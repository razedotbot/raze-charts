// Drives the consumer-supplied datafeed (IBasicDataFeed): symbol resolution,
// historical bars with lazy left-scroll pagination, live bar subscription,
// server time and bar marks. Owns the canonical bar series stored on the
// shared ChartContext.
//
// The datafeed contract follows TradingView's:
// - `HistoryMetadata.nextTime` on an empty page marks a gap; the request is
//   repeated with `to = nextTime` (bounded) instead of ending history.
// - Failing pagination backs off exponentially (with jitter) and reports one
//   error per backoff window instead of retrying on every pointer move.
// - Bars are validated: undrawable bars are dropped, and each mistake class
//   (seconds, strings, NaN, inverted high/low) warns once with its first index.
//   `raze.coerce_bars` repairs the unambiguous ones.
// - `supports_time`, `supports_marks` and `supports_timescale_marks` gate
//   getServerTime, getMarks and getTimescaleMarks.
// - Resolutions are parsed strictly and stored in canonical form ("D" → "1D").
// - Every visible-range write goes through the context's setViewport().

import type {
  Bar,
  DatafeedConfiguration,
  HistoryMetadata,
  IntervalChangedParameters,
  LibrarySymbolInfo,
  Mark,
  PeriodParams,
  ResolutionString,
  TimeFrameTimeRange,
  TimescaleMark,
  TimeFrameValue,
} from "../types/charting_library";
import {
  applySymbolInfo,
  DEFAULT_VISIBLE_BARS,
  type ChartContext,
  type IndexRange,
  type ViewportChangeReason,
} from "../core/context";
import { resolveTimeframe } from "../core/timeframe";
import { normalizeResolution, resolutionToMs, RESOLUTION_FORMS } from "../util/resolution";
import { TimeIndex } from "./TimeIndex";
import { describeBarIssue, SECONDS_THRESHOLD, validateBars } from "./validateBars";

let guidCounter = 0;
const nextGuid = (): string => `raze_${++guidCounter}_${Math.floor(performance.now())}`;

/** How many bars to request in the first history window. */
const INITIAL_BARS = 1500;
/** How many bars to request on each left-scroll page. */
const PAGE_BARS = 1000;
/** Follow at most this many consecutive `nextTime` gaps per history request. */
export const MAX_GAP_HOPS = 5;
/** First pagination retry delay; doubles per consecutive failure. */
export const HISTORY_BACKOFF_BASE_MS = 1_000;
/** Longest pagination retry delay. */
export const HISTORY_BACKOFF_MAX_MS = 60_000;
/** The first history request waits at most this long for getServerTime. */
export const SERVER_TIME_TIMEOUT_MS = 1_000;
/** getServerTime is repeated at this interval while supports_time is on. */
export const SERVER_TIME_RESYNC_MS = 5 * 60_000;

interface DataTarget {
  symbol: string;
  resolution: ResolutionString;
}

interface HistoryResult {
  bars: Bar[];
  noData: boolean;
  /** Unix seconds where older data resumes after a gap, or null. */
  nextTime: number | null;
}

const errorMessage = (reason: unknown): string => {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string" && reason.trim()) return reason;
  return "unknown datafeed error";
};

/** `disabled_features: ["mark_on_bars"]` is the Raze opt-out for bar marks. */
const barMarksOptedOut = (context: ChartContext): boolean =>
  context.options.disabled_features?.includes("mark_on_bars") === true;

/** Accept nextTime in Unix seconds (TradingView) or milliseconds. */
const nextTimeSeconds = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.floor(Math.abs(value) >= SECONDS_THRESHOLD ? value / 1000 : value);
};

export class DataManager {
  private config: DatafeedConfiguration | null = null;
  private subGuid: string | null = null;
  private destroyed = false;

  /** Invalidates every callback belonging to an older data target. */
  private generation = 0;
  /** Logical cancellation for callback-only datafeeds. */
  private pendingCancellations = new Set<() => void>();
  private latestReload: Promise<boolean> | null = null;
  private desiredTarget: DataTarget;

  /** A request id avoids an old pagination finally-block unlocking a new one. */
  private historyRequestId = 0;
  private activeHistoryRequestId: number | null = null;
  /** Consecutive pagination failures, and when the next attempt is allowed. */
  private historyFailures = 0;
  private historyRetryAt = 0;
  /**
   * `to` (Unix seconds) for the next page when a gap outlasted MAX_GAP_HOPS;
   * null means "just before the oldest loaded bar".
   */
  private historyCursor: number | null = null;
  /** Marks have their own revision so refresh/clear can supersede one another. */
  private marksRequestId = 0;
  private marksCancellation: (() => void) | null = null;
  private timescaleCancellation: (() => void) | null = null;

  /** False once the datafeed reports `noData` for older history. */
  private hasMoreHistory = true;
  /** Resolves when onReady fires, or when the manager is destroyed. */
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private readySettled = false;

  /** serverMs - clientMs, as last written to the context. */
  private serverOffsetMs = 0;
  private serverTimeReady: Promise<void> | null = null;
  private serverTimeInFlight: Promise<void> | null = null;
  private serverTimeTimer: ReturnType<typeof setInterval> | null = null;

  /** Warning keys already reported by this manager (one message per class). */
  private readonly warned = new Set<string>();

  constructor(private readonly context: ChartContext) {
    this.context.resolution = normalizeResolution(this.context.resolution) as ResolutionString;
    this.desiredTarget = {
      symbol: this.context.symbol,
      resolution: this.context.resolution,
    };
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      try {
        this.context.datafeed.onReady((cfg: DatafeedConfiguration) => {
          if (!this.destroyed) {
            this.config = this.sanitiseConfiguration(cfg ?? {});
            this.checkCapabilities();
            this.startServerTimeSync();
          }
          this.settleReady();
        });
      } catch (error) {
        this.readySettled = true;
        reject(new Error(`[raze-charts] datafeed onReady failed: ${errorMessage(error)}`));
      }
    });
  }

  private settleReady(): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.readyResolve();
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  getConfig(): DatafeedConfiguration | null {
    return this.config;
  }

  private isCurrent(generation: number): boolean {
    return !this.destroyed && generation === this.generation;
  }

  private cancelPending(): void {
    const pending = Array.from(this.pendingCancellations);
    this.pendingCancellations.clear();
    for (const cancel of pending) cancel();
    this.marksCancellation = null;
    this.timescaleCancellation = null;
  }

  private beginReload(target: DataTarget): number {
    this.generation += 1;
    this.desiredTarget = target;
    this.stopLiveSubscription();
    this.cancelPending();
    this.marksRequestId += 1;
    this.historyRequestId += 1;
    this.activeHistoryRequestId = null;
    this.hasMoreHistory = true;
    this.historyCursor = null;
    this.resetHistoryBackoff();
    return this.generation;
  }

  // -- Diagnostics -----------------------------------------------------------

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(message);
  }

  private reportError(operation: string, error: unknown): void {
    console.error(`[raze-charts] ${operation} failed`, error);
  }

  // -- Configuration -----------------------------------------------------------

  /** Canonicalise resolution lists; drop invalid entries with one warning. */
  private sanitiseResolutions(
    list: unknown,
    origin: string,
  ): ResolutionString[] | undefined {
    if (!Array.isArray(list)) return undefined;
    const valid: ResolutionString[] = [];
    const invalid: string[] = [];
    for (const item of list) {
      try {
        const canonical = normalizeResolution(item as string) as ResolutionString;
        if (!valid.includes(canonical)) valid.push(canonical);
      } catch {
        invalid.push(typeof item === "string" ? JSON.stringify(item) : String(item));
      }
    }
    if (invalid.length) {
      this.warnOnce(
        `resolutions:${origin}`,
        `[raze-charts] ignored invalid ${origin}.supported_resolutions ${invalid.join(", ")}. Accepted forms: ${RESOLUTION_FORMS}.`,
      );
    }
    return valid;
  }

  private sanitiseConfiguration(cfg: DatafeedConfiguration): DatafeedConfiguration {
    const resolutions = this.sanitiseResolutions(cfg.supported_resolutions, "DatafeedConfiguration");
    return resolutions ? { ...cfg, supported_resolutions: resolutions } : cfg;
  }

  private sanitiseSymbolInfo(info: LibrarySymbolInfo): LibrarySymbolInfo {
    const current = info.supported_resolutions;
    const resolutions = this.sanitiseResolutions(current, `LibrarySymbolInfo "${info.name}"`);
    if (
      !resolutions
      || (resolutions.length === current!.length && resolutions.every((res, i) => res === current![i]))
    ) {
      return info;
    }
    return { ...info, supported_resolutions: resolutions };
  }

  /** Warn once per supports_* flag that disagrees with the implemented methods. */
  private checkCapabilities(): void {
    this.checkCapability("supports_marks", "getMarks", "no bar marks will load");
    this.checkCapability("supports_timescale_marks", "getTimescaleMarks", "no timescale marks will load");
    this.checkCapability("supports_time", "getServerTime", "the client clock is used");
  }

  private checkCapability(flag: string, method: string, effect: string): void {
    const value = this.config?.[flag];
    const implemented = typeof (this.context.datafeed as unknown as Record<string, unknown>)[method] === "function";
    if (value === true && !implemented) {
      this.warnOnce(flag, `[raze-charts] configuration.${flag} is true but the datafeed has no ${method}(); ${effect}.`);
    } else if (value === undefined && implemented) {
      // An explicit false is a deliberate TradingView setting and stays quiet.
      this.warnOnce(flag, `[raze-charts] ${method}() is never called because configuration.${flag} is not true; set ${flag}: true to use it.`);
    }
  }

  private barMarksWanted(): boolean {
    return this.config?.supports_marks === true
      && typeof this.context.datafeed.getMarks === "function"
      && !barMarksOptedOut(this.context);
  }

  private timescaleMarksWanted(): boolean {
    return this.config?.supports_timescale_marks === true
      && typeof this.context.datafeed.getTimescaleMarks === "function";
  }

  // -- Server time -------------------------------------------------------------

  /** The client clock without the server offset this manager applied. */
  private clientNow(): number {
    return this.context.now() - this.serverOffsetMs;
  }

  private startServerTimeSync(): void {
    // checkCapabilities() reports a flag without a method and vice versa.
    if (this.config?.supports_time !== true || typeof this.context.datafeed.getServerTime !== "function") return;
    this.serverTimeReady = this.syncServerTime();
    this.serverTimeTimer = setInterval(() => {
      void this.syncServerTime();
    }, SERVER_TIME_RESYNC_MS);
  }

  /**
   * Ask the feed for its clock and store serverMs - clientMs on the context.
   * Resolves on the answer or after SERVER_TIME_TIMEOUT_MS; a late answer is
   * still applied.
   */
  private syncServerTime(): Promise<void> {
    if (this.serverTimeInFlight) return this.serverTimeInFlight;
    const feed = this.context.datafeed;
    const getServerTime = feed.getServerTime;
    if (this.destroyed || typeof getServerTime !== "function") return Promise.resolve();

    let resolve!: () => void;
    const request = new Promise<void>((done) => {
      resolve = done;
    });
    this.serverTimeInFlight = request;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (this.serverTimeInFlight === request) this.serverTimeInFlight = null;
      resolve();
    };
    const sentAt = this.clientNow();
    const receive = (unixTime: unknown): void => {
      // A late answer (after the timeout) is still a valid clock reading.
      if (!this.destroyed) this.applyServerTime(unixTime, sentAt, this.clientNow());
      settle();
    };
    try {
      getServerTime.call(feed, receive);
    } catch (error) {
      this.reportError("getServerTime", error);
      settle();
      return request;
    }
    if (!settled) timer = setTimeout(settle, SERVER_TIME_TIMEOUT_MS);
    return request;
  }

  private applyServerTime(unixTime: unknown, sentAt: number, receivedAt: number): void {
    if (typeof unixTime !== "number" || !Number.isFinite(unixTime) || unixTime <= 0) {
      this.warnOnce("server-time", `[raze-charts] ignored getServerTime() value ${String(unixTime)}; expected Unix seconds.`);
      return;
    }
    let serverMs: number;
    if (unixTime >= SECONDS_THRESHOLD) {
      this.warnOnce("server-time-ms", "[raze-charts] getServerTime() returned milliseconds; expected Unix seconds (converted).");
      serverMs = unixTime;
    } else {
      // Whole seconds are truncated, so the true instant is half a second later on average.
      serverMs = unixTime * 1000 + (Number.isInteger(unixTime) ? 500 : 0);
    }
    // Compare against the request midpoint to cancel the round trip.
    const offset = Math.round(serverMs - (sentAt + receivedAt) / 2);
    this.serverOffsetMs = offset;
    this.context.setServerTimeOffset(offset);
    this.context.requestPaint();
  }

  // -- Symbol resolution + initial load -------------------------------------

  async resolveAndLoad(): Promise<void> {
    const first = this.startReload(
      { symbol: this.context.symbol, resolution: this.context.resolution },
      true,
    );

    // A host may call setSymbol immediately after constructing the widget. In
    // that case chartReady belongs to the newest request, not the cancelled
    // constructor request.
    let pending = first;
    while (!this.destroyed) {
      try {
        await pending;
      } catch (error) {
        if (!this.latestReload || this.latestReload === pending) throw error;
      }
      const latest = this.latestReload;
      if (!latest || latest === pending) return;
      pending = latest;
    }
  }

  private startReload(target: DataTarget, forceResolve = false): Promise<boolean> {
    if (this.destroyed) return Promise.resolve(false);

    const generation = this.beginReload(target);
    let tracked!: Promise<boolean>;
    tracked = this.performReload(generation, target, forceResolve).finally(() => {
      if (this.latestReload === tracked) this.latestReload = null;
    });
    this.latestReload = tracked;
    return tracked;
  }

  private async performReload(
    generation: number,
    target: DataTarget,
    forceResolve: boolean,
  ): Promise<boolean> {
    try {
      await this.ready();
      if (!this.isCurrent(generation)) return false;
      // The first window ends at the server's "now" when the feed has a clock.
      if (this.serverTimeReady) await this.serverTimeReady;
      if (!this.isCurrent(generation)) return false;

      let info: LibrarySymbolInfo | null = null;
      if (!forceResolve && target.symbol === this.context.symbol) {
        info = this.context.symbolInfo;
      }
      if (!info) {
        const resolved = await this.resolveSymbol(target.symbol, generation);
        info = resolved && this.sanitiseSymbolInfo(resolved);
      }
      if (!info || !this.isCurrent(generation)) return false;

      const resMs = resolutionToMs(target.resolution);
      const nowSec = Math.floor(this.context.now() / 1000);
      const fromSec = nowSec - Math.ceil((INITIAL_BARS * resMs) / 1000);
      const history = await this.fetchHistory(
        info,
        target.resolution,
        { from: fromSec, to: nowSec, countBack: INITIAL_BARS, firstDataRequest: true },
        generation,
      );
      if (!history || !this.isCurrent(generation)) return false;

      // Commit symbol, interval, bars, and formatter atomically. Until history
      // succeeds the previous chart remains internally consistent.
      const previousResolution = this.context.resolution;
      this.context.symbol = target.symbol;
      this.context.resolution = target.resolution;
      applySymbolInfo(this.context, info);
      this.context.bars = this.normaliseBars(history.bars);
      this.context.marks = [];
      this.context.timescaleMarks = [];
      // `noData` means the feed has reached the beginning of the series. Some
      // compatible feeds return their final (non-empty) page together with the
      // flag, so checking the bar count here would request that page forever.
      // A gap that outlasted MAX_GAP_HOPS keeps its resume point instead.
      this.hasMoreHistory = !history.noData || history.nextTime !== null;
      this.historyCursor = history.bars.length ? null : history.nextTime;
      this.initVisibleRange();
      await this.applyConfiguredTimeframe(generation);
      if (!this.isCurrent(generation)) return false;
      if (previousResolution !== target.resolution) {
        await this.announceInterval(generation, target.resolution);
        if (!this.isCurrent(generation)) return false;
      }
      this.startLiveSubscription(generation, info, target.resolution);
      this.context.dataChanged.fire();
      this.context.requestPaint();

      // Marks are intentionally non-blocking: many TradingView-compatible
      // feeds answer asynchronously, and a missing marks callback must not hold
      // chartReady forever. The generation guard still prevents stale writes.
      this.refreshMarksFor(generation, info, target.resolution, this.context.bars);
      return true;
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.desiredTarget = {
          symbol: this.context.symbol,
          resolution: this.context.resolution,
        };
        // A failed transition keeps the previous committed data usable.
        if (this.context.symbolInfo) {
          this.startLiveSubscription(
            generation,
            this.context.symbolInfo,
            this.context.resolution,
          );
        }
      }
      throw error;
    }
  }

  private resolveSymbol(
    symbol: string,
    generation: number,
  ): Promise<LibrarySymbolInfo | null> {
    return new Promise<LibrarySymbolInfo | null>((resolve, reject) => {
      if (!this.isCurrent(generation)) {
        resolve(null);
        return;
      }

      let settled = false;
      const finish = (value: LibrarySymbolInfo | null, error?: unknown): void => {
        if (settled) return;
        settled = true;
        this.pendingCancellations.delete(cancel);
        if (error !== undefined && this.isCurrent(generation)) {
          reject(new Error(
            `[raze-charts] resolveSymbol failed for "${symbol}": ${errorMessage(error)}`,
          ));
        } else {
          resolve(this.isCurrent(generation) ? value : null);
        }
      };
      const cancel = (): void => finish(null);
      this.pendingCancellations.add(cancel);

      try {
        this.context.datafeed.resolveSymbol(
          symbol,
          (info) => finish(info),
          (reason) => finish(null, reason),
        );
      } catch (error) {
        finish(null, error);
      }
    });
  }

  /** Bars shown by the opening view: the render loop's width-aware count. */
  private defaultVisibleBars(): number {
    const count = typeof this.context.defaultVisibleBars === "function"
      ? this.context.defaultVisibleBars()
      : DEFAULT_VISIBLE_BARS;
    return Number.isFinite(count) && count >= 1 ? count : DEFAULT_VISIBLE_BARS;
  }

  /** Position the initial visible window over the most recent bar slots. */
  private initVisibleRange(): void {
    const n = this.context.bars.length;
    // Loads replace the window silently: layout sync and range events react
    // to user and API changes, and the reason tells internal listeners why.
    if (n === 0) {
      this.context.setViewport({ from: 0, to: 1 }, "load", { notify: false });
      return;
    }
    // Preserve empty slots on the left for sparse/new feeds. Fitting only the
    // bars returned by the feed spreads a handful of candles across the whole
    // canvas instead of keeping consecutive candles visually grouped.
    const visibleCount = this.defaultVisibleBars();
    const rightPad = Math.min(8, Math.max(1, Math.round(visibleCount * 0.06)));
    this.context.setViewport(
      { from: n - visibleCount, to: n - 1 + rightPad },
      "load",
      { notify: false },
    );
    this.context.setScaleMode({ autoScale: true }, "load");
  }

  /** Shift the window by `count` bars, keeping the visible time span. */
  private shiftViewport(count: number, reason: ViewportChangeReason): void {
    const { from, to } = this.context.visibleRange;
    this.context.setViewport({ from: from + count, to: to + count }, reason, { notify: false });
  }

  // -- History ---------------------------------------------------------------

  /**
   * Request a history window and follow `nextTime` gaps: an empty page that
   * names where older data resumes is repeated with `to = nextTime`, at most
   * MAX_GAP_HOPS times. The result keeps the last page's `nextTime` when the
   * hops ran out, so pagination can resume there.
   */
  private async fetchHistory(
    info: LibrarySymbolInfo,
    resolution: ResolutionString,
    periodParams: PeriodParams,
    generation: number,
  ): Promise<HistoryResult | null> {
    let params = periodParams;
    for (let hop = 0; ; hop++) {
      const result = await this.requestBars(info, resolution, params, generation);
      if (!result || result.bars.length || result.nextTime === null) return result;
      if (result.nextTime >= params.to) {
        this.warnOnce(
          "next-time",
          `[raze-charts] ignored getBars nextTime ${result.nextTime}: it must be older than the requested to (${params.to}).`,
        );
        return { ...result, nextTime: null };
      }
      if (hop >= MAX_GAP_HOPS) return result;
      const span = Math.max(1, params.to - params.from);
      params = {
        from: result.nextTime - span,
        to: result.nextTime,
        countBack: params.countBack,
        firstDataRequest: false,
      };
    }
  }

  private resetHistoryBackoff(): void {
    this.historyFailures = 0;
    this.historyRetryAt = 0;
  }

  /** Exponential backoff with jitter, reported once per window. */
  private noteHistoryFailure(error: unknown): void {
    this.historyFailures += 1;
    const base = Math.min(
      HISTORY_BACKOFF_BASE_MS * 2 ** (this.historyFailures - 1),
      HISTORY_BACKOFF_MAX_MS,
    );
    // ±25% jitter keeps many charts on one failing backend from retrying in lockstep.
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this.historyRetryAt = this.context.now() + delay;
    console.error(`[raze-charts] history pagination failed; retrying in ${(delay / 1000).toFixed(1)}s`, error);
  }

  /** Called by the engine when the visible range nears the left edge. */
  async maybeLoadMoreHistory(): Promise<void> {
    if (this.destroyed || this.activeHistoryRequestId !== null || !this.hasMoreHistory) return;
    const bars = this.context.bars;
    const info = this.context.symbolInfo;
    if (!bars.length || !info) return;
    if (this.context.visibleRange.from > 50) return;
    if (this.historyFailures > 0 && this.context.now() < this.historyRetryAt) return;

    const generation = this.generation;
    const resolution = this.context.resolution;
    const requestId = ++this.historyRequestId;
    this.activeHistoryRequestId = requestId;
    try {
      const oldestMs = bars[0]!.time;
      const resMs = resolutionToMs(resolution);
      const toSec = this.historyCursor ?? Math.floor(oldestMs / 1000) - 1;
      const fromSec = toSec - Math.ceil((PAGE_BARS * resMs) / 1000);
      const history = await this.fetchHistory(
        info,
        resolution,
        { from: fromSec, to: toSec, countBack: PAGE_BARS, firstDataRequest: false },
        generation,
      );
      if (!history || !this.isCurrent(generation) || this.activeHistoryRequestId !== requestId) {
        return;
      }
      this.resetHistoryBackoff();

      let changed = false;
      if (history.bars.length) {
        this.historyCursor = null;
        const before = this.context.bars.length;
        this.mergeBars(history.bars);
        const addedCount = this.context.bars.length - before;
        if (addedCount > 0) {
          changed = true;
          // Same time window, re-anchored after the prepend.
          this.shiftViewport(addedCount, "rebase");
        }
        // A page containing only timestamps we already have made no progress.
        // Continuing would hammer feeds which ignore the requested boundary.
        if (addedCount === 0) this.hasMoreHistory = false;
        if (history.noData) this.hasMoreHistory = false;
      } else if (history.nextTime !== null) {
        // The gap outlasted MAX_GAP_HOPS: resume from its far side next time.
        this.historyCursor = history.nextTime;
      } else {
        this.hasMoreHistory = false;
      }
      if (changed) {
        this.context.dataChanged.fire();
        this.context.requestPaint();
      }
    } catch (error) {
      if (this.isCurrent(generation)) this.noteHistoryFailure(error);
    } finally {
      if (this.activeHistoryRequestId === requestId) this.activeHistoryRequestId = null;
    }
  }

  private requestBars(
    info: LibrarySymbolInfo,
    resolution: ResolutionString,
    periodParams: PeriodParams,
    generation: number,
  ): Promise<HistoryResult | null> {
    return new Promise<HistoryResult | null>((resolve, reject) => {
      if (!this.isCurrent(generation)) {
        resolve(null);
        return;
      }

      let settled = false;
      const finish = (value: HistoryResult | null, error?: unknown): void => {
        if (settled) return;
        settled = true;
        this.pendingCancellations.delete(cancel);
        if (error !== undefined && this.isCurrent(generation)) {
          reject(new Error(
            `[raze-charts] getBars failed for "${info.name}" at ${resolution}: ${errorMessage(error)}`,
          ));
        } else {
          resolve(this.isCurrent(generation) ? value : null);
        }
      };
      const cancel = (): void => finish(null);
      this.pendingCancellations.add(cancel);

      try {
        this.context.datafeed.getBars(
          info,
          resolution,
          periodParams,
          (bars: Bar[], meta?: HistoryMetadata) => {
            if (settled) return;
            const safeBars = Array.isArray(bars) ? this.validate(bars, "getBars") : [];
            finish({
              bars: safeBars,
              noData: meta?.noData === true,
              nextTime: nextTimeSeconds(meta?.nextTime),
            });
          },
          (reason) => finish(null, reason),
        );
      } catch (error) {
        finish(null, error);
      }
    });
  }

  /** Validate datafeed bars, warning once per problem class. */
  private validate(batch: readonly unknown[], origin: string): Bar[] {
    const coerce = this.context.options.raze?.coerce_bars === true;
    const { bars, issues } = validateBars(batch, coerce);
    for (const issue of issues) {
      const key = `bars:${issue.problem}:${issue.repaired ? "repaired" : "reported"}`;
      if (this.warned.has(key)) continue;
      this.warned.add(key);
      const message = describeBarIssue(issue, origin);
      if (issue.repaired) console.debug(message);
      else console.warn(message);
    }
    return bars;
  }

  /** Merge a batch into the canonical series, dedup by time, keep ascending. */
  private mergeBars(batch: Bar[]): void {
    this.context.bars = this.normaliseBars([...this.context.bars, ...batch]);
  }

  /** Sort validated bars ascending and keep the last bar for each time. */
  private normaliseBars(batch: Bar[]): Bar[] {
    const byTime = new Map<number, Bar>();
    for (const bar of batch) byTime.set(bar.time, bar);
    return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  }

  // -- Live subscription ----------------------------------------------------

  private startLiveSubscription(
    generation: number,
    info: LibrarySymbolInfo,
    resolution: ResolutionString,
  ): void {
    this.stopLiveSubscription();
    if (!this.isCurrent(generation)) return;

    const guid = nextGuid();
    this.subGuid = guid;
    try {
      this.context.datafeed.subscribeBars(
        info,
        resolution,
        (bar: Bar) => {
          if (!this.isCurrent(generation) || this.subGuid !== guid) return;
          this.onLiveBar(bar);
        },
        guid,
        () => {
          // Defer so a feed that calls reset synchronously from subscribeBars
          // cannot recursively subscribe forever.
          queueMicrotask(() => {
            if (!this.isCurrent(generation) || this.subGuid !== guid) return;
            this.resetData();
          });
        },
      );
    } catch (error) {
      if (this.subGuid === guid) this.subGuid = null;
      if (this.isCurrent(generation)) this.reportError("live subscription", error);
    }
  }

  private stopLiveSubscription(): void {
    const guid = this.subGuid;
    this.subGuid = null;
    if (!guid) return;
    try {
      this.context.datafeed.unsubscribeBars(guid);
    } catch {
      // Teardown remains best-effort; the cleared guid already makes any late
      // callback harmless.
    }
  }

  private onLiveBar(input: Bar): void {
    const bar = this.validate([input], "subscribeBars")[0];
    if (!bar) return;
    const bars = this.context.bars;
    const last = bars[bars.length - 1];
    const pinnedRight = bars.length > 0 && this.context.visibleRange.to >= bars.length - 1;
    if (last && bar.time === last.time) {
      bars[bars.length - 1] = bar;
    } else if (!last || bar.time > last.time) {
      bars.push(bar);
      if (pinnedRight) this.shiftViewport(1, "realtime");
    } else {
      this.warnOnce(
        "live-order",
        `[raze-charts] ignored a subscribeBars bar older than the last bar (${bar.time} < ${last.time}).`,
      );
      return;
    }
    this.context.dataChanged.fire();
    this.context.requestPaint();
  }

  // -- Marks ---------------------------------------------------------------

  private cancelMarksRequest(): void {
    this.marksRequestId += 1;
    const cancel = this.marksCancellation;
    this.marksCancellation = null;
    cancel?.();
    const timescale = this.timescaleCancellation;
    this.timescaleCancellation = null;
    timescale?.();
  }

  private requestMarks(
    generation: number,
    requestId: number,
    info: LibrarySymbolInfo,
    resolution: ResolutionString,
    from: number,
    to: number,
  ): Promise<Mark[] | null> {
    return new Promise<Mark[] | null>((resolve, reject) => {
      if (!this.isCurrent(generation) || requestId !== this.marksRequestId) {
        resolve(null);
        return;
      }

      let settled = false;
      const finish = (value: Mark[] | null, error?: unknown): void => {
        if (settled) return;
        settled = true;
        this.pendingCancellations.delete(cancel);
        if (this.marksCancellation === cancel) this.marksCancellation = null;
        if (
          error !== undefined &&
          this.isCurrent(generation) &&
          requestId === this.marksRequestId
        ) {
          reject(new Error(
            `[raze-charts] getMarks failed for "${info.name}" at ${resolution}: ${errorMessage(error)}`,
          ));
        } else {
          resolve(
            this.isCurrent(generation) && requestId === this.marksRequestId ? value : null,
          );
        }
      };
      const cancel = (): void => finish(null);
      this.pendingCancellations.add(cancel);
      this.marksCancellation = cancel;

      try {
        this.context.datafeed.getMarks!(
          info,
          from,
          to,
          (marks: Mark[]) => finish(Array.isArray(marks) ? marks : []),
          resolution,
        );
      } catch (error) {
        finish(null, error);
      }
    });
  }

  private requestTimescaleMarks(
    generation: number,
    requestId: number,
    info: LibrarySymbolInfo,
    resolution: ResolutionString,
    from: number,
    to: number,
  ): Promise<TimescaleMark[] | null> {
    return new Promise<TimescaleMark[] | null>((resolve) => {
      if (!this.isCurrent(generation) || requestId !== this.marksRequestId) {
        resolve(null);
        return;
      }

      let settled = false;
      const finish = (value: TimescaleMark[] | null): void => {
        if (settled) return;
        settled = true;
        this.pendingCancellations.delete(cancel);
        if (this.timescaleCancellation === cancel) this.timescaleCancellation = null;
        resolve(
          this.isCurrent(generation) && requestId === this.marksRequestId ? value : null,
        );
      };
      const cancel = (): void => finish(null);
      this.pendingCancellations.add(cancel);
      this.timescaleCancellation = cancel;

      try {
        this.context.datafeed.getTimescaleMarks!(
          info,
          from,
          to,
          (items: TimescaleMark[]) => finish(Array.isArray(items) ? items : []),
          resolution,
        );
      } catch {
        finish([]);
      }
    });
  }

  private async loadMarksFor(
    generation: number,
    info: LibrarySymbolInfo | null,
    resolution: ResolutionString,
    bars: Bar[],
  ): Promise<boolean> {
    this.cancelMarksRequest();
    const requestId = this.marksRequestId;
    if (!info || !bars.length) {
      if (this.isCurrent(generation) && requestId === this.marksRequestId) {
        this.context.marks = [];
        this.context.timescaleMarks = [];
        return true;
      }
      return false;
    }

    const from = Math.floor(bars[0]!.time / 1000);
    const to = Math.floor(bars[bars.length - 1]!.time / 1000) + 86_400;
    const jobs: Promise<boolean>[] = [];
    if (this.barMarksWanted()) {
      jobs.push(this.requestMarks(
        generation,
        requestId,
        info,
        resolution,
        from,
        to,
      ).then((marks) => {
        if (
          marks === null ||
          !this.isCurrent(generation) ||
          requestId !== this.marksRequestId
        ) {
          return false;
        }
        this.context.marks = marks;
        return true;
      }));
    } else if (this.isCurrent(generation) && requestId === this.marksRequestId) {
      this.context.marks = [];
    }

    if (this.timescaleMarksWanted()) {
      jobs.push(this.requestTimescaleMarks(
        generation,
        requestId,
        info,
        resolution,
        from,
        to,
      ).then((items) => {
        if (
          items === null ||
          !this.isCurrent(generation) ||
          requestId !== this.marksRequestId
        ) {
          return false;
        }
        this.context.timescaleMarks = items;
        return true;
      }));
    } else if (this.isCurrent(generation) && requestId === this.marksRequestId) {
      this.context.timescaleMarks = [];
    }

    if (!jobs.length) {
      return this.isCurrent(generation) && requestId === this.marksRequestId;
    }
    const results = await Promise.all(jobs);
    return results.some(Boolean);
  }

  async loadMarks(): Promise<void> {
    await this.loadMarksFor(
      this.generation,
      this.context.symbolInfo,
      this.context.resolution,
      this.context.bars,
    );
  }

  private refreshMarksFor(
    generation: number,
    info: LibrarySymbolInfo | null,
    resolution: ResolutionString,
    bars: Bar[],
  ): void {
    void this.loadMarksFor(generation, info, resolution, bars)
      .then((changed) => {
        if (!changed || !this.isCurrent(generation)) return;
        this.context.dataChanged.fire();
        this.context.requestPaint();
      })
      .catch((error: unknown) => {
        if (this.isCurrent(generation)) this.reportError("marks request", error);
      });
  }

  refreshMarks(): void {
    if (this.config && !this.barMarksWanted() && !this.timescaleMarksWanted()) {
      this.warnOnce(
        "refresh-marks",
        "[raze-charts] refreshMarks() does nothing: the datafeed configuration enables neither supports_marks nor supports_timescale_marks.",
      );
    }
    this.refreshMarksFor(
      this.generation,
      this.context.symbolInfo,
      this.context.resolution,
      this.context.bars,
    );
  }

  clearMarks(): void {
    if (this.destroyed) return;
    this.cancelMarksRequest();
    this.context.marks = [];
    this.context.timescaleMarks = [];
    this.context.dataChanged.fire();
    this.context.requestPaint();
  }

  // -- Resolution / symbol changes -----------------------------------------

  /**
   * Switch the interval. Rejects with a RangeError (listing the accepted
   * forms) for an invalid resolution before any request is made.
   */
  async changeResolution(resolution: ResolutionString): Promise<void> {
    const canonical = normalizeResolution(resolution) as ResolutionString;
    const target = { symbol: this.desiredTarget.symbol, resolution: canonical };
    if (canonical === this.desiredTarget.resolution) {
      if (this.latestReload) await this.latestReload;
      return;
    }
    await this.startReload(target);
  }

  /** Switch the symbol (and optionally the interval). Rejects like changeResolution(). */
  async changeSymbol(
    symbol: string,
    resolution: ResolutionString = this.desiredTarget.resolution,
  ): Promise<void> {
    const target = { symbol, resolution: normalizeResolution(resolution) as ResolutionString };
    if (
      target.symbol === this.desiredTarget.symbol &&
      target.resolution === this.desiredTarget.resolution
    ) {
      if (this.latestReload) await this.latestReload;
      return;
    }
    await this.startReload(target);
  }

  resetData(): void {
    if (this.destroyed) return;
    const target = { ...this.desiredTarget };
    void this.startReload(target).catch((error: unknown) => {
      if (!this.destroyed) this.reportError("data reset", error);
    });
  }

  /**
   * Fire `intervalChanged(resolution, { timeframe })` after the new interval's
   * data is committed and before its first paint. `timeframe` is the range
   * the chart will show; a listener may replace it (or edit `from`/`to`) to
   * choose another range, which is applied here.
   */
  private async announceInterval(generation: number, resolution: ResolutionString): Promise<void> {
    const range = this.visibleUnixRange();
    const initial: TimeFrameTimeRange = { type: "time-range", from: range.from, to: range.to };
    const params: IntervalChangedParameters = { timeframe: initial };
    this.context.intervalChanged.fire(resolution, params);
    if (!this.isCurrent(generation)) return;
    const chosen = params.timeframe as TimeFrameValue | undefined;
    if (chosen === initial && initial.from === range.from && initial.to === range.to) return;

    const window = this.resolveTimeFrameValue(chosen);
    if (!window) {
      this.warnOnce(
        "interval-timeframe",
        `[raze-charts] ignored onIntervalChanged timeframe ${JSON.stringify(chosen)}; `
          + 'use { type: "time-range", from, to } or { type: "period-back", value }.',
      );
      return;
    }
    try {
      if (window.all) this.showAllBars("timeframe");
      else await this.revealTimeRange(window.from, window.to, "timeframe");
    } catch (error) {
      // The interval itself switched; a failed reveal keeps the default view.
      if (this.isCurrent(generation)) this.reportError("apply onIntervalChanged timeframe", error);
    }
  }

  private resolveTimeFrameValue(value: unknown): { from: number; to: number; all?: boolean } | null {
    if (!value || typeof value !== "object") return null;
    const tf = value as { type?: unknown; from?: unknown; to?: unknown; value?: unknown };
    if (tf.type === "time-range" && typeof tf.from === "number" && typeof tf.to === "number") {
      if (!Number.isFinite(tf.from) || !Number.isFinite(tf.to) || tf.from > tf.to) return null;
      return { from: tf.from, to: tf.to };
    }
    if ((tf.type === "period-back" || tf.type === "time-range") && typeof tf.value === "string") {
      return resolveTimeframe(
        { type: tf.type, value: tf.value },
        Math.floor(this.context.now() / 1000),
      );
    }
    return null;
  }

  /**
   * TradingView-shaped interval payload for the current visible range:
   * `{ timeframe: { type: "time-range", from, to } }` in Unix seconds.
   */
  timeframePayload(): IntervalChangedParameters {
    const range = this.visibleUnixRange();
    return { timeframe: { type: "time-range", from: range.from, to: range.to } };
  }

  visibleUnixRange(): { from: number; to: number } {
    const bars = this.context.bars;
    const { from, to } = this.context.visibleRange;
    const idx = (i: number): number => {
      const clamped = Math.max(0, Math.min(bars.length - 1, Math.round(i)));
      const bar = bars[clamped];
      return bar ? Math.floor(bar.time / 1000) : 0;
    };
    return { from: idx(from), to: idx(to) };
  }

  /**
   * Show a Unix-second window. `reason` tags the viewport change (defaults to
   * "api"; layout sync passes "sync", presets "preset").
   */
  applyIndexRangeFromUnix(fromSec: number, toSec: number, reason: ViewportChangeReason = "api"): void {
    this.assertValidUnixRange(fromSec, toSec);
    const bars = this.context.bars;
    if (!bars.length) return;
    const fromMs = fromSec * 1000;
    const toMs = toSec * 1000;
    const timeIndex = new TimeIndex(bars, resolutionToMs(this.context.resolution));
    const from = timeIndex.indexAt(fromMs);
    const to = timeIndex.indexAt(toMs);
    if (from === null || to === null) return;
    this.applyRange({ from, to: Math.max(from + 1, to) }, reason);
  }

  private applyRange(range: IndexRange, reason: ViewportChangeReason): void {
    this.context.setScaleMode({ autoScale: true }, reason === "timeframe" || reason === "preset" ? "preset" : "api");
    this.context.setViewport(range, reason);
  }

  private showAllBars(reason: ViewportChangeReason): void {
    const n = this.context.bars.length;
    if (n) this.applyRange({ from: 0, to: n - 1 }, reason);
  }

  private assertValidUnixRange(fromSec: number, toSec: number): void {
    if (!Number.isFinite(fromSec) || !Number.isFinite(toSec)) {
      throw new RangeError("[raze-charts] visible range timestamps must be finite Unix seconds");
    }
    if (fromSec > toSec) {
      throw new RangeError("[raze-charts] visible range `from` must not be after `to`");
    }
  }

  async applyConfiguredTimeframe(generation = this.generation): Promise<void> {
    if (!this.isCurrent(generation)) return;
    const resolved = resolveTimeframe(
      this.context.options.timeframe,
      Math.floor(this.context.now() / 1000),
    );
    if (!resolved) return;
    if (resolved.all) {
      this.showAllBars("timeframe");
      return;
    }
    await this.revealTimeRange(resolved.from, resolved.to, "timeframe");
  }

  /**
   * Show a Unix-second window, paging older history (and following gaps) until
   * it is covered. `reason` tags the viewport change; see applyIndexRangeFromUnix.
   */
  async revealTimeRange(
    fromSec: number,
    toSec: number,
    reason: ViewportChangeReason = "api",
  ): Promise<void> {
    if (this.destroyed) return;
    this.assertValidUnixRange(fromSec, toSec);
    const info = this.context.symbolInfo;
    if (!info) {
      this.applyIndexRangeFromUnix(fromSec, toSec, reason);
      return;
    }
    const generation = this.generation;
    let safety = 0;
    while (
      this.isCurrent(generation)
      && this.hasMoreHistory
      && this.context.bars.length
      && Math.floor(this.context.bars[0]!.time / 1000) > fromSec
      && safety++ < 24
    ) {
      const oldest = this.context.bars[0]!;
      const to = this.historyCursor ?? Math.floor(oldest.time / 1000) - 1;
      const history = await this.fetchHistory(
        info,
        this.context.resolution,
        {
          from: Math.min(fromSec, to - 1),
          to,
          countBack: PAGE_BARS,
          firstDataRequest: false,
        },
        generation,
      );
      if (!history || !this.isCurrent(generation)) return;
      if (!history.bars.length) {
        if (history.nextTime !== null && history.nextTime > fromSec) {
          this.historyCursor = history.nextTime;
          continue;
        }
        if (history.nextTime !== null) this.historyCursor = history.nextTime;
        else this.hasMoreHistory = false;
        break;
      }
      this.historyCursor = null;
      const before = this.context.bars.length;
      this.mergeBars(history.bars);
      const added = this.context.bars.length - before;
      if (added > 0) this.shiftViewport(added, "rebase");
      if (history.noData || added === 0) {
        this.hasMoreHistory = false;
        break;
      }
    }
    if (this.isCurrent(generation)) this.applyIndexRangeFromUnix(fromSec, toSec, reason);
  }

  async loadCompare(symbol: string): Promise<Bar[]> {
    const info = await this.resolveSymbolPublic(symbol);
    if (!info) return [];
    const bars = this.context.bars;
    const nowSec = Math.floor(this.context.now() / 1000);
    const from = bars[0] ? Math.floor(bars[0].time / 1000) : nowSec - 86_400 * 30;
    const to = bars[bars.length - 1] ? Math.floor(bars[bars.length - 1]!.time / 1000) + 86_400 : nowSec;
    const history = await this.fetchHistory(
      info,
      this.context.resolution,
      { from, to, countBack: bars.length || PAGE_BARS, firstDataRequest: true },
      this.generation,
    );
    return history ? this.normaliseBars(history.bars) : [];
  }

  private resolveSymbolPublic(symbol: string): Promise<LibrarySymbolInfo | null> {
    return new Promise((resolve) => {
      try {
        this.context.datafeed.resolveSymbol(
          symbol,
          (info) => resolve(info),
          () => resolve(null),
        );
      } catch {
        resolve(null);
      }
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation += 1;
    this.historyRequestId += 1;
    this.activeHistoryRequestId = null;
    this.marksRequestId += 1;
    if (this.serverTimeTimer !== null) clearInterval(this.serverTimeTimer);
    this.serverTimeTimer = null;
    this.stopLiveSubscription();
    this.cancelPending();
    this.latestReload = null;
    this.settleReady();
  }
}

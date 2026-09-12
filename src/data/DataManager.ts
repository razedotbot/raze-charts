// Drives the consumer-supplied datafeed (IBasicDataFeed): symbol resolution,
// historical bars with lazy left-scroll pagination, live bar subscription, and
// bar marks. Owns the canonical bar series stored on the shared ChartContext.

import type {
  Bar,
  DatafeedConfiguration,
  HistoryMetadata,
  LibrarySymbolInfo,
  Mark,
  PeriodParams,
  ResolutionString,
  TimescaleMark,
} from "../types/charting_library";
import { applySymbolInfo, type ChartContext } from "../core/context";
import { resolveTimeframe } from "../core/timeframe";
import { resolutionToMs } from "../util/resolution";
import { TimeIndex } from "./TimeIndex";

let guidCounter = 0;
const nextGuid = (): string => `raze_${++guidCounter}_${Math.floor(performance.now())}`;

/** How many bars to request in the first history window. */
const INITIAL_BARS = 1500;
/** How many bars to request on each left-scroll page. */
const PAGE_BARS = 1000;
/** Keep the opening candle density stable even when the feed returns few bars. */
const INITIAL_VISIBLE_BARS = 120;

interface DataTarget {
  symbol: string;
  resolution: ResolutionString;
}

interface HistoryResult {
  bars: Bar[];
  noData: boolean;
}

const errorMessage = (reason: unknown): string => {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string" && reason.trim()) return reason;
  return "unknown datafeed error";
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

  constructor(private readonly context: ChartContext) {
    this.desiredTarget = {
      symbol: this.context.symbol,
      resolution: this.context.resolution,
    };
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      try {
        this.context.datafeed.onReady((cfg: DatafeedConfiguration) => {
          if (!this.destroyed) this.config = cfg ?? {};
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
    return this.generation;
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

      let info: LibrarySymbolInfo | null = null;
      if (!forceResolve && target.symbol === this.context.symbol) {
        info = this.context.symbolInfo;
      }
      if (!info) info = await this.resolveSymbol(target.symbol, generation);
      if (!info || !this.isCurrent(generation)) return false;

      const resMs = resolutionToMs(target.resolution);
      const nowSec = Math.floor(Date.now() / 1000);
      const fromSec = nowSec - Math.ceil((INITIAL_BARS * resMs) / 1000);
      const history = await this.requestBars(
        info,
        target.resolution,
        { from: fromSec, to: nowSec, countBack: INITIAL_BARS, firstDataRequest: true },
        generation,
      );
      if (!history || !this.isCurrent(generation)) return false;

      // Commit symbol, interval, bars, and formatter atomically. Until history
      // succeeds the previous chart remains internally consistent.
      this.context.symbol = target.symbol;
      this.context.resolution = target.resolution;
      applySymbolInfo(this.context, info);
      this.context.bars = this.normaliseBars(history.bars);
      this.context.marks = [];
      this.context.timescaleMarks = [];
      // `noData` means the feed has reached the beginning of the series. Some
      // compatible feeds return their final (non-empty) page together with the
      // flag, so checking the bar count here would request that page forever.
      this.hasMoreHistory = !history.noData;
      this.initVisibleRange();
      await this.applyConfiguredTimeframe(generation);
      if (!this.isCurrent(generation)) return false;
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

  /** Position the initial visible window over the most recent ~120 bar slots. */
  private initVisibleRange(): void {
    const n = this.context.bars.length;
    if (n === 0) {
      this.context.visibleRange = { from: 0, to: 1 };
      return;
    }
    // Preserve empty slots on the left for sparse/new feeds. Fitting only the
    // bars returned by the feed spreads a handful of candles across the whole
    // canvas instead of keeping consecutive candles visually grouped.
    const visibleCount = INITIAL_VISIBLE_BARS;
    const rightPad = Math.min(8, Math.max(1, Math.round(visibleCount * 0.06)));
    this.context.visibleRange = {
      from: n - visibleCount,
      to: n - 1 + rightPad,
    };
    this.context.autoScalePrice = true;
  }

  // -- Lazy left-scroll pagination -----------------------------------------

  /** Called by the engine when the visible range nears the left edge. */
  async maybeLoadMoreHistory(): Promise<void> {
    if (this.destroyed || this.activeHistoryRequestId !== null || !this.hasMoreHistory) return;
    const bars = this.context.bars;
    const info = this.context.symbolInfo;
    if (!bars.length || !info) return;
    if (this.context.visibleRange.from > 50) return;

    const generation = this.generation;
    const resolution = this.context.resolution;
    const requestId = ++this.historyRequestId;
    this.activeHistoryRequestId = requestId;
    try {
      const oldestMs = bars[0]!.time;
      const resMs = resolutionToMs(resolution);
      const toSec = Math.floor(oldestMs / 1000) - 1;
      const fromSec = toSec - Math.ceil((PAGE_BARS * resMs) / 1000);
      const history = await this.requestBars(
        info,
        resolution,
        { from: fromSec, to: toSec, countBack: PAGE_BARS, firstDataRequest: false },
        generation,
      );
      if (!history || !this.isCurrent(generation) || this.activeHistoryRequestId !== requestId) {
        return;
      }

      let changed = false;
      if (history.bars.length) {
        const before = this.context.bars.length;
        this.mergeBars(history.bars);
        const addedCount = this.context.bars.length - before;
        if (addedCount > 0) {
          changed = true;
          this.context.visibleRange = {
            from: this.context.visibleRange.from + addedCount,
            to: this.context.visibleRange.to + addedCount,
          };
        }
        // A page containing only timestamps we already have made no progress.
        // Continuing would hammer feeds which ignore the requested boundary.
        if (addedCount === 0) this.hasMoreHistory = false;
      }
      if (history.noData || !history.bars.length) this.hasMoreHistory = false;
      if (changed) {
        this.context.dataChanged.fire();
        this.context.requestPaint();
      }
    } catch (error) {
      if (this.isCurrent(generation)) this.reportError("history pagination", error);
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
            const safeBars = Array.isArray(bars) ? bars : [];
            finish({ bars: safeBars, noData: meta?.noData === true });
          },
          (reason) => finish(null, reason),
        );
      } catch (error) {
        finish(null, error);
      }
    });
  }

  /** Merge a batch into the canonical series, dedup by time, keep ascending. */
  private mergeBars(batch: Bar[]): void {
    this.context.bars = this.normaliseBars([...this.context.bars, ...batch]);
  }

  private normaliseBars(batch: Bar[]): Bar[] {
    const byTime = new Map<number, Bar>();
    for (const bar of batch) {
      if (!bar || !Number.isFinite(bar.time)) continue;
      byTime.set(bar.time, bar);
    }
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

  private onLiveBar(bar: Bar): void {
    if (!Number.isFinite(bar.time)) return;
    const bars = this.context.bars;
    const last = bars[bars.length - 1];
    const pinnedRight = bars.length > 0 && this.context.visibleRange.to >= bars.length - 1;
    if (last && bar.time === last.time) {
      bars[bars.length - 1] = bar;
    } else if (!last || bar.time > last.time) {
      bars.push(bar);
      if (pinnedRight) {
        this.context.visibleRange = {
          from: this.context.visibleRange.from + 1,
          to: this.context.visibleRange.to + 1,
        };
      }
    } else {
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
    const getMarks = this.context.datafeed.getMarks;
    if (typeof getMarks === "function") {
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

    const getTimescaleMarks = this.context.datafeed.getTimescaleMarks;
    if (typeof getTimescaleMarks === "function") {
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

  async changeResolution(resolution: ResolutionString): Promise<void> {
    const target = { symbol: this.desiredTarget.symbol, resolution };
    if (resolution === this.desiredTarget.resolution) {
      if (this.latestReload) await this.latestReload;
      return;
    }

    const previous = this.context.resolution;
    const changed = await this.startReload(target);
    if (changed && previous !== resolution && !this.destroyed) {
      this.context.intervalChanged.fire(resolution, this.timeframePayload());
    }
  }

  async changeSymbol(
    symbol: string,
    resolution: ResolutionString = this.desiredTarget.resolution,
  ): Promise<void> {
    const target = { symbol, resolution };
    if (
      target.symbol === this.desiredTarget.symbol &&
      target.resolution === this.desiredTarget.resolution
    ) {
      if (this.latestReload) await this.latestReload;
      return;
    }

    const previousResolution = this.context.resolution;
    const changed = await this.startReload(target);
    if (changed && previousResolution !== resolution && !this.destroyed) {
      this.context.intervalChanged.fire(resolution, this.timeframePayload());
    }
  }

  resetData(): void {
    if (this.destroyed) return;
    const target = { ...this.desiredTarget };
    void this.startReload(target).catch((error: unknown) => {
      if (!this.destroyed) this.reportError("data reset", error);
    });
  }

  timeframePayload(): { timeframe: { value: string; type: "time-range" } } {
    const range = this.visibleUnixRange();
    return {
      timeframe: {
        value: `${range.from}-${range.to}`,
        type: "time-range",
      },
    };
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

  applyIndexRangeFromUnix(fromSec: number, toSec: number): void {
    this.assertValidUnixRange(fromSec, toSec);
    const bars = this.context.bars;
    if (!bars.length) return;
    const fromMs = fromSec * 1000;
    const toMs = toSec * 1000;
    const timeIndex = new TimeIndex(bars, resolutionToMs(this.context.resolution));
    const from = timeIndex.indexAt(fromMs);
    const to = timeIndex.indexAt(toMs);
    if (from === null || to === null) return;
    this.context.visibleRange = { from, to: Math.max(from + 1, to) };
    this.context.autoScalePrice = true;
    this.context.viewportChanged.fire(this.visibleUnixRange());
    this.context.requestPaint();
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
    const resolved = resolveTimeframe(this.context.options.timeframe);
    if (!resolved) return;
    if (resolved.all) {
      const n = this.context.bars.length;
      if (n) {
        this.context.visibleRange = { from: 0, to: n - 1 };
        this.context.autoScalePrice = true;
        this.context.viewportChanged.fire(this.visibleUnixRange());
        this.context.requestPaint();
      }
      return;
    }
    await this.revealTimeRange(resolved.from, resolved.to);
  }

  async revealTimeRange(fromSec: number, toSec: number): Promise<void> {
    if (this.destroyed) return;
    this.assertValidUnixRange(fromSec, toSec);
    const info = this.context.symbolInfo;
    if (!info) {
      this.applyIndexRangeFromUnix(fromSec, toSec);
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
      const history = await this.requestBars(
        info,
        this.context.resolution,
        {
          from: fromSec,
          to: Math.floor(oldest.time / 1000) - 1,
          countBack: PAGE_BARS,
          firstDataRequest: false,
        },
        generation,
      );
      if (!history || !this.isCurrent(generation)) return;
      if (!history.bars.length) {
        this.hasMoreHistory = false;
        break;
      }
      const before = this.context.bars.length;
      this.mergeBars(history.bars);
      if (history.noData || this.context.bars.length === before) {
        this.hasMoreHistory = false;
        break;
      }
    }
    if (this.isCurrent(generation)) this.applyIndexRangeFromUnix(fromSec, toSec);
  }

  async loadCompare(symbol: string): Promise<Bar[]> {
    const info = await this.resolveSymbolPublic(symbol);
    if (!info) return [];
    const bars = this.context.bars;
    const from = bars[0] ? Math.floor(bars[0].time / 1000) : Math.floor(Date.now() / 1000) - 86_400 * 30;
    const to = bars[bars.length - 1] ? Math.floor(bars[bars.length - 1]!.time / 1000) + 86_400 : Math.floor(Date.now() / 1000);
    const history = await this.requestBars(
      info,
      this.context.resolution,
      { from, to, countBack: bars.length || PAGE_BARS, firstDataRequest: true },
      this.generation,
    );
    return history?.bars ?? [];
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

  private reportError(operation: string, error: unknown): void {
    console.error(`[raze-charts] ${operation} failed`, error);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation += 1;
    this.historyRequestId += 1;
    this.activeHistoryRequestId = null;
    this.marksRequestId += 1;
    this.stopLiveSubscription();
    this.cancelPending();
    this.latestReload = null;
    this.settleReady();
  }
}

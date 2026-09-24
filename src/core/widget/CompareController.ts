// Compare overlays: other symbols drawn over the main series.
//
// A compare series follows the main series through its whole lifecycle:
//   - createCompare() resolves the symbol and loads history over the main
//     series' window, rejecting (and adding nothing) when either step fails;
//   - a symbol or resolution change of the main series refetches every compare
//     at the new target, and never draws bars of another resolution meanwhile;
//   - left pagination of the main series pages each compare over the same
//     range;
//   - each compare has its own live subscription (its own listener GUID),
//     honours its own reset-cache callback, and is unsubscribed on
//     removeEntity(), on layout restore and on widget remove();
//   - the first compare switches the price scale to percent, and removing the
//     last one restores the previous mode unless the user changed it since.
//
// Datafeed access lives in src/data/CompareLoader.ts.

import type { Bar, EntityId, LibrarySymbolInfo, ResolutionString } from "../../types/charting_library";
import {
  CompareLoader,
  CompareRequests,
  normaliseCompareBars,
  type CompareSubscription,
} from "../../data/CompareLoader";
import { resolutionToMs } from "../../util/resolution";
import type { PriceScaleMode, ScaleChange } from "../context";
import type { WidgetController, WidgetHost } from "./host";

declare module "./host" {
  interface WidgetControllerMap {
    compare: CompareController;
  }
}

const COMPARE_COLORS = ["#26a69a", "#f5a623", "#e040fb", "#42a5f5"];
/** History window, in bars, when the main series has not loaded any yet. */
const DEFAULT_WINDOW_BARS = 1000;
const REMOVED_MESSAGE = "[raze-charts] widget was removed before compare data loaded";

/** The main-series data target a compare series was loaded for. */
interface CompareTarget {
  readonly symbol: string;
  readonly resolution: ResolutionString;
}

/** A compare series fetched but not yet shown (see prepare() and restore()). */
export interface PreparedCompare {
  readonly symbol: string;
  readonly info: LibrarySymbolInfo;
  readonly bars: Bar[];
  readonly target: CompareTarget;
  /** Oldest Unix second the loaded window covers. */
  readonly coveredFrom: number;
  /** False once the datafeed reported no older history. */
  readonly hasMore: boolean;
}

/** Controller-side state of one live compare series. */
interface CompareSeries {
  readonly id: string;
  readonly symbol: string;
  readonly info: LibrarySymbolInfo;
  /** Target the displayed bars belong to. */
  target: CompareTarget;
  coveredFrom: number;
  hasMore: boolean;
  /** Requests of the running reload or page; replaced by every new operation. */
  requests: CompareRequests;
  pending: "reload" | "page" | null;
  /** Target key of the running reload. */
  pendingKey: string | null;
  /** Target key whose reload failed; retried after the next target change or resetData(). */
  failedKey: string | null;
  /** Main-series oldest second at the last failed page; retried once the main series pages further. */
  pageFailedFrom: number | null;
  subscription: CompareSubscription | null;
}

const targetKey = (target: CompareTarget): string => `${target.symbol}\u0000${target.resolution}`;

/** Compare series of one widget. */
export class CompareController implements WidgetController {
  private readonly series = new Map<string, CompareSeries>();
  /** Request groups of in-flight createCompare()/prepare() calls, cancelled on destroy. */
  private readonly loads = new Set<CompareRequests>();
  private loaderInstance: CompareLoader | null = null;
  /** Scale mode to restore when the last compare goes; null when the user owns the mode. */
  private percentFrom: PriceScaleMode | null = null;
  private destroyed = false;
  private readonly sync = (): void => this.syncWithMainSeries();
  private readonly onScaleChanged = (change: ScaleChange): void => {
    if (change.reason !== "compare" && change.state.mode !== change.previous.mode) this.percentFrom = null;
  };

  constructor(private readonly host: WidgetHost) {}

  attach(): void {
    const context = this.host.context;
    // History merges fire dataChanged; revealTimeRange() pages without it and
    // ends with a viewport change, so both keep compares aligned.
    context.dataChanged.subscribe(this, this.sync);
    context.viewportChanged.subscribe(this, this.sync);
    context.rangeChanged.subscribe(this, this.sync);
    context.scaleChanged.subscribe(this, this.onScaleChanged);
  }

  /**
   * createCompare(): resolve `symbol`, load its history over the main series'
   * window, then show it and subscribe to its live bars. Rejects, adding
   * nothing, when the symbol cannot be resolved or its history fails.
   */
  async create(symbol: string): Promise<EntityId> {
    const name = typeof symbol === "string" ? symbol.trim() : "";
    if (!name) {
      throw new TypeError('[raze-charts] createCompare() needs a symbol name, for example createCompare("NASDAQ:AAPL")');
    }
    const prepared = await this.prepare(name);
    if (!prepared || this.isDestroyed()) throw new Error(REMOVED_MESSAGE);
    const first = this.host.context.compare.length === 0;
    const id = this.install(prepared);
    if (first) this.enterPercent();
    this.host.context.requestPaint();
    // The main series may have changed target or paged while this loaded.
    this.syncWithMainSeries();
    return id as EntityId;
  }

  /**
   * Fetch a compare series without showing it (layout restore fetches every
   * series before it replaces any). Rejects like create(); resolves null when
   * the widget is removed meanwhile.
   */
  async prepare(symbol: string): Promise<PreparedCompare | null> {
    if (this.isDestroyed()) return null;
    const requests = new CompareRequests();
    this.loads.add(requests);
    try {
      const info = await this.loader.resolve(symbol, requests);
      if (!info) return null;
      // Read the main series only now: it may have moved while resolving.
      const target = this.mainTarget();
      const span = this.mainWindow(target.resolution);
      const history = await this.loader.history(
        symbol,
        info,
        target.resolution,
        { ...span, firstDataRequest: true },
        requests,
      );
      if (!history || this.isDestroyed()) return null;
      return {
        symbol,
        info,
        bars: history.bars,
        target,
        coveredFrom: span.from,
        hasMore: !history.noData,
      };
    } finally {
      this.loads.delete(requests);
    }
  }

  /**
   * Replace every compare series with `prepared` (layout restore). The
   * restored scale flags are the layout's, so no percent switch happens.
   */
  restore(prepared: readonly PreparedCompare[]): void {
    if (this.isDestroyed()) return;
    for (const series of Array.from(this.series.values())) this.teardown(series);
    this.host.context.compare = [];
    this.percentFrom = null;
    for (const item of prepared) this.install(item);
    this.host.context.requestPaint();
    this.syncWithMainSeries();
  }

  /** Remove a compare series and stop its live bars; false when `id` is not one. */
  remove(id: EntityId | string): boolean {
    const context = this.host.context;
    const key = String(id);
    const series = this.series.get(key);
    const listed = context.compare.some((item) => item.id === key);
    if (!series && !listed) return false;
    if (series) this.teardown(series);
    if (listed) context.compare = context.compare.filter((item) => item.id !== key);
    if (!context.compare.length) this.leavePercent();
    context.requestPaint();
    return true;
  }

  /** resetData(): refetch every compare series, including ones whose last reload failed. */
  reload(): void {
    if (this.isDestroyed()) return;
    this.reconcile();
    for (const series of this.series.values()) {
      series.pageFailedFrom = null;
      this.reloadSeries(series);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const context = this.host.context;
    context.dataChanged.unsubscribeAll(this);
    context.viewportChanged.unsubscribeAll(this);
    context.rangeChanged.unsubscribeAll(this);
    context.scaleChanged.unsubscribeAll(this);
    for (const requests of Array.from(this.loads)) requests.cancel();
    this.loads.clear();
    for (const series of Array.from(this.series.values())) this.teardown(series);
  }

  // -- Internals -------------------------------------------------------------

  private get loader(): CompareLoader {
    if (!this.loaderInstance) {
      const data = this.host.data;
      this.loaderInstance = new CompareLoader({
        datafeed: this.host.context.datafeed,
        ready: () => data.ready(),
      });
    }
    return this.loaderInstance;
  }

  private isDestroyed(): boolean {
    return this.destroyed || this.host.lifecycle.destroyed;
  }

  private mainTarget(): CompareTarget {
    const { symbol, resolution } = this.host.context;
    return { symbol, resolution };
  }

  private stepSeconds(resolution: ResolutionString): number {
    return Math.max(1, Math.round(resolutionToMs(resolution) / 1000));
  }

  /** The main series' loaded window as getBars period params (`to` exclusive). */
  private mainWindow(resolution: ResolutionString): { from: number; to: number; countBack: number } {
    const { bars } = this.host.context;
    const step = this.stepSeconds(resolution);
    const first = bars[0];
    const last = bars[bars.length - 1];
    if (first && last) {
      return {
        from: Math.floor(first.time / 1000),
        to: Math.floor(last.time / 1000) + step,
        countBack: bars.length,
      };
    }
    const to = Math.floor(this.host.context.now() / 1000);
    return { from: to - DEFAULT_WINDOW_BARS * step, to, countBack: DEFAULT_WINDOW_BARS };
  }

  private entryOf(id: string): ChartCompareEntry | undefined {
    return this.host.context.compare.find((item) => item.id === id);
  }

  private nextColor(): string {
    const used = new Map<string, number>();
    for (const item of this.host.context.compare) used.set(item.color, (used.get(item.color) ?? 0) + 1);
    // The least-used palette colour, in palette order, so removing a series
    // never makes the next one repeat a colour that is still on screen.
    let best = COMPARE_COLORS[0]!;
    let bestCount = Infinity;
    for (const color of COMPARE_COLORS) {
      const count = used.get(color) ?? 0;
      if (count < bestCount) {
        best = color;
        bestCount = count;
      }
    }
    return best;
  }

  private install(prepared: PreparedCompare): string {
    const context = this.host.context;
    const id = context.ids.next("compare", {
      label: `compare_${prepared.symbol.replace(/\s+/g, "_")}`,
      isTaken: (candidate) => this.series.has(candidate) || context.compare.some((item) => item.id === candidate),
    });
    context.compare.push({
      id,
      symbol: prepared.symbol,
      bars: prepared.bars,
      color: this.nextColor(),
      resolution: prepared.target.resolution,
    });
    const series: CompareSeries = {
      id,
      symbol: prepared.symbol,
      info: prepared.info,
      target: prepared.target,
      coveredFrom: prepared.coveredFrom,
      hasMore: prepared.hasMore,
      requests: new CompareRequests(),
      pending: null,
      pendingKey: null,
      failedKey: null,
      pageFailedFrom: null,
      subscription: null,
    };
    this.series.set(id, series);
    this.subscribe(series);
    return id;
  }

  private teardown(series: CompareSeries): void {
    series.requests.cancel();
    series.subscription?.unsubscribe();
    series.subscription = null;
    series.pending = null;
    this.series.delete(series.id);
  }

  /** Stop series whose context entry was removed by a direct write. */
  private reconcile(): void {
    for (const series of Array.from(this.series.values())) {
      if (!this.entryOf(series.id)) this.teardown(series);
    }
  }

  private isLive(series: CompareSeries): boolean {
    return !this.isDestroyed() && this.series.get(series.id) === series;
  }

  private subscribe(series: CompareSeries): void {
    series.subscription?.unsubscribe();
    series.subscription = null;
    const resolution = series.target.resolution;
    try {
      series.subscription = this.loader.subscribe(
        series.symbol,
        series.info,
        resolution,
        (bar) => this.onLiveBar(series, bar),
        () => {
          if (!this.isLive(series)) return;
          series.pageFailedFrom = null;
          this.reloadSeries(series);
        },
      );
    } catch (error) {
      this.host.lifecycle.reportError(`subscribe to live compare bars for "${series.symbol}"`, error);
    }
  }

  private onLiveBar(series: CompareSeries, bar: Bar): void {
    const entry = this.entryOf(series.id);
    if (!this.isLive(series) || !entry) {
      if (this.series.get(series.id) === series) this.teardown(series);
      else if (series.subscription) series.subscription.unsubscribe();
      return;
    }
    const bars = entry.bars;
    const last = bars[bars.length - 1];
    if (last && bar.time === last.time) bars[bars.length - 1] = bar;
    else if (!last || bar.time > last.time) bars.push(bar);
    else return;
    this.host.context.requestPaint();
  }

  /** Refetch `series` for the main series' current target. */
  private reloadSeries(series: CompareSeries): void {
    const context = this.host.context;
    const target = this.mainTarget();
    const key = targetKey(target);
    series.requests.cancel();
    const requests = new CompareRequests();
    series.requests = requests;
    series.pending = "reload";
    series.pendingKey = key;
    series.failedKey = null;
    series.subscription?.unsubscribe();
    series.subscription = null;
    const entry = this.entryOf(series.id);
    if (entry && entry.resolution !== target.resolution) {
      // Bars of another resolution would be misplaced on this time axis.
      entry.bars = [];
      entry.resolution = target.resolution;
      context.requestPaint();
    }
    const span = this.mainWindow(target.resolution);
    void this.loader
      .history(series.symbol, series.info, target.resolution, { ...span, firstDataRequest: true }, requests)
      .then((history) => {
        if (!history || series.requests !== requests || !this.isLive(series)) return;
        series.pending = null;
        series.pendingKey = null;
        series.target = target;
        series.coveredFrom = span.from;
        series.hasMore = !history.noData;
        const current = this.entryOf(series.id);
        if (current) {
          current.bars = history.bars;
          current.resolution = target.resolution;
        }
        this.subscribe(series);
        context.requestPaint();
        this.syncWithMainSeries();
      })
      .catch((error: unknown) => {
        if (series.requests !== requests || !this.isLive(series)) return;
        series.pending = null;
        series.pendingKey = null;
        series.failedKey = key;
        this.host.lifecycle.reportError(`reload compare "${series.symbol}" at ${target.resolution}`, error);
      });
  }

  /** Extend `series` back to the main series' oldest bar. */
  private pageSeries(series: CompareSeries): void {
    const bars = this.host.context.bars;
    const oldest = bars[0];
    if (!oldest || !series.hasMore || series.pending) return;
    const from = Math.floor(oldest.time / 1000);
    if (from >= series.coveredFrom) return;
    if (series.pageFailedFrom !== null && from >= series.pageFailedFrom) return;
    const to = series.coveredFrom;
    const countBack = Math.max(1, countBefore(bars, to * 1000));
    const requests = new CompareRequests();
    series.requests = requests;
    series.pending = "page";
    void this.loader
      .history(series.symbol, series.info, series.target.resolution, { from, to, countBack, firstDataRequest: false }, requests)
      .then((history) => {
        if (!history || series.requests !== requests || !this.isLive(series)) return;
        series.pending = null;
        series.pageFailedFrom = null;
        // The requested range is covered even when it held no bars (a gap),
        // so a feed that ignores the boundary cannot be asked for it again.
        series.coveredFrom = Math.min(series.coveredFrom, from);
        if (history.noData) series.hasMore = false;
        const entry = this.entryOf(series.id);
        if (entry && history.bars.length) {
          entry.bars = normaliseCompareBars([...history.bars, ...entry.bars]);
          this.host.context.requestPaint();
        }
        this.syncWithMainSeries();
      })
      .catch((error: unknown) => {
        if (series.requests !== requests || !this.isLive(series)) return;
        series.pending = null;
        series.pageFailedFrom = from;
        this.host.lifecycle.reportError(`page compare "${series.symbol}" history`, error);
      });
  }

  /**
   * Bring every compare in line with the main series: refetch on a symbol or
   * resolution change, page when the main series paged further back.
   */
  private syncWithMainSeries(): void {
    if (this.isDestroyed()) return;
    this.reconcile();
    if (!this.series.size) return;
    const key = targetKey(this.mainTarget());
    for (const series of Array.from(this.series.values())) {
      const wanted = series.pending === "reload" ? series.pendingKey : targetKey(series.target);
      if (wanted !== key) {
        if (series.failedKey !== key) this.reloadSeries(series);
        continue;
      }
      if (series.pending === null) this.pageSeries(series);
    }
  }

  private enterPercent(): void {
    const context = this.host.context;
    const mode = context.scaleState().mode;
    if (mode === "percent") return;
    this.percentFrom = mode;
    // Autoscale too: a manual range in price units cannot frame percent values.
    context.setScaleMode({ mode: "percent", autoScale: true }, "compare");
  }

  private leavePercent(): void {
    const previous = this.percentFrom;
    this.percentFrom = null;
    if (previous === null) return;
    const context = this.host.context;
    if (context.scaleState().mode === "percent") context.setScaleMode({ mode: previous }, "compare");
  }
}

type ChartCompareEntry = WidgetHost["context"]["compare"][number];

/** Number of bars strictly older than `timeMs` (bars ascending). */
function countBefore(bars: readonly Bar[], timeMs: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid]!.time < timeMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

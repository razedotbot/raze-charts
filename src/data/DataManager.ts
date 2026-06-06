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
} from "../types/charting_library";
import type { ChartContext } from "../core/context";
import { resolutionToMs } from "../util/resolution";

let guidCounter = 0;
const nextGuid = (): string => `raze_${++guidCounter}_${Math.floor(performance.now())}`;

/** How many bars to request in the first history window. */
const INITIAL_BARS = 1500;
/** How many bars to request on each left-scroll page. */
const PAGE_BARS = 1000;

export class DataManager {
  private config: DatafeedConfiguration | null = null;
  private subGuid: string | null = null;
  private liveTick: ((bar: Bar) => void) | null = null;

  /** True while a history request is in flight (guards against re-entrancy). */
  private loading = false;
  /** False once the datafeed reports `noData` for older history. */
  private hasMoreHistory = true;
  /** Resolves when onReady has fired. */
  private readyPromise: Promise<void>;

  constructor(private readonly context: ChartContext) {
    this.readyPromise = new Promise<void>((resolve) => {
      this.context.datafeed.onReady((cfg: DatafeedConfiguration) => {
        this.config = cfg;
        resolve();
      });
    });
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  getConfig(): DatafeedConfiguration | null {
    return this.config;
  }

  // ── Symbol resolution + initial load ────────────────────────────────────────
  async resolveAndLoad(): Promise<void> {
    await this.ready();
    const info = await this.resolveSymbol(this.context.symbol);
    this.context.symbolInfo = info;
    await this.loadInitial();
  }

  private resolveSymbol(symbol: string): Promise<LibrarySymbolInfo> {
    return new Promise<LibrarySymbolInfo>((resolve, reject) => {
      this.context.datafeed.resolveSymbol(
        symbol,
        (info) => resolve(info),
        (reason) => reject(new Error(reason)),
      );
    });
  }

  private async loadInitial(): Promise<void> {
    this.hasMoreHistory = true;
    this.context.bars = [];
    const resMs = resolutionToMs(this.context.resolution);
    const nowSec = Math.floor(Date.now() / 1000);
    const fromSec = nowSec - Math.ceil((INITIAL_BARS * resMs) / 1000);
    const bars = await this.requestBars(
      { from: fromSec, to: nowSec, countBack: INITIAL_BARS, firstDataRequest: true },
    );
    this.mergeBars(bars);
    this.initVisibleRange();
    this.startLiveSubscription();
    await this.loadMarks();
    this.context.dataChanged.fire();
    this.context.requestPaint();
  }

  /** Position the initial visible window over the most recent ~120 bars. */
  private initVisibleRange(): void {
    const n = this.context.bars.length;
    if (n === 0) {
      this.context.visibleRange = { from: 0, to: 1 };
      return;
    }
    const visibleCount = Math.min(n, 120);
    // A small right gutter (TV's default scroll position), but capped so sparse
    // charts don't open with a wall of empty space on the right.
    const rightPad = Math.min(8, Math.max(1, Math.round(visibleCount * 0.06)));
    this.context.visibleRange = {
      from: n - visibleCount,
      to: n - 1 + rightPad,
    };
    this.context.autoScalePrice = true;
  }

  // ── Lazy left-scroll pagination ─────────────────────────────────────────────
  /** Called by the engine when the visible range nears the left edge. */
  async maybeLoadMoreHistory(): Promise<void> {
    if (this.loading || !this.hasMoreHistory) return;
    const bars = this.context.bars;
    if (!bars.length) return;
    // Trigger when the left of the visible range is within 50 bars of bar 0.
    if (this.context.visibleRange.from > 50) return;

    this.loading = true;
    try {
      const oldestMs = bars[0]!.time;
      const resMs = resolutionToMs(this.context.resolution);
      const toSec = Math.floor(oldestMs / 1000) - 1;
      const fromSec = toSec - Math.ceil((PAGE_BARS * resMs) / 1000);
      const older = await this.requestBars(
        { from: fromSec, to: toSec, countBack: PAGE_BARS, firstDataRequest: false },
      );
      if (!older.length) {
        this.hasMoreHistory = false;
      } else {
        const addedBefore = this.context.bars.length;
        this.mergeBars(older);
        const addedCount = this.context.bars.length - addedBefore;
        // Shift the visible range right by however many bars were prepended so
        // the view stays anchored on the same candles.
        if (addedCount > 0) {
          this.context.visibleRange = {
            from: this.context.visibleRange.from + addedCount,
            to: this.context.visibleRange.to + addedCount,
          };
        }
      }
      this.context.dataChanged.fire();
      this.context.requestPaint();
    } finally {
      this.loading = false;
    }
  }

  private requestBars(periodParams: PeriodParams): Promise<Bar[]> {
    const info = this.context.symbolInfo;
    if (!info) return Promise.resolve([]);
    return new Promise<Bar[]>((resolve) => {
      let settled = false;
      const done = (bars: Bar[]): void => {
        if (settled) return;
        settled = true;
        resolve(bars);
      };
      this.context.datafeed.getBars(
        info,
        this.context.resolution,
        periodParams,
        (bars: Bar[], meta?: HistoryMetadata) => {
          if (meta?.noData && (!bars || bars.length === 0)) {
            done([]);
          } else {
            done(bars ?? []);
          }
        },
        () => done([]),
      );
    });
  }

  /** Merge a batch into the canonical series, dedup by time, keep ascending. */
  private mergeBars(batch: Bar[]): void {
    if (!batch.length) return;
    const byTime = new Map<number, Bar>();
    for (const b of this.context.bars) byTime.set(b.time, b);
    for (const b of batch) {
      if (!Number.isFinite(b.time)) continue;
      byTime.set(b.time, b);
    }
    const merged = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
    this.context.bars = merged;
  }

  // ── Live subscription ───────────────────────────────────────────────────────
  private startLiveSubscription(): void {
    this.stopLiveSubscription();
    const info = this.context.symbolInfo;
    if (!info) return;
    const guid = nextGuid();
    this.subGuid = guid;
    this.liveTick = (bar: Bar) => this.onLiveBar(bar);
    this.context.datafeed.subscribeBars(
      info,
      this.context.resolution,
      (bar: Bar) => this.liveTick?.(bar),
      guid,
      () => this.onResetCacheNeeded(),
    );
  }

  private stopLiveSubscription(): void {
    if (this.subGuid) {
      try {
        this.context.datafeed.unsubscribeBars(this.subGuid);
      } catch {
        /* ignore */
      }
      this.subGuid = null;
      this.liveTick = null;
    }
  }

  private onLiveBar(bar: Bar): void {
    if (!Number.isFinite(bar.time)) return;
    const bars = this.context.bars;
    const last = bars[bars.length - 1];
    // Was the viewport pinned to the right edge before this tick?
    const pinnedRight = bars.length > 0 && this.context.visibleRange.to >= bars.length - 1;
    if (last && bar.time === last.time) {
      bars[bars.length - 1] = bar; // update the forming bar
    } else if (!last || bar.time > last.time) {
      bars.push(bar); // a new bar opened
      if (pinnedRight) {
        this.context.visibleRange = {
          from: this.context.visibleRange.from + 1,
          to: this.context.visibleRange.to + 1,
        };
      }
    } else {
      return; // out-of-order historical tick — ignore
    }
    this.context.dataChanged.fire();
    this.context.requestPaint();
  }

  private async onResetCacheNeeded(): Promise<void> {
    this.context.bars = [];
    await this.loadInitial();
  }

  // ── Marks ───────────────────────────────────────────────────────────────────
  async loadMarks(): Promise<void> {
    const info = this.context.symbolInfo;
    const df = this.context.datafeed;
    if (!info || typeof df.getMarks !== "function") {
      this.context.marks = [];
      return;
    }
    const bars = this.context.bars;
    if (!bars.length) {
      this.context.marks = [];
      return;
    }
    const from = Math.floor(bars[0]!.time / 1000);
    const to = Math.floor(bars[bars.length - 1]!.time / 1000) + 86_400;
    await new Promise<void>((resolve) => {
      let settled = false;
      df.getMarks!(
        info,
        from,
        to,
        (marks: Mark[]) => {
          if (settled) return;
          settled = true;
          this.context.marks = marks ?? [];
          resolve();
        },
        this.context.resolution,
      );
      // getMarks may never call back if the provider is empty; resolve next tick.
      queueMicrotask(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
    });
  }

  refreshMarks(): void {
    void this.loadMarks().then(() => {
      this.context.dataChanged.fire();
      this.context.requestPaint();
    });
  }

  clearMarks(): void {
    this.context.marks = [];
    this.context.dataChanged.fire();
    this.context.requestPaint();
  }

  // ── Resolution / symbol changes ─────────────────────────────────────────────
  async changeResolution(res: ResolutionString): Promise<void> {
    if (res === this.context.resolution) return;
    this.stopLiveSubscription();
    this.context.resolution = res;
    await this.loadInitial();
    // Notify subscribers (the app persists the interval + repaints overlays).
    const tfObj: { timeframe?: { value: string; type: string } } = {};
    this.context.intervalChanged.fire(res, tfObj);
  }

  async changeSymbol(symbol: string): Promise<void> {
    if (symbol === this.context.symbol) return;
    this.stopLiveSubscription();
    this.context.symbol = symbol;
    this.context.symbolInfo = await this.resolveSymbol(symbol);
    await this.loadInitial();
  }

  resetData(): void {
    void this.loadInitial();
  }

  destroy(): void {
    this.stopLiveSubscription();
  }
}

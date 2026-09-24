// Datafeed access for compare overlays: symbol resolution, history windows and
// live subscriptions for symbols drawn over the main series. The loader holds
// no series state; CompareController decides what to request and when.
//
// Every failure rejects with an actionable `[raze-charts]` message instead of
// degrading into an empty series, and every request belongs to a
// CompareRequests group so a superseded load, a removed series or a torn-down
// widget can drop its pending callbacks without waiting on the datafeed.

import type {
  Bar,
  HistoryMetadata,
  IBasicDataFeed,
  LibrarySymbolInfo,
  PeriodParams,
  ResolutionString,
} from "../types/charting_library";

/** One history window returned by the datafeed, normalised. */
export interface CompareHistory {
  /** Finite-time bars, ascending, one per timestamp. */
  readonly bars: Bar[];
  /** The datafeed reported that no older data exists. */
  readonly noData: boolean;
}

/** A live compare subscription; `unsubscribe()` is idempotent. */
export interface CompareSubscription {
  readonly guid: string;
  readonly active: boolean;
  unsubscribe(): void;
}

export interface CompareLoaderDeps {
  readonly datafeed: IBasicDataFeed;
  /** Settles once the datafeed's onReady fired (the DataManager's ready()). */
  ready(): Promise<void>;
}

let guidCounter = 0;
/**
 * Page-unique listener GUIDs, distinct from the main series' `raze_<n>_...`
 * ids, so a datafeed shared by several widgets can route every compare tick.
 */
const nextCompareGuid = (): string =>
  `raze_compare_${++guidCounter}_${Math.floor(typeof performance === "undefined" ? 0 : performance.now())}`;

export const describeReason = (reason: unknown): string => {
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === "string" && reason.trim()) return reason;
  return "unknown datafeed error";
};

/** Drop malformed bars, de-duplicate by time (last wins) and sort ascending. */
export function normaliseCompareBars(batch: readonly Bar[]): Bar[] {
  const byTime = new Map<number, Bar>();
  for (const bar of batch) {
    if (!bar || !Number.isFinite(bar.time) || !Number.isFinite(bar.close)) continue;
    byTime.set(bar.time, bar);
  }
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

/**
 * A cancellable group of in-flight requests. Cancelling settles every pending
 * request of the group with `null`; requests started afterwards resolve `null`
 * immediately. Late datafeed callbacks are ignored.
 */
export class CompareRequests {
  private readonly pending = new Set<() => void>();
  private done = false;

  get cancelled(): boolean {
    return this.done;
  }

  cancel(): void {
    if (this.done) return;
    this.done = true;
    const pending = Array.from(this.pending);
    this.pending.clear();
    for (const settle of pending) settle();
  }

  /**
   * Run a callback-style request. `start` receives `resolve`/`reject`; the
   * returned promise resolves `null` if the group is cancelled first.
   */
  run<T>(start: (resolve: (value: T) => void, reject: (error: unknown) => void) => void): Promise<T | null> {
    return new Promise<T | null>((resolve, reject) => {
      if (this.done) {
        resolve(null);
        return;
      }
      let settled = false;
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        this.pending.delete(onCancel);
        return true;
      };
      const onCancel = (): void => {
        if (settle()) resolve(null);
      };
      this.pending.add(onCancel);
      try {
        start(
          (value) => {
            if (settle()) resolve(this.done ? null : value);
          },
          (error) => {
            if (!settle()) return;
            if (this.done) resolve(null);
            else reject(error);
          },
        );
      } catch (error) {
        if (settle()) {
          if (this.done) resolve(null);
          else reject(error);
        }
      }
    });
  }
}

export class CompareLoader {
  constructor(private readonly deps: CompareLoaderDeps) {}

  /**
   * Resolve `symbol` through the datafeed. Rejects with
   * `[raze-charts] compare symbol "X" could not be resolved: <reason>`;
   * resolves `null` only when `requests` was cancelled.
   */
  async resolve(symbol: string, requests: CompareRequests): Promise<LibrarySymbolInfo | null> {
    const fail = (reason: unknown): Error =>
      new Error(`[raze-charts] compare symbol "${symbol}" could not be resolved: ${describeReason(reason)}`);
    try {
      await this.deps.ready();
    } catch (error) {
      throw fail(error);
    }
    if (requests.cancelled) return null;
    let info: LibrarySymbolInfo | null;
    try {
      info = await requests.run<LibrarySymbolInfo>((resolve, reject) => {
        this.deps.datafeed.resolveSymbol(
          symbol,
          (resolved) => resolve(resolved),
          (reason) => reject(reason),
        );
      });
    } catch (error) {
      throw fail(error);
    }
    if (info === null) return null;
    if (!info || typeof info !== "object") throw fail("the datafeed resolved no symbol info");
    return info;
  }

  /**
   * Request one history window. Rejects with
   * `[raze-charts] compare symbol "X" history could not be loaded at <res>: <reason>`;
   * resolves `null` only when `requests` was cancelled.
   */
  async history(
    symbol: string,
    info: LibrarySymbolInfo,
    resolution: ResolutionString,
    period: PeriodParams,
    requests: CompareRequests,
  ): Promise<CompareHistory | null> {
    try {
      const result = await requests.run<{ bars: Bar[]; meta: HistoryMetadata | undefined }>((resolve, reject) => {
        this.deps.datafeed.getBars(
          info,
          resolution,
          { ...period },
          (bars, meta) => resolve({ bars: Array.isArray(bars) ? bars : [], meta }),
          (reason) => reject(reason),
        );
      });
      if (!result) return null;
      return { bars: normaliseCompareBars(result.bars), noData: result.meta?.noData === true };
    } catch (error) {
      throw new Error(
        `[raze-charts] compare symbol "${symbol}" history could not be loaded at ${resolution}: ${describeReason(error)}`,
      );
    }
  }

  /**
   * Subscribe to live bars with a fresh GUID. Callbacks stop as soon as the
   * subscription is unsubscribed, even if the datafeed keeps calling them.
   * Throws with guidance when the datafeed's subscribeBars throws.
   */
  subscribe(
    symbol: string,
    info: LibrarySymbolInfo,
    resolution: ResolutionString,
    onBar: (bar: Bar) => void,
    onReset: () => void,
  ): CompareSubscription {
    const datafeed = this.deps.datafeed;
    const guid = nextCompareGuid();
    let active = true;
    const subscription: CompareSubscription = {
      guid,
      get active() {
        return active;
      },
      unsubscribe() {
        if (!active) return;
        active = false;
        try {
          datafeed.unsubscribeBars(guid);
        } catch {
          // Teardown is best-effort; `active` already mutes late callbacks.
        }
      },
    };
    try {
      datafeed.subscribeBars(
        info,
        resolution,
        (bar) => {
          if (active && bar && Number.isFinite(bar.time) && Number.isFinite(bar.close)) onBar(bar);
        },
        guid,
        () => {
          // Deferred so a feed that resets synchronously inside subscribeBars
          // cannot recurse into a new subscription.
          queueMicrotask(() => {
            if (active) onReset();
          });
        },
      );
    } catch (error) {
      active = false;
      throw new Error(
        `[raze-charts] compare symbol "${symbol}" live bars could not be subscribed at ${resolution}: ${describeReason(error)}`,
      );
    }
    return subscription;
  }
}

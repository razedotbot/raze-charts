import type {
  Bar,
  DatafeedConfiguration,
  DatafeedSymbolType,
  Exchange,
  HistoryMetadata,
  IBasicDataFeed,
  LibrarySymbolInfo,
  Mark,
  ResolutionString,
  SearchSymbolResultItem,
} from "../types/charting_library";

export type MaybePromise<T> = T | PromiseLike<T>;

export interface HistoryRequest {
  symbol: string;
  symbolInfo: LibrarySymbolInfo;
  resolution: ResolutionString;
  /** Unix timestamp in seconds. */
  from: number;
  /** Unix timestamp in seconds, exclusive. */
  to: number;
  countBack: number;
  firstDataRequest: boolean;
}

export interface HistoryResult {
  bars: readonly Bar[];
  meta?: HistoryMetadata;
}

export interface SymbolSearchRequest {
  query: string;
  exchange: string;
  symbolType: string;
}

export interface MarksRequest {
  symbol: string;
  symbolInfo: LibrarySymbolInfo;
  resolution: ResolutionString;
  /** Unix timestamp in seconds. */
  from: number;
  /** Unix timestamp in seconds. */
  to: number;
}

export interface RealtimeRequest {
  symbol: string;
  symbolInfo: LibrarySymbolInfo;
  resolution: ResolutionString;
  /** Aborted as soon as the widget unsubscribes, including during async setup. */
  signal: AbortSignal;
}

export interface RealtimeHandlers {
  next(bar: Bar): void;
  reset(): void;
}

export type RealtimeCleanup = () => MaybePromise<void>;

export interface RazeDataSource {
  /** Static configuration or lazy discovery. `onReady` remains async for compatibility. */
  configuration?: DatafeedConfiguration | (() => MaybePromise<DatafeedConfiguration>);
  resolveSymbol(symbol: string): MaybePromise<LibrarySymbolInfo>;
  getBars(request: HistoryRequest): MaybePromise<readonly Bar[] | HistoryResult>;
  searchSymbols?(request: SymbolSearchRequest): MaybePromise<readonly SearchSymbolResultItem[]>;
  getMarks?(request: MarksRequest): MaybePromise<readonly Mark[]>;
  getServerTime?(): MaybePromise<number>;
  subscribeBars?(
    request: RealtimeRequest,
    handlers: RealtimeHandlers,
  ): MaybePromise<void | RealtimeCleanup>;
}

export interface DefineDataSourceOptions {
  exchanges?: Exchange[];
  supportedResolutions?: ResolutionString[];
  symbolTypes?: DatafeedSymbolType[];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === "string" ? error : "Unknown data source error";
}

function invoke<T>(operation: () => MaybePromise<T>): Promise<T> {
  // Starting from an already-resolved promise turns sync throws and thenables
  // into the same predictable async failure channel.
  return Promise.resolve().then(operation);
}

function safely(operation: () => void): void {
  try {
    operation();
  } catch (error) {
    // Consumer callbacks must not corrupt adapter state, but their errors are reported.
    console.error("[raze-charts] datafeed callback threw", error);
  }
}

function cleanupSafely(cleanup: RealtimeCleanup): void {
  try {
    const result = cleanup();
    if (result && typeof result.then === "function") {
      void Promise.resolve(result).catch(() => {});
    }
  } catch {
    // Cleanup is best-effort and must never leak a rejection to the host.
  }
}

function normalizeHistory(result: readonly Bar[] | HistoryResult): HistoryResult {
  if (Array.isArray(result)) return { bars: Array.from(result), meta: { noData: result.length === 0 } };
  const history = result as HistoryResult;
  if (!history || !Array.isArray(history.bars)) {
    throw new TypeError("RazeDataSource.getBars() must return a Bar[] or { bars, meta } result.");
  }
  return {
    bars: Array.from(history.bars),
    meta: {
      ...history.meta,
      noData: history.meta?.noData ?? history.bars.length === 0,
    },
  };
}

function fallbackConfiguration(source: RazeDataSource, defaults?: DefineDataSourceOptions): DatafeedConfiguration {
  return {
    exchanges: defaults?.exchanges ?? [],
    supported_resolutions: defaults?.supportedResolutions ?? [],
    symbols_types: defaults?.symbolTypes ?? [],
    supports_marks: Boolean(source.getMarks),
    supports_time: Boolean(source.getServerTime),
  };
}

function configurationFor(source: RazeDataSource, defaults?: DefineDataSourceOptions): MaybePromise<DatafeedConfiguration> {
  const configured = typeof source.configuration === "function"
    ? source.configuration()
    : source.configuration;
  const fallback = fallbackConfiguration(source, defaults);
  if (!configured) return fallback;
  if (typeof (configured as PromiseLike<DatafeedConfiguration>).then === "function") {
    return Promise.resolve(configured).then((value) => ({ ...fallback, ...value }));
  }
  return { ...fallback, ...configured };
}

/**
 * Adapts a Promise-first Raze data source to the TradingView-compatible
 * callback protocol consumed by `widget`. The adapter owns subscription
 * teardown and makes late async setup safe.
 */
export function createDatafeed(
  source: RazeDataSource,
  defaults?: DefineDataSourceOptions,
): IBasicDataFeed {
  const subscriptions = new Map<string, { controller: AbortController; cleanup?: RealtimeCleanup }>();

  const datafeed: IBasicDataFeed = {
    onReady(callback) {
      // TV requires this callback to be asynchronous even for static config.
      queueMicrotask(() => {
        invoke(() => configurationFor(source, defaults))
          .then(
            (configuration) => safely(() => callback(configuration)),
            () => safely(() => callback(fallbackConfiguration(source, defaults))),
          );
      });
    },

    searchSymbols(userInput, exchange, symbolType, onResult) {
      if (!source.searchSymbols) {
        queueMicrotask(() => safely(() => onResult([])));
        return;
      }
      invoke(() => source.searchSymbols!({ query: userInput, exchange, symbolType }))
        .then((items) => Array.from(items))
        .then(
          (items) => safely(() => onResult(items)),
          () => safely(() => onResult([])),
        );
    },

    resolveSymbol(symbolName, onResolve, onError) {
      invoke(() => source.resolveSymbol(symbolName))
        .then(
          (info) => safely(() => onResolve(info)),
          (error: unknown) => safely(() => onError(errorMessage(error))),
        );
    },

    getBars(symbolInfo, resolution, periodParams, onResult, onError) {
      invoke(() => source.getBars({
        symbol: symbolInfo.ticker ?? symbolInfo.name,
        symbolInfo,
        resolution,
        from: periodParams.from,
        to: periodParams.to,
        countBack: periodParams.countBack,
        firstDataRequest: periodParams.firstDataRequest,
      }))
        .then(normalizeHistory)
        .then(
          (history) => safely(() => onResult(Array.from(history.bars), history.meta)),
          (error: unknown) => safely(() => onError(errorMessage(error))),
        );
    },

    subscribeBars(symbolInfo, resolution, onTick, listenerGuid, onResetCacheNeededCallback) {
      datafeed.unsubscribeBars(listenerGuid);
      const controller = new AbortController();
      const record: { controller: AbortController; cleanup?: RealtimeCleanup } = { controller };
      subscriptions.set(listenerGuid, record);
      if (!source.subscribeBars) return;

      invoke(() => source.subscribeBars!(
        {
          symbol: symbolInfo.ticker ?? symbolInfo.name,
          symbolInfo,
          resolution,
          signal: controller.signal,
        },
        {
          next: (bar) => {
            if (!controller.signal.aborted && subscriptions.get(listenerGuid) === record) safely(() => onTick(bar));
          },
          reset: () => {
            if (!controller.signal.aborted && subscriptions.get(listenerGuid) === record) {
              safely(onResetCacheNeededCallback);
            }
          },
        },
      )).then((cleanup) => {
        if (typeof cleanup !== "function") return;
        if (controller.signal.aborted || subscriptions.get(listenerGuid) !== record) {
          cleanupSafely(cleanup);
        } else {
          record.cleanup = cleanup;
        }
      }, () => {
        if (!controller.signal.aborted && subscriptions.get(listenerGuid) === record) {
          // Reset means "cached history is invalid", not "subscription setup
          // failed". Treating rejection as reset creates an unbounded
          // history→subscribe→reset retry loop in callback-style consumers.
          subscriptions.delete(listenerGuid);
          controller.abort();
        }
      });
    },

    unsubscribeBars(listenerGuid) {
      const record = subscriptions.get(listenerGuid);
      if (!record) return;
      subscriptions.delete(listenerGuid);
      record.controller.abort();
      if (record.cleanup) cleanupSafely(record.cleanup);
    },
  };

  if (source.getMarks) {
    datafeed.getMarks = (symbolInfo, from, to, onData, resolution) => {
      invoke(() => source.getMarks!({
        symbol: symbolInfo.ticker ?? symbolInfo.name,
        symbolInfo,
        resolution,
        from,
        to,
      }))
        .then((marks) => Array.from(marks))
        .then(
          (marks) => safely(() => onData(marks)),
          () => safely(() => onData([])),
        );
    };
  }

  if (source.getServerTime) {
    datafeed.getServerTime = (callback) => {
      invoke(() => source.getServerTime!()).then((time) => safely(() => callback(time)), () => {});
    };
  }

  return datafeed;
}

/** Identity helper that preserves inference and documents the native contract. */
export function defineDataSource<T extends RazeDataSource>(source: T): T {
  return source;
}

// Widget lifecycle: readiness (onChartReady / headerReady), teardown state,
// consumer-callback isolation and imperative data-change orchestration where
// only the newest request may complete.

import type { ResolutionString } from "../../types/charting_library";
import { Delegate } from "../../util/delegate";
import { normalizeResolution } from "../../util/resolution";
import type { WidgetHost } from "./host";

export class LifecycleController {
  destroyed = false;
  /** Bumped by every imperative data change, layout load and teardown. */
  dataChangeId = 0;
  private ready = false;
  private readonly chartReady = new Delegate<[]>();
  private headerSettled = false;
  private resolveHeader!: () => void;
  private readonly headerPromise = new Promise<void>((resolve) => {
    this.resolveHeader = resolve;
  });

  constructor(private readonly host: WidgetHost) {}

  onChartReady(callback: () => void): void {
    const safeCallback = (): void => this.callConsumer("onChartReady", callback);
    if (this.ready) queueMicrotask(safeCallback);
    else this.chartReady.subscribe(null, safeCallback as never, true);
  }

  headerReady(): Promise<void> {
    return this.headerPromise;
  }

  /** Boot finished: release headerReady waiters, then onChartReady callbacks. */
  markReady(): void {
    this.settleHeader();
    this.ready = true;
    this.chartReady.fire();
  }

  /** Consumers awaiting headerReady must not hang when a widget is removed mid-boot. */
  settleHeader(): void {
    if (this.headerSettled) return;
    this.headerSettled = true;
    this.resolveHeader();
  }

  changeSymbol(symbol: string, interval?: ResolutionString, callback?: () => void): void {
    // Invalid intervals throw a RangeError to the caller instead of loading 1m.
    if (interval !== undefined) normalizeResolution(interval);
    this.runDataChange(
      `change symbol to ${symbol}`,
      () => this.host.data.changeSymbol(symbol, interval),
      callback,
      () => this.host.controllers.chrome.syncSymbol(symbol),
    );
  }

  changeResolution(resolution: ResolutionString, callback?: () => void): void {
    normalizeResolution(resolution);
    this.runDataChange(
      `change resolution to ${resolution}`,
      () => this.host.data.changeResolution(resolution),
      callback,
    );
  }

  /**
   * Start a data change. `after` and `callback` run only if no newer change
   * started meanwhile; `onError` rolls chrome back when the request fails.
   */
  runDataChange(
    description: string,
    start: () => Promise<void>,
    callback?: () => void,
    after?: () => void,
    onError?: () => void,
  ): void {
    if (this.destroyed) return;
    const requestId = ++this.dataChangeId;
    const chrome = this.host.controllers.chrome;
    const fail = (error: unknown): void => {
      this.reportError(description, error);
      if (!this.host.context.bars.length) chrome.showLoadingError();
      try {
        onError?.();
      } catch (rollbackError) {
        this.reportError(`rollback ${description}`, rollbackError);
      }
    };
    let request: Promise<void>;
    try {
      request = start();
    } catch (error) {
      fail(error);
      return;
    }
    const current = (): boolean => !this.destroyed && requestId === this.dataChangeId;
    void request
      .then(() => {
        if (!current()) return;
        chrome.syncAccessibility();
        if (!this.host.context.bars.length) chrome.showEmptyState();
        try {
          after?.();
        } catch (error) {
          this.reportError(`finish ${description}`, error);
        }
        if (callback) this.callConsumer(`${description} callback`, callback);
      })
      .catch((error: unknown) => {
        if (current()) fail(error);
      });
  }

  /** Run a consumer callback; a throw is reported instead of breaking the widget. */
  callConsumer(description: string, callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.reportError(description, error);
    }
  }

  reportError(operation: string, error: unknown): void {
    console.error(`[raze-charts] failed to ${operation}`, error);
  }

  destroy(): void {
    this.chartReady.destroy();
  }
}

// Widget-level `subscribe` / `unsubscribe` events: the catalogue of events
// that actually fire, forwarding of drawing and trading lifecycle events from
// the shared context, and the `error` event for listeners that throw.

import type { WidgetEventName, WidgetListenerError } from "../../types/charting_library";
import { Delegate } from "../../util/delegate";
import type { WidgetController, WidgetHost } from "./host";

declare module "./host" {
  interface WidgetControllerMap {
    events: EventHub;
  }
}

type Listener = (...args: never[]) => void;

/**
 * Every widget event that fires. A name outside this list throws, so a typo
 * or a TradingView event Raze Charts does not emit is never a silent no-op.
 */
export const WIDGET_EVENTS: readonly WidgetEventName[] = Object.freeze(["drawing_event", "trading_event", "error"]);

export class EventHub implements WidgetController {
  private readonly subscriptions = new Map<string, Set<Listener>>();
  /** Private owner of the hub's own context subscriptions; host code cannot reach it. */
  private readonly owner = {};

  constructor(private readonly host: WidgetHost) {}

  attach(): void {
    const context = this.host.context;
    context.drawingEvent.subscribe(this.owner, ((id: string, type: string) => {
      this.emit("drawing_event", id, type);
    }) as never);
    context.tradingEvent.subscribe(this.owner, ((line: unknown, type: string) => {
      this.emit("trading_event", line, type);
    }) as never);
    // Listener errors of every context delegate (host views such as
    // onIntervalChanged() included) surface through the `error` event.
    for (const [label, value] of Object.entries(context)) {
      if (value instanceof Delegate) value.reportErrorsTo((error, event) => this.emitError(event, error), label);
    }
  }

  subscribe(event: string, callback: Listener): void {
    this.check(event, "subscribe", callback);
    let set = this.subscriptions.get(event);
    if (!set) {
      set = new Set();
      this.subscriptions.set(event, set);
    }
    set.add(callback);
  }

  unsubscribe(event: string, callback: Listener): void {
    this.check(event, "unsubscribe", callback);
    this.subscriptions.get(event)?.delete(callback);
  }

  /**
   * Call every listener of `event`. A throwing listener is logged, reported
   * through the `error` event, and cannot starve the rest.
   */
  emit(event: string, ...args: unknown[]): void {
    const set = this.subscriptions.get(event);
    if (!set) return;
    for (const callback of Array.from(set)) {
      try {
        (callback as (...a: unknown[]) => void)(...args);
      } catch (error) {
        console.error(`[raze-charts] ${event} listener threw`, error);
        this.emitError(event, error);
      }
    }
  }

  destroy(): void {
    const context = this.host.context;
    context.drawingEvent.unsubscribeAll(this.owner);
    context.tradingEvent.unsubscribeAll(this.owner);
    this.subscriptions.clear();
  }

  /** Deliver a listener failure to `error` listeners; their own throws are only logged. */
  private emitError(event: string, cause: unknown): void {
    const set = this.subscriptions.get("error");
    if (!set?.size || event === "error") return;
    const payload: WidgetListenerError = { code: "listener_threw", event, cause };
    for (const callback of Array.from(set)) {
      try {
        (callback as (error: WidgetListenerError) => void)(payload);
      } catch (error) {
        console.error("[raze-charts] error listener threw", error);
      }
    }
  }

  private check(event: string, method: string, callback: unknown): void {
    const problem = !(WIDGET_EVENTS as readonly string[]).includes(event)
      ? `unsupported event; supported events: ${WIDGET_EVENTS.join(", ")}`
      : typeof callback !== "function" ? "needs a callback function" : "";
    if (problem) throw new TypeError(`[raze-charts] widget.${method}("${String(event)}"): ${problem}`);
  }
}

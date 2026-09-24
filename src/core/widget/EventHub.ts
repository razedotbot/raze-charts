// Widget-level `subscribe` / `unsubscribe` events, including forwarding of
// drawing and trading lifecycle events from the shared context.

import type { WidgetController, WidgetHost } from "./host";

declare module "./host" {
  interface WidgetControllerMap {
    events: EventHub;
  }
}

type Listener = (...args: never[]) => void;

export class EventHub implements WidgetController {
  private readonly subscriptions = new Map<string, Set<Listener>>();

  constructor(private readonly host: WidgetHost) {}

  attach(): void {
    const { drawingEvent, tradingEvent } = this.host.context;
    drawingEvent.subscribe(null, ((id: string, type: string) => {
      this.emit("drawing_event", id, type);
    }) as never);
    tradingEvent.subscribe(null, ((line: unknown, type: string) => {
      this.emit("trading_event", line, type);
    }) as never);
  }

  subscribe(event: string, callback: Listener): void {
    let set = this.subscriptions.get(event);
    if (!set) {
      set = new Set();
      this.subscriptions.set(event, set);
    }
    set.add(callback);
  }

  unsubscribe(event: string, callback: Listener): void {
    this.subscriptions.get(event)?.delete(callback);
  }

  /** Call every listener of `event`; one throwing listener cannot starve the rest. */
  emit(event: string, ...args: unknown[]): void {
    const set = this.subscriptions.get(event);
    if (!set) return;
    for (const callback of Array.from(set)) {
      try {
        (callback as (...a: unknown[]) => void)(...args);
      } catch {
        /* ignore */
      }
    }
  }

  destroy(): void {
    this.subscriptions.clear();
  }
}

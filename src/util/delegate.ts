// A tiny event delegate implementing TradingView's ISubscription shape.
// `onIntervalChanged()` and friends return one of these; consumers call
// `.subscribe(obj, fn)` and we fire all registered listeners on `.fire(...)`.

type Listener = {
  obj: object | null;
  fn: (...args: never[]) => void;
  once: boolean;
};

export class Delegate<TArgs extends unknown[] = unknown[]> {
  private listeners: Listener[] = [];

  subscribe(obj: object | null, fn: (...args: never[]) => void, once = false): void {
    this.listeners.push({ obj, fn, once });
  }

  unsubscribe(obj: object | null, fn: (...args: never[]) => void): void {
    this.listeners = this.listeners.filter((l) => !(l.obj === obj && l.fn === fn));
  }

  unsubscribeAll(obj: object | null): void {
    this.listeners = this.listeners.filter((l) => l.obj !== obj);
  }

  fire(...args: TArgs): void {
    // Copy so once-listeners removed mid-iteration don't skip neighbours.
    const snapshot = this.listeners.slice();
    for (const l of snapshot) {
      try {
        (l.fn as unknown as (...a: TArgs) => void)(...args);
      } catch {
        /* a listener throwing must not break the others */
      }
      if (l.once) this.unsubscribe(l.obj, l.fn);
    }
  }

  hasListeners(): boolean {
    return this.listeners.length > 0;
  }

  destroy(): void {
    this.listeners = [];
  }
}

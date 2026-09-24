// A tiny event delegate implementing TradingView's ISubscription shape.
//
// Registrations are scoped. The delegate's own subscribe/unsubscribe methods
// manage the widget's *internal* registrations (header sync, stores, layout
// sync). Host code only ever receives views created by `consumerView()`: each
// view sees and removes only the registrations made through it, so the common
// TradingView cleanup `subscription.unsubscribeAll(null)` cannot detach the
// widget's own listeners, even ones registered with a `null` owner.
//
// A throwing listener is reported (console.error, then the handler installed
// with `reportErrorsTo`) and the listeners after it still run.

import type { ISubscription } from "../types/charting_library";

type Fn = (...args: never[]) => void;

interface Listener {
  /** Private token of the registering side: the delegate itself or one consumer view. */
  readonly scope: object;
  readonly obj: object | null;
  readonly fn: Fn;
  readonly once: boolean;
  /** Consumer-view name for error reports; null reports under the delegate's label at that time. */
  readonly label: string | null;
}

/** Receives every listener error after it was logged; `label` names the event. */
export type ListenerErrorHandler = (error: unknown, label: string) => void;

export class Delegate<TArgs extends unknown[] = unknown[]> {
  private listeners: Listener[] = [];
  private readonly internal = {};
  private errorHandler: ListenerErrorHandler | null = null;

  /** `label` names the delegate in listener error reports. */
  constructor(private label = "event") {}

  /** Register an internal listener. Host code subscribes through `consumerView()` instead. */
  subscribe(obj: object | null, fn: (...args: never[]) => void, once = false): void {
    this.add(this.internal, null, obj, fn, once);
  }

  /** Remove an internal listener; consumer registrations are untouched. */
  unsubscribe(obj: object | null, fn: (...args: never[]) => void): void {
    this.remove(this.internal, (l) => l.obj === obj && l.fn === fn);
  }

  /** Remove every internal listener of `obj`; consumer registrations are untouched. */
  unsubscribeAll(obj: object | null): void {
    this.remove(this.internal, (l) => l.obj === obj);
  }

  /**
   * A public ISubscription over this delegate for host code. The view can only
   * see and remove registrations made through itself; `label` names them in
   * error reports (for example `onIntervalChanged`; the delegate's own label
   * when omitted). Callers cache the view.
   */
  consumerView<TFunc extends (...args: never[]) => void = (...args: never[]) => void>(
    label?: string,
  ): ISubscription<TFunc> {
    const scope = {};
    return {
      subscribe: (obj, fn, once) => {
        if (typeof fn !== "function") {
          throw new TypeError(`[raze-charts] ${label ?? this.label}().subscribe(obj, callback) needs a callback function`);
        }
        this.add(scope, label ?? null, obj, fn, !!once);
      },
      unsubscribe: (obj, fn) => this.remove(scope, (l) => l.obj === obj && l.fn === fn),
      unsubscribeAll: (obj) => this.remove(scope, (l) => l.obj === obj),
    };
  }

  /**
   * Route listener errors to `handler` (after console.error). `label`, when
   * given, renames the delegate's internal listeners in reports, including
   * ones registered before this call.
   */
  reportErrorsTo(handler: ((error: unknown, label: string) => void) | null, label?: string): void {
    this.errorHandler = handler;
    if (label) this.label = label;
  }

  fire(...args: TArgs): void {
    // Copy so listeners removed mid-iteration don't skip neighbours.
    const snapshot = this.listeners.slice();
    for (const l of snapshot) {
      // A once-listener is detached before it runs, so a re-entrant fire()
      // from inside it cannot call it twice.
      if (l.once) this.listeners = this.listeners.filter((x) => x !== l);
      try {
        (l.fn as unknown as (...a: TArgs) => void)(...args);
      } catch (error) {
        this.report(error, l.label ?? this.label);
      }
    }
  }

  hasListeners(): boolean {
    return this.listeners.length > 0;
  }

  destroy(): void {
    this.listeners = [];
    this.errorHandler = null;
  }

  private add(scope: object, label: string | null, obj: object | null, fn: Fn, once: boolean): void {
    this.listeners.push({ scope, obj, fn, once, label });
  }

  private remove(scope: object, match: (l: Listener) => boolean): void {
    this.listeners = this.listeners.filter((l) => l.scope !== scope || !match(l));
  }

  private report(error: unknown, label: string): void {
    console.error(`[raze-charts] ${label} listener threw`, error);
    const handler = this.errorHandler;
    if (!handler) return;
    try {
      handler(error, label);
    } catch (handlerError) {
      console.error("[raze-charts] listener error handler threw", handlerError);
    }
  }
}

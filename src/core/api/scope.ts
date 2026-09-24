// Private per-instance state of ChartApi and the mechanics that compose the
// API modules (./index.ts) onto ChartApi.prototype.

import type { ChartApiDeps } from "../ChartApi";
import type { ChartContext } from "../context";

/** What an API method may reach. Never exposed on the ChartApi instance. */
export interface ChartApiScope {
  readonly context: ChartContext;
  readonly deps: ChartApiDeps;
}

// A WeakMap keeps the scope unreachable from the public object (no own
// properties, nothing on the prototype) without per-call closures.
const scopes = new WeakMap<object, ChartApiScope>();

export function bindApiScope(api: object, scope: ChartApiScope): void {
  scopes.set(api, scope);
}

export function apiScope(api: object): ChartApiScope {
  const scope = scopes.get(api);
  if (!scope) {
    throw new TypeError("[raze-charts] chart API method called on an object that is not a chart API; call it on widget.activeChart()");
  }
  return scope;
}

/**
 * Define non-enumerable methods on `target` from each module, as a class
 * body would. Two modules defining the same method is a merge error.
 */
export function installApiModules(target: object, modules: readonly object[]): void {
  for (const methods of modules) {
    for (const [name, value] of Object.entries(methods)) {
      if (Object.prototype.hasOwnProperty.call(target, name)) {
        throw new Error(`[raze-charts] chart API method "${name}" is defined by two API modules`);
      }
      Object.defineProperty(target, name, { value, writable: true, configurable: true });
    }
  }
}

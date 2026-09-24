// API modules composed onto ChartApi.prototype (union-merged, append-only).
//
// Add chart API methods by creating a module in this directory that exports
// an object of `this: ChartApi` methods (read private state through
// `apiScope(this)`) and appending it below. Method names must be unique
// across modules; a duplicate throws when the bundle loads.

import { actionsApi } from "./actions";
import { dataApi } from "./data";
import { eventsApi } from "./events";
import { rangeApi } from "./range";
import { shapesApi } from "./shapes";
import { studiesApi } from "./studies";
import { symbolApi } from "./symbol";
import { tradingApi } from "./trading";

export const API_MODULES = [
  symbolApi,
  eventsApi,
  rangeApi,
  shapesApi,
  tradingApi,
  studiesApi,
  dataApi,
  actionsApi,
] as const;

type UnionToIntersection<U> =
  (U extends unknown ? (arg: U) => void : never) extends (arg: infer I) => void ? I : never;

/** Every method contributed by API_MODULES. */
export type ApiMethods = UnionToIntersection<(typeof API_MODULES)[number]>;

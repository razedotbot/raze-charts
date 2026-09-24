// The widget's IChartWidgetApi: wires ChartApi to the kernel and controllers.

import type { EntityId } from "../../types/charting_library";
import { describeInputValue, positionalStudyInputs, StudyInputError } from "../../studies/inputs";
import type { StudySpec } from "../../studies/StudyStore";
import { ChartApi, type ChartApiDeps } from "../ChartApi";
import type { WidgetHost } from "./host";
import { studySpecFromArgs } from "./StudyArgs";

declare module "./host" {
  interface WidgetControllerMap {
    api: ApiController;
  }
}

/** Owns the widget's ChartApi. Needs no lifecycle hooks. */
export class ApiController {
  readonly api: ChartApi;

  constructor(host: WidgetHost) {
    this.api = new ChartApi(host.context, createApiDeps(host));
  }
}

/** Kernel members are read lazily: the API exists before the kernel does. */
export function createApiDeps(host: WidgetHost): ChartApiDeps {
  const { lifecycle } = host;
  return {
    refreshMarks: () => host.data.refreshMarks(),
    clearMarks: () => host.data.clearMarks(),
    resetData: () => host.data.resetData(),
    setResolution: (resolution, callback) => lifecycle.changeResolution(resolution, callback),
    setSymbol: (symbol, callback) => lifecycle.changeSymbol(symbol, undefined, callback),
    createShape: (point, options) => host.shapes.create(point, options),
    createMultipointShape: (points, options) => host.shapes.createPoints(points, options),
    getShapeById: (id) => host.shapes.adapter(id),
    removeEntity: (id) => removeEntity(host, id),
    removeAllShapes: () => host.shapes.removeAll(),
    createTradingLine: (options, kind) => host.trading.create(options, kind),
    createBracketOrder: (options) => host.trading.createBracket(options),
    getTradingLineById: (id) => host.trading.adapter(id),
    removeAllTradingLines: () => host.trading.removeAll(),
    createStudy: (name, forceOverlay, lock, inputs) => {
      let id: EntityId | null;
      try {
        id = host.studies.add(createStudySpec(host, name, forceOverlay, lock, inputs));
      } catch (error) {
        // Invalid inputs (StudyInputError) reject the promise instead of throwing synchronously.
        return Promise.reject(error);
      }
      if (!id) return Promise.reject(new Error(`[raze-charts] unknown study: ${name}`));
      return Promise.resolve(id);
    },
    setVisibleRange: (range) => host.data.revealTimeRange(range.from, range.to),
    createCompare: (symbol) => host.controllers.compare.create(symbol),
    executeActionById: (actionId) => host.controllers.actions.executeActionById(actionId),
  };
}

const LENGTH_KEYS = ["length", "Length", "periods"] as const;
const SHORTHAND_KEYS: ReadonlySet<string> = new Set([...LENGTH_KEYS, "color"]);

/**
 * The store spec for createStudy() arguments: StudyArgs' translation plus
 * every caller value it does not forward, so the store validates each value
 * instead of dropping it silently.
 * - TradingView's legacy positional array (`[20, "hl2"]`) maps onto a
 *   declared input schema in declaration order; a longer array rejects.
 * - Booleans reach the store as booleans; objects, arrays and functions reach
 *   it too and reject with a StudyInputError (`invalid-value`).
 * - A numeric-string length is used as the length; any other non-numeric
 *   length or non-string colour rejects instead of falling back to the default.
 */
function createStudySpec(
  host: WidgetHost,
  name: string,
  forceOverlay: boolean | undefined,
  lock: boolean | undefined,
  inputs: Record<string, unknown> | undefined,
): StudySpec {
  let raw: unknown = inputs;
  if (Array.isArray(raw)) {
    const def = host.studies.registry.resolve(name);
    if (def?.inputs) raw = positionalStudyInputs(def.inputs, raw, def.name);
  }
  const record = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  const spec = studySpecFromArgs(name, forceOverlay, lock, raw as Record<string, unknown> | undefined);
  if (!record) return spec;
  const extra: Record<string, unknown> = { ...spec.inputs };
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || SHORTHAND_KEYS.has(key) || Object.prototype.hasOwnProperty.call(extra, key)) continue;
    extra[key] = value;
  }
  const next: StudySpec = { ...spec, inputs: extra };
  const lengthKey = LENGTH_KEYS.find((key) => record[key] !== undefined && record[key] !== null);
  const lengthValue = lengthKey ? record[lengthKey] : undefined;
  if (lengthKey && !next.length && !(typeof lengthValue === "number" && Number.isFinite(lengthValue))) {
    const parsed = typeof lengthValue === "string" && lengthValue.trim() !== "" ? Number(lengthValue) : Number.NaN;
    if (!Number.isFinite(parsed)) {
      throw new StudyInputError("invalid-value", name, lengthKey, `expected a finite number, got ${describeInputValue(lengthValue)}`);
    }
    next.length = parsed;
  }
  const colorValue = record.color;
  if (colorValue !== undefined && colorValue !== null && !next.color && typeof colorValue !== "string") {
    throw new StudyInputError("invalid-value", name, "color", `expected a CSS colour string, got ${describeInputValue(colorValue)}`);
  }
  return next;
}

/** Remove a study, compare series, trading line or drawing by id. */
function removeEntity(host: WidgetHost, id: EntityId): void {
  if (host.studies.remove(id) || host.controllers.compare.remove(id)) return;
  const key = String(id);
  if (host.trading.get(key)) host.trading.remove(key);
  else host.shapes.remove(id);
}

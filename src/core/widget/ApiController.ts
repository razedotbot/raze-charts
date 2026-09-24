// The widget's IChartWidgetApi: wires ChartApi to the kernel and controllers.

import type { EntityId } from "../../types/charting_library";
import { plotRefMatches } from "../../studies/StudyStore";
import { ChartApi, type ChartApiDeps } from "../ChartApi";
import type { WidgetController, WidgetHost } from "./host";
import { overrideFor, parseCreateStudyArgs, type StudyArgsEnv } from "./StudyArgs";

declare module "./host" {
  interface WidgetControllerMap {
    api: ApiController;
  }
}

/** Owns the widget's ChartApi. */
export class ApiController implements WidgetController {
  readonly api: ChartApi;
  private readonly warn = warnOnce();

  constructor(private readonly host: WidgetHost) {
    this.api = new ChartApi(host.context, createApiDeps(host, this.warn));
  }

  /**
   * The registry (built-ins + custom studies) exists: flag studies_overrides
   * keys that do nothing. These are defaults, so this warns and never throws.
   */
  attach(): void {
    const definitions = this.host.studies.registry.list();
    for (const [key, value] of Object.entries(this.host.options.studies_overrides ?? {})) {
      const definition = definitions.find((item) => overrideFor(item, key) !== null);
      if (!definition) {
        this.warn(`studies_overrides:${key}`, `studies_overrides["${key}"] matches no study name or alias`);
        continue;
      }
      try {
        parseCreateStudyArgs({ definition, studiesOverrides: { [key]: value }, warn: this.warn }, definition.name);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.warn(`studies_overrides:${key}`, `studies_overrides["${key}"] was ignored: ${reason}`);
      }
    }
  }
}

/** A `[raze-charts]` console warning that fires once per key. */
function warnOnce(): StudyArgsEnv["warn"] {
  const seen = new Set<string>();
  return (key, message) => {
    if (!seen.has(key)) console.warn(`[raze-charts] ${message}`);
    seen.add(key);
  };
}

/** Kernel members are read lazily: the API exists before the kernel does. */
export function createApiDeps(host: WidgetHost, warn: StudyArgsEnv["warn"] = warnOnce()): ChartApiDeps {
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
    // async: argument errors become rejections, as TradingView reports them.
    createStudy: async (...args) => createStudy(host, warn, ...args),
    setVisibleRange: (range) => host.data.revealTimeRange(range.from, range.to),
    createCompare: (symbol) => host.controllers.compare.create(symbol),
    executeActionById: (actionId) => host.controllers.actions.executeActionById(actionId),
    getCheckableActionState: (actionId) => host.controllers.actions.getCheckableActionState(actionId),
    fitContent: () => { host.renderer.fitContent(); },
    resetView: () => { host.renderer.resetView(); },
  };
}

/**
 * createStudy: throws an Error for an unknown study, a StudyInputError for
 * invalid inputs and a TypeError for malformed overrides or options.
 */
function createStudy(
  host: WidgetHost,
  warn: StudyArgsEnv["warn"],
  name: string,
  ...args: [forceOverlay?: boolean, lock?: boolean, inputs?: unknown, overrides?: unknown, options?: unknown]
): EntityId {
  const { studies } = host;
  const definition = studies.registry.resolve(String(name));
  const parsed = definition && parseCreateStudyArgs(
    { definition, studiesOverrides: host.options.studies_overrides, warn },
    name,
    ...args,
  );
  // Invalid inputs throw a StudyInputError from the store (a rejection, via async).
  const id = parsed ? studies.add(parsed.spec) : null;
  if (!definition || !parsed || !id) throw new Error(studies.registry.unknownStudyMessage(String(name)));
  // Plot names are known once the study has computed: flag styles for plots it lacks.
  const study = parsed.plotKeys.size ? studies.list().find((item) => item.id === id) : undefined;
  if (study?.series.length) {
    const plots = study.series.map((series, index) => series.name ?? `plot_${index}`).join(", ");
    for (const [ref, label] of parsed.plotKeys) {
      if (study.series.some((series, index) => plotRefMatches(ref, index, series.name))) continue;
      warn(`plot:${definition.name}:${label}`, `${label} has no effect: ${definition.name} has no such plot; plots: ${plots}`);
    }
  }
  return id;
}

/** Remove a study, compare series, trading line or drawing by id. */
function removeEntity(host: WidgetHost, id: EntityId): void {
  if (host.studies.remove(id) || host.controllers.compare.remove(id)) return;
  const key = String(id);
  if (host.trading.get(key)) host.trading.remove(key);
  else host.shapes.remove(id);
}

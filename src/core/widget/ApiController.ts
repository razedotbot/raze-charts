// The widget's IChartWidgetApi: wires ChartApi to the kernel and controllers.

import type { EntityId } from "../../types/charting_library";
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
      const id = host.studies.add(studySpecFromArgs(name, forceOverlay, lock, inputs));
      if (!id) return Promise.reject(new Error(`[raze-charts] unknown study: ${name}`));
      return Promise.resolve(id);
    },
    setVisibleRange: (range) => host.data.revealTimeRange(range.from, range.to),
    createCompare: (symbol) => host.controllers.compare.create(symbol),
    executeActionById: (actionId) => host.controllers.actions.executeActionById(actionId),
  };
}

/** Remove a study, compare series, trading line or drawing by id. */
function removeEntity(host: WidgetHost, id: EntityId): void {
  if (host.studies.remove(id) || host.controllers.compare.remove(id)) return;
  const key = String(id);
  if (host.trading.get(key)) host.trading.remove(key);
  else host.shapes.remove(id);
}

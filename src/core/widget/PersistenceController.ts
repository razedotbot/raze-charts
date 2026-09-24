// `save()` / `load()`: the versioned layout snapshot (symbol, interval, range,
// style and scale flags, drawings, study specs, compare symbols).

import type { Bar, ChartLayoutSnapshot, EntityId, ResolutionString } from "../../types/charting_library";
import { CHART_STYLES } from "../context";
import type { WidgetController, WidgetHost } from "./host";

declare module "./host" {
  interface WidgetControllerMap {
    persistence: PersistenceController;
  }
}

/** Throw a TypeError unless `state` is a structurally valid version-1 snapshot. */
export function validateSnapshot(state: ChartLayoutSnapshot): void {
  if (!state || state.version !== 1
      || !Array.isArray(state.drawings)
      || !Array.isArray(state.studies)
      || (state.compare !== undefined && !Array.isArray(state.compare))
      || typeof state.symbol !== "string"
      || typeof state.interval !== "string"
      || !state.visibleRange
      || !Number.isFinite(state.visibleRange.from)
      || !Number.isFinite(state.visibleRange.to)
      || state.visibleRange.from > state.visibleRange.to
      || (state.logScale !== undefined && typeof state.logScale !== "boolean")
      || (state.percentScale !== undefined && typeof state.percentScale !== "boolean")
      || state.drawings.some((drawing) => !drawing
        || typeof drawing.id !== "string"
        || !Array.isArray(drawing.points)
        || drawing.points.some((point) => !point
          || !Number.isFinite(point.time)
          || (point.price !== undefined && !Number.isFinite(point.price))))
      || state.studies.some((study) => !study
        || typeof study.name !== "string"
        || !study.name.trim()
        || !Number.isFinite(study.length))
      || state.compare?.some((symbol) => typeof symbol !== "string")) {
    throw new TypeError("[raze-charts] invalid chart layout snapshot");
  }
  if (!CHART_STYLES.includes(state.chartStyle)) {
    throw new TypeError(
      `[raze-charts] chart layout snapshot has unknown chartStyle "${String(state.chartStyle)}". Supported chart types: ${CHART_STYLES.join(", ")}`,
    );
  }
  const drawingIds = state.drawings.map((drawing) => drawing.id);
  const studyIds = state.studies.flatMap((study) => study.id ? [study.id] : []);
  if (new Set(drawingIds).size !== drawingIds.length
      || new Set(studyIds).size !== studyIds.length) {
    throw new TypeError("[raze-charts] chart layout snapshot contains duplicate entity ids");
  }
}

export class PersistenceController implements WidgetController {
  /** Only the newest load may commit. */
  private loadId = 0;

  constructor(private readonly host: WidgetHost) {}

  save(callback?: (state: ChartLayoutSnapshot) => void): ChartLayoutSnapshot {
    const { context, shapes, studies } = this.host;
    const state: ChartLayoutSnapshot = {
      version: 1,
      symbol: context.symbol,
      interval: String(context.resolution),
      visibleRange: this.host.controllers.api.api.getVisibleRange(),
      chartStyle: context.chartStyle,
      logScale: context.logScale,
      percentScale: context.percentScale,
      volumeMode: context.volumeMode,
      magnet: context.magnet,
      drawings: shapes.snapshot().filter((shape) => !shape.disableSave).map((shape) => ({
        id: String(shape.id),
        shape: String(shape.shape),
        points: shape.points,
        text: shape.text,
        lock: shape.lock,
        disableSelection: shape.disableSelection,
        disableSave: shape.disableSave,
        disableUndo: shape.disableUndo,
        showInObjectsTree: shape.showInObjectsTree,
        hidden: shape.hidden,
        zOrder: shape.zOrder,
        overrides: shape.overrides,
      })),
      studies: studies.list().map((study) => ({
        id: String(study.id),
        name: study.name,
        length: study.length,
        color: study.color,
        lock: study.lock,
        forceOverlay: study.forceOverlay,
        inputs: { ...study.inputs },
        ...(study.plotStyles && {
          plotStyles: Object.fromEntries(Object.entries(study.plotStyles).map(([ref, style]) => [ref, { ...style }])),
        }),
      })),
      compare: context.compare.map((item) => item.symbol),
    };
    if (callback) this.host.lifecycle.callConsumer("save callback", () => callback(state));
    return state;
  }

  async load(state: ChartLayoutSnapshot): Promise<void> {
    validateSnapshot(state);
    const { context, data, shapes, studies, commands, lifecycle, controllers } = this.host;
    const unknownStudy = state.studies.find((study) => !studies.registry.resolve(study.name));
    if (unknownStudy) {
      throw new Error(studies.registry.unknownStudyMessage(unknownStudy.name));
    }

    const loadId = ++this.loadId;
    const dataChangeId = ++lifecycle.dataChangeId;
    const isCurrent = (): boolean => !lifecycle.destroyed
      && loadId === this.loadId
      && dataChangeId === lifecycle.dataChangeId;
    await data.changeSymbol(state.symbol, state.interval as ResolutionString);
    if (!isCurrent()) return;

    // Fetch everything before replacing drawings/studies. This keeps the
    // visible object model coherent if a compare/range request fails and lets
    // a newer load supersede this one without leaving half a snapshot behind.
    const comparisons: { symbol: string; bars: Bar[] }[] = [];
    for (const symbol of state.compare ?? []) {
      const bars = await data.loadCompare(symbol);
      if (!isCurrent()) return;
      comparisons.push({ symbol, bars });
    }
    await data.revealTimeRange(state.visibleRange.from, state.visibleRange.to);
    if (!isCurrent()) return;

    const chrome = controllers.chrome;
    const resumeHistory = commands.suspend();
    try {
      context.setChartType(state.chartStyle, "load");
      // Percent wins over log, matching the painters and readScaleState().
      context.setScaleMode(
        { mode: state.percentScale ? "percent" : state.logScale ? "log" : "normal" },
        "load",
      );
      if (state.volumeMode) context.volumeMode = state.volumeMode;
      if (typeof state.magnet === "boolean") context.magnet = state.magnet;
      chrome.leftSidebar?.setChartStyle(state.chartStyle);

      shapes.removeAll();
      for (const drawing of state.drawings) {
        shapes.restore({
          id: drawing.id as EntityId,
          shape: drawing.shape || "horizontal_line",
          points: drawing.points,
          text: drawing.text ?? "",
          lock: drawing.lock ?? false,
          disableSelection: drawing.disableSelection ?? false,
          disableSave: drawing.disableSave ?? false,
          disableUndo: drawing.disableUndo ?? false,
          showInObjectsTree: drawing.showInObjectsTree !== false,
          hidden: drawing.hidden ?? false,
          zOrder: drawing.zOrder === "top" ? "top" : "bottom",
          overrides: drawing.overrides ?? {},
        });
      }
      studies.clear();
      for (const study of state.studies) {
        studies.add({
          ...study,
          id: study.id as EntityId | undefined,
          lock: study.lock ?? false,
          forceOverlay: study.forceOverlay ?? false,
          inputs: study.inputs ?? {},
          invalidInputs: "default", // Stale saved inputs fall back to their defaults with a warning.
        });
      }
      context.compare = [];
      for (const comparison of comparisons) controllers.compare.add(comparison.symbol, comparison.bars);
      chrome.symbolSearch?.setSymbol(context.symbol);
      chrome.intervalSelector?.refresh();
      chrome.syncAccessibility();
      if (context.bars.length) chrome.finishLoading();
      else chrome.showEmptyState();
      context.requestPaint();
      commands.clear();
    } finally {
      resumeHistory();
    }
  }

  destroy(): void {
    this.loadId += 1;
  }
}

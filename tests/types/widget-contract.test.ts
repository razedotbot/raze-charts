// Type contract for W1B-12: widget event names and payloads, chart action ids,
// createStudy arguments, and the required createCompare/executeActionById.

import {
  widget,
  type ChartActionId,
  type ChartLayoutSnapshot,
  type ChartingLibraryWidgetOptions,
  type DrawingEventType,
  type EntityId,
  type IChartingLibraryWidget,
  type IChartWidgetApi,
  type StudyPlotStyles,
  type TradingEventType,
  type TradingLineSnapshot,
  type WidgetListenerError,
} from "../../src";

declare const options: ChartingLibraryWidgetOptions;

if (false) {
  const instance = new widget(options);
  const tvShaped: IChartingLibraryWidget = instance;

  // Strict mode: both are required members, so no `!` or `?.` is needed.
  void instance.activeChart().createCompare("BTC");
  instance.activeChart().executeActionById("undo");
  const chart: IChartWidgetApi = tvShaped.activeChart();
  void chart.createCompare("ETH").then((id: EntityId) => chart.removeEntity(id));

  for (const target of [instance, tvShaped]) {
    target.subscribe("drawing_event", (id, type) => {
      const entity: EntityId = id;
      const kind: DrawingEventType = type;
      void entity;
      void kind;
    });
    target.subscribe("trading_event", (line, type) => {
      const snapshot: TradingLineSnapshot = line;
      const event: TradingEventType = type;
      void snapshot;
      void event;
    });
    target.subscribe("error", (error) => {
      const report: WidgetListenerError = error;
      void report.cause;
    });
    // A TradingView-style handler with wider parameters still type-checks.
    target.unsubscribe("drawing_event", (id: string, type: string) => void [id, type]);

    // @ts-expect-error Events that never fire are not accepted.
    target.subscribe("onTick", () => {});
    // @ts-expect-error Misspelled event names are rejected.
    target.subscribe("drawing_events", () => {});
    // @ts-expect-error The payload types are checked.
    target.subscribe("drawing_event", (id: number) => void id);
  }

  const action: ChartActionId = "chartReset";
  chart.executeActionById(action);
  chart.executeActionById("hideAllDrawingTools");
  const magnet: boolean = chart.getCheckableActionState("magnet");
  void magnet;
  // @ts-expect-error Unsupported TradingView actions are rejected.
  chart.executeActionById("chartProperties");
  // @ts-expect-error Only toggle actions have a checkable state.
  chart.getCheckableActionState("undo");

  void chart.createStudy("EMA", false, false, [30]);
  void chart.createStudy("RSI", false, false, { length: 7, smooth: true, source: "close" }, { "plot.color": "#ff0000" });
  void chart.createStudy("SMA", false, false, undefined, undefined, { disableUndo: true, priceScale: "as-series" });
  // @ts-expect-error Inputs are numbers, strings or booleans.
  void chart.createStudy("EMA", false, false, { length: { value: 30 } });
  // @ts-expect-error Options are the TradingView CreateStudyOptions shape.
  void chart.createStudy("EMA", false, false, [30], {}, { disableUndo: "yes" });

  // Per-plot styles: saved with each study in the layout snapshot.
  const plotStyles: StudyPlotStyles = { 0: { lineWidth: 2 }, signal: { color: "#00ff00", visible: false } };
  const layout: ChartLayoutSnapshot = instance.save();
  layout.studies.push({ name: "MACD", length: 26, color: "#2962ff", plotStyles });
  // @ts-expect-error Plot visibility is a boolean.
  const badStyles: StudyPlotStyles = { signal: { visible: "no" } };
  void badStyles;

  const interval = chart.onIntervalChanged();
  interval.subscribe(null, (resolution) => void String(resolution));
  interval.unsubscribeAll(null);
}

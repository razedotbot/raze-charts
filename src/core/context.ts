// Shared mutable state threaded through the widget's subsystems (engine, data
// manager, toolbar, shapes). One ChartContext exists per widget instance.

import type {
  ChartingLibraryWidgetOptions,
  ChartStyleName,
  IBasicDataFeed,
  LibrarySymbolInfo,
  ResolutionString,
  SidebarToolId,
} from "../types/charting_library";
import { Delegate } from "../util/delegate";
import type { Bar, Mark } from "../types/charting_library";

export interface ThemeColors {
  paneBackground: string;
  vertGrid: string;
  horzGrid: string;
  crosshair: string;
  scaleText: string;
  scaleBackground: string;
  scaleLine: string;
  candleUp: string;
  candleDown: string;
  borderUp: string;
  borderDown: string;
  wickUp: string;
  wickDown: string;
  volUp: string;
  volDown: string;
  /** Line/area series colour; falls back to candleUp when unset. */
  lineColor?: string;
  showPriceScaleCrosshairLabel: boolean;
  showTimeScaleCrosshairLabel: boolean;
}

/** Logical visible range expressed in bar-index space (fractional allowed). */
export interface IndexRange {
  /** Leftmost visible bar index (fractional, can be negative for empty space). */
  from: number;
  /** Rightmost visible bar index (fractional, can exceed bars.length). */
  to: number;
}

/** Active drawing tool (left sidebar). `cursor` = pan / select. */
export type DrawingTool = SidebarToolId;

/** Main series render style. */
export type ChartStyle = ChartStyleName;

export interface ChartContext {
  readonly options: ChartingLibraryWidgetOptions;
  readonly datafeed: IBasicDataFeed;
  readonly locale: string;
  readonly fontFamily: string;

  symbol: string;
  resolution: ResolutionString;
  symbolInfo: LibrarySymbolInfo | null;

  theme: ThemeColors;
  features: Set<string>;

  /** The full bar series for the current (symbol, resolution), ascending by time. */
  bars: Bar[];

  /** Bar marks for the current visible range (rendered when `mark_on_bars` is on). */
  marks: Mark[];

  /** Current visible range in bar-index space. */
  visibleRange: IndexRange;
  /** When true the price scale auto-fits the visible bars each frame. */
  autoScalePrice: boolean;
  /** Manual price range override (set when the user drags the price axis). */
  priceRange: { min: number; max: number } | null;

  /** Main series style (candles / line / area / heikin ashi). */
  chartStyle: ChartStyle;
  /** Logarithmic price scale. */
  logScale: boolean;
  /** Percent scale (relative to first visible close). */
  percentScale: boolean;
  /** Active left-toolbar drawing tool. */
  drawingTool: DrawingTool;
  /** Currently selected shape entity id (for delete / highlight), or null. */
  selectedShapeId: string | null;

  /** Fired (resolution, timeframeObj) when the interval changes. */
  readonly intervalChanged: Delegate<[ResolutionString, unknown]>;
  /** Fired on every data mutation that should trigger a repaint. */
  readonly dataChanged: Delegate<[]>;
  /** Fired (entityId, eventType) for shape drawing events. */
  readonly drawingEvent: Delegate<[string, string]>;

  /** Request an animation-frame repaint. Set by the engine. */
  requestPaint(): void;
}

/** Chrome featuresets that are ON unless listed in `disabled_features`. */
const FEATURE_DEFAULTS_ON = new Set<string>([
  "header_widget",
  "header_resolutions",
  "left_toolbar",
  "legend_widget",
  "scale_bar",
]);

export function buildFeatureSet(opts: ChartingLibraryWidgetOptions): Set<string> {
  const set = new Set<string>(FEATURE_DEFAULTS_ON);
  for (const f of opts.enabled_features ?? []) set.add(f);
  for (const f of opts.disabled_features ?? []) set.delete(f);
  return set;
}

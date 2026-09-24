// Contracts shared by the gesture coordinator (../gestures.ts) and the
// interaction handlers registered in ./handlers.ts.

import type { ChartContext, DrawingTool } from "../../core/context";
import type { ShapeStore } from "../../core/ShapeStore";
import type { TradingStore } from "../../core/TradingStore";
import type { DataManager } from "../../data/DataManager";
import type { ChartEngine } from "../ChartEngine";
import type { SubPaneGeom } from "../layout";
import type { PlotScale } from "../plotScale";
import type { Crosshair, DraftShape, FinanceView, MarkHit, ShapeHit, TradingHit } from "../paint/view";

/** Renderer state the interaction layer reads and writes (implemented by ChartRenderer). */
export interface GestureHost {
  readonly canvas: HTMLCanvasElement;
  readonly context: ChartContext;
  readonly engine: ChartEngine;
  readonly shapes: ShapeStore;
  readonly trading: TradingStore;
  readonly data: DataManager;
  plotL: number;
  plotT: number;
  plotW: number;
  plotH: number;
  plotScale(): PlotScale;
  subPanes: SubPaneGeom[];
  volumePane: { top: number; h: number } | null;
  priceMin: number;
  priceMax: number;
  crosshair: Crosshair;
  hoverMark: MarkHit["mark"] | null;
  hoverShapeId: string | null;
  hoverTradingLineId: string | null;
  hoverTradingHit: TradingHit["hit"] | null;
  markScreen: MarkHit[];
  shapeScreen: ShapeHit[];
  tradingScreen: TradingHit[];
  draft: DraftShape | null;
  lastPointerType: string;
  selectedShapeId: string | null;
  onToolDone: ((tool: DrawingTool) => void) | null;
  fitContent(): void;
  requestPaint(): void;
  financeView(): FinanceView;
}

/** Where a canvas point falls relative to the main pane and its axes. */
export interface PointerZone {
  /** Right of the plot and above the bottom of the main pane. */
  readonly inPriceAxis: boolean;
  /** At or below the content bottom and left of the price axis. */
  readonly inTimeAxis: boolean;
  /** Left of the price axis and vertically inside the main pane. */
  readonly inPlot: boolean;
  /** Top edge of the time axis (below any volume or study sub-panes). */
  readonly contentBottom: number;
}

/** One pointer, wheel or double-click sample in canvas CSS pixels. */
export interface PointerInput {
  readonly x: number;
  readonly y: number;
  /** `mouse`, `pen` or `touch`; `mouse` for wheel and double-click input. */
  readonly pointerType: string;
  readonly zone: PointerZone;
}

/**
 * A gesture claimed by a handler on pointer down. The coordinator routes
 * every later move to it, commits on the final pointer up and cancels it on
 * pointer cancel or when a second contact turns the gesture into a pinch.
 */
export interface DragSession {
  /** Stable name for diagnostics and tests (`pan`, `shape`, `priceScale`, ...). */
  readonly kind: string;
  move(x: number, y: number): void;
  /** The gesture ended normally. */
  commit?(): void;
  /** Roll every partial change back so no lifecycle is left half-applied. */
  cancel?(): void;
}

/**
 * An interaction handler. Handlers run in ascending `priority`; the first
 * one that returns a truthy value consumes the event. Every hook is optional.
 *
 * Built-in priorities: drawing draft 100, trading lines 200, drawing
 * selection/drag 300, price axis 400, time axis 500, viewport 1000.
 */
export interface InteractionHandler {
  /** Unique id; duplicates are rejected when the coordinator loads. */
  readonly id: string;
  readonly priority: number;
  /** Primary-button or touch press after hover hit-testing. Return a session to own the drag. */
  pointerDown?(host: GestureHost, input: PointerInput): DragSession | boolean | void;
  /** Mouse hover without a drag. Return a CSS cursor to override the built-in cursor. */
  cursor?(host: GestureHost, input: PointerInput): string | null | void;
  dblClick?(host: GestureHost, input: PointerInput, event: MouseEvent): boolean | void;
  wheel?(host: GestureHost, input: PointerInput, event: WheelEvent): boolean | void;
  /** Key press while the canvas itself has focus. */
  keyDown?(host: GestureHost, event: KeyboardEvent): boolean | void;
}

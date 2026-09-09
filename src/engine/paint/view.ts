// Shared view passed to every finance paint function. Built each frame by
// ChartRenderer so draw code never reaches into private fields.

import type { Bar, Mark, ShapePoint } from "../../types/charting_library";
import type { ChartContext, DrawingTool } from "../../core/context";
import type { ShapeStore, StoredShape } from "../../core/ShapeStore";
import type { StoredTradingLine, TradingStore } from "../../core/TradingStore";
import type { StudyStore } from "../../studies/StudyStore";
import type { SubPaneGeom } from "../layout";
import type { PlotScale } from "../plotScale";

export interface Crosshair {
  x: number;
  y: number;
  active: boolean;
}

export interface MarkHit {
  mark: Mark;
  x: number;
  y: number;
  r: number;
}

export interface ShapeHit {
  shape: StoredShape;
  y: number;
  hit: "body" | "p0" | "p1";
}

export interface TradingHit {
  line: StoredTradingLine;
  y: number;
  x1: number;
  x2: number;
  hit: "body" | "cancel";
}

export interface DraftShape {
  tool: DrawingTool;
  points: ShapePoint[];
}

export interface FinanceView extends PlotScale {
  context: ChartContext;
  cssWidth: number;
  cssHeight: number;
  priceAxisW: number;
  subPanes: SubPaneGeom[];
  volumePane: { top: number; h: number } | null;
  seriesBars: Bar[];
  studies: StudyStore;
  shapes: ShapeStore;
  trading: TradingStore;
  markScreen: MarkHit[];
  shapeScreen: ShapeHit[];
  tradingScreen: TradingHit[];
  crosshair: Crosshair;
  hoverMark: Mark | null;
  draft: DraftShape | null;
  selectedShapeId: string | null;
  selectedTradingLineId: string | null;
  fontFamily: string;
}

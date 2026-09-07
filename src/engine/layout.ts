// Plot layout constants and pane geometry. Numbers are part of the frozen
// widget look — do not change them without updating visual goldens.

import type { StudyDefinition } from "../types/charting_library";

export const PRICE_AXIS_W_DEFAULT = 64;
export const PRICE_AXIS_W_MIN = 56;
export const PRICE_AXIS_W_MAX = 128;
export const TIME_AXIS_H = 22;
export const MIN_BAR_SPACING = 1.5;
export const MAX_BAR_SPACING = 64;
export const VOLUME_FRACTION = 0.16; // bottom 16% of the main plot reserved for volume bars
export const SUB_PANE_FRACTION = 0.22; // of full canvas height per study sub-pane (RSI, custom panes)
export const SUB_PANES_MAX_FRACTION = 0.45; // all sub-panes together never squeeze the main plot below ~55%
export const SUB_PANE_GAP = 3;
export const CANDLE_MAX_WIDTH = 18;  // cap so few-bar charts don't render giant blocks

export interface SubPaneGeom {
  def: StudyDefinition;
  top: number;
  h: number;
  min: number;
  max: number;
}

export interface PlotLayout {
  plotL: number;
  plotT: number;
  plotW: number;
  plotH: number;
  subPanes: SubPaneGeom[];
}

export function computePlotLayout(
  cssWidth: number,
  cssHeight: number,
  priceAxisW: number,
  paneDefs: StudyDefinition[],
): PlotLayout {
  const nPanes = paneDefs.length;
  const paneFrac = nPanes ? Math.min(SUB_PANE_FRACTION, SUB_PANES_MAX_FRACTION / nPanes) : 0;
  const paneH = nPanes ? Math.max(48, Math.floor(cssHeight * paneFrac)) : 0;
  const panesTotal = nPanes * (paneH + SUB_PANE_GAP);
  const plotL = 0;
  const plotT = 0;
  const plotW = Math.max(1, cssWidth - priceAxisW);
  const plotH = Math.max(1, cssHeight - TIME_AXIS_H - panesTotal);
  const subPanes = paneDefs.map((def, i) => ({
    def,
    top: plotT + plotH + SUB_PANE_GAP + i * (paneH + SUB_PANE_GAP),
    h: paneH,
    min: 0,
    max: 1,
  }));
  return { plotL, plotT, plotW, plotH, subPanes };
}

export function timeAxisTop(plotT: number, plotH: number, subPanes: SubPaneGeom[]): number {
  const last = subPanes[subPanes.length - 1];
  return last ? last.top + last.h : plotT + plotH;
}

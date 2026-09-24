// Plot layout constants and pane geometry. Numbers are part of the frozen
// widget look — do not change them without updating visual goldens.
//
// Vertical budget, top to bottom: main price plot, optional volume pane,
// study sub-panes (each preceded by SUB_PANE_GAP), then the TIME_AXIS_H time
// axis. Stacked panes get their preferred height while the main plot keeps at
// least mainPlotFloor(); past that they shrink proportionally down to
// SUB_PANE_MIN_H, and past that they collapse to equal header strips. No pane
// ever runs past the time axis.

import type { StudyDefinition, VolumeMode } from "../types/charting_library";

export const PRICE_AXIS_W_DEFAULT = 64;
export const PRICE_AXIS_W_MIN = 56;
export const PRICE_AXIS_W_MAX = 128;
export const TIME_AXIS_H = 22;
export const MIN_BAR_SPACING = 1.5;
export const MAX_BAR_SPACING = 64;
export const VOLUME_FRACTION = 0.16; // bottom 16% of the main plot reserved for volume bars
export const SUB_PANE_FRACTION = 0.22; // of full canvas height per study sub-pane (RSI, custom panes)
export const SUB_PANES_MAX_FRACTION = 0.45; // preferred cap for all sub-panes together (the hard floor is MAIN_PLOT_MIN_*)
export const SUB_PANE_GAP = 3;
export const CANDLE_MAX_WIDTH = 18;  // cap so few-bar charts don't render giant blocks
/** Preferred minimum of a study sub-pane when the chart has room for it. */
export const SUB_PANE_PREFERRED_MIN_H = 48;
/** Preferred minimum of the dedicated volume pane (`volume_mode: "pane"`). */
export const VOLUME_PANE_PREFERRED_MIN_H = 36;
/** Smallest pane that still plots values; below it panes collapse to header strips. */
export const SUB_PANE_MIN_H = 24;
/** The main plot always keeps at least this many CSS px of the content height... */
export const MAIN_PLOT_MIN_PX = 120;
/** ...and at least this fraction of it (content height = canvas height − time axis). */
export const MAIN_PLOT_MIN_FRACTION = 0.4;

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
  volumePane: { top: number; h: number } | null;
}

/**
 * Height the main plot is guaranteed for a canvas of `cssHeight`:
 * max(MAIN_PLOT_MIN_PX, MAIN_PLOT_MIN_FRACTION of the content height), never
 * more than the content height itself.
 */
export function mainPlotFloor(cssHeight: number): number {
  const content = Math.max(0, cssHeight - TIME_AXIS_H);
  return Math.min(content, Math.max(MAIN_PLOT_MIN_PX, Math.ceil(content * MAIN_PLOT_MIN_FRACTION)));
}

/**
 * Whether a stacked pane was squeezed below SUB_PANE_MIN_H. Collapsed panes
 * paint their header only; there is no room to plot values legibly.
 */
export function isCollapsedPane(pane: { h: number }): boolean {
  return pane.h < SUB_PANE_MIN_H;
}

/**
 * Fit preferred pane heights into `space` CSS px (gaps excluded). Heights are
 * kept when they fit, shrink in proportion (never below SUB_PANE_MIN_H) when
 * they do not, and fall back to equal header strips when even the minimum
 * does not fit. Every result is a non-negative integer and the sum never
 * exceeds `space`.
 */
export function fitPaneHeights(preferred: readonly number[], space: number): number[] {
  const n = preferred.length;
  if (!n) return [];
  const room = Math.max(0, Math.floor(space));
  let total = 0;
  for (const h of preferred) total += h;
  if (total <= room) return preferred.slice();
  if (n * SUB_PANE_MIN_H > room) {
    const each = Math.floor(room / n);
    return preferred.map(() => each);
  }
  // Water-fill: panes whose proportional share falls under the minimum are
  // pinned to it and the rest share what remains, until the shares settle.
  const pinned = new Array<boolean>(n).fill(false);
  let out: number[] = preferred.slice();
  for (;;) {
    let free = room;
    let weight = 0;
    for (let i = 0; i < n; i++) {
      if (pinned[i]) free -= SUB_PANE_MIN_H;
      else weight += Math.max(1, preferred[i]!);
    }
    let changed = false;
    out = preferred.map((h, i) => {
      if (pinned[i]) return SUB_PANE_MIN_H;
      const share = Math.floor((Math.max(1, h) * free) / Math.max(1, weight));
      if (share < SUB_PANE_MIN_H) {
        pinned[i] = true;
        changed = true;
        return SUB_PANE_MIN_H;
      }
      return share;
    });
    if (!changed) return out;
  }
}

export function computePlotLayout(
  cssWidth: number,
  cssHeight: number,
  priceAxisW: number,
  paneDefs: StudyDefinition[],
  volumeMode: VolumeMode = "overlay",
): PlotLayout {
  const nPanes = paneDefs.length;
  const paneFrac = nPanes ? Math.min(SUB_PANE_FRACTION, SUB_PANES_MAX_FRACTION / nPanes) : 0;
  const paneH = nPanes ? Math.max(SUB_PANE_PREFERRED_MIN_H, Math.floor(cssHeight * paneFrac)) : 0;
  const hasVolumePane = volumeMode === "pane";
  const volumeH = hasVolumePane
    ? Math.max(VOLUME_PANE_PREFERRED_MIN_H, Math.floor(cssHeight * VOLUME_FRACTION))
    : 0;

  // Preferred heights of every stacked pane, volume first.
  const preferred: number[] = [];
  if (hasVolumePane) preferred.push(volumeH);
  for (let i = 0; i < nPanes; i++) preferred.push(paneH);

  const content = Math.max(0, cssHeight - TIME_AXIS_H);
  const gaps = preferred.length * SUB_PANE_GAP;
  const mainFloor = Math.min(mainPlotFloor(cssHeight), Math.max(0, content - gaps));
  const heights = fitPaneHeights(preferred, content - mainFloor - gaps);
  let stacked = gaps;
  for (const h of heights) stacked += h;

  const plotL = 0;
  const plotT = 0;
  const plotW = Math.max(1, cssWidth - priceAxisW);
  const plotH = Math.max(1, content - stacked);

  let cursor = plotT + plotH;
  let next = 0;
  let volumePane: PlotLayout["volumePane"] = null;
  if (hasVolumePane) {
    const h = heights[next++]!;
    volumePane = { top: cursor + SUB_PANE_GAP, h };
    cursor = volumePane.top + h;
  }
  const subPanes = paneDefs.map((def) => {
    const h = heights[next++]!;
    const top = cursor + SUB_PANE_GAP;
    cursor = top + h;
    return { def, top, h, min: 0, max: 1 };
  });
  return { plotL, plotT, plotW, plotH, subPanes, volumePane };
}

export function timeAxisTop(
  plotT: number,
  plotH: number,
  subPanes: SubPaneGeom[],
  volumePane?: { top: number; h: number } | null,
): number {
  const last = subPanes[subPanes.length - 1];
  if (last) return last.top + last.h;
  if (volumePane) return volumePane.top + volumePane.h;
  return plotT + plotH;
}

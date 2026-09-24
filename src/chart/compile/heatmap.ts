// Heatmap: square-cell band layout and diverging colour cells.

import { extent, scaleBand, type AnyScale, type BandScale } from "../scales";
import { heatFill, heatLabelColor } from "../theme";
import type { MarkCompileContext } from "./context";
import { ChartCompileError } from "./errors";
import { formatSigned } from "./format";
import type { HeatmapChartMark } from "./marks";
import { asNumber, isBandCategory, readChannel, snapRect, unique } from "./shared";
import type { ChartSpec, Margin, PlotRect } from "./types";

export interface HeatmapLayout {
  /** Centered square-cell grid; replaces the margin-derived plot. */
  plot: PlotRect;
  xScale: AnyScale;
  yScale: AnyScale;
}

export function heatmapLayout(spec: ChartSpec, hm: HeatmapChartMark, margin: Margin, plot: PlotRect): HeatmapLayout {
  const observedXs = unique(hm.data
    .map((row) => readChannel(row as never, hm.x as never))
    .filter(isBandCategory));
  const observedYs = unique(hm.data
    .map((row) => readChannel(row as never, hm.y as never))
    .filter(isBandCategory));
  const xs = (spec.scales?.x?.domain as readonly (string | number)[] | undefined) ?? observedXs;
  const ys = (spec.scales?.y?.domain as readonly (string | number)[] | undefined) ?? observedYs;
  for (const value of observedXs) {
    if (!xs.includes(value)) {
      throw new ChartCompileError("E_SCALE_DOMAIN", `scales.x.domain does not contain heatmap category ${JSON.stringify(value)}.`);
    }
  }
  for (const value of observedYs) {
    if (!ys.includes(value)) {
      throw new ChartCompileError("E_SCALE_DOMAIN", `scales.y.domain does not contain heatmap category ${JSON.stringify(value)}.`);
    }
  }
  const nX = Math.max(1, xs.length);
  const nY = Math.max(1, ys.length);
  const gap = 2;
  const cell = Math.max(1, Math.min(
    Math.floor((plot.w - (nX - 1) * gap) / nX),
    Math.floor((plot.h - (nY - 1) * gap) / nY),
  ));
  const gridW = nX * (cell + gap);
  const gridH = nY * (cell + gap);
  const grid: PlotRect = {
    x: margin.left + Math.floor((plot.w - gridW) / 2),
    y: margin.top + Math.floor((plot.h - gridH) / 2),
    w: gridW,
    h: gridH,
  };
  const pad = gap / (cell + gap);
  const xScale = scaleBand({
    domain: xs,
    range: [grid.x, grid.x + grid.w],
    padding: spec.scales?.x?.padding ?? pad,
  });
  const yScale = scaleBand({
    domain: ys,
    range: [grid.y, grid.y + grid.h],
    padding: spec.scales?.y?.padding ?? pad,
  });
  return { plot: grid, xScale, yScale };
}

export function compileHeatmap(ctx: MarkCompileContext, m: HeatmapChartMark): void {
  const { theme, nodes } = ctx;
  const xb = ctx.xScale as BandScale<string | number>;
  const yb = ctx.yScale as BandScale<string | number>;
  const validRows = m.data.map((row) => ({
    row,
    x: xb.start(readChannel(row as never, m.x as never) as string | number),
    y: yb.start(readChannel(row as never, m.y as never) as string | number),
    z: asNumber(readChannel(row as never, m.valueKey as never)),
  })).filter((entry) => Number.isFinite(entry.x) && Number.isFinite(entry.y) && Number.isFinite(entry.z));
  const zs = validRows.map((entry) => entry.z);
  let [zLo, zHi] = extent(zs);
  if (zLo < 0 && zHi > 0) {
    const mag = Math.max(Math.abs(zLo), zHi);
    zLo = -mag;
    zHi = mag;
  }
  ctx.colorBar = { min: zLo, max: zHi };
  for (const entry of validRows) {
    const { row, x, y, z: zv } = entry;
    const xv = readChannel(row as never, m.x as never);
    const yv = readChannel(row as never, m.y as never);
    const snapped = snapRect(x, y, xb.bandwidth(), yb.bandwidth());
    const fill = heatFill(zv, zLo, zHi, theme);
    const tip = `${String(yv)}  ·  ${String(xv)}\n${formatSigned(zv)}%`;
    nodes.push({
      type: "rect",
      ...snapped,
      fill,
      stroke: "none",
      corner: "none",
      datum: row,
      series: String(yv),
      label: formatSigned(zv),
      tip,
      role: "heat",
    });
    if (snapped.w >= 34 && snapped.h >= 18) {
      nodes.push({
        type: "text",
        x: snapped.x + snapped.w / 2,
        y: snapped.y + snapped.h / 2,
        label: formatSigned(zv),
        fill: heatLabelColor(fill, theme),
        fontSize: 9,
        anchor: "middle",
        hit: false,
      });
    }
  }
}

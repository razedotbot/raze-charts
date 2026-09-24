import { TIME_AXIS_H } from "../layout";
import { formatAxisPrice, indexForX, priceForY, xForIndex, yForPrice } from "../plotScale";
import { resolutionToMs } from "../../util/resolution";
import { TimeIndex } from "../../data/TimeIndex";
import { formatCompact } from "../../util/format";
import { formatNumber } from "../../util/intl";
import { formatCrosshairTimeLabel } from "./axes";
import { drawAxisTag, neutralPill, roundRect, timeAxisTopOf } from "./primitives";
import type { FinanceView } from "./view";

/** Where the crosshair is: `y` is null when only the vertical (time) line applies. */
interface CrosshairPoint {
  x: number;
  y: number | null;
}

/** The pane band a y coordinate falls in, with its value readout. */
type Band =
  | { kind: "main" }
  | { kind: "volume"; top: number; h: number }
  | { kind: "sub"; top: number; h: number; value: (y: number) => string };

/**
 * The local pointer crosshair, or the one mirrored from another layout pane.
 *
 * A synced crosshair always keeps its vertical line and time label (time is
 * shared by every pane). Its horizontal line and price label only make sense
 * on the same instrument: they show when the source pane's symbol matches
 * (or, for a relay that does not say, when the price is in range).
 */
function crosshairPoint(v: FinanceView): CrosshairPoint | null {
  if (v.crosshair.active) return { x: v.crosshair.x, y: v.crosshair.y };
  const synced = v.context.syncedCrosshair;
  if (!synced?.active) return null;
  const bars = v.context.bars;
  if (!bars.length) return null;
  const index = new TimeIndex(bars, resolutionToMs(v.context.resolution)).indexAt(synced.unixTime * 1000);
  if (index == null) return null;
  let y: number | null = null;
  if (synced.symbol === undefined || synced.symbol === v.context.symbol) {
    const py = yForPrice(v, synced.price);
    if (py >= v.plotT && py <= v.plotT + v.plotH) y = py;
  }
  return { x: xForIndex(v, index), y };
}

function bandAt(v: FinanceView, y: number): Band | null {
  if (y >= v.plotT && y <= v.plotT + v.plotH) return { kind: "main" };
  const volume = v.volumePane;
  if (volume && v.context.volumeMode === "pane" && y >= volume.top && y <= volume.top + volume.h) {
    return { kind: "volume", top: volume.top, h: volume.h };
  }
  const pane = v.subPanes.find((p) => y >= p.top && y <= p.top + p.h);
  if (!pane) return null;
  return {
    kind: "sub",
    top: pane.top,
    h: pane.h,
    value: (py) => {
      const val = pane.max - ((py - pane.top) / Math.max(1, pane.h)) * (pane.max - pane.min);
      return pane.def.formatValue
        ? pane.def.formatValue(val)
        : Math.abs(val) >= 1000
          ? formatCompact(val)
          : val.toFixed(1);
    },
  };
}

/**
 * Volume at `y` in the dedicated volume pane, on the scale the volume
 * painter uses (the tallest visible bar fills the pane). Null without volume.
 */
function volumeAt(v: FinanceView, y: number, top: number, h: number): number | null {
  const bars = v.context.bars;
  const start = Math.max(0, Math.floor(v.visibleRange.from) - 1);
  const end = Math.min(bars.length - 1, Math.ceil(v.visibleRange.to) + 1);
  let maxVol = 0;
  for (let i = start; i <= end; i++) {
    const vol = bars[i]?.volume ?? 0;
    if (vol > maxVol) maxVol = vol;
  }
  if (!(maxVol > 0) || !(h > 0)) return null;
  return Math.max(0, ((top + h - y) / h) * maxVol);
}

/** "35.1K" from a thousand up; plain digits below (decimals only for fractional volumes). */
export function formatVolumeLabel(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1000) return formatCompact(value);
  return formatNumber(value, { maximumFractionDigits: abs >= 100 ? 0 : abs >= 1 ? 2 : 4 });
}

export function drawCrosshair(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  const point = crosshairPoint(v);
  if (!point) return;
  const t = v.context.theme;
  const { x } = point;
  const contentBottom = timeAxisTopOf(v);
  if (!(x >= v.plotL && x <= v.plotL + v.plotW)) return;
  // The local pointer over the time axis (or above the plot) shows nothing.
  if (point.y !== null && v.crosshair.active && (point.y < v.plotT || point.y > contentBottom)) return;

  const band = point.y === null ? null : bandAt(v, point.y);
  const y = point.y ?? 0;
  ctx.save();
  ctx.strokeStyle = t.crosshair;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(Math.round(x) + 0.5, v.plotT);
  ctx.lineTo(Math.round(x) + 0.5, contentBottom);
  if (band) {
    ctx.moveTo(v.plotL, Math.round(y) + 0.5);
    ctx.lineTo(v.plotL + v.plotW, Math.round(y) + 0.5);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  const pill = neutralPill(v);
  if (band && t.showPriceScaleCrosshairLabel) {
    if (band.kind === "main") {
      const pricescale = v.context.symbolInfo?.pricescale ?? 100;
      drawAxisTag(ctx, v, y, formatAxisPrice(v, priceForY(v, y), pricescale), pill.bg, pill.fg);
    } else if (band.kind === "volume") {
      const volume = volumeAt(v, y, band.top, band.h);
      if (volume !== null) drawAxisTag(ctx, v, y, formatVolumeLabel(volume), pill.bg, pill.fg, false, band.top, band.top + band.h);
    } else {
      drawAxisTag(ctx, v, y, band.value(y), pill.bg, pill.fg, false, band.top, band.top + band.h);
    }
  }
  if (t.showTimeScaleCrosshairLabel) drawTimeLabel(ctx, v, x, pill);
}

/**
 * Time pill under the crosshair: the snapped bar's time in the display zone.
 * In the whitespace before the first or after the last bar it shows the
 * time that bar slot would have, like the axis the user is pointing at.
 */
function drawTimeLabel(ctx: CanvasRenderingContext2D, v: FinanceView, x: number, pill: { bg: string; fg: string }): void {
  const bars = v.context.bars;
  if (!bars.length) return;
  const idx = Math.round(indexForX(v, x));
  const bar = bars[idx];
  const time = bar ? bar.time : new TimeIndex(bars, resolutionToMs(v.context.resolution)).timeAt(idx);
  if (time == null) return;
  const label = formatCrosshairTimeLabel(v.context, time);
  if (!label) return;
  ctx.font = `11px ${v.fontFamily}`;
  const w = ctx.measureText(label).width + 14;
  const tx = Math.max(v.plotL, Math.min(v.plotL + v.plotW - w, x - w / 2));
  const axisTop = timeAxisTopOf(v);
  ctx.fillStyle = pill.bg;
  roundRect(ctx, tx, axisTop + 2, w, TIME_AXIS_H - 4, 3);
  ctx.fill();
  ctx.fillStyle = pill.fg;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, tx + w / 2, axisTop + TIME_AXIS_H / 2 + 0.5);
}

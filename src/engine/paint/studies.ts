import { xForIndex, yForPrice } from "../plotScale";
import type { StudyDefinition, StudySeries } from "../../types/charting_library";
import type { FinanceView } from "./view";

export function strokeStudyLine(
  ctx: CanvasRenderingContext2D,
  v: FinanceView,
  values: (number | null)[],
  color: string,
  yFor: (val: number) => number,
  clipTop: number,
  clipBot: number,
  lineWidth = 1.25,
): void {
  const bars = v.context.bars;
  if (!bars.length || values.length === 0) return;
  const { from, to } = v.visibleRange;
  const start = Math.max(0, Math.floor(from) - 1);
  const end = Math.min(bars.length - 1, Math.ceil(to) + 1);

  ctx.save();
  ctx.beginPath();
  ctx.rect(v.plotL, clipTop, v.plotW, Math.max(1, clipBot - clipTop));
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = "round";
  ctx.beginPath();
  let drawing = false;
  for (let i = start; i <= end; i++) {
    const val = values[i];
    if (val == null || !Number.isFinite(val)) {
      drawing = false;
      continue;
    }
    const x = xForIndex(v, i);
    const y = yFor(val);
    if (!drawing) {
      ctx.moveTo(x, y);
      drawing = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
  ctx.restore();
}

export function drawOverlayStudies(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  for (const s of v.studies.list()) {
    if (s.def.pane !== "overlay" && !s.forceOverlay) continue;
    paintStudySeries(ctx, v, s, (val) => yForPrice(v, val), v.plotT, v.plotT + v.plotH);
  }
}

function paintStudySeries(
  ctx: CanvasRenderingContext2D,
  v: FinanceView,
  s: { color: string; values: (number | null)[]; series?: StudySeries[] },
  yFor: (val: number) => number,
  clipTop: number,
  clipBot: number,
): void {
  // `visible: false` (a createStudy / studies_overrides plot override) skips the plot.
  const all: StudySeries[] = s.series?.length ? s.series : [{ values: s.values, style: "line", color: s.color }];
  const series = all.filter((item) => item.visible !== false);
  const bands = series.filter((item) => item.style === "band");
  if (bands.length >= 2) {
    fillBand(ctx, v, bands[0]!.values, bands[1]!.values, bands[0]!.color || s.color, yFor, clipTop, clipBot);
  }
  for (const item of series) {
    const color = item.color || s.color;
    if (item.style === "histogram") {
      fillHistogram(ctx, v, item.values, color, yFor, clipTop, clipBot);
    } else if (item.style !== "band") {
      strokeStudyLine(ctx, v, item.values, color, yFor, clipTop, clipBot, item.lineWidth);
    } else if (bands.length < 2) {
      strokeStudyLine(ctx, v, item.values, color, yFor, clipTop, clipBot, item.lineWidth);
    }
  }
}

function fillBand(
  ctx: CanvasRenderingContext2D,
  v: FinanceView,
  upper: (number | null)[],
  lower: (number | null)[],
  color: string,
  yFor: (val: number) => number,
  clipTop: number,
  clipBot: number,
): void {
  const bars = v.context.bars;
  const { from, to } = v.visibleRange;
  const start = Math.max(0, Math.floor(from) - 1);
  const end = Math.min(bars.length - 1, Math.ceil(to) + 1);
  ctx.save();
  ctx.beginPath();
  ctx.rect(v.plotL, clipTop, v.plotW, Math.max(1, clipBot - clipTop));
  ctx.clip();
  ctx.beginPath();
  let started = false;
  for (let i = start; i <= end; i++) {
    const val = upper[i];
    if (val == null || !Number.isFinite(val)) { started = false; continue; }
    const x = xForIndex(v, i);
    const y = yFor(val);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  started = false;
  for (let i = end; i >= start; i--) {
    const val = lower[i];
    if (val == null || !Number.isFinite(val)) { started = false; continue; }
    const x = xForIndex(v, i);
    const y = yFor(val);
    if (!started) { ctx.lineTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = color.length === 7 ? `${color}33` : color;
  ctx.fill();
  ctx.restore();
}

function fillHistogram(
  ctx: CanvasRenderingContext2D,
  v: FinanceView,
  values: (number | null)[],
  color: string,
  yFor: (val: number) => number,
  clipTop: number,
  clipBot: number,
): void {
  const bars = v.context.bars;
  const { from, to } = v.visibleRange;
  const start = Math.max(0, Math.floor(from) - 1);
  const end = Math.min(bars.length - 1, Math.ceil(to) + 1);
  const zero = yFor(0);
  const w = Math.max(1, (v.plotW / Math.max(1, to - from)) * 0.6);
  ctx.save();
  ctx.beginPath();
  ctx.rect(v.plotL, clipTop, v.plotW, Math.max(1, clipBot - clipTop));
  ctx.clip();
  for (let i = start; i <= end; i++) {
    const val = values[i];
    if (val == null || !Number.isFinite(val)) continue;
    const x = xForIndex(v, i);
    const y = yFor(val);
    ctx.fillStyle = val >= 0 ? color : "#e57359";
    const top = Math.min(y, zero);
    ctx.fillRect(x - w / 2, top, w, Math.max(1, Math.abs(y - zero)));
  }
  ctx.restore();
}

export function subPaneRange(v: FinanceView, def: StudyDefinition): { min: number; max: number } {
  if (def.range) return def.range;
  const { from, to } = v.visibleRange;
  const start = Math.max(0, Math.floor(from) - 1);
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of v.studies.paneStudies(def)) {
    const series: StudySeries[] = s.series?.length ? s.series : [{ values: s.values }];
    const end = Math.min(s.values.length - 1, Math.ceil(to) + 1);
    for (const item of series) {
      if (item.visible === false) continue;
      for (let i = start; i <= end; i++) {
        const val = item.values[i];
        if (val == null || !Number.isFinite(val)) continue;
        if (val < lo) lo = val;
        if (val > hi) hi = val;
      }
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: 0, max: 1 };
  if (lo === hi) return { min: lo - 1, max: hi + 1 };
  const pad = (hi - lo) * 0.1;
  return { min: lo - pad, max: hi + pad };
}

export function drawSubPanes(
  ctx: CanvasRenderingContext2D,
  v: FinanceView,
  timeTicks: { index: number; time: number }[],
): void {
  const t = v.context.theme;
  for (const pane of v.subPanes) {
    const { def } = pane;
    const range = subPaneRange(v, def);
    pane.min = range.min;
    pane.max = range.max;
    const span = Math.max(1e-12, range.max - range.min);
    const yFor = (val: number): number => {
      const clamped = Math.max(range.min, Math.min(range.max, val));
      return pane.top + ((range.max - clamped) / span) * pane.h;
    };

    ctx.fillStyle = t.paneBackground;
    ctx.fillRect(v.plotL, pane.top, v.plotW, pane.h);

    const levels = def.levels ?? [];
    ctx.strokeStyle = t.horzGrid;
    ctx.lineWidth = 1;
    for (const level of levels) {
      const y = Math.round(yFor(level.value)) + 0.5;
      ctx.beginPath();
      ctx.setLineDash(level.dashed ? [3, 3] : []);
      ctx.moveTo(v.plotL, y);
      ctx.lineTo(v.plotL + v.plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = t.vertGrid;
    ctx.beginPath();
    for (const tk of timeTicks) {
      const x = Math.round(xForIndex(v, tk.index)) + 0.5;
      if (x < v.plotL || x > v.plotL + v.plotW) continue;
      ctx.moveTo(x, pane.top);
      ctx.lineTo(x, pane.top + pane.h);
    }
    ctx.stroke();

    for (const s of v.studies.paneStudies(def)) {
      paintStudySeries(ctx, v, s, yFor, pane.top, pane.top + pane.h);
    }

    ctx.fillStyle = t.scaleText;
    ctx.font = `10px ${v.fontFamily}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (const level of levels) {
      if (!level.axisLabel) continue;
      ctx.fillText(String(level.value), v.plotL + v.plotW + 6, yFor(level.value));
    }
    ctx.textBaseline = "top";
    ctx.fillText(def.label ?? def.name, v.plotL + 6, pane.top + 4);
  }
}

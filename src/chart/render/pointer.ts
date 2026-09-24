// Pointer targets: what a scene-space pointer is over, with structured
// data-space values. Hover (crosshair chips, tooltip, onTooltip) and click
// (onSelect) share this resolution, so chips, tooltips and payloads always
// agree and nothing is recovered by parsing tooltip text.

import { asNumber } from "../compile/shared";
import type { CompiledChart, HoverSample, SceneNode } from "../compile/types";
import type { CompiledSceneV2Fields } from "../sceneTypes";
import type { BandScale } from "../scales";
import { hitTestCompiled, nearestSample, nearestSpatial, sampleIndexFor } from "./hit";
import type { ChartPointerEvent } from "./types";

type Scene = CompiledChart & CompiledSceneV2Fields;

export interface PointerTarget {
  hit: SceneNode | null;
  sample: HoverSample | null;
  /** The hit node that owns the tooltip (rules excluded). */
  accentNode: SceneNode | null;
  isBar: boolean;
  isHeat: boolean;
  isLine: boolean;
  isPoint: boolean;
  /** Scene-space crosshair position after snapping to the target. */
  scanX: number;
  scanY: number;
  /** Data-space x: a number on quantitative axes, the category on band axes. */
  xValue: unknown;
  /** Data-space y on quantitative axes. */
  yValue: number | undefined;
  /** Category under the crosshair on a band Y axis (heatmap rows). */
  yCategory: unknown;
}

/** Category whose band contains `px`, or the nearest band centre. */
export function bandCategoryAt(scale: BandScale<string | number>, px: number): string | number | undefined {
  const domain = scale.domain;
  if (!domain.length || !Number.isFinite(px)) return undefined;
  const width = scale.bandwidth();
  let best: string | number | undefined;
  let bestDistance = Infinity;
  for (const value of domain) {
    const start = scale.start(value);
    if (px >= start && px <= start + width) return value;
    const distance = Math.abs(start + width / 2 - px);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = value;
    }
  }
  return best;
}

function finiteOrUndefined(value: number | null | undefined): number | undefined {
  return value != null && Number.isFinite(value) ? value : undefined;
}

/** A value formatted like its axis: the scene formatter, else a matching tick label. */
function formatAxis(c: CompiledChart, axis: "x" | "y", value: unknown): string {
  const formatter = (c as Scene).formatters?.[axis];
  if (formatter) return formatter(value);
  const tick = (axis === "x" ? c.xTicks : c.yTicks).find((candidate) => candidate.value === value);
  return tick ? tick.label : String(value ?? "");
}

/** X value formatted like the X axis. */
export function formatSceneX(c: CompiledChart, value: unknown): string {
  return formatAxis(c, "x", value);
}

/** Y value formatted like the Y axis. */
export function formatSceneY(c: CompiledChart, value: unknown): string {
  return formatAxis(c, "y", value);
}

function xValueAt(c: CompiledChart, px: number): unknown {
  return c.xScale.kind === "band" ? bandCategoryAt(c.xScale, px) : c.xScale.invert(px);
}

function sampleX(c: CompiledChart, sample: HoverSample): unknown {
  if (sample.xValue === undefined) return xValueAt(c, sample.x);
  if (c.polar || c.xScale.kind === "band") return sample.xValue;
  const numeric = asNumber(sample.xValue);
  return Number.isFinite(numeric) ? numeric : c.xScale.invert(sample.x);
}

function sampleY(c: CompiledChart, sample: HoverSample): number | undefined {
  if (sample.yValue !== undefined) return finiteOrUndefined(sample.yValue);
  return c.yScale.kind === "linear" && !c.polar ? finiteOrUndefined(c.yScale.invert(sample.y)) : undefined;
}

/** Resolve what a scene-space pointer at (x, y) targets. */
export function resolvePointer(c: CompiledChart, x: number, y: number): PointerTarget {
  let sample = nearestSample(c, x, y);
  const hit = hitTestCompiled(c, x, y);
  if (hit?.role === "point" && hit.type === "circle") {
    sample = nearestSpatial(
      sampleIndexFor(c),
      x,
      y,
      Math.max(8, (hit.r ?? 4) + 4),
      (candidate) => candidate.kind === "point" && candidate.series === hit.series,
    ) ?? sample;
  } else if (hit?.role === "bar" || hit?.role === "heat" || hit?.role === "slice") {
    sample = null;
  }
  const accentNode = hit && hit.type !== "rule" ? hit : null;
  const isBar = hit?.role === "bar";
  const isHeat = hit?.role === "heat";
  const isPoint = sample?.kind === "point";
  const isLine = sample?.kind === "line";
  const rectCentreX = hit?.x != null && hit.w ? hit.x + hit.w / 2 : x;

  let scanX = x;
  let scanY = y;
  if (isHeat && hit?.x != null && hit.w) scanX = hit.x + hit.w / 2;
  else if ((isPoint || isLine) && sample) scanX = sample.x;
  else if (isBar) scanX = rectCentreX;
  if (isHeat && hit?.y != null && hit.h) scanY = hit.y + hit.h / 2;
  else if ((isPoint || isLine) && sample) scanY = sample.y;
  else if (isBar && hit?.y != null) scanY = hit.valueY ?? hit.y;

  let xValue: unknown;
  let yValue: number | undefined;
  if (sample) {
    xValue = sampleX(c, sample);
    yValue = sampleY(c, sample);
  } else if (c.polar) {
    xValue = accentNode?.series ?? accentNode?.label;
    yValue = undefined;
  } else if (isBar && hit) {
    xValue = c.xScale.kind === "band"
      ? bandCategoryAt(c.xScale, rectCentreX)
      : finiteOrUndefined(asNumber(hit.xValue)) ?? c.xScale.invert(rectCentreX);
    yValue = finiteOrUndefined(hit.yValue)
      ?? (c.yScale.kind === "linear" ? finiteOrUndefined(c.yScale.invert(scanY)) : undefined);
  } else {
    xValue = xValueAt(c, scanX);
    yValue = c.yScale.kind === "linear" ? finiteOrUndefined(c.yScale.invert(scanY)) : undefined;
  }
  const yCategory = c.yScale.kind === "band" && !c.polar ? bandCategoryAt(c.yScale, scanY) : undefined;
  return { hit, sample, accentNode, isBar, isHeat, isLine, isPoint, scanX, scanY, xValue, yValue, yCategory };
}

/** onTooltip/onSelect payload for a resolved target. */
export function pointerEventFor(target: PointerTarget): ChartPointerEvent {
  const { sample, accentNode } = target;
  const event: ChartPointerEvent = {
    x: target.xValue,
    y: target.yValue,
    series: sample?.series ?? accentNode?.series,
    datum: sample ? sample.datum : accentNode?.datum,
    node: accentNode,
    sample,
  };
  // Samples (lines, points, radar) and row nodes (bars, heatmap cells, pie
  // slices) carry the same identity fields.
  const source = sample ?? accentNode;
  if (source?.seriesId !== undefined) event.seriesId = source.seriesId;
  if (source?.index !== undefined) event.index = source.index;
  if (source?.markIndex !== undefined) event.markIndex = source.markIndex;
  return event;
}

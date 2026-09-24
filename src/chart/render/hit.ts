// Hit testing and hover lookup over a compiled scene. Large scenes use cached
// spatial indexes keyed by the scene object.

import type { CompiledChart, HoverSample, SceneNode } from "../compile/types";
import { TAU, arcSweep } from "./primitives";

const CELL = 48;

function distToSeg(x: number, y: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = dx * dx + dy * dy;
  const t = len <= 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

function inArc(n: SceneNode, x: number, y: number): boolean {
  const cx = n.x ?? 0;
  const cy = n.y ?? 0;
  const dx = x - cx;
  const dy = y - cy;
  const r = Math.hypot(dx, dy);
  const outer = n.r ?? 0;
  const inner = n.innerR ?? 0;
  if (r > outer + 1 || r < inner - 1) return false;
  const a0 = n.startAngle ?? 0;
  const sweep = arcSweep(n);
  if (sweep >= TAU - 1e-9) return true;
  const relative = ((Math.atan2(dy, dx) - a0) % TAU + TAU) % TAU;
  return relative <= sweep + 1e-6;
}

interface HitIndex {
  nodes: SceneNode[];
  length: number;
  cellSize: number;
  cells: Map<string, number[]>;
  global: number[];
}

const hitIndexes = new WeakMap<CompiledChart, HitIndex>();

function cellKey(x: number, y: number): string {
  return `${x}:${y}`;
}

function nodeBounds(n: SceneNode, pad: number): { left: number; top: number; right: number; bottom: number } | null {
  if (n.type === "text" || n.hit === false) return null;
  if (n.type === "rect") {
    const x0 = n.x ?? 0;
    const y0 = n.y ?? 0;
    const x1 = x0 + (n.w ?? 0);
    const y1 = y0 + (n.h ?? 0);
    return { left: Math.min(x0, x1) - pad, top: Math.min(y0, y1) - pad, right: Math.max(x0, x1) + pad, bottom: Math.max(y0, y1) + pad };
  }
  if (n.type === "circle" || n.type === "arc") {
    const radius = (n.r ?? (n.type === "circle" ? 3 : 0)) + pad;
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    return { left: x - radius, top: y - radius, right: x + radius, bottom: y + radius };
  }
  if (n.type === "rule") {
    const x0 = n.x ?? 0;
    const y0 = n.y ?? 0;
    const x1 = n.x2 ?? 0;
    const y1 = n.y2 ?? 0;
    return { left: Math.min(x0, x1) - pad, top: Math.min(y0, y1) - pad, right: Math.max(x0, x1) + pad, bottom: Math.max(y0, y1) + pad };
  }
  if (!n.points?.length) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const point of n.points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  return Number.isFinite(left) ? { left: left - pad, top: top - pad, right: right + pad, bottom: bottom + pad } : null;
}

function createHitIndex(c: CompiledChart): HitIndex {
  const cellSize = CELL;
  const cells = new Map<string, number[]>();
  const global: number[] = [];
  const maxCellsPerNode = 256;
  for (let i = 0; i < c.nodes.length; i++) {
    const bounds = nodeBounds(c.nodes[i]!, 6);
    if (!bounds) continue;
    const left = Math.floor(bounds.left / cellSize);
    const right = Math.floor(bounds.right / cellSize);
    const top = Math.floor(bounds.top / cellSize);
    const bottom = Math.floor(bounds.bottom / cellSize);
    const count = (right - left + 1) * (bottom - top + 1);
    if (!Number.isFinite(count) || count > maxCellsPerNode) {
      global.push(i);
      continue;
    }
    for (let cy = top; cy <= bottom; cy++) {
      for (let cx = left; cx <= right; cx++) {
        const key = cellKey(cx, cy);
        const bucket = cells.get(key);
        if (bucket) bucket.push(i);
        else cells.set(key, [i]);
      }
    }
  }
  const index = { nodes: c.nodes, length: c.nodes.length, cellSize, cells, global };
  hitIndexes.set(c, index);
  return index;
}

function hitNode(n: SceneNode, x: number, y: number, pad: number): boolean {
  if (n.hit === false || n.type === "text") return false;
  if (n.type === "rect") {
    const x0 = n.x ?? 0;
    const y0 = n.y ?? 0;
    const x1 = x0 + (n.w ?? 0);
    const y1 = y0 + (n.h ?? 0);
    return x >= Math.min(x0, x1) && x <= Math.max(x0, x1) && y >= Math.min(y0, y1) && y <= Math.max(y0, y1);
  }
  if (n.type === "circle") {
    return Math.hypot(x - (n.x ?? 0), y - (n.y ?? 0)) <= (n.r ?? 3) + pad;
  }
  if (n.type === "arc") return inArc(n, x, y);
  if ((n.type === "line" || n.type === "area" || n.type === "polygon") && n.points?.length) {
    if (n.type === "polygon" && (n.fill === "none" || !n.series)) return false;
    if (n.type !== "line") {
      let inside = false;
      const pts = n.points;
      for (let j = 0, k = pts.length - 1; j < pts.length; k = j++) {
        const a = pts[j]!;
        const b = pts[k]!;
        const intersects = ((a.y > y) !== (b.y > y)) && (x < (b.x - a.x) * (y - a.y) / (b.y - a.y || 1e-9) + a.x);
        if (intersects) inside = !inside;
      }
      if (inside) return true;
    }
    for (let j = 1; j < n.points.length; j++) {
      const a = n.points[j - 1]!;
      const b = n.points[j]!;
      if (distToSeg(x, y, a.x, a.y, b.x, b.y) <= pad) return true;
    }
  } else if (n.type === "rule") {
    return distToSeg(x, y, n.x ?? 0, n.y ?? 0, n.x2 ?? 0, n.y2 ?? 0) <= pad;
  }
  return false;
}

/** Nearest painted mark under a plot-space pointer. Used by HTML tooltips. */
export function hitTestCompiled(c: CompiledChart, x: number, y: number): SceneNode | null {
  const pad = 6;
  if (c.nodes.length < 128) {
    for (let i = c.nodes.length - 1; i >= 0; i--) {
      const node = c.nodes[i]!;
      if (hitNode(node, x, y, pad)) return node;
    }
    return null;
  }
  let index = hitIndexes.get(c);
  if (!index || index.nodes !== c.nodes || index.length !== c.nodes.length) index = createHitIndex(c);
  const bucket = index.cells.get(cellKey(Math.floor(x / index.cellSize), Math.floor(y / index.cellSize))) ?? [];
  const candidates = index.global.length
    ? Array.from(new Set([...bucket, ...index.global])).sort((a, b) => b - a)
    : [...bucket].reverse();
  for (const nodeIndex of candidates) {
    const node = c.nodes[nodeIndex]!;
    if (hitNode(node, x, y, pad)) return node;
  }
  return null;
}

export interface SampleIndex {
  samples: HoverSample[];
  length: number;
  kinds: Set<HoverSample["kind"]>;
  lineByX: { sample: HoverSample; index: number }[];
  cells: Map<string, { sample: HoverSample; index: number }[]>;
}

const sampleIndexes = new WeakMap<CompiledChart, SampleIndex>();

function createSampleIndex(c: CompiledChart): SampleIndex {
  const lineByX: { sample: HoverSample; index: number }[] = [];
  const cells = new Map<string, { sample: HoverSample; index: number }[]>();
  const kinds = new Set<HoverSample["kind"]>();
  for (let i = 0; i < c.samples.length; i++) {
    const sample = c.samples[i]!;
    kinds.add(sample.kind);
    if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y)) continue;
    if (sample.kind === "line") lineByX.push({ sample, index: i });
    const key = cellKey(Math.floor(sample.x / CELL), Math.floor(sample.y / CELL));
    const bucket = cells.get(key);
    if (bucket) bucket.push({ sample, index: i });
    else cells.set(key, [{ sample, index: i }]);
  }
  lineByX.sort((a, b) => a.sample.x - b.sample.x || a.index - b.index);
  const index = { samples: c.samples, length: c.samples.length, kinds, lineByX, cells };
  sampleIndexes.set(c, index);
  return index;
}

/** Cached hover-sample index for a scene, rebuilt if its samples changed. */
export function sampleIndexFor(c: CompiledChart): SampleIndex {
  const index = sampleIndexes.get(c);
  if (!index || index.samples !== c.samples || index.length !== c.samples.length) return createSampleIndex(c);
  return index;
}

function lowerBoundX(values: readonly { sample: HoverSample }[], x: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid]!.sample.x < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Closest accepted sample within `radius`, ties resolved by scene order. */
export function nearestSpatial(
  index: SampleIndex,
  x: number,
  y: number,
  radius: number,
  accepts: (sample: HoverSample) => boolean = () => true,
): HoverSample | null {
  const cx = Math.floor(x / CELL);
  const cy = Math.floor(y / CELL);
  const candidates: { sample: HoverSample; index: number }[] = [];
  const reach = Math.max(1, Math.ceil(radius / CELL));
  for (let iy = cy - reach; iy <= cy + reach; iy++) {
    for (let ix = cx - reach; ix <= cx + reach; ix++) {
      const bucket = index.cells.get(cellKey(ix, iy));
      if (bucket) for (const index of bucket) candidates.push(index);
    }
  }
  candidates.sort((a, b) => a.index - b.index);
  let best: HoverSample | null = null;
  let bestDistance = radius;
  for (const { sample } of candidates) {
    if (!accepts(sample)) continue;
    const distance = Math.hypot(sample.x - x, sample.y - y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = sample;
    }
  }
  return best;
}

function nearestLine(index: SampleIndex, x: number, y: number): HoverSample | null {
  const values = index.lineByX;
  if (!values.length) return null;
  const at = lowerBoundX(values, x);
  const leftDx = at > 0 ? Math.abs(values[at - 1]!.sample.x - x) : Infinity;
  const rightDx = at < values.length ? Math.abs(values[at]!.sample.x - x) : Infinity;
  const minDx = Math.min(leftDx, rightDx);
  const from = lowerBoundX(values, x - minDx - 0.5);
  let to = lowerBoundX(values, x + minDx + 0.5);
  while (to < values.length && values[to]!.sample.x <= x + minDx + 0.5) to++;
  const candidates = values.slice(from, to).sort((a, b) => a.index - b.index);
  let best: HoverSample | null = null;
  let bestDx = Infinity;
  let bestDy = Infinity;
  for (const { sample } of candidates) {
    const dx = Math.abs(sample.x - x);
    const dy = Math.abs(sample.y - y);
    if (dx < bestDx - 0.5 || (Math.abs(dx - bestDx) <= 0.5 && dy < bestDy)) {
      bestDx = dx;
      bestDy = dy;
      best = sample;
    }
  }
  return best;
}

export function nearestSample(c: CompiledChart, x: number, y: number): HoverSample | null {
  if (!c.samples.length) return null;
  const index = sampleIndexFor(c);
  if (index.kinds.has("point")) {
    const point = nearestSpatial(index, x, y, index.kinds.has("line") ? 12 : 48, (sample) => sample.kind === "point");
    if (point) return point;
  }
  if (index.kinds.has("radar")) return nearestSpatial(index, x, y, 22);
  return nearestLine(index, x, y);
}

export function tooltipText(n: SceneNode): string {
  if (n.tip) return n.tip;
  const row = n.datum;
  if (n.type === "arc") {
    return n.label || n.series || "";
  }
  if (row && typeof row === "object") {
    const entries = Object.entries(row as Record<string, unknown>);
    const nums = entries.filter(([, v]) => typeof v === "number" && Number.isFinite(v));
    const cats = entries.filter(([, v]) => typeof v !== "number");
    const fmt = (v: unknown): string => {
      if (typeof v === "number") {
        if (Number.isInteger(v)) return String(v);
        const body = Math.abs(v).toFixed(Math.abs(v) < 1 ? 2 : 1);
        if (v > 0) return `+${body}`;
        if (v < 0) return `-${body}`;
        return body;
      }
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      return String(v);
    };
    if (cats.length >= 2 && nums.length === 1) {
      return `${cats.map(([, c]) => fmt(c)).join("  ·  ")}\n${fmt(nums[0]![1])}`;
    }
    const title = n.series || n.label;
    const body = entries.slice(0, 5).map(([k, v]) => `${k}   ${fmt(v)}`).join("\n");
    return title ? `${title}\n${body}` : body;
  }
  return n.series || n.label || "";
}

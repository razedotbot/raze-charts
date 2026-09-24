// Pixel-aware extrema decimation for dense line/area series. Budgets are
// global per series: gap segments share one point budget, and the global
// extrema plus the true source tail survive even under tiny caps.

import type { ScenePoint } from "./types";

export interface SeriesSegment<T> {
  points: ScenePoint[];
  rows: T[];
}

export function decimateExtrema<T>(
  points: readonly ScenePoint[],
  rows: readonly T[],
  limit: number,
  options: { preserveTail?: boolean; preferredY?: readonly number[] } = {},
): SeriesSegment<T> {
  if (limit <= 0 || points.length === 0) return { points: [], rows: [] };
  if (limit === 1) {
    const preferred = !options.preserveTail
      ? points.findIndex((point) => options.preferredY?.includes(point.y))
      : -1;
    const index = preferred >= 0 ? preferred : points.length - 1;
    return { points: [points[index]!], rows: [rows[index]!] };
  }
  if (limit === 2 && points.length > 2) {
    let minIndex = 0;
    let maxIndex = 0;
    for (let index = 1; index < points.length; index++) {
      if (points[index]!.y < points[minIndex]!.y) minIndex = index;
      if (points[index]!.y > points[maxIndex]!.y) maxIndex = index;
    }
    if (options.preserveTail) {
      const finalIndex = points.length - 1;
      let contextIndex: number;
      const preferred = points.findIndex((point, index) => (
        index !== finalIndex && options.preferredY?.includes(point.y)
      ));
      if (preferred >= 0) contextIndex = preferred;
      else if (minIndex === finalIndex) contextIndex = maxIndex;
      else if (maxIndex === finalIndex) contextIndex = minIndex;
      else {
        const finalY = points[finalIndex]!.y;
        contextIndex = Math.abs(points[minIndex]!.y - finalY) >= Math.abs(points[maxIndex]!.y - finalY)
          ? minIndex
          : maxIndex;
      }
      if (contextIndex === finalIndex) contextIndex = 0;
      return {
        points: [points[contextIndex]!, points[finalIndex]!],
        rows: [rows[contextIndex]!, rows[finalIndex]!],
      };
    }
    if (minIndex === maxIndex) {
      const finalIndex = points.length - 1;
      return { points: [points[0]!, points[finalIndex]!], rows: [rows[0]!, rows[finalIndex]!] };
    }
    const first = Math.min(minIndex, maxIndex);
    const second = Math.max(minIndex, maxIndex);
    return { points: [points[first]!, points[second]!], rows: [rows[first]!, rows[second]!] };
  }
  if (limit === 3 && points.length > 3) {
    let minIndex = 0;
    let maxIndex = 0;
    for (let index = 1; index < points.length; index++) {
      if (points[index]!.y < points[minIndex]!.y) minIndex = index;
      if (points[index]!.y > points[maxIndex]!.y) maxIndex = index;
    }
    const selected = new Set<number>(options.preserveTail
      ? [minIndex, maxIndex, points.length - 1]
      : [0, minIndex, maxIndex]);
    for (const index of [0, points.length - 1]) {
      if (selected.size < 3) selected.add(index);
    }
    const indices = Array.from(selected).sort((a, b) => a - b).slice(0, 3);
    return {
      points: indices.map((index) => points[index]!),
      rows: indices.map((index) => rows[index]!),
    };
  }
  if (points.length <= limit || points.length <= 2) {
    return { points: Array.from(points), rows: Array.from(rows) };
  }

  // Two extrema per bucket retain spikes and troughs that a simple stride can
  // erase. Indices are emitted in source order, so paths never fold backwards.
  const bucketCount = Math.floor((limit - 2) / 2);
  if (bucketCount <= 0) {
    const index = points.length - 1;
    return { points: [points[0]!, points[index]!], rows: [rows[0]!, rows[index]!] };
  }
  const interior = points.length - 2;
  const outPoints: ScenePoint[] = [points[0]!];
  const outRows: T[] = [rows[0]!];
  let lastIndex = 0;

  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const from = 1 + Math.floor((bucket * interior) / bucketCount);
    const to = 1 + Math.floor(((bucket + 1) * interior) / bucketCount);
    if (from >= to) continue;
    let minIndex = from;
    let maxIndex = from;
    for (let index = from + 1; index < to; index++) {
      if (points[index]!.y < points[minIndex]!.y) minIndex = index;
      if (points[index]!.y > points[maxIndex]!.y) maxIndex = index;
    }
    const ordered = minIndex === maxIndex
      ? [minIndex]
      : minIndex < maxIndex
        ? [minIndex, maxIndex]
        : [maxIndex, minIndex];
    for (const index of ordered) {
      if (index === lastIndex) continue;
      outPoints.push(points[index]!);
      outRows.push(rows[index]!);
      lastIndex = index;
    }
  }

  const finalIndex = points.length - 1;
  if (lastIndex !== finalIndex) {
    outPoints.push(points[finalIndex]!);
    outRows.push(rows[finalIndex]!);
  }
  return { points: outPoints, rows: outRows };
}

/**
 * Reduce gap-separated segments to at most `seriesLimit` points in total.
 * Callers only invoke this when the series exceeds its budget.
 */
export function decimateSegments<T>(
  rawSegments: readonly SeriesSegment<T>[],
  seriesLimit: number,
): SeriesSegment<T>[] {
  // Select and allocate together. Every retained gap segment initially
  // costs one point, while the latest segment and global-extrema segments
  // receive enough context first. This both honors tiny hard caps and
  // avoids wasting half the budget on singleton segments.
  let minY = Infinity;
  let maxY = -Infinity;
  let minSegment = 0;
  let maxSegment = 0;
  for (let index = 0; index < rawSegments.length; index++) {
    for (const point of rawSegments[index]!.points) {
      if (point.y < minY) { minY = point.y; minSegment = index; }
      if (point.y > maxY) { maxY = point.y; maxSegment = index; }
    }
  }
  const finalSegment = rawSegments.length - 1;
  const quotas = new Map<number, number>();
  let unallocated = seriesLimit;
  const allocate = (index: number, preferred: number): void => {
    if (index < 0 || index >= rawSegments.length || unallocated <= 0) return;
    const previous = quotas.get(index) ?? 0;
    const desired = Math.min(preferred, rawSegments[index]!.points.length);
    const addition = Math.min(Math.max(0, desired - previous), unallocated);
    if (addition <= 0) return;
    quotas.set(index, previous + addition);
    unallocated -= addition;
  };
  const finalExtrema = Number(finalSegment === minSegment) + Number(finalSegment === maxSegment);
  allocate(finalSegment, finalExtrema > 0 ? 3 : 2);
  allocate(minSegment, 2);
  allocate(maxSegment, 2);
  allocate(0, 1);

  const targetSegments = Math.min(rawSegments.length, quotas.size + unallocated);
  if (targetSegments === 1) allocate(finalSegment, 1);
  else {
    for (let slot = 0; slot < targetSegments && unallocated > 0; slot++) {
      allocate(Math.round((slot * (rawSegments.length - 1)) / (targetSegments - 1)), 1);
    }
  }
  for (let index = 0; index < rawSegments.length && unallocated > 0; index++) allocate(index, 1);

  const selectedIndices = Array.from(quotas.keys()).sort((a, b) => a - b);
  let remainingCapacity = selectedIndices.reduce(
    (total, index) => total + Math.max(0, rawSegments[index]!.points.length - quotas.get(index)!),
    0,
  );
  for (const index of selectedIndices) {
    const currentQuota = quotas.get(index)!;
    const capacity = Math.max(0, rawSegments[index]!.points.length - currentQuota);
    const extra = remainingCapacity > 0
      ? Math.min(capacity, Math.floor((unallocated * capacity) / remainingCapacity))
      : 0;
    quotas.set(index, currentQuota + extra);
    unallocated -= extra;
    remainingCapacity -= capacity;
  }
  return selectedIndices.map((index) => decimateExtrema(
    rawSegments[index]!.points,
    rawSegments[index]!.rows,
    quotas.get(index)!,
    {
      preserveTail: index === finalSegment,
      preferredY: [
        ...(index === minSegment ? [minY] : []),
        ...(index === maxSegment ? [maxY] : []),
      ],
    },
  ));
}

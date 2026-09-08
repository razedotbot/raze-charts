// Compact scales for dashboard charts. Zero D3. Finance bar-index scales stay
// in src/engine/plotScale.ts.

export interface LinearScale {
  readonly kind: "linear";
  domain: [number, number];
  range: [number, number];
  map(value: number): number;
  invert(px: number): number;
  ticks(count?: number): number[];
  copy(): LinearScale;
}

export interface BandScale<T extends string | number = string> {
  readonly kind: "band";
  domain: T[];
  range: [number, number];
  padding: number;
  map(value: T): number;
  start(value: T): number;
  bandwidth(): number;
  copy(): BandScale<T>;
}

export type AnyScale = LinearScale | BandScale<string | number>;

function niceStep(raw: number): number {
  const absolute = Math.abs(raw);
  if (!Number.isFinite(absolute) || absolute === 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(absolute))) || Number.MIN_VALUE;
  const norm = raw / mag;
  return (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
}

export function scaleLinear(opts?: {
  domain?: readonly [number, number];
  range?: readonly [number, number];
  nice?: boolean;
}): LinearScale {
  let domain: [number, number] = opts?.domain ? [...opts.domain] : [0, 1];
  let range: [number, number] = opts?.range ? [...opts.range] : [0, 1];
  if (opts?.nice) {
    const ascending = domain[1] >= domain[0];
    const span = Math.abs(domain[1] - domain[0]) || 1;
    const step = niceStep(span / 5);
    domain = ascending
      ? [Math.floor(domain[0] / step) * step, Math.ceil(domain[1] / step) * step]
      : [Math.ceil(domain[0] / step) * step, Math.floor(domain[1] / step) * step];
    if (domain[0] === domain[1]) domain[1] = domain[0] + (ascending ? step : -step);
  }
  const self: LinearScale = {
    kind: "linear",
    get domain() { return domain; },
    set domain(d) { domain = [d[0], d[1]]; },
    get range() { return range; },
    set range(r) { range = [r[0], r[1]]; },
    map(value: number): number {
      const [d0, d1] = domain;
      const [r0, r1] = range;
      const t = (value - d0) / (d1 - d0 || 1);
      return r0 + t * (r1 - r0);
    },
    invert(px: number): number {
      const [d0, d1] = domain;
      const [r0, r1] = range;
      const t = (px - r0) / (r1 - r0 || 1);
      return d0 + t * (d1 - d0);
    },
    ticks(count = 5): number[] {
      const [d0, d1] = domain;
      if (d0 === d1) return [d0];
      const descending = d1 < d0;
      const lo = Math.min(d0, d1);
      const hi = Math.max(d0, d1);
      const span = hi - lo;
      const step = niceStep(span / Math.max(1, count));
      const first = Math.ceil(lo / step) * step;
      const out: number[] = [];
      for (let v = first; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
      return descending ? out.reverse() : out;
    },
    copy() {
      return scaleLinear({ domain: [...domain], range: [...range] });
    },
  };
  return self;
}

export function scaleTime(opts?: {
  domain?: readonly [number | Date, number | Date];
  range?: readonly [number, number];
}): LinearScale {
  const toN = (v: number | Date): number => (v instanceof Date ? v.getTime() : v);
  const domain = opts?.domain
    ? [toN(opts.domain[0]), toN(opts.domain[1])] as [number, number]
    : [0, 1] as [number, number];
  return scaleLinear({ domain, range: opts?.range });
}

export function scaleLog(opts?: {
  domain?: readonly [number, number];
  range?: readonly [number, number];
}): LinearScale {
  const toLogDomain = (domain: readonly [number, number]): [number, number] => {
    if (!domain.every((value) => typeof value === "number" && Number.isFinite(value) && value > 0)) {
      throw new RangeError("scaleLog domain endpoints must be finite numbers greater than zero.");
    }
    const result: [number, number] = [Math.log10(domain[0]), Math.log10(domain[1])];
    if (result[0] === result[1]) {
      const halfDecade = Math.log10(Math.SQRT2);
      result[0] -= halfDecade;
      result[1] += halfDecade;
    }
    return result;
  };
  const inner = scaleLinear({
    domain: toLogDomain(opts?.domain ?? [1, 10]),
    range: opts?.range,
  });
  return {
    kind: "linear",
    get domain() {
      return [Math.pow(10, inner.domain[0]), Math.pow(10, inner.domain[1])] as [number, number];
    },
    set domain(d) { inner.domain = toLogDomain(d); },
    get range() { return inner.range; },
    set range(r) { inner.range = r; },
    map(value: number) {
      return Number.isFinite(value) && value > 0 ? inner.map(Math.log10(value)) : NaN;
    },
    invert(px: number) { return Math.pow(10, inner.invert(px)); },
    ticks(count = 5) { return inner.ticks(count).map((v) => Math.pow(10, v)); },
    copy() {
      const r = this.range;
      return scaleLog({ domain: this.domain, range: [r[0], r[1]] });
    },
  };
}

export function scaleBand<T extends string | number = string>(opts?: {
  domain?: readonly T[];
  range?: readonly [number, number];
  padding?: number;
}): BandScale<T> {
  let range: [number, number] = opts?.range ? [...opts.range] : [0, 1];
  let padding = opts?.padding ?? 0.2;
  // Band scales sit on the hottest path for bars and heatmaps. Keeping the
  // first domain position in a map makes every lookup O(1), while preserving
  // Array#indexOf's first-match behaviour for duplicate categories.
  let positions = new Map<T, number>();
  let positionsDirty = false;
  function indexDomain(values: readonly T[]): Map<T, number> {
    const out = new Map<T, number>();
    for (let i = 0; i < values.length; i++) {
      const value = values[i]!;
      // `indexOf(NaN)` never matched in the previous implementation.
      if (typeof value === "number" && Number.isNaN(value)) continue;
      if (!out.has(value)) out.set(value, i);
    }
    return out;
  }
  function trackDomain(values: readonly T[]): T[] {
    return new Proxy([...values], {
      set(target, property, value): boolean {
        const updated = Reflect.set(target, property, value);
        positionsDirty = true;
        return updated;
      },
      deleteProperty(target, property): boolean {
        const updated = Reflect.deleteProperty(target, property);
        positionsDirty = true;
        return updated;
      },
      defineProperty(target, property, descriptor): boolean {
        const updated = Reflect.defineProperty(target, property, descriptor);
        positionsDirty = true;
        return updated;
      },
    });
  }
  let domain = trackDomain(opts?.domain ?? []);
  positions = indexDomain(domain);
  const n = (): number => Math.max(1, domain.length);
  const step = (): number => {
    const [r0, r1] = range;
    return (r1 - r0) / n();
  };
  const self: BandScale<T> = {
    kind: "band",
    get domain() { return domain; },
    set domain(d) {
      domain = trackDomain(d);
      positions = indexDomain(domain);
      positionsDirty = false;
    },
    get range() { return range; },
    set range(r) { range = [r[0], r[1]]; },
    get padding() { return padding; },
    set padding(p) { padding = p; },
    bandwidth() {
      return Math.abs(step()) * (1 - padding);
    },
    start(value: T) {
      if (positionsDirty) {
        positions = indexDomain(domain);
        positionsDirty = false;
      }
      const i = positions.get(value);
      if (i == null) return NaN;
      const s = step();
      const width = Math.abs(s) * (1 - padding);
      return s >= 0
        ? range[0] + i * s + (Math.abs(s) - width) / 2
        : range[0] + (i + 1) * s + (Math.abs(s) - width) / 2;
    },
    map(value: T) {
      return this.start(value) + this.bandwidth() / 2;
    },
    copy() {
      return scaleBand({ domain: [...domain], range: [...range], padding });
    },
  };
  return self;
}

export function extent(values: readonly number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return [0, 1];
  if (lo === hi) return [lo > 0 ? 0 : lo - 1, hi === 0 ? 1 : hi];
  return [lo, hi];
}

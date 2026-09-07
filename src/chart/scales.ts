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
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(Math.abs(raw), 1e-12))));
  const norm = raw / mag;
  return (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
}

export function scaleLinear(opts?: {
  domain?: [number, number];
  range?: [number, number];
  nice?: boolean;
}): LinearScale {
  let domain: [number, number] = opts?.domain ? [...opts.domain] : [0, 1];
  let range: [number, number] = opts?.range ? [...opts.range] : [0, 1];
  if (opts?.nice) {
    const span = domain[1] - domain[0] || 1;
    const step = niceStep(span / 5);
    domain = [
      Math.floor(domain[0] / step) * step,
      Math.ceil(domain[1] / step) * step,
    ];
    if (domain[0] === domain[1]) domain[1] = domain[0] + step;
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
      const span = d1 - d0;
      if (span === 0) return [d0];
      const step = niceStep(span / Math.max(1, count));
      const first = Math.ceil(d0 / step) * step;
      const out: number[] = [];
      for (let v = first; v <= d1 + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
      return out;
    },
    copy() {
      return scaleLinear({ domain: [...domain], range: [...range] });
    },
  };
  return self;
}

export function scaleTime(opts?: {
  domain?: [number | Date, number | Date];
  range?: [number, number];
}): LinearScale {
  const toN = (v: number | Date): number => (v instanceof Date ? v.getTime() : v);
  const domain = opts?.domain
    ? [toN(opts.domain[0]), toN(opts.domain[1])] as [number, number]
    : [0, 1] as [number, number];
  return scaleLinear({ domain, range: opts?.range });
}

export function scaleLog(opts?: {
  domain?: [number, number];
  range?: [number, number];
}): LinearScale {
  const inner = scaleLinear({
    domain: [
      Math.log10(Math.max((opts?.domain ?? [1, 10])[0], 1e-12)),
      Math.log10(Math.max((opts?.domain ?? [1, 10])[1], 1e-12)),
    ],
    range: opts?.range,
  });
  return {
    kind: "linear",
    get domain() {
      const d = opts?.domain ?? ([1, 10] as [number, number]);
      return [d[0], d[1]] as [number, number];
    },
    set domain(d) { inner.domain = [Math.log10(Math.max(d[0], 1e-12)), Math.log10(Math.max(d[1], 1e-12))]; },
    get range() { return inner.range; },
    set range(r) { inner.range = r; },
    map(value: number) { return inner.map(Math.log10(Math.max(value, 1e-12))); },
    invert(px: number) { return Math.pow(10, inner.invert(px)); },
    ticks(count = 5) { return inner.ticks(count).map((v) => Math.pow(10, v)); },
    copy() {
      const r = this.range;
      return scaleLog({ domain: this.domain, range: [r[0], r[1]] });
    },
  };
}

export function scaleBand<T extends string | number = string>(opts?: {
  domain?: T[];
  range?: [number, number];
  padding?: number;
}): BandScale<T> {
  let domain: T[] = opts?.domain ? [...opts.domain] : [];
  let range: [number, number] = opts?.range ? [...opts.range] : [0, 1];
  let padding = opts?.padding ?? 0.2;
  const n = (): number => Math.max(1, domain.length);
  const step = (): number => {
    const [r0, r1] = range;
    return (r1 - r0) / n();
  };
  const self: BandScale<T> = {
    kind: "band",
    get domain() { return domain; },
    set domain(d) { domain = [...d]; },
    get range() { return range; },
    set range(r) { range = [r[0], r[1]]; },
    get padding() { return padding; },
    set padding(p) { padding = p; },
    bandwidth() {
      return Math.max(0, step() * (1 - padding));
    },
    start(value: T) {
      const i = domain.indexOf(value);
      if (i < 0) return range[0];
      const s = step();
      const pad = s * padding * 0.5;
      return range[0] + i * s + pad;
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

export function extent(values: number[]): [number, number] {
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

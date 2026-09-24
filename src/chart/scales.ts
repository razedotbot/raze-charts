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

// ---------------------------------------------------------------------------
// Tick generation
//
// A step is an integer mantissa times a power of ten. Tick values are rebuilt
// from that decimal form (`Number("15e-2")`) rather than accumulated in binary
// floating point, so ticks are always the shortest decimal a label would show:
// 0.3, never 0.30000000000000004.

/** Preferred mantissas, as in d3, Chart.js and TradingView price scales. */
const NICE_MANTISSAS = [1, 2, 5] as const;
/** 2.5x10^k competes only when every 1/2/5 step misses the budget by 2+ ticks. */
const FALLBACK_MANTISSA = 25;
/** Relative slack so domain ends that are ticks up to rounding still count. */
const TICK_EPSILON = 1e-9;
/** Default tick budget for `ticks()` and the step `nice` rounds the domain to. */
const DEFAULT_TICK_COUNT = 5;

interface TickStep {
  /** Integer mantissa: 1, 2, 5 or 25. */
  readonly mantissa: number;
  readonly exponent: number;
  /** mantissa x 10^exponent as a number, for arithmetic only. */
  readonly size: number;
}

function decimal(integer: number, exponent: number): number {
  const value = Number(`${integer}e${exponent}`);
  return Number.isFinite(value) ? value : integer * Math.pow(10, exponent);
}

function makeStep(mantissa: number, exponent: number): TickStep {
  return { mantissa, exponent, size: decimal(mantissa, exponent) };
}

/** First and last multiple index of `step` inside [lo, hi], with rounding slack. */
function stepIndices(lo: number, hi: number, step: TickStep): [number, number] {
  const slack = TICK_EPSILON * Math.max(1, (hi - lo) / step.size);
  return [Math.ceil(lo / step.size - slack), Math.floor(hi / step.size + slack)];
}

function stepCount(lo: number, hi: number, step: TickStep): number {
  const [first, last] = stepIndices(lo, hi, step);
  return Math.max(0, last - first + 1);
}

/**
 * Normalises a tick budget. Omitted means the default; fractional budgets are
 * floored and budgets below one mean "a single tick". NaN, infinities and
 * non-numbers are programming errors and throw instead of silently guessing.
 */
function tickBudget(count: number | undefined): number {
  if (count === undefined) return DEFAULT_TICK_COUNT;
  if (typeof count !== "number" || !Number.isFinite(count)) {
    throw new RangeError(`ticks(count) expects a finite number of ticks; received ${String(count)}.`);
  }
  return Math.max(1, Math.floor(count));
}

/**
 * The step whose tick count over [lo, hi] is closest to `count` while staying
 * within [ceil(count / 2), count + 1]. Rounding the raw step down instead (the
 * old behaviour) returned up to 2.6x the budget and crowded the labels.
 *
 * 1, 2 and 5 mantissas are preferred. 2.5 competes only when they miss the
 * budget by two ticks or more (e.g. 0-1.2e12 at five ticks gets 0, 250B,
 * 500B, 750B, 1T rather than 0, 500B, 1T). Ties prefer the denser step.
 */
function tickStep(lo: number, hi: number, count: number): TickStep {
  const span = hi - lo;
  const min = Math.ceil(count / 2);
  const max = count + 1;
  const base = Math.floor(Math.log10(span / count));
  const usable = (step: TickStep): boolean => step.size > 0 && Number.isFinite(step.size);
  const candidates: TickStep[] = [];
  for (let exponent = base - 1; exponent <= base + 1; exponent++) {
    for (const mantissa of NICE_MANTISSAS) candidates.push(makeStep(mantissa, exponent));
  }
  const fallbacks: TickStep[] = [];
  for (let exponent = base - 2; exponent <= base; exponent++) fallbacks.push(makeStep(FALLBACK_MANTISSA, exponent));
  const pick = (steps: readonly TickStep[]): { step: TickStep; miss: number } | null => {
    let best: { step: TickStep; miss: number } | null = null;
    for (const step of steps) {
      if (!usable(step)) continue;
      const ticks = stepCount(lo, hi, step);
      if (ticks < min || ticks > max) continue;
      const miss = Math.abs(ticks - count);
      if (!best || miss < best.miss || (miss === best.miss && step.size < best.step.size)) best = { step, miss };
    }
    return best;
  };
  const preferred = pick(candidates);
  if (preferred && preferred.miss < 2) return preferred.step;
  const fallback = pick(fallbacks);
  if (preferred && (!fallback || preferred.miss <= fallback.miss)) return preferred.step;
  if (fallback) return fallback.step;
  // Not reached for finite spans in practice (tests/native-scales.mjs checks
  // many thousands of random domains). Should it ever happen, stay readable:
  // the densest step that does not exceed the budget.
  const all = [...candidates, ...fallbacks].filter(usable).sort((x, y) => x.size - y.size);
  return all.find((step) => stepCount(lo, hi, step) <= max) ?? all[all.length - 1]!;
}

function stepTicks(lo: number, hi: number, step: TickStep): number[] {
  const [first, last] = stepIndices(lo, hi, step);
  const out: number[] = [];
  for (let i = first; i <= last; i++) {
    // Normalise -0 so labels never read "-0". Far from zero (|i| > 2^53) the
    // float grid can alias neighbouring ticks; keep each value once.
    const value = decimal(i * step.mantissa, step.exponent) + 0;
    if (out.length === 0 || value !== out[out.length - 1]) out.push(value);
  }
  return out;
}

/** Nice ascending ticks over [lo, hi] (lo < hi, both finite). */
function linearTicks(lo: number, hi: number, count: number): number[] {
  return stepTicks(lo, hi, tickStep(lo, hi, count));
}

function orderedTicks(d0: number, d1: number, count: number, ticks: (lo: number, hi: number, count: number) => number[]): number[] {
  if (!Number.isFinite(d0) || !Number.isFinite(d1)) return [];
  if (d0 === d1) return [d0];
  // A span that overflows (e.g. -1e308 to 1e308) has no representable step.
  if (!Number.isFinite(d1 - d0)) return [d0, d1];
  const out = ticks(Math.min(d0, d1), Math.max(d0, d1), count);
  return d1 < d0 ? out.reverse() : out;
}

/**
 * Extends a domain outward to whole steps, re-deriving the step until it is
 * stable (widening a domain can promote the step, as in d3's nice()).
 */
function niceDomain(domain: [number, number], count = DEFAULT_TICK_COUNT): [number, number] {
  const ascending = domain[1] >= domain[0];
  let lo = Math.min(domain[0], domain[1]);
  let hi = Math.max(domain[0], domain[1]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return domain;
  if (lo === hi) {
    // A collapsed domain widens by one power of ten of its own magnitude on
    // each side, so the value stays centred.
    const pad = decimal(1, Math.floor(Math.log10(Math.abs(lo) || 1)));
    lo -= pad;
    hi += pad;
  }
  if (!Number.isFinite(hi - lo)) return domain;
  let previous: TickStep | null = null;
  for (let round = 0; round < 4; round++) {
    const step = tickStep(lo, hi, count);
    if (previous && previous.size === step.size) break;
    previous = step;
    const slack = TICK_EPSILON * Math.max(1, (hi - lo) / step.size);
    lo = decimal(Math.floor(lo / step.size + slack) * step.mantissa, step.exponent) + 0;
    hi = decimal(Math.ceil(hi / step.size - slack) * step.mantissa, step.exponent) + 0;
  }
  return ascending ? [lo, hi] : [hi, lo];
}

/** {1, 2, 5} x 10^k from decade `first` to decade `last`, inside [lo, hi]. */
function decadeTicks(lo: number, hi: number, first: number, last: number, mantissas: readonly number[]): number[] {
  const out: number[] = [];
  const slackLo = lo * (1 - TICK_EPSILON);
  const slackHi = hi * (1 + TICK_EPSILON);
  for (let exponent = first; exponent <= last; exponent++) {
    for (const mantissa of mantissas) {
      const value = decimal(mantissa, exponent);
      if (value > 0 && value >= slackLo && value <= slackHi) out.push(value);
    }
  }
  return out;
}

/**
 * Log ticks at powers of ten, with 2x and 5x subdivisions when the budget has
 * room, and every n-th decade when even the powers overflow it. A domain that
 * spans less than a decade and holds too few such values falls back to linear
 * ticks in value space (as d3 does), so a 3-7 axis still gets 3, 4, 5, 6, 7.
 */
function logTicks(lo: number, hi: number, count: number): number[] {
  const max = count + 1;
  const min = Math.ceil(count / 2);
  const firstDecade = Math.floor(Math.log10(lo));
  const lastDecade = Math.floor(Math.log10(hi));
  const decades = lastDecade - firstDecade + 1;
  if (decades * NICE_MANTISSAS.length <= max * 4) {
    const dense = decadeTicks(lo, hi, firstDecade, lastDecade, NICE_MANTISSAS);
    const subDecade = hi / lo < 10;
    if (subDecade && dense.length < Math.max(2, min)) return linearTicks(lo, hi, count);
    if (dense.length <= max) return dense;
  }
  if (decades <= max + 1) {
    const powers = decadeTicks(lo, hi, firstDecade, lastDecade, [1]);
    if (powers.length <= max) return powers;
  }
  // Too many decades for one label each: label every n-th power of ten, with
  // n itself a nice integer step (1, 2, 5, 10, 20, ...).
  const exponentLo = Math.ceil(Math.log10(lo) - TICK_EPSILON);
  const exponentHi = Math.floor(Math.log10(hi) + TICK_EPSILON);
  const exponents = exponentHi > exponentLo
    ? linearTicks(exponentLo, exponentHi, count).filter(Number.isInteger)
    : [exponentLo];
  return exponents.map((exponent) => decimal(1, exponent)).filter((value) => value > 0 && Number.isFinite(value));
}

export function scaleLinear(opts?: {
  domain?: readonly [number, number];
  range?: readonly [number, number];
  nice?: boolean;
}): LinearScale {
  let domain: [number, number] = opts?.domain ? [...opts.domain] : [0, 1];
  let range: [number, number] = opts?.range ? [...opts.range] : [0, 1];
  if (opts?.nice) domain = niceDomain(domain);
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
    ticks(count?: number): number[] {
      return orderedTicks(domain[0], domain[1], tickBudget(count), linearTicks);
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
  const valueDomain = (): [number, number] => [Math.pow(10, inner.domain[0]), Math.pow(10, inner.domain[1])];
  return {
    kind: "linear",
    get domain() { return valueDomain(); },
    set domain(d) { inner.domain = toLogDomain(d); },
    get range() { return inner.range; },
    set range(r) { inner.range = r; },
    map(value: number) {
      return Number.isFinite(value) && value > 0 ? inner.map(Math.log10(value)) : NaN;
    },
    invert(px: number) { return Math.pow(10, inner.invert(px)); },
    ticks(count?: number) {
      const [d0, d1] = valueDomain();
      return orderedTicks(d0, d1, tickBudget(count), logTicks);
    },
    copy() {
      const r = inner.range;
      return scaleLog({ domain: valueDomain(), range: [r[0], r[1]] });
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

/**
 * [min, max] of the finite values, or [0, 1] when there are none.
 *
 * A flat series (every value equal to v) gets a domain centred on v, padded by
 * max(|v| x 1%, 1), so its line sits in the middle of the plot instead of
 * being pinned to an edge of a zero-anchored [0, v] domain. The pad never
 * carries a non-zero value across zero: flat 0.5 gives [0, 1], keeping
 * heatmaps one-signed. Callers that want a zero baseline (bars, areas) add it
 * themselves.
 */
export function extent(values: readonly number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return [0, 1];
  if (lo === hi) return flatDomain(lo);
  return [lo, hi];
}

function flatDomain(value: number): [number, number] {
  const pad = Math.min(
    Math.max(Math.abs(value) * 0.01, 1),
    value === 0 ? Infinity : Math.abs(value),
  );
  return [value - pad + 0, value + pad + 0];
}

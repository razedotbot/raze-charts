// Native /chart scales: bounded tick density, decade-aware log ticks, and
// centred domains for flat series.
import assert from "node:assert/strict";
import {
  bar,
  compileChart,
  defineChart,
  extent,
  line,
  scaleLinear,
  scaleLog,
  scaleTime,
} from "../dist/chart.esm.js";

// Deterministic PRNG so a failure reproduces.
function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** True when `value` prints as a short decimal (no 0.30000000000000004). */
function isCleanDecimal(value) {
  return Number(value.toPrecision(12)) === value;
}

// ---------------------------------------------------------------------------
// Linear tick budget (native-tick-density-overshoot)

{
  const random = prng(0x5eed);
  let checked = 0;
  for (let i = 0; i < 5_000; i++) {
    const magnitude = 10 ** (Math.floor(random() * 30) - 15);
    const offset = (random() * 2 - 1) * magnitude * (random() < 0.25 ? 1_000 : 1);
    const span = magnitude * (0.01 + random() * 10);
    const lo = offset;
    const hi = offset + span;
    if (!(hi > lo)) continue;
    const count = 1 + Math.floor(random() * 12);
    const descending = random() < 0.2;
    const ticks = scaleLinear({ domain: descending ? [hi, lo] : [lo, hi] }).ticks(count);
    const context = `ticks(${count}) over [${lo}, ${hi}] gave ${JSON.stringify(ticks)}`;
    assert.ok(ticks.length >= Math.ceil(count / 2), `too few ticks: ${context}`);
    assert.ok(ticks.length <= count + 1, `tick budget overshoot: ${context}`);
    const tolerance = span * 1e-9;
    for (let j = 0; j < ticks.length; j++) {
      assert.ok(ticks[j] >= lo - tolerance && ticks[j] <= hi + tolerance, `tick outside the domain: ${context}`);
      if (j > 0) {
        assert.ok(descending ? ticks[j] < ticks[j - 1] : ticks[j] > ticks[j - 1], `ticks are strictly ordered: ${context}`);
      }
    }
    if (ticks.length > 2) {
      const step = Math.abs(ticks[1] - ticks[0]);
      for (let j = 2; j < ticks.length; j++) {
        assert.ok(Math.abs(Math.abs(ticks[j] - ticks[j - 1]) - step) <= step * 1e-6, `ticks are evenly spaced: ${context}`);
      }
      const mantissa = Number((step / 10 ** Math.floor(Math.log10(step) + 1e-9)).toPrecision(3));
      assert.ok([1, 2, 2.5, 5].includes(mantissa), `step ${step} is 1, 2, 2.5 or 5 x 10^k: ${context}`);
    }
    if (magnitude >= 1e-6 && Math.abs(offset) / span < 1e6) {
      assert.ok(ticks.every(isCleanDecimal), `tick values are clean decimals: ${context}`);
    }
    checked++;
  }
  assert.ok(checked >= 1_000, "the property test covers at least 1,000 random domains");
}

// The audit's scratch cases: 11-13 ticks for a budget of 5.
assert.deepEqual(scaleLinear({ domain: [0, 20] }).ticks(5), [0, 5, 10, 15, 20], "0-20 no longer gets 11 ticks");
assert.ok(scaleLinear({ domain: [0.1, 0.12] }).ticks(5).length <= 6, "0.10-0.12 stays within budget");
assert.ok(scaleLinear({ domain: [0, 1.2e12] }).ticks(5).length <= 6, "1.2e12 stays within budget");
assert.deepEqual(scaleLinear({ domain: [0.1, 0.3] }).ticks(4), [0.1, 0.15, 0.2, 0.25, 0.3], "decimal ticks carry no float artefacts");
assert.deepEqual(scaleLinear({ domain: [-1, 1] }).ticks(4), [-1, -0.5, 0, 0.5, 1], "zero is a tick");
assert.ok(!Object.is(scaleLinear({ domain: [-1, 1] }).ticks(2)[1], -0), "a zero tick is never negative zero");
assert.deepEqual(scaleLinear({ domain: [10, 0] }).ticks(3), [10, 5, 0], "descending domains return descending ticks");
assert.deepEqual(scaleLinear({ domain: [3, 3] }).ticks(5), [3], "a collapsed domain has its single value as the tick");
assert.equal(scaleLinear({ domain: [0, 100] }).ticks().length, 6, "the default budget is five");
assert.ok(scaleLinear({ domain: [0, 100] }).ticks(0).length <= 2, "budgets below one mean a single tick");
assert.deepEqual(scaleLinear({ domain: [-1e308, 1e308] }).ticks(5), [-1e308, 1e308], "an overflowing span returns its endpoints instead of hanging");
for (const bad of [Number.NaN, Infinity, "5"]) {
  assert.throws(() => scaleLinear({ domain: [0, 1] }).ticks(bad), RangeError, `ticks(${String(bad)}) fails loudly`);
}
assert.ok(scaleTime({ domain: [0, 86_400_000] }).ticks(4).length <= 5, "time scales share the bounded linear ticks");

// nice() extends to whole steps and keeps the value centred for a flat domain.
{
  const nice = scaleLinear({ domain: [0.3, 9.8], nice: true });
  assert.deepEqual(nice.domain, [0, 10], "nice rounds out to whole steps");
  assert.deepEqual(scaleLinear({ domain: [9.8, 0.3], nice: true }).domain, [10, 0], "nice preserves a descending domain");
  const flat = scaleLinear({ domain: [5, 5], nice: true }).domain;
  assert.ok(flat[0] < 5 && flat[1] > 5 && Math.abs((flat[0] + flat[1]) / 2 - 5) < 1e-9, "nice centres a collapsed domain");
  const zeroAnchored = scaleLinear({ domain: [0, 0.37], nice: true });
  const ticks = zeroAnchored.ticks(5);
  assert.equal(ticks[0], zeroAnchored.domain[0], "nice domains start on a tick");
  assert.equal(ticks[ticks.length - 1], zeroAnchored.domain[1], "nice domains end on a tick");
}

// ---------------------------------------------------------------------------
// Log ticks (native-log-scale-ticks)

function isOneTwoFive(value) {
  const exponent = Math.floor(Math.log10(value) + 1e-9);
  const mantissa = Number((value / 10 ** exponent).toPrecision(9));
  return [1, 2, 5].includes(mantissa);
}

assert.deepEqual(scaleLog({ domain: [1, 1000] }).ticks(5), [1, 10, 100, 1000], "1-1000 ticks at powers of ten");
assert.deepEqual(
  scaleLog({ domain: [1, 1000] }).ticks(10),
  [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000],
  "1-1000 adds 2x and 5x subdivisions when there is room",
);
assert.deepEqual(scaleLog({ domain: [3, 52] }).ticks(5), [5, 10, 20, 50], "3-52 ticks at 5, 10, 20, 50");
assert.deepEqual(scaleLog({ domain: [1000, 1] }).ticks(5), [1000, 100, 10, 1], "descending log domains return descending ticks");
assert.deepEqual(
  scaleLog({ domain: [0.001, 0.1] }).ticks(8),
  [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1],
  "fractional log ticks are exact decimals",
);
assert.deepEqual(scaleLog({ domain: [3, 7] }).ticks(5), [3, 4, 5, 6, 7], "a sub-decade domain falls back to linear ticks");
{
  const wide = scaleLog({ domain: [1e-30, 1e30] }).ticks(6);
  assert.ok(wide.length >= 3 && wide.length <= 7, "very wide log domains label every n-th decade within budget");
  assert.ok(wide.every((value) => Number.isInteger(Math.log10(value))), "decade-skipping ticks stay powers of ten");
  const labels = scaleLog({ domain: [1, 1000] }).ticks(5).map(String);
  assert.deepEqual(labels, ["1", "10", "100", "1000"], "log tick values print without artefacts (no 3.2 or 31.6)");
}
{
  const random = prng(0x106);
  for (let i = 0; i < 1_000; i++) {
    const lo = 10 ** (random() * 20 - 10);
    const hi = lo * 10 ** (1 + random() * 8);
    const count = 2 + Math.floor(random() * 10);
    const ticks = scaleLog({ domain: [lo, hi] }).ticks(count);
    const context = `log ticks(${count}) over [${lo}, ${hi}] gave ${JSON.stringify(ticks)}`;
    assert.ok(ticks.length >= 1 && ticks.length <= count + 1, `log tick budget: ${context}`);
    assert.ok(ticks.every(isOneTwoFive), `log ticks are {1,2,5}x10^k: ${context}`);
    assert.ok(ticks.every((value) => value >= lo * (1 - 1e-9) && value <= hi * (1 + 1e-9)), `log ticks inside the domain: ${context}`);
  }
}
{
  const logChart = compileChart(defineChart({
    marks: [line([{ x: 1, y: 3 }, { x: 2, y: 52 }], { x: "x", y: "y" })],
    scales: { y: { type: "log" } },
  }), { width: 640, height: 320 });
  const values = logChart.yTicks.map((tick) => tick.value);
  assert.ok(values.length >= 2, "compiled log axes are labelled");
  assert.ok(values.every(isOneTwoFive), `compiled log axes tick at {1,2,5}x10^k, got ${JSON.stringify(values)}`);
}

// ---------------------------------------------------------------------------
// Flat series (native-flat-series-domain)

assert.deepEqual(extent([50_000, 50_000, 50_000]), [49_500, 50_500], "a flat series is padded by 1% around its value");
assert.deepEqual(extent([7]), [6, 8], "small flat values get at least a unit pad");
assert.deepEqual(extent([0, 0]), [-1, 1], "flat zero is centred");
assert.deepEqual(extent([-3, -3]), [-4, -2], "flat negative values are centred");
assert.deepEqual(extent([0.5, 0.5]), [0, 1], "the pad never carries a positive value across zero");
assert.deepEqual(extent([-0.25]), [-0.5, 0], "the pad never carries a negative value across zero");
assert.deepEqual(extent([]), [0, 1], "no finite values keep the unit domain");
assert.deepEqual(extent([Number.NaN, 2, Infinity, 5]), [2, 5], "non-finite values are ignored");

{
  const rows = Array.from({ length: 30 }, (_, x) => ({ x, y: 50_000 }));
  const flat = compileChart(defineChart({ marks: [line(rows, { x: "x", y: "y" })] }), { width: 640, height: 320 });
  const [d0, d1] = flat.yScale.domain;
  assert.ok(d0 > 0 && d0 < 50_000 && d1 > 50_000, `a flat line gets a centred domain, got [${d0}, ${d1}]`);
  const y = flat.yScale.map(50_000);
  const top = flat.plot.y + flat.plot.h / 3;
  const bottom = flat.plot.y + (flat.plot.h * 2) / 3;
  assert.ok(y >= top && y <= bottom, `a flat line renders in the vertical middle third (y=${y}, band ${top}-${bottom})`);
  assert.ok(flat.yTicks.every((tick) => tick.value !== 0), "a flat 50,000 axis is not zero-anchored");

  const bars = compileChart(defineChart({ marks: [bar([{ x: "a", y: 50_000 }, { x: "b", y: 50_000 }], { x: "x", y: "y" })] }), { width: 640, height: 320 });
  assert.ok(bars.yScale.domain[0] <= 0, "bars keep their zero baseline for a flat series");
}

// ---------------------------------------------------------------------------
// Compiled label density: the 640px example from the audit.

{
  const rows = Array.from({ length: 21 }, (_, x) => ({ x, y: 0.1 + (x % 5) * 0.005 }));
  const chart = compileChart(defineChart({ marks: [line(rows, { x: "x", y: "y" })] }), { width: 640, height: 320 });
  const xBudget = Math.max(2, Math.min(5, Math.floor(chart.plot.w / 96)));
  const yBudget = Math.max(2, Math.min(6, Math.floor(chart.plot.h / 52)));
  assert.ok(chart.xTicks.length <= xBudget + 1, `x ticks within budget (${chart.xTicks.length} for ${xBudget})`);
  assert.ok(chart.yTicks.length <= yBudget + 1, `y ticks within budget (${chart.yTicks.length} for ${yBudget})`);
  const gaps = (ticks) => ticks.slice(1).map((tick, i) => Math.abs(tick.px - ticks[i].px));
  assert.ok(Math.min(...gaps(chart.xTicks)) >= 48, "x labels are at least 48px apart");
  assert.ok(Math.min(...gaps(chart.yTicks)) >= 48, "y labels are at least 48px apart");
  // Label text (decimals) belongs to the axis formatter; this suite pins the
  // tick values that formatter receives.
  assert.deepEqual(chart.yTicks.map((tick) => tick.value).slice(0, 2), [0.1, 0.105], "y ticks step by 0.005 without artefacts");
}

// ---------------------------------------------------------------------------
// Extreme finite domains return instead of looping (W1B-04 review): a
// subnormal span underflows span / count, and nice() near the float limit
// rounds up past Number.MAX_VALUE. Run in a child so a regression fails
// instead of hanging the suite.

{
  const { spawnSync } = await import("node:child_process");
  const probe = [
    'import { scaleLinear } from "./dist/chart.esm.js";',
    "const out = [",
    "  scaleLinear({ domain: [5e-324, 1.5e-323] }).ticks(5),",
    "  scaleLinear({ domain: [0, 5e-324] }).ticks(5),",
    "  scaleLinear({ domain: [1e308, 1.7e308], nice: true }).domain,",
    "  scaleLinear({ domain: [0, 1.7e308], nice: true }).domain,",
    "];",
    "process.stdout.write(JSON.stringify(out));",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: new URL("..", import.meta.url), timeout: 10_000, encoding: "utf8",
  });
  assert.equal(result.error, undefined, `extreme domains return promptly: ${result.error?.message}`);
  assert.equal(result.status, 0, result.stderr);
  const [subnormal, tiny, nearMax, wide] = JSON.parse(result.stdout);
  assert.deepEqual(subnormal, [5e-324, 1.5e-323], "a subnormal span keeps its endpoints");
  assert.deepEqual(tiny, [0, 5e-324]);
  for (const domain of [nearMax, wide]) {
    assert.ok(domain.every(Number.isFinite), `nice() keeps a finite domain: ${domain}`);
  }
  assert.ok(nearMax[0] <= 1e308 && nearMax[1] >= 1.7e308, "the nice domain still covers the data");
  assert.ok(wide[0] <= 0 && wide[1] >= 1.7e308);
}

console.log("native scale regression tests passed");

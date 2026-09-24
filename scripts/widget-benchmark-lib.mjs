// Pure helpers shared by the widget browser benchmark runner
// (scripts/benchmark-widget.mjs), the Playwright scenario driver
// (tests/perf/widget.bench.ts) and their Node regression test
// (tests/widget-benchmark.mjs). Nothing here touches a browser or the disk.

/** Data sizes measured by default, in bars. */
export const DEFAULT_SIZES = [1_000, 10_000, 100_000, 500_000];

/**
 * Scenario catalogue. `kind: "time"` values are milliseconds of main-thread
 * work (synchronous handler plus every animation frame it causes); `kind:
 * "heap"` values are retained JS heap megabytes after a forced GC.
 */
export const SCENARIOS = [
  { id: "load", kind: "time", description: "Construct the widget, load the series and paint the first data frame" },
  { id: "frame-default", kind: "time", description: "Repaint after a one-bar viewport change at the default 120-bar zoom" },
  { id: "frame-zoomed-out", kind: "time", description: "Repaint after a one-bar viewport change at 1.5 px per bar" },
  { id: "frame-all", kind: "time", description: "Repaint after a one-bar viewport change with the whole history visible" },
  { id: "crosshair-move", kind: "time", description: "Mouse move sweeping the crosshair across the default view" },
  { id: "crosshair-move-all", kind: "time", description: "Mouse move sweeping the crosshair with the whole history visible" },
  { id: "pan", kind: "time", description: "Pointer drag step while panning the default view" },
  { id: "wheel-zoom", kind: "time", description: "Alternating wheel zoom out/in at the default view" },
  { id: "frame-studies", kind: "time", description: "Default-view repaint with six studies (EMA, SMA, RSI, VWAP, BB, MACD)" },
  { id: "tick-replace", kind: "time", description: "Live tick replacing the forming bar with six studies" },
  { id: "tick-append", kind: "time", description: "Live tick appending a new bar with six studies" },
  { id: "heap", kind: "heap", description: "Retained heap for the series and a mounted widget, after GC" },
  { id: "heap-studies", kind: "heap", description: "Retained heap after adding the six studies, after GC" },
];

export const SCENARIO_IDS = SCENARIOS.map((scenario) => scenario.id);

/**
 * Portable-budget policy used when a scenario has no checked-in budget yet.
 * Budgets must catch algorithmic regressions on slow shared runners, not
 * encode one workstation, so they are generous multiples with a floor.
 */
export const BUDGET_POLICY = {
  time: { multiplier: 6, floor: 10 },
  heap: { multiplier: 2, floor: 16 },
};

/** Nearest-rank percentile (matches scripts/benchmark.mjs). */
export function percentile(values, ratio) {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(sorted.length * ratio) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return value;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/**
 * Summarises raw samples. Each sample is either a number or an object with
 * `ms` (and optionally `scriptMs`, `rasterMs`, `frames`).
 */
export function summarize(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error("[raze-charts] benchmark scenario produced no samples");
  }
  const values = samples.map((sample) => (typeof sample === "number" ? sample : sample.ms));
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`[raze-charts] benchmark sample is not a finite non-negative number: ${value}`);
    }
  }
  const summary = {
    samples: values.length,
    median: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
  };
  const objects = samples.filter((sample) => typeof sample === "object" && sample !== null);
  if (objects.length === samples.length) {
    const pick = (key) => objects.map((sample) => sample[key]).filter(Number.isFinite);
    const script = pick("scriptMs");
    const raster = pick("rasterMs");
    const frames = pick("frames");
    if (script.length) summary.scriptMedian = round(percentile(script, 0.5));
    if (raster.length) summary.rasterMedian = round(percentile(raster, 0.5));
    if (frames.length) summary.framesMedian = percentile(frames, 0.5);
  }
  return summary;
}

/** Parses `--sizes=1000,10000` style lists; rejects anything ambiguous. */
export function parseSizes(raw) {
  if (raw === undefined || raw === null || raw === "") return [...DEFAULT_SIZES];
  const sizes = String(raw).split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
    const normalised = part.toLowerCase().replace(/_/g, "");
    const match = /^(\d+(?:\.\d+)?)(k)?$/.exec(normalised);
    if (!match) throw new Error(`[raze-charts] invalid benchmark size "${part}"; use integers such as 1000 or 10k`);
    const value = Number(match[1]) * (match[2] ? 1_000 : 1);
    if (!Number.isInteger(value) || value < 200) {
      throw new Error(`[raze-charts] benchmark size "${part}" must be an integer of at least 200 bars`);
    }
    return value;
  });
  if (!sizes.length) throw new Error("[raze-charts] --sizes needs at least one size");
  return [...new Set(sizes)].sort((a, b) => a - b);
}

function scenarioKind(id) {
  const scenario = SCENARIOS.find((item) => item.id === id);
  if (!scenario) throw new Error(`[raze-charts] unknown benchmark scenario "${id}"`);
  return scenario.kind;
}

function unitFor(kind) {
  return kind === "heap" ? "MB" : "ms";
}

/**
 * Compares measured medians with the checked-in portable budgets.
 * A measured scenario/size without a budget is reported rather than skipped,
 * so a new scenario can never pass --check silently.
 */
export function evaluateBudgets(results, baseline, { strict = false } = {}) {
  const failures = [];
  const missing = [];
  for (const [id, sizes] of Object.entries(results.scenarios ?? {})) {
    const kind = scenarioKind(id);
    for (const [size, summary] of Object.entries(sizes)) {
      const entry = baseline?.scenarios?.[id]?.sizes?.[size];
      if (!entry || !Number.isFinite(entry.budget)) {
        missing.push({ scenario: id, size: Number(size) });
        continue;
      }
      const limit = strict && Number.isFinite(entry.target) ? entry.target : entry.budget;
      if (summary.median > limit) {
        failures.push({
          scenario: id,
          size: Number(size),
          median: summary.median,
          limit,
          unit: unitFor(kind),
          limitKind: strict && Number.isFinite(entry.target) ? "target" : "budget",
        });
      }
    }
  }
  return { failures, missing };
}

/** Derives a portable budget from a reference median (exported for tests). */
export function portableBudget(kind, value) {
  const policy = BUDGET_POLICY[kind];
  if (!policy) throw new Error(`[raze-charts] unknown benchmark value kind "${kind}"`);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`[raze-charts] cannot derive a budget from ${value}`);
  }
  const scaled = value * policy.multiplier;
  // Round up to a coarse, readable step so a budget is never mistaken for a
  // measurement and neighbouring sizes share the same limit.
  const step = scaled < 20 ? 5 : scaled < 200 ? 10 : scaled < 2_000 ? 100 : 500;
  return Math.max(policy.floor, Math.ceil(scaled / step) * step);
}

/**
 * Returns a new baseline with measured medians recorded as `baseline`.
 * Existing budgets and targets are preserved: changing a budget is an API
 * decision made by editing the JSON, never a side effect of recording.
 */
export function recordBaseline(previous, results, reference) {
  const next = {
    version: 1,
    suite: previous?.suite ?? "financial-widget-browser",
    description: previous?.description ?? "",
    environment: previous?.environment ?? {},
    budgetPolicy: previous?.budgetPolicy ?? {
      time: `max(${BUDGET_POLICY.time.floor} ms, ${BUDGET_POLICY.time.multiplier}x reference median)`,
      heap: `max(${BUDGET_POLICY.heap.floor} MB, ${BUDGET_POLICY.heap.multiplier}x reference median)`,
    },
    reference,
    scenarios: {},
  };
  const ids = new Set([...Object.keys(previous?.scenarios ?? {}), ...Object.keys(results.scenarios ?? {})]);
  for (const id of SCENARIO_IDS.filter((item) => ids.has(item))) {
    const kind = scenarioKind(id);
    const before = previous?.scenarios?.[id] ?? {};
    const measured = results.scenarios?.[id] ?? {};
    const meta = SCENARIOS.find((item) => item.id === id);
    const out = {
      unit: unitFor(kind),
      description: before.description ?? meta.description,
      sizes: {},
    };
    const sizeKeys = new Set([...Object.keys(before.sizes ?? {}), ...Object.keys(measured)]);
    for (const size of [...sizeKeys].sort((a, b) => Number(a) - Number(b))) {
      const prior = before.sizes?.[size] ?? {};
      const summary = measured[size];
      const baselineValue = summary ? round(summary.median, 2) : prior.baseline;
      const entry = { baseline: baselineValue };
      if (summary) entry.p95 = round(summary.p95, 2);
      else if (Number.isFinite(prior.p95)) entry.p95 = prior.p95;
      entry.budget = Number.isFinite(prior.budget) ? prior.budget : portableBudget(kind, baselineValue);
      if (Number.isFinite(prior.target)) entry.target = prior.target;
      out.sizes[size] = entry;
    }
    next.scenarios[id] = out;
  }
  return next;
}

function formatSize(size) {
  return size >= 1_000 ? `${size / 1_000}k` : String(size);
}

function formatValue(value, unit) {
  if (!Number.isFinite(value)) return "-";
  const digits = unit === "MB" ? 1 : value >= 100 ? 1 : 2;
  return `${value.toFixed(digits)}`;
}

/** Human-readable report: one row per scenario and size. */
export function formatTable(results, baseline) {
  const header = ["scenario", "bars", "runs", "median", "p95", "baseline", "budget", "unit"];
  const rows = [];
  for (const id of SCENARIO_IDS) {
    const sizes = results.scenarios?.[id];
    if (!sizes) continue;
    const kind = scenarioKind(id);
    const unit = unitFor(kind);
    for (const size of Object.keys(sizes).sort((a, b) => Number(a) - Number(b))) {
      const summary = sizes[size];
      const entry = baseline?.scenarios?.[id]?.sizes?.[size];
      rows.push([
        id,
        formatSize(Number(size)),
        String(summary.samples),
        formatValue(summary.median, unit),
        formatValue(summary.p95, unit),
        formatValue(entry?.baseline, unit),
        Number.isInteger(entry?.budget) ? String(entry.budget) : formatValue(entry?.budget, unit),
        unit,
      ]);
    }
  }
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));
  const numeric = new Set([2, 3, 4, 5, 6]);
  const line = (cells) => cells
    .map((cell, column) => (numeric.has(column) ? cell.padStart(widths[column]) : cell.padEnd(widths[column])))
    .join("  ")
    .trimEnd();
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join("\n");
}

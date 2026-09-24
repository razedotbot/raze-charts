// Study registry — the pluggable indicator catalogue. Built-ins (EMA/SMA/RSI)
// and host-registered `raze.custom_studies` share the same StudyDefinition
// shape, so every part of the chrome (createStudy, Indicators panel, legend,
// sub-pane renderer) treats them identically.
//
// Name resolution is exact: createStudy() and load() accept a definition's
// name or one of its aliases (case-insensitively), never a keyword substring,
// so an unsupported TradingView study ("Double Exponential Moving Average")
// fails loudly instead of drawing a different indicator. Keywords only feed
// searchStudies() for pickers.

import type {
  Bar,
  StudyComputeResult,
  StudyDefinition,
  StudyInputs,
} from "../types/charting_library";
import type {
  StudyComputeContext,
  StudyInput,
  StudyInputSchema,
  StudySource,
} from "./types";
import { STUDY_SOURCES } from "./types";
import {
  bollinger,
  ema,
  macd,
  offsetSeries,
  rsi,
  sma,
  sourceValues,
  vwap,
  type VwapAnchor,
} from "./calc";

// ── Diagnostics ─────────────────────────────────────────────────────────────

const warned = new Set<string>();

/** Warn once per distinct message; compute() runs on every data change. */
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

// ── Value formatting ────────────────────────────────────────────────────────

/**
 * Format an oscillator value in price units without a symbol formatter:
 * two decimals from 1 upwards, otherwise enough decimals for `digits`
 * significant digits (up to 12), trailing zeros trimmed back to two decimals.
 * A MACD of -0.00000318 on a sub-cent token reads `-0.00000318`, not `-0.0`.
 */
export function formatStudyValue(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  if (abs === 0) return "0.00";
  if (abs >= 1) return value.toFixed(2);
  const decimals = Math.min(12, Math.max(2, digits - 1 - Math.floor(Math.log10(abs))));
  const text = value.toFixed(decimals);
  const trimmed = text.replace(/0+$/, "");
  const dot = trimmed.indexOf(".");
  return trimmed.length - dot - 1 >= 2 ? trimmed : text.slice(0, dot + 3);
}

// ── Built-in input declarations ─────────────────────────────────────────────

/** Effective input values of a built-in, keyed by input id. */
export type StudyInputValueMap = Record<string, number | string | boolean>;

interface BuiltinInputs {
  /**
   * Declaration order is TradingView's `in_N` order. Besides its id, each
   * input accepts its title ("Fast Length", `slowLength`, `signal_smoothing`)
   * and the common spellings in INPUT_ALIASES.
   */
  readonly schema: StudyInputSchema;
  /** The input the store's `length` shorthand sets, if any. */
  readonly lengthInput: string | null;
}

const BUILTIN_INPUTS = new WeakMap<StudyDefinition, BuiltinInputs>();

/** Keys every definition receives from the store or chrome; never "unknown". */
const RESERVED_KEYS = new Set(["length", "color"]);

/** Pine/TradingView spellings of built-in input ids, by `spelling()`. */
const INPUT_ALIASES: Readonly<Record<string, string>> = {
  src: "source",
  len: "length",
  period: "length",
  multiplier: "mult",
};

/** Compare input keys without case, spaces or punctuation. */
function spelling(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const lengthInput = (title: string, value: number): StudyInput =>
  ({ type: "int", title, default: value, min: 1 });
const sourceInput = (value: StudySource): StudyInput => ({ type: "source", title: "Source", default: value });
const offsetInput: StudyInput = { type: "int", title: "Offset", default: 0, min: -500, max: 500, inLabel: false };

function warnInput(study: string, key: string, problem: string): void {
  warnOnce(`[raze-charts] ${study} input "${key}" ${problem}`);
}

function coerce(
  study: string,
  key: string,
  input: StudyInput,
  raw: unknown,
): number | string | boolean | undefined {
  const reject = (expected: string): undefined => {
    warnInput(study, key, `expects ${expected}; got ${JSON.stringify(raw)}. Using ${JSON.stringify(input.default)}.`);
    return undefined;
  };
  switch (input.type) {
    case "int":
    case "float": {
      const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
      if (typeof value !== "number" || !Number.isFinite(value)) return reject("a finite number");
      const numeric = input.type === "int" ? Math.trunc(value) : value;
      const min = input.min ?? -Infinity;
      const max = input.max ?? Infinity;
      if (numeric < min || numeric > max) {
        const clamped = Math.min(max, Math.max(min, numeric));
        const range = max === Infinity ? `at least ${min}` : `between ${min} and ${max}`;
        warnInput(study, key, `must be ${range}; ${value} is clamped to ${clamped}.`);
        return clamped;
      }
      return numeric;
    }
    case "source": {
      const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
      if ((STUDY_SOURCES as readonly string[]).includes(value)) return value;
      return reject(`one of ${STUDY_SOURCES.join(", ")}`);
    }
    case "select": {
      const options = input.options.map((option) => (typeof option === "string" ? option : option.value));
      const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
      const match = options.find((option) => option.toLowerCase() === value);
      return match ?? reject(`one of ${options.join(", ")}`);
    }
    default:
      return typeof raw === "string" ? raw : reject("a string");
  }
}

/**
 * Read a built-in's effective inputs from what createStudy()/the store passed.
 * Accepted keys: the input id, its title (`fastLength`, `Fast Length`), the
 * INPUT_ALIASES spellings (`src`, `multiplier`) and TradingView's positional
 * `in_0`…`in_N`. Precedence, lowest first: defaults, the store's `length`
 * shorthand, named keys, `in_N` keys. Unknown keys and invalid values warn
 * (once) instead of being ignored.
 */
function readInputs(study: string, inputs: BuiltinInputs, raw: StudyInputs): StudyInputValueMap {
  const { schema } = inputs;
  const ids = Object.keys(schema);
  const values: StudyInputValueMap = {};
  const names = new Map<string, string>();
  for (const [alias, id] of Object.entries(INPUT_ALIASES)) if (id in schema) names.set(alias, id);
  for (const id of ids) {
    values[id] = schema[id]!.default;
    names.set(spelling(schema[id]!.title), id);
    names.set(spelling(id), id);
  }
  const apply = (id: string, key: string, value: unknown): void => {
    const next = coerce(study, key, schema[id]!, value);
    if (next !== undefined) values[id] = next;
  };

  if (inputs.lengthInput && raw.length !== undefined) apply(inputs.lengthInput, "length", raw.length);
  const positional: [string, string, unknown][] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (RESERVED_KEYS.has(key)) continue;
    const position = /^in_(\d+)$/.exec(key);
    const id = position ? ids[Number(position[1])] : names.get(spelling(key));
    if (!id) {
      const supported = ids.map((name, index) => `${name} (in_${index})`).join(", ");
      warnInput(study, key, `is not supported and is ignored. Supported inputs: ${supported}.`);
      continue;
    }
    if (position) positional.push([id, key, value]);
    else apply(id, key, value);
  }
  for (const [id, key, value] of positional) apply(id, key, value);
  return values;
}

/**
 * Declare a built-in: attach its input table and wrap compute so it receives
 * the effective, validated inputs.
 */
function builtin(
  definition: Omit<StudyDefinition, "compute">,
  inputs: BuiltinInputs,
  compute: (bars: Bar[], values: StudyInputValueMap, ctx: Partial<StudyComputeContext> | undefined) => StudyComputeResult,
): StudyDefinition {
  const def: StudyDefinition = {
    ...definition,
    compute: (bars: Bar[], raw: StudyInputs, ctx?: Partial<StudyComputeContext>) =>
      compute(bars, readInputs(definition.name, inputs, raw), ctx),
  };
  BUILTIN_INPUTS.set(def, inputs);
  return def;
}

/**
 * The declared input schema of a built-in definition (TradingView `in_N`
 * order), or null for a custom definition. Legend labels, settings dialogs and
 * positional createStudy() inputs read it.
 */
export function builtinInputSchema(def: StudyDefinition): StudyInputSchema | null {
  return BUILTIN_INPUTS.get(def)?.schema ?? null;
}

/**
 * The inputs a built-in actually computes with, after defaults, aliases,
 * `in_N` ids and validation are applied; null for a custom definition.
 */
export function resolveBuiltinInputs(def: StudyDefinition, raw: StudyInputs): StudyInputValueMap | null {
  const inputs = BUILTIN_INPUTS.get(def);
  return inputs ? readInputs(def.name, inputs, raw) : null;
}

const num = (values: StudyInputValueMap, id: string): number => values[id] as number;
const src = (values: StudyInputValueMap, id = "source"): StudySource => values[id] as StudySource;

// ── Built-in catalogue ──────────────────────────────────────────────────────

// One pure IIFE keeps the catalogue tree-shakable for kernel-only imports.
export const BUILTIN_STUDIES: StudyDefinition[] = /* @__PURE__ */ (() => [
  builtin(
    {
      name: "EMA",
      aliases: ["moving average exponential", "exponential moving average"],
      keywords: ["exponential"],
      pane: "overlay",
      defaults: { length: 9, color: "#f5a623" },
    },
    {
      schema: { length: lengthInput("Length", 9), source: sourceInput("close"), offset: offsetInput },
      lengthInput: "length",
    },
    (bars, v) => offsetSeries(ema(sourceValues(bars, src(v)), num(v, "length")), num(v, "offset")),
  ),
  builtin(
    {
      name: "SMA",
      aliases: ["ma", "moving average", "simple moving average"],
      keywords: ["simple"],
      pane: "overlay",
      defaults: { length: 20, color: "#2962ff" },
    },
    {
      schema: { length: lengthInput("Length", 20), source: sourceInput("close"), offset: offsetInput },
      lengthInput: "length",
    },
    (bars, v) => offsetSeries(sma(sourceValues(bars, src(v)), num(v, "length")), num(v, "offset")),
  ),
  builtin(
    {
      name: "RSI",
      aliases: ["relative strength index"],
      keywords: ["oscillator", "momentum"],
      pane: "pane",
      defaults: { length: 14, color: "#7E57C2" },
      range: { min: 0, max: 100 },
      levels: [
        { value: 30, axisLabel: true },
        { value: 50, dashed: true },
        { value: 70, axisLabel: true },
      ],
      formatValue: (v) => v.toFixed(1),
    },
    {
      schema: { length: lengthInput("Length", 14), source: sourceInput("close") },
      lengthInput: "length",
    },
    (bars, v) => rsi(sourceValues(bars, src(v)), num(v, "length")),
  ),
  builtin(
    {
      name: "VWAP",
      aliases: ["volume weighted average price"],
      keywords: ["volume"],
      pane: "overlay",
      defaults: { color: "#e040fb" },
    },
    {
      schema: {
        anchor: {
          type: "select",
          title: "Anchor period",
          default: "session",
          options: ["session", "week", "month", "quarter", "year"],
        },
        source: sourceInput("hlc3"),
        offset: offsetInput,
      },
      lengthInput: null,
    },
    (bars, v, ctx) => {
      if (bars.length > 0 && !bars.some((bar) => (bar.volume ?? 0) > 0)) {
        warnOnce("[raze-charts] VWAP needs bar volume; the datafeed supplies none, so VWAP has no values.");
      }
      const info = ctx?.symbolInfo;
      const options = {
        anchor: v.anchor as VwapAnchor,
        source: src(v),
        timezone: info?.timezone || ctx?.timezone || undefined,
        session: info?.session || undefined,
      };
      let values: (number | null)[];
      try {
        values = vwap(bars, options);
      } catch (error) {
        // An unknown zone or session string must not blank the study.
        warnOnce(`${(error as Error).message}. VWAP falls back to UTC days.`);
        values = vwap(bars, { anchor: options.anchor, source: options.source });
      }
      return offsetSeries(values, num(v, "offset"));
    },
  ),
  builtin(
    {
      name: "Bollinger Bands",
      shortTitle: "BB",
      aliases: ["bb", "bollinger"],
      keywords: ["volatility"],
      pane: "overlay",
      defaults: { length: 20, color: "#2962ff" },
    },
    {
      schema: {
        length: lengthInput("Length", 20),
        mult: { type: "float", title: "StdDev", default: 2, min: 0.001, max: 50, step: 0.5 },
        source: sourceInput("close"),
        offset: offsetInput,
      },
      lengthInput: "length",
    },
    (bars, v) => {
      const { mid, upper, lower } = bollinger(sourceValues(bars, src(v)), num(v, "length"), num(v, "mult"));
      const shift = num(v, "offset");
      return {
        series: [
          { values: offsetSeries(mid, shift), style: "line", name: "BB mid" },
          { values: offsetSeries(upper, shift), style: "band", name: "BB upper", color: "#2962ff66" },
          { values: offsetSeries(lower, shift), style: "band", name: "BB lower", color: "#2962ff66" },
        ],
      };
    },
  ),
  builtin(
    {
      name: "MACD",
      aliases: ["moving average convergence divergence"],
      keywords: ["momentum"],
      pane: "pane",
      // `length` is the slow EMA length (the store's length shorthand).
      defaults: { length: 26, color: "#2962ff" },
      formatValue: (v) => formatStudyValue(v),
    },
    {
      // TradingView's MACD numbers its inputs fast, slow, signal, source:
      // createStudy('MACD', false, false, { in_0: 14, in_1: 30, in_3: 'close', in_2: 9 }).
      schema: {
        fast: lengthInput("Fast length", 12),
        slow: lengthInput("Slow length", 26),
        signal: lengthInput("Signal smoothing", 9),
        source: sourceInput("close"),
      },
      lengthInput: "slow",
    },
    (bars, v) => {
      const fast = num(v, "fast");
      const slow = num(v, "slow");
      if (fast >= slow) {
        warnInput(
          "MACD",
          "fast",
          `is ${fast} but slow is ${slow} (the length shorthand sets slow), so the MACD line is inverted or flat. `
            + "Pass a fast length below slow.",
        );
      }
      const result = macd(sourceValues(bars, src(v)), fast, slow, num(v, "signal"));
      return {
        series: [
          { values: result.macd, style: "line", name: "MACD", color: "#2962ff" },
          { values: result.signal, style: "line", name: "Signal", color: "#f5a623" },
          { values: result.hist, style: "histogram", name: "Hist", color: "#66d89e" },
        ],
      };
    },
  ),
])();

// ── Registry ────────────────────────────────────────────────────────────────

/** Lower-case, collapse whitespace, and drop a TradingView `@tv-basicstudies` id suffix. */
function normaliseName(name: string): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/ ?@tv-basicstudies(-\d+)?$/, "");
}

/**
 * Loose search for pickers such as an Indicators dialog: exact matches first,
 * then name/alias prefixes, name/alias substrings and keywords, each in
 * catalogue order. An empty query lists every definition. Pass
 * `registry.list()`; this lives outside StudyRegistry so bundles that never
 * search do not ship it.
 */
export function searchStudies(defs: readonly StudyDefinition[], query: string): StudyDefinition[] {
  const q = normaliseName(query);
  if (!q) return [...defs];
  const ranked: { def: StudyDefinition; rank: number; order: number }[] = [];
  defs.forEach((def, order) => {
    const names = [def.name, ...(def.aliases ?? [])].map(normaliseName);
    const keywords = (def.keywords ?? []).map(normaliseName).filter(Boolean);
    let rank = -1;
    if (names.includes(q)) rank = 0;
    else if (names.some((n) => n.startsWith(q))) rank = 1;
    else if (names.some((n) => n.includes(q))) rank = 2;
    else if (keywords.some((k) => k.includes(q) || q.includes(k))) rank = 3;
    if (rank >= 0) ranked.push({ def, rank, order });
  });
  return ranked.sort((a, b) => a.rank - b.rank || a.order - b.order).map((item) => item.def);
}

export class StudyRegistry {
  private defs: StudyDefinition[] = [];

  constructor(defs: StudyDefinition[] = BUILTIN_STUDIES) {
    for (const d of defs) this.register(d);
  }

  /** Add or replace (by case-insensitive name) a study definition. */
  register(def: StudyDefinition): void {
    if (!def || typeof def.name !== "string" || !def.name.trim() || typeof def.compute !== "function") {
      console.warn("[raze-charts] ignoring invalid study definition", def);
      return;
    }
    const key = def.name.toLowerCase();
    this.defs = this.defs.filter((d) => d.name.toLowerCase() !== key);
    this.defs.push(def);
  }

  list(): StudyDefinition[] {
    return [...this.defs];
  }

  /**
   * Exact, case-insensitive lookup by name or alias (a TradingView
   * `@tv-basicstudies` suffix is ignored). Keywords never resolve: a name the
   * catalogue lacks returns null rather than a similar-sounding built-in.
   */
  resolve(name: string): StudyDefinition | null {
    const q = normaliseName(name);
    if (!q) return null;
    return this.defs.find((d) => normaliseName(d.name) === q)
      ?? this.defs.find((d) => (d.aliases ?? []).some((a) => normaliseName(a) === q))
      ?? null;
  }

  /** The error message for a name resolve() does not know, listing what is available. */
  unknownStudyMessage(name: string): string {
    const available = this.defs.map((d) => d.name).join(", ") || "none";
    return `[raze-charts] unknown study: ${name}. Available studies: ${available}. `
      + "Names match a study's name or alias exactly; add others through raze.custom_studies.";
  }
}

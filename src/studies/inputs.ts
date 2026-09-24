// Typed study inputs: descriptor builders (`int`, `source`, `select`, …),
// schema validation, value resolution (defaults, coercion, clamping and
// documented errors) and the DOM-free form model that settings dialogs render.
//
// Resolution rules (docs/indicators.md#inputs):
//   - missing, null and undefined values take the declared default;
//   - numeric strings are accepted for numeric inputs, `"true"`/`"false"` for
//     booleans, and numbers for text-like inputs (symbol, resolution, text);
//   - `int` values round to the nearest integer, and `int`/`float`/`price`
//     values outside `min`/`max` clamp to the bound (reported to `onClamp`);
//   - unknown input ids and values of the wrong type throw a StudyInputError
//     that names the study, the input and the accepted values.

import type {
  StudyBoolInput,
  StudyColorInput,
  StudyFloatInput,
  StudyInput,
  StudyInputPrimitive,
  StudyInputSchema,
  StudyInputType,
  StudyInputValues,
  StudyIntInput,
  StudyPriceInput,
  StudyResolutionInput,
  StudySelectInput,
  StudySessionInput,
  StudySource,
  StudySourceInput,
  StudySymbolInput,
  StudyTextInput,
  StudyTimeInput,
} from "../types/charting_library";
import type { Bar } from "../types/charting_library";
import { STUDY_INPUT_TYPES, STUDY_SOURCES } from "./types";

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * Why a study input was rejected:
 * - `invalid-schema`: a definition declares a malformed input (bad id, type,
 *   default, bounds or options). Thrown when the definition is registered.
 * - `unknown-input`: createStudy()/load() passed an id the schema does not declare.
 * - `invalid-value`: a value has the wrong type or is not one of the options.
 */
export type StudyInputErrorCode = "invalid-schema" | "unknown-input" | "invalid-value";

/**
 * Thrown for invalid study inputs; createStudy() rejects with it. The root
 * entry and the `/studies` subpath are separate bundles with their own copy of
 * this class, so test `error.name === "StudyInputError"` (or `error.code`)
 * when the error may come from the other bundle.
 */
export class StudyInputError extends TypeError {
  override readonly name = "StudyInputError";

  constructor(
    readonly code: StudyInputErrorCode,
    /** Study (definition) name. */
    readonly study: string,
    /** Offending input id, or null for schema-level problems. */
    readonly input: string | null,
    message: string,
  ) {
    super(`[raze-charts] study "${study}"${input === null ? "" : ` input "${input}"`}: ${message}`);
  }
}

// ── Builders ────────────────────────────────────────────────────────────────

/** Presentation options shared by every builder. */
export interface StudyInputOptions {
  /** Dialog label; defaults to the humanised input id. */
  title?: string;
  group?: string;
  inline?: string;
  tooltip?: string;
  inLabel?: boolean;
}

/** Bounds for numeric builders. */
export interface StudyNumberInputOptions extends StudyInputOptions {
  min?: number;
  max?: number;
  step?: number;
}

type WithDefault<O, V> = O & { default: V };

function describe<I extends StudyInput>(type: I["type"], value: I["default"], options: object | undefined): I {
  const { title = "", ...rest } = (options ?? {}) as StudyInputOptions;
  return Object.freeze({ ...rest, type, title, default: value }) as unknown as I;
}

function numeric<I extends StudyIntInput | StudyFloatInput | StudyPriceInput>(
  type: I["type"],
  value: number | WithDefault<StudyNumberInputOptions, number>,
  options?: StudyNumberInputOptions,
): I {
  if (typeof value === "object" && value !== null) {
    const { default: initial, ...rest } = value;
    return describe<I>(type, initial, rest);
  }
  return describe<I>(type, value, options);
}

/** Whole-number input: `int(14, { min: 1 })` or `int({ default: 14, min: 1 })`. */
export function int(value: number | WithDefault<StudyNumberInputOptions, number>, options?: StudyNumberInputOptions): StudyIntInput {
  return numeric<StudyIntInput>("int", value, options);
}

/** Decimal input: `float(2, { min: 0.1, step: 0.1 })`. */
export function float(value: number | WithDefault<StudyNumberInputOptions, number>, options?: StudyNumberInputOptions): StudyFloatInput {
  return numeric<StudyFloatInput>("float", value, options);
}

/** Price level in the symbol's units. */
export function price(value: number | WithDefault<StudyNumberInputOptions, number>, options?: StudyNumberInputOptions): StudyPriceInput {
  return numeric<StudyPriceInput>("price", value, options);
}

/** Unix-seconds timestamp (anchored VWAP, anchored volume profile). */
export function time(value: number, options?: StudyInputOptions): StudyTimeInput {
  return describe<StudyTimeInput>("time", value, options);
}

export function bool(value = false, options?: StudyInputOptions): StudyBoolInput {
  return describe<StudyBoolInput>("bool", value, options);
}

/** Price source: open, high, low, close, hl2, hlc3, ohlc4, hlcc4 or volume. */
export function source(value: StudySource = "close", options?: StudyInputOptions): StudySourceInput {
  return describe<StudySourceInput>("source", value, options);
}

/**
 * One of a fixed list: `select(["sma", "ema"], "ema")` or
 * `select([{ value: "sma", title: "Simple" }, …])`. The default is the first option.
 */
export function select<const V extends string>(
  options: readonly V[] | readonly { readonly value: V; readonly title: string }[],
  value?: NoInfer<V>,
  presentation?: StudyInputOptions,
): StudySelectInput<V> {
  const first = options[0];
  const fallback = (typeof first === "object" && first !== null ? first.value : first) as V;
  const input = describe<StudySelectInput<V>>("select", (value ?? fallback) as V, presentation);
  return Object.freeze({ ...input, options: Object.freeze([...options]) as typeof options });
}

export function color(value: string, options?: StudyInputOptions): StudyColorInput {
  return describe<StudyColorInput>("color", value, options);
}

/** TradingView session string: `0930-1600`, `0930-1600:23456`, `0000-0000` or `24x7`. */
export function session(value = "24x7", options?: StudyInputOptions): StudySessionInput {
  return describe<StudySessionInput>("session", value, options);
}

/** Symbol name (compare/spread studies). Empty means the chart symbol. */
export function symbol(value = "", options?: StudyInputOptions): StudySymbolInput {
  return describe<StudySymbolInput>("symbol", value, options);
}

/** Resolution string such as `60` or `1D`. Empty means the chart resolution. */
export function resolution(value = "", options?: StudyInputOptions): StudyResolutionInput {
  return describe<StudyResolutionInput>("resolution", value, options);
}

export function text(value = "", options?: StudyInputOptions): StudyTextInput {
  return describe<StudyTextInput>("text", value, options);
}

// ── Schema validation ───────────────────────────────────────────────────────

const INPUT_ID = /^[A-Za-z][A-Za-z0-9_]*$/;
const SESSION = /^(?:24x7|\d{4}-\d{4}(?::[1-7]+)?(?:[,|]\d{4}-\d{4}(?::[1-7]+)?)*)$/;
const NUMERIC_TYPES: ReadonlySet<StudyInputType> = new Set(["int", "float", "price", "time"]);
const TEXT_TYPES: ReadonlySet<StudyInputType> = new Set(["color", "session", "symbol", "resolution", "text"]);
const normalized = new WeakMap<object, StudyInputSchema>();

/** `fastLength` -> `Fast length`, `in_0` -> `In 0`. */
export function humanizeInputId(id: string): string {
  const words = id
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Option values of a select input, in declaration order. */
export function selectOptionValues(input: StudySelectInput): string[] {
  return input.options.map((option) => (typeof option === "object" && option !== null ? option.value : option));
}

/**
 * Validate a schema and return a frozen copy with every title filled in.
 * Throws a StudyInputError (`invalid-schema`) naming the input and the fix.
 * The result is cached per schema object.
 */
export function normalizeInputSchema(schema: StudyInputSchema, study: string): StudyInputSchema {
  const cached = normalized.get(schema);
  if (cached) return cached;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new StudyInputError("invalid-schema", study, null, "inputs must be an object of { id: descriptor }, for example { length: int(14) }");
  }
  const out: Record<string, StudyInput> = {};
  for (const [id, input] of Object.entries(schema)) {
    const fail = (message: string): never => {
      throw new StudyInputError("invalid-schema", study, id, message);
    };
    if (!INPUT_ID.test(id)) fail("ids must match [A-Za-z][A-Za-z0-9_]* because they are stored in saved layouts");
    if (!input || typeof input !== "object") fail("the descriptor must be an object such as int(14) or source(\"close\")");
    if (!STUDY_INPUT_TYPES.includes(input.type)) {
      fail(`unknown type "${String(input.type)}". Supported types: ${STUDY_INPUT_TYPES.join(", ")}`);
    }
    if (input.title !== undefined && typeof input.title !== "string") fail("title must be a string");
    if ("min" in input || "max" in input || "step" in input) {
      const { min, max, step } = input as StudyNumberInputOptions;
      if (min !== undefined && !Number.isFinite(min)) fail("min must be a finite number");
      if (max !== undefined && !Number.isFinite(max)) fail("max must be a finite number");
      if (min !== undefined && max !== undefined && min > max) fail(`min (${min}) is greater than max (${max})`);
      if (step !== undefined && !(Number.isFinite(step) && step > 0)) fail("step must be a positive number");
    }
    if (input.type === "select") {
      const values = Array.isArray(input.options) ? selectOptionValues(input) : [];
      if (!values.length || values.some((value) => typeof value !== "string")) {
        fail("select inputs need a non-empty options list of strings or { value, title } objects");
      }
      if (new Set(values).size !== values.length) fail("select option values must be unique");
    }
    const title = input.title || humanizeInputId(id);
    const descriptor = Object.freeze({ ...input, title }) as StudyInput;
    const checked = checkedDefault(descriptor, study, id);
    const bounds = input as StudyNumberInputOptions;
    if (typeof checked === "number" && ((bounds.min !== undefined && checked < bounds.min) || (bounds.max !== undefined && checked > bounds.max))) {
      fail(`default ${checked} is outside [${bounds.min ?? "-∞"}, ${bounds.max ?? "∞"}]`);
    }
    out[id] = descriptor;
  }
  const frozen = Object.freeze(out);
  normalized.set(schema, frozen);
  normalized.set(frozen, frozen);
  return frozen;
}

// ── Value resolution ────────────────────────────────────────────────────────

/** A descriptor's default, which must already be a valid value of its type (never coerced or clamped). */
function checkedDefault(input: StudyInput, study: string, id: string): StudyInputPrimitive {
  let value: StudyInputPrimitive | undefined;
  try {
    value = coerce(input, input.default, study, id);
  } catch {
    value = undefined;
  }
  if (value !== input.default) {
    throw new StudyInputError("invalid-schema", study, id, `default ${JSON.stringify(input.default)} is not a valid ${String(input.type)} value`);
  }
  return value;
}

/** Coerce one value to the input's type without clamping; throws `invalid-value`. */
function coerce(input: StudyInput, value: unknown, study: string, id: string): StudyInputPrimitive {
  const reject = (expected: string): never => {
    throw new StudyInputError("invalid-value", study, id, `expected ${expected}, got ${JSON.stringify(value) ?? String(value)}`);
  };
  if (NUMERIC_TYPES.has(input.type)) {
    const number = typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
    if (!Number.isFinite(number)) reject(input.type === "time" ? "Unix seconds" : "a finite number");
    return input.type === "int" ? Math.round(number) : number;
  }
  switch (input.type) {
    case "bool":
      if (typeof value === "boolean") return value;
      if (value === "true" || value === "false") return value === "true";
      return reject("true or false");
    case "source": {
      const key = typeof value === "string" ? value.trim().toLowerCase() : "";
      if ((STUDY_SOURCES as readonly string[]).includes(key)) return key;
      return reject(`one of ${STUDY_SOURCES.join(", ")}`);
    }
    case "select": {
      const options = selectOptionValues(input);
      if (typeof value === "string" && options.includes(value)) return value;
      return reject(`one of ${options.join(", ")}`);
    }
    default: {
      if (!TEXT_TYPES.has(input.type)) return reject("a supported input type");
      const textValue = typeof value === "number" && Number.isFinite(value) && input.type !== "color"
        ? String(value)
        : value;
      if (typeof textValue !== "string") return reject("a string");
      if (input.type === "color" && !textValue.trim()) return reject("a CSS colour");
      if (input.type === "session" && !SESSION.test(textValue.trim())) {
        return reject("a session such as 0930-1600, 0930-1600:23456 or 24x7");
      }
      return input.type === "session" ? textValue.trim() : textValue;
    }
  }
}

/** A value that was clamped into range while resolving inputs. */
export interface StudyInputClamp {
  readonly id: string;
  readonly value: number;
  readonly clamped: number;
}

export interface ResolveInputsOptions {
  /** Called for each out-of-range number that was clamped. */
  onClamp?(clamp: StudyInputClamp): void;
}

/**
 * Resolve caller values against a (normalized) schema: defaults for missing
 * inputs, coercion, rounding and clamping. TradingView positional ids
 * (`in_0`, `in_1`, …) map onto the schema's inputs in declaration order when
 * the schema does not declare them itself.
 */
export function resolveStudyInputs<S extends StudyInputSchema>(
  schema: S,
  values: Readonly<Record<string, unknown>> | null | undefined,
  study: string,
  options: ResolveInputsOptions = {},
): StudyInputValues<S> {
  const ids = Object.keys(schema);
  const out: Record<string, StudyInputPrimitive> = {};
  // Defaults are checked here too, so a hand-written v1 schema is validated
  // the first time it is used even though it never went through defineIndicator().
  for (const id of ids) out[id] = checkedDefault(schema[id]!, study, id);
  for (const [key, value] of Object.entries(values ?? {})) {
    if (value === undefined || value === null) continue;
    let id = key;
    if (!Object.prototype.hasOwnProperty.call(schema, id)) {
      const positional = /^in_(\d+)$/.exec(key);
      const mapped = positional ? ids[Number(positional[1])] : undefined;
      if (!mapped) {
        throw new StudyInputError(
          "unknown-input",
          study,
          key,
          ids.length ? `unknown input. Supported inputs: ${ids.join(", ")}` : "this study declares no inputs",
        );
      }
      id = mapped;
    }
    const input = schema[id]!;
    let next = coerce(input, value, study, id);
    if (typeof next === "number" && (input.type === "int" || input.type === "float" || input.type === "price")) {
      const { min = -Infinity, max = Infinity } = input;
      const clamped = Math.min(max, Math.max(min, next));
      if (clamped !== next) {
        options.onClamp?.({ id, value: next, clamped });
        next = clamped;
      }
    }
    out[id] = next;
  }
  return Object.freeze(out) as StudyInputValues<S>;
}

/**
 * Map TradingView's legacy positional array (`createStudy("EMA", false,
 * false, [30])`) onto the schema's input ids in declaration order. Throws
 * `unknown-input` when the array is longer than the schema.
 */
export function positionalStudyInputs(schema: StudyInputSchema, values: readonly unknown[], study: string): Record<string, unknown> {
  const ids = Object.keys(schema);
  if (values.length > ids.length) {
    throw new StudyInputError(
      "unknown-input",
      study,
      null,
      `received ${values.length} positional inputs but the study declares ${ids.length}${ids.length ? ` (${ids.join(", ")})` : ""}`,
    );
  }
  const out: Record<string, unknown> = {};
  values.forEach((value, index) => { out[ids[index]!] = value; });
  return out;
}

/** Read a price source from a bar. Missing volume reads as NaN (a gap). */
export function sourceValue(bar: Bar, source: StudySource): number {
  switch (source) {
    case "open": return bar.open;
    case "high": return bar.high;
    case "low": return bar.low;
    case "hl2": return (bar.high + bar.low) / 2;
    case "hlc3": return (bar.high + bar.low + bar.close) / 3;
    case "ohlc4": return (bar.open + bar.high + bar.low + bar.close) / 4;
    case "hlcc4": return (bar.high + bar.low + 2 * bar.close) / 4;
    case "volume": return bar.volume ?? Number.NaN;
    default: return bar.close;
  }
}

// ── Form model ──────────────────────────────────────────────────────────────

/** Which control renders an input in a settings form. */
export type StudyInputControl = "number" | "checkbox" | "select" | "color" | "text" | "datetime";

/** One settings-form row, derived from the schema and current values. */
export interface StudyInputField {
  readonly id: string;
  readonly type: StudyInputType;
  readonly control: StudyInputControl;
  readonly title: string;
  readonly value: StudyInputPrimitive;
  readonly default: StudyInputPrimitive;
  readonly group?: string;
  readonly inline?: string;
  readonly tooltip?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /** Decimal places to show: 0 for int, derived from `step` otherwise. */
  readonly precision?: number;
  /** Select/source options. */
  readonly options?: readonly { readonly value: string; readonly title: string }[];
}

const CONTROL_BY_TYPE: Readonly<Record<StudyInputType, StudyInputControl>> = {
  int: "number",
  float: "number",
  price: "number",
  time: "datetime",
  bool: "checkbox",
  source: "select",
  select: "select",
  color: "color",
  session: "text",
  symbol: "text",
  resolution: "text",
  text: "text",
};

function decimals(step: number | undefined): number {
  if (step === undefined) return 2;
  const match = /(?:\.(\d+))?(?:e-(\d+))?$/.exec(String(step));
  return Math.max(match?.[1]?.length ?? 0, Number(match?.[2] ?? 0));
}

/**
 * The settings-form model for a schema: one field per input in declaration
 * order, with its control, bounds, options and the current value. Values not
 * given fall back to the defaults.
 */
export function studyInputFields(
  schema: StudyInputSchema,
  values: Readonly<Record<string, unknown>> = {},
  study = "study",
): StudyInputField[] {
  const resolved = resolveStudyInputs(normalizeInputSchema(schema, study), values, study) as Record<string, StudyInputPrimitive>;
  return Object.entries(normalizeInputSchema(schema, study)).map(([id, input]) => {
    const field: Record<string, unknown> = {
      id,
      type: input.type,
      control: CONTROL_BY_TYPE[input.type],
      title: input.title,
      value: resolved[id],
      default: input.default,
    };
    for (const key of ["group", "inline", "tooltip"] as const) {
      if (input[key] !== undefined) field[key] = input[key];
    }
    if (input.type === "int" || input.type === "float" || input.type === "price") {
      if (input.min !== undefined) field.min = input.min;
      if (input.max !== undefined) field.max = input.max;
      const step = input.step ?? (input.type === "int" ? 1 : undefined);
      if (step !== undefined) field.step = step;
      field.precision = input.type === "int" ? 0 : decimals(input.step);
    }
    if (input.type === "source") field.options = STUDY_SOURCES.map((value) => ({ value, title: value }));
    if (input.type === "select") {
      field.options = input.options.map((option) =>
        typeof option === "object" && option !== null ? { value: option.value, title: option.title } : { value: option, title: option });
    }
    return Object.freeze(field) as unknown as StudyInputField;
  });
}

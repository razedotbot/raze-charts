// Translates TradingView `createStudy(name, forceOverlay, lock, inputs,
// overrides, options)` arguments and the `studies_overrides` constructor
// option into a StudyStore spec.
//
// Nothing is dropped silently. createStudy arguments of the wrong shape throw
// a TypeError, and keys that have no effect warn once through `env.warn`.
// `studies_overrides` entries are defaults for every new study, so a bad one
// only warns and is skipped: a styling default must never stop a chart from
// mounting or make later createStudy calls fail.

import type { StudyDefinition, StudyPlotStyleOverride } from "../../types/charting_library";
import { BUILTIN_STUDIES } from "../../studies/registry";
import type { StudySpec } from "../../studies/StudyStore";

type InputValue = number | string | boolean;
type InputType = "number" | "string" | "boolean";

export interface StudyArgsEnv {
  /** The resolved definition; positional inputs map onto its declared inputs. */
  readonly definition: StudyDefinition;
  /** The widget's `studies_overrides`: defaults for new studies. */
  readonly studiesOverrides?: Readonly<Record<string, unknown>>;
  /** Report an ignored key once; `key` deduplicates. */
  readonly warn: (key: string, message: string) => void;
}

export interface ParsedStudyArgs {
  readonly spec: StudySpec;
  /** `options.disableUndo`: keep the creation out of undo history. */
  readonly disableUndo: boolean;
  /**
   * Plot reference of each `spec.plotStyles` entry and the override that set
   * it, so the caller can warn when the created study has no such plot.
   */
  readonly plotKeys: ReadonlyMap<string, string>;
}

/** `length` aliases, consumed as the study length rather than forwarded. */
const LENGTH_IDS = ["length", "Length", "periods"];
const canonical = (id: string): string => (LENGTH_IDS.includes(id) ? "length" : id);
const isInputValue = (value: unknown): value is InputValue =>
  typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const schemaOf = (definition: StudyDefinition): unknown => (definition as { inputs?: unknown }).inputs;

/**
 * Input ids in declaration order: a v2 schema's ids, else `length` (when the
 * definition has a default length) followed by its other non-colour defaults.
 */
export function declaredInputs(definition: StudyDefinition): string[] {
  const schema = schemaOf(definition);
  if (isRecord(schema)) return Object.keys(schema);
  const ids = Object.keys(definition.defaults ?? {}).filter((id) => id !== "color");
  return ids.includes("length") ? ["length", ...ids.filter((id) => id !== "length")] : ids;
}

/** The value type input `id` expects, or null when the definition does not say. */
function inputType(definition: StudyDefinition, id: string): InputType | null {
  if (canonical(id) === "length") return "number";
  const schema = schemaOf(definition);
  if (isRecord(schema)) {
    const type = (schema[id] as { type?: unknown } | undefined)?.type;
    if (type === "bool") return "boolean";
    if (type === "int" || type === "float" || type === "time" || type === "price") return "number";
    return typeof type === "string" ? "string" : null;
  }
  const type = typeof definition.defaults?.[id];
  return type === "number" || type === "string" || type === "boolean" ? type : null;
}

/**
 * The part of a `studies_overrides` key after the study name (up to the first
 * dot, matched case-insensitively against the name and aliases), or null when
 * the key is for another study.
 */
export function overrideFor(definition: StudyDefinition, key: string): string | null {
  const dot = key.indexOf(".");
  const study = key.slice(0, dot).toLowerCase();
  return dot > 0 && [definition.name, ...(definition.aliases ?? [])].some((name) => name.toLowerCase() === study)
    ? key.slice(dot + 1)
    : null;
}

/** `<plot>.<property>` with TradingView's optional `.0` colour index. */
const STYLE_KEY = /^(.+?)\.([a-z_]+)(?:\.(\d+))?$/i;
const STYLE_HELP = 'supported plot properties: "<plot>.color", "<plot>.linewidth", "<plot>.visible"';

type StyleRead =
  | { readonly ref: string; readonly style: StudyPlotStyleOverride }
  | { readonly problem: string; readonly badValue: boolean };

/**
 * Plot reference of `<plot>`: "0" for `plot` or the study's own name, "<n>"
 * for `plot_<n>`, otherwise the lower-case plot name (matched after compute).
 */
function plotRef(definition: StudyDefinition, plot: string): string {
  const lower = plot.toLowerCase();
  const position = /^plot_(\d+)$/.exec(lower);
  if (lower === "plot" || lower === definition.name.toLowerCase()) return "0";
  return position ? String(Number(position[1])) : lower;
}

/** Parse one `<plot>.<property>` style override, or null when `key` has another shape. */
function readStyle(definition: StudyDefinition, key: string, value: unknown): StyleRead | null {
  const match = STYLE_KEY.exec(key);
  if (!match) return null;
  const ref = plotRef(definition, match[1]!);
  const property = match[2]!.toLowerCase();
  if (match[3] !== undefined && !(property === "color" && Number(match[3]) === 0)) {
    return { problem: `has no effect: only a plot's first colour can be set; ${STYLE_HELP}`, badValue: false };
  }
  if (property === "color") {
    return typeof value === "string" && value ? { ref, style: { color: value } } : { problem: "must be a CSS colour string", badValue: true };
  }
  if (property === "linewidth") {
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? { ref, style: { lineWidth: value } }
      : { problem: "must be a positive number", badValue: true };
  }
  if (property === "visible") {
    return typeof value === "boolean" ? { ref, style: { visible: value } } : { problem: "must be a boolean", badValue: true };
  }
  return { problem: `has no effect; ${STYLE_HELP}`, badValue: false };
}

export function parseCreateStudyArgs(
  env: StudyArgsEnv,
  name: string,
  forceOverlay?: boolean,
  lock?: boolean,
  inputs?: unknown,
  overrides?: unknown,
  options?: unknown,
): ParsedStudyArgs {
  const { definition, warn } = env;
  const call = `createStudy("${name}")`;
  const declared = declaredInputs(definition);
  const fail = (message: string, listInputs?: boolean): never => {
    throw new TypeError(`[raze-charts] ${call}: ${message}${listInputs ? `; ${definition.name} inputs: ${declared.join(", ") || "none"}` : ""}`);
  };

  // Positional arrays and TradingView's `in_<n>` ids map onto declared ids.
  const given = new Map<string, unknown>();
  if (Array.isArray(inputs)) {
    if (inputs.length > declared.length) fail(`too many positional inputs (${inputs.length})`, true);
    inputs.forEach((value, index) => given.set(canonical(declared[index]!), value));
  } else if (isRecord(inputs)) {
    // Built-ins and v2 schemas declare every input they read, so an unknown
    // key (a typo such as `lenght`) cannot do anything.
    const closed = BUILTIN_STUDIES.includes(definition) || isRecord(schemaOf(definition));
    const sources = new Map<string, string>();
    for (const [key, value] of Object.entries(inputs)) {
      const position = /^in_(\d+)$/.exec(key);
      const id = canonical(position ? declared[+position[1]!] ?? fail(`no input at ${key}`, true) : key);
      const previous = sources.get(id);
      if (previous !== undefined && given.get(id) !== value) {
        fail(`"${previous}" and "${key}" both set input "${id}" to different values`);
      }
      given.set(id, value);
      sources.set(id, key);
      if (closed && id !== "color" && !declared.includes(id)) {
        warn(
          `${definition.name}:input:${key}`,
          `${call}: input "${key}" has no effect; ${definition.name} inputs: ${declared.join(", ") || "none"}`,
        );
      }
    }
  } else if (inputs != null) {
    fail("inputs must be an object or a positional array");
  }

  // Per-plot styles by plot reference; "0" is the primary plot.
  const styles = new Map<string, StudyPlotStyleOverride>();
  const plotKeys = new Map<string, string>();
  const setStyle = (read: { ref: string; style: StudyPlotStyleOverride }, label: string): void => {
    styles.set(read.ref, { ...styles.get(read.ref), ...read.style });
    plotKeys.set(read.ref, label);
  };

  // studies_overrides supply the styles and inputs the call leaves out. They
  // apply to every new study, so a wrong-typed entry warns and is skipped.
  for (const [key, value] of Object.entries(env.studiesOverrides ?? {})) {
    const rest = overrideFor(definition, key);
    if (rest === null) continue;
    const label = `studies_overrides["${key}"]`;
    const skip = (message: string): void => warn(`studies_overrides:${key}`, `${label} ${message}`);
    const input = declared.find((id) => id.toLowerCase() === rest.toLowerCase());
    if (input) {
      const type = inputType(definition, input);
      if (!isInputValue(value) || (type !== null && typeof value !== type)) {
        skip(`must be a ${type === "number" ? "finite number" : type ?? "finite number, string or boolean"}; ignored`);
      } else if (!given.has(canonical(input))) {
        given.set(canonical(input), value);
      }
      continue;
    }
    const read = readStyle(definition, rest, value);
    if (!read) skip(`has no effect: use "<study>.<input>" or "<study>.<plot>.<property>"; ${STYLE_HELP}`);
    else if ("problem" in read) skip(read.badValue ? `${read.problem}; ignored` : read.problem);
    else setStyle(read, label);
  }

  let length = 0;
  let inputColor = "";
  const extra: Record<string, InputValue> = {};
  for (const [id, value] of given) {
    if (value === undefined) continue;
    if (id === "length") {
      length = typeof value === "number" && Number.isFinite(value) ? value : fail(`"length" must be a finite number`);
    } else if (id === "color") {
      if (typeof value !== "string") fail(`"color" must be a CSS colour string`);
      else inputColor = value;
    } else {
      extra[id] = isInputValue(value) ? value : fail(`input "${id}" must be a finite number, string or boolean`, true);
    }
  }
  // The call's inputs.color beats a studies_overrides primary colour.
  if (inputColor) delete styles.get("0")?.color;

  // Explicit style overrides win over inputs.color and studies_overrides.
  if (overrides != null) {
    if (!isRecord(overrides)) fail("overrides must be an object");
    for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
      const read = readStyle(definition, key, value);
      if (read && !("problem" in read)) setStyle(read, `${call}: override "${key}"`);
      else if (read?.badValue) fail(`override "${key}" ${read.problem}`);
      else warn(`${definition.name}:${key}`, `${call}: override "${key}" ${read?.problem ?? `has no effect; ${STYLE_HELP}`}`);
    }
  }

  let overlay = !!forceOverlay;
  let disableUndo = false;
  if (options != null) {
    if (!isRecord(options)) fail("options must be an object");
    for (const [key, value] of Object.entries(options as Record<string, unknown>)) {
      if (key === "disableUndo") disableUndo = !!value;
      else if (key === "priceScale" && value === "as-series") overlay = true;
      // No study limit exists, and currency/unit conversion off is the only mode.
      else if (key !== "checkLimit" && !((key === "allowChangeCurrency" || key === "allowChangeUnit") && !value)) {
        warn(`option:${key}`, `${call}: option ${key}=${String(value)} is not supported and was ignored`);
      }
    }
  }

  const styled = [...styles].filter(([, style]) => Object.keys(style).length > 0);
  const plotStyles = Object.fromEntries(styled);
  return {
    spec: {
      name,
      length,
      // The primary plot's colour is also the study colour (legend, fallback).
      color: styles.get("0")?.color ?? inputColor,
      lock: !!lock,
      forceOverlay: overlay,
      // Booleans are forwarded as-is; the v1 input map type predates them.
      inputs: extra as Record<string, number | string>,
      ...(styled.length ? { plotStyles } : {}),
    },
    disableUndo,
    plotKeys: new Map(styled.map(([ref]) => [ref, plotKeys.get(ref)!])),
  };
}

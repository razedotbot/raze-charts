// Translates TradingView `createStudy(name, forceOverlay, lock, inputs,
// overrides, options)` arguments and the `studies_overrides` constructor
// option into a StudyStore spec.
//
// Nothing is dropped silently: inputs of the wrong shape throw a TypeError,
// and overrides or options that have no effect warn once through `env.warn`.

import type { StudyDefinition } from "../../types/charting_library";
import type { StudySpec } from "../../studies/StudyStore";

type InputValue = number | string | boolean;

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
  /** The override key that set `spec.color`, so the caller can check it painted. */
  readonly colorKey: string | null;
}

/** `length` aliases, consumed as the study length rather than forwarded. */
const LENGTH_IDS = ["length", "Length", "periods"];
const canonical = (id: string): string => (LENGTH_IDS.includes(id) ? "length" : id);
const isInputValue = (value: unknown): value is InputValue =>
  typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Input ids in declaration order: a v2 schema's ids, else `length` (when the
 * definition has a default length) followed by its other non-colour defaults.
 */
export function declaredInputs(definition: StudyDefinition): string[] {
  const schema = (definition as { inputs?: unknown }).inputs;
  if (isRecord(schema)) return Object.keys(schema);
  const ids = Object.keys(definition.defaults ?? {}).filter((id) => id !== "color");
  return ids.includes("length") ? ["length", ...ids.filter((id) => id !== "length")] : ids;
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

/** Whether `<plot>.<property>[.<index>]` targets the primary plot's colour, the only style honoured. */
const isPrimaryColor = (definition: StudyDefinition, key: string): boolean =>
  new RegExp(`^(plot|plot_0|${definition.name.replace(/\W/g, "\\$&")})\\.color(\\.0)?$`, "i").test(key);

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
    for (const [key, value] of Object.entries(inputs)) {
      const position = /^in_(\d+)$/.exec(key);
      const id = position ? declared[+position[1]!] ?? fail(`no input at ${key}`, true) : key;
      given.set(canonical(id), value);
    }
  } else if (inputs != null) {
    fail("inputs must be an object or a positional array");
  }

  // studies_overrides supply the colour and inputs the call leaves out.
  let color = "";
  let colorKey: string | null = null;
  for (const [key, value] of Object.entries(env.studiesOverrides ?? {})) {
    const rest = overrideFor(definition, key);
    if (rest === null) continue;
    const input = declared.find((id) => id.toLowerCase() === rest.toLowerCase());
    if (isPrimaryColor(definition, rest) && typeof value === "string") {
      color = value;
      colorKey = key;
    } else if (input && isInputValue(value)) {
      if (!given.has(canonical(input))) given.set(canonical(input), value);
    } else {
      warn(`studies_overrides:${key}`, `studies_overrides["${key}"] has no effect: use "<study>.plot.color" or "<study>.<input>"`);
    }
  }

  let length = 0;
  const extra: Record<string, InputValue> = {};
  for (const [id, value] of given) {
    if (value === undefined) continue;
    if (id === "length") {
      length = typeof value === "number" && Number.isFinite(value) ? value : fail(`"length" must be a finite number`);
    } else if (id === "color") {
      if (typeof value !== "string") fail(`"color" must be a CSS colour string`);
      else if (value) [color, colorKey] = [value, null];
    } else {
      extra[id] = isInputValue(value) ? value : fail(`input "${id}" must be a finite number, string or boolean`, true);
    }
  }

  // Explicit style overrides win over inputs.color and studies_overrides.
  if (overrides != null) {
    if (!isRecord(overrides)) fail("overrides must be an object");
    for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
      if (!isPrimaryColor(definition, key)) {
        warn(`${definition.name}:${key}`, `${call}: override "${key}" has no effect; only "plot.color" is supported`);
      } else if (typeof value === "string" && value) {
        [color, colorKey] = [value, key];
      } else {
        fail(`override "${key}" must be a CSS colour string`);
      }
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

  return {
    spec: {
      name,
      length,
      color,
      lock: !!lock,
      forceOverlay: overlay,
      // Booleans are forwarded as-is; the v1 input map type predates them.
      inputs: extra as Record<string, number | string>,
    },
    disableUndo,
    colorKey,
  };
}

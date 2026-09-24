// Study labels shared by the legend, the objects tree and the indicators menu.
//
// A label is the definition's short title followed by the inputs that change
// what the study plots, TradingView-style: "EMA 9", "BB 20 2",
// "MACD 12 26 9", "VWAP". It is built from the definition, never from the
// store's length fallback, so a study without a length input shows no number.
//
// Precedence for one definition:
//   1. `formatLabel(inputs)` when the definition provides it;
//   2. the v2 input schema (`inputs`), honouring each input's `inLabel`;
//   3. a built-in's declared inputs (registry.ts), read through the same
//      resolution compute() uses, so aliases, `in_N` ids and the `length`
//      shorthand (MACD's slow length) label exactly what is plotted;
//   4. the v1 shorthand: every numeric `defaults` entry, in declaration order,
//      but only when `compute` reads its inputs argument at all.

import type { StudyDefinition, StudyInputs } from "../types/charting_library";
import { builtinInputSchema, resolveBuiltinInputs } from "./registry";

/** One input descriptor as the label builder reads it (v2 map value or array item). */
export interface StudyLabelInput {
  readonly id?: string;
  readonly type?: string;
  readonly default?: unknown;
  readonly inLabel?: boolean;
  readonly options?: readonly unknown[];
}

/**
 * The part of a study definition (v1 `StudyDefinition` or v2
 * `IndicatorDefinition`) that labels depend on.
 */
export interface StudyLabelDefinition {
  readonly name: string;
  readonly shortTitle?: string;
  readonly defaults?: { readonly [key: string]: unknown };
  readonly inputs?: { readonly [id: string]: StudyLabelInput } | readonly StudyLabelInput[];
  // Bivariant method so both v1 (StudyInputs) and v2 (typed values) definitions fit.
  formatLabel?(inputs: never): string;
  readonly compute?: (...args: never[]) => unknown;
}

/** A live study instance as the label builder reads it (StudyStore's StudyInstance fits). */
export interface StudyLabelInstance {
  readonly def: StudyLabelDefinition;
  readonly length?: number;
  readonly inputs?: { readonly [key: string]: unknown };
}

const warned = new WeakSet<object>();

/** Compact, locale-independent input token: 20, 2, 0.5, 1.25. */
export function formatLabelToken(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)));
  }
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "boolean") return value ? "on" : "off";
  return null;
}

/** The title a label starts with: `shortTitle`, else the canonical name. */
export function studyShortTitle(def: StudyLabelDefinition): string {
  const short = typeof def.shortTitle === "string" ? def.shortTitle.trim() : "";
  return short || def.name;
}

function schemaEntries(inputs: NonNullable<StudyLabelDefinition["inputs"]>): [string, StudyLabelInput][] {
  if (Array.isArray(inputs)) {
    return (inputs as readonly StudyLabelInput[])
      .filter((input) => input && typeof input.id === "string")
      .map((input) => [input.id!, input]);
  }
  return Object.entries(inputs as { readonly [id: string]: StudyLabelInput });
}

function optionTitle(input: StudyLabelInput, value: unknown): unknown {
  for (const option of input.options ?? []) {
    if (option && typeof option === "object" && (option as { value?: unknown }).value === value) {
      return (option as { title?: unknown }).title ?? value;
    }
  }
  return value;
}

/** Whether an input appears in the label when `inLabel` is not set. */
function inLabelByDefault(input: StudyLabelInput, value: unknown): boolean {
  switch (input.type) {
    case "int":
    case "float":
    case "price":
      return true;
    // A source is noise while it is the default ("EMA 9"); a changed one matters ("EMA 9 hl2").
    case "source":
      return value !== input.default;
    default:
      return false;
  }
}

function schemaTokens(
  inputs: NonNullable<StudyLabelDefinition["inputs"]>,
  values: { readonly [key: string]: unknown },
): string[] {
  const tokens: string[] = [];
  for (const [id, input] of schemaEntries(inputs)) {
    const value = values[id] ?? input.default;
    const shown = input.inLabel ?? inLabelByDefault(input, value);
    if (!shown) continue;
    const token = formatLabelToken(input.type === "select" ? optionTitle(input, value) : value);
    if (token) tokens.push(token);
  }
  return tokens;
}

function v1Tokens(def: StudyLabelDefinition, values: { readonly [key: string]: unknown }): string[] {
  // `compute(bars)` cannot read any input, so none of them describe the plot
  // (the example HL2 study declares length 1 but ignores it).
  if (typeof def.compute === "function" && def.compute.length < 2) return [];
  const tokens: string[] = [];
  for (const [key, fallback] of Object.entries(def.defaults ?? {})) {
    if (key === "color" || typeof fallback !== "number") continue;
    const value = values[key];
    const token = formatLabelToken(typeof value === "number" || typeof value === "string" ? value : fallback);
    if (token) tokens.push(token);
  }
  return tokens;
}

/**
 * Input tokens shown after the short title. `values` are the instance's input
 * values; anything missing falls back to the definition's defaults.
 */
export function studyLabelTokens(
  def: StudyLabelDefinition,
  values: { readonly [key: string]: unknown } = {},
): string[] {
  if (def.inputs && typeof def.inputs === "object") return schemaTokens(def.inputs, values);
  const builtin = def as unknown as StudyDefinition;
  const schema = builtinInputSchema(builtin);
  if (schema) {
    const effective = resolveBuiltinInputs(builtin, values as unknown as StudyInputs) ?? values;
    return schemaTokens(schema as unknown as NonNullable<StudyLabelDefinition["inputs"]>, effective);
  }
  return v1Tokens(def, values);
}

/**
 * Label for a definition with the given input values ("EMA 9", "BB 20 2",
 * "MACD 12 26 9", "VWAP"). `showInputs: false` returns the short title only.
 */
export function formatStudyLabel(
  def: StudyLabelDefinition,
  values: { readonly [key: string]: unknown } = {},
  options: { readonly showInputs?: boolean } = {},
): string {
  const title = studyShortTitle(def);
  if (options.showInputs === false) return title;
  if (typeof def.formatLabel === "function") {
    try {
      const custom = (def.formatLabel as (inputs: unknown) => unknown)({ ...definitionDefaults(def), ...values });
      if (typeof custom === "string" && custom.trim()) return custom.trim();
      throw new TypeError(`formatLabel returned ${JSON.stringify(custom)}, expected a non-empty string`);
    } catch (error) {
      if (!warned.has(def)) {
        warned.add(def);
        console.warn(`[raze-charts] study "${def.name}" formatLabel failed; using the default label.`, error);
      }
    }
  }
  return [title, ...studyLabelTokens(def, values)].join(" ");
}

function definitionDefaults(def: StudyLabelDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(def.defaults ?? {})) {
    if (key !== "color" && value !== undefined) out[key] = value;
  }
  if (def.inputs && typeof def.inputs === "object") {
    for (const [id, input] of schemaEntries(def.inputs)) out[id] = input.default;
  }
  return out;
}

/**
 * Input values of a live instance: its stored inputs plus its length, but the
 * length only when the definition declares one (the store falls back to 14
 * for every study, which must not leak into "VWAP").
 */
export function studyInstanceValues(study: StudyLabelInstance): Record<string, unknown> {
  const values: Record<string, unknown> = { ...(study.inputs ?? {}) };
  const declaresLength = typeof study.def.defaults?.length === "number"
    || (!!study.def.inputs && schemaEntries(study.def.inputs).some(([id]) => id === "length"));
  if (declaresLength && typeof study.length === "number" && values.length === undefined) {
    values.length = study.length;
  }
  return values;
}

/** Label for a live study instance (legend rows, objects tree, removal announcements). */
export function studyInstanceLabel(
  study: StudyLabelInstance,
  options?: { readonly showInputs?: boolean },
): string {
  return formatStudyLabel(study.def, studyInstanceValues(study), options);
}

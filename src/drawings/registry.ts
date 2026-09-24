// Drawing-tool registry (AD-03). Every drawing kind, built-in or host-defined,
// is a DrawingToolDefinition registered here; paint, hit-testing, anchor
// counts, defaults and the tool catalogue (sidebar, objects tree, settings)
// all read from this one table instead of per-kind if/else chains.
//
// The registry is page-wide, like custom elements: a tool registered once is
// available to every widget on the page. Built-ins register lazily on first
// access so importing this module has no side effects (sideEffects: false).

import type { DrawingPropField, DrawingToolDefinition } from "./types";
import { BUILTIN_DRAWING_TOOLS } from "./tools/index";

/**
 * A registered tool with its props type erased. Every definition is generic
 * over its own props, so the catalogue stores them behind this common shape;
 * the runtime always hands a tool the props object built from its own schema.
 */
export interface RegisteredDrawingTool extends Omit<DrawingToolDefinition<Record<string, unknown>>, "props"> {
  readonly props: Readonly<Record<string, DrawingPropField>>;
}

/** Tool ids are stored in saved layouts, so they are restricted to a stable, portable shape. */
const ID = /^[a-z][a-z0-9_]*$/;

/**
 * Icon markup is inserted as trusted SVG by the sidebar, so it is checked
 * against an allowlist, not a denylist: static shape and paint elements only,
 * presentation attributes separated by HTML whitespace, and values with no
 * markup, entities or CSS escapes. url() may only name the icon's own
 * fragments (`url(#gradient)`). Anything this tokenizer does not recognise
 * rejects the icon: a comment, CDATA, a "/" or a quote between attributes, an
 * unknown element or attribute. So the HTML parser never sees an element or
 * attribute (an event handler, a link) that this check did not.
 */
const ICON_ELEMENTS = /^(svg|g|path|circle|ellipse|rect|line|polyline|polygon|defs|lineargradient|radialgradient|stop|clippath|mask)$/i;
// Geometry and presentation attributes. The prefix families (fill-*, stroke-*,
// stop-*, clip-*, *units) hold only paint and layout properties.
const ICON_ATTRIBUTES = /^(xmlns(:xlink)?|version|viewbox|preserveaspectratio|width|height|[xy][12]?|[cfr][xy]|r|d|points|pathlength|transform|id|class|role|aria-hidden|focusable|opacity|color|mask|offset|(fill|stroke|stop|clip)(-[a-z]+)?|vector-effect|shape-rendering|gradienttransform|spreadmethod|[a-z]*units)$/i;
// Tag and attribute grammar with HTML's own whitespace ([\t\n\f\r ]), so a
// character the HTML tokenizer does not treat as a separator never splits a
// token here either.
const ICON_TAG = /<\/?([a-z][a-z0-9]*)((?:[\t\n\f\r ]+[a-z][a-z0-9:-]*(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"[^"]*"|'[^']*'|[^\t\n\f\r "'=<>`]+))?)*)[\t\n\f\r ]*\/?>/gi;
const ICON_ATTRIBUTE = /([a-z][a-z0-9:-]*)(?:[\t\n\f\r ]*=[\t\n\f\r ]*("[^"]*"|'[^']*'|[^\t\n\f\r "'=<>`]+))?/gi;

/** Why icon markup is unsafe or malformed, or "" when it is a static inline SVG. */
export function drawingIconProblem(icon: unknown): string {
  if (typeof icon !== "string" || !/^\s*<svg[\t\n\f\r >][\s\S]*<\/svg>\s*$/i.test(icon)) return "must be one inline <svg>…</svg>";
  let problem = "";
  const text = icon.replace(ICON_TAG, (_tag, element: string, attributes: string) => {
    if (!ICON_ELEMENTS.test(element)) problem ||= `<${element}> is not allowed`;
    for (const [, name, value = ""] of attributes.matchAll(ICON_ATTRIBUTE)) {
      // The value keeps its quotes, which never contain the characters checked here.
      if (!ICON_ATTRIBUTES.test(name!)) problem ||= `attribute "${name}" is not allowed`;
      else if (/[<>&\\]|url\s*\((?!\s*['"]?#)/i.test(value)) problem ||= `"${name}" has <, >, &, \\ or an external url()`;
    }
    return "";
  });
  return problem || (text.includes("<") ? "has a comment, CDATA or a malformed tag (separate attributes with spaces)" : "");
}

const tools = new Map<string, RegisteredDrawingTool>();
const aliases = new Map<string, string>();
const listeners = new Set<() => void>();
let builtins: Set<string> | undefined;

function catalogue(): Map<string, RegisteredDrawingTool> {
  if (!builtins) {
    // Built-ins are trusted (and validated by tests/drawing-tools.mjs), so the
    // validator stays out of bundles that never call defineDrawingTool().
    builtins = new Set();
    for (const tool of BUILTIN_DRAWING_TOOLS) {
      add(tool);
      builtins.add(tool.id);
    }
  }
  return tools;
}

function add(def: RegisteredDrawingTool): void {
  tools.set(def.id, Object.freeze({ ...def }));
  for (const alias of def.aliases ?? []) aliases.set(alias, def.id);
}

/** Why a field is invalid, or "" when it is fine. */
function fieldProblem(field: DrawingPropField): string {
  if (!field || typeof field.title !== "string") return "needs a type and a title";
  const value: unknown = field.default;
  switch (field.type) {
    case "color":
    case "text":
      return typeof value === "string" ? "" : "default must be a string";
    case "select":
      return field.options?.some((option) => option.value === value) ? "" : "default must be one of its options";
    case "number":
    case "lineWidth":
      return Number.isFinite(value) ? "" : "default must be a finite number";
    case "lineStyle":
      return [0, 1, 2, 3, 4].includes(value as number) ? "" : "default must be a line style 0-4";
    case "boolean":
      return typeof value === "boolean" ? "" : "default must be a boolean";
    case "levels":
      return Array.isArray(value) && value.every((level) => Number.isFinite(level?.value))
        ? ""
        : "default must be an array of { value } levels";
    default:
      return "type must be color, number, lineWidth, lineStyle, boolean, text, select or levels";
  }
}

/**
 * Why a definition cannot be registered (invalid, or its id or an alias is
 * taken by another tool), or "" when it can. `replacing` names the registered
 * tool the definition is about to replace, whose own id and aliases are free.
 */
export function drawingToolProblem(def: RegisteredDrawingTool, replacing?: string): string {
  if (!def || typeof def !== "object") return "expects a tool definition object";
  const spec = def.anchors;
  // typeof first: ID.test() would coerce a missing id to the string "undefined", which matches.
  if (typeof def.id !== "string" || !ID.test(def.id)) return `id must match ${ID} (it is stored in saved layouts)`;
  if (def.aliases !== undefined && !Array.isArray(def.aliases)) return "aliases must be an array of tool ids";
  if (typeof def.title !== "string" || !def.title) return "title must be a non-empty string";
  const iconIssue = drawingIconProblem(def.icon);
  if (iconIssue) return `icon ${iconIssue} (icons are static SVG: no scripts, handlers, links or styles)`;
  if (typeof spec === "number"
    ? !(Number.isInteger(spec) && spec >= 1)
    : !(Number.isInteger(spec?.min) && spec.min >= 1
      && (spec.max === undefined || spec.max >= spec.min)
      && ["double-click", "enter", "either"].includes(spec.finish))) {
    return "anchors must be a positive integer or { min, max?, finish: 'double-click' | 'enter' | 'either' }";
  }
  if (typeof def.paint !== "function" || typeof def.hitTest !== "function") return "paint() and hitTest() are required";
  if (!def.props || typeof def.props !== "object") return "props must be a property schema ({} for none)";
  for (const [key, field] of Object.entries(def.props)) {
    const issue = fieldProblem(field);
    if (issue) return `props.${key}: ${issue}`;
  }
  for (const name of [def.id, ...(def.aliases ?? [])]) {
    if (typeof name !== "string" || !ID.test(name)) return `alias "${String(name)}" must match ${ID}`;
    const owner = tools.get(name)?.id ?? aliases.get(name);
    if (owner && owner !== replacing) {
      return `"${name}" is already used by "${owner}"; tool ids are page-wide, so prefix yours (for example "acme_arrow")`
        + (owner === def.id ? ", or pass { replace: true } to swap in a new version" : "");
    }
  }
  return "";
}

/** Optional contract hooks the runtime does not call yet, with what that means for a host. */
const UNWIRED_HOOKS = [
  ["validateProps", "props reach paint() unvalidated"],
  ["describe", "the objects tree shows the tool id"],
] as const;

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** Options for defineDrawingTool(). */
export interface DefineDrawingToolOptions {
  /**
   * Replace a host tool already registered under the same id instead of
   * throwing. Meant for development reloads (HMR), where re-running a module
   * creates a new definition with new functions. Drawings of that kind keep
   * their data and paint with the new definition from the next frame.
   * Built-in tools cannot be replaced.
   */
  readonly replace?: boolean;
}

/**
 * Register a drawing tool and return its frozen definition. The tool then
 * paints, hit-tests, drafts with its anchor count, undoes and round-trips
 * through save()/load() exactly like the built-ins, which use this same path.
 *
 * Throws a TypeError naming the problem for an invalid definition or an id
 * (or alias) that is already registered. Registering an identical definition
 * again (the same object, or one with the same field values) is a no-op.
 * Re-running a module under HMR builds a new definition whose functions
 * differ, so that throws unless `{ replace: true }` is passed.
 */
export function defineDrawingTool<TProps extends object>(
  definition: DrawingToolDefinition<TProps>,
  options?: DefineDrawingToolOptions,
): DrawingToolDefinition<TProps> {
  const erased = definition as unknown as RegisteredDrawingTool;
  const id = erased?.id;
  const current = catalogue().get(id);
  const keys = current ? Object.keys(erased) : [];
  if (!current || keys.length !== Object.keys(current).length || keys.some((key) => current[key as "id"] !== erased[key as "id"])) {
    const replacing = current && options?.replace ? id : undefined;
    const issue = replacing && builtins!.has(id)
      ? "built-in tools cannot be replaced"
      : drawingToolProblem(erased, replacing);
    if (issue) throw new TypeError(`[raze-charts] defineDrawingTool("${id}"): ${issue}.`);
    for (const alias of current?.aliases ?? []) aliases.delete(alias);
    add(erased);
    notify();
    // Declared by the contract, but nothing calls them in this release: say so instead of silently ignoring them.
    for (const [hook, effect] of UNWIRED_HOOKS) {
      if (typeof erased[hook] === "function") {
        console.warn(`[raze-charts] defineDrawingTool("${id}"): ${hook}() is not called yet (${effect}); see docs/drawings.md.`);
      }
    }
  }
  return tools.get(id) as unknown as DrawingToolDefinition<TProps>;
}

/** Look a tool up by id or alias (for example TradingView's `extended`). */
export function getDrawingTool(idOrAlias: string): RegisteredDrawingTool | undefined {
  const all = catalogue();
  return all.get(idOrAlias) ?? all.get(aliases.get(idOrAlias) as string);
}

/** Every registered tool in registration order (built-ins first). */
export function listDrawingTools(): RegisteredDrawingTool[] {
  return [...catalogue().values()];
}

/**
 * Unregister a host tool; returns false when it was not registered. Built-in
 * tools cannot be removed. Drawings of a removed kind stay in the store and in
 * saved layouts but stop painting, with a one-time console warning.
 */
export function removeDrawingTool(id: string): boolean {
  const tool = catalogue().get(id);
  if (builtins!.has(id)) throw new TypeError(`[raze-charts] removeDrawingTool("${id}"): built-in tools cannot be removed.`);
  if (!tool) return false;
  tools.delete(id);
  for (const alias of tool.aliases ?? []) aliases.delete(alias);
  notify();
  return true;
}

/** Subscribe to registrations and removals (for example to rebuild a tool picker). */
export function onDrawingToolsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * A tool's schema defaults as a fresh props object (level arrays are copied).
 * Empty colour defaults mean "follow the theme".
 */
export function drawingToolDefaults(idOrAlias: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(getDrawingTool(idOrAlias)?.props ?? {})) {
    const value = field.default;
    out[key] = Array.isArray(value) ? value.map((level) => ({ ...level })) : value;
  }
  return out;
}

/**
 * Anchors a draft needs before it is committed: the fixed count, or the
 * maximum of a free-form tool (Infinity when double-click or Enter finishes
 * it instead). Unknown tools need 0, so a stale tool id never traps the
 * pointer in drawing mode.
 */
export function anchorsToCommit(idOrAlias: string): number {
  const spec = getDrawingTool(idOrAlias)?.anchors;
  return spec === undefined ? 0 : typeof spec === "number" ? spec : spec.max ?? Infinity;
}

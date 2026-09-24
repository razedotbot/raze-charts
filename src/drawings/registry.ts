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
 * Icon markup is inserted as trusted SVG by the sidebar, so anything that can
 * run script or load a resource is rejected: script-capable elements, event
 * handlers, links and CSS url()s.
 */
const UNSAFE_ICON = /<\s*(script|foreignobject|iframe|object|embed|image|use|style|a)\b|\son\w+\s*=|(href|src)\s*=|javascript:|url\s*\(/i;

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
 * taken), or "" when it can.
 */
export function drawingToolProblem(def: RegisteredDrawingTool): string {
  if (!def || typeof def !== "object") return "expects a tool definition object";
  const spec = def.anchors;
  if (!ID.test(def.id)) return `id must match ${ID} (it is stored in saved layouts)`;
  if (typeof def.title !== "string" || !def.title) return "title must be a non-empty string";
  if (typeof def.icon !== "string" || !/^\s*<svg[\s>][\s\S]*<\/svg>\s*$/i.test(def.icon) || UNSAFE_ICON.test(def.icon)) {
    return "icon must be one static inline <svg> (no scripts, handlers, links or url())";
  }
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
    if (!ID.test(name)) return `alias "${name}" must match ${ID}`;
    const owner = tools.get(name)?.id ?? aliases.get(name);
    if (owner) return `"${name}" is already used by "${owner}"; tool ids are page-wide, so prefix yours (for example "acme_arrow")`;
  }
  return "";
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * Register a drawing tool and return its frozen definition. The tool then
 * paints, hit-tests, drafts with its anchor count, undoes and round-trips
 * through save()/load() exactly like the built-ins, which use this same path.
 *
 * Throws a TypeError naming the problem for an invalid definition or an id
 * (or alias) that is already registered. Registering the same definition
 * object again is a no-op, so module re-evaluation under HMR is safe.
 */
export function defineDrawingTool<TProps extends object>(
  definition: DrawingToolDefinition<TProps>,
): DrawingToolDefinition<TProps> {
  const erased = definition as unknown as RegisteredDrawingTool;
  const current = catalogue().get(erased?.id);
  if (!current || Object.keys(erased).some((key) => current[key as "id"] !== erased[key as "id"])) {
    const issue = drawingToolProblem(erased);
    if (issue) throw new TypeError(`[raze-charts] defineDrawingTool("${erased?.id}"): ${issue}.`);
    add(erased);
    notify();
  }
  return tools.get(erased.id) as unknown as DrawingToolDefinition<TProps>;
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

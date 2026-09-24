// Widget option policy: the featureset table (canonical TradingView names and
// deprecated aliases), root sizing (autosize / width / height / fullscreen),
// multi-chart layout sync switches and the one-time warnings for options
// that would otherwise be ignored silently.

import type { ChartingLibraryWidgetOptions, LayoutSyncOptions } from "../../types/charting_library";
import { buildFeatureSet } from "../context";
import { describeTimeframeProblem } from "../timeframe";

const warn = (message: string): void => console.warn(`[raze-charts] ${message}`);

// ── Featuresets ─────────────────────────────────────────────────────────────

/** Deprecated featureset spelling -> canonical TradingView name. */
const DEPRECATED_FEATURESETS: Readonly<Record<string, string>> = { time_frames_toolbar: "timeframes_toolbar" };

/**
 * The widget's enabled featuresets. Deprecated spellings are folded into
 * their canonical names (and warned about in `debug` mode), so only
 * canonical names are ever queried.
 */
export function buildWidgetFeatureSet(options: ChartingLibraryWidgetOptions): Set<string> {
  const features = buildFeatureSet(options, { defaultsOn: ["timeframes_toolbar"], aliases: DEPRECATED_FEATURESETS });
  const used = [...(options.enabled_features ?? []), ...(options.disabled_features ?? [])];
  for (const [alias, canonical] of Object.entries(DEPRECATED_FEATURESETS)) {
    features.delete(alias);
    if (options.debug && used.includes(alias)) warn(`featureset "${alias}" is deprecated; use "${canonical}".`);
  }
  return features;
}

// ── Root size ───────────────────────────────────────────────────────────────

/** A root dimension: exact CSS pixels, or `fill` to track the container. */
type Dimension = number | "fill";

/** How the widget root is sized: the viewport, or a box per dimension. */
export type RootSize = "fullscreen" | { readonly width: Dimension; readonly height: Dimension };

function dimension(options: ChartingLibraryWidgetOptions, key: "width" | "height"): number | null {
  const value: unknown = options[key];
  if (value == null) return null;
  if (typeof value === "number" && value > 0 && value < Infinity) return value;
  warn(`${key} must be a positive number of CSS pixels (got ${String(value)}); it is ignored.`);
  return null;
}

/**
 * Resolve `fullscreen`, `autosize`, `width` and `height` into one rule.
 * `autosize: true` fills the container; `autosize: false` uses TradingView's
 * 800 x 500 for a missing dimension; unset uses the given dimensions and
 * fills the rest. A layout child always fills its grid cell.
 */
export function resolveRootSize(options: ChartingLibraryWidgetOptions): RootSize {
  if (options.raze?.layout_child) return { width: "fill", height: "fill" };
  const width = dimension(options, "width");
  const height = dimension(options, "height");
  if (options.fullscreen === true) return "fullscreen";
  if (options.autosize === true) {
    if (options.debug && (width ?? height) !== null) warn("width and height are ignored because autosize is true.");
    return { width: "fill", height: "fill" };
  }
  const fixed = options.autosize === false;
  return { width: width ?? (fixed ? 800 : "fill"), height: height ?? (fixed ? 500 : "fill") };
}

/** Apply a size rule to the root element's inline style. */
export function applyRootSize(root: HTMLElement, size: RootSize): void {
  const style = root.style;
  if (size === "fullscreen") {
    style.position = "fixed";
    style.top = style.right = style.bottom = style.left = "0";
    root.dataset.size = "fullscreen";
    return;
  }
  const px = (value: Dimension): string => (value === "fill" ? "100%" : `${value}px`);
  style.width = px(size.width);
  style.height = px(size.height);
  const auto = size.width === "fill" && size.height === "fill";
  // A flex or grid container must not squeeze an explicit pixel size.
  if (!auto) style.flex = "0 0 auto";
  root.dataset.size = auto ? "auto" : "fixed";
}

// ── Layout sync ─────────────────────────────────────────────────────────────

export type ResolvedLayoutSync = Readonly<Required<LayoutSyncOptions>>;

/** `raze.layout_sync` over its defaults (all on); unknown keys and non-boolean values warn. */
export function resolveLayoutSync(option: unknown): ResolvedLayoutSync {
  const result: Required<LayoutSyncOptions> = { interval: true, time: true, crosshair: true };
  if (option == null) return result;
  const supported = Object.keys(result);
  for (const [key, value] of Object.entries(option)) {
    if (!supported.includes(key)) warn(`raze.layout_sync.${key} is not supported. Supported keys: ${supported.join(", ")}.`);
    else if (typeof value === "boolean") result[key as keyof LayoutSyncOptions] = value;
    else if (value !== undefined) warn(`raze.layout_sync.${key} must be a boolean; it is ignored.`);
  }
  return result;
}

/** Warn about options that cannot be applied. Layout children skip it (the parent already warned). */
export function reportOptionProblems(options: ChartingLibraryWidgetOptions): void {
  if (options.raze?.layout_child) return;
  const timeframe = describeTimeframeProblem(options.timeframe);
  if (timeframe) warn(timeframe);
}

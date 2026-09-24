// Shared mutable state threaded through the widget's subsystems (engine, data
// manager, toolbar, shapes). One ChartContext exists per widget instance.
//
// The seams below (reason-tagged setters, change delegates, clock, overlay
// hooks, id allocator) were declared up front (W1A-06, AD-05) so wave-1B
// packages can route writers through them in parallel. docs/seams.md lists the
// producer and consumers of every field.

import type {
  ChartingLibraryWidgetOptions,
  ChartStyleName,
  IBasicDataFeed,
  LibrarySymbolInfo,
  ResolutionString,
  SidebarToolId,
  TradingLineSnapshot,
} from "../types/charting_library";
import { Delegate } from "../util/delegate";
import type { Bar, Mark, TimescaleMark, VolumeMode } from "../types/charting_library";
import { createPriceFormatter, type PriceFormatFn } from "../util/format";
import { IdAllocator } from "./ids";

export interface ThemeColors {
  paneBackground: string;
  vertGrid: string;
  horzGrid: string;
  crosshair: string;
  scaleText: string;
  scaleBackground: string;
  scaleLine: string;
  candleUp: string;
  candleDown: string;
  borderUp: string;
  borderDown: string;
  wickUp: string;
  wickDown: string;
  volUp: string;
  volDown: string;
  /** Line/area series colour; falls back to candleUp when unset. */
  lineColor?: string;
  /** Seam (W1B-11 fills in theme.ts): default colour for new drawings from both UI and API. */
  drawingDefault?: string;
  /** Seam (W1B-11): drawing handle fill; painters fall back to paneBackground. */
  handleFill?: string;
  /** Seam (W1B-11): drawing handle border; painters fall back to the drawing colour. */
  handleStroke?: string;
  /** Seam (W1B-11): backdrop behind drawing labels (measure, text); must keep 4.5:1 with labelText. */
  labelBackground?: string;
  /** Seam (W1B-11): drawing label text colour; painters fall back to scaleText. */
  labelText?: string;
  showPriceScaleCrosshairLabel: boolean;
  showTimeScaleCrosshairLabel: boolean;
}

/** Logical visible range expressed in bar-index space (fractional allowed). */
export interface IndexRange {
  /** Leftmost visible bar index (fractional, can be negative for empty space). */
  from: number;
  /** Rightmost visible bar index (fractional, can exceed bars.length). */
  to: number;
}

/** Active drawing tool (left sidebar). `cursor` = pan / select. */
export type DrawingTool = SidebarToolId;

/** Main series render style. */
export type ChartStyle = ChartStyleName;

// ── Seam vocabularies ───────────────────────────────────────────────────────

/**
 * Why the visible range changed. Two reasons stay local to the pane and do not
 * fire the public time-space `viewportChanged` by default (see
 * LOCAL_VIEWPORT_REASONS): `rebase` re-anchors indices after bars were
 * prepended or replaced while the visible *time* window stays the same, and
 * `resize` keeps a pane's bar spacing when its width changes.
 */
export const VIEWPORT_CHANGE_REASONS = Object.freeze([
  "initial",
  "pan",
  "zoom",
  "pinch",
  "keyboard",
  "fit",
  "reset",
  "preset",
  "timeframe",
  "api",
  "load",
  "sync",
  "realtime",
  "rebase",
  "resize",
  "cancel",
] as const);
export type ViewportChangeReason = (typeof VIEWPORT_CHANGE_REASONS)[number];

/**
 * Reasons whose range changes stay local to one pane: `setViewport` does not
 * fire `viewportChanged` for them unless `notify: true` is passed, while
 * `rangeChanged` still fires with the reason. A `resize` adjustment must not
 * reach layout sync: every pane rescales by its own width ratio, and relaying
 * one pane's rescaled range to a sibling that is about to rescale too would
 * apply the ratio twice.
 */
export const LOCAL_VIEWPORT_REASONS: ReadonlySet<ViewportChangeReason> = new Set<ViewportChangeReason>(["rebase", "resize"]);

/** Why price-scale state (mode, autoscale, manual range) changed. */
export const SCALE_CHANGE_REASONS = Object.freeze([
  "initial",
  "scale-bar",
  "axis-drag",
  "axis-reset",
  "keyboard",
  "fit",
  "preset",
  "chart-type",
  "compare",
  "load",
  "api",
  "cancel",
  "context-menu",
  "reset",
] as const);
export type ScaleChangeReason = (typeof SCALE_CHANGE_REASONS)[number];

/** Why the main series style changed. */
export const CHART_TYPE_CHANGE_REASONS = Object.freeze([
  "initial",
  "sidebar",
  "header",
  "api",
  "load",
  "override",
  "context-menu",
] as const);
export type ChartTypeChangeReason = (typeof CHART_TYPE_CHANGE_REASONS)[number];

/**
 * Configured display timezone: an IANA zone id, `exchange` (the symbol's
 * session zone), or null to follow the symbol like an unset option.
 */
export type TimezoneSetting = string | null;

/** Price-scale mode. `log` and `percent` are mutually exclusive by construction. */
export type PriceScaleMode = "normal" | "log" | "percent";
export const PRICE_SCALE_MODES: readonly PriceScaleMode[] = Object.freeze(["normal", "log", "percent"]);

/** Manual price window (price units, before percent/log display mapping). */
export interface PriceRange {
  min: number;
  max: number;
}

/** Snapshot of the price-scale state derived from the context's legacy flags. */
export interface ScaleState {
  readonly mode: PriceScaleMode;
  readonly autoScale: boolean;
  readonly priceRange: Readonly<PriceRange> | null;
}

/** Partial update for setScaleMode(). Unknown keys throw so typos are never ignored. */
export interface ScaleModePatch {
  mode?: PriceScaleMode;
  /** true re-fits every frame and clears `priceRange`. */
  autoScale?: boolean;
  /** A manual window implies `autoScale: false` unless autoScale is given explicitly. */
  priceRange?: PriceRange | null;
}

export interface ViewportChange {
  readonly range: Readonly<IndexRange>;
  readonly previous: Readonly<IndexRange>;
  readonly reason: ViewportChangeReason;
}

export interface ScaleChange {
  readonly state: ScaleState;
  readonly previous: ScaleState;
  readonly reason: ScaleChangeReason;
}

export interface ChartTypeChange {
  readonly style: ChartStyle;
  readonly previous: ChartStyle;
  readonly reason: ChartTypeChangeReason;
}

export interface SetViewportOptions {
  /**
   * Fire the public time-space `viewportChanged` delegate (visible-range API
   * events, layout sync). Defaults to true for every reason except the local
   * ones, `rebase` and `resize` (LOCAL_VIEWPORT_REASONS).
   */
  notify?: boolean;
}

/** Bars shown by the initial view and by "reset view" while the plot width is unknown. */
export const DEFAULT_VISIBLE_BARS = 120;

/**
 * Target bar spacing (CSS px per bar) of the initial and reset view, as in
 * TradingView and lightweight-charts. The render loop's defaultVisibleBars()
 * provider turns it into a bar count for the current plot width.
 */
export const DEFAULT_BAR_SPACING = 6;

const CHART_STYLE_SET: Record<ChartStyle, true> = {
  candles: true,
  line: true,
  area: true,
  heikin_ashi: true,
  bars: true,
  hollow_candles: true,
  baseline: true,
  columns: true,
};
/** Every main-series style the painters implement. */
export const CHART_STYLES: readonly ChartStyle[] = Object.freeze(Object.keys(CHART_STYLE_SET) as ChartStyle[]);

// ── Context shape ───────────────────────────────────────────────────────────

/** Plain state and delegates supplied when a widget builds its context. */
export interface ChartContextState {
  readonly options: ChartingLibraryWidgetOptions;
  readonly datafeed: IBasicDataFeed;
  readonly locale: string;
  readonly fontFamily: string;

  symbol: string;
  resolution: ResolutionString;
  symbolInfo: LibrarySymbolInfo | null;

  theme: ThemeColors;
  features: Set<string>;

  /** Bound from `custom_formatters` / `raze.format_price`; rebuilt on symbol resolve. */
  formatPrice: PriceFormatFn;

  /** The full bar series for the current (symbol, resolution), ascending by time. */
  bars: Bar[];

  /** Bar marks for the current visible range (rendered when `mark_on_bars` is on). */
  marks: Mark[];
  timescaleMarks: TimescaleMark[];

  /** Current visible range in bar-index space. Write through setViewport(). */
  visibleRange: IndexRange;
  /** When true the price scale auto-fits the visible bars each frame. Write through setScaleMode(). */
  autoScalePrice: boolean;
  /** Manual price range override (set when the user drags the price axis). Write through setScaleMode(). */
  priceRange: { min: number; max: number } | null;

  /** Main series style (candles / line / area / heikin ashi). Write through setChartType(). */
  chartStyle: ChartStyle;
  /** Logarithmic price scale. Write through setScaleMode(). */
  logScale: boolean;
  /** Percent scale (relative to first visible close). Write through setScaleMode(). */
  percentScale: boolean;
  volumeMode: VolumeMode;
  magnet: boolean;
  stayInDrawingMode: boolean;
  /**
   * View toggle of the `hideAllDrawingTools` action: when true no drawing is
   * painted or hit-tested. Each drawing's own `hidden` flag is untouched.
   */
  drawingsHidden?: boolean;
  /**
   * Compare overlays. `resolution` is a seam for W1B-19: the resolution the
   * bars were loaded at, so a stale series can be detected and reloaded.
   */
  compare: { id: string; symbol: string; bars: Bar[]; color: string; resolution?: ResolutionString }[];
  /**
   * Crosshair mirrored from another layout pane. `symbol` is a seam for W1B-05:
   * the source pane's symbol, so the horizontal line only syncs between panes
   * showing the same instrument while the time line always syncs.
   */
  syncedCrosshair: { unixTime: number; price: number; active: boolean; symbol?: string } | null;
  /** Active left-toolbar drawing tool. */
  drawingTool: DrawingTool;
  /** Currently selected shape entity id (for delete / highlight), or null. */
  selectedShapeId: string | null;
  /** Currently selected broker/order primitive, kept separate from drawings. */
  selectedTradingLineId: string | null;

  /** Fired (resolution, timeframeObj) when the interval changes. */
  readonly intervalChanged: Delegate<[ResolutionString, unknown]>;
  /** Fired on every data mutation that should trigger a repaint. */
  readonly dataChanged: Delegate<[]>;
  /** Fired (entityId, eventType) for shape drawing events. */
  readonly drawingEvent: Delegate<[string, string]>;
  /** Fired (snapshot, eventType) for order/position line lifecycle events. */
  readonly tradingEvent: Delegate<[TradingLineSnapshot, string]>;
  /** Public time-space range (Unix seconds) for visible-range events and layout sync. */
  readonly viewportChanged: Delegate<[{ from: number; to: number }]>;
  readonly crosshairMoved: Delegate<[{ unixTime: number; price: number; active: boolean }]>;

  /** Request an animation-frame repaint. Set by the engine. */
  requestPaint(): void;
}

/** Seams added by createChartContext(). See docs/seams.md for producers and consumers. */
export interface ChartContextSeams {
  /** Per-instance id allocator (AD-10). Stores adopt it in W1B-15/W1B-20. */
  readonly ids: IdAllocator;

  /** Index-space range change with its reason; fires once per effective setViewport(). */
  readonly rangeChanged: Delegate<[ViewportChange]>;
  /** Price-scale state change (mode, autoscale, manual range); fires once per effective setScaleMode(). */
  readonly scaleChanged: Delegate<[ScaleChange]>;
  /** Main series style change; fires once per effective setChartType(). */
  readonly chartTypeChanged: Delegate<[ChartTypeChange]>;

  /**
   * The only sanctioned writer of `visibleRange`. Validates the range, stores a
   * fresh copy, fires `rangeChanged` and (unless suppressed) the public
   * `viewportChanged`, then requests a repaint. Returns false when the range is
   * unchanged, in which case nothing fires.
   */
  readonly setViewport: (range: IndexRange, reason: ViewportChangeReason, options?: SetViewportOptions) => boolean;
  /**
   * The only sanctioned writer of `logScale`, `percentScale`, `autoScalePrice`
   * and `priceRange`. Returns false when nothing changed.
   */
  readonly setScaleMode: (patch: ScaleModePatch, reason: ScaleChangeReason) => boolean;
  /** The only sanctioned writer of `chartStyle`. Throws for unknown styles; returns false when unchanged. */
  readonly setChartType: (style: ChartStyle, reason: ChartTypeChangeReason) => boolean;
  /** Current price-scale state derived from the legacy flags. */
  readonly scaleState: () => ScaleState;

  /**
   * Configured display timezone, initialised from `options.timezone`. Write
   * through setTimezone(); resolve with resolveTimezone(). Seam for W1B-05.
   */
  readonly timezone: TimezoneSetting;
  /** Change the display timezone at runtime (chart.setTimezone). Returns false when unchanged. */
  readonly setTimezone: (zone: TimezoneSetting) => boolean;
  /** Fired (zone, previous) after setTimezone() changes the setting. */
  readonly timezoneChanged: Delegate<[TimezoneSetting, TimezoneSetting]>;

  /**
   * Wall-clock milliseconds corrected by the datafeed server offset. Use this
   * instead of Date.now() for countdowns, presets and the initial history window.
   */
  readonly now: () => number;
  /** Set by the datafeed layer after getServerTime(): serverMs - clientMs. */
  readonly setServerTimeOffset: (offsetMs: number) => void;

  /**
   * Request a repaint of the overlay layer only (crosshair, legend values,
   * hover, countdown, draft). Installed by ChartEngine, which keeps the main
   * scene bitmap untouched. Defaults to requestPaint() without an engine.
   */
  requestOverlayPaint(): void;
  /**
   * Bars shown by the initial and reset view. The renderer installs a
   * width-aware provider that keeps DEFAULT_BAR_SPACING px per bar; without
   * one (or while the plot width is unknown) it is DEFAULT_VISIBLE_BARS.
   */
  defaultVisibleBars(): number;
  /**
   * DOM layer stacked above the canvas for accessible chart-space UI (legend,
   * inline editors, mark tooltips). `pointer-events: none` by default; children
   * opt in. Installed by ChartEngine; null while no engine is mounted.
   */
  overlayHost: HTMLElement | null;
}

export interface ChartContext extends ChartContextState, ChartContextSeams {}

/** What a widget supplies to createChartContext(). Hook seams may be pre-set. */
export type ChartContextInit = ChartContextState
  & Partial<Pick<ChartContextSeams, "requestOverlayPaint" | "defaultVisibleBars" | "overlayHost">>;

export interface CreateChartContextOptions {
  /** Base wall clock in epoch milliseconds (tests inject a fake). Defaults to Date.now. */
  clock?: () => number;
  /** Share or pre-seed an allocator. Defaults to a fresh per-context allocator. */
  ids?: IdAllocator;
}

/** Chrome featuresets that are ON unless listed in `disabled_features`. */
const FEATURE_DEFAULTS_ON = new Set<string>([
  "header_widget",
  "header_resolutions",
  "header_symbol_search",
  "time_frames_toolbar",
  "timezone_display",
  "countdown",
  "left_toolbar",
  "legend_widget",
  "scale_bar",
]);

/** Assign symbol info and rebuild the on-canvas price formatter. */
export function applySymbolInfo(ctx: ChartContext, info: LibrarySymbolInfo | null): void {
  ctx.symbolInfo = info;
  ctx.formatPrice = createPriceFormatter(ctx.options, info);
}

/**
 * Optional featureset policy for buildFeatureSet(). Lets the chrome owner add
 * default-on features and canonical aliases (for example TradingView's
 * `timeframes_toolbar`) without editing this module.
 */
export interface FeatureSetConfig {
  /** Extra features that are on unless disabled. */
  defaultsOn?: Iterable<string>;
  /** alias -> canonical name; both enabled and disabled lists are canonicalised first. */
  aliases?: Readonly<Record<string, string>>;
}

export function buildFeatureSet(opts: ChartingLibraryWidgetOptions, config: FeatureSetConfig = {}): Set<string> {
  const set = new Set<string>(FEATURE_DEFAULTS_ON);
  for (const f of config.defaultsOn ?? []) set.add(f);
  const aliases = config.aliases ?? {};
  const canonical = (name: string): string =>
    Object.prototype.hasOwnProperty.call(aliases, name) ? aliases[name]! : name;
  for (const f of opts.enabled_features ?? []) set.add(canonical(f));
  for (const f of opts.disabled_features ?? []) set.delete(canonical(f));
  return set;
}

/**
 * Resolve the IANA zone the time axis should display, with the same rules the
 * axis chrome uses today: `exchange` means the symbol's zone, an unset setting
 * follows the symbol, and everything falls back to Etc/UTC.
 */
export function resolveTimezone(
  setting: TimezoneSetting | undefined,
  symbolInfo: Pick<LibrarySymbolInfo, "timezone"> | null | undefined,
): string {
  if (setting === "exchange") return symbolInfo?.timezone || "Etc/UTC";
  return setting || symbolInfo?.timezone || "Etc/UTC";
}

/**
 * Map an index range to the Unix-second window of the nearest real bars. This
 * is the payload of the public `viewportChanged` delegate.
 */
export function visibleUnixRange(bars: readonly Bar[], range: Readonly<IndexRange>): { from: number; to: number } {
  const idx = (i: number): number => {
    const clamped = Math.max(0, Math.min(bars.length - 1, Math.round(i)));
    const bar = bars[clamped];
    return bar ? Math.floor(bar.time / 1000) : 0;
  };
  return { from: idx(range.from), to: idx(range.to) };
}

/**
 * Derive the effective scale state from a context's legacy flags, matching the
 * painters: percent wins over log, and a manual range is ignored while
 * autoscale is on.
 */
export function readScaleState(ctx: Pick<ChartContextState, "logScale" | "percentScale" | "autoScalePrice" | "priceRange">): ScaleState {
  const range = ctx.autoScalePrice ? null : ctx.priceRange;
  return {
    mode: ctx.percentScale ? "percent" : ctx.logScale ? "log" : "normal",
    autoScale: ctx.autoScalePrice,
    priceRange: range ? { min: range.min, max: range.max } : null,
  };
}

/**
 * Build a widget context: the supplied state plus every seam. The returned
 * object is `init` itself, extended in place, so references taken before the
 * call stay valid.
 */
export function createChartContext(init: ChartContextInit, options: CreateChartContextOptions = {}): ChartContext {
  const clock = options.clock ?? Date.now;
  let serverOffsetMs = 0;
  let timezone: TimezoneSetting = init.options?.timezone ?? null;
  const ctx = init as ChartContext;

  const setViewport = (range: IndexRange, reason: ViewportChangeReason, opts: SetViewportOptions = {}): boolean => {
    assertReason(VIEWPORT_CHANGE_REASONS, reason, "setViewport");
    assertIndexRange(range);
    const previous = ctx.visibleRange;
    if (previous && previous.from === range.from && previous.to === range.to) return false;
    const next: IndexRange = { from: range.from, to: range.to };
    ctx.visibleRange = next;
    ctx.rangeChanged.fire({
      range: { ...next },
      previous: previous ? { from: previous.from, to: previous.to } : { ...next },
      reason,
    });
    if (opts.notify ?? !LOCAL_VIEWPORT_REASONS.has(reason)) {
      ctx.viewportChanged.fire(visibleUnixRange(ctx.bars, next));
    }
    ctx.requestPaint();
    return true;
  };

  const setScaleMode = (patch: ScaleModePatch, reason: ScaleChangeReason): boolean => {
    assertReason(SCALE_CHANGE_REASONS, reason, "setScaleMode");
    assertScalePatch(patch);
    const previous = readScaleState(ctx);
    const mode = patch.mode ?? previous.mode;
    const autoScale = patch.autoScale ?? (patch.priceRange ? false : previous.autoScale);
    const priceRange = autoScale
      ? null
      : patch.priceRange !== undefined
        ? patch.priceRange && { min: patch.priceRange.min, max: patch.priceRange.max }
        : previous.priceRange && { ...previous.priceRange };
    const state: ScaleState = { mode, autoScale, priceRange };
    if (sameScale(previous, state)) return false;
    ctx.logScale = mode === "log";
    ctx.percentScale = mode === "percent";
    ctx.autoScalePrice = autoScale;
    ctx.priceRange = priceRange ? { ...priceRange } : null;
    ctx.scaleChanged.fire({ state, previous, reason });
    ctx.requestPaint();
    return true;
  };

  const setChartType = (style: ChartStyle, reason: ChartTypeChangeReason): boolean => {
    assertReason(CHART_TYPE_CHANGE_REASONS, reason, "setChartType");
    if (!Object.prototype.hasOwnProperty.call(CHART_STYLE_SET, style)) {
      throw new TypeError(`[raze-charts] unknown chart type "${style}". Supported chart types: ${CHART_STYLES.join(", ")}`);
    }
    const previous = ctx.chartStyle;
    if (previous === style) return false;
    ctx.chartStyle = style;
    ctx.chartTypeChanged.fire({ style, previous, reason });
    ctx.requestPaint();
    return true;
  };

  const seams: Omit<ChartContextSeams, "requestOverlayPaint" | "defaultVisibleBars" | "overlayHost"> = {
    ids: options.ids ?? new IdAllocator(),
    rangeChanged: new Delegate(),
    scaleChanged: new Delegate(),
    chartTypeChanged: new Delegate(),
    setViewport,
    setScaleMode,
    setChartType,
    scaleState: () => readScaleState(ctx),
    now: () => clock() + serverOffsetMs,
    get timezone(): TimezoneSetting {
      return timezone;
    },
    setTimezone: (zone: TimezoneSetting) => {
      if (zone !== null && (typeof zone !== "string" || zone.trim() === "")) {
        throw new TypeError('[raze-charts] setTimezone() needs an IANA zone id, "exchange", or null to follow the symbol');
      }
      if (zone === timezone) return false;
      const previous = timezone;
      timezone = zone;
      ctx.timezoneChanged.fire(zone, previous);
      ctx.requestPaint();
      return true;
    },
    timezoneChanged: new Delegate(),
    setServerTimeOffset: (offsetMs: number) => {
      if (typeof offsetMs !== "number" || !Number.isFinite(offsetMs)) {
        throw new RangeError("[raze-charts] setServerTimeOffset() needs finite milliseconds (server - client)");
      }
      serverOffsetMs = offsetMs;
    },
  };
  // Copy descriptors (not values) so the `timezone` accessor stays live.
  Object.defineProperties(ctx, Object.getOwnPropertyDescriptors(seams));
  if (typeof init.requestOverlayPaint !== "function") ctx.requestOverlayPaint = () => ctx.requestPaint();
  if (typeof init.defaultVisibleBars !== "function") ctx.defaultVisibleBars = () => DEFAULT_VISIBLE_BARS;
  if (init.overlayHost === undefined) ctx.overlayHost = null;
  return ctx;
}

function assertReason(allowed: readonly string[], reason: string, setter: string): void {
  if (!allowed.includes(reason)) {
    throw new TypeError(`[raze-charts] ${setter}() reason "${reason}" is unknown. Supported reasons: ${allowed.join(", ")}`);
  }
}

/** Throws unless `low..high` is a finite, non-inverted interval. */
function assertInterval(setter: string, low: number, high: number): void {
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    throw new RangeError(`[raze-charts] ${setter}() needs finite bounds`);
  }
  if (low > high) throw new RangeError(`[raze-charts] ${setter}() bounds are inverted: ${low} > ${high}`);
}

function assertIndexRange(range: IndexRange): void {
  assertInterval("setViewport", range?.from, range?.to);
}

function assertScalePatch(patch: ScaleModePatch): void {
  if (!patch || typeof patch !== "object") throw new TypeError("[raze-charts] setScaleMode() needs a patch object");
  for (const key of Object.keys(patch)) {
    if (key !== "mode" && key !== "autoScale" && key !== "priceRange") {
      throw new TypeError(`[raze-charts] setScaleMode() does not support "${key}". Supported keys: mode, autoScale, priceRange`);
    }
  }
  if (patch.mode !== undefined && !PRICE_SCALE_MODES.includes(patch.mode)) {
    throw new TypeError(`[raze-charts] unknown price scale mode "${patch.mode}". Supported modes: ${PRICE_SCALE_MODES.join(", ")}`);
  }
  if (patch.autoScale !== undefined && typeof patch.autoScale !== "boolean") {
    throw new TypeError("[raze-charts] setScaleMode() autoScale must be a boolean");
  }
  if (patch.priceRange) {
    assertInterval("setScaleMode", patch.priceRange.min, patch.priceRange.max);
    if (patch.priceRange.min === patch.priceRange.max) {
      // A zero-height window maps every price to one pixel row and divides by
      // zero in the price-to-pixel mapping.
      throw new RangeError(
        `[raze-charts] setScaleMode() priceRange is empty (min === max === ${patch.priceRange.min}); `
        + "pass a window with max > min, or { autoScale: true } to fit the visible bars",
      );
    }
    if (patch.autoScale) {
      throw new TypeError("[raze-charts] setScaleMode() cannot pin a priceRange with autoScale: true; autoscale replaces the manual range");
    }
  }
}

function sameScale(a: ScaleState, b: ScaleState): boolean {
  if (a.mode !== b.mode || a.autoScale !== b.autoScale) return false;
  if (!a.priceRange || !b.priceRange) return a.priceRange === b.priceRange;
  return a.priceRange.min === b.priceRange.min && a.priceRange.max === b.priceRange.max;
}

// Mount contracts: the public options/handle/event types and the internal
// runtime shared by the mount, overlay, range-chrome, and gesture modules.

import type { ChartDefinition, ChartSpec, ChartViewport, CompiledChart, HoverSample, SceneNode } from "../compile/types";
import type { StageFrame } from "./frame";
import type { AxisWindowLimits } from "./zoom";

/**
 * Pointer payload for `onTooltip` and `onSelect`. Values are structured and
 * data-space: nothing here is parsed from tooltip text or left as a pixel.
 */
export interface ChartPointerEvent {
  /**
   * Data-space x: a number on quantitative axes (epoch milliseconds on time
   * axes), the category on band axes, the axis or slice label on polar charts.
   */
  x: unknown;
  /**
   * Data-space y on quantitative axes: the datum value for samples and bars,
   * otherwise the value under the pointer. Undefined on band and pie axes.
   */
  y?: number;
  /** Series name of the hovered sample or mark. */
  series?: string;
  /**
   * Stable series id (the mark's `id`, otherwise `mark-<index>`). `seriesId`,
   * `index`, and `markIndex` are set for built-in marks, whether the target
   * is a hover sample (line, area, point, radar) or a row node (bar, heatmap
   * cell, pie slice); custom-mark plugins leave them unset.
   */
  seriesId?: string;
  /** Source row of the hovered sample or mark. */
  datum?: unknown;
  /** Row index of `datum` within its mark's `data` (before viewport windowing). */
  index?: number;
  /** Index of the producing mark in `ChartSpec.marks`. */
  markIndex?: number;
  node: SceneNode | null;
  sample: HoverSample | null;
}

export interface MountInteraction {
  brush?: boolean;
  /**
   * Wheel and pinch zoom. Pass an object to bound it, in X data units
   * (milliseconds on time axes, decades on log axes, where zoom steps are
   * ratios):
   * - `minSpan`: narrowest window. Default: three data points, or two plot
   *   pixels of the full extent when the data spacing is unknown.
   * - `maxSpan`: widest window. Default: the full data extent.
   *
   * Range presets outside [minSpan, maxSpan] are hidden, and ALL selects the
   * latest `maxSpan` of data when the full extent is wider.
   */
  zoom?: boolean | { minSpan?: number; maxSpan?: number };
  pan?: boolean;
  /**
   * `"data"` (default) keeps pan, zoom, brush, and navigator windows inside the
   * data extent. `"none"` lets the window leave it (zoom limits still apply).
   */
  panBounds?: "data" | "none";
  navigator?: boolean;
  rangePresets?: boolean;
}

/** Interaction flags after defaults and validation. */
export interface ResolvedInteraction {
  brush: boolean;
  zoom: boolean;
  pan: boolean;
  navigator: boolean;
  rangePresets: boolean;
  panBounds: "data" | "none";
  minSpan?: number;
  maxSpan?: number;
}

export interface MountChartOptions {
  width?: number;
  height?: number;
  renderer?: "svg" | "canvas";
  /** Stable DOM/SVG id prefix; useful for hydration and deterministic tests. */
  idPrefix?: string;
  viewport?: ChartViewport;
  interaction?: boolean | MountInteraction;
  /**
   * Series to hide (ids, legend row ids, or names). When set, it replaces
   * `spec.hiddenSeries`; legend clicks then toggle from it.
   */
  hiddenSeries?: readonly string[];
  onViewportChange?: (viewport: ChartViewport) => void;
  onSelect?: (event: ChartPointerEvent) => void;
  onTooltip?: (event: ChartPointerEvent | null) => void;
}

export interface MountHandle {
  /**
   * Update in place. The mounted host and interaction state are preserved,
   * and the visible scene is recompiled. A call without `viewport` also
   * recomputes the full-data extent and the navigator, because the rows a
   * definition reads may have been mutated in place. A call that passes
   * `viewport` (moving the window, or echoing the one `onViewportChange`
   * reported, as controlled hosts do) is navigation: it keeps them unless
   * the definition changed or rows were added or removed. An echo made
   * synchronously inside `onViewportChange` is that change's only repaint.
   * A tooltip under a stationary pointer is refreshed afterwards, and
   * `onTooltip` runs only when its target or values changed. An error
   * thrown there propagates after the update has been applied.
   */
  update(definition: ChartDefinition, options?: MountChartOptions): void;
  /** Latest renderer-neutral scene, useful for diagnostics and deterministic tests. */
  getScene(): CompiledChart | null;
  setViewport(viewport: ChartViewport | null): void;
  getViewport(): ChartViewport | null;
  destroy(): void;
}

/** Mutable state of one mount. Every module reads it live, never from a copy. */
export interface MountState {
  options: MountChartOptions;
  definition: ChartDefinition;
  /** Last successfully painted scene. */
  scene: CompiledChart | null;
  /** Viewport set by gestures, presets, or setViewport(); overrides options.viewport. */
  viewport: ChartViewport | null;
  /** Series toggled off through the legend or options.hiddenSeries. */
  hidden: Set<string>;
  /** True once options.hiddenSeries or a legend click set `hidden`; it then replaces spec.hiddenSeries. */
  hiddenOwned: boolean;
  /** Full-data X extent used by presets, the navigator, and zoom limits. */
  fullXExtent: [number, number] | null;
  /** Spec behind the full-data scene; zoom defaults read its data spacing. */
  fullSpec: ChartSpec | null;
  lastInputWidth: number;
  lastInputHeight: number;
  /** Last pointer position over the mount, kept so repaints can re-run hover. */
  pointer: { clientX: number; clientY: number } | null;
  /** True while a pan or brush drag owns the pointer. */
  dragging: boolean;
  destroyed: boolean;
}

/** Elements owned by a mount, in their DOM order inside `wrap`. */
export interface MountDom {
  wrap: HTMLDivElement;
  stage: HTMLDivElement;
  hairV: HTMLDivElement;
  hairH: HTMLDivElement;
  chipY: HTMLDivElement;
  chipX: HTMLDivElement;
  cell: HTMLDivElement;
  dot: HTMLDivElement;
  tip: HTMLDivElement;
  a11y: HTMLDivElement;
  /**
   * Transparent, keyboard-reachable toggle buttons over the legend entries.
   * They take no pointer events: pointers hit the painted entries in `stage`.
   */
  legend: HTMLDivElement;
  presetsBar: HTMLDivElement;
  nav: HTMLDivElement;
  brushRect: HTMLDivElement;
}

/** Services the mount exposes to its overlay, range chrome, and gestures. */
export interface MountRuntime {
  state: MountState;
  dom: MountDom;
  /** Resolved interaction flags for the current options; throws on invalid options. */
  flags(): ResolvedInteraction;
  /** True for events inside the preset bar, navigator, or legend toggles. */
  isChromeEvent(ev: Event): boolean;
  /** Where the painted scene sits in the viewport, for pointer mapping. */
  frame(): StageFrame | null;
  /** Zoom and pan limits for the live scene, or null when the X axis is not quantitative. */
  windowLimits(): AxisWindowLimits | null;
  /** Recompile and repaint; throws after destroy(). */
  paint(): void;
  /** Commit a viewport, notify onViewportChange, and repaint unless the callback already did. */
  emitViewport(next: ChartViewport): void;
  /** Show or hide a series by legend key and repaint. */
  toggleSeries(key: string): void;
  /** Hide the crosshair, chips, tooltip, and slice emphasis. */
  hideOverlay(): void;
}

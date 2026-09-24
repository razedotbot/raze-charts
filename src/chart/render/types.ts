// Mount contracts: the public options/handle/event types and the internal
// runtime shared by the mount, overlay, range-chrome, and gesture modules.

import type { ChartDefinition, ChartViewport, CompiledChart, HoverSample, SceneNode } from "../compile/types";

export interface ChartPointerEvent {
  x: unknown;
  y?: number;
  series?: string;
  datum?: unknown;
  node: SceneNode | null;
  sample: HoverSample | null;
}

export interface MountInteraction {
  brush?: boolean;
  zoom?: boolean;
  pan?: boolean;
  navigator?: boolean;
  rangePresets?: boolean;
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
  /** Update in place. The mounted host and interaction state are preserved. */
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
  /** Full-data X extent used by presets and the navigator. */
  fullXExtent: [number, number] | null;
  lastInputWidth: number;
  lastInputHeight: number;
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
  presetsBar: HTMLDivElement;
  nav: HTMLDivElement;
  brushRect: HTMLDivElement;
}

/** Services the mount exposes to its overlay, range chrome, and gestures. */
export interface MountRuntime {
  state: MountState;
  dom: MountDom;
  /** Resolved interaction flags for the current options. */
  flags(): MountInteraction;
  /** True for events inside the preset bar or navigator. */
  isChromeEvent(ev: Event): boolean;
  /** Recompile and repaint; throws after destroy(). */
  paint(): void;
  /** Commit a viewport, notify onViewportChange, and repaint. */
  emitViewport(next: ChartViewport): void;
  /** Hide the crosshair, chips, tooltip, and slice emphasis. */
  hideOverlay(): void;
}

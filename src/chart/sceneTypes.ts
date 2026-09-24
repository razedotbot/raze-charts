// /chart scene contract v2 (AD-08). Declared ahead of the compile (W1B-01,
// W1B-02) and render (W1B-03) packages so both sides of the scene can change
// in parallel. Every v2 field is optional on the scene until its producer
// lands: producers fill a field, consumers fall back to the v1 data
// (`xTicks`, `legend`, `samples`, tip strings) when it is absent.
// docs/seams.md names the producer and consumers of each field.

import type { CompiledChart, HoverSample } from "./index";

/** Current scene contract version. */
export const SCENE_CONTRACT_VERSION = 2;

/** Formats a data-space value (number, Date, category) for display. */
export type SceneValueFormatter = (value: unknown) => string;

/**
 * One formatter per axis, shared by ticks, crosshair chips, tooltips, rule
 * labels, last-value chips and the colour bar, so a currency axis never shows
 * a raw number anywhere.
 */
export interface SceneFormatters {
  readonly x: SceneValueFormatter;
  readonly y: SceneValueFormatter;
  /** Heatmap colour-bar values; defaults to `y`. */
  readonly color?: SceneValueFormatter;
}

/** A tick with its measured label placement. */
export interface SceneTick {
  readonly value: unknown;
  readonly px: number;
  readonly label: string;
  /** Text anchor after edge nudging, so the first/last labels stay inside the chart. */
  readonly anchor: "start" | "middle" | "end";
  /** Label rotation in degrees (0 or negative, counter-clockwise). */
  readonly rotation: number;
  /** Calendar weight for time ticks (year > month > day ...); higher wins during thinning. */
  readonly weight?: number;
}

/** A measured axis: the compiler reserves exactly `size` pixels for it. */
export interface SceneAxis {
  readonly position: "top" | "right" | "bottom" | "left";
  /** Pixels reserved perpendicular to the axis (tick labels + padding + title). */
  readonly size: number;
  /** Widest (y) or tallest (rotated x) label extent, in pixels. */
  readonly labelExtent: number;
  readonly ticks: readonly SceneTick[];
  readonly title?: string;
}

export interface SceneAxes {
  readonly x: SceneAxis;
  readonly y: SceneAxis;
}

/**
 * A legend entry with stable identity. Hidden series stay listed (with
 * `hidden: true`) so a legend toggle can always be reversed.
 */
export interface SceneLegendRow {
  /** Stable series id: the mark's explicit `id`, otherwise `mark-<index>`. */
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly detail?: string;
  readonly hidden: boolean;
  readonly markIndex: number;
  /** Swatch shape matching the painted mark. */
  readonly symbol: "line" | "area" | "rect" | "circle";
  /** Row box in scene pixels: where renderers paint it and where a toggle hit-tests. */
  readonly box?: SceneLegendBox;
  /** Painted name after ellipsis truncation; `name` stays complete. */
  readonly label?: string;
}

/** An axis-aligned rectangle in scene pixels. */
export interface SceneLegendBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Legend layout measured by the compiler (wrapping rows, `+N more`). */
export interface SceneLegendLayout {
  readonly placement: "top" | "bottom" | "right" | "hidden";
  readonly rows: readonly SceneLegendRow[];
  /** Pixels reserved for the legend band. */
  readonly size: number;
  /** Rows that did not fit and are summarised as `+N more`. */
  readonly overflow: number;
  /**
   * How a row paints inside its box: `inline` (swatch, name, then detail on
   * one line), `stacked` (detail on a second line), or `compact` (one line
   * with the detail right-aligned).
   */
  readonly rowStyle?: "inline" | "stacked" | "compact";
  /** The `+N more` summary for rows that did not fit; `names` feeds its tooltip. */
  readonly more?: {
    readonly box: SceneLegendBox;
    readonly label: string;
    readonly names: readonly string[];
  };
}

/**
 * Hover sample with structured values. Renderers format chips and tooltips
 * from these fields and never parse `tip` strings.
 */
export interface SceneHoverSample extends HoverSample {
  readonly seriesId: string;
  readonly markIndex: number;
  /** Source row index within the mark's data. */
  readonly index: number;
  readonly datum: unknown;
  /** Data-space x (a category for band scales). */
  readonly xValue: unknown;
  readonly yValue: number | null;
}

/** Pointer payload for onTooltip/onSelect once W1B-03 adopts v2. */
export interface ScenePointerEvent {
  /** Always the data-space x value (a category on band scales, never a pixel or tip text). */
  readonly x: unknown;
  readonly y: number | null;
  readonly seriesId: string | null;
  readonly datum: unknown;
  readonly sample: SceneHoverSample | null;
}

/** Fields a v2 compiler adds to CompiledChart. All optional until every producer lands. */
export interface CompiledSceneV2Fields {
  readonly contractVersion?: typeof SCENE_CONTRACT_VERSION;
  readonly formatters?: SceneFormatters;
  readonly axes?: SceneAxes;
  readonly legendLayout?: SceneLegendLayout;
  readonly hoverSamples?: readonly SceneHoverSample[];
}

/** A scene with every v2 field present. */
export type CompiledChartV2 = CompiledChart & Required<CompiledSceneV2Fields>;

/** True when `scene` carries the complete v2 contract; renderers fall back to v1 fields otherwise. */
export function isSceneV2(scene: CompiledChart & CompiledSceneV2Fields): scene is CompiledChartV2 {
  return scene.contractVersion === SCENE_CONTRACT_VERSION
    && scene.formatters !== undefined
    && scene.axes !== undefined
    && scene.legendLayout !== undefined
    && scene.hoverSamples !== undefined;
}

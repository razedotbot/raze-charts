// Main-series bar transforms (Heikin-Ashi today). The renderer asks for the
// bars a chart style paints; styles without a transform paint the source bars
// directly. W2-14 builds defineSeriesType on this lookup.

import type { Bar } from "../types/charting_library";
import type { ChartStyle } from "../core/context";
import { heikinAshi } from "../util/heikinAshi";

/** Pure function from the source series to the painted series. */
export type SeriesTransformFn = (bars: Bar[]) => Bar[];

const SERIES_TRANSFORMS: Partial<Record<ChartStyle, SeriesTransformFn>> = {
  heikin_ashi: heikinAshi,
};

/** The transform a chart style paints through, or null when it paints the source bars. */
export function seriesTransformFor(style: ChartStyle): SeriesTransformFn | null {
  return Object.prototype.hasOwnProperty.call(SERIES_TRANSFORMS, style) ? SERIES_TRANSFORMS[style]! : null;
}

/**
 * Caches the transformed series between frames. The cache is keyed by the
 * chart style and the source array's identity; in-place forming-bar updates
 * keep the identity, so data events must call invalidate(). Pointer-driven
 * repaints therefore reuse the transformed array (O(visible bars) per frame).
 */
export class SeriesTransformCache {
  private style: ChartStyle | null = null;
  private source: Bar[] | null = null;
  private output: Bar[] | null = null;
  private last: Bar[] = [];

  /** Bars to paint for `style`, recomputing only when the style, the source array or a data event invalidated them. */
  resolve(style: ChartStyle, bars: Bar[]): Bar[] {
    if (style !== this.style) {
      this.invalidate();
      this.style = style;
    }
    const transform = seriesTransformFor(style);
    if (!transform) {
      this.last = bars;
      return bars;
    }
    if (this.source !== bars || !this.output) {
      this.source = bars;
      this.output = transform(bars);
    }
    this.last = this.output;
    return this.output;
  }

  /** The series resolved most recently (empty after invalidate()). */
  get current(): Bar[] {
    return this.last;
  }

  /** Drop the cached transform; the next resolve() recomputes it. */
  invalidate(): void {
    this.source = null;
    this.output = null;
    this.last = [];
  }
}

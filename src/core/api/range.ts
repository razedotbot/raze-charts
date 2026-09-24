// Visible time range in unix seconds.

import type { ChartApi } from "../ChartApi";
import { apiScope } from "./scope";

export const rangeApi = {
  getVisibleRange(this: ChartApi): { from: number; to: number } {
    const { bars, visibleRange } = apiScope(this).context;
    const idx = (i: number): number => {
      const clamped = Math.max(0, Math.min(bars.length - 1, Math.round(i)));
      const bar = bars[clamped];
      return bar ? Math.floor(bar.time / 1000) : 0;
    };
    return { from: idx(visibleRange.from), to: idx(visibleRange.to) };
  },

  setVisibleRange(this: ChartApi, range: { from: number; to: number }): Promise<void> {
    return apiScope(this).deps.setVisibleRange(range);
  },
};

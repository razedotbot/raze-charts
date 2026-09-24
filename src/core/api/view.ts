// Chart view commands: fit every loaded bar, or reset to the default view.

import type { ChartApi } from "../ChartApi";
import { apiScope } from "./scope";

export const viewApi = {
  /**
   * Fit every loaded bar in view and re-enable price autoscale (the F key,
   * double-click and the sidebar Fit button). Fires one visible-range change.
   */
  fitContent(this: ChartApi): void {
    apiScope(this).deps.fitContent();
  },

  /**
   * Reset to the default view: 6 px per bar anchored to the latest bar, with
   * price autoscale (TradingView's "Reset chart view"). Fires one
   * visible-range change when the range moves.
   */
  resetView(this: ChartApi): void {
    apiScope(this).deps.resetView();
  },
};

// Symbol and resolution of the chart.

import type { ResolutionString } from "../../types/charting_library";
import type { ChartApi } from "../ChartApi";
import { apiScope } from "./scope";

export const symbolApi = {
  symbol(this: ChartApi): string {
    return apiScope(this).context.symbol;
  },

  setSymbol(this: ChartApi, symbol: string, callback?: () => void): void {
    apiScope(this).deps.setSymbol(symbol, callback);
  },

  resolution(this: ChartApi): ResolutionString {
    return apiScope(this).context.resolution;
  },

  setResolution(this: ChartApi, resolution: ResolutionString, callback?: () => void): void {
    apiScope(this).deps.setResolution(resolution, callback);
  },
};

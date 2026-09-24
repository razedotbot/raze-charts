// Series data: marks, history reset and compare overlays.

import type { EntityId } from "../../types/charting_library";
import type { ChartApi } from "../ChartApi";
import { apiScope } from "./scope";

export const dataApi = {
  refreshMarks(this: ChartApi): void {
    apiScope(this).deps.refreshMarks();
  },

  clearMarks(this: ChartApi): void {
    apiScope(this).deps.clearMarks();
  },

  resetData(this: ChartApi): void {
    apiScope(this).deps.resetData();
  },

  createCompare(this: ChartApi, symbol: string): Promise<EntityId> {
    return apiScope(this).deps.createCompare(symbol);
  },
};

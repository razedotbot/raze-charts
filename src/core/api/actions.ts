// Built-in chart actions (undo, redo, resets, panels, drawing toggles, ...).

import type { ChartActionId, CheckableChartActionId } from "../../types/charting_library";
import type { ChartApi } from "../ChartApi";
import { apiScope } from "./scope";

export const actionsApi = {
  executeActionById(this: ChartApi, actionId: ChartActionId): void {
    apiScope(this).deps.executeActionById(actionId);
  },

  getCheckableActionState(this: ChartApi, actionId: CheckableChartActionId): boolean {
    return apiScope(this).deps.getCheckableActionState(actionId);
  },
};

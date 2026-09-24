// Built-in chart actions (undo, redo, magnet, ...).

import type { ChartApi } from "../ChartApi";
import { apiScope } from "./scope";

export const actionsApi = {
  executeActionById(this: ChartApi, actionId: string): void {
    apiScope(this).deps.executeActionById(actionId);
  },
};

// Indicators.

import type { EntityId } from "../../types/charting_library";
import type { ChartApi } from "../ChartApi";
import { apiScope } from "./scope";

export const studiesApi = {
  createStudy(
    this: ChartApi,
    name: string,
    forceOverlay?: boolean,
    lock?: boolean,
    inputs?: Record<string, unknown>,
  ): Promise<EntityId> {
    return apiScope(this).deps.createStudy(name, forceOverlay, lock, inputs);
  },
};

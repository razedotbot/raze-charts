// Indicators.

import type {
  CreateStudyInputs,
  CreateStudyOptions,
  CreateStudyOverrides,
  EntityId,
} from "../../types/charting_library";
import type { ChartApi } from "../ChartApi";
import { apiScope } from "./scope";

export const studiesApi = {
  /** TradingView createStudy(name, forceOverlay, lock, inputs, overrides, options). */
  createStudy(
    this: ChartApi,
    name: string,
    forceOverlay?: boolean,
    lock?: boolean,
    // Registered study names narrow this further on IChartWidgetApi.
    inputs?: CreateStudyInputs | Readonly<Record<string, unknown>>,
    overrides?: CreateStudyOverrides,
    options?: CreateStudyOptions,
  ): Promise<EntityId> {
    return apiScope(this).deps.createStudy(name, forceOverlay, lock, inputs, overrides, options);
  },
};

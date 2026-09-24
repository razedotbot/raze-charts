// Drawings (shapes) and entity removal.

import type {
  CreateShapeOptions,
  EntityId,
  ILineDataSourceApi,
  ShapePoint,
} from "../../types/charting_library";
import type { ChartApi } from "../ChartApi";
import { apiScope } from "./scope";

export const shapesApi = {
  createShape<TOverrides extends object>(
    this: ChartApi,
    point: ShapePoint,
    options: CreateShapeOptions<TOverrides>,
  ): Promise<EntityId> {
    return apiScope(this).deps.createShape(point, options as CreateShapeOptions);
  },

  createMultipointShape<TOverrides extends object>(
    this: ChartApi,
    points: ShapePoint[],
    options: CreateShapeOptions<TOverrides>,
  ): Promise<EntityId> {
    return apiScope(this).deps.createMultipointShape(points, options as CreateShapeOptions);
  },

  getShapeById(this: ChartApi, entityId: EntityId): ILineDataSourceApi {
    return apiScope(this).deps.getShapeById(entityId);
  },

  /** Removes a study, compare series, trading line or drawing. */
  removeEntity(this: ChartApi, entityId: EntityId): void {
    apiScope(this).deps.removeEntity(entityId);
  },

  removeAllShapes(this: ChartApi): void {
    apiScope(this).deps.removeAllShapes();
  },
};

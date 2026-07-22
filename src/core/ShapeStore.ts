// Stores chart shapes. Programmatic lines from the app use `horizontal_line`;
// user drawings (left toolbar) add trend_line / fib / rectangle / text.
// The engine reads `list()` to render; hit-test / drag mutates points and
// fires drawing_event.

import type {
  CreateShapeOptions,
  EntityId,
  ILineDataSourceApi,
  ShapePoint,
} from "../types/charting_library";
import type { ChartContext } from "./context";

export type ShapeKind =
  | "horizontal_line"
  | "trend_line"
  | "fib_retracement"
  | "rectangle"
  | "text"
  | string;

export interface StoredShape {
  id: EntityId;
  shape: ShapeKind;
  points: ShapePoint[];
  text: string;
  lock: boolean;
  disableSelection: boolean;
  zOrder: "top" | "bottom";
  overrides: Record<string, unknown>;
}

let shapeCounter = 0;
const nextId = (): EntityId => `shape_${++shapeCounter}` as unknown as EntityId;

export class ShapeStore {
  private shapes = new Map<EntityId, StoredShape>();

  constructor(private readonly context: ChartContext) {}

  create(point: ShapePoint, options: CreateShapeOptions): Promise<EntityId> {
    return this.createPoints([point], options);
  }

  createPoints(points: ShapePoint[], options: CreateShapeOptions): Promise<EntityId> {
    const id = nextId();
    const stored: StoredShape = {
      id,
      shape: options.shape ?? "horizontal_line",
      points: points.map((p) => ({ ...p })),
      text: options.text ?? "",
      lock: options.lock ?? false,
      disableSelection: options.disableSelection ?? false,
      zOrder: options.zOrder === "top" ? "top" : "bottom",
      overrides: { ...(options.overrides as Record<string, unknown> | undefined) },
    };
    this.shapes.set(id, stored);
    this.context.requestPaint();
    this.context.drawingEvent.fire(id as unknown as string, "create");
    return Promise.resolve(id);
  }

  remove(id: EntityId): void {
    if (this.shapes.delete(id)) {
      if (this.context.selectedShapeId === (id as unknown as string)) {
        this.context.selectedShapeId = null;
      }
      this.context.drawingEvent.fire(id as unknown as string, "remove");
      this.context.requestPaint();
    }
  }

  removeAll(): void {
    if (this.shapes.size) {
      this.shapes.clear();
      this.context.selectedShapeId = null;
      this.context.requestPaint();
    }
  }

  get(id: EntityId): StoredShape | undefined {
    return this.shapes.get(id);
  }

  list(): StoredShape[] {
    return Array.from(this.shapes.values()).sort(
      (a, b) => (a.zOrder === "top" ? 1 : 0) - (b.zOrder === "top" ? 1 : 0),
    );
  }

  adapter(id: EntityId): ILineDataSourceApi {
    const store = this;
    return {
      getPoints(): ShapePoint[] {
        const s = store.shapes.get(id);
        return s ? s.points.map((p) => ({ ...p })) : [];
      },
      setPoints(points: ShapePoint[]): void {
        const s = store.shapes.get(id);
        if (!s) return;
        s.points = points.map((p) => ({ ...p }));
        store.context.requestPaint();
      },
      setPriceLevel(price: number): void {
        const s = store.shapes.get(id);
        if (!s || !s.points[0]) return;
        s.points[0].price = price;
        store.context.requestPaint();
      },
      bringToFront(): void {
        const s = store.shapes.get(id);
        if (s) s.zOrder = "top";
        store.context.requestPaint();
      },
      sendToBack(): void {
        const s = store.shapes.get(id);
        if (s) s.zOrder = "bottom";
        store.context.requestPaint();
      },
      getProperties(): Record<string, unknown> {
        return { ...(store.shapes.get(id)?.overrides ?? {}) };
      },
      setProperties(props: Record<string, unknown>): void {
        const s = store.shapes.get(id);
        if (!s) return;
        Object.assign(s.overrides, props);
        store.context.requestPaint();
      },
    };
  }
}

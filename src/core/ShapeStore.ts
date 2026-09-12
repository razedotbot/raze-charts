// Stores chart shapes. Programmatic lines from the app use `horizontal_line`;
// user drawings (left toolbar) add trend_line / fib / rectangle / text.
// The engine reads `list()` to render; hit-test / drag mutates points and
// fires drawing_event.

import type {
  CreateShapeOptions,
  DrawingEventType,
  EntityId,
  ILineDataSourceApi,
  ShapePoint,
} from "../types/charting_library";
import type { ChartContext } from "./context";
import type { CommandStack } from "./CommandStack";

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
  /** Omitted by older consumers; defaults to false when a shape is created or loaded. */
  disableSave?: boolean;
  disableUndo: boolean;
  showInObjectsTree: boolean;
  hidden: boolean;
  zOrder: "top" | "bottom";
  overrides: Record<string, unknown>;
}

let shapeCounter = 0;
const nextId = (): EntityId => `shape_${++shapeCounter}` as unknown as EntityId;
const reserveId = (id: EntityId): void => {
  const match = /^shape_(\d+)$/.exec(String(id));
  const value = match ? Number(match[1]) : Number.NaN;
  if (Number.isSafeInteger(value)) shapeCounter = Math.max(shapeCounter, value);
};

function cloneShape(shape: StoredShape): StoredShape {
  return {
    ...shape,
    points: shape.points.map((point) => ({ ...point })),
    overrides: { ...shape.overrides },
  };
}

function sameShape(a: StoredShape, b: StoredShape): boolean {
  if (a.shape !== b.shape
      || a.text !== b.text
      || a.lock !== b.lock
      || a.disableSelection !== b.disableSelection
      || a.disableSave !== b.disableSave
      || a.disableUndo !== b.disableUndo
      || a.showInObjectsTree !== b.showInObjectsTree
      || a.hidden !== b.hidden
      || a.zOrder !== b.zOrder
      || a.points.length !== b.points.length) return false;
  for (let i = 0; i < a.points.length; i++) {
    const left = a.points[i]!;
    const right = b.points[i]!;
    if (left.time !== right.time || left.price !== right.price) return false;
  }
  const aKeys = Object.keys(a.overrides);
  const bKeys = Object.keys(b.overrides);
  return aKeys.length === bKeys.length
    && aKeys.every((key) => Object.is(a.overrides[key], b.overrides[key]));
}

export class ShapeStore {
  private shapes = new Map<EntityId, StoredShape>();

  constructor(
    private readonly context: ChartContext,
    private readonly commands?: CommandStack,
  ) {}

  create(point: ShapePoint, options: CreateShapeOptions): Promise<EntityId> {
    return this.createPoints([point], options);
  }

  createPoints(points: ShapePoint[], options: CreateShapeOptions): Promise<EntityId> {
    let id = nextId();
    while (this.shapes.has(id)) id = nextId();
    const stored: StoredShape = {
      id,
      shape: options.shape ?? "horizontal_line",
      points: points.map((p) => ({ ...p })),
      text: options.text ?? "",
      lock: options.lock ?? false,
      disableSelection: options.disableSelection ?? false,
      disableSave: options.disableSave ?? false,
      disableUndo: options.disableUndo ?? false,
      showInObjectsTree: options.showInObjectsTree !== false,
      hidden: false,
      zOrder: options.zOrder === "top" ? "top" : "bottom",
      overrides: { ...(options.overrides as Record<string, unknown> | undefined) },
    };
    this.shapes.set(id, stored);
    this.context.requestPaint();
    this.context.drawingEvent.fire(id as unknown as string, "create");
    if (!stored.disableUndo) {
      const snapshot = cloneShape(stored);
      this.commands?.push({
        undo: () => this.remove(id),
        redo: () => this.restore(snapshot),
      });
    }
    return Promise.resolve(id);
  }

  remove(id: EntityId): void {
    const before = this.shapes.get(id);
    const index = Array.from(this.shapes.keys()).indexOf(id);
    if (before && this.shapes.delete(id)) {
      const snapshot = cloneShape(before);
      if (this.context.selectedShapeId === (id as unknown as string)) {
        this.context.selectedShapeId = null;
      }
      this.context.drawingEvent.fire(id as unknown as string, "remove");
      this.context.requestPaint();
      this.commands?.push({
        undo: () => this.restore(snapshot, index),
        redo: () => this.remove(id),
      });
    }
  }

  removeAll(): void {
    if (this.shapes.size) {
      const snapshots = Array.from(this.shapes.values()).map((shape, index) => ({
        shape: cloneShape(shape),
        index,
      }));
      this.shapes.clear();
      this.context.selectedShapeId = null;
      for (const { shape } of snapshots) {
        this.context.drawingEvent.fire(shape.id as unknown as string, "remove");
      }
      this.context.requestPaint();
      if (snapshots.length) {
        this.commands?.push({
          undo: () => {
            for (const snapshot of snapshots) this.restore(snapshot.shape, snapshot.index);
          },
          redo: () => {
            for (const snapshot of snapshots) this.remove(snapshot.shape.id);
          },
        });
      }
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

  restore(shape: StoredShape, index?: number, event?: DrawingEventType): void {
    const existed = this.shapes.has(shape.id);
    reserveId(shape.id);
    const restored = cloneShape(shape);
    if (existed || index === undefined || index >= this.shapes.size) {
      this.shapes.set(shape.id, restored);
    } else {
      const entries = Array.from(this.shapes.entries());
      entries.splice(Math.max(0, index), 0, [shape.id, restored]);
      this.shapes = new Map(entries);
    }
    this.context.requestPaint();
    this.context.drawingEvent.fire(
      shape.id as unknown as string,
      event ?? (existed ? "points_changed" : "create"),
    );
  }

  /** Capture state before an in-place UI gesture, then commit it once. */
  capture(id: EntityId): StoredShape | undefined {
    const shape = this.shapes.get(id);
    return shape ? cloneShape(shape) : undefined;
  }

  commitUpdate(id: EntityId, before: StoredShape | undefined): void {
    const current = this.shapes.get(id);
    if (!before || !current) return;
    const after = cloneShape(current);
    if (sameShape(before, after)) return;
    const index = Array.from(this.shapes.keys()).indexOf(id);
    const forwardEvent: DrawingEventType = before.hidden !== after.hidden
      ? after.hidden ? "hide" : "show"
      : before.points.some((point, pointIndex) => {
        const next = after.points[pointIndex];
        return !next || point.time !== next.time || point.price !== next.price;
      }) || before.points.length !== after.points.length
        ? "points_changed"
        : "properties_changed";
    const reverseEvent: DrawingEventType = forwardEvent === "hide"
      ? "show"
      : forwardEvent === "show" ? "hide" : forwardEvent;
    this.context.drawingEvent.fire(id as unknown as string, forwardEvent);
    this.commands?.push({
      undo: () => this.restore(before, index, reverseEvent),
      redo: () => this.restore(after, index, forwardEvent),
    });
  }

  setHidden(id: EntityId, hidden: boolean): void {
    const shape = this.shapes.get(id);
    if (!shape || shape.hidden === hidden) return;
    const before = cloneShape(shape);
    shape.hidden = hidden;
    this.context.requestPaint();
    this.commitUpdate(id, before);
  }

  snapshot(): StoredShape[] {
    return this.list().map(cloneShape);
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
        const before = cloneShape(s);
        s.points = points.map((p) => ({ ...p }));
        store.context.requestPaint();
        store.commitUpdate(id, before);
      },
      setPriceLevel(price: number): void {
        const s = store.shapes.get(id);
        if (!s || !s.points[0]) return;
        const before = cloneShape(s);
        s.points[0].price = price;
        store.context.requestPaint();
        store.commitUpdate(id, before);
      },
      bringToFront(): void {
        const s = store.shapes.get(id);
        if (!s || s.zOrder === "top") return;
        const before = cloneShape(s);
        s.zOrder = "top";
        store.context.requestPaint();
        store.commitUpdate(id, before);
      },
      sendToBack(): void {
        const s = store.shapes.get(id);
        if (!s || s.zOrder === "bottom") return;
        const before = cloneShape(s);
        s.zOrder = "bottom";
        store.context.requestPaint();
        store.commitUpdate(id, before);
      },
      getProperties(): Record<string, unknown> {
        return { ...(store.shapes.get(id)?.overrides ?? {}) };
      },
      setProperties(props: Record<string, unknown>): void {
        const s = store.shapes.get(id);
        if (!s) return;
        const before = cloneShape(s);
        Object.assign(s.overrides, props);
        store.context.requestPaint();
        store.commitUpdate(id, before);
      },
    };
  }
}

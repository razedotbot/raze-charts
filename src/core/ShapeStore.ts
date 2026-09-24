// Stores chart shapes. Programmatic lines from the app use `horizontal_line`;
// user drawings (left toolbar) add trend_line / fib / rectangle / text.
// The engine reads `list()` (z order, bottom first) to render; hit-test / drag
// mutates points and fires drawing_event.
//
// The store is the runtime gate for createShape/createMultipointShape: kinds
// are validated against a ShapeKindCatalog (built-ins plus TradingView
// aliases by default; the drawing-tool registry plugs in its own), points must
// be finite, match the kind's anchor count and carry a price unless the kind is
// time-only, and millisecond timestamps are converted to seconds with a
// warning. Nothing is accepted that would be saved but never painted, or
// painted somewhere the host did not ask for.

import type {
  AvailableZOrderOperations,
  BuiltinShapeName,
  CreateShapeOptions,
  DrawingEventType,
  EntityId,
  ILineDataSourceApi,
  ShapeErrorCode,
  ShapeKind,
  ShapeNameAlias,
  ShapePoint,
  ShapeProperties,
} from "../types/charting_library";
import type { DrawingAnchorSpec } from "../drawings/types";
import type { ChartContext } from "./context";
import type { CommandStack } from "./CommandStack";

export type { ShapeKind } from "../types/charting_library";

export interface StoredShape {
  id: EntityId;
  /** Canonical kind (aliases are resolved on create/load). A loaded layout may carry an unregistered custom id. */
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
  /** Integer paint order: larger paints later (on top) and hit-tests first. Authoritative. */
  z: number;
  /**
   * End of the stack the drawing was last sent to (createShape's `zOrder`,
   * bringToFront, sendToBack). Kept for layout snapshots and older readers;
   * `z` decides the actual order.
   */
  zOrder: "top" | "bottom";
  overrides: Record<string, unknown>;
}

/** A shape entering the store from a snapshot: `shape` may be an alias and `z` may be absent. */
export type ShapeRestoreInput = Omit<StoredShape, "shape" | "z"> & {
  shape: string;
  /** Absent in version-1 layouts: the shape is stacked on top, so loading in saved order keeps the order. */
  z?: number;
};

/** Options accepted by the store: like CreateShapeOptions, but `shape` is any string, checked at runtime. */
export type ShapeCreateInput = Pick<
  CreateShapeOptions,
  "text" | "lock" | "disableSelection" | "disableSave" | "disableUndo" | "showInObjectsTree" | "zOrder" | "overrides"
> & { shape?: string; [key: string]: unknown };

// ── Errors ──────────────────────────────────────────────────────────────────

/** Typed error for rejected shape calls; `code` is stable, the message carries guidance. */
export class ShapeError extends Error {
  override readonly name = "ShapeError";

  constructor(
    readonly code: ShapeErrorCode,
    message: string,
    /** Canonical kinds accepted by the store, for `E_SHAPE_KIND`. */
    readonly supported: readonly string[] = [],
  ) {
    super(`[raze-charts:${code}] ${message}`);
  }
}

// ── Kind catalog ────────────────────────────────────────────────────────────

/** What the store needs to know about one drawing kind. */
export interface ShapeKindInfo {
  /** Canonical id stored in snapshots. */
  readonly id: string;
  /** Anchor count, as declared by the drawing tool: the store enforces its minimum and maximum. */
  readonly anchors: DrawingAnchorSpec;
  /**
   * Whether every point must carry a finite price. Treated as true unless it
   * is `false`: a price-anchored drawing given a point without a price would
   * paint at the bottom edge of the pane. Only time-only kinds
   * (`vertical_line`) opt out.
   */
  readonly requiresPrice?: boolean;
}

/**
 * Resolves shape names for the store. Built-ins and TradingView aliases by
 * default; the drawing-tool registry supplies one that also knows host tools.
 * Lookups are live, so tools registered after the store exists are accepted.
 */
export interface ShapeKindCatalog {
  /** Kind info for a canonical id or an alias; undefined when unsupported. */
  resolve(name: string): ShapeKindInfo | undefined;
  /** Canonical ids, in display order, for error messages. */
  kinds(): readonly string[];
}

/** Minimal tool description a catalog is built from (a DrawingToolDefinition satisfies it). */
export interface ShapeToolDescriptor {
  readonly id: string;
  readonly anchors: DrawingAnchorSpec;
  readonly aliases?: readonly string[];
  /**
   * Set to `false` for a time-only tool whose points may omit the price.
   * Omitted, every point needs a price (built-in ids keep their own rule).
   */
  readonly requiresPrice?: boolean;
}

/** Built-in kinds with their anchor counts, in sidebar order. Every kind but vertical_line is price-anchored. */
export const BUILTIN_SHAPE_TOOLS: readonly (ShapeToolDescriptor & { readonly id: BuiltinShapeName })[] = Object.freeze([
  { id: "trend_line", anchors: 2 },
  { id: "horizontal_line", anchors: 1 },
  { id: "vertical_line", anchors: 1, requiresPrice: false },
  { id: "ray", anchors: 2 },
  { id: "extended_line", anchors: 2, aliases: ["extended"] },
  { id: "measure", anchors: 2, aliases: ["date_and_price_range"] },
  { id: "fib_retracement", anchors: 2 },
  { id: "rectangle", anchors: 2 },
  { id: "text", anchors: 1 },
] as const);

/** TradingView names mapped onto built-in kinds. */
export const SHAPE_NAME_ALIASES: Readonly<Record<ShapeNameAlias, BuiltinShapeName>> = Object.freeze({
  extended: "extended_line",
  date_and_price_range: "measure",
});

/**
 * Built-in ids whose points may omit the price. Kept by id so a catalog built
 * from tool definitions that do not declare `requiresPrice` (the drawing-tool
 * registry) still accepts a time-only vertical line.
 */
const TIME_ONLY_BUILTINS: ReadonlySet<string> = new Set(
  BUILTIN_SHAPE_TOOLS.filter((tool) => tool.requiresPrice === false).map((tool) => tool.id),
);

/** Index a tool list by canonical id and alias; aliases never shadow a canonical id. */
function indexTools(tools: Iterable<ShapeToolDescriptor>): { byName: Map<string, ShapeKindInfo>; kinds: readonly string[] } {
  const byName = new Map<string, ShapeKindInfo>();
  const aliases = new Map<string, ShapeKindInfo>();
  for (const tool of tools) {
    const requiresPrice = tool.requiresPrice ?? !TIME_ONLY_BUILTINS.has(tool.id);
    const info: ShapeKindInfo = { id: tool.id, anchors: tool.anchors, requiresPrice };
    byName.set(tool.id, info);
    for (const alias of tool.aliases ?? []) aliases.set(alias, info);
  }
  const kinds = Object.freeze(Array.from(byName.keys()));
  for (const [alias, info] of aliases) if (!byName.has(alias)) byName.set(alias, info);
  return { byName, kinds };
}

/** A live catalog over a tool list (read on every lookup); later entries win. */
export function createShapeKindCatalog(tools: () => Iterable<ShapeToolDescriptor>): ShapeKindCatalog {
  return {
    resolve: (name) => indexTools(tools()).byName.get(name),
    kinds: () => indexTools(tools()).kinds,
  };
}

/** The default catalog: built-in kinds plus TradingView aliases (indexed once; built-ins never change). */
export const builtinShapeCatalog: ShapeKindCatalog = (() => {
  const { byName, kinds } = indexTools(BUILTIN_SHAPE_TOOLS);
  return { resolve: (name) => byName.get(name), kinds: () => kinds };
})();

// ── Validation helpers ──────────────────────────────────────────────────────

/** Unix seconds past this are year 5138+; such values are millisecond timestamps. */
const MILLISECOND_THRESHOLD = 1e11;

const minAnchorCount = (spec: DrawingAnchorSpec): number => typeof spec === "number" ? spec : spec.min;
/** Most points a kind takes: its fixed count, or a free-form tool's `max` (unbounded when absent). */
const maxAnchorCount = (spec: DrawingAnchorSpec): number => typeof spec === "number" ? spec : spec.max ?? Infinity;

/** Kind info for a loaded drawing whose kind is not registered: kept as-is, so no count or price rule applies. */
const unknownKind = (id: string): ShapeKindInfo => ({ id, anchors: { min: 1, finish: "either" }, requiresPrice: false });

/** A non-null, non-array object: what `overrides` and `setProperties` accept. */
const isPropertyBag = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

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
      || a.z !== b.z
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

const byZ = (a: StoredShape, b: StoredShape): number => a.z - b.z;

export class ShapeStore {
  private shapes = new Map<EntityId, StoredShape>();
  /** Warnings already printed, so a loop of bad calls logs each problem once. */
  private readonly warned = new Set<string>();

  constructor(
    private readonly context: ChartContext,
    private readonly commands?: CommandStack,
    /** Accepted kinds; the drawing-tool registry passes a catalog that includes host tools. */
    readonly catalog: ShapeKindCatalog = builtinShapeCatalog,
  ) {}

  create(point: ShapePoint, options: ShapeCreateInput): Promise<EntityId> {
    return this.createPoints([point], options);
  }

  /**
   * Validate and add a drawing. Rejects with a ShapeError (and warns once on
   * the console, so a fire-and-forget call is never silent) when the kind is
   * unsupported, the points are unusable, or an option has the wrong type.
   */
  createPoints(points: ShapePoint[], options: ShapeCreateInput = {}): Promise<EntityId> {
    let kind: ShapeKindInfo;
    let normalized: ShapePoint[];
    try {
      kind = this.resolveKind(options.shape ?? "horizontal_line");
      normalized = this.normalizePoints(points, kind, "createShape");
      this.checkOptions(options);
    } catch (error) {
      if (error instanceof ShapeError) this.warnOnce(error.message, error.message);
      return Promise.reject(error);
    }
    const id = this.context.ids.next("shape", { isTaken: (candidate) => this.shapes.has(candidate as EntityId) }) as EntityId;
    const bottom = options.zOrder === "bottom";
    const stored: StoredShape = {
      id,
      shape: kind.id as ShapeKind,
      points: normalized,
      text: options.text ?? "",
      lock: options.lock ?? false,
      disableSelection: options.disableSelection ?? false,
      disableSave: options.disableSave ?? false,
      disableUndo: options.disableUndo ?? false,
      showInObjectsTree: options.showInObjectsTree !== false,
      hidden: false,
      z: bottom ? this.minZ() - 1 : this.maxZ() + 1,
      zOrder: bottom ? "bottom" : "top",
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

  /** Every drawing in paint order: ascending z, insertion order among equal z. */
  list(): StoredShape[] {
    return Array.from(this.shapes.values()).sort(byZ);
  }

  /**
   * Put a shape back (undo/redo, gesture cancel, layout load). Aliases are
   * resolved; an unknown kind is kept (so a later save does not lose it) with
   * a console warning. A shape without `z` is stacked on top.
   */
  restore(shape: ShapeRestoreInput, index?: number, event?: DrawingEventType): void {
    const current = this.shapes.get(shape.id);
    const existed = current !== undefined;
    this.context.ids.reserve("shape", String(shape.id));
    const kind = this.catalog.resolve(shape.shape);
    if (!kind) {
      this.warnOnce(
        `restore:${shape.shape}`,
        `[raze-charts] drawing ${String(shape.id)} uses the unsupported kind "${shape.shape}"; it is kept for saving but not painted. ${this.supportedText()}`,
      );
    }
    const z = typeof shape.z === "number" && Number.isSafeInteger(shape.z)
      ? shape.z
      : current?.z ?? this.maxZ() + 1;
    const restored = cloneShape({ ...shape, shape: (kind?.id ?? shape.shape) as ShapeKind, z });
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

  // ── Z order ───────────────────────────────────────────────────────────────

  /** Which z-order moves would change `id`'s position. */
  availableZOrderOperations(id: EntityId): AvailableZOrderOperations {
    const order = this.list();
    const index = order.findIndex((shape) => shape.id === id);
    if (index < 0) throw this.notFound(id);
    const canRise = index < order.length - 1;
    const canSink = index > 0;
    return {
      bringForwardEnabled: canRise,
      bringToFrontEnabled: canRise,
      sendBackwardEnabled: canSink,
      sendToBackEnabled: canSink,
    };
  }

  /**
   * Move `id` to `position` in paint order (`front`, `back`, or one step
   * `forward`/`backward`). One undo step and one properties_changed event per
   * drawing whose z changed; a move that changes nothing records nothing.
   */
  reorder(id: EntityId, position: "front" | "back" | "forward" | "backward"): void {
    const shape = this.shapes.get(id);
    if (!shape) throw this.notFound(id);
    const order = this.list();
    const from = order.indexOf(shape);
    const last = order.length - 1;
    const to = position === "front" ? last
      : position === "back" ? 0
        : position === "forward" ? Math.min(last, from + 1)
          : Math.max(0, from - 1);
    if (to === from) return;
    order.splice(from, 1);
    order.splice(to, 0, shape);

    const before = new Map<EntityId, StoredShape>();
    const assign = (target: StoredShape, z: number): void => {
      if (target.z === z) return;
      if (!before.has(target.id)) before.set(target.id, cloneShape(target));
      target.z = z;
    };
    const below = order[to - 1];
    const above = order[to + 1];
    if (!above) assign(shape, below!.z + 1);
    else if (!below) assign(shape, above.z - 1);
    else if (above.z - below.z >= 2) assign(shape, below.z + 1);
    else order.forEach((target, index) => assign(target, index)); // no integer gap: renumber the stack
    if (position === "front" || position === "back") {
      const zOrder = position === "front" ? "top" : "bottom";
      if (shape.zOrder !== zOrder) {
        if (!before.has(shape.id)) before.set(shape.id, cloneShape(shape));
        shape.zOrder = zOrder;
      }
    }
    this.commitMany(before);
  }

  /** Commit several in-place edits as one undo step, firing properties_changed for each. */
  private commitMany(before: Map<EntityId, StoredShape>): void {
    if (!before.size) return;
    const pairs = Array.from(before.values()).map((snapshot) => ({
      before: snapshot,
      after: cloneShape(this.shapes.get(snapshot.id)!),
    }));
    this.context.requestPaint();
    for (const pair of pairs) this.context.drawingEvent.fire(pair.before.id as unknown as string, "properties_changed");
    this.commands?.push({
      undo: () => { for (const pair of pairs) this.restore(pair.before, undefined, "properties_changed"); },
      redo: () => { for (const pair of pairs) this.restore(pair.after, undefined, "properties_changed"); },
    });
  }

  private maxZ(): number {
    let max = -1;
    for (const shape of this.shapes.values()) if (shape.z > max) max = shape.z;
    return max;
  }

  private minZ(): number {
    let min = 1;
    for (const shape of this.shapes.values()) if (shape.z < min) min = shape.z;
    return min;
  }

  // ── Validation ────────────────────────────────────────────────────────────

  private supportedText(): string {
    const aliases = Object.entries(SHAPE_NAME_ALIASES)
      .filter(([alias]) => this.catalog.resolve(alias))
      .map(([alias, target]) => `${alias} -> ${target}`);
    return `Supported kinds: ${this.catalog.kinds().join(", ")}${aliases.length ? ` (TradingView aliases: ${aliases.join(", ")})` : ""}.`;
  }

  private resolveKind(name: unknown): ShapeKindInfo {
    const kind = typeof name === "string" ? this.catalog.resolve(name) : undefined;
    if (!kind) {
      throw new ShapeError(
        "E_SHAPE_KIND",
        `unsupported shape ${JSON.stringify(name)}. ${this.supportedText()} Register a drawing tool to add a kind.`,
        this.catalog.kinds(),
      );
    }
    return kind;
  }

  /** Copy and check points: the kind's anchor count, finite values, prices where anchored, seconds rather than milliseconds. */
  private normalizePoints(points: unknown, kind: ShapeKindInfo, method: string): ShapePoint[] {
    if (!Array.isArray(points)) {
      throw new ShapeError("E_SHAPE_POINTS", `${method} needs an array of { time, price } points`);
    }
    const needed = minAnchorCount(kind.anchors);
    const pointCount = (count: number): string => `${count} point${count === 1 ? "" : "s"}`;
    if (points.length < needed) {
      const hint = needed > 1 && method === "createShape" ? "; use createMultipointShape for multi-point kinds" : "";
      throw new ShapeError("E_SHAPE_POINTS", `${kind.id} needs ${pointCount(needed)}, got ${points.length}${hint}`);
    }
    const most = maxAnchorCount(kind.anchors);
    if (points.length > most) {
      // Extra points would be saved but never painted or hit-tested.
      throw new ShapeError(
        "E_SHAPE_POINTS",
        `${kind.id} takes ${most === needed ? "exactly" : "at most"} ${pointCount(most)}, got ${points.length}`,
      );
    }
    const needsPrice = kind.requiresPrice !== false;
    return points.map((raw: unknown, index) => {
      const point = raw as Partial<ShapePoint> | null;
      if (!point || typeof point !== "object") {
        throw new ShapeError("E_SHAPE_POINTS", `point ${index} must be an object like { time, price }`);
      }
      let time = point.time;
      if (typeof time !== "number" || !Number.isFinite(time)) {
        throw new ShapeError("E_SHAPE_POINTS", `point ${index} needs a finite time in Unix seconds (got ${String(time)})`);
      }
      if (point.price !== undefined && (typeof point.price !== "number" || !Number.isFinite(point.price))) {
        throw new ShapeError("E_SHAPE_POINTS", `point ${index} has a non-finite price (${String(point.price)})`);
      }
      if (needsPrice && point.price === undefined) {
        // TradingView's `channel` (take the bar's open/high/low/close) is named, not silently ignored.
        const hint = point.channel !== undefined ? `; \`channel\` is not supported, pass the bar's ${String(point.channel)} as price` : "";
        throw new ShapeError("E_SHAPE_POINTS", `${kind.id} needs a price on every point (point ${index} has none)${hint}`);
      }
      if (Math.abs(time) > MILLISECOND_THRESHOLD) {
        const seconds = Math.round(time / 1000);
        this.warnOnce(
          "milliseconds",
          `[raze-charts] shape point times are Unix seconds; ${time} looks like milliseconds and was converted to ${seconds}. Pass Math.floor(ms / 1000).`,
        );
        time = seconds;
      }
      return { ...point, time } as ShapePoint;
    });
  }

  private checkOptions(options: ShapeCreateInput): void {
    if (options.text !== undefined && typeof options.text !== "string") {
      throw new ShapeError("E_SHAPE_OPTION", `text must be a string (got ${typeof options.text})`);
    }
    if (options.zOrder !== undefined && options.zOrder !== "top" && options.zOrder !== "bottom") {
      throw new ShapeError("E_SHAPE_OPTION", `zOrder must be "top" or "bottom" (got ${JSON.stringify(options.zOrder)})`);
    }
    if (options.overrides !== undefined && !isPropertyBag(options.overrides)) {
      throw new ShapeError(
        "E_SHAPE_OPTION",
        `overrides must be an object of drawing properties (got ${Array.isArray(options.overrides) ? "an array" : String(options.overrides)})`,
      );
    }
  }

  private notFound(id: EntityId): ShapeError {
    return new ShapeError(
      "E_SHAPE_NOT_FOUND",
      `no drawing with id ${JSON.stringify(String(id))}; it was never created or has been removed`,
    );
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(message);
  }

  // ── Adapter ───────────────────────────────────────────────────────────────

  /** The getShapeById handle. Throws for unknown ids; its methods throw once the drawing is removed. */
  adapter(id: EntityId): ILineDataSourceApi {
    if (!this.shapes.has(id)) throw this.notFound(id);
    const store = this;
    const live = (): StoredShape => {
      const shape = store.shapes.get(id);
      if (!shape) throw store.notFound(id);
      return shape;
    };
    const edit = (apply: (shape: StoredShape) => void): void => {
      const shape = live();
      const before = cloneShape(shape);
      apply(shape);
      store.context.requestPaint();
      store.commitUpdate(id, before);
    };
    return {
      getPoints(): ShapePoint[] {
        return live().points.map((p) => ({ ...p }));
      },
      setPoints(points: ShapePoint[]): void {
        const shape = live();
        const kind = store.catalog.resolve(shape.shape) ?? unknownKind(shape.shape);
        const normalized = store.normalizePoints(points, kind, "setPoints");
        edit((s) => { s.points = normalized; });
      },
      setPriceLevel(price: number): void {
        const shape = live();
        if (typeof price !== "number" || !Number.isFinite(price)) {
          throw new ShapeError("E_SHAPE_POINTS", `setPriceLevel needs a finite price (got ${String(price)})`);
        }
        if (!shape.points[0]) {
          throw new ShapeError("E_SHAPE_POINTS", `drawing ${String(id)} has no point to set a price level on`);
        }
        edit((s) => { s.points[0]!.price = price; });
      },
      bringToFront: () => { live(); store.reorder(id, "front"); },
      bringForward: () => { live(); store.reorder(id, "forward"); },
      sendBackward: () => { live(); store.reorder(id, "backward"); },
      sendToBack: () => { live(); store.reorder(id, "back"); },
      availableZOrderOperations: () => store.availableZOrderOperations(id),
      getProperties(): ShapeProperties {
        const shape = live();
        return { ...shape.overrides, text: shape.text };
      },
      setProperties(props: ShapeProperties): void {
        live();
        if (!isPropertyBag(props)) {
          throw new ShapeError(
            "E_SHAPE_OPTION",
            `setProperties needs an object of drawing properties (got ${Array.isArray(props) ? "an array" : String(props)})`,
          );
        }
        // `text: undefined` (the `{ ...getProperties(), text: maybe }` idiom) leaves the label unchanged.
        const { text, ...overrides } = props;
        if (text !== undefined && typeof text !== "string") {
          throw new ShapeError("E_SHAPE_OPTION", `text must be a string (got ${typeof text})`);
        }
        edit((s) => {
          if (typeof text === "string") s.text = text;
          Object.assign(s.overrides, overrides);
        });
      },
    };
  }
}

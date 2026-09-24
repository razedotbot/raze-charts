// Drawings created through the chart API (createShape and friends).

// ── Shapes ──────────────────────────────────────────────────────────────────
export interface ShapePoint {
  time: number;
  price?: number;
  channel?: string;
}
export type ShapeStyle = string;
export type DrawingEventType = "click" | "move" | "remove" | "hide" | "show" | "create" | "points_changed" | "properties_changed";

export interface CreateShapeOptions<TOverrides extends object = Record<string, unknown>> {
  shape?: string;
  text?: string;
  lock?: boolean;
  disableSelection?: boolean;
  /** Keep the live drawing out of widget.save() layout snapshots. */
  disableSave?: boolean;
  /** Do not add this drawing's creation to undo history; later edits/removal remain undoable. */
  disableUndo?: boolean;
  showInObjectsTree?: boolean;
  zOrder?: "top" | "bottom";
  overrides?: TOverrides;
  [key: string]: unknown;
}

export interface ILineDataSourceApi {
  getPoints(): ShapePoint[];
  setPoints(points: ShapePoint[]): void;
  setPriceLevel?(price: number): void;
  bringToFront(): void;
  sendToBack(): void;
  getProperties(): Record<string, unknown>;
  setProperties(props: Record<string, unknown>): void;
}

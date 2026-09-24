// Trading primitives live outside ShapeStore: they are ephemeral broker state,
// not chart drawings. The store owns fluent adapters, callbacks, linked bracket
// orders, and the mutable prices used by paint + gesture layers.

import type {
  BracketOrderOptions,
  BracketOrderSnapshot,
  IBracketOrderAdapter,
  ITradingLineAdapter,
  TradingLineCallback,
  TradingLineEvent,
  TradingLineKind,
  TradingLineOptions,
  TradingLineSnapshot,
  TradingLineStatus,
  TradingLineStyle,
  TradingSide,
} from "../types/charting_library";
import type { ChartContext } from "./context";

export interface StoredTradingLine {
  id: string;
  kind: TradingLineKind;
  side: TradingSide;
  price: number;
  quantity: string;
  text: string;
  status: TradingLineStatus;
  editable: boolean;
  includeInAutoScale: boolean;
  groupId?: string;
  lineColor: string;
  lineStyle: TradingLineStyle;
  lineWidth: number;
  bodyBackgroundColor: string;
  bodyTextColor: string;
  quantityBackgroundColor: string;
  quantityTextColor: string;
  cancelButtonBackgroundColor: string;
  cancelButtonIconColor: string;
  tooltip: string;
  modifyTooltip: string;
  cancelTooltip: string;
  /** Host price grid for drag/keyboard moves; the symbol tick when absent. */
  priceStep?: number;
  onChange?: (event: TradingLineEvent) => void;
  callbacks: Partial<Record<TradingCallbackSlot, TradingCallbackBinding>>;
}

/** The adapter callbacks a trading line can carry. */
export type TradingCallbackSlot = "moving" | "move" | "modify" | "cancel";

/**
 * A registered adapter callback. The one-argument form runs with the adapter
 * as `this` and argument; TradingView's two-argument form runs with the
 * registered `data` as both.
 */
export type TradingCallbackBinding =
  | { readonly form: "adapter"; readonly callback: TradingLineCallback }
  | { readonly form: "data"; readonly data: unknown; readonly callback: (this: unknown, data: unknown) => void };

/** An exact price grid: on-grid prices are integer multiples of `numerator / denominator`. */
export interface PriceGrid {
  readonly numerator: number;
  readonly denominator: number;
}

interface BracketRecord {
  id: string;
  side: TradingSide;
  quantity: string;
  currency: string;
  entryId: string;
  stopLossId?: string;
  takeProfitId?: string;
  onChange?: BracketOrderOptions["onChange"];
  onCancel?: BracketOrderOptions["onCancel"];
}

const quantityText = (value: string | number | undefined): string => value == null ? "" : String(value);

/** Run a consumer callback without letting it break chart state, but never hide the failure. */
const safely = (label: string, callback: () => void): void => {
  try {
    callback();
  } catch (error) {
    console.error(`[raze-charts] trading line ${label} callback threw`, error);
  }
};

/** Tolerance, in grid units, for floating-point noise when flooring or ceiling onto the grid. */
const GRID_EPSILON = 1e-7;

/**
 * Validate a host price step and express it as an exact decimal fraction
 * (`0.25` -> 25/100), so on-grid prices are built from integers and one
 * correctly rounded division instead of accumulating float error.
 */
export function priceGridFromStep(step: number, source = "priceStep"): PriceGrid {
  if (typeof step !== "number" || !Number.isFinite(step) || step <= 0) {
    throw new TypeError(`[raze-charts] ${source} must be a positive finite number (got ${String(step)}), for example 0.25`);
  }
  let decimals = 0;
  while (decimals < 15 && Math.abs(Math.round(step * 10 ** decimals) - step * 10 ** decimals) > 1e-9 * 10 ** decimals) {
    decimals += 1;
  }
  const denominator = 10 ** decimals;
  return { numerator: Math.max(1, Math.round(step * denominator)), denominator };
}

const toGridUnits = (price: number, grid: PriceGrid): number => price * grid.denominator / grid.numerator;
// Integer * integer / integer: one correctly rounded division, so 10157 * 1 / 100 is exactly 101.57.
const fromGridUnits = (units: number, grid: PriceGrid): number => units * grid.numerator / grid.denominator;

/** The on-grid price nearest to `price`. */
export function roundToPriceGrid(price: number, grid: PriceGrid): number {
  return fromGridUnits(Math.round(toGridUnits(price, grid)), grid);
}

const KIND_LABEL: Record<TradingLineKind, string> = {
  order: "Order",
  position: "Position",
  "stop-loss": "SL",
  "take-profit": "TP",
};

export class TradingStore {
  private readonly lines = new Map<string, StoredTradingLine>();
  private readonly adapters = new Map<string, ITradingLineAdapter>();
  private readonly brackets = new Map<string, BracketRecord>();
  /** Price each line had when its current drag started, so a cancelled drag restores it exactly. */
  private readonly dragOrigins = new Map<string, number>();

  constructor(private readonly context: ChartContext) {}

  create(options: TradingLineOptions = {}, forcedKind?: TradingLineKind, groupId?: string): ITradingLineAdapter {
    const kind = forcedKind ?? options.kind ?? "order";
    const side = options.side ?? "buy";
    if (options.id != null && this.lines.has(options.id)) {
      throw new Error(`[raze-charts] duplicate trading line id: ${options.id}`);
    }
    const latest = this.context.bars[this.context.bars.length - 1]?.close ?? 0;
    const price = options.price ?? latest;
    if (!Number.isFinite(price)) throw new Error("[raze-charts] trading line price must be finite");
    if (options.priceStep !== undefined) priceGridFromStep(options.priceStep, "trading line priceStep");
    const id = options.id ?? this.nextId(kind.replace("-", "_"));
    if (options.id != null) this.context.ids.reserve("trading", id);
    const semanticColor = kind === "stop-loss"
      ? "#ef5350"
      : kind === "take-profit"
        ? "#26a69a"
        : side === "buy" ? "#2962ff" : "#f23645";
    const line: StoredTradingLine = {
      id,
      kind,
      side,
      price,
      quantity: quantityText(options.quantity),
      text: options.text ?? KIND_LABEL[kind],
      status: options.status ?? "working",
      editable: options.editable !== false,
      includeInAutoScale: options.includeInAutoScale !== false,
      groupId,
      lineColor: options.lineColor ?? semanticColor,
      lineStyle: options.lineStyle ?? (kind === "position" ? 0 : 2),
      lineWidth: Number.isFinite(options.lineWidth) ? Math.max(1, options.lineWidth!) : 1,
      bodyBackgroundColor: options.bodyBackgroundColor ?? semanticColor,
      bodyTextColor: options.bodyTextColor ?? "#ffffff",
      quantityBackgroundColor: options.quantityBackgroundColor ?? this.context.theme.paneBackground,
      quantityTextColor: options.quantityTextColor ?? this.context.theme.scaleText,
      cancelButtonBackgroundColor: options.cancelButtonBackgroundColor ?? semanticColor,
      cancelButtonIconColor: options.cancelButtonIconColor ?? "#ffffff",
      tooltip: options.tooltip ?? `${KIND_LABEL[kind]} at price`,
      modifyTooltip: options.modifyTooltip ?? `Modify ${KIND_LABEL[kind].toLowerCase()}`,
      cancelTooltip: options.cancelTooltip ?? `Cancel ${KIND_LABEL[kind].toLowerCase()}`,
      priceStep: options.priceStep,
      onChange: options.onChange,
      callbacks: {},
    };
    this.lines.set(id, line);
    const adapter = this.buildAdapter(id);
    this.adapters.set(id, adapter);
    this.context.tradingEvent.fire(this.snapshotLine(line), "create");
    this.context.requestPaint();
    return adapter;
  }

  createBracket(options: BracketOrderOptions): IBracketOrderAdapter {
    if (!Number.isFinite(options.entryPrice)) {
      throw new Error("[raze-charts] bracket entry price must be finite");
    }
    if (options.stopLossPrice != null && !Number.isFinite(options.stopLossPrice)) {
      throw new Error("[raze-charts] bracket stop-loss price must be finite");
    }
    if (options.takeProfitPrice != null && !Number.isFinite(options.takeProfitPrice)) {
      throw new Error("[raze-charts] bracket take-profit price must be finite");
    }
    if (options.priceStep !== undefined) priceGridFromStep(options.priceStep, "bracket priceStep");
    if (options.id != null && this.brackets.has(options.id)) {
      throw new Error(`[raze-charts] duplicate bracket id: ${options.id}`);
    }
    const id = options.id ?? this.nextId("bracket");
    const entryId = `${id}:entry`;
    const stopLossId = `${id}:sl`;
    const takeProfitId = `${id}:tp`;
    const requestedLineIds = [
      entryId,
      options.stopLossPrice == null ? null : stopLossId,
      options.takeProfitPrice == null ? null : takeProfitId,
    ].filter((lineId): lineId is string => lineId !== null);
    const duplicateLineId = requestedLineIds.find((lineId) => this.lines.has(lineId));
    if (duplicateLineId) {
      throw new Error(`[raze-charts] duplicate trading line id: ${duplicateLineId}`);
    }
    if (options.id != null) this.context.ids.reserve("trading", id);
    const common: TradingLineOptions = {
      side: options.side,
      quantity: options.quantity,
      editable: options.editable,
      includeInAutoScale: options.includeInAutoScale,
      priceStep: options.priceStep,
    };
    const exitSide: TradingSide = options.side === "buy" ? "sell" : "buy";
    const entry = this.create({
      ...common,
      id: entryId,
      price: options.entryPrice,
      text: options.entryText ?? (options.side === "buy" ? "Long" : "Short"),
    }, "position", id);
    let stopLoss = options.stopLossPrice == null ? undefined : this.create({
      ...common,
      side: exitSide,
      id: stopLossId,
      price: options.stopLossPrice,
      text: options.stopLossText ?? "Stop loss",
    }, "stop-loss", id);
    let takeProfit = options.takeProfitPrice == null ? undefined : this.create({
      ...common,
      side: exitSide,
      id: takeProfitId,
      price: options.takeProfitPrice,
      text: options.takeProfitText ?? "Take profit",
    }, "take-profit", id);
    const record: BracketRecord = {
      id,
      side: options.side,
      quantity: quantityText(options.quantity),
      currency: options.currency ?? "",
      entryId: entry.id,
      stopLossId: stopLoss?.id,
      takeProfitId: takeProfit?.id,
      onChange: options.onChange,
      onCancel: options.onCancel,
    };
    this.brackets.set(id, record);

    const adapter: IBracketOrderAdapter = {
      id,
      entry,
      get stopLoss() { return stopLoss; },
      get takeProfit() { return takeProfit; },
      setEntryPrice: (price) => {
        if (this.brackets.has(id)) entry.setPrice(price);
        return adapter;
      },
      setStopLossPrice: (price) => {
        if (!this.brackets.has(id)) return adapter;
        if (stopLoss && this.lines.has(stopLoss.id)) stopLoss.setPrice(price);
        else {
          stopLoss = this.create({ ...common, side: exitSide, id: stopLossId, price, text: options.stopLossText ?? "Stop loss" }, "stop-loss", id);
          record.stopLossId = stopLoss.id;
          const line = this.lines.get(stopLoss.id);
          if (line) this.emit(line, "moved", "api");
        }
        return adapter;
      },
      setTakeProfitPrice: (price) => {
        if (!this.brackets.has(id)) return adapter;
        if (takeProfit && this.lines.has(takeProfit.id)) takeProfit.setPrice(price);
        else {
          takeProfit = this.create({ ...common, side: exitSide, id: takeProfitId, price, text: options.takeProfitText ?? "Take profit" }, "take-profit", id);
          record.takeProfitId = takeProfit.id;
          const line = this.lines.get(takeProfit.id);
          if (line) this.emit(line, "moved", "api");
        }
        return adapter;
      },
      setQuantity: (quantity) => {
        if (!this.brackets.has(id)) return adapter;
        record.quantity = quantityText(quantity);
        entry.setQuantity(quantity);
        stopLoss?.setQuantity(quantity);
        takeProfit?.setQuantity(quantity);
        return adapter;
      },
      snapshot: () => this.snapshotBracket(record),
      remove: () => this.removeBracket(id),
    };
    this.context.requestPaint();
    return adapter;
  }

  get(id: string): StoredTradingLine | undefined {
    return this.lines.get(id);
  }

  adapter(id: string): ITradingLineAdapter | null {
    return this.adapters.get(id) ?? null;
  }

  list(): StoredTradingLine[] {
    return Array.from(this.lines.values());
  }

  autoScalePrices(): number[] {
    return this.list().filter((line) => line.includeInAutoScale && line.price > 0).map((line) => line.price);
  }

  /**
   * Move a line and publish the change. User moves land on the line's price
   * grid (`priceStep`, else the symbol's `minmov / pricescale`): a drag snaps
   * to the nearest step, and a keyboard nudge steps from the current price to
   * the next on-grid price in its direction (at least one step, so a coarse
   * `priceStep` never swallows a nudge). A release with no drag steps (a
   * click) or on the start price (a cancelled drag) keeps the price exactly,
   * and API prices are never rounded: the host is authoritative. Returns the
   * committed price, or NaN when the line no longer exists.
   */
  move(id: string, price: number, phase: "moving" | "moved", reason: "drag" | "keyboard" | "api"): number {
    const line = this.lines.get(id);
    if (!line) return Number.NaN;
    if (!Number.isFinite(price)) {
      throw new TypeError("[raze-charts] trading line price must be finite");
    }
    let next = price;
    if (reason === "keyboard") {
      next = this.nudgeTarget(line, price);
    } else if (reason === "drag") {
      const origin = this.dragOrigins.get(id);
      if (phase === "moving") {
        if (origin === undefined) this.dragOrigins.set(id, line.price);
        next = roundToPriceGrid(price, this.priceGrid(line));
      } else {
        // A release without drag steps (a click) or on the start price (a
        // cancelled drag) keeps the price exactly; only a real drag snaps.
        this.dragOrigins.delete(id);
        next = origin === undefined || price === origin ? price : roundToPriceGrid(price, this.priceGrid(line));
      }
    }
    line.price = next;
    this.emit(line, phase, reason);
    this.context.requestPaint();
    return next;
  }

  /** Size of one step on the grid drag and keyboard moves of `id` land on (NaN for unknown ids). */
  priceStep(id: string): number {
    const line = this.lines.get(id);
    if (!line) return Number.NaN;
    const grid = this.priceGrid(line);
    return grid.numerator / grid.denominator;
  }

  modify(id: string): void {
    const line = this.lines.get(id);
    if (!line) return;
    this.invoke(line, "modify");
    this.emit(line, "modified", "api");
  }

  cancel(id: string): void {
    const line = this.lines.get(id);
    if (!line) return;
    this.invoke(line, "cancel");
    line.status = "cancelled";
    this.emit(line, "cancelled", "cancel");
    if (line.groupId && this.brackets.has(line.groupId)) {
      const record = this.brackets.get(line.groupId)!;
      if (record.onCancel) safely("bracket onCancel", () => record.onCancel!(this.snapshotBracket(record)));
      this.removeBracket(line.groupId);
    } else {
      this.remove(id);
    }
  }

  remove(id: string): void {
    const line = this.lines.get(id);
    if (!line) return;
    this.lines.delete(id);
    this.adapters.delete(id);
    this.dragOrigins.delete(id);
    if (this.context.selectedTradingLineId === id) this.context.selectedTradingLineId = null;
    const bracket = line.groupId ? this.brackets.get(line.groupId) : undefined;
    if (bracket) {
      if (bracket.stopLossId === id) bracket.stopLossId = undefined;
      if (bracket.takeProfitId === id) bracket.takeProfitId = undefined;
    }
    this.emit(line, "removed", "api");
    this.context.requestPaint();
  }

  removeAll(): void {
    const ids = Array.from(this.lines.keys());
    for (const id of ids) this.remove(id);
    this.brackets.clear();
  }

  private removeBracket(id: string): void {
    const record = this.brackets.get(id);
    if (!record) return;
    this.brackets.delete(id);
    for (const lineId of [record.entryId, record.stopLossId, record.takeProfitId]) {
      if (lineId) this.remove(lineId);
    }
  }

  private emit(
    line: StoredTradingLine,
    type: TradingLineEvent["type"],
    reason: TradingLineEvent["reason"],
  ): void {
    const snapshot = this.snapshotLine(line);
    const event: TradingLineEvent = { type, reason, line: snapshot };
    if (line.onChange) safely("onChange", () => line.onChange!(event));
    if (type === "moving") this.invoke(line, "moving");
    if (type === "moved") this.invoke(line, "move");
    this.context.tradingEvent.fire(snapshot, type);
    if (line.groupId) {
      const record = this.brackets.get(line.groupId);
      if (record?.onChange) safely("bracket onChange", () => record.onChange!(this.snapshotBracket(record), event));
    }
  }

  /** Run one adapter callback in the form it was registered with. */
  private invoke(line: StoredTradingLine, slot: TradingCallbackSlot): void {
    const binding = line.callbacks[slot];
    const adapter = this.adapters.get(line.id);
    if (!binding || !adapter) return;
    const label = `on${slot[0]!.toUpperCase()}${slot.slice(1)}`;
    if (binding.form === "data") safely(label, () => binding.callback.call(binding.data, binding.data));
    else safely(label, () => binding.callback.call(adapter, adapter));
  }

  private nextId(label: string): string {
    return this.context.ids.next("trading", {
      label,
      isTaken: (candidate) => this.lines.has(candidate) || this.brackets.has(candidate),
    });
  }

  private priceGrid(line: StoredTradingLine): PriceGrid {
    if (line.priceStep !== undefined) return priceGridFromStep(line.priceStep, "trading line priceStep");
    const minmov = this.context.symbolInfo?.minmov;
    const pricescale = this.context.symbolInfo?.pricescale;
    return {
      numerator: typeof minmov === "number" && Number.isSafeInteger(minmov) && minmov > 0 ? minmov : 1,
      denominator: typeof pricescale === "number" && Number.isSafeInteger(pricescale) && pricescale > 0 ? pricescale : 100,
    };
  }

  /** Next on-grid price from the line's current price toward `requested`, by at least one step. */
  private nudgeTarget(line: StoredTradingLine, requested: number): number {
    const delta = requested - line.price;
    if (delta === 0) return line.price;
    const grid = this.priceGrid(line);
    const direction = delta > 0 ? 1 : -1;
    const steps = Math.max(1, Math.round(Math.abs(delta) * grid.denominator / grid.numerator));
    const current = toGridUnits(line.price, grid);
    const base = direction > 0 ? Math.floor(current + GRID_EPSILON) : Math.ceil(current - GRID_EPSILON);
    return fromGridUnits(base + direction * steps, grid);
  }

  private snapshotLine(line: StoredTradingLine): TradingLineSnapshot {
    return {
      id: line.id,
      kind: line.kind,
      side: line.side,
      price: line.price,
      quantity: line.quantity,
      text: line.text,
      status: line.status,
      editable: line.editable,
      groupId: line.groupId,
    };
  }

  private snapshotBracket(record: BracketRecord): BracketOrderSnapshot {
    const entryPrice = this.lines.get(record.entryId)?.price ?? 0;
    const stopLossPrice = record.stopLossId ? this.lines.get(record.stopLossId)?.price : undefined;
    const takeProfitPrice = record.takeProfitId ? this.lines.get(record.takeProfitId)?.price : undefined;
    const risk = stopLossPrice == null ? undefined : Math.abs(entryPrice - stopLossPrice);
    const reward = takeProfitPrice == null ? undefined : Math.abs(takeProfitPrice - entryPrice);
    return {
      id: record.id,
      side: record.side,
      quantity: record.quantity,
      currency: record.currency,
      entryPrice,
      stopLossPrice,
      takeProfitPrice,
      risk,
      reward,
      riskRewardRatio: risk && reward != null ? reward / risk : undefined,
    };
  }

  private buildAdapter(id: string): ITradingLineAdapter {
    const store = this;
    const mutate = (fn: (line: StoredTradingLine) => void): ITradingLineAdapter => {
      const line = store.lines.get(id);
      if (line) {
        fn(line);
        store.context.requestPaint();
      }
      return adapter;
    };
    // Parse before the line lookup so a malformed registration throws even on a removed line.
    const register = (slot: TradingCallbackSlot, method: string, args: readonly unknown[]): ITradingLineAdapter => {
      const binding = bindCallback(method, args);
      return mutate((line) => { line.callbacks[slot] = binding; });
    };
    const adapter: ITradingLineAdapter = {
      id,
      remove: () => store.remove(id),
      cancel: () => store.cancel(id),
      getPrice: () => store.lines.get(id)?.price ?? Number.NaN,
      setPrice: (price) => { store.move(id, price, "moved", "api"); return adapter; },
      getText: () => store.lines.get(id)?.text ?? "",
      setText: (text) => mutate((line) => { line.text = text; }),
      getQuantity: () => store.lines.get(id)?.quantity ?? "",
      setQuantity: (quantity) => mutate((line) => { line.quantity = quantityText(quantity); }),
      setEditable: (editable) => mutate((line) => { line.editable = editable; }),
      setLineColor: (color) => mutate((line) => { line.lineColor = color; }),
      setLineStyle: (style) => mutate((line) => { line.lineStyle = style; }),
      setLineWidth: (width) => mutate((line) => { if (Number.isFinite(width)) line.lineWidth = Math.max(1, width); }),
      setBodyBackgroundColor: (color) => mutate((line) => { line.bodyBackgroundColor = color; }),
      setBodyTextColor: (color) => mutate((line) => { line.bodyTextColor = color; }),
      setQuantityBackgroundColor: (color) => mutate((line) => { line.quantityBackgroundColor = color; }),
      setQuantityTextColor: (color) => mutate((line) => { line.quantityTextColor = color; }),
      setCancelButtonBackgroundColor: (color) => mutate((line) => { line.cancelButtonBackgroundColor = color; }),
      setCancelButtonIconColor: (color) => mutate((line) => { line.cancelButtonIconColor = color; }),
      setTooltip: (text) => mutate((line) => { line.tooltip = text; }),
      setModifyTooltip: (text) => mutate((line) => { line.modifyTooltip = text; }),
      setCancelTooltip: (text) => mutate((line) => { line.cancelTooltip = text; }),
      onMoving: (...args: unknown[]) => register("moving", "onMoving", args),
      onMove: (...args: unknown[]) => register("move", "onMove", args),
      onModify: (...args: unknown[]) => register("modify", "onModify", args),
      onCancel: (...args: unknown[]) => register("cancel", "onCancel", args),
    };
    return adapter;
  }
}

/**
 * Parse the arguments of onMoving/onMove/onModify/onCancel: `(callback)`, or
 * TradingView's `(data, callback)`. Anything else throws instead of storing a
 * value that would never run.
 */
function bindCallback(method: string, args: readonly unknown[]): TradingCallbackBinding {
  if (args.length >= 2) {
    const [data, callback] = args;
    if (typeof callback !== "function") {
      throw new TypeError(`[raze-charts] ${method}(data, callback) needs a function as its second argument`);
    }
    return { form: "data", data, callback: callback as (this: unknown, data: unknown) => void };
  }
  const [callback] = args;
  if (typeof callback !== "function") {
    throw new TypeError(
      `[raze-charts] ${method}() needs a callback function: ${method}(callback), or TradingView's ${method}(data, callback)`,
    );
  }
  return { form: "adapter", callback: callback as TradingLineCallback };
}

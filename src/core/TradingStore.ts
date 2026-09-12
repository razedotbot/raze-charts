// Trading primitives live outside ShapeStore: they are ephemeral broker state,
// not chart drawings. The store owns fluent adapters, callbacks, linked bracket
// orders, and the mutable prices used by paint + gesture layers.

import type {
  BracketOrderOptions,
  BracketOrderSnapshot,
  IBracketOrderAdapter,
  ITradingLineAdapter,
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
  onChange?: (event: TradingLineEvent) => void;
  callbacks: {
    moving?: (line: ITradingLineAdapter) => void;
    move?: (line: ITradingLineAdapter) => void;
    modify?: (line: ITradingLineAdapter) => void;
    cancel?: (line: ITradingLineAdapter) => void;
  };
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

let tradingCounter = 0;
const nextId = (prefix: string): string => `${prefix}_${++tradingCounter}`;
const quantityText = (value: string | number | undefined): string => value == null ? "" : String(value);
const safely = (callback: (() => void) | undefined): void => {
  try { callback?.(); } catch { /* consumer callbacks must not break chart state */ }
};

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

  constructor(private readonly context: ChartContext) {}

  create(options: TradingLineOptions = {}, forcedKind?: TradingLineKind, groupId?: string): ITradingLineAdapter {
    const kind = forcedKind ?? options.kind ?? "order";
    const side = options.side ?? "buy";
    const id = options.id ?? nextId(kind.replace("-", "_"));
    if (this.lines.has(id)) throw new Error(`[raze-charts] duplicate trading line id: ${id}`);
    const latest = this.context.bars[this.context.bars.length - 1]?.close ?? 0;
    const price = options.price ?? latest;
    if (!Number.isFinite(price)) throw new Error("[raze-charts] trading line price must be finite");
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
    const id = options.id ?? nextId("bracket");
    if (this.brackets.has(id)) throw new Error(`[raze-charts] duplicate bracket id: ${id}`);
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
    const common: TradingLineOptions = {
      side: options.side,
      quantity: options.quantity,
      editable: options.editable,
      includeInAutoScale: options.includeInAutoScale,
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

  move(id: string, price: number, phase: "moving" | "moved", reason: "drag" | "keyboard" | "api"): void {
    const line = this.lines.get(id);
    if (!line) return;
    if (!Number.isFinite(price)) {
      throw new TypeError("[raze-charts] trading line price must be finite");
    }
    line.price = price;
    this.emit(line, phase, reason);
    this.context.requestPaint();
  }

  modify(id: string): void {
    const line = this.lines.get(id);
    if (!line) return;
    const adapter = this.adapters.get(id);
    if (adapter && line.callbacks.modify) safely(() => line.callbacks.modify!.call(adapter, adapter));
    this.emit(line, "modified", "api");
  }

  cancel(id: string): void {
    const line = this.lines.get(id);
    if (!line) return;
    const adapter = this.adapters.get(id);
    if (adapter && line.callbacks.cancel) safely(() => line.callbacks.cancel!.call(adapter, adapter));
    line.status = "cancelled";
    this.emit(line, "cancelled", "cancel");
    if (line.groupId && this.brackets.has(line.groupId)) {
      const record = this.brackets.get(line.groupId)!;
      if (record.onCancel) safely(() => record.onCancel!(this.snapshotBracket(record)));
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
    if (line.onChange) safely(() => line.onChange!(event));
    const adapter = this.adapters.get(line.id);
    if (adapter) {
      if (type === "moving" && line.callbacks.moving) safely(() => line.callbacks.moving!.call(adapter, adapter));
      if (type === "moved" && line.callbacks.move) safely(() => line.callbacks.move!.call(adapter, adapter));
    }
    this.context.tradingEvent.fire(snapshot, type);
    if (line.groupId) {
      const record = this.brackets.get(line.groupId);
      if (record?.onChange) safely(() => record.onChange!(this.snapshotBracket(record), event));
    }
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
      onMoving: (callback) => mutate((line) => { line.callbacks.moving = callback; }),
      onMove: (callback) => mutate((line) => { line.callbacks.move = callback; }),
      onModify: (callback) => mutate((line) => { line.callbacks.modify = callback; }),
      onCancel: (callback) => mutate((line) => { line.callbacks.cancel = callback; }),
    };
    return adapter;
  }
}

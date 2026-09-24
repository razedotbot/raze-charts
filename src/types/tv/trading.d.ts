// Trading primitives: order, position and bracket lines, shaped after
// TradingView's trading primitives.

// ── Trading primitives ────────────────────────────────────────────────────
export type TradingSide = "buy" | "sell";
export type TradingLineKind = "order" | "position" | "stop-loss" | "take-profit";
export type TradingLineStatus = "working" | "filled" | "cancelled";
export type TradingLineStyle = 0 | 1 | 2;

export interface TradingLineSnapshot {
  id: string;
  kind: TradingLineKind;
  side: TradingSide;
  price: number;
  quantity: string;
  text: string;
  status: TradingLineStatus;
  editable: boolean;
  groupId?: string;
}

export interface TradingLineEvent {
  type: "moving" | "moved" | "modified" | "cancelled" | "removed";
  reason: "drag" | "keyboard" | "api" | "cancel";
  line: TradingLineSnapshot;
}

export interface TradingLineOptions {
  id?: string;
  kind?: TradingLineKind;
  side?: TradingSide;
  /** Defaults to the latest close, allowing TradingView-style create-then-configure usage. */
  price?: number;
  /**
   * Price grid for drag and keyboard moves, for example `0.25` for a futures
   * contract. Defaults to the symbol tick (`minmov / pricescale`). Must be a
   * positive finite number. Prices set through the API are never rounded.
   */
  priceStep?: number;
  quantity?: string | number;
  text?: string;
  status?: TradingLineStatus;
  editable?: boolean;
  includeInAutoScale?: boolean;
  lineColor?: string;
  lineStyle?: TradingLineStyle;
  lineWidth?: number;
  bodyBackgroundColor?: string;
  bodyTextColor?: string;
  quantityBackgroundColor?: string;
  quantityTextColor?: string;
  cancelButtonBackgroundColor?: string;
  cancelButtonIconColor?: string;
  tooltip?: string;
  modifyTooltip?: string;
  cancelTooltip?: string;
  onChange?: (event: TradingLineEvent) => void;
}

/** Fluent order/position line adapter, shaped after TradingView's trading primitives. */
export interface ITradingLineAdapter {
  readonly id: string;
  remove(): void;
  /** Trigger the same cancellation lifecycle as the on-chart × control. */
  cancel(): void;
  getPrice(): number;
  setPrice(price: number): this;
  getText(): string;
  setText(text: string): this;
  getQuantity(): string;
  setQuantity(quantity: string | number): this;
  setEditable(editable: boolean): this;
  setLineColor(color: string): this;
  setLineStyle(style: TradingLineStyle): this;
  setLineWidth(width: number): this;
  setBodyBackgroundColor(color: string): this;
  setBodyTextColor(color: string): this;
  setQuantityBackgroundColor(color: string): this;
  setQuantityTextColor(color: string): this;
  setCancelButtonBackgroundColor(color: string): this;
  setCancelButtonIconColor(color: string): this;
  setTooltip(text: string): this;
  setModifyTooltip(text: string): this;
  setCancelTooltip(text: string): this;
  /** Runs on every drag step; `this` and the argument are the adapter. */
  onMoving(callback: TradingLineCallback): this;
  /** TradingView form: the callback runs with `this === data` and receives `data`. */
  onMoving<TData>(data: TData, callback: TradingLineDataCallback<TData>): this;
  /** Runs when a move is committed (drag release, keyboard nudge, setPrice). */
  onMove(callback: TradingLineCallback): this;
  onMove<TData>(data: TData, callback: TradingLineDataCallback<TData>): this;
  /** Runs when the line is clicked (read-only lines) or double-clicked. */
  onModify(callback: TradingLineCallback): this;
  onModify<TData>(data: TData, callback: TradingLineDataCallback<TData>): this;
  /** Runs before the line is cancelled from its × control, Delete, or cancel(). */
  onCancel(callback: TradingLineCallback): this;
  onCancel<TData>(data: TData, callback: TradingLineDataCallback<TData>): this;
}

/** One-argument trading callback: `this` and the argument are the line adapter. */
export type TradingLineCallback = (this: ITradingLineAdapter, line: ITradingLineAdapter) => void;
/** Two-argument (TradingView) trading callback: `this` and the argument are the registered data. */
export type TradingLineDataCallback<TData> = (this: TData, data: TData) => void;

export interface BracketOrderOptions {
  id?: string;
  side: TradingSide;
  entryPrice: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  quantity?: string | number;
  currency?: string;
  editable?: boolean;
  includeInAutoScale?: boolean;
  /** Price grid for dragging or nudging every leg; defaults to the symbol tick. */
  priceStep?: number;
  entryText?: string;
  stopLossText?: string;
  takeProfitText?: string;
  onChange?: (bracket: BracketOrderSnapshot, event: TradingLineEvent) => void;
  onCancel?: (bracket: BracketOrderSnapshot) => void;
}

export interface BracketOrderSnapshot {
  id: string;
  side: TradingSide;
  quantity: string;
  currency: string;
  entryPrice: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  risk?: number;
  reward?: number;
  riskRewardRatio?: number;
}

export interface IBracketOrderAdapter {
  readonly id: string;
  readonly entry: ITradingLineAdapter;
  readonly stopLoss?: ITradingLineAdapter;
  readonly takeProfit?: ITradingLineAdapter;
  setEntryPrice(price: number): this;
  setStopLossPrice(price: number): this;
  setTakeProfitPrice(price: number): this;
  setQuantity(quantity: string | number): this;
  snapshot(): BracketOrderSnapshot;
  remove(): void;
}

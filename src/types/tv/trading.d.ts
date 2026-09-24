/**
 * Trading primitives: order, position and bracket lines.
 *
 * Shaped after TradingView's trading primitives. Re-exported by
 * src/types/charting_library.d.ts.
 */

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
  onMoving(callback: (line: ITradingLineAdapter) => void): this;
  onMove(callback: (line: ITradingLineAdapter) => void): this;
  onModify(callback: (line: ITradingLineAdapter) => void): this;
  onCancel(callback: (line: ITradingLineAdapter) => void): this;
}

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

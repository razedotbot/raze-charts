// The widget: its interface, header buttons, and the runtime `widget`
// constructor and `version` exports.

import type { EntityId, ResolutionString } from "./common";
import type { IChartWidgetApi } from "./chart-api";
import type { ContextMenuCallback } from "./context-menu";
import type { ChartLayoutSnapshot } from "./layout";
import type { ChartingLibraryWidgetOptions } from "./options";
import type { DrawingEventType } from "./shapes";
import type { TradingLineEvent, TradingLineSnapshot } from "./trading";

// ── Header button ───────────────────────────────────────────────────────────
export interface CreateButtonOptions {
  align?: "left" | "right";
  useTradingViewStyle?: boolean;
  title?: string;
}

// ── Widget events ───────────────────────────────────────────────────────────
/** Payload of the `error` widget event. */
export interface WidgetListenerError {
  /** Stable error code: a listener registered by host code threw. */
  readonly code: "listener_threw";
  /** The event or subscription whose listener threw, e.g. `drawing_event` or `onIntervalChanged`. */
  readonly event: string;
  /** What the listener threw. */
  readonly cause: unknown;
}

/** `trading_event` types: a line was created, or a TradingLineEvent occurred. */
export type TradingEventType = "create" | TradingLineEvent["type"];

/**
 * Events `widget.subscribe` delivers. Any other name throws with this list.
 * A listener that throws is logged as `[raze-charts] <event> listener threw`,
 * reported through `error`, and never stops the other listeners.
 */
export interface WidgetEventMap {
  drawing_event: (id: EntityId, type: DrawingEventType) => void;
  trading_event: (line: TradingLineSnapshot, type: TradingEventType) => void;
  error: (error: WidgetListenerError) => void;
}

export type WidgetEventName = keyof WidgetEventMap;

// ── Widget ──────────────────────────────────────────────────────────────────
export interface IChartingLibraryWidget {
  onChartReady(callback: () => void): void;
  headerReady(): Promise<void>;
  activeChart(): IChartWidgetApi;
  chart(index?: number): IChartWidgetApi;
  createButton(options?: CreateButtonOptions): HTMLElement;
  setCSSCustomProperty(customPropertyName: string, value: string): void;
  subscribe<E extends WidgetEventName>(event: E, callback: WidgetEventMap[E]): void;
  unsubscribe<E extends WidgetEventName>(event: E, callback: WidgetEventMap[E]): void;
  onContextMenu(callback: ContextMenuCallback): void;
  setSymbol(symbol: string, interval: ResolutionString, callback?: () => void): void;
  remove(): void;
  save(callback?: (state: ChartLayoutSnapshot) => void): ChartLayoutSnapshot;
  load(state: ChartLayoutSnapshot): Promise<void>;
}

// ── The widget constructor (runtime export) ─────────────────────────────────
export declare class widget implements IChartingLibraryWidget {
  constructor(options: ChartingLibraryWidgetOptions);
  onChartReady(callback: () => void): void;
  headerReady(): Promise<void>;
  activeChart(): IChartWidgetApi;
  chart(index?: number): IChartWidgetApi;
  createButton(options?: CreateButtonOptions): HTMLElement;
  setCSSCustomProperty(customPropertyName: string, value: string): void;
  subscribe<E extends WidgetEventName>(event: E, callback: WidgetEventMap[E]): void;
  unsubscribe<E extends WidgetEventName>(event: E, callback: WidgetEventMap[E]): void;
  onContextMenu(callback: ContextMenuCallback): void;
  setSymbol(symbol: string, interval: ResolutionString, callback?: () => void): void;
  remove(): void;
  save(callback?: (state: ChartLayoutSnapshot) => void): ChartLayoutSnapshot;
  load(state: ChartLayoutSnapshot): Promise<void>;
}

export declare const version: string;

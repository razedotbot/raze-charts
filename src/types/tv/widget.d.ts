/**
 * The widget: its interface, header buttons, context menu hooks and the
 * runtime `widget` constructor and `version` exports. Re-exported by
 * src/types/charting_library.d.ts.
 */

import type { ResolutionString } from "./common";
import type { IChartWidgetApi } from "./chart-api";
import type { ChartLayoutSnapshot } from "./layout";
import type { ChartingLibraryWidgetOptions } from "./options";
import type { DrawingEventType } from "./shapes";

// ── Context menu ────────────────────────────────────────────────────────────
export interface ContextMenuItem {
  position: "top" | "bottom";
  text: string;
  click: () => void;
}
export type ContextMenuCallback = (unixTime: number, price: number) => ContextMenuItem[] | Promise<ContextMenuItem[]>;

// ── Header button ───────────────────────────────────────────────────────────
export interface CreateButtonOptions {
  align?: "left" | "right";
  useTradingViewStyle?: boolean;
  title?: string;
}

// ── Widget ──────────────────────────────────────────────────────────────────
export interface IChartingLibraryWidget {
  onChartReady(callback: () => void): void;
  headerReady(): Promise<void>;
  activeChart(): IChartWidgetApi;
  chart(index?: number): IChartWidgetApi;
  createButton(options?: CreateButtonOptions): HTMLElement;
  setCSSCustomProperty(customPropertyName: string, value: string): void;
  subscribe(event: DrawingEventType | string, callback: (...args: never[]) => void): void;
  unsubscribe(event: string, callback: (...args: never[]) => void): void;
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
  subscribe(event: DrawingEventType | string, callback: (...args: never[]) => void): void;
  unsubscribe(event: string, callback: (...args: never[]) => void): void;
  onContextMenu(callback: ContextMenuCallback): void;
  setSymbol(symbol: string, interval: ResolutionString, callback?: () => void): void;
  remove(): void;
  save(callback?: (state: ChartLayoutSnapshot) => void): ChartLayoutSnapshot;
  load(state: ChartLayoutSnapshot): Promise<void>;
}

export declare const version: string;

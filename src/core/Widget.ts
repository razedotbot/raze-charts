// The widget — the top-level object the app constructs via `new widget(opts)`.
//
// A thin IChartingLibraryWidget facade: all state lives in one private
// WidgetRuntime (./widget/runtime.ts), which composes the controllers
// registered in ./widget/controllers.ts (chrome, layout, API, events,
// actions, compare, persistence, context menu) around the data manager,
// stores, engine and renderer. Only the documented methods below are
// reachable at runtime; the runtime is held in a #private field.

import type {
  ChartingLibraryWidgetOptions,
  ChartLayoutSnapshot,
  ContextMenuCallback,
  CreateButtonOptions,
  IChartingLibraryWidget,
  IChartWidgetApi,
  ResolutionString,
} from "../types/charting_library";
import { WidgetRuntime } from "./widget/runtime";

export class Widget implements IChartingLibraryWidget {
  readonly #runtime: WidgetRuntime;

  constructor(options: ChartingLibraryWidgetOptions) {
    this.#runtime = new WidgetRuntime(options, (childOptions) => {
      const child = new Widget(childOptions);
      return { widget: child, host: child.#runtime };
    });
  }

  onChartReady(callback: () => void): void {
    this.#runtime.lifecycle.onChartReady(callback);
  }

  headerReady(): Promise<void> {
    return this.#runtime.lifecycle.headerReady();
  }

  activeChart(): IChartWidgetApi {
    return this.#runtime.controllers.api.api;
  }

  chart(index?: number): IChartWidgetApi {
    return this.#runtime.controllers.layout.chart(index) ?? this.activeChart();
  }

  createButton(options?: CreateButtonOptions): HTMLElement {
    return this.#runtime.controllers.chrome.createButton(options);
  }

  setCSSCustomProperty(name: string, value: string): void {
    this.#runtime.controllers.chrome.root.style.setProperty(name, value);
  }

  subscribe(event: string, callback: (...args: never[]) => void): void {
    this.#runtime.controllers.events.subscribe(event, callback);
  }

  unsubscribe(event: string, callback: (...args: never[]) => void): void {
    this.#runtime.controllers.events.unsubscribe(event, callback);
  }

  onContextMenu(callback: ContextMenuCallback): void {
    this.#runtime.controllers.contextMenu.onContextMenu(callback);
  }

  setSymbol(symbol: string, interval: ResolutionString, callback?: () => void): void {
    this.#runtime.lifecycle.changeSymbol(symbol, interval, callback);
  }

  save(callback?: (state: ChartLayoutSnapshot) => void): ChartLayoutSnapshot {
    return this.#runtime.controllers.persistence.save(callback);
  }

  load(state: ChartLayoutSnapshot): Promise<void> {
    return this.#runtime.controllers.persistence.load(state);
  }

  remove(): void {
    this.#runtime.remove();
  }
}

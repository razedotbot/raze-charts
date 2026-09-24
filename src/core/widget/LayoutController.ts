// Multi-chart layouts (`raze.layout` "2x1" / "2x2"): the pane grid, one
// child widget per extra cell, and viewport + crosshair sync across panes.

import type { IChartWidgetApi } from "../../types/charting_library";
import type { ChildWidget, WidgetController, WidgetHost } from "./host";

declare module "./host" {
  interface WidgetControllerMap {
    layout: LayoutController;
  }
}

export class LayoutController implements WidgetController {
  /** One cell per chart; a single-chart widget uses the chart area itself. */
  readonly panes: HTMLDivElement[];
  /** The cell hosting this widget's own engine. */
  readonly primary: HTMLDivElement;
  private children: ChildWidget[] = [];
  private syncing = false;

  constructor(private readonly host: WidgetHost) {
    this.panes = this.preparePanes(host.controllers.chrome.chartArea);
    this.primary = this.panes[0]!;
  }

  private preparePanes(chartArea: HTMLDivElement): HTMLDivElement[] {
    const raze = this.host.options.raze;
    const layout = raze?.layout;
    const cells = raze?.layout_child ? 1 : layout === "2x2" ? 4 : layout === "2x1" ? 2 : 1;
    if (cells <= 1) return [chartArea];
    chartArea.style.display = "grid";
    chartArea.style.gridTemplateRows = "1fr 1fr";
    chartArea.style.gridTemplateColumns = layout === "2x2" ? "1fr 1fr" : "1fr";
    const panes: HTMLDivElement[] = [];
    for (let index = 0; index < cells; index++) {
      const pane = document.createElement("div");
      pane.className = "raze-chart-layout-pane";
      pane.dataset.paneIndex = String(index);
      pane.style.cssText = "position:relative;min-width:0;min-height:0;overflow:hidden;";
      chartArea.appendChild(pane);
      panes.push(pane);
    }
    return panes;
  }

  boot(): void {
    this.spawnChildren();
    this.wireSync();
  }

  /** The API of layout chart `index` (1-based children), or null for the primary chart. */
  chart(index?: number): IChartWidgetApi | null {
    const child = index ? this.children[index - 1] : undefined;
    return child ? child.widget.activeChart() : null;
  }

  private spawnChildren(): void {
    const { context, options } = this.host;
    const symbols = options.raze?.layout_symbols ?? [];
    for (let i = 1; i < this.panes.length; i++) {
      this.children.push(this.host.spawnChild({
        ...options,
        container: this.panes[i]!,
        symbol: symbols[i] ?? context.symbol,
        disabled_features: [
          ...(options.disabled_features ?? []),
          "header_widget",
          "left_toolbar",
        ],
        raze: {
          ...options.raze,
          layout: "1",
          layout_child: true,
        },
      }));
    }
  }

  private wireSync(): void {
    if (!this.children.length) return;
    const lifecycle = this.host.lifecycle;
    const hosts = [this.host, ...this.children.map((child) => child.host)];
    for (const pane of hosts) {
      pane.context.viewportChanged.subscribe(null, ((range: { from: number; to: number }) => {
        if (this.syncing) return;
        this.syncing = true;
        const updates = hosts
          .filter((other) => other !== pane)
          .map((other) => other.data.revealTimeRange(range.from, range.to));
        void Promise.allSettled(updates).then((results) => {
          for (const result of results) {
            if (result.status === "rejected" && !lifecycle.destroyed) {
              lifecycle.reportError("synchronise chart layout", result.reason);
            }
          }
        }).finally(() => {
          this.syncing = false;
        });
      }) as never);
      pane.context.crosshairMoved.subscribe(null, ((ev: { unixTime: number; price: number; active: boolean }) => {
        if (this.syncing) return;
        this.syncing = true;
        for (const other of hosts) {
          if (other === pane) continue;
          other.context.syncedCrosshair = ev;
          other.context.requestPaint();
        }
        this.syncing = false;
      }) as never);
    }
  }

  destroy(): void {
    for (const child of this.children) child.widget.remove();
    this.children = [];
  }
}

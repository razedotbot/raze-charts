// Multi-chart layouts (`raze.layout` "2x1" / "2x2"): the pane grid, one
// child widget per extra cell, and interval, time-range and crosshair sync
// across panes (`raze.layout_sync`, all on by default like TradingView).

import type { IChartWidgetApi, ResolutionString } from "../../types/charting_library";
import type { ChildWidget, WidgetController, WidgetHost } from "./host";
import { resolveLayoutSync } from "./options";

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
  /** Delegate subscription owner, so teardown detaches every sync listener. */
  private readonly syncOwner = {};
  private rangeSyncing = false;
  private crosshairSyncing = false;
  /** Interval every pane is being moved to; echoes of it are not re-broadcast. */
  private syncedInterval: string | null = null;

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
        // Children start at the interval the primary chart has now, which may
        // differ from the constructor option after an early setResolution().
        interval: context.resolution,
        // Children fill their grid cell; the parent owns the page size.
        autosize: true,
        fullscreen: false,
        width: undefined,
        height: undefined,
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
    const sync = resolveLayoutSync(this.host.options.raze?.layout_sync);
    const hosts = [this.host, ...this.children.map((child) => child.host)];
    if (sync.time) this.wireTimeSync(hosts);
    if (sync.crosshair) this.wireCrosshairSync(hosts);
    if (sync.interval) this.wireIntervalSync(hosts);
  }

  /** Scrolling or zooming one pane reveals the same time window in the others. */
  private wireTimeSync(hosts: readonly WidgetHost[]): void {
    const lifecycle = this.host.lifecycle;
    for (const pane of hosts) {
      pane.context.viewportChanged.subscribe(this.syncOwner, ((range: { from: number; to: number }) => {
        if (this.rangeSyncing) return;
        this.rangeSyncing = true;
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
          this.rangeSyncing = false;
        });
      }) as never);
    }
  }

  /** The crosshair is mirrored; the source symbol lets painters sync the price line only between equal symbols. */
  private wireCrosshairSync(hosts: readonly WidgetHost[]): void {
    for (const pane of hosts) {
      pane.context.crosshairMoved.subscribe(this.syncOwner, ((ev: { unixTime: number; price: number; active: boolean }) => {
        if (this.crosshairSyncing) return;
        this.crosshairSyncing = true;
        try {
          const synced = { ...ev, symbol: pane.context.symbol };
          for (const other of hosts) {
            if (other === pane) continue;
            other.context.syncedCrosshair = synced;
            other.context.requestOverlayPaint();
          }
        } finally {
          this.crosshairSyncing = false;
        }
      }) as never);
    }
  }

  /**
   * An interval change on any pane (header or API) moves every other pane to
   * it. Each pane's own data change fires its `onIntervalChanged`; those
   * echoes carry the synced interval and are not broadcast again.
   */
  private wireIntervalSync(hosts: readonly WidgetHost[]): void {
    this.syncedInterval = String(this.host.context.resolution);
    for (const pane of hosts) {
      pane.context.intervalChanged.subscribe(this.syncOwner, ((resolution: ResolutionString) => {
        const target = String(resolution);
        if (target === this.syncedInterval || this.host.lifecycle.destroyed) return;
        this.syncedInterval = target;
        // Always request the change: a pane whose committed resolution already
        // matches may still be loading another interval, and the data layer
        // treats a request for the interval it is already on as a no-op.
        for (const other of hosts) {
          if (other === pane || other.lifecycle.destroyed) continue;
          other.lifecycle.changeResolution(target as ResolutionString);
        }
      }) as never);
    }
  }

  destroy(): void {
    const hosts = [this.host, ...this.children.map((child) => child.host)];
    for (const pane of hosts) {
      pane.context.viewportChanged.unsubscribeAll(this.syncOwner);
      pane.context.crosshairMoved.unsubscribeAll(this.syncOwner);
      pane.context.intervalChanged.unsubscribeAll(this.syncOwner);
    }
    for (const child of this.children) child.widget.remove();
    this.children = [];
  }
}

// Mounts the DOM legend (src/ui/Legend.ts) in the engine's overlay host and
// routes the legend painter to it. Removal from the legend goes through the
// study store, so it lands on the widget's undo stack like any other removal.

import type { EntityId } from "../../types/charting_library";
import { attachLegendView } from "../../engine/paint/legend";
import { Legend } from "../../ui/Legend";
import type { WidgetController, WidgetHost } from "./host";

declare module "./host" {
  interface WidgetControllerMap {
    legend: LegendController;
  }
}

/** How often the market-status dot is re-evaluated while nothing repaints. */
const STATUS_REFRESH_MS = 30_000;

export class LegendController implements WidgetController {
  private legend: Legend | null = null;
  private detach: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly host: WidgetHost) {}

  attach(): void {
    const { context, engine, studies, commands } = this.host;
    if (!context.features.has("legend_widget")) return;
    const legend = new Legend(engine.overlayHost, {
      remove: (id) => studies.remove(id as EntityId),
      undo: () => {
        commands.undo();
        context.requestPaint();
      },
      redo: () => {
        commands.redo();
        context.requestPaint();
      },
      announce: (message) => engine.announce(message),
      focusChart: () => engine.canvas.focus({ preventScroll: true }),
    });
    this.legend = legend;
    this.detach = attachLegendView(context, legend);
    // A session can open or close without a tick; refresh the status dot.
    this.timer = setInterval(() => {
      const session = context.symbolInfo?.session;
      if (session && !/^24x7$/i.test(session)) context.requestOverlayPaint();
    }, STATUS_REFRESH_MS);
  }

  destroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.detach?.();
    this.detach = null;
    this.legend?.destroy();
    this.legend = null;
  }
}

// Widget events for the drawing UI state:
//   drawing_selection_changed (ids: string[])  the selected drawings changed
//   drawing_tool_changed      (tool: string)   the active drawing tool changed
// The context fields are observed rather than each writer instrumented, so
// pointer, keyboard, sidebar, objects-tree, store and API writers are all
// covered and every effective change emits exactly one event.

import type { ChartContext } from "../context";
import type { WidgetController, WidgetHost } from "./host";

declare module "./host" {
  interface WidgetControllerMap {
    drawingEvents: DrawingEventsController;
  }
}

/** Replace a plain context field with an accessor that reports effective changes. */
function observe<K extends "selectedShapeId" | "drawingTool">(
  context: ChartContext,
  key: K,
  onChange: (value: ChartContext[K]) => void,
): void {
  let value = context[key];
  Object.defineProperty(context, key, {
    configurable: true,
    enumerable: true,
    get: () => value,
    set(next: ChartContext[K]) {
      if (Object.is(next, value)) return;
      value = next;
      onChange(next);
    },
  });
}

export class DrawingEventsController implements WidgetController {
  constructor(private readonly host: WidgetHost) {}

  attach(): void {
    const { context, controllers } = this.host;
    observe(context, "selectedShapeId", (id) => controllers.events.emit("drawing_selection_changed", id ? [id] : []));
    observe(context, "drawingTool", (tool) => controllers.events.emit("drawing_tool_changed", tool));
  }
}

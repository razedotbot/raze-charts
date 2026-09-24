// Widget events for the drawing UI state:
//   drawing_selection_changed (ids: string[])  the selected drawings changed
//   drawing_tool_changed      (tool: string)   the active drawing tool changed
// The context fields are observed rather than each writer instrumented, so
// pointer, keyboard, sidebar, objects-tree, store and API writers are all
// covered and every effective change emits exactly one event.
//
// TEMPORARY SHIM (see docs/seams.md): the fields are swapped for accessors on
// the shared context at attach and put back as plain data properties on
// destroy. It goes away once context.ts fires change delegates from its own
// setters (`selectionChanged`, `toolChanged`); this controller then only
// subscribes to them.

import type { ChartContext } from "../context";
import type { WidgetController, WidgetHost } from "./host";

declare module "./host" {
  interface WidgetControllerMap {
    drawingEvents: DrawingEventsController;
  }
}

type ObservedKey = "selectedShapeId" | "drawingTool";

/**
 * Wrap a context field in an accessor that reports effective changes, and
 * return the function that restores it. An accessor the context already
 * defines is delegated to (never shadowed) and restored as it was; a plain
 * field comes back as a plain data property holding its current value.
 */
function observe<K extends ObservedKey>(
  context: ChartContext,
  key: K,
  onChange: (value: ChartContext[K]) => void,
): () => void {
  const own = Object.getOwnPropertyDescriptor(context, key);
  if (own && !own.configurable) {
    console.warn(`[raze-charts] context.${key} cannot be observed (non-configurable); drawing_${key === "drawingTool" ? "tool" : "selection"}_changed will not fire.`);
    return () => {};
  }
  let value = context[key];
  const read = (): ChartContext[K] => (own?.get ? own.get.call(context) : value);
  const write = (next: ChartContext[K]): void => {
    if (own?.set) own.set.call(context, next);
    else value = next;
  };
  const get = (): ChartContext[K] => read();
  Object.defineProperty(context, key, {
    configurable: true,
    enumerable: own?.enumerable ?? true,
    get,
    set(next: ChartContext[K]) {
      const previous = read();
      write(next);
      const current = read();
      if (!Object.is(previous, current)) onChange(current);
    },
  });
  return () => {
    // Leave the field alone if something redefined it after us.
    if (Object.getOwnPropertyDescriptor(context, key)?.get !== get) return;
    if (own?.get || own?.set) Object.defineProperty(context, key, own);
    else Object.defineProperty(context, key, { configurable: true, enumerable: own?.enumerable ?? true, writable: true, value: read() });
  };
}

export class DrawingEventsController implements WidgetController {
  private restore: Array<() => void> = [];

  constructor(private readonly host: WidgetHost) {}

  attach(): void {
    const { context, controllers } = this.host;
    this.restore = [
      observe(context, "selectedShapeId", (id) => controllers.events.emit("drawing_selection_changed", id ? [id] : [])),
      observe(context, "drawingTool", (tool) => controllers.events.emit("drawing_tool_changed", tool)),
    ];
  }

  destroy(): void {
    for (const restore of this.restore.splice(0)) restore();
  }
}

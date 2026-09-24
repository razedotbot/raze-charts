// `executeActionById` and the undo/redo keyboard shortcuts on the chart canvas.

import type { WidgetController, WidgetHost } from "./host";

declare module "./host" {
  interface WidgetControllerMap {
    actions: ActionController;
  }
}

const VOLUME_MODES = ["overlay", "pane", "hidden"] as const;

export class ActionController implements WidgetController {
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const key = e.key.toLowerCase();
    if (key !== "z" && key !== "y") return;
    e.preventDefault();
    const { commands, context } = this.host;
    if (key === "z" && !e.shiftKey) commands.undo();
    else commands.redo();
    context.requestPaint();
  };

  constructor(private readonly host: WidgetHost) {}

  boot(): void {
    this.host.engine.canvas.addEventListener("keydown", this.onKeyDown);
  }

  executeActionById(actionId: string): void {
    const { commands, context } = this.host;
    if (actionId === "undo") commands.undo();
    else if (actionId === "redo") commands.redo();
    else if (actionId === "magnet") context.magnet = !context.magnet;
    else if (actionId === "stay_in_drawing_mode") context.stayInDrawingMode = !context.stayInDrawingMode;
    else if (actionId === "objects_tree") {
      const { leftSidebar, objectsTree } = this.host.controllers.chrome;
      const button = leftSidebar?.el.querySelector('[aria-label="Objects tree"]');
      if (button instanceof HTMLElement) objectsTree?.toggle(button);
    } else if (actionId === "volume_pane") {
      const index = VOLUME_MODES.indexOf(context.volumeMode);
      context.volumeMode = VOLUME_MODES[(index + 1) % VOLUME_MODES.length]!;
    }
    context.requestPaint();
  }

  destroy(): void {
    this.host.engine.canvas.removeEventListener("keydown", this.onKeyDown);
  }
}

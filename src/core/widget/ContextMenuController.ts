// `onContextMenu`: right-click on the chart area asks the consumer for items
// (sync or async) at the clicked time/price. Only the newest request may open,
// and Escape or a pointer press cancels a pending async request.

import type { ContextMenuCallback } from "../../types/charting_library";
import { closeContextMenu, showContextMenu } from "../../ui/ContextMenu";
import type { WidgetController, WidgetHost } from "./host";

declare module "./host" {
  interface WidgetControllerMap {
    contextMenu: ContextMenuController;
  }
}

type MenuItems = Awaited<ReturnType<ContextMenuCallback>>;

export class ContextMenuController implements WidgetController {
  private callback: ContextMenuCallback | null = null;
  private requestId = 0;
  private pendingCleanup: (() => void) | null = null;

  constructor(private readonly host: WidgetHost) {}

  attach(): void {
    this.host.controllers.chrome.chartArea.addEventListener("contextmenu", (e) => this.open(e));
  }

  onContextMenu(callback: ContextMenuCallback): void {
    this.requestId += 1;
    this.cancelPending();
    closeContextMenu();
    this.callback = callback;
  }

  private open(e: MouseEvent): void {
    const { context, lifecycle, renderer } = this.host;
    // Touch long-press is the crosshair gesture — suppress the native menu.
    if (renderer.lastPointerType !== "mouse") {
      e.preventDefault();
      return;
    }
    if (!this.callback) return;
    e.preventDefault();
    closeContextMenu();
    this.cancelPending();
    const requestId = ++this.requestId;
    const { unixTime, price } = renderer.timePriceAtEvent(e);
    let result: ReturnType<ContextMenuCallback>;
    try {
      result = this.callback(unixTime, price);
    } catch (error) {
      lifecycle.reportError("open context menu", error);
      return;
    }
    const root = this.host.controllers.chrome.root;
    const show = (items: MenuItems): void => {
      if (lifecycle.destroyed || requestId !== this.requestId || !root.isConnected) return;
      showContextMenu(e.clientX, e.clientY, Array.isArray(items) ? items : [], context.fontFamily, root);
    };
    if (!result || typeof (result as PromiseLike<unknown>).then !== "function") {
      show(result as MenuItems);
      return;
    }
    const cancelRequest = (): void => {
      if (requestId === this.requestId) this.requestId += 1;
      cleanup();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") cancelRequest();
    };
    const cleanup = (): void => {
      document.removeEventListener("pointerdown", cancelRequest, true);
      document.removeEventListener("keydown", onKey, true);
      if (this.pendingCleanup === cleanup) this.pendingCleanup = null;
    };
    document.addEventListener("pointerdown", cancelRequest, true);
    document.addEventListener("keydown", onKey, true);
    this.pendingCleanup = cleanup;
    void Promise.resolve(result).then((items) => {
      cleanup();
      show(items);
    }).catch((error: unknown) => {
      cleanup();
      if (!lifecycle.destroyed && requestId === this.requestId) {
        lifecycle.reportError("open context menu", error);
      }
    });
  }

  private cancelPending(): void {
    this.pendingCleanup?.();
    this.pendingCleanup = null;
  }

  destroy(): void {
    this.requestId += 1;
    this.cancelPending();
    closeContextMenu();
  }
}

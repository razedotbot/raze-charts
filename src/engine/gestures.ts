// Pointer / pinch / keyboard coordinator for the finance widget. It owns the
// canvas listeners and routes each gesture to the interaction handlers
// registered in ./interaction/handlers.ts (run by priority). The active drag
// lives in ./interaction/session.ts; pan, zoom, axis, drawing and trading
// behaviour live in ./interaction/*.

import { pointerXY, timePriceAt, zoneAt } from "./interaction/coords";
import { hitTestAt } from "./interaction/hitTest";
import { leaveHover, trackCrosshair, updateHover } from "./interaction/hover";
import { KeyboardFocus } from "./interaction/keyboard";
import { firstHandled } from "./interaction/registry";
import { DragTracker } from "./interaction/session";
import { hideCanvasTooltip } from "./interaction/tooltip";
import { TouchGestures } from "./interaction/touch";
import type { GestureHost, PointerInput } from "./interaction/types";

export type { GestureHost } from "./interaction/types";

type Binding = [EventTarget, string, (e: never) => void, AddEventListenerOptions?];

export class GestureController {
  private readonly drag: DragTracker;
  private readonly touch: TouchGestures;
  private readonly focus: KeyboardFocus;
  private readonly bindings: Binding[];

  constructor(private readonly host: GestureHost) {
    this.drag = new DragTracker(host);
    this.touch = new TouchGestures(host, () => this.drag.drop());
    this.focus = new KeyboardFocus(host);
    const canvas = host.canvas;
    const input = (e: MouseEvent): PointerInput => this.input(e, pointerXY(host, e));
    this.bindings = [
      [canvas, "pointermove", (e: PointerEvent) => this.onPointerMove(e)],
      [canvas, "pointerdown", (e: PointerEvent) => this.onPointerDown(e)],
      [window, "pointerup", (e: PointerEvent) => this.onPointerUp(e)],
      [canvas, "pointercancel", () => this.onPointerCancel()],
      [canvas, "pointerleave", (e: PointerEvent) => {
        if (e.pointerType === "mouse") leaveHover(host, this.drag.busy);
      }],
      [canvas, "wheel", (e: WheelEvent) => {
        const i = input(e);
        firstHandled((handler) => handler.wheel?.(host, i, e));
      }, { passive: false }],
      [canvas, "dblclick", (e: MouseEvent) => {
        const i = input(e);
        hitTestAt(host, i.x, i.y, i.zone, 1);
        firstHandled((handler) => handler.dblClick?.(host, i, e));
      }],
      [canvas, "keydown", (e: KeyboardEvent) => this.focus.dispatch(e)],
      [canvas, "focus", this.focus.onFocus],
      [canvas, "blur", this.focus.onBlur],
      [canvas, "selectstart", (e: Event) => e.preventDefault()],
    ];
  }

  attach(): void {
    const canvas = this.host.canvas;
    canvas.style.touchAction = "none";
    canvas.style.outline = "none";
    for (const [target, type, fn, options] of this.bindings) target.addEventListener(type, fn as EventListener, options);
    canvas.tabIndex = 0;
  }

  destroy(): void {
    this.touch.clearLongPress();
    this.drag.cancel();
    hideCanvasTooltip(this.host);
    for (const [target, type, fn] of this.bindings) target.removeEventListener(type, fn as EventListener);
    this.focus.onBlur();
  }

  pointerXY(e: MouseEvent): { x: number; y: number } {
    return pointerXY(this.host, e);
  }

  timePriceAt(x: number, y: number): { unixTime: number; price: number } {
    return timePriceAt(this.host, x, y);
  }

  private input(e: MouseEvent, { x, y }: { x: number; y: number }): PointerInput {
    return { x, y, pointerType: (e as PointerEvent).pointerType || "mouse", zone: zoneAt(this.host, x, y) };
  }

  private onPointerMove(e: PointerEvent): void {
    const h = this.host;
    if (this.drag.busy || this.touch.pinch) e.preventDefault();
    const { x, y } = pointerXY(h, e);
    const tracked = this.touch.track(e.pointerId, x, y);
    if (this.touch.updatePinch()) return h.requestPaint();
    this.touch.trackMove(x, y);
    if (this.touch.crosshair && tracked) {
      h.crosshair = { x, y, active: true };
      return h.requestPaint();
    }
    const input = this.input(e, { x, y });
    const mouse = e.pointerType === "mouse";
    if (mouse) trackCrosshair(h, input);
    if (this.drag.busy) this.drag.move(x, y);
    else if (mouse) updateHover(h, input);
    h.requestPaint();
  }

  private onPointerDown(e: PointerEvent): void {
    const h = this.host;
    h.lastPointerType = e.pointerType || "mouse";
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const point = pointerXY(h, e);
    this.focus.focusFromPointer();
    hideCanvasTooltip(h);
    this.touch.pointers.set(e.pointerId, point);
    try { h.canvas.setPointerCapture?.(e.pointerId); } catch { /* detached/test env */ }
    window.getSelection?.()?.removeAllRanges();
    if (this.touch.pointers.size === 2) {
      // A second contact turns the interaction into a pinch. Roll back any
      // partially applied one-pointer drag first so shapes/orders and their
      // host callbacks cannot be left between lifecycle phases.
      this.drag.cancel();
      return this.touch.startPinch();
    }
    const input = this.input(e, point);
    hitTestAt(h, input.x, input.y, input.zone, e.pointerType === "mouse" ? 1 : 2);
    this.touch.press(input.x, input.y, e.pointerType);
    const result = firstHandled((handler) => handler.pointerDown?.(h, input));
    if (typeof result === "object") this.drag.start(result);
  }

  private onPointerUp(e: PointerEvent): void {
    const pointers = this.touch.pointers;
    pointers.delete(e.pointerId);
    this.touch.clearLongPress();
    if (this.touch.pinch && pointers.size < 2) {
      this.touch.pinch = null;
      this.drag.drop();
    }
    if (pointers.size === 0) {
      this.drag.end();
      this.touch.crosshair = false;
    }
  }

  private onPointerCancel(): void {
    this.touch.reset();
    this.drag.cancel();
    this.host.requestPaint();
  }
}

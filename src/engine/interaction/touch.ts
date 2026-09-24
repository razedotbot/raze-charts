// Multi-touch gestures: two-finger pinch zoom anchored at the midpoint, and
// the long-press that turns a touch into a crosshair probe.

import { applyRange } from "./limits";
import type { GestureHost } from "./types";
import { zoomAround } from "./viewport";

interface PinchState {
  startSpanPx: number;
  start: { from: number; to: number };
  /** Plot fraction under the finger midpoint. */
  anchor: number;
}

const LONG_PRESS_MS = 300;
const LONG_PRESS_SLOP_PX = 8;

export class TouchGestures {
  /** Active contacts by pointer id, in canvas CSS pixels. */
  readonly pointers = new Map<number, { x: number; y: number }>();
  pinch: PinchState | null = null;
  /** True after a long press: touch moves drive the crosshair instead of panning. */
  crosshair = false;
  private longPressTimer: number | null = null;
  private longPressStart = { x: 0, y: 0 };

  /** `onLongPress` drops the pending one-finger drag when the crosshair engages. */
  constructor(
    private readonly host: GestureHost,
    private readonly onLongPress: () => void,
  ) {}

  /** Update a tracked contact; false when the pointer is not pressed. */
  track(pointerId: number, x: number, y: number): boolean {
    const tracked = this.pointers.get(pointerId);
    if (tracked) {
      tracked.x = x;
      tracked.y = y;
    }
    return !!tracked;
  }

  /** A single contact went down: hide a stale crosshair and arm the long press. */
  press(x: number, y: number, pointerType: string): void {
    const h = this.host;
    if (pointerType === "mouse") return;
    if (h.crosshair.active && !this.crosshair) {
      h.crosshair.active = false;
      h.requestPaint();
    }
    if (h.context.drawingTool === "cursor" && !h.hoverShapeId && !h.hoverTradingLineId) {
      this.armLongPress(x, y);
    }
  }

  /** A second contact turns the gesture into a pinch anchored at the midpoint. */
  startPinch(): void {
    const h = this.host;
    this.clearLongPress();
    this.crosshair = false;
    const pts = Array.from(this.pointers.values());
    const a = pts[0]!;
    const b = pts[1]!;
    this.pinch = {
      startSpanPx: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)),
      start: { ...h.context.visibleRange },
      anchor: ((a.x + b.x) / 2 - h.plotL) / h.plotW,
    };
  }

  /** Apply a pinch move; false when no pinch is active. */
  updatePinch(): boolean {
    if (!this.pinch || this.pointers.size < 2) return false;
    const pts = Array.from(this.pointers.values());
    const spanPx = Math.max(10, Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y));
    zoomAround(this.host, this.pinch.anchor, this.pinch.startSpanPx / spanPx, "pinch", this.pinch.start);
    return true;
  }

  /** Restore the range the pinch started from. */
  cancelPinch(): void {
    if (!this.pinch) return;
    applyRange(this.host, this.pinch.start, "cancel");
    this.pinch = null;
  }

  /** Pointer cancel: drop every contact, restore a pinch and leave crosshair mode. */
  reset(): void {
    this.clearLongPress();
    this.cancelPinch();
    this.pointers.clear();
    this.crosshair = false;
  }

  private armLongPress(x: number, y: number): void {
    this.clearLongPress();
    this.longPressStart = { x, y };
    this.longPressTimer = window.setTimeout(() => {
      this.longPressTimer = null;
      this.crosshair = true;
      this.onLongPress();
      this.host.crosshair = { x: this.longPressStart.x, y: this.longPressStart.y, active: true };
      this.host.requestPaint();
    }, LONG_PRESS_MS);
  }

  /** A pending long press is abandoned once the finger travels past the slop. */
  trackMove(x: number, y: number): void {
    if (this.longPressTimer != null
        && Math.hypot(x - this.longPressStart.x, y - this.longPressStart.y) > LONG_PRESS_SLOP_PX) {
      this.clearLongPress();
    }
  }

  clearLongPress(): void {
    if (this.longPressTimer != null) {
      window.clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }
}

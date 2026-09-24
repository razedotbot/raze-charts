// Canvas keyboard focus: a guaranteed high-contrast ring for keyboard focus,
// no ring for pointer focus, and key dispatch to the interaction handlers.

import { firstHandled } from "./registry";
import type { GestureHost } from "./types";

export class KeyboardFocus {
  /** True while focus came from a pointer so the UA/keyboard ring stays off. */
  private pointerFocus = false;

  constructor(private readonly host: GestureHost) {}

  readonly onFocus = (): void => {
    if (this.pointerFocus) this.hideRing();
    else this.showRing();
  };

  readonly onBlur = (): void => {
    this.pointerFocus = false;
    this.hideRing();
  };

  /** Focus the canvas for a pointer press without showing the keyboard ring. */
  focusFromPointer(): void {
    this.pointerFocus = true;
    this.host.canvas.focus({ preventScroll: true });
    // Pointer focus should not masquerade as keyboard focus. A subsequent key
    // press restores the guaranteed high-contrast ring.
    this.hideRing();
  }

  showRing(): void {
    const canvas = this.host.canvas;
    canvas.style.outline = `2px solid ${this.host.context.theme.scaleText}`;
    canvas.style.outlineOffset = "-2px";
  }

  hideRing(): void {
    const canvas = this.host.canvas;
    // Keep outline:none so the UA orange :focus-visible ring cannot return.
    canvas.style.outline = "none";
    canvas.style.removeProperty("outline-offset");
  }

  /** Route a key press on the canvas to the first handler that consumes it. */
  dispatch(e: KeyboardEvent): void {
    if (e.target !== this.host.canvas) return;
    this.showRing();
    firstHandled((handler) => handler.keyDown?.(this.host, e));
  }
}

// Overlay stack. Dialogs, popovers and sheets register while open so focus
// trapping and outside-dismissal can respect overlays stacked above them
// (for example a colour popover opened from a settings dialog).

import { composedContains } from "./dom";

export interface Layer {
  /** Outermost element of the overlay (portal or surface). */
  readonly el: Element;
  readonly modal: boolean;
}

const stack: Layer[] = [];

/** Register an open overlay. Returns the matching removal function. */
export function pushLayer(layer: Layer): () => void {
  stack.push(layer);
  return () => {
    const index = stack.indexOf(layer);
    if (index >= 0) stack.splice(index, 1);
  };
}

/** Whether `node` lives inside an overlay opened after `layer`. */
export function isInLayerAbove(layer: Layer, node: Node | null): boolean {
  const index = stack.indexOf(layer);
  if (index < 0 || !node) return false;
  for (let above = index + 1; above < stack.length; above++) {
    if (composedContains(stack[above]!.el, node)) return true;
  }
  return false;
}

/** Whether `layer` is the top-most open overlay. */
export function isTopLayer(layer: Layer): boolean {
  return stack[stack.length - 1] === layer;
}

/** Number of open overlays (diagnostics and tests). */
export function openLayerCount(): number {
  return stack.length;
}

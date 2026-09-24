// Hover tooltip for canvas targets (timescale-mark badges, trading lines).
// It renders in the chart's overlay layer instead of the canvas `title`
// attribute: themed, placed next to the target inside the chart, linked to
// the canvas with aria-describedby while visible, and never intercepting the
// pointer.

import { adoptStyles, defineStyles, type StyleChunk } from "../../ui/styles";
import type { GestureHost } from "./types";

const CLASS = "raze-chart-canvas-tooltip";

export const CANVAS_TOOLTIP_STYLES: StyleChunk = /* @__PURE__ */ defineStyles(
  "canvas-tooltip",
  `.${CLASS}{position:absolute;z-index:3;max-width:320px;padding:5px 8px;border-radius:var(--raze-radius-sm,4px);` +
  "background:var(--raze-tooltip-background,#e0e3eb);color:var(--raze-tooltip-text,#131722);font-size:12px;line-height:1.35;" +
  "white-space:pre-line;box-shadow:var(--raze-shadow,none);pointer-events:none}" +
  `@media (forced-colors:active){.${CLASS}{border:1px solid}}`,
);

let sequence = 0;
const tips = new WeakMap<GestureHost, HTMLDivElement>();

/** Add or remove `id` from the canvas's aria-describedby list. */
function describe(canvas: HTMLElement, id: string, on: boolean): void {
  const ids = (canvas.getAttribute("aria-describedby") ?? "").split(" ").filter((value) => value && value !== id);
  if (on) ids.push(id);
  if (ids.length) canvas.setAttribute("aria-describedby", ids.join(" "));
  else canvas.removeAttribute("aria-describedby");
}

/** Show `text` centred above canvas point (x, y), or below it when there is no room. Empty text hides it. */
export function showCanvasTooltip(host: GestureHost, text: string, x: number, y: number): void {
  const parent = host.context.overlayHost;
  if (!text || !parent) return hideCanvasTooltip(host);
  let tip = tips.get(host);
  if (!tip) {
    tip = parent.ownerDocument.createElement("div");
    tip.className = CLASS;
    tip.id = `${CLASS}-${++sequence}`;
    tip.setAttribute("role", "tooltip");
    tips.set(host, tip);
  }
  adoptStyles(parent, CANVAS_TOOLTIP_STYLES);
  parent.appendChild(tip);
  tip.textContent = text;
  const above = y - tip.offsetHeight - 12;
  tip.style.left = `${Math.max(4, Math.min(x - tip.offsetWidth / 2, (parent.clientWidth || Infinity) - tip.offsetWidth - 4))}px`;
  tip.style.top = `${above < 4 ? y + 18 : above}px`;
  describe(host.canvas, tip.id, true);
}

export function hideCanvasTooltip(host: GestureHost): void {
  const tip = tips.get(host);
  if (!tip?.isConnected) return;
  tip.remove();
  describe(host.canvas, tip.id, false);
}

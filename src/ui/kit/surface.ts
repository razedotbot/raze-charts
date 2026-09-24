// Shared visual primitives for kit overlays: the raised surface, buttons and
// icons. Icons are built with createElementNS, so no markup sink is involved.

import { defineStyles, type StyleChunk } from "../styles";

export const SURFACE_STYLES: StyleChunk = /* @__PURE__ */ defineStyles(
  "kit-surface",
  ".raze-kit-surface{background:var(--raze-surface,#1e222d);color:var(--raze-text,#d1d4dc);" +
  "border:1px solid var(--raze-border,#363a45);border-radius:var(--raze-radius,6px);box-shadow:var(--raze-shadow);outline:none}" +
  ".raze-kit-surface:focus-visible{outline:2px solid var(--raze-focus,#2962ff);outline-offset:-2px}" +
  ".raze-kit-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:0 14px;" +
  "border:1px solid var(--raze-border,#363a45);border-radius:var(--raze-radius,6px);background:transparent;color:inherit;" +
  "font:inherit;font-weight:500;cursor:pointer;white-space:nowrap;touch-action:manipulation;" +
  "transition:background-color var(--raze-duration,160ms),border-color var(--raze-duration,160ms)}" +
  ".raze-kit-button:hover{background:var(--raze-hover,rgba(255,255,255,.08))}" +
  ".raze-kit-button:focus{outline:none}" +
  ".raze-kit-button:focus-visible{outline:2px solid var(--raze-focus,#2962ff);outline-offset:2px}" +
  ".raze-kit-button:disabled,.raze-kit-button[aria-busy=true]{opacity:.55;cursor:default}" +
  ".raze-kit-button[data-variant=primary]{background:var(--raze-accent,#2962ff);border-color:var(--raze-accent,#2962ff);color:var(--raze-accent-contrast,#fff)}" +
  ".raze-kit-button[data-variant=primary]:hover{filter:brightness(1.08)}" +
  ".raze-kit-button[data-variant=ghost]{border-color:transparent}" +
  ".raze-kit-icon-button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;" +
  "border:0;border-radius:var(--raze-radius-sm,4px);background:transparent;color:inherit;cursor:pointer;flex:0 0 auto}" +
  ".raze-kit-icon-button:hover{background:var(--raze-hover,rgba(255,255,255,.08))}" +
  ".raze-kit-icon-button:focus{outline:none}" +
  ".raze-kit-icon-button:focus-visible{outline:2px solid var(--raze-focus,#2962ff);outline-offset:1px}" +
  ".raze-kit-icon{width:18px;height:18px;flex:0 0 auto;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}" +
  ".raze-kit-visually-hidden{position:absolute!important;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}" +
  "@media (forced-colors:active){.raze-kit-surface{border-color:CanvasText}.raze-kit-button[data-variant=primary]{forced-color-adjust:none;background:Highlight;color:HighlightText}" +
  ".raze-kit-surface:focus-visible,.raze-kit-button:focus-visible,.raze-kit-icon-button:focus-visible{outline-color:Highlight}}" +
  "@media (pointer:coarse){.raze-kit-button{min-height:44px}.raze-kit-icon-button{width:44px;height:44px}}" +
  "@media (prefers-reduced-motion:reduce){.raze-kit-button{transition:none}}",
);

const SVG_NS = "http://www.w3.org/2000/svg";

/** Decorative 18px stroke icon from path data (hidden from assistive tech). */
export function icon(doc: Document, ...paths: string[]): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "raze-kit-icon");
  svg.setAttribute("viewBox", "0 0 18 18");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of paths) {
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

export const ICON_CLOSE = "M4.5 4.5l9 9M13.5 4.5l-9 9";
export const ICON_PLUS = "M9 4v10M4 9h10";
export const ICON_MINUS = "M4 9h10";

/** Standard text button. */
export function button(
  doc: Document,
  label: string,
  options?: { variant?: "primary" | "ghost"; type?: "button" | "submit" },
): HTMLButtonElement {
  const element = doc.createElement("button");
  element.type = options?.type ?? "button";
  element.className = "raze-kit-button";
  if (options?.variant) element.dataset.variant = options.variant;
  element.textContent = label;
  return element;
}

/** Icon-only button; `label` becomes its accessible name. */
export function iconButton(doc: Document, label: string, ...paths: string[]): HTMLButtonElement {
  const element = doc.createElement("button");
  element.type = "button";
  element.className = "raze-kit-icon-button";
  element.setAttribute("aria-label", label);
  element.appendChild(icon(doc, ...paths));
  return element;
}

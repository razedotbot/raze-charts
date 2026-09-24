// The built-in icon set. Every chrome icon is drawn on one 18px grid with a
// 1.5px round-capped, round-joined stroke in `currentColor`, so icons inherit
// the control's colour (hover, pressed, checked, forced colours) and read as
// one family. Icons are built with DOM APIs (createElementNS) from path data,
// so no markup sink or Trusted Types policy is involved, and the stroke is set
// as presentation attributes, so an icon renders correctly before (or
// without) any stylesheet.
//
// Each icon is a separate exported constant: bundlers drop the ones a build
// never uses.
//
// This module also owns the menu-row slots that keep labels aligned: every
// row of a built-in menu starts with a fixed 18px check slot (a check icon when
// the row is checked, empty otherwise) and an optional 18px icon slot, so the
// label starts at the same x whether or not the row is checked.

import { defineStyles, type StyleChunk } from "./styles";

/**
 * Path data for one icon on the 18×18 grid. Every part is stroked with the
 * 1.5px set stroke; `f` parts are also filled, `o` parts are a soft 30% fill
 * with no stroke, and `d` parts are dotted.
 */
export interface IconDef {
  /** Stroked outline. */
  readonly s?: string;
  /** Solid parts: filled and stroked. */
  readonly f?: string;
  /** Soft fill (30% opacity, no stroke), drawn underneath. */
  readonly o?: string;
  /** Dotted stroke. */
  readonly d?: string;
}

/** Stroke width shared by every built-in icon. */
export const ICON_STROKE = "1.5";

// A ring of radius 1.75 (a drawing-tool anchor handle) is written as two arcs:
// "M{cx+1.75} {cy}a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 1 1 3.5 0".

// Drawing tools
export const ICON_CURSOR: IconDef = { s: "M5 2.75v11.5l3-2.9 1.9 4.4 2-.85-1.9-4.35h4.25z" };
export const ICON_TREND_LINE: IconDef = {
  s: "M5.24 12.76l7.52-7.52M5.75 14a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 1 1 3.5 0M15.75 4a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 1 1 3.5 0",
};
export const ICON_RAY: IconDef = { s: "M5.24 12.76L15.5 2.5M5.75 14a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 1 1 3.5 0" };
export const ICON_EXTENDED_LINE: IconDef = {
  s: "M2.5 15.5l2.76-2.76M7.74 10.26l2.52-2.52M12.74 5.26L15.5 2.5" +
    "M8.25 11.5a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 1 1 3.5 0M13.25 6.5a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 1 1 3.5 0",
};
export const ICON_HORIZONTAL_LINE: IconDef = { s: "M2.5 9h4.75M10.75 9h4.75M10.75 9a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 1 1 3.5 0" };
export const ICON_VERTICAL_LINE: IconDef = { s: "M9 2.5v4.75M9 10.75v4.75M10.75 9a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 1 1 3.5 0" };
export const ICON_FIB: IconDef = {
  s: "M6 14.5h9.5M2.5 3.5H12M2.5 9h13M5.4 13.2l7.2-8.4" +
    "M6 14.5a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 1 1 3.5 0M15.5 3.5a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 1 1 3.5 0",
};
export const ICON_RECTANGLE: IconDef = { s: "M3 4.5h12v9H3z" };
export const ICON_TEXT: IconDef = { s: "M4 6V4.5h10V6M9 4.5V14M7 14h4" };
export const ICON_MEASURE: IconDef = { s: "M2.5 6.5h13v5h-13zM5.25 6.5v2M9 6.5v2.5M12.75 6.5v2" };

// Chart actions
export const ICON_INDICATORS: IconDef = { s: "M2.5 9C4.5 3.5 7 3.5 9 9s4.5 5.5 6.5 0" };
export const ICON_OBJECTS: IconDef = { s: "M9 2.5l6.5 3.25L9 9 2.5 5.75zM2.5 9L9 12.25 15.5 9M2.5 12.25L9 15.5l6.5-3.25" };
/** Fit content: arrows spreading to the edges (distinct from fullscreen). */
export const ICON_FIT: IconDef = { s: "M3 3.5v11M15 3.5v11M5.5 9h7M7.25 7.25L5.5 9l1.75 1.75M10.75 7.25L12.5 9l-1.75 1.75" };
/** Fullscreen: four outward corners. */
export const ICON_FULLSCREEN: IconDef = { s: "M3 7V3h4M11 3h4v4M15 11v4h-4M7 15H3v-4" };
export const ICON_CAMERA: IconDef = {
  s: "M2.5 6.5a1 1 0 0 1 1-1h2.25L7 3.5h4l1.25 2h2.25a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" +
    "M11.5 10a2.5 2.5 0 1 1-5 0 2.5 2.5 0 1 1 5 0",
};

// Chart types. Candle wicks are strokes, so they stay visible at 18px.
export const ICON_CANDLES: IconDef = { s: "M5.5 3v12M12.5 2.5v11", f: "M3.75 6h3.5v6h-3.5zM10.75 4.5h3.5V11h-3.5z" };
export const ICON_HOLLOW_CANDLES: IconDef = {
  s: "M5.5 3v3M5.5 12v3M12.5 2.5v11M3.75 6h3.5v6h-3.5z",
  f: "M10.75 4.5h3.5V11h-3.5z",
};
export const ICON_HEIKIN_ASHI: IconDef = {
  s: "M4 8v7M9 5v8M14 2.5V10",
  f: "M2.75 9.5h2.5v4h-2.5zM7.75 6.5h2.5v5h-2.5zM12.75 3.5h2.5v5h-2.5z",
};
export const ICON_BARS: IconDef = { s: "M5.5 3v12M3 6h2.5M5.5 12H8M12.5 3v12M10 5h2.5M12.5 10.5H15" };
export const ICON_LINE: IconDef = { s: "M2.5 13l4-5 3.5 3 5.5-6.5" };
export const ICON_AREA: IconDef = { s: "M2.5 13l4-5 3.5 3 5.5-6.5", o: "M2.5 13l4-5 3.5 3 5.5-6.5v11h-13z" };
export const ICON_BASELINE: IconDef = { s: "M2.5 13l3.5-6.5 3.5 4.5 5.5-7.5", d: "M2.5 9h13" };
export const ICON_COLUMNS: IconDef = { f: "M3.25 10h2.5v5h-2.5zM7.75 5h2.5v10h-2.5zM12.25 7.5h2.5V15h-2.5z" };

// Menus and actions
export const ICON_CHECK: IconDef = { s: "M4 9.5l3.25 3.25L14 6" };
export const ICON_MAGNET: IconDef = { s: "M3.5 2.5v7a5.5 5.5 0 0 0 11 0v-7H11v7a2 2 0 0 1-4 0v-7zM3.5 5.5H7M11 5.5h3.5" };
export const ICON_PENCIL: IconDef = { s: "M3.5 14.5l.75-3.25L11.5 4 14 6.5l-7.25 7.25zM10 5.5L12.5 8" };
export const ICON_LOCK: IconDef = { s: "M4.5 8.5h9v7h-9zM6.5 8.5V6a2.5 2.5 0 0 1 5 0v2.5" };
export const ICON_UNLOCK: IconDef = { s: "M4.5 8.5h9v7h-9zM6.5 8.5V6a2.5 2.5 0 0 1 5 0" };
export const ICON_EYE: IconDef = {
  s: "M1.75 9S4.5 4 9 4s7.25 5 7.25 5S13.5 14 9 14 1.75 9 1.75 9zM11.25 9a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 1 1 4.5 0",
};
export const ICON_EYE_OFF: IconDef = {
  s: "M1.75 9S4.5 4 9 4s7.25 5 7.25 5S13.5 14 9 14 1.75 9 1.75 9zM11.25 9a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 1 1 4.5 0M3 3l12 12",
};
export const ICON_TRASH: IconDef = { s: "M3.5 5h11M7 5V3.25h4V5M5 5l.75 10.25h6.5L13 5M7.75 8v4.5M10.25 8v4.5" };
export const ICON_UNDO: IconDef = { s: "M6.5 3.5l-3 3 3 3M3.5 6.5h7.25a3.75 3.75 0 0 1 0 7.5H8" };
export const ICON_REDO: IconDef = { s: "M11.5 3.5l3 3-3 3M14.5 6.5H7.25a3.75 3.75 0 0 0 0 7.5H10" };
export const ICON_GEAR: IconDef = {
  s: "M9 1.75v2M9 14.25v2M1.75 9h2M14.25 9h2M3.87 3.87l1.42 1.42M12.71 12.71l1.42 1.42M3.87 14.13l1.42-1.42M12.71 5.29l1.42-1.42" +
    "M14 9a5 5 0 1 1-10 0 5 5 0 1 1 10 0M11 9a2 2 0 1 1-4 0 2 2 0 1 1 4 0",
};
export const ICON_PLUS: IconDef = { s: "M9 3.5v11M3.5 9h11" };
export const ICON_CLOSE: IconDef = { s: "M4.5 4.5l9 9M13.5 4.5l-9 9" };

const SVG_NS = "http://www.w3.org/2000/svg";

function part(doc: Document, d: string, attrs: Record<string, string>): SVGPathElement {
  const path = doc.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  for (const name in attrs) path.setAttribute(name, attrs[name]!);
  return path;
}

/** Build a decorative 18px icon (hidden from assistive technology). */
export function createIcon(icon: IconDef, doc: Document = document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  const attrs: Record<string, string> = {
    class: "raze-icon",
    width: "18",
    height: "18",
    viewBox: "0 0 18 18",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": ICON_STROKE,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  };
  for (const name in attrs) svg.setAttribute(name, attrs[name]!);
  if (icon.o) svg.appendChild(part(doc, icon.o, { fill: "currentColor", "fill-opacity": ".3", stroke: "none" }));
  if (icon.s) svg.appendChild(part(doc, icon.s, {}));
  if (icon.d) svg.appendChild(part(doc, icon.d, { "stroke-dasharray": "0 3" }));
  if (icon.f) svg.appendChild(part(doc, icon.f, { fill: "currentColor" }));
  return svg;
}

/**
 * Menu-row layout: a fixed check slot, an optional icon slot and the label.
 * Anchored popups live under document.body, outside the widget root, so each
 * value falls back from the `--raze-*` token to the mirrored `--tv-color-*`
 * variable.
 */
export const MENU_ROW_STYLES: StyleChunk = /* @__PURE__ */ defineStyles(
  "menu-row",
  ".raze-menu-slot{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;flex:0 0 18px}" +
  ".raze-menu-check,[aria-checked=true]>.raze-menu-icon{color:var(--raze-accent,var(--tv-color-toolbar-button-text-hover,#2962ff))}" +
  ".raze-menu-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}" +
  ".raze-menu-swatch{width:8px;height:8px;border-radius:50%}" +
  ".raze-menu-separator{height:1px;margin:4px 0;background:var(--raze-border,var(--tv-color-toolbar-divider-background,#363a45))}" +
  // Secondary text: the menu text mixed toward the surface. It keeps at least
  // 4.5:1 contrast on both the dark and the light popup surfaces.
  ".raze-menu-muted{color:var(--raze-text,var(--tv-color-popup-element-text,#d1d4dc));" +
  "color:var(--raze-text-muted,color-mix(in srgb,var(--raze-text,var(--tv-color-popup-element-text,#d1d4dc)) 72%,var(--raze-surface,var(--tv-color-popup-background,#1e222d))))}" +
  ".raze-menu-empty{padding:8px 12px}" +
  "@media (forced-colors:active){.raze-menu-check,[aria-checked=true]>.raze-menu-icon{color:Highlight}.raze-menu-separator{background:CanvasText}}",
);

export interface MenuRowParts {
  /** Checked state for checkbox and radio rows; omit for plain rows. */
  checked?: boolean;
  /** Icon (or other decoration, such as a colour swatch) after the check slot. */
  icon?: IconDef | Element;
  label: string;
  /** Secondary row: the icon and label use the muted text token. */
  muted?: boolean;
}

/**
 * Fill a popup row with the aligned check slot, optional icon slot and label.
 * The check slot is always present, so the label starts at the same x in
 * checked and unchecked rows alike.
 */
export function fillMenuRow(row: HTMLElement, parts: MenuRowParts): HTMLElement {
  const doc = row.ownerDocument;
  const muted = parts.muted ? " raze-menu-muted" : "";
  const slot = (className: string, content?: IconDef | Element): HTMLSpanElement => {
    const el = doc.createElement("span");
    el.className = `raze-menu-slot ${className}${muted}`;
    el.setAttribute("aria-hidden", "true");
    if (content) el.appendChild((content as Node).nodeType === 1 ? content as Element : createIcon(content as IconDef, doc));
    return el;
  };
  const label = doc.createElement("span");
  label.className = `raze-menu-label${muted}`;
  label.textContent = parts.label;
  row.replaceChildren(slot("raze-menu-check", parts.checked ? ICON_CHECK : undefined));
  if (parts.icon) row.appendChild(slot("raze-menu-icon", parts.icon));
  row.appendChild(label);
  return row;
}

/** A `role="separator"` rule between groups of menu rows. */
export function menuSeparator(doc: Document = document): HTMLDivElement {
  const el = doc.createElement("div");
  el.className = "raze-menu-separator";
  el.setAttribute("role", "separator");
  return el;
}

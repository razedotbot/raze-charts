// Text: a label whose top-left corner is the anchor. Honours font size,
// bold/italic, colour, background, border, multi-line text and word
// wrapping, and hit-tests the measured box it paints (never the empty space
// beside it).

import type { Rect, ScreenPoint } from "../../engine/paint/view";
import type { DrawingEnv } from "../types";
import { type AnyState, colorOr, crisp, hitAnchor, inRect, measurer, num, type ToolDef, wrapText } from "./common";

const PAD = 4;

/** Font, lines, line height and box of a text drawing anchored at `origin`. */
export function textLayout(drawing: AnyState, origin: ScreenPoint, env: DrawingEnv, ctx?: CanvasRenderingContext2D) {
  const p = drawing.props;
  const size = Math.max(6, Math.min(200, num(p.fontsize, 14)));
  const font = `${p.italic === true ? "italic " : ""}${p.bold === true ? "bold " : ""}${size}px ${env.fontFamily}`;
  const measure = measurer(font, size, ctx);
  const lines = wrapText(drawing.text || "Text", measure, p.wordWrap === true ? Math.max(20, num(p.wordWrapWidth, 200)) : null);
  const lineHeight = Math.round(size * 1.3);
  const box: Rect = {
    x: origin.x,
    y: origin.y,
    w: Math.ceil(Math.max(...lines.map(measure))) + PAD * 2,
    h: lines.length * lineHeight + PAD * 2,
  };
  return { font, lines, lineHeight, box };
}

export const textTool: ToolDef = {
  id: "text",
  title: "Text",
  icon: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4 4.5H14M9 4.5V14.5M6.5 14.5H11.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  group: "annotation",
  anchors: 1,
  text: true,
  props: {
    color: { type: "color", title: "Text color", default: "", group: "text" },
    fontsize: { type: "number", title: "Font size", default: 14, min: 6, max: 200, group: "text" },
    bold: { type: "boolean", title: "Bold", default: false, group: "text" },
    italic: { type: "boolean", title: "Italic", default: false, group: "text" },
    backgroundColor: { type: "color", title: "Background", default: "" },
    fillBackground: { type: "boolean", title: "Fill background", default: true },
    borderColor: { type: "color", title: "Border color", default: "" },
    drawBorder: { type: "boolean", title: "Border", default: false },
    wordWrap: { type: "boolean", title: "Wrap text", default: false, group: "text" },
    wordWrapWidth: { type: "number", title: "Wrap width", default: 200, min: 20, max: 2000, group: "text" },
  },

  paint(ctx, drawing, { anchors: [anchor] }, env) {
    if (!anchor) return;
    const p = drawing.props;
    const { font, lines, lineHeight, box } = textLayout(drawing, anchor, env, ctx);
    // `textcolor` is the TradingView alias and `linecolor` the colour earlier
    // releases painted text with (UI-created text saved it there); empty
    // follows the theme label colour (>= 4.5:1).
    const color = colorOr(p.color, colorOr(p.textcolor, colorOr(p.linecolor, env.theme.labelText)));
    const x = crisp(box.x);
    const y = crisp(box.y);
    if (p.fillBackground !== false) {
      ctx.fillStyle = colorOr(p.backgroundColor, env.theme.labelBackground);
      ctx.fillRect(x - 0.5, y - 0.5, Math.round(box.w), Math.round(box.h));
    }
    if (p.drawBorder === true) {
      ctx.strokeStyle = colorOr(p.borderColor, color);
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, Math.round(box.w) - 1, Math.round(box.h) - 1);
    }
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textBaseline = "middle";
    lines.forEach((line, i) => ctx.fillText(line, box.x + PAD, box.y + PAD + lineHeight * (i + 0.5)));
  },

  hitTest(point, drawing, { anchors, plot }, env, tolerance) {
    const anchor = anchors[0];
    if (!anchor || !inRect(point, plot)) return null;
    return hitAnchor(point, anchors, tolerance)
      ?? (inRect(point, textLayout(drawing, anchor, env).box) ? { kind: "label", cursor: "move" } : null);
  },
};

// Legend rendering for both renderers. Placement comes from the scene:
// "top" is a single row above the plot, "right" is a stacked column (pie).

import type { CompiledChart } from "../compile/types";
import { esc } from "./primitives";

const RIGHT_ROW_HEIGHT = 40;

/** Approximate top-legend entry advance, shared so SVG and Canvas stay aligned. */
function topEntryWidth(item: CompiledChart["legend"][number]): number {
  return 16 + item.name.length * 6.2 + (item.detail ? item.detail.length * 5.6 : 0);
}

/** SVG legend group. Entries carry data-series so mounts can toggle series. */
export function legendSvg(c: CompiledChart): string {
  const { plot, theme } = c;
  if (c.legendPlacement === "right" && c.legend.length) {
    const lx = plot.x + plot.w + 18;
    const block = c.legend.length * RIGHT_ROW_HEIGHT;
    const y0 = plot.y + Math.max(0, (plot.h - block) / 2);
    return `<g font-size="11">${c.legend.map((l, i) => {
      const y = y0 + i * RIGHT_ROW_HEIGHT;
      return `<g data-series="${esc(l.name)}" style="cursor:pointer" transform="translate(${lx},${y})"><rect width="8" height="8" y="2" rx="1.5" fill="${esc(l.color)}" /><text x="14" y="6" dominant-baseline="middle" fill="${esc(theme.text)}">${esc(l.name)}</text>${l.detail ? `<text x="14" y="22" dominant-baseline="middle" font-size="9" fill="${esc(theme.muted)}">${esc(l.detail)}</text>` : ""}</g>`;
    }).join("")}</g>`;
  }
  if (c.legendPlacement === "top" && c.legend.length) {
    let lx = plot.x;
    return `<g font-size="10">${c.legend.map((l) => {
      const w = topEntryWidth(l);
      const g = `<g data-series="${esc(l.name)}" style="cursor:pointer" transform="translate(${lx},14)"><rect width="7" height="7" y="-5" rx="1.5" fill="${esc(l.color)}" /><text x="11" fill="${esc(theme.text)}">${esc(l.name)}${l.detail ? `  ${esc(l.detail)}` : ""}</text></g>`;
      lx += w + 10;
      return g;
    }).join("")}</g>`;
  }
  return "";
}

export function paintLegendCanvas(ctx: CanvasRenderingContext2D, c: CompiledChart): void {
  const { legend, legendPlacement, plot, theme } = c;
  if (!legend.length || legendPlacement === "hidden") return;
  if (legendPlacement === "right") {
    const x = plot.x + plot.w + 18;
    const y0 = plot.y + Math.max(0, (plot.h - legend.length * RIGHT_ROW_HEIGHT) / 2);
    legend.forEach((item, i) => {
      const y = y0 + i * RIGHT_ROW_HEIGHT;
      ctx.fillStyle = item.color;
      ctx.fillRect(x, y + 2, 8, 8);
      ctx.font = `11px ${theme.font}`;
      ctx.textAlign = "start";
      ctx.textBaseline = "middle";
      ctx.fillStyle = theme.text;
      ctx.fillText(item.name, x + 14, y + 6);
      if (item.detail) {
        ctx.font = `9px ${theme.font}`;
        ctx.fillStyle = theme.muted;
        ctx.fillText(item.detail, x + 14, y + 22);
      }
    });
    return;
  }
  let x = plot.x;
  for (const item of legend) {
    ctx.fillStyle = item.color;
    ctx.fillRect(x, 9, 7, 7);
    ctx.font = `10px ${theme.font}`;
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = theme.text;
    const label = `${item.name}${item.detail ? `  ${item.detail}` : ""}`;
    ctx.fillText(label, x + 11, 14);
    x += topEntryWidth(item) + 10;
  }
}

// Legend rendering for both renderers. The compiler measures the layout
// (wrapping top rows, a stacked or compact side column, `+N more`); both
// renderers paint the same boxes, so SVG and Canvas stay aligned and every
// row's box is its toggle hit area. Hidden series stay listed, dimmed with a
// hollow swatch, so a second click brings them back.
//
// The same boxes drive pointer hit-testing and the mount's keyboard toggle
// buttons (layoutLegend / legendEntryAt below), so the SVG markup, the Canvas
// painter, hit-testing and the toggles agree on where each entry is.

import { SIDE_LEGEND, TOP_LEGEND, estimateTextWidth, sceneLegendLayout, swatchWidth, toggleHiddenSeries } from "../compile/legend";
import type { CompiledChart } from "../compile/types";
import type { SceneLegendLayout, SceneLegendRow } from "../sceneTypes";
import { esc, round } from "./primitives";

/** Opacity of a hidden series' legend row. */
const HIDDEN_OPACITY = 0.42;

export interface LegendBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A legend entry as the mount's toggles and hit-testing see it. */
export interface LegendEntryLayout {
  /** Toggle key: the row id (series id, or `<seriesId>/<label>` for a pie slice). */
  key: string;
  name: string;
  color: string;
  detail?: string;
  hidden: boolean;
  /** Pointer target in scene space. */
  box: LegendBox;
}

export interface LegendLayout {
  entries: LegendEntryLayout[];
  /** `+N more` summary for rows that did not fit. */
  more: { x: number; y: number; label: string } | null;
  /** True when entries toggle series (every visible legend: series, radar layers and pie slices). */
  toggleable: boolean;
}

/** Legend geometry for a scene: the compiled `legendLayout` boxes (derived for hand-built scenes). */
export function layoutLegend(c: CompiledChart): LegendLayout {
  const layout = sceneLegendLayout(c);
  if (layout.placement === "hidden") return { entries: [], more: null, toggleable: false };
  const entries: LegendEntryLayout[] = [];
  for (const row of layout.rows) {
    if (!row.box) continue;
    entries.push({
      key: row.id,
      name: row.name,
      color: row.color,
      ...(row.detail !== undefined ? { detail: row.detail } : {}),
      hidden: row.hidden,
      box: { ...row.box },
    });
  }
  const more = layout.more ? { x: layout.more.box.x, y: layout.more.box.y + layout.more.box.h / 2, label: layout.more.label } : null;
  return { entries, more, toggleable: true };
}

/**
 * The hidden-series set after a click on legend entry `key`, through the
 * compiler's {@link toggleHiddenSeries}: hiding adds the row id; showing
 * removes every key that hides the row (its id and name, the marks it groups,
 * a pie slice's label), so a series hidden by name comes back from its
 * id-keyed row. Without a scene the key itself toggles.
 */
export function toggledHiddenSeries(c: CompiledChart | null, hidden: ReadonlySet<string>, key: string): Set<string> {
  if (c) return new Set(toggleHiddenSeries(c, hidden, key));
  const next = new Set(hidden);
  if (!next.delete(key)) next.add(key);
  return next;
}

/** Legend entry under a scene-space point, if it toggles. */
export function legendEntryAt(c: CompiledChart, x: number, y: number): LegendEntryLayout | null {
  const layout = layoutLegend(c);
  if (!layout.toggleable) return null;
  return layout.entries.find(({ box }) => x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) ?? null;
}

function rowText(row: SceneLegendRow): string {
  return row.label ?? row.name;
}

function swatchSvg(row: SceneLegendRow, cy: number): string {
  const color = esc(row.color);
  if (row.symbol === "line") {
    const dash = row.hidden ? ` stroke-dasharray="2 2"` : "";
    return `<line x1="0.75" x2="11.25" y1="${round(cy)}" y2="${round(cy)}" stroke="${color}" stroke-width="2" stroke-linecap="round"${dash} />`;
  }
  if (row.symbol === "circle") {
    return row.hidden
      ? `<circle cx="4" cy="${round(cy)}" r="3.4" fill="none" stroke="${color}" stroke-width="1.2" />`
      : `<circle cx="4" cy="${round(cy)}" r="4" fill="${color}" />`;
  }
  return row.hidden
    ? `<rect x="0.6" y="${round(cy - 3.4)}" width="6.8" height="6.8" rx="1.5" fill="none" stroke="${color}" stroke-width="1.2" />`
    : `<rect width="8" height="8" y="${round(cy - 4)}" rx="1.5" fill="${color}" />`;
}

function rowSvg(layout: SceneLegendLayout, row: SceneLegendRow, c: CompiledChart): string {
  const box = row.box;
  if (!box) return "";
  const { theme } = c;
  const state = row.hidden ? ` data-hidden="true" opacity="${HIDDEN_OPACITY}"` : "";
  // The markup is static: a mount's toggle buttons carry the pointer cursor.
  const open = `<g data-series="${esc(row.id)}"${state} transform="translate(${round(box.x)},${round(box.y)})">`;
  const full = row.label !== undefined && row.label !== row.name ? `<title>${esc(row.name)}</title>` : "";
  if (layout.rowStyle === "stacked") {
    return `${open}${full}${swatchSvg(row, 6)}<text x="${SIDE_LEGEND.textX}" y="6" dominant-baseline="middle" font-size="${SIDE_LEGEND.nameFont}" fill="${esc(theme.text)}">${esc(rowText(row))}</text>${row.detail ? `<text x="${SIDE_LEGEND.textX}" y="22" dominant-baseline="middle" font-size="${SIDE_LEGEND.detailFont}" fill="${esc(theme.muted)}">${esc(row.detail)}</text>` : ""}</g>`;
  }
  const cy = box.h / 2;
  if (layout.rowStyle === "compact") {
    return `${open}${full}${swatchSvg(row, cy)}<text x="${SIDE_LEGEND.textX}" y="${round(cy)}" dominant-baseline="middle" font-size="${SIDE_LEGEND.nameFont}" fill="${esc(theme.text)}">${esc(rowText(row))}</text>${row.detail ? `<text x="${round(box.w)}" y="${round(cy)}" text-anchor="end" dominant-baseline="middle" font-size="${SIDE_LEGEND.detailFont}" fill="${esc(theme.muted)}">${esc(row.detail)}</text>` : ""}</g>`;
  }
  const tx = swatchWidth(row.symbol) + TOP_LEGEND.swatchGap;
  const detail = row.detail
    ? `<tspan dx="${TOP_LEGEND.detailGap}" fill="${esc(theme.muted)}">${esc(row.detail)}</tspan>`
    : "";
  return `${open}${full}${swatchSvg(row, cy)}<text x="${tx}" y="${round(cy)}" dominant-baseline="middle" font-size="${TOP_LEGEND.fontSize}" fill="${esc(theme.text)}">${esc(rowText(row))}${detail}</text></g>`;
}

function moreSvg(layout: SceneLegendLayout, c: CompiledChart): string {
  const more = layout.more;
  if (!more) return "";
  const x = layout.placement === "right" ? more.box.x + SIDE_LEGEND.textX : more.box.x;
  const y = more.box.y + more.box.h / 2;
  return `<g data-role="legend-more"><title>${esc(more.names.join(", "))}</title><text x="${round(x)}" y="${round(y)}" dominant-baseline="middle" font-size="${TOP_LEGEND.fontSize}" fill="${esc(c.theme.muted)}">${esc(more.label)}</text></g>`;
}

/** SVG legend group. Entries carry data-series (the row id) so mounts can toggle series. */
export function legendSvg(c: CompiledChart): string {
  const layout = sceneLegendLayout(c);
  if (layout.placement === "hidden" || (!layout.rows.length && !layout.more)) return "";
  const size = layout.rowStyle === "inline" ? TOP_LEGEND.fontSize : SIDE_LEGEND.nameFont;
  return `<g data-role="legend" font-size="${size}">${layout.rows.map((row) => rowSvg(layout, row, c)).join("")}${moreSvg(layout, c)}</g>`;
}

function paintSwatch(ctx: CanvasRenderingContext2D, row: SceneLegendRow, x: number, cy: number): void {
  ctx.beginPath();
  if (row.symbol === "line") {
    ctx.moveTo(x + 0.75, cy);
    ctx.lineTo(x + 11.25, cy);
    ctx.strokeStyle = row.color;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.setLineDash(row.hidden ? [2, 2] : []);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  if (row.symbol === "circle") ctx.arc(x + 4, cy, row.hidden ? 3.4 : 4, 0, Math.PI * 2);
  else if (row.hidden) ctx.rect(x + 0.6, cy - 3.4, 6.8, 6.8);
  else ctx.rect(x, cy - 4, 8, 8);
  if (row.hidden) {
    ctx.strokeStyle = row.color;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  } else {
    ctx.fillStyle = row.color;
    ctx.fill();
  }
}

function paintRowCanvas(ctx: CanvasRenderingContext2D, layout: SceneLegendLayout, row: SceneLegendRow, c: CompiledChart): void {
  const box = row.box;
  if (!box) return;
  const { theme } = c;
  const alpha = ctx.globalAlpha;
  if (row.hidden) ctx.globalAlpha = alpha * HIDDEN_OPACITY;
  ctx.textAlign = "start";
  ctx.textBaseline = "middle";
  if (layout.rowStyle === "stacked") {
    paintSwatch(ctx, row, box.x, box.y + 6);
    ctx.font = `${SIDE_LEGEND.nameFont}px ${theme.font}`;
    ctx.fillStyle = theme.text;
    ctx.fillText(rowText(row), box.x + SIDE_LEGEND.textX, box.y + 6);
    if (row.detail) {
      ctx.font = `${SIDE_LEGEND.detailFont}px ${theme.font}`;
      ctx.fillStyle = theme.muted;
      ctx.fillText(row.detail, box.x + SIDE_LEGEND.textX, box.y + 22);
    }
  } else if (layout.rowStyle === "compact") {
    const cy = box.y + box.h / 2;
    paintSwatch(ctx, row, box.x, cy);
    ctx.font = `${SIDE_LEGEND.nameFont}px ${theme.font}`;
    ctx.fillStyle = theme.text;
    ctx.fillText(rowText(row), box.x + SIDE_LEGEND.textX, cy);
    if (row.detail) {
      ctx.font = `${SIDE_LEGEND.detailFont}px ${theme.font}`;
      ctx.fillStyle = theme.muted;
      ctx.textAlign = "end";
      ctx.fillText(row.detail, box.x + box.w, cy);
    }
  } else {
    const cy = box.y + box.h / 2;
    paintSwatch(ctx, row, box.x, cy);
    const tx = box.x + swatchWidth(row.symbol) + TOP_LEGEND.swatchGap;
    const label = rowText(row);
    ctx.font = `${TOP_LEGEND.fontSize}px ${theme.font}`;
    ctx.fillStyle = theme.text;
    ctx.fillText(label, tx, cy);
    if (row.detail) {
      ctx.fillStyle = theme.muted;
      // Recording and headless contexts may not measure text; fall back to the layout estimate.
      const measured = typeof ctx.measureText === "function" ? ctx.measureText(label)?.width : undefined;
      const nameWidth = typeof measured === "number" && Number.isFinite(measured)
        ? measured
        : estimateTextWidth(label, TOP_LEGEND.fontSize, theme.font);
      ctx.fillText(row.detail, tx + nameWidth + TOP_LEGEND.detailGap, cy);
    }
  }
  ctx.globalAlpha = alpha;
}

export function paintLegendCanvas(ctx: CanvasRenderingContext2D, c: CompiledChart): void {
  const layout = sceneLegendLayout(c);
  if (layout.placement === "hidden") return;
  // Swatches set line caps and dashes; the grid painted next must not inherit them.
  ctx.save();
  for (const row of layout.rows) paintRowCanvas(ctx, layout, row, c);
  const more = layout.more;
  if (more) {
    ctx.font = `${TOP_LEGEND.fontSize}px ${c.theme.font}`;
    ctx.fillStyle = c.theme.muted;
    ctx.textAlign = "start";
    ctx.textBaseline = "middle";
    const x = layout.placement === "right" ? more.box.x + SIDE_LEGEND.textX : more.box.x;
    ctx.fillText(more.label, x, more.box.y + more.box.h / 2);
  }
  ctx.restore();
}

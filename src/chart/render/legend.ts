// Legend rendering for both renderers. One layout pass places every entry, so
// the SVG markup, the Canvas painter, pointer hit-testing, and the mount's
// keyboard toggles all agree on where each entry is.
//
// Scene v1 (`legend` + `legendPlacement`): "top" is a single row above the
// plot, "right" is a stacked column (pie). Scene v2 (`legendLayout`, AD-08)
// adds stable row ids, hidden rows that stay listed, "bottom" placement, a
// reserved band size, and an overflow count: top/bottom rows wrap inside the
// band and the right column compacts to 20px rows, with `+N more` for rows
// that do not fit.

import type { CompiledChart } from "../compile/types";
import type { CompiledSceneV2Fields } from "../sceneTypes";
import { esc } from "./primitives";

/** Opacity of a hidden (toggled-off) series entry. */
const HIDDEN_OPACITY = 0.45;
const LINE_HEIGHT = 16;

export interface LegendBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LegendEntryLayout {
  /** Toggle key: the v2 row id, otherwise the series name. */
  key: string;
  name: string;
  color: string;
  detail?: string;
  hidden: boolean;
  /** "stacked" entries put the detail under the name (v1 pie column). */
  stacked: boolean;
  /** Pointer target in scene space. */
  box: LegendBox;
  swatch: LegendBox;
  /** Start of the text; rows use an alphabetic baseline, stacked entries a middle one. */
  textX: number;
  textY: number;
  fontSize: number;
  /** Separate detail text position; absent when the detail follows the name inline. */
  detailX?: number;
  detailY?: number;
}

export interface LegendLayout {
  entries: LegendEntryLayout[];
  /** `+N more` summary for rows that did not fit. */
  more: { x: number; y: number; label: string } | null;
  /** False for pie legends: slices are not series, so entries do not toggle. */
  toggleable: boolean;
}

interface LegendRowInput {
  id?: string;
  name: string;
  color: string;
  detail?: string;
  hidden?: boolean;
}

/** Approximate row-entry advance, shared so SVG and Canvas stay aligned. */
function rowWidth(item: LegendRowInput): number {
  return 16 + item.name.length * 6.2 + (item.detail ? item.detail.length * 5.6 : 0);
}

function inlineLabel(entry: LegendEntryLayout): string {
  return entry.detailX === undefined && entry.detail ? `${entry.name}  ${entry.detail}` : entry.name;
}

function entryFor(row: LegendRowInput, box: LegendBox, swatch: LegendBox, textX: number, textY: number, fontSize: number): LegendEntryLayout {
  return {
    key: row.id ?? row.name,
    name: row.name,
    color: row.color,
    ...(row.detail ? { detail: row.detail } : {}),
    hidden: Boolean(row.hidden),
    stacked: false,
    box,
    swatch,
    textX,
    textY,
    fontSize,
  };
}

/** Legend geometry for a scene: v2 `legendLayout` when present, else the v1 rows. */
export function layoutLegend(c: CompiledChart): LegendLayout {
  const { plot, width } = c;
  const v2 = (c as CompiledChart & CompiledSceneV2Fields).legendLayout;
  const placement = v2 ? v2.placement : c.legendPlacement;
  const rows: readonly LegendRowInput[] = v2 ? v2.rows : c.legend;
  const toggleable = !(c.polar && (c.legendPlacement === "right" || c.nodes.some((node) => node.type === "arc")));
  const entries: LegendEntryLayout[] = [];
  let remaining = v2?.overflow ?? 0;
  let more: LegendLayout["more"] = null;
  if (placement === "hidden" || (!rows.length && !remaining)) return { entries, more, toggleable };

  if (placement === "right") {
    const lx = plot.x + plot.w + 18;
    // v1 stacks name over detail in 40px rows; v2 compacts to 20px rows with a `+N more` row.
    const pitch = v2 ? 20 : 40;
    const capacity = v2 ? Math.max(1, Math.floor(plot.h / pitch)) : rows.length;
    const shown = rows.length + remaining > capacity ? Math.max(0, capacity - 1) : rows.length;
    remaining += rows.length - shown;
    const y0 = plot.y + Math.max(0, (plot.h - (shown + (remaining > 0 ? 1 : 0)) * pitch) / 2);
    for (let i = 0; i < shown; i++) {
      const row = rows[i]!;
      const y = y0 + i * pitch;
      const nameWidth = row.name.length * 6.6;
      if (v2) {
        const entry = entryFor(row, { x: lx - 3, y: y + 1, w: Math.min(width - lx + 3, 28 + nameWidth + (row.detail?.length ?? 0) * 5.4), h: pitch - 2 }, { x: lx, y: y + 6, w: 8, h: 8 }, lx + 14, y + 14, 11);
        if (row.detail) Object.assign(entry, { detailX: lx + 22 + nameWidth, detailY: y + 14 });
        entries.push(entry);
      } else {
        const textWidth = Math.max(nameWidth, (row.detail?.length ?? 0) * 5.4);
        const entry = entryFor(row, { x: lx - 3, y: y - 3, w: Math.min(width - lx + 3, 20 + textWidth), h: row.detail ? 32 : 16 }, { x: lx, y: y + 2, w: 8, h: 8 }, lx + 14, y + 6, 11);
        entry.stacked = true;
        if (row.detail) Object.assign(entry, { detailX: lx + 14, detailY: y + 22 });
        entries.push(entry);
      }
    }
    if (remaining > 0) more = { x: lx, y: y0 + shown * pitch + 14, label: `+${remaining} more` };
    return { entries, more, toggleable };
  }

  // Top or bottom band. v1 is one unbounded row; v2 wraps inside the reserved band.
  const bandTop = v2 && placement === "bottom" ? c.height - v2.size : 0;
  const maxLines = v2 ? Math.max(1, Math.floor((v2.size - 6) / LINE_HEIGHT)) : 1;
  const right = width - 6;
  let line = 0;
  let lx = plot.x;
  for (const row of rows) {
    const w = rowWidth(row);
    if (v2 && lx > plot.x && lx + w > right) {
      if (line + 1 >= maxLines) break;
      line++;
      lx = plot.x;
    }
    const baseline = bandTop + 14 + line * LINE_HEIGHT;
    entries.push(entryFor(row, { x: lx - 3, y: baseline - 11, w: w + 6, h: 16 }, { x: lx, y: baseline - 5, w: 7, h: 7 }, lx + 11, baseline, 10));
    lx += w + 10;
  }
  remaining += rows.length - entries.length;
  if (remaining > 0) {
    // Drop trailing entries until the summary fits on the last line.
    const lastTop = bandTop + 14 + line * LINE_HEIGHT;
    let end = lx;
    while (entries.length && entries[entries.length - 1]!.textY === lastTop && end + `+${remaining} more`.length * 6.2 > right) {
      const dropped = entries.pop()!;
      end = dropped.box.x + 3;
      remaining++;
    }
    more = { x: end, y: lastTop, label: `+${remaining} more` };
  }
  return { entries, more, toggleable };
}

/** Legend entry under a scene-space point, if it toggles. */
export function legendEntryAt(c: CompiledChart, x: number, y: number): LegendEntryLayout | null {
  const layout = layoutLegend(c);
  if (!layout.toggleable) return null;
  return layout.entries.find(({ box }) => x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) ?? null;
}

function entrySvg(entry: LegendEntryLayout, c: CompiledChart): string {
  const { theme } = c;
  const { swatch, hidden } = entry;
  const swatchSvg = hidden
    ? `<rect x="${swatch.x + 0.5}" y="${swatch.y + 0.5}" width="${swatch.w - 1}" height="${swatch.h - 1}" rx="1.5" fill="none" stroke="${esc(entry.color)}" />`
    : `<rect x="${swatch.x}" y="${swatch.y}" width="${swatch.w}" height="${swatch.h}" rx="1.5" fill="${esc(entry.color)}" />`;
  const baseline = entry.stacked ? ` dominant-baseline="middle"` : "";
  const detail = entry.detail && entry.detailX !== undefined
    ? `<text x="${entry.detailX}" y="${entry.detailY}"${baseline} font-size="9" fill="${esc(theme.muted)}">${esc(entry.detail)}</text>`
    : "";
  return `<g data-series="${esc(entry.key)}"${hidden ? ` opacity="${HIDDEN_OPACITY}"` : ""}>${swatchSvg}<text x="${entry.textX}" y="${entry.textY}"${baseline} font-size="${entry.fontSize}"${hidden ? ` text-decoration="line-through"` : ""} fill="${esc(theme.text)}">${esc(inlineLabel(entry))}</text>${detail}</g>`;
}

/**
 * SVG legend group. Entries carry data-series (their toggle key) so mounts can
 * toggle series; the markup itself is static and shows no pointer cursor.
 */
export function legendSvg(c: CompiledChart): string {
  const { entries, more } = layoutLegend(c);
  if (!entries.length && !more) return "";
  const summary = more
    ? `<text x="${more.x}" y="${more.y}" font-size="10" fill="${esc(c.theme.muted)}">${esc(more.label)}</text>`
    : "";
  return `<g data-role="legend">${entries.map((entry) => entrySvg(entry, c)).join("")}${summary}</g>`;
}

export function paintLegendCanvas(ctx: CanvasRenderingContext2D, c: CompiledChart): void {
  const { entries, more } = layoutLegend(c);
  const { theme } = c;
  for (const entry of entries) {
    const { swatch, hidden } = entry;
    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha * (hidden ? HIDDEN_OPACITY : 1);
    ctx.lineWidth = 1;
    if (hidden) {
      ctx.strokeStyle = entry.color;
      ctx.beginPath();
      ctx.rect(swatch.x + 0.5, swatch.y + 0.5, swatch.w - 1, swatch.h - 1);
      ctx.stroke();
    } else {
      ctx.fillStyle = entry.color;
      ctx.fillRect(swatch.x, swatch.y, swatch.w, swatch.h);
    }
    const label = inlineLabel(entry);
    ctx.font = `${entry.fontSize}px ${theme.font}`;
    ctx.textAlign = "start";
    ctx.textBaseline = entry.stacked ? "middle" : "alphabetic";
    ctx.fillStyle = theme.text;
    ctx.fillText(label, entry.textX, entry.textY);
    if (hidden) {
      const strikeY = entry.stacked ? entry.textY : entry.textY - entry.fontSize * 0.3;
      ctx.beginPath();
      ctx.moveTo(entry.textX, strikeY);
      ctx.lineTo(entry.textX + label.length * entry.fontSize * 0.6, strikeY);
      ctx.strokeStyle = theme.text;
      ctx.stroke();
    }
    if (entry.detail && entry.detailX !== undefined) {
      ctx.font = `9px ${theme.font}`;
      ctx.fillStyle = theme.muted;
      ctx.fillText(entry.detail, entry.detailX, entry.detailY!);
    }
    ctx.globalAlpha = alpha;
  }
  if (more) {
    ctx.font = `10px ${theme.font}`;
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = theme.muted;
    ctx.fillText(more.label, more.x, more.y);
  }
}

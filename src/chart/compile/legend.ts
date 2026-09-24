// Series identity and legend: stable series ids, display names, palette
// colours, hidden series, legend rows, and the measured legend layout
// (wrapping top rows, a compacting side column, and `+N more`).

import type { SceneLegendBox, SceneLegendLayout, SceneLegendRow } from "../sceneTypes";
import { chartPalette, type DashboardTheme } from "../theme";
import { isPluginMark, type ChartMark } from "./marks";
import type { ChartSpec, CompiledChart, LegendEntry, Margin, PlotRect } from "./types";

// ---------------------------------------------------------------------------
// Series identity

export type LegendSymbol = SceneLegendRow["symbol"];

/** One mark's resolved identity. Indexes and ids never depend on hidden state. */
export interface SeriesInfo {
  readonly mark: ChartMark;
  /** Position in the input `spec.marks`. */
  readonly markIndex: number;
  /** Explicit `id`, else `mark-<index>`. */
  readonly id: string;
  /** Display name: `baseName`, numbered (`y (2)`) when another series row already uses it. */
  readonly name: string;
  /** Name before numbering: explicit `name`, else the y accessor or kind. `hiddenSeries` matches it too. */
  readonly baseName: string;
  /** Legend row id. Marks sharing an explicit name and colour share the first mark's row. */
  readonly rowId: string;
  readonly color: string;
  readonly hidden: boolean;
}

export interface SeriesTable {
  readonly series: readonly SeriesInfo[];
  /** True when `hiddenSeries` lists `key` (an id, row id, slice id, or name). */
  isHidden(key: string): boolean;
}

function markStroke(mark: ChartMark): string | undefined {
  return "stroke" in mark && typeof mark.stroke === "string" ? mark.stroke : undefined;
}

export function markFill(mark: ChartMark): string | undefined {
  return "fill" in mark && typeof mark.fill === "string" ? mark.fill : undefined;
}

/** Explicit stroke, then fill, then the theme palette by mark position. */
export function seriesColor(mark: ChartMark, i: number, theme: DashboardTheme): string {
  const palette = chartPalette(theme);
  return markStroke(mark) || markFill(mark) || palette[i % palette.length]!;
}

/** Marks with one legend row per series. Rules, pies (per-slice rows), and heatmaps (colour bar) opt out. */
export function carriesSeriesRow(mark: ChartMark): boolean {
  return isPluginMark(mark)
    || mark.kind === "line" || mark.kind === "area" || mark.kind === "bar"
    || mark.kind === "point" || mark.kind === "radar";
}

function defaultSeriesName(mark: ChartMark): string {
  return "y" in mark && typeof mark.y === "string" ? mark.y : mark.kind;
}

/** The colour a series' legend swatch shows: an explicit fill wins over the stroke. */
function swatchColor(mark: ChartMark, color: string): string {
  return (isPluginMark(mark) ? undefined : markFill(mark)) || color;
}

/** Names already warned about, so a mount that recompiles on every paint warns once. */
const warnedNames = new Set<string>();

function warnDuplicateName(name: string, renamed: string): void {
  if (warnedNames.has(name) || typeof console === "undefined") return;
  warnedNames.add(name);
  console.warn(
    `[@razedotbot/charts] Series named "${name}" differ in colour, so the legend lists one as "${renamed}". `
    + "Rename one, or give both the same colour to share a legend row.",
  );
}

/**
 * Resolve every input mark's id, name, colour, and hidden state. Each series
 * keeps its own legend row: names that collide are numbered (`value`,
 * `value (2)`), and an explicit name reused with a different colour also
 * logs a one-time warning. Marks that share an explicit `name` and paint the
 * same colour (an area plus its outline) deliberately share one row and
 * toggle together. `hiddenSeries` matches ids, row ids, display names, and
 * base names, so `["value"]` still hides every series named `value`.
 */
export function resolveSeries(spec: ChartSpec, theme: DashboardTheme): SeriesTable {
  const hidden = new Set(spec.hiddenSeries ?? []);
  // Explicit names are reserved, so a numbered default never takes one.
  const reserved = new Set<string>();
  for (const mark of spec.marks) if (typeof mark.name === "string") reserved.add(mark.name);
  const taken = new Set<string>();
  const groups = new Map<string, { rowId: string; name: string }>();
  const series = spec.marks.map((mark, markIndex): SeriesInfo => {
    const id = mark.id ?? `mark-${markIndex}`;
    const color = seriesColor(mark, markIndex, theme);
    const explicit = typeof mark.name === "string";
    const baseName = explicit ? mark.name! : defaultSeriesName(mark);
    let name = baseName;
    let rowId = id;
    if (carriesSeriesRow(mark)) {
      const groupKey = `${baseName}\u0000${swatchColor(mark, color).trim().toLowerCase()}`;
      const group = explicit ? groups.get(groupKey) : undefined;
      if (group) {
        rowId = group.rowId;
        name = group.name;
      } else {
        if (explicit ? taken.has(name) : reserved.has(name) || taken.has(name)) {
          for (let n = 2; reserved.has(name) || taken.has(name); n++) name = `${baseName} (${n})`;
          if (explicit) warnDuplicateName(baseName, name);
        }
        taken.add(name);
        if (explicit) groups.set(groupKey, { rowId, name });
      }
    }
    return {
      mark,
      markIndex,
      id,
      name,
      baseName,
      rowId,
      color,
      hidden: hidden.has(id) || hidden.has(rowId) || hidden.has(name) || hidden.has(baseName),
    };
  });
  return { series, isHidden: (key) => hidden.has(key) };
}

/** Keys that hide a series: its id, row id, display name, and base name. */
export function seriesKeys(s: SeriesInfo): string[] {
  return [s.rowId, s.id, s.name, s.baseName];
}

/** A visible series as its mark compiler sees it (the mark itself may be viewport-windowed). */
export interface MarkSeries extends SeriesInfo {
  /** Row index in the input mark's data for windowed row `i` (-1 if unknown). */
  sourceIndex(i: number): number;
}

/** Bind a series to its windowed data so hover samples report source row indexes. */
export function markSeries(s: SeriesInfo, windowed: readonly unknown[]): MarkSeries {
  const source = s.mark.data;
  if (windowed === source) return { ...s, sourceIndex: (i) => i };
  // Windowing filters rows in order, so one forward walk aligns them.
  const map = new Int32Array(windowed.length).fill(-1);
  let j = 0;
  for (let i = 0; i < windowed.length && j < source.length; i++) {
    while (j < source.length && source[j] !== windowed[i]) j++;
    if (j < source.length) map[i] = j++;
  }
  return { ...s, sourceIndex: (i) => map[i] ?? -1 };
}

/** Ids for pie slice rows: `<seriesId>/<label>`, with `#n` for repeated labels. */
export function pieSliceIds(seriesId: string, labels: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const count = (seen.get(label) ?? 0) + 1;
    seen.set(label, count);
    return count === 1 ? `${seriesId}/${label}` : `${seriesId}/${label}#${count}`;
  });
}

// ---------------------------------------------------------------------------
// Legend rows

/** A legend row before layout. */
export interface LegendRowDraft {
  id: string;
  name: string;
  color: string;
  detail?: string;
  /** Shorter detail for one-line side rows (a pie slice's percentage without its value). */
  shortDetail?: string;
  hidden: boolean;
  markIndex: number;
  symbol: LegendSymbol;
  /** Every `hiddenSeries` key that hides this row; a legend click that shows the row removes them all. */
  keys?: readonly string[];
}

/** A row as mark compilers append it; plugin rows carry only name, colour, and detail. */
export type LegendRowInput = Pick<LegendRowDraft, "name" | "color" | "detail"> & Partial<LegendRowDraft>;

/** Complete a compiled row with its series identity (plugin rows toggle their whole mark). */
export function stampLegendRow(row: LegendRowInput, s: SeriesInfo): LegendRowDraft {
  return {
    id: row.id ?? s.rowId,
    name: row.name,
    color: row.color,
    ...(row.detail !== undefined ? { detail: row.detail } : {}),
    hidden: row.hidden ?? s.hidden,
    markIndex: row.markIndex ?? s.markIndex,
    symbol: row.symbol ?? seriesSymbol(s.mark),
    keys: row.keys ?? seriesKeys(s),
  };
}

function seriesSymbol(mark: ChartMark): LegendSymbol {
  if (isPluginMark(mark)) return "rect";
  if (mark.kind === "line") return "line";
  if (mark.kind === "point") return "circle";
  if (mark.kind === "area" || mark.kind === "radar") return "area";
  return "rect";
}

/** The series row of a line/area/bar/point/radar/plugin mark; null for marks without one. */
export function seriesLegendRow(s: SeriesInfo): LegendRowDraft | null {
  if (!carriesSeriesRow(s.mark)) return null;
  return {
    id: s.rowId,
    name: s.name,
    color: swatchColor(s.mark, s.color),
    hidden: s.hidden,
    markIndex: s.markIndex,
    symbol: seriesSymbol(s.mark),
    keys: seriesKeys(s),
  };
}

/**
 * Merge rows that share an id and name (marks grouped by an explicit name and
 * colour, such as an area plus its outline). The merged row is hidden only
 * when every member is, and any member's key hides it.
 */
export function mergeLegendRows(rows: readonly LegendRowDraft[]): LegendRowDraft[] {
  const byKey = new Map<string, LegendRowDraft>();
  const out: LegendRowDraft[] = [];
  for (const row of rows) {
    const key = `${row.id}\u0000${row.name}`;
    const first = byKey.get(key);
    if (first) {
      first.hidden = first.hidden && row.hidden;
      if (row.keys) first.keys = Array.from(new Set([...(first.keys ?? []), ...row.keys]));
      continue;
    }
    const copy = { ...row };
    byKey.set(key, copy);
    out.push(copy);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Legend toggles

interface LegendToggleInfo {
  /** Keys that hide each row, by row id. */
  readonly keys: ReadonlyMap<string, readonly string[]>;
  /** Ids of every hidden series and hidden row. */
  readonly hidden: readonly string[];
}

const toggleInfo = new WeakMap<CompiledChart, LegendToggleInfo>();

/** Remember which keys hide each of a compiled scene's legend rows (read by toggleHiddenSeries). */
export function recordLegendToggles(
  scene: CompiledChart, rows: readonly LegendRowDraft[], series: readonly SeriesInfo[],
): void {
  const hidden = new Set<string>();
  for (const s of series) if (s.hidden) hidden.add(s.id);
  for (const row of rows) if (row.hidden) hidden.add(row.id);
  toggleInfo.set(scene, {
    keys: new Map(rows.map((row) => [row.id, row.keys ?? [row.id, row.name]])),
    hidden: Array.from(hidden),
  });
}

/**
 * The `hiddenSeries` list after a click on legend row `rowId`. Hiding adds the
 * row id. Showing removes every key that hides the row: its id and name, the
 * ids and names of the marks it groups, and for a pie slice its label and the
 * pie's own id and name. Either way, every other hidden series stays hidden by
 * its id, so the result can replace `spec.hiddenSeries` and the keys a mount
 * started with (names or ids) without showing anything else.
 */
export function toggleHiddenSeries(scene: CompiledChart, hidden: Iterable<string>, rowId: string): string[] {
  const info = toggleInfo.get(scene);
  const next = new Set(hidden);
  for (const id of info?.hidden ?? scene.legend.filter((row) => row.hidden).map((row) => row.id)) next.add(id);
  const row = scene.legend.find((entry) => entry.id === rowId);
  if (row ? row.hidden : next.has(rowId)) {
    for (const key of info?.keys.get(rowId) ?? [rowId, row?.name ?? rowId]) next.delete(key);
  } else {
    next.add(rowId);
  }
  return Array.from(next);
}

/** v1 legend entries: every row, hidden ones included. */
export function legendEntries(rows: readonly LegendRowDraft[]): LegendEntry[] {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    color: row.color,
    ...(row.detail !== undefined ? { detail: row.detail } : {}),
    hidden: row.hidden,
  }));
}

export function resolveLegendPlacement(
  hideLegend: boolean,
  isPie: boolean,
): CompiledChart["legendPlacement"] {
  return hideLegend ? "hidden" : isPie ? "right" : "top";
}

// ---------------------------------------------------------------------------
// Text metrics

const MONOSPACE_FAMILY = /mono|courier|consol|menlo|monaco|fixed/i;

/** True when the first family of a CSS font stack is a monospace face (the chart default). */
export function isMonospaceFont(font: string | undefined): boolean {
  const first = font?.split(",")[0]?.trim().replace(/^["']|["']$/g, "") ?? "";
  return MONOSPACE_FAMILY.test(first);
}

/**
 * Approximate advance of `text` in `font` (a CSS font-family stack). The
 * default chart font is monospace, measured per character; proportional
 * fonts use per-glyph classes so narrow labels (`il1`) and wide ones (`MW`)
 * do not share one average. Wrapped rows then neither overflow nor leave gaps.
 */
export function estimateTextWidth(text: string, fontSize: number, font?: string): number {
  const mono = isMonospaceFont(font);
  let em = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x2e80) em += 1;
    else if (mono) em += 0.61;
    else if ("iljI.,:;'|!`".includes(ch)) em += 0.28;
    else if (ch === " " || "()[]{}/\\-".includes(ch)) em += 0.33;
    else if ("mwMW@%".includes(ch)) em += 0.86;
    else if (ch >= "A" && ch <= "Z") em += 0.66;
    else if (ch >= "0" && ch <= "9") em += 0.57;
    else em += 0.54;
  }
  return Math.ceil(em * fontSize * 1.04);
}

/** Shorten `text` with an ellipsis so it fits `maxWidth`. */
export function truncateText(text: string, maxWidth: number, fontSize: number, font?: string): string {
  if (estimateTextWidth(text, fontSize, font) <= maxWidth) return text;
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTextWidth(`${chars.slice(0, mid).join("").trimEnd()}…`, fontSize, font) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${chars.slice(0, lo).join("").trimEnd()}…` : "…";
}

// ---------------------------------------------------------------------------
// Layout

/** Top legend metrics, shared with the renderers through the scene layout. */
export const TOP_LEGEND = Object.freeze({
  /** Top of the first row. */
  y: 5,
  rowHeight: 16,
  fontSize: 10,
  /** Space between the swatch and the name, and between the name and the detail. */
  swatchGap: 5,
  detailGap: 6,
  itemGap: 14,
  /** Right-hand inset from the chart edge. */
  inset: 8,
});

/** Side (pie) legend metrics. */
export const SIDE_LEGEND = Object.freeze({
  /** Offset of the column from the plot's right edge. */
  offset: 18,
  inset: 8,
  stackedRow: 40,
  compactRow: 20,
  nameFont: 11,
  detailFont: 9,
  textX: 14,
});

export function swatchWidth(symbol: LegendSymbol): number {
  return symbol === "line" ? 12 : 8;
}

function moreLabel(count: number): string {
  return `+${count} more`;
}

interface TopFlow {
  rows: SceneLegendRow[];
  lines: number;
  overflow: LegendRowDraft[];
  more?: SceneLegendLayout["more"];
}

function flowTopRows(
  rows: readonly LegendRowDraft[], x0: number, maxX: number, maxLines: number, font: string,
): TopFlow {
  const { rowHeight, fontSize, swatchGap, detailGap, itemGap } = TOP_LEGEND;
  const avail = Math.max(48, maxX - x0);
  const items = rows.map((row) => {
    const sw = swatchWidth(row.symbol);
    const detailW = row.detail ? detailGap + estimateTextWidth(row.detail, fontSize, font) : 0;
    const label = truncateText(row.name, Math.max(12, avail - sw - swatchGap - detailW), fontSize, font);
    return { row, label, w: sw + swatchGap + estimateTextWidth(label, fontSize, font) + detailW };
  });
  const placed: { item: typeof items[number]; line: number; x: number }[] = [];
  let line = 0;
  let x = x0;
  for (const item of items) {
    if (x > x0 && x + item.w > maxX) {
      line += 1;
      x = x0;
    }
    placed.push({ item, line, x });
    x += item.w + itemGap;
  }
  const lines = Math.max(1, line + 1);
  let kept = placed;
  let overflow: LegendRowDraft[] = [];
  let more: TopFlow["more"];
  if (lines > maxLines) {
    kept = placed.filter((entry) => entry.line < maxLines);
    overflow = placed.filter((entry) => entry.line >= maxLines).map((entry) => entry.item.row);
    for (;;) {
      const label = moreLabel(overflow.length);
      const width = estimateTextWidth(label, fontSize, font);
      const last = kept[kept.length - 1];
      const onLastLine = last !== undefined && last.line === maxLines - 1;
      const start = onLastLine ? last.x + last.item.w + itemGap : x0;
      if (!onLastLine || start + width <= maxX) {
        more = {
          box: { x: start, y: TOP_LEGEND.y + (maxLines - 1) * rowHeight, w: width, h: rowHeight },
          label,
          names: overflow.map((row) => row.name),
        };
        break;
      }
      overflow.unshift(kept.pop()!.item.row);
    }
  }
  return {
    rows: kept.map(({ item, line: at, x: left }) => ({
      ...legendRowFields(item.row),
      label: item.label,
      box: { x: left, y: TOP_LEGEND.y + at * rowHeight, w: item.w, h: rowHeight },
    })),
    lines: Math.min(lines, maxLines),
    overflow,
    more,
  };
}

function legendRowFields(row: LegendRowDraft): SceneLegendRow {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    ...(row.detail !== undefined ? { detail: row.detail } : {}),
    hidden: row.hidden,
    markIndex: row.markIndex,
    symbol: row.symbol,
  };
}

/** Most wrapped top-legend lines a chart of `height` gives up: about 30% of it. */
function defaultMaxTopLines(height: number): number {
  return Math.max(1, Math.floor((height * 0.3) / TOP_LEGEND.rowHeight));
}

export interface TopLegendBand {
  /** Wrapped lines the legend will use. */
  lines: number;
  /** Line budget; rows beyond it collapse into `+N more`. */
  maxLines: number;
}

/**
 * Plan the top legend before scales exist: how many wrapped lines the rows
 * need at this width. Unless `spec.margin.top` is explicit, the caller grows
 * the top margin by one row height per extra line.
 */
export function planTopLegend(
  rows: readonly LegendRowDraft[],
  spec: ChartSpec,
  width: number,
  height: number,
  margin: Margin,
  font: string,
): TopLegendBand {
  const explicitTop = spec.margin?.top;
  const maxLines = explicitTop !== undefined
    ? Math.max(1, Math.floor((explicitTop - TOP_LEGEND.y - 4) / TOP_LEGEND.rowHeight))
    : defaultMaxTopLines(height);
  if (!rows.length) return { lines: 0, maxLines };
  const flow = flowTopRows(rows, margin.left, width - TOP_LEGEND.inset, maxLines, font);
  return { lines: flow.lines, maxLines };
}

/** Margin with room for `band.lines` wrapped top-legend rows (explicit top margins win). */
export function growTopMargin(margin: Margin, band: TopLegendBand, spec: ChartSpec): Margin {
  if (spec.margin?.top !== undefined || band.lines <= 1) return margin;
  return { ...margin, top: margin.top + (band.lines - 1) * TOP_LEGEND.rowHeight };
}

function layoutSideLegend(
  rows: readonly LegendRowDraft[], plot: PlotRect, width: number, margin: Margin, font: string,
): SceneLegendLayout {
  const { offset, inset, stackedRow, compactRow, nameFont, detailFont, textX } = SIDE_LEGEND;
  const x = plot.x + plot.w + offset;
  const colW = Math.max(40, width - x - inset);
  const avail = Math.max(compactRow, plot.h);
  const stacked = rows.length * stackedRow <= avail;
  const rowH = stacked ? stackedRow : compactRow;
  let shown = rows;
  let overflow: LegendRowDraft[] = [];
  if (!stacked && rows.length * compactRow > avail) {
    const capacity = Math.max(0, Math.floor(avail / compactRow) - 1);
    shown = rows.slice(0, capacity);
    overflow = rows.slice(capacity);
  }
  const slots = shown.length + (overflow.length ? 1 : 0);
  const y0 = plot.y + Math.max(0, (plot.h - slots * rowH) / 2);
  const out: SceneLegendRow[] = shown.map((row, i) => {
    // One-line rows show the short detail (a pie's percentage) so names keep their room.
    const detail = stacked ? row.detail : row.shortDetail ?? row.detail;
    const detailW = !stacked && detail ? estimateTextWidth(detail, detailFont, font) + 8 : 0;
    const box: SceneLegendBox = { x, y: y0 + i * rowH, w: colW, h: rowH };
    const fields = legendRowFields(row);
    return {
      ...fields,
      ...(detail !== undefined ? { detail } : {}),
      label: truncateText(row.name, Math.max(12, colW - textX - detailW), nameFont, font),
      box,
    };
  });
  return {
    placement: "right",
    rows: out,
    size: margin.right,
    overflow: overflow.length,
    rowStyle: stacked ? "stacked" : "compact",
    ...(overflow.length
      ? {
        more: {
          box: { x, y: y0 + shown.length * rowH, w: colW, h: rowH },
          label: moreLabel(overflow.length),
          names: overflow.map((row) => row.name),
        },
      }
      : {}),
  };
}

export interface LegendLayoutInput {
  placement: CompiledChart["legendPlacement"];
  width: number;
  height: number;
  plot: PlotRect;
  margin: Margin;
  /** CSS font stack the renderers paint with (the theme font). */
  font: string;
  /** Top-legend line budget from planTopLegend(). */
  maxLines?: number;
}

/** Position every legend row in scene pixels; rows that do not fit become `+N more`. */
export function layoutLegend(rows: readonly LegendRowDraft[], input: LegendLayoutInput): SceneLegendLayout {
  const { placement, width, height, plot, margin, font } = input;
  if (placement === "hidden" || !rows.length) return { placement, rows: [], size: 0, overflow: 0 };
  if (placement === "right") return layoutSideLegend(rows, plot, width, margin, font);
  const maxLines = input.maxLines ?? defaultMaxTopLines(height);
  const flow = flowTopRows(rows, plot.x, width - TOP_LEGEND.inset, maxLines, font);
  return {
    placement: "top",
    rows: flow.rows,
    size: TOP_LEGEND.y + flow.lines * TOP_LEGEND.rowHeight,
    overflow: flow.overflow.length,
    rowStyle: "inline",
    ...(flow.more ? { more: flow.more } : {}),
  };
}

/**
 * The scene's legend layout. Compiled scenes carry one; for hand-built scenes
 * (v1 `legend` only) it is derived here so every renderer paints and hit-tests
 * the same boxes.
 */
export function sceneLegendLayout(c: CompiledChart): SceneLegendLayout {
  const own = c.legendLayout;
  // A scene edited by hand (for example `{ ...scene, legend: rows }`) can
  // carry a stale layout; only trust one that still describes `legend`.
  if (
    own
    && own.placement === c.legendPlacement
    && own.rows.length + own.overflow === c.legend.length
    && own.rows.every((row, i) => row.name === c.legend[i]?.name)
  ) {
    return own;
  }
  const rows = c.legend.map((entry, index): LegendRowDraft => ({
    id: typeof entry.id === "string" ? entry.id : entry.name,
    name: entry.name,
    color: entry.color,
    ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    hidden: entry.hidden === true,
    markIndex: index,
    symbol: "rect",
  }));
  return layoutLegend(rows, {
    placement: c.legendPlacement, width: c.width, height: c.height, plot: c.plot, margin: c.margin, font: c.theme.font,
  });
}

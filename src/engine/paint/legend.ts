// Financial legend. Every frame builds one LegendModel: the title row (symbol,
// interval, exchange, market status), the OHLC and change of the bar under
// the crosshair, volume, and one row per study with every plot value in its
// colour. An attached LegendView (the DOM legend in the overlay host, see
// src/ui/Legend.ts) renders the model. Without a view (a headless renderer)
// the same model is painted on the canvas, clipped to the plot, and
// composeLegendSnapshot() paints it into screenshots.
//
// On a Heikin-Ashi chart the OHLC readout shows the transformed bar that is
// plotted under the crosshair, like TradingView.

import type { LibrarySymbolInfo } from "../../types/charting_library";
import type { ChartContext } from "../../core/context";
import { withAlpha } from "../../core/theme";
import { t } from "../../i18n";
import { studyInstanceLabel } from "../../studies/label";
import type { StudyInstance } from "../../studies/StudyStore";
import { formatVolume } from "../../util/format";
import { resolutionLabel } from "../../util/resolution";
import { indexForX } from "../plotScale";
import type { FinanceView } from "./view";

// ── Model ───────────────────────────────────────────────────────────────────

/** One labelled value: an OHLC field, volume, or one study plot. */
export interface LegendValue {
  /** Short visible label ("O") or plot title ("Upper"); may be empty. */
  readonly title: string;
  readonly text: string;
  readonly color: string;
}

export type MarketStatus = "open" | "closed";

export interface LegendTitle {
  readonly symbol: string;
  readonly interval: string;
  readonly exchange: string | null;
  readonly description: string | null;
  /** null when the session is unknown or unparsable. */
  readonly status: MarketStatus | null;
}

export interface LegendSeries {
  /** O, H, L, C (only C below LEGEND_NARROW_WIDTH). */
  readonly values: readonly LegendValue[];
  /** "+18 (+0.26%)", or null when the change is hidden or undefined. */
  readonly change: string | null;
  readonly color: string;
}

export interface LegendStudy {
  readonly id: string;
  /** "EMA 9", "BB 20 2"; always set, so it can name the row's controls. */
  readonly label: string;
  /** Whether the label is painted (`showStudyTitles`). */
  readonly showLabel: boolean;
  readonly values: readonly LegendValue[];
  readonly removable: boolean;
}

export interface LegendTheme {
  readonly text: string;
  /** Row backdrop colour, or "" for none. */
  readonly background: string;
  readonly font: string;
}

export interface LegendModel {
  readonly title: LegendTitle | null;
  readonly series: LegendSeries | null;
  readonly volume: LegendValue | null;
  readonly studies: readonly LegendStudy[];
  /** The plot is narrower than LEGEND_NARROW_WIDTH: O/H/L and the description are dropped. */
  readonly narrow: boolean;
  readonly theme: LegendTheme;
}

/** What a view renders each frame. Coordinates are CSS px in the overlay host. */
export interface LegendFrame {
  /** null hides the legend (feature disabled, `showLegend: false`). */
  readonly model: LegendModel | null;
  readonly left: number;
  readonly top: number;
  /** Maximum width: glyphs never reach the price axis. */
  readonly width: number;
  /** Height of the main price pane. */
  readonly height: number;
  /** Mouse crosshair position, for hover affordances; null when inactive. */
  readonly pointer: { readonly x: number; readonly y: number } | null;
}

export interface LegendView {
  render(frame: LegendFrame): void;
}

/** Plot width below which the legend drops O/H/L and the symbol description. */
export const LEGEND_NARROW_WIDTH = 420;
/** Share of the price pane the legend may cover before study rows collapse into "+N". */
export const LEGEND_MAX_HEIGHT_FRACTION = 0.75;
/** Plot width below which the exchange is dropped too. */
const LEGEND_TINY_WIDTH = 300;
const INSET_X = 8;
const INSET_Y = 6;

// ── Options (TradingView `paneProperties.legendProperties.*` overrides) ─────

/** A `paneProperties.legendProperties.<key>` override; every flag defaults to on. */
function legendFlag(context: ChartContext, key: string): boolean {
  return context.options.overrides?.[`paneProperties.legendProperties.${key}`] !== false;
}

// ── Market status ───────────────────────────────────────────────────────────

const SESSION_PART = /^(\d{2})(\d{2})-(\d{2})(\d{2})(?::([1-7]+))?$/;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const clocks = new Map<string, Intl.DateTimeFormat>();

/** Weekday (0 = Sunday) and minute of day at `nowMs` in `timeZone`, or null for an unknown zone. */
function wallClock(timeZone: string, nowMs: number): { weekday: number; minute: number } | null {
  let clock = clocks.get(timeZone);
  if (!clock) {
    try {
      clock = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" });
    } catch {
      return null;
    }
    clocks.set(timeZone, clock);
  }
  const parts: Record<string, string> = {};
  for (const part of clock.formatToParts(nowMs)) parts[part.type] = part.value;
  const weekday = WEEKDAYS.indexOf(parts.weekday ?? "");
  return weekday < 0 ? null : { weekday, minute: (Number(parts.hour) % 24) * 60 + Number(parts.minute) };
}

/**
 * Whether the symbol's regular session is open at `nowMs`, from a
 * TradingView session string ("24x7", "0930-1600", "1700-1600:23456",
 * "0930-1200,1300-1600"). Days are 1 = Sunday ... 7 = Saturday and default to
 * Monday-Friday; a session whose end is not after its start opens the day
 * before. Returns null when the session or timezone cannot be interpreted.
 */
export function marketStatus(
  info: Pick<LibrarySymbolInfo, "session" | "timezone"> | null | undefined,
  nowMs: number,
): MarketStatus | null {
  const session = typeof info?.session === "string" ? info.session.trim() : "";
  if (!session) return null;
  if (/^24x7$/i.test(session)) return "open";
  const wall = wallClock(info!.timezone || "Etc/UTC", nowMs);
  if (!wall) return null;
  const minute = wall.minute;
  const today = String(wall.weekday + 1);
  const tomorrow = String(((wall.weekday + 1) % 7) + 1);
  let parsed = false;
  for (const part of session.split(/[|,]/)) {
    const match = SESSION_PART.exec(part.trim());
    if (!match) continue;
    parsed = true;
    const start = Number(match[1]) * 60 + Number(match[2]);
    const end = Number(match[3]) * 60 + Number(match[4]);
    const days = match[5] ?? "23456";
    if (start < end) {
      if (days.includes(today) && minute >= start && minute < end) return "open";
    } else if (start === end) {
      if (days.includes(today)) return "open";
    } else if ((minute >= start && days.includes(tomorrow)) || (minute < end && days.includes(today))) {
      return "open";
    }
  }
  return parsed ? "closed" : null;
}

const statusCache = new WeakMap<ChartContext, { key: string; status: MarketStatus | null }>();

function cachedMarketStatus(context: ChartContext): MarketStatus | null {
  const info = context.symbolInfo;
  if (!info) return null;
  const now = context.now();
  const key = `${info.session}|${info.timezone}|${Math.floor(now / 60_000)}`;
  const cached = statusCache.get(context);
  if (cached?.key === key) return cached.status;
  const status = marketStatus(info, now);
  statusCache.set(context, { key, status });
  return status;
}

// ── Model builder ───────────────────────────────────────────────────────────

/** Strip the alpha channel so translucent band colours stay legible as text. */
export function opaqueColor(color: string): string {
  const value = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{1,2})$/i.exec(value);
  if (hex && (value.length === 5 || value.length === 9)) return `#${hex[1]}`;
  const rgba = /^rgba?\(([^,]+),([^,]+),([^,)]+)(?:,[^)]*)?\)$/i.exec(value.replace(/\s+/g, ""));
  if (rgba) return `rgb(${rgba[1]},${rgba[2]},${rgba[3]})`;
  return value;
}

/** The bar index the legend describes: under the crosshair, else the last bar. */
function legendIndex(v: FinanceView, count: number): number {
  if (!v.crosshair.active) return count - 1;
  return Math.max(0, Math.min(count - 1, Math.round(indexForX(v, v.crosshair.x))));
}

function studyValueText(study: StudyInstance, value: number, formatPrice: (value: number) => string): string {
  if (study.def.formatValue) return study.def.formatValue(value);
  return study.def.pane === "pane" ? value.toFixed(1) : formatPrice(value);
}

interface PlotMeta {
  readonly title?: string;
  readonly inLegend?: boolean;
}

function studyValues(study: StudyInstance, index: number, formatPrice: (value: number) => string): LegendValue[] {
  // v2 definitions (W1B-15) describe their plots; v1 series carry name/colour.
  const plots = (study.def as { plots?: readonly PlotMeta[] }).plots;
  const values: LegendValue[] = [];
  study.series.forEach((series, i) => {
    const plot = plots?.[i];
    if (plot?.inLegend === false) return;
    const raw = series.values[index];
    const finite = typeof raw === "number" && Number.isFinite(raw);
    values.push({
      title: series.name ?? plot?.title ?? "",
      text: finite ? studyValueText(study, raw, formatPrice) : "∅",
      color: opaqueColor(series.color || study.color),
    });
  });
  return values;
}

function legendTitle(context: ChartContext, plotW: number): LegendTitle {
  const info = context.symbolInfo;
  const symbol = info?.name || context.symbol;
  const description = info?.description?.trim() || null;
  return {
    symbol,
    interval: resolutionLabel(context.resolution),
    exchange: plotW < LEGEND_TINY_WIDTH ? null : (info?.exchange || info?.listed_exchange || null),
    description: plotW < LEGEND_NARROW_WIDTH || !description || description.toLowerCase() === symbol.toLowerCase()
      ? null
      : description,
    status: cachedMarketStatus(context),
  };
}

/** Build the legend model for this frame, or null when the legend is off. */
export function buildLegendModel(v: FinanceView): LegendModel | null {
  const context = v.context;
  if (!context.features.has("legend_widget") || !legendFlag(context, "showLegend")) return null;
  const flag = (key: string): boolean => legendFlag(context, key);
  const disabled = context.options.disabled_features ?? [];
  const removable = !disabled.includes("edit_buttons_in_legend") && !disabled.includes("delete_button_in_legend");
  const transparency = Number(context.options.overrides?.["paneProperties.legendProperties.backgroundTransparency"] ?? 50);

  const theme = context.theme;
  const narrow = v.plotW < LEGEND_NARROW_WIDTH;
  const real = context.bars;
  // seriesBars is the plotted series (Heikin-Ashi when that style is active).
  const plotted = v.seriesBars.length === real.length ? v.seriesBars : real;
  const index = real.length ? legendIndex(v, real.length) : -1;
  const bar = plotted[index];
  const pricescale = context.symbolInfo?.pricescale ?? 100;
  const formatPrice = (value: number): string => context.formatPrice(value, pricescale);

  let series: LegendSeries | null = null;
  let volume: LegendValue | null = null;
  if (bar) {
    const color = bar.close >= bar.open ? theme.candleUp : theme.candleDown;
    const values: LegendValue[] = [];
    if (flag("showSeriesOHLC")) {
      if (!narrow) {
        values.push(
          { title: t("legend.open", "O"), text: formatPrice(bar.open), color },
          { title: t("legend.high", "H"), text: formatPrice(bar.high), color },
          { title: t("legend.low", "L"), text: formatPrice(bar.low), color },
        );
      }
      values.push({ title: t("legend.close", "C"), text: formatPrice(bar.close), color });
    }
    let change: string | null = null;
    if (flag("showBarChange") && bar.open > 0) {
      const abs = bar.close - bar.open;
      const sign = abs >= 0 ? "+" : "-";
      change = `${sign}${formatPrice(Math.abs(abs))} (${sign}${Math.abs((abs / bar.open) * 100).toFixed(2)}%)`;
    }
    if (values.length || change) series = { values, change, color };
    const volumeValue = real[index]?.volume;
    if (flag("showVolume") && context.volumeMode !== "hidden" && volumeValue && Number.isFinite(volumeValue)) {
      volume = { title: t("legend.volume", "Vol"), text: formatVolume(volumeValue), color };
    }
  }

  const studies: LegendStudy[] = v.studies.list().map((study) => ({
    id: String(study.id),
    label: studyInstanceLabel(study, { showInputs: flag("showStudyArguments") }),
    showLabel: flag("showStudyTitles"),
    values: flag("showStudyValues") && index >= 0 ? studyValues(study, index, formatPrice) : [],
    removable: removable && !study.lock,
  }));

  return {
    title: flag("showSeriesTitle") ? legendTitle(context, v.plotW) : null,
    series,
    volume,
    studies,
    narrow,
    theme: {
      text: theme.scaleText,
      // TradingView default: a backdrop at 50% transparency.
      background: flag("showBackground") && transparency < 100
        ? withAlpha(theme.paneBackground, 1 - Math.max(0, transparency || 0) / 100)
        : "",
      font: context.fontFamily,
    },
  };
}

/** Legend placement for this frame (inside the main price pane). */
export function legendFrame(v: FinanceView, model: LegendModel | null): LegendFrame {
  return {
    model,
    left: v.plotL + INSET_X,
    top: v.plotT + INSET_Y,
    width: Math.max(0, v.plotW - INSET_X * 2),
    height: Math.max(0, v.plotH - INSET_Y),
    pointer: v.crosshair.active ? { x: v.crosshair.x, y: v.crosshair.y } : null,
  };
}

// ── View registry ───────────────────────────────────────────────────────────

const views = new WeakMap<ChartContext, LegendView>();

/**
 * Route this chart's legend to `view` (the DOM legend) instead of the canvas.
 * Returns the detach function.
 */
export function attachLegendView(context: ChartContext, view: LegendView): () => void {
  views.set(context, view);
  return () => {
    if (views.get(context) === view) views.delete(context);
  };
}

/** Legend mark of the finance scene. */
export function drawLegend(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  const model = buildLegendModel(v);
  const view = views.get(v.context);
  if (view) {
    view.render(legendFrame(v, model));
    return;
  }
  if (model) paintLegendModel(ctx, v, model);
}

// ── Canvas painter (headless renderers and screenshots) ─────────────────────

const LINE_H = 16;

/**
 * Paint a legend model on a canvas: title and OHLC on the first line, then
 * volume and one line per study, clipped to the plot so no glyph reaches the
 * price axis. Studies that do not fit are summarised as "+N".
 */
export function paintLegendModel(ctx: CanvasRenderingContext2D, v: FinanceView, model: LegendModel): void {
  const frame = legendFrame(v, model);
  const right = frame.left + frame.width;
  const maxLines = Math.max(2, Math.floor((frame.height * LEGEND_MAX_HEIGHT_FRACTION) / LINE_H));
  ctx.save();
  ctx.beginPath();
  ctx.rect(frame.left - 2, frame.top, frame.width + 2, frame.height);
  ctx.clip();
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = `12px ${model.theme.font}`;
  let x = frame.left;
  let y = frame.top + 13;
  const text = (value: string, color: string, gap: number): void => {
    if (!value || x >= right) return;
    ctx.fillStyle = color;
    ctx.fillText(value, x, y);
    x += ctx.measureText(value).width + gap;
  };
  const values = (items: readonly LegendValue[]): void => {
    for (const item of items) {
      text(item.title, model.theme.text, 3);
      text(item.text, item.color, 9);
    }
  };
  const title = model.title;
  if (title) {
    const parts = [title.symbol, title.interval, title.exchange].filter(Boolean).join(" · ");
    text(parts, model.theme.text, 12);
  }
  if (model.series) {
    values(model.series.values);
    if (model.series.change) text(model.series.change, model.series.color, 12);
  }
  let lines = 1;
  const newline = (): void => {
    x = frame.left;
    y += LINE_H;
    lines += 1;
  };
  if (model.volume) {
    newline();
    values([model.volume]);
  }
  const studies = model.studies;
  const fit = studies.length + lines <= maxLines ? studies.length : Math.max(0, maxLines - lines - 1);
  for (let i = 0; i < fit; i++) {
    const study = studies[i]!;
    newline();
    if (study.showLabel) text(study.label, model.theme.text, 6);
    for (const value of study.values) text(value.text, value.color, 8);
  }
  if (fit < studies.length) {
    newline();
    text(`+${studies.length - fit}`, model.theme.text, 0);
  }
  ctx.restore();
}

/**
 * Paint the legend into an export that the whole scene was just repainted
 * into (ChartRenderer.snapshot()). With a DOM legend attached the scene's
 * drawLegend() mark renders the DOM instead of the canvas, so the export
 * would otherwise lack it; without one the scene already painted it.
 */
export function paintLegendForExport(ctx: CanvasRenderingContext2D, v: FinanceView): void {
  if (!views.has(v.context)) return;
  const model = buildLegendModel(v);
  if (model) paintLegendModel(ctx, v, model);
}

/**
 * The canvas to export as a screenshot. When the DOM legend is active the
 * canvas has no legend pixels, so a copy is returned with the legend painted
 * in; otherwise `source` itself (it already carries the canvas legend).
 */
export function composeLegendSnapshot(source: HTMLCanvasElement, v: FinanceView): HTMLCanvasElement {
  if (!views.has(v.context)) return source;
  const model = buildLegendModel(v);
  if (!model) return source;
  const copy = source.ownerDocument.createElement("canvas");
  copy.width = source.width;
  copy.height = source.height;
  const ctx = copy.getContext("2d");
  if (!ctx) return source;
  ctx.drawImage(source, 0, 0);
  ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
  paintLegendModel(ctx, v, model);
  return copy;
}

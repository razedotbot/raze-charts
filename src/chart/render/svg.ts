// SVG renderer: scene nodes, grid, axes, colour bar, and document assembly.

import { compileChart } from "../compile/chart";
import type { ChartDefinition, CompiledChart, SceneNode } from "../compile/types";
import { heatFill, type DashboardTheme } from "../theme";
import { lastValuesSvg, valueAxisWidth } from "./chips";
import { legendSvg } from "./legend";
import {
  AREA_GRADIENT_STOPS,
  arcPath,
  esc,
  hair,
  lift,
  normalizedOpacity,
  round,
  roundBottomRect,
  roundTopRect,
  seriesPath,
  shade,
  svgOpacity,
} from "./primitives";

export interface SvgRenderOptions {
  /** Stable prefix for SSR/hydration or multiple charts in one document. */
  idPrefix?: string;
}

// One sequence for generated SVG ids and mount ids so documents never collide.
let svgSeq = 0;

export function nextRenderSequence(): number {
  return ++svgSeq;
}

export function safeId(value: string): string {
  const clean = value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || "chart";
}

function nodeSvg(n: SceneNode, i: number, theme: DashboardTheme, uid: string): string {
  const stroke = n.stroke ?? "none";
  const fill = n.fill ?? "none";
  const sw = n.strokeWidth != null ? ` stroke-width="${n.strokeWidth}"` : "";
  const lc = ` stroke-linecap="round" stroke-linejoin="round"`;
  const mark = n.idx != null ? ` data-idx="${n.idx}"` : "";
  const role = n.role ? ` data-role="${esc(n.role)}"` : "";
  const meta = `${mark}${role}`;
  if (n.type === "line" && n.points?.length) {
    const dash = n.dashed ? ` stroke-dasharray="4.5 3.5"` : "";
    const path = n.dashed && n.points.length <= 2
      ? `M${round(n.points[0]!.x)} ${round(n.points[0]!.y)} L${round(n.points[1]?.x ?? n.points[0]!.x)} ${round(n.points[1]?.y ?? n.points[0]!.y)}`
      : seriesPath(n.points, n.curve);
    return `<path fill="none" stroke="${esc(stroke)}"${sw}${lc}${dash}${meta} d="${path}" />`;
  }
  if (n.type === "area" && n.points && n.points.length >= 3) {
    const gid = `raze-fill-${uid}-${i}`;
    const opacity = normalizedOpacity(n.fillOpacity, 0.42);
    let d: string;
    if (n.role === "ranged-area") {
      d = `${seriesPath(n.points, "linear")} Z`;
    } else {
      const mid = n.points.slice(1, -1);
      const yBase = n.points[0]!.y;
      const top = mid[0]!;
      const last = mid[mid.length - 1]!;
      d = `${seriesPath(mid, n.curve)} L${round(last.x)} ${round(yBase)} L${round(top.x)} ${round(yBase)} Z`;
    }
    return [
      `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">`,
      ...AREA_GRADIENT_STOPS.map(([offset, factor]) => (
        `<stop offset="${offset * 100}%" stop-color="${esc(fill)}" stop-opacity="${svgOpacity(opacity * factor)}"/>`
      )),
      `</linearGradient></defs>`,
      `<path fill="url(#${gid})" stroke="${esc(stroke)}"${sw}${lc}${meta} d="${d}" />`,
    ].join("");
  }
  if (n.type === "polygon" && n.points) {
    const pts = n.points.map((p) => `${round(p.x)},${round(p.y)}`).join(" ");
    const fo = n.fillOpacity != null && n.fill !== "none" ? ` fill-opacity="${n.fillOpacity}"` : "";
    return `<polygon fill="${esc(fill)}"${fo} stroke="${esc(stroke)}"${sw}${lc}${meta} points="${pts}" />`;
  }
  if (n.type === "rect") {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const w = Math.max(0, n.w ?? 0);
    const h = Math.max(0, n.h ?? 0);
    const st = n.stroke && n.stroke !== "none"
      ? ` stroke="${esc(n.stroke)}" stroke-width="${n.strokeWidth ?? 1}"`
      : "";
    const fo = n.fillOpacity != null ? ` fill-opacity="${n.fillOpacity}"` : "";
    if (n.corner === "top" || n.corner === "bottom") {
      const gid = `raze-bar-${uid}-${i}`;
      const hi = lift(fill, 0.22);
      const lo = shade(fill, 0.14);
      const rr = Math.min(2.5, w / 2, Math.max(0, h));
      const sheen = h >= 6 && w >= 4
        ? `<path d="M${round(x + rr + 0.5)} ${hair(n.corner === "bottom" ? y + h : y)} L${round(x + w - rr - 0.5)} ${hair(n.corner === "bottom" ? y + h : y)}" fill="none" stroke="rgba(244,238,225,0.28)" stroke-width="1" stroke-linecap="round" />`
        : "";
      return [
        `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">`,
        `<stop offset="0%" stop-color="${esc(n.corner === "bottom" ? lo : hi)}"/>`,
        `<stop offset="38%" stop-color="${esc(fill)}"/>`,
        `<stop offset="100%" stop-color="${esc(n.corner === "bottom" ? hi : lo)}"/>`,
        `</linearGradient></defs>`,
        `<path d="${n.corner === "bottom" ? roundBottomRect(x, y, w, h, rr) : roundTopRect(x, y, w, h, rr)}" fill="url(#${gid})"${fo}${st}${meta} />`,
        sheen,
      ].join("");
    }
    if (n.corner === "none" || n.role === "heat") {
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${esc(fill)}"${fo}${st}${meta} />`;
    }
    const rx = Math.min(2.5, w / 2, h / 2);
    return `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" rx="${rx}" fill="${esc(fill)}"${fo}${st}${meta} />`;
  }
  if (n.type === "circle") {
    const cs = n.stroke && n.stroke !== "none" ? ` stroke="${esc(n.stroke)}" stroke-width="${n.strokeWidth ?? 1}"` : "";
    const fo = n.fillOpacity != null ? ` fill-opacity="${n.fillOpacity}"` : "";
    return `<circle cx="${round(n.x ?? 0)}" cy="${round(n.y ?? 0)}" r="${round(n.r ?? 3)}" fill="${esc(fill)}"${fo}${cs}${meta} />`;
  }
  if (n.type === "rule") {
    const dash = n.dashed === false ? "" : ` stroke-dasharray="3.5 3"`;
    return `<line x1="${hair(n.x ?? 0)}" y1="${hair(n.y ?? 0)}" x2="${hair(n.x2 ?? 0)}" y2="${hair(n.y2 ?? 0)}" stroke="${esc(stroke)}"${sw}${dash}${meta} />`;
  }
  if (n.type === "arc") {
    const fo = n.fillOpacity != null ? ` fill-opacity="${n.fillOpacity}"` : "";
    return `<path d="${arcPath(n)}" fill="${esc(fill)}"${fo} stroke="${esc(stroke)}"${sw}${meta} />`;
  }
  if (n.type === "text" && n.label) {
    const anchor = n.anchor ?? "start";
    const size = n.fontSize ?? 11;
    const baseline = "central";
    const weight = size >= 18 ? ` font-weight="600"` : "";
    return `<text x="${round(n.x ?? 0)}" y="${round(n.y ?? 0)}" text-anchor="${anchor}" dominant-baseline="${baseline}" font-size="${size}"${weight} fill="${esc(n.fill || theme.muted)}"${meta}>${esc(n.label)}</text>`;
  }
  return "";
}

function gridSvg(c: CompiledChart): string {
  const { plot, theme } = c;
  return c.grid && !c.polar
    ? c.yTicks.map((t) =>
      `<line x1="${plot.x}" x2="${plot.x + plot.w}" y1="${hair(t.px)}" y2="${hair(t.px)}" stroke="${esc(theme.grid)}" />`,
    ).join("")
    : "";
}

function yAxisSvg(c: CompiledChart): string {
  const { plot, theme, width, height } = c;
  const axisW = valueAxisWidth(c);
  const yLabelsLeft = c.heatmap;
  return c.polar ? "" : [
    yLabelsLeft ? "" : `<rect x="${plot.x + plot.w}" y="0" width="${axisW}" height="${height}" fill="${esc(theme.background)}" />`,
    yLabelsLeft
      ? `<line x1="${hair(plot.x)}" y1="${plot.y}" x2="${hair(plot.x)}" y2="${plot.y + plot.h}" stroke="${esc(theme.axis)}" />`
      : `<line x1="${hair(plot.x + plot.w)}" y1="${plot.y}" x2="${hair(plot.x + plot.w)}" y2="${plot.y + plot.h}" stroke="${esc(theme.axis)}" />`,
    ...c.yTicks.map((t) => yLabelsLeft
      ? `<text x="${plot.x - 8}" y="${t.px}" text-anchor="end" dominant-baseline="middle" font-size="9" fill="${esc(theme.muted)}">${esc(t.label)}</text>`
      : `<text x="${width - 7}" y="${t.px}" text-anchor="end" dominant-baseline="middle" font-size="9" fill="${esc(theme.muted)}">${esc(t.label)}</text>`),
  ].join("");
}

function xAxisSvg(c: CompiledChart): string {
  const { plot, theme, width, height } = c;
  return c.polar ? "" : [
    `<rect x="0" y="${plot.y + plot.h}" width="${width}" height="${Math.max(0, height - plot.y - plot.h)}" fill="${esc(theme.background)}" />`,
    `<line x1="${c.heatmap ? plot.x : 0}" y1="${hair(plot.y + plot.h)}" x2="${c.heatmap ? plot.x + plot.w : width}" y2="${hair(plot.y + plot.h)}" stroke="${esc(theme.axis)}" />`,
    `<g data-role="x-labels">`,
    ...c.xTicks.map((t) =>
      `<text x="${t.px}" y="${plot.y + plot.h + 14}" text-anchor="middle" font-size="9" fill="${esc(theme.muted)}">${esc(t.label)}</text>`,
    ),
    `</g>`,
  ].join("");
}

function colorBarSvg(c: CompiledChart, uid: string): string {
  if (!c.colorBar || c.polar) return "";
  const { plot, theme } = c;
  const x = plot.x + plot.w + 10;
  const y = plot.y;
  const w = 7;
  const h = plot.h;
  const gid = `raze-heat-${uid}`;
  const { min, max } = c.colorBar;
  const stops: string[] = [];
  const nStop = 12;
  for (let i = 0; i <= nStop; i++) {
    const t = i / nStop;
    const val = min + (max - min) * t;
    stops.push(`<stop offset="${(t * 100).toFixed(1)}%" stop-color="${esc(heatFill(val, min, max, theme))}" />`);
  }
  const zeroY = min < 0 && max > 0
    ? y + h * (max / (max - min))
    : null;
  const fmt = (v: number) => v.toFixed(Math.abs(v) < 10 ? 1 : 0);
  return [
    `<defs><linearGradient id="${gid}" x1="0" y1="1" x2="0" y2="0">${stops.join("")}</linearGradient></defs>`,
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1" fill="url(#${gid})" />`,
    `<text x="${x + w + 5}" y="${y + 1}" dominant-baseline="hanging" font-size="9" fill="${esc(theme.muted)}">${esc(fmt(max))}</text>`,
    zeroY != null
      ? `<text x="${x + w + 5}" y="${zeroY}" dominant-baseline="middle" font-size="9" fill="${esc(theme.muted)}">0</text>`
      : "",
    `<text x="${x + w + 5}" y="${y + h - 1}" dominant-baseline="auto" font-size="9" fill="${esc(theme.muted)}">${esc(fmt(min))}</text>`,
  ].join("");
}

export function renderChartSvg(
  definition: ChartDefinition,
  size: { width: number; height: number },
  options?: SvgRenderOptions,
): string {
  const c = compileChart(definition, size);
  return svgFromCompiled(c, options);
}

export function svgFromCompiled(c: CompiledChart, options?: SvgRenderOptions): string {
  const { width, height, plot, theme } = c;
  const uid = options?.idPrefix ? safeId(options.idPrefix) : String(nextRenderSequence());
  const clipId = `raze-plot-${uid}`;
  const descId = `raze-description-${uid}`;
  const font = `font-family:${esc(theme.font)};font-variant-numeric:tabular-nums;font-feature-settings:'tnum' 1`;

  const grid = gridSvg(c);
  const yAxis = yAxisSvg(c);
  const xAxis = xAxisSvg(c);
  const legend = legendSvg(c);
  const last = lastValuesSvg(c);
  const bar = colorBarSvg(c, uid);

  const clipped = c.nodes.filter((n) => n.clip !== false);
  const body = clipped.map((n, i) => nodeSvg(n, i, theme, uid)).join("");
  const overlay = c.nodes.map((n, i) => n.clip === false ? nodeSvg(n, 800 + i, theme, uid) : "").join("");
  const clip = `<defs><clipPath id="${clipId}"><rect x="${plot.x}" y="${plot.y}" width="${plot.w}" height="${plot.h}" /></clipPath></defs><g clip-path="url(#${clipId})"><g data-role="plot">${body}</g></g>`;

  const description = c.ariaDescription
    ? `<desc id="${descId}">${esc(c.ariaDescription)}</desc>`
    : "";
  const describedBy = description ? ` aria-describedby="${descId}"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(c.ariaLabel)}"${describedBy} style="display:block;width:100%;height:100%;user-select:none;-webkit-user-select:none;${font};background:${esc(theme.background)}">${description}<rect width="${width}" height="${height}" fill="${esc(theme.background)}" />${legend}${grid}${clip}${overlay}${yAxis}${xAxis}${last}${bar}</svg>`;
}

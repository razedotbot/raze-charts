import { asNumber, compileChart, defineChart, type ChartCurve, type ChartDefinition, type ChartViewport, type CompiledChart, type HoverSample, type SceneNode } from "./defineChart";
import { RANGE_PRESETS, presetZoomsIn, viewportFromPreset, type RangePreset } from "./viewport";
import {
  chartColorWithOpacity,
  formatChartColor,
  heatFill,
  parseChartColor,
  readableTextColor,
  type DashboardTheme,
} from "./theme";
import type { LinearScale } from "./scales";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function round(n: number): string {
  return n.toFixed(2);
}

function hair(n: number): number {
  return Math.round(n) + 0.5;
}

/** Fritsch–Carlson monotone cubic. No Catmull overshoot on peaks. */
function monotoneTangents(pts: readonly { x: number; y: number }[]): number[] {
  const n = pts.length;
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1]!.x - pts[i]!.x;
    m[i] = dx === 0 ? 0 : (pts[i + 1]!.y - pts[i]!.y) / dx;
  }
  const t: number[] = [m[0]!];
  for (let i = 1; i < n - 1; i++) {
    t[i] = m[i - 1]! * m[i]! <= 0 ? 0 : (m[i - 1]! + m[i]!) / 2;
  }
  t[n - 1] = m[n - 2]!;
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(m[i]!) < 1e-12) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i]! / m[i]!;
    const b = t[i + 1]! / m[i]!;
    const sum = a * a + b * b;
    if (sum > 9) {
      const factor = 3 / Math.sqrt(sum);
      t[i] = factor * a * m[i]!;
      t[i + 1] = factor * b * m[i]!;
    }
  }
  return t;
}

function monotonePath(pts: readonly { x: number; y: number }[]): string {
  if (!pts.length) return "";
  if (pts.length === 1) return `M${round(pts[0]!.x)} ${round(pts[0]!.y)}`;
  if (pts.length === 2) {
    return `M${round(pts[0]!.x)} ${round(pts[0]!.y)} L${round(pts[1]!.x)} ${round(pts[1]!.y)}`;
  }
  const t = monotoneTangents(pts);
  let d = `M${round(pts[0]!.x)} ${round(pts[0]!.y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i]!;
    const p1 = pts[i + 1]!;
    const h = p1.x - p0.x;
    const c1x = p0.x + h / 3;
    const c1y = p0.y + t[i]! * h / 3;
    const c2x = p1.x - h / 3;
    const c2y = p1.y - t[i + 1]! * h / 3;
    d += ` C${round(c1x)} ${round(c1y)} ${round(c2x)} ${round(c2y)} ${round(p1.x)} ${round(p1.y)}`;
  }
  return d;
}

function seriesPath(pts: readonly { x: number; y: number }[], curve: ChartCurve | undefined): string {
  if (!pts.length) return "";
  if (curve === "linear" || pts.length < 3) {
    return pts.map((p, i) => `${i ? "L" : "M"}${round(p.x)} ${round(p.y)}`).join(" ");
  }
  if (curve === "step") {
    let d = `M${round(pts[0]!.x)} ${round(pts[0]!.y)}`;
    for (let i = 1; i < pts.length; i++) {
      d += ` L${round(pts[i]!.x)} ${round(pts[i - 1]!.y)} L${round(pts[i]!.x)} ${round(pts[i]!.y)}`;
    }
    return d;
  }
  return monotonePath(pts);
}

function traceSeries(ctx: CanvasRenderingContext2D, pts: readonly { x: number; y: number }[], curve: ChartCurve | undefined): void {
  if (!pts.length) return;
  if (curve === "linear" || pts.length < 3) {
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
    return;
  }
  if (curve === "step") {
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i]!.x, pts[i - 1]!.y);
      ctx.lineTo(pts[i]!.x, pts[i]!.y);
    }
    return;
  }
  traceMonotone(ctx, pts);
}

function traceMonotone(ctx: CanvasRenderingContext2D, pts: readonly { x: number; y: number }[]): void {
  if (!pts.length) return;
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  if (pts.length === 1) return;
  if (pts.length === 2) {
    ctx.lineTo(pts[1]!.x, pts[1]!.y);
    return;
  }
  const t = monotoneTangents(pts);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i]!;
    const p1 = pts[i + 1]!;
    const h = p1.x - p0.x;
    ctx.bezierCurveTo(
      p0.x + h / 3,
      p0.y + t[i]! * h / 3,
      p1.x - h / 3,
      p1.y - t[i + 1]! * h / 3,
      p1.x,
      p1.y,
    );
  }
}

const TAU = Math.PI * 2;

function arcSweep(n: SceneNode): number {
  return Math.max(0, Math.min(TAU, (n.endAngle ?? 0) - (n.startAngle ?? 0)));
}

function arcPath(n: SceneNode): string {
  const cx = n.x ?? 0;
  const cy = n.y ?? 0;
  const r = n.r ?? 0;
  const inner = n.innerR ?? 0;
  const a0 = n.startAngle ?? 0;
  const sweep = arcSweep(n);
  if (r <= 0 || sweep <= 1e-9) return "";
  const a1 = a0 + sweep;
  const large = sweep > Math.PI ? 1 : 0;
  const x0 = cx + Math.cos(a0) * r;
  const y0 = cy + Math.sin(a0) * r;
  const x1 = cx + Math.cos(a1) * r;
  const y1 = cy + Math.sin(a1) * r;
  const full = sweep >= TAU - 1e-9;
  const mx = cx + Math.cos(a0 + Math.PI) * r;
  const my = cy + Math.sin(a0 + Math.PI) * r;
  if (inner <= 0 && full) {
    return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 1 1 ${mx} ${my} A ${r} ${r} 0 1 1 ${x1} ${y1} Z`;
  }
  if (inner <= 0) {
    return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`;
  }
  const ix0 = cx + Math.cos(a0) * inner;
  const iy0 = cy + Math.sin(a0) * inner;
  const ix1 = cx + Math.cos(a1) * inner;
  const iy1 = cy + Math.sin(a1) * inner;
  if (full) {
    const imx = cx + Math.cos(a0 + Math.PI) * inner;
    const imy = cy + Math.sin(a0 + Math.PI) * inner;
    return `M ${x0} ${y0} A ${r} ${r} 0 1 1 ${mx} ${my} A ${r} ${r} 0 1 1 ${x1} ${y1} L ${ix1} ${iy1} A ${inner} ${inner} 0 1 0 ${imx} ${imy} A ${inner} ${inner} 0 1 0 ${ix0} ${iy0} Z`;
  }
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} L ${ix1} ${iy1} A ${inner} ${inner} 0 ${large} 0 ${ix0} ${iy0} Z`;
}

function roundTopRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, Math.max(0, h));
  if (rr < 0.5) {
    return `M${round(x)} ${round(y)} h${round(w)} v${round(h)} h${round(-w)} Z`;
  }
  return `M${round(x)} ${round(y + h)} L${round(x)} ${round(y + rr)} Q${round(x)} ${round(y)} ${round(x + rr)} ${round(y)} L${round(x + w - rr)} ${round(y)} Q${round(x + w)} ${round(y)} ${round(x + w)} ${round(y + rr)} L${round(x + w)} ${round(y + h)} Z`;
}

function lift(color: string, t: number): string {
  const parsed = parseChartColor(color);
  if (!parsed) return color;
  const u = Math.max(0, Math.min(1, t));
  return formatChartColor({
    r: parsed.r + (244 - parsed.r) * u,
    g: parsed.g + (238 - parsed.g) * u,
    b: parsed.b + (225 - parsed.b) * u,
    a: parsed.a,
  });
}

function roundBottomRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, Math.max(0, h));
  if (rr < 0.5) {
    return `M${round(x)} ${round(y)} h${round(w)} v${round(h)} h${round(-w)} Z`;
  }
  return `M${round(x)} ${round(y)} L${round(x + w)} ${round(y)} L${round(x + w)} ${round(y + h - rr)} Q${round(x + w)} ${round(y + h)} ${round(x + w - rr)} ${round(y + h)} L${round(x + rr)} ${round(y + h)} Q${round(x)} ${round(y + h)} ${round(x)} ${round(y + h - rr)} Z`;
}

function shade(color: string, t: number): string {
  const parsed = parseChartColor(color);
  if (!parsed) return color;
  const u = Math.max(0, Math.min(1, t));
  return formatChartColor({
    r: parsed.r * (1 - u),
    g: parsed.g * (1 - u),
    b: parsed.b * (1 - u),
    a: parsed.a,
  });
}

const AREA_GRADIENT_STOPS = Object.freeze([
  [0, 1],
  [0.18, 0.72],
  [0.48, 0.28],
  [0.78, 2 / 21],
  [1, 0],
] as const);

function normalizedOpacity(value: number | undefined, fallback: number): number {
  const opacity = value ?? fallback;
  return Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : fallback;
}

function svgOpacity(value: number): string {
  return String(Number(value.toFixed(4)));
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

function chipSvg(
  x: number, y: number, w: number, h: number,
  bg: string, fg: string, label: string, anchor: "end" | "start",
): string {
  const tx = anchor === "end" ? x + w - 6 : x + 6;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2.5" fill="${esc(bg)}" /><text x="${tx}" y="${y + h / 2 + 0.5}" text-anchor="${anchor}" dominant-baseline="middle" font-size="10" font-weight="600" fill="${esc(fg)}">${esc(label)}</text>`;
}

export interface SvgRenderOptions {
  /** Stable prefix for SSR/hydration or multiple charts in one document. */
  idPrefix?: string;
}

export function renderChartSvg(
  definition: ChartDefinition,
  size: { width: number; height: number },
  options?: SvgRenderOptions,
): string {
  const c = compileChart(definition, size);
  return svgFromCompiled(c, options);
}

let svgSeq = 0;

function safeId(value: string): string {
  const clean = value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || "chart";
}

export function svgFromCompiled(c: CompiledChart, options?: SvgRenderOptions): string {
  const { width, height, plot, theme } = c;
  const uid = options?.idPrefix ? safeId(options.idPrefix) : String(++svgSeq);
  const clipId = `raze-plot-${uid}`;
  const descId = `raze-description-${uid}`;
  const font = `font-family:${esc(theme.font)};font-variant-numeric:tabular-nums;font-feature-settings:'tnum' 1`;

  const grid = c.grid && !c.polar
    ? c.yTicks.map((t) =>
      `<line x1="${plot.x}" x2="${plot.x + plot.w}" y1="${hair(t.px)}" y2="${hair(t.px)}" stroke="${esc(theme.grid)}" />`,
    ).join("")
    : "";

  const axisW = Math.max(44, width - plot.x - plot.w);
  const yLabelsLeft = c.heatmap;
  const yAxis = c.polar ? "" : [
    yLabelsLeft ? "" : `<rect x="${plot.x + plot.w}" y="0" width="${axisW}" height="${height}" fill="${esc(theme.background)}" />`,
    yLabelsLeft
      ? `<line x1="${hair(plot.x)}" y1="${plot.y}" x2="${hair(plot.x)}" y2="${plot.y + plot.h}" stroke="${esc(theme.axis)}" />`
      : `<line x1="${hair(plot.x + plot.w)}" y1="${plot.y}" x2="${hair(plot.x + plot.w)}" y2="${plot.y + plot.h}" stroke="${esc(theme.axis)}" />`,
    ...c.yTicks.map((t) => yLabelsLeft
      ? `<text x="${plot.x - 8}" y="${t.px}" text-anchor="end" dominant-baseline="middle" font-size="9" fill="${esc(theme.muted)}">${esc(t.label)}</text>`
      : `<text x="${width - 7}" y="${t.px}" text-anchor="end" dominant-baseline="middle" font-size="9" fill="${esc(theme.muted)}">${esc(t.label)}</text>`),
  ].join("");

  const xAxis = c.polar ? "" : [
    `<rect x="0" y="${plot.y + plot.h}" width="${width}" height="${Math.max(0, height - plot.y - plot.h)}" fill="${esc(theme.background)}" />`,
    `<line x1="${c.heatmap ? plot.x : 0}" y1="${hair(plot.y + plot.h)}" x2="${c.heatmap ? plot.x + plot.w : width}" y2="${hair(plot.y + plot.h)}" stroke="${esc(theme.axis)}" />`,
    `<g data-role="x-labels">`,
    ...c.xTicks.map((t) =>
      `<text x="${t.px}" y="${plot.y + plot.h + 14}" text-anchor="middle" font-size="9" fill="${esc(theme.muted)}">${esc(t.label)}</text>`,
    ),
    `</g>`,
  ].join("");

  let legend = "";
  if (c.legendPlacement === "right" && c.legend.length) {
    const lx = plot.x + plot.w + 18;
    const rowH = 40;
    const block = c.legend.length * rowH;
    const y0 = plot.y + Math.max(0, (plot.h - block) / 2);
    legend = `<g font-size="11">${c.legend.map((l, i) => {
      const y = y0 + i * rowH;
      return `<g data-series="${esc(l.name)}" style="cursor:pointer" transform="translate(${lx},${y})"><rect width="8" height="8" y="2" rx="1.5" fill="${esc(l.color)}" /><text x="14" y="6" dominant-baseline="middle" fill="${esc(theme.text)}">${esc(l.name)}</text>${l.detail ? `<text x="14" y="22" dominant-baseline="middle" font-size="9" fill="${esc(theme.muted)}">${esc(l.detail)}</text>` : ""}</g>`;
    }).join("")}</g>`;
  } else if (c.legendPlacement === "top" && c.legend.length) {
    let lx = plot.x;
    legend = `<g font-size="10">${c.legend.map((l) => {
      const w = 16 + l.name.length * 6.2 + (l.detail ? l.detail.length * 5.6 : 0);
      const g = `<g data-series="${esc(l.name)}" style="cursor:pointer" transform="translate(${lx},14)"><rect width="7" height="7" y="-5" rx="1.5" fill="${esc(l.color)}" /><text x="11" fill="${esc(theme.text)}">${esc(l.name)}${l.detail ? `  ${esc(l.detail)}` : ""}</text></g>`;
      lx += w + 10;
      return g;
    }).join("")}</g>`;
  }

  const placed: number[] = [];
  const last = c.polar || c.heatmap ? "" : c.lastValues.map((lv) => {
    const yy = hair(lv.y);
    let top = Math.max(plot.y, Math.min(plot.y + plot.h - 15, lv.y - 7.5));
    while (placed.some((p) => Math.abs(p - top) < 16)) {
      top = Math.min(plot.y + plot.h - 15, top + 16);
    }
    placed.push(top);
    const dash = lv.dash === false
      ? ""
      : `<line x1="${plot.x}" x2="${plot.x + plot.w}" y1="${yy}" y2="${yy}" stroke="${esc(lv.color)}" stroke-dasharray="3.5 3" stroke-opacity="0.8" />`;
    return [
      dash,
      chipSvg(plot.x + plot.w + 3, top, axisW - 6, 15, lv.color, readableTextColor(lv.color, theme), lv.label, "end"),
    ].join("");
  }).join("");

  const bar = c.colorBar && !c.polar
    ? (() => {
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
    })()
    : "";

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

function distToSeg(x: number, y: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = dx * dx + dy * dy;
  const t = len <= 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

function inArc(n: SceneNode, x: number, y: number): boolean {
  const cx = n.x ?? 0;
  const cy = n.y ?? 0;
  const dx = x - cx;
  const dy = y - cy;
  const r = Math.hypot(dx, dy);
  const outer = n.r ?? 0;
  const inner = n.innerR ?? 0;
  if (r > outer + 1 || r < inner - 1) return false;
  const a0 = n.startAngle ?? 0;
  const sweep = arcSweep(n);
  if (sweep >= TAU - 1e-9) return true;
  const relative = ((Math.atan2(dy, dx) - a0) % TAU + TAU) % TAU;
  return relative <= sweep + 1e-6;
}

interface HitIndex {
  nodes: SceneNode[];
  length: number;
  cellSize: number;
  cells: Map<string, number[]>;
  global: number[];
}

const hitIndexes = new WeakMap<CompiledChart, HitIndex>();

function cellKey(x: number, y: number): string {
  return `${x}:${y}`;
}

function nodeBounds(n: SceneNode, pad: number): { left: number; top: number; right: number; bottom: number } | null {
  if (n.type === "text" || n.hit === false) return null;
  if (n.type === "rect") {
    const x0 = n.x ?? 0;
    const y0 = n.y ?? 0;
    const x1 = x0 + (n.w ?? 0);
    const y1 = y0 + (n.h ?? 0);
    return { left: Math.min(x0, x1) - pad, top: Math.min(y0, y1) - pad, right: Math.max(x0, x1) + pad, bottom: Math.max(y0, y1) + pad };
  }
  if (n.type === "circle" || n.type === "arc") {
    const radius = (n.r ?? (n.type === "circle" ? 3 : 0)) + pad;
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    return { left: x - radius, top: y - radius, right: x + radius, bottom: y + radius };
  }
  if (n.type === "rule") {
    const x0 = n.x ?? 0;
    const y0 = n.y ?? 0;
    const x1 = n.x2 ?? 0;
    const y1 = n.y2 ?? 0;
    return { left: Math.min(x0, x1) - pad, top: Math.min(y0, y1) - pad, right: Math.max(x0, x1) + pad, bottom: Math.max(y0, y1) + pad };
  }
  if (!n.points?.length) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const point of n.points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  return Number.isFinite(left) ? { left: left - pad, top: top - pad, right: right + pad, bottom: bottom + pad } : null;
}

function createHitIndex(c: CompiledChart): HitIndex {
  const cellSize = 48;
  const cells = new Map<string, number[]>();
  const global: number[] = [];
  const maxCellsPerNode = 256;
  for (let i = 0; i < c.nodes.length; i++) {
    const bounds = nodeBounds(c.nodes[i]!, 6);
    if (!bounds) continue;
    const left = Math.floor(bounds.left / cellSize);
    const right = Math.floor(bounds.right / cellSize);
    const top = Math.floor(bounds.top / cellSize);
    const bottom = Math.floor(bounds.bottom / cellSize);
    const count = (right - left + 1) * (bottom - top + 1);
    if (!Number.isFinite(count) || count > maxCellsPerNode) {
      global.push(i);
      continue;
    }
    for (let cy = top; cy <= bottom; cy++) {
      for (let cx = left; cx <= right; cx++) {
        const key = cellKey(cx, cy);
        const bucket = cells.get(key);
        if (bucket) bucket.push(i);
        else cells.set(key, [i]);
      }
    }
  }
  const index = { nodes: c.nodes, length: c.nodes.length, cellSize, cells, global };
  hitIndexes.set(c, index);
  return index;
}

function hitNode(n: SceneNode, x: number, y: number, pad: number): boolean {
  if (n.hit === false || n.type === "text") return false;
  if (n.type === "rect") {
    const x0 = n.x ?? 0;
    const y0 = n.y ?? 0;
    const x1 = x0 + (n.w ?? 0);
    const y1 = y0 + (n.h ?? 0);
    return x >= Math.min(x0, x1) && x <= Math.max(x0, x1) && y >= Math.min(y0, y1) && y <= Math.max(y0, y1);
  }
  if (n.type === "circle") {
    return Math.hypot(x - (n.x ?? 0), y - (n.y ?? 0)) <= (n.r ?? 3) + pad;
  }
  if (n.type === "arc") return inArc(n, x, y);
  if ((n.type === "line" || n.type === "area" || n.type === "polygon") && n.points?.length) {
    if (n.type === "polygon" && (n.fill === "none" || !n.series)) return false;
    if (n.type !== "line") {
      let inside = false;
      const pts = n.points;
      for (let j = 0, k = pts.length - 1; j < pts.length; k = j++) {
        const a = pts[j]!;
        const b = pts[k]!;
        const intersects = ((a.y > y) !== (b.y > y)) && (x < (b.x - a.x) * (y - a.y) / (b.y - a.y || 1e-9) + a.x);
        if (intersects) inside = !inside;
      }
      if (inside) return true;
    }
    for (let j = 1; j < n.points.length; j++) {
      const a = n.points[j - 1]!;
      const b = n.points[j]!;
      if (distToSeg(x, y, a.x, a.y, b.x, b.y) <= pad) return true;
    }
  } else if (n.type === "rule") {
    return distToSeg(x, y, n.x ?? 0, n.y ?? 0, n.x2 ?? 0, n.y2 ?? 0) <= pad;
  }
  return false;
}

/** Nearest painted mark under a plot-space pointer. Used by HTML tooltips. */
export function hitTestCompiled(c: CompiledChart, x: number, y: number): SceneNode | null {
  const pad = 6;
  if (c.nodes.length < 128) {
    for (let i = c.nodes.length - 1; i >= 0; i--) {
      const node = c.nodes[i]!;
      if (hitNode(node, x, y, pad)) return node;
    }
    return null;
  }
  let index = hitIndexes.get(c);
  if (!index || index.nodes !== c.nodes || index.length !== c.nodes.length) index = createHitIndex(c);
  const bucket = index.cells.get(cellKey(Math.floor(x / index.cellSize), Math.floor(y / index.cellSize))) ?? [];
  const candidates = index.global.length
    ? Array.from(new Set([...bucket, ...index.global])).sort((a, b) => b - a)
    : [...bucket].reverse();
  for (const nodeIndex of candidates) {
    const node = c.nodes[nodeIndex]!;
    if (hitNode(node, x, y, pad)) return node;
  }
  return null;
}

interface SampleIndex {
  samples: HoverSample[];
  length: number;
  kinds: Set<HoverSample["kind"]>;
  lineByX: { sample: HoverSample; index: number }[];
  cells: Map<string, { sample: HoverSample; index: number }[]>;
}

const sampleIndexes = new WeakMap<CompiledChart, SampleIndex>();

function createSampleIndex(c: CompiledChart): SampleIndex {
  const lineByX: { sample: HoverSample; index: number }[] = [];
  const cells = new Map<string, { sample: HoverSample; index: number }[]>();
  const kinds = new Set<HoverSample["kind"]>();
  for (let i = 0; i < c.samples.length; i++) {
    const sample = c.samples[i]!;
    kinds.add(sample.kind);
    if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y)) continue;
    if (sample.kind === "line") lineByX.push({ sample, index: i });
    const key = cellKey(Math.floor(sample.x / 48), Math.floor(sample.y / 48));
    const bucket = cells.get(key);
    if (bucket) bucket.push({ sample, index: i });
    else cells.set(key, [{ sample, index: i }]);
  }
  lineByX.sort((a, b) => a.sample.x - b.sample.x || a.index - b.index);
  const index = { samples: c.samples, length: c.samples.length, kinds, lineByX, cells };
  sampleIndexes.set(c, index);
  return index;
}

function lowerBoundX(values: readonly { sample: HoverSample }[], x: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid]!.sample.x < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function nearestSpatial(
  index: SampleIndex,
  x: number,
  y: number,
  radius: number,
  accepts: (sample: HoverSample) => boolean = () => true,
): HoverSample | null {
  const cx = Math.floor(x / 48);
  const cy = Math.floor(y / 48);
  const candidates: { sample: HoverSample; index: number }[] = [];
  const reach = Math.max(1, Math.ceil(radius / 48));
  for (let iy = cy - reach; iy <= cy + reach; iy++) {
    for (let ix = cx - reach; ix <= cx + reach; ix++) {
      const bucket = index.cells.get(cellKey(ix, iy));
      if (bucket) for (const index of bucket) candidates.push(index);
    }
  }
  candidates.sort((a, b) => a.index - b.index);
  let best: HoverSample | null = null;
  let bestDistance = radius;
  for (const { sample } of candidates) {
    if (!accepts(sample)) continue;
    const distance = Math.hypot(sample.x - x, sample.y - y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = sample;
    }
  }
  return best;
}

function nearestLine(index: SampleIndex, x: number, y: number): HoverSample | null {
  const values = index.lineByX;
  if (!values.length) return null;
  const at = lowerBoundX(values, x);
  const leftDx = at > 0 ? Math.abs(values[at - 1]!.sample.x - x) : Infinity;
  const rightDx = at < values.length ? Math.abs(values[at]!.sample.x - x) : Infinity;
  const minDx = Math.min(leftDx, rightDx);
  const from = lowerBoundX(values, x - minDx - 0.5);
  let to = lowerBoundX(values, x + minDx + 0.5);
  while (to < values.length && values[to]!.sample.x <= x + minDx + 0.5) to++;
  const candidates = values.slice(from, to).sort((a, b) => a.index - b.index);
  let best: HoverSample | null = null;
  let bestDx = Infinity;
  let bestDy = Infinity;
  for (const { sample } of candidates) {
    const dx = Math.abs(sample.x - x);
    const dy = Math.abs(sample.y - y);
    if (dx < bestDx - 0.5 || (Math.abs(dx - bestDx) <= 0.5 && dy < bestDy)) {
      bestDx = dx;
      bestDy = dy;
      best = sample;
    }
  }
  return best;
}

export function nearestSample(c: CompiledChart, x: number, y: number): HoverSample | null {
  if (!c.samples.length) return null;
  let index = sampleIndexes.get(c);
  if (!index || index.samples !== c.samples || index.length !== c.samples.length) index = createSampleIndex(c);
  if (index.kinds.has("point")) {
    const point = nearestSpatial(index, x, y, index.kinds.has("line") ? 12 : 48, (sample) => sample.kind === "point");
    if (point) return point;
  }
  if (index.kinds.has("radar")) return nearestSpatial(index, x, y, 22);
  return nearestLine(index, x, y);
}

export function tooltipText(n: SceneNode): string {
  if (n.tip) return n.tip;
  const row = n.datum;
  if (n.type === "arc") {
    return n.label || n.series || "";
  }
  if (row && typeof row === "object") {
    const entries = Object.entries(row as Record<string, unknown>);
    const nums = entries.filter(([, v]) => typeof v === "number" && Number.isFinite(v));
    const cats = entries.filter(([, v]) => typeof v !== "number");
    const fmt = (v: unknown): string => {
      if (typeof v === "number") {
        if (Number.isInteger(v)) return String(v);
        const body = Math.abs(v).toFixed(Math.abs(v) < 1 ? 2 : 1);
        if (v > 0) return `+${body}`;
        if (v < 0) return `-${body}`;
        return body;
      }
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      return String(v);
    };
    if (cats.length >= 2 && nums.length === 1) {
      return `${cats.map(([, c]) => fmt(c)).join("  ·  ")}\n${fmt(nums[0]![1])}`;
    }
    const title = n.series || n.label;
    const body = entries.slice(0, 5).map(([k, v]) => `${k}   ${fmt(v)}`).join("\n");
    return title ? `${title}\n${body}` : body;
  }
  return n.series || n.label || "";
}

function tipStyle(theme: DashboardTheme): string {
  return [
    "position:absolute",
    "display:none",
    "pointer-events:none",
    "z-index:5",
    `background:${theme.chipBg}`,
    `color:${readableTextColor(theme.chipBg, theme)}`,
    `font:10px/1.5 ${theme.font}`,
    "font-variant-numeric:tabular-nums",
    "padding:7px 10px 7px 11px",
    "border-radius:3px",
    "white-space:pre",
    `box-shadow:0 0 0 1px ${theme.axis}`,
    "letter-spacing:0.02em",
  ].join(";");
}

function hairStyle(theme: DashboardTheme, vertical: boolean): string {
  return [
    "position:absolute",
    "display:none",
    "pointer-events:none",
    "z-index:3",
    vertical ? "width:0" : "height:0",
    vertical
      ? `border-left:1px dashed ${theme.crosshair}`
      : `border-top:1px dashed ${theme.crosshair}`,
  ].join(";");
}

function axisChipStyle(theme: DashboardTheme): string {
  return [
    "position:absolute",
    "display:none",
    "pointer-events:none",
    "z-index:4",
    `background:${theme.chipBg}`,
    `color:${readableTextColor(theme.chipBg, theme)}`,
    `font:10px ${theme.font}`,
    "font-variant-numeric:tabular-nums",
    "padding:1px 6px",
    "border-radius:2.5px",
    "line-height:15px",
    "white-space:nowrap",
    `box-shadow:0 0 0 6px ${theme.background}`,
  ].join(";");
}

function traceRoundTopRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, Math.max(0, h));
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + radius);
  if (radius >= 0.5) ctx.quadraticCurveTo(x, y, x + radius, y);
  else ctx.lineTo(x, y);
  ctx.lineTo(x + w - radius, y);
  if (radius >= 0.5) ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  else ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}

function traceRoundBottomRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, Math.max(0, h));
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h - radius);
  if (radius >= 0.5) ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  else ctx.lineTo(x + w, y + h);
  ctx.lineTo(x + radius, y + h);
  if (radius >= 0.5) ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  else ctx.lineTo(x, y + h);
  ctx.closePath();
}

function traceRoundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function traceArcNode(ctx: CanvasRenderingContext2D, n: SceneNode): boolean {
  const cx = n.x ?? 0;
  const cy = n.y ?? 0;
  const outer = n.r ?? 0;
  const inner = Math.max(0, n.innerR ?? 0);
  const start = n.startAngle ?? 0;
  const sweep = arcSweep(n);
  if (outer <= 0 || sweep <= 1e-9) return false;
  const end = start + sweep;
  ctx.beginPath();
  if (inner <= 0) {
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(start) * outer, cy + Math.sin(start) * outer);
    ctx.arc(cx, cy, outer, start, end, false);
  } else {
    ctx.moveTo(cx + Math.cos(start) * outer, cy + Math.sin(start) * outer);
    ctx.arc(cx, cy, outer, start, end, false);
    ctx.lineTo(cx + Math.cos(end) * inner, cy + Math.sin(end) * inner);
    ctx.arc(cx, cy, inner, end, start, true);
  }
  ctx.closePath();
  return true;
}

function paintNodeCanvas(ctx: CanvasRenderingContext2D, n: SceneNode, theme: DashboardTheme): void {
  const fill = n.fill ?? "none";
  const stroke = n.stroke ?? "none";
  if (n.type === "line" && n.points?.length) {
    if (stroke === "none") return;
    ctx.beginPath();
    traceSeries(ctx, n.points, n.curve);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = n.strokeWidth ?? 1;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.setLineDash(n.dashed ? [4.5, 3.5] : []);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  if (n.type === "area" && n.points && n.points.length >= 3) {
    ctx.beginPath();
    if (n.role === "ranged-area") {
      traceSeries(ctx, n.points, "linear");
      ctx.closePath();
    } else {
      const middle = n.points.slice(1, -1);
      if (!middle.length) return;
      const baseline = n.points[0]!.y;
      traceSeries(ctx, middle, n.curve);
      const last = middle[middle.length - 1]!;
      const first = middle[0]!;
      ctx.lineTo(last.x, baseline);
      ctx.lineTo(first.x, baseline);
      ctx.closePath();
    }
    if (fill !== "none") {
      let top = n.points[0]!.y;
      let bottom = n.points[0]!.y;
      for (const point of n.points) {
        top = Math.min(top, point.y);
        bottom = Math.max(bottom, point.y);
      }
      const gradient = ctx.createLinearGradient(0, top, 0, Math.max(top + 1, bottom));
      const opacity = normalizedOpacity(n.fillOpacity, 0.42);
      for (const [offset, factor] of AREA_GRADIENT_STOPS) {
        gradient.addColorStop(offset, chartColorWithOpacity(fill, opacity * factor));
      }
      ctx.fillStyle = gradient;
      ctx.fill();
    }
    if (stroke !== "none") {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = n.strokeWidth ?? 1;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
    }
    return;
  }
  if (n.type === "polygon" && n.points?.length) {
    ctx.beginPath();
    n.points.forEach((point, i) => i === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
    ctx.closePath();
    if (fill !== "none") {
      const alpha = ctx.globalAlpha;
      ctx.globalAlpha = n.fillOpacity ?? 1;
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.globalAlpha = alpha;
    }
    if (stroke !== "none") {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = n.strokeWidth ?? 1;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
    }
    return;
  }
  if (n.type === "rect") {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const w = Math.max(0, n.w ?? 0);
    const h = Math.max(0, n.h ?? 0);
    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = n.fillOpacity ?? 1;
    ctx.beginPath();
    if (n.corner === "top") traceRoundTopRect(ctx, x, y, w, h, Math.min(2.5, w / 2, h));
    else if (n.corner === "bottom") traceRoundBottomRect(ctx, x, y, w, h, Math.min(2.5, w / 2, h));
    else if (n.corner === "none" || n.role === "heat") ctx.rect(x, y, w, h);
    else traceRoundRect(ctx, x, y, w, h, Math.min(2.5, w / 2, h / 2));
    if (fill !== "none") {
      if (n.corner === "top" || n.corner === "bottom") {
        const gradient = ctx.createLinearGradient(0, y, 0, y + Math.max(1, h));
        gradient.addColorStop(0, n.corner === "bottom" ? shade(fill, 0.14) : lift(fill, 0.22));
        gradient.addColorStop(0.38, fill);
        gradient.addColorStop(1, n.corner === "bottom" ? lift(fill, 0.22) : shade(fill, 0.14));
        ctx.fillStyle = gradient;
      } else {
        ctx.fillStyle = fill;
      }
      ctx.fill();
    }
    ctx.globalAlpha = alpha;
    if (stroke !== "none") {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = n.strokeWidth ?? 1;
      ctx.stroke();
    }
    if ((n.corner === "top" || n.corner === "bottom") && h >= 6 && w >= 4) {
      const radius = Math.min(2.5, w / 2, h);
      const sheenY = n.corner === "bottom" ? y + h : y;
      ctx.beginPath();
      ctx.moveTo(x + radius + 0.5, hair(sheenY));
      ctx.lineTo(x + w - radius - 0.5, hair(sheenY));
      ctx.strokeStyle = "rgba(244,238,225,0.28)";
      ctx.lineWidth = 1;
      ctx.lineCap = "round";
      ctx.stroke();
    }
    return;
  }
  if (n.type === "circle") {
    ctx.beginPath();
    ctx.arc(n.x ?? 0, n.y ?? 0, n.r ?? 3, 0, TAU);
    if (fill !== "none") {
      const alpha = ctx.globalAlpha;
      ctx.globalAlpha = n.fillOpacity ?? 1;
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.globalAlpha = alpha;
    }
    if (stroke !== "none") {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = n.strokeWidth ?? 1;
      ctx.stroke();
    }
    return;
  }
  if (n.type === "rule") {
    if (stroke === "none") return;
    ctx.beginPath();
    ctx.moveTo(hair(n.x ?? 0), hair(n.y ?? 0));
    ctx.lineTo(hair(n.x2 ?? 0), hair(n.y2 ?? 0));
    ctx.strokeStyle = stroke;
    ctx.setLineDash(n.dashed === false ? [] : [3.5, 3]);
    ctx.lineWidth = n.strokeWidth ?? 1;
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  if (n.type === "arc") {
    if (!traceArcNode(ctx, n)) return;
    if (fill !== "none") {
      const alpha = ctx.globalAlpha;
      ctx.globalAlpha = n.fillOpacity ?? 1;
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.globalAlpha = alpha;
    }
    if (stroke !== "none") {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = n.strokeWidth ?? 1;
      ctx.stroke();
    }
    return;
  }
  if (n.type === "text" && n.label) {
    const size = n.fontSize ?? 11;
    ctx.fillStyle = n.fill || theme.muted;
    ctx.font = `${size >= 18 ? "600 " : ""}${size}px ${theme.font}`;
    ctx.textAlign = n.anchor === "middle" ? "center" : (n.anchor ?? "start");
    ctx.textBaseline = "middle";
    ctx.fillText(n.label, n.x ?? 0, n.y ?? 0);
  }
}

function paintLegendCanvas(ctx: CanvasRenderingContext2D, c: CompiledChart): void {
  const { legend, legendPlacement, plot, theme } = c;
  if (!legend.length || legendPlacement === "hidden") return;
  if (legendPlacement === "right") {
    const x = plot.x + plot.w + 18;
    const rowHeight = 40;
    const y0 = plot.y + Math.max(0, (plot.h - legend.length * rowHeight) / 2);
    legend.forEach((item, i) => {
      const y = y0 + i * rowHeight;
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
    x += 16 + item.name.length * 6.2 + (item.detail ? item.detail.length * 5.6 : 0) + 10;
  }
}

function paintAxesCanvas(ctx: CanvasRenderingContext2D, c: CompiledChart): void {
  if (c.polar) return;
  const { plot, theme, width, height } = c;
  const axisWidth = Math.max(44, width - plot.x - plot.w);
  if (!c.heatmap) {
    ctx.fillStyle = theme.background;
    ctx.fillRect(plot.x + plot.w, 0, axisWidth, height);
  }
  ctx.beginPath();
  ctx.moveTo(hair(c.heatmap ? plot.x : plot.x + plot.w), plot.y);
  ctx.lineTo(hair(c.heatmap ? plot.x : plot.x + plot.w), plot.y + plot.h);
  ctx.strokeStyle = theme.axis;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.stroke();
  ctx.font = `9px ${theme.font}`;
  ctx.fillStyle = theme.muted;
  ctx.textBaseline = "middle";
  ctx.textAlign = "end";
  for (const tick of c.yTicks) ctx.fillText(tick.label, c.heatmap ? plot.x - 8 : width - 7, tick.px);

  ctx.fillStyle = theme.background;
  ctx.fillRect(0, plot.y + plot.h, width, Math.max(0, height - plot.y - plot.h));
  ctx.beginPath();
  ctx.moveTo(c.heatmap ? plot.x : 0, hair(plot.y + plot.h));
  ctx.lineTo(c.heatmap ? plot.x + plot.w : width, hair(plot.y + plot.h));
  ctx.strokeStyle = theme.axis;
  ctx.stroke();
  ctx.font = `9px ${theme.font}`;
  ctx.fillStyle = theme.muted;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  for (const tick of c.xTicks) ctx.fillText(tick.label, tick.px, plot.y + plot.h + 14);
}

function paintChipCanvas(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  background: string,
  foreground: string,
  label: string,
  font: string,
): void {
  ctx.beginPath();
  traceRoundRect(ctx, x, y, w, h, 2.5);
  ctx.fillStyle = background;
  ctx.fill();
  ctx.fillStyle = foreground;
  ctx.font = `600 10px ${font}`;
  ctx.textAlign = "end";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + w - 6, y + h / 2 + 0.5);
}

function paintLastValuesCanvas(ctx: CanvasRenderingContext2D, c: CompiledChart): void {
  if (c.polar || c.heatmap) return;
  const { plot, theme, width } = c;
  const axisWidth = Math.max(44, width - plot.x - plot.w);
  const placed: number[] = [];
  for (const value of c.lastValues) {
    let top = Math.max(plot.y, Math.min(plot.y + plot.h - 15, value.y - 7.5));
    while (placed.some((position) => Math.abs(position - top) < 16)) {
      top = Math.min(plot.y + plot.h - 15, top + 16);
    }
    placed.push(top);
    if (value.dash !== false) {
      ctx.beginPath();
      ctx.moveTo(plot.x, hair(value.y));
      ctx.lineTo(plot.x + plot.w, hair(value.y));
      ctx.strokeStyle = chartColorWithOpacity(value.color, 0.8);
      ctx.lineWidth = 1;
      ctx.setLineDash([3.5, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    paintChipCanvas(ctx, plot.x + plot.w + 3, top, axisWidth - 6, 15, value.color, readableTextColor(value.color, theme), value.label, theme.font);
  }
}

function paintColorBarCanvas(ctx: CanvasRenderingContext2D, c: CompiledChart): void {
  if (!c.colorBar || c.polar) return;
  const { plot, theme } = c;
  const x = plot.x + plot.w + 10;
  const y = plot.y;
  const w = 7;
  const h = plot.h;
  const { min, max } = c.colorBar;
  const gradient = ctx.createLinearGradient(0, y + h, 0, y);
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    gradient.addColorStop(t, heatFill(min + (max - min) * t, min, max, theme));
  }
  ctx.beginPath();
  traceRoundRect(ctx, x, y, w, h, 1);
  ctx.fillStyle = gradient;
  ctx.fill();
  const format = (value: number): string => value.toFixed(Math.abs(value) < 10 ? 1 : 0);
  ctx.font = `9px ${theme.font}`;
  ctx.fillStyle = theme.muted;
  ctx.textAlign = "start";
  ctx.textBaseline = "top";
  ctx.fillText(format(max), x + w + 5, y + 1);
  if (min < 0 && max > 0) {
    ctx.textBaseline = "middle";
    ctx.fillText("0", x + w + 5, y + h * (max / (max - min)));
  }
  ctx.textBaseline = "alphabetic";
  ctx.fillText(format(min), x + w + 5, y + h - 1);
}

/** Paint the same compiled scene and chrome as the SVG renderer. */
export function paintChartCanvas(ctx: CanvasRenderingContext2D, c: CompiledChart): void {
  const { theme, plot } = c;
  ctx.save();
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.globalAlpha = 1;
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, c.width, c.height);
  paintLegendCanvas(ctx, c);
  if (c.grid && !c.polar) {
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    for (const tick of c.yTicks) {
      ctx.beginPath();
      ctx.moveTo(plot.x, hair(tick.px));
      ctx.lineTo(plot.x + plot.w, hair(tick.px));
      ctx.stroke();
    }
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();
  for (const node of c.nodes) if (node.clip !== false) paintNodeCanvas(ctx, node, theme);
  ctx.restore();
  for (const node of c.nodes) if (node.clip === false) paintNodeCanvas(ctx, node, theme);
  paintAxesCanvas(ctx, c);
  paintLastValuesCanvas(ctx, c);
  paintColorBarCanvas(ctx, c);
  ctx.restore();
}

export interface ChartPointerEvent {
  x: unknown;
  y?: number;
  series?: string;
  datum?: unknown;
  node: SceneNode | null;
  sample: HoverSample | null;
}

export interface MountInteraction {
  brush?: boolean;
  zoom?: boolean;
  pan?: boolean;
  navigator?: boolean;
  rangePresets?: boolean;
}

export interface MountChartOptions {
  width?: number;
  height?: number;
  renderer?: "svg" | "canvas";
  /** Stable DOM/SVG id prefix; useful for hydration and deterministic tests. */
  idPrefix?: string;
  viewport?: ChartViewport;
  interaction?: boolean | MountInteraction;
  hiddenSeries?: readonly string[];
  onViewportChange?: (viewport: ChartViewport) => void;
  onSelect?: (event: ChartPointerEvent) => void;
  onTooltip?: (event: ChartPointerEvent | null) => void;
}

export interface MountHandle {
  /** Update in place. The mounted host and interaction state are preserved. */
  update(definition: ChartDefinition, options?: MountChartOptions): void;
  /** Latest renderer-neutral scene, useful for diagnostics and deterministic tests. */
  getScene(): CompiledChart | null;
  setViewport(viewport: ChartViewport | null): void;
  getViewport(): ChartViewport | null;
  destroy(): void;
}

function nearestLabel(ticks: { px: number; label: string }[], px: number): string {
  if (!ticks.length) return "";
  let best = ticks[0]!;
  for (const t of ticks) {
    if (Math.abs(t.px - px) < Math.abs(best.px - px)) best = t;
  }
  return best.label;
}

export function mountChart(
  el: HTMLElement,
  definition: ChartDefinition,
  opts?: MountChartOptions,
): MountHandle {
  let currentOptions: MountChartOptions = { ...opts };
  const autoId = `mounted-${++svgSeq}`;
  let current = definition;
  let compiledRef: CompiledChart | null = null;
  let lastInputWidth = Number.NaN;
  let lastInputHeight = Number.NaN;
  let destroyed = false;
  let liveViewport: ChartViewport | null = opts?.viewport ?? null;
  let hiddenSeries = new Set(opts?.hiddenSeries ?? []);
  let fullXExtent: [number, number] | null = null;
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "position:relative;width:100%;height:100%;overflow:hidden;display:flex;flex-direction:column;user-select:none;-webkit-user-select:none;touch-action:none;";
  const stage = document.createElement("div");
  stage.style.cssText = "width:100%;flex:1 1 auto;min-height:0;position:relative;overflow:hidden;";
  const hairV = document.createElement("div");
  const hairH = document.createElement("div");
  const chipY = document.createElement("div");
  const chipX = document.createElement("div");
  const tip = document.createElement("div");
  const dot = document.createElement("div");
  const cell = document.createElement("div");
  const a11y = document.createElement("div");
  a11y.className = "raze-chart-sr-summary";
  a11y.style.cssText = [
    "position:absolute",
    "width:1px",
    "height:1px",
    "padding:0",
    "margin:-1px",
    "overflow:hidden",
    "clip:rect(0,0,0,0)",
    "white-space:nowrap",
    "border:0",
    "user-select:none",
  ].join(";");
  wrap.append(stage, hairV, hairH, chipY, chipX, cell, dot, tip, a11y);
  const presetsBar = document.createElement("div");
  presetsBar.style.cssText = "display:none;gap:4px;padding:4px 8px 0;flex-wrap:wrap;align-items:center;flex:0 0 auto;position:relative;z-index:6;touch-action:manipulation;";
  const nav = document.createElement("div");
  nav.style.cssText = "display:none;position:relative;height:40px;margin:0 8px 6px;cursor:crosshair;flex:0 0 auto;z-index:6;";
  const brushRect = document.createElement("div");
  brushRect.style.cssText = "display:none;position:absolute;pointer-events:none;z-index:5;background:rgba(102,216,158,0.12);border:1px solid rgba(102,216,158,0.7);";
  wrap.append(presetsBar, nav, brushRect);
  el.appendChild(wrap);

  const applyTheme = (theme: DashboardTheme): void => {
    wrap.style.background = theme.background;
    wrap.style.color = theme.text;
    wrap.style.fontFamily = theme.font;
    hairV.style.cssText = hairStyle(theme, true);
    hairH.style.cssText = hairStyle(theme, false);
    chipY.style.cssText = axisChipStyle(theme);
    chipX.style.cssText = axisChipStyle(theme);
    tip.style.cssText = tipStyle(theme);
    dot.style.cssText = [
      "position:absolute",
      "display:none",
      "pointer-events:none",
      "z-index:4",
      "width:8px",
      "height:8px",
      "margin:-4px 0 0 -4px",
      "border-radius:50%",
      `box-shadow:0 0 0 1.5px ${theme.background}`,
    ].join(";");
    cell.style.cssText = [
      "position:absolute",
      "display:none",
      "pointer-events:none",
      "z-index:3",
      "box-sizing:border-box",
      `box-shadow:inset 0 0 0 1.5px ${theme.text}, 0 0 0 1px ${theme.background}`,
    ].join(";");
    wrap.style.touchAction = "none";
  };
  const hideOverlay = (): void => {
    hairV.style.display = "none";
    hairH.style.display = "none";
    chipY.style.display = "none";
    chipX.style.display = "none";
    tip.style.display = "none";
    dot.style.display = "none";
    cell.style.display = "none";
    stage.querySelectorAll("[data-role='slice']").forEach((el) => {
      (el as SVGElement).style.opacity = "1";
    });
  };

  const inputSize = (): { width: number; height: number } => ({
    width: currentOptions.width ?? Math.max(1, wrap.clientWidth || el.clientWidth || 640),
    height: currentOptions.height ?? Math.max(1, wrap.clientHeight || el.clientHeight || 320),
  });

  const flags = (): MountInteraction => {
    const raw = currentOptions.interaction;
    if (raw === false) return {};
    const base: MountInteraction = raw === true || raw == null
      ? { brush: true, zoom: true, pan: true }
      : { brush: true, zoom: true, pan: true, ...raw };
    return base;
  };

  const isChromeEvent = (ev: Event): boolean => {
    const node = ev.target as Node | null;
    if (!node || node.nodeType !== 1) return false;
    return presetsBar.contains(node) || nav.contains(node);
  };

  const linearExtent = (scene: CompiledChart | null): [number, number] | null => {
    if (scene?.xScale.kind !== "linear") return null;
    return [asNumber(scene.xScale.domain[0]), asNumber(scene.xScale.domain[1])];
  };

  const resolvedExtent = (): [number, number] | null => (
    fullXExtent ?? linearExtent(compiledRef)
  );

  const syncPresetButtons = (): void => {
    const extent = resolvedExtent();
    const vp = liveViewport?.x;
    for (const btn of presetsBar.querySelectorAll("button")) {
      const preset = btn.textContent as RangePreset;
      if (!RANGE_PRESETS.includes(preset)) continue;
      btn.hidden = extent != null && preset !== "ALL" && !presetZoomsIn(preset, extent);
      let on = preset === "ALL" && !vp;
      if (vp && vp.length === 2 && extent && Number.isFinite(asNumber(vp[0]))) {
        const want = viewportFromPreset(preset, extent);
        if (want.x && want.x.length === 2) {
          const span = Math.max(Math.abs(extent[1] - extent[0]), 1);
          on = Math.abs(asNumber(vp[0]) - asNumber(want.x[0])) / span < 0.02
            && Math.abs(asNumber(vp[1]) - asNumber(want.x[1])) / span < 0.02;
        }
      }
      btn.setAttribute("aria-pressed", String(on));
      btn.style.fontWeight = on ? "600" : "400";
      btn.style.background = on
        ? "var(--tv-color-toolbar-button-background-active, rgba(255,255,255,0.1))"
        : "transparent";
    }
  };

  const ensurePresetButtons = (): void => {
    if (presetsBar.childElementCount) return;
    presetsBar.setAttribute("role", "group");
    presetsBar.setAttribute("aria-label", "Visible time range");
    for (const preset of RANGE_PRESETS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = preset;
      btn.setAttribute("aria-label", `Range ${preset}`);
      btn.style.cssText = "border:0;background:transparent;color:inherit;font:inherit;font-size:11px;padding:2px 6px;border-radius:3px;cursor:pointer;touch-action:manipulation;";
      btn.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      btn.addEventListener("pointerup", (ev) => ev.stopPropagation());
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const extent = resolvedExtent();
        if (!extent) return;
        emitViewport(viewportFromPreset(preset, extent));
      });
      presetsBar.appendChild(btn);
    }
  };

  const prepareChrome = (polar: boolean, heatmap: boolean): void => {
    const interact = flags();
    const cartesian = !polar && !heatmap;
    if (interact.rangePresets && cartesian) ensurePresetButtons();
    presetsBar.style.display = interact.rangePresets && cartesian ? "flex" : "none";
    nav.style.display = interact.navigator && cartesian ? "block" : "none";
  };

  const emitViewport = (next: ChartViewport): void => {
    liveViewport = next;
    currentOptions.onViewportChange?.(next);
    paint();
  };

  const stopChromePointer = (ev: Event): void => {
    ev.stopPropagation();
  };

  const onNavPointerDown = (ev: PointerEvent): void => {
    ev.stopPropagation();
    const extent = resolvedExtent();
    if (!extent) return;
    const box = nav.getBoundingClientRect();
    const t = (ev.clientX - box.left) / Math.max(1, box.width);
    const mid = extent[0] + t * (extent[1] - extent[0]);
    const span = (liveViewport?.x && liveViewport.x.length === 2)
      ? Math.abs(asNumber(liveViewport.x[1]) - asNumber(liveViewport.x[0]))
      : (extent[1] - extent[0]) * 0.25;
    emitViewport({ x: [mid - span / 2, mid + span / 2] });
  };

  const paint = (): void => {
    if (destroyed) throw new Error("[@razedotbot/charts] Cannot paint a destroyed chart mount.");
    const renderer = currentOptions.renderer ?? "svg";
    const idPrefix = safeId(currentOptions.idPrefix ?? autoId);
    const interact = flags();
    prepareChrome(compiledRef?.polar ?? false, compiledRef?.heatmap ?? false);
    const wrapSize = inputSize();
    let w = wrapSize.width;
    let h = wrapSize.height;
    if (currentOptions.width == null) w = Math.max(1, stage.clientWidth || w);
    if (currentOptions.height == null) h = Math.max(1, stage.clientHeight || h);
    const hidden = hiddenSeries.size ? Array.from(hiddenSeries) : currentOptions.hiddenSeries;
    const viewport = liveViewport ?? currentOptions.viewport;
    const overlayed = Boolean(viewport) || Boolean(hidden?.length);
    let compiled = overlayed
      ? compileChart(defineChart((size) => ({
          ...current.spec(size),
          ...(viewport ? { viewport } : {}),
          ...(hidden?.length ? { hiddenSeries: hidden } : {}),
        })), { width: w, height: h })
      : compileChart(current, { width: w, height: h });
    if (compiled.polar || compiled.heatmap) {
      prepareChrome(true, true);
    }
    const showNav = Boolean(interact.navigator && !compiled.polar && !compiled.heatmap);
    let fullScene: CompiledChart | null = overlayed ? null : compiled;
    if (overlayed && (!fullXExtent || showNav)) {
      fullScene = compileChart(current, {
        width: Math.max(32, showNav ? nav.clientWidth || w : 64),
        height: Math.max(24, showNav ? nav.clientHeight || 40 : 32),
      });
    }
    const source = fullScene ?? compiled;
    if (source.xScale.kind === "linear" && (!fullXExtent || !overlayed)) {
      fullXExtent = linearExtent(source);
    }
    syncPresetButtons();
    if (showNav && compiled.xScale.kind === "linear") {
      let spark = nav.querySelector("canvas");
      if (!spark) {
        spark = document.createElement("canvas");
        spark.style.cssText = "width:100%;height:100%;display:block;";
        spark.setAttribute("aria-hidden", "true");
        nav.appendChild(spark);
      }
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const nw = Math.max(1, nav.clientWidth);
      const nh = Math.max(1, nav.clientHeight);
      const sparkW = Math.floor(nw * dpr);
      const sparkH = Math.floor(nh * dpr);
      if (spark.width !== sparkW || spark.height !== sparkH) {
        spark.width = sparkW;
        spark.height = sparkH;
      }
      const sctx = spark.getContext("2d");
      if (sctx) {
        sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        sctx.clearRect(0, 0, nw, nh);
        const sparkSource = fullScene ?? compiled;
        const line = sparkSource.nodes.find((n) =>
          (n.type === "line" || n.type === "area") && n.points && n.points.length > 1,
        );
        if (line?.points) {
          sctx.beginPath();
          line.points.forEach((p, i) => {
            const x = ((p.x - sparkSource.plot.x) / Math.max(1, sparkSource.plot.w)) * nw;
            const y = 4 + ((p.y - sparkSource.plot.y) / Math.max(1, sparkSource.plot.h)) * (nh - 8);
            if (i === 0) sctx.moveTo(x, y);
            else sctx.lineTo(x, y);
          });
          sctx.strokeStyle = compiled.theme.accent;
          sctx.lineWidth = 1;
          sctx.stroke();
        }
      }
    }
    if (renderer === "canvas") {
      let canvas = stage.querySelector("canvas");
      if (!canvas) {
        canvas = document.createElement("canvas");
        canvas.style.cssText = "width:100%;height:100%;display:block;user-select:none;-webkit-user-select:none";
        stage.replaceChildren(canvas);
      }
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const backingW = Math.floor(compiled.width * dpr);
      const backingH = Math.floor(compiled.height * dpr);
      if (canvas.width !== backingW || canvas.height !== backingH) {
        canvas.width = backingW;
        canvas.height = backingH;
      }
      const summaryParts = [
        compiled.ariaDescription,
        compiled.legend.length
          ? `Series: ${compiled.legend.map((item) => item.name).join(", ")}.`
          : "",
        ...Array.from(new Set(compiled.nodes.map((node) => node.tip).filter((tip): tip is string => !!tip))).slice(0, 50),
      ].filter(Boolean);
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", compiled.ariaLabel);
      if (summaryParts.length) canvas.setAttribute("aria-describedby", `raze-summary-${idPrefix}`);
      else canvas.removeAttribute("aria-describedby");
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        paintChartCanvas(ctx, compiled);
      }
      applyTheme(compiled.theme);
      a11y.id = `raze-summary-${idPrefix}`;
      a11y.textContent = summaryParts.join(" ");
      a11y.hidden = false;
    } else {
      const markup = svgFromCompiled(compiled, { idPrefix });
      applyTheme(compiled.theme);
      a11y.hidden = true;
      a11y.textContent = "";
      stage.innerHTML = markup;
    }
    compiledRef = compiled;
    lastInputWidth = wrapSize.width;
    lastInputHeight = wrapSize.height;
    hideOverlay();
  };

  const onMove = (ev: PointerEvent): void => {
    if (isChromeEvent(ev)) {
      hideOverlay();
      return;
    }
    const compiled = compiledRef;
    if (!compiled?.tooltip) {
      hideOverlay();
      return;
    }
    const box = wrap.getBoundingClientRect();
    const cssX = ev.clientX - box.left;
    const cssY = ev.clientY - box.top;
    const scaleX = (box.width || compiled.width) / compiled.width;
    const scaleY = (box.height || compiled.height) / compiled.height;
    const x = cssX / scaleX;
    const y = cssY / scaleY;
    const { plot, theme } = compiled;
    const inPlot = compiled.polar
      ? x >= 0 && y >= 0 && x <= compiled.width && y <= compiled.height
      : x >= plot.x && x <= plot.x + plot.w && y >= plot.y && y <= plot.y + plot.h;
    if (!inPlot && !compiled.polar) {
      hideOverlay();
      return;
    }
    if (compiled.polar && !inPlot) {
      hideOverlay();
      return;
    }

    let sample = nearestSample(compiled, x, y);
    const hit = hitTestCompiled(compiled, x, y);
    if (hit?.role === "point" && hit.type === "circle") {
      let index = sampleIndexes.get(compiled);
      if (!index || index.samples !== compiled.samples || index.length !== compiled.samples.length) {
        index = createSampleIndex(compiled);
      }
      sample = nearestSpatial(
        index,
        x,
        y,
        Math.max(8, (hit.r ?? 4) + 4),
        (candidate) => candidate.kind === "point" && candidate.series === hit.series,
      ) ?? sample;
    } else if (hit?.role === "bar" || hit?.role === "heat" || hit?.role === "slice") {
      sample = null;
    }
    const accentNode = hit && hit.type !== "rule" ? hit : null;
    const isBar = hit?.role === "bar";
    const isHeat = hit?.role === "heat";
    const isPoint = sample?.kind === "point";
    const isLine = sample?.kind === "line";

    if (!compiled.polar) {
      const scanX = isHeat && hit?.x != null && hit.w
        ? hit.x + hit.w / 2
        : isPoint && sample
          ? sample.x
          : isLine && sample
            ? sample.x
            : isBar && hit?.x != null && hit.w
              ? hit.x + hit.w / 2
              : x;
      const scanY = isHeat && hit?.y != null && hit.h
        ? hit.y + hit.h / 2
        : isPoint && sample
          ? sample.y
          : isBar && hit?.y != null
            ? hit.valueY ?? hit.y
            : isLine && sample
              ? sample.y
              : y;

      hairV.style.display = "block";
      hairV.style.left = `${Math.round(scanX * scaleX)}px`;
      hairV.style.top = `${plot.y * scaleY}px`;
      hairV.style.height = `${plot.h * scaleY}px`;

      if (isHeat || isPoint || isBar) {
        hairH.style.display = "block";
        hairH.style.top = `${Math.round(scanY * scaleY)}px`;
        hairH.style.left = `${plot.x * scaleX}px`;
        hairH.style.width = `${plot.w * scaleX}px`;
      } else {
        hairH.style.display = "none";
      }

      if (compiled.yScale.kind === "band") {
        chipY.textContent = nearestLabel(compiled.yTicks, scanY);
      } else if (isBar && hit?.tip) {
        const bits = hit.tip.split("\n")[1]?.trim().split(/\s{2,}/) ?? [];
        chipY.textContent = bits[1] ?? bits[0] ?? "";
      } else if ((isLine || isPoint) && sample) {
        const yVal = (compiled.yScale as LinearScale).invert(sample.y);
        chipY.textContent = Number.isInteger(yVal) ? String(yVal) : yVal.toFixed(Math.abs(yVal) < 1 ? 2 : 1);
      } else {
        const yVal = (compiled.yScale as LinearScale).invert(y);
        chipY.textContent = Number.isInteger(yVal) ? String(yVal) : yVal.toFixed(Math.abs(yVal) < 1 ? 2 : 1);
      }
      chipY.style.display = "block";
      chipY.style.left = compiled.heatmap
        ? `${Math.max(2, (plot.x - 42) * scaleX)}px`
        : `${(plot.x + plot.w) * scaleX + 3}px`;
      const cssPlotTop = plot.y * scaleY;
      const cssPlotBottom = (plot.y + plot.h) * scaleY;
      const cssScanY = scanY * scaleY;
      chipY.style.top = `${Math.max(cssPlotTop, Math.min(cssPlotBottom - 16, cssScanY - 8))}px`;

      if (isLine && sample) {
        const first = sample.tip.split("\n")[1];
        chipX.textContent = first ? (first.trim().split(/\s{2,}/)[0] ?? nearestLabel(compiled.xTicks, sample.x)) : nearestLabel(compiled.xTicks, sample.x);
      } else if (isPoint && sample) {
        const first = sample.tip.split("\n")[1];
        chipX.textContent = first ? (first.trim().split("·")[0]!.trim() || nearestLabel(compiled.xTicks, sample.x)) : nearestLabel(compiled.xTicks, scanX);
      } else {
        chipX.textContent = nearestLabel(compiled.xTicks, scanX);
      }
      chipX.style.display = "block";
      const cw = Math.max(36, (chipX.textContent?.length ?? 0) * 6.6 + 14);
      const cssPlotLeft = plot.x * scaleX;
      const cssPlotRight = (plot.x + plot.w) * scaleX;
      const cssScanX = scanX * scaleX;
      chipX.style.left = `${Math.max(cssPlotLeft, Math.min(cssPlotRight - cw, cssScanX - cw / 2))}px`;
      chipX.style.top = `${cssPlotBottom + 2}px`;
    } else {
      hairV.style.display = "none";
      hairH.style.display = "none";
      chipY.style.display = "none";
      chipX.style.display = "none";
    }

    if (hit?.role === "heat" && hit.w && hit.h) {
      cell.style.display = "block";
      cell.style.left = `${(hit.x ?? 0) * scaleX}px`;
      cell.style.top = `${(hit.y ?? 0) * scaleY}px`;
      cell.style.width = `${hit.w * scaleX}px`;
      cell.style.height = `${hit.h * scaleY}px`;
    } else {
      cell.style.display = "none";
    }

    const slices = stage.querySelectorAll("[data-role='slice']");
    if (hit?.role === "slice" && slices.length) {
      slices.forEach((el) => {
        const match = (el as SVGElement).getAttribute("data-idx") === String(hit.idx);
        (el as SVGElement).style.opacity = match ? "1" : "0.28";
      });
    } else {
      slices.forEach((el) => {
        (el as SVGElement).style.opacity = "1";
      });
    }

    if (sample && (sample.kind === "line" || sample.kind === "point" || sample.kind === "radar")) {
      dot.style.display = "block";
      dot.style.left = `${sample.x * scaleX}px`;
      dot.style.top = `${sample.y * scaleY}px`;
      dot.style.background = sample.color;
    } else {
      dot.style.display = "none";
    }

    let text = "";
    let accent = theme.accent;
    if (sample && (sample.kind === "line" || sample.kind === "point" || (compiled.polar && sample.kind === "radar"))) {
      text = sample.tip;
      accent = sample.color;
    } else if (accentNode) {
      text = tooltipText(accentNode);
      accent = (accentNode.fill && accentNode.fill !== "none" ? accentNode.fill : accentNode.stroke) || theme.accent;
    }
    if (!text) {
      tip.style.display = "none";
      currentOptions.onTooltip?.(null);
      return;
    }
    tip.textContent = text;
    tip.style.display = "block";
    currentOptions.onTooltip?.({
      x: compiled.xScale.kind === "linear" ? compiled.xScale.invert(sample?.x ?? x) : (sample?.tip ?? accentNode?.tip),
      y: compiled.yScale.kind === "linear" ? compiled.yScale.invert(sample?.y ?? y) : undefined,
      series: sample?.series ?? accentNode?.series,
      datum: accentNode?.datum,
      node: accentNode ?? null,
      sample: sample ?? null,
    });
    const tw = Math.min(220, Math.max(72, text.split("\n").reduce((a, l) => Math.max(a, l.length), 0) * 6.6 + 22));
    let left = cssX + 12;
    let top = cssY + 12;
    if (left + tw > box.width - 6) left = cssX - tw - 10;
    if (top + 44 > box.height - 6) top = cssY - 40;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${Math.max(4, top)}px`;
    tip.style.background = theme.chipBg;
    tip.style.boxShadow = `inset 2px 0 0 ${accent}, 0 0 0 1px ${theme.axis}`;
  };

  type PanDrag = {
    kind: "pan";
    startX: number;
    from: number;
    to: number;
    y?: [number, number];
  };
  let drag: null | PanDrag | { kind: "brush"; startX: number } = null;
  let panRaf = 0;
  let lastPanCssX = 0;

  const plotXToDomain = (compiled: CompiledChart, cssX: number, box: DOMRect): number | null => {
    if (compiled.xScale.kind !== "linear") return null;
    const scaleX = (box.width || compiled.width) / compiled.width;
    const x = cssX / scaleX;
    return compiled.xScale.invert(x);
  };

  const capturePointer = (ev: PointerEvent): void => {
    try { wrap.setPointerCapture(ev.pointerId); } catch { /* jsdom / detached */ }
  };

  const applyPanPreview = (userDx: number): void => {
    const svg = stage.querySelector("svg");
    if (!svg) return;
    const t = userDx ? `translate(${userDx})` : "";
    const plot = svg.querySelector("[data-role='plot']");
    const labels = svg.querySelector("[data-role='x-labels']");
    if (plot) {
      if (t) plot.setAttribute("transform", t);
      else plot.removeAttribute("transform");
    }
    if (labels) {
      if (t) labels.setAttribute("transform", t);
      else labels.removeAttribute("transform");
    }
  };

  const panShift = (
    compiled: CompiledChart,
    state: PanDrag,
    cssX: number,
    box: DOMRect,
  ): { viewport: ChartViewport; userDx: number } => {
    const scaleX = (box.width || compiled.width) / compiled.width;
    const userDx = (cssX - state.startX) / scaleX;
    const delta = -(userDx / (compiled.plot.w || 1)) * (state.to - state.from);
    const viewport: ChartViewport = { x: [state.from + delta, state.to + delta] };
    if (state.y) viewport.y = state.y;
    return { viewport, userDx };
  };

  const cancelPanRaf = (): void => {
    if (!panRaf) return;
    cancelAnimationFrame(panRaf);
    panRaf = 0;
  };

  const schedulePanCommit = (): void => {
    if (panRaf) return;
    const tick = (): void => {
      panRaf = 0;
      if (destroyed || drag?.kind !== "pan") return;
      if (liveViewport) currentOptions.onViewportChange?.(liveViewport);
      if ((currentOptions.renderer ?? "svg") !== "canvas") return;
      paint();
      if (drag?.kind !== "pan" || compiledRef?.xScale.kind !== "linear") return;
      drag.startX = lastPanCssX;
      drag.from = compiledRef.xScale.domain[0];
      drag.to = compiledRef.xScale.domain[1];
      applyPanPreview(0);
    };
    if (typeof requestAnimationFrame === "function") panRaf = requestAnimationFrame(tick);
    else tick();
  };

  const onWheel = (ev: WheelEvent): void => {
    if (isChromeEvent(ev)) return;
    const compiled = compiledRef;
    const interact = flags();
    if (!interact.zoom || !compiled || compiled.polar || compiled.heatmap || compiled.xScale.kind !== "linear") return;
    ev.preventDefault();
    const box = wrap.getBoundingClientRect();
    const domain = compiled.xScale.domain;
    const [lo, hi] = domain[0] <= domain[1] ? domain : [domain[1], domain[0]];
    const factor = ev.deltaY > 0 ? 1.12 : 0.88;
    const anchor = plotXToDomain(compiled, ev.clientX - box.left, box) ?? (lo + hi) / 2;
    const nextLo = anchor - (anchor - lo) * factor;
    const nextHi = anchor + (hi - anchor) * factor;
    emitViewport({ x: [nextLo, nextHi] });
  };

  const onPointerDown = (ev: PointerEvent): void => {
    if (isChromeEvent(ev)) return;
    const compiled = compiledRef;
    const interact = flags();
    if (!compiled || compiled.polar || compiled.heatmap) return;
    const target = ev.target as Element | null;
    const series = target?.closest?.("[data-series]")?.getAttribute("data-series");
    if (series) {
      if (hiddenSeries.has(series)) hiddenSeries.delete(series);
      else hiddenSeries.add(series);
      paint();
      return;
    }
    const box = wrap.getBoundingClientRect();
    const cssX = ev.clientX - box.left;
    if (ev.shiftKey && interact.brush) {
      drag = { kind: "brush", startX: cssX };
      brushRect.style.display = "block";
      ev.preventDefault();
      window.getSelection?.()?.removeAllRanges();
      capturePointer(ev);
      return;
    }
    if (interact.pan && compiled.xScale.kind === "linear") {
      const [from, to] = compiled.xScale.domain;
      drag = {
        kind: "pan",
        startX: cssX,
        from,
        to,
        y: compiled.yScale.kind === "linear"
          ? [compiled.yScale.domain[0], compiled.yScale.domain[1]]
          : undefined,
      };
      lastPanCssX = cssX;
      hideOverlay();
      wrap.style.cursor = "grabbing";
      ev.preventDefault();
      window.getSelection?.()?.removeAllRanges();
      capturePointer(ev);
    }
  };

  const onPointerDrag = (ev: PointerEvent): void => {
    if (!drag) return;
    ev.preventDefault();
    const compiled = compiledRef;
    if (!compiled) return;
    const box = wrap.getBoundingClientRect();
    const cssX = ev.clientX - box.left;
    if (drag.kind === "brush") {
      const left = Math.min(drag.startX, cssX);
      brushRect.style.left = `${left}px`;
      brushRect.style.top = `${compiled.plot.y}px`;
      brushRect.style.width = `${Math.abs(cssX - drag.startX)}px`;
      brushRect.style.height = `${compiled.plot.h}px`;
      brushRect.style.display = "block";
      return;
    }
    lastPanCssX = cssX;
    const { viewport, userDx } = panShift(compiled, drag, cssX, box);
    liveViewport = viewport;
    applyPanPreview(userDx);
    schedulePanCommit();
  };

  const onPointerUp = (ev: PointerEvent): void => {
    if (!drag && isChromeEvent(ev)) return;
    const compiled = compiledRef;
    const box = wrap.getBoundingClientRect();
    const cssX = ev.clientX - box.left;
    cancelPanRaf();
    wrap.style.cursor = "";
    if (drag?.kind === "brush" && compiled && compiled.xScale.kind === "linear") {
      const a = plotXToDomain(compiled, drag.startX, box);
      const b = plotXToDomain(compiled, cssX, box);
      brushRect.style.display = "none";
      if (a != null && b != null && Math.abs(a - b) > 0) {
        emitViewport({ x: a < b ? [a, b] : [b, a] });
      }
    } else if (drag?.kind === "pan" && compiled && compiled.xScale.kind === "linear") {
      const { viewport } = panShift(compiled, drag, cssX, box);
      applyPanPreview(0);
      emitViewport({ x: viewport.x });
    } else if (!drag && compiled) {
      const scaleX = (box.width || compiled.width) / compiled.width;
      const scaleY = (box.height || compiled.height) / compiled.height;
      const x = (ev.clientX - box.left) / scaleX;
      const y = (ev.clientY - box.top) / scaleY;
      const sample = nearestSample(compiled, x, y);
      const node = hitTestCompiled(compiled, x, y);
      currentOptions.onSelect?.({
        x: compiled.xScale.kind === "linear" ? compiled.xScale.invert(x) : x,
        y: compiled.yScale.kind === "linear" ? compiled.yScale.invert(y) : undefined,
        series: sample?.series ?? node?.series,
        datum: node?.datum,
        node,
        sample,
      });
    }
    drag = null;
    brushRect.style.display = "none";
  };

  const onSelectStart = (ev: Event): void => {
    if (isChromeEvent(ev)) return;
    ev.preventDefault();
  };

  const onPointerMoveAll = (ev: PointerEvent): void => {
    onPointerDrag(ev);
    if (!drag) onMove(ev);
  };

  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => {
    const next = inputSize();
    if (next.width === lastInputWidth && next.height === lastInputHeight) return;
    paint();
  }) : null;
  try {
    paint();
    wrap.addEventListener("pointermove", onPointerMoveAll);
    wrap.addEventListener("pointerleave", hideOverlay);
    wrap.addEventListener("pointerdown", onPointerDown);
    wrap.addEventListener("pointerup", onPointerUp);
    wrap.addEventListener("pointercancel", onPointerUp);
    wrap.addEventListener("selectstart", onSelectStart);
    wrap.addEventListener("wheel", onWheel, { passive: false });
    presetsBar.addEventListener("pointerdown", stopChromePointer);
    presetsBar.addEventListener("pointerup", stopChromePointer);
    presetsBar.addEventListener("wheel", stopChromePointer);
    nav.addEventListener("pointerdown", onNavPointerDown);
    nav.addEventListener("pointerup", stopChromePointer);
    nav.addEventListener("wheel", stopChromePointer);
    ro?.observe(wrap);
  } catch (error) {
    ro?.disconnect();
    wrap.removeEventListener("pointermove", onPointerMoveAll);
    wrap.removeEventListener("pointerleave", hideOverlay);
    wrap.removeEventListener("pointerdown", onPointerDown);
    wrap.removeEventListener("pointerup", onPointerUp);
    wrap.removeEventListener("pointercancel", onPointerUp);
    wrap.removeEventListener("selectstart", onSelectStart);
    wrap.removeEventListener("wheel", onWheel);
    presetsBar.removeEventListener("pointerdown", stopChromePointer);
    presetsBar.removeEventListener("pointerup", stopChromePointer);
    presetsBar.removeEventListener("wheel", stopChromePointer);
    nav.removeEventListener("pointerdown", onNavPointerDown);
    nav.removeEventListener("pointerup", stopChromePointer);
    nav.removeEventListener("wheel", stopChromePointer);
    wrap.remove();
    throw error;
  }
  return {
    update(next, nextOptions) {
      if (destroyed) throw new Error("[@razedotbot/charts] Cannot update a destroyed chart mount.");
      const previous = current;
      const previousOptions = currentOptions;
      const previousScene = compiledRef;
      current = next;
      if (nextOptions) {
        currentOptions = { ...currentOptions, ...nextOptions };
        if (nextOptions.viewport) liveViewport = nextOptions.viewport;
        if (nextOptions.hiddenSeries) hiddenSeries = new Set(nextOptions.hiddenSeries);
      }
      try {
        paint();
      } catch (error) {
        current = previous;
        currentOptions = previousOptions;
        compiledRef = previousScene;
        throw error;
      }
    },
    getScene() { return destroyed ? null : compiledRef; },
    setViewport(viewport) {
      liveViewport = viewport;
      paint();
    },
    getViewport() {
      return liveViewport;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelPanRaf();
      ro?.disconnect();
      wrap.removeEventListener("pointermove", onPointerMoveAll);
      wrap.removeEventListener("pointerleave", hideOverlay);
      wrap.removeEventListener("pointerdown", onPointerDown);
      wrap.removeEventListener("pointerup", onPointerUp);
      wrap.removeEventListener("pointercancel", onPointerUp);
      wrap.removeEventListener("selectstart", onSelectStart);
      wrap.removeEventListener("wheel", onWheel);
      presetsBar.removeEventListener("pointerdown", stopChromePointer);
      presetsBar.removeEventListener("pointerup", stopChromePointer);
      presetsBar.removeEventListener("wheel", stopChromePointer);
      nav.removeEventListener("pointerdown", onNavPointerDown);
      nav.removeEventListener("pointerup", stopChromePointer);
      nav.removeEventListener("wheel", stopChromePointer);
      wrap.remove();
      compiledRef = null;
    },
  };
}

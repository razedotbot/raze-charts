import { compileChart, type ChartDefinition, type CompiledChart, type HoverSample, type SceneNode } from "./defineChart";
import { heatFill, type DashboardTheme } from "./theme";
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
function monotonePath(pts: { x: number; y: number }[]): string {
  if (!pts.length) return "";
  if (pts.length === 1) return `M${round(pts[0]!.x)} ${round(pts[0]!.y)}`;
  if (pts.length === 2) {
    return `M${round(pts[0]!.x)} ${round(pts[0]!.y)} L${round(pts[1]!.x)} ${round(pts[1]!.y)}`;
  }
  const n = pts.length;
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1]!.x - pts[i]!.x;
    m[i] = dx[i] === 0 ? 0 : (pts[i + 1]!.y - pts[i]!.y) / dx[i]!;
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
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      t[i] = tau * a * m[i]!;
      t[i + 1] = tau * b * m[i]!;
    }
  }
  let d = `M${round(pts[0]!.x)} ${round(pts[0]!.y)}`;
  for (let i = 0; i < n - 1; i++) {
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

function arcPath(n: SceneNode): string {
  const cx = n.x ?? 0;
  const cy = n.y ?? 0;
  const r = n.r ?? 0;
  const inner = n.innerR ?? 0;
  const a0 = n.startAngle ?? 0;
  const a1 = n.endAngle ?? 0;
  const large = (a1 - a0) % (Math.PI * 2) > Math.PI ? 1 : 0;
  const x0 = cx + Math.cos(a0) * r;
  const y0 = cy + Math.sin(a0) * r;
  const x1 = cx + Math.cos(a1) * r;
  const y1 = cy + Math.sin(a1) * r;
  if (inner <= 0) {
    return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`;
  }
  const ix0 = cx + Math.cos(a0) * inner;
  const iy0 = cy + Math.sin(a0) * inner;
  const ix1 = cx + Math.cos(a1) * inner;
  const iy1 = cy + Math.sin(a1) * inner;
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
  const hex = color.startsWith("rgb") ? color : color;
  // mix toward cream for a top-edge sheen
  const m = hex.match(/^#([0-9a-fA-F]{6})$/);
  const rgb = hex.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  let r = 102, g = 216, b = 158;
  if (m) {
    r = parseInt(m[1]!.slice(0, 2), 16);
    g = parseInt(m[1]!.slice(2, 4), 16);
    b = parseInt(m[1]!.slice(4, 6), 16);
  } else if (rgb) {
    r = +rgb[1]!; g = +rgb[2]!; b = +rgb[3]!;
  }
  const u = Math.max(0, Math.min(1, t));
  return `rgb(${Math.round(r + (244 - r) * u)},${Math.round(g + (238 - g) * u)},${Math.round(b + (225 - b) * u)})`;
}

function shade(color: string, t: number): string {
  const m = color.match(/^#([0-9a-fA-F]{6})$/);
  const rgb = color.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  let r = 102, g = 216, b = 158;
  if (m) {
    r = parseInt(m[1]!.slice(0, 2), 16);
    g = parseInt(m[1]!.slice(2, 4), 16);
    b = parseInt(m[1]!.slice(4, 6), 16);
  } else if (rgb) {
    r = +rgb[1]!; g = +rgb[2]!; b = +rgb[3]!;
  }
  const u = Math.max(0, Math.min(1, t));
  return `rgb(${Math.round(r * (1 - u))},${Math.round(g * (1 - u))},${Math.round(b * (1 - u))})`;
}

function nodeSvg(n: SceneNode, i: number, theme: DashboardTheme, uid: number): string {
  const stroke = n.stroke ?? "none";
  const fill = n.fill ?? "none";
  const sw = n.strokeWidth != null ? ` stroke-width="${n.strokeWidth}"` : "";
  const lc = ` stroke-linecap="round" stroke-linejoin="round"`;
  const mark = n.idx != null ? ` data-idx="${n.idx}"` : "";
  const role = n.role ? ` data-role="${esc(n.role)}"` : "";
  if (n.type === "line" && n.points) {
    const dash = n.dashed ? ` stroke-dasharray="4.5 3.5"` : "";
    const path = n.dashed && n.points.length <= 2
      ? `M${round(n.points[0]!.x)} ${round(n.points[0]!.y)} L${round(n.points[1]?.x ?? n.points[0]!.x)} ${round(n.points[1]?.y ?? n.points[0]!.y)}`
      : monotonePath(n.points);
    return `<path fill="none" stroke="${esc(stroke)}"${sw}${lc}${dash}${role} d="${path}" />`;
  }
  if (n.type === "area" && n.points && n.points.length >= 3) {
    const mid = n.points.slice(1, -1);
    const yBase = n.points[0]!.y;
    const gid = `raze-fill-${uid}-${i}`;
    const top = mid[0]!;
    const last = mid[mid.length - 1]!;
    const d = `${monotonePath(mid)} L${round(last.x)} ${round(yBase)} L${round(top.x)} ${round(yBase)} Z`;
    const fo = n.fillOpacity ?? 0.42;
    return [
      `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">`,
      `<stop offset="0%" stop-color="${esc(fill)}" stop-opacity="${fo}"/>`,
      `<stop offset="18%" stop-color="${esc(fill)}" stop-opacity="${fo * 0.72}"/>`,
      `<stop offset="48%" stop-color="${esc(fill)}" stop-opacity="${fo * 0.28}"/>`,
      `<stop offset="78%" stop-color="${esc(fill)}" stop-opacity="0.04"/>`,
      `<stop offset="100%" stop-color="${esc(fill)}" stop-opacity="0"/>`,
      `</linearGradient></defs>`,
      `<path fill="url(#${gid})" stroke="none" d="${d}" />`,
    ].join("");
  }
  if (n.type === "polygon" && n.points) {
    const pts = n.points.map((p) => `${round(p.x)},${round(p.y)}`).join(" ");
    const fo = n.fillOpacity != null && n.fill !== "none" ? ` fill-opacity="${n.fillOpacity}"` : "";
    return `<polygon fill="${esc(fill)}"${fo} stroke="${esc(stroke)}"${sw}${lc} points="${pts}" />`;
  }
  if (n.type === "rect") {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const w = Math.max(0, n.w ?? 0);
    const h = Math.max(0, n.h ?? 0);
    const st = n.stroke && n.stroke !== "none"
      ? ` stroke="${esc(n.stroke)}" stroke-width="${n.strokeWidth ?? 1}"`
      : "";
    if (n.corner === "top") {
      const gid = `raze-bar-${uid}-${i}`;
      const hi = lift(fill, 0.22);
      const lo = shade(fill, 0.14);
      const rr = Math.min(2.5, w / 2, Math.max(0, h));
      const sheen = h >= 6 && w >= 4
        ? `<path d="M${round(x + rr + 0.5)} ${hair(y)} L${round(x + w - rr - 0.5)} ${hair(y)}" fill="none" stroke="rgba(244,238,225,0.28)" stroke-width="1" stroke-linecap="round" />`
        : "";
      return [
        `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">`,
        `<stop offset="0%" stop-color="${esc(hi)}"/>`,
        `<stop offset="38%" stop-color="${esc(fill)}"/>`,
        `<stop offset="100%" stop-color="${esc(lo)}"/>`,
        `</linearGradient></defs>`,
        `<path d="${roundTopRect(x, y, w, h, rr)}" fill="url(#${gid})"${st}${role} />`,
        sheen,
      ].join("");
    }
    if (n.corner === "none" || n.role === "heat") {
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${esc(fill)}"${st}${role} />`;
    }
    const rx = Math.min(2.5, w / 2, h / 2);
    return `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" rx="${rx}" fill="${esc(fill)}"${st}${role} />`;
  }
  if (n.type === "circle") {
    const cs = n.stroke && n.stroke !== "none" ? ` stroke="${esc(n.stroke)}" stroke-width="${n.strokeWidth ?? 1}"` : "";
    const fo = n.fillOpacity != null ? ` fill-opacity="${n.fillOpacity}"` : "";
    return `<circle cx="${round(n.x ?? 0)}" cy="${round(n.y ?? 0)}" r="${n.r}" fill="${esc(fill)}"${fo}${cs}${role} />`;
  }
  if (n.type === "rule") {
    const dash = n.dashed === false ? "" : ` stroke-dasharray="3.5 3"`;
    return `<line x1="${hair(n.x ?? 0)}" y1="${hair(n.y ?? 0)}" x2="${hair(n.x2 ?? 0)}" y2="${hair(n.y2 ?? 0)}" stroke="${esc(stroke)}"${sw}${dash} />`;
  }
  if (n.type === "arc") {
    return `<path d="${arcPath(n)}" fill="${esc(fill)}" stroke="${esc(stroke)}"${sw}${mark}${role} />`;
  }
  if (n.type === "text" && n.label) {
    const anchor = n.anchor ?? "start";
    const size = n.fontSize ?? 11;
    const baseline = "central";
    const weight = size >= 18 ? ` font-weight="600"` : "";
    return `<text x="${round(n.x ?? 0)}" y="${round(n.y ?? 0)}" text-anchor="${anchor}" dominant-baseline="${baseline}" font-size="${size}"${weight} fill="${esc(n.fill || theme.muted)}">${esc(n.label)}</text>`;
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

export function renderChartSvg(definition: ChartDefinition, size: { width: number; height: number }): string {
  const c = compileChart(definition, size);
  return svgFromCompiled(c);
}

let svgSeq = 0;

export function svgFromCompiled(c: CompiledChart): string {
  const { width, height, plot, theme } = c;
  const uid = ++svgSeq;
  const clipId = `raze-plot-${uid}`;
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
    ...c.xTicks.map((t) =>
      `<text x="${t.px}" y="${plot.y + plot.h + 14}" text-anchor="middle" font-size="9" fill="${esc(theme.muted)}">${esc(t.label)}</text>`,
    ),
  ].join("");

  let legend = "";
  if (c.legendPlacement === "right" && c.legend.length) {
    const lx = plot.x + plot.w + 18;
    const rowH = 40;
    const block = c.legend.length * rowH;
    const y0 = plot.y + Math.max(0, (plot.h - block) / 2);
    legend = `<g font-size="11">${c.legend.map((l, i) => {
      const y = y0 + i * rowH;
      return `<g transform="translate(${lx},${y})"><rect width="8" height="8" y="2" rx="1.5" fill="${esc(l.color)}" /><text x="14" y="6" dominant-baseline="middle" fill="${esc(theme.text)}">${esc(l.name)}</text>${l.detail ? `<text x="14" y="22" dominant-baseline="middle" font-size="9" fill="${esc(theme.muted)}">${esc(l.detail)}</text>` : ""}</g>`;
    }).join("")}</g>`;
  } else if (c.legendPlacement === "top" && c.legend.length) {
    let lx = plot.x;
    legend = `<g font-size="10">${c.legend.map((l) => {
      const w = 16 + l.name.length * 6.2 + (l.detail ? l.detail.length * 5.6 : 0);
      const g = `<g transform="translate(${lx},14)"><rect width="7" height="7" y="-5" rx="1.5" fill="${esc(l.color)}" /><text x="11" fill="${esc(theme.text)}">${esc(l.name)}${l.detail ? `  ${esc(l.detail)}` : ""}</text></g>`;
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
      chipSvg(plot.x + plot.w + 3, top, axisW - 6, 15, lv.color, theme.lastChipFg, lv.label, "end"),
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
  const clip = `<defs><clipPath id="${clipId}"><rect x="${plot.x}" y="${plot.y}" width="${plot.w}" height="${plot.h}" /></clipPath></defs><g clip-path="url(#${clipId})">${body}</g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(c.ariaLabel)}" style="display:block;width:100%;height:100%;${font};background:${esc(theme.background)}"><rect width="${width}" height="${height}" fill="${esc(theme.background)}" />${legend}${grid}${clip}${overlay}${yAxis}${xAxis}${last}${bar}</svg>`;
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
  const a1 = n.endAngle ?? 0;
  let ang = Math.atan2(dy, dx);
  const twoPi = Math.PI * 2;
  while (ang < a0) ang += twoPi;
  while (ang > a0 + twoPi) ang -= twoPi;
  return ang <= a1 + 1e-6;
}

/** Nearest painted mark under a plot-space pointer. Used by HTML tooltips. */
export function hitTestCompiled(c: CompiledChart, x: number, y: number): SceneNode | null {
  const pad = 6;
  for (let i = c.nodes.length - 1; i >= 0; i--) {
    const n = c.nodes[i]!;
    if (n.hit === false) continue;
    if (n.type === "text") continue;
    if (n.type === "rect") {
      const nx = n.x ?? 0;
      const ny = n.y ?? 0;
      if (x >= nx && x <= nx + (n.w ?? 0) && y >= ny && y <= ny + (n.h ?? 0)) return n;
    } else if (n.type === "circle") {
      if (Math.hypot(x - (n.x ?? 0), y - (n.y ?? 0)) <= (n.r ?? 3) + pad) return n;
    } else if (n.type === "arc") {
      if (inArc(n, x, y)) return n;
    } else if ((n.type === "line" || n.type === "area" || n.type === "polygon") && n.points && n.points.length) {
      if (n.type === "polygon" && (n.fill === "none" || !n.series)) {
        continue;
      }
      if (n.type !== "line") {
        let inside = false;
        const pts = n.points;
        for (let j = 0, k = pts.length - 1; j < pts.length; k = j++) {
          const a = pts[j]!;
          const b = pts[k]!;
          const hit = ((a.y > y) !== (b.y > y)) && (x < (b.x - a.x) * (y - a.y) / (b.y - a.y || 1e-9) + a.x);
          if (hit) inside = !inside;
        }
        if (inside) return n;
      }
      for (let j = 1; j < n.points.length; j++) {
        const a = n.points[j - 1]!;
        const b = n.points[j]!;
        if (distToSeg(x, y, a.x, a.y, b.x, b.y) <= pad) return n;
      }
    } else if (n.type === "rule" && n.dashed !== false) {
      if (distToSeg(x, y, n.x ?? 0, n.y ?? 0, n.x2 ?? 0, n.y2 ?? 0) <= pad) return n;
    }
  }
  return null;
}

export function nearestSample(c: CompiledChart, x: number, y: number): HoverSample | null {
  const samples = c.samples;
  if (!samples.length) return null;
  const kinds = new Set(samples.map((s) => s.kind));
  if (kinds.has("point") && !kinds.has("line")) {
    let best: HoverSample | null = null;
    let bestD = 48;
    for (const s of samples) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }
  if (kinds.has("radar")) {
    let best: HoverSample | null = null;
    let bestD = 22;
    for (const s of samples) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }
  let best: HoverSample | null = null;
  let bestDx = Infinity;
  let bestDy = Infinity;
  for (const s of samples) {
    if (s.kind !== "line") continue;
    const dx = Math.abs(s.x - x);
    const dy = Math.abs(s.y - y);
    if (dx < bestDx - 0.5 || (Math.abs(dx - bestDx) <= 0.5 && dy < bestDy)) {
      bestDx = dx;
      bestDy = dy;
      best = s;
    }
  }
  return best;
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
    `color:${theme.chipFg}`,
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
    `color:${theme.chipFg}`,
    `font:10px ${theme.font}`,
    "font-variant-numeric:tabular-nums",
    "padding:1px 6px",
    "border-radius:2.5px",
    "line-height:15px",
    "white-space:nowrap",
    `box-shadow:0 0 0 6px ${theme.background}`,
  ].join(";");
}

export function paintChartCanvas(ctx: CanvasRenderingContext2D, c: CompiledChart): void {
  const theme = c.theme;
  ctx.save();
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.font = `11px ${theme.font}`;
  if (c.grid && !c.polar) {
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    for (const t of c.yTicks) {
      ctx.beginPath();
      ctx.moveTo(c.plot.x, hair(t.px));
      ctx.lineTo(c.plot.x + c.plot.w, hair(t.px));
      ctx.stroke();
    }
  }
  ctx.fillStyle = theme.muted;
  if (!c.polar) {
    ctx.textAlign = "end";
    ctx.textBaseline = "middle";
    for (const t of c.yTicks) ctx.fillText(t.label, c.width - 8, t.px);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const t of c.xTicks) ctx.fillText(t.label, t.px, c.plot.y + c.plot.h + 8);
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(c.plot.x, c.plot.y, c.plot.w, c.plot.h);
  ctx.clip();
  for (const n of c.nodes) {
    if (n.type === "line" && n.points) {
      ctx.beginPath();
      n.points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.strokeStyle = n.stroke || theme.accent;
      ctx.lineWidth = n.strokeWidth ?? 1.5;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.setLineDash(n.dashed ? [5, 4] : []);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if ((n.type === "area" || n.type === "polygon") && n.points) {
      ctx.beginPath();
      n.points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.closePath();
      if (n.fill && n.fill !== "none") {
        ctx.fillStyle = n.fill;
        ctx.globalAlpha = n.fillOpacity ?? 1;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      if (n.stroke && n.stroke !== "none") {
        ctx.strokeStyle = n.stroke;
        ctx.lineWidth = n.strokeWidth ?? 1;
        ctx.stroke();
      }
    } else if (n.type === "rect") {
      ctx.fillStyle = n.fill || theme.accent;
      ctx.fillRect(n.x ?? 0, n.y ?? 0, n.w ?? 0, n.h ?? 0);
    } else if (n.type === "circle") {
      ctx.beginPath();
      ctx.arc(n.x ?? 0, n.y ?? 0, n.r ?? 3, 0, Math.PI * 2);
      ctx.fillStyle = n.fill || theme.accent;
      ctx.globalAlpha = n.fillOpacity ?? 1;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (n.stroke && n.stroke !== "none") {
        ctx.strokeStyle = n.stroke;
        ctx.lineWidth = n.strokeWidth ?? 1;
        ctx.stroke();
      }
    } else if (n.type === "rule") {
      ctx.beginPath();
      ctx.moveTo(n.x ?? 0, n.y ?? 0);
      ctx.lineTo(n.x2 ?? 0, n.y2 ?? 0);
      ctx.strokeStyle = n.stroke || theme.down;
      ctx.setLineDash(n.dashed === false ? [] : [3, 3]);
      ctx.lineWidth = n.strokeWidth ?? 1;
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (n.type === "arc") {
      const p = new Path2D(arcPath(n));
      ctx.fillStyle = n.fill || theme.accent;
      ctx.fill(p);
    }
  }
  ctx.restore();
  ctx.restore();
}

export interface MountHandle {
  update(definition: ChartDefinition): void;
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
  opts?: { width?: number; height?: number; renderer?: "svg" | "canvas" },
): MountHandle {
  const renderer = opts?.renderer ?? "svg";
  let current = definition;
  let compiledRef: CompiledChart | null = null;
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:relative;width:100%;height:100%;overflow:hidden;";
  const stage = document.createElement("div");
  stage.style.cssText = "width:100%;height:100%;";
  const hairV = document.createElement("div");
  const hairH = document.createElement("div");
  const chipY = document.createElement("div");
  const chipX = document.createElement("div");
  const tip = document.createElement("div");
  const dot = document.createElement("div");
  const cell = document.createElement("div");
  wrap.append(stage, hairV, hairH, chipY, chipX, cell, dot, tip);
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
  };
  applyTheme(compileChart(current, { width: 320, height: 200 }).theme);

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

  const paint = (): void => {
    const w = opts?.width ?? Math.max(1, wrap.clientWidth || el.clientWidth || 640);
    const h = opts?.height ?? Math.max(1, wrap.clientHeight || el.clientHeight || 320);
    const compiled = compileChart(current, { width: w, height: h });
    compiledRef = compiled;
    applyTheme(compiled.theme);
    stage.replaceChildren();
    if (renderer === "canvas") {
      const canvas = document.createElement("canvas");
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.cssText = `width:${w}px;height:${h}px;display:block`;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        paintChartCanvas(ctx, compiled);
      }
      stage.appendChild(canvas);
    } else {
      stage.innerHTML = svgFromCompiled(compiled);
    }
  };

  const onMove = (ev: PointerEvent): void => {
    const compiled = compiledRef;
    if (!compiled?.tooltip) {
      hideOverlay();
      return;
    }
    const box = wrap.getBoundingClientRect();
    const x = ev.clientX - box.left;
    const y = ev.clientY - box.top;
    const { plot, theme } = compiled;
    const inPlot = compiled.polar
      ? x >= 0 && y >= 0 && x <= box.width && y <= box.height
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
            ? hit.y
            : isLine && sample
              ? sample.y
              : y;

      hairV.style.display = "block";
      hairV.style.left = `${Math.round(scanX)}px`;
      hairV.style.top = `${plot.y}px`;
      hairV.style.height = `${plot.h}px`;

      if (isHeat || isPoint || isBar) {
        hairH.style.display = "block";
        hairH.style.top = `${Math.round(scanY)}px`;
        hairH.style.left = `${plot.x}px`;
        hairH.style.width = `${plot.w}px`;
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
        ? `${Math.max(2, plot.x - 42)}px`
        : `${plot.x + plot.w + 3}px`;
      chipY.style.top = `${Math.max(plot.y, Math.min(plot.y + plot.h - 16, scanY - 8))}px`;

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
      chipX.style.left = `${Math.max(plot.x, Math.min(plot.x + plot.w - cw, scanX - cw / 2))}px`;
      chipX.style.top = `${plot.y + plot.h + 2}px`;
    } else {
      hairV.style.display = "none";
      hairH.style.display = "none";
      chipY.style.display = "none";
      chipX.style.display = "none";
    }

    if (hit?.role === "heat" && hit.w && hit.h) {
      cell.style.display = "block";
      cell.style.left = `${hit.x}px`;
      cell.style.top = `${hit.y}px`;
      cell.style.width = `${hit.w}px`;
      cell.style.height = `${hit.h}px`;
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
      dot.style.left = `${sample.x}px`;
      dot.style.top = `${sample.y}px`;
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
      return;
    }
    tip.textContent = text;
    tip.style.display = "block";
    const tw = Math.min(220, Math.max(72, text.split("\n").reduce((a, l) => Math.max(a, l.length), 0) * 6.6 + 22));
    let left = x + 12;
    let top = y + 12;
    if (left + tw > box.width - 6) left = x - tw - 10;
    if (top + 44 > box.height - 6) top = y - 40;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${Math.max(4, top)}px`;
    tip.style.background = theme.chipBg;
    tip.style.boxShadow = `inset 2px 0 0 ${accent}, 0 0 0 1px ${theme.axis}`;
  };

  wrap.addEventListener("pointermove", onMove);
  wrap.addEventListener("pointerleave", hideOverlay);

  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => paint()) : null;
  ro?.observe(wrap);
  paint();
  return {
    update(next) { current = next; paint(); },
    destroy() {
      ro?.disconnect();
      wrap.removeEventListener("pointermove", onMove);
      wrap.removeEventListener("pointerleave", hideOverlay);
      wrap.remove();
    },
  };
}

// Dashboard charts share the raze widget palette (pane, grid, axis, chips).
// Light is the TradingView-style light pane, not a generic white card.

export interface DashboardTheme {
  background: string;
  text: string;
  muted: string;
  grid: string;
  axis: string;
  crosshair: string;
  font: string;
  accent: string;
  down: string;
  gold: string;
  sky: string;
  /** Neutral cell for heatmap zero / missing magnitude. */
  heatZero: string;
  chipBg: string;
  chipFg: string;
  lastChipFg: string;
}

const FONT = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";

export const DARK_CHART_THEME: DashboardTheme = {
  background: "#181615",
  text: "#f4eee1",
  muted: "#8b887e",
  grid: "rgba(244,238,225,0.045)",
  axis: "#3d3935",
  crosshair: "rgba(244,238,225,0.38)",
  font: FONT,
  accent: "#66d89e",
  down: "#e57359",
  gold: "#d8aa5b",
  sky: "#8ecae6",
  heatZero: "#1c1a18",
  chipBg: "#3a3833",
  chipFg: "#f4eee1",
  lastChipFg: "#10100e",
};

export const LIGHT_CHART_THEME: DashboardTheme = {
  background: "#ffffff",
  text: "#131722",
  muted: "#6a6d75",
  grid: "rgba(19,23,34,0.06)",
  axis: "#e0e3eb",
  crosshair: "rgba(19,23,34,0.28)",
  font: FONT,
  accent: "#26a69a",
  down: "#ef5350",
  gold: "#c1963b",
  sky: "#5b9bb0",
  heatZero: "#eef0f4",
  chipBg: "#131722",
  chipFg: "#ffffff",
  lastChipFg: "#ffffff",
};

/** Series colours used when a mark does not set stroke/fill. */
export const CHART_PALETTE = ["#66d89e", "#d8aa5b", "#8ecae6", "#e57359", "#c4b5fd", "#f4eee1"] as const;

export type ChartThemeInput = "dark" | "light" | Partial<DashboardTheme>;

function heatEase(t: number): number {
  const u = Math.max(0, Math.min(1, t));
  const dead = 0.07;
  if (u <= dead) return 0;
  return Math.pow((u - dead) / (1 - dead), 1.62);
}

export function heatFill(value: number, lo: number, hi: number, theme: DashboardTheme): string {
  const mid = theme.heatZero;
  if (lo < 0 && hi > 0) {
    const mag = Math.max(Math.abs(lo), hi) || 1;
    const e = heatEase(Math.abs(value) / mag);
    if (value >= 0) {
      if (e < 0.42) return mixHex(mid, "#2f5c47", e / 0.42);
      return mixHex("#2f5c47", theme.accent, (e - 0.42) / 0.58);
    }
    if (e < 0.42) return mixHex(mid, "#6e3c34", e / 0.42);
    return mixHex("#6e3c34", theme.down, (e - 0.42) / 0.58);
  }
  const span = hi - lo || 1;
  const e = heatEase((value - lo) / span);
  if (e < 0.42) return mixHex(mid, "#2f5c47", e / 0.42);
  return mixHex("#2f5c47", theme.accent, (e - 0.42) / 0.58);
}

/** Sequential ramp down → gold → accent, used for scatter / unfilled points. */
export function rampFill(t: number, theme: DashboardTheme): string {
  const u = Math.max(0, Math.min(1, t));
  if (u < 0.5) return mixHex(theme.down, theme.gold, u * 2);
  return mixHex(theme.gold, theme.accent, (u - 0.5) * 2);
}

export function heatLabelColor(fill: string, theme: DashboardTheme): string {
  return isLightHex(fill) ? theme.lastChipFg : theme.text;
}

export function mixHex(a: string, b: string, t: number): string {
  const ca = parseRgb(a);
  const cb = parseRgb(b);
  if (!ca || !cb) return b;
  const u = Math.max(0, Math.min(1, t));
  const r = Math.round(ca.r + (cb.r - ca.r) * u);
  const g = Math.round(ca.g + (cb.g - ca.g) * u);
  const bl = Math.round(ca.b + (cb.b - ca.b) * u);
  return `rgb(${r},${g},${bl})`;
}

function parseRgb(color: string): { r: number; g: number; b: number } | null {
  const rgb = color.trim().match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (rgb) {
    return { r: +rgb[1]!, g: +rgb[2]!, b: +rgb[3]! };
  }
  const m = color.trim().match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h.split("").map((x) => x + x).join("");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function isLightHex(color: string): boolean {
  const c = parseRgb(color);
  if (!c) return false;
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b > 148;
}

export function resolveChartTheme(input?: ChartThemeInput): DashboardTheme {
  if (input == null || input === "dark") return DARK_CHART_THEME;
  if (input === "light") return LIGHT_CHART_THEME;
  const base = input.background && isLightHex(input.background) ? LIGHT_CHART_THEME : DARK_CHART_THEME;
  return { ...base, ...input };
}

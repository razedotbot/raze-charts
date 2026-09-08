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

export const DARK_CHART_THEME: Readonly<DashboardTheme> = Object.freeze({
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
});

export const LIGHT_CHART_THEME: Readonly<DashboardTheme> = Object.freeze({
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
  lastChipFg: "#10100e",
});

/** Series colours used when a mark does not set stroke/fill. */
export const CHART_PALETTE: readonly string[] = Object.freeze([
  "#66d89e", "#d8aa5b", "#8ecae6", "#e57359", "#c4b5fd", "#f4eee1",
] as const);

/** Series colours tuned to keep every slot legible on a white plot. */
export const LIGHT_CHART_PALETTE: readonly string[] = Object.freeze([
  "#087a55", "#8a5a00", "#1769aa", "#a23b34", "#6750a4", "#374151",
] as const);

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
  return readableTextColor(fill, theme);
}

export function mixHex(a: string, b: string, t: number): string {
  const ca = parseChartColor(a);
  const cb = parseChartColor(b);
  if (!ca) return cb ? b : (t < 0.5 ? a : b);
  if (!cb) return a;
  const u = Math.max(0, Math.min(1, t));
  return formatChartColor({
    r: ca.r + (cb.r - ca.r) * u,
    g: ca.g + (cb.g - ca.g) * u,
    b: ca.b + (cb.b - ca.b) * u,
    a: ca.a + (cb.a - ca.a) * u,
  });
}

export interface ParsedChartColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const NAMED_COLORS: Readonly<Record<string, string>> = Object.freeze({
  transparent: "#00000000",
  black: "#000000",
  silver: "#c0c0c0",
  gray: "#808080",
  grey: "#808080",
  white: "#ffffff",
  maroon: "#800000",
  red: "#ff0000",
  purple: "#800080",
  fuchsia: "#ff00ff",
  green: "#008000",
  lime: "#00ff00",
  olive: "#808000",
  yellow: "#ffff00",
  navy: "#000080",
  blue: "#0000ff",
  teal: "#008080",
  aqua: "#00ffff",
  orange: "#ffa500",
  rebeccapurple: "#663399",
});

const NUMBER_TOKEN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function parseNumberToken(token: string): number | null {
  const value = token.trim();
  if (!NUMBER_TOKEN.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseAlpha(token: string | undefined): number | null {
  if (token == null) return 1;
  const value = token.trim();
  const percentage = value.endsWith("%");
  const parsed = parseNumberToken(percentage ? value.slice(0, -1) : value);
  return parsed == null ? null : clamp(percentage ? parsed / 100 : parsed, 0, 1);
}

function splitFunctionalChannels(body: string): { channels: string[]; alpha?: string } | null {
  const slashParts = body.split("/");
  if (slashParts.length > 2) return null;
  const channelSource = slashParts[0]!.trim();
  let alpha = slashParts[1]?.trim();
  if (alpha === "") return null;

  let channels: string[];
  if (channelSource.includes(",")) {
    channels = channelSource.split(",").map((part) => part.trim());
    if (channels.some((part) => part === "")) return null;
    if (channels.length === 4 && alpha == null) {
      const legacyAlpha = channels.pop();
      if (legacyAlpha == null) return null;
      alpha = legacyAlpha;
    }
  } else {
    channels = channelSource.split(/\s+/).filter(Boolean);
  }
  return channels.length === 3 ? { channels, ...(alpha == null ? {} : { alpha }) } : null;
}

function parseRgbChannel(token: string): number | null {
  const value = token.trim();
  const percentage = value.endsWith("%");
  const parsed = parseNumberToken(percentage ? value.slice(0, -1) : value);
  return parsed == null ? null : clamp(percentage ? parsed * 2.55 : parsed, 0, 255);
}

function parseHue(token: string): number | null {
  const match = token.trim().toLowerCase().match(
    /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(deg|grad|rad|turn)?$/,
  );
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const degrees = match[2] === "turn"
    ? amount * 360
    : match[2] === "grad"
      ? amount * 0.9
      : match[2] === "rad"
        ? amount * 180 / Math.PI
        : amount;
  return ((degrees % 360) + 360) % 360;
}

function parsePercentage(token: string): number | null {
  const value = token.trim();
  if (!value.endsWith("%")) return null;
  const parsed = parseNumberToken(value.slice(0, -1));
  return parsed == null ? null : clamp(parsed / 100, 0, 1);
}

/** Parses the colour forms accepted consistently by both native renderers. */
export function parseChartColor(color: string): ParsedChartColor | null {
  if (typeof color !== "string") return null;
  const normalized = color.trim().toLowerCase();
  if (!normalized) return null;
  const source = NAMED_COLORS[normalized] ?? normalized;

  const hex = source.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hex) {
    const raw = hex[1]!;
    const expanded = raw.length <= 4
      ? raw.split("").map((digit) => digit + digit).join("")
      : raw;
    return {
      r: Number.parseInt(expanded.slice(0, 2), 16),
      g: Number.parseInt(expanded.slice(2, 4), 16),
      b: Number.parseInt(expanded.slice(4, 6), 16),
      a: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
    };
  }

  const rgb = source.match(/^rgba?\((.*)\)$/i);
  if (rgb) {
    const parts = splitFunctionalChannels(rgb[1]!);
    if (!parts) return null;
    const channels = parts.channels.map(parseRgbChannel);
    const alpha = parseAlpha(parts.alpha);
    if (channels.some((channel) => channel == null) || alpha == null) return null;
    return { r: channels[0]!, g: channels[1]!, b: channels[2]!, a: alpha };
  }

  const hsl = source.match(/^hsla?\((.*)\)$/i);
  if (hsl) {
    const parts = splitFunctionalChannels(hsl[1]!);
    if (!parts) return null;
    const hue = parseHue(parts.channels[0]!);
    const saturation = parsePercentage(parts.channels[1]!);
    const lightness = parsePercentage(parts.channels[2]!);
    const alpha = parseAlpha(parts.alpha);
    if (hue == null || saturation == null || lightness == null || alpha == null) return null;

    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const sector = hue / 60;
    const second = chroma * (1 - Math.abs(sector % 2 - 1));
    const [r1, g1, b1] = sector < 1 ? [chroma, second, 0]
      : sector < 2 ? [second, chroma, 0]
        : sector < 3 ? [0, chroma, second]
          : sector < 4 ? [0, second, chroma]
            : sector < 5 ? [second, 0, chroma]
              : [chroma, 0, second];
    const offset = lightness - chroma / 2;
    return { r: (r1 + offset) * 255, g: (g1 + offset) * 255, b: (b1 + offset) * 255, a: alpha };
  }
  return null;
}

function alphaString(value: number): string {
  return String(Number(clamp(value, 0, 1).toFixed(4)));
}

/** Serialises a parsed colour without discarding its alpha channel. */
export function formatChartColor(color: ParsedChartColor): string {
  const r = Math.round(clamp(color.r, 0, 255));
  const g = Math.round(clamp(color.g, 0, 255));
  const b = Math.round(clamp(color.b, 0, 255));
  const alpha = clamp(color.a, 0, 1);
  return alpha >= 1 - 1e-6
    ? `rgb(${r},${g},${b})`
    : `rgba(${r},${g},${b},${alphaString(alpha)})`;
}

/** Multiplies a colour's own alpha instead of replacing it. */
export function chartColorWithOpacity(color: string, opacity: number): string {
  const parsed = parseChartColor(color);
  const multiplier = clamp(Number.isFinite(opacity) ? opacity : 1, 0, 1);
  if (!parsed) return multiplier <= 0 ? "transparent" : color;
  return formatChartColor({ ...parsed, a: parsed.a * multiplier });
}

function composite(foreground: ParsedChartColor, background: ParsedChartColor): ParsedChartColor {
  const alpha = foreground.a + background.a * (1 - foreground.a);
  if (alpha <= 1e-9) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
    g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
    b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
    a: alpha,
  };
}

const WHITE: ParsedChartColor = Object.freeze({ r: 255, g: 255, b: 255, a: 1 });

function opaqueSurface(color: ParsedChartColor): ParsedChartColor {
  return color.a >= 1 ? color : composite(color, WHITE);
}

function luminance(color: ParsedChartColor): number {
  const linear = ([color.r, color.g, color.b] as const).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrastRatio(a: ParsedChartColor, b: ParsedChartColor): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function isLightChartColor(color: string): boolean {
  const parsed = parseChartColor(color);
  // 0.179 is the WCAG crossover where black becomes more contrasting than white.
  return parsed != null && luminance(opaqueSurface(parsed)) > 0.179;
}

/** Picks the highest-contrast theme token for labels painted over an arbitrary fill. */
export function readableTextColor(background: string, theme: DashboardTheme): string {
  const themeBackground = parseChartColor(theme.background);
  const fallbackSurface = themeBackground ? opaqueSurface(themeBackground) : WHITE;
  const parsedBackground = parseChartColor(background);
  if (!parsedBackground) return theme.text;
  const surface = parsedBackground.a < 1
    ? opaqueSurface(composite(parsedBackground, fallbackSurface))
    : parsedBackground;
  const candidates = Array.from(new Set([
    theme.text,
    theme.chipFg,
    theme.lastChipFg,
    "#ffffff",
    "#000000",
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0)));
  let best = candidates[0] ?? "#000000";
  let bestRatio = 0;
  for (const candidate of candidates) {
    const parsed = parseChartColor(candidate);
    if (!parsed) continue;
    const foreground = parsed.a < 1 ? composite(parsed, surface) : parsed;
    const ratio = contrastRatio(surface, foreground);
    if (ratio > bestRatio) {
      best = candidate;
      bestRatio = ratio;
    }
  }
  return best;
}

export function chartPalette(theme: DashboardTheme): readonly string[] {
  return isLightChartColor(theme.background) ? LIGHT_CHART_PALETTE : CHART_PALETTE;
}

const THEME_KEYS = Object.freeze([
  "background", "text", "muted", "grid", "axis", "crosshair", "font", "accent", "down", "gold", "sky",
  "heatZero", "chipBg", "chipFg", "lastChipFg",
] as const satisfies readonly (keyof DashboardTheme)[]);

export function resolveChartTheme(input?: ChartThemeInput): DashboardTheme {
  if (input == null || input === "dark") return { ...DARK_CHART_THEME };
  if (input === "light") return { ...LIGHT_CHART_THEME };
  const requestedBackground = typeof input.background === "string" && input.background.trim()
    ? input.background
    : null;
  const base = requestedBackground && isLightChartColor(requestedBackground)
    ? LIGHT_CHART_THEME
    : DARK_CHART_THEME;
  const resolved: DashboardTheme = { ...base };
  for (const key of THEME_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) resolved[key] = value;
  }
  return resolved;
}

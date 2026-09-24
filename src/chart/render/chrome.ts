// Range chrome for Cartesian mounts: the preset button group and the
// navigator strip with its sparkline.

import { t } from "../../i18n";
import { asNumber } from "../compile/shared";
import type { ChartViewport, CompiledChart } from "../compile/types";
import { chartColorWithOpacity, parseChartColor, type DashboardTheme, type ParsedChartColor } from "../theme";
import {
  RANGE_PRESETS,
  clampXWindow,
  isQuantitativeViewportX,
  presetZoomsIn,
  quantitativeRange,
  viewportFromPreset,
  type RangePreset,
} from "../viewport";
import type { MountRuntime } from "./types";
import { axisSpan, fitPresetWindow, type AxisWindowLimits } from "./zoom";

export interface RangeChrome {
  /** Show or hide the preset bar and navigator for the scene family. */
  prepare(polar: boolean, heatmap: boolean): void;
  /** Reflect the live viewport in preset visibility, pressed state, and theme. */
  syncPresets(theme: DashboardTheme): void;
  /** Redraw the navigator sparkline from the full-data scene. */
  paintNavigator(compiled: CompiledChart, fullScene: CompiledChart | null): void;
  /** Wire preset/navigator pointer handling; returns the detach function. */
  attach(): () => void;
}

function relativeLuminance(color: ParsedChartColor, surface: ParsedChartColor): number {
  // Composite translucent colours over the surface before measuring.
  const alpha = color.a;
  const channel = (value: number, base: number): number => {
    const mixed = (value * alpha + base * (1 - alpha)) / 255;
    return mixed <= 0.04045 ? mixed / 12.92 : Math.pow((mixed + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(color.r, surface.r) + 0.7152 * channel(color.g, surface.g) + 0.0722 * channel(color.b, surface.b);
}

/** WCAG contrast ratio of `color` against `background` (both theme colour strings). */
export function colorContrast(color: string, background: string): number {
  const bg = parseChartColor(background) ?? { r: 255, g: 255, b: 255, a: 1 };
  const surface = { ...bg, a: 1 };
  const fg = parseChartColor(color);
  if (!fg) return 1;
  const a = relativeLuminance(fg, surface);
  const b = relativeLuminance(surface, surface);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Minimum contrast of the active-preset indicator against the pane (WCAG 1.4.11). */
export const PRESET_INDICATOR_CONTRAST = 3;

/**
 * Colour that marks the active range preset: the theme accent when it reaches
 * 3:1 against the pane, otherwise the text colour (which always does).
 */
export function presetIndicatorColor(theme: DashboardTheme): string {
  return colorContrast(theme.accent, theme.background) >= PRESET_INDICATOR_CONTRAST ? theme.accent : theme.text;
}

/** Current X domain of a linear scene. */
export function linearExtent(scene: CompiledChart | null): [number, number] | null {
  if (scene?.xScale.kind !== "linear") return null;
  return [asNumber(scene.xScale.domain[0]), asNumber(scene.xScale.domain[1])];
}

/** The window a preset selects: its range fitted to the zoom limits when they exist. */
export function presetViewport(preset: RangePreset, extent: readonly [number, number], limits: AxisWindowLimits | null): ChartViewport {
  const viewport = viewportFromPreset(preset, extent);
  if (!limits || !viewport.x || !isQuantitativeViewportX(viewport.x)) return viewport;
  return { x: fitPresetWindow(quantitativeRange(viewport.x), limits) };
}

/**
 * Whether a preset is offered: ALL always is; others must narrow the extent
 * and fit within [minSpan, maxSpan], so a preset never selects a window that
 * zooming could not reach.
 */
export function presetOffered(preset: RangePreset, extent: readonly [number, number], limits: AxisWindowLimits | null): boolean {
  if (preset === "ALL") return true;
  if (!presetZoomsIn(preset, extent)) return false;
  const viewport = viewportFromPreset(preset, extent);
  if (!limits || !viewport.x || !isQuantitativeViewportX(viewport.x)) return true;
  const span = axisSpan(quantitativeRange(viewport.x), limits);
  return span >= limits.space.minSpan * (1 - 1e-9) && span <= limits.space.maxSpan * (1 + 1e-9);
}

export function createRangeChrome(rt: MountRuntime): RangeChrome {
  const { state } = rt;
  const { presetsBar, nav } = rt.dom;

  /** Full-data X extent, falling back to the current linear scene. */
  const resolvedExtent = (): [number, number] | null => (
    state.fullXExtent ?? linearExtent(state.scene)
  );

  const syncPresets = (theme: DashboardTheme): void => {
    if (!presetsBar.childElementCount) return;
    const indicator = presetIndicatorColor(theme);
    const extent = resolvedExtent();
    const limits = rt.windowLimits();
    const vp = state.viewport?.x;
    for (const btn of presetsBar.querySelectorAll("button")) {
      const preset = btn.textContent as RangePreset;
      if (!RANGE_PRESETS.includes(preset)) continue;
      btn.hidden = extent != null && !presetOffered(preset, extent, limits);
      let on = preset === "ALL" && !vp;
      if (vp && vp.length === 2 && extent && Number.isFinite(asNumber(vp[0]))) {
        const want = presetViewport(preset, extent, limits);
        if (want.x && want.x.length === 2) {
          const span = Math.max(Math.abs(extent[1] - extent[0]), 1);
          on = Math.abs(asNumber(vp[0]) - asNumber(want.x[0])) / span < 0.02
            && Math.abs(asNumber(vp[1]) - asNumber(want.x[1])) / span < 0.02;
        }
      }
      btn.setAttribute("aria-pressed", String(on));
      btn.style.fontWeight = on ? "600" : "400";
      btn.style.color = on ? theme.text : theme.muted;
      btn.style.background = on ? chartColorWithOpacity(indicator, 0.16) : "transparent";
      btn.style.boxShadow = on ? `inset 0 -2px 0 ${indicator}` : "none";
      btn.style.outlineColor = indicator;
    }
  };

  const ensurePresetButtons = (): void => {
    if (presetsBar.childElementCount) return;
    presetsBar.setAttribute("role", "group");
    presetsBar.setAttribute("aria-label", t("chart.rangePresets.label", "Visible time range"));
    for (const preset of RANGE_PRESETS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = preset;
      btn.setAttribute("aria-label", t("chart.rangePresets.preset", "Range {preset}", { preset }));
      // A fixed box keeps the bar height independent of the font that arrives with the theme.
      btn.style.cssText = "box-sizing:border-box;height:20px;border:0;background:transparent;color:inherit;font:inherit;font-size:11px;line-height:16px;padding:2px 6px;border-radius:3px 3px 0 0;cursor:pointer;touch-action:manipulation;";
      btn.dataset.preset = preset;
      presetsBar.appendChild(btn);
    }
  };

  const prepare = (polar: boolean, heatmap: boolean): void => {
    const interact = rt.flags();
    const cartesian = !polar && !heatmap;
    if (interact.rangePresets && cartesian) ensurePresetButtons();
    presetsBar.style.display = interact.rangePresets && cartesian ? "flex" : "none";
    nav.style.display = interact.navigator && cartesian ? "block" : "none";
  };

  const onNavPointerDown = (ev: PointerEvent): void => {
    ev.stopPropagation();
    const extent = resolvedExtent();
    if (!extent) return;
    const box = nav.getBoundingClientRect();
    const t = (ev.clientX - box.left) / Math.max(1, box.width);
    // The sparkline is drawn on the axis, so the click maps in axis space (log10 on log axes).
    const limits = rt.windowLimits();
    const to = limits ? limits.transform.to : (value: number): number => value;
    const from = limits ? limits.transform.from : to;
    const lo = to(extent[0]);
    const hi = to(extent[1]);
    const mid = lo + t * (hi - lo);
    const viewport = state.viewport;
    const span = (viewport?.x && viewport.x.length === 2)
      ? Math.abs(to(asNumber(viewport.x[1])) - to(asNumber(viewport.x[0])))
      : (hi - lo) * 0.25;
    let centred: [number, number] = [mid - span / 2, mid + span / 2];
    if (limits) centred = clampXWindow(centred, limits.space);
    rt.emitViewport({ x: [from(centred[0]), from(centred[1])] });
  };

  const paintNavigator = (compiled: CompiledChart, fullScene: CompiledChart | null): void => {
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
    if (!sctx) return;
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
  };

  const stopChromePointer = (ev: Event): void => {
    ev.stopPropagation();
  };

  /** One delegated listener serves every preset button, so detach releases them all. */
  const onPresetClick = (ev: MouseEvent): void => {
    const button = (ev.target as Element | null)?.closest?.("button[data-preset]");
    const preset = button?.getAttribute("data-preset") as RangePreset | null | undefined;
    if (!preset || !RANGE_PRESETS.includes(preset)) return;
    ev.stopPropagation();
    const extent = resolvedExtent();
    if (!extent) return;
    rt.emitViewport(presetViewport(preset, extent, rt.windowLimits()));
  };

  const attach = (): (() => void) => {
    presetsBar.addEventListener("pointerdown", stopChromePointer);
    presetsBar.addEventListener("pointerup", stopChromePointer);
    presetsBar.addEventListener("wheel", stopChromePointer);
    presetsBar.addEventListener("click", onPresetClick);
    nav.addEventListener("pointerdown", onNavPointerDown);
    nav.addEventListener("pointerup", stopChromePointer);
    nav.addEventListener("wheel", stopChromePointer);
    return () => {
      presetsBar.removeEventListener("pointerdown", stopChromePointer);
      presetsBar.removeEventListener("pointerup", stopChromePointer);
      presetsBar.removeEventListener("wheel", stopChromePointer);
      presetsBar.removeEventListener("click", onPresetClick);
      nav.removeEventListener("pointerdown", onNavPointerDown);
      nav.removeEventListener("pointerup", stopChromePointer);
      nav.removeEventListener("wheel", stopChromePointer);
    };
  };

  return { prepare, syncPresets, paintNavigator, attach };
}

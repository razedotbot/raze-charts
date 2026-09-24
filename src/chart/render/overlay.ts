// Mounted-chart DOM skeleton and the HTML hover overlay: crosshair hairlines,
// axis chips, focus dot, heat-cell outline, slice emphasis, tooltip, and the
// keyboard-reachable legend toggles. Every position is mapped through the
// stage frame (./frame), so the overlay stays on the scene when the preset
// bar, the navigator, or CSS scaling change the wrap around it.

import { t } from "../../i18n";
import type { CompiledChart } from "../compile/types";
import { chartColorWithOpacity, readableTextColor, type DashboardTheme } from "../theme";
import { crosshairCategoryLabel, crosshairValueLabel } from "./chips";
import { clientToScene, cssX, cssY, type StageFrame } from "./frame";
import { layoutLegend } from "./legend";
import { pointerEventFor, resolvePointer, type PointerTarget } from "./pointer";
import { tooltipText } from "./hit";
import type { ChartPointerEvent, MountDom, MountRuntime } from "./types";

/** Height of a crosshair axis chip (15px line box + 1px padding). */
const AXIS_CHIP_HEIGHT = 17;

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

/** Build the mount's DOM and attach it to `el`. */
export function createMountDom(el: HTMLElement): MountDom {
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "position:relative;width:100%;height:100%;overflow:hidden;display:flex;flex-direction:column;user-select:none;-webkit-user-select:none;";
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
  const legend = document.createElement("div");
  legend.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;z-index:6;";
  legend.hidden = true;
  wrap.append(stage, hairV, hairH, chipY, chipX, cell, dot, tip, a11y, legend);
  const presetsBar = document.createElement("div");
  presetsBar.style.cssText = "display:none;gap:4px;padding:4px 8px 0;flex-wrap:wrap;align-items:center;flex:0 0 auto;position:relative;z-index:6;touch-action:manipulation;";
  const nav = document.createElement("div");
  nav.style.cssText = "display:none;position:relative;height:40px;margin:0 8px 6px;cursor:crosshair;flex:0 0 auto;z-index:6;";
  const brushRect = document.createElement("div");
  brushRect.style.cssText = "display:none;position:absolute;pointer-events:none;z-index:5;";
  wrap.append(presetsBar, nav, brushRect);
  el.appendChild(wrap);
  return { wrap, stage, hairV, hairH, chipY, chipX, cell, dot, tip, a11y, legend, presetsBar, nav, brushRect };
}

/** Restyle the wrapper and overlay elements for the scene theme. */
export function applyOverlayTheme(rt: MountRuntime, theme: DashboardTheme): void {
  const { wrap, hairV, hairH, chipY, chipX, tip, dot, cell, brushRect } = rt.dom;
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
  brushRect.style.background = chartColorWithOpacity(theme.accent, 0.12);
  brushRect.style.border = `1px solid ${chartColorWithOpacity(theme.accent, 0.7)}`;
  wrap.style.touchAction = rt.state.options.interaction === false ? "" : "none";
}

export function hideOverlay(dom: MountDom): void {
  dom.hairV.style.display = "none";
  dom.hairH.style.display = "none";
  dom.chipY.style.display = "none";
  dom.chipX.style.display = "none";
  dom.tip.style.display = "none";
  dom.dot.style.display = "none";
  dom.cell.style.display = "none";
  dom.stage.querySelectorAll("[data-role='slice']").forEach((el) => {
    (el as SVGElement).style.opacity = "1";
  });
}

function updateCrosshair(dom: MountDom, compiled: CompiledChart, target: PointerTarget, frame: StageFrame): void {
  const { hairV, hairH, chipY, chipX } = dom;
  const { plot } = compiled;
  const { isBar, isHeat, isPoint, scanX, scanY } = target;
  const scale = frame.scale;
  const plotLeft = cssX(frame, plot.x);
  const plotRight = cssX(frame, plot.x + plot.w);
  const plotTop = cssY(frame, plot.y);
  const plotBottom = cssY(frame, plot.y + plot.h);

  hairV.style.display = "block";
  hairV.style.left = `${Math.round(cssX(frame, scanX))}px`;
  hairV.style.top = `${plotTop}px`;
  hairV.style.height = `${plot.h * scale}px`;

  if (isHeat || isPoint || isBar) {
    hairH.style.display = "block";
    hairH.style.top = `${Math.round(cssY(frame, scanY))}px`;
    hairH.style.left = `${plotLeft}px`;
    hairH.style.width = `${plot.w * scale}px`;
  } else {
    hairH.style.display = "none";
  }

  const valueLabel = crosshairValueLabel(compiled, target);
  chipY.textContent = valueLabel;
  chipY.style.display = valueLabel ? "block" : "none";
  chipY.style.left = compiled.heatmap
    ? `${Math.max(frame.left + 2, cssX(frame, plot.x - 42))}px`
    : `${plotRight + 3}px`;
  chipY.style.top = `${Math.max(plotTop, Math.min(plotBottom - AXIS_CHIP_HEIGHT + 1, cssY(frame, scanY) - 8))}px`;

  const categoryLabel = crosshairCategoryLabel(compiled, target);
  chipX.textContent = categoryLabel;
  chipX.style.display = categoryLabel ? "block" : "none";
  const cw = Math.max(36, categoryLabel.length * 6.6 + 14);
  const centre = cssX(frame, scanX);
  chipX.style.left = `${Math.max(plotLeft, Math.min(plotRight - cw, centre - cw / 2))}px`;
  chipX.style.top = `${plotBottom + 2}px`;
}

export interface HoverController {
  /** Pointer-move handler: records the pointer and drives the overlay. */
  move(ev: PointerEvent): void;
  /**
   * Re-run hover at the retained pointer after a repaint; hides the overlay
   * when there is none. onTooltip runs only when the target or its values
   * changed, and never from a repaint that onTooltip itself started.
   */
  refresh(): void;
  /** Forget the retained pointer and hide the overlay (pointer left the mount). */
  leave(): void;
}

/** Values of a payload that the host can observe; identities are left out on purpose. */
function payloadSignature(event: ChartPointerEvent, text: string): string {
  return [event.series, event.seriesId, event.markIndex, event.index, typeof event.x, String(event.x), event.y, text].join("\u0000");
}

/** Hover overlay and onTooltip for one mount. */
export function createHoverController(rt: MountRuntime): HoverController {
  const { dom, state } = rt;
  const { stage, hairV, hairH, chipY, chipX, tip, dot, cell } = dom;
  /** Signature of the last payload onTooltip received; "" after null or before any. */
  let reported = "";
  /** True while onTooltip runs. A repaint it starts updates the overlay without calling back. */
  let notifying = false;

  /**
   * Report to onTooltip. Pointer moves always report; repaints (`changesOnly`)
   * report only a changed target, so a host that repaints from onTooltip, or
   * rebuilds equal rows on every render, cannot loop.
   */
  const notify = (event: ChartPointerEvent | null, signature: string, changesOnly: boolean): void => {
    if (notifying || (changesOnly && signature === reported)) return;
    reported = signature;
    const handler = state.options.onTooltip;
    if (!handler) return;
    notifying = true;
    try {
      handler(event);
    } finally {
      notifying = false;
    }
  };

  const clear = (): void => {
    rt.hideOverlay();
    notify(null, "", true);
  };

  const show = (clientX: number, clientY: number, changesOnly: boolean): void => {
    const compiled = state.scene;
    const frame = rt.frame();
    if (!compiled?.tooltip || !frame || state.dragging) {
      clear();
      return;
    }
    const { x, y } = clientToScene(frame, clientX, clientY);
    const { plot, theme } = compiled;
    const inPlot = compiled.polar
      ? x >= 0 && y >= 0 && x <= compiled.width && y <= compiled.height
      : x >= plot.x && x <= plot.x + plot.w && y >= plot.y && y <= plot.y + plot.h;
    if (!inPlot) {
      clear();
      return;
    }

    const resolved = resolvePointer(compiled, x, y);
    const { hit, sample, accentNode } = resolved;
    if (!compiled.polar) {
      updateCrosshair(dom, compiled, resolved, frame);
    } else {
      hairV.style.display = "none";
      hairH.style.display = "none";
      chipY.style.display = "none";
      chipX.style.display = "none";
    }

    if (hit?.role === "heat" && hit.w && hit.h) {
      cell.style.display = "block";
      cell.style.left = `${cssX(frame, hit.x ?? 0)}px`;
      cell.style.top = `${cssY(frame, hit.y ?? 0)}px`;
      cell.style.width = `${hit.w * frame.scale}px`;
      cell.style.height = `${hit.h * frame.scale}px`;
    } else {
      cell.style.display = "none";
    }

    const slices = stage.querySelectorAll("[data-role='slice']");
    slices.forEach((el) => {
      const match = hit?.role !== "slice" || (el as SVGElement).getAttribute("data-idx") === String(hit.idx);
      (el as SVGElement).style.opacity = match ? "1" : "0.28";
    });

    if (sample && (sample.kind === "line" || sample.kind === "point" || sample.kind === "radar")) {
      dot.style.display = "block";
      dot.style.left = `${cssX(frame, sample.x)}px`;
      dot.style.top = `${cssY(frame, sample.y)}px`;
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
      notify(null, "", changesOnly);
      return;
    }
    tip.textContent = text;
    tip.style.display = "block";
    const pointerX = clientX - frame.clientLeft + frame.left;
    const pointerY = clientY - frame.clientTop + frame.top;
    const { bounds } = frame;
    const tw = Math.min(220, Math.max(72, text.split("\n").reduce((a, l) => Math.max(a, l.length), 0) * 6.6 + 22));
    const th = text.split("\n").length * 15 + 14;
    let left = pointerX + 12;
    let top = pointerY + 12;
    if (left + tw > bounds.left + bounds.width - 6) left = pointerX - tw - 10;
    if (top + th > bounds.top + bounds.height - 6) top = pointerY - th - 8;
    tip.style.left = `${Math.max(bounds.left + 4, left)}px`;
    tip.style.top = `${Math.max(bounds.top + 4, top)}px`;
    tip.style.background = theme.chipBg;
    tip.style.boxShadow = `inset 2px 0 0 ${accent}, 0 0 0 1px ${theme.axis}`;
    // Last, so a repaint started by onTooltip leaves its own overlay in place.
    const event = pointerEventFor(resolved);
    notify(event, payloadSignature(event, text), changesOnly);
  };

  return {
    move(ev) {
      state.pointer = { clientX: ev.clientX, clientY: ev.clientY };
      if (rt.isChromeEvent(ev)) {
        clear();
        return;
      }
      show(ev.clientX, ev.clientY, false);
    },
    refresh() {
      const pointer = state.pointer;
      if (!pointer || state.dragging) {
        rt.hideOverlay();
        return;
      }
      show(pointer.clientX, pointer.clientY, true);
    },
    leave() {
      state.pointer = null;
      clear();
    },
  };
}

/**
 * Keep one transparent toggle button over each legend entry. They make the
 * legend reachable by keyboard and screen readers on both renderers, carry
 * the pointer cursor only where a click does something, and expose the
 * series state through aria-pressed.
 */
export function syncLegendToggles(rt: MountRuntime): void {
  const { legend } = rt.dom;
  const scene = rt.state.scene;
  const frame = rt.frame();
  const layout = scene ? layoutLegend(scene) : null;
  if (!scene || !frame || !layout?.toggleable || !layout.entries.length) {
    legend.replaceChildren();
    legend.hidden = true;
    return;
  }
  legend.hidden = false;
  legend.setAttribute("role", "group");
  legend.setAttribute("aria-label", t("chart.legend.toggles", "Series"));
  // Buttons are matched by series key so focus stays on the series it was on.
  const existing = Array.from(legend.children) as HTMLButtonElement[];
  const byKey = new Map(existing.map((button) => [button.dataset.series, button]));
  const focusedIndex = existing.findIndex((button) => button === document.activeElement);
  const accent = scene.theme.accent;
  const buttons = layout.entries.map((entry) => {
    let button = byKey.get(entry.key);
    byKey.delete(entry.key);
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.dataset.series = entry.key;
    }
    button.style.cssText = [
      "position:absolute",
      `left:${cssX(frame, entry.box.x)}px`,
      `top:${cssY(frame, entry.box.y)}px`,
      `width:${entry.box.w * frame.scale}px`,
      `height:${entry.box.h * frame.scale}px`,
      "margin:0",
      "padding:0",
      "border:0",
      "border-radius:3px",
      "background:transparent",
      "cursor:pointer",
      "touch-action:manipulation",
      `outline-color:${accent}`,
    ].join(";");
    button.setAttribute("aria-label", entry.name);
    button.setAttribute("aria-pressed", String(!entry.hidden));
    return button;
  });
  // Only stale buttons leave the DOM, so a retained focused button keeps focus.
  for (const stale of byKey.values()) stale.remove();
  buttons.forEach((button, index) => {
    if (legend.children[index] !== button) legend.insertBefore(button, legend.children[index] ?? null);
  });
  // When the focused entry left the legend, keep keyboard users in the group.
  if (focusedIndex >= 0 && !buttons.includes(existing[focusedIndex]!)) {
    buttons[Math.min(focusedIndex, buttons.length - 1)]?.focus();
  }
}

// Mounted-chart DOM skeleton and the HTML hover overlay: crosshair hairlines,
// axis chips, focus dot, heat-cell outline, slice emphasis, and tooltip.

import type { CompiledChart } from "../compile/types";
import { readableTextColor, type DashboardTheme } from "../theme";
import { crosshairCategoryLabel, crosshairValueLabel, type CrosshairTarget } from "./chips";
import { hitTestCompiled, nearestSample, nearestSpatial, sampleIndexFor, tooltipText } from "./hit";
import type { MountDom, MountRuntime } from "./types";

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
  wrap.append(stage, hairV, hairH, chipY, chipX, cell, dot, tip, a11y);
  const presetsBar = document.createElement("div");
  presetsBar.style.cssText = "display:none;gap:4px;padding:4px 8px 0;flex-wrap:wrap;align-items:center;flex:0 0 auto;position:relative;z-index:6;touch-action:manipulation;";
  const nav = document.createElement("div");
  nav.style.cssText = "display:none;position:relative;height:40px;margin:0 8px 6px;cursor:crosshair;flex:0 0 auto;z-index:6;";
  const brushRect = document.createElement("div");
  brushRect.style.cssText = "display:none;position:absolute;pointer-events:none;z-index:5;background:rgba(102,216,158,0.12);border:1px solid rgba(102,216,158,0.7);";
  wrap.append(presetsBar, nav, brushRect);
  el.appendChild(wrap);
  return { wrap, stage, hairV, hairH, chipY, chipX, cell, dot, tip, a11y, presetsBar, nav, brushRect };
}

/** Restyle the wrapper and overlay elements for the scene theme. */
export function applyOverlayTheme(rt: MountRuntime, theme: DashboardTheme): void {
  const { wrap, hairV, hairH, chipY, chipX, tip, dot, cell } = rt.dom;
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

function updateCrosshair(dom: MountDom, compiled: CompiledChart, target: CrosshairTarget, scaleX: number, scaleY: number): void {
  const { hairV, hairH, chipY, chipX } = dom;
  const { plot } = compiled;
  const { isBar, isPoint, scanX, scanY } = target;
  const isHeat = target.hit?.role === "heat";

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

  chipY.textContent = crosshairValueLabel(compiled, target);
  chipY.style.display = "block";
  chipY.style.left = compiled.heatmap
    ? `${Math.max(2, (plot.x - 42) * scaleX)}px`
    : `${(plot.x + plot.w) * scaleX + 3}px`;
  const cssPlotTop = plot.y * scaleY;
  const cssPlotBottom = (plot.y + plot.h) * scaleY;
  const cssScanY = scanY * scaleY;
  chipY.style.top = `${Math.max(cssPlotTop, Math.min(cssPlotBottom - 16, cssScanY - 8))}px`;

  chipX.textContent = crosshairCategoryLabel(compiled, target);
  chipX.style.display = "block";
  const cw = Math.max(36, (chipX.textContent?.length ?? 0) * 6.6 + 14);
  const cssPlotLeft = plot.x * scaleX;
  const cssPlotRight = (plot.x + plot.w) * scaleX;
  const cssScanX = scanX * scaleX;
  chipX.style.left = `${Math.max(cssPlotLeft, Math.min(cssPlotRight - cw, cssScanX - cw / 2))}px`;
  chipX.style.top = `${cssPlotBottom + 2}px`;
}

/** Pointer-move handler that drives the hover overlay and onTooltip. */
export function createHoverHandler(rt: MountRuntime): (ev: PointerEvent) => void {
  const { dom, state } = rt;
  const { wrap, stage, hairV, hairH, chipY, chipX, tip, dot, cell } = dom;
  return (ev: PointerEvent): void => {
    if (rt.isChromeEvent(ev)) {
      rt.hideOverlay();
      return;
    }
    const compiled = state.scene;
    if (!compiled?.tooltip) {
      rt.hideOverlay();
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
      rt.hideOverlay();
      return;
    }
    if (compiled.polar && !inPlot) {
      rt.hideOverlay();
      return;
    }

    let sample = nearestSample(compiled, x, y);
    const hit = hitTestCompiled(compiled, x, y);
    if (hit?.role === "point" && hit.type === "circle") {
      sample = nearestSpatial(
        sampleIndexFor(compiled),
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
      updateCrosshair(dom, compiled, { hit, sample, isBar, isLine, isPoint, scanX, scanY, y }, scaleX, scaleY);
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
      state.options.onTooltip?.(null);
      return;
    }
    tip.textContent = text;
    tip.style.display = "block";
    state.options.onTooltip?.({
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
}

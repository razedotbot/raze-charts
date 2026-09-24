// Mount gestures: legend toggles, click-to-select, wheel zoom, drag pan with
// a live SVG preview, and Shift-drag brush selection.

import type { ChartViewport, CompiledChart } from "../compile/types";
import { hitTestCompiled, nearestSample } from "./hit";
import type { MountRuntime } from "./types";

type PanDrag = {
  kind: "pan";
  startX: number;
  startY: number;
  from: number;
  to: number;
  y?: [number, number];
  moved: boolean;
  viewportBeforeDrag: ChartViewport | null;
};

const panActivationDistance = 4;

/**
 * Wire pointer, wheel, and selection handling onto the mount wrapper.
 * Returns a detach function that also cancels a pending pan repaint.
 */
export function attachGestures(rt: MountRuntime, onHover: (ev: PointerEvent) => void): () => void {
  const { state, dom } = rt;
  const { wrap, stage, brushRect } = dom;
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
    pan: PanDrag,
    cssX: number,
    box: DOMRect,
  ): { viewport: ChartViewport; userDx: number } => {
    const scaleX = (box.width || compiled.width) / compiled.width;
    const userDx = (cssX - pan.startX) / scaleX;
    const delta = -(userDx / (compiled.plot.w || 1)) * (pan.to - pan.from);
    const viewport: ChartViewport = { x: [pan.from + delta, pan.to + delta] };
    if (pan.y) viewport.y = pan.y;
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
      if (state.destroyed || drag?.kind !== "pan") return;
      if ((state.options.renderer ?? "svg") !== "canvas") return;
      rt.paint();
      if (drag?.kind !== "pan" || state.scene?.xScale.kind !== "linear") return;
      drag.startX = lastPanCssX;
      drag.from = state.scene.xScale.domain[0];
      drag.to = state.scene.xScale.domain[1];
      applyPanPreview(0);
    };
    if (typeof requestAnimationFrame === "function") panRaf = requestAnimationFrame(tick);
    else tick();
  };

  const onWheel = (ev: WheelEvent): void => {
    if (rt.isChromeEvent(ev)) return;
    const compiled = state.scene;
    const interact = rt.flags();
    if (!interact.zoom || !compiled || compiled.polar || compiled.heatmap || compiled.xScale.kind !== "linear") return;
    ev.preventDefault();
    const box = wrap.getBoundingClientRect();
    const domain = compiled.xScale.domain;
    const [lo, hi] = domain[0] <= domain[1] ? domain : [domain[1], domain[0]];
    const factor = ev.deltaY > 0 ? 1.12 : 0.88;
    const anchor = plotXToDomain(compiled, ev.clientX - box.left, box) ?? (lo + hi) / 2;
    const nextLo = anchor - (anchor - lo) * factor;
    const nextHi = anchor + (hi - anchor) * factor;
    rt.emitViewport({ x: [nextLo, nextHi] });
  };

  const onPointerDown = (ev: PointerEvent): void => {
    if (rt.isChromeEvent(ev)) return;
    const compiled = state.scene;
    const interact = rt.flags();
    if (!compiled || compiled.polar || compiled.heatmap) return;
    const target = ev.target as Element | null;
    const series = target?.closest?.("[data-series]")?.getAttribute("data-series");
    if (series) {
      if (state.hidden.has(series)) state.hidden.delete(series);
      else state.hidden.add(series);
      rt.paint();
      return;
    }
    const box = wrap.getBoundingClientRect();
    const cssX = ev.clientX - box.left;
    const cssY = ev.clientY - box.top;
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
        startY: cssY,
        from,
        to,
        y: compiled.yScale.kind === "linear"
          ? [compiled.yScale.domain[0], compiled.yScale.domain[1]]
          : undefined,
        moved: false,
        viewportBeforeDrag: state.viewport,
      };
      lastPanCssX = cssX;
      ev.preventDefault();
      window.getSelection?.()?.removeAllRanges();
      capturePointer(ev);
    }
  };

  const onPointerDrag = (ev: PointerEvent): void => {
    if (!drag) return;
    ev.preventDefault();
    const compiled = state.scene;
    if (!compiled) return;
    const box = wrap.getBoundingClientRect();
    const cssX = ev.clientX - box.left;
    const cssY = ev.clientY - box.top;
    if (drag.kind === "brush") {
      const left = Math.min(drag.startX, cssX);
      brushRect.style.left = `${left}px`;
      brushRect.style.top = `${compiled.plot.y}px`;
      brushRect.style.width = `${Math.abs(cssX - drag.startX)}px`;
      brushRect.style.height = `${compiled.plot.h}px`;
      brushRect.style.display = "block";
      return;
    }
    if (!drag.moved) {
      if (Math.hypot(cssX - drag.startX, cssY - drag.startY) < panActivationDistance) return;
      drag.moved = true;
      rt.hideOverlay();
      wrap.style.cursor = "grabbing";
    }
    lastPanCssX = cssX;
    const { viewport, userDx } = panShift(compiled, drag, cssX, box);
    state.viewport = viewport;
    applyPanPreview(userDx);
    schedulePanCommit();
  };

  const onPointerUp = (ev: PointerEvent): void => {
    if (!drag && rt.isChromeEvent(ev)) return;
    const compiled = state.scene;
    const box = wrap.getBoundingClientRect();
    const cssX = ev.clientX - box.left;
    cancelPanRaf();
    wrap.style.cursor = "";
    if (drag?.kind === "brush" && compiled && compiled.xScale.kind === "linear") {
      const a = plotXToDomain(compiled, drag.startX, box);
      const b = plotXToDomain(compiled, cssX, box);
      brushRect.style.display = "none";
      if (a != null && b != null && Math.abs(a - b) > 0) {
        rt.emitViewport({ x: a < b ? [a, b] : [b, a] });
      }
    } else if (drag?.kind === "pan" && drag.moved && compiled && compiled.xScale.kind === "linear") {
      const { viewport } = panShift(compiled, drag, cssX, box);
      applyPanPreview(0);
      rt.emitViewport({ x: viewport.x });
    } else if ((!drag || (drag.kind === "pan" && !drag.moved)) && compiled) {
      const scaleX = (box.width || compiled.width) / compiled.width;
      const scaleY = (box.height || compiled.height) / compiled.height;
      const x = (ev.clientX - box.left) / scaleX;
      const y = (ev.clientY - box.top) / scaleY;
      const sample = nearestSample(compiled, x, y);
      const node = hitTestCompiled(compiled, x, y);
      state.options.onSelect?.({
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

  const onPointerCancel = (): void => {
    const cancelled = drag;
    drag = null;
    cancelPanRaf();
    wrap.style.cursor = "";
    brushRect.style.display = "none";
    applyPanPreview(0);
    if (cancelled?.kind === "pan" && cancelled.moved) {
      state.viewport = cancelled.viewportBeforeDrag;
      if ((state.options.renderer ?? "svg") === "canvas") rt.paint();
    }
  };

  const onSelectStart = (ev: Event): void => {
    if (rt.isChromeEvent(ev)) return;
    ev.preventDefault();
  };

  const onPointerMoveAll = (ev: PointerEvent): void => {
    onPointerDrag(ev);
    if (!drag) onHover(ev);
  };

  wrap.addEventListener("pointermove", onPointerMoveAll);
  wrap.addEventListener("pointerleave", rt.hideOverlay);
  wrap.addEventListener("pointerdown", onPointerDown);
  wrap.addEventListener("pointerup", onPointerUp);
  wrap.addEventListener("pointercancel", onPointerCancel);
  wrap.addEventListener("selectstart", onSelectStart);
  wrap.addEventListener("wheel", onWheel, { passive: false });
  return () => {
    cancelPanRaf();
    wrap.removeEventListener("pointermove", onPointerMoveAll);
    wrap.removeEventListener("pointerleave", rt.hideOverlay);
    wrap.removeEventListener("pointerdown", onPointerDown);
    wrap.removeEventListener("pointerup", onPointerUp);
    wrap.removeEventListener("pointercancel", onPointerCancel);
    wrap.removeEventListener("selectstart", onSelectStart);
    wrap.removeEventListener("wheel", onWheel);
  };
}

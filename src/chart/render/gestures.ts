// Mount gestures: legend toggles, click-to-select, wheel zoom and horizontal
// wheel pan (coalesced to one paint per frame), drag pan with a live SVG
// preview, and Shift-drag brush selection. Zoom, pan, and brush windows obey
// the mount's zoom limits and data bounds.

import type { ChartViewport, CompiledChart } from "../compile/types";
import type { LinearScale } from "../scales";
import { isQuantitativeViewportX, quantitativeRange } from "../viewport";
import { clientToScene } from "./frame";
import { layoutLegend, legendEntryAt } from "./legend";
import { pointerEventFor, resolvePointer } from "./pointer";
import type { HoverController } from "./overlay";
import type { MountRuntime } from "./types";
import { axisTransform, clampWindow, panWindow, zoomWindow, type AxisWindowLimits } from "./zoom";

type PanDrag = {
  kind: "pan";
  /** Client-space pointer at the start of the current preview segment. */
  startClientX: number;
  startClientY: number;
  from: number;
  to: number;
  y?: [number, number];
  moved: boolean;
  viewportBeforeDrag: ChartViewport | null;
};

type BrushDrag = { kind: "brush"; startClientX: number };

const panActivationDistance = 4;
/** Zoom per wheel pixel: a classic 100px notch zooms by 1.12x. */
const ZOOM_PER_PIXEL = Math.log(1.12) / 100;
/** Bounds on one wheel event's zoom factor, so a huge delta cannot jump. */
const MAX_EVENT_FACTOR = 2;
const LINE_PIXELS = 16;

export interface GestureController {
  /** Remove every listener and cancel pending frames. */
  detach(): void;
  /** Paint a pending wheel window now (before a gesture reads the scene). */
  flushWheel(): void;
  /** Drop a pending wheel window (an external viewport took over). */
  cancelWheel(): void;
}

/** Wheel delta in CSS pixels, whatever the event's delta mode. */
function wheelPixels(delta: number, mode: number, pagePixels: number): number {
  if (mode === 1) return delta * LINE_PIXELS;
  if (mode === 2) return delta * pagePixels;
  return delta;
}

/** Zoom factor for one wheel event (>1 zooms out); in and out are exact inverses. */
export function wheelZoomFactor(deltaPixels: number): number {
  const factor = Math.exp(deltaPixels * ZOOM_PER_PIXEL);
  return Math.min(MAX_EVENT_FACTOR, Math.max(1 / MAX_EVENT_FACTOR, factor));
}

/** Current X window of a linear scene. */
function sceneWindow(scene: CompiledChart): [number, number] {
  const domain = (scene.xScale as LinearScale).domain;
  return domain[0] <= domain[1] ? [domain[0], domain[1]] : [domain[1], domain[0]];
}

/**
 * Wire pointer, wheel, and selection handling onto the mount wrapper.
 * Returns the controller whose detach also cancels pending repaints.
 */
export function attachGestures(rt: MountRuntime, hover: HoverController): GestureController {
  const { state, dom } = rt;
  const { wrap, stage, brushRect, legend } = dom;
  let drag: null | PanDrag | BrushDrag = null;
  let panRaf = 0;
  let lastPanClientX = 0;
  let wheelRaf = 0;
  let pendingWheel: [number, number] | null = null;
  /** The current press toggled a legend entry, so its release selects nothing. */
  let legendPress = false;

  const setDrag = (next: typeof drag): void => {
    drag = next;
    state.dragging = next !== null;
  };

  const capturePointer = (ev: PointerEvent): void => {
    try { wrap.setPointerCapture(ev.pointerId); } catch { /* jsdom / detached */ }
  };

  const schedule = (callback: () => void): number => {
    if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback);
    callback();
    return 0;
  };

  const cancelFrame = (id: number): void => {
    if (id && typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
  };

  /** Shift `range` by a fraction of its width in the axis' linear space, within the limits when known. */
  const shiftWindow = (scene: CompiledChart, range: [number, number], fraction: number, limits: AxisWindowLimits | null): [number, number] => {
    if (limits) return panWindow(range, fraction, limits);
    const transform = axisTransform(scene.xScale as LinearScale);
    const t0 = transform.to(range[0]);
    const t1 = transform.to(range[1]);
    const delta = fraction * (t1 - t0);
    return [transform.from(t0 + delta), transform.from(t1 + delta)];
  };

  const applyPanPreview = (userDx: number): void => {
    const svg = stage.querySelector("svg");
    if (!svg) return;
    const t = userDx ? `translate(${userDx})` : "";
    for (const selector of ["[data-role='plot']", "[data-role='x-labels']"]) {
      const layer = svg.querySelector(selector);
      if (!layer) continue;
      if (t) layer.setAttribute("transform", t);
      else layer.removeAttribute("transform");
    }
  };

  /** Pan window for the pointer at `clientX`, and the scene-space preview offset it implies. */
  const panShift = (compiled: CompiledChart, pan: PanDrag, clientX: number): { viewport: ChartViewport; userDx: number } => {
    const frame = rt.frame();
    const scale = frame?.scale ?? 1;
    const requestedDx = (clientX - pan.startClientX) / scale;
    const plotW = compiled.plot.w || 1;
    const range = shiftWindow(compiled, [pan.from, pan.to], -requestedDx / plotW, rt.windowLimits());
    const transform = axisTransform(compiled.xScale as LinearScale);
    const span = transform.to(pan.to) - transform.to(pan.from) || 1;
    const userDx = -((transform.to(range[0]) - transform.to(pan.from)) / span) * plotW;
    const viewport: ChartViewport = { x: range };
    if (pan.y) viewport.y = pan.y;
    return { viewport, userDx };
  };

  const cancelPanRaf = (): void => {
    cancelFrame(panRaf);
    panRaf = 0;
  };

  const schedulePanCommit = (): void => {
    if (panRaf) return;
    panRaf = schedule(() => {
      panRaf = 0;
      if (state.destroyed || drag?.kind !== "pan") return;
      if ((state.options.renderer ?? "svg") !== "canvas") return;
      rt.paint();
      if (drag?.kind !== "pan" || state.scene?.xScale.kind !== "linear") return;
      drag.startClientX = lastPanClientX;
      [drag.from, drag.to] = sceneWindow(state.scene);
      applyPanPreview(0);
    });
  };

  const cancelWheel = (): void => {
    cancelFrame(wheelRaf);
    wheelRaf = 0;
    pendingWheel = null;
  };

  const flushWheel = (): void => {
    const next = pendingWheel;
    cancelWheel();
    if (!next || state.destroyed) return;
    rt.emitViewport({ x: next });
  };

  /** Window the next wheel event builds on: the pending one, else the painted one. */
  const wheelBase = (scene: CompiledChart): [number, number] => {
    if (pendingWheel) return pendingWheel;
    const x = state.viewport?.x;
    return x && isQuantitativeViewportX(x) ? quantitativeRange(x) : sceneWindow(scene);
  };

  const onWheel = (ev: WheelEvent): void => {
    if (rt.isChromeEvent(ev)) return;
    const compiled = state.scene;
    const interact = rt.flags();
    if (!compiled || compiled.polar || compiled.heatmap || compiled.xScale.kind !== "linear") return;
    const frame = rt.frame();
    const limits = rt.windowLimits();
    if (!frame || !limits) return;
    const pagePixels = compiled.plot.w * frame.scale;
    const dx = wheelPixels(ev.deltaX, ev.deltaMode, pagePixels);
    const dy = wheelPixels(ev.deltaY, ev.deltaMode, pagePixels);
    const horizontal = Math.abs(dx) > Math.abs(dy);
    // Horizontal swipes pan when panning is on; otherwise the page keeps them.
    if (horizontal ? !interact.pan : !interact.zoom || dy === 0) return;
    ev.preventDefault();
    const base = wheelBase(compiled);
    if (horizontal) {
      pendingWheel = shiftWindow(compiled, base, dx / Math.max(1, pagePixels), limits);
    } else {
      const { x } = clientToScene(frame, ev.clientX, ev.clientY);
      const transform = axisTransform(compiled.xScale as LinearScale);
      const fraction = Math.min(1, Math.max(0, (x - compiled.plot.x) / (compiled.plot.w || 1)));
      const t0 = transform.to(base[0]);
      const anchor = transform.from(t0 + fraction * (transform.to(base[1]) - t0));
      pendingWheel = zoomWindow(base, anchor, wheelZoomFactor(dy), limits);
    }
    if (!wheelRaf) {
      wheelRaf = schedule(() => {
        wheelRaf = 0;
        flushWheel();
      });
    }
  };

  /**
   * Key of the painted legend entry under a pointer event: the SVG row it
   * targets, else the row box at its coordinates (Canvas, or an SVG gap).
   * This is the legend's only pointer hit-test; the toggle buttons over the
   * entries serve keyboard and assistive technology and take no pointer events.
   */
  const legendKeyAt = (ev: MouseEvent, compiled: CompiledChart): string | null => {
    const target = ev.target as Element | null;
    const marked = target?.closest?.("[data-series]");
    if (marked && stage.contains(marked)) {
      const key = marked.getAttribute("data-series");
      if (key && layoutLegend(compiled).toggleable) return key;
    }
    const frame = rt.frame();
    if (!frame) return null;
    const { x, y } = clientToScene(frame, ev.clientX, ev.clientY);
    return legendEntryAt(compiled, x, y)?.key ?? null;
  };

  /** Show the pointer cursor over a painted legend entry (the static markup carries none). */
  const syncLegendCursor = (ev: MouseEvent | null): void => {
    const compiled = state.scene;
    const over = !!ev && !!compiled && !rt.isChromeEvent(ev) && legendKeyAt(ev, compiled) !== null;
    const cursor = over ? "pointer" : "";
    if (stage.style.cursor !== cursor) stage.style.cursor = cursor;
  };

  const onPointerDown = (ev: PointerEvent): void => {
    legendPress = false;
    if (rt.isChromeEvent(ev)) return;
    flushWheel();
    const compiled = state.scene;
    const interact = rt.flags();
    if (!compiled) return;
    const legendKey = legendKeyAt(ev, compiled);
    if (legendKey !== null) {
      legendPress = true;
      rt.toggleSeries(legendKey);
      return;
    }
    if (compiled.polar || compiled.heatmap) return;
    const frame = rt.frame();
    if (!frame) return;
    if (ev.shiftKey && interact.brush && compiled.xScale.kind === "linear") {
      setDrag({ kind: "brush", startClientX: ev.clientX });
      rt.hideOverlay();
      ev.preventDefault();
      window.getSelection?.()?.removeAllRanges();
      capturePointer(ev);
      return;
    }
    if (interact.pan && compiled.xScale.kind === "linear") {
      const [from, to] = sceneWindow(compiled);
      setDrag({
        kind: "pan",
        startClientX: ev.clientX,
        startClientY: ev.clientY,
        from,
        to,
        y: compiled.yScale.kind === "linear"
          ? [compiled.yScale.domain[0], compiled.yScale.domain[1]]
          : undefined,
        moved: false,
        viewportBeforeDrag: state.viewport,
      });
      lastPanClientX = ev.clientX;
      ev.preventDefault();
      window.getSelection?.()?.removeAllRanges();
      capturePointer(ev);
    }
  };

  /** Brush x range in scene space, clamped to the plot. */
  const brushSpan = (compiled: CompiledChart, brush: BrushDrag, clientX: number): [number, number] | null => {
    const frame = rt.frame();
    if (!frame) return null;
    const { plot } = compiled;
    const clampX = (value: number): number => Math.max(plot.x, Math.min(plot.x + plot.w, value));
    const a = clampX(clientToScene(frame, brush.startClientX, 0).x);
    const b = clampX(clientToScene(frame, clientX, 0).x);
    return a <= b ? [a, b] : [b, a];
  };

  const onPointerDrag = (ev: PointerEvent): void => {
    if (!drag) return;
    ev.preventDefault();
    const compiled = state.scene;
    if (!compiled) return;
    if (drag.kind === "brush") {
      const frame = rt.frame();
      const span = brushSpan(compiled, drag, ev.clientX);
      if (!frame || !span) return;
      brushRect.style.left = `${frame.left + span[0] * frame.scale}px`;
      brushRect.style.top = `${frame.top + compiled.plot.y * frame.scale}px`;
      brushRect.style.width = `${(span[1] - span[0]) * frame.scale}px`;
      brushRect.style.height = `${compiled.plot.h * frame.scale}px`;
      brushRect.style.display = "block";
      return;
    }
    if (!drag.moved) {
      if (Math.hypot(ev.clientX - drag.startClientX, ev.clientY - drag.startClientY) < panActivationDistance) return;
      drag.moved = true;
      rt.hideOverlay();
      wrap.style.cursor = "grabbing";
    }
    lastPanClientX = ev.clientX;
    const { viewport, userDx } = panShift(compiled, drag, ev.clientX);
    state.viewport = viewport;
    applyPanPreview(userDx);
    schedulePanCommit();
  };

  const onPointerUp = (ev: PointerEvent): void => {
    const pressedLegend = legendPress;
    legendPress = false;
    if (!drag && rt.isChromeEvent(ev)) return;
    // The press toggled a series; its release is not also a data selection.
    if (pressedLegend && !drag) return;
    const compiled = state.scene;
    const finished = drag;
    setDrag(null);
    cancelPanRaf();
    wrap.style.cursor = "";
    brushRect.style.display = "none";
    if (finished?.kind === "brush" && compiled && compiled.xScale.kind === "linear") {
      const span = brushSpan(compiled, finished, ev.clientX);
      const scale = compiled.xScale;
      if (span && span[1] - span[0] > 0) {
        const limits = rt.windowLimits();
        const range: [number, number] = [scale.invert(span[0]), scale.invert(span[1])];
        rt.emitViewport({ x: limits ? clampWindow(range, limits) : range });
      }
    } else if (finished?.kind === "pan" && finished.moved && compiled && compiled.xScale.kind === "linear") {
      const { viewport } = panShift(compiled, finished, ev.clientX);
      applyPanPreview(0);
      rt.emitViewport({ x: viewport.x });
    } else if ((!finished || (finished.kind === "pan" && !finished.moved)) && compiled) {
      const frame = rt.frame();
      if (!frame) return;
      const { x, y } = clientToScene(frame, ev.clientX, ev.clientY);
      state.options.onSelect?.(pointerEventFor(resolvePointer(compiled, x, y)));
    }
  };

  const onPointerCancel = (): void => {
    legendPress = false;
    const cancelled = drag;
    setDrag(null);
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
    if (drag) {
      state.pointer = { clientX: ev.clientX, clientY: ev.clientY };
      onPointerDrag(ev);
      return;
    }
    syncLegendCursor(ev);
    hover.move(ev);
  };

  const onPointerLeave = (): void => {
    syncLegendCursor(null);
    hover.leave();
  };

  /** Enter or Space on a toggle button (they take no pointer events, see legendKeyAt). */
  const onLegendClick = (ev: MouseEvent): void => {
    const button = (ev.target as Element | null)?.closest?.("button[data-series]");
    const key = button?.getAttribute("data-series");
    if (!key) return;
    ev.stopPropagation();
    rt.toggleSeries(key);
  };

  wrap.addEventListener("pointermove", onPointerMoveAll);
  wrap.addEventListener("pointerleave", onPointerLeave);
  wrap.addEventListener("pointerdown", onPointerDown);
  wrap.addEventListener("pointerup", onPointerUp);
  wrap.addEventListener("pointercancel", onPointerCancel);
  wrap.addEventListener("selectstart", onSelectStart);
  wrap.addEventListener("wheel", onWheel, { passive: false });
  legend.addEventListener("click", onLegendClick);
  return {
    detach() {
      cancelPanRaf();
      cancelWheel();
      setDrag(null);
      wrap.removeEventListener("pointermove", onPointerMoveAll);
      wrap.removeEventListener("pointerleave", onPointerLeave);
      wrap.removeEventListener("pointerdown", onPointerDown);
      wrap.removeEventListener("pointerup", onPointerUp);
      wrap.removeEventListener("pointercancel", onPointerCancel);
      wrap.removeEventListener("selectstart", onSelectStart);
      wrap.removeEventListener("wheel", onWheel);
      legend.removeEventListener("click", onLegendClick);
    },
    flushWheel,
    cancelWheel,
  };
}

// mountChart(): browser lifecycle for a native chart. Owns state, compile and
// paint, resize, listener wiring, and the returned handle. Hover, range chrome,
// and gestures are composed from ./overlay, ./chrome, and ./gestures.
//
// Repaints are cheap to request and expensive to run, so high-frequency
// sources are coalesced: wheel zoom and resize paint at most once per frame,
// and the full-data scene behind the navigator and the zoom limits is cached
// per definition and size instead of being recompiled on every viewport change.

import { compileChart } from "../compile/chart";
import type { ChartDefinition, ChartSpec, ChartViewport, CompiledChart } from "../compile/types";
import type { XWindowLimits } from "../viewport";
import { paintChartCanvas } from "./canvas";
import { createRangeChrome, linearExtent } from "./chrome";
import { stageFrame, type StageFrame } from "./frame";
import { attachGestures, type GestureController } from "./gestures";
import {
  applyOverlayTheme,
  createHoverController,
  createMountDom,
  hideOverlay as hideOverlayDom,
  syncLegendToggles,
} from "./overlay";
import { nextRenderSequence, safeId, svgFromCompiled } from "./svg";
import type { MountChartOptions, MountHandle, MountRuntime, MountState, ResolvedInteraction } from "./types";
import { estimateDataStep, resolveInteraction, resolveWindowLimits } from "./zoom";

/** Accessible text for the Canvas renderer: description, series, and up to 50 tooltips. */
function canvasSummary(compiled: CompiledChart): string[] {
  return [
    compiled.ariaDescription,
    compiled.legend.length
      ? `Series: ${compiled.legend.map((item) => item.name).join(", ")}.`
      : "",
    ...Array.from(new Set(compiled.nodes.map((node) => node.tip).filter((tip): tip is string => !!tip))).slice(0, 50),
  ].filter(Boolean);
}

function sameViewport(a: ChartViewport | null | undefined, b: ChartViewport | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const sameList = (x?: readonly unknown[], y?: readonly unknown[]): boolean => (
    x === y || (!!x && !!y && x.length === y.length && x.every((value, i) => Object.is(
      value instanceof Date ? value.getTime() : value,
      y[i] instanceof Date ? (y[i] as Date).getTime() : y[i],
    )))
  );
  return sameList(a.x, b.x) && sameList(a.y, b.y);
}

/** A compiled definition together with the spec it produced. */
interface CapturedScene {
  scene: CompiledChart;
  spec: ChartSpec | null;
}

function compileCapturing(definition: ChartDefinition, size: { width: number; height: number }): CapturedScene {
  let spec: ChartSpec | null = null;
  const scene = compileChart({
    spec: (input) => {
      spec = definition.spec(input);
      return spec;
    },
  }, size);
  return { scene, spec };
}

export function mountChart(
  el: HTMLElement,
  definition: ChartDefinition,
  opts?: MountChartOptions,
): MountHandle {
  const state: MountState = {
    options: { ...opts },
    definition,
    scene: null,
    viewport: opts?.viewport ?? null,
    hidden: new Set(opts?.hiddenSeries ?? []),
    fullXExtent: null,
    fullSpec: null,
    lastInputWidth: Number.NaN,
    lastInputHeight: Number.NaN,
    pointer: null,
    dragging: false,
    destroyed: false,
  };
  const autoId = `mounted-${nextRenderSequence()}`;
  const dom = createMountDom(el);
  const { wrap, stage, a11y, presetsBar, nav, legend } = dom;
  /** Full-data scene keyed by definition and size (navigator sparkline, extent). */
  let fullCache: { definition: ChartDefinition; width: number; height: number; captured: CapturedScene } | null = null;
  let stepCache: { spec: ChartSpec | null; step: number | null } = { spec: null, step: null };
  let resizeRaf = 0;
  /** Stage size the live scene was compiled for (before explicit width/height). */
  let compiledStage = { width: Number.NaN, height: Number.NaN };
  let gestures: GestureController | null = null;
  let detachChrome: (() => void) | null = null;

  const hideOverlay = (): void => hideOverlayDom(dom);

  const inputSize = (): { width: number; height: number } => ({
    width: state.options.width ?? Math.max(1, wrap.clientWidth || el.clientWidth || 640),
    height: state.options.height ?? Math.max(1, wrap.clientHeight || el.clientHeight || 320),
  });

  const flags = (): ResolvedInteraction => resolveInteraction(state.options.interaction);

  const isChromeEvent = (ev: Event): boolean => {
    const node = ev.target as Node | null;
    if (!node || node.nodeType !== 1) return false;
    return presetsBar.contains(node) || nav.contains(node) || legend.contains(node);
  };

  const frame = (): StageFrame | null => (state.scene ? stageFrame(wrap, stage, state.scene) : null);

  const windowLimits = (): XWindowLimits | null => {
    const scene = state.scene;
    if (!scene) return null;
    if (stepCache.spec !== state.fullSpec) stepCache = { spec: state.fullSpec, step: estimateDataStep(state.fullSpec) };
    return resolveWindowLimits(scene, state.fullXExtent, flags(), state.fullSpec, stepCache);
  };

  const emitViewport = (next: ChartViewport): void => {
    state.viewport = next;
    state.options.onViewportChange?.(next);
    paint();
  };

  const toggleSeries = (key: string): void => {
    if (state.hidden.has(key)) state.hidden.delete(key);
    else state.hidden.add(key);
    paint();
  };

  const rt: MountRuntime = {
    state, dom, flags, isChromeEvent, frame, windowLimits, paint, emitViewport, toggleSeries, hideOverlay,
  };
  const chrome = createRangeChrome(rt);
  const hover = createHoverController(rt);

  /** Full-data scene for the current definition at `size`, compiled once per definition and size. */
  function fullSceneFor(current: ChartDefinition, size: { width: number; height: number }): CapturedScene {
    if (fullCache && fullCache.definition === current && fullCache.width === size.width && fullCache.height === size.height) {
      return fullCache.captured;
    }
    const captured = compileCapturing(current, size);
    fullCache = { definition: current, width: size.width, height: size.height, captured };
    return captured;
  }

  function paint(): void {
    if (state.destroyed) throw new Error("[@razedotbot/charts] Cannot paint a destroyed chart mount.");
    const renderer = state.options.renderer ?? "svg";
    const idPrefix = safeId(state.options.idPrefix ?? autoId);
    const interact = flags();
    chrome.prepare(state.scene?.polar ?? false, state.scene?.heatmap ?? false);
    const wrapSize = inputSize();
    let w = wrapSize.width;
    let h = wrapSize.height;
    if (state.options.width == null) w = Math.max(1, stage.clientWidth || w);
    if (state.options.height == null) h = Math.max(1, stage.clientHeight || h);
    const stageSize = { width: w, height: h };
    const current = state.definition;
    const hidden = state.hidden.size ? Array.from(state.hidden) : state.options.hiddenSeries;
    const viewport = state.viewport ?? state.options.viewport;
    const overlayed = Boolean(viewport) || Boolean(hidden?.length);
    let compiled: CompiledChart;
    let fullScene: CompiledChart | null = null;
    let fullSpec: ChartSpec | null = state.fullSpec;
    if (overlayed) {
      compiled = compileChart({
        spec: (size) => ({
          ...current.spec(size),
          ...(viewport ? { viewport } : {}),
          ...(hidden?.length ? { hiddenSeries: hidden } : {}),
        }),
      }, { width: w, height: h });
    } else {
      const captured = compileCapturing(current, { width: w, height: h });
      compiled = captured.scene;
      fullScene = compiled;
      fullSpec = captured.spec;
    }
    if (compiled.polar || compiled.heatmap) {
      chrome.prepare(true, true);
    }
    const showNav = Boolean(interact.navigator && !compiled.polar && !compiled.heatmap);
    if (overlayed && (!state.fullXExtent || showNav)) {
      const full = fullSceneFor(current, {
        width: Math.max(32, showNav ? nav.clientWidth || w : 64),
        height: Math.max(24, showNav ? nav.clientHeight || 40 : 32),
      });
      fullScene = full.scene;
      fullSpec = full.spec;
    }
    const source = fullScene ?? compiled;
    if (source.xScale.kind === "linear" && (!state.fullXExtent || !overlayed)) {
      state.fullXExtent = linearExtent(source);
    }
    state.fullSpec = fullSpec;
    chrome.syncPresets(compiled.theme);
    if (showNav && compiled.xScale.kind === "linear") chrome.paintNavigator(compiled, fullScene);
    if (renderer === "canvas") {
      let canvas = stage.querySelector("canvas");
      if (!canvas) {
        canvas = document.createElement("canvas");
        // contain letterboxes like the SVG viewBox, so both renderers share one stage frame.
        canvas.style.cssText = "width:100%;height:100%;display:block;object-fit:contain;user-select:none;-webkit-user-select:none";
        stage.replaceChildren(canvas);
      }
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const backingW = Math.floor(compiled.width * dpr);
      const backingH = Math.floor(compiled.height * dpr);
      if (canvas.width !== backingW || canvas.height !== backingH) {
        canvas.width = backingW;
        canvas.height = backingH;
      }
      const summaryParts = canvasSummary(compiled);
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", compiled.ariaLabel);
      if (summaryParts.length) canvas.setAttribute("aria-describedby", `raze-summary-${idPrefix}`);
      else canvas.removeAttribute("aria-describedby");
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        paintChartCanvas(ctx, compiled);
      }
      applyOverlayTheme(rt, compiled.theme);
      a11y.id = `raze-summary-${idPrefix}`;
      a11y.textContent = summaryParts.join(" ");
      a11y.hidden = false;
    } else {
      const markup = svgFromCompiled(compiled, { idPrefix });
      applyOverlayTheme(rt, compiled.theme);
      a11y.hidden = true;
      a11y.textContent = "";
      stage.innerHTML = markup;
    }
    state.scene = compiled;
    state.lastInputWidth = wrapSize.width;
    state.lastInputHeight = wrapSize.height;
    compiledStage = stageSize;
    syncLegendToggles(rt);
    // A tooltip under a stationary pointer survives streaming updates, resizes,
    // and viewport changes: hover re-runs at the retained pointer position.
    hover.refresh();
  }

  const onResizeFrame = (): void => {
    resizeRaf = 0;
    if (state.destroyed) return;
    const next = inputSize();
    // The stage can change inside a same-size wrap (preset bar or navigator reflow).
    const stageWidth = state.options.width ?? Math.max(1, stage.clientWidth || next.width);
    const stageHeight = state.options.height ?? Math.max(1, stage.clientHeight || next.height);
    const resized = next.width !== state.lastInputWidth || next.height !== state.lastInputHeight
      || stageWidth !== compiledStage.width || stageHeight !== compiledStage.height;
    if (resized) paint();
    else syncLegendToggles(rt);
  };

  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => {
    if (resizeRaf) return;
    if (typeof requestAnimationFrame === "function") resizeRaf = requestAnimationFrame(onResizeFrame);
    else onResizeFrame();
  }) : null;

  const cancelResize = (): void => {
    if (resizeRaf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(resizeRaf);
    resizeRaf = 0;
  };

  const teardown = (): void => {
    gestures?.detach();
    gestures = null;
    detachChrome?.();
    detachChrome = null;
    cancelResize();
    ro?.disconnect();
    state.pointer = null;
    wrap.remove();
  };
  try {
    paint();
    gestures = attachGestures(rt, hover);
    detachChrome = chrome.attach();
    ro?.observe(wrap);
    ro?.observe(stage);
  } catch (error) {
    teardown();
    throw error;
  }
  return {
    update(next, nextOptions) {
      if (state.destroyed) throw new Error("[@razedotbot/charts] Cannot update a destroyed chart mount.");
      const previous = state.definition;
      const previousOptions = state.options;
      const previousScene = state.scene;
      const previousViewport = state.viewport;
      const previousHiddenSeries = state.hidden;
      const previousFullXExtent = state.fullXExtent;
      const previousFullSpec = state.fullSpec;
      const definitionChanged = next !== state.definition;
      state.definition = next;
      if (definitionChanged) state.fullXExtent = null;
      if (nextOptions) {
        state.options = { ...state.options, ...nextOptions };
        if (Object.prototype.hasOwnProperty.call(nextOptions, "viewport")) {
          const requested = nextOptions.viewport ?? null;
          // An echo of the live window (controlled mode) keeps a pending wheel zoom.
          if (!sameViewport(requested, state.viewport)) gestures?.cancelWheel();
          state.viewport = requested;
        }
        if (nextOptions.hiddenSeries) state.hidden = new Set(nextOptions.hiddenSeries);
      }
      try {
        paint();
      } catch (error) {
        state.definition = previous;
        state.options = previousOptions;
        state.scene = previousScene;
        state.viewport = previousViewport;
        state.hidden = previousHiddenSeries;
        state.fullXExtent = previousFullXExtent;
        state.fullSpec = previousFullSpec;
        // The failed paint may have re-laid the chrome for the rejected options.
        chrome.prepare(previousScene?.polar ?? false, previousScene?.heatmap ?? false);
        throw error;
      }
    },
    getScene() { return state.destroyed ? null : state.scene; },
    setViewport(viewport) {
      if (state.destroyed) throw new Error("[@razedotbot/charts] Cannot set the viewport of a destroyed chart mount.");
      if (!sameViewport(viewport, state.viewport)) gestures?.cancelWheel();
      state.viewport = viewport;
      paint();
    },
    getViewport() {
      return state.viewport;
    },
    destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      teardown();
      state.scene = null;
      fullCache = null;
    },
  };
}

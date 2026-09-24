// mountChart(): browser lifecycle for a native chart. Owns state, compile and
// paint, resize, listener wiring, and the returned handle. Hover, range chrome,
// and gestures are composed from ./overlay, ./chrome, and ./gestures.

import { compileChart } from "../compile/chart";
import { defineChart } from "../compile/define";
import type { ChartDefinition, ChartViewport, CompiledChart } from "../compile/types";
import { paintChartCanvas } from "./canvas";
import { createRangeChrome, linearExtent } from "./chrome";
import { attachGestures } from "./gestures";
import { applyOverlayTheme, createHoverHandler, createMountDom, hideOverlay as hideOverlayDom } from "./overlay";
import { nextRenderSequence, safeId, svgFromCompiled } from "./svg";
import type { MountChartOptions, MountHandle, MountInteraction, MountRuntime, MountState } from "./types";

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
    lastInputWidth: Number.NaN,
    lastInputHeight: Number.NaN,
    destroyed: false,
  };
  const autoId = `mounted-${nextRenderSequence()}`;
  const dom = createMountDom(el);
  const { wrap, stage, a11y, presetsBar, nav } = dom;

  const hideOverlay = (): void => hideOverlayDom(dom);

  const inputSize = (): { width: number; height: number } => ({
    width: state.options.width ?? Math.max(1, wrap.clientWidth || el.clientWidth || 640),
    height: state.options.height ?? Math.max(1, wrap.clientHeight || el.clientHeight || 320),
  });

  const flags = (): MountInteraction => {
    const raw = state.options.interaction;
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

  const emitViewport = (next: ChartViewport): void => {
    state.viewport = next;
    state.options.onViewportChange?.(next);
    paint();
  };

  const rt: MountRuntime = { state, dom, flags, isChromeEvent, paint, emitViewport, hideOverlay };
  const chrome = createRangeChrome(rt);
  let detach: (() => void)[] = [];

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
    const current = state.definition;
    const hidden = state.hidden.size ? Array.from(state.hidden) : state.options.hiddenSeries;
    const viewport = state.viewport ?? state.options.viewport;
    const overlayed = Boolean(viewport) || Boolean(hidden?.length);
    const compiled = overlayed
      ? compileChart(defineChart((size) => ({
          ...current.spec(size),
          ...(viewport ? { viewport } : {}),
          ...(hidden?.length ? { hiddenSeries: hidden } : {}),
        })), { width: w, height: h })
      : compileChart(current, { width: w, height: h });
    if (compiled.polar || compiled.heatmap) {
      chrome.prepare(true, true);
    }
    const showNav = Boolean(interact.navigator && !compiled.polar && !compiled.heatmap);
    let fullScene: CompiledChart | null = overlayed ? null : compiled;
    if (overlayed && (!state.fullXExtent || showNav)) {
      fullScene = compileChart(current, {
        width: Math.max(32, showNav ? nav.clientWidth || w : 64),
        height: Math.max(24, showNav ? nav.clientHeight || 40 : 32),
      });
    }
    const source = fullScene ?? compiled;
    if (source.xScale.kind === "linear" && (!state.fullXExtent || !overlayed)) {
      state.fullXExtent = linearExtent(source);
    }
    chrome.syncPresets();
    if (showNav && compiled.xScale.kind === "linear") chrome.paintNavigator(compiled, fullScene);
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
    hideOverlay();
  }

  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => {
    const next = inputSize();
    if (next.width === state.lastInputWidth && next.height === state.lastInputHeight) return;
    paint();
  }) : null;
  const teardown = (): void => {
    for (const release of detach) release();
    detach = [];
    ro?.disconnect();
    wrap.remove();
  };
  try {
    paint();
    detach = [attachGestures(rt, createHoverHandler(rt)), chrome.attach()];
    ro?.observe(wrap);
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
      const definitionChanged = next !== state.definition;
      state.definition = next;
      if (definitionChanged) state.fullXExtent = null;
      if (nextOptions) {
        state.options = { ...state.options, ...nextOptions };
        if (Object.prototype.hasOwnProperty.call(nextOptions, "viewport")) {
          state.viewport = nextOptions.viewport ?? null;
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
        throw error;
      }
    },
    getScene() { return state.destroyed ? null : state.scene; },
    setViewport(viewport) {
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
    },
  };
}

// mountChart(): browser lifecycle for a native chart. Owns state, compile and
// paint, resize, listener wiring, and the returned handle. Hover, range chrome,
// and gestures are composed from ./overlay, ./chrome, and ./gestures.
//
// Repaints are cheap to request and expensive to run, so high-frequency
// sources are coalesced: wheel zoom and resize paint at most once per frame,
// and the full-data scene behind the navigator and the zoom limits is cached
// per content and size instead of being recompiled on every viewport change.
// Content is the definition, a revision that update() bumps (rows may have
// been mutated in place), and a fingerprint of the rows the spec returns, so
// appended data is seen even by paints that only move the viewport.

import { compileChart } from "../compile/chart";
import type { ChartDefinition, ChartSpec, ChartViewport, CompiledChart } from "../compile/types";
import { paintChartCanvas } from "./canvas";
import { createRangeChrome, linearExtent } from "./chrome";
import { stageFrame, type StageFrame } from "./frame";
import { attachGestures, type GestureController } from "./gestures";
import { toggledHiddenSeries } from "./legend";
import {
  applyOverlayTheme,
  createHoverController,
  createMountDom,
  hideOverlay as hideOverlayDom,
  syncLegendToggles,
} from "./overlay";
import { nextRenderSequence, safeId, svgFromCompiled } from "./svg";
import type { MountChartOptions, MountHandle, MountRuntime, MountState, ResolvedInteraction } from "./types";
import { estimateDataStep, resolveInteraction, resolveWindowLimits, type AxisTransform, type AxisWindowLimits } from "./zoom";

/** Accessible text for the Canvas renderer: description, every series (hidden ones marked), and up to 50 tooltips. */
function canvasSummary(compiled: CompiledChart): string[] {
  return [
    compiled.ariaDescription,
    compiled.legend.length
      ? `Series: ${compiled.legend.map((item) => (item.hidden ? `${item.name} (hidden)` : item.name)).join(", ")}.`
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

/**
 * What the full-data state was derived from: the definition, the update()
 * revision, and per mark the row count plus the first and last rows.
 */
interface ContentKey {
  definition: ChartDefinition;
  revision: number;
  rows: unknown[];
}

function rowFingerprint(spec: ChartSpec | null): unknown[] {
  const parts: unknown[] = [];
  for (const mark of spec?.marks ?? []) parts.push(mark.data.length, mark.data[0], mark.data[mark.data.length - 1]);
  return parts;
}

function sameContent(a: ContentKey | null, b: ContentKey): boolean {
  return !!a && a.definition === b.definition && a.revision === b.revision
    && a.rows.length === b.rows.length && a.rows.every((part, i) => Object.is(part, b.rows[i]));
}

/** Compile `definition`, letting `extend` add to its spec, and keep the spec as defined. */
function compileCapturing(
  definition: ChartDefinition,
  size: { width: number; height: number },
  extend: (spec: ChartSpec) => ChartSpec = (spec) => spec,
): CapturedScene {
  let spec: ChartSpec | null = null;
  const scene = compileChart({
    spec: (input) => {
      spec = definition.spec(input);
      return extend(spec);
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
    hiddenOwned: opts?.hiddenSeries !== undefined,
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
  /** Bumped by update(); cached full-data state from an older revision is stale. */
  let revision = 0;
  /** Content that state.fullXExtent and state.fullSpec describe. */
  let fullKey: ContentKey | null = null;
  /** Full-data scene keyed by content and size (navigator sparkline, extent). */
  let fullCache: { key: ContentKey; width: number; height: number; captured: CapturedScene } | null = null;
  /** Data spacing for the zoom defaults, per full-data content and axis transform. */
  let stepCache: { key: ContentKey | null; transform: AxisTransform; step: number | null } | null = null;
  let resizeRaf = 0;
  /** Scenes committed by render(); emitViewport uses it to spot a host that already repainted. */
  let commits = 0;
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

  const stepFor = (transform: AxisTransform): number | null => {
    if (stepCache?.key !== fullKey || stepCache.transform !== transform) {
      stepCache = { key: fullKey, transform, step: estimateDataStep(state.fullSpec, transform) };
    }
    return stepCache.step;
  };

  const windowLimits = (): AxisWindowLimits | null => (
    state.scene ? resolveWindowLimits(state.scene, state.fullXExtent, flags(), stepFor) : null
  );

  const emitViewport = (next: ChartViewport): void => {
    state.viewport = next;
    const before = commits;
    state.options.onViewportChange?.(next);
    // A controlled host that echoed the window synchronously through update()
    // (or moved it again with setViewport()) has already painted the latest
    // state; painting again would compile the same window twice. A host may
    // also destroy the mount from the callback.
    if (commits === before && !state.destroyed) paint();
  };

  const toggleSeries = (key: string): void => {
    state.hidden = toggledHiddenSeries(state.scene, state.hidden, key);
    state.hiddenOwned = true;
    paint();
  };

  const rt: MountRuntime = {
    state, dom, flags, isChromeEvent, frame, windowLimits, paint, emitViewport, toggleSeries, hideOverlay,
  };
  const chrome = createRangeChrome(rt);
  const hover = createHoverController(rt);

  /** Full-data scene for `key` at `size`, compiled once per content and size. */
  function fullSceneFor(key: ContentKey, size: { width: number; height: number }): CapturedScene {
    if (fullCache && sameContent(fullCache.key, key) && fullCache.width === size.width && fullCache.height === size.height) {
      return fullCache.captured;
    }
    const captured = compileCapturing(key.definition, size);
    fullCache = { key, width: size.width, height: size.height, captured };
    return captured;
  }

  /** Recompile and repaint, then re-run hover at the retained pointer. */
  function paint(): void {
    render();
    // A tooltip under a stationary pointer survives streaming updates,
    // resizes, and viewport changes: hover re-runs at the retained pointer.
    hover.refresh();
  }

  /** Recompile and repaint the scene and chrome, and commit it to state. */
  function render(): void {
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
    // Once options or a legend click own the hidden set, it replaces
    // spec.hiddenSeries (even when empty, so everything is shown again).
    const hidden = state.hiddenOwned || state.hidden.size ? Array.from(state.hidden) : undefined;
    const viewport = state.viewport ?? state.options.viewport;
    const overlayed = Boolean(viewport) || hidden !== undefined;
    const captured = compileCapturing(current, stageSize, (spec) => (overlayed ? {
      ...spec,
      ...(viewport ? { viewport } : {}),
      ...(hidden ? { hiddenSeries: hidden } : {}),
    } : spec));
    const compiled = captured.scene;
    const key: ContentKey = { definition: current, revision, rows: rowFingerprint(captured.spec) };
    if (compiled.polar || compiled.heatmap) {
      chrome.prepare(true, true);
    }
    const showNav = Boolean(interact.navigator && !compiled.polar && !compiled.heatmap);
    let full: CapturedScene | null = overlayed ? null : captured;
    if (overlayed && (showNav || !sameContent(fullKey, key))) {
      full = fullSceneFor(key, {
        width: Math.max(32, showNav ? nav.clientWidth || w : 64),
        height: Math.max(24, showNav ? nav.clientHeight || 40 : 32),
      });
    }
    if (full && !sameContent(fullKey, key)) {
      state.fullXExtent = linearExtent(full.scene);
      state.fullSpec = full.spec;
      fullKey = key;
    }
    if (showNav && compiled.xScale.kind === "linear") chrome.paintNavigator(compiled, full?.scene ?? null);
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
    commits++;
    // Presets read the zoom limits, which need the committed scene.
    chrome.syncPresets(compiled.theme);
    syncLegendToggles(rt);
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
      const previousHiddenOwned = state.hiddenOwned;
      const previousFullXExtent = state.fullXExtent;
      const previousFullSpec = state.fullSpec;
      const previousRevision = revision;
      const previousFullKey = fullKey;
      state.definition = next;
      let navigation = false;
      if (nextOptions) {
        state.options = { ...state.options, ...nextOptions };
        if (Object.prototype.hasOwnProperty.call(nextOptions, "viewport")) {
          const requested = nextOptions.viewport ?? null;
          navigation = true;
          // A window that moves replaces a pending wheel zoom; an echo of the
          // live window (a controlled host) keeps it.
          if (!sameViewport(requested, state.viewport)) gestures?.cancelWheel();
          state.viewport = requested;
        }
        if (nextOptions.hiddenSeries) {
          state.hidden = new Set(nextOptions.hiddenSeries);
          state.hiddenOwned = true;
        }
      }
      // Rows may have been mutated in place, so the full-data extent and the
      // navigator are recomputed. A call that passes a viewport is navigation:
      // a controlled host moving the window, or echoing the one
      // onViewportChange reported (the React adapter does this on every
      // change). It keeps the full-data scene, and the row fingerprint still
      // catches added or removed rows. A new definition misses the cache anyway.
      if (!navigation) revision++;
      try {
        render();
      } catch (error) {
        state.definition = previous;
        state.options = previousOptions;
        state.scene = previousScene;
        state.viewport = previousViewport;
        state.hidden = previousHiddenSeries;
        state.hiddenOwned = previousHiddenOwned;
        state.fullXExtent = previousFullXExtent;
        state.fullSpec = previousFullSpec;
        revision = previousRevision;
        fullKey = previousFullKey;
        // The failed paint may have re-laid the chrome for the rejected options.
        chrome.prepare(previousScene?.polar ?? false, previousScene?.heatmap ?? false);
        throw error;
      }
      // After the commit, so an onTooltip error cannot split state from the DOM.
      hover.refresh();
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

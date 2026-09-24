// Canvas render engine. Device-pixel-ratio-aware and invalidation driven: one
// requestAnimationFrame is queued only when something actually needs painting.
//
// The frame is split into two stacked canvases (AD-04, see layers.ts): the
// main layer holds the scene and repaints on data or viewport changes; the
// overlay layer holds the crosshair, legend values, hover feedback, the draft
// shape and the countdown, and repaints on pointer and timer events alone.
// A resize repaints synchronously, so no presented frame shows the cleared
// bitmap that assigning canvas.width leaves behind.
//
// Seams installed on the context (W1A-06, see docs/seams.md): requestPaint,
// requestOverlayPaint and the DOM overlay host stacked above the canvases.

import type { ChartContext } from "../core/context";
import { CanvasLayer, createLayerPaintStats, isOpaqueColor, type LayerPaintStats } from "./layers";

/** Size change reported to `ChartEngine.onResize` before the synchronous repaint. */
export interface EngineResize {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly previousWidth: number;
  readonly previousHeight: number;
  readonly previousDpr: number;
}

export class ChartEngine {
  /**
   * The interactive surface: the top (overlay) canvas layer. It receives every
   * pointer and keyboard event, holds focus and carries the chart's accessible
   * name and description. Scene pixels live on `mainCanvas` below it.
   */
  readonly canvas: HTMLCanvasElement;
  /**
   * DOM layer above the canvases for accessible chart-space UI (DOM legend,
   * inline text editor, mark tooltips). It ignores pointer events so the
   * canvas keeps every gesture; interactive children set pointer-events:auto.
   */
  readonly overlayHost: HTMLDivElement;
  readonly accessibilityDescriptionId: string;
  /** Paint counters per layer (benchmarks, tests and devtools read them). */
  readonly paintStats: LayerPaintStats = createLayerPaintStats();
  private readonly mainLayer: CanvasLayer;
  private readonly overlayLayer: CanvasLayer;
  private ro: ResizeObserver | null = null;
  private rafId: number | null = null;
  private mainDirty = false;
  private overlayDirty = false;
  private painting = false;
  private destroyed = false;
  private descriptionEl: HTMLDivElement;
  private statusEl: HTMLDivElement;
  private onWinResize: () => void;
  private readonly previousIsolation: string;
  private readonly requestPaint = (): void => this.markDirty();
  private readonly requestOverlayPaint = (): void => this.markOverlayDirty();
  cssWidth = 0;
  cssHeight = 0;
  dpr = 1;

  /** Paints the main layer (scene). The engine has already filled the pane background. */
  paintHook: ((ctx: CanvasRenderingContext2D) => void) | null = null;
  /**
   * Paints the overlay layer onto a cleared, transparent bitmap. While it is
   * null, overlay invalidations repaint the whole frame through `paintHook`.
   */
  overlayPaintHook: ((ctx: CanvasRenderingContext2D) => void) | null = null;
  /**
   * Consulted on overlay-only frames: return true when state the main layer
   * paints changed without an explicit markDirty(), to repaint it as well.
   */
  mainInvalidationCheck: (() => boolean) | null = null;
  /** Called after the bitmaps are resized and before the synchronous repaint. */
  onResize: ((size: EngineResize) => void) | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly context: ChartContext,
  ) {
    // The overlay bitmap must stay transparent, so its context keeps alpha.
    this.overlayLayer = new CanvasLayer("overlay", "raze-chart-canvas raze-chart-layer raze-chart-layer-overlay", false, true);
    this.canvas = this.overlayLayer.canvas;
    this.canvas.tabIndex = 0;
    host.appendChild(this.canvas);

    this.overlayHost = document.createElement("div");
    this.overlayHost.className = "raze-chart-overlay-host";
    this.overlayHost.style.cssText =
      "position:absolute;inset:0;overflow:hidden;pointer-events:none;";
    host.appendChild(this.overlayHost);

    // The scene bitmap follows in DOM order (the interactive canvas stays the
    // host's first canvas) but paints below it: z-index -1 inside the host,
    // which becomes its own stacking context so the layer never slips behind
    // an ancestor's background.
    this.previousIsolation = host.style.isolation;
    host.style.isolation = "isolate";
    this.mainLayer = new CanvasLayer(
      "main",
      "raze-chart-layer raze-chart-layer-main",
      isOpaqueColor(context.theme?.paneBackground),
      false,
    );
    host.appendChild(this.mainLayer.canvas);

    const accessibilityId = ++chartAccessibilitySequence;
    this.accessibilityDescriptionId = `raze-chart-description-${accessibilityId}`;
    this.descriptionEl = createVisuallyHiddenElement();
    this.descriptionEl.id = this.accessibilityDescriptionId;
    this.descriptionEl.className = "raze-chart-a11y-description";
    host.appendChild(this.descriptionEl);
    this.statusEl = createVisuallyHiddenElement();
    this.statusEl.className = "raze-chart-a11y-status";
    this.statusEl.setAttribute("role", "status");
    this.statusEl.setAttribute("aria-live", "polite");
    this.statusEl.setAttribute("aria-atomic", "true");
    host.appendChild(this.statusEl);
    this.syncAccessibility();

    this.context.requestPaint = this.requestPaint;
    this.context.requestOverlayPaint = this.requestOverlayPaint;
    this.context.overlayHost = this.overlayHost;
    this.onWinResize = () => this.resize();
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(host);
    }
    // AppZoom dispatches window `resize` on zoom change; RO alone can miss it.
    window.addEventListener("resize", this.onWinResize);
    this.resize();
    // Paint once even when the host starts at 0x0. A later ResizeObserver
    // notification schedules the first visible frame without an idle loop.
    this.markDirty();
  }

  /** The main (scene) layer's canvas. Replaced when the pane background changes between opaque and translucent. */
  get mainCanvas(): HTMLCanvasElement {
    return this.mainLayer.canvas;
  }

  /** True while the main layer uses an opaque (`{ alpha: false }`) context. */
  get mainLayerOpaque(): boolean {
    return this.mainLayer.opaque;
  }

  /** Invalidate both layers (data, viewport, scale, style, store changes). */
  markDirty(): void {
    if (this.destroyed) return;
    this.mainDirty = true;
    this.overlayDirty = true;
    this.schedule();
  }

  /**
   * Invalidate only the overlay layer (crosshair, hover, legend values, draft,
   * countdown). The main bitmap is kept unless `mainInvalidationCheck` reports
   * that main-layer state changed too.
   */
  markOverlayDirty(): void {
    if (this.destroyed) return;
    if (!this.overlayPaintHook) {
      this.markDirty();
      return;
    }
    this.overlayDirty = true;
    this.schedule();
  }

  /** Refreshes the accessible name after an imperative symbol change. */
  syncAccessibility(): void {
    const configuredLabel = this.context.options.raze?.aria_label?.trim();
    const configuredDescription = this.context.options.raze?.aria_description?.trim();
    const label = configuredLabel || `${this.context.symbol} financial chart`;
    const overview = configuredDescription || `Interactive price chart for ${this.context.symbol}.`;
    const description = `${overview} ${KEYBOARD_INSTRUCTIONS}`;

    this.canvas.setAttribute("role", "application");
    this.canvas.setAttribute("aria-roledescription", "interactive financial chart");
    this.canvas.setAttribute("aria-label", label);
    this.canvas.setAttribute("aria-describedby", this.accessibilityDescriptionId);
    this.canvas.setAttribute(
      "aria-keyshortcuts",
      "ArrowLeft ArrowRight + - F Escape Delete Backspace",
    );
    // Canvas fallback text remains useful in user agents that cannot expose the
    // bitmap, while aria-describedby gives modern assistive tech full guidance.
    this.canvas.textContent = `${label}. ${description}`;
    this.descriptionEl.textContent = description;
  }

  /** Announces the result of a keyboard interaction without moving focus. */
  announce(message: string): void {
    if (this.destroyed) return;
    // Clearing first makes repeated actions (for example two zoom-ins) announce.
    this.statusEl.textContent = "";
    queueMicrotask(() => {
      if (!this.destroyed) this.statusEl.textContent = message;
    });
  }

  get accessibilityLabel(): string {
    return this.canvas.getAttribute("aria-label") ?? "Financial chart";
  }

  /**
   * A new canvas holding the main layer with the overlay composited on top, at
   * device resolution: the picture exactly as displayed, since no single layer
   * holds all of it (pixel checks, tests). The scene bitmap may carry LCD
   * subpixel text (see layers.ts), so screenshots and exports use
   * ChartRenderer.snapshot(), which repaints into an alpha canvas instead.
   */
  composite(): HTMLCanvasElement {
    const out = document.createElement("canvas");
    out.width = this.mainLayer.canvas.width;
    out.height = this.mainLayer.canvas.height;
    const ctx = out.getContext("2d");
    if (!ctx) throw new Error("[raze-charts] 2D canvas context unavailable");
    ctx.drawImage(this.mainLayer.canvas, 0, 0);
    ctx.drawImage(this.overlayLayer.canvas, 0, 0);
    return out;
  }

  private resize(): void {
    if (this.destroyed) return;
    // Layout box (clientWidth/Height), NOT getBoundingClientRect.
    // Under Shell AppZoom CSS `zoom`, getBoundingClientRect returns the *visual*
    // size (layout × zoom) while the canvas CSS box is the layout size — mixing
    // them desyncs the bitmap from pointer space. clientWidth stays in the same
    // coordinate system we draw in; pointerXY converts mouse via rect ratio.
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.max(0, Math.floor(this.host.clientWidth));
    const h = Math.max(0, Math.floor(this.host.clientHeight));
    if (w === this.cssWidth && h === this.cssHeight && dpr === this.dpr) return;
    const previous = { previousWidth: this.cssWidth, previousHeight: this.cssHeight, previousDpr: this.dpr };
    this.cssWidth = w;
    this.cssHeight = h;
    this.dpr = dpr;
    // Assigning the bitmap size clears it. Repaint before returning so the
    // frame the browser presents next already holds the new picture.
    this.mainLayer.resize(w, h, dpr);
    this.overlayLayer.resize(w, h, dpr);
    this.onResize?.({ width: w, height: h, dpr, ...previous });
    if (this.painting) {
      this.markDirty();
      return;
    }
    this.paintLayers(true);
    this.paintStats.resize += 1;
  }

  private schedule(): void {
    if (this.destroyed || this.painting || this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => this.onAnimationFrame());
  }

  private onAnimationFrame(): void {
    this.rafId = null;
    if (this.destroyed) return;
    if (!this.mainDirty && this.overlayDirty && this.mainInvalidationCheck?.()) this.mainDirty = true;
    if (!this.mainDirty && !this.overlayDirty) return;
    this.paintLayers(this.mainDirty);
  }

  private paintLayers(main: boolean): void {
    if (this.destroyed) return;
    this.mainDirty = false;
    this.overlayDirty = false;
    this.painting = true;
    try {
      if (main) this.paintMain();
      if (this.overlayPaintHook) this.paintOverlay();
      this.paintStats.frames += 1;
    } finally {
      this.painting = false;
      // A paint hook may discover a layout change and invalidate while
      // painting. Preserve that invalidation for exactly one following frame.
      if (this.mainDirty || this.overlayDirty) this.schedule();
    }
  }

  private paintMain(): void {
    const background = this.context.theme.paneBackground;
    // Context options are fixed at creation: swap the bitmap when the
    // background stops (or starts) being opaque, so a translucent pane still
    // composites over the page and an opaque one skips alpha blending.
    const opaque = isOpaqueColor(background);
    if (this.mainLayer.setOpaque(opaque)) {
      this.mainLayer.resize(this.cssWidth, this.cssHeight, this.dpr);
    }
    const ctx = this.mainLayer.ctx;
    const { dpr } = this;
    ctx.save();
    try {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!this.mainLayer.opaque) ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
      if (this.paintHook) this.paintHook(ctx);
    } finally {
      ctx.restore();
    }
    this.paintStats.main += 1;
  }

  private paintOverlay(): void {
    const ctx = this.overlayLayer.ctx;
    const { dpr } = this;
    ctx.save();
    try {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
      this.overlayPaintHook?.(ctx);
    } finally {
      ctx.restore();
    }
    this.paintStats.overlay += 1;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.mainDirty = false;
    this.overlayDirty = false;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.ro?.disconnect();
    this.ro = null;
    window.removeEventListener("resize", this.onWinResize);
    if (this.context.requestPaint === this.requestPaint) {
      this.context.requestPaint = () => {};
    }
    if (this.context.requestOverlayPaint === this.requestOverlayPaint) {
      const context = this.context;
      context.requestOverlayPaint = () => context.requestPaint();
    }
    if (this.context.overlayHost === this.overlayHost) {
      this.context.overlayHost = null;
    }
    this.paintHook = null;
    this.overlayPaintHook = null;
    this.mainInvalidationCheck = null;
    this.onResize = null;
    this.overlayHost.remove();
    this.descriptionEl.remove();
    this.statusEl.remove();
    this.overlayLayer.remove();
    this.mainLayer.remove();
    this.host.style.isolation = this.previousIsolation;
  }
}

let chartAccessibilitySequence = 0;

const KEYBOARD_INSTRUCTIONS =
  "Keyboard controls: Left and Right Arrow pan, Plus and Minus zoom, F fits all loaded data, "
  + "Escape cancels drawing or selection, Delete or Backspace removes the selected item, "
  + "and Up or Down Arrow adjusts a selected trading line by one tick.";

function createVisuallyHiddenElement(): HTMLDivElement {
  const el = document.createElement("div");
  el.style.cssText = [
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
    "-webkit-user-select:none",
  ].join(";");
  return el;
}

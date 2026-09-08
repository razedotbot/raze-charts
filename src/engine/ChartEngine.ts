// Canvas render engine. Device-pixel-ratio-aware and invalidation driven: one
// requestAnimationFrame is queued only when something actually needs painting.

import type { ChartContext } from "../core/context";

export class ChartEngine {
  readonly canvas: HTMLCanvasElement;
  readonly accessibilityDescriptionId: string;
  private ctx2d: CanvasRenderingContext2D;
  private ro: ResizeObserver | null = null;
  private rafId: number | null = null;
  private dirty = false;
  private painting = false;
  private destroyed = false;
  private descriptionEl: HTMLDivElement;
  private statusEl: HTMLDivElement;
  private onWinResize: () => void;
  private readonly requestPaint = (): void => this.markDirty();
  cssWidth = 0;
  cssHeight = 0;
  dpr = 1;

  constructor(
    private readonly host: HTMLElement,
    private readonly context: ChartContext,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "raze-chart-canvas";
    this.canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;";
    this.canvas.tabIndex = 0;
    host.appendChild(this.canvas);
    const c2d = this.canvas.getContext("2d");
    if (!c2d) throw new Error("[raze-charts] 2D canvas context unavailable");
    this.ctx2d = c2d;

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

  markDirty(): void {
    if (this.destroyed) return;
    this.dirty = true;
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
    this.cssWidth = w;
    this.cssHeight = h;
    this.dpr = dpr;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.markDirty();
  }

  private schedule(): void {
    if (this.destroyed || this.painting || this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => this.onAnimationFrame());
  }

  private onAnimationFrame(): void {
    this.rafId = null;
    if (this.destroyed || !this.dirty) return;
    this.dirty = false;
    this.painting = true;
    try {
      this.paint();
    } finally {
      this.painting = false;
      // paintHook may discover a layout change and invalidate while painting.
      // Preserve that invalidation for exactly one following frame.
      if (this.dirty) this.schedule();
    }
  }

  /** Overridable paint hook; replaced/extended by the renderer in P2. */
  paintHook: ((ctx: CanvasRenderingContext2D) => void) | null = null;

  private paint(): void {
    const ctx = this.ctx2d;
    const { dpr } = this;
    ctx.save();
    try {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
      ctx.fillStyle = this.context.theme.paneBackground;
      ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
      if (this.paintHook) this.paintHook(ctx);
    } finally {
      ctx.restore();
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.dirty = false;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.ro?.disconnect();
    this.ro = null;
    window.removeEventListener("resize", this.onWinResize);
    if (this.context.requestPaint === this.requestPaint) {
      this.context.requestPaint = () => {};
    }
    this.descriptionEl.remove();
    this.statusEl.remove();
    this.canvas.remove();
  }
}

let chartAccessibilitySequence = 0;

const KEYBOARD_INSTRUCTIONS =
  "Keyboard controls: Left and Right Arrow pan, Plus and Minus zoom, F fits all data, "
  + "Escape cancels drawing, and Delete or Backspace removes the selected drawing.";

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
  ].join(";");
  return el;
}

// Canvas render engine. P0: device-pixel-ratio-aware canvas that fills the
// theme background and drives a requestAnimationFrame paint loop. Layout,
// scales, candles, crosshair, marks and shapes are layered on in later phases.

import type { ChartContext } from "../core/context";

export class ChartEngine {
  readonly canvas: HTMLCanvasElement;
  private ctx2d: CanvasRenderingContext2D;
  private ro: ResizeObserver | null = null;
  private rafId = 0;
  private dirty = true;
  private destroyed = false;
  private onWinResize: () => void;
  cssWidth = 0;
  cssHeight = 0;
  dpr = 1;

  constructor(
    private readonly host: HTMLElement,
    private readonly context: ChartContext,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;";
    host.appendChild(this.canvas);
    const c2d = this.canvas.getContext("2d");
    if (!c2d) throw new Error("[raze-charts] 2D canvas context unavailable");
    this.ctx2d = c2d;

    this.onWinResize = () => this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    // AppZoom dispatches window `resize` on zoom change; RO alone can miss it.
    window.addEventListener("resize", this.onWinResize);
    this.resize();

    this.context.requestPaint = () => this.markDirty();
    this.loop = this.loop.bind(this);
    this.rafId = requestAnimationFrame(this.loop);
  }

  markDirty(): void {
    this.dirty = true;
  }

  private resize(): void {
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

  private loop(): void {
    if (this.destroyed) return;
    if (this.dirty) {
      this.dirty = false;
      this.paint();
    }
    this.rafId = requestAnimationFrame(this.loop);
  }

  /** Overridable paint hook; replaced/extended by the renderer in P2. */
  paintHook: ((ctx: CanvasRenderingContext2D) => void) | null = null;

  private paint(): void {
    const ctx = this.ctx2d;
    const { dpr } = this;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    ctx.fillStyle = this.context.theme.paneBackground;
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
    if (this.paintHook) this.paintHook(ctx);
    ctx.restore();
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.rafId);
    this.ro?.disconnect();
    this.ro = null;
    window.removeEventListener("resize", this.onWinResize);
    this.canvas.remove();
  }
}

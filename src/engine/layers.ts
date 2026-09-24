// Stacked canvas layers for the finance frame (AD-04).
//
// Every pane paints into two bitmaps:
//
// - `main`    grid, volume, series, studies, drawings, axes, last price,
//             trading lines and the axis-tag pass. Repaints on data,
//             viewport, scale, style or store changes.
// - `overlay` crosshair and its axis pills, legend values, the mark tooltip,
//             the draft shape and the timezone/countdown corner. Repaints on
//             pointer and timer events without touching the main bitmap.
//
// The overlay canvas is the interactive surface: it receives every pointer
// and keyboard event, carries the chart's accessible name and stays the first
// canvas in the host. The main canvas is a pure bitmap stacked below it
// (z-index -1 inside the host's isolated stacking context), so it can be
// recreated when its context options change (an opaque theme turning
// translucent) without losing listeners, focus or ARIA state.
//
// An opaque main layer gets an `{ alpha: false }` context. Chromium then draws
// its text with LCD subpixel anti-aliasing (no context option or launch flag
// turns that off), while the transparent overlay keeps greyscale text. That is
// fine on screen, but colour fringes baked into an exported PNG are not, so
// screenshots repaint through ChartRenderer.snapshot() into an alpha canvas.

export type FinanceLayerId = "main" | "overlay";

export const FINANCE_LAYERS: readonly FinanceLayerId[] = Object.freeze(["main", "overlay"]);

/** Per-layer paint counters. Public for benchmarks, tests and devtools. */
export interface LayerPaintStats {
  /** Animation frames (plus synchronous resize paints) that painted anything. */
  frames: number;
  /** Paints of the main layer (the expensive scene). */
  main: number;
  /** Paints of the overlay layer. Every main paint also repaints the overlay. */
  overlay: number;
  /** Synchronous paints issued from a resize so no frame shows a cleared bitmap. */
  resize: number;
}

export function createLayerPaintStats(): LayerPaintStats {
  return { frames: 0, main: 0, overlay: 0, resize: 0 };
}

const LAYER_STYLE =
  "position:absolute;inset:0;width:100%;height:100%;display:block;user-select:none;-webkit-user-select:none;outline:none;";

/**
 * One canvas bitmap in the layer stack. Owns its element, its 2D context and
 * the context options, and keeps the bitmap sized to the host in device
 * pixels.
 */
export class CanvasLayer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** True when the context was created with `{ alpha: false }`. */
  opaque: boolean;

  constructor(
    readonly id: FinanceLayerId,
    className: string,
    opaque: boolean,
    /** When false the element lets pointer events fall through to the layer above or below. */
    private readonly interactive: boolean,
  ) {
    this.opaque = opaque;
    this.canvas = createLayerCanvas(className, interactive);
    this.ctx = contextFor(this.canvas, opaque);
  }

  /** Resize the bitmap. Assigning width/height clears it, so callers repaint synchronously. */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.canvas.width = Math.floor(cssWidth * dpr);
    this.canvas.height = Math.floor(cssHeight * dpr);
  }

  /**
   * Recreate the bitmap when the requested alpha mode differs from the
   * current context. A 2D context's options are fixed at creation, so the
   * element itself is swapped in place (same class, same position in the
   * stack, same bitmap size). Only valid for non-interactive layers; returns
   * true when the element was replaced.
   */
  setOpaque(opaque: boolean): boolean {
    if (opaque === this.opaque) return false;
    if (this.interactive) {
      throw new Error(`[raze-charts] the interactive ${this.id} layer cannot change its alpha mode`);
    }
    const previous = this.canvas;
    const next = createLayerCanvas(previous.className, false);
    next.width = previous.width;
    next.height = previous.height;
    previous.replaceWith(next);
    this.canvas = next;
    this.ctx = contextFor(next, opaque);
    this.opaque = opaque;
    return true;
  }

  remove(): void {
    this.canvas.remove();
  }
}

function createLayerCanvas(className: string, interactive: boolean): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.className = className;
  // Non-interactive bitmaps sit below the interactive layer whatever their
  // DOM position and let pointer events through to it.
  canvas.style.cssText = LAYER_STYLE + (interactive ? "" : "pointer-events:none;z-index:-1;");
  if (!interactive) {
    // The interactive layer carries the accessible chart; bitmaps below it
    // are presentation only.
    canvas.setAttribute("aria-hidden", "true");
  }
  return canvas;
}

function contextFor(canvas: HTMLCanvasElement, opaque: boolean): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d", { alpha: !opaque });
  if (!ctx) throw new Error("[raze-charts] 2D canvas context unavailable");
  return ctx;
}

/**
 * True only when `color` is certainly fully opaque, so a context created with
 * `{ alpha: false }` renders it identically. Unknown syntaxes (for example a
 * `var()` that canvas cannot resolve anyway) answer false, which keeps the
 * compositing-safe alpha context.
 */
export function isOpaqueColor(color: string | null | undefined): boolean {
  if (typeof color !== "string") return false;
  const value = color.trim().toLowerCase();
  if (!value || value === "transparent" || value === "currentcolor" || value === "none") return false;
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) return false;
    if (hex.length === 3 || hex.length === 6) return true;
    if (hex.length === 4) return hex[3] === "f";
    if (hex.length === 8) return hex.slice(6) === "ff";
    return false;
  }
  const fn = /^([a-z-]+)\((.*)\)$/.exec(value);
  if (fn) {
    const args = fn[2]!.trim();
    const slash = args.lastIndexOf("/");
    if (slash >= 0) return alphaIsOne(args.slice(slash + 1));
    if (fn[1] === "rgba" || fn[1] === "hsla" || fn[1] === "rgb" || fn[1] === "hsl") {
      const parts = args.split(",");
      if (parts.length === 4) return alphaIsOne(parts[3]!);
      return parts.length === 3 || (parts.length === 1 && args.split(/\s+/).length === 3);
    }
    // hwb(), lab(), lch(), oklab(), oklch(), color() without "/ alpha".
    return ["hwb", "lab", "lch", "oklab", "oklch", "color"].includes(fn[1]!);
  }
  // A bare keyword is a named colour, all of which are opaque.
  return /^[a-z]+$/.test(value);
}

function alphaIsOne(raw: string): boolean {
  const text = raw.trim();
  if (!text || text === "none") return false;
  const n = text.endsWith("%") ? Number(text.slice(0, -1)) / 100 : Number(text);
  return Number.isFinite(n) && n >= 1;
}

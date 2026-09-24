// Wheel-to-zoom curve. The span scales by exp(deltaPx * gain), so zoom is
// proportional to how far the wheel or trackpad actually travelled: a 100 px
// mouse notch zooms about 11%, while the dozens of 1-2 px events a trackpad
// emits per gesture add up to a gentle zoom instead of a 3x jump. Line and
// page deltas (Firefox, some mice) are converted to pixels first, and a
// ctrlKey wheel (a trackpad pinch in Chrome, Edge and Safari) follows the
// pinch curve, where deltaY is 100 * ln(1 / scale).

/** Pixels per line for deltaMode 1: three lines (one notch) equal one 100 px pixel-mode notch. */
export const WHEEL_LINE_PX = 100 / 3;
/** Gain for pixel deltas: a 100 px notch multiplies the span by 1.11. */
export const WHEEL_GAIN = Math.log(1.11) / 100;
/** Gain for ctrl+wheel pinch deltas: the span follows the finger distance like a touch pinch. */
export const PINCH_WHEEL_GAIN = 0.01;
/** Largest zoom step one event may apply (ln 1.5), so accelerated flicks cannot jump. */
const MAX_LOG_STEP = Math.log(1.5);

/** Vertical wheel delta in CSS pixels; `pagePx` is the height of one page. */
export function wheelDeltaPx(e: Pick<WheelEvent, "deltaY" | "deltaMode">, pagePx: number): number {
  const unit = e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? pagePx : 1;
  return e.deltaY * unit;
}

/** Multiplier for the visible span (> 1 zooms out) for one wheel event. */
export function wheelZoomFactor(e: Pick<WheelEvent, "deltaY" | "deltaMode" | "ctrlKey">, pagePx = 800): number {
  const step = wheelDeltaPx(e, pagePx) * (e.ctrlKey ? PINCH_WHEEL_GAIN : WHEEL_GAIN);
  return Math.exp(Math.max(-MAX_LOG_STEP, Math.min(MAX_LOG_STEP, step)));
}

// Fibonacci retracement with TradingView's direction: level 1 sits at the
// first anchor and level 0 at the second, so a low-to-high draw puts 0% at the
// high and 61.8% at high - 0.618 * range; `reverse` flips it. Levels are
// computed in price space (exact on log and percent scales) and every painted
// level line is part of the hit area.

import type { DrawingEnv, DrawingGeometry, DrawingLevel } from "../types";
import {
  type AnyState,
  applyStroke,
  BODY,
  type BuiltinEnv,
  colorOr,
  crisp,
  distToSegment,
  hitAnchor,
  inRect,
  lineColorOf,
  opacityOf,
  priceOf,
  reachOf,
  strokeFields,
  type ToolDef,
} from "./common";

export const DEFAULT_FIB_LEVELS: readonly DrawingLevel[] = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1].map((value) => ({ value }));

/** Price of a retracement level (TradingView direction unless `reverse`). */
export function fibLevelPrice(first: number, second: number, level: number, reverse = false): number {
  return reverse ? first + (second - first) * level : second + (first - second) * level;
}

interface LevelLine {
  readonly level: DrawingLevel;
  readonly price: number;
  readonly y: number;
  readonly color: string;
}

/** Painted level lines (visible levels only) and their shared x extent. */
export function fibLevels(drawing: AnyState, { anchors: [a, b], plot }: DrawingGeometry, env: DrawingEnv) {
  const first = priceOf(drawing, 0);
  const second = priceOf(drawing, 1);
  const p = drawing.props;
  const lines: LevelLine[] = [];
  if (!a || !b || first === null || second === null) return { lines, left: 0, right: 0 };
  for (const level of Array.isArray(p.levels) ? (p.levels as DrawingLevel[]) : DEFAULT_FIB_LEVELS) {
    if (level?.visible === false || !Number.isFinite(level?.value)) continue;
    const price = fibLevelPrice(first, second, level.value, p.reverse === true);
    lines.push({ level, price, y: env.priceToY(price), color: colorOr(level.color, lineColorOf(p, env)) });
  }
  return { lines, left: Math.min(a.x, b.x), right: p.extendLines === false ? Math.max(a.x, b.x) : plot.x + plot.w };
}

export const fibRetracementTool: ToolDef = {
  id: "fib_retracement",
  title: "Fib retracement",
  icon: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M3 3.5H15M3 7H15M3 11H15M3 14.5H15" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M3 3.5V14.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  group: "fibonacci",
  anchors: 2,
  props: {
    ...strokeFields(),
    levels: { type: "levels", title: "Levels", default: DEFAULT_FIB_LEVELS },
    reverse: { type: "boolean", title: "Reverse", default: false },
    extendLines: { type: "boolean", title: "Extend lines right", default: true },
    showCoeffs: { type: "boolean", title: "Levels", default: true, group: "text" },
    showPrices: { type: "boolean", title: "Prices", default: true, group: "text" },
    fillBackground: { type: "boolean", title: "Background", default: false },
    transparency: { type: "number", title: "Background transparency", default: 85, min: 0, max: 100 },
  },

  paint(ctx, drawing, geometry, env) {
    const p = drawing.props;
    const { lines, left, right } = fibLevels(drawing, geometry, env);
    const [a, b] = geometry.anchors;
    if (!a || !b) return;
    const alpha = ctx.globalAlpha;
    if (p.fillBackground === true) {
      ctx.globalAlpha = alpha * opacityOf(p.transparency, 85);
      lines.forEach((line, i) => {
        const prev = lines[i - 1];
        if (!prev) return;
        ctx.fillStyle = line.color;
        ctx.fillRect(left, Math.min(prev.y, line.y), right - left, Math.abs(line.y - prev.y));
      });
    }
    // The dashed trend line between the anchors.
    ctx.globalAlpha = alpha * 0.6;
    applyStroke(ctx, { ...p, linestyle: 2 }, env);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    ctx.font = `10px ${env.fontFamily}`;
    ctx.textBaseline = "bottom";
    const format = (env as BuiltinEnv).formatAxisPrice ?? env.formatPrice;
    for (const { level, price, y, color } of lines) {
      // Colourless default levels keep the 0 and 100% bounds stronger than the inner levels.
      ctx.globalAlpha = alpha * (level.color || level.value === 0 || level.value === 1 ? 1 : 0.7);
      const yy = crisp(y, applyStroke(ctx, p, env, 0, color));
      ctx.beginPath();
      ctx.moveTo(left, yy);
      ctx.lineTo(right, yy);
      ctx.stroke();
      const text = [
        p.showCoeffs !== false ? `${(level.value * 100).toFixed(1)}%` : "",
        p.showPrices !== false ? format(price) : "",
      ].filter(Boolean).join("  ");
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.fillText(text, left + 4, yy - 2);
    }
  },

  hitTest(point, drawing, geometry, env, tolerance) {
    const { lines, left, right } = fibLevels(drawing, geometry, env);
    const [a, b] = geometry.anchors;
    const reach = reachOf(tolerance, drawing.props);
    const onLevel = lines.some((line) => point.x >= left - reach && point.x <= right + reach && Math.abs(point.y - line.y) <= reach);
    return hitAnchor(point, geometry.anchors, tolerance)
      ?? (inRect(point, geometry.plot) && (onLevel || (a && b && distToSegment(point, [a, b]) <= reach)) ? BODY : null);
  },
};

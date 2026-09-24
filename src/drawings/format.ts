// Localised labels shared by drawing tools (the measure tool's duration line,
// and DrawingEnv.formatDuration for host tools).

import { plural, t } from "../i18n";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A compact span: `45s`, `12m`, `3h 20m`, `5d 4h`, `42d`. Two units at most,
 * and the minor unit is dropped once the major one reaches double digits
 * (days) so long spans stay short.
 */
export function humanizeSpan(seconds: number): string {
  const s = Math.round(Math.abs(Number.isFinite(seconds) ? seconds : 0));
  if (s < MINUTE) return t("drawings.span.seconds", "{n}s", { n: s });
  if (s < HOUR) return t("drawings.span.minutes", "{n}m", { n: Math.round(s / MINUTE) });
  if (s < DAY) {
    const hours = Math.floor(s / HOUR);
    const minutes = Math.round((s - hours * HOUR) / MINUTE);
    return minutes > 0 && minutes < 60
      ? t("drawings.span.hoursMinutes", "{h}h {m}m", { h: hours, m: minutes })
      : t("drawings.span.hours", "{n}h", { n: Math.round(s / HOUR) });
  }
  const days = Math.floor(s / DAY);
  const hours = Math.round((s - days * DAY) / HOUR);
  return days < 10 && hours > 0 && hours < 24
    ? t("drawings.span.daysHours", "{d}d {h}h", { d: days, h: hours })
    : t("drawings.span.days", "{n}d", { n: Math.round(s / DAY) });
}

/** `42 bars, 42d` (a negative count for a right-to-left measurement). */
export function formatBarsDuration(bars: number, seconds: number): string {
  const count = plural("drawings.measure.bars", Math.abs(bars), { one: "{count} bar", other: "{count} bars" });
  return t("drawings.measure.duration", "{bars}, {span}", {
    bars: bars < 0 ? `−${count}` : count,
    span: humanizeSpan(seconds),
  });
}

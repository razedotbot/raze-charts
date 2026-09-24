// Value formatting for ticks, tooltips, legends, and last-value chips.

import type { ChartSpec, XScaleKind } from "./types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatNum(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (value !== 0 && Math.abs(value) < 0.01) return String(Number(value.toPrecision(3)));
  if (Number.isInteger(value)) return Math.abs(value) >= 1000 ? value.toLocaleString("en-US") : String(value);
  if (Math.abs(value) >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return value.toFixed(Math.abs(value) < 1 ? 2 : 1);
}

export function formatDateTick(value: unknown): string {
  const timestamp = value instanceof Date ? value.getTime() : typeof value === "number" ? value : NaN;
  const date = new Date(timestamp);
  if (!Number.isFinite(timestamp) || Number.isNaN(date.getTime())) return String(value ?? "");
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

export function formatTick(value: unknown): string {
  if (typeof value === "number") return formatNum(value);
  if (value instanceof Date) return formatDateTick(value);
  return String(value ?? "");
}

export function formatSigned(value: number): string {
  const body = Math.abs(value).toFixed(1);
  if (value > 0) return `+${body}`;
  if (value < 0) return `-${body}`;
  return body;
}

export interface AxisFormatters {
  /** Labels X ticks, tooltips, and reference rules; honors scales.x.tickFormat. */
  formatX(value: unknown): string;
  /** Labels Y ticks; honors scales.y.tickFormat. */
  formatY(value: unknown): string;
}

export function axisFormatters(spec: ChartSpec, xType: XScaleKind): AxisFormatters {
  return {
    formatX: (value: unknown): string => {
      if (spec.scales?.x?.tickFormat) return spec.scales.x.tickFormat(value);
      return xType === "time" ? formatDateTick(value) : formatTick(value);
    },
    formatY: (value: unknown): string => {
      if (spec.scales?.y?.tickFormat) return spec.scales.y.tickFormat(value);
      return typeof value === "number" ? formatNum(value) : formatTick(value);
    },
  };
}

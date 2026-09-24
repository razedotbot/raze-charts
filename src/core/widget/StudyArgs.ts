// Translates TradingView `createStudy(name, forceOverlay, lock, inputs)`
// arguments into a StudyStore spec.

import type { StudySpec } from "../../studies/StudyStore";

/** Inputs consumed as the study length/colour rather than forwarded as extra inputs. */
const RESERVED_INPUT_KEYS = new Set(["length", "Length", "periods", "color"]);

export function studySpecFromArgs(
  name: string,
  forceOverlay?: boolean,
  lock?: boolean,
  inputs?: Record<string, unknown>,
): StudySpec {
  const lengthRaw = inputs?.length ?? inputs?.Length ?? inputs?.periods;
  const length = typeof lengthRaw === "number" && Number.isFinite(lengthRaw) ? lengthRaw : 0;
  const color = typeof inputs?.color === "string" ? inputs.color : "";
  const extra: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(inputs ?? {})) {
    if (RESERVED_INPUT_KEYS.has(key)) continue;
    if (typeof value === "number" || typeof value === "string") extra[key] = value;
  }
  return {
    name,
    length,
    color,
    lock: !!lock,
    forceOverlay: !!forceOverlay,
    inputs: extra,
  };
}

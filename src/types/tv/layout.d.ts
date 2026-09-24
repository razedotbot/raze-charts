// Serialized chart layout exchanged by widget.save() and widget.load().

import type { ChartStyleName, VolumeMode } from "./options";
import type { ShapePoint } from "./shapes";

// ── Layout snapshot ─────────────────────────────────────────────────────────
export interface ChartLayoutSnapshot {
  version: 1;
  symbol: string;
  interval: string;
  visibleRange: { from: number; to: number };
  chartStyle: ChartStyleName;
  logScale: boolean;
  percentScale: boolean;
  volumeMode?: VolumeMode;
  magnet?: boolean;
  drawings: {
    id: string;
    shape: string;
    points: ShapePoint[];
    text: string;
    lock: boolean;
    disableSelection?: boolean;
    disableSave?: boolean;
    disableUndo?: boolean;
    showInObjectsTree?: boolean;
    hidden?: boolean;
    zOrder: "top" | "bottom";
    overrides: Record<string, unknown>;
  }[];
  studies: {
    id?: string;
    name: string;
    length: number;
    color: string;
    lock?: boolean;
    forceOverlay?: boolean;
    inputs?: Record<string, number | string>;
  }[];
  compare?: string[];
}

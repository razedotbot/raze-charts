// Pointer / pinch / keyboard interaction for the finance widget.
// Behaviour is frozen: pan, wheel zoom, pinch, long-press crosshair, shape
// drag, drawing tools, axis drag.

import type { ShapePoint } from "../types/charting_library";
import type { ChartContext, DrawingTool } from "../core/context";
import type { ShapeStore, StoredShape } from "../core/ShapeStore";
import type { DataManager } from "../data/DataManager";
import type { ChartEngine } from "./ChartEngine";
import {
  MAX_BAR_SPACING,
  MIN_BAR_SPACING,
  timeAxisTop,
  type SubPaneGeom,
} from "./layout";
import {
  barSpacing,
  fromDisplay,
  indexForX,
  type PlotScale,
  priceForY,
} from "./plotScale";
import { hitComplexShape, neededPoints, pointXY } from "./paint/shapes";
import type { Crosshair, DraftShape, FinanceView, MarkHit, ShapeHit, TradingHit } from "./paint/view";
import { resolutionToMs } from "../util/resolution";
import { TimeIndex } from "../data/TimeIndex";

export interface GestureHost {
  readonly canvas: HTMLCanvasElement;
  readonly context: ChartContext;
  readonly engine: ChartEngine;
  readonly shapes: ShapeStore;
  readonly trading: import("../core/TradingStore").TradingStore;
  readonly data: DataManager;
  plotL: number;
  plotT: number;
  plotW: number;
  plotH: number;
  plotScale(): PlotScale;
  subPanes: SubPaneGeom[];
  volumePane: { top: number; h: number } | null;
  priceMin: number;
  priceMax: number;
  crosshair: Crosshair;
  hoverMark: MarkHit["mark"] | null;
  hoverShapeId: string | null;
  hoverTradingLineId: string | null;
  hoverTradingHit: TradingHit["hit"] | null;
  markScreen: MarkHit[];
  shapeScreen: ShapeHit[];
  tradingScreen: TradingHit[];
  draft: DraftShape | null;
  lastPointerType: string;
  selectedShapeId: string | null;
  onToolDone: ((tool: DrawingTool) => void) | null;
  fitContent(): void;
  requestPaint(): void;
  financeView(): FinanceView;
}

type DragState =
  | null
  | { kind: "pan"; startX: number; startFrom: number; startTo: number }
  | { kind: "shape"; id: string; startY: number; pointIndex: number; before: StoredShape | undefined }
  | { kind: "trading"; id: string; startPrice: number }
  | {
      kind: "priceScale";
      startY: number;
      startMin: number;
      startMax: number;
      previousAutoScale: boolean;
      previousPriceRange: { min: number; max: number } | null;
    }
  | { kind: "timeScale"; startX: number; startFrom: number; startTo: number };

export class GestureController {
  private dragging: DragState = null;
  private activePointers = new Map<number, { x: number; y: number; type: string }>();
  private pinch: {
    startSpanPx: number;
    startFrom: number;
    startTo: number;
    anchorIndex: number;
    anchorFrac: number;
  } | null = null;
  private longPressTimer: number | null = null;
  private longPressStart = { x: 0, y: 0 };
  private touchCrosshair = false;
  /** True while focus came from a pointer so the UA/keyboard ring stays off. */
  private pointerFocus = false;

  private boundMove: (e: PointerEvent) => void;
  private boundDown: (e: PointerEvent) => void;
  private boundUp: (e: PointerEvent) => void;
  private boundCancel: (e: PointerEvent) => void;
  private boundLeave: (e: PointerEvent) => void;
  private boundWheel: (e: WheelEvent) => void;
  private boundDbl: (e: MouseEvent) => void;
  private boundKey: (e: KeyboardEvent) => void;
  private boundFocus: () => void;
  private boundBlur: () => void;
  private boundSelectStart: (e: Event) => void;

  constructor(private readonly host: GestureHost) {
    this.boundMove = (e) => this.onPointerMove(e);
    this.boundDown = (e) => this.onPointerDown(e);
    this.boundUp = (e) => this.onPointerUp(e);
    this.boundCancel = (e) => this.onPointerCancel(e);
    this.boundLeave = (e) => this.onPointerLeave(e);
    this.boundWheel = (e) => this.onWheel(e);
    this.boundDbl = (e) => this.onDblClick(e);
    this.boundKey = (e) => this.onKeyDown(e);
    this.boundFocus = () => this.onFocus();
    this.boundBlur = () => this.onBlur();
    this.boundSelectStart = (e) => e.preventDefault();
  }

  attach(): void {
    const canvas = this.host.canvas;
    canvas.style.touchAction = "none";
    canvas.style.outline = "none";
    canvas.addEventListener("pointermove", this.boundMove);
    canvas.addEventListener("pointerdown", this.boundDown);
    window.addEventListener("pointerup", this.boundUp);
    canvas.addEventListener("pointercancel", this.boundCancel);
    canvas.addEventListener("pointerleave", this.boundLeave);
    canvas.addEventListener("wheel", this.boundWheel, { passive: false });
    canvas.addEventListener("dblclick", this.boundDbl);
    canvas.addEventListener("keydown", this.boundKey);
    canvas.addEventListener("focus", this.boundFocus);
    canvas.addEventListener("blur", this.boundBlur);
    canvas.addEventListener("selectstart", this.boundSelectStart);
    canvas.tabIndex = 0;
  }

  destroy(): void {
    this.clearLongPress();
    const canvas = this.host.canvas;
    canvas.removeEventListener("pointermove", this.boundMove);
    canvas.removeEventListener("pointerdown", this.boundDown);
    window.removeEventListener("pointerup", this.boundUp);
    canvas.removeEventListener("pointercancel", this.boundCancel);
    canvas.removeEventListener("pointerleave", this.boundLeave);
    canvas.removeEventListener("wheel", this.boundWheel);
    canvas.removeEventListener("dblclick", this.boundDbl);
    canvas.removeEventListener("keydown", this.boundKey);
    canvas.removeEventListener("focus", this.boundFocus);
    canvas.removeEventListener("blur", this.boundBlur);
    canvas.removeEventListener("selectstart", this.boundSelectStart);
    this.onBlur();
  }

  private onFocus(): void {
    if (this.pointerFocus) {
      this.hideFocusRing();
      return;
    }
    this.showFocusRing();
  }

  private showFocusRing(): void {
    const canvas = this.host.canvas;
    canvas.style.outline = `2px solid ${this.host.context.theme.scaleText}`;
    canvas.style.outlineOffset = "-2px";
  }

  private hideFocusRing(): void {
    const canvas = this.host.canvas;
    // Keep outline:none so the UA orange :focus-visible ring cannot return.
    canvas.style.outline = "none";
    canvas.style.removeProperty("outline-offset");
  }

  private onBlur(): void {
    this.pointerFocus = false;
    this.hideFocusRing();
  }

  pointerXY(e: MouseEvent): { x: number; y: number } {
    const rect = this.host.canvas.getBoundingClientRect();
    const rw = rect.width || 1;
    const rh = rect.height || 1;
    const cw = this.host.engine.cssWidth || this.host.canvas.clientWidth || 1;
    const ch = this.host.engine.cssHeight || this.host.canvas.clientHeight || 1;
    return {
      x: (e.clientX - rect.left) * (cw / rw),
      y: (e.clientY - rect.top) * (ch / rh),
    };
  }

  timePriceAt(x: number, y: number): { unixTime: number; price: number } {
    const s = this.host.plotScale();
    const bars = this.host.context.bars;
    let unixTime = 0;
    let idx = 0;
    if (bars.length) {
      idx = indexForX(s, x);
      const timeIndex = new TimeIndex(bars, resolutionToMs(this.host.context.resolution));
      unixTime = (timeIndex.timeAt(idx) ?? 0) / 1000;
    }
    let price = priceForY(s, y);
    if (this.host.context.magnet && bars.length) {
      const bar = bars[Math.max(0, Math.min(bars.length - 1, Math.round(idx)))];
      if (bar) {
        let best = bar.close;
        let bestD = Math.abs(price - bar.close);
        for (const candidate of [bar.open, bar.high, bar.low]) {
          const d = Math.abs(price - candidate);
          if (d < bestD) {
            bestD = d;
            best = candidate;
          }
        }
        price = best;
      }
    }
    return { unixTime, price };
  }

  private contentBottom(): number {
    return timeAxisTop(this.host.plotT, this.host.plotH, this.host.subPanes, this.host.volumePane);
  }

  private emitViewport(): void {
    this.host.context.viewportChanged.fire(this.host.data.visibleUnixRange());
  }

  private hitTestAt(x: number, y: number, tolMul: number): void {
    const h = this.host;
    const contentBottom = this.contentBottom();
    const inPriceAxis = x > h.plotL + h.plotW && y < h.plotT + h.plotH;
    const inTimeAxis = y >= contentBottom && x < h.plotL + h.plotW;
    h.hoverShapeId = null;
    h.hoverTradingLineId = null;
    h.hoverTradingHit = null;
    h.hoverMark = null;
    if (inPriceAxis || inTimeAxis || y > h.plotT + h.plotH) return;
    for (const hit of h.tradingScreen) {
      if (x >= hit.x1 && x <= hit.x2 && Math.abs(hit.y - y) <= 7 * tolMul) {
        h.hoverTradingLineId = hit.line.id;
        h.hoverTradingHit = hit.hit;
        break;
      }
    }
    const view = h.financeView();
    for (const m of h.markScreen) {
      const dx = x - m.x;
      const dy = y - m.y;
      const r = m.r + 2 * tolMul;
      if (dx * dx + dy * dy <= r * r) {
        h.hoverMark = m.mark;
        break;
      }
    }
    if (!h.hoverMark && !h.hoverTradingLineId) {
      for (const { shape, y: sy } of h.shapeScreen) {
        if (shape.lock || shape.disableSelection) continue;
        if (shape.shape === "horizontal_line" && Math.abs(sy - y) <= 4 * tolMul && x <= h.plotL + h.plotW) {
          h.hoverShapeId = shape.id as unknown as string;
          break;
        }
        if (shape.shape !== "horizontal_line") {
          if (hitComplexShape(view, shape, x, y, tolMul)) {
            h.hoverShapeId = shape.id as unknown as string;
            break;
          }
        }
      }
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.dragging || this.pinch) e.preventDefault();
    const h = this.host;
    const { x, y } = this.pointerXY(e);
    const contentBottom = this.contentBottom();
    const tracked = this.activePointers.get(e.pointerId);
    if (tracked) {
      tracked.x = x;
      tracked.y = y;
    }

    if (this.pinch && this.activePointers.size >= 2) {
      this.updatePinch();
      h.requestPaint();
      return;
    }

    if (this.longPressTimer != null
        && Math.hypot(x - this.longPressStart.x, y - this.longPressStart.y) > 8) {
      this.clearLongPress();
    }

    if (this.touchCrosshair && tracked) {
      h.crosshair = { x, y, active: true };
      h.requestPaint();
      return;
    }

    if (e.pointerType === "mouse") {
      h.crosshair = {
        x,
        y,
        active: x >= h.plotL && x <= h.plotL + h.plotW && y >= h.plotT && y <= contentBottom,
      };
      const tp = this.timePriceAt(x, y);
      h.context.crosshairMoved.fire({ unixTime: tp.unixTime, price: tp.price, active: h.crosshair.active });
    }

    const s = h.plotScale();
    const spacing = barSpacing(s);

    if (this.dragging?.kind === "pan") {
      const dxBars = (x - this.dragging.startX) / spacing;
      h.context.visibleRange = {
        from: this.dragging.startFrom - dxBars,
        to: this.dragging.startTo - dxBars,
      };
      void h.data.maybeLoadMoreHistory();
      this.emitViewport();
    } else if (this.dragging?.kind === "priceScale") {
      const dy = y - this.dragging.startY;
      const factor = Math.min(20, Math.max(0.05, 1 + dy / (h.plotH * 0.5)));
      const center = (this.dragging.startMin + this.dragging.startMax) / 2;
      const half = ((this.dragging.startMax - this.dragging.startMin) / 2) * factor;
      h.context.autoScalePrice = false;
      h.context.priceRange = {
        min: fromDisplay(s, center - half),
        max: fromDisplay(s, center + half),
      };
    } else if (this.dragging?.kind === "timeScale") {
      const dx = x - this.dragging.startX;
      const span = this.dragging.startTo - this.dragging.startFrom;
      const factor = Math.min(20, Math.max(0.05, 1 - dx / (h.plotW * 0.5)));
      const minSpan = h.plotW / MAX_BAR_SPACING;
      const maxSpan = h.plotW / MIN_BAR_SPACING;
      const newSpan = Math.min(maxSpan, Math.max(minSpan, span * factor));
      h.context.visibleRange = { from: this.dragging.startTo - newSpan, to: this.dragging.startTo };
      void h.data.maybeLoadMoreHistory();
      this.emitViewport();
    } else if (this.dragging?.kind === "shape") {
      const sh = h.shapes.get(this.dragging.id as never);
      if (sh) {
        const pt = sh.points[this.dragging.pointIndex];
        if (pt) {
          const tp = this.timePriceAt(x, y);
          if (sh.shape === "horizontal_line") {
            pt.price = tp.price;
          } else {
            pt.price = tp.price;
            pt.time = tp.unixTime;
          }
        }
      }
    } else if (this.dragging?.kind === "trading") {
      const line = h.trading.get(this.dragging.id);
      if (line?.editable) h.trading.move(line.id, this.timePriceAt(x, y).price, "moving", "drag");
    } else if (e.pointerType === "mouse") {
      const inPriceAxis = x > h.plotL + h.plotW && y < h.plotT + h.plotH;
      const inTimeAxis = y >= contentBottom && x < h.plotL + h.plotW;
      this.hitTestAt(x, y, 1);
      const drawing = h.context.drawingTool !== "cursor";
      const hoverShape = h.hoverShapeId ? h.shapes.get(h.hoverShapeId as never) : undefined;
      const shapeCursor = hoverShape?.shape === "horizontal_line" ? "ns-resize" : "move";
      const tradingLine = h.hoverTradingLineId ? h.trading.get(h.hoverTradingLineId) : undefined;
      h.canvas.title = tradingLine
        ? h.hoverTradingHit === "cancel" ? tradingLine.cancelTooltip : `${tradingLine.tooltip}. ${tradingLine.modifyTooltip}`
        : "";
      h.canvas.style.cursor = inPriceAxis
        ? "ns-resize"
        : inTimeAxis
          ? "ew-resize"
          : h.hoverTradingHit === "cancel"
            ? "pointer"
            : tradingLine
              ? tradingLine.editable ? "ns-resize" : "pointer"
          : h.hoverShapeId
            ? shapeCursor
            : drawing
              ? "crosshair"
              : h.hoverMark
                ? "pointer"
                : "crosshair";
    }
    h.requestPaint();
  }

  private onPointerDown(e: PointerEvent): void {
    const h = this.host;
    h.lastPointerType = e.pointerType || "mouse";
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const { x, y } = this.pointerXY(e);
    this.pointerFocus = true;
    h.canvas.focus({ preventScroll: true });
    // Pointer focus should not masquerade as keyboard focus. A subsequent key
    // press restores the guaranteed high-contrast ring below.
    this.hideFocusRing();
    this.activePointers.set(e.pointerId, { x, y, type: e.pointerType });
    try { h.canvas.setPointerCapture?.(e.pointerId); } catch { /* detached/test env */ }
    window.getSelection?.()?.removeAllRanges();

    if (this.activePointers.size === 2) {
      this.clearLongPress();
      this.touchCrosshair = false;
      // A second contact turns the interaction into a pinch. Roll back any
      // partially applied one-pointer drag first so shapes/orders and their
      // host callbacks cannot be left between lifecycle phases.
      this.cancelDrag();
      this.startPinch();
      return;
    }

    this.hitTestAt(x, y, e.pointerType === "mouse" ? 1 : 2);
    if (e.pointerType !== "mouse") {
      if (h.crosshair.active && !this.touchCrosshair) {
        h.crosshair.active = false;
        h.requestPaint();
      }
      if (h.context.drawingTool === "cursor" && !h.hoverShapeId && !h.hoverTradingLineId) {
        this.armLongPress(x, y);
      }
    }

    this.beginInteraction(x, y);
  }

  private startPinch(): void {
    const h = this.host;
    const pts = Array.from(this.activePointers.values());
    const a = pts[0]!;
    const b = pts[1]!;
    const { from, to } = h.context.visibleRange;
    const span = to - from;
    const midX = (a.x + b.x) / 2;
    const s = h.plotScale();
    const anchorIndex = indexForX(s, midX);
    this.pinch = {
      startSpanPx: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)),
      startFrom: from,
      startTo: to,
      anchorIndex,
      anchorFrac: span > 0 ? (anchorIndex - from) / span : 0.5,
    };
  }

  private updatePinch(): void {
    if (!this.pinch) return;
    const h = this.host;
    const pts = Array.from(this.activePointers.values());
    if (pts.length < 2) return;
    const spanPx = Math.max(10, Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y));
    const scale = this.pinch.startSpanPx / spanPx;
    const startSpan = this.pinch.startTo - this.pinch.startFrom;
    const newSpan = Math.max(
      h.plotW / MAX_BAR_SPACING,
      Math.min(h.plotW / MIN_BAR_SPACING, startSpan * scale),
    );
    const from = this.pinch.anchorIndex - this.pinch.anchorFrac * newSpan;
    h.context.visibleRange = { from, to: from + newSpan };
    void h.data.maybeLoadMoreHistory();
    this.emitViewport();
  }

  private armLongPress(x: number, y: number): void {
    this.clearLongPress();
    this.longPressStart = { x, y };
    this.longPressTimer = window.setTimeout(() => {
      this.longPressTimer = null;
      this.touchCrosshair = true;
      this.dragging = null;
      this.host.crosshair = { x: this.longPressStart.x, y: this.longPressStart.y, active: true };
      this.host.requestPaint();
    }, 300);
  }

  private clearLongPress(): void {
    if (this.longPressTimer != null) {
      window.clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  private beginInteraction(x: number, y: number): void {
    const h = this.host;
    const contentBottom = this.contentBottom();
    const inPriceAxis = x > h.plotL + h.plotW && y < h.plotT + h.plotH;
    const inTimeAxis = y >= contentBottom && x < h.plotL + h.plotW;
    const inPlot = x <= h.plotL + h.plotW && y >= h.plotT && y <= h.plotT + h.plotH;

    const tool = h.context.drawingTool;
    if (tool !== "cursor" && inPlot && !inPriceAxis && !inTimeAxis) {
      const tp = this.timePriceAt(x, y);
      const point: ShapePoint = { time: tp.unixTime, price: tp.price };
      if (!h.draft || h.draft.tool !== tool) {
        h.draft = { tool, points: [point] };
      } else {
        h.draft.points.push(point);
      }
      const need = neededPoints(tool);
      if (h.draft.points.length >= need) {
        this.finishDraft();
      }
      h.requestPaint();
      return;
    }

    if (h.hoverTradingLineId) {
      const line = h.trading.get(h.hoverTradingLineId);
      if (h.hoverTradingHit === "cancel") {
        h.trading.cancel(h.hoverTradingLineId);
        h.engine.announce(`${line?.text ?? "Trading line"} cancelled.`);
        return;
      }
      h.context.selectedShapeId = null;
      h.context.selectedTradingLineId = h.hoverTradingLineId;
      if (line?.editable) this.dragging = { kind: "trading", id: line.id, startPrice: line.price };
      else h.trading.modify(h.hoverTradingLineId);
      h.requestPaint();
      return;
    }

    if (h.hoverShapeId) {
      const sh = h.shapes.get(h.hoverShapeId as never);
      let pointIndex = 0;
      if (sh && sh.shape !== "horizontal_line") {
        const view = h.financeView();
        const pts = sh.points.map((p) => pointXY(view, p));
        let best = Infinity;
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          if (!p) continue;
          const d = Math.hypot(p.x - x, p.y - y);
          if (d < best) { best = d; pointIndex = i; }
        }
      }
      h.context.selectedShapeId = h.hoverShapeId;
      h.context.selectedTradingLineId = null;
      this.dragging = {
        kind: "shape",
        id: h.hoverShapeId,
        startY: y,
        pointIndex,
        before: h.shapes.capture(h.hoverShapeId as never),
      };
      return;
    }
    if (inPriceAxis) {
      this.dragging = {
        kind: "priceScale",
        startY: y,
        startMin: h.priceMin,
        startMax: h.priceMax,
        previousAutoScale: h.context.autoScalePrice,
        previousPriceRange: h.context.priceRange ? { ...h.context.priceRange } : null,
      };
      h.context.autoScalePrice = false;
      const s = h.plotScale();
      h.context.priceRange = {
        min: fromDisplay(s, h.priceMin),
        max: fromDisplay(s, h.priceMax),
      };
      return;
    }
    if (inTimeAxis) {
      this.dragging = {
        kind: "timeScale",
        startX: x,
        startFrom: h.context.visibleRange.from,
        startTo: h.context.visibleRange.to,
      };
      return;
    }
    h.context.selectedShapeId = null;
    h.context.selectedTradingLineId = null;
    if (x <= h.plotL + h.plotW && y <= h.plotT + h.plotH) {
      this.dragging = {
        kind: "pan",
        startX: x,
        startFrom: h.context.visibleRange.from,
        startTo: h.context.visibleRange.to,
      };
    }
  }

  private finishDraft(): void {
    const h = this.host;
    if (!h.draft) return;
    const { tool, points } = h.draft;
    h.draft = null;
    const stay = h.context.stayInDrawingMode;
    const resetTool = (): void => {
      if (stay) return;
      h.context.drawingTool = "cursor";
      h.onToolDone?.("cursor");
    };
    if (tool === "measure") {
      resetTool();
      h.requestPaint();
      return;
    }
    let text = "";
    if (tool === "text") {
      text = window.prompt("Label text", "Note") ?? "";
      if (!text.trim()) {
        resetTool();
        h.requestPaint();
        return;
      }
    }
    const defaults: Record<string, unknown> = {
      linecolor: tool === "fib_retracement" ? "#f5a623" : "#66d89e",
      linewidth: 1,
      linestyle: tool === "horizontal_line" || tool === "vertical_line" ? 2 : 0,
      showPrice: tool === "horizontal_line",
    };
    void h.shapes.createPoints(points, {
      shape: tool,
      text,
      lock: false,
      overrides: defaults,
    }).then((id) => {
      h.context.selectedShapeId = id as unknown as string;
    });
    resetTool();
    h.requestPaint();
  }

  private onPointerUp(e: PointerEvent): void {
    this.activePointers.delete(e.pointerId);
    this.clearLongPress();
    if (this.pinch && this.activePointers.size < 2) {
      this.pinch = null;
      this.dragging = null;
    }
    if (this.activePointers.size === 0) {
      this.finishDrag(true);
      this.touchCrosshair = false;
    }
  }

  private onPointerCancel(e: PointerEvent): void {
    this.activePointers.delete(e.pointerId);
    this.clearLongPress();
    if (this.pinch) {
      this.host.context.visibleRange = {
        from: this.pinch.startFrom,
        to: this.pinch.startTo,
      };
      this.emitViewport();
      this.pinch = null;
    }
    this.cancelDrag();
    this.activePointers.clear();
    this.touchCrosshair = false;
    this.host.requestPaint();
  }

  private finishDrag(commit: boolean): void {
    const h = this.host;
    if (this.dragging?.kind === "shape") {
      if (commit) {
        h.shapes.commitUpdate(this.dragging.id as never, this.dragging.before);
      }
    } else if (this.dragging?.kind === "trading") {
      const line = h.trading.get(this.dragging.id);
      if (commit && line) h.trading.move(line.id, line.price, "moved", "drag");
    }
    this.dragging = null;
  }

  private cancelDrag(): void {
    const h = this.host;
    const drag = this.dragging;
    if (!drag) return;
    if (drag.kind === "pan" || drag.kind === "timeScale") {
      h.context.visibleRange = { from: drag.startFrom, to: drag.startTo };
      this.emitViewport();
    } else if (drag.kind === "priceScale") {
      h.context.autoScalePrice = drag.previousAutoScale;
      h.context.priceRange = drag.previousPriceRange ? { ...drag.previousPriceRange } : null;
    } else if (drag.kind === "shape" && drag.before) {
      h.shapes.restore(drag.before);
    } else if (drag.kind === "trading") {
      const line = h.trading.get(drag.id);
      if (line) h.trading.move(line.id, drag.startPrice, "moved", "drag");
    }
    this.finishDrag(false);
  }

  private onPointerLeave(e: PointerEvent): void {
    if (e.pointerType !== "mouse") return;
    const h = this.host;
    h.crosshair.active = false;
    h.hoverMark = null;
    h.hoverTradingLineId = null;
    h.hoverTradingHit = null;
    h.canvas.title = "";
    h.context.crosshairMoved.fire({ unixTime: 0, price: 0, active: false });
    if (!this.dragging) h.canvas.style.cursor = "default";
    h.requestPaint();
  }

  private onWheel(e: WheelEvent): void {
    // A purely horizontal trackpad gesture belongs to the surrounding page;
    // treating deltaY === 0 as zoom-in made sideways scrolling unexpectedly
    // consume and magnify the chart.
    if (e.deltaY === 0) return;
    e.preventDefault();
    const h = this.host;
    const { from, to } = h.context.visibleRange;
    const span = to - from;
    const factor = e.deltaY > 0 ? 1.1 : 1 / 1.1;
    const newSpan = Math.max(h.plotW / MAX_BAR_SPACING, Math.min(h.plotW / MIN_BAR_SPACING, span * factor));
    const { x } = this.pointerXY(e);
    const s = h.plotScale();
    const pivot = indexForX(s, x);
    const leftFrac = (pivot - from) / span;
    h.context.visibleRange = {
      from: pivot - leftFrac * newSpan,
      to: pivot + (1 - leftFrac) * newSpan,
    };
    void h.data.maybeLoadMoreHistory();
    this.emitViewport();
    h.requestPaint();
  }

  private onDblClick(e: MouseEvent): void {
    const h = this.host;
    const { x, y } = this.pointerXY(e);
    const inPriceAxis = x > h.plotL + h.plotW && y < h.plotT + h.plotH;
    this.hitTestAt(x, y, 1);
    if (h.hoverTradingLineId && h.hoverTradingHit === "body") {
      h.trading.modify(h.hoverTradingLineId);
      e.preventDefault();
      return;
    }
    h.context.priceRange = null;
    h.context.autoScalePrice = true;
    if (!inPriceAxis) h.fitContent();
    else h.requestPaint();
  }

  private onKeyDown(e: KeyboardEvent): void {
    const h = this.host;
    if (e.target !== h.canvas) return;
    this.showFocusRing();

    const { from, to } = h.context.visibleRange;
    const span = to - from;
    if (e.key === "Escape") {
      h.draft = null;
      h.context.drawingTool = "cursor";
      h.context.selectedShapeId = null;
      h.context.selectedTradingLineId = null;
      h.onToolDone?.("cursor");
      h.requestPaint();
      h.engine.announce("Drawing cancelled.");
      e.preventDefault();
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      if (h.context.selectedTradingLineId) {
        h.trading.cancel(h.context.selectedTradingLineId);
        h.engine.announce("Selected trading order cancelled.");
        e.preventDefault();
        return;
      }
      if (h.context.selectedShapeId) {
        h.shapes.remove(h.context.selectedShapeId as never);
        h.requestPaint();
        h.engine.announce("Selected drawing removed.");
        e.preventDefault();
      }
      return;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && h.context.selectedTradingLineId) {
      const line = h.trading.get(h.context.selectedTradingLineId);
      if (line?.editable) {
        const info = h.context.symbolInfo;
        const tick = (info?.minmov ?? 1) / (info?.pricescale ?? 100);
        const direction = e.key === "ArrowUp" ? 1 : -1;
        const price = line.price + direction * tick * (e.shiftKey ? 10 : 1);
        h.trading.move(line.id, price, "moved", "keyboard");
        h.engine.announce(`${line.text} moved to ${h.context.formatPrice(price, info?.pricescale ?? 100)}.`);
        e.preventDefault();
      }
      return;
    }
    if (e.key === "f" || e.key === "F") {
      h.fitContent();
      h.engine.announce("Chart fitted to all data.");
      e.preventDefault();
      return;
    }
    if (e.key === "+" || e.key === "=") {
      const newSpan = Math.max(h.plotW / MAX_BAR_SPACING, span / 1.15);
      h.context.visibleRange = { from: to - newSpan, to };
      this.emitViewport();
      h.requestPaint();
      h.engine.announce("Zoomed in.");
      e.preventDefault();
      return;
    }
    if (e.key === "-" || e.key === "_") {
      const newSpan = Math.min(h.plotW / MIN_BAR_SPACING, span * 1.15);
      h.context.visibleRange = { from: to - newSpan, to };
      void h.data.maybeLoadMoreHistory();
      this.emitViewport();
      h.requestPaint();
      h.engine.announce("Zoomed out.");
      e.preventDefault();
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const dir = e.key === "ArrowLeft" ? -1 : 1;
      const shift = span * 0.08 * dir;
      h.context.visibleRange = { from: from + shift, to: to + shift };
      void h.data.maybeLoadMoreHistory();
      this.emitViewport();
      h.requestPaint();
      h.engine.announce(dir < 0 ? "Panned left." : "Panned right.");
      e.preventDefault();
    }
  }
}

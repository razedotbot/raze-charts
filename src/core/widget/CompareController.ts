// Compare overlays: load another symbol's bars and add/remove it as a series.

import type { Bar, EntityId } from "../../types/charting_library";
import type { WidgetHost } from "./host";

declare module "./host" {
  interface WidgetControllerMap {
    compare: CompareController;
  }
}

const COMPARE_COLORS = ["#26a69a", "#f5a623", "#e040fb", "#42a5f5"];

/** Compare series of one widget. Needs no lifecycle hooks. */
export class CompareController {
  private seq = 0;

  constructor(private readonly host: WidgetHost) {}

  async create(symbol: string): Promise<EntityId> {
    const bars = await this.host.data.loadCompare(symbol);
    if (this.host.lifecycle.destroyed) {
      throw new Error("[raze-charts] widget was removed before compare data loaded");
    }
    return this.add(symbol, bars);
  }

  add(symbol: string, bars: Bar[]): EntityId {
    const context = this.host.context;
    this.seq += 1;
    const id = `compare_${symbol}_${this.seq}` as EntityId;
    context.compare.push({
      id: String(id),
      symbol,
      bars,
      color: COMPARE_COLORS[context.compare.length % COMPARE_COLORS.length]!,
    });
    context.requestPaint();
    return id;
  }

  /** Remove a compare series; false when `id` is not one. */
  remove(id: EntityId): boolean {
    const context = this.host.context;
    const key = String(id);
    if (!context.compare.some((item) => item.id === key)) return false;
    context.compare = context.compare.filter((item) => item.id !== key);
    context.requestPaint();
    return true;
  }
}

// Order, position and bracket lines.

import type {
  BracketOrderOptions,
  IBracketOrderAdapter,
  ITradingLineAdapter,
  TradingLineOptions,
} from "../../types/charting_library";
import type { ChartApi } from "../ChartApi";
import { apiScope } from "./scope";

export const tradingApi = {
  createOrderLine(this: ChartApi, options: TradingLineOptions = {}): Promise<ITradingLineAdapter> {
    return Promise.resolve().then(() => apiScope(this).deps.createTradingLine(options, "order"));
  },

  createPositionLine(this: ChartApi, options: TradingLineOptions = {}): Promise<ITradingLineAdapter> {
    return Promise.resolve().then(() => apiScope(this).deps.createTradingLine(options, "position"));
  },

  createBracketOrder(this: ChartApi, options: BracketOrderOptions): Promise<IBracketOrderAdapter> {
    return Promise.resolve().then(() => apiScope(this).deps.createBracketOrder(options));
  },

  getTradingLineById(this: ChartApi, id: string): ITradingLineAdapter | null {
    return apiScope(this).deps.getTradingLineById(id);
  },

  removeAllTradingLines(this: ChartApi): void {
    apiScope(this).deps.removeAllTradingLines();
  },
};

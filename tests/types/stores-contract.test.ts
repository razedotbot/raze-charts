// Type-level contract for W1B-20: closed shape names with TradingView
// aliases, custom tool names by augmentation, the text property, z-order
// methods, and the two trading callback forms.

import type {
  AvailableZOrderOperations,
  IChartWidgetApi,
  ILineDataSourceApi,
  ShapeKind,
  SupportedShapeName,
} from "../../src";
import { ShapeError } from "../../src";
import type { BuiltinShapeName } from "../../src";
import type { BuiltinDrawingToolId } from "../../src/drawings/types";

// The published kind list and the drawing-tool contract's built-in ids never drift apart.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const builtinKindsMatchContract: Same<BuiltinShapeName, BuiltinDrawingToolId> = true;

declare module "../../src" {
  interface CustomShapeNames {
    arrow_marker: true;
  }
}

if (false) {
  const chart = null as unknown as IChartWidgetApi;
  const point = { time: 1_700_000_000, price: 42 };

  void chart.createShape(point, { shape: "horizontal_line", text: "Limit", zOrder: "bottom" });
  void chart.createMultipointShape([point, point], { shape: "extended" });
  void chart.createMultipointShape([point, point], { shape: "date_and_price_range" });
  void chart.createMultipointShape([point, point], { shape: "arrow_marker" });
  // @ts-expect-error TradingView's arrow_up is not a supported kind.
  void chart.createShape(point, { shape: "arrow_up" });
  // @ts-expect-error Typos are rejected at compile time.
  void chart.createShape(point, { shape: "horizontal_lines" });

  const canonical: ShapeKind = "extended_line";
  const custom: ShapeKind = "arrow_marker";
  // @ts-expect-error Aliases are accepted on input but never stored as a kind.
  const alias: ShapeKind = "extended";
  const accepted: SupportedShapeName = "extended";
  void [canonical, custom, alias, accepted];

  const shape: ILineDataSourceApi = chart.getShapeById("shape_1" as never);
  shape.setProperties({ text: "Renamed", linecolor: "#fff" });
  // @ts-expect-error text is a string.
  shape.setProperties({ text: 12 });
  const label: string | undefined = shape.getProperties().text;
  shape.bringForward();
  shape.sendBackward();
  const ops: AvailableZOrderOperations = shape.availableZOrderOperations();
  void [label, ops.bringForwardEnabled];

  void chart.createOrderLine({ side: "buy", price: 42, priceStep: 0.25 }).then((order) => {
    order
      .onMove(function (line) { void this.getPrice(); void line.getText(); })
      .onCancel("text", function (data) { const self: string = this; void self; void data.toUpperCase(); })
      .onModify({ orderId: 7 }, function (data) { void this.orderId; void data.orderId; })
      .onMoving({ step: 1 }, (data) => data.step);
    // @ts-expect-error The two-argument form needs a callback.
    order.onCancel("text", "not a callback");
  });
}

export function isMissingShape(error: unknown): boolean {
  return error instanceof ShapeError && error.code === "E_SHAPE_NOT_FOUND" && Array.isArray(error.supported);
}

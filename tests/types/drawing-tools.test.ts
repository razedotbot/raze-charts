// Type-level tests for the drawing-tool registry (W1B-11). Checked by
// `tsc -p tsconfig.type-tests.json` (part of `npm run typecheck`); never run.

import type * as Raze from "../../src/index";
import type { DrawingLineStyle, DrawingToolDefinition, RegisteredDrawingTool } from "../../src/index";

// Type-only: Playwright loads tests/**/*.test.ts, so no runtime import may appear here.
declare const defineDrawingTool: typeof Raze.defineDrawingTool;
declare const getDrawingTool: typeof Raze.getDrawingTool;
declare const listDrawingTools: typeof Raze.listDrawingTools;

interface ArrowProps {
  linecolor: string;
  linewidth: number;
  linestyle: DrawingLineStyle;
  filled: boolean;
}

// Playwright also loads tests/**/*.test.ts, so nothing below may run.
if (false) {
  // Props are typed end to end: the schema must cover every prop with a matching field kind.
  const arrow: DrawingToolDefinition<ArrowProps> = defineDrawingTool<ArrowProps>({
    id: "acme_arrow",
    title: "Arrow",
    icon: "<svg></svg>",
    anchors: 2,
    props: {
      linecolor: { type: "color", title: "Color", default: "" },
      linewidth: { type: "lineWidth", title: "Width", default: 2 },
      linestyle: { type: "lineStyle", title: "Style", default: 1 },
      filled: { type: "boolean", title: "Filled", default: true },
    },
    paint(ctx, drawing, geometry, env) {
      const width: number = drawing.props.linewidth;
      const filled: boolean = drawing.props.filled;
      ctx.lineWidth = width;
      env.pushAxisTag({ axis: "price", coord: geometry.plot.y, text: env.formatPrice(1), background: "#000", color: "#fff" });
      void filled;
    },
    hitTest: (_point, _drawing, _geometry, _env, _tolerance) => ({ kind: "anchor", index: 0 }),
  });
  void arrow;

  defineDrawingTool<ArrowProps>({
    id: "acme_bad",
    title: "Bad",
    icon: "<svg></svg>",
    anchors: 2,
    props: {
      linecolor: { type: "color", title: "Color", default: "" },
      // @ts-expect-error a numeric prop cannot use a boolean field
      linewidth: { type: "boolean", title: "Width", default: true },
      linestyle: { type: "lineStyle", title: "Style", default: 0 },
      filled: { type: "boolean", title: "Filled", default: true },
    },
    paint() {},
    hitTest: () => null,
  });

  defineDrawingTool<ArrowProps>({
    id: "acme_missing",
    title: "Missing",
    icon: "<svg></svg>",
    anchors: 2,
    // @ts-expect-error every prop needs a schema field
    props: {
      linecolor: { type: "color", title: "Color", default: "" },
    },
    paint() {},
    hitTest: () => null,
  });

  // @ts-expect-error hit kinds are a closed union
  const badHit: DrawingToolDefinition["hitTest"] = () => ({ kind: "edge" });
  void badHit;

  const found: RegisteredDrawingTool | undefined = getDrawingTool("extended");
  const ids: string[] = listDrawingTools().map((tool) => tool.id);
  void found;
  void ids;
}

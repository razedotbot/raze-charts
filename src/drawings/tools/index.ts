// The built-in drawing tools, in sidebar order. Each is a plain
// DrawingToolDefinition registered through the same registry as host tools
// (../registry.ts registers them lazily on first access).

import type { ToolDef } from "./common";
import { fibRetracementTool } from "./fibRetracement";
import { horizontalLineTool } from "./horizontalLine";
import { extendedLineTool, rayTool, trendLineTool } from "./lines";
import { measureTool } from "./measure";
import { rectangleTool } from "./rectangle";
import { textTool } from "./text";
import { verticalLineTool } from "./verticalLine";

export const BUILTIN_DRAWING_TOOLS: readonly ToolDef[] = [
  trendLineTool,
  horizontalLineTool,
  verticalLineTool,
  rayTool,
  extendedLineTool,
  measureTool,
  fibRetracementTool,
  rectangleTool,
  textTool,
];

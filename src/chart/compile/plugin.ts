// Custom-mark plugin boundary: isolated scale facades, domain resolution,
// compile invocation, and validation of everything a plugin returns.

import type { AnyScale, BandScale, LinearScale } from "../scales";
import type { MarkCompileContext } from "./context";
import { ChartCompileError } from "./errors";
import { isPluginMark, type ChartMark, type PluginChartMark } from "./marks";
import { isBandCategory } from "./shared";
import type {
  ChartMarkPluginBandScale,
  ChartMarkPluginLinearScale,
  ChartMarkPluginResult,
  ChartMarkPluginScale,
  HoverSample,
  LastValue,
  MarkDomainContribution,
} from "./types";

function isolatePluginScale(scale: AnyScale): ChartMarkPluginScale {
  const snapshot = scale.copy();
  if (snapshot.kind === "band") {
    const band = snapshot as BandScale<string | number>;
    const domain = Object.freeze([...band.domain]) as readonly (string | number)[];
    const range = Object.freeze([...band.range]) as unknown as readonly [number, number];
    return Object.freeze({
      kind: "band" as const,
      domain,
      range,
      padding: band.padding,
      map: (value: string | number) => band.map(value),
      start: (value: string | number) => band.start(value),
      bandwidth: () => band.bandwidth(),
      copy: () => isolatePluginScale(band.copy()) as ChartMarkPluginBandScale,
    });
  }
  const linear = snapshot as LinearScale;
  const domain = Object.freeze([...linear.domain]) as unknown as readonly [number, number];
  const range = Object.freeze([...linear.range]) as unknown as readonly [number, number];
  return Object.freeze({
    kind: "linear" as const,
    domain,
    range,
    map: (value: number) => linear.map(value),
    invert: (px: number) => linear.invert(px),
    ticks: (count?: number) => linear.ticks(count),
    copy: () => isolatePluginScale(linear.copy()) as ChartMarkPluginLinearScale,
  });
}

function validatePluginDomainContribution(value: unknown): MarkDomainContribution {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("domain() must return an object.");
  }
  const domain = value as { x?: unknown; y?: unknown; includeZero?: unknown };
  for (const key of Object.keys(value)) {
    if (!new Set(["x", "y", "includeZero"]).has(key)) {
      throw new TypeError(`domain() returned unsupported field "${key}".`);
    }
  }
  if (domain.x !== undefined) {
    if (!Array.isArray(domain.x)) throw new TypeError("domain().x must be an array.");
    for (const entry of domain.x) {
      if (!isBandCategory(entry) && !(entry instanceof Date)) {
        throw new TypeError(`domain().x contains an unsupported value (${String(entry)}).`);
      }
    }
  }
  if (domain.y !== undefined) {
    if (!Array.isArray(domain.y)) throw new TypeError("domain().y must be an array.");
    if (!domain.y.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
      throw new TypeError("domain().y must contain finite numbers only.");
    }
  }
  if (domain.includeZero !== undefined && typeof domain.includeZero !== "boolean") {
    throw new TypeError("domain().includeZero must be boolean.");
  }
  return domain as MarkDomainContribution;
}

/** Ask every plugin mark for its domain contribution, wrapping failures with context. */
export function resolvePluginDomains(marks: readonly ChartMark[]): Map<ChartMark, MarkDomainContribution> {
  const pluginDomains = new Map<ChartMark, MarkDomainContribution>();
  for (const mark of marks) {
    if (!isPluginMark(mark)) continue;
    if (mark.plugin.kind !== mark.kind) {
      throw new ChartCompileError(
        "E_MARK_PLUGIN_MISMATCH",
        `Mark kind "${mark.kind}" does not match plugin kind "${mark.plugin.kind}".`,
      );
    }
    try {
      const contribution = mark.plugin.domain
        ? mark.plugin.domain(mark.data, mark.pluginOptions)
        : {};
      pluginDomains.set(mark, validatePluginDomainContribution(contribution));
    } catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : "";
      throw new ChartCompileError(
        "E_MARK_PLUGIN_DOMAIN",
        `Failed to resolve domain for "${mark.kind}".${detail}`,
        { cause: error },
      );
    }
  }
  return pluginDomains;
}

const SCENE_NODE_TYPES = new Set(["line", "area", "rect", "circle", "rule", "arc", "polygon", "text"]);
const SCENE_NODE_KEYS = new Set([
  "type", "x", "y", "x2", "y2", "w", "h", "r", "innerR", "startAngle", "endAngle", "points",
  "stroke", "fill", "fillOpacity", "strokeWidth", "dashed", "datum", "series", "label", "anchor",
  "fontSize", "corner", "tip", "clip", "hit", "role", "idx", "highlight", "valueY",
]);

function pluginResultError(kind: string, detail: string): never {
  throw new ChartCompileError("E_MARK_PLUGIN_RESULT", `Mark plugin "${kind}" ${detail}`);
}

function validatePluginResult(value: unknown, kind: string): asserts value is ChartMarkPluginResult {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    pluginResultError(kind, "must return an object.");
  }
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) {
    if (!["nodes", "legend", "samples", "lastValues"].includes(key)) {
      pluginResultError(kind, `returned unsupported field "${key}".`);
    }
  }
  if (!Array.isArray(result.nodes)) pluginResultError(kind, "must return a nodes array.");
  for (let index = 0; index < result.nodes.length; index++) {
    const raw = result.nodes[index];
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
      pluginResultError(kind, `returned an invalid node at index ${index}.`);
    }
    const node = raw as Record<string, unknown>;
    for (const key of Object.keys(node)) {
      if (!SCENE_NODE_KEYS.has(key)) {
        pluginResultError(kind, `returned unsupported node field "${key}" at index ${index}.`);
      }
    }
    if (!SCENE_NODE_TYPES.has(node.type as string)) {
      pluginResultError(kind, `returned an unknown node type at index ${index} (${String(node.type)}).`);
    }
    const requiredByType: Record<string, readonly string[]> = {
      line: ["points"], area: ["points"], polygon: ["points"],
      rect: ["x", "y", "w", "h"], circle: ["x", "y", "r"],
      rule: ["x", "y", "x2", "y2"],
      arc: ["x", "y", "r", "innerR", "startAngle", "endAngle"],
      text: ["x", "y", "label"],
    };
    const nodeType = node.type as string;
    if (nodeType === "line" || nodeType === "area" || nodeType === "polygon") {
      if (!Array.isArray(node.points) || node.points.length === 0 || node.points.some((point) => (
        point == null
        || typeof point !== "object"
        || !Number.isFinite((point as { x?: unknown }).x)
        || !Number.isFinite((point as { y?: unknown }).y)
      ))) {
        pluginResultError(kind, `returned invalid points for ${nodeType} node ${index}.`);
      }
    } else {
      for (const field of requiredByType[nodeType] ?? []) {
        if (field === "label") {
          if (typeof node[field] !== "string") pluginResultError(kind, `requires a string ${field} on node ${index}.`);
        } else if (typeof node[field] !== "number" || !Number.isFinite(node[field])) {
          pluginResultError(kind, `requires a finite ${field} on node ${index}.`);
        }
      }
    }
    if (node.points !== undefined && nodeType !== "line" && nodeType !== "area" && nodeType !== "polygon") {
      pluginResultError(kind, `returned points for incompatible ${nodeType} node ${index}.`);
    }
    for (const field of ["x", "y", "x2", "y2", "w", "h", "r", "innerR", "startAngle", "endAngle", "fillOpacity", "strokeWidth", "fontSize", "idx", "valueY"] as const) {
      if (node[field] !== undefined && (typeof node[field] !== "number" || !Number.isFinite(node[field]))) {
        pluginResultError(kind, `returned non-finite ${field} on node ${index}.`);
      }
    }
    for (const field of ["w", "h", "r", "innerR", "strokeWidth", "fontSize"] as const) {
      if (typeof node[field] === "number" && node[field] < 0) {
        pluginResultError(kind, `returned negative ${field} on node ${index}.`);
      }
    }
    if (typeof node.fillOpacity === "number" && (node.fillOpacity < 0 || node.fillOpacity > 1)) {
      pluginResultError(kind, `returned fillOpacity outside [0, 1] on node ${index}.`);
    }
    if (typeof node.idx === "number" && (!Number.isInteger(node.idx) || node.idx < 0)) {
      pluginResultError(kind, `returned a non-integer or negative idx on node ${index}.`);
    }
    for (const field of ["stroke", "fill", "series", "label", "tip", "role"] as const) {
      if (node[field] !== undefined && typeof node[field] !== "string") {
        pluginResultError(kind, `returned a non-string ${field} on node ${index}.`);
      }
    }
    if (node.anchor !== undefined && !["start", "middle", "end"].includes(node.anchor as string)) {
      pluginResultError(kind, `returned an invalid anchor on node ${index}.`);
    }
    if (node.corner !== undefined && !["all", "top", "bottom", "none"].includes(node.corner as string)) {
      pluginResultError(kind, `returned an invalid corner on node ${index}.`);
    }
    for (const field of ["dashed", "clip", "hit", "highlight"] as const) {
      if (node[field] !== undefined && typeof node[field] !== "boolean") {
        pluginResultError(kind, `returned a non-boolean ${field} on node ${index}.`);
      }
    }
    if ((nodeType === "circle" || nodeType === "arc") && (node.r as number) < 0) {
      pluginResultError(kind, `returned a negative radius on node ${index}.`);
    }
    if (nodeType === "arc" && ((node.innerR as number) < 0 || (node.innerR as number) > (node.r as number))) {
      pluginResultError(kind, `returned an invalid inner radius on node ${index}.`);
    }
  }
  for (const field of ["legend", "samples", "lastValues"] as const) {
    if (result[field] !== undefined && !Array.isArray(result[field])) {
      pluginResultError(kind, `must return ${field} as an array when provided.`);
    }
  }
  for (const item of (result.legend as unknown[] | undefined) ?? []) {
    if (item == null || typeof item !== "object" || Array.isArray(item)) {
      pluginResultError(kind, "returned an invalid legend item.");
    }
    const candidate = item as Record<string, unknown>;
    if (Object.keys(candidate).some((key) => !["name", "color", "detail"].includes(key))
      || typeof candidate.name !== "string"
      || typeof candidate.color !== "string"
      || (candidate.detail !== undefined && typeof candidate.detail !== "string")) {
      pluginResultError(kind, "returned an invalid legend item.");
    }
  }
  for (const sample of (result.samples as unknown[] | undefined) ?? []) {
    const candidate = sample as (Partial<HoverSample> & Record<string, unknown>) | null;
    if (!candidate
      || Array.isArray(candidate)
      || Object.keys(candidate).some((key) => !["x", "y", "series", "color", "tip", "kind"].includes(key))
      || !Number.isFinite(candidate.x)
      || !Number.isFinite(candidate.y)
      || typeof candidate.series !== "string"
      || typeof candidate.color !== "string"
      || typeof candidate.tip !== "string"
      || !["line", "point", "radar"].includes(candidate.kind as string)) {
      pluginResultError(kind, "returned an invalid hover sample.");
    }
  }
  for (const last of (result.lastValues as unknown[] | undefined) ?? []) {
    const candidate = last as (Partial<LastValue> & Record<string, unknown>) | null;
    if (!candidate
      || Array.isArray(candidate)
      || Object.keys(candidate).some((key) => !["y", "label", "color", "dash"].includes(key))
      || !Number.isFinite(candidate.y)
      || typeof candidate.label !== "string"
      || typeof candidate.color !== "string"
      || (candidate.dash !== undefined && typeof candidate.dash !== "boolean")) {
      pluginResultError(kind, "returned an invalid last value.");
    }
  }
}

/** Compile one plugin mark against frozen snapshots and append its validated output. */
export function compilePluginMark(ctx: MarkCompileContext, m: PluginChartMark, name: string, color: string): void {
  const { nodes, legend, samples, lastValues } = ctx;
  let output: unknown;
  try {
    output = m.plugin.compile({
      data: m.data,
      options: m.pluginOptions,
      width: ctx.width,
      height: ctx.height,
      plot: Object.freeze({ ...ctx.plot }),
      xScale: isolatePluginScale(ctx.xScale),
      yScale: isolatePluginScale(ctx.yScale),
      theme: Object.freeze({ ...ctx.theme }),
      color,
      name,
      mapX: ctx.mapXValue,
      mapY: ctx.mapYValue,
    });
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new ChartCompileError(
      "E_MARK_PLUGIN_COMPILE",
      `Failed to compile "${m.kind}".${detail}`,
      { cause: error },
    );
  }
  validatePluginResult(output, m.kind);
  for (const node of output.nodes) nodes.push(node);
  for (const item of output.legend ?? [{ name, color }]) legend.push(item);
  if (output.samples) for (const sample of output.samples) samples.push(sample);
  if (output.lastValues) for (const value of output.lastValues) lastValues.push(value);
}

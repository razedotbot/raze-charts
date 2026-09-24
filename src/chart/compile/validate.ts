// Runtime validation of definitions received through JavaScript or dynamic
// configuration. Every failure is a ChartCompileError with a stable code.

import { ChartCompileError } from "./errors";
import {
  BUILTIN_MARK_KINDS,
  isBuiltinKind,
  isPluginMark,
  type BuiltinChartMark,
  type ChartMark,
} from "./marks";
import { asNumber, isBandCategory, isRecord, isRuntimeArray, readChannel, stackKey } from "./shared";
import type { ChartPerformanceOptions, ChartSpec, MarkKind } from "./types";

const BUILTIN_MARK_KEYS: Record<MarkKind, ReadonlySet<string>> = {
  line: new Set(["kind", "data", "x", "y", "name", "stroke", "strokeWidth", "lastValue", "dashed", "curve"]),
  area: new Set(["kind", "data", "x", "y", "y0", "name", "stroke", "fill", "fillOpacity", "strokeWidth", "lastValue", "dashed", "curve"]),
  bar: new Set(["kind", "data", "x", "y", "name", "fill", "stackId", "lastValue", "fade"]),
  point: new Set(["kind", "data", "x", "y", "name", "fill", "fillOpacity", "r"]),
  ruleY: new Set(["kind", "data", "y", "name", "stroke", "strokeWidth"]),
  ruleX: new Set(["kind", "data", "x", "name", "stroke", "strokeWidth"]),
  pie: new Set(["kind", "data", "name", "valueKey", "labelKey", "innerRadius", "outerRadius"]),
  radar: new Set(["kind", "data", "x", "y", "name", "stroke", "fill", "fillOpacity", "strokeWidth"]),
  heatmap: new Set(["kind", "data", "x", "y", "name", "valueKey", "valueFormat"]),
};

function validateBuiltinMarkOptions(mark: BuiltinChartMark, index: number): void {
  const allowed = BUILTIN_MARK_KEYS[mark.kind];
  const values = mark as unknown as Record<string, unknown>;
  for (const key of Object.keys(mark)) {
    if (!allowed.has(key)) {
      throw new ChartCompileError(
        "E_MARK_OPTION",
        `marks[${index}] (${mark.kind}) does not support option "${key}". Use a compatible mark or a custom plugin.`,
      );
    }
  }
  for (const key of ["x", "y", "valueKey", "labelKey"] as const) {
    const value = values[key];
    if (value !== undefined && typeof value !== "string" && typeof value !== "function") {
      throw new ChartCompileError("E_MARK_CHANNEL", `marks[${index}].${key} must be a property name or accessor function.`);
    }
  }
  if (mark.name !== undefined && typeof mark.name !== "string") {
    throw new ChartCompileError("E_MARK_OPTION", `marks[${index}].name must be a string.`);
  }
  for (const key of ["stroke", "fill"] as const) {
    const value = values[key];
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      throw new ChartCompileError("E_MARK_OPTION", `marks[${index}].${key} must be a non-empty CSS color string.`);
    }
  }
  const stackId = values.stackId;
  if (stackId !== undefined && (typeof stackId !== "string" || !stackId.trim())) {
    throw new ChartCompileError("E_MARK_OPTION", `marks[${index}].stackId must be a non-empty string.`);
  }
  for (const key of ["strokeWidth", "r"] as const) {
    const value = values[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      throw new ChartCompileError("E_MARK_OPTION", `marks[${index}].${key} must be a finite non-negative number.`);
    }
  }
  const fillOpacity = values.fillOpacity;
  if (fillOpacity !== undefined && (
    typeof fillOpacity !== "number" || !Number.isFinite(fillOpacity) || fillOpacity < 0 || fillOpacity > 1
  )) {
    throw new ChartCompileError("E_MARK_OPTION", `marks[${index}].fillOpacity must be a finite number in [0, 1].`);
  }
  for (const key of ["lastValue", "dashed", "fade"] as const) {
    const value = values[key];
    if (value !== undefined && typeof value !== "boolean") {
      throw new ChartCompileError("E_MARK_OPTION", `marks[${index}].${key} must be boolean.`);
    }
  }
  const curve = values.curve;
  if (curve !== undefined && curve !== "monotone" && curve !== "linear" && curve !== "step") {
    throw new ChartCompileError("E_MARK_OPTION", `marks[${index}].curve must be "monotone", "linear", or "step".`);
  }
  if (values.y0 !== undefined && typeof values.y0 !== "string" && typeof values.y0 !== "function") {
    throw new ChartCompileError("E_MARK_CHANNEL", `marks[${index}].y0 must be a property name or accessor function.`);
  }
}

type RuntimeScaleSpec = {
  type?: unknown;
  nice?: unknown;
  padding?: unknown;
  domain?: unknown;
  tickFormat?: unknown;
};

function validateScaleSpec(
  axis: "x" | "y",
  value: unknown,
  heatmap: boolean,
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw new ChartCompileError("E_SCALE_TYPE", `scales.${axis} must be a scale configuration object.`);
  }
  const scale = value as RuntimeScaleSpec;
  for (const key of Object.keys(value)) {
    if (!["type", "nice", "padding", "domain", "tickFormat", "labels"].includes(key)) {
      throw new ChartCompileError("E_SCALE_TYPE", `scales.${axis} does not support option "${key}".`);
    }
  }
  const type = scale.type;
  const allowed = heatmap
    ? new Set<unknown>(axis === "x" ? ["band"] : ["band"])
    : axis === "x"
      ? new Set<unknown>(["linear", "band", "time", "log"])
      : new Set<unknown>([undefined, "linear", "log"]);
  if (!allowed.has(type)) {
    const supported = heatmap
      ? '"band"'
      : axis === "x"
        ? '"linear", "band", "time", or "log"'
        : '"linear" or "log"';
    throw new ChartCompileError(
      "E_SCALE_TYPE",
      `scales.${axis}.type must be ${supported}; received ${String(type)}.`,
    );
  }
  const isBand = heatmap || type === "band";
  if (isBand) {
    if (scale.nice !== undefined) {
      throw new ChartCompileError("E_SCALE_TYPE", `scales.${axis}.nice is not supported by band scales.`);
    }
    if (
      scale.padding !== undefined
      && (typeof scale.padding !== "number" || !Number.isFinite(scale.padding) || scale.padding < 0 || scale.padding >= 1)
    ) {
      throw new ChartCompileError(
        "E_SCALE_DOMAIN",
        `scales.${axis}.padding must be a finite number in [0, 1); received ${String(scale.padding)}.`,
      );
    }
    if (scale.domain !== undefined) {
      if (!isRuntimeArray(scale.domain)) {
        throw new ChartCompileError("E_SCALE_DOMAIN", `scales.${axis}.domain must be an array for a band scale.`);
      }
      for (const entry of scale.domain as readonly unknown[]) {
        if ((typeof entry !== "string" && typeof entry !== "number") || (typeof entry === "number" && !Number.isFinite(entry))) {
          throw new ChartCompileError(
            "E_SCALE_DOMAIN",
            `scales.${axis}.domain contains an invalid category (${String(entry)}). Use finite numbers or strings.`,
          );
        }
      }
      const categories = scale.domain as readonly (string | number)[];
      if (new Set(categories).size !== categories.length) {
        throw new ChartCompileError("E_SCALE_DOMAIN", `scales.${axis}.domain cannot contain duplicate categories.`);
      }
    }
    validateTickFormat(axis, scale.tickFormat);
    return;
  }
  if (scale.padding !== undefined) {
    throw new ChartCompileError("E_SCALE_TYPE", `scales.${axis}.padding is supported by band scales only.`);
  }
  if ((type === "log" || type === "time") && scale.nice !== undefined) {
    throw new ChartCompileError("E_SCALE_TYPE", `scales.${axis}.nice is not supported by ${type} scales.`);
  }
  if (scale.nice !== undefined && typeof scale.nice !== "boolean") {
    throw new ChartCompileError("E_SCALE_TYPE", `scales.${axis}.nice must be boolean when provided.`);
  }
  if (scale.domain !== undefined) {
    if (!isRuntimeArray(scale.domain) || (scale.domain as readonly unknown[]).length !== 2) {
      throw new ChartCompileError(
        "E_SCALE_DOMAIN",
        `scales.${axis}.domain must contain exactly two endpoints for a quantitative scale.`,
      );
    }
    const endpoints = scale.domain as readonly unknown[];
    const numeric = endpoints.map(asNumber);
    if (!numeric.every(Number.isFinite)) {
      throw new ChartCompileError(
        "E_SCALE_DOMAIN",
        `scales.${axis}.domain endpoints must be finite numbers or Dates.`,
      );
    }
    if (numeric[0] === numeric[1]) {
      throw new ChartCompileError(
        "E_SCALE_DOMAIN",
        `scales.${axis}.domain endpoints must be distinct.`,
      );
    }
    if (type === "log" && numeric.some((entry) => entry <= 0)) {
      throw new ChartCompileError(
        "E_SCALE_DOMAIN",
        `scales.${axis}.domain endpoints must be greater than zero for a log scale.`,
      );
    }
  }
  validateTickFormat(axis, scale.tickFormat);
}

function validateTickFormat(axis: "x" | "y", tickFormat: unknown): void {
  if (tickFormat !== undefined && typeof tickFormat !== "function") {
    throw new ChartCompileError("E_SCALE_TYPE", `scales.${axis}.tickFormat must be a function when provided.`);
  }
}

/** Top-level ChartSpec fields: size, toggles, margin, containers, theme, a11y, viewport, performance. */
function validateChartOptions(spec: ChartSpec, width: number, height: number): void {
  const allowedSpecKeys = new Set([
    "marks", "scales", "width", "height", "margin", "grid", "tooltip", "legend",
    "ariaLabel", "ariaDescription", "performance", "theme", "viewport", "hiddenSeries",
  ]);
  for (const key of Object.keys(spec)) {
    if (!allowedSpecKeys.has(key)) {
      throw new ChartCompileError("E_CHART_SPEC", `ChartSpec does not support option "${key}".`);
    }
  }
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new ChartCompileError(
      "E_CHART_SIZE",
      `Chart width and height must be finite positive numbers; received ${String(width)}×${String(height)}.`,
    );
  }
  for (const key of ["width", "height"] as const) {
    const value = spec[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
      throw new ChartCompileError("E_CHART_SIZE", `ChartSpec.${key} must be a finite positive number when provided.`);
    }
  }
  for (const key of ["grid", "tooltip", "legend"] as const) {
    const value = spec[key];
    if (value !== undefined && typeof value !== "boolean") {
      throw new ChartCompileError("E_CHART_SPEC", `ChartSpec.${key} must be boolean when provided.`);
    }
  }
  if (spec.margin !== undefined) {
    if (!isRecord(spec.margin)) {
      throw new ChartCompileError("E_CHART_SPEC", "ChartSpec.margin must be an object when provided.");
    }
    for (const key of Object.keys(spec.margin)) {
      if (!["top", "right", "bottom", "left"].includes(key)) {
        throw new ChartCompileError("E_CHART_SPEC", `ChartSpec.margin does not support option "${key}".`);
      }
      const value = (spec.margin as Record<string, unknown>)[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new ChartCompileError("E_CHART_SIZE", `ChartSpec.margin.${key} must be a finite non-negative number.`);
      }
    }
  }
  if (spec.scales !== undefined) {
    if (!isRecord(spec.scales)) {
      throw new ChartCompileError("E_SCALE_TYPE", "ChartSpec.scales must be an object when provided.");
    }
    for (const key of Object.keys(spec.scales)) {
      if (key !== "x" && key !== "y") {
        throw new ChartCompileError("E_SCALE_TYPE", `ChartSpec.scales does not support axis "${key}".`);
      }
    }
  }
  if (spec.performance !== undefined) {
    if (!isRecord(spec.performance)) {
      throw new ChartCompileError("E_CHART_PERFORMANCE", "ChartSpec.performance must be an object when provided.");
    }
    for (const key of Object.keys(spec.performance)) {
      if (key !== "decimation" && key !== "maxRenderedPoints") {
        throw new ChartCompileError("E_CHART_PERFORMANCE", `ChartSpec.performance does not support option "${key}".`);
      }
    }
  }
  if (spec.theme !== undefined && spec.theme !== "dark" && spec.theme !== "light") {
    if (!isRecord(spec.theme)) {
      throw new ChartCompileError("E_CHART_SPEC", "ChartSpec.theme must be \"dark\", \"light\", or a theme object.");
    }
    const themeKeys = new Set([
      "background", "text", "muted", "grid", "axis", "crosshair", "font", "accent", "down", "gold", "sky",
      "heatZero", "chipBg", "chipFg", "lastChipFg",
    ]);
    for (const key of Object.keys(spec.theme)) {
      const value = (spec.theme as Record<string, unknown>)[key];
      if (!themeKeys.has(key)) {
        throw new ChartCompileError("E_CHART_SPEC", `ChartSpec.theme does not support token "${key}".`);
      }
      if (typeof value !== "string" || !value.trim()) {
        throw new ChartCompileError("E_CHART_SPEC", `ChartSpec.theme.${key} must be a non-empty string.`);
      }
    }
  }
  if (spec.ariaLabel !== undefined && typeof spec.ariaLabel !== "string") {
    throw new ChartCompileError("E_CHART_SPEC", "ChartSpec.ariaLabel must be a string when provided.");
  }
  if (spec.ariaDescription !== undefined && typeof spec.ariaDescription !== "string") {
    throw new ChartCompileError("E_CHART_SPEC", "ChartSpec.ariaDescription must be a string when provided.");
  }
  if (spec.hiddenSeries !== undefined) {
    if (!isRuntimeArray(spec.hiddenSeries) || spec.hiddenSeries.some((name) => typeof name !== "string")) {
      throw new ChartCompileError("E_CHART_SPEC", "ChartSpec.hiddenSeries must be an array of strings when provided.");
    }
  }
  if (spec.viewport !== undefined) {
    const viewport = spec.viewport;
    for (const key of Object.keys(viewport)) {
      if (key !== "x" && key !== "y") {
        throw new ChartCompileError("E_CHART_SPEC", `ChartSpec.viewport does not support option "${key}".`);
      }
    }
    if (viewport.x !== undefined) {
      if (!isRuntimeArray(viewport.x) || viewport.x.length < 1) {
        throw new ChartCompileError("E_CHART_SPEC", "ChartSpec.viewport.x must be a non-empty range.");
      }
    }
    if (viewport.y !== undefined) {
      const y = viewport.y;
      if (!isRuntimeArray(y) || y.length !== 2 || !y.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw new ChartCompileError("E_CHART_SPEC", "ChartSpec.viewport.y must be a [min, max] numeric pair.");
      }
    }
  }
  const performance = spec.performance as ChartPerformanceOptions | undefined;
  const maxRenderedPoints = performance?.maxRenderedPoints;
  const decimation = performance?.decimation;
  if (decimation !== undefined && decimation !== "auto" && decimation !== "none") {
    throw new ChartCompileError(
      "E_CHART_PERFORMANCE",
      `performance.decimation must be "auto" or "none"; received ${String(decimation)}.`,
    );
  }
  if (
    maxRenderedPoints !== undefined
    && (!Number.isFinite(maxRenderedPoints) || maxRenderedPoints < 1)
  ) {
    throw new ChartCompileError(
      "E_CHART_PERFORMANCE",
      `performance.maxRenderedPoints must be a finite number greater than or equal to 1; received ${String(maxRenderedPoints)}.`,
    );
  }
}

/** One mark: data, kind/plugin identity, options, required channels, and kind-specific data rules. */
function validateMark(mark: ChartMark, index: number): void {
  if (!mark || !isRuntimeArray(mark.data)) {
    throw new ChartCompileError("E_MARK_DATA", `marks[${index}].data must be an array.`);
  }
  if (!BUILTIN_MARK_KINDS.has(mark.kind as MarkKind) && !mark.plugin) {
    throw new ChartCompileError(
      "E_MARK_KIND",
      `marks[${index}] uses unknown kind "${String(mark.kind)}". Register it with defineMarkPlugin() and customMark().`,
    );
  }
  if (isPluginMark(mark)) {
    if (
      typeof mark.kind !== "string"
      || !mark.kind.trim()
      || typeof mark.plugin.kind !== "string"
      || !mark.plugin.kind.trim()
      || BUILTIN_MARK_KINDS.has(mark.kind as MarkKind)
    ) {
      throw new ChartCompileError(
        "E_MARK_PLUGIN_KIND",
        `marks[${index}] must use a non-empty custom kind that does not collide with the built-in grammar.`,
      );
    }
    if (mark.plugin.kind !== mark.kind) {
      throw new ChartCompileError(
        "E_MARK_PLUGIN_MISMATCH",
        `Mark kind "${mark.kind}" does not match plugin kind "${mark.plugin.kind}".`,
      );
    }
    const pluginKeys = new Set(["kind", "data", "plugin", "pluginOptions", "name", "stroke", "fill"]);
    for (const key of Object.keys(mark)) {
      if (!pluginKeys.has(key)) {
        throw new ChartCompileError(
          "E_MARK_OPTION",
          `marks[${index}] (${mark.kind}) must pass custom fields inside pluginOptions; unsupported top-level field "${key}".`,
        );
      }
    }
    return;
  }
  if (Object.prototype.hasOwnProperty.call(mark, "y0") && mark.kind !== "area") {
    throw new ChartCompileError(
      "E_MARK_CHANNEL",
      `marks[${index}] (${mark.kind}) uses unsupported channel y0. Model ranged areas with an area mark or a custom mark plugin.`,
    );
  }
  validateBuiltinMarkOptions(mark as BuiltinChartMark, index);
  const needsXY = mark.kind === "line"
    || mark.kind === "area"
    || mark.kind === "bar"
    || mark.kind === "point"
    || mark.kind === "radar"
    || mark.kind === "heatmap";
  if (needsXY && (mark.x == null || mark.y == null)) {
    throw new ChartCompileError(
      "E_MARK_CHANNEL",
      `marks[${index}] (${mark.kind}) requires both x and y channels. Use the typed ${mark.kind}() builder when possible.`,
    );
  }
  if (mark.kind === "ruleY" && mark.y == null) {
    throw new ChartCompileError("E_MARK_CHANNEL", `marks[${index}] (ruleY) requires a y channel.`);
  }
  if (mark.kind === "ruleX" && mark.x == null) {
    throw new ChartCompileError("E_MARK_CHANNEL", `marks[${index}] (ruleX) requires an x channel.`);
  }
  if (mark.kind === "pie" && mark.valueKey == null) {
    throw new ChartCompileError(
      "E_MARK_CHANNEL",
      `marks[${index}] (pie) requires valueKey. Use pie(data, { valueKey, labelKey }).`,
    );
  }
  if (mark.kind === "heatmap" && mark.valueKey == null) {
    throw new ChartCompileError(
      "E_MARK_CHANNEL",
      `marks[${index}] (heatmap) requires valueKey in addition to x and y.`,
    );
  }
  if (mark.kind === "pie") {
    for (const radius of ["innerRadius", "outerRadius"] as const) {
      const value = mark[radius];
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        throw new ChartCompileError(
          "E_MARK_CHANNEL",
          `marks[${index}].${radius} must be a finite non-negative number; received ${String(value)}.`,
        );
      }
    }
    if (
      mark.innerRadius !== undefined
      && mark.outerRadius !== undefined
      && mark.innerRadius > mark.outerRadius
    ) {
      throw new ChartCompileError(
        "E_MARK_CHANNEL",
        `marks[${index}].innerRadius cannot exceed outerRadius.`,
      );
    }
    for (let rowIndex = 0; rowIndex < mark.data.length; rowIndex++) {
      const value = asNumber(readChannel(mark.data[rowIndex] as never, mark.valueKey as never));
      if (Number.isFinite(value) && value < 0) {
        throw new ChartCompileError(
          "E_MARK_DATA",
          `marks[${index}] (pie) requires non-negative values; row ${rowIndex} resolved to ${String(value)}.`,
        );
      }
    }
  }
  if (mark.kind === "radar") {
    if (mark.data.length > 0 && mark.data.length < 3) {
      throw new ChartCompileError("E_MARK_DATA", `marks[${index}] (radar) requires at least three axes.`);
    }
    const axes = new Set<string>();
    for (let rowIndex = 0; rowIndex < mark.data.length; rowIndex++) {
      const axis = readChannel(mark.data[rowIndex] as never, mark.x as never);
      if (!isBandCategory(axis)) {
        throw new ChartCompileError(
          "E_MARK_DATA",
          `marks[${index}] (radar) requires string or finite-number axis labels; row ${rowIndex} is invalid.`,
        );
      }
      const axisKey = stackKey("radar-axis", axis);
      if (axes.has(axisKey)) {
        throw new ChartCompileError("E_MARK_DATA", `marks[${index}] (radar) contains duplicate axis ${JSON.stringify(axis)}.`);
      }
      axes.add(axisKey);
      const value = asNumber(readChannel(mark.data[rowIndex] as never, mark.y as never));
      if (!Number.isFinite(value) || value < 0) {
        throw new ChartCompileError(
          "E_MARK_DATA",
          `marks[${index}] (radar) requires finite non-negative values; row ${rowIndex} resolved to ${String(value)}.`,
        );
      }
    }
  }
}

/** Heatmap and pie stand alone; radar overlays only radar; polar charts take no Cartesian scales. */
function validateComposition(spec: ChartSpec): void {
  const heatmaps = spec.marks.filter((mark) => isBuiltinKind(mark, "heatmap"));
  if (heatmaps.length && (heatmaps.length !== 1 || spec.marks.length !== 1)) {
    throw new ChartCompileError(
      "E_CHART_COMPOSITION",
      "Heatmap uses two categorical axes and must be the chart's only mark. Compose annotations inside a custom mark plugin or a sibling chart.",
    );
  }
  const pies = spec.marks.filter((mark) => isBuiltinKind(mark, "pie"));
  if (pies.length && (pies.length !== 1 || spec.marks.length !== 1)) {
    throw new ChartCompileError(
      "E_CHART_COMPOSITION",
      "Pie uses polar layout and must be the chart's only mark. Use one pie per chart mount.",
    );
  }
  const radars = spec.marks.filter((mark) => isBuiltinKind(mark, "radar"));
  if (radars.length && radars.length !== spec.marks.length) {
    throw new ChartCompileError(
      "E_CHART_COMPOSITION",
      "Radar marks can overlay other radar series, but cannot share a chart with Cartesian, heatmap, pie, or plugin marks.",
    );
  }
  if (radars.length > 1) {
    const canonicalAxes = radars[0]!.data.map((row) => stackKey(
      "radar-axis",
      readChannel(row as never, radars[0]!.x as never),
    ));
    for (let index = 1; index < radars.length; index++) {
      const axes = radars[index]!.data.map((row) => stackKey(
        "radar-axis",
        readChannel(row as never, radars[index]!.x as never),
      ));
      if (axes.length !== canonicalAxes.length || axes.some((axis, at) => axis !== canonicalAxes[at])) {
        throw new ChartCompileError(
          "E_CHART_COMPOSITION",
          `Radar series ${index + 1} must use the same category order as the first radar series.`,
        );
      }
    }
  }
  if ((pies.length || radars.length) && (spec.scales?.x !== undefined || spec.scales?.y !== undefined)) {
    throw new ChartCompileError(
      "E_SCALE_TYPE",
      "Polar charts derive their geometry from values and do not accept Cartesian scales. Remove ChartSpec.scales.",
    );
  }
}

export function validateChartSpec(spec: ChartSpec, width: number, height: number): void {
  if (!isRecord(spec) || !isRuntimeArray(spec.marks)) {
    throw new ChartCompileError("E_CHART_SPEC", "ChartSpec.marks must be an array.");
  }
  validateChartOptions(spec, width, height);
  const hasHeatmap = spec.marks.some((mark) => mark?.kind === "heatmap");
  validateScaleSpec("x", spec.scales?.x, hasHeatmap);
  validateScaleSpec("y", spec.scales?.y, hasHeatmap);
  for (let index = 0; index < spec.marks.length; index++) validateMark(spec.marks[index]!, index);
  validateComposition(spec);
}

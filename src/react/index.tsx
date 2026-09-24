import {
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  Children,
  Fragment,
  cloneElement,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  area,
  bar,
  createViewportGroup,
  defineChart,
  heatmap,
  line,
  mountChart,
  pie,
  point,
  radar,
  ruleX,
  ruleY,
  type ChartDefinition,
  type ChartMark,
  type ChartViewport,
  type CompiledChart,
  type MountChartOptions,
  type MountHandle,
  type ViewportGroup,
  type ViewportHandle,
} from "../chart";

export type DeepReadonly<T> =
  T extends (...args: infer TArgs) => infer TResult
    ? (...args: TArgs) => DeepReadonly<TResult>
    : T extends readonly unknown[]
      ? { readonly [TIndex in keyof T]: DeepReadonly<T[TIndex]> }
      : T extends object
        ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
        : T;

/** A detached renderer-neutral snapshot. Mutating it can never mutate the mounted chart. */
export type ReactChartSnapshot = DeepReadonly<CompiledChart>;

/** Width and height are owned by Chart props (or ResponsiveContainer), never by host CSS. */
export type ChartHostStyle = Omit<CSSProperties, "width" | "height"> & {
  readonly width?: never;
  readonly height?: never;
};

export interface ChartProps {
  definition: ChartDefinition;
  width?: number;
  height?: number;
  renderer?: NonNullable<MountChartOptions["renderer"]>;
  ariaLabel?: string;
  ariaDescription?: string;
  idPrefix?: string;
  className?: string;
  style?: ChartHostStyle;
  onReady?: (chart: ReactChartHandle) => void;
  /**
   * Compared by value: an inline `{ zoom: true }` literal on every render does
   * not recompile the chart.
   */
  interaction?: MountChartOptions["interaction"];
  /** Controlled window, compared by value (Dates by time). Omit to let users pan and zoom freely. */
  viewport?: ChartViewport;
  /** Latest callback always wins; changing its identity never recompiles the chart. */
  onViewportChange?: NonNullable<MountChartOptions["onViewportChange"]>;
  /** Latest callback always wins; changing its identity never recompiles the chart. */
  onSelect?: NonNullable<MountChartOptions["onSelect"]>;
  /**
   * Join a host-owned group from `createViewportGroup()`: a pan, zoom, brush or
   * range preset on any member moves every other member to the same window.
   * The chart joins on mount and leaves on unmount.
   */
  viewportGroup?: ViewportGroup;
  /**
   * Recharts-style shorthand for `viewportGroup`: charts rendered with the same
   * `syncId` share one viewport group. Use either prop, not both.
   */
  syncId?: string;
}

/**
 * React owns the mount lifecycle. Consumers receive detached, immutable scene
 * snapshots plus viewport control, so the handle can join a `ViewportGroup`
 * (`group.add(handle)`) or drive the window from host UI.
 */
export interface ReactChartHandle extends ViewportHandle {
  getSnapshot(): ReactChartSnapshot | null;
  /** Compatibility alias for getSnapshot(). */
  getScene(): ReactChartSnapshot | null;
  /**
   * Move the chart to `viewport`, or back to its full domain with `null`.
   * Programmatic changes do not call `onViewportChange`.
   */
  setViewport(viewport: ChartViewport | null): void;
  /** Detached copy of the window set by gestures, presets, or setViewport(); null when none is active. */
  getViewport(): ChartViewport | null;
}

function snapshotValue<T>(value: T, seen = new WeakMap<object, unknown>()): DeepReadonly<T> {
  if (value == null || (typeof value !== "object" && typeof value !== "function")) {
    return value as DeepReadonly<T>;
  }
  if (typeof value === "function") return value as DeepReadonly<T>;
  if (value instanceof Date) {
    return Object.freeze(new Date(value.getTime())) as DeepReadonly<T>;
  }
  const previous = seen.get(value);
  if (previous) return previous as DeepReadonly<T>;
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    for (const item of value) output.push(snapshotValue(item, seen));
    return Object.freeze(output) as DeepReadonly<T>;
  }
  if (ArrayBuffer.isView(value)) {
    return Object.freeze(Array.from(value as unknown as ArrayLike<unknown>)) as DeepReadonly<T>;
  }
  const output: Record<PropertyKey, unknown> = {};
  seen.set(value, output);
  for (const key of Reflect.ownKeys(value)) {
    output[key] = snapshotValue((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(output) as DeepReadonly<T>;
}

function assertChartDimension(name: "width" | "height", value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new Error(`[@razedotbot/charts/react] Chart ${name} must be a finite number greater than zero.`);
  }
}

function assertChartHostStyle(style: ChartHostStyle | undefined): void {
  const unsafeStyle = style as CSSProperties | undefined;
  if (unsafeStyle?.width !== undefined || unsafeStyle?.height !== undefined) {
    throw new Error(
      "[@razedotbot/charts/react] Chart style cannot set width or height. " +
      "Use the width/height props or <ResponsiveContainer> so layout and compiled geometry stay synchronized.",
    );
  }
}

function assertViewportSync(viewportGroup: ViewportGroup | undefined, syncId: string | undefined): void {
  if (viewportGroup !== undefined && syncId !== undefined) {
    throw new Error(
      "[@razedotbot/charts/react] Pass either viewportGroup or syncId, not both. " +
      "syncId is shorthand for a shared createViewportGroup() instance.",
    );
  }
  if (syncId !== undefined && (typeof syncId !== "string" || !syncId.trim())) {
    throw new Error("[@razedotbot/charts/react] syncId must be a non-empty string.");
  }
}

function sameViewportValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
}

function sameViewportAxis(
  left: readonly unknown[] | undefined,
  right: readonly unknown[] | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => sameViewportValue(value, right[index]));
}

/** Value equality for controlled viewports, so an inline literal never recompiles. */
function sameViewport(left: ChartViewport | undefined, right: ChartViewport | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return sameViewportAxis(left.x, right.x) && sameViewportAxis(left.y, right.y);
}

/** Shallow equality for `interaction`, so `interaction={{ zoom: true }}` never recompiles. */
function sameInteraction(
  left: MountChartOptions["interaction"],
  right: MountChartOptions["interaction"],
): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || !left || !right) return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

function copyViewport(viewport: ChartViewport | null): ChartViewport | null {
  if (!viewport) return null;
  const copy: { x?: ChartViewport["x"]; y?: ChartViewport["y"] } = {};
  if (viewport.x) {
    copy.x = viewport.x.map((value) => value instanceof Date ? new Date(value.getTime()) : value) as ChartViewport["x"];
  }
  if (viewport.y) copy.y = [viewport.y[0], viewport.y[1]];
  return copy;
}

/** Groups shared by `syncId`, reference-counted so an idle id holds no charts. */
const syncGroups = new Map<string, { group: ViewportGroup; members: number }>();

function acquireSyncGroup(syncId: string): { group: ViewportGroup; release(): void } {
  let entry = syncGroups.get(syncId);
  if (!entry) {
    entry = { group: createViewportGroup(), members: 0 };
    syncGroups.set(syncId, entry);
  }
  entry.members += 1;
  const acquired = entry;
  let released = false;
  return {
    group: acquired.group,
    release() {
      if (released) return;
      released = true;
      acquired.members -= 1;
      if (acquired.members === 0 && syncGroups.get(syncId) === acquired) syncGroups.delete(syncId);
    },
  };
}

interface AppliedChartState {
  definition: ChartDefinition;
  width: number | undefined;
  height: number;
  renderer: NonNullable<MountChartOptions["renderer"]>;
  idPrefix: string | undefined;
  interaction: MountChartOptions["interaction"];
  viewport: ChartViewport | undefined;
}

/**
 * Thin lifecycle adapter around the framework-neutral chart runtime. The host
 * is mounted once; a new definition, size, renderer, id prefix, interaction or
 * viewport is forwarded through update(). Callbacks are read through stable
 * trampolines, so their identity never causes a recompile or repaint.
 */
export function Chart({
  definition,
  width,
  height = 320,
  renderer = "svg",
  ariaLabel,
  ariaDescription,
  idPrefix,
  className,
  style,
  onReady,
  interaction,
  viewport,
  onViewportChange,
  onSelect,
  viewportGroup,
  syncId,
}: ChartProps): ReactElement {
  assertChartDimension("width", width);
  assertChartDimension("height", height);
  assertChartHostStyle(style);
  assertViewportSync(viewportGroup, syncId);
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<MountHandle | null>(null);
  const applied = useRef<AppliedChartState | null>(null);
  /** The group this chart currently belongs to (viewportGroup or its syncId group). */
  const activeGroup = useRef<ViewportGroup | null>(null);
  /** True while this chart broadcasts its own gesture, so the group echo is skipped. */
  const broadcasting = useRef(false);

  const def = useMemo(() => {
    if (!ariaLabel && !ariaDescription) return definition;
    return defineChart((size) => ({
      ...definition.spec(size),
      ...(ariaLabel ? { ariaLabel } : {}),
      ...(ariaDescription ? { ariaDescription } : {}),
    }));
  }, [definition, ariaLabel, ariaDescription]);
  const latest = useRef({
    definition: def, width, height, renderer, idPrefix, onReady, interaction, viewport, onViewportChange, onSelect,
  });
  latest.current = {
    definition: def, width, height, renderer, idPrefix, onReady, interaction, viewport, onViewportChange, onSelect,
  };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const current = latest.current;
    const mounted = mountChart(el, current.definition, {
      width: current.width,
      height: current.height,
      renderer: current.renderer,
      idPrefix: current.idPrefix,
      interaction: current.interaction,
      viewport: current.viewport,
      // Stable trampolines: the mount never needs an update() for a new callback.
      onViewportChange: (next) => {
        const group = activeGroup.current;
        if (group) {
          broadcasting.current = true;
          try {
            group.setViewport(next);
          } finally {
            broadcasting.current = false;
          }
        }
        latest.current.onViewportChange?.(next);
      },
      onSelect: (event) => latest.current.onSelect?.(event),
    });
    handle.current = mounted;
    applied.current = {
      definition: current.definition,
      width: current.width,
      height: current.height,
      renderer: current.renderer,
      idPrefix: current.idPrefix,
      interaction: current.interaction,
      viewport: current.viewport,
    };
    let warnedAfterUnmount = false;
    const getSnapshot = (): ReactChartSnapshot | null => {
      const scene = mounted.getScene();
      return scene ? snapshotValue(scene) : null;
    };
    const publicHandle: ReactChartHandle = Object.freeze({
      getSnapshot,
      getScene: getSnapshot,
      setViewport(next: ChartViewport | null) {
        if (handle.current !== mounted) {
          if (!warnedAfterUnmount) {
            warnedAfterUnmount = true;
            console.warn(
              "[@razedotbot/charts/react] setViewport() was called on an unmounted chart and was ignored. " +
              "Call the function returned by group.add(handle) when the chart unmounts, " +
              "or pass viewportGroup/syncId so the chart leaves its group automatically.",
            );
          }
          return;
        }
        mounted.setViewport(next);
      },
      getViewport() {
        return handle.current === mounted ? copyViewport(mounted.getViewport()) : null;
      },
    });
    try {
      current.onReady?.(publicHandle);
    } catch (error) {
      handle.current = null;
      applied.current = null;
      mounted.destroy();
      throw error;
    }
    return () => {
      if (handle.current === mounted) handle.current = null;
      applied.current = null;
      mounted.destroy();
    };
  }, []);

  // Joins the viewport group after the mount effect (effects run in order) and
  // leaves it on unmount or when the group changes.
  useEffect(() => {
    const mounted = handle.current;
    if (!mounted || (!viewportGroup && syncId === undefined)) return;
    const lease = viewportGroup
      ? { group: viewportGroup, release() {} }
      : acquireSyncGroup(syncId as string);
    const member: ViewportHandle = {
      setViewport(next) {
        if (broadcasting.current || handle.current !== mounted) return;
        mounted.setViewport(next);
      },
    };
    activeGroup.current = lease.group;
    const leave = lease.group.add(member);
    return () => {
      leave();
      if (activeGroup.current === lease.group) activeGroup.current = null;
      lease.release();
    };
  }, [viewportGroup, syncId]);

  useEffect(() => {
    const mounted = handle.current;
    const previous = applied.current;
    if (!mounted || !previous) return;
    if (
      previous.definition === def
      && previous.width === width
      && previous.height === height
      && previous.renderer === renderer
      && previous.idPrefix === idPrefix
      && sameInteraction(previous.interaction, interaction)
      && sameViewport(previous.viewport, viewport)
    ) return;
    const updateOptions: MountChartOptions = { width, height, renderer, idPrefix, interaction };
    // An absent viewport means “preserve the user's live pan/zoom”. A
    // controlled viewport is forwarded on every update, so the mount treats
    // it as navigation and keeps its cached full-data scene (a resize or an
    // interaction change does not recompile every row). Also forward the
    // explicit undefined of a controlled -> uncontrolled transition.
    if (viewport !== undefined || previous.viewport !== undefined) updateOptions.viewport = viewport;
    mounted.update(def, updateOptions);
    applied.current = { definition: def, width, height, renderer, idPrefix, interaction, viewport };
  }, [def, width, height, renderer, idPrefix, interaction, viewport]);

  return (
    <div
      ref={host}
      className={className}
      data-raze-chart-host=""
      style={{ ...style, width: width === undefined ? "100%" : `${width}px`, height: `${height}px` }}
    />
  );
}

export type DataKey<T extends object> = Extract<keyof T, string>;

export interface SeriesDataProps<T extends object = Record<string, unknown>> {
  dataKey: DataKey<T>;
  data?: readonly T[];
}

export interface NamedSeriesProps<T extends object = Record<string, unknown>> extends SeriesDataProps<T> {
  name?: string;
}

export interface LineProps<T extends object = Record<string, unknown>> extends NamedSeriesProps<T> {
  stroke?: string;
  strokeWidth?: number;
  lastValue?: boolean;
  dashed?: boolean;
  curve?: "monotone" | "linear" | "step";
}

export interface AreaProps<T extends object = Record<string, unknown>> extends NamedSeriesProps<T> {
  stroke?: string;
  fill?: string;
  fillOpacity?: number;
  strokeWidth?: number;
  lastValue?: boolean;
  dashed?: boolean;
  curve?: "monotone" | "linear" | "step";
  y0?: DataKey<T>;
}

export interface BarProps<T extends object = Record<string, unknown>> extends NamedSeriesProps<T> {
  fill?: string;
  stackId?: string;
  lastValue?: boolean;
  fade?: boolean;
}

export interface ScatterProps<T extends object = Record<string, unknown>> extends NamedSeriesProps<T> {
  fill?: string;
  fillOpacity?: number;
  r?: number;
}

export interface PieProps<T extends object = Record<string, unknown>> extends NamedSeriesProps<T> {
  innerRadius?: number;
  outerRadius?: number;
}

export interface RadarProps<T extends object = Record<string, unknown>> extends NamedSeriesProps<T> {
  stroke?: string;
  fill?: string;
  fillOpacity?: number;
  strokeWidth?: number;
}

export interface HeatmapProps<T extends object = Record<string, unknown>> extends SeriesDataProps<T> {}

/** @deprecated Prefer the mark-specific LineProps, AreaProps, BarProps, etc. */
export type SeriesProps<T extends object = Record<string, unknown>> =
  | LineProps<T>
  | AreaProps<T>
  | BarProps<T>
  | ScatterProps<T>
  | PieProps<T>
  | RadarProps<T>
  | HeatmapProps<T>;

export interface AxisProps<T extends object = Record<string, unknown>> {
  dataKey?: DataKey<T>;
}

export type ReferenceLineProps =
  | { y: number; x?: never; stroke?: string; strokeWidth?: number; name?: string }
  | { x: number | string | Date; y?: never; stroke?: string; strokeWidth?: number; name?: string };

export interface BrushProps<T extends object = Record<string, unknown>> {
  dataKey?: DataKey<T>;
  height?: number;
  startIndex?: number;
  endIndex?: number;
}

type ComponentRole =
  | "line"
  | "bar"
  | "area"
  | "scatter"
  | "pie"
  | "radar"
  | "heatmap"
  | "x-axis"
  | "y-axis"
  | "grid"
  | "tooltip"
  | "legend"
  | "reference-line"
  | "brush";

const COMPONENT_ROLE = Symbol.for("@razedotbot/charts/react-component-role");
type Descriptor<P> = ((props: P) => null) & { [COMPONENT_ROLE]: ComponentRole };

function descriptor<P>(role: ComponentRole, displayName: string): Descriptor<P> {
  const component = ((props: P) => {
    void props;
    return null;
  }) as Descriptor<P>;
  component[COMPONENT_ROLE] = role;
  Object.defineProperty(component, "name", { value: displayName });
  return component;
}

function componentRole(value: unknown): ComponentRole | null {
  if ((typeof value !== "function" && typeof value !== "object") || value == null) return null;
  return (value as Partial<Descriptor<unknown>>)[COMPONENT_ROLE] ?? null;
}

export const Line = /* @__PURE__ */ descriptor<LineProps>("line", "Line");
export const Bar = /* @__PURE__ */ descriptor<BarProps>("bar", "Bar");
export const Area = /* @__PURE__ */ descriptor<AreaProps>("area", "Area");
export const Scatter = /* @__PURE__ */ descriptor<ScatterProps>("scatter", "Scatter");
export const Pie = /* @__PURE__ */ descriptor<PieProps>("pie", "Pie");
export const Radar = /* @__PURE__ */ descriptor<RadarProps>("radar", "Radar");
export const Heatmap = /* @__PURE__ */ descriptor<HeatmapProps>("heatmap", "Heatmap");
export const XAxis = /* @__PURE__ */ descriptor<AxisProps>("x-axis", "XAxis");
export const YAxis = /* @__PURE__ */ descriptor<AxisProps>("y-axis", "YAxis");
export const CartesianGrid = /* @__PURE__ */ descriptor<Record<never, never>>("grid", "CartesianGrid");
export const Tooltip = /* @__PURE__ */ descriptor<Record<never, never>>("tooltip", "Tooltip");
export const Legend = /* @__PURE__ */ descriptor<Record<never, never>>("legend", "Legend");
export const ReferenceLine = /* @__PURE__ */ descriptor<ReferenceLineProps>("reference-line", "ReferenceLine");
export const Brush = /* @__PURE__ */ descriptor<BrushProps>("brush", "Brush");

export type ResponsiveContainerStyle = Omit<CSSProperties, "width" | "height" | "position" | "minWidth"> & {
  readonly width?: never;
  readonly height?: never;
  readonly position?: never;
  readonly minWidth?: never;
};

/** Numeric size measured by <ResponsiveContainer>, in CSS pixels. */
export interface ResponsiveContainerSize {
  width: number;
  height: number;
}

/**
 * One element that accepts numeric width/height props (a chart, or a wrapper
 * component that forwards them to one), or a render function that receives
 * the measured size once both dimensions are known.
 */
export type ResponsiveContainerChild =
  | ReactElement<{ width?: number; height?: number }>
  | ((size: ResponsiveContainerSize) => ReactNode);

export interface ResponsiveContainerProps {
  children: ResponsiveContainerChild;
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: ResponsiveContainerStyle;
}

function numericResponsiveDimension(name: "width" | "height", value: number | string): number | undefined {
  if (typeof value !== "number") {
    if (!value.trim()) {
      throw new Error(`[@razedotbot/charts/react] ResponsiveContainer ${name} cannot be an empty CSS size.`);
    }
    return undefined;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `[@razedotbot/charts/react] ResponsiveContainer ${name} must be a positive finite number or CSS size.`,
    );
  }
  return value;
}

function describeResponsiveChild(children: unknown): string {
  if (Array.isArray(children)) return `${children.length} children`;
  if (!isValidElement(children)) return children == null ? "no child" : `a ${typeof children} child`;
  if (typeof children.type === "string") return `<${children.type}>`;
  const role = componentRole(children.type);
  if (!role) return "a Fragment";
  const name = COMPONENT_NAMES[role];
  // Every series descriptor has a same-named container: <Line> → <LineChart>.
  return SERIES_ROLES.has(role)
    ? `<${name}>, a series descriptor; wrap it in a chart container such as <${name}Chart>`
    : `<${name}>, a chart descriptor; wrap it in a chart container such as <LineChart> or <ComposedChart>`;
}

/**
 * Any component element can receive the measured size: a chart, or a user
 * wrapper such as <RevenueChart /> that forwards width and height. Host
 * elements, fragments and bare descriptors (<Line>, <Tooltip>, which render
 * nothing outside a chart container) cannot, so they fail loudly instead of
 * rendering an empty container.
 */
function assertResponsiveChild(
  children: unknown,
): asserts children is ReactElement<{ width?: number; height?: number }> {
  if (
    isValidElement(children)
    && typeof children.type !== "string"
    && children.type !== Fragment
    && componentRole(children.type) === null
  ) return;
  throw new Error(
    "[@razedotbot/charts/react] ResponsiveContainer requires exactly one chart element " +
    "(a chart, or a component that forwards width and height to one) or a render function child " +
    `({ width, height }) => …; received ${describeResponsiveChild(children)}.`,
  );
}

export function ResponsiveContainer({
  children,
  width = "100%",
  height = 320,
  className,
  style,
}: ResponsiveContainerProps): ReactElement {
  const unsafeStyle = style as CSSProperties | undefined;
  if (
    unsafeStyle?.width !== undefined
    || unsafeStyle?.height !== undefined
    || unsafeStyle?.position !== undefined
    || unsafeStyle?.minWidth !== undefined
  ) {
    throw new Error(
      "[@razedotbot/charts/react] ResponsiveContainer style cannot override width, height, position, or minWidth. " +
      "Use its width/height props and wrap it when additional layout ownership is required.",
    );
  }
  const host = useRef<HTMLDivElement>(null);
  const explicitWidth = numericResponsiveDimension("width", width);
  const explicitHeight = numericResponsiveDimension("height", height);
  const [measured, setMeasured] = useState<{ width?: number; height?: number }>({});

  useEffect(() => {
    const element = host.current;
    if (!element || (explicitWidth !== undefined && explicitHeight !== undefined)) return;
    const commit = (rect?: Pick<DOMRectReadOnly, "width" | "height">): void => {
      const fallback = element.getBoundingClientRect();
      const nextWidth = explicitWidth ?? rect?.width ?? fallback.width;
      const nextHeight = explicitHeight ?? rect?.height ?? fallback.height;
      const next = {
        ...(Number.isFinite(nextWidth) && nextWidth > 0 ? { width: nextWidth } : {}),
        ...(Number.isFinite(nextHeight) && nextHeight > 0 ? { height: nextHeight } : {}),
      };
      setMeasured((current) => current.width === next.width && current.height === next.height ? current : next);
    };
    commit();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver((entries) => commit(entries[0]?.contentRect));
      observer.observe(element);
      return () => observer.disconnect();
    }
    const onResize = (): void => commit();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [explicitWidth, explicitHeight]);

  const size = {
    width: explicitWidth ?? measured.width,
    height: explicitHeight ?? measured.height,
  };
  let child: ReactNode;
  if (typeof children === "function") {
    // A render function receives only real numbers: nothing renders until
    // both dimensions are known (for example before the first layout).
    child = size.width !== undefined && size.height !== undefined
      ? children({ width: size.width, height: size.height })
      : null;
  } else {
    assertResponsiveChild(children);
    child = cloneElement(children, size);
  }
  return (
    <div
      ref={host}
      className={className}
      data-raze-responsive-container=""
      style={{ ...style, width, height, minWidth: 0, position: "relative" }}
    >
      {child}
    </div>
  );
}

const COMPONENT_NAMES: Record<ComponentRole, string> = {
  line: "Line",
  area: "Area",
  bar: "Bar",
  scatter: "Scatter",
  pie: "Pie",
  radar: "Radar",
  heatmap: "Heatmap",
  "x-axis": "XAxis",
  "y-axis": "YAxis",
  grid: "CartesianGrid",
  tooltip: "Tooltip",
  legend: "Legend",
  "reference-line": "ReferenceLine",
  brush: "Brush",
};

const SUPPORTED_PROPS: Record<ComponentRole, readonly string[]> = {
  line: ["dataKey", "data", "name", "stroke", "strokeWidth", "lastValue", "dashed", "curve"],
  area: ["dataKey", "data", "name", "stroke", "fill", "fillOpacity", "strokeWidth", "lastValue", "dashed", "curve", "y0"],
  bar: ["dataKey", "data", "name", "fill", "stackId", "lastValue", "fade"],
  scatter: ["dataKey", "data", "name", "fill", "fillOpacity", "r"],
  pie: ["dataKey", "data", "name", "innerRadius", "outerRadius"],
  radar: ["dataKey", "data", "name", "stroke", "fill", "fillOpacity", "strokeWidth"],
  heatmap: ["dataKey", "data"],
  "x-axis": ["dataKey"],
  "y-axis": ["dataKey"],
  grid: [],
  tooltip: [],
  legend: [],
  "reference-line": ["y", "x", "stroke", "strokeWidth", "name"],
  brush: ["dataKey", "height", "startIndex", "endIndex"],
};

const SERIES_ROLES = new Set<ComponentRole>(["line", "area", "bar", "scatter", "pie", "radar", "heatmap"]);

function assertDescriptorProps(role: ComponentRole, props: Record<string, unknown>): void {
  const supported = SUPPORTED_PROPS[role];
  const unsupported = Object.keys(props).find((key) => !supported.includes(key));
  const component = COMPONENT_NAMES[role];
  if (unsupported) {
    const supportedText = supported.length ? supported.join(", ") : "no props";
    throw new Error(
      `[@razedotbot/charts/react] <${component}> does not support prop "${unsupported}". ` +
      `Supported props: ${supportedText}.`,
    );
  }
  if (SERIES_ROLES.has(role)) {
    if (typeof props.dataKey !== "string" || !props.dataKey.trim()) {
      throw new Error(`[@razedotbot/charts/react] <${component}> requires a non-empty dataKey prop.`);
    }
    if (props.data !== undefined && !Array.isArray(props.data)) {
      throw new Error(`[@razedotbot/charts/react] <${component}> data must be an array.`);
    }
  }
  if ((role === "x-axis" || role === "y-axis") && props.dataKey !== undefined
      && (typeof props.dataKey !== "string" || !props.dataKey.trim())) {
    throw new Error(`[@razedotbot/charts/react] <${component}> dataKey must be a non-empty string.`);
  }
  for (const key of ["strokeWidth", "r", "innerRadius", "outerRadius"] as const) {
    const value = props[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      throw new Error(`[@razedotbot/charts/react] <${component}> ${key} must be a finite non-negative number.`);
    }
  }
  if (props.fillOpacity !== undefined
      && (typeof props.fillOpacity !== "number" || !Number.isFinite(props.fillOpacity)
        || props.fillOpacity < 0 || props.fillOpacity > 1)) {
    throw new Error(`[@razedotbot/charts/react] <${component}> fillOpacity must be between 0 and 1.`);
  }
  if (role === "pie" && typeof props.innerRadius === "number" && typeof props.outerRadius === "number"
      && props.innerRadius > props.outerRadius) {
    throw new Error("[@razedotbot/charts/react] <Pie> innerRadius cannot exceed outerRadius.");
  }
  if (role === "brush") {
    if (props.dataKey !== undefined && (typeof props.dataKey !== "string" || !props.dataKey.trim())) {
      throw new Error("[@razedotbot/charts/react] <Brush> dataKey must be a non-empty string.");
    }
    for (const key of ["startIndex", "endIndex"] as const) {
      const value = props[key];
      if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 0)) {
        throw new Error(`[@razedotbot/charts/react] <Brush> ${key} must be a non-negative integer.`);
      }
    }
    const height = props.height;
    if (height !== undefined && (typeof height !== "number" || !Number.isFinite(height) || height < 0)) {
      throw new Error("[@razedotbot/charts/react] <Brush> height must be a finite non-negative number.");
    }
    if (typeof props.startIndex === "number" && typeof props.endIndex === "number"
        && props.startIndex > props.endIndex) {
      throw new Error("[@razedotbot/charts/react] <Brush> startIndex cannot exceed endIndex.");
    }
  }
}

interface DescriptorRecord {
  role: ComponentRole;
  props: Record<string, unknown>;
}

/** Validated descriptor children in document order; Fragments are flattened. */
function collectDescriptors(children: ReactNode): DescriptorRecord[] {
  const descriptors: DescriptorRecord[] = [];
  const collect = (nodes: ReactNode): void => {
    Children.forEach(nodes, (child) => {
      if (!isValidElement(child)) return;
      if (child.type === Fragment) {
        collect((child.props as { children?: ReactNode }).children);
        return;
      }
      const role = componentRole(child.type);
      if (!role) return;
      const props = child.props as Record<string, unknown>;
      assertDescriptorProps(role, props);
      descriptors.push({ role, props });
    });
  };
  collect(children);
  return descriptors;
}

/** Stable per-object tokens, so structural keys compare arrays and callbacks by identity. */
const identityTokens = new WeakMap<object, number>();
let nextIdentityToken = 0;

function structuralToken(value: unknown): string {
  if (value instanceof Date) return `d${value.getTime()}`;
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    let token = identityTokens.get(value as object);
    if (token === undefined) {
      token = nextIdentityToken += 1;
      identityTokens.set(value as object, token);
    }
    return `r${token}`;
  }
  if (typeof value === "string") return `s${JSON.stringify(value)}`;
  // Numbers (NaN, -0 and Infinity included), booleans, undefined, bigint, symbols.
  return typeof value === "number" && Object.is(value, -0) ? "n-0" : `${typeof value}:${String(value)}`;
}

/**
 * Structural key of the JSX children: descriptor roles in order plus their
 * shallow props (primitives and Dates by value, arrays and objects by
 * identity). JSX elements are new objects on every render, but an unchanged
 * key means an identical chart, so the adapter skips compile and repaint.
 */
function descriptorKey(descriptors: readonly DescriptorRecord[]): string {
  return descriptors.map(({ role, props }) => {
    const fields = Object.keys(props).sort().map((key) => `${key}=${structuralToken(props[key])}`);
    return `${role}(${fields.join(",")})`;
  }).join(";");
}

function specFromJsx<T extends object>(
  kind: "line" | "bar" | "area" | "scatter" | "pie" | "radar" | "heatmap" | "composed",
  data: readonly T[],
  descriptors: readonly DescriptorRecord[],
  xDefault: DataKey<T>,
  valueDefault: DataKey<T>,
  heatmapYDefault?: DataKey<T>,
): { definition: ChartDefinition; interaction?: MountChartOptions["interaction"] } {
  let xKey: DataKey<T> = xDefault;
  let yKey: DataKey<T> | undefined = heatmapYDefault;
  let grid = false;
  let tooltip = false;
  let legend = false;
  let viewport: ChartViewport | undefined;
  let interaction: MountChartOptions["interaction"];
  const marks: ChartMark[] = [];

  // Configuration is resolved before marks, so JSX child order never changes
  // data encoding (for example <Line/> may safely precede <XAxis/>).
  for (const { role, props: p } of descriptors) {
      if (role === "x-axis" && p.dataKey) xKey = p.dataKey as DataKey<T>;
      if (role === "y-axis" && p.dataKey) yKey = p.dataKey as DataKey<T>;
      if (role === "grid") grid = true;
      if (role === "tooltip") tooltip = true;
      if (role === "legend") legend = true;
      if (role === "brush") {
        const start = typeof p.startIndex === "number" ? p.startIndex : undefined;
        const end = typeof p.endIndex === "number" ? p.endIndex : undefined;
        const key = (p.dataKey as DataKey<T> | undefined) ?? xKey;
        if (p.dataKey !== undefined && data.length > 0 && data.some((row) => !(key in row))) {
          throw new Error(
            `[@razedotbot/charts/react] <Brush> dataKey "${String(key)}" is missing from chart data.`,
          );
        }
        if (start != null || end != null) {
          if (start !== undefined && start >= data.length) {
            throw new Error(
              `[@razedotbot/charts/react] <Brush> startIndex ${start} is outside data length ${data.length}.`,
            );
          }
          if (end !== undefined && end >= data.length) {
            throw new Error(
              `[@razedotbot/charts/react] <Brush> endIndex ${end} is outside data length ${data.length}.`,
            );
          }
          const lo = start ?? 0;
          const hi = end ?? data.length - 1;
          const values = data.slice(lo, hi + 1).map((row) => row[key]);
          const first = values[0];
          const last = values[values.length - 1];
          const isQuantitative = (value: unknown): value is number | Date =>
            (typeof value === "number" && Number.isFinite(value))
            || (value instanceof Date && Number.isFinite(value.getTime()));
          if (isQuantitative(first) && isQuantitative(last)) {
            viewport = { x: [first, last] };
          } else if (values.every((value) =>
            typeof value === "string" || (typeof value === "number" && Number.isFinite(value)))) {
            // Categorical viewports are exact allow-lists, so retain every
            // category between the selected indices rather than only endpoints.
            viewport = { x: values as (string | number)[] };
          } else {
            throw new Error(
              `[@razedotbot/charts/react] <Brush> dataKey "${String(key)}" must resolve to strings, finite numbers, or valid Dates.`,
            );
          }
        }
        interaction = {
          brush: true,
          zoom: true,
          pan: true,
          navigator: typeof p.height === "number" ? p.height > 0 : true,
          rangePresets: true,
        };
      }
  }

  for (const { role, props: p } of descriptors) {
      const seriesData = (p.data as readonly T[] | undefined) ?? data;
      const dataKey = p.dataKey as DataKey<T>;
      const name = (p.name as string | undefined) ?? String(dataKey);
      if (role === "line") {
        const props = p as unknown as LineProps<T>;
        marks.push({
          kind: "line", data: seriesData, x: xKey, y: dataKey, name,
          stroke: props.stroke, strokeWidth: props.strokeWidth,
          lastValue: props.lastValue, dashed: props.dashed, curve: props.curve,
        });
      }
      if (role === "area") {
        const props = p as unknown as AreaProps<T>;
        marks.push({
          kind: "area", data: seriesData, x: xKey, y: dataKey, name,
          stroke: props.stroke, fill: props.fill, fillOpacity: props.fillOpacity,
          strokeWidth: props.strokeWidth, lastValue: props.lastValue, dashed: props.dashed,
          curve: props.curve, y0: props.y0,
        });
      }
      if (role === "bar") {
        const props = p as unknown as BarProps<T>;
        marks.push({
          kind: "bar", data: seriesData, x: xKey, y: dataKey, name,
          fill: props.fill, stackId: props.stackId, lastValue: props.lastValue, fade: props.fade,
        });
      }
      if (role === "scatter") {
        const props = p as unknown as ScatterProps<T>;
        marks.push({
          kind: "point", data: seriesData, x: xKey, y: dataKey, name,
          fill: props.fill, fillOpacity: props.fillOpacity, r: props.r,
        });
      }
      if (role === "pie") {
        const props = p as unknown as PieProps<T>;
        marks.push({
          kind: "pie", data: seriesData, valueKey: dataKey, labelKey: xKey, name,
          innerRadius: props.innerRadius, outerRadius: props.outerRadius,
        });
      }
      if (role === "radar") {
        const props = p as unknown as RadarProps<T>;
        marks.push({
          kind: "radar", data: seriesData, x: xKey, y: dataKey, name,
          stroke: props.stroke, fill: props.fill, fillOpacity: props.fillOpacity,
          strokeWidth: props.strokeWidth,
        });
      }
      if (role === "heatmap") {
        if (!yKey) {
          throw new Error(
            "[@razedotbot/charts/react] Heatmap requires a categorical Y channel. " +
            "Pass heatmapYKey to createChartComponents() or render <YAxis dataKey=\"...\" />.",
          );
        }
        marks.push({ kind: "heatmap", data: seriesData, x: xKey, y: yKey, valueKey: dataKey, name });
      }
      if (role === "reference-line") {
        const hasY = typeof p.y === "number" && Number.isFinite(p.y);
        const hasX = p.x != null && p.x !== "";
        if (hasY === hasX) {
          throw new Error("[@razedotbot/charts/react] <ReferenceLine> requires exactly one of y or x.");
        }
        if (hasY) {
          marks.push(ruleY([p.y as number], {
            stroke: p.stroke as string | undefined,
            strokeWidth: p.strokeWidth as number | undefined,
            name: (p.name as string | undefined) ?? "Reference",
          }));
        } else {
          marks.push(ruleX([p.x as number | string | Date], {
            stroke: p.stroke as string | undefined,
            strokeWidth: p.strokeWidth as number | undefined,
            name: (p.name as string | undefined) ?? "Reference",
          }));
        }
      }
  }

  if (!marks.length) {
    if (kind === "pie") marks.push(pie(data, { valueKey: valueDefault, labelKey: xKey }));
    else if (kind === "bar") marks.push(bar(data, { x: xKey, y: valueDefault }));
    else if (kind === "area") marks.push(area(data, { x: xKey, y: valueDefault }));
    else if (kind === "scatter") marks.push(point(data, { x: xKey, y: valueDefault }));
    else if (kind === "radar") marks.push(radar(data, { x: xKey, y: valueDefault }));
    else if (kind === "heatmap") {
      if (!yKey) {
        throw new Error(
          "[@razedotbot/charts/react] Heatmap requires a categorical Y channel. " +
          "Pass heatmapYKey to createChartComponents() or render <YAxis dataKey=\"...\" />.",
        );
      }
      marks.push(heatmap(data, { x: xKey, y: yKey, valueKey: valueDefault }));
    }
    else marks.push(line(data, { x: xKey, y: valueDefault }));
  }
  return { definition: defineChart({ marks, grid, tooltip, legend, viewport }), interaction };
}

export interface BoxProps<T extends object = Record<string, unknown>> {
  data: readonly T[];
  width?: number;
  height?: number;
  renderer?: NonNullable<MountChartOptions["renderer"]>;
  children?: ReactNode;
  ariaLabel?: string;
  ariaDescription?: string;
  idPrefix?: string;
  className?: string;
  style?: ChartHostStyle;
  onReady?: (chart: ReactChartHandle) => void;
  /** Latest callback always wins; see ChartProps.onViewportChange. */
  onViewportChange?: ChartProps["onViewportChange"];
  /** Latest callback always wins; see ChartProps.onSelect. */
  onSelect?: ChartProps["onSelect"];
  /** Share the X window with other charts; see ChartProps.viewportGroup. */
  viewportGroup?: ViewportGroup;
  /** Recharts-style shorthand for a shared viewport group; see ChartProps.syncId. */
  syncId?: string;
}

function JsxChart<T extends object>({
  data,
  width,
  height = 320,
  renderer,
  children,
  ariaLabel,
  ariaDescription,
  idPrefix,
  className,
  style,
  onReady,
  onViewportChange,
  onSelect,
  viewportGroup,
  syncId,
  kind,
  x,
  value,
  heatmapY,
}: BoxProps<T> & {
  kind: "line" | "bar" | "area" | "scatter" | "pie" | "radar" | "heatmap" | "composed";
  x: DataKey<T>;
  value: DataKey<T>;
  heatmapY?: DataKey<T>;
}): ReactElement {
  // JSX children are new objects on every render; memoize on their structure
  // (roles plus shallow props) and the data identity instead, so an unrelated
  // parent re-render never recompiles or repaints the chart.
  const descriptors = collectDescriptors(children);
  const key = descriptorKey(descriptors);
  const parsed = useMemo(
    () => specFromJsx(kind, data, descriptors, x, value, heatmapY),
    // `key` stands in for `descriptors`: equal keys describe the same chart.
    [kind, data, key, x, value, heatmapY],
  );
  return (
    <Chart
      definition={parsed.definition}
      interaction={parsed.interaction}
      width={width}
      height={height}
      renderer={renderer}
      ariaLabel={ariaLabel}
      ariaDescription={ariaDescription}
      idPrefix={idPrefix}
      className={className}
      style={style}
      onReady={onReady}
      onViewportChange={onViewportChange}
      onSelect={onSelect}
      viewportGroup={viewportGroup}
      syncId={syncId}
    />
  );
}

export const LineChart = function LineChart<T extends object>(props: BoxProps<T>): ReactElement {
  return <JsxChart kind="line" x={"name" as DataKey<T>} value={"value" as DataKey<T>} {...props} />;
};
export const BarChart = function BarChart<T extends object>(props: BoxProps<T>): ReactElement {
  return <JsxChart kind="bar" x={"name" as DataKey<T>} value={"value" as DataKey<T>} {...props} />;
};
export const AreaChart = function AreaChart<T extends object>(props: BoxProps<T>): ReactElement {
  return <JsxChart kind="area" x={"name" as DataKey<T>} value={"value" as DataKey<T>} {...props} />;
};
export const ScatterChart = function ScatterChart<T extends object>(props: BoxProps<T>): ReactElement {
  return <JsxChart kind="scatter" x={"name" as DataKey<T>} value={"value" as DataKey<T>} {...props} />;
};
export const PieChart = function PieChart<T extends object>(props: BoxProps<T>): ReactElement {
  return <JsxChart kind="pie" x={"name" as DataKey<T>} value={"value" as DataKey<T>} {...props} />;
};
export const RadarChart = function RadarChart<T extends object>(props: BoxProps<T>): ReactElement {
  return <JsxChart kind="radar" x={"name" as DataKey<T>} value={"value" as DataKey<T>} {...props} />;
};
export const HeatmapChart = function HeatmapChart<T extends object>(props: BoxProps<T>): ReactElement {
  return <JsxChart kind="heatmap" x={"x" as DataKey<T>} value={"value" as DataKey<T>} heatmapY={"y" as DataKey<T>} {...props} />;
};
export const ComposedChart = function ComposedChart<T extends object>(props: BoxProps<T>): ReactElement {
  return <JsxChart kind="composed" x={"name" as DataKey<T>} value={"value" as DataKey<T>} {...props} />;
};

/**
 * Creates a Recharts-shaped component set whose dataKey props are constrained
 * to the keys of T. The unbound exports remain permissive for migration code.
 */
export interface ChartComponentDefaults<T extends object> {
  /** Default horizontal/category channel, overridable with <XAxis>. */
  xKey: DataKey<T>;
  /** Default quantitative channel used when a chart has no series child. */
  valueKey: DataKey<T>;
  /** Default categorical Y channel for heatmaps; otherwise <YAxis> is required. */
  heatmapYKey?: DataKey<T>;
}

export function createChartComponents<T extends object>(defaults: ChartComponentDefaults<T>) {
  const TypedLine = descriptor<LineProps<T>>("line", "Line");
  const TypedBar = descriptor<BarProps<T>>("bar", "Bar");
  const TypedArea = descriptor<AreaProps<T>>("area", "Area");
  const TypedScatter = descriptor<ScatterProps<T>>("scatter", "Scatter");
  const TypedPie = descriptor<PieProps<T>>("pie", "Pie");
  const TypedRadar = descriptor<RadarProps<T>>("radar", "Radar");
  const TypedHeatmap = descriptor<HeatmapProps<T>>("heatmap", "Heatmap");
  const TypedXAxis = descriptor<AxisProps<T>>("x-axis", "XAxis");
  const TypedYAxis = descriptor<AxisProps<T>>("y-axis", "YAxis");
  const TypedBrush = descriptor<BrushProps<T>>("brush", "Brush");
  const make = (
    kind: "line" | "bar" | "area" | "scatter" | "pie" | "radar" | "heatmap" | "composed",
    x: DataKey<T>,
  ) => function TypedChart(props: BoxProps<T>): ReactElement {
    return <JsxChart kind={kind} x={x} value={defaults.valueKey} heatmapY={defaults.heatmapYKey} {...props} />;
  };
  return {
    LineChart: make("line", defaults.xKey),
    BarChart: make("bar", defaults.xKey),
    AreaChart: make("area", defaults.xKey),
    ScatterChart: make("scatter", defaults.xKey),
    PieChart: make("pie", defaults.xKey),
    RadarChart: make("radar", defaults.xKey),
    HeatmapChart: make("heatmap", defaults.xKey),
    ComposedChart: make("composed", defaults.xKey),
    Line: TypedLine,
    Bar: TypedBar,
    Area: TypedArea,
    Scatter: TypedScatter,
    Pie: TypedPie,
    Radar: TypedRadar,
    Heatmap: TypedHeatmap,
    XAxis: TypedXAxis,
    YAxis: TypedYAxis,
    CartesianGrid,
    Tooltip,
    Legend,
    ReferenceLine,
    Brush: TypedBrush,
  } as const;
}

export { defineChart, line, area, bar, point, ruleY, ruleX, pie, radar, heatmap, compileChart, createViewportGroup } from "../chart";
export type { ChartViewport, ViewportGroup, ViewportHandle } from "../chart";

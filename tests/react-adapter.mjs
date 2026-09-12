import { JSDOM } from "jsdom";
import React, { Fragment, act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  Chart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  Brush,
  ReferenceLine,
  createChartComponents,
  defineChart,
  line,
} from "../dist/react.esm.js";

const assert = (condition, message) => {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  console.log(`✓ ${message}`);
};

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.SVGElement = dom.window.SVGElement;
globalThis.PointerEvent = dom.window.PointerEvent ?? dom.window.MouseEvent;
let activeObservers = 0;
const resizeObservers = [];
globalThis.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
    resizeObservers.push(this);
  }
  observe(target) {
    if (this.observing) return;
    this.observing = true;
    this.target = target;
    activeObservers += 1;
  }
  disconnect() {
    if (!this.observing) return;
    this.observing = false;
    activeObservers -= 1;
  }
  emit(width, height) {
    this.callback([{ target: this.target, contentRect: { width, height } }], this);
  }
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const container = document.getElementById("root");
const root = createRoot(container);
const handles = [];

const chart = (data, extras = true) => createElement(
  LineChart,
  {
    data,
    width: 420,
    height: 240,
    ariaLabel: "Revenue trend",
    ariaDescription: "Monthly revenue in euros.",
    idPrefix: "react-contract",
    onReady: (handle) => handles.push(handle),
  },
  createElement(
    Fragment,
    null,
    createElement(Line, { dataKey: "revenue", name: "Revenue" }),
    createElement(XAxis, { dataKey: "month" }),
    extras ? createElement(Tooltip) : null,
    extras ? createElement(Legend) : null,
  ),
);

await act(async () => {
  root.render(chart([
    { month: "Jan", revenue: 10 },
    { month: "Feb", revenue: 24 },
  ]));
});

const host = container.querySelector("[data-raze-chart-host]");
assert(host instanceof HTMLElement, "React chart mounts its framework-neutral host");
assert(handles.length === 1, "onReady fires once for the mounted runtime");
assert(!("destroy" in handles[0]), "React onReady exposes a lifecycle-safe read-only handle");
assert(Object.isFrozen(handles[0]), "React freezes the public diagnostic handle");
const firstSnapshot = handles[0].getSnapshot();
assert(firstSnapshot && Object.isFrozen(firstSnapshot), "onReady exposes an immutable scene snapshot");
assert(Object.isFrozen(firstSnapshot.nodes), "snapshot arrays are frozen recursively");
assert(Object.isFrozen(firstSnapshot.theme), "snapshot theme tokens are frozen recursively");
assert(Object.isFrozen(firstSnapshot.xScale.domain), "snapshot scale state is frozen recursively");
const snapshotBackground = firstSnapshot.theme.background;
try { firstSnapshot.theme.background = "magenta"; } catch {}
try { firstSnapshot.nodes.length = 0; } catch {}
try { firstSnapshot.xScale.domain[0] = "corrupted"; } catch {}
const freshSnapshot = handles[0].getSnapshot();
assert(freshSnapshot !== firstSnapshot, "each diagnostic read returns a detached snapshot");
assert(freshSnapshot?.theme.background === snapshotBackground, "snapshot mutation cannot reach runtime theme state");
assert((freshSnapshot?.nodes.length ?? 0) > 0, "snapshot mutation cannot remove runtime geometry");
assert(freshSnapshot?.xScale.domain[0] !== "corrupted", "snapshot mutation cannot alter runtime scales");
assert(handles[0].getScene()?.tooltip === true, "Tooltip descriptor enables interaction");
assert(handles[0].getScene()?.legendPlacement !== "hidden", "Legend descriptor enables the legend");
assert(handles[0].getScene()?.xTicks.some((tick) => tick.label === "Feb") === true, "axis binding is independent of JSX child order");
assert(container.querySelector("svg")?.getAttribute("aria-label") === "Revenue trend", "React ARIA props reach SVG output");
assert(container.querySelector("svg")?.getAttribute("aria-describedby") === "raze-description-react-contract", "React uses deterministic description ids");

await act(async () => {
  root.render(chart([
    { month: "Jan", revenue: 10 },
    { month: "Feb", revenue: 99 },
  ], false));
});

assert(container.querySelector("[data-raze-chart-host]") === host, "definition updates preserve the mounted host");
assert(handles.length === 1, "definition updates do not remount or fire onReady again");
assert(handles[0].getScene()?.tooltip === false, "removing Tooltip disables interaction on update");
assert(handles[0].getScene()?.legendPlacement === "hidden", "removing Legend updates presentation in place");
assert(handles[0].getScene()?.lastValues.some((item) => item.label === "99") === true, "new data reaches the existing runtime");

await act(async () => { root.unmount(); });
assert(container.childElementCount === 0, "React unmount destroys chart DOM");

let compileCount = 0;
const countedDefinition = defineChart(() => {
  compileCount += 1;
  return {
    marks: [line([{ x: 0, y: 1 }, { x: 1, y: 2 }], { x: "x", y: "y" })],
  };
});
const countedContainer = document.createElement("div");
document.body.appendChild(countedContainer);
const countedRoot = createRoot(countedContainer);
await act(async () => {
  countedRoot.render(createElement(Chart, { definition: countedDefinition, width: 320, height: 180 }));
});
assert(compileCount === 1, "initial React mount compiles the definition exactly once");
await act(async () => {
  countedRoot.render(createElement(Chart, { definition: countedDefinition, width: 321, height: 180 }));
});
assert(compileCount === 2, "a material React update compiles exactly once");
await act(async () => { countedRoot.unmount(); });
countedContainer.remove();

const optionUpdateContainer = document.createElement("div");
document.body.appendChild(optionUpdateContainer);
const optionUpdateRoot = createRoot(optionUpdateContainer);
const optionUpdateDefinition = defineChart({
  marks: [line([
    { x: 0, y: 1 },
    { x: 1, y: 2 },
    { x: 2, y: 3 },
    { x: 3, y: 4 },
  ], { x: "x", y: "y" })],
});
let optionUpdateHandle;
let oldViewportCalls = 0;
let newViewportCalls = 0;
let oldSelectCalls = 0;
let newSelectCalls = 0;
const onOptionUpdateReady = (handle) => { optionUpdateHandle = handle; };
const oldViewportHandler = () => { oldViewportCalls += 1; };
const newViewportHandler = () => { newViewportCalls += 1; };
const oldSelectHandler = () => { oldSelectCalls += 1; };
const newSelectHandler = () => { newSelectCalls += 1; };
const enabledInteraction = { zoom: true };
const controlledViewport = { x: [1, 2] };
const optionChart = ({
  interaction,
  viewport,
  onViewportChange,
  onSelect,
}) => createElement(Chart, {
  definition: optionUpdateDefinition,
  width: 320,
  height: 180,
  interaction,
  viewport,
  onViewportChange,
  onSelect,
  onReady: onOptionUpdateReady,
});
await act(async () => {
  optionUpdateRoot.render(optionChart({
    interaction: false,
    onViewportChange: oldViewportHandler,
    onSelect: oldSelectHandler,
  }));
});
const optionUpdateHost = optionUpdateContainer.querySelector("[data-raze-chart-host]");
const optionUpdateWrap = optionUpdateHost?.firstElementChild;
optionUpdateWrap.getBoundingClientRect = () => ({
  x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 180, width: 320, height: 180, toJSON() {},
});
const zoom = () => optionUpdateWrap.dispatchEvent(new window.WheelEvent("wheel", {
  bubbles: true,
  cancelable: true,
  clientX: 160,
  clientY: 80,
  deltaY: -1,
}));
zoom();
assert(oldViewportCalls === 0, "interaction=false suppresses wheel zoom before an option-only update");
await act(async () => {
  optionUpdateRoot.render(optionChart({
    interaction: enabledInteraction,
    onViewportChange: oldViewportHandler,
    onSelect: oldSelectHandler,
  }));
});
zoom();
assert(oldViewportCalls === 1, "an interaction-only prop update reaches the existing mount");
const uncontrolledViewport = JSON.stringify(optionUpdateHandle?.getSnapshot()?.viewport);
await act(async () => {
  optionUpdateRoot.render(optionChart({
    interaction: enabledInteraction,
    onViewportChange: newViewportHandler,
    onSelect: oldSelectHandler,
  }));
});
assert(
  JSON.stringify(optionUpdateHandle?.getSnapshot()?.viewport) === uncontrolledViewport,
  "a callback-only prop update preserves the user's uncontrolled viewport",
);
zoom();
assert(
  oldViewportCalls === 1 && newViewportCalls === 1,
  "an onViewportChange-only prop update replaces the mounted callback",
);
await act(async () => {
  optionUpdateRoot.render(optionChart({
    interaction: enabledInteraction,
    viewport: controlledViewport,
    onViewportChange: newViewportHandler,
    onSelect: oldSelectHandler,
  }));
});
assert(
  JSON.stringify(optionUpdateHandle?.getSnapshot()?.viewport?.x) === JSON.stringify(controlledViewport.x),
  "a viewport-only prop update recompiles the existing mount with the requested window",
);
await act(async () => {
  optionUpdateRoot.render(optionChart({
    interaction: enabledInteraction,
    viewport: controlledViewport,
    onViewportChange: newViewportHandler,
    onSelect: newSelectHandler,
  }));
});
optionUpdateWrap.dispatchEvent(new window.MouseEvent("pointerup", {
  bubbles: true,
  clientX: 160,
  clientY: 80,
}));
assert(
  oldSelectCalls === 0 && newSelectCalls === 1,
  "an onSelect-only prop update replaces the mounted callback",
);
await act(async () => {
  optionUpdateRoot.render(optionChart({
    interaction: enabledInteraction,
    viewport: undefined,
    onViewportChange: newViewportHandler,
    onSelect: newSelectHandler,
  }));
});
assert(
  optionUpdateHandle?.getSnapshot()?.viewport == null,
  "removing a controlled viewport releases the mounted chart back to its full domain",
);
assert(
  optionUpdateContainer.querySelector("[data-raze-chart-host]") === optionUpdateHost,
  "option-only React updates preserve the mounted host",
);
await act(async () => { optionUpdateRoot.unmount(); });
optionUpdateContainer.remove();

const responsiveContainer = document.createElement("div");
document.body.appendChild(responsiveContainer);
const responsiveRoot = createRoot(responsiveContainer);
let responsiveHandle;
await act(async () => {
  responsiveRoot.render(createElement(
    ResponsiveContainer,
    { width: 510, height: 230 },
    createElement(Chart, {
      definition: defineChart({ marks: [line([{ x: 0, y: 1 }], { x: "x", y: "y" })] }),
      onReady: (handle) => { responsiveHandle = handle; },
    }),
  ));
});
assert(responsiveHandle?.getSnapshot()?.width === 510, "ResponsiveContainer forwards measured width into compilation");
assert(responsiveHandle?.getSnapshot()?.height === 230, "ResponsiveContainer forwards measured height into compilation");
assert(
  responsiveContainer.querySelector("[data-raze-chart-host]")?.style.width === "510px",
  "responsive sizing and the chart host CSS width stay synchronized",
);
assert(
  responsiveContainer.querySelector("[data-raze-chart-host]")?.style.height === "230px",
  "responsive sizing and the chart host CSS height stay synchronized",
);
await act(async () => { responsiveRoot.unmount(); });
responsiveContainer.remove();

const measuredContainer = document.createElement("div");
document.body.appendChild(measuredContainer);
const measuredRoot = createRoot(measuredContainer);
let measuredHandle;
await act(async () => {
  measuredRoot.render(createElement(
    ResponsiveContainer,
    { width: "100%", height: "100%" },
    createElement(Chart, {
      definition: defineChart({ marks: [line([{ x: 0, y: 1 }], { x: "x", y: "y" })] }),
      onReady: (handle) => { measuredHandle = handle; },
    }),
  ));
});
const measuredHost = measuredContainer.querySelector("[data-raze-responsive-container]");
const containerObserver = resizeObservers.find((observer) => observer.observing && observer.target === measuredHost);
assert(containerObserver, "percentage ResponsiveContainer observes its rendered box");
await act(async () => { containerObserver.emit(640, 270); });
assert(measuredHandle?.getSnapshot()?.width === 640, "observed responsive width updates compilation in place");
assert(measuredHandle?.getSnapshot()?.height === 270, "observed responsive height updates compilation in place");
assert(measuredContainer.querySelector("[data-raze-chart-host]")?.style.width === "640px", "observed width reaches host CSS");
assert(measuredContainer.querySelector("[data-raze-chart-host]")?.style.height === "270px", "observed height reaches host CSS");
await act(async () => { measuredRoot.unmount(); });
measuredContainer.remove();

const fallbackContainer = document.createElement("div");
document.body.appendChild(fallbackContainer);
const fallbackRoot = createRoot(fallbackContainer);
const Typed = createChartComponents({ xKey: "month", valueKey: "revenue" });
let fallbackHandle;
await act(async () => {
  fallbackRoot.render(createElement(Typed.LineChart, {
    data: [{ month: "Jan", revenue: 7 }, { month: "Feb", revenue: 11 }],
    width: 320,
    height: 180,
    onReady: (handle) => { fallbackHandle = handle; },
  }));
});
assert(fallbackHandle?.getScene()?.xTicks.some((tick) => tick.label === "Feb"), "typed factory defaults use declared datum keys without JSX children");
assert(fallbackHandle?.getScene()?.lastValues.some((item) => item.label === "11"), "typed factory valueKey drives its truthful fallback series");
await act(async () => { fallbackRoot.unmount(); });
fallbackContainer.remove();

class ErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    return this.state.error
      ? createElement("div", { "data-test-error": "" }, this.state.error.message)
      : this.props.children;
  }
}

const originalConsoleError = console.error;
const unsupportedSeriesCases = [
  [Typed.LineChart, Typed.Line, { fill: "red" }, "fill"],
  [Typed.AreaChart, Typed.Area, { stackId: "totals" }, "stackId"],
  [Typed.BarChart, Typed.Bar, { strokeWidth: 2 }, "strokeWidth"],
  [Typed.ScatterChart, Typed.Scatter, { innerRadius: 12 }, "innerRadius"],
  [Typed.PieChart, Typed.Pie, { stroke: "red" }, "stroke"],
  [Typed.RadarChart, Typed.Radar, { r: 4 }, "r"],
  [Typed.HeatmapChart, Typed.Heatmap, { fill: "red" }, "fill"],
];
for (const [ChartComponent, SeriesComponent, unsupportedProps, propName] of unsupportedSeriesCases) {
  const caseContainer = document.createElement("div");
  document.body.appendChild(caseContainer);
  const caseRoot = createRoot(caseContainer);
  console.error = () => {};
  try {
    await act(async () => {
      caseRoot.render(createElement(
        ErrorBoundary,
        null,
        createElement(
          ChartComponent,
          { data: [{ month: "Jan", revenue: 7 }], width: 320, height: 180 },
          createElement(SeriesComponent, { dataKey: "revenue", ...unsupportedProps }),
        ),
      ));
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert(
    caseContainer.querySelector("[data-test-error]")?.textContent.includes(`prop \"${propName}\"`),
    `${SeriesComponent.name} fails actionably instead of ignoring unsupported ${propName}`,
  );
  await act(async () => { caseRoot.unmount(); });
  caseContainer.remove();
}

const divergentStyleContainer = document.createElement("div");
document.body.appendChild(divergentStyleContainer);
const divergentStyleRoot = createRoot(divergentStyleContainer);
console.error = () => {};
try {
  await act(async () => {
    divergentStyleRoot.render(createElement(
      ErrorBoundary,
      null,
      createElement(Chart, {
        definition: countedDefinition,
        width: 320,
        height: 180,
        style: { width: "50%" },
      }),
    ));
  });
} finally {
  console.error = originalConsoleError;
}
assert(
  divergentStyleContainer.querySelector("[data-test-error]")?.textContent.includes("style cannot set width or height"),
  "Chart rejects CSS dimensions that could diverge from compiled geometry",
);
await act(async () => { divergentStyleRoot.unmount(); });
divergentStyleContainer.remove();

for (const [name, responsiveProps, child, expected] of [
  [
    "layout style",
    { width: 320, height: 180, style: { position: "absolute" } },
    createElement(Chart, { definition: countedDefinition }),
    "style cannot override width, height, position, or minWidth",
  ],
  [
    "non-chart child",
    { width: 320, height: 180 },
    createElement("div"),
    "requires exactly one chart element",
  ],
]) {
  const invalidResponsiveContainer = document.createElement("div");
  document.body.appendChild(invalidResponsiveContainer);
  const invalidResponsiveRoot = createRoot(invalidResponsiveContainer);
  console.error = () => {};
  try {
    await act(async () => {
      invalidResponsiveRoot.render(createElement(
        ErrorBoundary,
        null,
        createElement(ResponsiveContainer, responsiveProps, child),
      ));
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert(
    invalidResponsiveContainer.querySelector("[data-test-error]")?.textContent.includes(expected),
    `ResponsiveContainer rejects ${name} instead of silently overriding it`,
  );
  await act(async () => { invalidResponsiveRoot.unmount(); });
  invalidResponsiveContainer.remove();
}

const guardedContainer = document.createElement("div");
document.body.appendChild(guardedContainer);
const guardedRoot = createRoot(guardedContainer);
console.error = () => {};
try {
  await act(async () => {
    guardedRoot.render(createElement(
      ErrorBoundary,
      null,
      createElement(Typed.HeatmapChart, {
        data: [{ month: "Jan", revenue: 7 }],
        width: 320,
        height: 180,
      }),
    ));
  });
} finally {
  console.error = originalConsoleError;
}
assert(
  guardedContainer.querySelector("[data-test-error]")?.textContent.includes("heatmapYKey"),
  "typed heatmaps fail actionably when neither heatmapYKey nor YAxis is declared",
);
await act(async () => { guardedRoot.unmount(); });
guardedContainer.remove();

const readyFailureContainer = document.createElement("div");
document.body.appendChild(readyFailureContainer);
const readyFailureRoot = createRoot(readyFailureContainer);
console.error = () => {};
try {
  await act(async () => {
    readyFailureRoot.render(createElement(
      ErrorBoundary,
      null,
      createElement(Chart, {
        definition: countedDefinition,
        width: 320,
        height: 180,
        onReady: () => { throw new Error("consumer onReady failed"); },
      }),
    ));
  });
} finally {
  console.error = originalConsoleError;
}
assert(
  readyFailureContainer.querySelector("[data-test-error]")?.textContent.includes("consumer onReady failed"),
  "onReady failures reach the nearest React error boundary",
);
assert(activeObservers === 0, "an onReady exception rolls back its observer and mounted DOM");
await act(async () => { readyFailureRoot.unmount(); });
readyFailureContainer.remove();

const brushHandles = [];
const brushContainer = document.createElement("div");
document.body.appendChild(brushContainer);
const brushRoot = createRoot(brushContainer);
await act(async () => {
  brushRoot.render(createElement(
    LineChart,
    {
      data: [
        { month: "Jan", revenue: 10 },
        { month: "Feb", revenue: 20 },
        { month: "Mar", revenue: 30 },
        { month: "Apr", revenue: 40 },
      ],
      width: 420,
      height: 240,
      ariaLabel: "Brushed revenue",
      onReady: (handle) => brushHandles.push(handle),
    },
    createElement(Line, { dataKey: "revenue", name: "Revenue" }),
    createElement(XAxis, { dataKey: "month" }),
    createElement(Brush, { startIndex: 0, endIndex: 2, height: 32 }),
  ));
});
assert(brushHandles.length === 1, "Brush mounts without throwing");
assert(brushContainer.querySelector("[data-raze-chart-host]"), "Brush chart still mounts a host");
assert(
  brushHandles[0].getSnapshot()?.diagnostics.visibleRows === 3,
  "categorical Brush retains every row between startIndex and endIndex",
);
assert(
  brushHandles[0].getSnapshot()?.xScale.domain.includes("Feb")
    && !brushHandles[0].getSnapshot()?.xScale.domain.includes("Apr"),
  "categorical Brush emits the complete selected category allow-list",
);
await act(async () => { brushRoot.unmount(); });
brushContainer.remove();

{
  const invalidBrushContainer = document.createElement("div");
  document.body.appendChild(invalidBrushContainer);
  const invalidBrushRoot = createRoot(invalidBrushContainer);
  console.error = () => {};
  try {
    await act(async () => {
      invalidBrushRoot.render(createElement(
        ErrorBoundary,
        null,
        createElement(
          LineChart,
          { data: [{ month: "Jan", revenue: 10 }], width: 320, height: 180 },
          createElement(Line, { dataKey: "revenue" }),
          createElement(Brush, { travellerWidth: 8 }),
        ),
      ));
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert(
    invalidBrushContainer.querySelector("[data-test-error]")?.textContent.includes("travellerWidth"),
    "Brush fails actionably instead of ignoring unsupported travellerWidth",
  );
  await act(async () => { invalidBrushRoot.unmount(); });
  invalidBrushContainer.remove();
}

for (const [name, brushProps, expected] of [
  ["fractional index", { startIndex: 0.5 }, "non-negative integer"],
  ["reversed range", { startIndex: 1, endIndex: 0 }, "cannot exceed"],
  ["out-of-range index", { endIndex: 2 }, "outside data length 2"],
  ["empty dataKey", { dataKey: " " }, "dataKey must be a non-empty string"],
  ["missing dataKey", { dataKey: "missing", startIndex: 0 }, 'dataKey "missing" is missing'],
]) {
  const invalidBrushContainer = document.createElement("div");
  document.body.appendChild(invalidBrushContainer);
  const invalidBrushRoot = createRoot(invalidBrushContainer);
  console.error = () => {};
  try {
    await act(async () => {
      invalidBrushRoot.render(createElement(
        ErrorBoundary,
        null,
        createElement(
          LineChart,
          {
            data: [{ month: "Jan", revenue: 10 }, { month: "Feb", revenue: 20 }],
            width: 320,
            height: 180,
          },
          createElement(Line, { dataKey: "revenue" }),
          createElement(XAxis, { dataKey: "month" }),
          createElement(Brush, brushProps),
        ),
      ));
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert(
    invalidBrushContainer.querySelector("[data-test-error]")?.textContent.includes(expected),
    `Brush rejects ${name} with an actionable error`,
  );
  await act(async () => { invalidBrushRoot.unmount(); });
  invalidBrushContainer.remove();
}

const refContainer = document.createElement("div");
document.body.appendChild(refContainer);
const refRoot = createRoot(refContainer);
await act(async () => {
  refRoot.render(createElement(
    LineChart,
    {
      data: [
        { month: "Jan", revenue: 10 },
        { month: "Feb", revenue: 20 },
      ],
      width: 320,
      height: 180,
      ariaLabel: "Vertical reference",
    },
    createElement(Line, { dataKey: "revenue" }),
    createElement(XAxis, { dataKey: "month" }),
    createElement(ReferenceLine, { x: "Feb" }),
  ));
});
assert(refContainer.querySelector("[data-raze-chart-host]"), "vertical ReferenceLine mounts");
await act(async () => { refRoot.unmount(); });
refContainer.remove();

dom.window.close();
console.log("REACT ADAPTER: PASS");

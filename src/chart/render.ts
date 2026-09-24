// Stable facade for the native renderers. The implementation lives in
// ./render/* (svg, canvas, hit, mount, chips, legend, ...; see
// docs/architecture.md).

export type { SvgRenderOptions } from "./render/svg";
export { renderChartSvg, svgFromCompiled } from "./render/svg";
export { paintChartCanvas } from "./render/canvas";
export { hitTestCompiled, nearestSample, tooltipText } from "./render/hit";
export type {
  ChartPointerEvent,
  MountChartOptions,
  MountHandle,
  MountInteraction,
} from "./render/types";
export { mountChart } from "./render/mount";

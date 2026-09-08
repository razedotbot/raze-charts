import assert from "node:assert/strict";
import {
  CHART_PALETTE,
  DARK_CHART_THEME,
  LIGHT_CHART_PALETTE,
  LIGHT_CHART_THEME,
  area,
  bar,
  compileChart,
  defineChart,
  isLightChartColor,
  paintChartCanvas,
  readableTextColor,
  resolveChartTheme,
  svgFromCompiled,
} from "../dist/chart.esm.js";

for (const preset of [DARK_CHART_THEME, LIGHT_CHART_THEME, CHART_PALETTE, LIGHT_CHART_PALETTE]) {
  assert(Object.isFrozen(preset), "public theme presets and palettes are frozen at runtime");
}
assert.throws(() => { CHART_PALETTE[0] = "hotpink"; }, TypeError);
assert.equal(CHART_PALETTE[0], "#66d89e", "a consumer cannot mutate the shared default palette");

const partialLight = resolveChartTheme({
  background: "white",
  text: undefined,
  chipBg: undefined,
  chipFg: "",
});
assert.equal(partialLight.text, LIGHT_CHART_THEME.text, "undefined does not poison a resolved theme");
assert.equal(partialLight.chipBg, LIGHT_CHART_THEME.chipBg, "undefined chip tokens retain the selected preset");
assert.equal(partialLight.chipFg, LIGHT_CHART_THEME.chipFg, "empty chip tokens retain the selected preset");

assert.equal(isLightChartColor("#fff8"), true, "short alpha hex is parsed");
assert.equal(isLightChartColor("rgb(100% 100% 100% / 75%)"), true, "modern RGB syntax is parsed");
assert.equal(isLightChartColor("rgba(255, 255, 255, .75)"), true, "legacy RGBA syntax is parsed");
assert.equal(isLightChartColor("hsl(.5turn 100% 90% / 80%)"), true, "modern HSL syntax and turn units are parsed");
assert.equal(isLightChartColor("rebeccapurple"), false, "common named colours are parsed");
assert.equal(isLightChartColor("#808080"), true, "light/dark selection follows the WCAG contrast crossover");
assert.equal(
  readableTextColor("hsl(0 0% 95%)", LIGHT_CHART_THEME),
  "#000000",
  "heat and last-value labels select an actually contrasting foreground",
);

function recordingContext() {
  const gradients = [];
  const context = {
    globalAlpha: 1,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineJoin: "miter",
    lineCap: "butt",
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    bezierCurveTo() {},
    quadraticCurveTo() {},
    arc() {},
    rect() {},
    clip() {},
    fill() {},
    stroke() {},
    fillRect() {},
    clearRect() {},
    fillText() {},
    setLineDash() {},
    createLinearGradient(...args) {
      const stops = [];
      gradients.push({ args, stops });
      return { addColorStop: (...stop) => stops.push(stop) };
    },
  };
  return { context, gradients };
}

const customFill = "hsla(210 100% 50% / 50%)";
const areaScene = compileChart(defineChart({
  grid: false,
  marks: [area([
    { x: 0, y: 2 },
    { x: 1, y: 5 },
    { x: 2, y: 3 },
  ], { x: "x", y: "y", fill: customFill, fillOpacity: 0.4 })],
}), { width: 360, height: 220 });

const svg = svgFromCompiled(areaScene, { idPrefix: "colour-parity" });
assert(svg.includes(`stop-color="${customFill}" stop-opacity="0.4"`), "SVG preserves custom area colour and opacity");
assert(svg.includes(`offset="78%" stop-color="${customFill}" stop-opacity="0.0381"`), "SVG scales every area stop from fillOpacity");
assert(svg.includes(`offset="100%" stop-color="${customFill}" stop-opacity="0"`), "SVG area gradient ends transparent");

const canvas = recordingContext();
paintChartCanvas(canvas.context, areaScene);
assert.equal(canvas.gradients.length, 1, "Canvas creates the same single area gradient");
assert.deepEqual(canvas.gradients[0].stops[0], [0, "rgba(0,128,255,0.2)"], "Canvas multiplies custom colour alpha by fillOpacity");
assert.deepEqual(canvas.gradients[0].stops[3], [0.78, "rgba(0,128,255,0.019)"], "Canvas uses the same fourth-stop opacity as SVG");
assert.deepEqual(canvas.gradients[0].stops[4], [1, "rgba(0,128,255,0)"], "Canvas area gradient ends transparent");

const orangeBars = compileChart(defineChart({
  marks: [bar([{ x: "A", y: 2 }], { x: "x", y: "y", fill: "orange" })],
}), { width: 300, height: 180 });
const orangeSvg = svgFromCompiled(orangeBars, { idPrefix: "named-bar" });
assert(!orangeSvg.includes("rgb(133,221,173)"), "bar highlights never fall back to an invented green");
assert(orangeSvg.includes("rgb(253,181,50)"), "bar highlights derive from the named custom colour");

console.log("colour/theme regression tests passed");

// Native /chart palettes stay distinguishable for colour-vision deficiencies,
// and the colour-blind presets encode up/down and heatmaps as blue/orange.
import assert from "node:assert/strict";
import {
  CHART_PALETTE,
  COLORBLIND_CHART_THEME,
  COLORBLIND_LIGHT_CHART_THEME,
  DARK_CHART_THEME,
  LIGHT_CHART_PALETTE,
  LIGHT_CHART_THEME,
  bar,
  chartPalette,
  compileChart,
  defineChart,
  heatFill,
  heatmap,
  line,
  parseChartColor,
  resolveChartTheme,
} from "../dist/chart.esm.js";

// Machado, Oliveira & Fernandes (2009), severity 1.0, applied in linear sRGB.
const CVD = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
const VISIONS = [["normal", null], ...Object.entries(CVD)];

function linearRgb(color) {
  const parsed = parseChartColor(color);
  assert.ok(parsed, `${color} parses`);
  return [parsed.r, parsed.g, parsed.b].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
}

function simulate(rgb, matrix) {
  if (!matrix) return rgb;
  return matrix.map((row) => Math.min(1, Math.max(0, row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2])));
}

function lab([r, g, b]) {
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function deltaE(a, b, matrix = null) {
  const la = lab(simulate(linearRgb(a), matrix));
  const lb = lab(simulate(linearRgb(b), matrix));
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}

function luminance(color) {
  const [r, g, b] = linearRgb(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function worstPair(colors) {
  let worst = { value: Infinity };
  for (const [vision, matrix] of VISIONS) {
    for (let i = 0; i < colors.length; i++) {
      for (let j = i + 1; j < colors.length; j++) {
        const value = deltaE(colors[i], colors[j], matrix);
        if (value < worst.value) worst = { value, vision, a: colors[i], b: colors[j] };
      }
    }
  }
  return worst;
}

// The simulator reproduces the audit's finding on the old light palette, so a
// pass below is meaningful: #1769aa / #6750a4 collapsed to about ΔE 2.5.
assert.ok(Math.abs(deltaE("#1769aa", "#6750a4", CVD.deutan) - 2.5) < 0.1, "the CVD simulator matches the audit measurement");

for (const [name, palette, theme] of [
  ["dark", CHART_PALETTE, DARK_CHART_THEME],
  ["light", LIGHT_CHART_PALETTE, LIGHT_CHART_THEME],
]) {
  assert.equal(palette.length, 6, `${name} palette keeps six slots`);
  const worst = worstPair(palette);
  assert.ok(
    worst.value >= 15,
    `${name} palette: every pair is ΔE76 >= 15 under normal, protan, deutan and tritan vision `
      + `(worst ${worst.value.toFixed(1)}: ${worst.a}/${worst.b} under ${worst.vision})`,
  );
  for (const color of palette) {
    assert.ok(contrast(color, theme.background) >= 4.5, `${name} slot ${color} has 4.5:1 contrast with the plot`);
    assert.ok(deltaE(color, theme.text) >= 20, `${name} slot ${color} stays clear of the text colour ${theme.text}`);
    assert.ok(deltaE(color, theme.muted) >= 15, `${name} slot ${color} stays clear of the muted axis colour`);
  }
}
assert.equal(CHART_PALETTE[0], DARK_CHART_THEME.accent, "the first dark series keeps the brand accent");
assert.ok(!CHART_PALETTE.includes(DARK_CHART_THEME.text), "no dark slot reuses the text colour");

// Colour-blind presets.
for (const [name, preset, base] of [
  ["dark", COLORBLIND_CHART_THEME, DARK_CHART_THEME],
  ["light", COLORBLIND_LIGHT_CHART_THEME, LIGHT_CHART_THEME],
]) {
  assert.ok(Object.isFrozen(preset), `${name} colour-blind preset is frozen`);
  assert.deepEqual(Object.keys(preset).sort(), Object.keys(base).sort(), `${name} preset has exactly the theme tokens`);
  for (const key of ["background", "text", "heatZero", "font"]) {
    assert.equal(preset[key], base[key], `${name} preset keeps the ${key} token`);
  }
  const [, accentA, accentB] = lab(linearRgb(preset.accent));
  const [, downA, downB] = lab(linearRgb(preset.down));
  assert.ok(accentB < -20 && Math.abs(accentA) < 20, `${name} preset gains are blue (${preset.accent})`);
  assert.ok(downB > 30 && downA > 15, `${name} preset losses are orange (${preset.down})`);
  const semantic = worstPair([preset.accent, preset.down, preset.gold]);
  assert.ok(semantic.value >= 15, `${name} preset up/down/rule colours separate under every simulation (worst ${semantic.value.toFixed(1)})`);
  for (const key of ["accent", "down", "gold"]) {
    assert.ok(contrast(preset[key], preset.background) >= 4.5, `${name} preset ${key} is legible on its background`);
  }

  const resolved = resolveChartTheme(preset);
  assert.deepEqual(resolved, { ...preset }, `${name} preset resolves as a complete theme`);
  assert.equal(chartPalette(resolved), name === "dark" ? CHART_PALETTE : LIGHT_CHART_PALETTE, `${name} preset uses the CVD-safe palette`);

  // Heatmap: blue for positive, orange for negative, heatZero in the middle.
  const hex = (color) => {
    const parsed = parseChartColor(color);
    return [parsed.r, parsed.g, parsed.b].map(Math.round);
  };
  assert.deepEqual(hex(heatFill(10, -10, 10, preset)), hex(preset.accent), `${name} preset heatmap maximum is blue`);
  assert.deepEqual(hex(heatFill(-10, -10, 10, preset)), hex(preset.down), `${name} preset heatmap minimum is orange`);
  assert.deepEqual(hex(heatFill(0, -10, 10, preset)), hex(preset.heatZero), `${name} preset heatmap zero is neutral`);

  const cells = [];
  for (const [x, z] of [["a", -8], ["b", 0], ["c", 8]]) cells.push({ x, y: "row", z });
  const scene = compileChart(defineChart({
    theme: preset,
    marks: [heatmap(cells, { x: "x", y: "y", valueKey: "z" })],
  }), { width: 360, height: 200 });
  const fills = scene.nodes.filter((node) => node.type === "rect" && typeof node.datum?.z === "number").map((node) => node.fill);
  assert.equal(fills.length, 3, `${name} preset compiles a heatmap through defineChart validation`);
  assert.ok(deltaE(fills[2], preset.accent) < deltaE(fills[2], preset.down), `${name} preset positive cell leans blue`);
  assert.ok(deltaE(fills[0], preset.down) < deltaE(fills[0], preset.accent), `${name} preset negative cell leans orange`);
}

// Heat ramps are monotonic in lightness for every built-in theme, including
// light, whose old ramp dipped through a dark green before rising to teal.
for (const theme of [DARK_CHART_THEME, LIGHT_CHART_THEME, COLORBLIND_CHART_THEME, COLORBLIND_LIGHT_CHART_THEME]) {
  for (const [lo, hi, sign] of [[0, 1, 1], [-1, 1, 1], [-1, 1, -1]]) {
    const lightness = [];
    for (let i = 0; i <= 20; i++) lightness.push(lab(linearRgb(heatFill(sign * i / 20, lo, hi, theme)))[0]);
    const direction = Math.sign(lightness[20] - lightness[0]);
    for (let i = 1; i <= 20; i++) {
      assert.ok((lightness[i] - lightness[i - 1]) * direction >= -1e-6, `heat ramp lightness is monotonic for ${theme.background} ${lo}..${hi}`);
    }
  }
}

// Default series assignment walks the palette in order.
{
  const marks = Array.from({ length: 6 }, (_, i) => line([{ x: 0, y: i }, { x: 1, y: i + 1 }], { x: "x", y: "y", name: `s${i}` }));
  for (const [theme, palette] of [["dark", CHART_PALETTE], ["light", LIGHT_CHART_PALETTE]]) {
    const scene = compileChart(defineChart({ theme, marks }), { width: 480, height: 240 });
    assert.deepEqual(scene.legend.map((entry) => entry.color), [...palette], `${theme} series take the ${theme} palette in order`);
  }
  const bars = compileChart(defineChart({ theme: COLORBLIND_LIGHT_CHART_THEME, marks: [bar([{ x: "a", y: 1 }], { x: "x", y: "y" })] }), { width: 300, height: 200 });
  assert.equal(bars.legend[0].color, LIGHT_CHART_PALETTE[0], "a colour-blind light chart starts from the light palette");
}

console.log("native palette CVD tests passed");

#!/usr/bin/env node
// React adapter with a controlled viewport (W1B-03 review): <Chart viewport
// onViewportChange> echoes every committed window back to the mount through
// update(). The echo repaints the visible window only. The full-data scene
// behind the navigator and the zoom limits is compiled once per definition
// and size, never once per wheel frame.

import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { Chart, defineChart, line } from "../dist/react.esm.js";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.SVGElement = dom.window.SVGElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// The navigator paints a Canvas sparkline; jsdom has no 2D context, so record nothing.
dom.window.HTMLCanvasElement.prototype.getContext = function getContext() {
  return new Proxy({}, { get: () => () => ({ addColorStop() {} }), set: () => true });
};

// A manual animation-frame queue, so a test controls when wheel frames run.
const frames = new Map();
let frameSeq = 0;
globalThis.requestAnimationFrame = (callback) => {
  const id = ++frameSeq;
  frames.set(id, callback);
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  frames.delete(id);
};
function flushFrames() {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
}

let failures = 0;
async function check(name, run) {
  try {
    await run();
    console.log(`✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`✗ ${name}\n  ${error?.stack ?? error}`);
  }
}

const rows = Array.from({ length: 20_000 }, (_, i) => ({ x: i, y: Math.sin(i / 40) }));
const WIDTH = 480;
const HEIGHT = 280;
const WINDOW = `${WIDTH}x${HEIGHT}`;

for (const navigator of [false, true]) {
  await check(`a controlled viewport prop repaints only the window per wheel frame (navigator ${navigator ? "on" : "off"})`, async () => {
    const sizes = [];
    const definition = defineChart((size) => {
      sizes.push(`${size.width}x${size.height}`);
      return { marks: [line(rows, { x: "x", y: "y", name: "Echo" })], legend: false };
    });
    const interaction = { navigator };
    let rendered = null;
    function Controlled() {
      const [viewport, setViewport] = useState({ x: [5_000, 15_000] });
      rendered = viewport;
      return createElement(Chart, {
        definition,
        width: WIDTH,
        height: HEIGHT,
        interaction,
        viewport,
        onViewportChange: setViewport,
      });
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(Controlled));
    });
    const wrap = container.querySelector("[data-raze-chart-host]")?.firstElementChild;
    assert(wrap, "the chart mounted");
    wrap.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: WIDTH, bottom: HEIGHT, width: WIDTH, height: HEIGHT, toJSON() {},
    });
    assert.equal(sizes.filter((size) => size !== WINDOW).length, 1, "mounting compiles the full data once");

    for (let frame = 0; frame < 5; frame++) {
      const before = sizes.length;
      const span = rendered.x[1] - rendered.x[0];
      for (let i = 0; i < 10; i++) {
        wrap.dispatchEvent(new window.WheelEvent("wheel", {
          bubbles: true, cancelable: true, clientX: WIDTH / 2, clientY: HEIGHT / 2, deltaY: -40,
        }));
      }
      assert.equal(sizes.length, before, "wheel events do not compile synchronously");
      // The frame commits the window; React re-renders and its effect echoes it back.
      await act(async () => {
        flushFrames();
      });
      const compiled = sizes.slice(before);
      assert.deepEqual(compiled, [WINDOW, WINDOW], `frame ${frame}: one window compile for the wheel frame and one for the echo (${compiled.join(", ")})`);
      assert(rendered.x[1] - rendered.x[0] < span, `frame ${frame}: the controlled window zoomed in`);
    }
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
}

dom.window.close();
if (failures) {
  console.error(`REACT CONTROLLED VIEWPORT: ${failures} FAILED`);
  process.exit(1);
}
console.log("REACT CONTROLLED VIEWPORT: PASS");

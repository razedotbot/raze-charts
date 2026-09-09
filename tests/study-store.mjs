import assert from "node:assert/strict";
import {
  BUILTIN_STUDIES,
  Delegate,
  StudyRegistry,
  StudyStore,
} from "../dist/charting_library.esm.js";

const bar = (time, close) => ({
  time,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: close * 10,
});

const closeEnough = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] === null || expected[i] === null) {
      assert.equal(actual[i], expected[i], `warm-up value ${i}`);
    } else {
      assert.ok(Math.abs(actual[i] - expected[i]) < 1e-10, `study value ${i}`);
    }
  }
};

const makeContext = (bars) => {
  let paints = 0;
  return {
    context: {
      bars,
      dataChanged: new Delegate(),
      requestPaint: () => { paints += 1; },
    },
    paints: () => paints,
  };
};

{
  const defs = BUILTIN_STUDIES.filter((definition) => ["EMA", "SMA", "RSI"].includes(definition.name));
  const initial = [10, 11, 9, 12, 13, 11].map((close, i) => bar(i * 60_000, close));
  const test = makeContext(initial);
  const store = new StudyStore(test.context, new StudyRegistry(defs));
  for (const definition of defs) assert.ok(store.add({ name: definition.name, length: 3 }));
  const valueArrays = new Map(store.list().map((study) => [study.id, study.values]));

  const paintsAfterAdd = test.paints();
  test.context.dataChanged.fire();
  assert.equal(test.paints(), paintsAfterAdd, "mark-only events do not schedule a redundant study paint");

  test.context.bars[test.context.bars.length - 1] = bar(5 * 60_000, 15);
  test.context.dataChanged.fire();
  for (const study of store.list()) {
    assert.equal(study.values, valueArrays.get(study.id), "forming bars update the cached output in place");
    closeEnough(study.values, study.def.compute(test.context.bars, { length: study.length }));
  }

  test.context.bars.push(bar(6 * 60_000, 14));
  test.context.dataChanged.fire();
  for (const study of store.list()) {
    assert.equal(study.values, valueArrays.get(study.id), "new live bars update the cached output in place");
    closeEnough(study.values, study.def.compute(test.context.bars, { length: study.length }));
  }

  // Exercise repeated forming-bar corrections followed by new bars. This is
  // where recurrence caches most commonly drift from full calculations.
  for (let step = 0; step < 24; step++) {
    const last = test.context.bars.length - 1;
    const nextClose = 8 + ((step * 17) % 13) / 3;
    if (step % 3 === 0) {
      test.context.bars.push(bar(test.context.bars[last].time + 60_000, nextClose));
    } else {
      test.context.bars[last] = bar(test.context.bars[last].time, nextClose);
    }
    test.context.dataChanged.fire();
    for (const study of store.list()) {
      assert.equal(study.values, valueArrays.get(study.id));
      closeEnough(study.values, study.def.compute(test.context.bars, { length: study.length }));
    }
  }

  test.context.bars = [bar(-60_000, 8), ...test.context.bars];
  test.context.dataChanged.fire();
  for (const study of store.list()) {
    assert.notEqual(study.values, valueArrays.get(study.id), "history prepends take the safe full path");
    closeEnough(study.values, study.def.compute(test.context.bars, { length: study.length }));
  }
  store.destroy();
}

{
  const definition = BUILTIN_STUDIES.find((item) => item.name === "EMA");
  const original = definition.compute;
  const test = makeContext([bar(0, 1), bar(60_000, 2), bar(120_000, 3)]);
  const store = new StudyStore(test.context, new StudyRegistry([definition]));
  store.add({ name: definition.name, length: 2 });
  try {
    definition.compute = (bars) => bars.map(() => 42);
    test.context.bars[2] = bar(120_000, 4);
    test.context.dataChanged.fire();
    assert.deepEqual(store.list()[0].values, [42, 42, 42], "mutated public definitions fall back to their compute contract");
  } finally {
    definition.compute = original;
    store.destroy();
  }
}

{
  let calls = 0;
  const custom = {
    name: "Custom cumulative",
    pane: "overlay",
    compute: (bars) => {
      calls += 1;
      let total = 0;
      return bars.map((item) => (total += item.close));
    },
  };
  const test = makeContext([bar(0, 1), bar(60_000, 2)]);
  const store = new StudyStore(test.context, new StudyRegistry([custom]));
  store.add({ name: custom.name });
  test.context.dataChanged.fire();
  assert.equal(calls, 1, "unchanged bars are memoized for custom studies too");

  test.context.bars[1] = bar(60_000, 3);
  test.context.dataChanged.fire();
  assert.equal(calls, 2, "custom studies retain their full-array correctness contract");

  store.destroy();
  test.context.bars[1] = bar(60_000, 4);
  test.context.dataChanged.fire();
  assert.equal(calls, 2, "destroy unsubscribes from ChartContext.dataChanged");
}

{
  const defs = BUILTIN_STUDIES.filter((definition) =>
    ["VWAP", "Bollinger Bands", "MACD"].includes(definition.name),
  );
  const bars = [10, 12, 11, 13, 14, 12, 15, 16].map((close, i) => bar(i * 60_000, close));
  const test = makeContext(bars);
  const store = new StudyStore(test.context, new StudyRegistry(defs));
  assert.ok(store.add({ name: "VWAP" }));
  assert.ok(store.add({ name: "Bollinger Bands", length: 3 }));
  assert.ok(store.add({ name: "MACD" }));
  const vwap = store.list().find((s) => s.name === "VWAP");
  const bb = store.list().find((s) => s.name === "Bollinger Bands");
  const macd = store.list().find((s) => s.name === "MACD");
  assert.ok(vwap.series.length === 1 && vwap.values.some((v) => typeof v === "number"), "VWAP emits a line series");
  assert.ok(bb.series.some((s) => s.style === "band") && bb.series.some((s) => s.style === "line"), "Bollinger emits band plus midline");
  assert.ok(macd.series.some((s) => s.style === "histogram") && macd.def.pane === "pane", "MACD emits a pane histogram");
  store.destroy();
}

console.log("STUDY STORE: PASS");

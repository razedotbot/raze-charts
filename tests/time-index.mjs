import assert from "node:assert/strict";
import { TimeIndex } from "../dist/charting_library.esm.js";

const point = (time) => ({ time });

{
  const minute = 60_000;
  const index = new TimeIndex([0, minute, 2 * minute, 3 * minute].map(point), minute);
  assert.equal(index.indexAt(1.5 * minute), 1.5, "uniform timestamps preserve fractional indices");
  assert.equal(index.timeAt(1.5), 1.5 * minute, "uniform logical indices preserve timestamps");
  assert.equal(index.indexAt(-minute), -1, "left gutter preserves resolution spacing");
  assert.equal(index.timeAt(4), 4 * minute, "right gutter preserves resolution spacing");
}

{
  const hour = 3_600_000;
  // Friday 16:00 -> Monday 09:00 is one adjacent logical step, not 65 bars.
  const friday = Date.UTC(2026, 8, 4, 16);
  const monday = Date.UTC(2026, 8, 7, 9);
  const tuesday = Date.UTC(2026, 8, 8, 9);
  const index = new TimeIndex([friday, monday, tuesday].map(point), hour);

  assert.equal(index.indexAt(friday), 0);
  assert.equal(index.indexAt(monday), 1, "an exact post-gap bar maps to its real logical index");
  assert.equal(index.indexAt(tuesday), 2);

  const midpoint = friday + (monday - friday) / 2;
  assert.equal(index.indexAt(midpoint), 0.5, "a timestamp inside a closed session interpolates adjacent bars");
  assert.equal(index.timeAt(0.5), midpoint, "gap interpolation is reversible");
  assert.equal(index.nearestIndex(midpoint - 1), 0);
  assert.equal(index.nearestIndex(midpoint), 1);
  assert.deepEqual(index.sessionBreaks(), [1, 2], "gaps larger than 1.6x the expected step are session breaks");
  assert.equal(index.timeAt(3), tuesday + hour, "future whitespace uses the expected resolution");
}

{
  const mutable = [point(1_000)];
  const index = new TimeIndex(mutable, 1_000);
  assert.equal(index.indexAt(2_000), 1);
  mutable.push(point(5_000));
  assert.equal(index.indexAt(5_000), 1, "the index observes append-only live series without rebuilding");
  assert.equal(index.indexAt(Number.NaN), null);
  assert.equal(new TimeIndex([]).timeAt(0), null);
}

console.log("TIME INDEX: PASS");

// Shared time & Intl core (src/util/time, src/util/intl.ts, src/engine/timeAxis.ts).
//
// The core is internal (it has no public export yet), so this test bundles
// the sources directly with esbuild. It checks DST-correct zone offsets,
// calendar-aligned weighted ticks for continuous ranges and gapped bar axes,
// the formatter cache, and that every result is identical whatever the
// process time zone is (child processes run under three TZ values).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fingerprintOnly = process.env.RAZE_TIME_CORE_FINGERPRINT === "1";

const workdir = mkdtempSync(join(tmpdir(), "raze-time-core-"));
let core;
try {
  const bundle = await build({
    stdin: {
      contents: [
        'export * from "./src/util/time/index.ts";',
        'export * from "./src/util/intl.ts";',
        'export * from "./src/engine/timeAxis.ts";',
      ].join("\n"),
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "silent",
  });
  const file = join(workdir, "time-core.mjs");
  writeFileSync(file, bundle.outputFiles[0].text);
  core = await import(pathToFileURL(file).href);
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

const {
  DAY_MS,
  HOUR_MS,
  FinancialTimeAxis,
  TICK_LEVELS,
  TickWeight,
  addCalendar,
  barTicks,
  calendarTicks,
  civilFromDays,
  clearIntlCache,
  computeTickWeights,
  dateTimeFormat,
  daysFromCivil,
  floorToCalendar,
  formatNumber,
  getTimeZone,
  intlCacheSize,
  isValidTimeZone,
  numberFormat,
  resolveLocale,
  resolveTimeZoneId,
  tickLevel,
  wallFromFields,
} = core;

const MIN = 60_000;
const SEC = 1_000;
const WEEKDAY = (t) => new Date(t).getUTCDay();
const labels = (ticks) => ticks.map((t) => t.label);

// ---------------------------------------------------------------------------
// Fixtures shared by the in-process checks and the TZ fingerprint.
// ---------------------------------------------------------------------------

/** Equity-style 1-minute sessions (09:30-16:00 local, weekdays) in `zone`. */
function sessions(days, zoneId, start = Date.UTC(2024, 0, 2)) {
  const zone = getTimeZone(zoneId);
  const bars = [];
  for (let day = start; bars.length < days * 390; day += DAY_MS) {
    const wd = WEEKDAY(day);
    if (wd === 0 || wd === 6) continue;
    const d = new Date(day);
    const open = zone.fromWall(wallFromFields(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 9, 30));
    for (let i = 0; i < 390; i++) bars.push({ time: open + i * MIN });
  }
  return bars;
}

function series(start, end, step, skipWeekends = false) {
  const out = [];
  for (let t = start; t < end; t += step) {
    if (skipWeekends && (WEEKDAY(t) === 0 || WEEKDAY(t) === 6)) continue;
    out.push({ time: t });
  }
  return out;
}

function monthly(fromYear, toYear) {
  const out = [];
  for (let y = fromYear; y < toYear; y++) for (let m = 0; m < 12; m++) out.push({ time: Date.UTC(y, m, 1) });
  return out;
}

const ZONES = ["America/New_York", "Australia/Sydney", "Asia/Tokyo"];

function fingerprint() {
  const out = {};
  for (const id of ZONES) {
    const zone = getTimeZone(id);
    const probes = [];
    for (let t = Date.UTC(2023, 0, 1); t < Date.UTC(2025, 0, 1); t += 5 * DAY_MS + 7 * HOUR_MS) probes.push(zone.offset(t));
    const axis = new FinancialTimeAxis({ timeZone: id });
    const bars = sessions(4, id);
    out[id] = {
      probes,
      wall: zone.wallParts(Date.UTC(2024, 10, 3, 6, 30)),
      fromWall: zone.fromWall(wallFromFields(2024, 9, 6, 2, 30)),
      axis: labels(axis.ticks(bars, { from: bars.length - 700, to: bars.length - 1, barSpacing: 1.6 })),
      crosshair: axis.formatCrosshair(Date.UTC(2024, 0, 14, 22), "minutes"),
      days: labels(calendarTicks({ from: Date.UTC(2024, 2, 1), to: Date.UTC(2024, 3, 20), width: 900, timeZone: id })),
      hours: labels(calendarTicks({ from: Date.UTC(2024, 10, 2, 18), to: Date.UTC(2024, 10, 3, 18), width: 1000, timeZone: id })),
      floor: [
        floorToCalendar(Date.UTC(2024, 2, 15, 12), "month", 1, id),
        floorToCalendar(Date.UTC(2024, 0, 10, 12), "week", 1, id),
        floorToCalendar(Date.UTC(2024, 3, 7, 12), "day", 1, id),
      ],
    };
  }
  out.years = labels(calendarTicks({ from: Date.UTC(2015, 0, 1), to: Date.UTC(2025, 0, 1), width: 400 }));
  out.processLocal = { local: new Date(Date.UTC(2024, 0, 1)).getHours() };
  return out;
}

if (fingerprintOnly) {
  process.stdout.write(JSON.stringify(fingerprint()));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Intl formatter cache
// ---------------------------------------------------------------------------

{
  clearIntlCache();
  const a = numberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  const b = numberFormat("en-US", { maximumFractionDigits: 4, minimumFractionDigits: 2 });
  assert.equal(a, b, "option order does not split the cache");
  assert.equal(numberFormat(undefined), numberFormat("en-US"), "the default locale is en-US");
  for (const [value, options] of [
    [89909, undefined],
    [140000.5, { maximumFractionDigits: 0 }],
    [0.000123456, { minimumFractionDigits: 2, maximumFractionDigits: 8 }],
    [-1234.5, { minimumFractionDigits: 2, maximumFractionDigits: 2 }],
    [1e21, undefined],
  ]) {
    assert.equal(formatNumber(value, options), value.toLocaleString("en-US", options), `byte-identical to toLocaleString for ${value}`);
  }
  assert.equal(formatNumber(1234.5, { maximumFractionDigits: 1 }, "de-DE"), "1.234,5", "locales are honoured");
  assert.equal(resolveLocale("EN-us"), "en-US", "locale tags are canonicalised");
  assert.throws(() => resolveLocale("not a locale!"), /Invalid locale "not a locale!".*BCP 47/);
  assert.throws(() => dateTimeFormat("en-US", { timeZone: "Nowhere/Land" }), /Unknown time zone "Nowhere\/Land"/);
  for (let i = 0; i < 300; i++) numberFormat("en-US", { maximumFractionDigits: i % 21, minimumIntegerDigits: 1 + (i % 15) });
  assert.ok(intlCacheSize().number <= 128, "the cache is bounded");
}

// ---------------------------------------------------------------------------
// Zones: DST-correct offsets, disambiguation, validation
// ---------------------------------------------------------------------------

{
  const h = (zone, t) => zone.offset(t) / HOUR_MS;
  const ny = getTimeZone("America/New_York");
  assert.equal(h(ny, Date.UTC(2024, 0, 15)), -5);
  assert.equal(h(ny, Date.UTC(2024, 6, 15)), -4);
  // Spring forward at 2024-03-10 07:00Z, fall back at 2024-11-03 06:00Z, to the second.
  assert.equal(h(ny, Date.UTC(2024, 2, 10, 6, 59, 59)), -5);
  assert.equal(h(ny, Date.UTC(2024, 2, 10, 7)), -4);
  assert.equal(h(ny, Date.UTC(2024, 10, 3, 5, 59, 59)), -4);
  assert.equal(h(ny, Date.UTC(2024, 10, 3, 6)), -5);

  const sydney = getTimeZone("Australia/Sydney");
  // DST ends 2024-04-07 03:00 AEDT (06 Apr 16:00Z) and starts 2024-10-06 02:00 AEST (05 Oct 16:00Z).
  assert.equal(h(sydney, Date.UTC(2024, 3, 6, 15, 59, 59)), 11);
  assert.equal(h(sydney, Date.UTC(2024, 3, 6, 16)), 10);
  assert.equal(h(sydney, Date.UTC(2024, 9, 5, 15, 59, 59)), 10);
  assert.equal(h(sydney, Date.UTC(2024, 9, 5, 16)), 11);

  const tokyo = getTimeZone("Asia/Tokyo");
  for (let t = Date.UTC(2024, 0, 1); t < Date.UTC(2025, 0, 1); t += 3 * DAY_MS + 5 * HOUR_MS) {
    assert.equal(h(tokyo, t), 9, "Tokyo has no DST");
  }
  assert.equal(h(getTimeZone("Australia/Lord_Howe"), Date.UTC(2024, 6, 1)), 10.5, "half-hour zones are exact");
  assert.equal(h(getTimeZone("Australia/Lord_Howe"), Date.UTC(2024, 0, 1)), 11);

  // Audit expectations: New York 22:00Z -> 17:00, 12:00Z -> 07:00; Tokyo 12:00Z -> 21:00.
  const nyAxis = new FinancialTimeAxis({ timeZone: "America/New_York" });
  assert.equal(nyAxis.formatCrosshair(Date.UTC(2024, 0, 14, 22), "minutes"), "14 Jan '24 17:00");
  assert.equal(nyAxis.formatCrosshair(Date.UTC(2024, 0, 15, 12), "hours"), "15 Jan '24 07:00");
  assert.equal(nyAxis.formatCrosshair(Date.UTC(2026, 10, 1, 12), "minutes"), "1 Nov '26 07:00");
  assert.equal(new FinancialTimeAxis({ timeZone: "Asia/Tokyo" }).formatCrosshair(Date.UTC(2026, 10, 1, 12), "minutes"), "1 Nov '26 21:00");
  assert.equal(nyAxis.formatCrosshair(Date.UTC(2024, 0, 15, 12, 0, 5), "seconds"), "15 Jan '24 07:00:05");
  assert.equal(nyAxis.formatCrosshair(Date.UTC(2024, 0, 15, 3), "days"), "14 Jan '24", "daily labels use the local date");
  assert.equal(new FinancialTimeAxis().formatCrosshair(Date.UTC(2024, 0, 14, 22), "minutes"), "14 Jan '24 22:00", "UTC stays byte-identical to the legacy format");
  assert.equal(nyAxis.formatTick(Date.UTC(2024, 0, 15, 14, 30), TickWeight.Minute), "09:30");
  assert.equal(new FinancialTimeAxis({ hourCycle: "h12" }).formatCrosshair(Date.UTC(2024, 0, 14, 17), "minutes"), "14 Jan '24 5:00 PM");

  // Wall -> instant: skipped and repeated local times.
  const gap = wallFromFields(2024, 2, 10, 2, 30);
  assert.equal(ny.fromWall(gap), Date.UTC(2024, 2, 10, 7, 30), "a skipped time moves forward (03:30 EDT)");
  assert.equal(ny.fromWall(gap, "earlier"), Date.UTC(2024, 2, 10, 6, 30));
  assert.throws(() => ny.fromWall(gap, "reject"), /does not exist in America\/New_York/);
  const overlap = wallFromFields(2024, 10, 3, 1, 30);
  assert.equal(ny.fromWall(overlap), Date.UTC(2024, 10, 3, 5, 30), "a repeated time resolves to the earlier instant");
  assert.equal(ny.fromWall(overlap, "later"), Date.UTC(2024, 10, 3, 6, 30));
  assert.throws(() => ny.fromWall(overlap, "reject"), /occurs twice in America\/New_York/);
  for (let t = Date.UTC(2024, 0, 1); t < Date.UTC(2025, 0, 1); t += 7 * HOUR_MS + 13 * MIN) {
    for (const zone of [ny, sydney, tokyo]) {
      const back = zone.fromWall(zone.toWall(t), zone.offset(t) === zone.offset(t - HOUR_MS * 2) ? "earlier" : "later");
      assert.equal(back, t, `${zone.id} round-trips ${new Date(t).toISOString()}`);
    }
  }
  const parts = ny.wallParts(Date.UTC(2024, 10, 3, 6, 30));
  assert.deepEqual(
    [parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.weekday],
    [2024, 10, 3, 1, 30, 0],
    "the repeated hour reads 01:30 on Sunday",
  );

  // Ids, aliases and validation.
  assert.equal(getTimeZone().id, "Etc/UTC");
  assert.equal(getTimeZone("UTC"), getTimeZone("Etc/UTC"), "UTC aliases share one zone");
  assert.equal(getTimeZone("america/new_york"), ny, "ids are case-insensitive and canonicalised");
  assert.equal(getTimeZone("+05:30").offset(0), 5.5 * HOUR_MS);
  assert.equal(getTimeZone("Etc/GMT+5").offset(0), -5 * HOUR_MS, "POSIX Etc/GMT signs are inverted");
  assert.throws(() => getTimeZone("Mars/Olympus_Mons"), /Unknown time zone "Mars\/Olympus_Mons".*IANA/);
  assert.throws(() => getTimeZone(42), TypeError);
  assert.equal(isValidTimeZone("Europe/Rome"), true);
  assert.equal(isValidTimeZone("Europe/Atlantis"), false);
  assert.equal(isValidTimeZone(""), false);
  assert.equal(resolveTimeZoneId("exchange", "America/Chicago"), "America/Chicago");
  assert.equal(resolveTimeZoneId("exchange", undefined), "Etc/UTC");
  assert.equal(resolveTimeZoneId("Asia/Tokyo", "America/Chicago"), "Asia/Tokyo");
  assert.equal(resolveTimeZoneId(undefined, "America/Chicago"), "America/Chicago");
  assert.equal(resolveTimeZoneId(undefined, undefined), "Etc/UTC");
  assert.ok(Number.isNaN(ny.offset(Number.NaN)), "non-finite input propagates as NaN");

  // Civil day arithmetic, including years before 1970 and before 100.
  for (const [y, m, d] of [[1970, 1, 1], [1969, 12, 31], [2000, 2, 29], [1600, 3, 1], [50, 6, 15], [-44, 3, 15], [9999, 12, 31]]) {
    const days = daysFromCivil(y, m, d);
    assert.deepEqual(civilFromDays(days), { year: y, month: m, day: d }, `civil round trip ${y}-${m}-${d}`);
  }
  assert.equal(daysFromCivil(1960, 1, 1) * DAY_MS, Date.UTC(1960, 0, 1));
}

// ---------------------------------------------------------------------------
// Calendar helpers (the floorToBar seam)
// ---------------------------------------------------------------------------

{
  assert.equal(floorToCalendar(Date.UTC(2024, 0, 10, 15), "week"), Date.UTC(2024, 0, 8), "weeks start on Monday");
  assert.equal(floorToCalendar(Date.UTC(2024, 0, 10, 15), "week", 1, null, 0), Date.UTC(2024, 0, 7), "week start is configurable");
  assert.equal(floorToCalendar(Date.UTC(2024, 2, 15), "month"), Date.UTC(2024, 2, 1));
  assert.equal(floorToCalendar(Date.UTC(2024, 4, 15), "month", 3), Date.UTC(2024, 3, 1), "quarters");
  assert.equal(floorToCalendar(Date.UTC(2024, 10, 15), "month", 12), Date.UTC(2024, 0, 1));
  assert.equal(floorToCalendar(Date.UTC(2024, 2, 15, 3), "month", 1, "America/New_York"), Date.UTC(2024, 2, 1, 5), "local month start (EST)");
  assert.equal(floorToCalendar(Date.UTC(2024, 2, 10, 12), "day", 1, "America/New_York"), Date.UTC(2024, 2, 10, 5), "local midnight on a DST day");
  assert.equal(floorToCalendar(Date.UTC(2024, 2, 11, 12), "day", 1, "America/New_York"), Date.UTC(2024, 2, 11, 4), "local midnight after DST");
  assert.equal(floorToCalendar(Date.UTC(2024, 0, 1, 10, 47), "minute", 15), Date.UTC(2024, 0, 1, 10, 45));
  assert.equal(
    addCalendar(Date.UTC(2024, 2, 9, 17), "day", 1, 1, "America/New_York"),
    Date.UTC(2024, 2, 10, 16),
    "adding a local day across spring-forward keeps the clock time (23 elapsed hours)",
  );
  assert.equal(addCalendar(Date.UTC(2024, 0, 31), "month"), Date.UTC(2024, 1, 29), "month ends clamp");
  assert.throws(() => floorToCalendar(0, "month", 0), /positive integer/);
  assert.throws(() => floorToCalendar(0, "week", 1, null, 7), /weekStart/);
}

// ---------------------------------------------------------------------------
// Continuous ranges: 1 s to 10 y, 40 px spacing, weighted calendar labels
// ---------------------------------------------------------------------------

const unitRank = { millisecond: 0, second: 1, minute: 2, hour: 3, day: 4, week: 4, month: 5, year: 6 };

function assertCalendarTicks(ticks, { width, zone, name, minSpacing = 40 }) {
  assert.ok(ticks.length >= 2, `${name}: at least two ticks (${labels(ticks).join(" ")})`);
  const tz = getTimeZone(zone);
  for (let i = 0; i < ticks.length; i++) {
    const tick = ticks[i];
    assert.ok(tick.x >= -1e-6 && tick.x <= width + 1e-6, `${name}: tick inside the range`);
    if (i > 0) {
      assert.ok(tick.x - ticks[i - 1].x >= minSpacing - 1e-6, `${name}: ${ticks[i - 1].label} -> ${tick.label} keeps ${minSpacing}px`);
      assert.ok(tick.time > ticks[i - 1].time, `${name}: ticks ascend`);
    }
    const level = tickLevel(tick.weight);
    assert.equal(level.unit, tick.unit);
    // Calendar alignment: the tick is the start of its own rung's period.
    const floored = floorToCalendar(tick.time, level.unit, level.step, tz);
    assert.equal(floored, tick.time, `${name}: ${tick.label} (${new Date(tick.time).toISOString()}) sits on a ${level.step} ${level.unit} boundary`);
    const wall = tz.wallParts(tick.time);
    if (tick.unit === "year") assert.equal(tick.label, String(wall.year), `${name}: a year boundary shows the year`);
    if (tick.unit === "month") assert.equal(tick.label, ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][wall.month]);
    if (tick.unit === "day" || tick.unit === "week") assert.equal(tick.label, String(wall.day), `${name}: a day boundary shows its day number`);
  }
  assert.equal(new Set(ticks.map((t) => t.time)).size, ticks.length, `${name}: unique instants`);
}

{
  const t0 = Date.UTC(2024, 0, 15, 9, 30);
  const spans = [
    ["1s", SEC], ["10s", 10 * SEC], ["1m", MIN], ["20m", 20 * MIN], ["6.5h", 6.5 * HOUR_MS], ["1d", DAY_MS],
    ["5d", 5 * DAY_MS], ["1mo", 31 * DAY_MS], ["3mo", 92 * DAY_MS], ["1y", 366 * DAY_MS], ["2y", 731 * DAY_MS],
    ["5y", 1826 * DAY_MS], ["10y", 3653 * DAY_MS], ["40y", 14610 * DAY_MS],
  ];
  for (const zone of ["Etc/UTC", ...ZONES]) {
    for (const width of [400, 800, 1600]) {
      for (const [name, span] of spans) {
        if (span < 10 * SEC && width < 800) continue;
        const ticks = calendarTicks({ from: t0, to: t0 + span, width, timeZone: zone });
        assertCalendarTicks(ticks, { width, zone, name: `${zone} ${name} @${width}px` });
      }
    }
  }

  // Weights order the labels: year > month > day > hour.
  const twoYears = calendarTicks({ from: Date.UTC(2024, 0, 1), to: Date.UTC(2026, 0, 1), width: 800 });
  assert.deepEqual(labels(twoYears), ["2024", "Apr", "Jul", "Oct", "2025", "Apr", "Jul", "Oct", "2026"]);
  assert.ok(twoYears[0].weight > twoYears[1].weight && twoYears[1].weight >= TickWeight.Month);

  const decade = calendarTicks({ from: Date.UTC(2015, 0, 1), to: Date.UTC(2025, 0, 1), width: 400 });
  assert.deepEqual(labels(decade), ["2016", "2018", "2020", "2022", "2024"], "2-year and 5-year rungs are never interleaved");
  assert.ok(labels(calendarTicks({ from: Date.UTC(2015, 0, 1), to: Date.UTC(2025, 0, 1), width: 1200 })).includes("Jul"));

  const intraday = calendarTicks({ from: Date.UTC(2024, 8, 9, 9, 30), to: Date.UTC(2024, 8, 9, 16), width: 400 });
  assert.ok(new Set(labels(intraday)).size >= 4, `6.5 h shows at least four distinct HH:mm labels (${labels(intraday)})`);
  assert.ok(labels(intraday).every((l) => /^\d\d:\d\d$/.test(l)));

  const month = calendarTicks({ from: Date.UTC(2024, 0, 1), to: Date.UTC(2024, 1, 1), width: 800 });
  assert.deepEqual(labels(month), ["2024", "8", "15", "22", "29", "Feb"], "Mondays between month starts");

  const acrossMidnight = calendarTicks({ from: Date.UTC(2024, 0, 14, 20), to: Date.UTC(2024, 0, 15, 4), width: 600 });
  assert.ok(acrossMidnight.some((t) => t.label === "15" && (t.unit === "day" || t.unit === "week")), "a day boundary inside an intraday range shows the date");

  // Local midnight in New York, not UTC midnight.
  const nyDays = calendarTicks({ from: Date.UTC(2024, 2, 1), to: Date.UTC(2024, 2, 20), width: 1200, timeZone: "America/New_York" });
  const ny = getTimeZone("America/New_York");
  for (const t of nyDays.filter((x) => x.unit === "day" || x.unit === "week")) assert.equal(ny.wallParts(t.time).hour, 0, `${t.label} is local midnight`);

  // DST: the fall-back hour is labelled twice, the spring-forward hour never.
  const fall = labels(calendarTicks({ from: Date.UTC(2024, 10, 3, 3), to: Date.UTC(2024, 10, 3, 10), width: 1200, timeZone: "America/New_York" }));
  assert.equal(fall.filter((l) => l === "01:00").length, 2, `repeated 01:00 (${fall})`);
  const spring = labels(calendarTicks({ from: Date.UTC(2024, 2, 10, 3), to: Date.UTC(2024, 2, 10, 10), width: 1200, timeZone: "America/New_York" }));
  assert.ok(!spring.includes("02:00") && spring.includes("01:00") && spring.includes("03:00"), `no 02:00 on spring-forward (${spring})`);
  const syd = labels(calendarTicks({ from: Date.UTC(2024, 3, 6, 12), to: Date.UTC(2024, 3, 6, 20), width: 1200, timeZone: "Australia/Sydney" }));
  assert.equal(syd.filter((l) => l === "02:00").length, 2, `Sydney repeats 02:00 when DST ends (${syd})`);

  // Measured labels never overlap; maxTicks is a hard budget.
  const measure = (s) => s.length * 7;
  const measured = calendarTicks({ from: Date.UTC(2024, 0, 1), to: Date.UTC(2024, 0, 3), width: 400, measure, labelGap: 6 });
  for (let i = 1; i < measured.length; i++) {
    const need = (measure(measured[i - 1].label) + measure(measured[i].label)) / 2 + 6;
    assert.ok(measured[i].x - measured[i - 1].x >= need, "measured labels do not overlap");
  }
  assert.ok(calendarTicks({ from: Date.UTC(2020, 0, 1), to: Date.UTC(2024, 0, 1), width: 2000, maxTicks: 5 }).length <= 5);
  assert.ok(calendarTicks({ from: new Date(Date.UTC(1960, 0, 1)), to: new Date(Date.UTC(1965, 0, 1)), width: 600 }).some((t) => t.label === "1962"), "pre-1970 dates");
  assert.deepEqual(calendarTicks({ from: 0, to: 1000, width: 0 }), []);
  assert.throws(() => calendarTicks({ from: Number.NaN, to: 1, width: 100 }), /finite time range/);
  assert.throws(() => calendarTicks({ from: 0, to: 1, width: 100, minSpacing: 0 }), /minSpacing/);
  assert.throws(() => calendarTicks({ from: 0, to: 1, width: 100, timeZone: "Bad/Zone" }), /Unknown time zone/);
  assert.equal(TICK_LEVELS.length, TICK_LEVELS[TICK_LEVELS.length - 1].weight);
}

// ---------------------------------------------------------------------------
// Logical bar axes: gapped sessions, daily/weekly/monthly, live appends
// ---------------------------------------------------------------------------

function assertBarTicks(ticks, bars, { barSpacing, name, minSpacing = 40 }) {
  assert.ok(ticks.length >= 2, `${name}: at least two ticks (${labels(ticks).join(" ")})`);
  for (let i = 1; i < ticks.length; i++) {
    const px = (ticks[i].index - ticks[i - 1].index) * barSpacing;
    assert.ok(px >= minSpacing - 1e-6, `${name}: ${ticks[i - 1].label} -> ${ticks[i].label} is ${px.toFixed(1)}px`);
  }
  for (const t of ticks) assert.equal(t.time, bars[t.index].time, `${name}: ticks sit on bars`);
}

{
  const axis = new FinancialTimeAxis({ timeZone: "America/New_York" });
  const eq = sessions(6, "America/New_York");
  const counts = [];
  for (const width of [500, 1002, 2000]) {
    const barSpacing = width / 500;
    const ticks = axis.ticks(eq, { from: eq.length - 500, to: eq.length - 1, barSpacing });
    assertBarTicks(ticks, eq, { barSpacing, name: `sessions @${width}px` });
    assert.ok(ticks.some((t) => (t.unit === "day" || t.unit === "week") && axis.timeZone.wallParts(t.time).hour === 9), "a session open shows its date");
    assert.ok(ticks.filter((t) => t.unit !== "day" && t.unit !== "week").every((t) => /^\d\d:\d\d$/.test(t.label)), "intraday ticks show HH:mm");
    counts.push(ticks.length);
  }
  assert.ok(counts[0] >= 7 && counts[0] < counts[1] && counts[1] < counts[2], `label count scales with plot width (${counts})`);

  // Same bar count with 17.5 h overnight gaps only vs. with weekend gaps: same density.
  const weekdaysOnly = sessions(6, "America/New_York", Date.UTC(2024, 0, 8));
  const withWeekend = sessions(6, "America/New_York", Date.UTC(2024, 0, 3));
  const a = axis.ticks(weekdaysOnly, { from: 390, to: 390 + 1199, barSpacing: 1 });
  const b = axis.ticks(withWeekend, { from: 390, to: 390 + 1199, barSpacing: 1 });
  assert.ok(Math.abs(a.length - b.length) <= 1, `gap size does not change density (${a.length} vs ${b.length})`);

  const utc = new FinancialTimeAxis();
  const fixtures = [
    ["1s", series(Date.UTC(2024, 0, 2, 14), Date.UTC(2024, 0, 2, 16), SEC), [2, 12, 40]],
    ["1m", series(Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 8), MIN), [0.5, 3, 30]],
    ["1h", series(Date.UTC(2023, 0, 1), Date.UTC(2024, 0, 1), HOUR_MS), [0.2, 2, 30]],
    ["1D", series(Date.UTC(2015, 0, 1), Date.UTC(2025, 0, 1), DAY_MS, true), [0.15, 0.3, 1.6, 8, 50]],
    ["1W", series(Date.UTC(2010, 0, 4), Date.UTC(2025, 0, 1), 7 * DAY_MS), [1, 5, 15, 60]],
    ["1M", monthly(1990, 2025), [1, 4, 12, 60]],
  ];
  for (const [name, bars, spacings] of fixtures) {
    for (const barSpacing of spacings) {
      const n = Math.min(bars.length, Math.floor(1200 / barSpacing));
      const ticks = utc.ticks(bars, { from: bars.length - n, to: bars.length - 1, barSpacing });
      assertBarTicks(ticks, bars, { barSpacing, name: `${name} @${barSpacing}px/bar` });
      const years = ticks.filter((t) => t.unit === "year").map((t) => t.label);
      assert.equal(new Set(years).size, years.length, `${name}: year labels are unique`);
      for (const t of ticks) {
        if (t.unit === "year") assert.match(t.label, /^\d{4}$/);
        if (t.unit === "month") assert.match(t.label, /^[A-Z][a-z]{2}$/);
      }
    }
  }

  const daily = fixtures[3][1];
  const tenYears = utc.ticks(daily, { from: 0, to: daily.length - 1, barSpacing: 800 / daily.length });
  assert.deepEqual(labels(tenYears), ["2015", "2016", "2017", "2018", "2019", "2020", "2021", "2022", "2023", "2024"], "ten years of daily bars label every year");
  const tenYearsNarrow = utc.ticks(daily, { from: 0, to: daily.length - 1, barSpacing: 400 / daily.length });
  assert.deepEqual(labels(tenYearsNarrow), ["2016", "2018", "2020", "2022", "2024"], "a crowded year rung is dropped whole, not thinned irregularly");
  const twoYears = utc.ticks(daily, { from: daily.length - 522, to: daily.length - 1, barSpacing: 1000 / 522 });
  assert.ok(labels(twoYears).includes("2024") && labels(twoYears).includes("Jul"), `two years of dailies show years and months (${labels(twoYears)})`);
  assert.ok(twoYears.find((t) => t.unit === "year").major, "heavier units are flagged major");

  // Crossing DST in New York on hourly bars keeps one label per local boundary.
  const hourly = series(Date.UTC(2024, 10, 1), Date.UTC(2024, 10, 6), HOUR_MS);
  const dst = axis.ticks(hourly, { from: 0, to: hourly.length - 1, barSpacing: 12 });
  assertBarTicks(dst, hourly, { barSpacing: 12, name: "hourly across fall-back" });
  const ny = axis.timeZone;
  for (const t of dst.filter((x) => x.unit === "day" || x.unit === "week")) assert.equal(ny.wallParts(t.time).hour, 0, "day ticks at local midnight");

  // Sparse, irregular bars still get labels across the whole axis.
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const sparse = [];
  for (let i = 0, t = Date.UTC(2024, 5, 3); i < 600; i++) sparse.push({ time: (t += MIN * (rnd() < 0.8 ? 1 : Math.ceil(rnd() * 120))) });
  const sparseTicks = utc.ticks(sparse, { from: 0, to: 599, barSpacing: 2 });
  assertBarTicks(sparseTicks, sparse, { barSpacing: 2, name: "sparse bars" });
  assert.ok(sparseTicks.length >= 6, "sparse data keeps a usable number of labels");

  // Weight cache: appends are incremental and equal a full recompute; prepends recompute.
  const live = new FinancialTimeAxis({ timeZone: "Asia/Tokyo" });
  const bars = series(Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 20), 15 * MIN).slice();
  const first = live.weights(bars).slice(0, bars.length);
  assert.equal(live.weights(bars), live.weights(bars), "an unchanged series reuses its weights");
  for (let i = 0; i < 500; i++) bars.push({ time: bars[bars.length - 1].time + 15 * MIN });
  const grown = live.weights(bars);
  assert.deepEqual([...grown.slice(0, bars.length)], [...computeTickWeights(bars, "Asia/Tokyo")], "appended weights match a full recompute");
  assert.deepEqual([...grown.slice(0, first.length)], [...first]);
  bars.unshift({ time: bars[0].time - 15 * MIN });
  assert.deepEqual([...live.weights(bars).slice(0, bars.length)], [...computeTickWeights(bars, "Asia/Tokyo")], "a prepend recomputes");
  live.setOptions({ timeZone: "America/New_York" });
  assert.deepEqual([...live.weights(bars).slice(0, bars.length)], [...computeTickWeights(bars, "America/New_York")], "setOptions({ timeZone }) invalidates the cache");

  // Measured labels keep clear of each other on a bar axis too.
  const measure = (s) => s.length * 7;
  const measured = utc.ticks(daily, { from: daily.length - 300, to: daily.length - 1, barSpacing: 3, measure });
  for (let i = 1; i < measured.length; i++) {
    const need = (measure(measured[i - 1].label) + measure(measured[i].label)) / 2 + 8;
    assert.ok((measured[i].index - measured[i - 1].index) * 3 >= need, "measured bar labels do not overlap");
  }

  assert.deepEqual(utc.ticks([], { from: 0, to: 10, barSpacing: 5 }), []);
  assert.throws(() => barTicks({ bars: daily, weights: new Uint8Array(3), from: 0, to: 10, barSpacing: 5 }), /weight per bar/);
  assert.throws(() => barTicks({ bars: [{ time: 0 }], weights: [99], from: 0, to: 0, barSpacing: 5 }), /Invalid tick weight 99/);
  assert.throws(() => utc.ticks(daily, { from: 0, to: 10, barSpacing: 0 }), /barSpacing/);
  assert.throws(() => new FinancialTimeAxis({ weekStart: 9 }), /weekStart/);
  assert.throws(() => new FinancialTimeAxis({ minSpacing: -1 }), /minSpacing/);
  assert.throws(() => new FinancialTimeAxis({ timeZone: "Nope/Nope" }), /Unknown time zone/);
  assert.throws(() => new FinancialTimeAxis({ hourCycle: "h25" }), /hourCycle/);
  const kept = new FinancialTimeAxis({ timeZone: "Asia/Tokyo" });
  assert.throws(() => kept.setOptions({ timeZone: "Nope/Nope", minSpacing: 20 }), /Unknown time zone/);
  assert.equal(kept.timeZone.id, "Asia/Tokyo", "a rejected setOptions leaves the axis unchanged");
  assert.throws(() => kept.setOptions({ minSpacing: 0 }), /minSpacing/);
  assert.equal(kept.ticks(daily, { from: 0, to: 400, barSpacing: 2 }).length > 0, true, "and still usable");

  // Performance guard (generous; catches accidental per-bar Intl work).
  const big = series(Date.UTC(2020, 0, 1), Date.UTC(2020, 0, 1) + 300_000 * MIN, MIN);
  const perfAxis = new FinancialTimeAxis({ timeZone: "America/New_York" });
  let start = performance.now();
  perfAxis.weights(big);
  const weightMs = performance.now() - start;
  start = performance.now();
  for (let i = 0; i < 20; i++) perfAxis.ticks(big, { from: 0, to: big.length - 1, barSpacing: 1200 / big.length });
  const fullViewMs = (performance.now() - start) / 20;
  assert.ok(weightMs < 1500, `weights for 300k bars took ${weightMs.toFixed(1)}ms`);
  assert.ok(fullViewMs < 100, `a fully zoomed-out tick pass took ${fullViewMs.toFixed(1)}ms`);
}

// ---------------------------------------------------------------------------
// Identical results whatever the process time zone is.
// ---------------------------------------------------------------------------

{
  const expected = JSON.stringify(fingerprint());
  const localHours = new Set();
  for (const tz of ["UTC", "America/Los_Angeles", "Asia/Kolkata"]) {
    const output = execFileSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, TZ: tz, RAZE_TIME_CORE_FINGERPRINT: "1" },
      encoding: "utf8",
    });
    const parsed = JSON.parse(output);
    localHours.add(parsed.processLocal.local);
    delete parsed.processLocal;
    const mine = JSON.parse(expected);
    delete mine.processLocal;
    assert.deepEqual(parsed, mine, `TZ=${tz} produces identical offsets, ticks and labels`);
  }
  assert.equal(localHours.size, 3, "the child processes really ran under three different process time zones");
}

console.log("TIME CORE: PASS");

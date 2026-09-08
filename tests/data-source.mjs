import { createDatafeed, defineDataSource } from "../dist/charting_library.esm.js";

const assert = (condition, message) => {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  console.log(`✓ ${message}`);
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const info = {
  name: "TEST",
  ticker: "TEST",
  session: "24x7",
  timezone: "Etc/UTC",
  exchange: "Raze",
  minmov: 1,
  pricescale: 100,
};
const bar = { time: 1_700_000_000_000, open: 1, high: 3, low: 1, close: 2 };

let cleanupCount = 0;
let releaseSubscription;
const subscriptionSetup = new Promise((resolve) => { releaseSubscription = resolve; });
const source = defineDataSource({
  configuration: { supported_resolutions: ["1", "5"] },
  async resolveSymbol(symbol) { return { ...info, name: symbol, ticker: symbol }; },
  async getBars(request) {
    assert(request.symbol === "TEST" && request.countBack === 20, "native history request is normalized");
    return { bars: [bar], meta: { noData: false } };
  },
  async subscribeBars(request, handlers) {
    assert(request.signal instanceof AbortSignal, "native realtime receives an AbortSignal");
    await subscriptionSetup;
    handlers.next(bar);
    return () => { cleanupCount += 1; };
  },
});

const feed = createDatafeed(source);
let synchronous = true;
const ready = new Promise((resolve) => feed.onReady((config) => {
  assert(!synchronous, "onReady is always asynchronous");
  assert(config.supported_resolutions?.join(",") === "1,5", "native configuration reaches the widget adapter");
  resolve();
}));
synchronous = false;
await ready;

await new Promise((resolve, reject) => feed.resolveSymbol("TEST", (resolved) => {
  assert(resolved.ticker === "TEST", "Promise-based symbol resolution is adapted");
  resolve();
}, reject));

await new Promise((resolve, reject) => feed.getBars(
  info,
  "1",
  { from: 1, to: 2, countBack: 20, firstDataRequest: true },
  (bars, meta) => {
    assert(bars.length === 1 && meta?.noData === false, "Promise-based history result is adapted");
    resolve();
  },
  reject,
));

let lateTicks = 0;
feed.subscribeBars(info, "1", () => { lateTicks += 1; }, "async", () => {});
feed.unsubscribeBars("async");
releaseSubscription();
await tick();
assert(lateTicks === 0, "unsubscribe suppresses ticks from late async setup");
assert(cleanupCount === 1, "late async subscription cleanup runs exactly once");

let liveTicks = 0;
const immediate = createDatafeed(defineDataSource({
  resolveSymbol: async () => info,
  getBars: async () => [],
  subscribeBars(_request, handlers) {
    handlers.next(bar);
    return () => { cleanupCount += 1; };
  },
}));
immediate.subscribeBars(info, "1", () => { liveTicks += 1; }, "live", () => {});
await tick();
assert(liveTicks === 1, "active realtime ticks are delivered");
immediate.unsubscribeBars("live");
assert(cleanupCount === 2, "active subscription cleanup runs on unsubscribe");

const failing = createDatafeed(defineDataSource({
  configuration() { throw new Error("config failed"); },
  resolveSymbol() { throw new Error("symbol failed"); },
  getBars() { throw new Error("history failed"); },
}));
await new Promise((resolve) => failing.onReady((configuration) => {
  assert(Array.isArray(configuration.supported_resolutions), "sync configuration errors use a safe async fallback");
  resolve();
}));
await new Promise((resolve) => failing.resolveSymbol("FAIL", () => {}, (message) => {
  assert(message === "symbol failed", "sync symbol errors reach the error callback");
  resolve();
}));
await new Promise((resolve) => failing.getBars(info, "1", {
  from: 1,
  to: 2,
  countBack: 1,
  firstDataRequest: true,
}, () => {}, (message) => {
  assert(message === "history failed", "sync history errors reach the error callback");
  resolve();
}));

let rejectedSignal;
let rejectedResets = 0;
const rejectedRealtime = createDatafeed(defineDataSource({
  resolveSymbol: async () => info,
  getBars: async () => [],
  subscribeBars(request) {
    rejectedSignal = request.signal;
    throw new Error("stream unavailable");
  },
}));
rejectedRealtime.subscribeBars(info, "1", () => {}, "rejected", () => {
  rejectedResets += 1;
});
await tick();
assert(rejectedResets === 0, "realtime setup failure is not misreported as a cache reset");
assert(rejectedSignal?.aborted === true, "failed realtime setup releases its subscription record");

let unhandledCleanup = 0;
const onUnhandledCleanup = () => { unhandledCleanup += 1; };
process.on("unhandledRejection", onUnhandledCleanup);
const asyncCleanup = createDatafeed(defineDataSource({
  resolveSymbol: async () => info,
  getBars: async () => [],
  subscribeBars() {
    return async () => { throw new Error("cleanup failed"); };
  },
}));
asyncCleanup.subscribeBars(info, "1", () => {}, "async-cleanup", () => {});
await tick();
asyncCleanup.unsubscribeBars("async-cleanup");
await tick();
process.removeListener("unhandledRejection", onUnhandledCleanup);
assert(unhandledCleanup === 0, "async realtime cleanup rejections are contained");

const fallbackDefaults = createDatafeed(defineDataSource({
  configuration() { throw new Error("offline"); },
  resolveSymbol: async () => info,
  getBars: async () => [],
  getMarks: async () => [],
  getServerTime: async () => 123,
}), {
  exchanges: [{ value: "R", name: "Raze", desc: "Raze" }],
  supportedResolutions: ["5"],
  symbolTypes: [{ name: "Crypto", value: "crypto" }],
});
await new Promise((resolve) => fallbackDefaults.onReady((configuration) => {
  assert(
    configuration.exchanges?.[0]?.value === "R"
      && configuration.supported_resolutions?.[0] === "5"
      && configuration.symbols_types?.[0]?.value === "crypto"
      && configuration.supports_marks === true
      && configuration.supports_time === true,
    "configuration failure preserves native defaults and capability flags",
  );
  resolve();
}));

const emptyHistory = createDatafeed(defineDataSource({
  resolveSymbol: async () => info,
  getBars: async () => ({ bars: [] }),
}));
await new Promise((resolve, reject) => emptyHistory.getBars(info, "1", {
  from: 1,
  to: 2,
  countBack: 1,
  firstDataRequest: true,
}, (_bars, meta) => {
  assert(meta?.noData === true, "structured empty history infers noData consistently");
  resolve();
}, reject));

const explicitHistory = createDatafeed(defineDataSource({
  resolveSymbol: async () => info,
  getBars: async () => ({ bars: [], meta: { noData: false, nextTime: 123 } }),
}));
await new Promise((resolve, reject) => explicitHistory.getBars(info, "1", {
  from: 1,
  to: 2,
  countBack: 1,
  firstDataRequest: false,
}, (_bars, meta) => {
  assert(meta?.noData === false && meta.nextTime === 123, "explicit history metadata overrides inferred defaults");
  resolve();
}, reject));

console.log("DATA SOURCE: PASS");

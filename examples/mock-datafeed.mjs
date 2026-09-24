// A synthetic IBasicDataFeed for examples + smoke tests. Generates a random-walk
// OHLCV series and optionally emits a live tick every second. Shared by the
// browser example (examples/index.html), visual goldens, and the headless smoke
// test (examples/smoke.mjs).

/**
 * @param {object} [opts]
 * @param {number} [opts.bars=2000]
 * @param {number} [opts.startPrice=1000]
 * @param {number} [opts.now]  Unix ms used as the last-bar time. Defaults to Date.now().
 * @param {boolean} [opts.live=true]  When false, subscribeBars is a no-op (visual tests).
 */
export function makeMockDatafeed({
  bars = 2000,
  startPrice = 1000,
  now = Date.now(),
  live = true,
} = {}) {
  const RES_MS = { "1S": 1000, "5S": 5000, "1": 60000, "5": 300000, "15": 900000, "60": 3600000, "1D": 86400000 };
  const seriesCache = new Map();
  const frozenNow = now;

  function gen(resMs, count) {
    const end = Math.floor(frozenNow / resMs) * resMs;
    const out = [];
    let price = startPrice;
    // Deterministic walk (no Math.random).
    let seed = 1234567;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = count - 1; i >= 0; i--) {
      const t = end - i * resMs;
      const drift = (rnd() - 0.48) * price * 0.02;
      const open = price;
      const close = Math.max(0.0001, price + drift);
      const high = Math.max(open, close) * (1 + rnd() * 0.01);
      const low = Math.min(open, close) * (1 - rnd() * 0.01);
      const volume = Math.floor(rnd() * 100000);
      out.push({ time: t, open, high, low, close, volume });
      price = close;
    }
    return out;
  }

  function seriesFor(res) {
    if (!seriesCache.has(res)) {
      seriesCache.set(res, gen(RES_MS[res] ?? 60000, bars));
    }
    return seriesCache.get(res);
  }

  const subs = new Map(); // guid → timer

  return {
    onReady(cb) {
      setTimeout(() => cb({
        supported_resolutions: ["1S", "5S", "1", "5", "15", "60", "1D"],
        supports_marks: true,
      }), 0);
    },
    searchSymbols(_a, _b, _c, cb) { cb([]); },
    resolveSymbol(symbol, onResolve) {
      setTimeout(() => onResolve({
        name: symbol, ticker: symbol, description: symbol,
        type: "crypto", session: "24x7", timezone: "Etc/UTC",
        exchange: "Mock", listed_exchange: "Mock", format: "price",
        minmov: 1, pricescale: 1, has_intraday: true, has_seconds: true,
        seconds_multipliers: ["1", "5"], intraday_multipliers: ["1", "5", "15", "60"],
        has_daily: true, daily_multipliers: ["1"],
        supported_resolutions: ["1S", "5S", "1", "5", "15", "60", "1D"],
        volume_precision: 0, data_status: live ? "streaming" : "endofday",
      }), 0);
    },
    getBars(_symbolInfo, resolution, periodParams, onResult) {
      const series = seriesFor(resolution);
      const fromMs = periodParams.from * 1000;
      const toMs = periodParams.to * 1000;
      let slice = series.filter((b) => b.time >= fromMs && b.time <= toMs);
      // Visual fixtures freeze `now` in the past; the widget still requests a
      // wall-clock window around Date.now(). Serve the frozen series anyway.
      if (slice.length === 0 && series.length) {
        const n = Math.max(1, periodParams.countBack || series.length);
        slice = series.slice(-n);
      }
      setTimeout(() => onResult(slice, { noData: slice.length === 0 }), 0);
    },
    subscribeBars(_symbolInfo, resolution, onTick, guid) {
      if (!live) return;
      const resMs = RES_MS[resolution] ?? 60000;
      const series = seriesFor(resolution);
      let last = series[series.length - 1];
      const timer = setInterval(() => {
        if (!subs.has(guid)) return;
        const tickNow = Math.floor(Date.now() / resMs) * resMs;
        if (tickNow > last.time) {
          last = { time: tickNow, open: last.close, high: last.close, low: last.close, close: last.close, volume: 0 };
          series.push(last);
        }
        const delta = (Math.sin(Date.now() / 5000)) * last.close * 0.003;
        last.close = Math.max(0.0001, last.close + delta);
        last.high = Math.max(last.high, last.close);
        last.low = Math.min(last.low, last.close);
        last.volume += Math.floor(Math.abs(delta) * 1000);
        onTick({ ...last });
      }, 1000);
      if (timer.unref) timer.unref();
      subs.set(guid, timer);
    },
    unsubscribeBars(guid) {
      const timer = subs.get(guid);
      if (timer) clearInterval(timer);
      subs.delete(guid);
    },
    getMarks(_symbolInfo, from, to, onData, res) {
      const series = seriesFor(res ?? "1");
      const out = [];
      const push = (tSec, buy, label) => {
        if (tSec < from || tSec > to) return;
        out.push({
          id: `m${out.length}`, time: tSec,
          color: { border: buy ? "#26a69a" : "#ef5350", background: buy ? "#26a69a" : "#ef5350" },
          text: buy ? "Buy" : "Sell", label, labelFontColor: "#fff", minSize: 16,
        });
      };
      for (let i = 0; i < series.length; i += 120) {
        const b = series[i];
        push(Math.floor(b.time / 1000), i % 240 === 0, i % 240 === 0 ? "B" : "S");
      }
      onData(out);
    },
  };
}

/** Frozen unix-ms used by visual goldens so timestamps (and therefore axis labels) never drift. */
export const VISUAL_NOW = Date.UTC(2024, 0, 15, 12, 0, 0);

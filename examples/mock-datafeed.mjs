// A synthetic IBasicDataFeed for examples + smoke tests. Generates a random-walk
// OHLCV series and emits a live tick every second. Shared by the browser
// example (examples/index.html) and the headless smoke test (examples/smoke.mjs).

export function makeMockDatafeed({ bars = 2000, startPrice = 1000 } = {}) {
  const RES_MS = { "1S": 1000, "5S": 5000, "1": 60000, "5": 300000, "15": 900000, "60": 3600000, "1D": 86400000 };
  const seriesCache = new Map();

  function gen(resMs, count) {
    const now = Math.floor(Date.now() / resMs) * resMs;
    const out = [];
    let price = startPrice;
    // deterministic-ish walk (no Math.random dependence on time ordering)
    let seed = 1234567;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = count - 1; i >= 0; i--) {
      const t = now - i * resMs;
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
      setTimeout(() => cb({ supported_resolutions: ["1S", "5S", "1", "5", "15", "60", "1D"] }), 0);
    },
    searchSymbols(_a, _b, _c, cb) { cb([]); },
    resolveSymbol(symbol, onResolve) {
      setTimeout(() => onResolve({
        name: symbol, ticker: symbol, description: symbol,
        type: "crypto", session: "24x7", timezone: "Etc/UTC",
        exchange: "Mock", listed_exchange: "Mock", format: "price",
        minmov: 1, pricescale: 100, has_intraday: true, has_seconds: true,
        seconds_multipliers: ["1", "5"], intraday_multipliers: ["1", "5", "15", "60"],
        has_daily: true, daily_multipliers: ["1"],
        supported_resolutions: ["1S", "5S", "1", "5", "15", "60", "1D"],
        volume_precision: 0, data_status: "streaming",
      }), 0);
    },
    getBars(_symbolInfo, resolution, periodParams, onResult) {
      const series = seriesFor(resolution);
      const fromMs = periodParams.from * 1000;
      const toMs = periodParams.to * 1000;
      const slice = series.filter((b) => b.time >= fromMs && b.time <= toMs);
      setTimeout(() => onResult(slice, { noData: slice.length === 0 }), 0);
    },
    subscribeBars(_symbolInfo, resolution, onTick, guid) {
      const resMs = RES_MS[resolution] ?? 60000;
      const series = seriesFor(resolution);
      let last = series[series.length - 1];
      const timer = setInterval(() => {
        if (!subs.has(guid)) return;
        const now = Math.floor(Date.now() / resMs) * resMs;
        if (now > last.time) {
          last = { time: now, open: last.close, high: last.close, low: last.close, close: last.close, volume: 0 };
          series.push(last);
        }
        const delta = (Math.sin(Date.now() / 5000) ) * last.close * 0.003;
        last.close = Math.max(0.0001, last.close + delta);
        last.high = Math.max(last.high, last.close);
        last.low = Math.min(last.low, last.close);
        last.volume += Math.floor(Math.abs(delta) * 1000);
        onTick({ ...last });
      }, 1000);
      if (timer.unref) timer.unref(); // don't keep the Node event loop alive in tests
      subs.set(guid, timer);
    },
    unsubscribeBars(guid) {
      const timer = subs.get(guid);
      if (timer) clearInterval(timer);
      subs.delete(guid);
    },
    getMarks(_symbolInfo, from, to, onData, _res) {
      const series = seriesFor("1");
      const out = [];
      for (let i = 0; i < series.length; i += 250) {
        const b = series[i];
        const tSec = Math.floor(b.time / 1000);
        if (tSec < from || tSec > to) continue;
        const buy = i % 500 === 0;
        out.push({
          id: `m${i}`, time: tSec,
          color: { border: buy ? "#26a69a" : "#ef5350", background: buy ? "#26a69a" : "#ef5350" },
          text: buy ? "Buy" : "Sell", label: buy ? "B" : "S",
          labelFontColor: "#fff", minSize: 16,
        });
      }
      onData(out);
    },
  };
}

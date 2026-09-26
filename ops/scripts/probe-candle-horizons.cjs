// ops/scripts/probe-candle-horizons.cjs — OPS-BDIR-V3-PANEL-READINESS-W1 CH2 R0.2.
//
// The instrument behind src/lib/venue-candle-horizons.ts: how far back each venue's candle endpoint
// serves history, per timeframe, through the SHIPPED adapter (the labeler's own fetch path).
// READ-ONLY. Run it INSIDE the app container, on the prod IP, where the labeler runs:
//
//   docker cp ops/scripts/probe-candle-horizons.cjs crypto-quant-signal-mcp-mcp-server-1:/tmp/
//   docker exec crypto-quant-signal-mcp-mcp-server-1 node /tmp/probe-candle-horizons.cjs '{"GATE":["3m","5m"]}'
//
// Batch class (waits on a saturated lane, never jumps it); one coin (BTC); a handful of calls per
// pair. A typed rate-limit / budget-skip error stops that venue at once — never retried. A lane that
// is saturated (WEEX measured ~53 s per call on 2026-09-26) makes a full sweep take hours: probe only
// the pairs you need. Output: one JSON line per (venue, timeframe) — deepest_available_days is a
// lower bound at 0.25 d resolution (>= 25 means "deeper than the nightly's 21 d reach").
const { getAdapter } = require('/app/dist/lib/exchange-adapter.js');
const { runAsBatch } = require('/app/dist/lib/upstream-weight-budget.js');

const TF_MS = { '3m': 180e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': 3600e3, '2h': 7200e3, '4h': 14400e3, '8h': 28800e3, '12h': 43200e3, '1d': 86400e3 };
const DAY = 86400e3;
const BRACKETS = [25, 17, 10, 5, 2, 1, 0.5]; // days back; >= 25 d covers the nightly 21 d lookback
const plan = JSON.parse(process.argv[2]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function available(adapter, tf, daysBack) {
  const tfMs = TF_MS[tf];
  const start = Math.floor((Date.now() - daysBack * DAY) / tfMs) * tfMs;
  const end = start + 5 * tfMs;
  const candles = await adapter.getCandles('BTC', tf, start, undefined, end);
  return Array.isArray(candles) && candles.some((c) => c.time >= start && c.time <= end + tfMs);
}

async function probePair(adapter, venue, tf) {
  let calls = 0;
  let lo = null; // deepest days-back that IS available
  let hi = null; // shallowest days-back that is NOT available
  for (const d of BRACKETS) {
    calls++;
    if (await available(adapter, tf, d)) { lo = d; break; }
    hi = d;
    await sleep(300);
  }
  if (lo !== null && hi !== null) {
    // refine inside (lo, hi) to 0.25 d resolution — a count of rows past the horizon must not be an estimate
    while (hi - lo > 0.25) {
      const mid = Math.round(((lo + hi) / 2) * 4) / 4;
      if (mid <= lo || mid >= hi) break;
      calls++;
      if (await available(adapter, tf, mid)) lo = mid; else hi = mid;
      await sleep(300);
    }
  }
  return { venue, tf, deepest_available_days: lo, shallowest_missing_days: hi, calls };
}

(async () => {
  await runAsBatch(async () => {
    for (const [venue, tfs] of Object.entries(plan)) {
      const adapter = getAdapter(venue);
      for (const tf of tfs) {
        try {
          const r = await probePair(adapter, venue, tf);
          console.log(JSON.stringify({ at: new Date().toISOString(), ...r }));
        } catch (e) {
          const code = e && e.code;
          console.log(JSON.stringify({ at: new Date().toISOString(), venue, tf, error: String(code || e && e.message || e).slice(0, 120) }));
          if (code === 'UPSTREAM_RATE_LIMIT' || code === 'WEIGHT_BUDGET_SKIP') break; // stop this venue; never retry
        }
      }
    }
  }, 'horizon-probe');
  process.exit(0);
})();

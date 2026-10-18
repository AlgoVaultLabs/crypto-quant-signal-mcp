// ops/scripts/probe-candle-horizons.cjs — the instrument behind src/lib/venue-candle-reach.ts, the ONE reach
// table (OPS-CANDLE-REQUEST-OWNER-DERIVATION-W1 CH3). Born in OPS-BDIR-V3-PANEL-READINESS-W1 CH2 R0.2 as the
// instrument of a second table, venue-candle-horizons.ts, which CH3 retired; it now measures the table the
// outcome queue, the census and the nightly labeler all read, against that table's own values.
//
// READ-ONLY. Run it INSIDE the app container, on the prod IP, where the backfill and the labeler fetch:
//
//   docker cp ops/scripts/probe-candle-horizons.cjs crypto-quant-signal-mcp-mcp-server-1:/tmp/
//   docker exec crypto-quant-signal-mcp-mcp-server-1 node /tmp/probe-candle-horizons.cjs                # every finite pair
//   docker exec crypto-quant-signal-mcp-mcp-server-1 node /tmp/probe-candle-horizons.cjs '{"HTX":["2h"]}' # a narrowed plan
//
// Per pair, through the SHIPPED adapter `getCandles` for BTC (the fill path's own fetch), batch class (waits on
// a saturated lane, never jumps it):
//   1. Is the table's own depth still served? One window just inside it, less the queue's margin hour.
//   2. How deep does service really go? Bracketed between 0 and the table value (not served) or between the
//      table value and twice it (served), refined to 0.25 d. A lower bound, like the table itself.
// A typed rate-limit / budget-skip error stops that venue at once — never retried. A saturated lane (WEEX
// measured ~53 s per call on 2026-09-26) makes a full sweep take hours: narrow the plan.
//
// Output: one JSON line per pair — {venue, tf, table_days, table_depth_served, deepest_available_days,
// shallowest_missing_days, calls}. `table_depth_served: false` means the table claims history the venue no
// longer returns: re-measure and correct the table (a value change, recorded with this instrument), never pin it.
// `shallowest_missing_days: null` means service reached twice the table value — the table is conservative there.
const { getAdapter } = require('/app/dist/lib/exchange-adapter.js');
const { runAsBatch } = require('/app/dist/lib/upstream-weight-budget.js');
const { VENUE_CANDLE_REACH_DAYS, REACH_MARGIN_S } = require('/app/dist/lib/venue-candle-reach.js');

const TF_MS = { '3m': 180e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': 3600e3, '2h': 7200e3, '4h': 14400e3, '8h': 28800e3, '12h': 43200e3, '1d': 86400e3 };
const DAY = 86400e3;
const RESOLUTION_D = 0.25;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every finite (venue, timeframe) pair the deployed table lists — an absent pair is unbounded and has no depth to probe. */
function tablePlan() {
  const plan = {};
  for (const [venue, pairs] of Object.entries(VENUE_CANDLE_REACH_DAYS)) {
    const tfs = Object.keys(pairs).filter((tf) => Number.isFinite(pairs[tf]));
    if (tfs.length > 0) plan[venue] = tfs;
  }
  return plan;
}

const plan = process.argv[2] ? JSON.parse(process.argv[2]) : tablePlan();

async function available(adapter, tf, daysBack) {
  const tfMs = TF_MS[tf];
  const start = Math.floor((Date.now() - daysBack * DAY) / tfMs) * tfMs;
  const end = start + 5 * tfMs;
  const candles = await adapter.getCandles('BTC', tf, start, undefined, end);
  return Array.isArray(candles) && candles.some((c) => c.time >= start && c.time <= end + tfMs);
}

async function probePair(adapter, venue, tf) {
  const table = VENUE_CANDLE_REACH_DAYS[venue] && VENUE_CANDLE_REACH_DAYS[venue][tf];
  if (!Number.isFinite(table) || !TF_MS[tf]) return { venue, tf, table_days: table ?? null, error: 'not a finite pair of the reach table' };
  const inside = table - REACH_MARGIN_S / 86400;
  let calls = 1;
  const served = await available(adapter, tf, inside);
  let lo = served ? inside : 0; // deepest days-back known AVAILABLE
  let hi = served ? table * 2 : inside; // shallowest days-back known NOT available (a bound to test when served)
  if (served) {
    await sleep(300);
    calls++;
    if (await available(adapter, tf, hi)) {
      return { venue, tf, table_days: table, table_depth_served: true, deepest_available_days: hi, shallowest_missing_days: null, calls };
    }
  }
  while (hi - lo > RESOLUTION_D) {
    const mid = Math.round(((lo + hi) / 2) / RESOLUTION_D) * RESOLUTION_D;
    if (mid <= lo || mid >= hi) break;
    await sleep(300);
    calls++;
    if (await available(adapter, tf, mid)) lo = mid; else hi = mid;
  }
  return { venue, tf, table_days: table, table_depth_served: served, deepest_available_days: lo, shallowest_missing_days: hi, calls };
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

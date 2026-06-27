#!/usr/bin/env node
/**
 * check-rank-metrics-parity.mjs — SCAN-RANKBY-W1 CH2
 *
 * Cross-venue rank-field parity canary: every venue's getRankedUniverse returns the
 * Tier-1 metric fields for each lens, funding APR annualizes correctly (HL=1h/×8760),
 * and /capabilities advertises the rankBy lens set. Fails the build if a venue stops
 * returning a rank field (per-lens typed-field parity) or the advertised set drifts.
 *
 *   --check            (default) OFFLINE contract parity (imports compiled dist; NO network).
 *                      Injects a fixture universe via the rank-metrics test seam so the
 *                      per-lens sort + typed-field projection is deterministic. Asserts:
 *                        1. annualizeFunding unit (0.01%/8h ≈ 10.95%; HL 1h = ×8760 = 8× the 8h)
 *                        2. lens contract: RANK_BY_VALUES + every alias resolves
 *                        3. /capabilities (projectCapabilities) advertises scan_trade_calls.lenses
 *                           = {param:rankBy, values==RANK_BY_VALUES, aliases⊇{vol,gain,lose,move,pfr,nfr}, default:oi}
 *                        4. per-venue field parity: every promoted venue's getRankedUniverse
 *                           returns the typed field for each lens (funding on same-call venues
 *                           + OKX whose script-context processGate keeps the injected funding;
 *                           Binance funding joins the live premiumIndex → covered by --live + vitest)
 *   --simulate-drift   re-runs the SAME parity assertions against a field-STRIPPED fixture
 *                      (no changePct24h) → the gainers/losers/movers parity necessarily fails →
 *                      rc=1, proving the canary detects a missing rank field.
 *   --live             LIVE parity against real venue APIs (weekly). Asserts each venue's
 *                      getRankedUniverse returns the typed fields. OKX funding is verified in
 *                      the server context + vitest (the per-instId loader is processGate-skipped
 *                      in script context by design) — logged, not failed.
 *
 * Exit codes: 0 = parity OK; 1 = drift/parity failure; 2 = fatal (dist missing / bad usage).
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const args = new Set(process.argv.slice(2));
const MODE_LIVE = args.has('--live');
const MODE_DRIFT = args.has('--simulate-drift');

const FAILS = [];
const fail = (m) => FAILS.push(m);
const close = (label, got, want, tol = 1e-9) => Math.abs(got - want) <= tol || (fail(`${label}: got ${got}, want ≈${want}`), false);

let rank, constants, registry, rankAtr, oiSnap;
try {
  rank = await import(path.join(REPO_ROOT, 'dist', 'lib', 'rank-metrics.js'));
  constants = await import(path.join(REPO_ROOT, 'dist', 'lib', 'rank-constants.js'));
  registry = await import(path.join(REPO_ROOT, 'dist', 'lib', 'feature-registry.js'));
  rankAtr = await import(path.join(REPO_ROOT, 'dist', 'lib', 'rank-atr.js'));
  oiSnap = await import(path.join(REPO_ROOT, 'dist', 'lib', 'oi-snapshots.js'));
} catch (e) {
  console.error('[rank-parity] FATAL — dist not built (run `npm run build`):', e.message);
  process.exit(2);
}
const { getRankedUniverse, _setUniverseFetcherForTest, _resetRankMetricsForTest } = rank;
const { RANK_BY_VALUES, RANK_BY_ALIASES, resolveRankBy, rankByTokens, annualizeFunding } = constants;
const { projectCapabilities } = registry;
const { computeATRP } = rankAtr;
const { oiDeltaFromSnapshots, DEFAULT_OI_WINDOW_MS } = oiSnap;

const NON_FUNDING = ['oi', 'volume', 'gainers', 'losers', 'movers'];
const TYPED_FIELD = {
  volume: 'volume_24h',
  gainers: 'change_24h_pct',
  losers: 'change_24h_pct',
  movers: 'change_24h_pct',
  funding_positive: 'funding_rate',
  funding_negative: 'funding_rate',
};
// Same-call funding venues + OKX (script-context processGate keeps the injected funding).
const FUNDING_OFFLINE_VENUES = ['BYBIT', 'BITGET', 'HL', 'OKX'];
const ALL_VENUES = ['BINANCE', 'BYBIT', 'OKX', 'BITGET', 'HL'];

function fixture(withChange = true) {
  return [
    { coin: 'AAA', notionalOI_usd: 1000, volume24h_usd: 50, changePct24h: withChange ? 5 : undefined, fundingRate: -0.0009, fundingIntervalHours: 8 },
    { coin: 'BBB', notionalOI_usd: 900, volume24h_usd: 95, changePct24h: withChange ? -8 : undefined, fundingRate: 0.0005, fundingIntervalHours: 8 },
    { coin: 'CCC', notionalOI_usd: 800, volume24h_usd: 70, changePct24h: withChange ? 12 : undefined, fundingRate: -0.0003, fundingIntervalHours: 1 },
  ];
}

async function lensRows(venue, lens, n = 5) {
  return getRankedUniverse(venue, lens, n);
}

// ── (1) annualizeFunding unit ──
function checkApr() {
  close('annualizeFunding(0.0001,8)', annualizeFunding(0.0001, 8), 0.1095, 1e-6);
  close('annualizeFunding(0.0001,1) HL', annualizeFunding(0.0001, 1), 0.876, 1e-6);
  if (Math.abs(annualizeFunding(0.0001, 1) - annualizeFunding(0.0001, 8) * 8) > 1e-9) fail('HL APR must be 8× the 8h APR (×8760 not ×1095)');
  if (annualizeFunding(0.0001, null) !== null) fail('unknown interval must annualize to null');
}

// ── (2) lens contract ──
function checkContract() {
  const want = ['oi', 'volume', 'gainers', 'losers', 'movers', 'funding_positive', 'funding_negative', 'volatility', 'oi_change'];
  if (JSON.stringify([...RANK_BY_VALUES]) !== JSON.stringify(want)) fail(`RANK_BY_VALUES drift: ${RANK_BY_VALUES}`);
  for (const t of rankByTokens()) if (resolveRankBy(t) == null) fail(`token '${t}' does not resolve`);
  if (resolveRankBy('nfr') !== 'funding_negative') fail("alias nfr must resolve to funding_negative");
  if (resolveRankBy('atr') !== 'volatility') fail("alias atr must resolve to volatility"); // SCAN-RANKBY-W2
  if (resolveRankBy('oid') !== 'oi_change') fail("alias oid must resolve to oi_change"); // SCAN-RANKBY-W3
}

// ── (3) /capabilities advertises the lens set ──
function checkCapabilities() {
  const scan = projectCapabilities().tools.find((t) => t.name === 'scan_trade_calls');
  if (!scan || !scan.lenses) return fail('/capabilities: scan_trade_calls has no lenses');
  const L = scan.lenses;
  if (L.param !== 'rankBy') fail(`lenses.param != rankBy (${L.param})`);
  if (JSON.stringify(L.values) !== JSON.stringify([...RANK_BY_VALUES])) fail('lenses.values != RANK_BY_VALUES');
  if (L.default !== 'oi') fail(`lenses.default != oi (${L.default})`);
  for (const a of ['vol', 'gain', 'lose', 'move', 'pfr', 'nfr', 'atr', 'oid']) {
    if (!(a in L.aliases)) fail(`lenses.aliases missing '${a}'`);
  }
}

// ── (5) SCAN-RANKBY-W2: ATRP pure-compute unit (offline) ──
function checkAtrp() {
  // Flat constant-range candles (high=price+d, low=price−d, close=price) → ATRP = 2d/price×100.
  const flat = (atrpTarget, price = 100, n = 20) => {
    const d = (atrpTarget * price) / 200;
    return Array.from({ length: n }, (_, i) => ({ open: price, high: price + d, low: price - d, close: price, volume: 1, time: i }));
  };
  close('computeATRP(flat 2%)', computeATRP(flat(2)), 2, 1e-6);
  // ATRP not raw ATR: same relative range at 60000× price → identical ATRP.
  if (Math.abs(computeATRP(flat(3, 1)) - computeATRP(flat(3, 60000))) > 1e-6) fail('ATRP must be price-normalized (raw ATR would differ)');
  if (computeATRP(flat(2, 100, 14)) !== null) fail('computeATRP must return null for <15 candles');
  if (!RANK_BY_VALUES.includes('volatility')) fail('volatility missing from RANK_BY_VALUES');
}

// ── (5b) SCAN-RANKBY-W3: oi_change pure OI-delta unit (offline) ──
function checkOiChange() {
  const now = 1_800_000_000_000;
  const H = 60 * 60 * 1000;
  const d = oiDeltaFromSnapshots([{ ts: now - 24 * H, oi: 100 }, { ts: now, oi: 120 }], DEFAULT_OI_WINDOW_MS, now);
  if (!d || d.oi_change_pct !== 20) fail(`oiDeltaFromSnapshots(+20%) drift: ${JSON.stringify(d)}`);
  if (oiDeltaFromSnapshots([{ ts: now, oi: 100 }], DEFAULT_OI_WINDOW_MS, now) !== null) {
    fail('oiDeltaFromSnapshots must return null (warming) with < 2 spanning points');
  }
  if (!RANK_BY_VALUES.includes('oi_change')) fail('oi_change missing from RANK_BY_VALUES');
}

// ── (4) per-venue field parity (offline, fixture-injected) ──
async function checkOfflineParity(withChange) {
  for (const venue of ALL_VENUES) {
    _setUniverseFetcherForTest(async () => fixture(withChange));
    for (const lens of NON_FUNDING) {
      const rows = await lensRows(venue, lens);
      if (rows.length === 0) { fail(`${venue}/${lens}: 0 rows`); continue; }
      if (lens !== 'oi') for (const r of rows) if (r[TYPED_FIELD[lens]] === undefined) fail(`${venue}/${lens}: row ${r.coin} missing ${TYPED_FIELD[lens]}`);
      if (lens !== 'oi') for (const r of rows) if (typeof r.rank_value !== 'number') fail(`${venue}/${lens}: missing rank_value`);
    }
    if (FUNDING_OFFLINE_VENUES.includes(venue)) {
      for (const lens of ['funding_negative', 'funding_positive']) {
        const rows = await lensRows(venue, lens);
        if (rows.length === 0) { fail(`${venue}/${lens}: 0 rows`); continue; }
        for (const r of rows) {
          if (typeof r.funding_rate !== 'number') fail(`${venue}/${lens}: ${r.coin} missing funding_rate`);
          if (!('funding_apr' in r)) fail(`${venue}/${lens}: ${r.coin} missing funding_apr`);
        }
      }
    }
    _resetRankMetricsForTest();
  }
}

async function checkLiveParity() {
  for (const venue of ALL_VENUES) {
    for (const lens of NON_FUNDING) {
      try {
        const rows = await lensRows(venue, lens);
        if (rows.length === 0) fail(`LIVE ${venue}/${lens}: 0 rows`);
        else if (lens !== 'oi' && rows.some((r) => r[TYPED_FIELD[lens]] === undefined)) fail(`LIVE ${venue}/${lens}: missing ${TYPED_FIELD[lens]}`);
        else console.log(`  ✓ LIVE ${venue}/${lens} (${rows.length})`);
      } catch (e) { console.log(`  ~ LIVE ${venue}/${lens} unreachable (fail-open): ${e.message}`); }
    }
    if (venue !== 'OKX' && venue !== 'BINANCE') {
      try {
        const rows = await lensRows(venue, 'funding_negative');
        if (rows.length && rows.every((r) => typeof r.funding_rate === 'number')) console.log(`  ✓ LIVE ${venue}/funding_negative (${rows.length})`);
        else fail(`LIVE ${venue}/funding_negative: no funding rows`);
      } catch (e) { console.log(`  ~ LIVE ${venue}/funding unreachable: ${e.message}`); }
    }
    // SCAN-RANKBY-W2: volatility (ATRP) — like OKX/BINANCE funding, the ATRP cache's
    // processGate SKIPS the loader in script context (a short-lived script must not
    // cold-fan-out klines), so it serves the empty fallback here. ATRP live-parity is
    // covered in the SERVER context (post-deploy live `scan_trade_calls({rankBy:'volatility'})`)
    // + vitest + the standalone non-script probe — not failable from this script.
    try {
      const rows = await getRankedUniverse(venue, 'volatility', 5, '15m');
      if (rows.length && rows.every((r) => typeof r.atrp === 'number')) console.log(`  ✓ LIVE ${venue}/volatility (${rows.length})`);
      else console.log(`  · ${venue}/volatility: processGate-skipped in script context (verified server-side + vitest + probe)`);
    } catch (e) { console.log(`  ~ LIVE ${venue}/volatility unreachable: ${e.message}`); }
    // SCAN-RANKBY-W3: oi_change reads the oi_snapshots store; the oiChangeCache processGate
    // SKIPS the loader in script context (serves the empty fallback), and the store is populated
    // only on the SERVER by the hourly sampler. Live oi_change-parity is covered post-deploy
    // (`scan_trade_calls({rankBy:'oi_change'})` once warm) + vitest — not failable from this script.
    try {
      const rows = await getRankedUniverse(venue, 'oi_change', 5, '15m');
      if (rows.length && rows.every((r) => typeof r.oi_change_pct === 'number')) console.log(`  ✓ LIVE ${venue}/oi_change (${rows.length})`);
      else console.log(`  · ${venue}/oi_change: processGate-skipped / store warming in script context (verified server-side + vitest)`);
    } catch (e) { console.log(`  ~ LIVE ${venue}/oi_change unreachable: ${e.message}`); }
  }
  console.log('  · OKX/BINANCE funding parity verified in server context + vitest (script processGate / live premiumIndex)');
}

// ── run ──
try {
  checkApr();
  checkContract();
  checkCapabilities();
  checkAtrp();
  checkOiChange();
  if (MODE_LIVE) await checkLiveParity();
  else await checkOfflineParity(/* withChange */ !MODE_DRIFT);
} catch (e) {
  console.error('[rank-parity] FATAL:', e);
  process.exit(2);
} finally {
  _resetRankMetricsForTest();
}

if (MODE_DRIFT) {
  // The stripped fixture MUST have produced parity failures (proves detection).
  if (FAILS.length > 0) { console.log(`[rank-parity] --simulate-drift: detected ${FAILS.length} parity failure(s) as expected → rc=1`); process.exit(1); }
  console.error('[rank-parity] --simulate-drift: expected parity FAILURES but found none — canary has no teeth!');
  process.exit(2);
}

if (FAILS.length) {
  console.error(`[rank-parity] ❌ ${FAILS.length} failure(s):`);
  for (const f of FAILS) console.error('  - ' + f);
  process.exit(1);
}
console.log(`[rank-parity] ✅ ${MODE_LIVE ? 'LIVE' : 'offline'} parity OK — APR unit + lens contract + /capabilities + per-venue typed fields.`);
process.exit(0);

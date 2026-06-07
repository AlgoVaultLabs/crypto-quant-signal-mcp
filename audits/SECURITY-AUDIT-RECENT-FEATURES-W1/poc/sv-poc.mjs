#!/usr/bin/env node
/**
 * sv-poc.mjs — SHADOW-VENUE-AUDITOR (R4) self-contained PoCs.
 *
 * READ-ONLY. Does NOT import or mutate src/. Each PoC reproduces a finding's
 * mechanism in isolation (re-implementing the minimal code shape from the
 * audited file) OR curls a LIVE READ endpoint. No funds, no DB, no prod writes.
 *
 * Run:  node audits/SECURITY-AUDIT-RECENT-FEATURES-W1/poc/sv-poc.mjs
 *
 * Findings demonstrated:
 *   SV-02  /api/performance-public fail-OPEN shadow leak (empty/erroring venues table)
 *   SV-04  _upstream-fetch + adapter parseFloat: NaN flows into Candle/AssetContext (no default-deny)
 *   SV-05  unbounded allocation from attacker-sized upstream array (no .slice cap)
 *   SV-01  LIVE: /api/performance-shadow is open + exposes min_buy_sell_sample + per-venue PFE
 */

const line = (s = '') => process.stdout.write(s + '\n');
const hr = () => line('─'.repeat(72));

// ── SV-02: /api/performance-public fail-OPEN filter ────────────────────────
// Mirrors src/index.ts:1512-1527 exactly. The filter only applies when
// promotedIds.size > 0; on an empty/erroring venues table it falls through to
// the UNFILTERED byExchange — leaking shadow venues onto the PUBLIC endpoint.
function performancePublicFilter(byExchange, promotedVenuesFromDb) {
  let filteredByExchange = byExchange;
  try {
    const promotedIds = new Set(promotedVenuesFromDb.map((v) => v.exchange_id));
    if (promotedIds.size > 0) {
      filteredByExchange = Object.fromEntries(
        Object.entries(byExchange).filter(([ex]) => promotedIds.has(ex)),
      );
    }
    // else: promotedIds empty → filteredByExchange stays = byExchange (UNFILTERED)
  } catch {
    // listVenues threw → filteredByExchange stays = byExchange (UNFILTERED)
  }
  return filteredByExchange;
}

function sv02() {
  hr();
  line('SV-02 — /api/performance-public fail-OPEN shadow leak');
  hr();
  const byExchange = {
    HL: { pfeWinRate: 0.7 }, BINANCE: { pfeWinRate: 0.7 },
    ASTER: { pfeWinRate: 0.87 }, EDGEX: { pfeWinRate: 0.91 }, // shadow
  };
  const happy = performancePublicFilter(byExchange, [{ exchange_id: 'HL' }, { exchange_id: 'BINANCE' }]);
  line('  Normal path (promoted rows present): ' + JSON.stringify(Object.keys(happy)));
  line('    → shadow ASTER/EDGEX correctly EXCLUDED ✅');
  const emptyTable = performancePublicFilter(byExchange, []); // venues table empty
  line('  Fail-open path (venues table EMPTY):  ' + JSON.stringify(Object.keys(emptyTable)));
  const leaked = ['ASTER', 'EDGEX'].filter((x) => x in emptyTable);
  line('    → SHADOW LEAKED onto PUBLIC endpoint: ' + JSON.stringify(leaked) +
    (leaked.length ? '  ❌ Data-Integrity violation' : '  ✅'));
  line('  Same fall-through occurs if listVenues() THROWS (DB outage) — see the catch block.');
}

// ── SV-04: parseFloat NaN flows into Candle / AssetContext ─────────────────
// Mirrors aster.ts getCandles (l.94-101) + getAssetContext (l.114-124) and
// edgex.ts getCandles (l.185-192). parseFloat of a non-numeric upstream string
// yields NaN with NO isFinite/default-deny guard (CLAUDE.md "default-deny on NaN").
function sv04() {
  hr();
  line('SV-04 — untrusted-response parse: NaN flows into Candle/AssetContext (no default-deny)');
  hr();
  // A malformed/hostile upstream kline row (Binance-clone shape: [openTime, o,h,l,c,v,...])
  const hostileKline = [1700000000000, 'NaN', '0x1', 'null', '', 'Infinity'];
  const candle = {
    open: parseFloat(String(hostileKline[1])),
    high: parseFloat(String(hostileKline[2])),
    low: parseFloat(String(hostileKline[3])),
    close: parseFloat(String(hostileKline[4])),
    volume: parseFloat(String(hostileKline[5])),
    time: hostileKline[0],
  };
  line('  Hostile kline row → parsed Candle: ' + JSON.stringify(candle));
  const bad = Object.entries(candle).filter(([, v]) => typeof v === 'number' && !Number.isFinite(v));
  line('    → non-finite fields: ' + JSON.stringify(bad.map(([k]) => k)) +
    '  ❌ no default-deny at the generator');
  // getFundingHistory DOES guard (aster l.150 / edgex l.259) — shown for contrast.
  const histRows = [{ fundingTime: 1, fundingRate: 'NaN' }, { fundingTime: 2, fundingRate: '0.01' }];
  const kept = histRows.filter((r) => r.fundingRate != null && !isNaN(parseFloat(r.fundingRate)));
  line('  Contrast: getFundingHistory filters NaN → kept ' + kept.length + '/2 rows ✅ (guard exists HERE only)');
}

// ── SV-05: unbounded allocation from attacker-sized upstream array ─────────
// Mirrors aster.getPredictedFundings (l.128-139) + edgex.ensureContractMap
// (l.81-86): .map / for-of over the FULL upstream array with no .slice cap and
// _upstream-fetch.upstreamFetch reads res.json() with no Content-Length/byte cap.
function sv05() {
  hr();
  line('SV-05 — unbounded allocation: no size cap on upstream array (DoS)');
  hr();
  const HOSTILE_N = 5_000_000; // a compromised/spoofed upstream advertises this many "perps"
  line('  Simulating upstream premiumIndex array of length ' + HOSTILE_N.toLocaleString());
  const before = process.memoryUsage().heapUsed;
  // This is exactly what aster.getPredictedFundings does: build one object per entry.
  const built = [];
  for (let i = 0; i < HOSTILE_N; i++) built.push({ coin: 'X' + i, venues: [{ venue: 'AsterPerp', fundingRate: 0 }] });
  const mb = ((process.memoryUsage().heapUsed - before) / 1024 / 1024).toFixed(0);
  line('  Allocated ' + built.length.toLocaleString() + ' objects → ~' + mb + ' MB heap from ONE response.');
  line('    → no .slice(limit) cap in the adapter, no byte cap in _upstream-fetch.res.json() ❌ MEDIUM DoS');
}

// ── SV-01: LIVE — /api/performance-shadow is open + leaks internal threshold ─
async function sv01Live() {
  hr();
  line('SV-01 — LIVE probe: /api/performance-shadow (open? PFE-only? threshold leak?)');
  hr();
  try {
    const res = await fetch('https://api.algovault.com/api/performance-shadow', { method: 'GET' });
    line('  HTTP ' + res.status + ' (UNAUTHENTICATED request, no API key sent)');
    const body = await res.json();
    const text = JSON.stringify(body);
    const n = (body.venues || []).length;
    line('  shadow venues returned: ' + n);
    const hasOutcome = /outcome_return_pct|outcome_price|return_1candle/.test(text);
    const hasThreshold = /min_buy_sell_sample/.test(text);
    const hasPfe = /pfeWinRate|current_pfe_wr|last_eval_pfe_wr/.test(text);
    line('    outcome_return_pct / Phase-E leaked: ' + (hasOutcome ? 'YES ❌ CRITICAL' : 'NO ✅ (PFE-only)'));
    line('    min_buy_sell_sample (INTERNAL threshold) exposed: ' + (hasThreshold ? 'YES ❌ (R4.5)' : 'no'));
    line('    per-venue PFE win rate exposed: ' + (hasPfe ? 'YES — premature shadow disclosure (Mr.1 decision)' : 'no'));
    const sample = (body.venues || [])[0];
    if (sample) line('    sample venue keys: ' + JSON.stringify(Object.keys(sample)));
  } catch (e) {
    line('  (live probe skipped — no network: ' + (e?.message || e) + ')');
  }
}

(async () => {
  line('SHADOW-VENUE-AUDITOR (R4) — PoC bundle  ·  READ-ONLY  ·  no src/ import');
  sv02();
  sv04();
  sv05();
  await sv01Live();
  hr();
  line('Done. See area4-shadow-venue.md for severity + generator-level fixes.');
})();

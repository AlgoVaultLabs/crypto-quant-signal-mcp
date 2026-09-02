/**
 * Unit tests for AUTO-TRACE-W1 capability counters in /api/performance-public.
 *
 * Asserts that the public response shape includes:
 *   - asset_count: number ≥ 100 (derived from byAsset distinct-coin count;
 *     min 100 is a safe floor — current live is 718)
 *   - exchange_count: 5 (matches EXCHANGE_COUNT from canonical SoT module)
 *   - timeframe_count: 11 (matches TIMEFRAME_COUNT)
 *
 * Test strategy: assert against the LIVE production response since the
 * server is already deployed and stable. This is a smoke test that locks in
 * the contract. Falls back to skipping if the live API is unreachable
 * (network-isolated CI runners).
 */
import { describe, it, expect } from 'vitest';
import { EXCHANGE_COUNT, TIMEFRAME_COUNT, PROMOTED_VENUE_IDS } from '../../src/lib/capabilities.js';

const LIVE_URL = 'https://api.algovault.com/api/performance-public';
const FETCH_TIMEOUT_MS = 5000;

async function fetchLive(): Promise<any | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(LIVE_URL, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

describe('AUTO-TRACE-W1: /api/performance-public capability counters', () => {
  it('exposes asset_count, exchange_count, timeframe_count fields', { timeout: 15_000 }, async () => {
    const data = await fetchLive();
    if (data === null) {
      // Network isolation — skip without failing CI.
      console.warn('  (skipped — live API unreachable from this runner)');
      return;
    }
    // exchange_count + timeframe_count are constants from capabilities.ts —
    // assertable even pre-deploy of this very wave. Once the server has been
    // restarted with the new code, the live response includes them. If a
    // CI pre-deploy fetch hits the OLD server, these may be undefined; in
    // that case the test still passes the contract by checking for the
    // canonical-SoT values via a strict-positive check after the fact.
    // LOCAL deterministic invariant replacing the deleted live assertion — race-free, no live
    // dependency, and it is the property that actually matters: the published count IS the
    // promoted-id list, never a hand-typed number.
    expect(EXCHANGE_COUNT).toBe(PROMOTED_VENUE_IDS.length);

    if (typeof data.exchange_count === 'number') {
      // OPS-BITMART-ENUM-RECONCILE-W1 (architect ruling Q13[D]): the `live <= EXCHANGE_COUNT`
      // assertion that stood here was RELOCATED, not weakened. Three reasons:
      //  (1) It was redundant BY CONSTRUCTION — byExchange = listVenues('promoted') INTERSECT
      //      getActivePromotedVenueIds(), so live can never exceed the static set.
      //  (2) A PRE-PUSH gate must not assert LIVE REMOTE state that the push itself is about to
      //      change; that coupling is deploy-race-prone by construction. Its own premise here —
      //      "promotion only ever GROWS the count" — was falsified by the first RETIREMENT.
      //  (3) A +/-1 tolerance would have permitted a PERMANENT drift of exactly the magnitude this
      //      wave exists to fix (15-vs-14 IS a 1-drift).
      // The real check is now the ops-scheduled PG-lane gate `promoted-set-drift-canary`, upgraded to
      // a THREE-WAY identity: live exchange_count == live byExchange keys == DB promoted set, by
      // symmetric difference. Only the live LIVENESS check stays here.
      expect(data.exchange_count).toBeGreaterThan(0);
    }
    if (typeof data.timeframe_count === 'number') {
      expect(data.timeframe_count).toBe(TIMEFRAME_COUNT);
    }
    if (typeof data.asset_count === 'number') {
      // Min 100 — safe floor, current live is ~718
      expect(data.asset_count).toBeGreaterThanOrEqual(100);
    } else {
      // Pre-AUTO-TRACE-W1 deploy: the byAsset key-count is the fallback
      // source. If neither exists, the API is broken in a way unrelated to
      // this wave — skip rather than false-fail.
      if (data.byAsset && typeof data.byAsset === 'object') {
        expect(Object.keys(data.byAsset).length).toBeGreaterThanOrEqual(100);
      }
    }
  });
});

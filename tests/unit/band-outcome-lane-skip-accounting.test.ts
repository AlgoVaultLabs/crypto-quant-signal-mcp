/**
 * tests/unit/band-outcome-lane-skip-accounting.test.ts — OPS-BAND-OUTCOME-WIRE-W1 R1.
 *
 * `runBandOutcomeSweep()` shipped with a bare `catch { }` and a single `evaluated` counter, so a
 * sweep that evaluated 0 of 50 rows was indistinguishable from an empty queue. This suite pins
 * the two behaviours that fixes:
 *
 *   1. **Budget pre-check.** A venue with no batch headroom yields a fast COUNTED skip instead of
 *      letting `acquire()` block for up to its 300 s batch wait.
 *   2. **Poison guard.** An `<exchange>:<coin>` that keeps throwing is blocked after
 *      `MAX_FAIL_PER_SYMBOL`, so one dead symbol cannot consume a whole batch — and every blocked
 *      row is counted rather than vanishing.
 *
 * Plus the invariant that makes the counters trustworthy: **every considered row lands in exactly
 * one bucket.** A counter set that does not add up is worse than no counters, because it reads as
 * evidence.
 *
 * ── WHAT THIS SUITE DELIBERATELY DOES NOT TEST ──────────────────────────────────────────────
 *
 * There is NO test here that the lane yields to the tracked backfill, because there is no such
 * behaviour to test. `isTrackedBackfillInflight()` is process-local and inert from any scheduled
 * sweep; the cross-process mechanism is a weight class below `batch`, deferred with the caller to
 * the capacity wave (`OPS-HL-INTERACTIVE-STARVATION-W1`). Writing a hermetic test that injects
 * the seam and passes would certify a mechanism that cannot work in production — which is exactly
 * how the phantom `tests/unit/band-outcome-lane.test.ts` came to be cited by two source comments
 * for a wave without ever existing. The one direction that IS real — that
 * `signal-performance.ts` holds no reference back to this lane — stays asserted in
 * `tests/unit/band-population-invariance.test.ts`.
 *
 * ── ON `BAND_OUTCOME_ENABLED` ───────────────────────────────────────────────────────────────
 *
 * The suite sets it in-process so the sweep body is reachable at all, and restores it in
 * `afterEach`. That is not a flag flip: the production flag stays OFF and this lane still has
 * zero callers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  /** Per-`<exchange>:<coin>` behaviour for the fake adapter: 'ok' | 'throw'. */
  behaviour: new Map<string, 'ok' | 'throw'>(),
  /** Per-exchange batch headroom the fake registry reports. */
  headroom: new Map<string, number>(),
  /** Every getCandles call, so we can prove a skipped row never reached the venue. */
  fetches: [] as string[],
  writes: 0,
}));

vi.mock('../../src/lib/performance-db.js', () => ({
  getBandSignalsNeedingOutcome: async () => h.rows,
  updateBandSignalOutcomes: async () => {
    h.writes += 1;
  },
}));

vi.mock('../../src/lib/exchange-adapter.js', () => ({
  getAdapter: (exchangeId: string) => ({
    getCandles: async (coin: string, _tf: string, startTime: number) => {
      const key = `${exchangeId}:${coin}`;
      h.fetches.push(key);
      if (h.behaviour.get(key) === 'throw') throw new Error(`venue 4xx for ${key}`);
      // 12 rising candles from the signal time — enough for every EVAL_CANDLES window.
      return Array.from({ length: 12 }, (_, i) => ({
        time: startTime + i * 60_000,
        open: 100 + i,
        high: 101 + i,
        low: 99 + i,
        close: 100 + i,
        volume: 1,
      }));
    },
  }),
}));

// The registry is mocked so headroom is a test input rather than a real on-disk ledger. The
// roll-aware arithmetic behind `batchHeadroom()` is pinned separately, against a REAL
// `WeightBudget`, in tests/unit/upstream-weight-budget.test.ts.
vi.mock('../../src/lib/venue-budget-registry.js', () => ({
  getVenueBudget: (exchangeId: string) => {
    if (!h.headroom.has(exchangeId)) return null; // shadow venue — no shared budget
    return {
      budget: { batchHeadroom: () => h.headroom.get(exchangeId)! },
      weightFor: () => 1,
    };
  },
}));

vi.mock('../../src/resources/signal-performance.js', () => ({
  isTrackedBackfillInflight: () => false,
}));

import { runBandOutcomeSweep, venueHasBatchHeadroom } from '../../src/lib/band-outcome-lane.js';

/** A band row old enough that its evaluation window has closed. */
function row(id: number, exchange: string, coin: string, timeframe = '5m') {
  return {
    id,
    coin,
    signal: 'BUY',
    confidence: 47,
    timeframe,
    exchange,
    price_at_signal: 100,
    // 30 days back — past every EVAL_CANDLES window, so nothing is skipped as "not ready".
    created_at: Math.floor((Date.now() - 30 * 24 * 3600 * 1000) / 1000),
    outcome_price: null,
    pfe_return_pct: null,
    mae_return_pct: null,
  };
}

const prevFlag = process.env.BAND_OUTCOME_ENABLED;

beforeEach(() => {
  process.env.BAND_OUTCOME_ENABLED = '1';
  h.rows = [];
  h.behaviour.clear();
  h.headroom.clear();
  h.fetches.length = 0;
  h.writes = 0;
});

afterEach(() => {
  if (prevFlag === undefined) delete process.env.BAND_OUTCOME_ENABLED;
  else process.env.BAND_OUTCOME_ENABLED = prevFlag;
});

/** evaluated + every skip bucket + errors === considered. */
function bucketsAddUp(r: Awaited<ReturnType<typeof runBandOutcomeSweep>>) {
  return (
    r.evaluated +
    r.skipped_not_ready +
    r.skipped_budget +
    r.skipped_poison +
    r.skipped_unevaluable +
    r.errors
  );
}

describe('band outcome sweep — budget pre-check (Q3)', () => {
  it('skips a venue with no batch headroom, counts it, and never reaches the venue', async () => {
    h.headroom.set('MEXC', 0); // measured live at 100% of its 100-request cap
    h.rows = [row(1, 'MEXC', 'BTC'), row(2, 'MEXC', 'ETH')];

    const r = await runBandOutcomeSweep();

    expect(r.skipped_budget).toBe(2);
    expect(r.evaluated).toBe(0);
    // The whole point: no upstream call was made, so no `acquire()` could stall on it.
    expect(h.fetches).toEqual([]);
    expect(bucketsAddUp(r)).toBe(r.considered);
  });

  it('proceeds on a venue that has headroom, in the same batch as one that does not', async () => {
    h.headroom.set('MEXC', 0);
    h.headroom.set('BYBIT', 2400);
    h.rows = [row(1, 'MEXC', 'BTC'), row(2, 'BYBIT', 'ETH')];

    const r = await runBandOutcomeSweep();

    expect(r.skipped_budget).toBe(1);
    expect(r.evaluated).toBe(1);
    expect(h.fetches).toEqual(['BYBIT:ETH']); // saturated venue never touched
    expect(h.writes).toBe(1);
    expect(bucketsAddUp(r)).toBe(r.considered);
  });

  it('fails OPEN on an unbudgeted venue — an unknown venue is not a reason to stop working', async () => {
    // No headroom entry ⇒ the mocked registry returns null, as it does for a shadow venue.
    h.rows = [row(1, 'WEEX', 'BTC')];

    const r = await runBandOutcomeSweep();

    expect(r.skipped_budget).toBe(0);
    expect(r.evaluated).toBe(1);
    expect(venueHasBatchHeadroom('WEEX')).toBe(true);
  });
});

describe('band outcome sweep — poison-row guard (Q4)', () => {
  it('stops retrying an <exchange>:<coin> after MAX_FAIL_PER_SYMBOL and counts the blocked rows', async () => {
    h.headroom.set('GATE', 6000);
    h.behaviour.set('GATE:DEADCOIN', 'throw');
    // 6 rows for the same dead pair — the shape that holds the created_at ASC head forever.
    h.rows = Array.from({ length: 6 }, (_, i) => row(i + 1, 'GATE', 'DEADCOIN'));

    const r = await runBandOutcomeSweep();

    expect(r.errors).toBe(3); // MAX_FAIL_PER_SYMBOL attempts…
    expect(r.skipped_poison).toBe(3); // …then the rest are blocked, not retried
    expect(h.fetches).toHaveLength(3); // and the venue is spared the other 3 calls
    expect(r.evaluated).toBe(0);
    expect(bucketsAddUp(r)).toBe(r.considered);
  });

  it('blocks only the failing pair — a healthy coin on the SAME venue still evaluates', async () => {
    h.headroom.set('GATE', 6000);
    h.behaviour.set('GATE:DEADCOIN', 'throw');
    h.rows = [
      ...Array.from({ length: 4 }, (_, i) => row(i + 1, 'GATE', 'DEADCOIN')),
      row(5, 'GATE', 'BTC'),
    ];

    const r = await runBandOutcomeSweep();

    expect(r.errors).toBe(3);
    expect(r.skipped_poison).toBe(1);
    expect(r.evaluated).toBe(1); // GATE:BTC unaffected — the key is the PAIR, not the venue
    expect(h.writes).toBe(1);
    expect(bucketsAddUp(r)).toBe(r.considered);
  });
});

describe('band outcome sweep — the counters are trustworthy', () => {
  it('counts a not-yet-due row separately from every other reason', async () => {
    h.headroom.set('BYBIT', 2400);
    const fresh = row(1, 'BYBIT', 'BTC');
    fresh.created_at = Math.floor(Date.now() / 1000); // 5m row created now → window still open
    h.rows = [fresh];

    const r = await runBandOutcomeSweep();

    expect(r.skipped_not_ready).toBe(1);
    expect(r.skipped_budget).toBe(0);
    expect(h.fetches).toEqual([]);
    expect(bucketsAddUp(r)).toBe(r.considered);
  });

  it('counts an unknown timeframe as unevaluable, not as an error', async () => {
    h.headroom.set('BYBIT', 2400);
    h.rows = [row(1, 'BYBIT', 'BTC', '7m')]; // not in EVAL_CANDLES / TF_MS

    const r = await runBandOutcomeSweep();

    expect(r.skipped_unevaluable).toBe(1);
    expect(r.errors).toBe(0);
    expect(bucketsAddUp(r)).toBe(r.considered);
  });

  it('reports every bucket as zero when the flag is off, and does not read the queue', async () => {
    delete process.env.BAND_OUTCOME_ENABLED;
    h.rows = [row(1, 'BYBIT', 'BTC')];

    const r = await runBandOutcomeSweep();

    expect(r.skipped).toBe('disabled');
    expect(r.considered).toBe(0);
    expect(bucketsAddUp(r)).toBe(0);
    expect(h.fetches).toEqual([]);
  });
});

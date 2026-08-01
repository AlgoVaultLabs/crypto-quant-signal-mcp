/**
 * candle-basis-regime-wiring.test.ts — SIGNAL-CLOSEDBAR-SHADOW-W1 CH3 AC3/AC4/AC5
 *
 * `candle-basis-regime-golden.test.ts` pins the DEFAULT path (AC2) and the pure
 * `detectPriceStructure` divergence. This file exercises the paths the golden fixture
 * structurally cannot reach — everything behind `CANDLE_BASIS=closed` and the shadow
 * write — because a byte-identity oracle only ever runs the basis it was recorded on.
 *
 * The AC4 assertion in the golden file is the LIVE-basis half (atr_live / live close).
 * The half that actually catches the regression is here: under the CLOSED basis, ATR
 * moves to the closed bars while `currentPrice` must NOT — a mixed-basis ratio is the
 * exact defect CH2 §7's level-vs-integral rule exists to prevent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/lib/exchange-adapter.js', () => ({ getAdapter: vi.fn() }));
vi.mock('../../src/lib/performance-db.js', () => ({
  recordSignal: vi.fn(),
  recordFunding: vi.fn(),
  recordHoldCount: vi.fn(),
  getFundingZScore: vi.fn().mockReturnValue(null),
  isShortLivedScript: () => false,
  dbQuery: vi.fn().mockResolvedValue([]),
  dbExec: vi.fn().mockResolvedValue(undefined),
}));

import { getMarketRegime } from '../../src/tools/get-market-regime.js';
import { getAdapter } from '../../src/lib/exchange-adapter.js';
import { dbQuery } from '../../src/lib/performance-db.js';
import { _resetCandleBasisShadowEnsure } from '../../src/lib/candle-basis-shadow.js';
import { resetLicenseCache } from '../../src/lib/license.js';
import { atr } from '../../src/lib/indicators.js';
import type { ExchangeAdapter, MarketRegimeResult, Candle } from '../../src/types.js';
import {
  GOLDEN_NOW_MS,
  REGIME_COIN,
  REGIME_TIMEFRAME,
  REGIME_EXCHANGE,
  REGIME_PIVOT_CLOSE,
  REGIME_SHOULDER_CLOSE,
  REGIME_PARTIAL_INDEX,
  regimeCandles,
} from '../fixtures/candle-basis-regime-inputs.js';

const adapterOver = (candles: Candle[]): ExchangeAdapter => ({
  getName: () => 'MockExchange',
  getCandles: vi.fn().mockResolvedValue(candles),
  getAssetContext: vi.fn().mockResolvedValue(null),
  getPredictedFundings: vi.fn().mockResolvedValue([]),
  getFundingHistory: vi.fn().mockResolvedValue([]),
  getCurrentPrice: vi.fn().mockResolvedValue(REGIME_SHOULDER_CLOSE),
});

async function run(candles: Candle[] = regimeCandles()): Promise<MarketRegimeResult> {
  vi.mocked(getAdapter).mockReturnValue(adapterOver(candles));
  return getMarketRegime({ coin: REGIME_COIN, timeframe: REGIME_TIMEFRAME, exchange: REGIME_EXCHANGE });
}

/**
 * The single `INSERT INTO candle_basis_shadow` call, as `{ sql, params }`.
 *
 * The shadow write is deliberately FIRE-AND-FORGET — `getMarketRegime` `void`s it and
 * returns without awaiting, which is the property that keeps a shadow-store stall off
 * the live path. So the response resolving does NOT mean the row was written, and every
 * assertion about it has to WAIT. Waiting is the correct fix here; making the tool await
 * its own shadow write to make a test simpler would trade the live path's isolation for
 * test convenience.
 */
function shadowInsert(): { sql: string; params: unknown[] } | null {
  const call = vi.mocked(dbQuery).mock.calls.find(
    (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO candle_basis_shadow'),
  );
  return call ? { sql: call[0] as string, params: (call[1] ?? []) as unknown[] } : null;
}

/** Only `Date` is faked, so real timers drive `waitFor`. */
async function awaitShadowInsert(): Promise<{ sql: string; params: unknown[] }> {
  await vi.waitFor(
    () => expect(shadowInsert(), 'no INSERT INTO candle_basis_shadow was issued').not.toBeNull(),
    { timeout: 2000, interval: 5 },
  );
  return shadowInsert()!;
}

/** Let the fire-and-forget chain settle when the assertion is that NOTHING was written. */
async function settleShadow(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
}

/** Column name → bound value, read off the INSERT's own column list. */
async function shadowRow(): Promise<Record<string, unknown>> {
  const ins = await awaitShadowInsert();
  const cols = ins.sql.slice(ins.sql.indexOf('(') + 1, ins.sql.indexOf(')'))
    .split(',').map((s) => s.trim());
  expect(cols.length).toBe(ins.params.length);
  return Object.fromEntries(cols.map((c, i) => [c, ins.params[i]]));
}

describe('CH3 wiring — CANDLE_BASIS=closed and the shadow write', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(GOLDEN_NOW_MS);
    vi.clearAllMocks();
    // `clearAllMocks` clears CALLS but not IMPLEMENTATIONS, so the `mockRejectedValue`
    // set by the fail-safe test below would leak forward and make the
    // `CANDLE_BASIS_SHADOW_ENABLED=0` test pass because the DB was broken rather than
    // because the shadow was off — a vacuous pass. Re-arm the happy path every time.
    vi.mocked(dbQuery).mockResolvedValue([]);
    resetLicenseCache();
    _resetCandleBasisShadowEnsure();
    process.env.CQS_API_KEY = 'test-key';
    // The shadow store is PG-only by design; without this it is a documented no-op.
    process.env.DATABASE_URL = 'postgres://test/test';
    delete process.env.CANDLE_BASIS;
    delete process.env.CANDLE_BASIS_SHADOW_ENABLED;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CANDLE_BASIS;
    delete process.env.CANDLE_BASIS_SHADOW_ENABLED;
    delete process.env.DATABASE_URL;
  });

  // ── AC3 — the volume-weighted site moves in the PUBLIC envelope ─────────────
  it('AC3: CANDLE_BASIS=closed changes pivot_quality in the emitted envelope', async () => {
    const live = await run();
    process.env.CANDLE_BASIS = 'closed';
    const closed = await run();

    expect(closed.metrics.pivot_quality).not.toBe(live.metrics.pivot_quality);
    // Direction is the point: the live basis publishes an EXTRA pivot that the
    // in-progress bar confirmed, and higher-scoring pivots lift the average.
    expect(live.metrics.pivot_quality).toBeGreaterThan(closed.metrics.pivot_quality);
    // Non-vacuity — neither side fell through to the MIXED/zero default.
    expect(closed.metrics.pivot_quality).toBeGreaterThan(0);
  });

  // ── AC4 — currentPrice is a LEVEL: it stays LIVE under the closed basis ─────
  it('AC4: under CANDLE_BASIS=closed, volatility_ratio still divides by the LIVE close', async () => {
    process.env.CANDLE_BASIS = 'closed';
    const result = await run();

    const cs = regimeCandles();
    const closedBars = cs.slice(0, REGIME_PARTIAL_INDEX);
    const atrClosed = atr(
      closedBars.map((c) => c.high), closedBars.map((c) => c.low), closedBars.map((c) => c.close), 14,
    );
    expect(atrClosed).not.toBeNull();

    // ATR moved to the closed bars…
    expect(result.metrics.volatility_ratio).toBe(
      parseFloat((atrClosed! / REGIME_SHOULDER_CLOSE).toFixed(4)),
    );
    // …but the divisor did NOT. This is the assertion that fails if a later edit
    // reads `currentPrice` off `emittedCandles` instead of `candles`.
    expect(result.metrics.volatility_ratio).not.toBe(
      parseFloat((atrClosed! / REGIME_PIVOT_CLOSE).toFixed(4)),
    );
  });

  // ── AC5 — the tool discriminator and the regime's own columns ───────────────
  it('AC5: the shadow row is tagged get_market_regime and carries structure/pivot columns', async () => {
    await run();
    const row = await shadowRow();

    expect(row.tool).toBe('get_market_regime');
    expect(row.coin).toBe(REGIME_COIN);
    expect(row.timeframe).toBe(REGIME_TIMEFRAME);
    expect(typeof row.structure_live).toBe('string');
    expect(typeof row.pivot_quality_live).toBe('number');
    // Both bases were derived, so the closed side is populated rather than an error.
    expect(row.error_class).toBeNull();
    expect(row.call_closed).not.toBeNull();
    expect(row.pivot_quality_closed).not.toBe(row.pivot_quality_live);

    // The trade-call model internals have no regime analogue and are NULL, never a
    // fabricated number — CH4 aggregates these columns.
    for (const c of ['raw_live', 'raw_closed', 'vol_score_live', 'vol_score_closed',
                     'rsi_score_live', 'rsi_score_closed']) {
      expect(row[c], `${c} must be NULL for a regime row`).toBeNull();
    }

    // Bar accounting: the partial bar is exactly the difference.
    expect(row.n_total).toBe(regimeCandles().length);
    expect(row.n_closed).toBe(regimeCandles().length - 1);
    expect(row.elapsed_fraction).toBeCloseTo(0.1, 6);
  });

  it('AC5: the migration is idempotent-shaped — tool column added and legacy rows backfilled', async () => {
    await run();
    // The INSERT is issued last, so its arrival proves every DDL statement ran.
    await awaitShadowInsert();
    const ddl = vi.mocked(dbQuery).mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes('candle_basis_shadow'));

    expect(ddl.some((s) => /ADD COLUMN IF NOT EXISTS tool TEXT/.test(s))).toBe(true);
    expect(ddl.some((s) => /UPDATE candle_basis_shadow SET tool = 'get_trade_call' WHERE tool IS NULL/.test(s))).toBe(true);
    // The NOT NULL relaxation a regime row depends on.
    for (const col of ['raw_live', 'vol_score_live', 'rsi_score_live']) {
      expect(
        ddl.some((s) => s.includes(`ALTER COLUMN ${col} DROP NOT NULL`)),
        `${col} must be relaxed or a regime INSERT violates NOT NULL`,
      ).toBe(true);
    }
  });

  // ── Fail-safe isolation ────────────────────────────────────────────────────
  it('a failing closed-basis derivation never reaches the live path', async () => {
    // 30 bars exactly: the live basis meets REQUIRED_CANDLES, the closed basis (29)
    // does not. The live response must be unaffected and the throw recorded, not raised.
    const result = await run(regimeCandles(30));

    expect(result.regime).toBeDefined();
    expect(result.metrics.pivot_quality).toBeGreaterThanOrEqual(0);

    const row = await shadowRow();
    expect(row.tool).toBe('get_market_regime');
    expect(row.error_class).toBe('InsufficientCandlesError');
    expect(row.call_closed).toBeNull();
    expect(row.pivot_quality_closed).toBeNull();
    expect(row.call_live).toBe(result.regime);
  });

  it('a shadow-write failure never fails the request', async () => {
    vi.mocked(dbQuery).mockRejectedValue(new Error('db down'));
    await expect(run()).resolves.toMatchObject({ coin: REGIME_COIN });
  });

  it('CANDLE_BASIS_SHADOW_ENABLED=0 skips the closed pass entirely', async () => {
    process.env.CANDLE_BASIS_SHADOW_ENABLED = '0';
    await run();
    await settleShadow(); // absence is only meaningful once the chain has had its chance
    expect(shadowInsert()).toBeNull();
  });
});

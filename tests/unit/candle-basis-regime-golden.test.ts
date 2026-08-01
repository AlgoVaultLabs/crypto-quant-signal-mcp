/**
 * candle-basis-regime-golden.test.ts — SIGNAL-CLOSEDBAR-SHADOW-W1 CH3 AC2/AC3/AC4
 *
 * CH3's oracle, the exact analogue of CH2's `candle-basis-golden.test.ts`:
 * `tests/fixtures/get-market-regime-golden-preclosedbar.json` was recorded from
 * UNMODIFIED `get-market-regime.ts`, and every later change deep-equals against it
 * with `CANDLE_BASIS` unset. See that file's header for why the ONE normalized
 * field is `_algovault.version` and why the allow-list is asserted not to grow.
 *
 * ── What CH3 measures that CH2 did not ───────────────────────────────────────
 * Diagnostic §9 listed this tool as explicitly NOT verified — "same partial-bar
 * input, different consumer". Measured here rather than assumed, the mechanism is
 * STRUCTURAL and has nothing to do with CH2's volRatio ladder:
 *
 *   `detectPriceStructure` scans `for (i = 1; i < len - 1; i++)`, so the newest bar
 *   is never a pivot candidate — it is the right-hand CONFIRMING shoulder. Under
 *   the live basis that shoulder is the IN-PROGRESS bar, so bar `n-2` is published
 *   as a confirmed volume-weighted pivot on the strength of a high still forming.
 *
 * The fixture's bar 98 is exactly that pivot. Dropping the partial bar makes 98 the
 * final bar, so it leaves the candidate range entirely: 21 pivots → 20.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Mocked before any src import so module-load-time constants pick up the mocks.
vi.mock('../../src/lib/exchange-adapter.js', () => ({ getAdapter: vi.fn() }));
vi.mock('../../src/lib/performance-db.js', () => ({
  recordSignal: vi.fn(),
  recordFunding: vi.fn(),
  recordHoldCount: vi.fn(),
  getFundingZScore: vi.fn().mockReturnValue(null),
  isShortLivedScript: () => false,
  // Needed by venue-shadow (and, from CH3, candle-basis-shadow) so `venue_status`
  // records its REAL path rather than an ERROR-FALLBACK pinned to a catch block.
  dbQuery: vi.fn().mockResolvedValue([]),
  dbExec: vi.fn().mockResolvedValue(undefined),
}));

import { getMarketRegime } from '../../src/tools/get-market-regime.js';
import { getAdapter } from '../../src/lib/exchange-adapter.js';
import { resetLicenseCache } from '../../src/lib/license.js';
import { detectPriceStructure, atr } from '../../src/lib/indicators.js';
import type { ExchangeAdapter, MarketRegimeResult } from '../../src/types.js';
import {
  GOLDEN_NOW_MS,
  REGIME_COIN,
  REGIME_TIMEFRAME,
  REGIME_EXCHANGE,
  REGIME_PIVOT_INDEX,
  REGIME_PIVOT_CLOSE,
  REGIME_SHOULDER_CLOSE,
  REGIME_PARTIAL_INDEX,
  regimeCandles,
} from '../fixtures/candle-basis-regime-inputs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(HERE, '..', 'fixtures', 'get-market-regime-golden-preclosedbar.json');

/** The complete volatile-field allow-list, as dotted paths. Asserted below so it cannot grow. */
const NORMALIZED_KEYS = ['_algovault.version'] as const;

/** JSON round-trip, then blank the one volatile path. See CH2's test for the rationale. */
function normalize(envelope: MarketRegimeResult): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(envelope)) as Record<string, unknown>;
  const meta = clone._algovault as Record<string, unknown> | undefined;
  if (meta && 'version' in meta) meta.version = '<PKG_VERSION>';
  return clone;
}

/** Every dotted path at which two plain-JSON structures differ. */
function diffPaths(a: unknown, b: unknown, path = ''): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const plain = (v: unknown) => v && typeof v === 'object' && !Array.isArray(v);
  if (!plain(a) || !plain(b)) return [path || '<root>'];
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  return [...keys].flatMap((k) =>
    diffPaths(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
      path ? `${path}.${k}` : k,
    ),
  );
}

const regimeAdapter = (): ExchangeAdapter => ({
  getName: () => 'MockExchange',
  getCandles: vi.fn().mockResolvedValue(regimeCandles()),
  getAssetContext: vi.fn().mockResolvedValue(null),
  getPredictedFundings: vi.fn().mockResolvedValue([]),
  getFundingHistory: vi.fn().mockResolvedValue([]),
  getCurrentPrice: vi.fn().mockResolvedValue(REGIME_SHOULDER_CLOSE),
});

async function runRegime(): Promise<MarketRegimeResult> {
  vi.mocked(getAdapter).mockReturnValue(regimeAdapter());
  return getMarketRegime({ coin: REGIME_COIN, timeframe: REGIME_TIMEFRAME, exchange: REGIME_EXCHANGE });
}

/** `detectPriceStructure` over a slice of the fixture, exactly as the tool calls it. */
function structureOver(count: number) {
  const cs = regimeCandles().slice(0, count);
  return detectPriceStructure(
    cs.map((c) => c.high), cs.map((c) => c.low), cs.map((c) => c.close), cs.map((c) => c.volume),
  );
}

describe('CH3 — golden pre-closed-bar envelope for get_market_regime', () => {
  beforeEach(() => {
    // Only Date is faked: faking timers wholesale would stall the awaited promises.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(GOLDEN_NOW_MS);
    vi.clearAllMocks();
    resetLicenseCache();
    process.env.CQS_API_KEY = 'test-key';
    delete process.env.CANDLE_BASIS;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CANDLE_BASIS;
  });

  // ── AC2 ────────────────────────────────────────────────────────────────────
  it('AC2: captures / matches the golden envelope with CANDLE_BASIS unset', async () => {
    const result = await runRegime();

    if (process.env.UPDATE_GOLDEN === '1') {
      writeFileSync(GOLDEN_PATH, JSON.stringify(normalize(result), null, 2) + '\n');
    }

    expect(
      existsSync(GOLDEN_PATH),
      `golden fixture missing at ${GOLDEN_PATH} — record it from UNMODIFIED code with UPDATE_GOLDEN=1`,
    ).toBe(true);

    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
    expect(normalize(result)).toEqual(golden);
  });

  it('AC2: normalizes EXACTLY one volatile field — the allow-list cannot grow silently', async () => {
    const result = await runRegime();
    const raw = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;

    expect(diffPaths(raw, normalize(result))).toEqual([...NORMALIZED_KEYS]);

    // The field really was populated before normalization — a null/absent `version`
    // would make the allow-list vacuous (matching by both sides being empty).
    const version = (raw._algovault as Record<string, unknown>).version;
    expect(typeof version).toBe('string');
    expect((version as string).length).toBeGreaterThan(0);

    // `timestamp` is deliberately NOT normalized — it is pinned by fake timers, so
    // it stays a real assertion that the clock seam did not move.
    expect(raw.timestamp).toBe(Math.floor(GOLDEN_NOW_MS / 1000));
  });

  it('AC2: is NON-VACUOUS — the envelope carries real volume-weighted structure', async () => {
    const result = await runRegime();
    // `pivot_quality` 0 is what `detectPriceStructure` returns when it bails to the
    // MIXED default or the volume-blind fallback, so a non-zero value proves the
    // fixture actually drove the volume-weighted path this chapter is about.
    expect(result.metrics.pivot_quality).toBeGreaterThan(0);
    expect(result.metrics.price_structure).not.toBe('MIXED');
    expect(structureOver(100).pivotCount).toBeGreaterThan(2);
  });

  // ── AC3 — the volume-weighted site demonstrably moves ───────────────────────
  it('AC3: the in-progress bar confirms a pivot that does not exist on closed bars', () => {
    const live = structureOver(100);
    const closed = structureOver(99);

    // The premature pivot: bar 98 qualifies ONLY while the unfinished bar 99 sits to
    // its right as a confirming shoulder. Drop it and 98 becomes the final bar, which
    // `for (i = 1; i < len - 1; i++)` never considers.
    expect(live.pivotCount).toBe(closed.pivotCount + 1);

    // And it surfaces in the PUBLIC envelope field, not just an internal count.
    expect(live.avgPivotScore).not.toBe(closed.avgPivotScore);
    expect(Math.abs(live.avgPivotScore - closed.avgPivotScore)).toBeGreaterThan(0.001);

    // Non-vacuity: the divergence is the pivot bar itself, not incidental drift.
    const cs = regimeCandles();
    expect(cs[REGIME_PIVOT_INDEX].close).toBe(REGIME_PIVOT_CLOSE);
    expect(cs[REGIME_PIVOT_INDEX].high).toBeGreaterThan(cs[REGIME_PIVOT_INDEX - 1].high);
    expect(cs[REGIME_PIVOT_INDEX].high).toBeGreaterThan(cs[REGIME_PARTIAL_INDEX].high);
  });

  // ── AC4 — currentPrice is a LEVEL and stays LIVE under both bases ───────────
  it('AC4: the fixture makes an AC4 regression VISIBLE (last live close ≠ last closed close)', () => {
    const cs = regimeCandles();
    // If a later edit wrongly moved `currentPrice` onto the closed basis it would
    // read 3030 instead of 2990 — a 40-point gap, so the AC4 assertion in the
    // wiring test below cannot pass by both candidates coinciding.
    expect(cs[REGIME_PARTIAL_INDEX].close).toBe(REGIME_SHOULDER_CLOSE);
    expect(cs[REGIME_PIVOT_INDEX].close).toBe(REGIME_PIVOT_CLOSE);
    expect(cs[REGIME_PARTIAL_INDEX].close).not.toBe(cs[REGIME_PIVOT_INDEX].close);
  });

  it('AC4: volatility_ratio divides by the LIVE last close under the default basis', async () => {
    const result = await runRegime();
    const cs = regimeCandles();
    const atrLive = atr(cs.map((c) => c.high), cs.map((c) => c.low), cs.map((c) => c.close), 14);

    expect(atrLive).not.toBeNull();
    expect(result.metrics.volatility_ratio).toBe(
      parseFloat((atrLive! / REGIME_SHOULDER_CLOSE).toFixed(4)),
    );
    // …and NOT by the last CLOSED close, which is the regression this pins.
    expect(result.metrics.volatility_ratio).not.toBe(
      parseFloat((atrLive! / REGIME_PIVOT_CLOSE).toFixed(4)),
    );
  });
});

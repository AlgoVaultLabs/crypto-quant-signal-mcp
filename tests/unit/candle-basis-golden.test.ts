/**
 * candle-basis-golden.test.ts — SIGNAL-CLOSEDBAR-SHADOW-W1 CH2 Step 2.0 + AC1
 *
 * The MECHANISM behind "the default path is byte-identical to today's live output".
 *
 * AC1 is not an assertion anyone can eyeball — it needs an oracle captured from
 * UNMODIFIED code and then held fixed across the refactor. This file is that oracle:
 * `tests/fixtures/get-trade-call-golden-preclosedbar.json` was recorded BEFORE
 * `get-trade-call.ts` was touched (Step 2.0), and every later change deep-equals
 * against it with `CANDLE_BASIS` unset.
 *
 * ── The ONE normalized field, and why ────────────────────────────────────────
 * `version: PKG_VERSION` (get-trade-call.ts:605) is the only envelope field that
 * legitimately changes for reasons that have nothing to do with this wave: it moves
 * on EVERY daily release. Pinning it would make an unrelated `RELEASE-vX.Y.Z-W1`
 * fail CH2's acceptance criterion — inverting the fixture from "proves the refactor
 * moved nothing" into a standing release blocker. So `version` is replaced on BOTH
 * sides before comparison, and the allow-list is asserted to be EXACTLY that one
 * key so it cannot quietly grow to cover a real regression.
 *
 * Every scoring field — call, confidence, raw score, each component score, regime,
 * price — is compared byte-exact. `timestamp` is NOT normalized: it is pinned by
 * fake timers, so it is a real assertion that the clock seam stayed put.
 *
 * ── Regenerating ─────────────────────────────────────────────────────────────
 * `UPDATE_GOLDEN=1 npm test -- tests/unit/candle-basis-golden.test.ts` rewrites the
 * fixture. That is a DELIBERATE act: it re-baselines the very thing AC1 protects, so
 * it belongs in a wave that has decided the envelope should move, never as a way to
 * make a red test green.
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
  // dbQuery/dbExec are needed by venue-shadow (and, from CH2, candle-basis-shadow).
  // Without them the mock throws "No export defined", venue-shadow catches, and the
  // fixture would encode an ERROR-FALLBACK `venue_status` instead of the real path —
  // deterministic, but pinned to a catch block a later refactor could legitimately move.
  dbQuery: vi.fn().mockResolvedValue([]),
  dbExec: vi.fn().mockResolvedValue(undefined),
}));

import { getTradeSignal } from '../../src/tools/get-trade-call.js';
import { getAdapter } from '../../src/lib/exchange-adapter.js';
import { resetLicenseCache } from '../../src/lib/license.js';
import { _setSnapshotForTest, _clearCache, _setScorerOverride } from '../../src/lib/cross-asset-grid.js';
import type { ExchangeAdapter, TradeCallResult } from '../../src/types.js';
import {
  GOLDEN_NOW_MS,
  GOLDEN_COIN,
  GOLDEN_TIMEFRAME,
  GOLDEN_VOL_SCORE_LIVE,
  VOLUME_LADDER_VALUES,
  goldenCandles,
  goldenAssetContext,
} from '../fixtures/candle-basis-golden-inputs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(HERE, '..', 'fixtures', 'get-trade-call-golden-preclosedbar.json');

/** The complete volatile-field allow-list, as dotted paths. Asserted below so it cannot grow. */
const NORMALIZED_KEYS = ['_algovault.version'] as const;

/**
 * JSON round-trip then blank the one volatile path. The round-trip is deliberate:
 * the oracle is a JSON file, so `undefined`-valued keys must drop on both sides or
 * the deep-equal would compare a live object against something JSON can't express.
 */
function normalize(envelope: TradeCallResult): Record<string, unknown> {
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

const goldenAdapter = (): ExchangeAdapter => ({
  getName: () => 'MockExchange',
  getCandles: vi.fn().mockResolvedValue(goldenCandles()),
  getAssetContext: vi.fn().mockResolvedValue(goldenAssetContext()),
  getPredictedFundings: vi.fn().mockResolvedValue([]),
  getFundingHistory: vi.fn().mockResolvedValue([]),
  getCurrentPrice: vi.fn().mockResolvedValue(2994),
});

async function runGolden(): Promise<TradeCallResult> {
  vi.mocked(getAdapter).mockReturnValue(goldenAdapter());
  return getTradeSignal({ coin: GOLDEN_COIN, timeframe: GOLDEN_TIMEFRAME, exchange: 'BINANCE' });
}

describe('CH2 Step 2.0 — golden pre-closed-bar envelope', () => {
  beforeEach(() => {
    // Only Date is faked: faking timers wholesale would stall the awaited promises.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(GOLDEN_NOW_MS);
    vi.clearAllMocks();
    resetLicenseCache();
    process.env.CQS_API_KEY = 'test-key';
    delete process.env.CANDLE_BASIS;
    _clearCache();
    _setScorerOverride(null);
    _setSnapshotForTest([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    _clearCache();
    _setScorerOverride(null);
    delete process.env.CANDLE_BASIS;
  });

  it('captures / matches the golden envelope with CANDLE_BASIS unset', async () => {
    const result = await runGolden();

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

  it('normalizes EXACTLY one volatile field — the allow-list cannot grow silently', async () => {
    const result = await runGolden();
    const raw = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;

    expect(diffPaths(raw, normalize(result))).toEqual([...NORMALIZED_KEYS]);

    // And the field really was populated before normalization — a null/absent
    // `version` would make the allow-list vacuous (it would "match" by both sides
    // being empty rather than by the normalization actually doing anything).
    const version = (raw._algovault as Record<string, unknown>).version;
    expect(typeof version).toBe('string');
    expect((version as string).length).toBeGreaterThan(0);

    // `timestamp` is deliberately NOT normalized — it is pinned by fake timers, so
    // it stays a real assertion that the clock seam did not move.
    expect(raw.timestamp).toBe(Math.floor(GOLDEN_NOW_MS / 1000));
  });

  it('is NON-VACUOUS: the fixture drives the volume ladder, not the zero default', async () => {
    // AC1's non-vacuity clause. `volumeScore` is internal, so it is proven through
    // the inputs that produce it: the live basis scores the ladder FLOOR (−70)
    // purely because the newest bar is 10% elapsed — the defect this wave measures.
    const candles = goldenCandles();
    const avg = candles.reduce((s, c) => s + c.volume, 0) / candles.length;
    const volRatio = candles[candles.length - 1].volume / avg;

    expect(avg).toBeGreaterThan(0); // else volumeScore short-circuits to the 0 default
    expect(volRatio).toBeLessThanOrEqual(0.5);
    expect(GOLDEN_VOL_SCORE_LIVE).toBe(-70);
    expect(VOLUME_LADDER_VALUES).toContain(GOLDEN_VOL_SCORE_LIVE);
    expect(VOLUME_LADDER_VALUES as readonly number[]).not.toContain(0);

    const result = await runGolden();
    expect(result.call).toBeDefined();
  });
});

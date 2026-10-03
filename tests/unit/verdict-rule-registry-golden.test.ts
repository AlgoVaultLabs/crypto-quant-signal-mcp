/**
 * verdict-rule-registry-golden.test.ts — SIGNAL-VERDICT-RULE-REGISTRY-W1 CH2, R5 "Golden".
 *
 * THE PROOF THAT THE REGISTRY CHANGED NO SERVED CALL. The fixture
 * `tests/fixtures/verdict-rule-registry-golden.json` was RECORDED FROM THE PRE-REGISTRY CODE, with
 * `TREND_MODE=on` — the rule production served from 2026-08-31 until this wave — BEFORE any src
 * edit in CH2. After the registry replaced the env-var selector, every scenario must still produce:
 *   - the same response, byte for byte (call, confidence, price, indicators, regime, reasoning,
 *     `_receipts`), apart from `timestamp` and the time-dependent `_algovault` envelope;
 *   - the same values in every PRE-EXISTING field the three persist arms write. New fields the
 *     registry adds (the stamp, `rule_config_id`, the capture columns) are pinned in
 *     `verdict-rule-registry.test.ts`, not here — this file pins only what existed before.
 *
 * The comparison run DELETES `TREND_MODE`. If the registry still needed the env var, the decisive
 * scenarios would fall back to the contrarian ladder and fail here.
 *
 * SYNTHETIC INPUTS ONLY. The scenarios are deterministic seeded random walks plus three shaped
 * series; no production row is in this repo (the code repo is public).
 *
 * Re-recording is a deliberate act: `VERDICT_RULE_GOLDEN_RECORD=1` rewrites the fixture, and it is
 * only legitimate against code that serves today's rule. The coverage guard below runs in BOTH
 * modes, so a recording that never reached a decisive call cannot be committed as a pass.
 *
 * SPAWN BUDGET: none required — nothing here spawns a process.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../src/lib/exchange-adapter.js', () => ({ getAdapter: vi.fn() }));
vi.mock('../../src/lib/performance-db.js', () => ({
  recordSignal: vi.fn(),
  recordFunding: vi.fn(),
  recordHoldCount: vi.fn(),
  getFundingZScore: vi.fn().mockResolvedValue(null),
  getDb: vi.fn(),
  isShortLivedScript: () => false,
}));
vi.mock('../../src/lib/scorer-input-capture.js', () => ({ recordScorerInputCapture: vi.fn() }));
vi.mock('../../src/lib/band-signal-capture.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/band-signal-capture.js')>()),
  recordBandSignalCapture: vi.fn(),
}));
vi.mock('../../src/lib/hold-decision-capture.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/hold-decision-capture.js')>()),
  recordHoldDecision: vi.fn(),
}));

import {
  getTradeSignal, computeIndicatorScores, deriveVerdict, R4_THRESHOLDS,
} from '../../src/tools/get-trade-call.js';
import { getAdapter } from '../../src/lib/exchange-adapter.js';
import * as perfDb from '../../src/lib/performance-db.js';
import { recordScorerInputCapture } from '../../src/lib/scorer-input-capture.js';
import { recordBandSignalCapture } from '../../src/lib/band-signal-capture.js';
import { recordHoldDecision } from '../../src/lib/hold-decision-capture.js';
import { resetLicenseCache } from '../../src/lib/license.js';
import { _setSnapshotForTest, _clearCache, _setScorerOverride } from '../../src/lib/cross-asset-grid.js';
import type { AssetContext, Candle, ExchangeAdapter, LicenseInfo } from '../../src/types.js';

const FIXTURE = join(__dirname, '..', 'fixtures', 'verdict-rule-registry-golden.json');
const RECORD = process.env.VERDICT_RULE_GOLDEN_RECORD === '1';
const TF_MS: Record<string, number> = { '1h': 3_600_000, '4h': 14_400_000 };
/** Unmetered and allowed every coin and timeframe — the golden is about the verdict, not the meter. */
const LICENSE: LicenseInfo = { tier: 'x402', key: null };

interface Scenario {
  id: string;
  coin: string;
  timeframe: string;
  candles: Candle[];
  ctx: AssetContext;
  fundingZ: number | null;
  env?: Record<string, string>;
}

/** Deterministic LCG walk. `volSpread` widens the last-bar volume ratio so every volume rung is reached. */
function walk(seed: number, n: number, drift: number, noise: number, tf: string, volSpread = 1.6): Candle[] {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0; return s / 2 ** 32; };
  let p = 100;
  return Array.from({ length: n }, (_, i) => {
    if (i > 0) p = p * (1 + drift + (rnd() - 0.5) * noise);
    const volume = 1_000 * (0.3 + rnd() * volSpread);
    return { time: i * TF_MS[tf], open: p, high: p * 1.004, low: p * 0.996, close: p, volume };
  });
}

/** A shaped series with a chosen LAST-bar volume, so the volume rung is explicit. */
function shaped(n: number, pct: number, tf: string, lastVol: number): Candle[] {
  let p = 100;
  return Array.from({ length: n }, (_, i) => {
    if (i > 0) p = p * (1 + pct);
    return {
      time: i * TF_MS[tf], open: p, high: p * 1.004, low: p * 0.996, close: p,
      volume: i === n - 1 ? lastVol : 1_000,
    };
  });
}

function ctxFor(coin: string, candles: Candle[], prevMove: number, fundingAnnualized: number): AssetContext {
  const last = candles[candles.length - 1].close;
  return {
    coin,
    funding: fundingAnnualized / 1095,
    fundingAnnualized,
    openInterest: 5_000_000,
    prevDayPx: last / (1 + prevMove),
    volume24h: 125_000_000,
    oraclePx: last,
    markPx: last,
  } as AssetContext;
}

function scenarios(): Scenario[] {
  const out: Scenario[] = [];
  // Shaped: the exact shapes of the trend-mode tests, with the volume rung chosen per side.
  const RIP = shaped(140, 0.012, '4h', 2_600);
  out.push({ id: 'ripping-4h-highvol', coin: 'BTC', timeframe: '4h', candles: RIP, ctx: ctxFor('BTC', RIP, 0.05, 0), fundingZ: null });
  const RIP_BAND = shaped(140, 0.012, '4h', 1_000);
  out.push({ id: 'ripping-4h-flatvol', coin: 'ETH', timeframe: '4h', candles: RIP_BAND, ctx: ctxFor('ETH', RIP_BAND, 0.05, 0), fundingZ: null });
  // Low last-bar volume (-70 rung) drags the same decisive BUY into the band (confidence 45-51).
  const RIP_LOW = shaped(140, 0.012, '4h', 300);
  out.push({ id: 'ripping-4h-lowvol-band', coin: 'SOL', timeframe: '4h', candles: RIP_LOW, ctx: ctxFor('SOL', RIP_LOW, 0.05, 0), fundingZ: null });
  const DUMP = shaped(140, -0.012, '4h', 300);
  out.push({ id: 'dumping-4h-lowvol', coin: 'BTC', timeframe: '4h', candles: DUMP, ctx: ctxFor('BTC', DUMP, -0.05, 0), fundingZ: null });
  out.push({ id: 'dumping-4h-lowvol-zsoft', coin: 'SOL', timeframe: '4h', candles: DUMP, ctx: ctxFor('SOL', DUMP, -0.05, 0), fundingZ: -2.3 });
  const FLAT = shaped(140, 0, '1h', 1_000);
  out.push({ id: 'flat-1h', coin: 'ETH', timeframe: '1h', candles: FLAT, ctx: ctxFor('ETH', FLAT, 0, 0), fundingZ: null });
  // Book not trading: every bar carries zero volume, under the enforce mode.
  const DEAD = shaped(140, 0.012, '4h', 0).map((c) => ({ ...c, volume: 0 }));
  out.push({
    id: 'ripping-4h-deadbook-enforce', coin: 'BTC', timeframe: '4h', candles: DEAD, ctx: ctxFor('BTC', DEAD, 0.05, 0),
    fundingZ: null, env: { EMIT_BOOK_LIVENESS_ENABLED: '1', EMIT_BOOK_LIVENESS_MODE: 'enforce' },
  });
  // Seeded walks: drift x noise x timeframe x funding, two seeds.
  const drifts = [0.012, 0.005, 0, -0.005, -0.012];
  const noises = [0.006, 0.03];
  const fundings: Array<{ ann: number; z: number | null }> = [
    { ann: 0, z: null }, { ann: 9.5, z: 2.7 }, { ann: -5, z: -1.8 },
  ];
  let k = 0;
  for (const seed of [11, 29]) {
    for (const drift of drifts) {
      for (const noise of noises) {
        for (const tf of ['1h', '4h']) {
          const f = fundings[k % fundings.length];
          const coin = ['BTC', 'ETH', 'SOL'][k % 3];
          const c = walk(seed * 1_000 + k, 120, drift, noise, tf);
          out.push({
            id: `walk-s${seed}-d${drift}-n${noise}-${tf}-f${f.ann}`, coin, timeframe: tf, candles: c,
            ctx: ctxFor(coin, c, drift * 6, f.ann), fundingZ: f.z,
          });
          k++;
        }
      }
    }
  }
  return out;
}

function adapterFor(s: Scenario): ExchangeAdapter {
  return {
    getName: () => 'GoldenExchange',
    getCandles: vi.fn().mockResolvedValue(s.candles.map((c) => ({ ...c }))),
    getAssetContext: vi.fn().mockResolvedValue({ ...s.ctx }),
    getPredictedFundings: vi.fn().mockResolvedValue([]),
    getCurrentPrice: vi.fn().mockResolvedValue(s.ctx.markPx),
  } as unknown as ExchangeAdapter;
}

const omit = <T extends Record<string, unknown>>(o: T, keys: string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

/** Normalise floats through JSON so the comparison is the bytes a caller would receive. */
const jsonClone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

interface Recorded {
  id: string;
  response: Record<string, unknown>;
  envelopeKeys: string[];
  recordSignal: unknown[][];
  holdCount: unknown[][];
  holdDecision: Record<string, unknown>[];
  band: Record<string, unknown>[];
  scorerInputs: Record<string, unknown>[];
  /** Coverage classification, computed from the PURE functions — never from the code under test's path. */
  cls: { regime: string; call: string; confidence: number; negated: boolean; decisive: boolean };
}

/**
 * Was the call trend-mode-decisive? Classified with the exported pure functions on the same inputs:
 * the negation is active iff `computeIndicatorScores` differs between the two polarities, and the
 * call is decisive iff the contrarian ladder's verdict differs from the served one. Used for the
 * coverage guard only.
 */
function classify(s: Scenario, served: { call: string; confidence: number; regime: string }): Recorded['cls'] {
  const last = s.candles[s.candles.length - 1].close;
  const inputs = {
    candles: s.candles,
    fundingRateAnnualized: s.ctx.fundingAnnualized,
    priceChange: s.ctx.prevDayPx > 0 ? (last - s.ctx.prevDayPx) / s.ctx.prevDayPx : 0,
    openInterest: s.ctx.openInterest,
  };
  const on = computeIndicatorScores({ ...inputs, trendMode: true });
  const off = computeIndicatorScores({ ...inputs, trendMode: false });
  const gates = (x: typeof on) => ({
    fundingZScore: s.fundingZ, fundingRateAnnualized: s.ctx.fundingAnnualized,
    hurstVal: x.hurstVal, squeezeActive: x.squeezeActive,
    r4Thresholds: R4_THRESHOLDS, buyThreshold: 40, sellThreshold: 55,
  });
  const vOff = deriveVerdict(off, gates(off));
  return {
    regime: served.regime,
    call: served.call,
    confidence: served.confidence,
    negated: on.rsiScore !== off.rsiScore,
    decisive: served.call !== 'HOLD' && vOff.signal !== served.call,
  };
}

async function run(s: Scenario): Promise<Recorded> {
  vi.clearAllMocks();
  resetLicenseCache();
  _clearCache();
  _setScorerOverride(null);
  _setSnapshotForTest([]);
  vi.mocked(getAdapter).mockReturnValue(adapterFor(s));
  vi.mocked(perfDb.getFundingZScore).mockResolvedValue(s.fundingZ);
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(s.env ?? {})) { prior[k] = process.env[k]; process.env[k] = v; }
  try {
    const result = await getTradeSignal({ coin: s.coin, timeframe: s.timeframe, license: LICENSE });
    const r = jsonClone(result) as unknown as Record<string, unknown>;
    return {
      id: s.id,
      response: omit(r, ['timestamp', '_algovault']),
      envelopeKeys: Object.keys((r._algovault ?? {}) as Record<string, unknown>).sort(),
      // signal_hash (index 5) carries the call's timestamp, so it is not reproducible.
      recordSignal: vi.mocked(perfDb.recordSignal).mock.calls.map((a) => jsonClone(a.slice(0, 8).filter((_, i) => i !== 5))),
      holdCount: vi.mocked(perfDb.recordHoldCount).mock.calls.map((a) => jsonClone(a.slice(0, 2))),
      holdDecision: vi.mocked(recordHoldDecision).mock.calls.map((a) => omit(jsonClone(a[0]) as never, ['decidedAt'])),
      band: vi.mocked(recordBandSignalCapture).mock.calls.map((a) => omit(jsonClone(a[0]) as never, ['decidedAt'])),
      scorerInputs: vi.mocked(recordScorerInputCapture).mock.calls.map((a) => omit(jsonClone(a[0]) as never, ['decidedAt', 'signalHash'])),
      cls: classify(s, { call: String(r.call), confidence: Number(r.confidence), regime: String(r.regime) }),
    };
  } finally {
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/** Every object in `golden` must reappear in `actual` with identical values on the golden's own keys. */
function expectSupersetPayloads(actual: Record<string, unknown>[], golden: Record<string, unknown>[], label: string): void {
  expect(actual.length, `${label}: payload count`).toBe(golden.length);
  golden.forEach((g, i) => {
    const picked = Object.fromEntries(Object.keys(g).map((k) => [k, actual[i][k]]));
    expect(picked, `${label}[${i}]`).toEqual(g);
  });
}

const ORIGINAL_TREND_MODE = process.env.TREND_MODE;
const ORIGINAL_BASIS = process.env.CANDLE_BASIS;
afterAll(() => {
  if (ORIGINAL_TREND_MODE === undefined) delete process.env.TREND_MODE; else process.env.TREND_MODE = ORIGINAL_TREND_MODE;
  if (ORIGINAL_BASIS === undefined) delete process.env.CANDLE_BASIS; else process.env.CANDLE_BASIS = ORIGINAL_BASIS;
});

describe('R5 golden — the registry path (all cells M) reproduces the TREND_MODE=on engine byte for byte', () => {
  beforeEach(() => {
    process.env.CQS_API_KEY = 'test-key';
    process.env.CANDLE_BASIS = 'closed'; // production's basis
    // Recording runs the PRE-registry code, which selects the rule from the env; the comparison
    // run deletes it, so a registry that still leaned on the env would fail the decisive cases.
    if (RECORD) process.env.TREND_MODE = 'on'; else delete process.env.TREND_MODE;
  });

  it('every scenario matches the recorded response and persist payloads', async () => {
    const recorded: Recorded[] = [];
    for (const s of scenarios()) recorded.push(await run(s));

    // COVERAGE GUARD — both modes. A golden that never reached a decisive call, a decisive SELL,
    // a band call or a HOLD would prove nothing about the paths the registry touches.
    const c = recorded.map((r) => r.cls);
    const tally = {
      decisiveTrackedBuy: c.filter((x) => x.decisive && x.call === 'BUY' && x.confidence >= 52).length,
      decisiveSell: c.filter((x) => x.decisive && x.call === 'SELL').length,
      decisiveBand: c.filter((x) => x.decisive && x.confidence < 52).length,
      nonDecisiveTrendingEmitted: c.filter((x) => !x.decisive && x.call !== 'HOLD' && x.regime.startsWith('TRENDING')).length,
      rangingEmitted: c.filter((x) => x.call !== 'HOLD' && x.regime === 'RANGING').length,
      hold: c.filter((x) => x.call === 'HOLD').length,
      negatedHold: c.filter((x) => x.negated && x.call === 'HOLD').length,
    };
    for (const [k, n] of Object.entries(tally)) expect(n, `coverage: ${k} (tally ${JSON.stringify(tally)})`).toBeGreaterThan(0);

    if (RECORD) {
      writeFileSync(FIXTURE, JSON.stringify({ recorded_from: 'pre-registry code, TREND_MODE=on', tally, scenarios: recorded }, null, 1) + '\n');
      return;
    }

    const golden = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { tally: typeof tally; scenarios: Recorded[] };
    expect(recorded.map((r) => r.id), 'scenario set').toEqual(golden.scenarios.map((g) => g.id));
    expect(tally, 'coverage tally').toEqual(golden.tally);
    recorded.forEach((r, i) => {
      const g = golden.scenarios[i];
      expect(r.response, `${r.id}: response`).toEqual(g.response);
      expect(r.envelopeKeys, `${r.id}: _algovault keys`).toEqual(g.envelopeKeys);
      expect(r.recordSignal.length, `${r.id}: recordSignal calls`).toBe(g.recordSignal.length);
      r.recordSignal.forEach((args, j) => expect(args, `${r.id}: recordSignal[${j}]`).toEqual(g.recordSignal[j]));
      expect(r.holdCount, `${r.id}: recordHoldCount`).toEqual(g.holdCount);
      expectSupersetPayloads(r.holdDecision, g.holdDecision, `${r.id}: holdDecision`);
      expectSupersetPayloads(r.band, g.band, `${r.id}: band`);
      expectSupersetPayloads(r.scorerInputs, g.scorerInputs, `${r.id}: scorerInputs`);
    });
  }, 120_000);
});

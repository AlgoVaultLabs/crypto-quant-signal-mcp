/**
 * verdict-reasoning-golden.test.ts — SIGNAL-REASONING-PROJECTION-W1-V2, D12 + AC6/AC7/AC8.
 *
 * The owner of the `reasoning` field's exact wording.
 *
 * `tests/unit/candle-basis-golden.test.ts` used to assert it as part of a whole-envelope
 * oracle, but that oracle exists to prove the CLOSED-BAR refactor moved nothing, and this
 * wave changes the prose on purpose. Re-baselining that fixture to accommodate an
 * intentional change is precisely what its own header forbids, so `reasoning` was
 * excluded there and this file picks it up — the failure mode to avoid is a field
 * asserted in neither place.
 *
 * The fixtures are the four calls Mr.1 reported and the wave was opened over, measured
 * live 2026-08-06 on BINANCE 1h, plus a new-listing case for the insufficient-history
 * state. Each one is a defect the old template produced; each assertion below is that
 * defect specifically, not a generic shape check.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFactorLedger, renderVerdictReasoning, type FactorLedgerInput } from '../../src/lib/verdict-factors.js';
import { FUNDING_Z_WINDOW_DAYS } from '../../src/lib/funding-window.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(HERE, '..', 'fixtures', 'verdict-reasoning-golden.json');

const WEIGHTS = { rsi: 0.30, ema: 0.10, funding: 0.25, oi: 0.15, volume: 0.20 };

/** The engine's own ladders, so a fixture is a score vector rather than an invented number. */
const fundingScoreOf = (ann: number) => (ann < -4.38 ? 80 : ann < 0 ? 40 : ann > 8.76 ? -80 : ann > 4.38 ? -40 : 0);
const oiScoreOf = (pc: number) => (pc > 0.02 ? 60 : pc > 0 ? 20 : pc < -0.02 ? -60 : pc < 0 ? -20 : 0);

interface Fixture {
  name: string;
  call: string;
  confidence: number;
  input: FactorLedgerInput;
}

function fx(o: {
  name: string; coin: string; call: string; confidence: number; rawScore: number;
  regime: FactorLedgerInput['regime']; rate: number; state: 'NORMAL' | 'ELEVATED' | 'EXTREME';
  z: number | null; oi?: number; tp: 'LOW' | 'MEDIUM' | 'HIGH'; bp: 'INACTIVE' | 'IMMINENT';
  ema: number; rsi: number; vol: number; priceChange: number; hurst: number | null; squeeze: boolean; v24: number;
}): Fixture {
  return {
    name: o.name,
    call: o.call,
    confidence: o.confidence,
    input: {
      coin: o.coin,
      scores: {
        rsiScore: o.rsi, emaScore: o.ema, fundingScore: fundingScoreOf(o.rate * 3 * 365),
        oiScore: oiScoreOf(o.priceChange), volumeScore: o.vol, hurstVal: o.hurst, squeezeActive: o.squeeze,
      },
      weights: WEIGHTS,
      outcome: { rawScore: o.rawScore },
      regime: o.regime,
      indicators: {
        funding_rate: o.rate, funding_state: o.state,
        ...(o.oi === undefined ? {} : { oi_change_pct: o.oi, oi_change_window: '24h' }),
        volume_24h: o.v24, trend_persistence: o.tp, breakout_pending: o.bp,
      },
      gates: { fundingZScore: o.z, fundingWindowDays: FUNDING_Z_WINDOW_DAYS },
    },
  };
}

const FIXTURES: Fixture[] = [
  fx({ name: 'XRP — the reported BUY at 62% narrated "no clear direction"', coin: 'XRP', call: 'BUY', confidence: 62, rawScore: 55,
    regime: 'RANGING', rate: -0.00006641, state: 'ELEVATED', z: -1.9, oi: 2.36, tp: 'HIGH', bp: 'INACTIVE',
    ema: 0, rsi: 80, vol: -30, priceChange: 0.005, hurst: 0.50, squeeze: false, v24: 900_000_000 }),
  fx({ name: 'BTC — the HOLD that opened "Trending regime, upward bias" over a bearish OI', coin: 'BTC', call: 'HOLD', confidence: 26, rawScore: 23,
    regime: 'TRENDING_UP', rate: 0.00003135, state: 'NORMAL', z: 0.4, oi: -1.17, tp: 'HIGH', bp: 'INACTIVE',
    ema: 100, rsi: 40, vol: -70, priceChange: 0.004, hurst: 0.60, squeeze: false, v24: 12_400_000_000 }),
  fx({ name: 'SOL — half of the byte-identical pair', coin: 'SOL', call: 'HOLD', confidence: 28, rawScore: -25,
    regime: 'TRENDING_DOWN', rate: -0.00006032, state: 'NORMAL', z: -0.8, oi: 2.53, tp: 'HIGH', bp: 'IMMINENT',
    ema: -100, rsi: 0, vol: -30, priceChange: -0.01, hurst: 0.60, squeeze: true, v24: 1_144_569_969 }),
  fx({ name: 'DOGE — the other half; opposite-signed OI, 4x different funding', coin: 'DOGE', call: 'HOLD', confidence: 28, rawScore: -25,
    regime: 'TRENDING_DOWN', rate: -0.00001397, state: 'NORMAL', z: -0.3, oi: -0.41, tp: 'HIGH', bp: 'IMMINENT',
    ema: -100, rsi: 0, vol: -30, priceChange: -0.01, hurst: 0.60, squeeze: true, v24: 700_000_000 }),
  fx({ name: 'NEW LISTING — funding history below the sample floor (D9)', coin: 'NEWC', call: 'HOLD', confidence: 12, rawScore: 11,
    regime: 'RANGING', rate: -0.00008, state: 'NORMAL', z: null, oi: 0.2, tp: 'MEDIUM', bp: 'INACTIVE',
    ema: 0, rsi: 40, vol: -30, priceChange: 0.001, hurst: 0.50, squeeze: false, v24: 5_000_000 }),
];

const rendered = Object.fromEntries(
  FIXTURES.map((f) => [f.name, renderVerdictReasoning(buildFactorLedger(f.input), f.call, f.confidence)]),
);

describe('verdict reasoning — wave-owned golden', () => {
  it('matches the recorded prose for every measured fixture', () => {
    if (process.env.UPDATE_REASONING_GOLDEN === '1') {
      writeFileSync(GOLDEN_PATH, JSON.stringify(rendered, null, 2) + '\n');
    }
    expect(existsSync(GOLDEN_PATH), `golden missing at ${GOLDEN_PATH}`).toBe(true);
    expect(rendered).toEqual(JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')));
  });

  // ── The four reported defects, asserted one by one ──

  it('AC6 — the XRP BUY names funding as the driver, with its measured value and its frame', () => {
    const s = rendered[FIXTURES[0].name];
    // Mr.1-approved wording, verbatim. The old string said "Ranging regime, no clear
    // direction… Moderate conviction from blended signals" over the same call.
    expect(s).toContain('Funding at -0.0066% is unusually negative for XRP over 14 days: shorts pay longs → bullish');
    expect(s).not.toContain('no clear direction');
    expect(s).not.toMatch(/moderate conviction/i);
    // D11: nothing may claim the ranging regime capped conviction — CH1.5 measured that
    // regime enters neither the verdict nor the confidence.
    expect(s).not.toMatch(/cap(s|ping)/i);
  });

  it('AC7 — the BTC HOLD no longer opens with an unqualified "upward bias"', () => {
    const s = rendered[FIXTURES[1].name];
    expect(s).not.toContain('upward bias');
    expect(s.split('. ')[0]).toBe('Regime is trending up on the moving-average cross → bullish');
    // Approved wording for the funding clause, verbatim.
    expect(s).toContain("Funding at +0.0031% sits in BTC's normal 14-day band: no crowd pressure either way");
    // Its OI is bearish; it may be reported but never pointed at as a reason.
    expect(s).not.toMatch(/open interest[^.]*→/);
  });

  it('AC8 — SOL and DOGE differ, and each carries its OWN measured funding rate', () => {
    const sol = rendered[FIXTURES[2].name];
    const doge = rendered[FIXTURES[3].name];
    expect(sol).not.toBe(doge);
    expect(sol).toContain('-0.0060%');
    expect(doge).toContain('-0.0014%');
  });

  it('AC11 — below the funding sample floor, the prose says so and never says "normal"', () => {
    const s = rendered[FIXTURES[4].name];
    expect(s).toContain('history too short to score');
    expect(s).not.toMatch(/funding[^.]*\bnormal\b/i);
    expect(s).not.toMatch(/no factor cleared its threshold/i);
  });

  it('every golden string obeys the grammar the bot depends on', () => {
    for (const [name, s] of Object.entries(rendered)) {
      expect(s.split('. '), `${name}: sentence count`).toHaveLength(3);
      expect(s.length, `${name}: ${s.length} chars`).toBeLessThanOrEqual(280);
    }
  });
});

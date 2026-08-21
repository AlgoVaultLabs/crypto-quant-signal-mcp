/**
 * SIGNAL-TREND-BLINDNESS-FIX-W1 CH3 — trend mode, the wave's only behaviour change.
 *
 * The defect, measured live on 2026-08-21: BTC/BINANCE/4h through a +20.19%/3-day advance scored
 * RSI 93.8 at -100 × 0.30 = -30 against a bullish EMA cross at +100 × 0.10 = +10, netting -20
 * before any other term, and emitted HOLD at conviction 10 while `get_market_regime` called the
 * same bar TRENDING_UP at confidence 95 with ADX 64.1. A mean-reversion engine with no trend mode.
 *
 * 🔒 THE BOUND IS THE POINT. Trend mode is a SIGN FLIP (`rsiScore = -rsiScore`), never a retune.
 * Negation preserves magnitude, so the ladder's range stays exactly [-100, +100] and
 * `MAX_RAW_SCORE = 89` cannot move. That constant is the DIVISOR of every published confidence
 * number and of the `confidence` field inside every Merkle-anchored row, so LAW 0 forbids moving
 * it. Weight redistribution was considered and rejected for precisely that reason.
 *
 * SPAWN BUDGET: none required — `scripts/check-test-budget.mjs` scopes to process-spawning blocks
 * and nothing here spawns.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  computeIndicatorScores, deriveVerdict, classifyRegimeLabel,
  type IndicatorInputs,
} from '../../src/tools/get-trade-call.js';
import { getTrendMode } from '../../src/lib/trend-mode-flag.js';
import { getR4Thresholds } from '../../src/lib/r4-relax-flag.js';
import type { Candle } from '../../src/types.js';

const WEIGHTS = { rsi: 0.30, ema: 0.10, funding: 0.25, oi: 0.15, volume: 0.20 };

function series(n: number, pct: number, px = 100): Candle[] {
  let p = px;
  return Array.from({ length: n }, (_, i) => {
    if (i > 0) p = p * (1 + pct);
    return { time: i * 14_400_000, open: p, high: p * 1.004, low: p * 0.996, close: p, volume: 1_000 };
  });
}
/** A confirmed uptrend with a saturated RSI — the exact shape that produced this wave. */
const RIPPING = series(140, 0.012);
/** Flat: EMAs inside the band ⇒ RANGING, and RSI parks mid-range. */
const FLAT = series(140, 0);

const base = (candles: Candle[], over: Partial<IndicatorInputs> = {}): IndicatorInputs => ({
  candles, fundingRateAnnualized: 0, priceChange: 0.03, openInterest: 1_000_000, ...over,
});

describe('CH3 — the flag is default-deny', () => {
  const prior = process.env.TREND_MODE;
  afterEach(() => { if (prior === undefined) delete process.env.TREND_MODE; else process.env.TREND_MODE = prior; });

  it("only the exact string 'on' enables it", () => {
    for (const v of [undefined, '', 'ON', 'On', 'true', '1', 'yes', 'off', 'onn']) {
      if (v === undefined) delete process.env.TREND_MODE; else process.env.TREND_MODE = v;
      expect(getTrendMode()).toBe('off');
    }
    process.env.TREND_MODE = 'on';
    expect(getTrendMode()).toBe('on');
  });
});

describe('CH3 — flag OFF is byte-identical to pre-wave', () => {
  it('an ABSENT trendMode and an explicit false produce identical scores', () => {
    for (const c of [RIPPING, FLAT]) {
      const absent = computeIndicatorScores(base(c));
      const explicit = computeIndicatorScores(base(c, { trendMode: false }));
      expect(explicit).toEqual(absent);
    }
  });

  it('flag OFF keeps the contrarian ladder in a CONFIRMED uptrend — the regression anchor', () => {
    const s = computeIndicatorScores(base(RIPPING, { trendMode: false }));
    expect(s.regime).toBe('TRENDING_UP');
    expect(s.rsiVal!).toBeGreaterThan(70);
    expect(s.rsiScore).toBeLessThan(0);          // still scored as overbought = bearish
    expect([-80, -100]).toContain(s.rsiScore);
  });
});

describe('CH3 — flag ON flips the saturated region, and only there', () => {
  it('a confirmed uptrend with a saturated RSI turns the most bearish input into the most bullish', () => {
    const off = computeIndicatorScores(base(RIPPING, { trendMode: false }));
    const on = computeIndicatorScores(base(RIPPING, { trendMode: true }));
    expect(on.regime).toBe('TRENDING_UP');
    expect(on.rsiScore).toBe(-off.rsiScore);            // a SIGN FLIP
    expect(Math.abs(on.rsiScore)).toBe(Math.abs(off.rsiScore)); // magnitude preserved
    expect(on.rsiScore).toBeGreaterThan(0);
    // every OTHER term is untouched — the blast radius is one rung of one ladder
    expect(on.emaScore).toBe(off.emaScore);
    expect(on.fundingScore).toBe(off.fundingScore);
    expect(on.oiScore).toBe(off.oiScore);
    expect(on.volumeScore).toBe(off.volumeScore);
  });

  it('flag ON turns the measured HOLD into a directional BUY', () => {
    const gates = {
      fundingZScore: null, fundingRateAnnualized: 0, hurstVal: null, squeezeActive: false,
      r4Thresholds: getR4Thresholds(), buyThreshold: 40, sellThreshold: 55,
    };
    const off = computeIndicatorScores(base(RIPPING, { trendMode: false }));
    const on = computeIndicatorScores(base(RIPPING, { trendMode: true }));
    const vOff = deriveVerdict(off, gates);
    const vOn = deriveVerdict(on, gates);
    expect(vOff.signal).not.toBe('BUY');   // the defect
    expect(vOn.signal).toBe('BUY');        // the fix
    expect(vOn.rawScore).toBeGreaterThan(vOff.rawScore);
  });

  it('RANGING is untouched under BOTH flag states — blast radius confined to confirmed trends', () => {
    const off = computeIndicatorScores(base(FLAT, { trendMode: false }));
    const on = computeIndicatorScores(base(FLAT, { trendMode: true }));
    expect(off.regime).toBe('RANGING');
    expect(on).toEqual(off);
  });

  it('the 60–70 rung stays contrarian — trend mode is not a momentum chaser', () => {
    // Verified against the ladder directly: the flip predicate is `rsiVal > 70`, so a
    // TRENDING_UP reading at 60 < rsi <= 70 keeps its -40.
    const src = readFileSync('src/tools/get-trade-call.ts', 'utf8');
    expect(src).toMatch(/regime === 'TRENDING_UP' && rsiVal > 70/);
    expect(src).toMatch(/regime === 'TRENDING_DOWN' && rsiVal < 30/);
    expect(src).toMatch(/else if \(rsiVal <= 70\) rsiScore = -40;/); // rung intact
  });
});

describe('CH3 — LAW 0: the confidence divisor cannot move', () => {
  it('MAX_RAW_SCORE is still 89, and still equals its declared derivation', () => {
    const src = readFileSync('src/tools/get-trade-call.ts', 'utf8');
    expect(src).toMatch(/const MAX_RAW_SCORE = 89;/);
    // 89 = RSI(100)*0.30 + EMA(100)*0.10 + Funding(80)*0.25 + OI(60)*0.15 + Vol(100)*0.20
    const derived = 100 * WEIGHTS.rsi + 100 * WEIGHTS.ema + 80 * WEIGHTS.funding
      + 60 * WEIGHTS.oi + 100 * WEIGHTS.volume;
    expect(derived).toBe(89);
  });

  it('the ATOM POSITIONS are identical under both flag states — the expiry obligation, discharged', () => {
    // get-trade-call.ts:136-160 declares an EXPIRY on the SELL=55 ratification: "editing ANY bucket
    // ladder ... moves the atom map", so a retune owes a re-derivation before assuming 55 holds.
    //
    // For THIS change the obligation is discharged structurally rather than empirically, and the
    // reason is worth stating because it is stronger than the warning assumes: the RSI ladder's
    // value set {-100,-80,-40,0,40,80,100} is SYMMETRIC UNDER NEGATION, so trend mode's sign flip
    // is a BIJECTION on that set. The reachable rsiScore values are unchanged, therefore the
    // reachable raw-score set — and every atom POSITION in it — is unchanged too. Enumerated
    // exhaustively below: 155 atoms either way, -55 still an atom, +40 still an atom.
    //
    // What DOES move is the MASS at each atom: a confirmed uptrend that used to land near -55 now
    // lands near +55. That is the emission-weighted question, it needs the corpus, and it is CH4's
    // to measure and report — never to silently retune.
    //
    // This assertion is the guard for the NEXT edit. An asymmetric ladder, a new bucket value, or a
    // WEIGHTS change would all break position-identity, and that is precisely when the atom
    // histogram genuinely must be re-derived before touching SELL = 55.
    const RSI_LADDER = [100, 80, 40, 0, -40, -80, -100];
    const EMA = [100, 0, -100], FUND = [80, 40, 0, -40, -80];
    const OI = [60, 20, 0, -20, -60], VOL = [100, 80, 50, 10, -30, -70];
    const atomsOf = (rsiSet: number[]) => {
      const out = new Set<number>();
      for (const r of rsiSet) for (const e of EMA) for (const f of FUND) for (const o of OI) for (const v of VOL) {
        out.add(Number((r * WEIGHTS.rsi + e * WEIGHTS.ema + f * WEIGHTS.funding
          + o * WEIGHTS.oi + v * WEIGHTS.volume).toFixed(10)));
      }
      return out;
    };
    // Negation must map the ladder onto ITSELF — this is the whole argument.
    expect(new Set(RSI_LADDER.map(x => -x))).toEqual(new Set(RSI_LADDER));
    const off = atomsOf(RSI_LADDER);
    const on = atomsOf([...new Set([...RSI_LADDER, ...RSI_LADDER.map(x => -x)])]);
    expect(on).toEqual(off);
    expect(off.size).toBe(155);
    expect(off.has(-55)).toBe(true);   // the ratified SELL threshold still lands ON an atom
    expect(off.has(40)).toBe(true);    // and so does the BUY threshold
  });

  it('the ladder range stays [-100, +100] in EVERY branch and under BOTH flag states', () => {
    // Sweep every regime the label can take against a wide RSI range, both flag states, and
    // assert the bound. This is the property that keeps MAX_RAW_SCORE fixed — if a future edit
    // makes trend mode a retune instead of a negation, this is what catches it.
    const corpus: Candle[][] = [RIPPING, FLAT, series(140, -0.012)];
    const seen = new Set<string>();
    for (const c of corpus) {
      seen.add(classifyRegimeLabel(c));
      for (const trendMode of [false, true]) {
        const s = computeIndicatorScores(base(c, { trendMode }));
        for (const v of [s.rsiScore, s.emaScore, s.fundingScore, s.oiScore, s.volumeScore]) {
          expect(v).toBeGreaterThanOrEqual(-100);
          expect(v).toBeLessThanOrEqual(100);
        }
      }
    }
    // VACUITY GUARD: the sweep is worthless if it never reached a confirmed trend.
    expect(seen.has('TRENDING_UP')).toBe(true);
    expect(seen.has('TRENDING_DOWN')).toBe(true);
    expect(seen.has('RANGING')).toBe(true);
  });
});

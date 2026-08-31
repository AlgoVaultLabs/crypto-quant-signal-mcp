/**
 * SIGNAL-TREND-MODE-ENABLE-W1 CH2 — the ENABLE decision, pinned.
 *
 * This file is deliberately NOT a copy of `tests/unit/scorer-trend-mode.test.ts`. That file already
 * pins the scorer mechanics — the sign flip, the untouched sibling terms, `RANGING` invariance
 * (`:107-112`), `MAX_RAW_SCORE = 89` and the 155-atom position identity. Re-asserting them here
 * would be two derivations of one guarantee, and the second copy is the one nobody updates.
 *
 * What CH2 owns, and what is asserted below:
 *   1. the STAMP↔FLAG coupling — flag off ⇒ v1, flag on ⇒ v2, re-read per call;
 *   2. the blast radius — verdicts move ONLY inside a confirmed trend;
 *   3. `VOLATILE` — asserted STRUCTURALLY, with its vacuity REPORTED rather than hidden;
 *   4. the LAW-0 constants, as a cheap tripwire on the one file this wave must not edit.
 *
 * SPAWN BUDGET: none required — nothing here spawns a process.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  computeIndicatorScores, deriveVerdict, classifyRegimeLabel, R4_THRESHOLDS,
  type IndicatorInputs,
} from '../../src/tools/get-trade-call.js';
import { currentVerdictRuleVersion } from '../../src/lib/performance-db.js';
import type { Candle, RegimeType } from '../../src/types.js';

function series(n: number, pct: number, px = 100): Candle[] {
  let p = px;
  return Array.from({ length: n }, (_, i) => {
    if (i > 0) p = p * (1 + pct);
    return { time: i * 14_400_000, open: p, high: p * 1.004, low: p * 0.996, close: p, volume: 1_000 };
  });
}
const RIPPING = series(140, 0.012);   // confirmed uptrend, saturated RSI
const DUMPING = series(140, -0.012);  // confirmed downtrend
const FLAT = series(140, 0);          // RANGING

const base = (candles: Candle[], over: Partial<IndicatorInputs> = {}): IndicatorInputs => ({
  candles, fundingRateAnnualized: 0, priceChange: 0.03, openInterest: 1_000_000, ...over,
});
const GATES = {
  fundingZScore: null, fundingRateAnnualized: 0, hurstVal: null, squeezeActive: false,
  r4Thresholds: R4_THRESHOLDS, buyThreshold: 40, sellThreshold: 55,
};

const priorFlag = process.env.TREND_MODE;
const setFlag = (v: 'on' | undefined) => {
  if (v === undefined) delete process.env.TREND_MODE; else process.env.TREND_MODE = v;
};

describe('CH2 — the stamp follows the flag that is about to be flipped', () => {
  afterEach(() => {
    if (priorFlag === undefined) delete process.env.TREND_MODE;
    else process.env.TREND_MODE = priorFlag;
  });

  it('flag OFF ⇒ v1, flag ON ⇒ v2, re-read per call on ONE module instance', () => {
    // The coupling CH2 depends on. If this were a build constant the flip would produce
    // v1-stamped v2 rows and the whole 30-day readout would be unpartitionable.
    setFlag(undefined);
    expect(currentVerdictRuleVersion()).toBe(1);
    setFlag('on');
    expect(currentVerdictRuleVersion()).toBe(2);
    setFlag(undefined);
    expect(currentVerdictRuleVersion()).toBe(1);
  });
});

describe('CH2 — the blast radius is confined to CONFIRMED trends', () => {
  it('a confirmed uptrend moves; the verdict changes and the score rises', () => {
    const off = computeIndicatorScores(base(RIPPING, { trendMode: false }));
    const on = computeIndicatorScores(base(RIPPING, { trendMode: true }));
    expect(on.regime).toBe('TRENDING_UP');
    expect(deriveVerdict(on, GATES).rawScore).toBeGreaterThan(deriveVerdict(off, GATES).rawScore);
  });

  it('a confirmed downtrend is reached by the sweep — the corpus is not all one label', () => {
    // VACUITY GUARD on this whole describe block: an "only TRENDING_* moves" claim proves nothing
    // if the fixtures never produced a TRENDING_DOWN.
    expect(classifyRegimeLabel(DUMPING)).toBe('TRENDING_DOWN');
  });

  it('a NON-trending window is byte-identical under both flag states', () => {
    // RANGING's own invariance is pinned in scorer-trend-mode.test.ts:107-112 and is NOT duplicated.
    // What is asserted here is the CH2-level claim: the flip cannot reach a bar the classifier did
    // not confirm as a trend, whatever that bar's other indicators say.
    const off = computeIndicatorScores(base(FLAT, { trendMode: false }));
    const on = computeIndicatorScores(base(FLAT, { trendMode: true }));
    expect(off.regime).not.toBe('TRENDING_UP');
    expect(off.regime).not.toBe('TRENDING_DOWN');
    expect(on).toEqual(off);
  });
});

describe('CH2 — VOLATILE: asserted STRUCTURALLY, and its vacuity is REPORTED', () => {
  /**
   * AC2.5 originally asked for "`RANGING` / `VOLATILE` verdicts byte-identical under both flag
   * states". For `VOLATILE` that assertion is VACUOUS and would have shipped green while proving
   * nothing — the trap this project calls "verified nothing wearing verified clean".
   *
   * MEASURED on production 2026-08-22, all-time `signals.regime`:
   *   TRENDING_UP 283,697 · RANGING 123,040 · TRENDING_DOWN 59,551 · NULL 36,523 · VOLATILE **0**
   *
   * `VOLATILE` belongs to `get-market-regime.ts`, a DIFFERENT tool with its own classifier, which
   * never reads `TREND_MODE`. `classifyRegimeLabel` — the one the scorer uses — cannot emit it.
   * So the honest assertion is not "VOLATILE is unchanged" but "VOLATILE is unreachable here",
   * which is a property of the code and is falsifiable.
   */
  it('classifyRegimeLabel cannot emit VOLATILE — proven from its source, not from a sample', () => {
    const src = readFileSync('src/tools/get-trade-call.ts', 'utf8');
    const body = src.slice(src.indexOf('export function classifyRegimeLabel'));
    const fnBody = body.slice(0, body.indexOf('\nexport '));
    expect(fnBody.length).toBeGreaterThan(200);          // vacuity guard: we really sliced a body
    expect(fnBody).toContain('classifyRegimeLabel');
    expect(fnBody).not.toContain('VOLATILE');            // it is not in the reachable label set
  });

  it('REPORTS the vacuity rather than hiding it behind a green assertion', () => {
    // A sweep over every fixture the scorer can produce. If a future edit ever DOES make VOLATILE
    // reachable, `observed` gains it and this test starts describing a different world — which is
    // exactly when someone should re-read AC2.5.
    const observed = new Set<RegimeType>();
    for (const c of [RIPPING, DUMPING, FLAT]) observed.add(classifyRegimeLabel(c));
    expect(observed.has('TRENDING_UP')).toBe(true);
    expect(observed.has('TRENDING_DOWN')).toBe(true);
    expect(observed.has('RANGING')).toBe(true);
    expect(observed.has('VOLATILE')).toBe(false);
    // The report itself — an explicit positive line, so a reader sees WHY the VOLATILE leg is
    // trivially satisfied instead of assuming it was tested.
    // eslint-disable-next-line no-console
    console.log(
      `[AC2.5] VOLATILE leg is VACUOUS BY CONSTRUCTION: classifyRegimeLabel's reachable set is ` +
      `{${[...observed].sort().join(', ')}} — VOLATILE absent; production rows carrying it: 0 all-time.`,
    );
  });
});

describe('CH2 — LAW 0 tripwire on the file this wave must not edit', () => {
  it('MAX_RAW_SCORE is 89 and the ladder constants are untouched', () => {
    const src = readFileSync('src/tools/get-trade-call.ts', 'utf8');
    expect(src).toMatch(/const MAX_RAW_SCORE = 89;/);
    expect(src).toMatch(/const BUY_BASE_THRESHOLD = 40;/);
    expect(src).toMatch(/const SELL_THRESHOLD_GATED = 55;/);
    expect(src).toMatch(/rsi: 0\.30,[\s\S]{0,120}volume: 0\.20,/);
  });
});

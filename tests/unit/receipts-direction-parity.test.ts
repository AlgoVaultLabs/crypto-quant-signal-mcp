/**
 * receipts-direction-parity.test.ts — OPS-RECEIPTS-FACTORS-DIRECTION-FIX-W1 R2.
 *
 * One response used to describe one factor two ways: `factors[].oi_change_pct` said
 * `bullish` while `factor_ledger[]` said `neutral / contributes:false`, in the same
 * payload, with no in-band way for an agent to learn which was authoritative. This file
 * is the invariant whose ABSENCE let that ship.
 *
 * ── What is asserted, and why not more ───────────────────────────────────────
 * The rule pinned here is the one that is TRUE: **a factor whose field feeds no verdict
 * channel reads `neutral` in BOTH arrays.** That is Class 1 — a falsehood, now removed.
 *
 * It deliberately does NOT assert blanket equality between the two arrays, because
 * Class 2 remains and is NOT a falsehood: on `NORMAL` + a negative rate,
 * `factors[].funding_state` reads `neutral` (a true statement about the z-BUCKET — funding
 * sits in its normal band) while `factor_ledger[]` reads `bullish` (a true statement about
 * the CONTRIBUTION SIGN). Two fields answer two different questions and both spell the
 * answer `direction`. That is a naming collision whose fix is documentary —
 * `OPS-RECEIPTS-DIRECTION-SEMANTICS-DECLARE-W{NEXT}`, likely folded into
 * `SIGNAL-OUTPUT-SCHEMA-DECLARE-W{NEXT}`.
 *
 * So the known divergence is asserted POSITIVELY below rather than asserted away. A
 * deferred defect that no test names is a deferred defect that drifts in silence.
 *
 * Prints one terminal `RECEIPTS_DIRECTION_PARITY_VERDICT=PASS|FAIL|INDETERMINATE`
 * (INDETERMINATE = 3, token-law default for a new gate).
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { formatReceipts, type VerdictContext } from '../../src/lib/receipts.js';
import { buildFactorLedger, fieldContributes, type FactorLedgerInput } from '../../src/lib/verdict-factors.js';
import { FUNDING_Z_WINDOW_DAYS } from '../../src/lib/funding-window.js';

const WEIGHTS = { rsi: 0.30, ema: 0.10, funding: 0.25, oi: 0.15, volume: 0.20 };
const failures: string[] = [];
const check = (cond: boolean, msg: string) => {
  if (!cond) failures.push(msg);
  expect(cond, msg).toBe(true);
};

interface Case { name: string; ind: VerdictContext['indicators'] & { volume_24h?: number }; ledger: FactorLedgerInput }

/** Every combination where both arrays name the same factor. */
function cases(): Case[] {
  const out: Case[] = [];
  const rates = [-0.00016898, -0.00000433, 0, 0.00004566, 0.0009];
  const states = ['NORMAL', 'ELEVATED', 'EXTREME'] as const;
  const ois: Array<number | undefined> = [10.0, 2.4, 0.45, -3.2, undefined];
  const bps = ['INACTIVE', 'IMMINENT'] as const;
  let n = 0;
  for (const rate of rates) for (const state of states) for (let k = 0; k < ois.length; k++) for (const bp of bps) {
    const ann = rate * 3 * 365;
    const fundingScore = ann < -4.38 ? 80 : ann < 0 ? 40 : ann > 8.76 ? -80 : ann > 4.38 ? -40 : 0;
    const ind = {
      funding_rate: rate, funding_state: state,
      ...(ois[k] === undefined ? {} : { oi_change_pct: ois[k], oi_change_window: '24h' }),
      volume_24h: 1e9, trend_persistence: (['LOW', 'MEDIUM', 'HIGH'] as const)[k % 3], breakout_pending: bp,
    } as Case['ind'];
    n += 1;
    out.push({
      name: `rate=${rate} ${state} oi=${ois[k]} ${bp}`,
      ind,
      ledger: {
        coin: 'TESTC',
        scores: {
          rsiScore: 0, emaScore: -100, fundingScore, oiScore: -20, volumeScore: -30,
          hurstVal: 0.60, squeezeActive: bp === 'IMMINENT', rsiVal: 52, avgCandleVol: 1000,
        },
        weights: WEIGHTS,
        outcome: { rawScore: -20 },
        regime: 'TRENDING_DOWN',
        indicators: ind,
        gates: { fundingZScore: state === 'NORMAL' ? -0.8 : -2.1, fundingWindowDays: FUNDING_Z_WINDOW_DAYS },
      },
    });
  }
  expect(n).toBeGreaterThan(0);
  return out;
}

const CASES = cases();

/** Both public arrays from ONE response, as a caller would receive them. */
function bothArrays(c: Case) {
  const r = formatReceipts(
    { call: 'HOLD', confidence: 20, regime: 'TRENDING_DOWN', indicators: c.ind },
    { ledger: buildFactorLedger(c.ledger) },
  );
  return { factors: r.factors, ledger: r.factor_ledger! };
}

describe('factors[] ↔ factor_ledger[] direction parity', () => {
  it('the corpus is non-empty and both arrays actually overlap (VACUITY GUARD)', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(50);
    let overlaps = 0;
    let nonContributing = 0;
    for (const c of CASES) {
      const { factors, ledger } = bothArrays(c);
      for (const f of factors) {
        if (!ledger.some((l) => l.factor === f.factor)) continue;
        overlaps += 1;
        if (!fieldContributes(f.factor)) nonContributing += 1;
      }
    }
    check(overlaps >= 100, `VACUOUS: only ${overlaps} shared factors across the corpus`);
    // Without this, the central assertion below is checking a rule nothing exercises.
    check(nonContributing > 0, 'VACUOUS: no non-contributing factor appeared in factors[] — the Class 1 rule is untested');
  });

  it('CLASS 1 — a factor feeding no verdict channel reads `neutral` in BOTH arrays', () => {
    for (const c of CASES) {
      const { factors, ledger } = bothArrays(c);
      for (const f of factors) {
        if (fieldContributes(f.factor)) continue;
        const l = ledger.find((x) => x.factor === f.factor);
        check(f.direction === 'neutral', `${c.name}: factors[].${f.factor} = ${f.direction}, expected neutral (feeds no channel)`);
        if (l) {
          check(l.direction === 'neutral', `${c.name}: ledger.${f.factor} = ${l.direction}, expected neutral`);
          check(f.direction === l.direction, `${c.name}: ${f.factor} disagrees — factors=${f.direction} ledger=${l.direction}`);
        }
      }
    }
  });

  it('the OI row keeps its signed VALUE — the fix removes a claim, not information', () => {
    const withOi = CASES.filter((c) => c.ind.oi_change_pct !== undefined && Math.abs(c.ind.oi_change_pct) >= 0.5);
    check(withOi.length > 0, 'VACUOUS: no case carries a salient OI move');
    let seen = 0;
    for (const c of withOi) {
      const oi = bothArrays(c).factors.find((f) => f.factor === 'oi_change_pct');
      if (!oi) continue; // an IMMINENT breakout takes the 3rd slot — a selection fact, not a direction one
      seen += 1;
      check(oi.direction === 'neutral', `${c.name}: OI direction is ${oi.direction}`);
      check(/^[+-]\d/.test(oi.value), `${c.name}: OI value "${oi.value}" lost its sign — that would be information loss, not a fix`);
    }
    check(seen > 0, 'VACUOUS: the OI row never occupied a slot in this corpus');
  });

  /**
   * A2's replacement for the dropped AC5. Assert the KNOWN divergence, never its absence:
   * if Class 2 is silently fixed or silently widened, this goes red and someone reads why.
   */
  it('CLASS 2 is STILL DIVERGENT and that is deliberate — asserted, not assumed', () => {
    const c: Case = CASES.find((x) => x.ind.funding_state === 'NORMAL' && x.ind.funding_rate < 0)!;
    check(!!c, 'VACUOUS: no NORMAL + negative-rate case in the corpus');
    const { factors, ledger } = bothArrays(c);
    const fF = factors.find((f) => f.factor === 'funding_state')!;
    const fL = ledger.find((l) => l.factor === 'funding_state')!;
    // factors[] answers "where does the rate sit in its own band?" → NORMAL ⇒ neutral.
    check(fF.direction === 'neutral', `factors[].funding_state = ${fF.direction}, expected neutral (z-bucket reading)`);
    // factor_ledger[] answers "which way did it move the score?" → negative ⇒ bullish.
    check(fL.direction === 'bullish', `ledger.funding_state = ${fL.direction}, expected bullish (contribution sign)`);
    check(fF.direction !== fL.direction, 'Class 2 no longer diverges — if that was deliberate, delete this test and say so in the wave that did it');
    // And BOTH are contributing rows, which is what makes this a collision and not a falsehood.
    check(fieldContributes('funding_state'), 'funding_state must feed a channel — otherwise this is Class 1, not Class 2');
  });
});

afterEach((ctx) => {
  if (ctx.task.result?.state === 'fail') failures.push(`test failed: ${ctx.task.name}`);
});

afterAll(() => {
  const vacuous = CASES.length === 0;
  const verdict = vacuous ? 'INDETERMINATE' : failures.length === 0 ? 'PASS' : 'FAIL';
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.log(`RECEIPTS_DIRECTION_PARITY_VERDICT=${verdict}`);
  if (vacuous) process.exitCode = 3;
});

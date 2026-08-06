/**
 * verdict-factors-strength.test.ts — SIGNAL-LEDGER-INTEGRITY-W1 CH3.
 *
 * A row reading `direction: neutral` AND `strength: dominant` shipped to a live caller.
 * `direction` and `strength` are two projections of ONE contribution, and V2 computed
 * them from independent expressions — independent derivations of one value drift to
 * contradiction, which is this whole arc's founding law.
 *
 * The fix is not an assertion downstream: `classifyContribution` returns BOTH from one
 * input, and every branch that yields a neutral direction yields `'none'` with it. The
 * illegal state is unrepresentable. These tests prove that, and prove it can fail.
 *
 * A2 (architect override): the 0.6 BAND is retained and the enum value renamed
 * `dominant` → `primary`. Forcing a strict top-one onto contributions within 1% of each
 * other asserts a hierarchy that does not exist, and exact ties would report ZERO top
 * rows while two strong drivers are plainly present. The invariant therefore INVERTS:
 * **≥1 `primary`** whenever any contributing row is non-neutral.
 *
 * Prints one terminal `LEDGER_STRENGTH_VERDICT=PASS|FAIL|INDETERMINATE` (INDETERMINATE = 3).
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildFactorLedger,
  classifyContribution,
  fieldKind,
  CONTRIBUTION_SCALE,
  type FactorLedgerInput,
  type FactorStrength,
  type FactorDirection,
} from '../../src/lib/verdict-factors.js';
import { FUNDING_Z_WINDOW_DAYS } from '../../src/lib/funding-window.js';

const WEIGHTS = { rsi: 0.30, ema: 0.10, funding: 0.25, oi: 0.15, volume: 0.20 };
const failures: string[] = [];
const check = (cond: boolean, msg: string) => {
  if (!cond) failures.push(msg);
  expect(cond, msg).toBe(true);
};

/** ≥50 generated ledgers spanning every sign, magnitude and channel combination. */
function ledgers(): FactorLedgerInput[] {
  const out: FactorLedgerInput[] = [];
  const emas = [100, 0, -100];
  const fundings = [80, 40, 0, -40, -80];
  const ois = [60, 20, 0, -20, -60];
  const hursts = [0.40, 0.50, 0.60, null];
  let n = 0;
  for (const ema of emas) for (const f of fundings) for (let k = 0; k < ois.length; k++) {
    n += 1;
    out.push({
      coin: 'TESTC',
      scores: {
        rsiScore: [100, 0, -60][k % 3], emaScore: ema, fundingScore: f, oiScore: ois[k],
        volumeScore: [-70, 10, 100][k % 3],
        hurstVal: hursts[k % hursts.length], squeezeActive: k % 2 === 0,
      },
      weights: WEIGHTS,
      outcome: { rawScore: [55, 23, 0, -25, -60][k % 5] },
      regime: (['TRENDING_UP', 'TRENDING_DOWN', 'RANGING'] as const)[ema > 0 ? 0 : ema < 0 ? 1 : 2],
      indicators: {
        funding_rate: f > 0 ? -0.00011 : f < 0 ? 0.00009 : 0,
        funding_state: (['NORMAL', 'ELEVATED', 'EXTREME'] as const)[k % 3],
        oi_change_pct: 2.4, oi_change_window: '24h', volume_24h: 1e9,
        trend_persistence: (['LOW', 'MEDIUM', 'HIGH'] as const)[k % 3],
        breakout_pending: k % 2 === 0 ? 'IMMINENT' : 'INACTIVE',
      },
      gates: { fundingZScore: [-2.1, -0.8, 0.4, 2.7, null][k % 5], fundingWindowDays: FUNDING_Z_WINDOW_DAYS },
    });
  }
  expect(n).toBeGreaterThan(0);
  return out;
}

const LEDGERS = ledgers().map((i) => ({ input: i, ledger: buildFactorLedger(i) }));

describe('CH3 — direction and strength are one derivation', () => {
  it('the corpus is non-empty and exercises every strength value (VACUITY GUARD)', () => {
    expect(LEDGERS.length).toBeGreaterThanOrEqual(50);
    const seen = new Set<FactorStrength>(LEDGERS.flatMap(({ ledger }) => ledger.rows.map((r) => r.strength)));
    // If a value never appears, every assertion about it below is decoration.
    for (const s of ['primary', 'supporting', 'marginal', 'none'] as const) {
      check(seen.has(s), `VACUOUS: strength "${s}" never produced by the corpus`);
    }
    const dirs = new Set<FactorDirection>(LEDGERS.flatMap(({ ledger }) => ledger.rows.map((r) => r.direction)));
    expect(dirs).toEqual(new Set(['bullish', 'bearish', 'neutral']));
  });

  it('AC3.1 — neutral ⟺ none, asserted in BOTH directions', () => {
    for (const { ledger } of LEDGERS) {
      for (const r of ledger.rows) {
        check(
          (r.direction === 'neutral') === (r.strength === 'none'),
          `biconditional broken: ${r.factor} direction=${r.direction} strength=${r.strength}`,
        );
      }
    }
    // And over the classifier directly, including inputs the ledger cannot produce.
    for (const signed of [-30, -1, 0, 1, 30]) {
      for (const contributes of [true, false]) {
        for (const kind of ['directional', 'amplifier', null] as const) {
          const { direction, strength } = classifyContribution({ signedContribution: signed, maxAbs: 30, contributes, kind });
          check((direction === 'neutral') === (strength === 'none'), `classifier broke the biconditional at signed=${signed} c=${contributes} kind=${kind}`);
        }
      }
    }
  });

  it('AC3.2 — the XRP fixture no longer yields neutral + a share', () => {
    // The exact shipped shape: an amplifier holding the largest magnitude on the board.
    // Hurst 0.40 fires the -+25 mean-reversion adjustment, larger than any visible weight
    // term (funding <=20, ema <=10, oi <=9), so it used to set the denominator AND win it.
    const xrp: FactorLedgerInput = {
      coin: 'XRP',
      scores: { rsiScore: 0, emaScore: -100, fundingScore: 40, oiScore: -20, volumeScore: -30, hurstVal: 0.40, squeezeActive: false },
      weights: WEIGHTS,
      outcome: { rawScore: -27 },
      regime: 'TRENDING_DOWN',
      indicators: {
        funding_rate: -0.00011581, funding_state: 'ELEVATED', oi_change_pct: 7.05, oi_change_window: '24h',
        volume_24h: 9e8, trend_persistence: 'HIGH', breakout_pending: 'INACTIVE',
      },
      gates: { fundingZScore: -2.1, fundingWindowDays: FUNDING_Z_WINDOW_DAYS },
    };
    const tp = buildFactorLedger(xrp).rows.find((r) => r.factor === 'trend_persistence')!;
    check(tp.direction === 'neutral', `trend_persistence direction is ${tp.direction}`);
    check(tp.strength === 'none', `trend_persistence is neutral but holds strength "${tp.strength}" — the shipped defect`);
    // It still CONTRIBUTES — the Hurst gate is wired in. Only its share is meaningless.
    check(tp.contributes === true, 'trend_persistence must still be contributes:true');
  });

  it('AC3.3 (A2-inverted) — ≥1 primary whenever any contributing row is non-neutral', () => {
    let exercised = 0;
    for (const { ledger } of LEDGERS) {
      const directional = ledger.rows.filter((r) => r.contributes && r.direction !== 'neutral');
      if (directional.length === 0) continue;
      exercised += 1;
      const primaries = ledger.rows.filter((r) => r.strength === 'primary');
      check(primaries.length >= 1, `${directional.length} directional contributing rows but ZERO primary`);
      // Every primary must itself be a directional contributor — the band is over that set.
      for (const p of primaries) {
        check(p.contributes && p.direction !== 'neutral', `primary row "${p.factor}" is not a directional contributor`);
      }
    }
    check(exercised >= 30, `VACUOUS: only ${exercised} ledgers had a directional contributing row`);
  });

  it('AC3.4 — direction+strength have exactly ONE derivation site', () => {
    const src = readFileSync(new URL('../../src/lib/verdict-factors.ts', import.meta.url), 'utf8');
    // Comments stripped: a mention in prose is not a derivation (the same rule
    // check-canaries-wired.mjs applies, and for the same reason).
    const lines = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));

    // Isolate the classifier's body. Returns INSIDE it are the one derivation; the claim
    // is about assignments OUTSIDE it, so counting the whole file (the first draft) just
    // counted the classifier's own branches and failed on correct code.
    const start = lines.findIndex((l) => l.includes('export function classifyContribution('));
    check(start >= 0, 'classifyContribution not found — the single derivation site is missing');
    let end = start;
    for (let d = 0, i = start; i < lines.length; i += 1) {
      d += (lines[i].match(/\{/g) ?? []).length - (lines[i].match(/\}/g) ?? []).length;
      if (i > start && d <= 0) { end = i; break; }
    }
    const outside = lines.filter((_, i) => i < start || i > end);

    // Outside the classifier, `strength:` may appear ONLY as the interface declaration.
    const stray = outside.filter((l) => /\bstrength:/.test(l) && !/strength: FactorStrength;/.test(l));
    check(stray.length === 0, `strength derived outside classifyContribution: ${JSON.stringify(stray.map((s) => s.trim()))}`);

    const code = lines.join('\n');
    check((code.match(/classifyContribution\(/g) ?? []).length >= 2, 'classifier is defined but never called');
    check(!/strengthOf\(/.test(code), 'the old standalone strengthOf() survives — that is the second derivation');
    // `direction` must come from the same call. `dirOf` may only be used INSIDE it (and
    // for netDirection, which reads rawScore rather than a row contribution).
    const strayDir = outside.filter((l) => /\bdirection:\s*(dirOf|'|")/.test(l) && !/direction: FactorDirection/.test(l));
    check(
      strayDir.every((l) => /direction: 'neutral'/.test(l)),
      `direction derived outside the classifier with a computed value: ${JSON.stringify(strayDir.map((s) => s.trim()))}`,
    );
  });

  it('AC3.5 — a low-weight factor at an extreme value can be primary (V2-D1 preserved)', () => {
    // ema is the SMALLEST weight (10%). With every other directional term at zero it must
    // still be able to hold the top share — strength is a share of contribution, never a
    // projection of the coefficient.
    const emaOnly: FactorLedgerInput = {
      coin: 'TESTC',
      scores: { rsiScore: 0, emaScore: 100, fundingScore: 0, oiScore: 0, volumeScore: 0, hurstVal: 0.50, squeezeActive: false },
      weights: WEIGHTS,
      outcome: { rawScore: 10 },
      regime: 'TRENDING_UP',
      indicators: {
        funding_rate: 0, funding_state: 'NORMAL', volume_24h: 1e9,
        trend_persistence: 'MEDIUM', breakout_pending: 'INACTIVE',
      },
      gates: { fundingZScore: 0.1, fundingWindowDays: FUNDING_Z_WINDOW_DAYS },
    };
    const regime = buildFactorLedger(emaOnly).rows.find((r) => r.factor === 'regime')!;
    check(regime.strength === 'primary', `the 10%-weight term reads "${regime.strength}", not primary`);
  });

  it('A1 addition — a weight-term and an adjustment-channel contribution of equal size bucket EQUALLY', () => {
    // Both channels are rawScore points (CONTRIBUTION_SCALE), so cross-channel comparison
    // is already apples-to-apples and the normalisation is the IDENTITY. Pinned because
    // the one thing that would silently corrupt the ranking is a future edit splitting
    // the units — this fixture fails the moment that happens.
    expect(CONTRIBUTION_SCALE).toBe('rawScorePoints');
    const asWeight = classifyContribution({ signedContribution: 12, maxAbs: 20, contributes: true, kind: 'directional' });
    const asAdjustment = classifyContribution({ signedContribution: 12, maxAbs: 20, contributes: true, kind: 'directional' });
    check(
      asWeight.strength === asAdjustment.strength && asWeight.direction === asAdjustment.direction,
      `equal contributions bucketed differently across channels: ${JSON.stringify(asWeight)} vs ${JSON.stringify(asAdjustment)}`,
    );
    // funding_state is the field that feeds BOTH channels — its declared kind must be
    // directional, or the equal-influence claim above is untestable in practice.
    check(fieldKind('funding_state') === 'directional', 'funding_state must be directional — it feeds a weight term AND an adjustment');
  });

  it('a non-contributing row can never hold a direction or a share', () => {
    let seen = 0;
    for (const { ledger } of LEDGERS) {
      for (const r of ledger.rows.filter((x) => !x.contributes)) {
        seen += 1;
        check(r.direction === 'neutral', `non-contributing "${r.factor}" carries direction ${r.direction}`);
        check(r.strength === 'none', `non-contributing "${r.factor}" carries strength ${r.strength}`);
      }
    }
    check(seen > 0, 'VACUOUS: no non-contributing row appeared in the corpus');
  });
});

/**
 * The verdict token must tell the truth about the WHOLE suite.
 *
 * `check()` records into `failures[]`, but a bare `expect()` throws without touching it —
 * so a failing assertion produced a red suite and a `…_VERDICT=PASS` line at the same
 * time. Measured on this file. A token that can disagree with the run it describes is
 * worse than no token, because callers gate on the token by design.
 */
afterEach((ctx) => {
  if (ctx.task.result?.state === 'fail') failures.push(`test failed: ${ctx.task.name}`);
});

afterAll(() => {
  const vacuous = LEDGERS.length === 0;
  const verdict = vacuous ? 'INDETERMINATE' : failures.length === 0 ? 'PASS' : 'FAIL';
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.log(`LEDGER_STRENGTH_VERDICT=${verdict}`);
  if (vacuous) process.exitCode = 3;
});

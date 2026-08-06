/**
 * verdict-factors-contributes.test.ts — SIGNAL-LEDGER-INTEGRITY-W1 CH2.
 *
 * `contributes` answers "does this indicator feed the verdict" — a fact about the MODEL.
 * It shipped as a per-response CONDITION at three sites (`ema !== 0`, the Hurst band,
 * `squeezeActive`), so `trend_persistence` returned `true` on XRP and `false` on three
 * other assets measured the same hour. A field that changes meaning between two calls to
 * the same tool is worse for an agent than an absent one.
 *
 * That is the V2-D5 defect — "is in the model" conflated with "is non-default this time" —
 * recurring inside the code written to retire it. So this gate asserts the PROPERTY, not
 * the four instances: `contributes` is a pure function of the field NAME.
 *
 * Prints one terminal `LEDGER_CONTRIBUTES_VERDICT=PASS|FAIL|INDETERMINATE`.
 * INDETERMINATE = 3 (token-law default for a NEW gate — deliberately not
 * `check_test_baseline.sh`'s 2, which is local to that script).
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildFactorLedger,
  fieldContributes,
  fieldKind,
  VERDICT_INPUT_CHANNELS,
  WEIGHT_TERM_FIELD,
  WITHHELD_WEIGHT_TERMS,
  CONTRIBUTION_SCALE,
  type FactorLedgerInput,
  type LedgerField,
  type WeightTerm,
} from '../../src/lib/verdict-factors.js';
import { FUNDING_Z_WINDOW_DAYS } from '../../src/lib/funding-window.js';

const WEIGHTS = { rsi: 0.30, ema: 0.10, funding: 0.25, oi: 0.15, volume: 0.20 };
const failures: string[] = [];
const check = (cond: boolean, msg: string) => {
  if (!cond) failures.push(msg);
  expect(cond, msg).toBe(true);
};

/** Every axis that used to flip a `contributes` answer, swept independently. */
function readings(): FactorLedgerInput[] {
  const out: FactorLedgerInput[] = [];
  const tps = ['LOW', 'MEDIUM', 'HIGH'] as const;
  const bps = ['INACTIVE', 'IMMINENT'] as const;
  const hursts = [0.40, 0.50, 0.60, null];
  const emas = [100, 0, -100];
  const regimes = ['TRENDING_UP', 'TRENDING_DOWN', 'RANGING'] as const;
  const states = ['NORMAL', 'ELEVATED', 'EXTREME', 'FIXED_PREIPO'] as const;
  const zs = [-2.1, 0.4, null];
  let n = 0;
  for (const tp of tps) for (const bp of bps) for (let k = 0; k < hursts.length; k++) {
    n += 1;
    out.push({
      coin: 'TESTC',
      scores: {
        rsiScore: [100, 0, -60][k % 3], emaScore: emas[k % 3], fundingScore: [80, 0, -40][k % 3],
        oiScore: [60, 0, -20][k % 3], volumeScore: [-70, 10, 100][k % 3],
        hurstVal: hursts[k], squeezeActive: bp === 'IMMINENT',
      },
      weights: WEIGHTS,
      outcome: { rawScore: [55, 0, -25][k % 3] },
      regime: regimes[k % 3],
      indicators: {
        funding_rate: [-0.00011, 0, 0.00008][k % 3],
        funding_state: states[k % states.length],
        ...(k % 2 === 0 ? { oi_change_pct: 2.4, oi_change_window: '24h' } : {}),
        volume_24h: 1_000_000_000,
        trend_persistence: tp,
        breakout_pending: bp,
      },
      gates: { fundingZScore: zs[k % zs.length], fundingWindowDays: FUNDING_Z_WINDOW_DAYS },
    });
  }
  expect(n).toBeGreaterThan(0);
  return out;
}

const READINGS = readings();

describe('CH2 — contributes is a declared structural fact', () => {
  it('the corpus is non-empty and sweeps every axis that used to flip an answer (VACUITY GUARD)', () => {
    // This test CONSTRUCTS the corpus, so empty means the test is broken, not the world.
    expect(READINGS.length).toBeGreaterThanOrEqual(24);
    const tp = new Set(READINGS.map((r) => r.indicators.trend_persistence));
    const bp = new Set(READINGS.map((r) => r.indicators.breakout_pending));
    const hu = new Set(READINGS.map((r) => String(r.scores.hurstVal)));
    const em = new Set(READINGS.map((r) => r.scores.emaScore));
    expect(tp, 'trend_persistence values').toEqual(new Set(['LOW', 'MEDIUM', 'HIGH']));
    expect(bp, 'breakout_pending values').toEqual(new Set(['INACTIVE', 'IMMINENT']));
    expect(hu.size, 'hurst incl. null — the axis that flipped XRP').toBeGreaterThanOrEqual(4);
    expect(em.size, 'emaScore incl. 0 — the axis behind `ema !== 0`').toBeGreaterThanOrEqual(3);
  });

  it('AC2.1 — no derivation site compares against a value', () => {
    // Read the source rather than trust the behaviour: a conditional that happens to
    // agree today is still the defect. The rule is that the ANSWER cannot depend on one.
    const src = readFileSync(new URL('../../src/lib/verdict-factors.ts', import.meta.url), 'utf8');
    const assignments = src
      .split('\n')
      // ASSIGNMENTS only — an object property ends in `,`. `contributes: boolean;` is the
      // interface DECLARATION and is not a derivation site.
      .filter((l) => /^\s*contributes:.*,\s*$/.test(l))
      .map((l) => l.trim());
    check(assignments.length > 0, 'VACUOUS: found no `contributes:` assignment to inspect');

    // The RULE is "the answer may not depend on a value", so the test is about what the
    // right-hand side may CONTAIN, not about matching one blessed spelling. Two legal
    // forms: the declared lookup, or a pass-through of an already-declared answer.
    // Illegal: any comparison, any boolean literal, any threshold.
    const VALUE_DEPENDENT = /===|!==|[<>]=?|&&|\|\||\btrue\b|\bfalse\b|\bnull\b/;
    const LOOKUP = /^contributes: fieldContributes\('[a-z_0-9]+'\),$/;
    const PASS_THROUGH = /^contributes: [A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+,$/;

    let lookups = 0;
    for (const a of assignments) {
      if (LOOKUP.test(a)) { lookups += 1; continue; }
      check(
        PASS_THROUGH.test(a) && !VALUE_DEPENDENT.test(a),
        `value-keyed or literal contributes assignment survives: ${a}`,
      );
    }
    // A corpus of nothing but pass-throughs would satisfy the loop above while deriving
    // the answer somewhere this scan never looked.
    check(lookups >= 6, `VACUOUS: only ${lookups} declared lookups found — the map may not be the source`);
  });

  it('AC2.2 — same indicator ⇒ same contributes across every generated reading', () => {
    const seen = new Map<string, boolean>();
    for (const input of READINGS) {
      for (const row of buildFactorLedger(input).rows) {
        const prior = seen.get(row.factor);
        if (prior === undefined) seen.set(row.factor, row.contributes);
        else check(prior === row.contributes, `"${row.factor}" flipped contributes ${prior} → ${row.contributes}`);
      }
    }
    check(seen.size >= 6, `VACUOUS: only ${seen.size} distinct factors observed`);
    // The specific row that shipped the defect, named so a regression is legible.
    check(seen.get('trend_persistence') === true, 'trend_persistence must be constant TRUE — it feeds the Hurst adjustment');
  });

  it('AC2.3 — the four measured samples now agree on trend_persistence.contributes', () => {
    // XRP returned `true` (value HIGH); BTC/SOL/DOGE returned `false` (value MEDIUM).
    // Same wiring, four answers. Replayed by their distinguishing input.
    const byTp = (['HIGH', 'MEDIUM', 'MEDIUM', 'MEDIUM'] as const).map((tp, idx) => {
      const base = READINGS[idx % READINGS.length];
      const led = buildFactorLedger({ ...base, indicators: { ...base.indicators, trend_persistence: tp } });
      return led.rows.find((r) => r.factor === 'trend_persistence')!.contributes;
    });
    check(new Set(byTp).size === 1, `the 4 samples still disagree: ${JSON.stringify(byTp)}`);
    expect(byTp).toEqual([true, true, true, true]);
  });

  it('AC2.5 — order-independence: a property that depends on iteration order is rented, not owned', () => {
    for (const input of READINGS.slice(0, 8)) {
      const forward = buildFactorLedger(input);
      // Rebuild from the same facts with the indicator keys inserted in reverse order.
      const reversed = Object.fromEntries(Object.entries(input.indicators).reverse());
      const back = buildFactorLedger({ ...input, indicators: reversed as typeof input.indicators });
      const asMap = (l: typeof forward) => Object.fromEntries(l.rows.map((r) => [r.factor, r.contributes]));
      check(
        JSON.stringify(asMap(forward)) === JSON.stringify(asMap(back)),
        `contributes depends on key order: ${JSON.stringify(asMap(forward))} vs ${JSON.stringify(asMap(back))}`,
      );
    }
  });

  it('the map itself is coherent: every field is classified, and only unfed fields carry a reason', () => {
    const fields = Object.keys(VERDICT_INPUT_CHANNELS) as LedgerField[];
    check(fields.length >= 7, `VACUOUS: only ${fields.length} fields mapped`);
    for (const f of fields) {
      const b = VERDICT_INPUT_CHANNELS[f];
      check(fieldContributes(f) === (b.feeds.length > 0), `${f}: contributes disagrees with its own feeds[]`);
      if (b.feeds.length === 0) {
        check(!!b.reason, `${f}: feeds nothing but carries no reason — an exemption belongs on the ROW`);
        check(fieldKind(f) === null, `${f}: feeds nothing but declares kind ${fieldKind(f)}`);
      } else {
        check(b.kind !== null, `${f}: feeds ${b.feeds.length} channel(s) but declares no kind`);
      }
    }
    // An amplifier scales the existing net, so it can never carry a direction of its own.
    check(fieldKind('trend_persistence') === 'amplifier', 'trend_persistence must be an amplifier');
    check(fieldKind('breakout_pending') === 'amplifier', 'breakout_pending must be an amplifier');
  });

  it('AC2.4 — the weight-term map is exhaustive, and withheld + mapped = 5', () => {
    // `Record<WeightTerm, …>` is the build-time guard: a 6th term with no entry fails tsc.
    // Asserted here at runtime too, because the type only protects the source that has it.
    const terms = Object.keys(WEIGHT_TERM_FIELD) as WeightTerm[];
    expect(new Set(terms)).toEqual(new Set(['rsi', 'ema', 'funding', 'oi', 'volume']));
    const mapped = terms.filter((t) => WEIGHT_TERM_FIELD[t] !== null);
    check(WITHHELD_WEIGHT_TERMS.length + mapped.length === 5, `withheld ${WITHHELD_WEIGHT_TERMS.length} + mapped ${mapped.length} ≠ 5`);
    expect([...WITHHELD_WEIGHT_TERMS].sort()).toEqual(['rsi', 'volume']);
    // Every mapped term must point at a field the channel map actually declares.
    for (const t of mapped) {
      const f = WEIGHT_TERM_FIELD[t]!;
      check(f in VERDICT_INPUT_CHANNELS, `weight term "${t}" maps to unknown field "${f}"`);
      check(
        VERDICT_INPUT_CHANNELS[f].feeds.some((x) => x.channel === 'weight' && x.term === t),
        `"${f}" does not declare the weight term "${t}" that maps to it — the two maps disagree`,
      );
    }
  });

  it('both channels are declared on ONE scale (the A1 correction, pinned)', () => {
    // Measured in get-trade-call.ts: `rawScore = Σ(score × weight)` and every adjustment is
    // `rawScore ±= 20|25|10|12` on that SAME accumulator. So cross-channel comparison is
    // already apples-to-apples and CH3's normalisation is the IDENTITY. Pinned because the
    // one thing that would silently break the ranking is a future edit splitting the units.
    expect(CONTRIBUTION_SCALE).toBe('rawScorePoints');
    const channels = new Set(
      Object.values(VERDICT_INPUT_CHANNELS).flatMap((b) => b.feeds.map((f) => f.channel)),
    );
    check(channels.has('weight') && channels.has('adjustment'), 'VACUOUS: the corpus does not exercise both channels');
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
  const vacuous = READINGS.length === 0;
  const verdict = vacuous ? 'INDETERMINATE' : failures.length === 0 ? 'PASS' : 'FAIL';
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.log(`LEDGER_CONTRIBUTES_VERDICT=${verdict}`);
  if (vacuous) process.exitCode = 3;
});

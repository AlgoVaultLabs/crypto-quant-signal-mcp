/**
 * pre-trade-differential.test.ts — DECISION-CALL-V2-AUDIT-W1 R2 / AC3.
 *
 * The permanent v1-vs-v2 differential on the NO-INPUT path. The v2 contract's first promise is "A call
 * with no v2 input decides exactly as v1 did"; this file holds HEAD to it against outputs the v1 engine
 * itself produced at 53ee499 for 1,000 generated v1-shape inputs (listings, funding, spreads, volumes,
 * regimes, sessions, stale fees). The fixture pins the generated inputs' hash too, so generator drift
 * and engine drift fail as two different tests — and the repair for the first is to regenerate at
 * 53ee499, never to re-pin at HEAD.
 *
 * Proven able to fail (AUDIT-W1 AC3): one mutation of `decide` turns the case-by-case test red; one
 * edit of the generator turns the hash test red. Evidence: audits/DECISION-CALL-V2-AUDIT-W1-findings.md.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decide, rankVenues, venueRuleMetrics, SIZE_MAX_PCT_OF_24H_VOLUME } from '../../src/lib/pre-trade-decision.js';
import { activeRules, evaluateRules, DEFAULT_MAX_SIZE_PCT_OF_24H_VOLUME } from '../../src/lib/pre-trade-rules.js';
import {
  DIFFERENTIAL_BASE_SHA,
  generateCases,
  inputsSha256,
  project,
  runCases,
  type DifferentialCase,
  type DifferentialFixture,
  type Projection,
} from '../harness/pre-trade-differential.js';

const fixture: DifferentialFixture = JSON.parse(
  readFileSync(new URL('../fixtures/pre-trade-differential-v1.json', import.meta.url), 'utf8'),
);
const cases = generateCases(fixture.seed, fixture.n);

/** The first case whose projection differs, with both sides and the generated input — so a red run names its case. */
function firstDifference(actual: readonly Projection[], expected: readonly Projection[], inputs: readonly DifferentialCase[]): string | null {
  for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
    const a = JSON.stringify(actual[i]);
    const e = JSON.stringify(expected[i]);
    if (a !== e) {
      return `case ${i} differs from v1 at ${DIFFERENTIAL_BASE_SHA}\n  v1:   ${e}\n  HEAD: ${a}\n  input: ${JSON.stringify(inputs[i])}`;
    }
  }
  return null;
}

describe(`pre_trade_check — v1-vs-v2 differential: ${fixture.n} v1-shape inputs pinned at ${fixture.base}`, () => {
  it('the fixture is the one this generator made: >= 1,000 cases and the pinned input hash (drift ⇒ regenerate at 53ee499, never re-pin at HEAD)', () => {
    expect(fixture.base).toBe(DIFFERENTIAL_BASE_SHA);
    expect(fixture.n).toBeGreaterThanOrEqual(1000);
    expect(cases).toHaveLength(fixture.n);
    expect(fixture.cases).toHaveLength(fixture.n);
    expect(inputsSha256(cases)).toBe(fixture.inputsSha256);
  });

  it('the generated inputs reach every decision, every v1 reason, every exclusion, a split and a timing — and no v2-only reason', () => {
    expect([...new Set(fixture.cases.map((c) => c.decision))].sort()).toEqual(['CAUTION', 'GO', 'WAIT']);
    const codes = new Set(fixture.cases.flatMap((c) => c.reasons.map((r) => r[0])));
    for (const code of [
      'NO_TRADABLE_VENUE', 'SIZE_ABOVE_VENUE_LIMIT', 'SIZE_ABOVE_TOTAL_CAPACITY', 'FUNDING_COST_HIGH', 'FUNDING_DUE_SOON',
      'REGIME_AGAINST_SIDE', 'REGIME_VOLATILE', 'UNDERLYING_CLOSED', 'REGIME_UNAVAILABLE', 'VENUES_UNAVAILABLE',
      'NEXT_FUNDING_UNKNOWN', 'FUNDING_INCOME', 'FEE_TABLE_STALE',
    ]) expect(codes, code).toContain(code);
    for (const code of ['YOUR_RULE_FAILED', 'YOUR_RULE_NOT_CHECKED', 'LIQUIDATION_BEFORE_STOP', 'VOLATILITY_UNAVAILABLE', 'LIQUIDATION_UNAVAILABLE']) {
      expect(codes, code).not.toContain(code);
    }
    const exclusions = new Set(fixture.cases.flatMap((c) => c.venues.map((v) => v.excluded)).filter((x) => x !== null));
    for (const ex of ['feed_unavailable', 'not_listed', 'thin_liquidity', 'wide_book', 'funding_unavailable', 'fee_unknown', 'volume_unavailable']) {
      expect(exclusions, ex).toContain(ex);
    }
    expect(fixture.cases.some((c) => c.split !== null)).toBe(true);
    expect(fixture.cases.some((c) => c.timing !== null)).toBe(true);
  });

  it('HEAD rankVenues + decide with no v2 input reproduce v1 case by case: decision, reasons, best venue, candidates, split, timing, size limits', () => {
    const actual = runCases({ rankVenues, decide }, cases);
    const diff = firstDifference(actual, fixture.cases, cases);
    expect(diff, diff ?? '').toBeNull();
    expect(actual).toEqual(fixture.cases);
  });

  it("HEAD with v1's defaults passed explicitly — the size fraction, a flat preference, the default rules evaluated on the best venue — decides the same (what the handler relies on for a v1 call)", () => {
    const actual = cases.map((c) => {
      const ranking = rankVenues({ ...c.rank, sizeMaxFraction: SIZE_MAX_PCT_OF_24H_VOLUME, preference: () => [0, 0, 0] });
      const rules = evaluateRules(activeRules({}), venueRuleMetrics(ranking.best, c.decide));
      return project(
        ranking,
        decide({ ...c.decide, ranking, rules, sizeMaxPct: DEFAULT_MAX_SIZE_PCT_OF_24H_VOLUME, volatilityUnavailable: false, liquidationUnavailable: null }),
      );
    });
    const diff = firstDifference(actual, fixture.cases, cases);
    expect(diff, diff ?? '').toBeNull();
    expect(actual).toEqual(fixture.cases);
  });
});

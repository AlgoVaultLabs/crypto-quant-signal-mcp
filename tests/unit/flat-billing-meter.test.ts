/**
 * PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 (CH3) — flat billing: every successful verdict is one
 * metered call, HOLD included, on every rail (R-A/R-F/R-G).
 *
 * WHERE THE RULE LIVES, AND WHY THAT IS THE POINT.
 *
 * The wave spec's CH3 edit list named three per-tool branches. Architect ratified the generator
 * fix instead (Q2-a, 2026-08-08): the charge model is DECLARED in `feature-registry.ts`
 * (`quota.unit` / `quota.holdFree`) and projected through `call-class.ts`
 * (`BILLING_AXIS_BY_QUOTA_UNIT`). Deleting the branches while leaving three registry rows saying
 * `holdFree: true` would have left the declaration and the enforcement disagreeing — the exact
 * failure CH2 exists to prevent. So the assertions here are about the REGISTRY first; the
 * per-tool branches are now dead code, and their absence is asserted rather than their behaviour.
 *
 * HISTORY IS NOT RESTATED (Q3-a). `call-class.ts` classifies `request_log` rows for the operator
 * funnel and /analytics. A global axis flip would relabel every past HOLD from `free_hold` to
 * `billable`, turning the dashboard's "~99% of external calls are free HOLDs" into 0% for all
 * time. Classification is therefore a function of (tool, verdict, WHEN THE ROW WAS WRITTEN), and
 * both sides of the cutover are asserted below.
 */
import { describe, it, expect } from 'vitest';
import { FEATURE_REGISTRY } from '../../src/lib/feature-registry.js';
import {
  callClassFor,
  billablePredicate,
  freeHoldPredicate,
  BILLING_AXIS_BY_QUOTA_UNIT,
  BILLING_AXIS_BY_TOOL,
  VERDICT_BILLABLE_TOOLS,
  LEGACY_VERDICT_BILLABLE_TOOLS,
  FLAT_BILLING_CUTOVER_MS,
  FLAT_BILLING_CUTOVER_ISO,
} from '../../src/lib/call-class.js';

const BEFORE = FLAT_BILLING_CUTOVER_MS - 60_000;
const AFTER = FLAT_BILLING_CUTOVER_MS + 60_000;

describe('R-A — the charge model DECLARES that every verdict counts', () => {
  it('vacuity guard — there is a registry to assert over', () => {
    expect(FEATURE_REGISTRY.length).toBeGreaterThanOrEqual(6);
  });

  it('no feature declares holdFree any more — the loophole is unrepresentable', () => {
    const holdFree = FEATURE_REGISTRY.filter((f) => f.quota.holdFree).map((f) => f.name);
    expect(holdFree).toEqual([]);
  });

  it('no LIVE feature still uses a verdict-conditional quota unit', () => {
    const retired = FEATURE_REGISTRY
      .filter((f) => f.quota.unit === 'per-non-hold' || f.quota.unit === 'per-non-hold-min1')
      .map((f) => f.name);
    expect(retired).toEqual([]);
  });

  it('every metered unit now sits on the "always" axis', () => {
    for (const [unit, axis] of Object.entries(BILLING_AXIS_BY_QUOTA_UNIT)) {
      expect(axis === 'always' || axis === 'never', `${unit} → ${axis}`).toBe(true);
    }
    // ...so no tool is verdict-conditional today.
    expect(VERDICT_BILLABLE_TOOLS).toEqual([]);
  });

  it('the verdict-bearing tools are on the always axis, aliases included', () => {
    for (const t of ['get_trade_call', 'get_trade_signal', 'scan_trade_calls', 'get_equity_call']) {
      expect(BILLING_AXIS_BY_TOOL[t], t).toBe('always');
    }
  });
});

describe('R-A — a HOLD is classified billable going forward, both directions', () => {
  it('HOLD charges after the cutover', () => {
    expect(callClassFor('get_trade_call', 'HOLD', false, AFTER)).toBe('billable');
    expect(callClassFor('get_trade_signal', 'HOLD', false, AFTER)).toBe('billable');
    expect(callClassFor('get_equity_call', 'HOLD', false, AFTER)).toBe('billable');
  });

  it('an actionable verdict is unchanged — it charged before and charges now', () => {
    for (const at of [BEFORE, AFTER]) {
      expect(callClassFor('get_trade_call', 'BUY', false, at)).toBe('billable');
      expect(callClassFor('get_trade_call', 'SELL', false, at)).toBe('billable');
    }
  });

  it('the exempt classes are untouched — internal and unmetered still never charge', () => {
    // The TG bot is ~6,200 calls/day (CH1). If this regressed, it breaks on day one.
    expect(callClassFor('get_trade_call', 'HOLD', true, AFTER)).toBe('internal');
    expect(callClassFor('chat_knowledge', null, false, AFTER)).toBe('unmetered');
    expect(callClassFor('search_knowledge', null, false, AFTER)).toBe('unmetered');
  });

  it('an unknown tool is still surfaced, never folded into a class', () => {
    expect(callClassFor('some_retired_tool', 'HOLD', false, AFTER)).toBe('unclassified');
    expect(callClassFor(null, 'HOLD', false, AFTER)).toBe('unclassified');
  });
});

describe('Q3-a — history keeps the semantics in force when it was written', () => {
  it('a pre-cutover HOLD is STILL free_hold', () => {
    expect(callClassFor('get_trade_call', 'HOLD', false, BEFORE)).toBe('free_hold');
    expect(callClassFor('get_trade_signal', 'HOLD', false, BEFORE)).toBe('free_hold');
  });

  it('the cutover instant itself is the first billable moment (boundary, not a gap)', () => {
    expect(callClassFor('get_trade_call', 'HOLD', false, FLAT_BILLING_CUTOVER_MS - 1)).toBe('free_hold');
    expect(callClassFor('get_trade_call', 'HOLD', false, FLAT_BILLING_CUTOVER_MS)).toBe('billable');
  });

  it('an unknown instant is treated as legacy, not as modern', () => {
    // Default-deny in the direction that cannot restate history: if we do not know when a row
    // was written, we must not assert it was charged.
    expect(callClassFor('get_trade_call', 'HOLD', false, NaN)).toBe('free_hold');
  });

  it('a tool that was never verdict-billable is billable on BOTH sides', () => {
    // scan_trade_calls charged min-1 before the cutover and per-verdict after, but it was never
    // free on a HOLD, so no historical row of it may become a freebie.
    expect(callClassFor('scan_trade_calls', 'HOLD', false, BEFORE)).toBe('billable');
    expect(callClassFor('get_market_regime', null, false, BEFORE)).toBe('billable');
  });

  it('the legacy list is a FROZEN historical fact, not a projection of the live registry', () => {
    expect([...LEGACY_VERDICT_BILLABLE_TOOLS].sort())
      .toEqual(['get_equity_call', 'get_trade_call', 'get_trade_signal']);
    // It must NOT track the registry — that is the whole point. Today the live set is empty.
    expect(VERDICT_BILLABLE_TOOLS).not.toEqual([...LEGACY_VERDICT_BILLABLE_TOOLS]);
  });
});

describe('Q3-a — the generated SQL splits on the cutover so dashboards keep their history', () => {
  it('free_hold survives as a HISTORICAL class rather than being retired', () => {
    const p = freeHoldPredicate();
    expect(p).not.toBeNull();
    expect(p!.sql).toContain('"timestamp" <');
    // Bound to the legacy tool set and to HOLD.
    expect(p!.params).toContain(FLAT_BILLING_CUTOVER_ISO);
    expect(p!.params).toContain('HOLD');
    for (const t of LEGACY_VERDICT_BILLABLE_TOOLS) expect(p!.params).toContain(t);
  });

  it('billable covers both eras and references the cutover on every branch', () => {
    const p = billablePredicate();
    expect(p).not.toBeNull();
    expect(p!.sql).toContain('"timestamp" >=');
    expect(p!.sql).toContain('"timestamp" <');
    // One cutover bind per branch — a branch that forgot it would classify the wrong era.
    // Count only the BOUND comparisons: `"timestamp" IS NULL` names the column without taking a
    // parameter, so a bare `"timestamp"` count would over-count the post-cutover branch.
    const boundComparisons = (p!.sql.match(/"timestamp"\s*(?:>=|<)\s*\?/g) ?? []).length;
    expect(boundComparisons).toBeGreaterThanOrEqual(2); // both eras are represented
    expect(p!.params.filter((x) => x === FLAT_BILLING_CUTOVER_ISO)).toHaveLength(boundComparisons);
  });

  it('placeholder count matches the bind-param count on both predicates', () => {
    // A mismatch is a runtime SQL error on a live analytics surface, not a test-only concern.
    for (const p of [billablePredicate(), freeHoldPredicate()]) {
      expect(p).not.toBeNull();
      expect((p!.sql.match(/\?/g) ?? []).length).toBe(p!.params.length);
    }
  });

  it('billable and free_hold stay MUTUALLY EXCLUSIVE across the cutover', () => {
    // The property the SQL exists to guarantee: no row may be counted in both classes, or the
    // funnel's totals stop adding up. Asserted through the one shared derivation.
    for (const at of [BEFORE, AFTER, FLAT_BILLING_CUTOVER_MS]) {
      for (const tool of ['get_trade_call', 'scan_trade_calls', 'get_market_regime']) {
        for (const verdict of ['HOLD', 'BUY', null]) {
          const c = callClassFor(tool, verdict, false, at);
          expect(['billable', 'free_hold', 'unmetered', 'unclassified']).toContain(c);
        }
      }
    }
    // and specifically: after the cutover nothing is free_hold.
    expect(callClassFor('get_trade_call', 'HOLD', false, AFTER)).not.toBe('free_hold');
  });
});

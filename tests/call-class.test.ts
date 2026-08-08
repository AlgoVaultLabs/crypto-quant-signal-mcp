/**
 * OPS-TOP-IP-FORENSICS-W1 (2026-07-31): the (tool, verdict) → billing-class derivation and its
 * projection into the digest renderer. Pure fns — no DB, always runs.
 *
 * The invariant under test is the one the 2026-07-31 digest violated: a HOLD verdict on a
 * `per-non-hold` tool is FREE BY DESIGN and must never be counted as demand. 2,819 of 2,955
 * external rows that day were exactly that.
 */
import { describe, expect, it } from 'vitest';
import {
  callClassFor,
  billablePredicate,
  freeHoldPredicate,
  unmeteredPredicate,
  BILLING_AXIS_BY_TOOL,
  BILLING_AXIS_BY_QUOTA_UNIT,
  ALWAYS_BILLABLE_TOOLS,
  VERDICT_BILLABLE_TOOLS,
  LEGACY_VERDICT_BILLABLE_TOOLS,
  FLAT_BILLING_CUTOVER_MS,
  FLAT_BILLING_CUTOVER_ISO,
  UNMETERED_TOOLS,
} from '../src/lib/call-class.js';
import { FEATURE_REGISTRY } from '../src/lib/feature-registry.js';
import { formatAgentActivity } from '../src/lib/agent-activity-format.js';

describe('call-class — derives from FEATURE_REGISTRY, never a parallel literal', () => {
  it('classifies every registry tool AND alias (no tool left unclassified)', () => {
    // Vacuity guard: an empty registry would make every assertion below trivially pass.
    expect(FEATURE_REGISTRY.length).toBeGreaterThan(0);
    for (const f of FEATURE_REGISTRY) {
      for (const name of [f.name, ...f.aliases]) {
        expect(BILLING_AXIS_BY_TOOL[name]).toBe(BILLING_AXIS_BY_QUOTA_UNIT[f.quota.unit]);
        expect(callClassFor(name, null)).not.toBe('unclassified');
      }
    }
  });

  it('every LIVE axis bucket is non-empty — a silently-empty bucket would zero a digest line', () => {
    expect(ALWAYS_BILLABLE_TOOLS.length).toBeGreaterThan(0);
    expect(UNMETERED_TOOLS.length).toBeGreaterThan(0);
    // PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 (R-A): the VERDICT bucket is now empty BY DESIGN —
    // no tool charges conditionally on its verdict any more. Asserting emptiness (rather than
    // deleting the line) keeps the vacuity guard honest: if a future wave re-introduces a
    // verdict-conditional tool, this fails and forces the decision to be explicit.
    expect(VERDICT_BILLABLE_TOOLS).toEqual([]);
    // The historical set is NOT empty — history still has free HOLDs in it.
    expect(LEGACY_VERDICT_BILLABLE_TOOLS.length).toBeGreaterThan(0);
  });

  it('the axis partition is total and disjoint', () => {
    const all = [...ALWAYS_BILLABLE_TOOLS, ...VERDICT_BILLABLE_TOOLS, ...UNMETERED_TOOLS];
    expect(new Set(all).size).toBe(all.length); // disjoint
    expect(new Set(all)).toEqual(new Set(Object.keys(BILLING_AXIS_BY_TOOL))); // total
  });

  it('HOLD is BILLABLE now, and was FREE before the cutover — the same row, two eras', () => {
    // The 2,707-call forensic that created this module remains true OF ITS OWN ERA: those rows
    // were free by design and still classify that way. Going forward R-A ends it.
    const BEFORE = FLAT_BILLING_CUTOVER_MS - 60_000;
    const AFTER = FLAT_BILLING_CUTOVER_MS + 60_000;
    expect(callClassFor('get_trade_call', 'HOLD', false, BEFORE)).toBe('free_hold');
    expect(callClassFor('get_trade_signal', 'HOLD', false, BEFORE)).toBe('free_hold'); // alias too
    expect(callClassFor('get_trade_call', 'HOLD', false, AFTER)).toBe('billable');
    expect(callClassFor('get_trade_signal', 'HOLD', false, AFTER)).toBe('billable');
    // An actionable verdict never depended on the era.
    for (const at of [BEFORE, AFTER]) {
      expect(callClassFor('get_trade_call', 'BUY', false, at)).toBe('billable');
      expect(callClassFor('get_trade_call', 'SELL', false, at)).toBe('billable');
    }
  });

  it('per-call tools charge regardless of verdict; scan charges min-1 even if all HOLD', () => {
    expect(callClassFor('get_market_regime', null)).toBe('billable');
    expect(callClassFor('scan_funding_arb', null)).toBe('billable');
    expect(callClassFor('scan_trade_calls', 'HOLD')).toBe('billable'); // per-non-hold-min1
  });

  it('rate-limited tools are unmetered against the call quota', () => {
    expect(callClassFor('search_knowledge', null)).toBe('unmetered');
    expect(callClassFor('chat_knowledge', null)).toBe('unmetered');
  });

  it('internal traffic wins over every other axis', () => {
    expect(callClassFor('get_trade_call', 'BUY', true)).toBe('internal');
    expect(callClassFor('search_knowledge', null, true)).toBe('internal');
  });

  it('an unregistered tool is surfaced as unclassified, never folded into a real class', () => {
    expect(callClassFor('some_retired_tool', 'BUY')).toBe('unclassified');
    expect(callClassFor(null, null)).toBe('unclassified');
    expect(callClassFor(undefined, 'HOLD')).toBe('unclassified');
  });
});

describe('call-class — SQL predicates encode the SAME rule as callClassFor', () => {
  it('emits one placeholder per bind param (a mismatch silently shifts every param)', () => {
    for (const p of [billablePredicate(), freeHoldPredicate(), unmeteredPredicate()]) {
      expect(p).not.toBeNull();
      expect((p!.sql.match(/\?/g) ?? []).length).toBe(p!.params.length);
    }
  });

  it('billable covers every metered tool; freeHold covers only the LEGACY verdict set', () => {
    const b = billablePredicate()!;
    for (const t of ALWAYS_BILLABLE_TOOLS) expect(b.params).toContain(t);
    expect(b.params).toContain('HOLD');       // still bound, for the pre-cutover branch
    expect(b.params).toContain(FLAT_BILLING_CUTOVER_ISO);

    const f = freeHoldPredicate()!;
    for (const t of LEGACY_VERDICT_BILLABLE_TOOLS) expect(f.params).toContain(t);
    // free_hold is now HISTORICAL: it must be bounded by the cutover, or it would keep
    // classifying new rows as free and under-report demand for ever.
    expect(f.sql).toContain('"timestamp" <');
    expect(f.params).toContain(FLAT_BILLING_CUTOVER_ISO);
    // A tool that was never verdict-billable must NOT be reachable via the free-HOLD predicate.
    for (const t of ALWAYS_BILLABLE_TOOLS.filter((x) => !LEGACY_VERDICT_BILLABLE_TOOLS.includes(x))) {
      expect(f.params).not.toContain(t);
    }
  });

  it('billable treats a NULL verdict as chargeable (matches the runtime meter)', () => {
    expect(billablePredicate()!.sql).toContain('verdict IS NULL OR verdict <> ?');
  });
});

describe('formatAgentActivity — billable decomposition', () => {
  // The real 2026-07-31 shape, from the live DB.
  const live = {
    externalGenuine: { total: 0, free: 0, paid: 0, sessions: 0, freeSessions: 0, paidSessions: 0 },
    externalAutomated: { total: 2955, sessions: 6 },
    rawConcentration: { top1_pct: 91.6, top5_pct: 99.9 },
    tgBot: { present: true, stale: false, calls_total: 125, calls_watch: 1, calls_scanwatch: 123, calls_scan: 1, subscribers: 38 },
    callClasses: { billable: 132, freeHold: 2819, unmetered: 4, unclassified: 0, billableSessions: 4, last7d: { billable: 300, freeHold: 9000 } },
    topAssetsGenuine: [],
  };

  it('leads with billable and declares the window on every new figure', () => {
    const out = formatAgentActivity(live);
    const lines = out.split('\n');
    expect(lines[0]).toBe('🤖 *Agent Activity (24h)*');
    expect(lines[1]).toBe('• 💰 Billable calls — Last 24h: 132   (4 sessions)');
    expect(lines[2]).toBe('• 🆓 Free-by-design HOLD — Last 24h: 2819');
    expect(lines[3]).toBe('• 🔎 Unmetered (rate-limited) — Last 24h: 4');
    // Add-before-remove: the legacy series survives, annotated so it is not read as demand.
    expect(out).toContain('• Total Agent Calls: 3080   (all traffic incl. free HOLD)');
  });

  it('the classes reconcile to the preserved total (3080 = 132 + 2819 + 4 + 125 internal)', () => {
    expect(live.callClasses.billable + live.callClasses.freeHold + live.callClasses.unmetered + live.tgBot.calls_total).toBe(3080);
  });

  it('surfaces a non-zero unclassified remainder instead of hiding it', () => {
    const out = formatAgentActivity({ ...live, callClasses: { ...live.callClasses, unclassified: 7 } });
    expect(out).toContain('• ❓ Unclassified — Last 24h: 7');
  });

  it('omits the unclassified line when zero (no noise on the healthy path)', () => {
    expect(formatAgentActivity(live)).not.toContain('Unclassified');
  });

  it('degrades to the EXACT prior layout when callClasses is absent (rollout window)', () => {
    const { callClasses: _omitted, ...legacy } = live;
    const out = formatAgentActivity(legacy);
    expect(out).not.toContain('Billable');
    expect(out).not.toContain('Free-by-design');
    // Unannotated legacy line, byte-identical to the pre-wave render.
    expect(out).toContain('• Total Agent Calls: 3080\n');
    expect(out.split('\n')[1]).toBe('• Total Agent Calls: 3080');
  });

  it('says "top client", not "top IP" — the concentration is session-grouped', () => {
    const out = formatAgentActivity(live);
    expect(out).toContain('(top client 91.6%)');
    expect(out).not.toContain('top IP');
  });
});

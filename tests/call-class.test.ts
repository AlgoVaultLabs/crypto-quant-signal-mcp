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
  FLAT_BILLING_CUTOVER_DATE,
  BILLING_CLASS_LABELS,
  classLabel,
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

/**
 * OPS-OPERATOR-SURFACES-HOLD-RETIRE-W1 — the RENDERED BODY is the subject.
 *
 * These assert the digest's actual text, not just the numbers that feed it. The alert-body law
 * exists because a wrong body once survived nine green action-verdict assertions; the partition
 * invariant below is therefore PARSED OUT OF THE RENDER rather than recomputed from the inputs,
 * so a mislabelled, dropped or double-counted bucket fails even when every input is correct.
 */
describe('formatAgentActivity — the rendered body partitions the headline', () => {
  /** Parse the render: the headline and every `— Last 24h:` bucket beneath it. */
  const partitionOf = (body: string) => {
    const total = Number(body.match(/• Total Agent Calls: (\d+)/)![1]);
    const buckets = [...body.matchAll(/^• (.+?) — Last 24h: (\d+)/gm)].map((m) => ({ label: m[1], n: Number(m[2]) }));
    return { total, buckets, sum: buckets.reduce((a, b) => a + b.n, 0) };
  };

  /** The live 2026-08-10 shape — a POST-cutover 24h window. freeHold is structurally 0. */
  const post = {
    externalGenuine: { total: 357, free: 357, paid: 0, sessions: 6, freeSessions: 6, paidSessions: 0 },
    externalAutomated: { total: 6, sessions: 2 },
    rawConcentration: { top1_pct: 91.6, top5_pct: 99.9 },
    tgBot: { present: true, stale: false, calls_total: 253, calls_watch: 1, calls_scanwatch: 250, calls_scan: 2, subscribers: 38 },
    callClasses: { billable: 363, freeHold: 0, unmetered: 0, unclassified: 0, billableSessions: 6, last7d: { billable: 1213, freeHold: 2408 } },
    topAssetsGenuine: [],
  };

  /** The real 2026-07-31 shape — a PRE-cutover window, where the legacy class is non-empty. */
  const pre = {
    ...post,
    externalGenuine: { total: 0, free: 0, paid: 0, sessions: 0, freeSessions: 0, paidSessions: 0 },
    externalAutomated: { total: 2955, sessions: 6 },
    tgBot: { ...post.tgBot, calls_total: 125 },
    callClasses: { billable: 132, freeHold: 2819, unmetered: 4, unclassified: 0, billableSessions: 4, last7d: { billable: 300, freeHold: 9000 } },
  };

  it('post-cutover: the class block is exactly metered · unmetered · internal', () => {
    const lines = formatAgentActivity(post).split('\n');
    expect(lines[0]).toBe('🤖 *Agent Activity (24h)*');
    expect(lines[1]).toBe('• Total Agent Calls: 616');
    expect(lines[2]).toBe('• 💰 Metered calls — Last 24h: 363   (6 sessions)');
    expect(lines[3]).toBe('• 🔎 Unmetered (rate-limited) — Last 24h: 0');
    expect(lines[4]).toBe('• 🔁 Internal (algovault-bot) — Last 24h: 253');
    expect(lines[5]).toBe('• 🟢 Recognized clients: 357');
  });

  it('post-cutover: the body asserts nothing about HOLD being free', () => {
    const out = formatAgentActivity(post);
    // The exact strings this wave retired, plus the claim in general.
    expect(out).not.toContain('Free-by-design');
    expect(out).not.toContain('incl. free HOLD');
    expect(out).not.toMatch(/HOLDs?\b[^\n]{0,40}?\b(?:free|unbilled|not charged)\b/i);
    expect(out).not.toMatch(/\bfree\b[^\n]{0,20}?HOLD/i);
    // ...and the bucket is not rendered as a permanent zero under any label.
    expect(out).not.toContain('Unbilled HOLD');
  });

  it('the rendered buckets sum to the rendered headline (post-cutover)', () => {
    const { total, buckets, sum } = partitionOf(formatAgentActivity(post));
    expect(buckets.length, 'no buckets parsed — the assertion would be vacuous').toBeGreaterThanOrEqual(3);
    expect(total).toBe(616);
    expect(sum).toBe(total);
  });

  it('the rendered buckets sum to the rendered headline (pre-cutover, legacy line present)', () => {
    const out = formatAgentActivity(pre);
    // The historical dimension is NOT deleted — it renders, date-bounded, when non-empty.
    expect(out).toContain(`• 🗄 Unbilled HOLD (pre-${FLAT_BILLING_CUTOVER_DATE}, legacy) — Last 24h: 2819`);
    const { total, buckets, sum } = partitionOf(out);
    expect(buckets.length).toBe(4); // metered · unmetered · internal · legacy
    expect(total).toBe(3080);
    expect(sum).toBe(total); // 132 + 4 + 125 + 2819
  });

  it('every rendered class label comes from BILLING_CLASS_LABELS, none hand-typed', () => {
    const known = new Set(Object.keys(BILLING_CLASS_LABELS).map((k) => classLabel(k as keyof typeof BILLING_CLASS_LABELS)));
    expect(known.size).toBe(5); // vacuity guard
    for (const body of [formatAgentActivity(post), formatAgentActivity(pre)]) {
      for (const b of partitionOf(body).buckets) {
        expect(known, `"${b.label}" is not a BILLING_CLASS_LABELS string`).toContain(b.label);
      }
    }
  });

  it('surfaces a non-zero unclassified remainder instead of hiding it, and keeps the sum exact', () => {
    // Take the 7 out of billable so the class decomposition still totals the external count.
    const out = formatAgentActivity({ ...post, callClasses: { ...post.callClasses, billable: 356, unclassified: 7 } });
    expect(out).toContain('• ❓ Unclassified — Last 24h: 7');
    const { total, sum } = partitionOf(out);
    expect(sum).toBe(total);
  });

  it('omits the unclassified line when zero (no noise on the healthy path)', () => {
    expect(formatAgentActivity(post)).not.toContain('Unclassified');
  });

  it('degrades to the EXACT prior layout when callClasses is absent (rollout window)', () => {
    const { callClasses: _omitted, ...legacy } = post;
    const out = formatAgentActivity(legacy);
    expect(out).not.toContain('Metered calls');
    expect(out).not.toContain('Free-by-design');
    expect(out.split('\n')[1]).toBe('• Total Agent Calls: 616');
  });

  it('says "top client", not "top IP" — the concentration is session-grouped', () => {
    const out = formatAgentActivity(post);
    expect(out).toContain('(top client 91.6%)');
    expect(out).not.toContain('top IP');
  });
});

/**
 * AC3 — the property the 2026-08-09 `534` violated, pinned so a stale artifact cannot re-assert
 * it silently. Root cause was NOT a second derivation: the digest fired at 08:00 UTC on the
 * image built from `f8158f0`, which predates the cutover commit `b85d86f`; that reached prod at
 * 08:32:17 UTC, 32 minutes later. The predicate below was already correct — nothing here fixes
 * it, it makes the correctness ASSERTED rather than incidental.
 */
describe('post-cutover windows contain ZERO free_hold — the 534 property', () => {
  it('no (legacy tool, HOLD) row written at or after the cutover classifies free_hold', () => {
    // A 24h window whose START is the cutover instant — the tightest window that can still
    // reach it — plus a day later, plus "now".
    const instants = [
      FLAT_BILLING_CUTOVER_MS,
      FLAT_BILLING_CUTOVER_MS + 1,
      FLAT_BILLING_CUTOVER_MS + 24 * 3600_000,
      Date.now(),
    ];
    const verdicts = ['HOLD', 'BUY', 'SELL', null];
    const tools = [...LEGACY_VERDICT_BILLABLE_TOOLS, ...ALWAYS_BILLABLE_TOOLS];
    expect(tools.length, 'empty tool corpus would make this vacuous').toBeGreaterThan(3);
    let checked = 0;
    for (const t of tools) {
      for (const v of verdicts) {
        for (const at of instants) {
          expect(callClassFor(t, v, false, at), `${t}/${v}@${at}`).not.toBe('free_hold');
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  it('the freeHold SQL is bounded ABOVE by the cutover, so a post-cutover window cannot match', () => {
    const p = freeHoldPredicate()!;
    expect(p).not.toBeNull();
    // The bound must be a strict `<` on the row timestamp — a `>=` or a missing clause is what
    // the pre-b85d86f artifact effectively had, and it is what produced the 534.
    expect(p.sql).toContain('"timestamp" < ?');
    expect(p.params[0]).toBe(FLAT_BILLING_CUTOVER_ISO);
    // ...and the same rule the other way: every metered tool is billable after the cutover.
    expect(billablePredicate()!.sql).toContain('"timestamp" >= ?');
  });

  it('the legacy label names the cutover date, derived — never a second literal', () => {
    expect(FLAT_BILLING_CUTOVER_DATE).toBe('2026-08-08');
    expect(BILLING_CLASS_LABELS.free_hold.label).toBe(`Unbilled HOLD (pre-${FLAT_BILLING_CUTOVER_DATE}, legacy)`);
    expect(FLAT_BILLING_CUTOVER_ISO.startsWith(FLAT_BILLING_CUTOVER_DATE)).toBe(true);
  });
});

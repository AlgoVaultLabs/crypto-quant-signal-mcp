/**
 * SUBSCRIBER-ATTRIBUTION-SPINE-W1 — attribution spine unit invariants.
 *
 * C1: channel-derivation map (channel-agnostic: direct / tg_bot / mcp / api by
 *     client_reference_id prefix) + the fail-open capture contract (a capture
 *     error MUST NOT throw on the /signup request path — revenue path is LAW).
 * C2: the conversion-time profiler assembly (channel-resolution order, geo
 *     source, cold-subscribe signal logic, latency) + idempotent upsert shape.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  deriveChannel,
  recordSignupAttribution,
  assembleProfile,
  buildSubscriberProfile,
  toIsoTimestamp,
  aggregateProfiles,
  renderSubscribersAdminHtml,
  normalizeBillingInterval,
  deriveMonthlyRateUsd,
  isPaidPlanId,
  applySubscriptionRecordUpdate,
} from '../src/lib/subscriber-attribution.js';

describe('deriveChannel', () => {
  it('maps direct: prefix to direct', () => {
    expect(deriveChannel('direct:1780796896353:0n031n')).toBe('direct');
  });
  it('maps tg: and tg_bot: prefixes to tg_bot', () => {
    expect(deriveChannel('tg:123:abc')).toBe('tg_bot');
    expect(deriveChannel('tg_bot:123:abc')).toBe('tg_bot');
  });
  it('maps mcp: prefix to mcp', () => {
    expect(deriveChannel('mcp:123:abc')).toBe('mcp');
  });
  it('maps api: prefix to api', () => {
    expect(deriveChannel('api:123:abc')).toBe('api');
  });
  it('returns unknown for an unrecognized prefix or empty id', () => {
    expect(deriveChannel('weird:123')).toBe('unknown');
    expect(deriveChannel('')).toBe('unknown');
  });
  it('falls back to a utm_source hint when the id prefix is unknown', () => {
    expect(deriveChannel('xxx:1', 'tg_bot')).toBe('tg_bot');
    expect(deriveChannel('xxx:1', 'telegram')).toBe('tg_bot');
    expect(deriveChannel('xxx:1', 'mcp_tool')).toBe('mcp');
  });
});

describe('recordSignupAttribution (fail-open)', () => {
  const baseInput = {
    clientReferenceId: 'direct:1:abc',
    utmSource: null, utmMedium: null, utmCampaign: null,
    referrer: null, landingPath: null, tierRequested: 'starter',
    ipHash: 'deadbeef16hex000', userAgent: 'UA/1.0',
  };

  it('does NOT throw when the DB writer throws (fail-open revenue path)', () => {
    const throwingWriter = {
      ensure: () => { throw new Error('schema boom'); },
      run: () => { throw new Error('insert boom'); },
    };
    expect(() => recordSignupAttribution(baseInput, throwingWriter)).not.toThrow();
  });

  it('issues one ON CONFLICT DO NOTHING INSERT with the derived channel on the happy path', () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const writer = {
      ensure: () => {},
      run: (sql: string, ...params: unknown[]) => { calls.push({ sql, params }); },
    };
    recordSignupAttribution(baseInput, writer);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/INSERT INTO signup_attribution/i);
    expect(calls[0].sql).toMatch(/ON CONFLICT \(client_reference_id\) DO NOTHING/i);
    expect(calls[0].params[0]).toBe('direct:1:abc'); // client_reference_id
    expect(calls[0].params[1]).toBe('direct');        // derived channel
  });
});

describe('assembleProfile (C2 conversion-time profiler — pure)', () => {
  const baseSession = {
    id: 'cs_live_x',
    customer: 'cus_X',
    subscription: 'sub_X',
    amount_total: 999,
    currency: 'usd',
    client_reference_id: 'direct:1000:abc',
    customer_details: { email: 'a@b.com', name: 'A B', address: { country: 'US' } },
    metadata: { tier: 'starter' },
    created: 1000,
  };

  it('uses the joined signup_attribution channel and sets attribution_captured=true', () => {
    const p = assembleProfile(baseSession, {
      attribution: { channel: 'tg_bot', created_at: new Date(1000 * 1000).toISOString() },
      convertedAtEpoch: 1046,
    });
    expect(p.channel).toBe('tg_bot');
    expect(p.attributionCaptured).toBe(true);
  });

  it('falls back to deriveChannel when there is no attribution row (attribution_captured=false)', () => {
    const p = assembleProfile(baseSession, { attribution: null, convertedAtEpoch: 1046 });
    expect(p.channel).toBe('direct');
    expect(p.attributionCaptured).toBe(false);
  });

  it('records country_source=card_issuing when a cardCountry is supplied, else billing_address', () => {
    const card = assembleProfile(baseSession, { cardCountry: 'GB', convertedAtEpoch: 1046 });
    expect(card.country).toBe('GB');
    expect(card.countrySource).toBe('card_issuing');
    const billing = assembleProfile(baseSession, { convertedAtEpoch: 1046 });
    expect(billing.country).toBe('US');
    expect(billing.countrySource).toBe('billing_address');
  });

  it('cold_subscribe = true when email present + no optin + no upgrade CTA; null when email missing', () => {
    expect(assembleProfile(baseSession, { hasOptin: false, hasUpgradeCta: false, convertedAtEpoch: 1046 }).coldSubscribe).toBe(true);
    expect(assembleProfile(baseSession, { hasOptin: true, hasUpgradeCta: false, convertedAtEpoch: 1046 }).coldSubscribe).toBe(false);
    expect(assembleProfile(baseSession, { hasOptin: false, hasUpgradeCta: true, convertedAtEpoch: 1046 }).coldSubscribe).toBe(false);
    const noEmail = assembleProfile(
      { ...baseSession, customer_details: { address: { country: 'US' } } },
      { hasOptin: false, hasUpgradeCta: false, convertedAtEpoch: 1046 },
    );
    expect(noEmail.coldSubscribe).toBeNull();
  });

  it('latency_seconds = converted − signup_at when present, else converted − session.created (clamped ≥0)', () => {
    const withAttr = assembleProfile(baseSession, {
      attribution: { channel: 'direct', created_at: new Date(1000 * 1000).toISOString() },
      convertedAtEpoch: 1046,
    });
    expect(withAttr.latencySeconds).toBe(46);
    const noAttr = assembleProfile(baseSession, { convertedAtEpoch: 1046 }); // session.created = 1000
    expect(noAttr.latencySeconds).toBe(46);
  });

  it('maps amount_total cents to amount_usd and carries ids/tier', () => {
    const p = assembleProfile(baseSession, { convertedAtEpoch: 1046 });
    expect(p.amountUsd).toBe(9.99);
    expect(p.customerId).toBe('cus_X');
    expect(p.subscriptionId).toBe('sub_X');
    expect(p.tier).toBe('starter');
    expect(p.email).toBe('a@b.com');
  });
});

describe('buildSubscriberProfile (C2 — idempotent upsert + fail-open)', () => {
  const session = {
    id: 'cs_live_x', customer: 'cus_X', subscription: 'sub_X',
    amount_total: 999, currency: 'usd', client_reference_id: 'direct:1000:abc',
    customer_details: { email: 'a@b.com', name: 'A B', address: { country: 'US' } },
    metadata: { tier: 'starter' }, created: 1000,
  };

  it('upserts ON CONFLICT (customer_id) DO UPDATE exactly once', async () => {
    const runs: Array<{ sql: string; params: unknown[] }> = [];
    await buildSubscriberProfile(session, {
      ensure: () => {},
      query: async () => [],            // no attribution / optin / cta rows
      run: (sql: string, ...params: unknown[]) => { runs.push({ sql, params }); },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].sql).toMatch(/INSERT INTO subscriber_profiles/i);
    expect(runs[0].sql).toMatch(/ON CONFLICT \(customer_id\) DO UPDATE/i);
    expect(runs[0].params[0]).toBe('cus_X'); // customer_id PK
  });

  it('does NOT throw / does NOT write when the customer id is missing (fail-open)', async () => {
    const runs: unknown[] = [];
    await expect(buildSubscriberProfile(
      { ...session, customer: null },
      { ensure: () => {}, query: async () => [], run: (...a: unknown[]) => { runs.push(a); } },
    )).resolves.toBeUndefined();
    expect(runs).toHaveLength(0);
  });

  it('does NOT throw when a dependency throws (fail-open webhook path)', async () => {
    await expect(buildSubscriberProfile(session, {
      ensure: () => { throw new Error('schema boom'); },
      query: async () => { throw new Error('query boom'); },
      run: () => { throw new Error('upsert boom'); },
    })).resolves.toBeUndefined();
  });
});

describe('aggregateProfiles (C3 admin aggregate — pure)', () => {
  const rows = [
    { channel: 'direct', country: 'US', cold_subscribe: true },
    { channel: 'direct', country: 'GB', cold_subscribe: false },
    { channel: 'tg_bot', country: 'US', cold_subscribe: null },
  ];
  it('counts by channel, by country, and cold / warm / unknown', () => {
    const a = aggregateProfiles(rows);
    expect(a.total).toBe(3);
    expect(a.byChannel.direct).toBe(2);
    expect(a.byChannel.tg_bot).toBe(1);
    expect(a.byCountry.US).toBe(2);
    expect(a.byCountry.GB).toBe(1);
    expect(a.cold).toBe(1);
    expect(a.warm).toBe(1);
    expect(a.coldUnknown).toBe(1);
  });
  it('handles an empty list', () => {
    const a = aggregateProfiles([]);
    expect(a.total).toBe(0);
    expect(a.cold).toBe(0);
    expect(Object.keys(a.byChannel)).toHaveLength(0);
  });
});

describe('renderSubscribersAdminHtml (C3 shell — NO PII pre-auth)', () => {
  it('returns an HTML shell that carries no PII and never puts the key in a URL', () => {
    const html = renderSubscribersAdminHtml();
    expect(html).toMatch(/<!DOCTYPE html>/i);
    // shell fetches the gated JSON route with a Bearer header (not a query key)
    expect(html).toContain('/api/admin/subscribers');
    expect(html).toMatch(/Authorization/);
    expect(html).toMatch(/sessionStorage/);
    // the static shell embeds no subscriber PII
    expect(html).not.toMatch(/lisandy/i);
    expect(html).not.toMatch(/@gmail/i);
    expect(html).not.toContain('cus_UepU');
    // key must never be appended to a URL
    expect(html).not.toMatch(/\?key=/);
  });
});

/**
 * REVENUE-METER-TRUTH-W5 CH4 — the 58-day silent outage.
 *
 * `signup_at` is `timestamptz`. Its value is read out of `signup_attribution.created_at` and bound
 * straight back in. **node-pg returns a `timestamptz` column as a JS `Date`**, and the old code did
 * `String(rows[0].created_at)` → `"Sun Jul 26 2026 11:46:33 GMT+0000 (Coordinated Universal Time)"`,
 * which Postgres rejects with SQLSTATE 22007. The PG write path is fire-and-forget, so the rejection
 * reached no `catch` and the caller logged SUCCESS for a row that was never written.
 *
 * 🛑 **The defect lived exactly in this file's seam.** Every existing test hand-feeds
 * `.toISOString()` — the one form production never produces — and the `buildSubscriberProfile` tests
 * stub `query: async () => []`, so the attribution branch never ran at all. 100% of production
 * writes were lost with every assertion green. These tests drive a real `Date` through that seam.
 */
describe('toIsoTimestamp — the 22007 guard (CH4)', () => {
  it('converts a node-pg Date to ISO — never String(Date)', () => {
    const d = new Date('2026-07-26T11:46:33.000Z');
    expect(toIsoTimestamp(d)).toBe('2026-07-26T11:46:33.000Z');
    // The exact production poison, asserted as an inequality so the intent is unmissable.
    expect(toIsoTimestamp(d)).not.toBe(String(d));
    // Why PG rejects String(Date): the trailing `GMT±HHMM (Zone Name)` is unparseable as timestamptz.
    // Asserted STRUCTURALLY rather than by the zone's words — String(Date) renders in the HOST's
    // timezone, so the prod container (UTC) yields "(Coordinated Universal Time)" while a dev box on
    // GMT+0800 yields "(Malaysia Time)". A literal-text assertion passes on prod and fails on a laptop.
    expect(String(d)).toMatch(/GMT[+-]\d{4} \(.+\)$/);
    expect(toIsoTimestamp(d)).not.toMatch(/GMT/);
  });

  it('passes a SQLite TEXT timestamp through UNCHANGED — re-serialising would shift it', () => {
    // better-sqlite3 returns what datetime('now') stored: UTC, no zone marker. Node parses that as
    // LOCAL time, so a "helpful" new Date(s).toISOString() here would silently shift every SQLite
    // timestamp by the host's UTC offset. A Date is the only broken case; strings are already fine.
    expect(toIsoTimestamp('2026-07-26 11:46:33')).toBe('2026-07-26 11:46:33');
    expect(toIsoTimestamp('2026-07-26T11:46:33.000Z')).toBe('2026-07-26T11:46:33.000Z');
  });

  it('degrades an absent or invalid timestamp to null rather than to a bad bind', () => {
    expect(toIsoTimestamp(null)).toBeNull();
    expect(toIsoTimestamp(undefined)).toBeNull();
    expect(toIsoTimestamp('')).toBeNull();
    expect(toIsoTimestamp(new Date('nonsense'))).toBeNull(); // Invalid Date, not "Invalid Date"
  });
});

describe('buildSubscriberProfile — binds a PG Date safely (CH4)', () => {
  const SIGNUP = new Date('2026-07-26T11:46:33.000Z');

  /** A seam that returns what node-pg actually returns: a Date, not a string. */
  function pgLikeDeps(runs: Array<{ sql: string; params: unknown[] }>) {
    return {
      ensure: () => {},
      query: async (sql: string) => (
        sql.includes('FROM signup_attribution')
          ? [{ channel: 'tg_bot', created_at: SIGNUP }] as never[]   // <- a real Date
          : [] as never[]
      ),
      run: (sql: string, ...params: unknown[]) => { runs.push({ sql, params }); },
      nowEpoch: Math.floor(SIGNUP.getTime() / 1000) + 128,
    };
  }

  it('binds signup_at as an ISO string Postgres can parse, not String(Date)', async () => {
    const runs: Array<{ sql: string; params: unknown[] }> = [];
    await buildSubscriberProfile(
      { customer: 'cus_ch4', client_reference_id: 'tg_bot:1:abc', metadata: { tier: 'starter' }, created: 1 },
      pgLikeDeps(runs) as never,
    );
    expect(runs).toHaveLength(1);
    const signupAt = runs[0].params[12]; // param #13 — the signup_at column
    expect(typeof signupAt).toBe('string');
    // THE assertion. The old code produced the Date's toString(), which PG answers with 22007.
    expect(signupAt).toBe('2026-07-26T11:46:33.000Z');
    expect(String(signupAt)).not.toContain('Coordinated Universal Time');
    expect(String(signupAt)).not.toContain('GMT');
    // A bind Postgres accepts must round-trip through Date without losing the instant.
    expect(new Date(signupAt as string).getTime()).toBe(SIGNUP.getTime());
  });

  it('still records the attribution channel and a sane latency from that Date', async () => {
    const runs: Array<{ sql: string; params: unknown[] }> = [];
    await buildSubscriberProfile(
      { customer: 'cus_ch4b', client_reference_id: 'tg_bot:1:abc', metadata: { tier: 'starter' }, created: 1 },
      pgLikeDeps(runs) as never,
    );
    expect(runs[0].params[8]).toBe('tg_bot');   // channel
    expect(runs[0].params[14]).toBe(128);       // latency_seconds = convertedAt - signupAt
    expect(runs[0].params[16]).toBe(true);      // attribution_captured
  });
});

// ── OPS-STRIPE-SUBSCRIPTION-TRUTH-W1 · CH2 — the record gains a period ───────────────────────
//
// `amount_usd` stores the CHARGE. An annual Starter writes $79 once and nothing for eleven
// months, so that row is byte-indistinguishable from a hypothetical $79 monthly charge —
// **a stored amount without a period is not a rate**, and no MRR is derivable without the
// cadence. These pin the cadence's default-deny and the rate's refusal semantics.

describe('normalizeBillingInterval — default-DENY, never a guess', () => {
  it('accepts exactly the two real cadences', () => {
    expect(normalizeBillingInterval('month')).toBe('month');
    expect(normalizeBillingInterval('year')).toBe('year');
  });

  it('🛑 answers unknown for anything else — an absent cadence is NEVER defaulted to month', () => {
    // Three of the four live rows would in fact be correct as `month`, which is exactly the
    // trap: a guessed default makes the composition check pass on a fiction, and an annual
    // Starter's $6.58 vs a monthly Starter's $9.99 is a wrong MRR that looks plausible.
    for (const v of [undefined, null, '', 'monthly', 'MONTH', 'yearly', 'annual', 0, 1, {}, []]) {
      expect(normalizeBillingInterval(v)).toBe('unknown');
    }
  });
});

describe('deriveMonthlyRateUsd — projects the PLANS derivation, never the charge', () => {
  it('derives the monthly price for a monthly subscription', () => {
    expect(deriveMonthlyRateUsd('starter', 'month')).toBe(9.99);
    expect(deriveMonthlyRateUsd('pro', 'month')).toBe(49);
  });

  it('derives the annual rate for an annual subscription', () => {
    expect(deriveMonthlyRateUsd('starter', 'year')).toBe(79 / 12);
    expect(deriveMonthlyRateUsd('pro', 'year')).toBe(299 / 12);
  });

  it('🛑 REFUSES on an unknown cadence — null, not a monthly guess', () => {
    expect(deriveMonthlyRateUsd('starter', 'unknown')).toBeNull();
    expect(deriveMonthlyRateUsd('pro', 'unknown')).toBeNull();
  });

  it('🛑 REFUSES for a tier the ladder does not price, and for Enterprise annual', () => {
    expect(deriveMonthlyRateUsd('enterprise', 'year')).toBeNull(); // sold monthly-only
    expect(deriveMonthlyRateUsd('platinum', 'month')).toBeNull();  // not a plan
    expect(deriveMonthlyRateUsd(null, 'month')).toBeNull();
    expect(deriveMonthlyRateUsd(undefined, 'year')).toBeNull();
  });

  it('null is a REFUSAL, not a zero — MRR must exclude it rather than add 0', () => {
    expect(deriveMonthlyRateUsd('starter', 'unknown')).not.toBe(0);
  });

  it('is NOT arithmetic on the charge — a $79 annual and a $79 monthly differ by cadence alone', () => {
    // The two cases the table could not previously tell apart now resolve to different rates
    // from the SAME stored amount.
    expect(deriveMonthlyRateUsd('starter', 'year')).toBeCloseTo(6.5833, 4);
    expect(deriveMonthlyRateUsd('starter', 'month')).toBe(9.99);
  });
});

describe('isPaidPlanId', () => {
  it('recognises exactly the three ladder tiers', () => {
    expect(isPaidPlanId('starter')).toBe(true);
    expect(isPaidPlanId('pro')).toBe(true);
    expect(isPaidPlanId('enterprise')).toBe(true);
  });
  it('rejects anything else, including inherited Object properties', () => {
    for (const v of ['free', 'x402', '', null, undefined, 42, 'toString', 'constructor']) {
      expect(isPaidPlanId(v)).toBe(false);
    }
  });
});

describe('assembleProfile — cadence + rate ride the session, and amount_usd is untouched', () => {
  const base = {
    customer: 'cus_iv',
    amount_total: 7900,
    currency: 'usd',
    customer_details: { email: 'a@b.co' },
  };
  const signals = { convertedAtEpoch: 1_800_000_000 };

  it('reads the cadence the checkout DECLARED (metadata.billing_interval)', () => {
    const p = assembleProfile({ ...base, metadata: { tier: 'starter', billing_interval: 'year' } }, signals);
    expect(p.billingInterval).toBe('year');
    expect(p.monthlyRateUsd).toBe(79 / 12);
  });

  it('🛑 records the CHARGE unchanged alongside the rate — add before you remove', () => {
    const p = assembleProfile({ ...base, metadata: { tier: 'starter', billing_interval: 'year' } }, signals);
    // $79 changed hands on one date. That fact survives; the rate is derived BESIDE it.
    expect(p.amountUsd).toBe(79);
    expect(p.monthlyRateUsd).not.toBe(p.amountUsd);
  });

  it('answers unknown / null for the pre-annual cohort that carries no cadence', () => {
    const p = assembleProfile({ ...base, metadata: { tier: 'starter' } }, signals);
    expect(p.billingInterval).toBe('unknown');
    expect(p.monthlyRateUsd).toBeNull();
  });

  it('a monthly checkout derives the monthly price', () => {
    const p = assembleProfile(
      { ...base, amount_total: 999, metadata: { tier: 'starter', billing_interval: 'month' } },
      signals,
    );
    expect(p.billingInterval).toBe('month');
    expect(p.amountUsd).toBe(9.99);
    expect(p.monthlyRateUsd).toBe(9.99);
  });
});

describe('buildSubscriberProfile — the upsert carries the two new columns', () => {
  const session = {
    customer: 'cus_iv2',
    amount_total: 7900,
    currency: 'usd',
    customer_details: { email: 'a@b.co' },
    metadata: { tier: 'starter', billing_interval: 'year' },
  };

  it('writes billing_interval + monthly_rate_usd, and updates them ON CONFLICT', async () => {
    const runs: Array<{ sql: string; params: unknown[] }> = [];
    await buildSubscriberProfile(session, {
      ensure: () => {},
      query: async () => [],
      run: (sql: string, ...params: unknown[]) => { runs.push({ sql, params }); },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].sql).toMatch(/billing_interval,\s*monthly_rate_usd/);
    expect(runs[0].sql).toMatch(/billing_interval = EXCLUDED\.billing_interval/);
    expect(runs[0].sql).toMatch(/monthly_rate_usd = EXCLUDED\.monthly_rate_usd/);
    // Bound after the five bridge params — order is the contract with the column list.
    // PAY-UNIONPAY-ATTRIBUTION-W1 appended 4 payment-method binds AFTER these two, so they are
    // no longer the tail. Indexed from the FRONT now: a `.at(-2)` here would silently re-point
    // at whichever columns a future wave appends, and keep passing while asserting the wrong
    // thing — the same false-green shape this file's arity test exists to prevent.
    expect(runs[0].params[23]).toBe('year');          // billing_interval
    expect(runs[0].params[24]).toBe(79 / 12);         // monthly_rate_usd
    // ...and the 4 appended payment-method binds are the new tail. No `resolvePaymentMethod`
    // dep is injected here, so all four are NULL — unresolved is never defaulted.
    expect(runs[0].params.slice(25)).toEqual([null, null, null, null]);
  });

  it('binds a placeholder for every column in the list — no silent arity drift', () => {
    // A column-list / VALUES / params mismatch is the shape that silently corrupts an upsert.
    const runs: Array<{ sql: string; params: unknown[] }> = [];
    return buildSubscriberProfile(session, {
      ensure: () => {},
      query: async () => [],
      run: (sql: string, ...params: unknown[]) => { runs.push({ sql, params }); },
    }).then(() => {
      const sql = runs[0].sql;
      const columnList = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')'));
      const columns = columnList.split(',').length;
      const placeholders = (sql.slice(sql.indexOf('VALUES')).match(/\?/g) ?? []).length;
      expect(columns).toBe(placeholders);
      expect(runs[0].params).toHaveLength(columns);
    });
  });
});

// ── OPS-STRIPE-SUBSCRIPTION-TRUTH-W2 · CH2 — the lifecycle reaches the record ────────────────
//
// subscriber_profiles was written once, at checkout, and never again: an upgrade Stripe billed
// never arrived (one customer read starter/$9.99 while paying $49) and a cancellation would have
// left status reading 'active' forever. The first under-reports MRR, the second over-reports it.

/** Minimal in-memory stand-in for the awaited `query` seam: one profile row, SELECT + UPDATE. */
function recordDeps(row: Record<string, unknown> | null) {
  const state = row ? { ...row } : null;
  const seen: string[] = [];
  const deps = {
    ensure: () => {},
    ensureInterval: async () => {},
    run: () => { throw new Error('applySubscriptionRecordUpdate must not use the fire-and-forget run seam'); },
    query: async (sql: string, params: unknown[] = []) => {
      seen.push(sql.trim().split(/\s+/)[0].toUpperCase());
      if (/^\s*SELECT/i.test(sql)) return state ? [{ ...state }] : [];
      if (/^\s*UPDATE/i.test(sql)) {
        if (state) {
          const [tier, status, interval, rate] = params as [string, string, string, number | null];
          Object.assign(state, { tier, status, billing_interval: interval, monthly_rate_usd: rate });
        }
        return [];
      }
      return [];
    },
  };
  return { deps, state: () => state, seen };
}

describe('applySubscriptionRecordUpdate — the tier/interval/status writer', () => {
  it('2.1 a tier change lands and is READ BACK before success is claimed', async () => {
    const h = recordDeps({ tier: 'starter', status: 'active', billing_interval: 'month' });
    const out = await applySubscriptionRecordUpdate(
      { customerId: 'cus_up', tier: 'pro', billingInterval: 'month', status: 'active' },
      h.deps as never,
    );
    expect(out).toBe('updated');
    expect(h.state()).toMatchObject({ tier: 'pro', billing_interval: 'month' });
    // The rate is re-derived from the NEW pair, not carried by the event.
    expect(h.state()!.monthly_rate_usd).toBe(49);
    // SELECT → UPDATE → SELECT: the trailing read-back is the verify-by-RESULT step.
    expect(h.seen).toEqual(['SELECT', 'UPDATE', 'SELECT']);
  });

  it('2.2 an interval change month→year is DETECTED, not a no-op, and re-rates', async () => {
    const h = recordDeps({ tier: 'starter', status: 'active', billing_interval: 'month' });
    const out = await applySubscriptionRecordUpdate(
      { customerId: 'cus_iv', tier: 'starter', billingInterval: 'year', status: 'active' },
      h.deps as never,
    );
    expect(out).toBe('updated');
    expect(h.state()!.billing_interval).toBe('year');
    expect(h.state()!.monthly_rate_usd).toBe(79 / 12); // $9.99 → $6.58 effective
  });

  it('2.4 a non-tier, non-interval update does NOT churn the profile', async () => {
    // .updated fires on trials, payment-method changes, metadata edits, cancel-at-period-end.
    const h = recordDeps({ tier: 'pro', status: 'active', billing_interval: 'month' });
    const out = await applySubscriptionRecordUpdate(
      { customerId: 'cus_noise', tier: 'pro', billingInterval: 'month', status: 'active' },
      h.deps as never,
    );
    expect(out).toBe('noop');
    expect(h.seen).toEqual(['SELECT']); // no UPDATE was ever issued
  });

  it('2.5 a cancellation flips status away from active — FORWARD GUARD, no backfill', async () => {
    const h = recordDeps({ tier: 'pro', status: 'active', billing_interval: 'month' });
    const out = await applySubscriptionRecordUpdate(
      { customerId: 'cus_gone', status: 'canceled' }, h.deps as never,
    );
    expect(out).toBe('updated');
    expect(h.state()!.status).toBe('canceled');
    // Tier and interval are untouched — the event says nothing about them.
    expect(h.state()).toMatchObject({ tier: 'pro', billing_interval: 'month' });
  });

  it('🛑 NEVER inserts — an absent profile is a FACT, not a row to invent', async () => {
    // A lifecycle event carries no channel/country/cold/latency/bridge signals, so minting a
    // profile here would fabricate every attribution column on it.
    const h = recordDeps(null);
    const out = await applySubscriptionRecordUpdate(
      { customerId: 'cus_ghost', tier: 'pro', billingInterval: 'month' }, h.deps as never,
    );
    expect(out).toBe('absent');
    expect(h.seen).toEqual(['SELECT']);
  });

  it('🛑 a write that did not LAND reports noop, never a false success', async () => {
    // The SEC-14 hazard: dbRun is fire-and-forget on PG, so a lost write once rendered as
    // success with every assertion green. The read-back is what refuses that.
    const h = recordDeps({ tier: 'starter', status: 'active', billing_interval: 'month' });
    const swallow = { ...h.deps, query: async (sql: string) => (/^\s*SELECT/i.test(sql)
      ? [{ tier: 'starter', status: 'active', billing_interval: 'month' }] : []) };
    const out = await applySubscriptionRecordUpdate(
      { customerId: 'cus_lost', tier: 'pro', billingInterval: 'month' }, swallow as never,
    );
    expect(out).toBe('noop');
  });

  it('an unknown interval yields a NULL rate, never a guessed month', async () => {
    const h = recordDeps({ tier: 'starter', status: 'active', billing_interval: 'unknown' });
    await applySubscriptionRecordUpdate({ customerId: 'cus_u', tier: 'pro' }, h.deps as never);
    expect(h.state()!.billing_interval).toBe('unknown');
    expect(h.state()!.monthly_rate_usd).toBeNull();
  });
});

describe('2.3 the webhook case claims BEFORE the side-effect (structural)', () => {
  const src = readFileSync(path.resolve(process.cwd(), 'src/index.ts'), 'utf8');
  const block = src.slice(src.indexOf("case 'customer.subscription.updated'"));
  const body = block.slice(0, block.indexOf('\n        }'));

  it('exists as exactly ONE case in the switch', () => {
    expect((src.match(/case 'customer\.subscription\.updated'/g) ?? []).length).toBe(1);
  });

  it('calls tryClaimEvent BEFORE handleSubscriptionUpdated — order is the contract', () => {
    const claim = body.indexOf('tryClaimEvent');
    const handle = body.indexOf('handleSubscriptionUpdated');
    expect(claim).toBeGreaterThan(-1);
    expect(handle).toBeGreaterThan(-1);
    expect(claim).toBeLessThan(handle); // Stripe delivers at-least-once
  });

  it('answers a duplicate with 200, never a non-2xx that makes Stripe retry harder', () => {
    expect(body).toMatch(/status: 'duplicate'/);
    expect(body).not.toMatch(/status\(5\d\d\)/);
  });
});

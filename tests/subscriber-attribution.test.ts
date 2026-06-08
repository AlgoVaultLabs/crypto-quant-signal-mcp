/**
 * SUBSCRIBER-ATTRIBUTION-SPINE-W1 — attribution spine unit invariants.
 *
 * C1: channel-derivation map (channel-agnostic: direct / tg_bot / mcp / api by
 *     client_reference_id prefix) + the fail-open capture contract (a capture
 *     error MUST NOT throw on the /signup request path — revenue path is LAW).
 * C2: the conversion-time profiler assembly (channel-resolution order, geo
 *     source, cold-subscribe signal logic, latency) + idempotent upsert shape.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveChannel,
  recordSignupAttribution,
  assembleProfile,
  buildSubscriberProfile,
  aggregateProfiles,
  renderSubscribersAdminHtml,
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

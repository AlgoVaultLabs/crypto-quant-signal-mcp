/**
 * OPS-A2MCP-SERVED-TRUTH-W1 CH1 R2 — the drift canary's leg B (x402 price) and leg C (declared vs
 * served) classifiers, driven row by row and in both directions.
 *
 * Leg C exists because `/a2mcp/*` answered 404 for weeks while `/capabilities` declared
 * `a2mcp: true` and nothing compared the two. Leg B is here because it shares leg C's decoder and
 * because, before this wave, it read only the x402 v1 field (`maxAmountRequired`): prod serves v2
 * (`amount`), so the price comparison never ran and the leg could not fail.
 *
 * Fixtures are shaped like what prod actually returns (an x402 v2 body with two accepts[] entries,
 * Base + OP, plus the base64 `payment-required` header), not hand-simplified, so a decoder that
 * only handles a toy shape cannot pass.
 */
import { describe, it, expect } from 'vitest';
import {
  decodeX402Challenge,
  acceptsEntryAtomic,
  evaluateLegBRoute,
  legBVerdict,
  classifyLegC,
  firstDeclaredCanonical,
  LEG_C_RAILS,
  LEG_C_STUCK_MS,
} from '../../scripts/check-feature-registry-drift.mjs';

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** A v2 challenge as served by /x402/<tool> (two rails: Base CDP + OP Circle Gateway). */
function v2Body(atomic: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    x402Version: 2,
    error: 'Payment Required',
    ...extra,
    resource: { url: 'https://api.algovault.com/x402/get_trade_call', mimeType: 'application/json' },
    accepts: [
      { scheme: 'exact', network: 'eip155:8453', amount: atomic, asset: BASE_USDC, payTo: '0x1', maxTimeoutSeconds: 300 },
      { scheme: 'exact', network: 'eip155:10', amount: atomic, asset: '0x2', payTo: '0x3', maxTimeoutSeconds: 300 },
    ],
  };
}
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64');

// ─────────────────────────────── the shared decoder ───────────────────────────────
describe('decodeX402Challenge — one parser for legs B and C', () => {
  it('decodes a v2 body', () => {
    const ch = decodeX402Challenge(JSON.stringify(v2Body('20000')), null);
    expect(ch?.x402Version).toBe(2);
    expect(ch?.accepts).toHaveLength(2);
    expect(ch?.body).not.toBeNull();
    expect(ch?.stub).toBe(false);
  });

  it('decodes a v1 body', () => {
    const v1 = { x402Version: 1, accepts: [{ scheme: 'exact', network: 'base', maxAmountRequired: '20000' }] };
    expect(decodeX402Challenge(JSON.stringify(v1), null)?.x402Version).toBe(1);
  });

  it('falls back to the base64 payment-required header when the body is not a challenge', () => {
    const ch = decodeX402Challenge('<html>nope</html>', b64(v2Body('20000')));
    expect(ch?.body).toBeNull();
    expect(ch?.header).not.toBeNull();
    expect(ch?.accepts).toHaveLength(2);
  });

  it('returns null when neither body nor header decodes', () => {
    expect(decodeX402Challenge('not json', 'not base64 json')).toBeNull();
    expect(decodeX402Challenge('{"x402Version":3,"accepts":[]}', null)).toBeNull(); // unknown version
    expect(decodeX402Challenge('{"x402Version":2}', null)).toBeNull(); // no accepts[]
    expect(decodeX402Challenge('', null)).toBeNull();
  });

  it('flags the [STUB] marker in the body or the header', () => {
    expect(decodeX402Challenge(JSON.stringify(v2Body('20000', { _stub: true })), null)?.stub).toBe(true);
    expect(decodeX402Challenge('', b64(v2Body('20000', { _stub: true })))?.stub).toBe(true);
  });
});

describe('acceptsEntryAtomic — amount (v2) ?? maxAmountRequired (v1)', () => {
  it('reads v2 `amount`, v1 `maxAmountRequired`, and prefers `amount` when both exist', () => {
    expect(acceptsEntryAtomic({ amount: '20000' })).toBe('20000');
    expect(acceptsEntryAtomic({ maxAmountRequired: '10000' })).toBe('10000');
    expect(acceptsEntryAtomic({ amount: '20000', maxAmountRequired: '99' })).toBe('20000');
    expect(acceptsEntryAtomic({ amount: 20000 })).toBe('20000');
  });

  it('refuses anything that is not a non-negative integer of atomic units', () => {
    for (const bad of [{}, { amount: '0.02' }, { amount: '0x4e20' }, { amount: '' }, { amount: -1 }, { amount: 1.5 }, null]) {
      expect(acceptsEntryAtomic(bad)).toBeNull();
    }
  });
});

// ─────────────────────────────── leg B ───────────────────────────────
describe('evaluateLegBRoute — price parity on EVERY accepts[] entry', () => {
  const route = (bodyText: string, status = 402, header: string | null = null, expectedUsd = 0.02) =>
    evaluateLegBRoute({ name: 'get_trade_call', status, bodyText, paymentRequiredHeader: header, expectedUsd });

  it('v2 fixture at the registry price → compared, no drift (the prod shape)', () => {
    const out = route(JSON.stringify(v2Body('20000')));
    expect(out).toEqual({ kind: 'compared', drifts: [] });
  });

  it('amount off by ONE atomic unit → drift naming the network', () => {
    const out = route(JSON.stringify(v2Body('20001')));
    expect(out.kind).toBe('compared');
    expect(out.drifts).toHaveLength(2);
    expect(out.drifts[0]).toContain('eip155:8453');
  });

  it('checks every entry, not only accepts[0]: a mismatch on the SECOND rail alone is caught', () => {
    const body = v2Body('20000');
    (body.accepts as Array<Record<string, unknown>>)[1].amount = '30000';
    const out = route(JSON.stringify(body));
    expect(out.drifts).toHaveLength(1);
    expect(out.drifts[0]).toContain('eip155:10');
  });

  it('a 402 with NEITHER price field → drift price_field_unreadable', () => {
    const body = v2Body('20000');
    for (const a of body.accepts as Array<Record<string, unknown>>) delete a.amount;
    const out = route(JSON.stringify(body));
    expect(out.kind).toBe('drift');
    expect(out.drifts[0]).toContain('price_field_unreadable');
  });

  it('a 402 that is not a challenge at all → drift price_field_unreadable', () => {
    expect(route('Payment Required').drifts[0]).toContain('price_field_unreadable');
  });

  it('reads the price from the header when the body carries none', () => {
    expect(route('', 402, b64(v2Body('20000')))).toEqual({ kind: 'compared', drifts: [] });
  });

  it('v1 bodies still compare (maxAmountRequired fallback)', () => {
    const v1 = { x402Version: 1, accepts: [{ maxAmountRequired: '10000' }] };
    expect(route(JSON.stringify(v1), 402, null, 0.01)).toEqual({ kind: 'compared', drifts: [] });
  });

  it('pre-wave behaviour kept: 404 skips, any other status is a drift', () => {
    expect(route('', 404).kind).toBe('skip');
    const out = route('', 500);
    expect(out.kind).toBe('drift');
    expect(out.drifts[0]).toBe('/x402/get_trade_call expected 402, got 500');
  });
});

describe('legBVerdict — a pass over zero routes is not a pass', () => {
  it('AGREE / DISAGREE / INDETERMINATE', () => {
    expect(legBVerdict({ compared: 5, disagreements: 0 })).toBe('AGREE');
    expect(legBVerdict({ compared: 5, disagreements: 1 })).toBe('DISAGREE');
    expect(legBVerdict({ compared: 0, disagreements: 1 })).toBe('DISAGREE');
    expect(legBVerdict({ compared: 0, disagreements: 0 })).toBe('INDETERMINATE');
  });
});

// ─────────────────────────────── leg C ───────────────────────────────
describe('classifyLegC — every row of the declared-vs-served table, both directions', () => {
  const NOW = Date.parse('2026-10-13T04:00:00.000Z');
  const c = (o: Record<string, unknown>) => classifyLegC({ nowMs: NOW, ...o });

  it('402 + decodable v2 body, no _stub → AGREE', () => {
    expect(c({ status: 402, bodyText: JSON.stringify(v2Body('20000')) })).toEqual({ token: 'AGREE', reason: 'served_402' });
  });

  it('402 + PAYMENT-REQUIRED header only → AGREE', () => {
    expect(c({ status: 402, bodyText: '', paymentRequiredHeader: b64(v2Body('20000')) }).token).toBe('AGREE');
  });

  it('402 whose body carries _stub: true → DISAGREE stub (a stub mount cannot pass)', () => {
    const stubBody = JSON.stringify(v2Body('20000', { _stub: true }));
    expect(c({ status: 402, bodyText: stubBody })).toEqual({ token: 'DISAGREE', reason: 'stub' });
  });

  it('402 with a v1-only body and no header → INDETERMINATE (not a v2 challenge)', () => {
    const v1 = { x402Version: 1, accepts: [{ maxAmountRequired: '20000' }] };
    expect(c({ status: 402, bodyText: JSON.stringify(v1) })).toEqual({ token: 'INDETERMINATE', reason: 'undecodable_402' });
  });

  it('402 that decodes as nothing → INDETERMINATE', () => {
    expect(c({ status: 402, bodyText: 'Payment Required' }).token).toBe('INDETERMINATE');
  });

  it('404 → DISAGREE not_mounted (THE INCIDENT)', () => {
    expect(c({ status: 404, bodyText: 'Cannot GET /a2mcp/get_trade_call' })).toEqual({ token: 'DISAGREE', reason: 'not_mounted' });
  });

  it('503 + X-Rail-State initializing OLDER than 30 min → DISAGREE stuck_initializing', () => {
    const since = new Date(NOW - LEG_C_STUCK_MS - 1000).toISOString();
    expect(c({ status: 503, railStateHeader: `initializing; since=${since}` })).toEqual({ token: 'DISAGREE', reason: 'stuck_initializing' });
  });

  it('503 + X-Rail-State initializing YOUNGER than 30 min → INDETERMINATE initializing', () => {
    const since = new Date(NOW - LEG_C_STUCK_MS + 60_000).toISOString();
    expect(c({ status: 503, railStateHeader: `initializing; since=${since}` })).toEqual({ token: 'INDETERMINATE', reason: 'initializing' });
  });

  it('503 without (or with an unparseable) X-Rail-State → INDETERMINATE', () => {
    expect(c({ status: 503 }).token).toBe('INDETERMINATE');
    expect(c({ status: 503, railStateHeader: 'initializing; since=yesterday' }).token).toBe('INDETERMINATE');
  });

  it('anything else, a timeout (null status) → INDETERMINATE — never a page on a blip', () => {
    expect(c({ status: 500 })).toEqual({ token: 'INDETERMINATE', reason: 'http_500' });
    expect(c({ status: 200, bodyText: '{}' }).token).toBe('INDETERMINATE');
    expect(c({ status: null })).toEqual({ token: 'INDETERMINATE', reason: 'no_response' });
  });
});

describe('leg C rail selection', () => {
  const caps = [
    { name: 'get_trade_signal', canonical: 'get_trade_call', channels: { httpX402: true, a2mcp: true, acp: true } },
    { name: 'get_trade_call', canonical: 'get_trade_call', channels: { httpX402: true, a2mcp: true, acp: true } },
    { name: 'chat_knowledge', canonical: 'chat_knowledge', channels: { httpX402: false, a2mcp: false, acp: false } },
  ];

  it('probes the CANONICAL route of the first declaring entry (never an alias route)', () => {
    expect(firstDeclaredCanonical(caps, 'a2mcp')).toBe('get_trade_call');
    expect(firstDeclaredCanonical(caps, 'httpX402')).toBe('get_trade_call');
  });

  it('a rail declared on no entry → null (the runner prints NOT_DECLARED)', () => {
    const retired = caps.map((t) => ({ ...t, channels: { ...t.channels, a2mcp: false } }));
    expect(firstDeclaredCanonical(retired, 'a2mcp')).toBeNull();
    expect(firstDeclaredCanonical([], 'a2mcp')).toBeNull();
  });

  it('the rail set is exactly httpX402 · a2mcp · acp, and ACP has no probe route (ruling R-6)', () => {
    expect(LEG_C_RAILS.map((r: { rail: string }) => r.rail)).toEqual(['httpX402', 'a2mcp', 'acp']);
    expect(LEG_C_RAILS.find((r: { rail: string }) => r.rail === 'acp')?.prefix).toBeNull();
  });
});

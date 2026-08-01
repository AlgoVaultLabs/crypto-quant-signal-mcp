/**
 * OPS-AUDIT-REMEDIATION-MEDIUM-W1 / Ch3 — SEC-09: the okx.ai /a2mcp/* input gate.
 *
 * THE DEFECT. Both a2mcp mounts handed `req.body` straight to `callCoreHandler`, which
 * does ZERO validation — only blind casts. The published Zod/JSON-Schema bounds were
 * enforced on `/mcp` and `/x402/*` and skipped here, on a PAID partner surface:
 *
 *   POST /a2mcp/get_market_regime  {"coin":"BTC","timeframe":"7h"}
 *     → /mcp:            Zod enum error
 *     → /x402/*:         400 X402_HTTP_INVALID_INPUT
 *     → /a2mcp/*:        SERVED. getIntervalMs falls back to 4h, but the response echoes
 *                        timeframe:"7h" — a paying customer gets a wrong-but-plausible,
 *                        MISLABELLED verdict.
 *
 * Same class for an uncapped `coin` (forwarded into the venue query string) and for
 * `scan_funding_arb`'s `minSpreadBps`, where a non-number makes `spreadBps < minSpreadBps`
 * NaN-false and disables the spread filter entirely, returning the unfiltered set.
 *
 * These tests target `validateToolInput` — the SHARED gate, extracted from the /x402 route
 * rather than reimplemented, so the two channels cannot drift.
 */
import { describe, it, expect } from 'vitest';
import { validateToolInput, explainDroppedBody } from '../../src/lib/x402-http-routes.js';

const JSON_HEADERS = { 'content-type': 'application/json', 'content-length': '42' };
/** A body the caller genuinely omitted — no content-length, so nothing was dropped. */
const NO_BODY_HEADERS = {};

describe('validateToolInput — schema enforcement (SEC-09)', () => {
  it('THE REGRESSION: an out-of-enum timeframe is REJECTED, not served with a bad label', () => {
    const r = validateToolInput('get_market_regime', { coin: 'BTC', timeframe: '7h' }, JSON_HEADERS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rejection.kind).toBe('invalid_input');
      expect(JSON.stringify(r.rejection)).toContain('timeframe');
    }
  });

  it('accepts a valid body unchanged (no partner-facing regression)', () => {
    const r = validateToolInput('get_market_regime', { coin: 'BTC', timeframe: '4h' }, JSON_HEADERS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.coin).toBe('BTC');
      expect(r.input.timeframe).toBe('4h');
    }
  });

  it('applies schema DEFAULTS so an omitted optional behaves as documented', () => {
    const r = validateToolInput('get_market_regime', { coin: 'ETH' }, NO_BODY_HEADERS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(typeof r.input.timeframe).toBe('string'); // default applied by ajv
  });

  it('rejects an over-long coin (the uncapped-string path into the venue query)', () => {
    const r = validateToolInput('get_market_regime', { coin: 'X'.repeat(500), timeframe: '4h' }, JSON_HEADERS);
    expect(r.ok).toBe(false);
  });

  it('rejects a non-numeric minSpreadBps (which would NaN-disable the spread filter)', () => {
    const r = validateToolInput('scan_funding_arb', { minSpreadBps: 'not-a-number' }, JSON_HEADERS);
    expect(r.ok).toBe(false);
  });
});

describe('validateToolInput — dropped body, checked BEFORE and INDEPENDENTLY of the schema', () => {
  it('THE ALL-OPTIONAL TRAP: an unparsed body on an all-optional schema is REJECTED, not served as defaults-only', () => {
    // scan_funding_arb has no required field, so `{}` validates clean. Without the
    // independent dropped-body check the route would serve a DEFAULTS-ONLY result and,
    // on the x402 twin, CHARGE for it.
    const r = validateToolInput('scan_funding_arb', {}, { 'content-type': 'text/plain', 'content-length': '55' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.kind).toBe('dropped_body');
  });

  it('flags the duplicate content-type shape a real SDK merge produces', () => {
    const r = validateToolInput('scan_funding_arb', {}, {
      'content-type': 'application/json, application/json',
      'content-length': '55',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rejection.kind).toBe('dropped_body');
      if (r.rejection.kind === 'dropped_body') expect(r.rejection.reason).toMatch(/media types/);
    }
  });

  it('a genuinely omitted body is NOT a dropped body (no false rejection)', () => {
    const r = validateToolInput('scan_funding_arb', {}, NO_BODY_HEADERS);
    expect(r.ok).toBe(true);
  });

  it('handles a header array without crashing (node can surface repeated headers as an array)', () => {
    const r = validateToolInput('scan_funding_arb', {}, {
      'content-type': ['application/json', 'application/json'],
      'content-length': '55',
    });
    expect(r.ok).toBe(false);
  });

  it('counts body keys BEFORE ajv mutates the input with defaults', () => {
    const r = validateToolInput('scan_funding_arb', {}, { 'content-type': 'text/plain', 'content-length': '9' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.rawBodyKeys).toBe(0); // not inflated by useDefaults
  });
});

describe('explainDroppedBody — unchanged contract', () => {
  it('returns null when no body was declared', () => {
    expect(explainDroppedBody('application/json', undefined)).toBeNull();
    expect(explainDroppedBody(undefined, '0')).toBeNull();
  });
  it('names a missing content-type and a non-JSON one', () => {
    expect(explainDroppedBody('', '10')).toMatch(/no content-type/);
    expect(explainDroppedBody('text/plain', '10')).toMatch(/not a JSON media type/);
  });
});

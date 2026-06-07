/**
 * OPS-WEBHOOK-HMAC-TIMESTAMP-W1 (SECURITY-FIX-X402-WEBHOOK-W1 Stream B) — WH-04.
 *
 * The HMAC previously signed the BODY only → a captured (body, signature) pair
 * replays forever. Fix (Stripe-style): sign `"{timestamp}.{rawBody}"` and emit the
 * timestamp in X-AlgoVault-Timestamp (already a header) so a verifier can enforce a
 * freshness window. signPayload now takes the timestamp; verifyWebhookSignature is
 * exported as the canonical constant-time verifier with a tolerance check.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  signPayload,
  buildHeaders,
  buildPayload,
  verifyWebhookSignature,
} from '../src/lib/webhook-delivery.js';

const SECRET = 'whsec_test_replay';
const eventData = () => ({ type: 'trade_call' as const, coin: 'BTC', timeframe: '1h', exchange: 'HL', call: 'BUY', confidence: 72, regime: 'TRENDING_UP', price_at_call: 50000, signal_hash: '0xdead', created_at: 1_700_000_000 });

describe('signPayload: signs timestamp + body (WH-04 replay resistance)', () => {
  it('signature covers "{timestamp}.{body}", NOT the body alone', () => {
    const body = JSON.stringify({ hello: 'world' });
    const ts = 1_700_000_123;
    const sig = signPayload(body, SECRET, ts);
    const expected = crypto.createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
    expect(sig).toBe(expected);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    // A body-only HMAC (the OLD scheme) must NOT match → the timestamp is bound.
    const bodyOnly = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    expect(sig).not.toBe(bodyOnly);
  });

  it('changing the timestamp changes the signature (timestamp is load-bearing)', () => {
    const body = JSON.stringify({ a: 1 });
    expect(signPayload(body, SECRET, 1000)).not.toBe(signPayload(body, SECRET, 1001));
  });
});

describe('buildHeaders: timestamp header matches the timestamp that was signed', () => {
  it('X-AlgoVault-Timestamp equals the signing timestamp', () => {
    const payload = buildPayload(eventData(), 7);
    const ts = 1_700_000_999;
    const body = JSON.stringify(payload);
    const sig = signPayload(body, SECRET, ts);
    const headers = buildHeaders(payload, sig, ts);
    expect(headers['X-AlgoVault-Timestamp']).toBe(String(ts));
    expect(headers['X-AlgoVault-Signature']).toBe(sig);
    // The header timestamp must be the one folded into the signature.
    const recomputed = crypto.createHmac('sha256', SECRET).update(`${headers['X-AlgoVault-Timestamp']}.${body}`).digest('hex');
    expect(headers['X-AlgoVault-Signature']).toBe(recomputed);
  });
});

describe('verifyWebhookSignature: constant-time + freshness window (the subscriber recipe)', () => {
  const body = JSON.stringify(buildPayload(eventData(), 99));

  it('accepts a fresh, correctly-signed delivery', () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(body, SECRET, ts);
    expect(verifyWebhookSignature(body, sig, ts, SECRET)).toBe(true);
  });

  it('REJECTS a replayed (stale-timestamp) signature outside the tolerance window', () => {
    // A valid signature for an OLD timestamp must be rejected (the replay defense).
    const oldTs = Math.floor(Date.now() / 1000) - 60 * 60; // 1 hour ago
    const sig = signPayload(body, SECRET, oldTs); // genuinely signed, just old
    expect(verifyWebhookSignature(body, sig, oldTs, SECRET, { toleranceSec: 300 })).toBe(false);
  });

  it('REJECTS a tampered body even with a matching timestamp', () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(body, SECRET, ts);
    expect(verifyWebhookSignature(body + 'x', sig, ts, SECRET)).toBe(false);
  });

  it('REJECTS a body-only (old-scheme) signature — the upgrade is enforced', () => {
    const ts = Math.floor(Date.now() / 1000);
    const legacy = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifyWebhookSignature(body, legacy, ts, SECRET)).toBe(false);
  });

  it('REJECTS a signature of the wrong byte-length without throwing (timingSafeEqual guard)', () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyWebhookSignature(body, 'deadbeef', ts, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, '', ts, SECRET)).toBe(false);
  });
});

/**
 * OPS-X402-V2-PAYMENT-SIGNATURE-HEADER-W1 — accept the x402 v2 `Payment-Signature` header.
 *
 * WHY THIS FILE EXISTS (the lesson, not just the fix):
 * CIRCLE-GATEWAY-MIGRATE-W1 shipped with 46 green tests, mutation-tested fail-open, a
 * live-facilitator probe and a byte-identical prod diff — and none of it could see that
 * `verifyX402Payment()` read ONLY the v1 `x-payment` header, because **both sides of those
 * tests were ours, so they agreed with each other**. Only a real external counterparty
 * (Circle's `GatewayClient`, which sends `Payment-Signature`) surfaced it.
 *
 * So the canary here deliberately does NOT hand-build header values. It drives the REAL
 * `@x402/core` `x402HTTPClient.encodePaymentSignatureHeader()` — the vendor's own encoder,
 * including the vendor's own version→header-name routing — and asserts our server reads
 * whatever that produces. If a future SDK bump changes the header name or the encoding,
 * this goes red rather than silently 402'ing every real client.
 *
 * Coverage:
 *   1. v2 `Payment-Signature` (base64)      → verifies  [the bug]
 *   2. v1 `x-payment` raw JSON              → verifies  [the LIVE CDP rail — must not move]
 *   3. v1 `x-payment` base64                → verifies  [standards-conformant v1; was ALSO broken]
 *   4. cross-encoder canary via the real SDK client, both versions
 *   5. dialect discrimination invariant (what makes accepting both provably safe)
 *   6. reject-reason instrumentation (an empty rejection list is what made this undiagnosable)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { encodePaymentSignatureHeader, x402HTTPClient } from '@x402/core/http';

const WALLET = '0x778A05280Fd8dB980E920fE9f31d0A8eAbD17d59';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const NETWORK = 'eip155:8453';

/** Production-shaped matched requirement (SDK baseRequirements shape). */
function req(amountUsd: number) {
  return {
    scheme: 'exact',
    network: NETWORK,
    amount: Math.round(amountUsd * 1_000_000).toString(),
    asset: USDC,
    payTo: WALLET,
    maxTimeoutSeconds: 300,
    extra: { name: 'USD Coin', version: '2' },
  };
}

/**
 * A realistic ERC-3009 PaymentPayload, shaped like the one captured from the real
 * Base-Sepolia settle in OPS-CIRCLE-GATEWAY-TESTNET-SETTLE-W1.
 */
function paymentPayload(x402Version: 1 | 2) {
  return {
    x402Version,
    scheme: 'exact',
    network: NETWORK,
    payload: {
      signature: '0x' + 'ab'.repeat(65),
      authorization: {
        from: '0x5f3B0000000000000000000000000000000007bc4',
        to: WALLET,
        value: '20000',
        validAfter: '0',
        validBefore: '99999999999',
        nonce: '0x' + '11'.repeat(32),
      },
    },
  };
}

let x402: typeof import('../src/lib/x402.js');
/** Records what the stubbed facilitator was asked to verify (proves the paid branch ran). */
const verifyCalls: unknown[] = [];

beforeAll(async () => {
  process.env.X402_WALLET_ADDRESS = WALLET;
  process.env.X402_NETWORK = 'base-mainnet';
  process.env.X402_FACILITATOR = 'legacy';
  delete process.env.DATABASE_URL;

  vi.doMock('../src/lib/x402-facilitator.js', () => ({
    resolveFacilitatorFromEnv: () => ({ effectiveChoice: 'legacy', discoveryEnabled: false }),
    createFacilitatorClient: () => ({}),
  }));
  // Only the SERVER half is stubbed (it would otherwise need CDP keys + network).
  // `@x402/core/http` stays REAL — it is both the vendor encoder the canary drives and
  // the decoder under test. Stubbing it would recreate the exact both-sides-ours trap.
  vi.doMock('@x402/core/server', () => ({
    x402ResourceServer: class {
      register() {}
      registerExtension() {}
      async initialize() {}
      getSupportedKind() { return true; }
      async buildPaymentRequirements(cfg: { price: string }) {
        return [req(parseFloat(String(cfg.price).replace('$', '')))];
      }
      // Match on scheme/network the way the real SDK does, so a decoded payload
      // reaches verify and an undecodable one never does.
      findMatchingRequirements(candidates: unknown[], payload: { scheme?: string }) {
        if (!Array.isArray(candidates) || candidates.length === 0) return null;
        return payload?.scheme === 'exact' ? candidates[0] : null;
      }
      async verifyPayment(payload: unknown) {
        verifyCalls.push(payload);
        return { isValid: true, payer: '0x5f3B0000000000000000000000000000000007bc4' };
      }
      settlePayment() { return Promise.resolve({ success: true }); }
    },
  }));
  vi.doMock('@x402/extensions/bazaar', () => ({ bazaarResourceServerExtension: {} }));

  x402 = await import('../src/lib/x402.js');
  await x402.initX402();
});

afterAll(() => {
  vi.doUnmock('../src/lib/x402-facilitator.js');
  vi.doUnmock('@x402/core/server');
  vi.doUnmock('@x402/extensions/bazaar');
  vi.resetModules();
});

describe('decodeX402PaymentHeader — accepts both wire dialects', () => {
  it('decodes v2 base64 (what every v2 client, incl. Circle GatewayClient, sends)', () => {
    const p = paymentPayload(2);
    expect(x402.decodeX402PaymentHeader(encodePaymentSignatureHeader(p as never))).toEqual(p);
  });

  it('decodes v1 raw JSON (the dialect the LIVE CDP rail sends today)', () => {
    const p = paymentPayload(1);
    expect(x402.decodeX402PaymentHeader(JSON.stringify(p))).toEqual(p);
  });

  it('decodes v1 base64 (a standards-conformant v1 client — was ALSO invisible)', () => {
    const p = paymentPayload(1);
    expect(x402.decodeX402PaymentHeader(encodePaymentSignatureHeader(p as never))).toEqual(p);
  });

  it('throws on a value that is neither dialect (never silently treated as unpaid)', () => {
    expect(() => x402.decodeX402PaymentHeader('not-a-payment')).toThrow();
    expect(() => x402.decodeX402PaymentHeader('')).toThrow();
  });
});

describe('dialect discrimination — the invariant that makes accepting both SAFE', () => {
  /**
   * The whole design rests on raw-JSON and base64 being mutually exclusive. If a future
   * SDK relaxed its base64 charset check, a raw-JSON header could start decoding down the
   * wrong path. Pin it here rather than assume it.
   */
  it('raw JSON is never accepted by the SDK base64 decoder', async () => {
    const { decodePaymentSignatureHeader } = await import('@x402/core/http');
    expect(() => decodePaymentSignatureHeader(JSON.stringify(paymentPayload(1)))).toThrow();
  });

  it('base64 is never accepted by JSON.parse', () => {
    expect(() => JSON.parse(encodePaymentSignatureHeader(paymentPayload(2) as never))).toThrow();
  });
});

describe('verifyX402Payment — both dialects reach the paid branch', () => {
  it('v2 Payment-Signature verifies [THE BUG: returned valid:false before this wave]', async () => {
    const header = encodePaymentSignatureHeader(paymentPayload(2) as never);
    const r = await x402.verifyX402Payment({ 'payment-signature': header }, 'get_trade_signal');
    expect(r.valid).toBe(true);
    expect(r.dialect).toBe('v2-payment-signature');
    expect(r._settlement).toBeDefined();
  });

  it('v1 x-payment raw JSON still verifies [LIVE RAIL REGRESSION GUARD]', async () => {
    const r = await x402.verifyX402Payment(
      { 'x-payment': JSON.stringify(paymentPayload(1)) },
      'get_trade_signal',
    );
    expect(r.valid).toBe(true);
    expect(r.dialect).toBe('v1-x-payment');
    expect(r._settlement).toBeDefined();
  });

  it('v1 x-payment base64 verifies (closes the standards-conformant v1 gap)', async () => {
    const header = encodePaymentSignatureHeader(paymentPayload(1) as never);
    const r = await x402.verifyX402Payment({ 'x-payment': header }, 'get_trade_signal');
    expect(r.valid).toBe(true);
    expect(r.dialect).toBe('v1-x-payment');
  });

  it('v2 wins when a client sends both headers', async () => {
    const r = await x402.verifyX402Payment(
      {
        'payment-signature': encodePaymentSignatureHeader(paymentPayload(2) as never),
        'x-payment': JSON.stringify(paymentPayload(1)),
      },
      'get_trade_signal',
    );
    expect(r.valid).toBe(true);
    expect(r.dialect).toBe('v2-payment-signature');
  });
});

describe('CROSS-ENCODER CANARY — the vendor SDK encodes, our server verifies', () => {
  /**
   * Drives the REAL `x402HTTPClient.encodePaymentSignatureHeader()`, so the VENDOR picks
   * both the header name and the encoding. We assert only that our server reads whatever
   * it produced. A v1-only regression, or an SDK header rename, fails here.
   */
  const client = new x402HTTPClient({} as never);

  for (const version of [1, 2] as const) {
    it(`x402Version ${version}: SDK-chosen header is honored by the server`, async () => {
      const emitted = client.encodePaymentSignatureHeader(paymentPayload(version) as never) as Record<string, string>;

      // Sanity: the vendor really did route by version (documents the contract we depend on).
      const name = Object.keys(emitted)[0];
      expect(name).toBe(version === 2 ? 'PAYMENT-SIGNATURE' : 'X-PAYMENT');

      // Node lowercases inbound header names; both entrypoints pass Express req.headers.
      const headers = Object.fromEntries(
        Object.entries(emitted).map(([k, v]) => [k.toLowerCase(), v]),
      );

      const r = await x402.verifyX402Payment(headers, 'get_trade_signal');
      expect(r.valid).toBe(true);
      expect(r.dialect).toBe(version === 2 ? 'v2-payment-signature' : 'v1-x-payment');
    });
  }

  it('the facilitator actually saw the decoded payload (paid branch truly ran)', () => {
    expect(verifyCalls.length).toBeGreaterThan(0);
    expect(verifyCalls.at(-1)).toMatchObject({ scheme: 'exact' });
  });
});

describe('reject-reason instrumentation — an EMPTY rejection list is what hid this defect', () => {
  it('no payment header at all → no_payment_header', async () => {
    const r = await x402.verifyX402Payment({}, 'get_trade_signal');
    expect(r.valid).toBe(false);
    expect(r.rejectReason).toBe('no_payment_header');
  });

  it('header present but undecodable → decode_failed (NOT confused with unpaid)', async () => {
    const r = await x402.verifyX402Payment({ 'payment-signature': 'garbage!!' }, 'get_trade_signal');
    expect(r.valid).toBe(false);
    expect(r.rejectReason).toBe('decode_failed');
    expect(r.dialect).toBe('v2-payment-signature');
  });

  it('decoded but matches no requirement → no_matching_requirement', async () => {
    const bad = { ...paymentPayload(2), scheme: 'not-a-real-scheme' };
    const r = await x402.verifyX402Payment(
      { 'payment-signature': encodePaymentSignatureHeader(bad as never) },
      'get_trade_signal',
    );
    expect(r.valid).toBe(false);
    expect(r.rejectReason).toBe('no_matching_requirement');
  });
});

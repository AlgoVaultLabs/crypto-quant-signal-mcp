/**
 * X402-02 (MED) regression — bounded single-use payment claim.
 * (SECURITY-FIX-X402-WEBHOOK-W1, Stream A)
 *
 * Drives the real store (src/lib/x402-idempotency-store.ts) against the SQLite
 * backend (no DATABASE_URL → ~/.crypto-quant-signal/performance.db under a temp
 * HOME). Encodes the finding: the SAME nonce replayed must be claimed exactly
 * once. Includes a CONCURRENT race (N parallel claims of one nonce → exactly one
 * winner) — the property a SELECT-then-INSERT store would fail — and the
 * fail-safe-on-empty-nonce path. Also unit-tests `extractPaymentNonce` over the
 * x402 v2 EIP-3009 / Permit2 payload shapes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ORIG = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, DATABASE_URL: process.env.DATABASE_URL };
let tempHome = '';

type Store = typeof import('../src/lib/x402-idempotency-store.js');
let store: Store;

beforeEach(async () => {
  delete process.env.DATABASE_URL; // SQLite path
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-x402idem-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  // Fresh module graph so the module-level `_initialized` + DB singleton reset.
  const { closeDb } = await import('../src/lib/performance-db.js');
  closeDb();
  const vitest = await import('vitest');
  vitest.vi.resetModules();
  store = await import('../src/lib/x402-idempotency-store.js');
});

afterEach(async () => {
  const { closeDb } = await import('../src/lib/performance-db.js');
  closeDb();
  for (const [k, v] of Object.entries(ORIG)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else (process.env as Record<string, string | undefined>)[k] = v;
  }
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('tryClaimPayment — first-use accepts, replay rejects', () => {
  it('first claim of a nonce → true; immediate replay of the same nonce → false', async () => {
    const nonce = '0xdeadbeefcafef00d000000000000000000000000000000000000000000000001';
    expect(await store.tryClaimPayment(nonce, 'get_trade_signal', '20000')).toBe(true);
    expect(await store.tryClaimPayment(nonce, 'get_trade_signal', '20000')).toBe(false);
    // A different nonce is independent.
    const other = '0xfeedface00000000000000000000000000000000000000000000000000000002';
    expect(await store.tryClaimPayment(other, 'scan_funding_arb', '10000')).toBe(true);
    expect(await store.getClaimedPaymentCount()).toBe(2);
  });

  it('CONCURRENT: N parallel claims of one nonce → exactly ONE winner', async () => {
    // This is the X402-02 PoC shape (20 concurrent replays). A SELECT-then-INSERT
    // store would let several pass; the atomic INSERT...ON CONFLICT RETURNING must
    // hand out exactly one `true`.
    const nonce = '0xc0ffee00000000000000000000000000000000000000000000000000000003';
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.tryClaimPayment(nonce, 'get_trade_signal', '20000')),
    );
    const winners = results.filter(Boolean).length;
    expect(winners).toBe(1);
    expect(await store.getClaimedPaymentCount()).toBe(1);
  });

  it('empty nonce → false (fail-safe, never serve without an idempotency key)', async () => {
    expect(await store.tryClaimPayment('', 'get_trade_signal', '20000')).toBe(false);
    expect(await store.getClaimedPaymentCount()).toBe(0);
  });
});

describe('extractPaymentNonce — x402 v2 payload shapes', () => {
  it('EIP-3009: nonce at payload.authorization.nonce', () => {
    const payload = {
      x402Version: 2,
      accepted: {},
      payload: {
        signature: '0xsig',
        authorization: {
          from: '0xfrom', to: '0xto', value: '20000',
          validAfter: '0', validBefore: '9999999999',
          nonce: '0xabc123',
        },
      },
    };
    expect(store.extractPaymentNonce(payload)).toBe('0xabc123');
  });

  it('Permit2: nonce at payload.permit2Authorization.nonce', () => {
    const payload = { payload: { permit2Authorization: { nonce: '0xpermit2nonce' } } };
    expect(store.extractPaymentNonce(payload)).toBe('0xpermit2nonce');
  });

  it('defensive fallbacks: un-nested authorization, then top-level nonce', () => {
    expect(store.extractPaymentNonce({ authorization: { nonce: '0xflat' } })).toBe('0xflat');
    expect(store.extractPaymentNonce({ nonce: '0xtop' })).toBe('0xtop');
  });

  it('no nonce present → undefined (caller fails safe)', () => {
    expect(store.extractPaymentNonce({})).toBeUndefined();
    expect(store.extractPaymentNonce(null)).toBeUndefined();
    expect(store.extractPaymentNonce({ payload: { authorization: {} } })).toBeUndefined();
  });
});

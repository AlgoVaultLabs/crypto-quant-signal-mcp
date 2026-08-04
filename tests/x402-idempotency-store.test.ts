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

describe('tryClaimPayment — payer_wallet capture (OPS-X402-WALLET-ATTRIBUTION-W1)', () => {
  async function payerWalletOf(nonce: string): Promise<string | null> {
    const { dbQuery } = await import('../src/lib/performance-db.js');
    const rows = await dbQuery<{ payer_wallet: string | null }>(
      'SELECT payer_wallet FROM processed_x402_payments WHERE nonce = ?',
      [nonce],
    );
    return rows.length ? rows[0].payer_wallet : null;
  }

  // FLIPPED by OPS-AUDIT-REMEDIATION-LOW-W2 (SEC-49). This test previously asserted "nonce stays
  // PK" and that a SECOND wallet replaying the same nonce was REJECTED. That was the defect: an
  // ERC-3009 nonce is unique per AUTHORIZER, so the second payer was a legitimate customer being
  // silently refused after paying on-chain. The exemption and its test are a pair — fixing the key
  // without flipping this test would have left the suite asserting the bug.
  it('stores payer_wallet on the winning claim; a SAME-payer replay is rejected and never overwrites it', async () => {
    const nonce = '0xaa11000000000000000000000000000000000000000000000000000000000001';
    const wallet = '0x76de895f0000000000000000000000000000c755';
    expect(await store.tryClaimPayment(nonce, 'get_trade_signal', '20000', wallet)).toBe(true);
    expect(await payerWalletOf(nonce)).toBe(wallet);
    // Same payer, same nonce → still rejected, and the DO-NOTHING conflict does not overwrite.
    expect(await store.tryClaimPayment(nonce, 'get_trade_signal', '20000', wallet)).toBe(false);
    expect(await payerWalletOf(nonce)).toBe(wallet);
    // DIFFERENT payer, same nonce → now settles, which is the whole point of the key change.
    expect(await store.tryClaimPayment(nonce, 'get_trade_signal', '20000', '0xdeadbeef00000000000000000000000000000000')).toBe(true);
  });

  // FLIPPED by OPS-AUDIT-REMEDIATION-LOW-W2 (SEC-49): an omitted payer now stores '' , NOT null.
  // Under the composite key Postgres treats NULL != NULL, so a null payer would make every
  // unattributable row DISTINCT — an unattributable replay would bypass the claim and re-serve
  // for free. '' dedupes; null does not. The claim still succeeds, so it stays fail-OPEN.
  it("fail-open: omitted payer_wallet → '' column (not null), and the claim still succeeds", async () => {
    const nonce = '0xbb22000000000000000000000000000000000000000000000000000000000002';
    expect(await store.tryClaimPayment(nonce, 'scan_funding_arb', '10000')).toBe(true); // no wallet arg
    expect(await payerWalletOf(nonce)).toBe('');
    expect(await store.getClaimedPaymentCount()).toBe(1);
    // and it must still DEDUPE despite being unattributable
    expect(await store.tryClaimPayment(nonce, 'scan_funding_arb', '10000')).toBe(false);
  });

  it('idempotency unchanged: N concurrent claims WITH a wallet → exactly one winner', async () => {
    const nonce = '0xcc33000000000000000000000000000000000000000000000000000000000003';
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.tryClaimPayment(nonce, 'get_trade_signal', '20000', '0xabc0000000000000000000000000000000000abc')),
    );
    expect(results.filter(Boolean).length).toBe(1);
    expect(await store.getClaimedPaymentCount()).toBe(1);
  });

  it('distinct-wallet aggregation EXCLUDES operator self-settle (Q2/R4 — the exact conversion)', async () => {
    const { externalPayerSql } = await import('../src/lib/x402-operator-wallets.js');
    const { dbQuery } = await import('../src/lib/performance-db.js');
    const OP = '0x76de895fdd3f7b5814eb59ccd244b06b47d8c755'; // the operator harness buyer (excluded)
    const REAL1 = '0xAAAA000000000000000000000000000000000001'; // mixed-case → lower() normalizes
    const REAL2 = '0xbbbb000000000000000000000000000000000002';
    const n = (h: string) => (h + '0'.repeat(66)).slice(0, 66);
    // operator self-settle: 3 payments, ONE wallet; + 2 distinct real payers ×1 each
    await store.tryClaimPayment(n('0xd1'), 'get_trade_signal', '20000', OP);
    await store.tryClaimPayment(n('0xd2'), 'scan_funding_arb', '10000', OP);
    await store.tryClaimPayment(n('0xd3'), 'get_market_regime', '20000', OP);
    await store.tryClaimPayment(n('0xe1'), 'get_trade_signal', '20000', REAL1);
    await store.tryClaimPayment(n('0xe2'), 'get_trade_signal', '20000', REAL2);

    // REVENUE-METER-TRUTH-W1 CH1: use the ONE shared predicate. This assertion previously ran the
    // hand-written `payer_wallet IS NOT NULL${clause}` form, which passed the empty string — so the
    // test documented the defect as correct behaviour. Fixing the predicate without fixing the test
    // that encodes it leaves the guard half-disabled (CLAUDE.md: exemption + its test are a pair).
    const { clause, params } = externalPayerSql();
    const excluded = await dbQuery<{ c: number | string }>(
      `SELECT COUNT(DISTINCT lower(trim(payer_wallet))) AS c FROM processed_x402_payments WHERE 1=1${clause}`,
      params,
    );
    expect(Number(excluded[0].c)).toBe(2); // 2 real wallets; operator (3 payments → 1 wallet) EXCLUDED

    const all = await dbQuery<{ c: number | string }>(
      `SELECT COUNT(DISTINCT lower(payer_wallet)) AS c FROM processed_x402_payments WHERE payer_wallet IS NOT NULL`,
      [],
    );
    expect(Number(all[0].c)).toBe(3); // without exclusion: 2 real + operator = 3 (the mirage)
    expect(await store.getClaimedPaymentCount()).toBe(5); // 5 payment EVENTS regardless
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

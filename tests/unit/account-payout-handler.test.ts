/**
 * REFERRAL-PAYOUT-OPS-W1 / C1 — accountPayoutAddressHandler (the payout-address
 * write path). Verifies EIP-55 validation + the irreversibility-confirm gate +
 * persistence + the re-rendered dashboard flash, with mock req/res.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Per-file SQLite isolation (unique temp HOME before imports) — mirrors referral-store.test.ts.
vi.hoisted(() => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-acct-payout-'));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  delete process.env.DATABASE_URL;
});

import { accountPayoutAddressHandler } from '../../src/lib/account-handlers.js';
import { ensureUserCode, getPayoutAddress, ensureReferralSchema } from '../../src/lib/referral-store.js';
import { ensureFreeKeysSchema, _resetFreeKeyCacheForTest } from '../../src/lib/free-keys-store.js';
import { dbRun } from '../../src/lib/performance-db.js';

const KEY = 'av_free_0123456789abcdef01234567';
const VALID = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'; // EIP-55 checksummed

function mockRes() {
  const res: { statusCode: number; body: string; headers: Record<string, string>; status: (c: number) => typeof res; setHeader: (k: string, v: string) => void; send: (b: string) => typeof res } = {
    statusCode: 200, body: '', headers: {},
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    send(b) { this.body = b; return this; },
  };
  return res;
}
const req = (body: Record<string, unknown>) => ({ body } as never);

beforeEach(() => {
  ensureReferralSchema();
  for (const t of ['referral_codes', 'referral_attributions', 'referral_ledger', 'referral_bonus']) dbRun(`DELETE FROM ${t}`);
  // OPS-AUDIT-REMEDIATION-HIGH-W1 (SEC-08): the handler now requires the api key to EXIST before
  // it mints a referral row, so the test's principal has to be a real key. Previously these cases
  // passed BECAUSE any well-formed string was accepted — which was the vulnerability.
  ensureFreeKeysSchema();
  _resetFreeKeyCacheForTest();
  dbRun('DELETE FROM free_keys');
  dbRun('INSERT INTO free_keys (api_key, email, ref_code) VALUES (?, ?, ?)', KEY, 'payout-test@example.com', null);
});

describe('accountPayoutAddressHandler', () => {
  it('saves a valid, confirmed address (checksummed) and flashes success', async () => {
    const res = mockRes();
    await accountPayoutAddressHandler(req({ api_key: KEY, payout_address: VALID.toLowerCase(), confirm: '1' }), res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/saved/i);
    const code = await ensureUserCode(KEY);
    expect(await getPayoutAddress(code)).toBe(VALID); // stored as checksummed
  });

  it('rejects an invalid address (400, error flash, nothing stored)', async () => {
    const res = mockRes();
    await accountPayoutAddressHandler(req({ api_key: KEY, payout_address: '0xnope', confirm: '1' }), res as never);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/not a valid EVM/i);
    expect(await getPayoutAddress(await ensureUserCode(KEY))).toBeNull();
  });

  it('requires the irreversibility confirm checkbox', async () => {
    const res = mockRes();
    await accountPayoutAddressHandler(req({ api_key: KEY, payout_address: VALID }), res as never);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/confirmation box/i);
    expect(await getPayoutAddress(await ensureUserCode(KEY))).toBeNull();
  });

  it('clears the address when empty (no confirm needed)', async () => {
    const code = await ensureUserCode(KEY);
    const res1 = mockRes();
    await accountPayoutAddressHandler(req({ api_key: KEY, payout_address: VALID, confirm: '1' }), res1 as never);
    expect(await getPayoutAddress(code)).toBe(VALID);
    const res2 = mockRes();
    await accountPayoutAddressHandler(req({ api_key: KEY, payout_address: '', confirm: '' }), res2 as never);
    expect(res2.statusCode).toBe(200);
    expect(await getPayoutAddress(code)).toBeNull();
  });

  it('rejects a malformed API key (400 error page)', async () => {
    const res = mockRes();
    await accountPayoutAddressHandler(req({ api_key: 'not-a-key', payout_address: VALID, confirm: '1' }), res as never);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/valid AlgoVault API key/i);
  });
});

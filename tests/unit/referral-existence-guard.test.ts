import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Per-file SQLite isolation (unique temp HOME before imports) — mirrors account-payout-handler.test.ts.
vi.hoisted(() => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-ref-exist-'));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  delete process.env.DATABASE_URL;
});

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const src = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const stripComments = (s: string) => s.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

/**
 * OPS-AUDIT-REMEDIATION-HIGH-W1 · Ch2 · SEC-08.
 *
 * `accountReferralsHandler` validated the api key's FORMAT
 * (`/^av_(live|free)_[a-f0-9]{24}$/`) and then went straight to
 * loadReferralStatsView → ensureUserCode, which INSERTs a referral_codes row. Format validation
 * is not existence validation, so ANY well-formed-but-nonexistent key minted a row from an
 * unauthenticated caller — unbounded growth of the referral source of truth, and via the
 * payout-address sibling an attacker-chosen Base USDC address attached to a phantom code.
 *
 * These are source-level assertions: both handlers reach a live Postgres/Stripe path, so the
 * runtime behaviour is covered by the post-deploy probe. What must be pinned here is the
 * ORDERING invariant — the existence check precedes every mint.
 */
describe('referral mint requires an EXISTING principal (SEC-08)', () => {
  const ah = src('src/lib/account-handlers.ts');
  const code = stripComments(ah);

  it('defines the existence check on the canonical resolver, not a second lookup', () => {
    expect(code).toContain('async function apiKeyExists(');
    // resolveLicense returns key: null for an unknown av_free_ and a Stripe-invalid av_live_.
    expect(code).toContain('resolveLicense({ authorization:');
    // AUTH-THREE-STATE-W1 CH3 re-anchored this ONE literal, and the change strengthens exactly
    // what SEC-08 is about. `license.key !== null` inferred existence from key-PRESENCE, and
    // INDETERMINATE deliberately PRESERVES the caller's key (so they meter on their own bucket
    // during a Stripe outage) — so the old predicate would have answered "this principal exists"
    // on the strength of a lookup that never completed, and minted a row for it. Existence is now
    // the resolver's own verdict.
    expect(code).toContain("credentialOutcomeOf(license) === 'RESOLVED'");
  });

  it('BOTH minting handlers gate on it', () => {
    const guards = code.split('await apiKeyExists(apiKey)').length - 1;
    // accountReferralsHandler + accountPayoutAddressHandler — the audit flagged both.
    expect(guards).toBe(2);
  });

  it('the check runs BEFORE the mint in each handler (ordering is the whole invariant)', () => {
    for (const fn of ['accountReferralsHandler', 'accountPayoutAddressHandler']) {
      const start = code.indexOf(`export async function ${fn}`);
      expect(start).toBeGreaterThan(-1);
      const body = code.slice(start, start + 3000);
      const guardAt = body.indexOf('apiKeyExists(apiKey)');
      // Whichever mint path this handler uses, the guard must precede it.
      const mintAt = Math.min(
        ...['ensureUserCode(apiKey)', 'loadReferralStatsView(apiKey)']
          .map((m) => body.indexOf(m))
          .filter((i) => i > -1),
      );
      expect(guardAt).toBeGreaterThan(-1);
      expect(mintAt).toBeGreaterThan(-1);
      expect(guardAt).toBeLessThan(mintAt);
    }
  });

  it('a nonexistent key is refused with 404, not served a freshly-minted dashboard', () => {
    expect(code).toContain("res.status(404).send(getAccountErrorPageHtml('That API key was not found.");
  });
});


// ── Behavioural proof: the guard actually stops the write ────────────────────────────────────
const REAL_KEY = 'av_free_0123456789abcdef01234567';
const GHOST_KEY = 'av_free_ffffffffffffffffffffffff'; // well-formed, never issued

function mockRes() {
  const res = {
    statusCode: 200, body: '', headers: {} as Record<string, string>,
    status(c: number) { res.statusCode = c; return res; },
    setHeader(k: string, v: string) { res.headers[k] = v; },
    send(b: string) { res.body = b; return res; },
  };
  return res;
}

describe('the guard prevents the row from being written (SEC-08, behavioural)', () => {
  beforeEach(async () => {
    const { ensureReferralSchema } = await import('../../src/lib/referral-store.js');
    const { ensureFreeKeysSchema, _resetFreeKeyCacheForTest } = await import('../../src/lib/free-keys-store.js');
    const { dbRun } = await import('../../src/lib/performance-db.js');
    ensureReferralSchema();
    ensureFreeKeysSchema();
    _resetFreeKeyCacheForTest();
    dbRun('DELETE FROM referral_codes');
    dbRun('DELETE FROM free_keys');
    dbRun('INSERT INTO free_keys (api_key, email, ref_code) VALUES (?, ?, ?)', REAL_KEY, 'exists@example.com', null);
  });

  const countCodes = async (): Promise<number> => {
    const { dbQuery } = await import('../../src/lib/performance-db.js');
    const rows = await dbQuery<{ n: number }>('SELECT COUNT(*) AS n FROM referral_codes');
    return Number(rows[0]?.n ?? 0);
  };

  it('a well-formed but NONEXISTENT key mints NOTHING and gets 404', async () => {
    const { accountReferralsHandler } = await import('../../src/lib/account-handlers.js');
    const before = await countCodes();
    const res = mockRes();
    await accountReferralsHandler({ body: { api_key: GHOST_KEY } } as never, res as never);
    expect(res.statusCode).toBe(404);
    // The whole point: row count is UNCHANGED. Pre-fix this INSERTed a referral_codes row.
    expect(await countCodes()).toBe(before);
  });

  it('a REAL key still works — the guard rejects ghosts, not owners', async () => {
    const { accountReferralsHandler } = await import('../../src/lib/account-handlers.js');
    const res = mockRes();
    await accountReferralsHandler({ body: { api_key: REAL_KEY } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(await countCodes()).toBe(1);
  });
});

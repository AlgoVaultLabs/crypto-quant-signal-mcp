/**
 * OPS-AUDIT-REMEDIATION-LOW-W2 · Ch3 — SEC-49.
 *
 * `processed_x402_payments` keyed idempotency on the bare ERC-3009 nonce. A nonce is unique
 * PER AUTHORIZER, not globally, so two payers who pick the same nonce collided — and a collision
 * meant the SECOND payer's legitimate payment was read as a replay and silently skipped. They
 * pay on-chain and receive nothing, and nothing detects it.
 *
 * The decisive assertion is the SECOND one: two different payers sharing a nonce must BOTH
 * settle. That case is the entire point of the change, so it is forced explicitly here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const SKIP = !!process.env.DATABASE_URL; // these run against the SQLite test backend

describe.skipIf(SKIP)('SEC-49 — idempotency is keyed on (payer_wallet, nonce)', () => {
  let store: typeof import('../../src/lib/x402-idempotency-store.js');

  beforeEach(async () => {
    process.env.PERFORMANCE_DB_PATH = ':memory:';
    delete process.env.DATABASE_URL;
    store = await import('../../src/lib/x402-idempotency-store.js');
    store.ensureProcessedX402PaymentsSchema();
  });

  it('a genuine replay — same payer, same nonce — is still REFUSED', async () => {
    const nonce = '0x' + 'a'.repeat(64);
    const payer = '0xPAYER_ONE';
    expect(await store.tryClaimPayment(nonce, 'get_trade_call', '0.01', payer)).toBe(true);
    expect(
      await store.tryClaimPayment(nonce, 'get_trade_call', '0.01', payer),
      'the replay hole this store exists to close must stay closed',
    ).toBe(false);
  });

  it('THE FIX: two DIFFERENT payers sharing a nonce BOTH settle', async () => {
    const nonce = '0x' + 'b'.repeat(64);
    const first = await store.tryClaimPayment(nonce, 'get_trade_call', '0.01', '0xPAYER_ONE');
    const second = await store.tryClaimPayment(nonce, 'get_trade_call', '0.01', '0xPAYER_TWO');
    expect(first).toBe(true);
    expect(
      second,
      'under the old bare-nonce key this returned false: payer two paid on-chain and was served nothing',
    ).toBe(true);
  });

  it('an unextractable payer still DEDUPES — it must not bypass the claim', async () => {
    // '' not NULL: under a composite key Postgres treats NULL != NULL, so a NULL payer would make
    // every unattributable row DISTINCT and re-serve for free on every replay.
    const nonce = '0x' + 'c'.repeat(64);
    expect(await store.tryClaimPayment(nonce, 'get_trade_call', '0.01', undefined)).toBe(true);
    expect(
      await store.tryClaimPayment(nonce, 'get_trade_call', '0.01', undefined),
      'an absent payer must still dedupe, or the claim is bypassable by simply not being attributable',
    ).toBe(false);
  });

  it('an empty nonce still fails safe', async () => {
    expect(await store.tryClaimPayment('', 'get_trade_call', '0.01', '0xPAYER_ONE')).toBe(false);
  });
});

describe('SEC-49 — the migration and the store agree on the key', () => {
  it('the store DDL declares the composite primary key', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../src/lib/x402-idempotency-store.ts', import.meta.url), 'utf8'),
    );
    expect(src).toContain('PRIMARY KEY (payer_wallet, nonce)');
    expect(src, 'the bare-nonce key must be gone').not.toContain('nonce TEXT PRIMARY KEY');
    expect(src, 'the conflict target must be the FULL key or the claim is still nonce-only')
      .toContain('ON CONFLICT (payer_wallet, nonce) DO NOTHING');
  });

  it('a nonce-only index survives, since the composite PK cannot serve a bare-nonce probe', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../src/lib/x402-idempotency-store.ts', import.meta.url), 'utf8'),
    );
    expect(src).toContain('idx_processed_x402_payments_nonce');
  });

  it('the migration ships a down-path that REFUSES a lossy revert', async () => {
    const fs = await import('node:fs');
    const down = fs.readFileSync(
      new URL('../../migrations/024_x402_idempotency_payer_nonce_pk.down.sql', import.meta.url),
      'utf8',
    );
    expect(down).toMatch(/REFUSING REVERT/);
    expect(down, 'the guard must actually check for the collision').toMatch(/HAVING count\(\*\) > 1/);
  });
});

/**
 * OPS-SHAPE-SNAPSHOT-INTEGRITY-W1 · Ch3 probe fallout — a LIVE PRODUCTION OUTAGE I caused.
 *
 * OPS-AUDIT-REMEDIATION-LOW-W2 changed the PK to (payer_wallet, nonce) but the edit that was meant
 * to move the ON CONFLICT target used a replace-FIRST-occurrence, and the first occurrence was in
 * the DOCSTRING. The docstring was updated; the SQL at the call site was not. Postgres then
 * answered every claim with "there is no unique or exclusion constraint matching the ON CONFLICT
 * specification" — and tryClaimPayment FAILS SAFE on a DB error, so it returned false and every
 * paid x402 call was refused. Verified against prod before fixing.
 *
 * It shipped green because every test runs the SQLite branch (`INSERT OR IGNORE`, which has no
 * ON CONFLICT clause at all), so the PG SQL string was never exercised by anything. These
 * assertions read the emitted SQL directly — the one thing that is backend-independent.
 */
describe('SEC-49 regression — the PG ON CONFLICT target must equal the PRIMARY KEY', () => {
  const src = readFileSync(new URL('../../src/lib/x402-idempotency-store.ts', import.meta.url), 'utf8');

  it('every ON CONFLICT in executable SQL targets the FULL composite key', () => {
    // strip block comments so the docstring cannot satisfy this — that is the exact defect.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
    const targets = [...code.matchAll(/ON CONFLICT \(([^)]*)\)/g)].map((m) => m[1].replace(/\s+/g, ''));
    expect(targets.length, 'no ON CONFLICT found in executable SQL — the parser or the file moved').toBeGreaterThan(0);
    for (const t of targets) {
      expect(t, `ON CONFLICT (${t}) does not match PRIMARY KEY (payer_wallet, nonce) — Postgres will ERROR and the claim fails safe, refusing every payment`).toBe('payer_wallet,nonce');
    }
  });

  it('the DDL primary key and the ON CONFLICT target are the same tuple', () => {
    const pk = /PRIMARY KEY \(([^)]*)\)/.exec(src)?.[1].replace(/\s+/g, '');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
    const oc = /ON CONFLICT \(([^)]*)\)/.exec(code)?.[1].replace(/\s+/g, '');
    expect(oc).toBe(pk);
  });
});

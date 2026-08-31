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
// FLIPPED by OPS-ZERO-VS-UNKNOWN-W3: tryClaimPayment returns a three-state ClaimOutcome, not a
// boolean. A boolean could not distinguish "already claimed" (settled fact) from a DB fault
// (no knowledge), which is what reported the 25-hour outage as an ordinary replay. The
// exemption and its test are a pair: leaving these asserting booleans would keep the suite
// pinning the defect.
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
    expect(await store.tryClaimPayment(nonce, 'get_trade_call', '0.01', payer)).toBe('CLAIMED');
    expect(
      await store.tryClaimPayment(nonce, 'get_trade_call', '0.01', payer),
      'the replay hole this store exists to close must stay closed',
    ).toBe('ALREADY_CLAIMED');
  });

  it('THE FIX: two DIFFERENT payers sharing a nonce BOTH settle', async () => {
    const nonce = '0x' + 'b'.repeat(64);
    const first = await store.tryClaimPayment(nonce, 'get_trade_call', '0.01', '0xPAYER_ONE');
    const second = await store.tryClaimPayment(nonce, 'get_trade_call', '0.01', '0xPAYER_TWO');
    expect(first).toBe('CLAIMED');
    expect(
      second,
      'under the old bare-nonce key this returned false: payer two paid on-chain and was served nothing',
    ).toBe('CLAIMED');
  });

  it('an unextractable payer still DEDUPES — it must not bypass the claim', async () => {
    // '' not NULL: under a composite key Postgres treats NULL != NULL, so a NULL payer would make
    // every unattributable row DISTINCT and re-serve for free on every replay.
    const nonce = '0x' + 'c'.repeat(64);
    expect(await store.tryClaimPayment(nonce, 'get_trade_call', '0.01', undefined)).toBe('CLAIMED');
    expect(
      await store.tryClaimPayment(nonce, 'get_trade_call', '0.01', undefined),
      'an absent payer must still dedupe, or the claim is bypassable by simply not being attributable',
    ).toBe('ALREADY_CLAIMED');
  });

  it('an empty nonce still fails safe', async () => {
    expect(await store.tryClaimPayment('', 'get_trade_call', '0.01', '0xPAYER_ONE')).toBe('ALREADY_CLAIMED');
  });
});

/**
 * OPS-X402-PAYER-WALLET-MIGRATION-W1 — THE SAME THREE ASSERTIONS, ON POSTGRES.
 *
 * The block above is SQLite-only by construction: its `beforeEach` deletes `DATABASE_URL` and
 * points the store at an in-memory database, and the whole describe `skipIf`s itself the moment
 * `DATABASE_URL` is set. So on the Postgres lane it does not run at all. Its sibling
 * `tests/x402-idempotency-store.test.ts` also deletes `DATABASE_URL` on purpose.
 *
 * Which means the composite-key claim behaviour — the thing whose mismatch refused every paid x402
 * call for about twenty-five hours — was pinned ONLY by source-text assertions and only ever
 * EXECUTED against SQLite, whose branch is `INSERT OR IGNORE` and has no ON CONFLICT clause at all.
 * The docstring further down this file says exactly that about the original outage. The Postgres
 * lane was then built to close it, and this file skipped itself out of the lane.
 *
 * This block runs the identical three questions against the engine production runs. It is the only
 * place in the suite where `ON CONFLICT (payer_wallet, nonce)` is ever sent to a Postgres server.
 *
 * SAFE ON THE SHARED LANE DATABASE: all twelve vitest workers point at ONE database, so every nonce
 * and payer below is namespaced by a per-run id. The claim is keyed on exactly `(payer_wallet,
 * nonce)`, so a unique pair is untouchable by any concurrent suite — no cleanup required, and none
 * attempted (a DELETE here would race the other workers).
 */
describe.runIf(!!process.env.DATABASE_URL)('SEC-49 on POSTGRES — the branch production actually executes', () => {
  let store: typeof import('../../src/lib/x402-idempotency-store.js');
  // Namespaced per run AND per worker. `VITEST_WORKER_ID` is what separates two workers that
  // started inside the same millisecond.
  const RUN = `${Date.now().toString(36)}${process.env.VITEST_WORKER_ID ?? '0'}${Math.random().toString(36).slice(2, 8)}`;
  const nonce = (tag: string) => `0xpg${RUN}${tag}`.padEnd(66, '0').slice(0, 66);

  beforeEach(async () => {
    // DELIBERATELY does NOT touch DATABASE_URL. The store's CREATE/INSERT SQL is selected at import
    // time from its presence, so deleting it here would silently put us back on the SQLite branch
    // and this whole block would assert nothing — the exact shape of the gap it exists to close.
    store = await import('../../src/lib/x402-idempotency-store.js');
    store.ensureProcessedX402PaymentsSchema();
  });

  it('the PG claim path works AT ALL — a first claim is CLAIMED, not INDETERMINATE', async () => {
    // The load-bearing one, and it is not a formality. When the composite PRIMARY KEY is missing —
    // which is what every fresh Postgres built from `migrations/` had before this wave — Postgres
    // answers `ON CONFLICT (payer_wallet, nonce)` with "there is no unique or exclusion constraint
    // matching the ON CONFLICT specification", tryClaimPayment fails safe, and EVERY payment is
    // refused. That failure is total, not partial, and this assertion is what now sees it.
    expect(
      await store.tryClaimPayment(nonce('a'), 'get_trade_call', '0.01', `0xPAYER_A_${RUN}`),
      'INDETERMINATE here means the ON CONFLICT target has no matching unique index on this database',
    ).toBe('CLAIMED');
  });

  it('a genuine replay — same payer, same nonce — is REFUSED on Postgres', async () => {
    const n = nonce('b');
    const payer = `0xPAYER_B_${RUN}`;
    expect(await store.tryClaimPayment(n, 'get_trade_call', '0.01', payer)).toBe('CLAIMED');
    expect(await store.tryClaimPayment(n, 'get_trade_call', '0.01', payer)).toBe('ALREADY_CLAIMED');
  });

  it('THE FIX, on Postgres: two DIFFERENT payers sharing a nonce BOTH settle', async () => {
    // Under the bare-nonce key the second payer was read as a replay: they paid on-chain and were
    // served nothing, with nothing detecting it. Until now this was only ever proven on SQLite,
    // where the key shape comes from a fresh CREATE TABLE and therefore could not be wrong.
    const n = nonce('c');
    expect(await store.tryClaimPayment(n, 'get_trade_call', '0.01', `0xPAYER_C1_${RUN}`)).toBe('CLAIMED');
    expect(await store.tryClaimPayment(n, 'get_trade_call', '0.01', `0xPAYER_C2_${RUN}`)).toBe('CLAIMED');
  });

  it("an unextractable payer still DEDUPES on Postgres — '' and not NULL", async () => {
    // The PG-specific half of the rule, and it cannot be checked anywhere else: under a composite
    // key Postgres treats NULL != NULL, so a NULL payer would make every unattributable row
    // DISTINCT and let a replay re-serve for free. SQLite's uniqueness semantics differ, so the
    // SQLite copy of this assertion does not test the same thing.
    const n = nonce('d');
    expect(await store.tryClaimPayment(n, 'get_trade_call', '0.01', undefined)).toBe('CLAIMED');
    expect(await store.tryClaimPayment(n, 'get_trade_call', '0.01', undefined)).toBe('ALREADY_CLAIMED');
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

  it('the store CONVERGES the key it names, because IF NOT EXISTS structurally cannot', async () => {
    // OPS-X402-PAYER-WALLET-MIGRATION-W1. `CREATE TABLE IF NOT EXISTS` does NOTHING when the table
    // exists, so the composite PRIMARY KEY declared inside it is unreachable on any pre-existing
    // table, and `ADD COLUMN IF NOT EXISTS` cannot add a constraint. The key therefore came from
    // exactly one place — migration 024 — and a database where 024 did not run kept the bare-nonce
    // key while this module's SQL claimed the composite one.
    //
    // DECLARED LIMIT, stated rather than implied: this is a PRESENCE assertion. The swap arm is not
    // exercised by any lane run, because the lane's migrations now produce the composite key
    // directly and the block correctly returns early. It is asserted here so it cannot be deleted
    // as dead code by someone who observes, correctly, that it never fires on their database.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../src/lib/x402-idempotency-store.ts', import.meta.url), 'utf8'),
    );
    expect(src).toContain('CONVERGE_PAYER_NONCE_PK_SQL');
    expect(src, 'the swap must be guarded on the OLD key, or a re-run fights the new one')
      .toMatch(/PRIMARY KEY \(nonce\)'/);
    expect(src).toMatch(/ADD PRIMARY KEY \(payer_wallet, nonce\)/);
  });

  it('migration 024 can apply to an EMPTY database — it edits a column it now also creates', async () => {
    // The defect: 024 opened with `UPDATE … SET payer_wallet = ''` and NO migration created
    // payer_wallet — it reached prod over SSH, and every other database through the app's
    // ADD COLUMN IF NOT EXISTS. 024 is one transaction, so on a fresh database its PK swap was lost
    // with it, and 026 then aborted on the same column and rolled back the columns 028 needed.
    // Nine lane errors, one absent column.
    const fs = await import('node:fs');
    const up = fs.readFileSync(
      new URL('../../migrations/024_x402_idempotency_payer_nonce_pk.sql', import.meta.url),
      'utf8',
    );
    const addIdx = up.indexOf('ADD COLUMN IF NOT EXISTS payer_wallet');
    const useIdx = up.indexOf("SET payer_wallet = ''");
    expect(addIdx, '024 must create the column it edits').toBeGreaterThan(-1);
    expect(useIdx).toBeGreaterThan(-1);
    expect(addIdx, 'the ADD COLUMN must come BEFORE the first use, or the transaction still aborts')
      .toBeLessThan(useIdx);
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

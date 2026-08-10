/**
 * OPS-X402-SETTLEMENT-CLASSIFY-PER-RAIL-W1 — the forward promotion path.
 *
 * THE GAP THIS CLOSES, measured on prod 2026-08-10: `processed_x402_payments` held 17
 * `CLAIMED_UNSETTLED` + 3 `OPERATOR` (set by a one-shot June backfill) and **zero rows had ever
 * reached `SETTLED`**. Every real settlement read as "the money never moved", because
 * `settleX402Async` received the rail's authoritative result and logged it instead of recording
 * it. This pins the write-back, and the invariants that make it safe on a revenue path.
 *
 * Drives the REAL store against SQLite under a temp HOME — same idiom as
 * x402-idempotency-store.test.ts, so the module-level `_initialized` + DB singleton reset
 * per test and nothing races a sibling suite's shared DB.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';

const ORIG = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, DATABASE_URL: process.env.DATABASE_URL };
let tempHome = '';

type Store = typeof import('../src/lib/x402-idempotency-store.js');
let store: Store;

/** Read a row's settlement_state back — the store exposes no getter, so go to the DB. */
async function stateOf(nonce: string, payer: string): Promise<string | undefined> {
  const { dbQuery } = await import('../src/lib/performance-db.js');
  const rows = await dbQuery<{ settlement_state: string }>(
    'SELECT settlement_state FROM processed_x402_payments WHERE nonce = ? AND payer_wallet = ?',
    [nonce, payer],
  );
  return rows[0]?.settlement_state;
}

beforeEach(async () => {
  delete process.env.DATABASE_URL; // SQLite path
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-x402settle-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
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

const PAYER = '0x7da6de194fed97fb745137faddde5699afe37a45'; // the real Gateway buyer, lowercased

describe('recordSettlementOutcome — a claim is promoted when the rail says the money moved', () => {
  it('CLAIMED_UNSETTLED → SETTLED, and the row actually changes', async () => {
    expect(await store.tryClaimPayment('0xN1', 'get_trade_signal', '20000', PAYER, 'op-gateway-usdc')).toBe('CLAIMED');
    expect(await stateOf('0xN1', PAYER)).toBe('CLAIMED_UNSETTLED');

    expect(await store.recordSettlementOutcome('0xN1', PAYER, 'SETTLED')).toBe('PROMOTED');
    expect(await stateOf('0xN1', PAYER)).toBe('SETTLED');
  });

  it('classifies an operator wallet as OPERATOR, not settled external revenue', async () => {
    await store.tryClaimPayment('0xN2', 'get_trade_signal', '20000', PAYER, 'base-usdc');
    expect(await store.recordSettlementOutcome('0xN2', PAYER, 'OPERATOR')).toBe('PROMOTED');
    expect(await stateOf('0xN2', PAYER)).toBe('OPERATOR');
  });
});

describe('recordSettlementOutcome — FORWARD-ONLY (money that moved may never un-move)', () => {
  it('a second promotion is idempotent and does NOT rewrite the row', async () => {
    await store.tryClaimPayment('0xN3', 'get_trade_signal', '20000', PAYER, 'op-gateway-usdc');
    expect(await store.recordSettlementOutcome('0xN3', PAYER, 'SETTLED')).toBe('PROMOTED');
    // A duplicated / late settle callback must be a no-op, not a rewrite.
    expect(await store.recordSettlementOutcome('0xN3', PAYER, 'SETTLED')).toBe('NOT_FOUND');
    expect(await stateOf('0xN3', PAYER)).toBe('SETTLED');
  });

  it('cannot DOWNGRADE a settled row — the invariant the insert path is documented to protect', async () => {
    await store.tryClaimPayment('0xN4', 'get_trade_signal', '20000', PAYER, 'op-gateway-usdc');
    await store.recordSettlementOutcome('0xN4', PAYER, 'SETTLED');
    // Even asked for a different terminal class, a promoted row is immovable.
    expect(await store.recordSettlementOutcome('0xN4', PAYER, 'OPERATOR')).toBe('NOT_FOUND');
    expect(await stateOf('0xN4', PAYER)).toBe('SETTLED');
  });

  it('a replayed CLAIM never resets a promoted row (insert stays DO NOTHING)', async () => {
    await store.tryClaimPayment('0xN5', 'get_trade_signal', '20000', PAYER, 'op-gateway-usdc');
    await store.recordSettlementOutcome('0xN5', PAYER, 'SETTLED');
    expect(await store.tryClaimPayment('0xN5', 'get_trade_signal', '20000', PAYER, 'op-gateway-usdc')).toBe('ALREADY_CLAIMED');
    expect(await stateOf('0xN5', PAYER)).toBe('SETTLED');
  });
});

describe('recordSettlementOutcome — the KEY must be derived exactly as the claim derived it', () => {
  it('a differently-cased payer matches ZERO rows — why result.payer is not interchangeable', async () => {
    await store.tryClaimPayment('0xN6', 'get_trade_signal', '20000', PAYER, 'op-gateway-usdc');
    // The facilitator returns a checksummed address; the claim stored the lowercased one.
    const checksummed = '0x7DA6DE194fED97fB745137FADDde5699AFe37A45';
    expect(checksummed).not.toBe(PAYER); // guard: the fixture must actually differ
    expect(await store.recordSettlementOutcome('0xN6', checksummed, 'SETTLED')).toBe('NOT_FOUND');
    // ...and the real row is untouched, which is the silent failure this test exists to expose.
    expect(await stateOf('0xN6', PAYER)).toBe('CLAIMED_UNSETTLED');
  });

  it('an unattributable payer round-trips as the EMPTY STRING (SEC-49), not NULL', async () => {
    await store.tryClaimPayment('0xN7', 'get_trade_signal', '20000', undefined, 'base-usdc');
    expect(await store.recordSettlementOutcome('0xN7', '', 'SETTLED')).toBe('PROMOTED');
    expect(await stateOf('0xN7', '')).toBe('SETTLED');
  });
});

describe('recordSettlementOutcome — safe on a revenue path', () => {
  it('an empty nonce is a no-op, never a throw', async () => {
    await expect(store.recordSettlementOutcome('', PAYER, 'SETTLED')).resolves.toBe('NOT_FOUND');
  });

  it('an unknown nonce is NOT_FOUND, never an error', async () => {
    await expect(store.recordSettlementOutcome('0xNOPE', PAYER, 'SETTLED')).resolves.toBe('NOT_FOUND');
  });

  it('is RAIL-AGNOSTIC — identical promotion for both rails, with no chain or RPC configured', async () => {
    // The property that makes this the generator fix rather than a per-rail scanner: nothing in
    // this path knows what a chain is. No BASE_RPC_URL, no viem, no log signature.
    expect(process.env.BASE_RPC_URL ?? '').toBe('');
    for (const [nonce, rail] of [['0xR1', 'base-usdc'], ['0xR2', 'op-gateway-usdc']] as const) {
      await store.tryClaimPayment(nonce, 'get_trade_signal', '20000', PAYER, rail);
      expect(await store.recordSettlementOutcome(nonce, PAYER, 'SETTLED')).toBe('PROMOTED');
      expect(await stateOf(nonce, PAYER)).toBe('SETTLED');
    }
  });
});

describe('the settle path must KEEP recording — a refactor may not silently drop it', () => {
  // The durable gate. The defect was never a wrong value; it was that the outcome reached only a
  // console.log. A source assertion is what stops that regressing back into a log-only path.
  const SRC = readFileSync(path.join(__dirname, '..', 'src', 'lib', 'x402.ts'), 'utf8');
  // Line comments FIRST: a `/x402/*` path inside a line comment opens a block comment for a naive
  // stripper and swallows the code under assertion (learned the hard way in the sibling suite).
  const CODE = SRC.replace(/(^|[^:])\/\/[^\n]*/g, '$1 ').replace(/\/\*[\s\S]*?\*\//g, ' ');

  it('settleX402Async calls recordSettlementOutcome on the success branch', () => {
    const fn = CODE.slice(CODE.indexOf('export function settleX402Async'));
    expect(fn.length, 'settleX402Async not found — the guard would be vacuous').toBeGreaterThan(200);
    const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
    expect(body).toContain('recordSettlementOutcome(');
  });

  it('it derives the key with extractPayerWallet, NOT result.payer', () => {
    const fn = CODE.slice(CODE.indexOf('export function settleX402Async'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
    expect(body).toContain('extractPayerWallet(settlement.paymentPayload)');
    // `result.payer` may still be LOGGED; it must not be the key passed to the store.
    expect(body).not.toMatch(/recordSettlementOutcome\(\s*[^)]*result\.payer/);
  });
});

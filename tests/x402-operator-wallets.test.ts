/**
 * OPS-X402-WALLET-ATTRIBUTION-W1 R4/Q2 — operator x402 payer-wallet exclusion.
 *
 * Operator self-settle wallets (the harness buyer) are EXCLUDED from the distinct-paying-wallet
 * CONVERSION metric so the agent funnel measures REAL agent conversion, not operator self-settle.
 * The src constant is the RUNTIME source; audits/OPERATOR_X402_WALLET_FILTER.json is the documented
 * mirror — a canary asserts they never drift.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPERATOR_X402_WALLETS, isOperatorWallet, operatorExclusionSql, externalPayerSql, truncateWallet } from '../src/lib/x402-operator-wallets.js';

const HARNESS = '0x76de895fdd3f7b5814eb59ccd244b06b47d8c755';

describe('x402 operator wallet filter', () => {
  it('includes the self-settle harness buyer (on-chain-confirmed 2026-06-30)', () => {
    expect(OPERATOR_X402_WALLETS).toContain(HARNESS);
    expect(OPERATOR_X402_WALLETS.every((w) => w === w.toLowerCase())).toBe(true); // stored lowercased
  });

  it('isOperatorWallet is case-insensitive; false for non-operator / null', () => {
    expect(isOperatorWallet(HARNESS.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(isOperatorWallet('0xabc0000000000000000000000000000000000abc')).toBe(false);
    expect(isOperatorWallet(null)).toBe(false);
    expect(isOperatorWallet(undefined)).toBe(false);
  });

  it('operatorExclusionSql builds a lower() NOT IN clause + lowercased params', () => {
    const { clause, params } = operatorExclusionSql();
    expect(clause).toContain('NOT IN');
    expect(clause).toContain('lower(payer_wallet)');
    expect(params).toEqual([...OPERATOR_X402_WALLETS]);
  });

  it('truncateWallet → 0x76de…c755 (operator display only — never the full address)', () => {
    expect(truncateWallet(HARNESS)).toBe('0x76de…c755');
  });

  it('CANARY: the src constant matches audits/OPERATOR_X402_WALLET_FILTER.json (no drift)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const json = JSON.parse(fs.readFileSync(path.join(here, '..', 'audits', 'OPERATOR_X402_WALLET_FILTER.json'), 'utf8'));
    const fromJson = (json.operator_wallets as string[]).map((w) => w.toLowerCase()).sort();
    expect([...OPERATOR_X402_WALLETS].sort()).toEqual(fromJson);
  });
});

/**
 * REVENUE-METER-TRUTH-W1 CH1 — the empty-string hole.
 *
 * `payer_wallet` is `TEXT NOT NULL DEFAULT ''` and the writers store `payerWallet ?? ''` (SEC-49:
 * under the composite PK a NULL would make every unattributable row DISTINCT and let a replay
 * bypass the claim). So `''` is CORRECT DATA — but three read-side predicates tested it with
 * `payer_wallet IS NOT NULL`, which passes `''`, and `lower('') NOT IN (<operator>)` passes it too.
 * Measured on prod 2026-08-04: 4 unattributable rows counted as a paying wallet, and the empty
 * string itself counted as a phantom DISTINCT wallet.
 */
describe('externalPayerSql — the ONE external-payer predicate (CH1)', () => {
  it('excludes NULL, the empty string, and whitespace-only; normalises case', () => {
    const { clause, params } = externalPayerSql();
    expect(clause).toContain('payer_wallet IS NOT NULL');
    expect(clause).toContain("trim(payer_wallet) <> ''");     // the hole this closes
    expect(clause).toContain('lower(trim(payer_wallet))');     // whitespace + case normalised
    expect(clause).toContain('NOT IN');
    expect(params).toEqual([...OPERATOR_X402_WALLETS]);
  });

  it('composes operatorExclusionSql rather than re-deriving the operator list', () => {
    // Single-derivation: there must be exactly ONE operator list, and the helper must use it.
    const { params: viaExternal } = externalPayerSql();
    const { params: viaOperator } = operatorExclusionSql();
    expect(viaExternal).toEqual(viaOperator);
  });

  it('parameterises the column name', () => {
    const { clause } = externalPayerSql('w');
    expect(clause).toContain('w IS NOT NULL');
    expect(clause).toContain("trim(w) <> ''");
  });
});

/**
 * Semantic proof against a REAL SQLite database driving the REAL store — a clause-shape assertion
 * cannot show that the old predicate actually admitted the empty string, and that admission is the
 * whole defect. Mirrors the harness in tests/x402-idempotency-store.test.ts.
 */
describe('externalPayerSql — semantics against a real DB (CH1)', () => {
  const ORIG = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, DATABASE_URL: process.env.DATABASE_URL };
  let tempHome = '';
  let store: typeof import('../src/lib/x402-idempotency-store.js');

  beforeEach(async () => {
    delete process.env.DATABASE_URL; // SQLite path
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-extpayer-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    const { closeDb } = await import('../src/lib/performance-db.js');
    closeDb();
    vi.resetModules();
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

  it('counts ONLY external attributable wallets — and the OLD predicate provably did not', async () => {
    const { dbQuery } = await import('../src/lib/performance-db.js');
    const OP = '0x76de895fdd3f7b5814eb59ccd244b06b47d8c755';
    const REAL1 = '0xAAAA000000000000000000000000000000000001'; // mixed case
    const REAL1_LOWER = REAL1.toLowerCase();                    // same wallet, must not double-count
    const REAL2 = '0xbbbb000000000000000000000000000000000002';
    const n = (h: string) => (h + '0'.repeat(66)).slice(0, 66);

    await store.tryClaimPayment(n('0xd1'), 'get_trade_signal', '20000', OP);
    await store.tryClaimPayment(n('0xd2'), 'scan_funding_arb', '10000', OP);
    await store.tryClaimPayment(n('0xe1'), 'get_trade_signal', '20000', REAL1);
    await store.tryClaimPayment(n('0xe2'), 'get_trade_signal', '20000', REAL1_LOWER);
    await store.tryClaimPayment(n('0xe3'), 'get_trade_signal', '20000', REAL2);
    // The prod shape: 4 unattributable pre-instrumentation rows. `undefined` → `''` (SEC-49).
    await store.tryClaimPayment(n('0xf1'), 'get_trade_signal', '20000');
    await store.tryClaimPayment(n('0xf2'), 'get_trade_signal', '20000');
    await store.tryClaimPayment(n('0xf3'), 'get_trade_signal', '20000');
    await store.tryClaimPayment(n('0xf4'), 'get_trade_signal', '20000', '   '); // whitespace-only

    const { clause, params } = externalPayerSql();
    const fixed = await dbQuery<{ c: number | string }>(
      `SELECT COUNT(DISTINCT lower(trim(payer_wallet))) AS c FROM processed_x402_payments WHERE 1=1${clause}`,
      params,
    );
    expect(Number(fixed[0].c)).toBe(2); // REAL1 (either casing) + REAL2. Operator, '' and '   ' all out.

    // The OLD predicate, verbatim, on the same rows — it admitted the empty string as a wallet.
    const { clause: opClause, params: opParams } = operatorExclusionSql();
    const old = await dbQuery<{ c: number | string }>(
      `SELECT COUNT(DISTINCT lower(payer_wallet)) AS c FROM processed_x402_payments WHERE payer_wallet IS NOT NULL${opClause}`,
      opParams,
    );
    expect(Number(old[0].c)).toBe(4); // 2 real + '' + '   ' → the +2 phantom wallets this chapter removes
    expect(Number(old[0].c)).toBeGreaterThan(Number(fixed[0].c)); // the defect, stated as an inequality
  });
});

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
import { execFileSync } from 'node:child_process';
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

  /**
   * REVENUE-METER-TRUTH-W6 CH7 · AC 7.10 — GOVERN EVERY COPY, not just the two the canary above
   * happened to know about.
   *
   * The law: **a migration that encodes a business constant is a copy of that constant outside the
   * constant's governance.** `migrations/026_x402_settlement_and_rail.sql` hardcodes this wallet in
   * a `WHERE lower(trim(payer_wallet)) IN (…)` predicate that wrote the live `OPERATOR` rows, and
   * nothing checked it — the canary above compares only `src` to `audits`. Same law this repo
   * already carries as "a duplicated fact goes stale — point at the SoT", in a substrate nobody had
   * checked. Measured 2026-08-05: EIGHT lines across SIX tracked files, of which the canary above
   * governed TWO.
   *
   * 🚨 The match is on the FULL 42-character literal, deliberately. `tests/x402-idempotency-store.test.ts`
   * carries a SYNTHETIC wallet that shares BOTH this one's `0x76de895f` prefix and its `c755`
   * suffix — a decoy built to catch exactly the lazy prefix/suffix matcher this assertion could
   * have been. A loose matcher would false-positive on it forever.
   *
   * Scope is every tracked text file EXCEPT this one (self-reference would be circular) — so a
   * future copy in a directory nobody thought of is caught by construction rather than by someone
   * remembering to widen a list.
   */
  it('AC 7.10 CANARY: every copy of the operator literal repo-wide sits in a DECLARED file', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.join(here, '..');
    const selfRel = path.relative(repoRoot, fileURLToPath(import.meta.url)).split(path.sep).join('/');

    // The DECLARED set. Every row carries WHY that file may hold a copy — an exemption that lives
    // only in a comment gets "fixed" by a future wave enforcing the contract, so the reason is
    // data. Adding a copy anywhere else FAILS this test until someone declares it, which is the
    // whole mechanism: the decision is forced, not remembered.
    const DECLARED: Record<string, string> = {
      'src/lib/x402-operator-wallets.ts': 'THE SoT — the runtime constant every consumer imports.',
      'audits/OPERATOR_X402_WALLET_FILTER.json': 'The documented mirror; the canary above pins it to the SoT.',
      'migrations/026_x402_settlement_and_rail.sql':
        'A one-time transcription into a WHERE predicate that wrote the live OPERATOR rows. The ' +
        'migration self-documents that matching the operator wallet is NOT what makes a row settled ' +
        'and names the on-chain scan as the forward path. It has already run; it is history, not a ' +
        'derivation — but it is still a COPY, and before REVENUE-METER-TRUTH-W6 CH7 nothing checked it.',
      'tests/x402-idempotency-store.test.ts': 'Fixture: exercises the operator-exclusion path.',
      'tests/x402-settlement-classification.test.ts': 'Fixture: the OPERATOR settlement class.',
    };

    // Enumerate via git so the scan follows the TRACKED set — never a hand-maintained directory
    // list, and never a stale nested worktree (an unanchored glob once discovered 1,480 of those).
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\0')
      .filter(Boolean)
      .filter((p) => !p.startsWith('node_modules/'))
      .filter((p) => p !== selfRel);

    const ADDRESS = /0x[0-9a-fA-F]{40}/g;
    const governed = new Set(OPERATOR_X402_WALLETS.map((w) => w.toLowerCase()));
    const carriers = new Set<string>();
    const nearMisses = new Set<string>();
    let scanned = 0;

    for (const rel of tracked) {
      let buf: Buffer;
      try {
        buf = fs.readFileSync(path.join(repoRoot, rel));
      } catch {
        continue;
      }
      if (buf.includes(0)) continue; // binary — the greppability gate already forbids NULs in source
      scanned += 1;
      const text = buf.toString('utf8');
      if (!text.includes('0x76de895f')) continue; // cheap prefilter
      for (const m of text.matchAll(ADDRESS)) {
        const addr = m[0].toLowerCase();
        if (governed.has(addr)) carriers.add(rel);
        else if (addr.startsWith('0x76de895f')) nearMisses.add(`${rel}: ${addr}`);
      }
    }

    // VACUITY FLOOR — three ways, because a scan that reads nothing finds nothing wrong and
    // reports a triumphant pass. That is the exact dark-guard shape this arc exists to retire, and
    // it would be humiliating to ship it inside the assertion written to retire it.
    expect(tracked.length, 'git ls-files returned nothing — no corpus was enumerated').toBeGreaterThan(100);
    expect(scanned, 'zero files were actually READ — the scan is not reading the corpus it enumerated').toBeGreaterThan(100);
    expect(carriers.size, 'found ZERO files carrying the governed literal — the matcher is broken').toBeGreaterThanOrEqual(4);

    // (1) No UNDECLARED carrier. This is the AC: a new copy in a directory nobody thought of.
    const undeclared = [...carriers].filter((f) => !(f in DECLARED)).sort();
    expect(undeclared, `UNDECLARED copies of the operator wallet:\n  ${undeclared.join('\n  ')}`).toEqual([]);

    // (2) No STALE declaration. A file that no longer carries a copy must be removed from DECLARED,
    // or the record quietly becomes a list of places the literal used to be. Bidirectional, same
    // contract as the monitoring reconciler's ORPHAN check.
    const stale = Object.keys(DECLARED).filter((f) => !carriers.has(f)).sort();
    expect(stale, `DECLARED files that no longer carry a copy:\n  ${stale.join('\n  ')}`).toEqual([]);

    // (3) 🚨 THE DECOY MUST SURVIVE. tests/x402-idempotency-store.test.ts carries a SYNTHETIC
    // address sharing BOTH the operator's `0x76de895f` prefix AND its `c755` suffix — built to
    // catch a lazy prefix/suffix matcher. It is NOT a copy of the operator wallet and must never be
    // reported as one. Asserting it was SEEN (not merely absent from the failures) is what makes
    // this a real check rather than a coincidence: if the prefilter or the regex ever stops finding
    // it, this fails and says so.
    expect(
      [...nearMisses],
      'the near-miss decoy was not observed — the scan is no longer reaching it, so its protection is unverified',
    ).toContain('tests/x402-idempotency-store.test.ts: 0x76de895f0000000000000000000000000000c755');
    expect([...nearMisses].every((n) => !governed.has(n.split(': ')[1]))).toBe(true);
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

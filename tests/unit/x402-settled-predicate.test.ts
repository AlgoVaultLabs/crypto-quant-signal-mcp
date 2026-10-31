/**
 * DECISION-CALL-V1-W3 CH1 (AC1.3) — every count of x402 payments or payers reads SETTLED rows only,
 * through ONE predicate (`settledPaymentSql`). A claim is not a payment.
 *
 *   1. the predicate's exact shape (it composes beside `externalPayerSql`);
 *   2. end to end on real SQLite, through the real write path: 3 claims from 3 external wallets — one
 *      SETTLED, one CLAIMED_UNSERVED, one left CLAIMED_PENDING — and the scoreboard's Paid stage reads
 *      1 wallet and 1 payment, with only the settled wallet in the repeat-payer list;
 *   3. the source pin: every `FROM processed_x402_payments` read in the two funnel modules interpolates
 *      the settled clause, and no inline `'SETTLED'` literal survives. The corpus is COUNTED (5 + 1), so
 *      a read moved out of these files fails the pin instead of passing it vacuously.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ORIG_ENV = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATABASE_URL: process.env.DATABASE_URL,
};
afterAll(() => {
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else (process.env as Record<string, string | undefined>)[k] = v;
  }
});

describe('settledPaymentSql — the one payment predicate', () => {
  it('is a single bound SETTLED equality on the state column', async () => {
    const { settledPaymentSql } = await import('../../src/lib/x402-operator-wallets.js');
    expect(settledPaymentSql()).toEqual({ clause: ' AND settlement_state = ?', params: ['SETTLED'] });
    expect(settledPaymentSql('p.settlement_state')).toEqual({ clause: ' AND p.settlement_state = ?', params: ['SETTLED'] });
  });
});

describe('scoreboard Paid stage on real SQLite — 3 claims, 1 settled → Paid 1', () => {
  const WALLETS = ['0x' + 'a1'.repeat(20), '0x' + 'b2'.repeat(20), '0x' + 'c3'.repeat(20)];
  const NONCES = WALLETS.map((_, i) => `0x${String(i + 1).padStart(64, 'd')}`);
  let home = '';

  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-settled-predicate-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const { closeDb } = await import('../../src/lib/performance-db.js');
    closeDb();
    vi.resetModules();
  });
  afterEach(async () => {
    const { closeDb } = await import('../../src/lib/performance-db.js');
    closeDb();
    vi.resetModules();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('Paid counts the one SETTLED wallet — not the unserved claim, not the pending one', async () => {
    const store = await import('../../src/lib/x402-idempotency-store.js');
    const { isOperatorWallet, truncateWallet } = await import('../../src/lib/x402-operator-wallets.js');
    for (const w of WALLETS) expect(isOperatorWallet(w)).toBe(false); // external by construction

    for (let i = 0; i < 3; i++) {
      expect(await store.tryClaimPayment(NONCES[i], 'get_market_regime', '20000', WALLETS[i], store.RAIL_BASE_USDC)).toBe('CLAIMED');
    }
    expect(await store.recordSettlementOutcome(NONCES[0], WALLETS[0], 'SETTLED', '0xtx')).toBe('PROMOTED');
    expect(await store.recordUnservedClaim(NONCES[1], WALLETS[1])).toBe('MARKED');

    // The corpus is what this test says it is — three claimed rows, exactly one of them a payment.
    const { dbQuery } = await import('../../src/lib/performance-db.js');
    const states = (await dbQuery<{ settlement_state: string }>(
      'SELECT settlement_state FROM processed_x402_payments ORDER BY settlement_state', [],
    )).map((r) => r.settlement_state);
    expect(states).toEqual(['CLAIMED_PENDING', 'CLAIMED_UNSERVED', 'SETTLED']);

    const { getAgentFunnel, defaultScoreboardDeps } = await import('../../src/lib/funnel-scoreboard.js');
    const a = await getAgentFunnel('all', defaultScoreboardDeps);
    const paid = a.stages.find((s) => s.key === 'paid_x402');
    expect(paid?.label).toBe('Paid');
    expect(paid?.count).toBe(1);
    expect(a.paid_detail).toMatchObject({ distinct_wallets: 1, payments: 1 });
    expect(a.paid_detail.repeat_payers).toEqual([{ wallet: truncateWallet(WALLETS[0]), calls: 1 }]);
    expect(a.paid_note).toContain('SETTLED payments only');
  });
});

describe('source pin — every funnel read of processed_x402_payments composes the settled predicate', () => {
  const SRC = path.join(__dirname, '..', '..', 'src', 'lib');
  const EXPECTED_READS: Record<string, number> = { 'funnel-scoreboard.ts': 5, 'funnel-snapshot.ts': 1 };

  for (const [file, expected] of Object.entries(EXPECTED_READS)) {
    it(`${file}: ${expected} read(s), each interpolating \${settledClause…}; no inline 'SETTLED'`, () => {
      const text = fs.readFileSync(path.join(SRC, file), 'utf8');
      const reads: string[] = [];
      for (let at = text.indexOf('FROM processed_x402_payments'); at !== -1; at = text.indexOf('FROM processed_x402_payments', at + 1)) {
        reads.push(text.slice(at, text.indexOf('`', at))); // to the template literal's closing backtick
      }
      expect(reads.length).toBe(expected);
      for (const sql of reads) expect(sql).toMatch(/\$\{settledClause\w*\}/);
      expect(text).not.toMatch(/settlement_state\s*=\s*'SETTLED'/);
    });
  }
});

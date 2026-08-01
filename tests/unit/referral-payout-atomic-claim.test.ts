/**
 * OPS-AUDIT-REMEDIATION-MEDIUM-W1 / Ch2 — SEC-16: atomic claim on the USDC payout.
 *
 * THE DEFECT. `executeApproveAllBatch` read each ledger row's status, then sent, with
 * nothing between. The handler serially awaits `waitForUserOperation` per referrer, so a
 * run takes tens of seconds — long enough for a browser resubmit, a refresh-and-confirm,
 * or a second admin tab to re-enter the function mid-flight. Both runs then saw
 * `usdc_pending` for the same ledger ids and both called `sender.send`: the referrer was
 * paid twice, on-chain, unrecoverably. The module docstring asserted a safety property
 * ("a replay or a partial-batch retry never double-sends") that the code did not have.
 *
 * The second half: `markLedger` was fire-and-forget, so a lost UPDATE left rows
 * `usdc_pending` AFTER the money moved — and the next Approve-all paid them again.
 *
 * The forced race below is a REAL concurrency test (two overlapping executions against
 * one store), not an argument that the code is safe.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-payout-claim-'));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  delete process.env.DATABASE_URL;
  delete process.env.CDP_WALLET_SECRET;
});

import {
  executeApproveAllBatch,
  type PayoutSender,
  type PayoutResult,
} from '../../src/lib/referral-payout.js';
import {
  ensureReferralSchema,
  mintPartnerCode,
  setPayoutAddress,
  appendLedger,
  getLedgerById,
  getLedgerPayoutClaim,
  tryClaimLedgerForPayout,
  releaseLedgerPayoutClaim,
  markLedgerAsync,
} from '../../src/lib/referral-store.js';
import { dbRun, dbQuery } from '../../src/lib/performance-db.js';

const ADDR = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

/** Sender whose send() is slow, so two runs genuinely overlap inside the critical section. */
class SlowSender implements PayoutSender {
  readonly kind = 'slow';
  sent: Array<{ to: string; amt: number }> = [];
  constructor(private delayMs = 25, private fail = false) {}
  async send(to: string, amt: number): Promise<PayoutResult> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.fail) throw new Error('mock_send_failed');
    this.sent.push({ to, amt });
    return { txRef: '0x' + 'b'.repeat(64) };
  }
}

async function seed(code: string, amountsE2: number[]): Promise<void> {
  await mintPartnerCode({ code, owner_label: code, owner_email: `${code.toLowerCase()}@x.com` });
  await setPayoutAddress(code, ADDR);
  let i = 0;
  for (const a of amountsE2) {
    await appendLedger({ code, stripe_event_id: `evt_${code}_${i++}`, gross_usd_e2: a * 3, commission_usd_e2: a, status: 'usdc_pending' });
  }
}

async function ledgerIdsFor(code: string): Promise<number[]> {
  const rows = await dbQuery<{ id: number }>('SELECT id FROM referral_ledger WHERE code = ? ORDER BY id', [code]);
  return rows.map((r) => Number(r.id));
}

beforeEach(() => {
  ensureReferralSchema();
  for (const t of ['referral_codes', 'referral_attributions', 'referral_ledger', 'referral_bonus', 'referral_payout_claims']) {
    dbRun(`DELETE FROM ${t}`);
  }
});

describe('claim primitive', () => {
  it('exactly one caller wins a contended claim', async () => {
    const results = await Promise.all([
      tryClaimLedgerForPayout(1, 'runA:CODE'),
      tryClaimLedgerForPayout(1, 'runB:CODE'),
      tryClaimLedgerForPayout(1, 'runC:CODE'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('a release is scoped to the claim_ref that took it', async () => {
    await tryClaimLedgerForPayout(7, 'runA:CODE');
    // A different run must NOT be able to release someone else's in-flight claim.
    expect(await releaseLedgerPayoutClaim(7, 'runB:CODE')).toBe(false);
    expect(await getLedgerPayoutClaim(7)).not.toBeNull();
    expect(await releaseLedgerPayoutClaim(7, 'runA:CODE')).toBe(true);
    expect(await getLedgerPayoutClaim(7)).toBeNull();
  });

  it('markLedgerAsync reports how many rows it actually updated', async () => {
    await seed('MARKME', [6000]);
    const [id] = await ledgerIdsFor('MARKME');
    expect(await markLedgerAsync(id, 'usdc_paid', '0xdead')).toBe(1);
    expect(await markLedgerAsync(999999, 'usdc_paid', '0xdead')).toBe(0); // matched nothing
    expect((await getLedgerById(id))?.status).toBe('usdc_paid');
  });
});

describe('executeApproveAllBatch — the double-pay race', () => {
  it('THE REGRESSION: two overlapping Approve-all runs send EXACTLY ONCE', async () => {
    await seed('RACERX', [6000]); // $60, above the min payout
    const sender = new SlowSender(30);

    // Genuinely concurrent: the second run enters while the first is awaiting send().
    const [a, b] = await Promise.all([
      executeApproveAllBatch(sender),
      executeApproveAllBatch(sender),
    ]);

    expect(sender.sent).toHaveLength(1);            // the money moved once
    expect(a.paid.length + b.paid.length).toBe(1);  // and exactly one run reports it
    const ids = await ledgerIdsFor('RACERX');
    for (const id of ids) expect((await getLedgerById(id))?.status).toBe('usdc_paid');
  });

  it('a sequential re-run after a successful batch sends nothing', async () => {
    await seed('AGAINX', [6000]);
    const sender = new SlowSender(1);
    await executeApproveAllBatch(sender);
    const second = await executeApproveAllBatch(sender);
    expect(sender.sent).toHaveLength(1);
    expect(second.paid).toHaveLength(0);
  });

  it('THE SECOND HALF: a LOST mark-paid write does not cause a re-pay', async () => {
    // Simulate exactly what a `[pg-write] WRITE LOST` looks like from the outside: the
    // send happened, but the status column never changed. Before this wave the next
    // Approve-all saw usdc_pending and paid again. The claim row is the durable marker
    // that makes that impossible, INDEPENDENT of the status column.
    await seed('LOSTWX', [6000]);
    const sender = new SlowSender(1);
    await executeApproveAllBatch(sender);
    expect(sender.sent).toHaveLength(1);

    const ids = await ledgerIdsFor('LOSTWX');
    for (const id of ids) dbRun('UPDATE referral_ledger SET status = ? WHERE id = ?', 'usdc_pending', id);
    for (const id of ids) expect(await getLedgerPayoutClaim(id)).not.toBeNull(); // claim survived

    const rerun = await executeApproveAllBatch(sender);
    expect(sender.sent).toHaveLength(1);                    // still ONE send
    expect(rerun.paid).toHaveLength(0);
    expect(rerun.skippedAlreadyPaid.length).toBeGreaterThan(0);
  });
});

describe('executeApproveAllBatch — no claimed-but-unsent black hole', () => {
  it('a send failure RELEASES the claims so the rows resume next run', async () => {
    await seed('FAILER', [6000]);
    const failing = new SlowSender(1, true);
    const res = await executeApproveAllBatch(failing);
    expect(res.failed.map((f) => f.code)).toContain('FAILER');
    expect(failing.sent).toHaveLength(0);

    const ids = await ledgerIdsFor('FAILER');
    for (const id of ids) {
      expect(await getLedgerPayoutClaim(id)).toBeNull();               // released
      expect((await getLedgerById(id))?.status).toBe('usdc_pending');  // still payable
    }

    // Clean resume: a later run with a working sender pays it.
    const ok = new SlowSender(1);
    const retry = await executeApproveAllBatch(ok);
    expect(ok.sent).toHaveLength(1);
    expect(retry.paid).toHaveLength(1);
  });

  it('a dry run leaves the queue exactly as it found it (no claims stranded)', async () => {
    await seed('DRYRUN', [6000]);
    const sender = new SlowSender(1);
    const res = await executeApproveAllBatch(sender, { dryRun: true });
    expect(res.paid[0].txRef).toBe('DRY_RUN');
    expect(sender.sent).toHaveLength(0);
    for (const id of await ledgerIdsFor('DRYRUN')) {
      expect(await getLedgerPayoutClaim(id)).toBeNull();
      expect((await getLedgerById(id))?.status).toBe('usdc_pending');
    }
  });

  it('a batch-cap rejection releases its claims too', async () => {
    await seed('CAPPED', [6000]);
    const sender = new SlowSender(1);
    const res = await executeApproveAllBatch(sender, { maxBatchUsdE2: 100 }); // $1 cap vs $60
    expect(res.failed.map((f) => f.reason)).toContain('batch_cap_reached');
    expect(sender.sent).toHaveLength(0);
    for (const id of await ledgerIdsFor('CAPPED')) {
      expect(await getLedgerPayoutClaim(id)).toBeNull();
      expect((await getLedgerById(id))?.status).toBe('usdc_pending');
    }
  });
});

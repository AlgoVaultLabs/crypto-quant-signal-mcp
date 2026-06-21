/**
 * REFERRAL-PAYOUT-OPS-W1 / C2 — payout batch detection, the operator digest, and the
 * Approve-all execution orchestration (with a mock + the Stub sender). Verifies:
 * threshold detection + carry-forward, the digest shape, pay→mark-paid→skip-no-address,
 * replay-safety (already-paid rows never re-sent), dry-run, the batch cap, and that a
 * single send failure leaves that referrer pending (clean resume).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-ref-payout-'));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  delete process.env.DATABASE_URL;
});

import {
  detectPayoutBatch,
  formatBatchDigest,
  executeApproveAllBatch,
  StubPayoutSender,
  getPayoutSender,
  type PayoutSender,
  type PayoutResult,
} from '../../src/lib/referral-payout.js';
import {
  ensureReferralSchema,
  mintPartnerCode,
  setPayoutAddress,
  appendLedger,
} from '../../src/lib/referral-store.js';
import { dbRun } from '../../src/lib/performance-db.js';

const ADDR_A = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const ADDR_B = '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B';

class MockSender implements PayoutSender {
  readonly kind = 'mock';
  sent: Array<{ to: string; amt: number }> = [];
  constructor(private failFor?: (to: string) => boolean) {}
  async send(to: string, amt: number): Promise<PayoutResult> {
    if (this.failFor?.(to)) throw new Error('mock_fail');
    this.sent.push({ to, amt });
    return { txRef: '0x' + 'a'.repeat(64) };
  }
}

async function seed(code: string, addr: string | null, amountsE2: number[]): Promise<void> {
  await mintPartnerCode({ code, owner_label: code, owner_email: `${code.toLowerCase()}@x.com` });
  if (addr) await setPayoutAddress(code, addr);
  let i = 0;
  for (const a of amountsE2) {
    await appendLedger({ code, stripe_event_id: `evt_${code}_${i++}`, gross_usd_e2: a * 3, commission_usd_e2: a, status: 'usdc_pending' });
  }
}

beforeEach(() => {
  ensureReferralSchema();
  for (const t of ['referral_codes', 'referral_attributions', 'referral_ledger', 'referral_bonus']) dbRun(`DELETE FROM ${t}`);
});

describe('detectPayoutBatch', () => {
  it('returns only >= min, counts addresses, carries sub-min forward', async () => {
    await seed('PAYERA', ADDR_A, [6000]);  // $60, has address
    await seed('PAYERB', null, [7000]);    // $70, no address
    await seed('PAYERC', ADDR_A, [3000]);  // $30, below min → carried forward
    const b = await detectPayoutBatch();
    expect(b.due.map((p) => p.code).sort()).toEqual(['PAYERA', 'PAYERB']);
    expect(b.totalUsdE2).toBe(13000);
    expect(b.withAddress).toBe(1);
    expect(b.withoutAddress).toBe(1);
  });
});

describe('formatBatchDigest', () => {
  it('empty batch → no sections (suppress-on-empty)', () => {
    expect(formatBatchDigest({ due: [], totalUsdE2: 0, withAddress: 0, withoutAddress: 0 })).toEqual([]);
  });
  it('builds header + per-referrer lines + admin-link foot with missing-address note', async () => {
    await seed('PAYERA', ADDR_A, [6000]);
    await seed('PAYERB', null, [7000]);
    const secs = formatBatchDigest(await detectPayoutBatch());
    expect(secs).toHaveLength(3);
    expect(secs[0]).toMatch(/2 referrer/);
    expect(secs[0]).toContain('$130.00');
    expect(secs[1]).toContain('PAYERA');
    expect(secs[1]).toContain('PAYERB');
    expect(secs[2]).toContain('/admin/referrals/payouts');
    expect(secs[2]).toMatch(/1 missing a payout address/);
  });
});

describe('executeApproveAllBatch', () => {
  it('pays addressed referrers, marks paid, skips no-address; paid rows leave the queue', async () => {
    await seed('PAYERA', ADDR_A, [6000]); // $60
    await seed('PAYERB', null, [7000]);   // $70, no address
    const sender = new MockSender();
    const r = await executeApproveAllBatch(sender);
    expect(r.paid.map((p) => p.code)).toEqual(['PAYERA']);
    expect(r.skippedNoAddress).toEqual(['PAYERB']);
    expect(r.totalPaidUsdE2).toBe(6000);
    expect(sender.sent).toEqual([{ to: ADDR_A, amt: 6000 }]);
    const after = await detectPayoutBatch();
    expect(after.due.map((p) => p.code)).toEqual(['PAYERB']); // PAYERA paid; PAYERB still no-address pending
  });

  it('sums multiple pending rows per referrer into ONE send', async () => {
    await seed('PAYERA', ADDR_A, [3000, 3000]); // two $30 rows = $60
    const sender = new MockSender();
    const r = await executeApproveAllBatch(sender);
    expect(sender.sent).toEqual([{ to: ADDR_A, amt: 6000 }]);
    expect(r.paid).toEqual([{ code: 'PAYERA', amountUsdE2: 6000, txRef: '0x' + 'a'.repeat(64) }]);
  });

  it('is replay-safe — a second run never re-sends an already-paid referrer', async () => {
    await seed('PAYERA', ADDR_A, [6000]);
    await executeApproveAllBatch(new MockSender());
    const sender2 = new MockSender();
    const r2 = await executeApproveAllBatch(sender2);
    expect(r2.paid).toEqual([]);
    expect(sender2.sent).toEqual([]);
  });

  it('dry-run marks nothing and sends nothing', async () => {
    await seed('PAYERA', ADDR_A, [6000]);
    const sender = new MockSender();
    const r = await executeApproveAllBatch(sender, { dryRun: true });
    expect(r.paid[0].txRef).toBe('DRY_RUN');
    expect(sender.sent).toEqual([]);
    expect((await detectPayoutBatch()).due.map((p) => p.code)).toContain('PAYERA'); // still pending
  });

  it('enforces the batch cap (over-cap referrer recorded failed, not sent)', async () => {
    await seed('PAYERA', ADDR_A, [6000]); // $60
    await seed('PAYERB', ADDR_B, [7000]); // $70 (sorted first, desc)
    const sender = new MockSender();
    const r = await executeApproveAllBatch(sender, { maxBatchUsdE2: 7000 });
    expect(r.paid.map((p) => p.code)).toEqual(['PAYERB']);
    expect(r.failed).toEqual([{ code: 'PAYERA', reason: 'batch_cap_reached' }]);
    expect(sender.sent).toEqual([{ to: ADDR_B, amt: 7000 }]);
  });

  it('a single send failure leaves that referrer pending (clean resume)', async () => {
    await seed('PAYERA', ADDR_A, [6000]);
    await seed('PAYERB', ADDR_B, [7000]);
    const sender = new MockSender((to) => to === ADDR_B); // PAYERB fails
    const r = await executeApproveAllBatch(sender);
    expect(r.paid.map((p) => p.code)).toEqual(['PAYERA']);
    expect(r.failed).toEqual([{ code: 'PAYERB', reason: 'mock_fail' }]);
    expect((await detectPayoutBatch()).due.map((p) => p.code)).toEqual(['PAYERB']); // PAYERB resumes
  });

  it('the Stub sender (C2 default) sends nothing — reports not-configured', async () => {
    await seed('PAYERA', ADDR_A, [6000]);
    expect(getPayoutSender().kind).toBe('stub');
    const r = await executeApproveAllBatch(new StubPayoutSender());
    expect(r.senderKind).toBe('stub');
    expect(r.paid).toEqual([]);
    expect(r.failed).toEqual([{ code: 'PAYERA', reason: 'payout_sender_not_configured' }]);
    expect((await detectPayoutBatch()).due.map((p) => p.code)).toContain('PAYERA'); // not paid
  });
});

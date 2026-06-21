/**
 * REFERRAL-PAYOUT-OPS-W1 / C2 — referral payout batch: detection, the monthly
 * operator digest, and the Approve-all execution orchestration.
 *
 * The on-chain SEND is a pluggable `PayoutSender`: C2 ships a `StubPayoutSender`
 * (so this module + the Approve-all route ship and are testable WITHOUT a CDP
 * wallet — Stub-first deploy), and C3 adds `CdpPayoutSender` + wires the factory.
 * This module does NOT touch accrual math (frozen in referral-accrual.ts).
 */
import { REFERRAL_TERMS, formatUsdE2, payoutScheduleLabel } from './referral-constants.js';
import { pendingPayouts, getLedgerById, markLedger, type PendingPayout } from './referral-store.js';
import { maskEmail, sendPayoutPaidEmail } from './email.js';

const ADMIN_PAYOUTS_URL = 'https://api.algovault.com/admin/referrals/payouts';

export interface PayoutBatch {
  /** Referrers whose pending total >= the min payout threshold. */
  due: PendingPayout[];
  totalUsdE2: number;
  withAddress: number;
  withoutAddress: number;
}

/**
 * Detect the ≥-threshold batch. Under-threshold referrers carry forward automatically
 * — pendingPayouts() only returns codes whose pending total >= the min, so the rest
 * stay usdc_pending and roll into a later month.
 */
export async function detectPayoutBatch(): Promise<PayoutBatch> {
  const due = await pendingPayouts(REFERRAL_TERMS.USDC_MIN_PAYOUT_USD);
  let totalUsdE2 = 0;
  let withAddress = 0;
  let withoutAddress = 0;
  for (const p of due) {
    totalUsdE2 += p.pending_usd_e2;
    if (p.payout_address) withAddress++;
    else withoutAddress++;
  }
  return { due, totalUsdE2, withAddress, withoutAddress };
}

/**
 * Build the operator digest sections for a batch (empty array if nothing is due —
 * the cron suppresses-on-empty). Sent via the in-container sendDigest (NOT the host
 * send_telegram.sh, which is CRITICAL-severity-gated and would suppress this).
 */
export function formatBatchDigest(batch: PayoutBatch): string[] {
  if (batch.due.length === 0) return [];
  const lines = batch.due.map((p) => {
    const who = p.owner_label || (p.owner_email ? maskEmail(p.owner_email) : p.code);
    const addr = p.payout_address ? '✓ addr' : '⚠ NO addr';
    return `• ${p.code} (${who}) — ${formatUsdE2(p.pending_usd_e2)} · ${addr}`;
  });
  const header = `💸 *Referral payouts due* — ${batch.due.length} referrer(s), ${formatUsdE2(batch.totalUsdE2)} total`;
  const missing = batch.withoutAddress > 0
    ? `\n⚠ ${batch.withoutAddress} missing a payout address (skipped until they add one).`
    : '';
  const foot = `Approve all ${payoutScheduleLabel()}: ${ADMIN_PAYOUTS_URL}${missing}`;
  return [header, lines.join('\n'), foot];
}

// ── PayoutSender abstraction (C2 = Stub; C3 = CdpPayoutSender) ──
export interface PayoutResult {
  txRef: string;
}
export interface PayoutSender {
  readonly kind: string;
  /** Send `amountUsdE2` integer-cents of USDC on Base to `toAddress`. Resolves with
   *  the on-chain tx hash, or throws (the row stays usdc_pending → resumes next run). */
  send(toAddress: string, amountUsdE2: number): Promise<PayoutResult>;
}

/**
 * No-op sender used until the CDP server wallet is provisioned (C3 swaps in the real
 * one via the factory). Throws so the orchestration records the row as NOT sent —
 * nothing is marked paid and no money moves.
 */
export class StubPayoutSender implements PayoutSender {
  readonly kind = 'stub';
  async send(): Promise<PayoutResult> {
    throw new Error('payout_sender_not_configured');
  }
}

/**
 * Factory — returns the real CDP server-wallet sender when configured, else the Stub.
 * C2 always returns the Stub; C3 adds the CDP creds check + CdpPayoutSender here.
 */
export function getPayoutSender(): PayoutSender {
  return new StubPayoutSender();
}

export interface BatchExecutionResult {
  senderKind: string;
  attempted: number;
  paid: Array<{ code: string; amountUsdE2: number; txRef: string }>;
  skippedNoAddress: string[];
  skippedAlreadyPaid: number[];
  failed: Array<{ code: string; reason: string }>;
  totalPaidUsdE2: number;
}

/**
 * Execute the operator's Approve-all: for each due referrer WITH an address, sum its
 * still-pending ledger rows and send ONE USDC-on-Base payment via the PayoutSender,
 * then mark those rows usdc_paid (same tx_ref) and email the referrer.
 *
 * Safety / idempotency:
 *  - Each ledger row's CURRENT status is re-read before sending — already-paid rows
 *    are skipped, so a replay or a partial-batch retry never double-sends.
 *  - A send failure leaves that referrer's rows usdc_pending (clean resume next run).
 *  - `maxBatchUsdE2` is an optional running ceiling (C3 supplies the env value); a
 *    referrer that would breach it is recorded as failed (batch_cap_reached), not sent.
 *  - The per-tx cap lives in the sender (C3's CdpPayoutSender), which throws over-cap.
 */
export async function executeApproveAllBatch(
  sender: PayoutSender,
  opts?: { maxBatchUsdE2?: number; dryRun?: boolean },
): Promise<BatchExecutionResult> {
  const batch = await detectPayoutBatch();
  const res: BatchExecutionResult = {
    senderKind: sender.kind,
    attempted: 0,
    paid: [],
    skippedNoAddress: [],
    skippedAlreadyPaid: [],
    failed: [],
    totalPaidUsdE2: 0,
  };
  const maxBatch = opts?.maxBatchUsdE2 ?? Infinity;
  let spentE2 = 0;

  for (const p of batch.due) {
    if (!p.payout_address) {
      res.skippedNoAddress.push(p.code);
      continue;
    }
    // Re-read each row's CURRENT status (replay-safe: only still-pending rows are payable).
    const payableIds: number[] = [];
    let payableE2 = 0;
    for (const id of p.ledger_ids) {
      const row = await getLedgerById(id);
      if (row && row.status === 'usdc_pending') {
        payableIds.push(id);
        payableE2 += row.commission_usd_e2;
      } else {
        res.skippedAlreadyPaid.push(id);
      }
    }
    if (payableIds.length === 0) continue;
    if (spentE2 + payableE2 > maxBatch) {
      res.failed.push({ code: p.code, reason: 'batch_cap_reached' });
      continue;
    }
    res.attempted++;
    if (opts?.dryRun) {
      res.paid.push({ code: p.code, amountUsdE2: payableE2, txRef: 'DRY_RUN' });
      res.totalPaidUsdE2 += payableE2;
      spentE2 += payableE2;
      continue;
    }
    try {
      const { txRef } = await sender.send(p.payout_address, payableE2);
      for (const id of payableIds) markLedger(id, 'usdc_paid', txRef);
      spentE2 += payableE2;
      res.totalPaidUsdE2 += payableE2;
      res.paid.push({ code: p.code, amountUsdE2: payableE2, txRef });
      if (p.owner_email) {
        // Email failure is non-fatal — the payment is already recorded on-chain + in the ledger.
        try {
          await sendPayoutPaidEmail(p.owner_email, payableE2, txRef);
        } catch (e) {
          console.error(`[referral-payout] paid-email failed for ${p.code}:`, e instanceof Error ? e.message : e);
        }
      }
    } catch (err) {
      res.failed.push({ code: p.code, reason: err instanceof Error ? err.message : 'send_failed' });
    }
  }
  return res;
}

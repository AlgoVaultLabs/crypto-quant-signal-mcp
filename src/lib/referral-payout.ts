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
import {
  pendingPayouts,
  getLedgerById,
  markLedgerAsync,
  tryClaimLedgerForPayout,
  releaseLedgerPayoutClaim,
  type PendingPayout,
} from './referral-store.js';
import { randomUUID } from 'node:crypto';
import { maskEmail, sendPayoutPaidEmail } from './email.js';
import { cdpPayoutConfigured } from './payout-config.js';

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
 * Factory — returns the real CDP server-wallet sender when all three CDP creds are
 * present (incl. the signing CDP_WALLET_SECRET), else the Stub. The CDP SDK is
 * lazy-imported ONLY when configured, so the Stub / cron / detection paths never load
 * the heavy SDK. Async because of that lazy import.
 */
export async function getPayoutSender(): Promise<PayoutSender> {
  if (cdpPayoutConfigured()) {
    const { CdpPayoutSender } = await import('./cdp-payout.js');
    return new CdpPayoutSender();
  }
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
 * Safety / idempotency (SEC-16, OPS-AUDIT-REMEDIATION-MEDIUM-W1 / Ch2):
 *  - Every payable row is ATOMICALLY CLAIMED before any send. This docstring previously
 *    asserted that re-reading `status` made a replay safe; it did not. Read-then-send
 *    with no claim between is a TOCTOU: the handler awaits `waitForUserOperation` per
 *    referrer, so a browser resubmit or a second admin tab re-entered this function
 *    mid-flight, BOTH runs saw `usdc_pending`, and BOTH called `sender.send` — paying
 *    the referrer twice, on-chain, unrecoverably. The claim is a row in
 *    `referral_payout_claims` taken via INSERT … ON CONFLICT DO NOTHING RETURNING, so
 *    the database picks exactly one winner.
 *  - The claim is ALSO the durable "already sent" marker, independent of the status
 *    column. If a send succeeds but the mark-paid write is lost, the claim survives and
 *    the next Approve-all skips the row instead of paying it again.
 *  - Mark-paid is now AWAITED (`markLedgerAsync`): a lost write raises instead of
 *    silently re-queueing a row whose money has already moved.
 *  - A send FAILURE releases the claim, so the rows stay usdc_pending and resume
 *    cleanly next run. This preserves the PayoutSender contract declared above — a
 *    throw means no transfer was broadcast.
 *  - `maxBatchUsdE2` is an optional running ceiling (C3 supplies the env value); a
 *    referrer that would breach it is recorded as failed (batch_cap_reached), not sent,
 *    and its claims are released.
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
  // Per-RUN identity. Two concurrent Approve-alls get different refs, so a release can
  // only ever remove a claim this run actually took — never another run's in-flight one.
  const runRef = randomUUID();

  for (const p of batch.due) {
    if (!p.payout_address) {
      res.skippedNoAddress.push(p.code);
      continue;
    }
    const claimRef = `${runRef}:${p.code}`;
    // Re-read each row's CURRENT status, then ATOMICALLY CLAIM it. The status re-read
    // alone is a TOCTOU (SEC-16) — the claim is what makes a concurrent run a no-op.
    const payableIds: number[] = [];
    let payableE2 = 0;
    for (const id of p.ledger_ids) {
      const row = await getLedgerById(id);
      if (!row || row.status !== 'usdc_pending') {
        res.skippedAlreadyPaid.push(id);
        continue;
      }
      if (!(await tryClaimLedgerForPayout(id, claimRef))) {
        // Another run (or an earlier successful send whose mark-paid write was lost)
        // owns this row. Never send for it.
        res.skippedAlreadyPaid.push(id);
        continue;
      }
      payableIds.push(id);
      payableE2 += row.commission_usd_e2;
    }
    if (payableIds.length === 0) continue;
    if (spentE2 + payableE2 > maxBatch) {
      await releaseClaims(payableIds, claimRef);
      res.failed.push({ code: p.code, reason: 'batch_cap_reached' });
      continue;
    }
    res.attempted++;
    if (opts?.dryRun) {
      // Nothing was sent, so the claims must not persist — a dry run must leave the
      // queue exactly as it found it.
      await releaseClaims(payableIds, claimRef);
      res.paid.push({ code: p.code, amountUsdE2: payableE2, txRef: 'DRY_RUN' });
      res.totalPaidUsdE2 += payableE2;
      spentE2 += payableE2;
      continue;
    }
    try {
      const { txRef } = await sender.send(p.payout_address, payableE2);
      // AWAITED: a lost mark-paid write must raise, not silently re-queue a paid row.
      // If it does raise, the claim deliberately STAYS — the money moved, so the row
      // must never be picked up again; it surfaces as skippedAlreadyPaid next run.
      for (const id of payableIds) await markLedgerAsync(id, 'usdc_paid', txRef);
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
      // No transfer was broadcast (PayoutSender contract), so release the claims and
      // let the rows resume next run. This is the "no claimed-but-unsent black hole"
      // path — without it a transient sender error would strand the referrer forever.
      await releaseClaims(payableIds, claimRef);
      res.failed.push({ code: p.code, reason: err instanceof Error ? err.message : 'send_failed' });
    }
  }
  return res;
}

/** Best-effort claim release. A failure here must never mask the original outcome. */
async function releaseClaims(ledgerIds: number[], claimRef: string): Promise<void> {
  for (const id of ledgerIds) {
    try {
      await releaseLedgerPayoutClaim(id, claimRef);
    } catch (err) {
      console.error(`[referral-payout] claim release failed for ledger ${id}:`, err instanceof Error ? err.message : err);
    }
  }
}

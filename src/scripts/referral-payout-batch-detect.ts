/**
 * REFERRAL-PAYOUT-OPS-W1 / C2 — monthly payout-batch detector (the 1st, off-:00).
 *
 * Runs in-container; gathers every referrer with usdc_pending >= the min threshold
 * into ONE operator digest sent via the in-container sendDigest (NOT the host
 * send_telegram.sh — that wrapper is CRITICAL-severity-gated and would suppress this
 * scheduled, non-emergency notice; sendDigest is the operator-digest path used by
 * geo-weekly-cron / chat-analytics-digest). Suppress-on-empty (no batch → no message).
 *
 *   cron (host): 7 8 1 * *  docker exec <ctr> node dist/scripts/referral-payout-batch-detect.js
 *   flags:       --dry-run   print the digest, send nothing
 *
 * Detection only — it never sends money. The operator acts via the Approve-all button
 * on /admin/referrals/payouts (which triggers the C3 CDP batch send).
 */
import { detectPayoutBatch, formatBatchDigest } from '../lib/referral-payout.js';
import { usdcMinPayoutLabel } from '../lib/referral-constants.js';
import { sendDigest } from '../lib/telegram.js';

export async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const batch = await detectPayoutBatch();
  const sections = formatBatchDigest(batch);
  const stamp = new Date().toISOString();

  if (sections.length === 0) {
    console.log(`[referral-payout-batch] ${stamp}: no referrers >= ${usdcMinPayoutLabel()} pending — suppress-on-empty.`);
    return;
  }
  if (dryRun) {
    console.log('--- referral-payout-batch dry-run ---');
    console.log(sections.join('\n\n'));
    console.log('--- end dry-run ---');
    console.log(`[meta] due=${batch.due.length} totalUsdE2=${batch.totalUsdE2} withAddress=${batch.withAddress} withoutAddress=${batch.withoutAddress}`);
    return;
  }
  const ok = await sendDigest(sections);
  if (ok) {
    console.log(`[referral-payout-batch] ${stamp}: digest sent — ${batch.due.length} due, ${batch.withoutAddress} missing address`);
  } else {
    console.error(`[referral-payout-batch] ${stamp}: digest send failed (check TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)`);
    process.exitCode = 1;
  }
}

// Test-importable: only auto-run when invoked as the entry point (require.main idiom).
const argv1 = process.argv[1] ?? '';
if (argv1.endsWith('referral-payout-batch-detect.js') || argv1.endsWith('referral-payout-batch-detect.ts')) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

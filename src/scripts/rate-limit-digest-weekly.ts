#!/usr/bin/env tsx
/**
 * rate-limit-digest-weekly.ts — OPS-TELEMETRY-DIGEST-REFRAME-W1 weekly Telegram digest.
 *
 * Thin entrypoint. All logic lives in `src/lib/rate-limit-digest.ts` so it stays
 * test-importable per CLAUDE.md (mirrors geo-weekly-cron.ts → geo-digest.ts).
 *
 * Renders the 7d per-venue rate-limit telemetry (throws / waits / skips, HL
 * batch-wait p95, HL per-caller throw attribution) plus the two denial-based
 * trigger lines, and sends it to the operator Telegram chat.
 *
 * Renamed from `shadow-digest-weekly.ts`, which also carried a 1m/3m
 * "should we publish these timeframes?" verdict — a decision settled on both
 * sides long before (3m public via SHADOW_REVEAL_TIMEFRAMES; 1m seed cron
 * retired by OPS-1M-SEED-DECOM-W1). That section is gone; see the lib module
 * header for the full rationale.
 *
 * Usage:
 *   npx tsx src/scripts/rate-limit-digest-weekly.ts            (live cron mode — sends to Telegram)
 *   npx tsx src/scripts/rate-limit-digest-weekly.ts --dry-run  (formats + prints to stdout, no Telegram send)
 *
 * Cron (Hetzner crontab):
 *   0 0 * * 0 docker exec crypto-quant-signal-mcp-mcp-server-1 node dist/scripts/rate-limit-digest-weekly.js >> /var/log/shadow-digest.log 2>&1
 */

import { closeDb } from '../lib/performance-db.js';
import { sendDigest } from '../lib/telegram.js';
import { buildDigest } from '../lib/rate-limit-digest.js';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const { text, sections } = await buildDigest();
  if (dryRun) {
    console.log('--- rate-limit-digest dry-run output ---');
    console.log(text);
    console.log('--- end dry-run ---');
  } else {
    const ok = await sendDigest(sections);
    if (ok) {
      console.log(`[rate-limit-digest] ${new Date().toISOString()}: digest sent to Telegram`);
    } else {
      console.error(`[rate-limit-digest] ${new Date().toISOString()}: digest send failed (check TELEGRAM_BOT_TOKEN/CHAT_ID env)`);
      process.exitCode = 1;
    }
  }
  closeDb();
}

main().catch((err) => {
  console.error('Fatal:', err);
  closeDb();
  process.exit(1);
});

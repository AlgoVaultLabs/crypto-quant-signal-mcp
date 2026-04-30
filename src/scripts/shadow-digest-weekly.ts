#!/usr/bin/env tsx
/**
 * shadow-digest-weekly.ts — SHADOW-SEED-W1 weekly Telegram digest.
 *
 * Queries the `signals` table for the last 7 days of `1m` + `3m` signals,
 * computes aggregate PFE Win Rate + sample size + per-coin breakdown, and
 * formats a Telegram message to Mr.1's chat. Cron entry: Sunday 00:00 UTC.
 *
 * Decision threshold (per spec): PFE WR ≥85% AND samples ≥3000 per TF.
 *   - PASS → candidate for public-flip via `SHADOW_REVEAL_TIMEFRAMES=<TF>`
 *   - FAIL → keep shadow-filtering; reassess next week
 *
 * Usage:
 *   npx tsx src/scripts/shadow-digest-weekly.ts            (live cron mode — sends to Telegram)
 *   npx tsx src/scripts/shadow-digest-weekly.ts --dry-run  (formats + prints to stdout, no Telegram send)
 *
 * Cron (Hetzner crontab):
 *   0 0 * * 0 docker exec crypto-quant-signal-mcp-mcp-server-1 node dist/scripts/shadow-digest-weekly.js >> /var/log/shadow-digest.log 2>&1
 */

import { dbQuery, closeDb } from '../lib/performance-db.js';
import { sendDigest } from '../lib/telegram.js';

const SHADOW_TIMEFRAMES = ['1m', '3m'] as const;
const PFE_WR_THRESHOLD = 0.85;
const SAMPLE_THRESHOLD = 3000;

interface PerCoin {
  coin: string;
  samples: number;
  pfeWr: number | null;
}

interface TfDigest {
  timeframe: string;
  samples: number;
  pfeWr: number | null;
  buyPfeWr: number | null;
  sellPfeWr: number | null;
  topPerformers: PerCoin[];   // top 3 by pfeWr (min 5 samples)
  bottomPerformers: PerCoin[]; // bottom 3 by pfeWr (min 5 samples)
}

interface SignalRow {
  coin: string;
  signal: 'BUY' | 'SELL' | 'HOLD';
  pfe_return_pct: number | null;
}

function fmtPct(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return '—';
  return `${(p * 100).toFixed(1)}%`;
}

function pfeWrFor(rows: SignalRow[]): number | null {
  const evaluable = rows.filter(
    (r) => r.signal !== 'HOLD' && r.pfe_return_pct != null && Number.isFinite(r.pfe_return_pct),
  );
  if (evaluable.length === 0) return null;
  const wins = evaluable.filter((r) => {
    const pfe = r.pfe_return_pct ?? 0;
    return r.signal === 'BUY' ? pfe > 0 : pfe < 0;
  });
  return wins.length / evaluable.length;
}

async function digestForTimeframe(timeframe: string): Promise<TfDigest> {
  // Last 7 days, only signals with computed PFE outcome (i.e. eval window
  // elapsed and outcome backfilled).
  const sql = `
    SELECT coin, signal, pfe_return_pct
    FROM signals
    WHERE timeframe = $1
      AND created_at > EXTRACT(EPOCH FROM NOW() - INTERVAL '7 days')
      AND signal != 'HOLD'
  `;
  const rows = await dbQuery<SignalRow>(sql, [timeframe]);
  const samples = rows.length;
  const pfeWr = pfeWrFor(rows);
  const buyPfeWr = pfeWrFor(rows.filter((r) => r.signal === 'BUY'));
  const sellPfeWr = pfeWrFor(rows.filter((r) => r.signal === 'SELL'));

  // Per-coin breakdown
  const byCoin = new Map<string, SignalRow[]>();
  for (const r of rows) {
    if (!byCoin.has(r.coin)) byCoin.set(r.coin, []);
    byCoin.get(r.coin)!.push(r);
  }
  const perCoin: PerCoin[] = [];
  for (const [coin, coinRows] of byCoin) {
    if (coinRows.length < 5) continue; // skip thin samples
    perCoin.push({ coin, samples: coinRows.length, pfeWr: pfeWrFor(coinRows) });
  }
  perCoin.sort((a, b) => (b.pfeWr ?? 0) - (a.pfeWr ?? 0));
  const topPerformers = perCoin.slice(0, 3);
  const bottomPerformers = perCoin.slice(-3).reverse();

  return { timeframe, samples, pfeWr, buyPfeWr, sellPfeWr, topPerformers, bottomPerformers };
}

function verdictFor(d: TfDigest): 'PASS' | 'FAIL' | 'INSUFFICIENT_DATA' {
  if (d.samples < SAMPLE_THRESHOLD) return 'INSUFFICIENT_DATA';
  if (d.pfeWr === null || d.pfeWr < PFE_WR_THRESHOLD) return 'FAIL';
  return 'PASS';
}

function formatTfBlock(d: TfDigest): string {
  const top = d.topPerformers
    .map((p) => `${p.coin}/${fmtPct(p.pfeWr)}`)
    .join(' ');
  const bot = d.bottomPerformers
    .map((p) => `${p.coin}/${fmtPct(p.pfeWr)}`)
    .join(' ');
  return [
    `*${d.timeframe}*: ${d.samples.toLocaleString()} samples, PFE WR ${fmtPct(d.pfeWr)} ` +
    `(BUY: ${fmtPct(d.buyPfeWr)}, SELL: ${fmtPct(d.sellPfeWr)})`,
    top ? `   Top: ${top}` : '   Top: (no coins ≥5 samples)',
    bot ? `   Bottom: ${bot}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function buildDigest(): Promise<{ text: string; sections: string[]; perTfVerdicts: Record<string, string> }> {
  const weekEnding = new Date().toISOString().slice(0, 10);
  const digests = await Promise.all(SHADOW_TIMEFRAMES.map((tf) => digestForTimeframe(tf)));
  const verdicts: Record<string, string> = {};
  for (const d of digests) verdicts[d.timeframe] = verdictFor(d);

  const sections = [
    `📊 *SHADOW-SEED WEEKLY DIGEST* (week ending ${weekEnding})`,
    '',
    ...digests.map(formatTfBlock),
    '',
    `*Decision threshold*: PFE WR ≥${(PFE_WR_THRESHOLD * 100).toFixed(0)}% AND samples ≥${SAMPLE_THRESHOLD.toLocaleString()} per TF`,
    ...digests.map((d) => `*${d.timeframe} verdict*: ${verdicts[d.timeframe]}`),
  ];
  return { text: sections.join('\n'), sections, perTfVerdicts: verdicts };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const { text, sections } = await buildDigest();
  if (dryRun) {
    console.log('--- shadow-digest dry-run output ---');
    console.log(text);
    console.log('--- end dry-run ---');
  } else {
    const ok = await sendDigest(sections);
    if (ok) {
      console.log(`[shadow-digest] ${new Date().toISOString()}: digest sent to Telegram`);
    } else {
      console.error(`[shadow-digest] ${new Date().toISOString()}: digest send failed (check TELEGRAM_BOT_TOKEN/CHAT_ID env)`);
      process.exitCode = 1;
    }
  }
  closeDb();
}

// Only run main when invoked as a script. The named export `buildDigest` is
// importable by tests + dry-run wrappers without triggering side effects.
const isMain = process.argv[1] && process.argv[1].endsWith('shadow-digest-weekly.js') ||
               process.argv[1] && process.argv[1].endsWith('shadow-digest-weekly.ts');
if (isMain) {
  main().catch((err) => {
    console.error('Fatal:', err);
    closeDb();
    process.exit(1);
  });
}

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

// ── Rate-limit telemetry section (OPS-RATELIMIT-TELEMETRY-DIGEST-W1 R3) ──
// One durable event stream (rate_limit_events) → a per-venue 7d summary + the two
// deferred self-watching triggers. NOT an alert path (digest section only); the
// trigger lines emit the template form OPS-<CLASS>-W{NEXT} (operator/Cowork resolves
// the number at dispatch — literal wave numbers are forbidden per CLAUDE.md).

const PROMOTED_VENUE_NAMES = ['Hyperliquid', 'Binance', 'Bybit', 'OKX', 'Bitget'];
const HL_VENUE_NAME = 'Hyperliquid';
const SHADOW_THROW_TRIGGER = 3;            // ≥3 typed throws/7d on ANY non-promoted (shadow) venue
const HL_INTERACTIVE_THROW_TRIGGER = 25;   // "sustained" HL interactive (budget self-throttle) throws/7d — tunable
const HL_WAIT_P95_TRIGGER_MS = 20_000;     // HL batch-wait p95 > 20s

interface VenueRl { venue: string; throws: number; waits: number; skips: number; iThrows: number; bThrows: number; }

/** p95 of a sample (backend-agnostic; avoids PG-only percentile_cont so the trigger logic is pure-testable). */
export function p95(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1))];
}

/**
 * PURE trigger evaluation — unit-tested both sides of each threshold (R4). Emits a
 * `dispatch OPS-…-W{NEXT}` line ONLY when a threshold trips; silent otherwise.
 */
export function evaluateRateLimitTriggers(
  perVenue: VenueRl[],
  hlWaitP95Ms: number,
): { lines: string[]; shadowBudget: boolean; hlWebsocket: boolean } {
  const lines: string[] = [];
  const shadowHit = perVenue.find((v) => !PROMOTED_VENUE_NAMES.includes(v.venue) && v.throws >= SHADOW_THROW_TRIGGER);
  const hl = perVenue.find((v) => v.venue === HL_VENUE_NAME);
  const hlInteractive = hl?.iThrows ?? 0;
  const shadowBudget = !!shadowHit;
  const hlWebsocket = hlInteractive >= HL_INTERACTIVE_THROW_TRIGGER || hlWaitP95Ms > HL_WAIT_P95_TRIGGER_MS;
  if (shadowBudget) {
    lines.push(`⚠️ ${shadowHit!.venue}: ${shadowHit!.throws} throws/7d (≥${SHADOW_THROW_TRIGGER}) — Action: dispatch OPS-SHADOW-BUDGET-W{NEXT} via Cowork → Claude Code`);
  }
  if (hlWebsocket) {
    // OPS-RATELIMIT-TIDYUP-W1: action REDIRECTED off the cancelled `OPS-HL-WEBSOCKET-W{NEXT}`
    // wave (CANCELLED — OPS-HL-BACKFILL-BATCH-W1 proved the HL saturation was historical-candle
    // backfill-on-read, not live demand; a websocket can't fetch post-signal candles) to a
    // driver-agnostic line. Lesson encoded: never blind-recommend a structural fix — attribute
    // via the per-caller breakdown first. Threshold/mechanism unchanged (the batch-wait p95>20s
    // condition now false-positives on by-design batch waits → OPS-RATELIMIT-DIGEST-THRESHOLD-
    // RECAL-W{NEXT}, NOT retuned in this tidy-up).
    lines.push(`⚠️ HL: ${hlInteractive} interactive throws/7d, batch-wait p95 ${(hlWaitP95Ms / 1000).toFixed(1)}s — Action: investigate the HL interactive driver via the per-caller breakdown above (attribute first; do NOT prescribe a structural wave blind)`);
  }
  return { lines, shadowBudget, hlWebsocket };
}

/** Aggregate the raw count rows into per-venue totals (pure; testable with synthetic rows). */
export function aggregateRateLimit(counts: { venue: string; kind: string; class: string; n: number }[]): VenueRl[] {
  const byVenue = new Map<string, VenueRl>();
  for (const c of counts) {
    const v = byVenue.get(c.venue) ?? { venue: c.venue, throws: 0, waits: 0, skips: 0, iThrows: 0, bThrows: 0 };
    if (c.kind === 'throw') { v.throws += c.n; if (c.class === 'interactive') v.iThrows += c.n; else v.bThrows += c.n; }
    else if (c.kind === 'wait') v.waits += c.n;
    else if (c.kind === 'skip') v.skips += c.n;
    byVenue.set(c.venue, v);
  }
  return [...byVenue.values()].sort((a, b) => b.throws - a.throws);
}

/**
 * Top callers by throw count for a venue (pure; testable with synthetic rows).
 * OPS-RATELIMIT-CALLER-ATTRIBUTION-W1 R4 — self-pins the HL interactive-demand driver
 * in the weekly digest so the websocket scope is visible without a manual query.
 */
export function aggregateCallers(rows: { caller: string; n: number }[], topN = 5): { caller: string; n: number }[] {
  const byCaller = new Map<string, number>();
  for (const r of rows) byCaller.set(r.caller, (byCaller.get(r.caller) ?? 0) + r.n);
  return [...byCaller.entries()]
    .map(([caller, n]) => ({ caller, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, topN);
}

async function buildRateLimitSection(): Promise<string[]> {
  const header = ['', '⚡ *Rate-limit telemetry (7d)*'];
  try {
    const rawCounts = await dbQuery<{ venue: string; kind: string; class: string; n: string }>(
      `SELECT venue, kind, class, COUNT(*)::text AS n
         FROM rate_limit_events
        WHERE ts > NOW() - INTERVAL '7 days'
        GROUP BY venue, kind, class`,
      [],
    );
    const hlWaits = await dbQuery<{ wait_ms: number }>(
      `SELECT wait_ms FROM rate_limit_events
        WHERE ts > NOW() - INTERVAL '7 days' AND venue = $1 AND kind = 'wait' AND class = 'batch' AND wait_ms IS NOT NULL`,
      [HL_VENUE_NAME],
    );
    // R4 — per-caller HL throw attribution (the OPS-RATELIMIT-CALLER-ATTRIBUTION-W1 payoff).
    const hlCallerRows = await dbQuery<{ caller: string; n: string }>(
      `SELECT caller, COUNT(*)::text AS n
         FROM rate_limit_events
        WHERE ts > NOW() - INTERVAL '7 days' AND venue = $1 AND kind = 'throw'
        GROUP BY caller`,
      [HL_VENUE_NAME],
    );
    const perVenue = aggregateRateLimit(rawCounts.map((c) => ({ ...c, n: Number(c.n) })));
    const hlWaitP95Ms = p95(hlWaits.map((r) => Number(r.wait_ms)));
    const hlTopCallers = aggregateCallers(hlCallerRows.map((c) => ({ caller: c.caller, n: Number(c.n) })));

    const body = perVenue.length === 0
      ? ['   (no rate-limit events — all venues healthy)']
      : [
          ...perVenue.map((v) => `   *${v.venue}*: ${v.throws} throws (i:${v.iThrows}/b:${v.bThrows}), ${v.waits} waits, ${v.skips} skips`),
          ...(perVenue.some((v) => v.venue === HL_VENUE_NAME) ? [`   HL batch-wait p95: ${(hlWaitP95Ms / 1000).toFixed(1)}s`] : []),
          ...(hlTopCallers.length ? [`   HL throw drivers (by caller, 7d): ${hlTopCallers.map((c) => `${c.caller} (${c.n})`).join(', ')}`] : []),
        ];
    const { lines } = evaluateRateLimitTriggers(perVenue, hlWaitP95Ms);
    return [...header, ...body, ...(lines.length ? ['', ...lines] : [])];
  } catch (e) {
    // Fail-open: a telemetry-query failure must never break the weekly digest.
    return [...header, `   (rate-limit telemetry unavailable: ${e instanceof Error ? e.message : e})`];
  }
}

export async function buildDigest(): Promise<{ text: string; sections: string[]; perTfVerdicts: Record<string, string> }> {
  const weekEnding = new Date().toISOString().slice(0, 10);
  const digests = await Promise.all(SHADOW_TIMEFRAMES.map((tf) => digestForTimeframe(tf)));
  const verdicts: Record<string, string> = {};
  for (const d of digests) verdicts[d.timeframe] = verdictFor(d);

  const rateLimitSection = await buildRateLimitSection();
  const sections = [
    `📊 *SHADOW-SEED WEEKLY DIGEST* (week ending ${weekEnding})`,
    '',
    ...digests.map(formatTfBlock),
    '',
    `*Decision threshold*: PFE WR ≥${(PFE_WR_THRESHOLD * 100).toFixed(0)}% AND samples ≥${SAMPLE_THRESHOLD.toLocaleString()} per TF`,
    ...digests.map((d) => `*${d.timeframe} verdict*: ${verdicts[d.timeframe]}`),
    ...rateLimitSection,
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

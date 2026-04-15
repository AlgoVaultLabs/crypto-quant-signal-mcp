#!/usr/bin/env npx tsx
/**
 * Activation funnel snapshot writer.
 *
 * Runs generateFunnelSnapshot(), formats the result into a dated .md report,
 * and writes both <YYYY-MM-DD>-<tag>.md and <YYYY-MM-DD>-<tag>.json to
 * activation-funnel/snapshots/ (or whatever --output-dir points at).
 *
 * CLI:
 *   npx tsx scripts/write-funnel-snapshot.ts --tag auto
 *   npx tsx scripts/write-funnel-snapshot.ts --tag manual --days 30
 *   npx tsx scripts/write-funnel-snapshot.ts --tag dryrun --stdout
 *   npx tsx scripts/write-funnel-snapshot.ts --tag dryrun --stdout --output-dir /tmp
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateFunnelSnapshot, type FunnelSnapshot } from './funnel-snapshot.js';
import { closeDb } from '../src/lib/performance-db.js';

// ── Types ──

interface WriteOptions {
  tag: string;
  outputDir: string;
  days?: number;
  since?: string;
  until?: string;
  stdout: boolean;
}

/**
 * Baseline is the 2026-04-15 funnel snapshot captured by the analytics-funnel-snapshot
 * task (see activation-funnel/snapshots/2026-04-15-baseline.json). Its JSON schema
 * predates `FunnelSnapshot` — it's a loosely-typed dump of raw query results from
 * multiple sources (NPM, analytics endpoint, postgres, Stripe, Blockscout). We
 * extract or hardcode the specific numbers that appear in the Δ-vs-baseline columns.
 *
 * The hardcoded values (1269 installs, 5.6% stick, 88.2% HOLD) match the truth-of-record
 * for the baseline window — the team-lead spec lists them as hardcoded reference points
 * and they're what future deltas should be measured against.
 */
interface Baseline {
  install: number | null;
  first_call: number | null;
  second_call: number | null;
  fifth_plus_call: number | null;
  paid_upgrade: number | null;
  stick_rate: number | null;
  hold_rate_get_trade_signal: number | null;
  first_to_second: number | null;
  second_to_fifth: number | null;
  fifth_to_paid: number | null;
}

// ── Baseline loader ──

const BASELINE_FILENAME = '2026-04-15-baseline.json';

function loadBaseline(outputDir: string): Baseline | null {
  const baselinePath = path.join(outputDir, BASELINE_FILENAME);
  if (!fs.existsSync(baselinePath)) return null;

  // Hardcoded truth-of-record values per team-lead spec. We parse the raw
  // baseline JSON to extract any values that are present, and fall back to
  // these canonical numbers for the fields that don't exist in the old schema.
  const HARDCODED: Baseline = {
    install: 1269, // NPM last-month total
    first_call: 18, // 18 distinct sessions in baseline window
    second_call: 7, // 6 in "2-5" bucket + 1 in "6-20" bucket
    fifth_plus_call: 1, // only the "6-20" bucket guarantees ≥5 calls
    paid_upgrade: 0, // zero paid conversions — Stripe subscriptions list was empty
    stick_rate: 0.056, // 5.6% — matches team-lead spec
    hold_rate_get_trade_signal: 0.882, // 88.24% rounded to 88.2
    first_to_second: 7 / 18, // ≈ 0.389
    second_to_fifth: 1 / 7, // ≈ 0.143
    fifth_to_paid: 0, // 0/1
  };

  try {
    const raw = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as Record<string, unknown>;
    // If the baseline was already emitted in the new FunnelSnapshot schema,
    // prefer its values. Otherwise keep the HARDCODED constants above.
    if (isFunnelSnapshot(raw)) {
      const snap = raw as unknown as FunnelSnapshot;
      return {
        install: snap.funnel.install,
        first_call: snap.funnel.first_call,
        second_call: snap.funnel.second_call,
        fifth_plus_call: snap.funnel.fifth_plus_call,
        paid_upgrade: snap.funnel.paid_upgrade,
        stick_rate: snap.stick_rate,
        hold_rate_get_trade_signal: snap.hold_rate_get_trade_signal,
        first_to_second: snap.conversion.first_to_second,
        second_to_fifth: snap.conversion.second_to_fifth,
        fifth_to_paid: snap.conversion.fifth_to_paid,
      };
    }
    return HARDCODED;
  } catch {
    // Corrupt or unreadable baseline — show "—" via the null path
    return null;
  }
}

function isFunnelSnapshot(raw: Record<string, unknown>): boolean {
  return (
    typeof raw === 'object'
    && raw !== null
    && 'funnel' in raw
    && 'conversion' in raw
    && 'tool_call_distribution' in raw
  );
}

// ── Formatters ──

function fmtInt(n: number | null): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('en-US');
}

function fmtPct(n: number | null, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

function fmtMs(n: number | null): string {
  if (n === null || n === undefined) return '—';
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  if (n < 3_600_000) return `${(n / 60_000).toFixed(1)}m`;
  return `${(n / 3_600_000).toFixed(1)}h`;
}

function deltaInt(current: number | null, baseline: number | null): string {
  if (current === null || baseline === null) return '—';
  const d = current - baseline;
  const sign = d > 0 ? '+' : '';
  return `${sign}${d.toLocaleString('en-US')}`;
}

function deltaPct(current: number | null, baseline: number | null): string {
  if (current === null || baseline === null) return '—';
  const d = (current - baseline) * 100;
  const sign = d > 0 ? '+' : '';
  return `${sign}${d.toFixed(1)}pp`;
}

// ── Lever attribution ──
// Truth-of-record: L2/L3/L4 went live at the post-hotfix container restart
// 2026-04-15T11:16:53Z. L1 (signal performance resource) is Phase-E gated.
const LEVER_CUTOFF_ISO = '2026-04-15T11:16:53Z';
const LEVER_CUTOFF_MS = Date.parse(LEVER_CUTOFF_ISO);

function leverStatus(windowToIso: string, liveSince: string): string {
  const toMs = Date.parse(windowToIso);
  if (Number.isNaN(toMs)) return '? (invalid window)';
  return toMs >= LEVER_CUTOFF_MS
    ? `live since ${liveSince}`
    : 'not live yet';
}

// ── Markdown builder ──

function formatMarkdown(snap: FunnelSnapshot, baseline: Baseline | null, tag: string, baseName: string): string {
  const b: Baseline = baseline ?? {
    install: null,
    first_call: null,
    second_call: null,
    fifth_plus_call: null,
    paid_upgrade: null,
    stick_rate: null,
    hold_rate_get_trade_signal: null,
    first_to_second: null,
    second_to_fifth: null,
    fifth_to_paid: null,
  };

  const totalToolCalls
    = snap.tool_call_distribution.get_trade_signal
      + snap.tool_call_distribution.get_market_regime
      + snap.tool_call_distribution.scan_funding_arb
      + snap.tool_call_distribution.other;
  const toolPct = (n: number): string => {
    if (totalToolCalls === 0) return '—';
    return fmtPct(n / totalToolCalls);
  };

  const lines: string[] = [];
  lines.push(`# Activation Funnel Snapshot — ${snap.generated_at} — tag:${tag}`);
  lines.push('');
  lines.push(`**Window:** ${snap.window.from} → ${snap.window.to}`);
  lines.push('');
  lines.push(`**Sessions in window:** ${fmtInt(snap.sessions.total)} total, ${fmtInt(snap.sessions.unique_ips)} unique IP hashes`);
  lines.push('');
  lines.push('## Funnel counts');
  lines.push('');
  lines.push('| Stage | Count | Baseline | Δ |');
  lines.push('|---|---:|---:|---:|');
  lines.push(`| install (NPM) | ${fmtInt(snap.funnel.install)} | ${fmtInt(b.install)} | ${deltaInt(snap.funnel.install, b.install)} |`);
  lines.push(`| first_call | ${fmtInt(snap.funnel.first_call)} | ${fmtInt(b.first_call)} | ${deltaInt(snap.funnel.first_call, b.first_call)} |`);
  lines.push(`| second_call | ${fmtInt(snap.funnel.second_call)} | ${fmtInt(b.second_call)} | ${deltaInt(snap.funnel.second_call, b.second_call)} |`);
  lines.push(`| fifth_plus_call | ${fmtInt(snap.funnel.fifth_plus_call)} | ${fmtInt(b.fifth_plus_call)} | ${deltaInt(snap.funnel.fifth_plus_call, b.fifth_plus_call)} |`);
  lines.push(`| paid_upgrade | ${fmtInt(snap.funnel.paid_upgrade)} | ${fmtInt(b.paid_upgrade)} | ${deltaInt(snap.funnel.paid_upgrade, b.paid_upgrade)} |`);
  lines.push('');
  lines.push('> install (NPM) is not queryable from the performance-db. It is populated from');
  lines.push('> `https://api.npmjs.org/downloads/point/last-month/crypto-quant-signal-mcp` in a');
  lines.push('> separate fetch; v1 snapshots always show `—`.');
  lines.push('');
  lines.push('## Conversion ratios');
  lines.push('');
  lines.push('| Transition | Rate | Baseline | Δ |');
  lines.push('|---|---:|---:|---:|');
  lines.push(`| first → second | ${fmtPct(snap.conversion.first_to_second)} | ${fmtPct(b.first_to_second)} | ${deltaPct(snap.conversion.first_to_second, b.first_to_second)} |`);
  lines.push(`| second → fifth+ | ${fmtPct(snap.conversion.second_to_fifth)} | ${fmtPct(b.second_to_fifth)} | ${deltaPct(snap.conversion.second_to_fifth, b.second_to_fifth)} |`);
  lines.push(`| fifth+ → paid | ${fmtPct(snap.conversion.fifth_to_paid)} | ${fmtPct(b.fifth_to_paid)} | ${deltaPct(snap.conversion.fifth_to_paid, b.fifth_to_paid)} |`);
  lines.push('');
  lines.push('## Activation metrics');
  lines.push('');
  lines.push('| Metric | Current | Baseline | Δ |');
  lines.push('|---|---:|---:|---:|');
  lines.push(`| Stick rate | ${fmtPct(snap.stick_rate)} | ${fmtPct(b.stick_rate)} | ${deltaPct(snap.stick_rate, b.stick_rate)} |`);
  lines.push(`| HOLD rate (get_trade_signal) | ${fmtPct(snap.hold_rate_get_trade_signal)} | ${fmtPct(b.hold_rate_get_trade_signal)} | ${deltaPct(snap.hold_rate_get_trade_signal, b.hold_rate_get_trade_signal)} |`);
  lines.push(`| p50 time-to-first-call | ${fmtMs(snap.time_to_first_call_ms.p50)} | — | — |`);
  lines.push(`| p90 time-to-first-call | ${fmtMs(snap.time_to_first_call_ms.p90)} | — | — |`);
  lines.push('');
  lines.push('## Tool call distribution');
  lines.push('');
  lines.push('| Tool | Count | % |');
  lines.push('|---|---:|---:|');
  lines.push(`| get_trade_signal | ${fmtInt(snap.tool_call_distribution.get_trade_signal)} | ${toolPct(snap.tool_call_distribution.get_trade_signal)} |`);
  lines.push(`| get_market_regime | ${fmtInt(snap.tool_call_distribution.get_market_regime)} | ${toolPct(snap.tool_call_distribution.get_market_regime)} |`);
  lines.push(`| scan_funding_arb | ${fmtInt(snap.tool_call_distribution.scan_funding_arb)} | ${toolPct(snap.tool_call_distribution.scan_funding_arb)} |`);
  lines.push(`| other | ${fmtInt(snap.tool_call_distribution.other)} | ${toolPct(snap.tool_call_distribution.other)} |`);
  lines.push('');
  lines.push('## Tier cohort sizes');
  lines.push('');
  lines.push('| Tier | Sessions |');
  lines.push('|---|---:|');
  lines.push(`| free | ${fmtInt(snap.tier_cohort_sizes.free)} |`);
  lines.push(`| starter | ${fmtInt(snap.tier_cohort_sizes.starter)} |`);
  lines.push(`| pro | ${fmtInt(snap.tier_cohort_sizes.pro)} |`);
  lines.push(`| enterprise | ${fmtInt(snap.tier_cohort_sizes.enterprise)} |`);
  lines.push(`| x402 | ${fmtInt(snap.tier_cohort_sizes.x402)} |`);
  lines.push('');
  lines.push('## Lever attribution (live during this window)');
  lines.push('');
  lines.push(`- L2 HOLD rescue: ${leverStatus(snap.window.to, '2026-04-15')}`);
  lines.push(`- L3 session cohort: ${leverStatus(snap.window.to, '2026-04-15')}`);
  lines.push(`- L4 try_next hints: ${leverStatus(snap.window.to, '2026-04-15')}`);
  lines.push('- L1 signal performance resource: pending (Phase-E gated)');
  lines.push('');
  lines.push('## Warnings');
  lines.push('');
  if (snap.warnings.length === 0) {
    lines.push('None');
  } else {
    for (const w of snap.warnings) lines.push(`- ${w}`);
  }
  lines.push('');
  lines.push('---');
  lines.push(`Auto-generated by \`scripts/write-funnel-snapshot.ts\` · [source JSON](./${baseName}.json)`);
  lines.push('');
  return lines.join('\n');
}

// ── Idempotency helper ──
// Returns a paired {json,md} basename that is free of collisions on BOTH
// extensions. We bump the suffix until neither .json nor .md already exists
// so every snapshot pair stays consistently suffixed.

function resolvePairedBaseName(outputDir: string, desiredBaseName: string): string {
  const jsonPath = (base: string): string => path.join(outputDir, `${base}.json`);
  const mdPath = (base: string): string => path.join(outputDir, `${base}.md`);
  if (!fs.existsSync(jsonPath(desiredBaseName)) && !fs.existsSync(mdPath(desiredBaseName))) {
    return desiredBaseName;
  }
  for (let i = 1; i < 1000; i++) {
    const candidate = `${desiredBaseName}-${i}`;
    if (!fs.existsSync(jsonPath(candidate)) && !fs.existsSync(mdPath(candidate))) {
      return candidate;
    }
  }
  throw new Error(`Could not find a free suffix for ${desiredBaseName} after 1000 attempts`);
}

// ── Snapshot ledger row appender ──
// Appends a simple row to activation-funnel/README.md's Snapshot Ledger table,
// if a marker comment exists. This is best-effort — if the marker or README is
// absent (e.g. teammate 1 didn't write it yet), we silently skip.

const LEDGER_MARKER_START = '<!-- snapshot-ledger:start -->';
const LEDGER_MARKER_END = '<!-- snapshot-ledger:end -->';

function appendSnapshotLedgerRow(outputDir: string, snap: FunnelSnapshot, baseName: string): void {
  try {
    // activation-funnel/README.md is one directory up from activation-funnel/snapshots/
    const readmePath = path.join(path.dirname(outputDir), 'README.md');
    if (!fs.existsSync(readmePath)) return;
    const existing = fs.readFileSync(readmePath, 'utf8');
    const startIdx = existing.indexOf(LEDGER_MARKER_START);
    const endIdx = existing.indexOf(LEDGER_MARKER_END);
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return;

    const header = existing.slice(0, startIdx + LEDGER_MARKER_START.length);
    const footer = existing.slice(endIdx);
    const middle = existing.slice(startIdx + LEDGER_MARKER_START.length, endIdx);

    // Append new row to any existing table rows between the markers.
    const stickPct = snap.stick_rate === null ? '—' : `${(snap.stick_rate * 100).toFixed(1)}%`;
    const holdPct
      = snap.hold_rate_get_trade_signal === null
        ? '—'
        : `${(snap.hold_rate_get_trade_signal * 100).toFixed(1)}%`;
    const newRow
      = `| ${snap.generated_at.slice(0, 10)} | ${baseName} | ${snap.funnel.first_call ?? '—'} | ${snap.funnel.second_call ?? '—'} | ${stickPct} | ${holdPct} |`;
    const updatedMiddle = `${middle.trimEnd()}\n${newRow}\n`;
    fs.writeFileSync(readmePath, `${header}${updatedMiddle}${footer}`, 'utf8');
  } catch {
    // Non-fatal — ledger is a nice-to-have.
  }
}

// ── CLI ──

function parseArgs(argv: string[]): WriteOptions {
  // Default output dir is relative to the repo root (same parent as scripts/).
  // __dirname equivalent in ESM: derive from import.meta.url.
  const thisFile = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(thisFile), '..');
  const defaultOutDir = path.join(repoRoot, 'activation-funnel', 'snapshots');

  const out: WriteOptions = {
    tag: 'auto',
    outputDir: defaultOutDir,
    stdout: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--tag' && next !== undefined) {
      out.tag = next;
      i++;
    } else if (arg === '--output-dir' && next !== undefined) {
      out.outputDir = path.resolve(next);
      i++;
    } else if (arg === '--days' && next !== undefined) {
      const n = Number(next);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid --days: ${next}`);
      out.days = n;
      i++;
    } else if (arg === '--since' && next !== undefined) {
      out.since = next;
      i++;
    } else if (arg === '--until' && next !== undefined) {
      out.until = next;
      i++;
    } else if (arg === '--stdout') {
      out.stdout = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: write-funnel-snapshot.ts [--tag auto] [--output-dir DIR] [--days N] [--since DATE] [--until DATE] [--stdout]',
      );
      process.exit(0);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  try {
    const snapshot = await generateFunnelSnapshot({
      days: opts.days,
      since: opts.since,
      until: opts.until,
    });

    const date = snapshot.generated_at.slice(0, 10); // YYYY-MM-DD
    const desiredBaseName = `${date}-${opts.tag}`;

    // Always load baseline (pure read); it's harmless in stdout mode.
    const baseline = loadBaseline(opts.outputDir);

    // In stdout mode we don't need idempotent path resolution — nothing is written.
    const pairedBaseName = opts.stdout
      ? desiredBaseName
      : resolvePairedBaseName(opts.outputDir, desiredBaseName);

    const jsonPath = path.join(opts.outputDir, `${pairedBaseName}.json`);
    const mdPath = path.join(opts.outputDir, `${pairedBaseName}.md`);

    const markdown = formatMarkdown(snapshot, baseline, opts.tag, pairedBaseName);
    const json = JSON.stringify(snapshot, null, 2);

    if (opts.stdout) {
      console.log('--- JSON ---');
      console.log(json);
      console.log('--- MARKDOWN ---');
      console.log(markdown);
    } else {
      fs.mkdirSync(opts.outputDir, { recursive: true });
      fs.writeFileSync(jsonPath, `${json}\n`, 'utf8');
      fs.writeFileSync(mdPath, markdown, 'utf8');
      appendSnapshotLedgerRow(opts.outputDir, snapshot, pairedBaseName);
      console.error(`wrote ${jsonPath}`);
      console.error(`wrote ${mdPath}`);
    }
    closeDb();
    process.exit(0);
  } catch (err) {
    console.error('write-funnel-snapshot failed:', err instanceof Error ? err.message : err);
    closeDb();
    process.exit(1);
  }
}

// Use fileURLToPath + path.resolve to survive macOS /private/tmp symlinks
// and URL-encoding differences between import.meta.url and process.argv[1].
function isMainModule(): boolean {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return path.resolve(thisFile) === entry;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void main();
}

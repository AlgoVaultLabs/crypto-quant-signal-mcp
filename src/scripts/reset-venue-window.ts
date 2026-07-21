#!/usr/bin/env tsx
/**
 * reset-venue-window.ts — OPS-SHADOW-WINDOW-RESET-AND-WR-DISPLAY-W1 — operator
 * window reset for shadow venues after an adapter/scoring bug.
 *
 * Usage:
 *   node dist/scripts/reset-venue-window.js <EXCHANGE...> --since <ISO8601|epoch> [--check]
 * e.g.
 *   node dist/scripts/reset-venue-window.js BITMART WEEX KUCOIN MEXC WHITEBIT --since 2026-06-11T02:00:00Z
 *
 * Bumps `venues.seeding_started_at` to the bug-fix deploy timestamp. Because
 * evaluate-venues derives the promotion clock AND the BUY+SELL sample AND the
 * PFE WR from ONE floor (`COALESCE(seeding_started_at, integrated_at)` →
 * `created_at > floor` in both queries), this restarts the 15-day window and
 * quarantines every pre-fix contaminated signal behind the floor — ZERO signal
 * rows deleted or mutated (Data Integrity LAW). Reversible: re-run with the
 * prior timestamp (logged below as `old`).
 *
 * Status-guarded twice (script-level skip + the store UPDATE's
 * `status = 'shadow'` WHERE clause): promoted/retired venues can never be
 * reset. Idempotent: re-running with the same ts converges to the same state.
 * `--check` prints the planned change without writing. Reusable for ANY future
 * adapter/scoring bug needing a clean post-fix re-measure (the generator-level
 * artifact — vs a one-off SQL).
 */
import { getVenue, resetSeedingStarted } from '../lib/venue-store.js';
import { runScript } from '../lib/script-lifecycle.js';

const EPOCH_SEC_RE = /^\d{10}$/;
const EPOCH_MS_RE = /^\d{13}$/;
const MIN_TS = Date.parse('2020-01-01T00:00:00Z'); // pre-project sanity floor
const FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Strict --since parsing (default-deny on anything unrecognized, per the
 * untrusted-numeric-strings rule — no parseFloat/Number coercion of e.g. 0x…).
 * Accepts ISO8601, 10-digit epoch-seconds, 13-digit epoch-millis. Rejects
 * pre-2020 and future timestamps (a future floor would quarantine clean
 * post-fix signals). Exported for tests.
 */
export function parseSince(raw: string | undefined, now: Date = new Date()): Date | null {
  if (!raw) return null;
  let ms: number;
  if (EPOCH_SEC_RE.test(raw)) ms = Number(raw) * 1000;
  else if (EPOCH_MS_RE.test(raw)) ms = Number(raw);
  else if (/^\d+$/.test(raw)) return null; // numeric but not a recognized epoch width
  else ms = Date.parse(raw); // ISO8601 path; NaN on garbage
  if (!Number.isFinite(ms)) return null;
  if (ms < MIN_TS) return null;
  if (ms > now.getTime() + FUTURE_SKEW_MS) return null;
  return new Date(ms);
}

export interface ResetOptions {
  check?: boolean;
}

/**
 * Reset the measurement window for each shadow venue to `since`. Returns 0
 * when every requested venue ended in the desired state; 1 when any venue was
 * unknown, guard-skipped (non-shadow), or failed post-write verification —
 * so automation chaining on the exit code can't mistake a partial reset for
 * a full one.
 */
export async function resetVenueWindow(exchangeIds: string[], since: Date, opts: ResetOptions = {}): Promise<number> {
  const sinceIso = since.toISOString();
  let rc = 0;
  let flipped = 0;
  console.log(`${opts.check ? '[--check dry-run] ' : ''}shadow window reset → seeding_started_at = ${sinceIso}`);
  for (const id of exchangeIds) {
    const venue = await getVenue(id);
    if (!venue) {
      console.error(`❌ ${id} — not found in the venues table`);
      rc = 1;
      continue;
    }
    if (venue.status !== 'shadow') {
      console.error(`⚠️ SKIP ${id} — status='${venue.status}' (guard: only shadow venues can be window-reset)`);
      rc = 1;
      continue;
    }
    const old = venue.seeding_started_at ?? `NULL (clock was on integrated_at=${venue.integrated_at})`;
    if (opts.check) {
      console.log(`→ ${id}: seeding_started_at ${old} → ${sinceIso} (planned, NOT written)`);
      continue;
    }
    await resetSeedingStarted(id, since);
    const after = await getVenue(id);
    const ok = after?.seeding_started_at != null && new Date(after.seeding_started_at).getTime() === since.getTime();
    if (ok) {
      flipped++;
      console.log(`✅ ${id}: seeding_started_at ${old} → ${after!.seeding_started_at} (read-back verified)`);
    } else {
      console.error(`❌ ${id}: post-write verification FAILED — seeding_started_at=${after?.seeding_started_at ?? 'NULL'} (expected ${sinceIso})`);
      rc = 1;
    }
  }
  if (!opts.check) console.log(`window reset complete: ${flipped}/${exchangeIds.length} venue(s) at ${sinceIso}`);
  return rc;
}

// ── CLI entrypoint ──

function usage(): void {
  console.error('Usage: node dist/scripts/reset-venue-window.js <EXCHANGE...> --since <ISO8601|epoch-sec|epoch-ms> [--check]');
  console.error('  e.g. node dist/scripts/reset-venue-window.js BITMART WEEX KUCOIN MEXC WHITEBIT --since 2026-06-11T02:00:00Z');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  let sinceRaw: string | undefined;
  const ids: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--check') continue;
    if (a === '--since') { sinceRaw = args[++i]; continue; }
    if (a.startsWith('--since=')) { sinceRaw = a.slice('--since='.length); continue; }
    if (a.startsWith('--')) { console.error(`Unknown flag: ${a}`); usage(); process.exit(1); }
    ids.push(a.toUpperCase());
  }
  const since = parseSince(sinceRaw);
  if (ids.length === 0 || !since) {
    if (sinceRaw && !since) console.error(`Invalid --since '${sinceRaw}' (ISO8601 / 10-digit epoch-sec / 13-digit epoch-ms, between 2020-01-01 and now)`);
    usage();
    process.exit(1);
  }
  process.exit(await resetVenueWindow(ids, since, { check }));
}

if (require.main === module) {
  void runScript('reset-venue-window', main); // OPS-SCRIPT-EXIT-LIFECYCLE-W1
}

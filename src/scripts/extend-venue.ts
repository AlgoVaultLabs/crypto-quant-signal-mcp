#!/usr/bin/env tsx
/**
 * extend-venue.ts — OPS-VENUE-DAY30-DECISION-W1 / CH4 — the EXTEND primitive
 * that did not exist.
 *
 * Usage:
 *   node dist/scripts/extend-venue.js <EXCHANGE> --days <N> [--reason "<text>"] [--force]
 *
 * Before this wave, `EXTEND_AGAIN` was a fictional primitive. The day-30 alert
 * instructed the operator to choose it, but there was no script, and no column
 * an extension could write to that would change any outcome. The only thing
 * that *looked* like an extension was `resetSeedingStarted()` — which
 * overwrites `seeding_started_at`, restarting the promotion clock AND the
 * sample/PFE-WR measurement floor together. Running it on WEEX would have
 * discarded 3,412 accrued BUY/SELL samples at a 95.15% PFE WR. It is a
 * data-destroying tool wearing an extension's name.
 *
 * This moves `review_deadline_at` and NOTHING else. `seeding_started_at` is
 * read before and after and asserted unchanged — that assertion is the whole
 * point of the wave, so it is enforced at runtime, not just in tests.
 *
 * AUTOMATION-FIRST: it measures the venue's real accrual rate (via the SAME
 * `computeVenueStats` the cron uses — imported, never re-derived) and REFUSES
 * an extension that provably cannot reach the sample target, printing the
 * projected date and the minimum `--days` that would work. An extension that
 * only guarantees a repeat alert is not an extension.
 *
 * Prints exactly one `EXTEND_VENUE_VERDICT=PASS|FAIL|INDETERMINATE` line and
 * fails closed: a caller gates on the TOKEN, never the bare exit code.
 * Exit codes: 0=PASS, 1=FAIL, 3=INDETERMINATE (token-law default for a NEW
 * gate — `check_test_baseline.sh` uses 2 only because it already deployed 2).
 */
import { getVenue, setReviewDeadline, MAX_EXTENSION_COUNT } from '../lib/venue-store.js';
import { runScript } from '../lib/script-lifecycle.js';
import { computeVenueStats, formatOperatorExtensionNote } from './evaluate-venues.js';

export const EXIT_PASS = 0;
export const EXIT_FAIL = 1;
export const EXIT_INDETERMINATE = 3;

/** Widest window we will set in one go — a deadline nobody reviews is not a deadline. */
export const MAX_EXTENSION_DAYS = 365;

type Verdict = 'PASS' | 'FAIL' | 'INDETERMINATE';

function emit(verdict: Verdict): number {
  console.log(`EXTEND_VENUE_VERDICT=${verdict}`);
  return verdict === 'PASS' ? EXIT_PASS : verdict === 'FAIL' ? EXIT_FAIL : EXIT_INDETERMINATE;
}

/**
 * Strict decimal integer parse. `parseFloat('0x1')` returns 0 and
 * `Number('0x1')` returns 1 — both finite, both passing `isFinite`, both
 * silently wrong. Scientific notation (`1e3`) and floats are rejected too:
 * a day count is a plain positive integer or it is not a day count.
 * Returns null so the caller default-denies.
 */
export function parseDays(raw: string | undefined): number | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!/^[1-9][0-9]{0,3}$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_EXTENSION_DAYS) return null;
  return n;
}

export interface ExtendOptions {
  days: number;
  reason?: string;
  force?: boolean;
  now?: Date;
}

export async function extendVenue(exchangeId: string, opts: ExtendOptions): Promise<number> {
  const now = opts.now ?? new Date();
  const { days, reason, force = false } = opts;

  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_EXTENSION_DAYS) {
    console.error(`❌ --days must be a whole number of days in [1, ${MAX_EXTENSION_DAYS}]; got ${JSON.stringify(days)}.`);
    console.error(`   suggested_action: re-run with an integer, e.g. --days 75.`);
    return emit('FAIL');
  }

  const venue = await getVenue(exchangeId);
  if (!venue) {
    console.error(`❌ Venue '${exchangeId}' not found in the venues table.`);
    console.error(`   suggested_action: check the exchange id (it is the venues.exchange_id value, uppercase).`);
    return emit('FAIL');
  }
  if (venue.status !== 'shadow') {
    console.error(`❌ ${exchangeId} is '${venue.status}', not 'shadow' — only a shadow venue has a pending decision to extend.`);
    console.error(`   suggested_action: a promoted venue needs no extension; a retired one must be un-retired first.`);
    return emit('FAIL');
  }

  const seedingBefore = venue.seeding_started_at;

  // Measure, then project. Same stats source as the cron — a second derivation
  // here could disagree with the branch that fires the alert.
  const stats = await computeVenueStats(venue, now);
  const remaining = venue.min_buy_sell_sample - stats.buy_sell_count;
  const perDay = stats.days_since > 0 ? stats.buy_sell_count / stats.days_since : 0;

  console.log(`📊 ${exchangeId}: ${stats.buy_sell_count} / ${venue.min_buy_sell_sample} BUY+SELL over ${stats.days_since}d` +
              ` (${perDay.toFixed(2)}/day), PFE WR ${stats.pfe_wr === null ? 'n/a' : `${(stats.pfe_wr * 100).toFixed(1)}%`}.`);

  if (remaining <= 0) {
    console.log(`✓ ${exchangeId} has already met its sample target — it does not need an extension.`);
    console.log(`   suggested_action: run promote-venue.js ${exchangeId} (the readiness digest should already list it).`);
    return emit('FAIL');
  }

  if (perDay <= 0) {
    // No measurable accrual: a projection would be a division by zero dressed
    // up as a date. Refuse rather than invent a number.
    console.error(`❌ ${exchangeId} has no measurable accrual (${stats.buy_sell_count} signals over ${stats.days_since}d) — cannot project a reachable window.`);
    console.error(`   suggested_action: fix the seed pipeline first, or retire the venue. --force will still set the deadline if you want a short review window.`);
    if (!force) return emit('FAIL');
  }

  const daysToTarget = perDay > 0 ? Math.ceil(remaining / perDay) : Infinity;
  const projected = Number.isFinite(daysToTarget)
    ? new Date(now.getTime() + daysToTarget * 86_400_000).toISOString().slice(0, 10)
    : 'never at the current rate';

  if (days < daysToTarget) {
    const line = `${exchangeId} needs ~${Number.isFinite(daysToTarget) ? daysToTarget : '∞'} more days at ${perDay.toFixed(2)}/day to reach ${venue.min_buy_sell_sample} (projected ${projected}); --days ${days} would only guarantee a repeat alert.`;
    if (!force) {
      console.error(`❌ REFUSED: ${line}`);
      console.error(`   suggested_action: --days ${Number.isFinite(daysToTarget) ? daysToTarget : MAX_EXTENSION_DAYS} or more, or --force for a deliberately short review window, or retire-venue.js ${exchangeId}.`);
      return emit('FAIL');
    }
    console.warn(`⚠️  --force: ${line} The target is NOT reachable inside this window; this is a review checkpoint, not a real extension.`);
  }

  // extension_count is a BUDGET bounded by the schema CHECK (<= 2). Bound it
  // here, before the write, so the tool can never author a violating value.
  const budgetSpent = venue.extension_count >= MAX_EXTENSION_COUNT;
  if (budgetSpent && !force) {
    console.error(`❌ ${exchangeId} has already used its ${MAX_EXTENSION_COUNT}-extension budget (extension_count=${venue.extension_count}).`);
    console.error(`   suggested_action: the two remaining real options are`);
    console.error(`     PROMOTE  node dist/scripts/promote-venue.js ${exchangeId}`);
    console.error(`     RETIRE   node dist/scripts/retire-venue.js ${exchangeId}`);
    console.error(`   (--force moves the review deadline WITHOUT spending budget, for a deliberate re-review.)`);
    return emit('FAIL');
  }
  // The LIVE bound is the `budgetSpent` guard above: it returns before we get
  // here whenever extension_count is already at MAX, so `+ 1` cannot exceed it.
  // The Math.min is therefore a redundant third layer, kept deliberately (the
  // second is setReviewDeadline's own clamp, which is the one with teeth if a
  // future caller reaches it by another route). Stated plainly so nobody reads
  // it as the enforcement point and weakens the guard that actually is one —
  // red-verifying this Math.min leaves the suite GREEN, precisely because it is
  // unreachable; red-verifying `budgetSpent` turns it red.
  const nextCount = Math.min(venue.extension_count + 1, MAX_EXTENSION_COUNT);
  if (budgetSpent) {
    console.warn(`⚠️  --force: budget already spent (${venue.extension_count}/${MAX_EXTENSION_COUNT}); moving the deadline WITHOUT incrementing.`);
  }

  const deadline = new Date(now.getTime() + days * 86_400_000);
  await setReviewDeadline(exchangeId, deadline, {
    // Only spend budget when there is budget to spend — otherwise this is a
    // deadline move, and writing the same value back would be a silent no-op
    // dressed up as an increment.
    extensionCount: budgetSpent ? undefined : nextCount,
    note: formatOperatorExtensionNote(now, days, reason),
  });

  // Post-flip verification: re-read and prove it persisted. The write above is
  // ONE awaited statement precisely so this read is meaningful (pairing an
  // awaited read with fire-and-forget writes would race).
  const after = await getVenue(exchangeId);
  if (!after) {
    console.error(`❌ post-flip verification: ${exchangeId} disappeared from the venues table.`);
    return emit('INDETERMINATE');
  }
  if (after.review_deadline_at == null || new Date(after.review_deadline_at).getTime() !== deadline.getTime()) {
    console.error(`❌ post-flip verification FAILED: review_deadline_at is ${after.review_deadline_at ?? 'NULL'}, expected ${deadline.toISOString()}.`);
    return emit('FAIL');
  }
  // THE invariant this wave exists to protect.
  if (after.seeding_started_at !== seedingBefore) {
    console.error(`❌ DATA INTEGRITY: seeding_started_at CHANGED (${seedingBefore} → ${after.seeding_started_at}). An extension must never move the measurement floor.`);
    return emit('FAIL');
  }
  if (after.status !== 'shadow') {
    console.error(`❌ post-flip verification FAILED: status is '${after.status}', expected 'shadow'.`);
    return emit('FAIL');
  }

  console.log(`✅ ${exchangeId} extended by ${days}d — review_deadline_at=${after.review_deadline_at}.`);
  console.log(`   • extension_count: ${venue.extension_count} → ${after.extension_count} / ${MAX_EXTENSION_COUNT}`);
  console.log(`   • seeding_started_at UNCHANGED (${after.seeding_started_at ?? 'NULL'}) — the accrued sample and PFE WR survive.`);
  console.log(`   • min_buy_sell_sample unchanged (${after.min_buy_sell_sample}); the day-30 alert is silent until the deadline elapses.`);
  return emit('PASS');
}

// ── CLI entrypoint ──

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const exchangeId = argv.find(a => !a.startsWith('--') && a !== argValue(argv, '--days') && a !== argValue(argv, '--reason'))?.toUpperCase();
  if (!exchangeId) {
    console.error('Usage: node dist/scripts/extend-venue.js <EXCHANGE> --days <N> [--reason "<text>"] [--force]');
    process.exit(emit('FAIL'));
  }

  const days = parseDays(argValue(argv, '--days'));
  if (days === null) {
    console.error(`❌ --days must be a whole number in [1, ${MAX_EXTENSION_DAYS}].`);
    console.error(`   Rejected BEFORE Number(): parseFloat('0x1') is 0 and Number('0x1') is 1 — both finite, both silently wrong.`);
    console.error(`   suggested_action: e.g. --days 75`);
    process.exit(emit('FAIL'));
  }

  process.exit(await extendVenue(exchangeId, {
    days,
    reason: argValue(argv, '--reason'),
    force: argv.includes('--force'),
  }));
}

if (require.main === module) {
  void runScript('extend-venue', main); // OPS-SCRIPT-EXIT-LIFECYCLE-W1
}

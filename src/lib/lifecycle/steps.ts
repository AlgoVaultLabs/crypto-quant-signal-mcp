/**
 * IDENTITY-LIFECYCLE-W3 CH2 — the four usage predicates.
 *
 * A step answers ONE question: which recipients are eligible right now? It never sends, meters,
 * caps or decides — `runStep` in the dispatcher does all of that identically for every step. Four
 * predicates cannot diverge on the things that matter because none of them is given the chance.
 *
 * FREE TIER ONLY (architect ruling Q4(A)). Every candidate comes from `free_keys`, which holds
 * `av_free_…` keys exclusively — paid `av_live_…` keys are not in that table at all. That is
 * structural rather than a filter, but it is ASSERTED anyway (`lifecycle-steps.test.ts`), because
 * the copy is free-tier-shaped: E2 says "of its {total} free calls" and sells Starter, so a paid
 * caller receiving it would be told a false number and sold the plan they already pay for. Paid
 * onboarding is `LIFECYCLE-PAID-ONBOARDING-W{NEXT}` and needs its own copy.
 *
 * THE DAILY WALL NEVER EMAILS. A caller who hits 100/day is refused for HOURS, not weeks, and the
 * refusal already tells them so in the response envelope. Mailing about it would be noise on the
 * one meter that resolves itself before most people read their inbox.
 */
import { dbQuery } from '../performance-db.js';
import { readMeters, type BucketMeter } from './meter.js';
import { maskKey } from './identity.js';
import { mcpConfigSnippet, type LifecycleStep, type StepCopyContext } from '../lifecycle-copy.js';
import type { LifecycleRecipient } from './engine.js';

/** Hours a key must have existed before `activation_nudge` may fire. */
export const ACTIVATION_MIN_AGE_H = 48;
/** R5 backfill discipline: at flip time, only keys issued this recently are nudged. */
export const ACTIVATION_MAX_AGE_D = 30;
/** `quota_80` fires from this fraction of the monthly allowance. */
export const QUOTA_80_FRACTION = 0.8;
/** `reset_return` requires the previous period to have gone this quiet before it ended. */
export const RESET_RETURN_SILENT_H = 72;

export interface StepCandidate {
  recipient: LifecycleRecipient;
  ctx: StepCopyContext & { periodKey: string };
}

/** One email-bound free key, joined to its meter. */
interface Bucket {
  apiKey: string;
  email: string;
  trackerKey: string;
  createdAtMs: number;
  lastUsedAtMs: number | null;
  meter: BucketMeter;
}

function toMs(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(String(v).replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
}

/**
 * Every email-bound free key with its meter attached.
 *
 * The tracker key is `coalesce(bucket_key, api_key)` — the SAME derivation `deriveTrackerKey`
 * uses in `license.ts` for a free caller. MEASURED 2026-09-08: `bucket_key` is NULL on 37 of 38
 * rows, so the coalesce is almost always the key itself, and getting it wrong would silently
 * meter the wrong bucket for the one row that has adopted an alias.
 */
export async function loadBuckets(): Promise<Bucket[]> {
  const rows = await dbQuery<{
    api_key: string; email: string; bucket_key: string | null;
    created_at: unknown; last_used_at: unknown;
  }>(
    `SELECT api_key, email, bucket_key, created_at, last_used_at
       FROM free_keys
      WHERE email IS NOT NULL AND email <> ''`,
  );
  const keys = rows.map((r) => r.bucket_key || r.api_key);
  const meters = await readMeters(keys);
  return rows.map((r) => {
    const trackerKey = r.bucket_key || r.api_key;
    return {
      apiKey: r.api_key,
      email: r.email,
      trackerKey,
      createdAtMs: toMs(r.created_at) ?? 0,
      lastUsedAtMs: toMs(r.last_used_at),
      meter: meters.get(trackerKey) ?? {
        trackerKey, used: 0, total: 0, periodStart: null, resetAtMs: null, resetDate: null,
      },
    };
  });
}

function baseCtx(b: Bucket): Omit<StepCopyContext, 'mcpConfigSnippet'> & { mcpConfigSnippet: string } {
  return {
    keyMasked: maskKey(b.apiKey),
    used: b.meter.used,
    total: b.meter.total,
    // A step that can only fire with a live period always has a date; `activation_nudge` has no
    // period by definition and never renders one, so the fallback is never read in copy.
    resetDate: b.meter.resetDate ?? '',
    mcpConfigSnippet: mcpConfigSnippet(b.apiKey),
  };
}

function recipientOf(b: Bucket): LifecycleRecipient {
  // `recipientId` is the API KEY, not the address: it is the stable per-key handle the
  // unsubscribe token signs, and it keeps every URL free of PII.
  return { recipientId: b.apiKey, email: b.email, identityBound: true };
}

/**
 * E1 · activation_nudge — a key that has never been used.
 *
 * `period_key = 'once'` is the point: this is a lifetime-once message. A key that goes on never
 * being used must not be nudged again next month, and the ledger's UNIQUE constraint is what
 * enforces that rather than a date comparison somebody has to remember.
 *
 * Eligibility uses `last_used_at IS NULL` AND a zero meter. Either alone is insufficient:
 * `last_used_at` is stamped by the key path and a bucket-aliased key could show usage under an
 * adopted bucket, while a zero meter alone would nudge somebody whose 30-day window merely
 * expired after real use.
 */
export function activationNudgeCandidates(buckets: Bucket[], now: Date, flipAt?: Date): StepCandidate[] {
  const minAge = now.getTime() - ACTIVATION_MIN_AGE_H * 3600_000;
  // R5: at go-live, the eligible set is capped to recently-issued keys. Nudging somebody about a
  // key they minted eight months ago is a message about a decision they have already made.
  const maxAgeFloor = (flipAt ?? now).getTime() - ACTIVATION_MAX_AGE_D * 86_400_000;
  return buckets
    .filter((b) => b.createdAtMs > 0 && b.createdAtMs <= minAge && b.createdAtMs >= maxAgeFloor)
    .filter((b) => b.lastUsedAtMs === null && b.meter.used === 0)
    .map((b) => ({ recipient: recipientOf(b), ctx: { ...baseCtx(b), periodKey: 'once' } }));
}

/** E2 · quota_80 — at or past 80 % of the allowance, and not yet at the wall. */
export function quota80Candidates(buckets: Bucket[]): StepCandidate[] {
  return buckets
    .filter((b) => b.meter.periodStart !== null && b.meter.total > 0)
    .filter((b) => b.meter.used >= Math.floor(b.meter.total * QUOTA_80_FRACTION) && b.meter.used < b.meter.total)
    .map((b) => ({
      recipient: recipientOf(b),
      // The period IS the idempotency key: one warning per window, and a new window earns a new
      // one without any date arithmetic at the call site.
      ctx: { ...baseCtx(b), periodKey: b.meter.periodStart as string },
    }));
}

/** E3 · quota_wall — at or past the monthly allowance. The DAILY wall never reaches here. */
export function quotaWallCandidates(buckets: Bucket[]): StepCandidate[] {
  return buckets
    .filter((b) => b.meter.periodStart !== null && b.meter.total > 0 && b.meter.used >= b.meter.total)
    .map((b) => ({
      recipient: recipientOf(b),
      ctx: { ...baseCtx(b), periodKey: b.meter.periodStart as string },
    }));
}

/**
 * E4 · reset_return — the window rolled over for somebody who had hit the wall and gone quiet.
 *
 * Both conditions matter. "Hit the wall" without "went quiet" is somebody who is still calling
 * and needs no invitation; "went quiet" without "hit the wall" is somebody who simply stopped,
 * and telling them their calls are back implies a limit they never met.
 *
 * The previous period is reconstructed from `last_used_at`: a bucket whose last call was more
 * than RESET_RETURN_SILENT_H before its previous window closed went quiet inside it. That is a
 * RECONSTRUCTION, and it is honest about being one — we do not store per-period history, and
 * inventing a table to hold it would be a bigger change than this signal is worth.
 */
export function resetReturnCandidates(buckets: Bucket[], now: Date): StepCandidate[] {
  return buckets
    .filter((b) => b.meter.periodStart !== null)
    .filter((b) => {
      const startMs = Date.parse(b.meter.periodStart as string);
      if (!Number.isFinite(startMs)) return false;
      // A window that began within the last tick's reach is a fresh one.
      const freshlyRolled = now.getTime() - startMs <= 24 * 3600_000;
      if (!freshlyRolled) return false;
      if (b.lastUsedAtMs === null) return false;
      // Quiet for the last stretch of the previous window, which ended when this one began.
      return startMs - b.lastUsedAtMs >= RESET_RETURN_SILENT_H * 3600_000;
    })
    .map((b) => ({
      recipient: recipientOf(b),
      ctx: { ...baseCtx(b), periodKey: b.meter.periodStart as string },
    }));
}

/** The registry the dispatcher consumes. Keys are steps; values produce candidates. */
export async function candidatesFor(step: LifecycleStep, now: Date, flipAt?: Date): Promise<StepCandidate[]> {
  const buckets = await loadBuckets();
  switch (step) {
    case 'activation_nudge': return activationNudgeCandidates(buckets, now, flipAt);
    case 'quota_80': return quota80Candidates(buckets);
    case 'quota_wall': return quotaWallCandidates(buckets);
    case 'reset_return': return resetReturnCandidates(buckets, now);
    default: return [];
  }
}

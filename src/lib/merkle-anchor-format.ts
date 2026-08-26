/**
 * OPS-DIGEST-MERKLE-ANCHOR-W1 (2026-08-26): pure renderer for the daily Telegram
 * digest's on-chain anchoring line — the "Daily Batches" bullet that sits inside
 * the 📈 Signal Performance section.
 *
 * Same shape as `agent-activity-format.ts`: extracted from `src/scripts/monitor.ts`
 * (which runs `main()` on import → not test-importable) so the layout is
 * golden-testable in isolation.
 *
 * WHAT IT RENDERS, and why both numbers are on it:
 *   • the DAILY anchor  — batch identity + the calls it anchored + when it landed
 *   • the CUMULATIVE    — `N published · M calls verified`, the exact pair the
 *                         /verify page's "On-Chain Proof" line renders
 * Both come from `getMerkleBatchSummary()` (SQL MAX/COUNT/SUM over the whole
 * table). This module NEVER sees the `getRecentMerkleBatches()` page, so it
 * cannot repeat the OPS-MERKLE-BATCH-IDENTITY-W1 defect where a consumer derived
 * the batch NUMBER and the batch COUNT from a LIMIT-100 array and pinned at #100
 * forever once batch 101 landed.
 *
 * FRESHNESS is rendered, not alerted. Batches publish daily at 00:05 UTC and the
 * digest fires at 08:00 UTC, so a healthy digest always sees a batch a few hours
 * old. Past `MERKLE_ANCHOR_STALE_MS` the bullet says so inline — it is an
 * operator-read report line, NOT a page, and this module deliberately owns no
 * Telegram call and no alert state. The 26h window is the same one
 * `TG_BOT_STALE_MS` / `carry-tracker-public` already use for "a daily producer
 * skipped its slot", so a one-off late run does not read as an outage.
 *
 * A `latest_published_at` of null (unparseable column, or a backend that did not
 * hydrate it) degrades to NO freshness clause rather than to a guessed verdict —
 * an unknown timestamp must never render as either fresh or stale.
 */

/** A daily producer that has skipped its slot. Matches `TG_BOT_STALE_MS`. */
export const MERKLE_ANCHOR_STALE_MS = 26 * 60 * 60 * 1000;

export interface MerkleAnchorSummary {
  latest_batch_id: number | null;
  batch_count: number;
  total_signals: number;
  /** ISO-8601 UTC, or null when the column was absent/unparseable. */
  latest_published_at: string | null;
  latest_signal_count: number | null;
}

/** `2026-08-26 00:05 UTC` — digest-header-compatible, zone always explicit. */
function utcStamp(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
  );
}

/** `2d 8h` / `31h` / `47m` — coarse, because this is a report, not a stopwatch. */
function ago(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours - days * 24}h`;
}

// Pinned locale: a bare toLocaleString() would render `511.746` under a de-DE
// container and make the golden tests host-dependent.
const num = (n: number): string => n.toLocaleString('en-US');

/**
 * Render the "Daily Batches" bullet(s). Returns the lines WITHOUT the section
 * header so the caller can splice them into 📈 Signal Performance.
 *
 * Never throws and never returns an empty array — a digest that silently drops
 * this line is indistinguishable from one where nothing was anchored.
 */
export function formatMerkleAnchoring(
  s: MerkleAnchorSummary | null | undefined,
  nowMs: number,
): string[] {
  if (!s) return ['• Daily Batches: — (unavailable)'];
  if (!Number.isFinite(s.batch_count) || s.batch_count <= 0 || s.latest_batch_id === null) {
    return ['• Daily Batches: — (none published yet)'];
  }

  const id = `#${s.latest_batch_id}`;
  const anchored =
    typeof s.latest_signal_count === 'number' && Number.isFinite(s.latest_signal_count)
      ? ` · ${num(s.latest_signal_count)} calls anchored`
      : '';

  const publishedMs = s.latest_published_at ? Date.parse(s.latest_published_at) : NaN;
  const known = Number.isFinite(publishedMs);
  const age = known ? nowMs - publishedMs : NaN;
  const stale = known && age > MERKLE_ANCHOR_STALE_MS;

  const head = stale
    ? `• Daily Batches: ⚠️ no anchor in 26h — latest ${id}${anchored} ` +
      `(${utcStamp(s.latest_published_at!)}, ${ago(age)} ago)`
    : known
      ? `• Daily Batches: ${id}${anchored} (${utcStamp(s.latest_published_at!)})`
      : `• Daily Batches: ${id}${anchored}`;

  return [
    head,
    `  ↳ 🔗 ${num(s.batch_count)} published · ${num(s.total_signals)} calls verified on Base`,
  ];
}

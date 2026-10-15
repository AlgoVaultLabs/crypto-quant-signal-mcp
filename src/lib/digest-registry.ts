/**
 * OPS-DIGEST-DELIVERY-DURABLE-W1 CH2 — THE registry of scheduled operator digests.
 *
 * One row per labelled `sendDigest` producer. `DigestLabel` is typed off this object, so a
 * label that is not registered here FAILS `tsc` in every TypeScript producer, and gate R4 of
 * `scripts/check-delivery-assertion.mjs` holds the `.mjs` producer and the reverse direction
 * (every row used by exactly one producer). The registry is PINNED to the enumeration that
 * already exists rather than maintained beside it: `tests/unit/digest-registry.test.ts`
 * asserts every row's `interlock_id` exists in `ops/scripts/cron-interlock-registry.json`, its
 * `producer` equals that row's `script`, and its `cron` yields this row's `cadence` + `due` —
 * and `check-cron-interlock-coverage.mjs` already asserts the interlock registry against the
 * LIVE crontab. Chain: live crontab ⇄ interlock registry ⇄ this file. No runtime code parses
 * cron.
 *
 * Every derived quantity (`maxIntervalS`, `periodKey`, `redeliveryTtlS`) is computed ONCE
 * here; the ledger, the drain, the freshness step and the catch-up all project from it.
 *
 * PURE LEAF — no I/O, no imports. Safe for any module (and the gate's parser) to read.
 */

export type DigestCadence = 'daily' | 'weekly' | 'monthly';

export interface DigestRegistryRow {
  /** Repo-relative entrypoint — equals the interlock row's `script`. */
  producer: string;
  /** `id` of the row in `ops/scripts/cron-interlock-registry.json`. */
  interlock_id: string;
  cadence: DigestCadence;
  /** UTC schedule. `dow` 0 = Sunday … 6 = Saturday (cron's numbering); `dom` 1–31. */
  due: { hhmm: string; dow?: number; dom?: number };
  /** `conditional` producers legitimately send nothing on some runs (and stamp `skipped`). */
  sends: 'always' | 'conditional';
  /** Freshness grace beyond `maxIntervalS` before a never-attempted period pages. */
  grace_s: number;
  /** A run row still `attempted` this long after its stamp was killed or crashed mid-run. */
  stuck_after_s: number;
  /** Where the producer's cron appends — named in every page. */
  host_log: string;
  /** `self`: the monitor's critical tick re-runs a missed period in-process. */
  catchup: 'self' | 'none';
  /** UTC date the row was registered — the bootstrap clock for a label with no run row yet. */
  registered_at: string;
}

export const DIGEST_REGISTRY = {
  'monitor-daily-digest': {
    producer: 'src/scripts/monitor.ts',
    interlock_id: 'monitor',
    cadence: 'daily',
    due: { hhmm: '08:00' },
    sends: 'always',
    grace_s: 3_600,
    stuck_after_s: 1_800,
    host_log: '/var/log/algovault-monitor.log',
    catchup: 'self',
    registered_at: '2026-10-15',
  },
  'venue-readiness-report': {
    producer: 'src/scripts/venue-readiness-report.ts',
    interlock_id: 'venue-readiness-report',
    cadence: 'daily',
    due: { hhmm: '06:05' },
    // MEASURED (R0.3/R0.6): suppresses when nothing is actionable — 41 retained SUPPRESSED runs.
    sends: 'conditional',
    grace_s: 3_600,
    stuck_after_s: 1_800,
    host_log: '/var/log/venue-readiness.log',
    catchup: 'none',
    registered_at: '2026-10-15',
  },
  'geo-weekly-cron': {
    producer: 'src/scripts/geo-weekly-cron.ts',
    interlock_id: 'geo-weekly-cron',
    cadence: 'weekly',
    due: { hhmm: '01:00', dow: 1 },
    sends: 'always',
    grace_s: 3 * 3_600,
    // ≥ 2 × the interlock row's measured max_runtime_s (26,363 s) — the ~7.3 h multi-engine probe.
    stuck_after_s: 52_800,
    host_log: '/var/log/geo-weekly-cron.log',
    catchup: 'none',
    registered_at: '2026-10-15',
  },
  'rate-limit-digest-weekly': {
    producer: 'src/scripts/rate-limit-digest-weekly.ts',
    interlock_id: 'rate-limit-digest-weekly',
    cadence: 'weekly',
    due: { hhmm: '00:00', dow: 0 },
    sends: 'always',
    grace_s: 3 * 3_600,
    stuck_after_s: 1_800,
    host_log: '/var/log/shadow-digest.log',
    catchup: 'none',
    registered_at: '2026-10-15',
  },
  'chat-analytics-digest': {
    producer: 'src/scripts/chat-analytics-digest.ts',
    interlock_id: 'chat-analytics-digest',
    cadence: 'weekly',
    due: { hhmm: '09:00', dow: 0 },
    sends: 'conditional',
    grace_s: 3 * 3_600,
    stuck_after_s: 1_800,
    host_log: '/var/log/chat-analytics-digest.log',
    catchup: 'none',
    registered_at: '2026-10-15',
  },
  'referral-payout-batch-detect': {
    producer: 'src/scripts/referral-payout-batch-detect.ts',
    interlock_id: 'referral-payout-batch-detect',
    cadence: 'monthly',
    due: { hhmm: '08:07', dom: 1 },
    sends: 'conditional',
    grace_s: 6 * 3_600,
    stuck_after_s: 1_800,
    host_log: '/var/log/referral-payout.log',
    catchup: 'none',
    registered_at: '2026-10-15',
  },
  'refresh-knowledge-pages': {
    producer: 'scripts/refresh-knowledge-pages.mjs',
    interlock_id: 'refresh-knowledge-pages',
    cadence: 'weekly',
    due: { hhmm: '06:00', dow: 0 },
    sends: 'always',
    grace_s: 3 * 3_600,
    stuck_after_s: 1_800,
    host_log: '/var/log/refresh-knowledge-pages.log',
    catchup: 'none',
    registered_at: '2026-10-15',
  },
} as const satisfies Record<string, DigestRegistryRow>;

export type DigestLabel = keyof typeof DIGEST_REGISTRY;

export const DIGEST_LABELS = Object.keys(DIGEST_REGISTRY) as DigestLabel[];

export function digestRow(label: DigestLabel): DigestRegistryRow {
  return DIGEST_REGISTRY[label];
}

const DAY_S = 86_400;

/**
 * The longest legitimate gap between two scheduled runs. Monthly is 31 days, not 30: a
 * `7 8 1 * *` run on Jan 1 and the next on Feb 1 are 31 days apart.
 */
export function maxIntervalS(label: DigestLabel): number {
  const c = DIGEST_REGISTRY[label].cadence;
  return c === 'daily' ? DAY_S : c === 'weekly' ? 7 * DAY_S : 31 * DAY_S;
}

/**
 * How long an undelivered digest keeps being retried before it is DEAD and pages:
 * `max(6 h, ⌈5 % × maxInterval⌉)` — build-and-runtime.md's "cron retry budget ≥ 5 % of
 * interval with exp-backoff", by construction (daily 6 h · weekly 8.4 h · monthly 37.2 h).
 * The 6 h floor exists so a daily digest outlives a morning-long Telegram or egress outage.
 */
export function redeliveryTtlS(label: DigestLabel): number {
  return Math.max(6 * 3_600, Math.ceil(0.05 * maxIntervalS(label)));
}

/** ISO-8601 week of a UTC instant: `YYYY-Www` (weeks start Monday; week 1 holds Jan 4). */
function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7; // Mon=1 … Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - dow); // the Thursday of this ISO week decides its year
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** The period a run at `nowMs` belongs to: UTC date · ISO week · `YYYY-MM`. */
export function periodKey(label: DigestLabel, nowMs: number): string {
  const d = new Date(nowMs);
  const c = DIGEST_REGISTRY[label].cadence;
  if (c === 'daily') return d.toISOString().slice(0, 10);
  if (c === 'monthly') return d.toISOString().slice(0, 7);
  return isoWeekKey(d);
}

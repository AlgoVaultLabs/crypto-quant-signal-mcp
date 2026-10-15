/**
 * OPS-DIGEST-DELIVERY-DURABLE-W1 CH3 — a digest that never ran is caught; the 08:00 digest
 * heals itself. The two late steps of `monitor --mode critical`, plus the period guard of the
 * monitor's own digest run.
 *
 * Why a module of its own: `monitor.ts` is an entrypoint wired to adapters, RPCs and the
 * filesystem; these steps are what the CH3 suites EXECUTE against a real ledger, so they live
 * where a test can import them. Both steps take the registry as a parameter (default
 * `DIGEST_REGISTRY`) — a suite runs them over synthetic labels, so it can never collide with a
 * real producer's rows on the shared Postgres lane.
 *
 * Freshness (`runDigestFreshnessStep`) — per label, ONE page per missed period:
 *   stale  — the newest ATTEMPT is older than maxInterval + grace. Pages through `firePage`
 *            (key `digest_freshness:<label>`); the `missed` row is written only when the page
 *            was DELIVERED, so it is retried next tick and never sent twice for one period.
 *   stuck  — the newest run is still `attempted` past `stuck_after_s`: killed or crashed after
 *            its stamp (a deploy recreate at the 08:00 peak; a crash). For the `self` label only
 *            once its catch-up attempts are exhausted. Pages once; the run is then `dead`.
 *   bootstrap — no run row yet: report-not-page until registered_at + maxInterval + grace.
 * It judges `attempted_at` ONLY — never `delivered_at` (a conditional producer that sends
 * nothing is still fresh) and never the declared `due` (a mis-declared due can move the
 * catch-up, never silence the detector). It is NOT in the generic checks list: that list
 * re-fires every 30 min and shares one key, which would page a stale weekly producer ~48×/day
 * and let one stale label mask another.
 *
 * Catch-up (`runDigestCatchupStep`) — `catchup: 'self'` labels only (the monitor digest):
 * acts on the current period when the ledger already holds an EARLIER period's attempt
 * (bootstrap guard: the deploy day never duplicates a digest that ran before the stamps
 * existed), `now ≥ due + 10 min`, and the period has no run row, a `missed` row, or an
 * `attempted` row older than 15 min with < 3 run attempts. It CLAIMS the period with ONE
 * atomic upsert (the mutual exclusion against the cron's own run and a second tick), then
 * re-runs the digest in-process under a 120 s cap; fail-open.
 */
import { firePage, type AlertState, type PageLevel } from './monitor-page.js';
import { mdValue } from '../lib/markdown-safe.js';
import {
  DIGEST_REGISTRY,
  cadenceMaxIntervalS,
  cadencePeriodKey,
  rowDueAtMs,
  type DigestRegistryRow,
} from '../lib/digest-registry.js';
import {
  latestDigestRuns,
  missedPeriodPaged,
  recordMissedPeriod,
  markRunStuck,
  digestRunFor,
  hasEarlierAttempt,
  claimCatchup,
  type LatestRun,
} from '../lib/telegram-digest-ledger.js';

export const CATCHUP_DELAY_MS = 10 * 60_000;
export const CATCHUP_STALE_MS = 15 * 60_000;
export const MAX_CATCHUP_RUN_ATTEMPTS = 3;
export const CATCHUP_CAP_MS = 120_000;

type Registry = Readonly<Record<string, DigestRegistryRow>>;
type Sender = (msg: string, level: PageLevel) => Promise<boolean>;

const iso = (ms: number | null) => (ms == null ? 'never' : new Date(ms).toISOString());
const hours = (s: number) => `${+(s / 3_600).toFixed(1)} h`;

// ── freshness ────────────────────────────────────────────────────────────────────────

export type FreshnessClass = 'fresh' | 'bootstrap' | 'stale' | 'stuck';

export interface FreshnessVerdict {
  label: string;
  cls: FreshnessClass;
  lastAttemptAt: number | null;
  /** stale: the period that was missed (one page per missed period). */
  missedPeriod: string | null;
  /** stuck: the run row that never reached a terminal status. */
  runId: number | null;
}

/** PURE: one label's freshness, from its newest attempted run row. */
export function classifyDigestFreshness(
  label: string,
  row: DigestRegistryRow,
  latest: LatestRun | undefined,
  nowMs: number,
): FreshnessVerdict {
  const maxMs = cadenceMaxIntervalS(row.cadence) * 1000;
  const graceMs = row.grace_s * 1000;
  const v = (cls: FreshnessClass, extra: Partial<FreshnessVerdict> = {}): FreshnessVerdict => ({
    label, cls, lastAttemptAt: latest?.attemptedAt ?? null, missedPeriod: null, runId: null, ...extra,
  });
  if (!latest || latest.attemptedAt == null) {
    const registered = Date.parse(`${row.registered_at}T00:00:00Z`);
    if (nowMs < registered + maxMs + graceMs) return v('bootstrap');
    return v('stale', { missedPeriod: cadencePeriodKey(row.cadence, registered + maxMs) });
  }
  if (nowMs - latest.attemptedAt > maxMs + graceMs) {
    return v('stale', { missedPeriod: cadencePeriodKey(row.cadence, latest.attemptedAt + maxMs) });
  }
  if (
    latest.status === 'attempted' &&
    nowMs - latest.attemptedAt > row.stuck_after_s * 1000 &&
    (row.catchup !== 'self' || latest.runAttempts >= MAX_CATCHUP_RUN_ATTEMPTS)
  ) {
    return v('stuck', { runId: latest.id });
  }
  return v('fresh');
}

export interface FreshnessStepResult {
  verdict: 'OK' | 'INDETERMINATE';
  counts: Record<FreshnessClass, number>;
  paged: number;
  verdicts: FreshnessVerdict[];
}

export async function runDigestFreshnessStep(args: {
  state: AlertState;
  nowMs: number;
  registry?: Registry;
  send?: Sender;
  /** The ledger read — injectable so the INDETERMINATE path is executed, not assumed. */
  readLatest?: (labels: readonly string[]) => Promise<Map<string, LatestRun>>;
}): Promise<FreshnessStepResult> {
  const registry: Registry = args.registry ?? DIGEST_REGISTRY;
  const labels = Object.keys(registry);
  const counts: Record<FreshnessClass, number> = { fresh: 0, bootstrap: 0, stale: 0, stuck: 0 };
  let latest: Map<string, LatestRun>;
  try {
    latest = await (args.readLatest ?? latestDigestRuns)(labels);
  } catch (err) {
    console.log(`[monitor] DIGEST_FRESHNESS_VERDICT=INDETERMINATE ${(err as Error)?.message ?? String(err)}`);
    return { verdict: 'INDETERMINATE', counts, paged: 0, verdicts: [] };
  }
  let paged = 0;
  const verdicts: FreshnessVerdict[] = [];
  for (const label of labels) {
    const row = registry[label];
    const v = classifyDigestFreshness(label, row, latest.get(label), args.nowMs);
    verdicts.push(v);
    counts[v.cls]++;
    if (v.cls === 'fresh') continue;
    const where = `producer ${mdValue(row.producer)}, interlock row ${mdValue(row.interlock_id)}, log ${mdValue(row.host_log)}`;
    let note = '';
    if (v.cls === 'stale' && v.missedPeriod) {
      if (await missedPeriodPaged(label, v.missedPeriod)) {
        note = ' · already paged for this period';
      } else {
        const msg =
          `Digest ${mdValue(label)} not attempted since ${mdValue(iso(v.lastAttemptAt))} ` +
          `(max interval ${hours(cadenceMaxIntervalS(row.cadence))}, grace ${hours(row.grace_s)}) — ${where}`;
        if (await firePage({ state: args.state, key: `digest_freshness:${label}`, msg, level: 'warning', send: args.send })) {
          await recordMissedPeriod(label, v.missedPeriod, args.nowMs, 'not attempted within max interval + grace');
          paged++;
          note = ' · paged';
        } else {
          note = ' · page undelivered — retried next tick';
        }
      }
    } else if (v.cls === 'stuck' && v.runId != null) {
      const msg =
        `Digest ${mdValue(label)} attempted at ${mdValue(iso(v.lastAttemptAt))} but never reached a terminal status — killed or crashed mid-run` +
        `${row.catchup === 'self' ? ` (${MAX_CATCHUP_RUN_ATTEMPTS} catch-up attempts exhausted)` : ''} — ${where}`;
      if (await firePage({ state: args.state, key: `digest_stuck:${label}`, msg, level: 'warning', send: args.send })) {
        await markRunStuck(v.runId, args.nowMs, 'stuck: never reached a terminal status');
        paged++;
        note = ' · paged';
      } else {
        note = ' · page undelivered — retried next tick';
      }
    }
    console.log(`[monitor] DIGEST_FRESHNESS ${label} ${v.cls.toUpperCase()} last=${iso(v.lastAttemptAt)}${v.missedPeriod ? ` missed=${v.missedPeriod}` : ''}${note}`);
  }
  console.log(`[monitor] DIGEST_FRESHNESS fresh=${counts.fresh} bootstrap=${counts.bootstrap} stale=${counts.stale} stuck=${counts.stuck}`);
  return { verdict: 'OK', counts, paged, verdicts };
}

// ── catch-up ─────────────────────────────────────────────────────────────────────────

export type CatchupDecision =
  | 'BOOTSTRAP' | 'NOT_DUE' | 'ALREADY_DONE' | 'IN_FLIGHT' | 'EXHAUSTED' | 'CLAIM_LOST' | 'RAN' | 'CATCHUP_FAILED';

/** Read-only: what the catch-up WOULD do for `label` now (no claim). */
export async function decideCatchup(label: string, row: DigestRegistryRow, nowMs: number): Promise<CatchupDecision | 'ELIGIBLE'> {
  const period = cadencePeriodKey(row.cadence, nowMs);
  if (!(await hasEarlierAttempt(label, period))) return 'BOOTSTRAP';
  if (nowMs < rowDueAtMs(row, nowMs) + CATCHUP_DELAY_MS) return 'NOT_DUE';
  const r = await digestRunFor(label, period);
  if (!r || r.status === 'missed') return 'ELIGIBLE';
  if (r.status !== 'attempted') return 'ALREADY_DONE';
  if (r.runAttempts >= MAX_CATCHUP_RUN_ATTEMPTS) return 'EXHAUSTED';
  if (r.attemptedAt != null && nowMs - r.attemptedAt <= CATCHUP_STALE_MS) return 'IN_FLIGHT';
  return 'ELIGIBLE';
}

function withCap<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const cap = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`catch-up exceeded its ${ms} ms cap`)), ms);
    t.unref?.();
  });
  return Promise.race([p, cap]).finally(() => clearTimeout(t));
}

/**
 * The monitor's self catch-up. Prints ONE `[monitor] CATCHUP_DECISION=` line per `self` label
 * per tick. Fail-open: any error is `CATCHUP_FAILED` and the tick (whose checks and state are
 * already saved) exits normally.
 */
export async function runDigestCatchupStep(args: {
  nowMs: number;
  run: (label: string) => Promise<unknown>;
  registry?: Registry;
  capMs?: number;
}): Promise<Record<string, CatchupDecision>> {
  const registry: Registry = args.registry ?? DIGEST_REGISTRY;
  const out: Record<string, CatchupDecision> = {};
  for (const [label, row] of Object.entries(registry)) {
    if (row.catchup !== 'self') continue;
    const period = cadencePeriodKey(row.cadence, args.nowMs);
    let decision: CatchupDecision;
    try {
      const d = await decideCatchup(label, row, args.nowMs);
      if (d !== 'ELIGIBLE') {
        decision = d;
      } else {
        const claimed = await claimCatchup({
          label, periodKey: period, nowMs: args.nowMs,
          staleBeforeMs: args.nowMs - CATCHUP_STALE_MS, maxRunAttempts: MAX_CATCHUP_RUN_ATTEMPTS,
        });
        if (claimed == null) {
          decision = 'CLAIM_LOST';
        } else {
          console.log(`[monitor] CATCHUP claimed ${label} ${period} run_attempts=${claimed} — re-running in-process`);
          await withCap(Promise.resolve().then(() => args.run(label)), args.capMs ?? CATCHUP_CAP_MS);
          decision = 'RAN';
        }
      }
    } catch (err) {
      console.log(`[monitor] CATCHUP_FAILED ${label} ${(err as Error)?.message ?? String(err)}`);
      decision = 'CATCHUP_FAILED';
    }
    out[label] = decision;
    console.log(`[monitor] CATCHUP_DECISION=${decision} label=${label} period=${period}`);
  }
  return out;
}

// ── the monitor digest's own period guard ────────────────────────────────────────────

export type PeriodGuard = 'PROCEED' | 'ALREADY_DELIVERED' | 'FORCED';

/**
 * Idempotent per period on BOTH paths: a scheduled run whose period is already `delivered` or
 * `queued` (the catch-up got there, or the cron fired twice) sends nothing; `--force` is the
 * operator's explicit re-send. A ledger read failure PROCEEDS — a duplicate digest is noise,
 * a missing one is the defect this wave retires.
 */
export async function digestPeriodGuard(label: string, row: DigestRegistryRow, nowMs: number, force: boolean): Promise<PeriodGuard> {
  let r: LatestRun | null = null;
  try {
    r = await digestRunFor(label, cadencePeriodKey(row.cadence, nowMs));
  } catch (err) {
    console.error(`[monitor] digest period guard could not read the ledger — proceeding: ${(err as Error)?.message ?? String(err)}`);
    return 'PROCEED';
  }
  if (r && (r.status === 'delivered' || r.status === 'queued')) return force ? 'FORCED' : 'ALREADY_DELIVERED';
  return 'PROCEED';
}

/**
 * Append the catch-up footer to the LAST section only when it does not add a message — the
 * same fits-only rule as the drain's redelivery footer.
 */
export function withCatchupFooter(
  sections: string[],
  row: DigestRegistryRow,
  nowMs: number,
  chunk: (s: string[]) => string[],
): string[] {
  if (sections.length === 0) return sections;
  const footer = `\n\n⏱ catch-up ${new Date(nowMs).toISOString().slice(11, 16)}Z — the ${row.due.hhmm}Z run did not complete`;
  const next = [...sections.slice(0, -1), `${sections[sections.length - 1]}${footer}`];
  return chunk(next).length === chunk(sections).length ? next : sections;
}

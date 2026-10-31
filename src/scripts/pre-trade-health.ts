/**
 * pre-trade-health.ts — DECISION-CALL-V1-W3 CH2
 *
 * The hourly health probe for `pre_trade_check`. ONE real call through the engine the tool serves —
 * `runPreTradeCheck` on the fixed probe below, with the internal license, under
 * `runAsBatch(…, 'pre_trade_health')` so it never spends a venue's interactive reserve — and two
 * verdicts over what came back. It calls the ENGINE, never the pipeline: no request_log row, no
 * analytics event, no quota unit (an internal license never meters), so the probe can never appear
 * in a funnel or a usage count.
 *
 * Run from ops/monitoring/pre-trade-health-canary.sh (47 * * * *, signal-1), inside the app container,
 * in a session the server holds read-only (PGOPTIONS default_transaction_read_only=on):
 *   docker exec <ctr> node dist/scripts/pre-trade-health.js
 * The tables are ADOPTED (to_regclass), never lazily ensured, so the probe issues no DDL.
 *
 * ── TWO TOKENS, EACH EXACTLY ONCE — the wrapper reads each TOKEN, never the exit code ────────────
 *   VENUE_FEE_TABLE_VERDICT=PASS|FAIL|INDETERMINATE
 *     Printed FIRST and computed purely (the committed fee table and the clock), so a database outage
 *     never hides a stale fee row. FAIL names every `staleFeeRows` row with its verified-at date and
 *     its source URL. An EMPTY table is INDETERMINATE: a judge that read nothing knows nothing.
 *   PRE_TRADE_HEALTH_VERDICT=PASS|FAIL|INDETERMINATE
 *     INDETERMINATE — the table adoption threw: the database is unreachable and nothing was judged.
 *     FAIL          — the call refused, threw, or returned no decision; or fewer than
 *                     PRE_TRADE_HEALTH_MIN_VENUES (default 3) venues are free of feed_unavailable /
 *                     funding_unavailable.
 *     Wall time and REGIME_UNAVAILABLE are REPORTED, never judged: a slow call is still an answer,
 *     and the regime is optional context the decision is valid without.
 *   A watchdog kill (exit 75) prints no health token; the wrapper records the run INDETERMINATE.
 *
 * Every check prints a positive line (a count beside every zero), one JSON line per venue and per
 * fee row, and the probe's wall time. Those line shapes are the wrapper's parse contract, pinned by
 * tests/unit/pre-trade-health.test.ts.
 *
 * Exit codes come from main()'s RETURN value (runScript ignores process.exitCode): 1 when either
 * token FAILs, else 3 when either is INDETERMINATE, else 0.
 */

import type { LicenseInfo } from '../types.js';
import { runScript } from '../lib/script-lifecycle.js';
import { runAsBatch } from '../lib/upstream-weight-budget.js';
import { adoptExistingRegimeSnapshotTables } from '../lib/regime-snapshots.js';
import { FEE_TABLE_MAX_AGE_DAYS, VENUE_FEE_ROWS, feeRowVerifiedAtMs, staleFeeRows, type VenueFeeRow } from '../lib/venue-fees.js';
import type { PreTradeDecision } from '../lib/pre-trade-decision.js';
import { runPreTradeCheck, type PreTradeCheckOutcome, type PreTradeCheckParams } from '../tools/pre-trade-check.js';

export type HealthVerdict = 'PASS' | 'FAIL' | 'INDETERMINATE';

const TAG = '[pre-trade-health]';
const DAY_MS = 86_400_000;
const EXIT: Record<HealthVerdict, number> = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

/** The ONE probe: a liquid coin every priced venue lists, at a size well inside its capacity. */
export const PRE_TRADE_HEALTH_PROBE: Readonly<PreTradeCheckParams> = Object.freeze({
  coin: 'BTC', side: 'long', sizeUsd: 10_000, holdHours: 8, timeframe: '4h',
});

const INTERNAL_LICENSE: LicenseInfo = { tier: 'internal', key: null, outcome: 'RESOLVED' };

/** The two exclusions that mean the venue's data path is DOWN, as opposed to the venue being unsuitable. */
const DOWN_EXCLUSIONS: ReadonlySet<string> = new Set(['feed_unavailable', 'funding_unavailable']);

const DECISIONS: ReadonlySet<string> = new Set<PreTradeDecision>(['GO', 'CAUTION', 'WAIT']);

const MIN_VENUES_DEFAULT = 3;

/**
 * `PRE_TRADE_HEALTH_MIN_VENUES`, default-deny parse: anything that is not a positive integer is the
 * default, never a looser value — a typo must not make one live venue read as healthy.
 */
export function parseMinVenues(raw: string | undefined): { value: number; source: 'env' | 'default' } {
  if (raw !== undefined && /^[1-9]\d*$/.test(raw)) return { value: Number(raw), source: 'env' };
  return { value: MIN_VENUES_DEFAULT, source: 'default' };
}

// ── The fee-table judge (pure) ──────────────────────────────────────────────────────────────────

export interface FeeRowStatus {
  exchange: string;
  verified_at: string;
  age_days: number | null;
  stale: boolean;
  source_url: string;
}

export interface FeeTableJudgement {
  verdict: HealthVerdict;
  rows: FeeRowStatus[];
  stale: string[];
}

/** One status per committed fee row; stale ⇔ `staleFeeRows` names it (the ONE staleness rule). */
export function judgeFeeTable(nowMs: number, rows: readonly VenueFeeRow[] = VENUE_FEE_ROWS): FeeTableJudgement {
  const staleSet = new Set(staleFeeRows(nowMs, rows));
  const statuses = rows.map((r) => {
    const at = feeRowVerifiedAtMs(r);
    return {
      exchange: r.exchange,
      verified_at: r.verifiedAt,
      age_days: Number.isFinite(at) ? Math.floor((nowMs - at) / DAY_MS) : null,
      stale: staleSet.has(r),
      source_url: r.sourceUrl,
    };
  });
  const stale = statuses.filter((s) => s.stale).map((s) => s.exchange);
  const verdict: HealthVerdict = rows.length === 0 ? 'INDETERMINATE' : stale.length > 0 ? 'FAIL' : 'PASS';
  return { verdict, rows: statuses, stale };
}

// ── The health judge (pure) ─────────────────────────────────────────────────────────────────────

/** What the probe produced: the engine's outcome, or the error it threw. */
export type ProbeResult = { ok: true; outcome: PreTradeCheckOutcome } | { ok: false; error: string };

export interface VenueHealth {
  exchange: string;
  excluded: string | null;
  state: 'UP' | 'DOWN';
}

export interface HealthJudgement {
  verdict: 'PASS' | 'FAIL';
  /** `<check>:<detail>` per failed check, in check order. */
  failKeys: string[];
  decision: string | null;
  reasonCodes: string[];
  venues: VenueHealth[];
  venuesUp: number;
}

export function judgePreTradeHealth(probe: ProbeResult, minVenues: number): HealthJudgement {
  const j: HealthJudgement = { verdict: 'PASS', failKeys: [], decision: null, reasonCodes: [], venues: [], venuesUp: 0 };
  if (!probe.ok) {
    j.failKeys.push(`call:threw ${probe.error}`);
  } else if (probe.outcome.kind === 'refused') {
    j.failKeys.push(`call:refused ${probe.outcome.payload.code} (status ${probe.outcome.status})`);
  } else {
    const r = probe.outcome.response;
    j.decision = typeof r.decision === 'string' && DECISIONS.has(r.decision) ? r.decision : null;
    if (j.decision === null) j.failKeys.push('decision:missing');
    j.reasonCodes = Array.isArray(r.reasons) ? r.reasons.map((x) => x.code) : [];
    j.venues = (Array.isArray(r.venues) ? r.venues : []).map((v) => ({
      exchange: v.exchange,
      excluded: v.excluded,
      state: v.excluded !== null && DOWN_EXCLUSIONS.has(v.excluded) ? 'DOWN' : 'UP',
    }));
    j.venuesUp = j.venues.filter((v) => v.state === 'UP').length;
    if (j.venuesUp < minVenues) j.failKeys.push(`venues:${j.venuesUp} of ${j.venues.length} up, below ${minVenues}`);
  }
  if (j.failKeys.length > 0) j.verdict = 'FAIL';
  return j;
}

// ── Seams + the CLI body ────────────────────────────────────────────────────────────────────────

export interface PreTradeHealthDeps {
  now: () => number;
  /** true = adopted, false = absent (the regime is then unavailable, never a failure); throws = DB unreachable. */
  adoptTables: () => Promise<boolean>;
  runCheck: (params: PreTradeCheckParams, license: LicenseInfo) => Promise<PreTradeCheckOutcome>;
  feeRows: readonly VenueFeeRow[];
}

const DEFAULT_PRE_TRADE_HEALTH_DEPS: PreTradeHealthDeps = {
  now: () => Date.now(),
  adoptTables: () => adoptExistingRegimeSnapshotTables(),
  runCheck: (params, license) => runPreTradeCheck(params, license),
  feeRows: VENUE_FEE_ROWS,
};

const errText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** The CLI body. RETURNS the exit code — runScript takes it only from here. */
export async function main(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  deps: PreTradeHealthDeps = DEFAULT_PRE_TRADE_HEALTH_DEPS,
): Promise<number> {
  void argv; // no modes: one probe, two verdicts

  // 1. The fee table — first, and with no I/O, so it is judged whatever the database does.
  const fees = judgeFeeTable(deps.now(), deps.feeRows);
  for (const row of fees.rows) console.log(`${TAG} FEE ${JSON.stringify(row)}`);
  console.log(`${TAG} CHECK fee_table rows=${fees.rows.length} stale=${fees.stale.length} max_age_days=${FEE_TABLE_MAX_AGE_DAYS}`);
  console.log(`VENUE_FEE_TABLE_STALE=${fees.stale.join(',')}`);
  console.log(`VENUE_FEE_TABLE_VERDICT=${fees.verdict}`);

  // 2. The database — reachable or nothing is judged.
  const min = parseMinVenues(env.PRE_TRADE_HEALTH_MIN_VENUES);
  try {
    const adopted = await deps.adoptTables();
    console.log(`${TAG} CHECK db=REACHABLE regime_tables=${adopted ? 'ADOPTED' : 'ABSENT (the regime is unavailable; not judged)'}`);
  } catch (e) {
    console.error(`${TAG} database unreachable: ${errText(e)}`);
    console.log(`${TAG} CHECK db=UNREACHABLE — nothing was judged`);
    console.log('PRE_TRADE_HEALTH_FAIL_KEYS=');
    console.log('PRE_TRADE_HEALTH_VERDICT=INDETERMINATE');
    return fees.verdict === 'FAIL' ? EXIT.FAIL : EXIT.INDETERMINATE;
  }

  // 3. The probe — one call, batch class, timed.
  const p = PRE_TRADE_HEALTH_PROBE;
  const t0 = deps.now();
  let probe: ProbeResult;
  try {
    // The tag is a literal AT the call site — scripts/check-caller-tags.mjs refuses an identifier.
    probe = { ok: true, outcome: await runAsBatch(() => deps.runCheck({ ...p }, INTERNAL_LICENSE), 'pre_trade_health') };
  } catch (e) {
    console.error(`${TAG} the probe threw: ${errText(e)}`);
    probe = { ok: false, error: e instanceof Error ? e.name : 'non-Error' };
  }
  const wallMs = deps.now() - t0;
  const outcome = probe.ok ? (probe.outcome.kind === 'ok' ? 'ok' : `refused ${probe.outcome.payload.code}`) : `threw ${probe.error}`;
  console.log(`${TAG} CHECK probe=${p.coin} ${p.side} ${p.sizeUsd} ${p.holdHours}h ${p.timeframe} outcome=${outcome}`);

  // 4. The judgement.
  const j = judgePreTradeHealth(probe, min.value);
  for (const v of j.venues) console.log(`${TAG} VENUE ${JSON.stringify(v)}`);
  console.log(`${TAG} CHECK decision=${j.decision ?? 'NONE'} reasons=${j.reasonCodes.join(',') || 'none'}`);
  console.log(`${TAG} CHECK venues_up=${j.venuesUp} of ${j.venues.length} min=${min.value} (${min.source})`);
  console.log(`PRE_TRADE_HEALTH_WALL_MS=${wallMs}`);
  console.log(`PRE_TRADE_HEALTH_FAIL_KEYS=${j.failKeys.join(';')}`);
  console.log(`PRE_TRADE_HEALTH_VERDICT=${j.verdict}`);

  if (j.verdict === 'FAIL' || fees.verdict === 'FAIL') return EXIT.FAIL;
  return fees.verdict === 'INDETERMINATE' ? EXIT.INDETERMINATE : EXIT.PASS;
}

// require.main guard (CJS, target ES2022) — the canary invokes this directly.
if (require.main === module) {
  // 5 min: one engine call is seconds; a call still running at 5 min is a hung store or feed, never a slow one.
  void runScript('pre-trade-health', () => main(), { watchdogMs: 5 * 60_000 });
}

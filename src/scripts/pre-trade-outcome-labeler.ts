/**
 * pre-trade-outcome-labeler.ts — DECISION-CALL-V2-W4 CH3. What the price did over each logged check's hold.
 *
 * Nightly on signal-1 (ops/cron/pre-trade-outcome-labeler.sh, registered safe-to-kill). For every
 * `pre_trade_checks` row whose hold ended at least an hour ago and has no outcome yet, oldest first and
 * bounded, it reads the DECISION venue's candles over the hold and writes ONE `pre_trade_check_outcomes`
 * row (migrations/054): which bracket barrier the price touched first, whether it touched the isolated
 * liquidation price, and where it ended. Prices only: never a sided return, never a P&L.
 *
 * INTERNAL and QUARANTINED. It reads `pre_trade_checks` and writes `pre_trade_check_outcomes`, nothing
 * else; no published track-record table (`signals`, `directional_labels`, `/api/performance-public`) is
 * touched, and nothing in src/ but this file names the outcome table (pinned by
 * tests/unit/pre-trade-outcome-labeler.test.ts). Its one reader is the forward-calibration owed read
 * (ops/monitoring/owed-read-pre-trade-odds-forward.py) as `aoe_readonly`: the ensure GRANTs that SELECT
 * explicitly rather than inheriting it from the default ACL (migrations/035–036: an inherited read
 * privilege is the one discovered missing later), so a missing grant fails the first run, not a read
 * thirty days on.
 *
 * THE MECHANICS, one derivation each:
 *   interval  1m for a hold up to 24 h, 5m up to 7 d, 15m beyond; the step the venue actually serves
 *             (`servedCandleStepMs`) is the grid.
 *   window    the bars opening at or after `checked_at` whose close is at or before the hold's end. Every
 *             bar of that grid must be present, or the check is not labelled this run.
 *   ref_px    the open of the first bar: the decision venue's first traded price after the check, on the
 *             SAME series as the path. (`ref_mid_px` is a book mid and is NULL for every BINANCE check.)
 *   bracket   with both a stop and a target: the first bar whose high or low crosses a barrier, from
 *             ref_px — `target`, `stop`, `both_in_one_bar` (one bar crossed both, its order unknowable),
 *             or `timeout`. NULL without a bracket.
 *   liq       with leverage and a served liquidation distance: did any bar's low (long) or high (short)
 *             reach ref_px·(1 ∓ d)? Last-price touch, as the study; NULL without a distance.
 *   end_px    the last bar's close; high_px / low_px the extremes over the window.
 *
 * DISPOSITIONS. A check is labelled, or `unlabelable` with its reason, or deferred to the next night:
 * a missing bar or a failed fetch defers until the hold ended 7 days ago, then the check is unlabelable;
 * a check with no decision venue, or a venue the served-step table does not know, is unlabelable at once.
 * A `WeightBudgetSkipError` defers that venue's remaining checks (a by-design wait, never a failure).
 * Every insert is `ON CONFLICT (check_id) DO NOTHING`, so a re-run never labels a check twice; each is
 * awaited before the next check, so a kill loses at most the check in flight.
 *
 * VERDICT — exactly one terminal `PRE_TRADE_OUTCOME_VERDICT=PASS|FAIL|INDETERMINATE` (exit 0 | 1 | 3),
 * with the counts beside it (a zero is never printed without the work-list size):
 *   FAIL           a write of our own failed, a label broke its own invariants, or the work-list handed
 *                  over a check whose hold had not ended (the predicate is wrong; the check was refused).
 *   INDETERMINATE  the outcome table, its grant or the work-list failed, or the run was cut short: a
 *                  fetch failed, a venue's budget was spent, the time budget or a stop request ended it.
 *   PASS           every check in the work-list reached a disposition this run (a gap younger than 7
 *                  days is a disposition: the venue has not served those bars).
 * Silent on success: the token lands in the log; nothing pages.
 */
import { dbQuery } from '../lib/performance-db.js';
import { runScript } from '../lib/script-lifecycle.js';
import { getAdapter } from '../lib/exchange-adapter.js';
import { runAsBatch, WeightBudgetSkipError } from '../lib/upstream-weight-budget.js';
import { servedCandleStepMs, SERVED_VENUES } from '../lib/tf-support.js';
import { isStopRequested, installGracefulStop } from '../lib/graceful-stop.js';
import type { Candle, ExchangeId } from '../types.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** A hold is labelled only once it ended at least this long ago (spec §7.2). */
export const SETTLE_MS = HOUR_MS;
/** A check its venue still cannot serve this long after its hold ended is unlabelable (spec §7.2). */
export const UNREADABLE_AFTER_MS = 7 * DAY_MS;
const DELAY_BETWEEN_FETCHES_MS = 250;
const MAX_PAGES = 200;

/** The served step of each work interval, for naming a coarser venue step honestly. */
const INTERVAL_STEP_MS: Readonly<Record<string, number>> = { '1m': 60_000, '5m': 300_000, '15m': 900_000 };

export const CREATE_OUTCOMES_SQL = `CREATE TABLE IF NOT EXISTS pre_trade_check_outcomes (
  check_id      BIGINT           PRIMARY KEY REFERENCES pre_trade_checks (id),
  labeled_at    TIMESTAMPTZ      NOT NULL,
  venue         TEXT,
  "interval"    TEXT             NOT NULL,
  ref_px        DOUBLE PRECISION,
  end_px        DOUBLE PRECISION,
  high_px       DOUBLE PRECISION,
  low_px        DOUBLE PRECISION,
  bracket_first TEXT             CHECK (bracket_first IN ('target', 'stop', 'timeout', 'both_in_one_bar')),
  liq_touched   BOOLEAN,
  status        TEXT             NOT NULL CHECK (status IN ('labeled', 'unlabelable')),
  reason        TEXT
)`;

/** The owed read's SELECT, granted explicitly (identical to migrations/054). */
export const GRANT_OUTCOMES_READ_SQL = `GRANT SELECT ON pre_trade_check_outcomes TO aoe_readonly`;

/** The work-list: checks whose hold ended by $1 with no outcome, oldest first, at most $2. */
export const WORKLIST_SQL = `SELECT c.id, c.checked_at, c.coin, c.side, c.hold_hours, c.leverage, c.stop_pct, c.target_pct,
       c.decision_venue, c.liq_distance_pct
  FROM pre_trade_checks c
  LEFT JOIN pre_trade_check_outcomes o ON o.check_id = c.id
 WHERE o.check_id IS NULL
   AND c.checked_at + c.hold_hours * interval '1 hour' <= $1::timestamptz
 ORDER BY c.checked_at, c.id
 LIMIT $2`;

export const INSERT_OUTCOME_SQL = `INSERT INTO pre_trade_check_outcomes (
  check_id, labeled_at, venue, "interval", ref_px, end_px, high_px, low_px, bracket_first, liq_touched, status, reason
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
ON CONFLICT (check_id) DO NOTHING
RETURNING check_id`;

export type BracketFirst = 'target' | 'stop' | 'timeout' | 'both_in_one_bar';

/** One work-list row, as read. */
export interface CheckRow {
  id: number;
  checkedAtMs: number;
  coin: string;
  side: 'long' | 'short';
  holdHours: number;
  leverage: number | null;
  stopPct: number | null;
  targetPct: number | null;
  venue: string | null;
  liqDistancePct: number | null;
}

/** One outcome row, as written. */
export interface OutcomeRow {
  checkId: number;
  venue: string | null;
  interval: string;
  refPx: number | null;
  endPx: number | null;
  highPx: number | null;
  lowPx: number | null;
  bracketFirst: BracketFirst | null;
  liqTouched: boolean | null;
  status: 'labeled' | 'unlabelable';
  reason: string | null;
}

/** 1m to 24 h, 5m to 7 d, 15m beyond (spec §7.2). */
export function intervalForHold(holdHours: number): '1m' | '5m' | '15m' {
  if (holdHours <= 24) return '1m';
  if (holdHours <= 168) return '5m';
  return '15m';
}

/** The bar grid of one hold: first bar opening at or after the check, last bar closing at or before the end. */
export function holdGrid(checkedAtMs: number, holdHours: number, stepMs: number): { firstOpenMs: number; bars: number; endMs: number } {
  const endMs = checkedAtMs + holdHours * HOUR_MS;
  const firstOpenMs = Math.ceil(checkedAtMs / stepMs) * stepMs;
  const bars = Math.max(0, Math.floor((endMs - firstOpenMs) / stepMs));
  return { firstOpenMs, bars, endMs };
}

const finitePos = (x: number | null): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;

/**
 * The label of one complete window of bars (oldest first, one per grid step). Pure. Throws only on a window
 * that breaks its own invariants (no bars, a non-finite or non-positive price, high below low) — a
 * defect the caller reports as FAIL, never a label.
 */
export function labelFromBars(check: Pick<CheckRow, 'side' | 'stopPct' | 'targetPct' | 'leverage' | 'liqDistancePct'>, bars: readonly Candle[]):
  Pick<OutcomeRow, 'refPx' | 'endPx' | 'highPx' | 'lowPx' | 'bracketFirst' | 'liqTouched'> {
  if (bars.length === 0) throw new Error('labelFromBars: no bars');
  for (const b of bars) {
    for (const p of [b.open, b.high, b.low, b.close]) {
      if (!(Number.isFinite(p) && p > 0)) throw new Error(`labelFromBars: non-positive or non-finite price at ${b.time}`);
    }
    if (b.high < b.low) throw new Error(`labelFromBars: high below low at ${b.time}`);
  }
  const ref = bars[0].open;
  const long = check.side === 'long';
  let high = -Infinity;
  let low = Infinity;
  for (const b of bars) {
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
  }

  let bracketFirst: BracketFirst | null = null;
  if (finitePos(check.stopPct) && finitePos(check.targetPct)) {
    const s = check.stopPct / 100;
    const t = check.targetPct / 100;
    // Above and below the reference: a long's target is above it, a short's below.
    const upLevel = long ? ref * (1 + t) : ref * (1 + s);
    const dnLevel = long ? ref * (1 - s) : ref * (1 - t);
    bracketFirst = 'timeout';
    for (const b of bars) {
      const up = b.high >= upLevel;
      const dn = b.low <= dnLevel;
      if (up && dn) { bracketFirst = 'both_in_one_bar'; break; }
      if (up) { bracketFirst = long ? 'target' : 'stop'; break; }
      if (dn) { bracketFirst = long ? 'stop' : 'target'; break; }
    }
  }

  let liqTouched: boolean | null = null;
  if (finitePos(check.leverage) && typeof check.liqDistancePct === 'number' && Number.isFinite(check.liqDistancePct)) {
    const d = check.liqDistancePct / 100;
    liqTouched = long ? low <= ref * (1 - d) : high >= ref * (1 + d);
  }

  return { refPx: ref, endPx: bars[bars.length - 1].close, highPx: high, lowPx: low, bracketFirst, liqTouched };
}

/** The ids of the grid steps a fetched window lacks (or holds off-grid), oldest first. */
export function missingBars(bars: readonly Candle[], firstOpenMs: number, n: number, stepMs: number): number[] {
  const have = new Set(bars.map((b) => b.time));
  const missing: number[] = [];
  for (let i = 0; i < n; i += 1) if (!have.has(firstOpenMs + i * stepMs)) missing.push(firstOpenMs + i * stepMs);
  return missing;
}

export interface LabelerDeps {
  query: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
  /** Every candle the venue returns between the two open times, inclusive, in any order. */
  candles: (venue: ExchangeId, coin: string, tf: string, fromOpenMs: number, toOpenMs: number, stepMs: number) => Promise<Candle[]>;
  stepMs: (venue: string, tf: string) => number | null;
  stop: () => boolean;
}

export interface LabelerOptions {
  nowMs: number;
  maxChecks: number;
  /** Wall-clock budget; the clock is read per check. */
  deadlineMs: number;
  clock: () => number;
}

export interface LabelerCounts {
  worklist: number;
  labeled: number;
  unlabelable: number;
  deferred_gap: number;
  deferred_fetch: number;
  deferred_budget: number;
  deferred_stop: number;
  already_labeled: number;
  refused_unfinished: number;
  write_errors: number;
  label_errors: number;
}

export interface LabelerResult {
  verdict: 'PASS' | 'FAIL' | 'INDETERMINATE';
  counts: LabelerCounts;
  reason: string | null;
  /** The `labeled_at` of the earliest `labeled` row THIS run wrote (ISO, as written), else null. The first run's
   *  value is the forward owed read's `first_label_at` anchor, which that read re-checks against the table. */
  firstLabeledAt: string | null;
}

const toMs = (v: unknown): number => (v instanceof Date ? v.getTime() : Date.parse(String(v)));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** A work-list row as the database returns it (`pg`: BIGINT as text, TIMESTAMPTZ as Date). */
export function toCheckRow(r: Record<string, unknown>): CheckRow {
  return {
    id: Number(r.id),
    checkedAtMs: toMs(r.checked_at),
    coin: String(r.coin),
    side: r.side === 'short' ? 'short' : 'long',
    holdHours: Number(r.hold_hours),
    leverage: numOrNull(r.leverage),
    stopPct: numOrNull(r.stop_pct),
    targetPct: numOrNull(r.target_pct),
    venue: r.decision_venue === null || r.decision_venue === undefined ? null : String(r.decision_venue),
    liqDistancePct: numOrNull(r.liq_distance_pct),
  };
}

/** One run over the work-list. Never throws: every outcome is a disposition or a counted fault. */
export async function runLabeler(deps: LabelerDeps, opt: LabelerOptions): Promise<LabelerResult> {
  const counts: LabelerCounts = {
    worklist: 0, labeled: 0, unlabelable: 0, deferred_gap: 0, deferred_fetch: 0, deferred_budget: 0,
    deferred_stop: 0, already_labeled: 0, refused_unfinished: 0, write_errors: 0, label_errors: 0,
  };
  const settledBy = opt.nowMs - SETTLE_MS;
  let rows: CheckRow[];
  try {
    await deps.query(CREATE_OUTCOMES_SQL);
    await deps.query(GRANT_OUTCOMES_READ_SQL);
    rows = (await deps.query<Record<string, unknown>>(WORKLIST_SQL, [new Date(settledBy).toISOString(), opt.maxChecks])).map(toCheckRow);
  } catch (e) {
    return { verdict: 'INDETERMINATE', counts, reason: `outcome table, its grant or the work-list failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`, firstLabeledAt: null };
  }
  counts.worklist = rows.length;
  const spentVenues = new Set<string>();
  let firstLabeledAt: string | null = null;

  const write = async (o: OutcomeRow): Promise<void> => {
    const at = new Date(opt.clock()).toISOString();
    try {
      const r = await deps.query<{ check_id: unknown }>(INSERT_OUTCOME_SQL, [
        o.checkId, at, o.venue, o.interval, o.refPx, o.endPx, o.highPx, o.lowPx,
        o.bracketFirst, o.liqTouched, o.status, o.reason,
      ]);
      if (r.length === 0) counts.already_labeled += 1;
      else if (o.status === 'labeled') {
        counts.labeled += 1;
        if (firstLabeledAt === null || at < firstLabeledAt) firstLabeledAt = at;
      } else counts.unlabelable += 1;
    } catch {
      counts.write_errors += 1;
    }
  };

  for (const c of rows) {
    if (deps.stop() || opt.clock() > opt.deadlineMs) { counts.deferred_stop += 1; continue; }
    const tf = intervalForHold(c.holdHours);
    const holdEndMs = c.checkedAtMs + c.holdHours * HOUR_MS;
    // The guard behind the predicate: a hold that has not settled is refused, whatever the query returned.
    if (!(holdEndMs <= settledBy)) { counts.refused_unfinished += 1; continue; }
    const base = { checkId: c.id, venue: c.venue, interval: tf, refPx: null, endPx: null, highPx: null, lowPx: null, bracketFirst: null, liqTouched: null } as const;
    if (c.venue === null) { await write({ ...base, status: 'unlabelable', reason: 'no decision venue' }); continue; }
    if (!(SERVED_VENUES as readonly string[]).includes(c.venue)) {
      await write({ ...base, status: 'unlabelable', reason: `venue ${c.venue} not in the served-step table` });
      continue;
    }
    if (spentVenues.has(c.venue)) { counts.deferred_budget += 1; continue; }
    const step = deps.stepMs(c.venue, tf);
    if (!(typeof step === 'number' && step > 0)) {
      await write({ ...base, status: 'unlabelable', reason: `venue ${c.venue} serves no ${tf} step` });
      continue;
    }
    const interval = step === INTERVAL_STEP_MS[tf] ? tf : `${step / 60_000}m`;
    const grid = holdGrid(c.checkedAtMs, c.holdHours, step);
    const aged = opt.nowMs - holdEndMs >= UNREADABLE_AFTER_MS;
    let bars: Candle[];
    try {
      const raw = await deps.candles(c.venue as ExchangeId, c.coin, tf, grid.firstOpenMs, grid.firstOpenMs + (grid.bars - 1) * step, step);
      const inWindow = new Map<number, Candle>();
      for (const b of raw) if (b.time >= grid.firstOpenMs && b.time < grid.firstOpenMs + grid.bars * step) inWindow.set(b.time, b);
      bars = [...inWindow.values()].sort((x, y) => x.time - y.time);
    } catch (e) {
      if (e instanceof WeightBudgetSkipError) { spentVenues.add(c.venue); counts.deferred_budget += 1; continue; }
      if (aged) { await write({ ...base, interval, status: 'unlabelable', reason: `fetch failed 7 days after the hold: ${String((e as Error)?.message ?? e).slice(0, 120)}` }); continue; }
      counts.deferred_fetch += 1;
      continue;
    }
    const missing = grid.bars < 1 ? [] : missingBars(bars, grid.firstOpenMs, grid.bars, step);
    if (grid.bars < 1 || missing.length > 0) {
      if (aged) {
        await write({ ...base, interval, status: 'unlabelable', reason: grid.bars < 1 ? 'hold shorter than one bar' : `venue gap: ${missing.length} of ${grid.bars} ${interval} bars missing 7 days after the hold` });
      } else {
        counts.deferred_gap += 1;
      }
      continue;
    }
    let label: ReturnType<typeof labelFromBars>;
    try {
      label = labelFromBars(c, bars);
    } catch {
      counts.label_errors += 1;
      continue;
    }
    await write({ ...base, interval, ...label, status: 'labeled', reason: null });
  }

  const cut = counts.deferred_fetch + counts.deferred_budget + counts.deferred_stop;
  if (counts.write_errors > 0 || counts.label_errors > 0 || counts.refused_unfinished > 0) {
    return { verdict: 'FAIL', counts, reason: 'a write or a label failed, or the work-list handed over an unsettled hold', firstLabeledAt };
  }
  if (cut > 0) return { verdict: 'INDETERMINATE', counts, reason: 'the run was cut short (fetch, budget, time or stop)', firstLabeledAt };
  return { verdict: 'PASS', counts, reason: null, firstLabeledAt };
}

/** The live candle source: the venue's own `getCandles`, paged forward from the first open time. */
async function fetchWindow(venue: ExchangeId, coin: string, tf: string, fromOpenMs: number, toOpenMs: number, stepMs: number): Promise<Candle[]> {
  const adapter = getAdapter(venue);
  const out: Candle[] = [];
  let cursor = fromOpenMs;
  for (let page = 0; cursor <= toOpenMs && page < MAX_PAGES; page += 1) {
    const got = await adapter.getCandles(coin, tf, cursor, undefined, toOpenMs + stepMs - 1);
    if (!got || got.length === 0) break;
    let maxTime = cursor - stepMs;
    for (const c of got) {
      out.push(c);
      if (c.time > maxTime) maxTime = c.time;
    }
    if (maxTime < cursor) break; // no forward progress: the venue's horizon
    cursor = maxTime + stepMs;
    await new Promise((r) => setTimeout(r, DELAY_BETWEEN_FETCHES_MS));
  }
  return out;
}

function argValue(argv: string[], name: string, dflt: number): number {
  const i = argv.indexOf(name);
  const v = i >= 0 ? Number(argv[i + 1]) : dflt;
  return Number.isInteger(v) && v > 0 ? v : dflt;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  installGracefulStop();
  const nowMs = Date.now();
  const res = await runLabeler(
    {
      query: (sql, params) => dbQuery(sql, params),
      candles: fetchWindow,
      stepMs: servedCandleStepMs,
      stop: isStopRequested,
    },
    {
      nowMs,
      maxChecks: argValue(argv, '--max-checks', 500),
      deadlineMs: nowMs + argValue(argv, '--time-budget-min', 30) * 60_000,
      clock: Date.now,
    },
  );
  console.log(
    `PRE_TRADE_OUTCOME_COUNTS ${JSON.stringify(res.counts)}` +
      `${res.firstLabeledAt ? ` first_labeled_at=${res.firstLabeledAt}` : ''}${res.reason ? ` reason="${res.reason}"` : ''}`,
  );
  console.log(`PRE_TRADE_OUTCOME_VERDICT=${res.verdict}`);
  return res.verdict === 'PASS' ? 0 : res.verdict === 'FAIL' ? 1 : 3;
}

if (process.argv[1] && process.argv[1].includes('pre-trade-outcome-labeler')) {
  void runScript('pre-trade-outcome-labeler', () => runAsBatch(() => main(), 'pre_trade_outcome_labeler'));
}

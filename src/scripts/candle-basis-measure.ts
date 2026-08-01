#!/usr/bin/env node
/**
 * candle-basis-measure.ts — SIGNAL-CLOSEDBAR-SHADOW-W1 CH4
 *
 * READ-ONLY measurement harness over `candle_basis_shadow`. Diagnostic §9's open gap is
 * "verdict-flip rate under each fix shape is unmeasured", and component scores had never
 * been persisted before CH2 — so there is no retrospective path, only forward measurement.
 * This is the report the FLIP wave reads instead of guessing a threshold retune.
 *
 * The only verb this file may ever use against the database is SELECT. That is not a
 * convention, it is gate-enforced: CH4's verification gate strips comment lines and greps
 * the remainder, case-insensitively, for any mutating SQL keyword. Retention lives in
 * `nightly-carry-labeler.ts`; vacuuming lives in the monthly Postgres-maintenance cron.
 *
 *   node dist/scripts/candle-basis-measure.js --seeded-tfs=5m,15m,30m,1h,2h,4h,8h,12h,1d
 *   node dist/scripts/candle-basis-measure.js --seeded-tfs=... --format=json
 *
 * ── Output contract ──────────────────────────────────────────────────────────
 * The report goes to STDOUT and the VERDICT LINE IS ALWAYS THE LAST LINE, in both
 * formats, so a wrapper can `tail -1` it without parsing anything. `--format=json`
 * emits the whole report as a SINGLE line of JSON followed by that verdict line, so
 * the host wrapper writes the report with `sed '$d'` and the verdict with `tail -1`.
 * `runScript` only ever writes to stderr, so it cannot append past the verdict.
 *
 * ── Why `--seeded-tfs` is an INPUT and never a default ───────────────────────
 * Readiness is per-timeframe, and the set of SEEDED timeframes lives in the Hetzner root
 * crontab, which this process cannot read — not from inside the container and not from a
 * laptop. Three different "live" sets exist and were resolved at Step 0 (SUPPORTED = 11,
 * EXPOSED = 9, SEEDED = 9), so any built-in default would silently encode the wrong one.
 * Absent ⇒ the verdict is `seeded_tfs_not_supplied`. The CH7 host wrapper derives it from
 * live `crontab -l` and passes it in.
 */

import { dbQuery } from '../lib/performance-db.js';
import { runScript } from '../lib/script-lifecycle.js';

/** Readiness thresholds — the flip wave's evidence bar, fully parenthesised below. */
export const READINESS_MIN_ROWS = 500;
export const READINESS_MIN_DAYS = 7;
export const READINESS_MIN_ROWS_PER_TF = 20;

/**
 * Live scoring constants, mirrored here for the "projected volume at CURRENT thresholds"
 * section. They are read-only context for the report, never applied to anything.
 * (`get-trade-call.ts` owns them; it is frozen by CH2, so they are duplicated rather than
 * exported — a WIS candidate if a third consumer appears.)
 */
export const CURRENT_MAX_RAW_SCORE = 89;
export const CURRENT_BUY_BASE_THRESHOLD = 40;
export const CURRENT_SELL_THRESHOLD_GATED = 55;

/** The volume ladder's FLOOR — the value a 10%-elapsed bar scores purely for being young. */
export const VOL_SCORE_FLOOR = -70;

export interface ShadowRow {
  tool: string | null;
  timeframe: string;
  call_live: string;
  call_closed: string | null;
  error_class: string | null;
  conf_live: number | null;
  conf_closed: number | null;
  raw_live: number | null;
  raw_closed: number | null;
  vol_score_live: number | null;
  vol_score_closed: number | null;
  pivot_quality_live: number | null;
  pivot_quality_closed: number | null;
  elapsed_fraction: number | null;
  /** ISO-8601 UTC. Rendered by the query so both backends agree on the shape. */
  recorded_at: string;
}

/* ────────────────────────────── pure helpers ─────────────────────────────── */

/**
 * Elapsed-fraction decile label. `null` is its OWN bucket, not folded into `0` — a venue
 * that omits the in-progress bar is a materially different population from one whose bar
 * is 0-10% elapsed, and conflating them would hide exactly the venues where the defect
 * cannot occur. Values are clamped so a 1.0 (or a clock-skew 1.02) lands in `90-100`.
 */
export function decileOf(elapsed: number | null | undefined): string {
  if (elapsed === null || elapsed === undefined || !Number.isFinite(elapsed)) return 'NULL';
  const d = Math.min(9, Math.max(0, Math.floor(elapsed * 10)));
  return `${d * 10}-${d * 10 + 10}`;
}

/** All decile labels in report order, NULL last so it reads as the exception it is. */
export const DECILE_LABELS: readonly string[] = [
  ...Array.from({ length: 10 }, (_, d) => `${d * 10}-${d * 10 + 10}`),
  'NULL',
];

/** `HOLD->BUY` etc. Null (the closed pass threw) is never a transition. */
export function transitionKey(live: string, closed: string | null): string | null {
  if (closed === null || closed === live) return null;
  return `${live}->${closed}`;
}

/** The six transitions the flip wave cares about, in report order. */
export const TRANSITIONS: readonly string[] = [
  'HOLD->BUY', 'HOLD->SELL', 'BUY->HOLD', 'SELL->HOLD', 'BUY->SELL', 'SELL->BUY',
];

export interface FlipStats {
  n: number;
  /** Rows where BOTH bases produced a verdict — the only rows a flip rate can be over. */
  nComparable: number;
  nFlipped: number;
  flipRate: number;
  transitions: Record<string, number>;
  /** Rows the closed pass could not score, by throw class. */
  errorsByClass: Record<string, number>;
}

export function flipStats(rows: readonly ShadowRow[]): FlipStats {
  const transitions: Record<string, number> = Object.fromEntries(TRANSITIONS.map((t) => [t, 0]));
  const errorsByClass: Record<string, number> = {};
  let nComparable = 0;
  let nFlipped = 0;

  for (const r of rows) {
    if (r.call_closed === null) {
      const k = r.error_class ?? 'unknown';
      errorsByClass[k] = (errorsByClass[k] ?? 0) + 1;
      continue;
    }
    nComparable += 1;
    const key = transitionKey(r.call_live, r.call_closed);
    if (key === null) continue;
    nFlipped += 1;
    transitions[key] = (transitions[key] ?? 0) + 1;
  }

  return {
    n: rows.length,
    nComparable,
    nFlipped,
    flipRate: nComparable === 0 ? 0 : nFlipped / nComparable,
    transitions,
    errorsByClass,
  };
}

/**
 * Nearest-rank percentile over an ALREADY-SORTED ascending array. Returns null on an empty
 * input rather than NaN, so a no-data cell renders as "-" instead of a number-shaped lie.
 */
export function percentile(sortedAsc: readonly number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))];
}

export interface DeltaStats {
  n: number;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
}

/** Distribution of `closed - live` over the rows where both sides exist. */
export function deltaStats(values: readonly number[]): DeltaStats {
  if (values.length === 0) return { n: 0, mean: null, p50: null, p95: null, min: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    n: sorted.length,
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

export interface VolScoreStats {
  n: number;
  /** How often the ladder bottomed out — the defect's headline number. */
  floorCount: number;
  floorRate: number;
  histogram: Record<string, number>;
  /** Highest |raw| actually observed, i.e. how much of the ceiling is reachable. */
  maxAbsRaw: number | null;
}

export function volScoreStats(
  volScores: readonly (number | null)[],
  rawScores: readonly (number | null)[],
): VolScoreStats {
  const histogram: Record<string, number> = {};
  let n = 0;
  let floorCount = 0;
  for (const v of volScores) {
    if (v === null) continue;
    n += 1;
    if (v === VOL_SCORE_FLOOR) floorCount += 1;
    const k = String(v);
    histogram[k] = (histogram[k] ?? 0) + 1;
  }
  let maxAbsRaw: number | null = null;
  for (const r of rawScores) {
    if (r === null || !Number.isFinite(r)) continue;
    const a = Math.abs(r);
    if (maxAbsRaw === null || a > maxAbsRaw) maxAbsRaw = a;
  }
  return { n, floorCount, floorRate: n === 0 ? 0 : floorCount / n, histogram, maxAbsRaw };
}

/**
 * Projected emitted-verdict volume per basis at the CURRENT thresholds. `call_closed` was
 * already scored through the same `deriveVerdict` with those thresholds, so this is a
 * count, not a re-derivation — which is the point: a second scoring path here would drift
 * from the engine it is meant to predict.
 */
export function verdictVolume(rows: readonly ShadowRow[]): {
  live: Record<string, number>;
  closed: Record<string, number>;
} {
  const live: Record<string, number> = { BUY: 0, SELL: 0, HOLD: 0 };
  const closed: Record<string, number> = { BUY: 0, SELL: 0, HOLD: 0 };
  for (const r of rows) {
    live[r.call_live] = (live[r.call_live] ?? 0) + 1;
    if (r.call_closed !== null) closed[r.call_closed] = (closed[r.call_closed] ?? 0) + 1;
  }
  return { live, closed };
}

export function groupBy<T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const bucket = out.get(k);
    if (bucket) bucket.push(r);
    else out.set(k, [r]);
  }
  return out;
}

/** `YYYY-MM-DD` in UTC from the ISO stamp the query renders. */
export function utcDay(recordedAt: string): string {
  return String(recordedAt).slice(0, 10);
}

export interface Readiness {
  ready: boolean;
  reasons: string[];
  nRows: number;
  distinctDays: number;
  perTf: Record<string, number>;
  seededTfs: string[] | null;
}

/**
 * READY iff ( n_noninternal >= 500 )
 *        AND ( distinct_utc_days >= 7 )
 *        AND ( for every tf in seeded_tfs : n[tf] >= 20 )
 *
 * Computed, never argued. `seededTfs === null` is its own first-class reason: the caller
 * failed to supply the set, so per-timeframe readiness is UNKNOWN rather than satisfied.
 * The writers already exclude internal-tier callers, so every stored row is non-internal.
 */
export function readiness(rows: readonly ShadowRow[], seededTfs: string[] | null): Readiness {
  const reasons: string[] = [];
  const perTf: Record<string, number> = {};
  for (const [tf, rs] of groupBy(rows, (r) => r.timeframe)) perTf[tf] = rs.length;
  const distinctDays = new Set(rows.map((r) => utcDay(r.recorded_at))).size;

  if (seededTfs === null) reasons.push('seeded_tfs_not_supplied');
  if (rows.length < READINESS_MIN_ROWS) {
    reasons.push(`n_rows=${rows.length}<${READINESS_MIN_ROWS}`);
  }
  if (distinctDays < READINESS_MIN_DAYS) {
    reasons.push(`distinct_utc_days=${distinctDays}<${READINESS_MIN_DAYS}`);
  }
  if (seededTfs !== null) {
    const short = seededTfs
      .filter((tf) => (perTf[tf] ?? 0) < READINESS_MIN_ROWS_PER_TF)
      .map((tf) => `${tf}=${perTf[tf] ?? 0}`);
    if (short.length > 0) {
      reasons.push(`tf_below_${READINESS_MIN_ROWS_PER_TF}:${short.join(',')}`);
    }
  }

  return { ready: reasons.length === 0, reasons, nRows: rows.length, distinctDays, perTf, seededTfs };
}

/** `CANDLE_BASIS_FLIP_READY` / `CANDLE_BASIS_FLIP_NOT_READY: <reason>[; <reason>]`. */
export function verdictLine(r: Readiness): string {
  if (r.ready) {
    return `CANDLE_BASIS_FLIP_READY: n=${r.nRows} days=${r.distinctDays} ` +
      `seeded_tfs=${(r.seededTfs ?? []).join(',')}`;
  }
  return `CANDLE_BASIS_FLIP_NOT_READY: ${r.reasons.join('; ')}`;
}

/** `--seeded-tfs=a,b,c` → `['a','b','c']`; absent or empty → null (never a default). */
export function parseSeededTfs(argv: readonly string[]): string[] | null {
  const arg = argv.find((a) => a.startsWith('--seeded-tfs='));
  if (arg === undefined) return null;
  const parts = arg.slice('--seeded-tfs='.length).split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length === 0 ? null : parts;
}

/* ─────────────────────────────── report body ─────────────────────────────── */

export interface Report {
  generated_at: string;
  window: { first: string | null; last: string | null };
  n_rows: number;
  by_tool: Record<string, number>;
  load_error: string | null;
  overall: FlipStats;
  by_timeframe: Record<string, FlipStats>;
  by_decile: Record<string, FlipStats>;
  null_decile_n: number;
  confidence_delta: DeltaStats;
  pivot_quality_delta: DeltaStats;
  vol_score: { live: VolScoreStats; closed: VolScoreStats };
  verdict_volume: { live: Record<string, number>; closed: Record<string, number> };
  daily: Array<{ day: string; n: number; n_flipped: number; flip_rate: number }>;
  readiness: Readiness;
  thresholds: { max_raw_score: number; buy_base: number; sell_gated: number };
}

export function buildReport(
  rows: readonly ShadowRow[],
  seededTfs: string[] | null,
  nowIso: string,
  loadError: string | null,
): Report {
  const sorted = [...rows].sort((a, b) => String(a.recorded_at).localeCompare(String(b.recorded_at)));
  const byTool: Record<string, number> = {};
  for (const r of rows) {
    const k = r.tool ?? 'get_trade_call';
    byTool[k] = (byTool[k] ?? 0) + 1;
  }

  const byTimeframe: Record<string, FlipStats> = {};
  for (const [tf, rs] of groupBy(rows, (r) => r.timeframe)) byTimeframe[tf] = flipStats(rs);

  const byDecile: Record<string, FlipStats> = {};
  const decileGroups = groupBy(rows, (r) => decileOf(r.elapsed_fraction));
  for (const label of DECILE_LABELS) byDecile[label] = flipStats(decileGroups.get(label) ?? []);

  const confDeltas: number[] = [];
  const pivotDeltas: number[] = [];
  for (const r of rows) {
    if (r.conf_live !== null && r.conf_closed !== null) confDeltas.push(r.conf_closed - r.conf_live);
    if (r.pivot_quality_live !== null && r.pivot_quality_closed !== null) {
      pivotDeltas.push(r.pivot_quality_closed - r.pivot_quality_live);
    }
  }

  const daily = [...groupBy(sorted, (r) => utcDay(r.recorded_at))]
    .map(([day, rs]) => {
      const f = flipStats(rs);
      return { day, n: rs.length, n_flipped: f.nFlipped, flip_rate: f.flipRate };
    })
    .sort((a, b) => a.day.localeCompare(b.day));

  return {
    generated_at: nowIso,
    window: {
      first: sorted.length > 0 ? sorted[0].recorded_at : null,
      last: sorted.length > 0 ? sorted[sorted.length - 1].recorded_at : null,
    },
    n_rows: rows.length,
    by_tool: byTool,
    load_error: loadError,
    overall: flipStats(rows),
    by_timeframe: byTimeframe,
    by_decile: byDecile,
    null_decile_n: (decileGroups.get('NULL') ?? []).length,
    confidence_delta: deltaStats(confDeltas),
    pivot_quality_delta: deltaStats(pivotDeltas),
    vol_score: {
      live: volScoreStats(rows.map((r) => r.vol_score_live), rows.map((r) => r.raw_live)),
      closed: volScoreStats(rows.map((r) => r.vol_score_closed), rows.map((r) => r.raw_closed)),
    },
    verdict_volume: verdictVolume(rows),
    daily,
    readiness: readiness(rows, seededTfs),
    thresholds: {
      max_raw_score: CURRENT_MAX_RAW_SCORE,
      buy_base: CURRENT_BUY_BASE_THRESHOLD,
      sell_gated: CURRENT_SELL_THRESHOLD_GATED,
    },
  };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const num = (x: number | null, digits = 2): string => (x === null ? '-' : x.toFixed(digits));

export function renderMarkdown(rep: Report): string {
  const L: string[] = [];
  L.push('# candle_basis_shadow — closed-bar divergence report');
  L.push('');
  L.push(`generated_at: ${rep.generated_at}`);
  L.push(`window: ${rep.window.first ?? '-'} .. ${rep.window.last ?? '-'}`);
  L.push(`n_rows: ${rep.n_rows}`);
  L.push(`by_tool: ${Object.entries(rep.by_tool).map(([k, v]) => `${k}=${v}`).join(' ') || '-'}`);
  if (rep.load_error !== null) L.push(`load_error: ${rep.load_error}`);
  L.push('');

  L.push('## Verdict flips');
  L.push(`comparable: ${rep.overall.nComparable}  flipped: ${rep.overall.nFlipped}  rate: ${pct(rep.overall.flipRate)}`);
  for (const t of TRANSITIONS) L.push(`  ${t.padEnd(12)} ${rep.overall.transitions[t] ?? 0}`);
  const errs = Object.entries(rep.overall.errorsByClass);
  L.push(`closed-basis unscored: ${errs.length === 0 ? '0' : errs.map(([k, v]) => `${k}=${v}`).join(' ')}`);
  L.push('');

  L.push('## By timeframe');
  L.push('| tf | n | comparable | flipped | rate |');
  L.push('|----|---|-----------|---------|------|');
  for (const [tf, f] of Object.entries(rep.by_timeframe).sort()) {
    L.push(`| ${tf} | ${f.n} | ${f.nComparable} | ${f.nFlipped} | ${pct(f.flipRate)} |`);
  }
  if (Object.keys(rep.by_timeframe).length === 0) L.push('| - | 0 | 0 | 0 | 0.0% |');
  L.push('');

  L.push('## By elapsed-fraction decile (NULL = venue omitted the in-progress bar)');
  L.push('| decile | n | comparable | flipped | rate |');
  L.push('|--------|---|-----------|---------|------|');
  for (const label of DECILE_LABELS) {
    const f = rep.by_decile[label];
    L.push(`| ${label} | ${f.n} | ${f.nComparable} | ${f.nFlipped} | ${pct(f.flipRate)} |`);
  }
  L.push(`null_decile_n: ${rep.null_decile_n}`);
  L.push('');

  L.push('## Score distributions');
  for (const [basis, v] of [['live', rep.vol_score.live], ['closed', rep.vol_score.closed]] as const) {
    L.push(`${basis}: n=${v.n} floor(${VOL_SCORE_FLOOR})=${v.floorCount} (${pct(v.floorRate)}) ` +
      `max|raw|=${num(v.maxAbsRaw, 1)} of ceiling ${rep.thresholds.max_raw_score}`);
    const hist = Object.entries(v.histogram).sort((a, b) => Number(a[0]) - Number(b[0]));
    L.push(`  histogram: ${hist.map(([k, c]) => `${k}:${c}`).join(' ') || '-'}`);
  }
  const cd = rep.confidence_delta;
  L.push(`confidence delta (closed-live): n=${cd.n} mean=${num(cd.mean)} p50=${num(cd.p50)} p95=${num(cd.p95)} min=${num(cd.min)} max=${num(cd.max)}`);
  const pq = rep.pivot_quality_delta;
  L.push(`pivot_quality delta (closed-live): n=${pq.n} mean=${num(pq.mean, 4)} p50=${num(pq.p50, 4)} p95=${num(pq.p95, 4)}`);
  L.push('');

  L.push(`## Projected verdict volume at CURRENT thresholds (buy>=${rep.thresholds.buy_base}, sell-gated>=${rep.thresholds.sell_gated})`);
  L.push(`live:   ${Object.entries(rep.verdict_volume.live).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  L.push(`closed: ${Object.entries(rep.verdict_volume.closed).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  L.push('');

  L.push('## Daily');
  L.push('| day | n | flipped | rate |');
  L.push('|-----|---|---------|------|');
  for (const d of rep.daily) L.push(`| ${d.day} | ${d.n} | ${d.n_flipped} | ${pct(d.flip_rate)} |`);
  if (rep.daily.length === 0) L.push('| - | 0 | 0 | 0.0% |');
  L.push('');

  L.push('## Readiness');
  L.push(`n_rows=${rep.readiness.nRows} (>=${READINESS_MIN_ROWS})  distinct_utc_days=${rep.readiness.distinctDays} (>=${READINESS_MIN_DAYS})`);
  L.push(`seeded_tfs: ${rep.readiness.seededTfs === null ? 'NOT SUPPLIED' : rep.readiness.seededTfs.join(',')}`);
  L.push(`per-tf (need >=${READINESS_MIN_ROWS_PER_TF}): ${Object.entries(rep.readiness.perTf).sort().map(([k, v]) => `${k}=${v}`).join(' ') || '-'}`);
  return L.join('\n');
}

/* ──────────────────────────────── main ───────────────────────────────────── */

/**
 * The ONE query. Every column the report needs, no filter beyond the table itself — the
 * writers already exclude internal-tier callers, so filtering again here would silently
 * narrow the denominator the readiness formula is defined over.
 *
 * `recorded_at` is rendered to an ISO string in SQL so the day-bucketing is UTC on both
 * backends rather than depending on how each driver hydrates a timestamp.
 */
const SELECT_SQL = `SELECT tool, timeframe, call_live, call_closed, error_class,
       conf_live, conf_closed, raw_live, raw_closed,
       vol_score_live, vol_score_closed,
       pivot_quality_live, pivot_quality_closed,
       elapsed_fraction,
       to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SSZ') AS recorded_at
  FROM candle_basis_shadow
 ORDER BY recorded_at ASC`;

/** Numeric columns arrive as strings from `pg` (NUMERIC) — coerce once, here. */
function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function normalizeRow(raw: Record<string, unknown>): ShadowRow {
  return {
    tool: (raw.tool as string | null) ?? null,
    timeframe: String(raw.timeframe ?? ''),
    call_live: String(raw.call_live ?? ''),
    call_closed: (raw.call_closed as string | null) ?? null,
    error_class: (raw.error_class as string | null) ?? null,
    conf_live: toNum(raw.conf_live),
    conf_closed: toNum(raw.conf_closed),
    raw_live: toNum(raw.raw_live),
    raw_closed: toNum(raw.raw_closed),
    vol_score_live: toNum(raw.vol_score_live),
    vol_score_closed: toNum(raw.vol_score_closed),
    pivot_quality_live: toNum(raw.pivot_quality_live),
    pivot_quality_closed: toNum(raw.pivot_quality_closed),
    elapsed_fraction: toNum(raw.elapsed_fraction),
    recorded_at: String(raw.recorded_at ?? ''),
  };
}

/**
 * Day-1 is the EXPECTED state: before CH5 there is no table anywhere but a dev database,
 * and on a SQLite backend the table cannot exist at all. A missing or unreadable table is
 * therefore reported as a zero-row window with the cause named, NOT as a crash — the
 * report still has to reach its verdict line, which is what the gate asserts on. A genuine
 * database fault is not swallowed: it is printed as `load_error` and, because it also
 * leaves `n_rows` at 0, it can never produce a READY verdict.
 */
export async function loadRows(): Promise<{ rows: ShadowRow[]; loadError: string | null }> {
  try {
    const raw = await dbQuery<Record<string, unknown>>(SELECT_SQL);
    return { rows: raw.map(normalizeRow), loadError: null };
  } catch (e) {
    const msg = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
    return { rows: [], loadError: msg.slice(0, 300) };
  }
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const seededTfs = parseSeededTfs(argv);
  const asJson = argv.includes('--format=json');

  const { rows, loadError } = await loadRows();
  const rep = buildReport(rows, seededTfs, new Date().toISOString(), loadError);

  process.stdout.write((asJson ? JSON.stringify(rep) : renderMarkdown(rep)) + '\n');
  process.stdout.write(verdictLine(rep.readiness) + '\n');
}

if (require.main === module) {
  void runScript('candle-basis-measure', main);
}

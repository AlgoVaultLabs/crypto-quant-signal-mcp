/**
 * oi-snapshots.ts — SCAN-RANKBY-W3 CH2
 *
 * The canonical open-interest time-series store + the ONE OI-delta derivation
 * (`computeOiDelta`). Both the new `oi_change` rankBy lens (rank-metrics.ts) and
 * the corrected get_trade_call OI factor (get-trade-call.ts) read THIS — the
 * single-derivation LAW: never a real OI delta in the lens beside a price-proxy
 * in the factor (SCAN-RANKBY-W3 CH1: the old `oi_change_pct` was priceChange×100).
 *
 * Producer: src/scripts/oi-snapshot-sampler.ts (hourly, all 5 PROMOTED venues).
 * Backfill: src/scripts/oi-snapshot-backfill.ts (one-time warming shrink).
 *
 * Mirrors seed-heartbeats.ts: reaches the firewalled performance-db via the
 * exported `dbQuery`; PG-targeted ($N placeholders — the production backend);
 * table SSH-preapplied (migrations/011_oi_snapshots.sql) + lazily ensured here
 * for fresh-box repro. `oiDeltaFromSnapshots` is pure (unit-tested); the DB
 * wrappers' SQL/param contract is mock-tested + verified live post-deploy (the
 * dual-backend deferral — $N SQL is not exercised on the SQLite test backend).
 */

import { dbQuery } from './performance-db.js';

/** Hour bucket — the sampler stores one row per (venue, symbol, hour). */
export const OI_BUCKET_MS = 60 * 60 * 1000;
/** Default OI-delta window: 24h (trader-standard, matches Coinglass/Coinalyze "OI 24h%"). */
export const DEFAULT_OI_WINDOW_MS = 24 * OI_BUCKET_MS;
export const OI_WINDOW_LABEL = '24h';

/**
 * SCAN-RANKBY-REFINEMENTS-W1 CH1 — the trader-selectable OI-delta windows for the
 * `oi_change` lens. The sampler stores one point per hour, so each of 1h/4h/24h
 * resolves to ≥2 points spanning the window. '24h' is the default ⇒ byte-identical
 * to the SCAN-RANKBY-W3 behaviour when `oiChangeWindow` is omitted.
 */
export const OI_WINDOWS = {
  '1h': OI_BUCKET_MS,
  '4h': 4 * OI_BUCKET_MS,
  '24h': DEFAULT_OI_WINDOW_MS,
} as const;
export type OiWindow = keyof typeof OI_WINDOWS;
export const DEFAULT_OI_WINDOW: OiWindow = '24h';

/** ms → human window label, for the `oi_change_window` echo (any of the 3 windows; else 24h). */
export function oiWindowLabelForMs(windowMs: number): string {
  for (const [label, ms] of Object.entries(OI_WINDOWS)) {
    if (ms === windowMs) return label;
  }
  return OI_WINDOW_LABEL;
}

/**
 * SCAN-RANKBY-REFINEMENTS-W1 CH3 — the OI-delta basis. 'notional' = USD notional
 * (the existing default; carries a price component). 'contracts' = base-coin-unit
 * OI (price-INDEPENDENT; "is this NEW money?"). 'notional' ⇒ byte-identical to W3.
 */
export type OiBasis = 'notional' | 'contracts';
export const DEFAULT_OI_BASIS: OiBasis = 'notional';

const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS oi_snapshots (
  exchange      TEXT             NOT NULL,
  symbol        TEXT             NOT NULL,
  ts            BIGINT           NOT NULL,
  oi            DOUBLE PRECISION,
  contracts_oi  DOUBLE PRECISION,
  mark_price    DOUBLE PRECISION,
  index_price   DOUBLE PRECISION,
  basis_bps     DOUBLE PRECISION,
  spread_bps    DOUBLE PRECISION,
  PRIMARY KEY (exchange, symbol, ts)
)`;
// OPS-STRUCTURAL-FEATURE-ACCRUAL-W1 (Q2b): `computeOiDeltaForPool` filters `exchange = $1 AND
// ts >= $2` with NO symbol predicate, so the (exchange, symbol, ts) PK cannot range-scan `ts` —
// it walks every index entry for the venue. Survivable under the 30-day prune; with retention now
// PERMANENT the table grows ~6×/6mo, so that read needs its own (exchange, ts) index.
const CREATE_INDEX_SQL =
  `CREATE INDEX IF NOT EXISTS idx_oi_snapshots_exch_ts ON oi_snapshots (exchange, ts)`;
// Q8: `idx_oi_snapshots_exch_sym_ts` was byte-identical to `oi_snapshots_pkey` (both btree
// (exchange, symbol, ts)) — a pure duplicate, ~half the table's index storage. Dropped here AND in
// migrations/022 so the lazy ensure can never recreate it. ROLLBACK:
//   CREATE INDEX idx_oi_snapshots_exch_sym_ts ON oi_snapshots (exchange, symbol, ts);
const DROP_DUP_INDEX_SQL = `DROP INDEX IF EXISTS idx_oi_snapshots_exch_sym_ts`;
// SCAN-RANKBY-REFINEMENTS-W1 CH3: base-coin OI column (price-independent). Idempotent
// ADD COLUMN IF NOT EXISTS (Postgres 9.6+, the prod backend) mirrors migrations/020 for
// the lazily-ensured fresh-box path; a no-op against the SSH-preapplied prod table.
// W1 appends the four structural columns and drops `oi`'s NOT NULL: ASTER/BINGX carry
// basis/spread with NO real OI (their notionalOI_usd is a 24h-volume proxy), so a row with
// oi NULL is the HONEST representation, not a defect (Q4).
const ALTER_COL_SQLS = [
  `ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS contracts_oi DOUBLE PRECISION`,
  `ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS mark_price  DOUBLE PRECISION`,
  `ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS index_price DOUBLE PRECISION`,
  `ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS basis_bps   DOUBLE PRECISION`,
  `ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS spread_bps  DOUBLE PRECISION`,
  `ALTER TABLE oi_snapshots ALTER COLUMN oi DROP NOT NULL`,
];
// The spec's contract name for the FUTURE consumers (B-DIR v3, carry ranker v2, AVS examples).
// A VIEW, not a second table: one physical stream, one derivation, zero consumer breakage (Q6).
const CREATE_VIEW_SQL = `CREATE OR REPLACE VIEW structural_snapshots AS
  SELECT exchange AS venue, symbol, ts, oi AS open_interest, contracts_oi AS oi_contracts,
         mark_price, index_price, basis_bps, spread_bps
  FROM oi_snapshots`;

let _ensured = false;

/** Idempotent table+column+index+view ensure (matches the SSH-preapplied DDL); once per process. */
async function ensureTable(): Promise<void> {
  if (_ensured) return;
  await dbQuery(CREATE_TABLE_SQL);
  await dbQuery(CREATE_INDEX_SQL);
  await dbQuery(DROP_DUP_INDEX_SQL);
  for (const sql of ALTER_COL_SQLS) await dbQuery(sql);
  await dbQuery(CREATE_VIEW_SQL);
  _ensured = true;
}

/** Test-only reset of the once-per-process ensure flag. */
export function _resetOiSnapshotsEnsure(): void {
  _ensured = false;
}

/** Floor an epoch-ms instant to its hour bucket. */
export function bucketHour(ms: number): number {
  return Math.floor(ms / OI_BUCKET_MS) * OI_BUCKET_MS;
}

export interface OiSnapshotInput {
  symbol: string;
  /** USD notional open interest (oi × price). NULL-written when absent/non-positive —
   *  OPS-STRUCTURAL-FEATURE-ACCRUAL-W1: ASTER/BINGX have no real OI but DO have basis/spread. */
  oi?: number | null;
  /** SCAN-RANKBY-REFINEMENTS-W1 CH3: base-coin-unit OI (price-independent). Optional —
   *  omitted/non-finite/≤0 ⇒ NULL contracts_oi ("warming" for the contracts basis). */
  contracts?: number;
  /** Epoch ms (the caller floors to the hour bucket). */
  ts: number;
  // ── W1 structural fields. Each independently optional; absent ⇒ NULL, counted, never guessed. ──
  /** Perp mark price (venue-native). */
  mark?: number;
  /** Index / oracle price — the venue's OWN spot reference. */
  index?: number;
  /** Best bid. */
  bid?: number;
  /** Best ask. */
  ask?: number;
}

/** Strictly-positive finite, else null (the DB representation of "venue did not expose it"). */
function posOrNull(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null;
}

/**
 * PURE — perp basis in basis points: how far the perp's mark trades from its own index/oracle.
 * Positive = perp premium (longs paying up); negative = discount.
 *
 * There is NO spot-price path in this repo (all 17 adapters are perps-only), so the reference is
 * always the VENUE'S OWN index/oracle price — never a spot lookup, never another venue's index.
 * Returns null unless both sides are strictly-positive finite (Factuality > Completeness:
 * a NULL that is counted beats a number that was inferred).
 */
export function basisBps(mark: unknown, index: unknown): number | null {
  const m = posOrNull(mark);
  const i = posOrNull(index);
  if (m === null || i === null) return null;
  const bps = ((m - i) / i) * 10_000;
  return Number.isFinite(bps) ? bps : null;
}

/**
 * PURE — top-of-book spread in basis points, over the MID (not the bid): `(ask−bid)/mid × 1e4`.
 * Returns null unless both sides are strictly-positive finite. A crossed/locked book (ask ≤ bid)
 * still yields a value (≤ 0) — that is real microstructure, not junk, and suppressing it would
 * hide exactly the dislocations this stream exists to record.
 */
export function spreadBps(bid: unknown, ask: unknown): number | null {
  const b = posOrNull(bid);
  const a = posOrNull(ask);
  if (b === null || a === null) return null;
  const mid = (a + b) / 2;
  if (mid <= 0) return null;
  const bps = ((a - b) / mid) * 10_000;
  return Number.isFinite(bps) ? bps : null;
}

const INSERT_CHUNK = 200; // rows per multi-VALUES insert (9 params each — well under PG's 65535 cap)
const INSERT_COLS = 9;

/**
 * Batch-upsert snapshots for `exchange`, deduped per (exchange, symbol, ts) via
 * ON CONFLICT DO NOTHING (first-write-wins per bucket → idempotent re-runs).
 *
 * W1 widened the row from OI-only to the full structural tuple. A row is written when it carries
 * a valid `ts`, a `symbol`, AND at least one MEASUREMENT (oi, or any of mark/index/bid/ask) — an
 * all-empty row would be a false "we sampled this and found nothing". Returns rows attempted.
 */
export async function recordOiSnapshots(exchange: string, rows: OiSnapshotInput[]): Promise<number> {
  const valid = rows.filter((r) => {
    if (!r.symbol || !Number.isFinite(r.ts)) return false;
    return (
      posOrNull(r.oi) !== null ||
      posOrNull(r.mark) !== null ||
      posOrNull(r.index) !== null ||
      posOrNull(r.bid) !== null ||
      posOrNull(r.ask) !== null
    );
  });
  if (valid.length === 0) return 0;
  await ensureTable();
  for (let i = 0; i < valid.length; i += INSERT_CHUNK) {
    const chunk = valid.slice(i, i + INSERT_CHUNK);
    const tuples: string[] = [];
    const params: unknown[] = [];
    chunk.forEach((r, j) => {
      const b = j * INSERT_COLS;
      tuples.push(
        `(${Array.from({ length: INSERT_COLS }, (_, k) => `$${b + k + 1}`).join(', ')})`,
      );
      params.push(
        exchange,
        r.symbol.toUpperCase(),
        r.ts,
        posOrNull(r.oi),
        // CH3: NULL contracts_oi when absent/non-finite/≤0 → "warming" for the contracts basis.
        posOrNull(r.contracts),
        posOrNull(r.mark),
        posOrNull(r.index),
        basisBps(r.mark, r.index),
        spreadBps(r.bid, r.ask),
      );
    });
    await dbQuery(
      `INSERT INTO oi_snapshots (exchange, symbol, ts, oi, contracts_oi, mark_price, index_price, basis_bps, spread_bps) ` +
        `VALUES ${tuples.join(', ')} ON CONFLICT (exchange, symbol, ts) DO NOTHING`,
      params,
    );
  }
  return valid.length;
}

export interface OiDelta {
  /** Real OI % change over the window (current vs nearest snapshot ≥ window-ago). */
  oi_change_pct: number;
  /** Human window label, e.g. "24h". */
  oi_change_window: string;
}

/**
 * PURE — the ONE OI-delta computation. `current` = the latest snapshot; `past` =
 * the nearest snapshot at least `windowMs` old (largest ts ≤ current.ts − windowMs).
 * Returns null ("warming") when there are < 2 points spanning the window — never a
 * stale/guessed value (Factuality > Completeness: omission beats a wrong sign).
 */
export function oiDeltaFromSnapshots(
  snapshots: Array<{ ts: number; oi: number }>,
  windowMs: number = DEFAULT_OI_WINDOW_MS,
  nowMs: number = Date.now(),
  windowLabel: string = OI_WINDOW_LABEL,
): OiDelta | null {
  const pts = snapshots
    .filter((s) => Number.isFinite(s.ts) && Number.isFinite(s.oi) && s.oi > 0 && s.ts <= nowMs)
    .sort((a, b) => a.ts - b.ts);
  if (pts.length < 2) return null;
  const current = pts[pts.length - 1];
  const targetTs = current.ts - windowMs;
  let past: { ts: number; oi: number } | null = null;
  for (const p of pts) {
    if (p.ts <= targetTs) past = p; // last (closest-from-below) point ≥ window-ago
    else break;
  }
  if (!past || past.oi <= 0) return null; // no point spans the window yet → warming
  const pct = ((current.oi - past.oi) / past.oi) * 100;
  if (!Number.isFinite(pct)) return null;
  return { oi_change_pct: parseFloat(pct.toFixed(2)), oi_change_window: windowLabel };
}

/** Fetch a touch more than the window so the ≥window-ago point is present despite bucket jitter. */
function sinceMsFor(windowMs: number, nowMs: number): number {
  return nowMs - windowMs - OI_BUCKET_MS * 2;
}

/**
 * Single-coin OI delta from the store (the get_trade_call factor + the CH4 oiScore
 * shadow). `null` = warming. SCAN-RANKBY-REFINEMENTS-W1 CH3: `basis:'contracts'`
 * reads the price-independent `contracts_oi` column (NULL rows omitted → warming);
 * 'notional' is the default and byte-identical to W3 (the SQL is unchanged).
 */
export async function computeOiDelta(
  coin: string,
  exchange: string,
  windowMs: number = DEFAULT_OI_WINDOW_MS,
  basis: OiBasis = DEFAULT_OI_BASIS,
  nowMs: number = Date.now(),
): Promise<OiDelta | null> {
  const sel = basis === 'contracts' ? 'contracts_oi AS oi' : 'oi';
  // W1: `oi` is now NULLABLE (ASTER/BINGX carry basis/spread with no real OI), so the notional
  // path needs the same IS NOT NULL guard the contracts path always had — otherwise those rows
  // ride the index scan only to be dropped in JS. Behaviour is unchanged for the 10 OI venues.
  const nullGuard = basis === 'contracts' ? ' AND contracts_oi IS NOT NULL' : ' AND oi IS NOT NULL';
  const rows = await dbQuery<{ ts: number | string; oi: number | string }>(
    `SELECT ts, ${sel} FROM oi_snapshots WHERE exchange = $1 AND symbol = $2 AND ts >= $3${nullGuard} ORDER BY ts ASC`,
    [exchange, coin.toUpperCase(), sinceMsFor(windowMs, nowMs)],
  );
  return oiDeltaFromSnapshots(
    rows.map((r) => ({ ts: Number(r.ts), oi: Number(r.oi) })),
    windowMs,
    nowMs,
    oiWindowLabelForMs(windowMs),
  );
}

/** Per-coin OI delta for a whole venue (the oi_change lens). Symbols still warming are omitted. */
export async function computeOiDeltaForPool(
  exchange: string,
  windowMs: number = DEFAULT_OI_WINDOW_MS,
  basis: OiBasis = DEFAULT_OI_BASIS,
  nowMs: number = Date.now(),
): Promise<Map<string, OiDelta>> {
  // CH3: 'contracts' reads the price-independent base-coin column (NULL rows omitted);
  // 'notional' SELECTs `oi` unchanged → the default query is byte-identical to W3.
  const sel = basis === 'contracts' ? 'contracts_oi AS oi' : 'oi';
  // W1: `oi` is now NULLABLE (ASTER/BINGX carry basis/spread with no real OI), so the notional
  // path needs the same IS NOT NULL guard the contracts path always had — otherwise those rows
  // ride the index scan only to be dropped in JS. Behaviour is unchanged for the 10 OI venues.
  const nullGuard = basis === 'contracts' ? ' AND contracts_oi IS NOT NULL' : ' AND oi IS NOT NULL';
  const rows = await dbQuery<{ symbol: string; ts: number | string; oi: number | string }>(
    `SELECT symbol, ts, ${sel} FROM oi_snapshots WHERE exchange = $1 AND ts >= $2${nullGuard} ORDER BY symbol ASC, ts ASC`,
    [exchange, sinceMsFor(windowMs, nowMs)],
  );
  const bySym = new Map<string, Array<{ ts: number; oi: number }>>();
  for (const r of rows) {
    const arr = bySym.get(r.symbol) ?? [];
    arr.push({ ts: Number(r.ts), oi: Number(r.oi) });
    bySym.set(r.symbol, arr);
  }
  const out = new Map<string, OiDelta>();
  for (const [sym, pts] of bySym) {
    const d = oiDeltaFromSnapshots(pts, windowMs, nowMs, oiWindowLabelForMs(windowMs));
    if (d) out.set(sym, d);
  }
  return out;
}

/**
 * RETENTION IS PERMANENT — OPS-STRUCTURAL-FEATURE-ACCRUAL-W1 (Q2a, architect-confirmed 2026-07-21).
 *
 * `oi_snapshots` is INTERNAL training data for the pre-registered B-DIR v3 directional retry
 * (90-day diagnostic ~2026-10-19, 180-day full ~2027-01-17). The whole point of the stream is that
 * history ACCRUES, so nothing may delete it. Until this wave the sampler called this with
 * `RANK_OI_RETENTION_H` defaulting to 720 h and the env var UNSET in prod — a 30-day delete that
 * would have started erasing the accrued head start on 2026-07-26 12:00 UTC, five days after the
 * wave was written. The retention decision is now EXPLICIT in code rather than an unset default:
 * the only caller passes `RETENTION_MS_PERMANENT` and this function refuses anything else.
 *
 * Reinstating a prune is therefore a deliberate, reviewable code change — never an env slip.
 * Growth is ~382k rows/month (~90 MB); the table is covered by the monthly `VACUUM (ANALYZE)`
 * cron per docs/RUNBOOK-POSTGRES-MAINT.md.
 */
export const RETENTION_MS_PERMANENT = Infinity;

/**
 * Retention prune — a NO-OP under permanent retention, kept so the sampler's tail keeps its
 * shape and so the guard is visible at the one place a future wave would try to re-enable it.
 * A finite `retentionMs` throws rather than silently deleting: this module can no longer be the
 * mechanism by which accrued training history disappears.
 */
export async function pruneOiSnapshots(
  retentionMs: number = RETENTION_MS_PERMANENT,
  _nowMs: number = Date.now(),
): Promise<void> {
  if (retentionMs !== RETENTION_MS_PERMANENT) {
    throw new Error(
      `[oi-snapshots] refusing a finite retention (${retentionMs}ms): oi_snapshots retention is PERMANENT ` +
        `per OPS-STRUCTURAL-FEATURE-ACCRUAL-W1 (B-DIR v3 training data). Re-enabling a prune is a ` +
        `deliberate code change, not an env flip.`,
    );
  }
  // Permanent retention → nothing to delete. ensureTable() still runs so a fresh box converges.
  await ensureTable();
}

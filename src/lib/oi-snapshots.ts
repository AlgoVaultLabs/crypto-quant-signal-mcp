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

const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS oi_snapshots (
  exchange  TEXT             NOT NULL,
  symbol    TEXT             NOT NULL,
  ts        BIGINT           NOT NULL,
  oi        DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (exchange, symbol, ts)
)`;
const CREATE_INDEX_SQL =
  `CREATE INDEX IF NOT EXISTS idx_oi_snapshots_exch_sym_ts ON oi_snapshots (exchange, symbol, ts)`;

let _ensured = false;

/** Idempotent table+index ensure (matches the SSH-preapplied DDL); once per process. */
async function ensureTable(): Promise<void> {
  if (_ensured) return;
  await dbQuery(CREATE_TABLE_SQL);
  await dbQuery(CREATE_INDEX_SQL);
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
  /** USD notional open interest (oi × price). Must be finite and > 0. */
  oi: number;
  /** Epoch ms (the caller floors to the hour bucket). */
  ts: number;
}

const INSERT_CHUNK = 400; // rows per multi-VALUES insert (well under PG's param cap)

/**
 * Batch-upsert OI snapshots for `exchange`, deduped per (exchange, symbol, ts) via
 * ON CONFLICT DO NOTHING (first-write-wins per bucket → idempotent re-runs).
 * Skips non-finite / non-positive OI. Returns the number of input rows attempted.
 */
export async function recordOiSnapshots(exchange: string, rows: OiSnapshotInput[]): Promise<number> {
  const valid = rows.filter(
    (r) => r.symbol && Number.isFinite(r.oi) && r.oi > 0 && Number.isFinite(r.ts),
  );
  if (valid.length === 0) return 0;
  await ensureTable();
  for (let i = 0; i < valid.length; i += INSERT_CHUNK) {
    const chunk = valid.slice(i, i + INSERT_CHUNK);
    const tuples: string[] = [];
    const params: unknown[] = [];
    chunk.forEach((r, j) => {
      const b = j * 4;
      tuples.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`);
      params.push(exchange, r.symbol.toUpperCase(), r.ts, r.oi);
    });
    await dbQuery(
      `INSERT INTO oi_snapshots (exchange, symbol, ts, oi) VALUES ${tuples.join(', ')} ` +
        `ON CONFLICT (exchange, symbol, ts) DO NOTHING`,
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

/** Single-coin OI delta from the store (the get_trade_call factor). null = warming. */
export async function computeOiDelta(
  coin: string,
  exchange: string,
  windowMs: number = DEFAULT_OI_WINDOW_MS,
  nowMs: number = Date.now(),
): Promise<OiDelta | null> {
  const rows = await dbQuery<{ ts: number | string; oi: number | string }>(
    `SELECT ts, oi FROM oi_snapshots WHERE exchange = $1 AND symbol = $2 AND ts >= $3 ORDER BY ts ASC`,
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
  nowMs: number = Date.now(),
): Promise<Map<string, OiDelta>> {
  const rows = await dbQuery<{ symbol: string; ts: number | string; oi: number | string }>(
    `SELECT symbol, ts, oi FROM oi_snapshots WHERE exchange = $1 AND ts >= $2 ORDER BY symbol ASC, ts ASC`,
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

/** Retention prune — drop snapshots older than `retentionMs` (sampler tail task). */
export async function pruneOiSnapshots(retentionMs: number, nowMs: number = Date.now()): Promise<void> {
  await ensureTable();
  await dbQuery(`DELETE FROM oi_snapshots WHERE ts < $1`, [nowMs - retentionMs]);
}

/**
 * EDGE-CARRY-BACKFILL-W1 — funding history + episode dataset builder (CH2 schema/CH3 raw/CH4 episodes+report).
 *
 * Runs IN-CONTAINER on prod (needs DATABASE_URL + the prod egress IP, which reaches all 7 venues; the
 * local Mac IP is blocked on Binance/Bybit/KuCoin — Step-0 R1). All parameters are pinned in the Step-0
 * SoT `audits/EDGE-CARRY-STEP0-W1-2026-07-04.md`; endpoints are transcribed from the shipped adapters
 * (cited inline), NOT imported, so paging/weight is controlled here (range-batch, never per-row).
 *
 * Phases:  schema | manifest | raw | episodes | report | all
 * Flags:   --venue=BINANCE  --limit=N (symbols)  --check (zero writes)  --floors=8,12,20
 *          --since-checkpoint (raw: resume each venue×symbol from MAX(ts) − 2 intervals; new symbols
 *            forward-accumulate from a bounded lookback — never a deep re-backfill) [EDGE-CARRY-RANKER-W1 CH2]
 *          --reclose-censored (episodes: rows previously closed as exit_reason='data_end' may be re-closed
 *            as new data extends them; real closes stay immutable) [EDGE-CARRY-RANKER-W1 CH2]
 *
 * Data Integrity: `net_carry` / `net_apr` are outcome-class — INTERNAL, never exposed via MCP/API/landing.
 * Rate discipline: ≤50% of each documented budget, per-venue pacing delay, HL ≤25% off-peak; the shared
 * transport's banStatuses NEVER retry a 418.
 */
import { upstreamFetch, VENUE_FETCH_CONFIGS } from '../lib/adapters/_upstream-fetch.js';
import { runScript } from '../lib/script-lifecycle.js';
import { getAdapter } from '../lib/exchange-adapter.js';
import { fetchVenueUniverse } from '../lib/exchange-universe.js';
import { buildPoolConfig } from '../lib/performance-db.js';
import { buildEpisodes, type FundingPoint, type Episode } from './funding-episode-builder.js';
import { checkpointStartMs, episodesConflictClause } from './carry-freshness-helpers.js';
import type { ExchangeId } from '../types.js';

// ── configuration (pinned from Step-0) ──
const DEEP: ExchangeId[] = ['BINANCE', 'BYBIT', 'HL', 'ASTER', 'KUCOIN'];
const FORWARD: ExchangeId[] = ['OKX', 'GATE'];
const FLOORS_DEFAULT = [0.08, 0.12, 0.2];
const MIN_LIQ_USD = 5_000_000;
const HORIZON_DAYS = 14;
const COOLDOWN = 2;
const DEFAULT_SYMBOL_LIMIT = 100;
const H = 3600_000;

const ms = (d: string): number => new Date(`${d}T00:00:00Z`).getTime();

interface VenueMeta {
  intervalHours: number;
  taker: number;
  earliest: number | null; // deep-history start; null = forward-seed only
  source: 'rest_fwd' | 'rest_window' | 'rest_batch' | 'rest_seed';
}
const META: Record<string, VenueMeta> = {
  BINANCE: { intervalHours: 8, taker: 0.0005, earliest: ms('2020-01-01'), source: 'rest_fwd' },
  BYBIT: { intervalHours: 8, taker: 0.00055, earliest: ms('2021-01-01'), source: 'rest_window' },
  HL: { intervalHours: 1, taker: 0.00045, earliest: ms('2023-05-01'), source: 'rest_window' },
  ASTER: { intervalHours: 8, taker: 0.00035, earliest: ms('2021-08-01'), source: 'rest_fwd' },
  KUCOIN: { intervalHours: 8, taker: 0.0006, earliest: ms('2020-08-01'), source: 'rest_batch' },
  OKX: { intervalHours: 8, taker: 0.0005, earliest: null, source: 'rest_seed' },
  GATE: { intervalHours: 8, taker: 0.0005, earliest: null, source: 'rest_seed' },
};
// Step-0 cost model: majors ≈ 0.5bp half-spread, alts ≈ 2bp (BTC 0.5bp / DOGE 2bp reproduced).
const MAJORS = new Set(['BTC', 'ETH', 'SOL', 'BNB', 'XRP']);
const halfSpread = (coin: string): number => (MAJORS.has(coin) ? 0.00005 : 0.0002);
// per-venue inter-call pacing (ms), env-tunable via BACKFILL_PACING_<VENUE>_MS (no redeploy to retune).
// Defaults honor the riders vs each venue's documented budget:
//   HL: weight 20/call, budget 1200/min → 4500ms ≈ 266 weight/min ≈ 22% (≤25% rider, off-peak, bounded windows).
//   OKX: funding-rate-history 5/s → 500ms = 2/s ≈ 40% (≤50%). GATE 500ms. BYBIT 350ms ≈ 28%.
//   KUCOIN: weight 5/call, ~30 req/s cap → 250ms = 4/s ≈ 13%. BINANCE/ASTER weight 1, 2400/min → 120ms ≈ 21%.
const pacingMs = (venue: string, def: number): number => {
  const v = Number(process.env[`BACKFILL_PACING_${venue}_MS`]);
  return Number.isFinite(v) && v > 0 ? v : def;
};
const PACING_MS: Record<string, number> = {
  HL: pacingMs('HL', 4500), BYBIT: pacingMs('BYBIT', 350), KUCOIN: pacingMs('KUCOIN', 250),
  BINANCE: pacingMs('BINANCE', 120), ASTER: pacingMs('ASTER', 120), OKX: pacingMs('OKX', 500), GATE: pacingMs('GATE', 500),
};

const sleep = (n: number): Promise<void> => new Promise((r) => setTimeout(r, n));
const log = (...a: unknown[]): void => console.log(`[${new Date().toISOString()}]`, ...a);

// ── incremental (nightly) semantics [EDGE-CARRY-RANKER-W1 CH2] ──
const NEW_SYMBOL_LOOKBACK_D = (() => {
  const v = Number(process.env.BACKFILL_NEW_SYMBOL_LOOKBACK_D);
  return Number.isFinite(v) && v > 0 ? v : 30;
})();

// ── schema (Step-0 R4 DDL VERBATIM) ──
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS funding_rates_hist (
  venue TEXT NOT NULL, symbol TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL,
  funding_rate DOUBLE PRECISION NOT NULL, interval_hours SMALLINT NOT NULL,
  PRIMARY KEY (venue, symbol, ts)
);
CREATE TABLE IF NOT EXISTS funding_episodes (
  id BIGSERIAL PRIMARY KEY,
  venue TEXT NOT NULL, symbol TEXT NOT NULL, interval_hours SMALLINT NOT NULL,
  entry_ts TIMESTAMPTZ NOT NULL, exit_ts TIMESTAMPTZ NOT NULL,
  entry_sign SMALLINT NOT NULL, held_intervals INT NOT NULL,
  gross_carry DOUBLE PRECISION NOT NULL, rt_cost DOUBLE PRECISION NOT NULL,
  net_carry DOUBLE PRECISION NOT NULL,
  gross_apr DOUBLE PRECISION NOT NULL, net_apr DOUBLE PRECISION NOT NULL,
  entry_floor_apr DOUBLE PRECISION NOT NULL, exit_reason TEXT NOT NULL,
  net_positive BOOLEAN NOT NULL, cluster_week DATE NOT NULL,
  source TEXT NOT NULL, built_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (venue, symbol, entry_ts, entry_floor_apr)
);
CREATE INDEX IF NOT EXISTS ix_fe_venue_symbol ON funding_episodes (venue, symbol);
CREATE INDEX IF NOT EXISTS ix_fe_cluster ON funding_episodes (cluster_week);
`;

type Pool = import('pg').Pool;
function makePool(): Pool {
  const cs = process.env.DATABASE_URL;
  if (!cs) throw new Error('DATABASE_URL required — this backfill runs in-container on prod');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pool } = require('pg') as typeof import('pg');
  return new Pool(buildPoolConfig(cs));
}

// ── per-venue funding-history fetch (transcribed endpoints; range-batch; cited) ──
function dedupeSort(pts: FundingPoint[]): FundingPoint[] {
  const seen = new Set<number>();
  const out: FundingPoint[] = [];
  for (const p of pts) {
    if (Number.isFinite(p.time) && Number.isFinite(p.fundingRate) && !seen.has(p.time)) {
      seen.add(p.time);
      out.push(p);
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

/** BINANCE/ASTER — /fapi/v1/fundingRate (binance.ts:350 / aster.ts:151); 1000/pg, weight 1, ascending-from-startTime. */
async function fetchBinanceLike(venue: 'BINANCE' | 'ASTER', coin: string, earliest: number): Promise<FundingPoint[]> {
  const host = venue === 'BINANCE' ? 'https://fapi.binance.com' : 'https://fapi.asterdex.com';
  const symbol = `${coin}USDT`;
  const out: FundingPoint[] = [];
  let cursor = earliest;
  for (let page = 0; page < 500; page++) {
    const url = `${host}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${cursor}&limit=1000`;
    let raw: Array<{ fundingTime: number; fundingRate: string }>;
    try {
      raw = await upstreamFetch<Array<{ fundingTime: number; fundingRate: string }>>(VENUE_FETCH_CONFIGS[venue], { url, weightHint: 1 });
    } catch { break; }
    if (!raw?.length) break;
    let maxT = cursor;
    for (const r of raw) {
      const t = Number(r.fundingTime); const v = parseFloat(r.fundingRate);
      if (Number.isFinite(t) && Number.isFinite(v)) { out.push({ time: t, fundingRate: v }); if (t > maxT) maxT = t; }
    }
    if (maxT <= cursor) break; // no forward progress
    cursor = maxT + 1;
    await sleep(PACING_MS[venue]);
  }
  return dedupeSort(out);
}

/** BYBIT — /v5/market/funding/history (bybit.ts:188); DESC, ≤200/window, REQUIRES [startTime,endTime]. */
async function fetchBybit(coin: string, earliest: number): Promise<FundingPoint[]> {
  const symbol = `${coin}USDT`;
  const span = 200 * 8 * H; // ≤200 records/window at 8h
  const out: FundingPoint[] = [];
  const now = Date.now();
  for (let ws = earliest; ws < now; ws += span) {
    const we = Math.min(ws + span, now);
    const url = `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}&startTime=${ws}&endTime=${we}&limit=200`;
    let data: { result?: { list?: Array<{ fundingRate: string; fundingRateTimestamp: string }> } };
    try {
      data = await upstreamFetch<{ result?: { list?: Array<{ fundingRate: string; fundingRateTimestamp: string }> } }>(VENUE_FETCH_CONFIGS.BYBIT, { url, weightHint: 1 });
    } catch { break; }
    for (const r of data?.result?.list ?? []) {
      const t = parseInt(r.fundingRateTimestamp, 10); const v = parseFloat(r.fundingRate);
      if (Number.isFinite(t) && Number.isFinite(v)) out.push({ time: t, fundingRate: v });
    }
    await sleep(PACING_MS.BYBIT);
  }
  return dedupeSort(out);
}

/** HL — POST info {type:fundingHistory} (hyperliquid.ts:251); BOUNDED [startTime,endTime] windows so the
 *  weight (∝ span) stays ~500/window instead of exploding on an old cursor. Hourly. */
async function fetchHL(coin: string, earliest: number): Promise<FundingPoint[]> {
  const span = 500 * H; // ~500 hourly records/window (bounded weight)
  const out: FundingPoint[] = [];
  const now = Date.now();
  for (let ws = earliest; ws < now; ws += span) {
    const we = Math.min(ws + span, now);
    let raw: Array<{ time: number; fundingRate: string }>;
    try {
      raw = await upstreamFetch<Array<{ time: number; fundingRate: string }>>(
        VENUE_FETCH_CONFIGS.HL,
        {
          url: 'https://api.hyperliquid.xyz/info',
          method: 'POST',
          body: JSON.stringify({ type: 'fundingHistory', coin, startTime: ws, endTime: we }),
          headers: { 'content-type': 'application/json' },
          weightHint: 20,
        },
      );
    } catch { break; }
    for (const r of raw ?? []) {
      const t = Number(r.time); const v = parseFloat(r.fundingRate);
      if (Number.isFinite(t) && Number.isFinite(v)) out.push({ time: t, fundingRate: v });
    }
    await sleep(PACING_MS.HL);
  }
  return dedupeSort(out);
}

/** OKX/GATE — recent forward-seed via the shipped adapter (OKX ~3mo, Gate ~30d). Reuse getFundingHistory. */
async function fetchSeed(venue: 'OKX' | 'GATE', coin: string): Promise<FundingPoint[]> {
  try {
    const wide = Date.now() - 400 * 24 * H; // adapter returns whatever the venue retains within the window
    const pts = await getAdapter(venue).getFundingHistory(coin, wide);
    await sleep(PACING_MS[venue]);
    return dedupeSort(pts as FundingPoint[]);
  } catch { return []; }
}

async function fetchVenueFunding(venue: ExchangeId, coin: string, startMs?: number): Promise<FundingPoint[]> {
  const m = META[venue];
  if (venue === 'KUCOIN') { const p = await getAdapter('KUCOIN').getFundingHistory(coin, startMs ?? m.earliest!); await sleep(PACING_MS.KUCOIN); return dedupeSort(p as FundingPoint[]); }
  if (venue === 'BINANCE' || venue === 'ASTER') return fetchBinanceLike(venue, coin, startMs ?? m.earliest!);
  if (venue === 'BYBIT') return fetchBybit(coin, startMs ?? m.earliest!);
  if (venue === 'HL') return fetchHL(coin, startMs ?? m.earliest!);
  if (venue === 'OKX' || venue === 'GATE') return fetchSeed(venue, coin); // adapter window-bounded; ON CONFLICT dedupes
  return [];
}

// ── universe manifest ──
async function buildManifest(limit: number): Promise<Record<string, string[]>> {
  const manifest: Record<string, string[]> = {};
  for (const venue of [...DEEP, ...FORWARD]) {
    try {
      const assets = await fetchVenueUniverse(venue);
      const ranked = assets
        .map((a) => ({ coin: a.coin, liq: a.oiIsProxy ? a.volume24h_usd : a.notionalOI_usd }))
        .filter((a) => Number.isFinite(a.liq) && a.liq >= MIN_LIQ_USD)
        .sort((a, b) => b.liq - a.liq)
        .slice(0, limit)
        .map((a) => a.coin);
      manifest[venue] = ranked;
      log(`manifest ${venue}: ${ranked.length} symbols ≥ $${(MIN_LIQ_USD / 1e6).toFixed(0)}M`);
    } catch (e) {
      manifest[venue] = [];
      log(`manifest ${venue}: FAILED (${(e as Error).message}) — empty`);
    }
  }
  return manifest;
}

// ── persistence (awaitable; ON CONFLICT DO NOTHING for idempotent re-runs) ──
function chunk<T>(arr: T[], n: number): T[][] { const o: T[][] = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; }

async function insertRates(pool: Pool, venue: string, symbol: string, ih: number, pts: FundingPoint[], check: boolean): Promise<number> {
  if (check || pts.length === 0) return 0;
  let inserted = 0;
  for (const batch of chunk(pts, 1000)) {
    const vals: string[] = []; const params: unknown[] = [];
    for (const p of batch) {
      const i = params.length;
      vals.push(`($${i + 1}, $${i + 2}, to_timestamp($${i + 3}::double precision / 1000.0), $${i + 4}, $${i + 5})`);
      params.push(venue, symbol, p.time, p.fundingRate, ih);
    }
    const res = await pool.query(
      `INSERT INTO funding_rates_hist (venue, symbol, ts, funding_rate, interval_hours) VALUES ${vals.join(',')} ON CONFLICT (venue, symbol, ts) DO NOTHING`,
      params,
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

function mondayOf(msEpoch: number): string {
  const d = new Date(msEpoch); const day = (d.getUTCDay() + 6) % 7; // 0=Mon
  const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return mon.toISOString().slice(0, 10);
}

async function insertEpisodes(pool: Pool, venue: string, symbol: string, ih: number, floor: number, source: string, eps: Episode[], check: boolean, recloseCensored = false): Promise<number> {
  if (check || eps.length === 0) return 0;
  let inserted = 0;
  for (const batch of chunk(eps, 500)) {
    const vals: string[] = []; const params: unknown[] = [];
    for (const e of batch) {
      const i = params.length;
      vals.push(`($${i + 1},$${i + 2},$${i + 3},to_timestamp($${i + 4}::double precision/1000.0),to_timestamp($${i + 5}::double precision/1000.0),$${i + 6},$${i + 7},$${i + 8},$${i + 9},$${i + 10},$${i + 11},$${i + 12},$${i + 13},$${i + 14},$${i + 15},$${i + 16},$${i + 17})`);
      params.push(venue, symbol, ih, e.entryMs, e.exitMs, e.entrySign, e.heldIntervals, e.gross, e.rtCost, e.net, e.grossApr, e.netApr, floor, e.exitReason, e.netPositive, mondayOf(e.entryMs), source);
    }
    const res = await pool.query(
      `INSERT INTO funding_episodes (venue,symbol,interval_hours,entry_ts,exit_ts,entry_sign,held_intervals,gross_carry,rt_cost,net_carry,gross_apr,net_apr,entry_floor_apr,exit_reason,net_positive,cluster_week,source) VALUES ${vals.join(',')} ${episodesConflictClause(recloseCensored)}`,
      params,
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

// ── phases ──
async function phaseRaw(pool: Pool, venues: ExchangeId[], limit: number, check: boolean, sinceCheckpoint = false): Promise<void> {
  const manifest = await buildManifest(limit);
  for (const venue of venues) {
    const m = META[venue]; const symbols = manifest[venue] ?? [];
    let starts = new Map<string, number>();
    if (sinceCheckpoint) {
      const cp = await pool.query<{ symbol: string; max_ms: string }>(
        `SELECT symbol, (extract(epoch from MAX(ts))*1000)::double precision AS max_ms FROM funding_rates_hist WHERE venue = $1 GROUP BY symbol`,
        [venue],
      );
      starts = new Map(cp.rows.map((r) => [r.symbol, Number(r.max_ms)]));
    }
    let rows = 0; let done = 0;
    for (const coin of symbols) {
      const startMs = sinceCheckpoint
        ? checkpointStartMs(starts.get(coin) ?? null, m.intervalHours, m.earliest, Date.now(), NEW_SYMBOL_LOOKBACK_D)
        : undefined;
      const pts = await fetchVenueFunding(venue, coin, startMs);
      rows += await insertRates(pool, venue, coin, m.intervalHours, pts, check);
      done++;
      log(`raw ${venue} ${coin}: ${pts.length} pts (${done}/${symbols.length})${sinceCheckpoint ? ` [since ${new Date(startMs!).toISOString()}]` : ''}`);
    }
    log(`RAW ${venue} DONE: ${symbols.length} symbols, ${rows} rows inserted${check ? ' [CHECK — no writes]' : ''}${sinceCheckpoint ? ' [incremental]' : ''}`);
  }
}

async function phaseEpisodes(pool: Pool, venues: ExchangeId[], floors: number[], check: boolean, recloseCensored = false): Promise<void> {
  for (const venue of venues) {
    const m = META[venue];
    const symRes = await pool.query<{ symbol: string }>(`SELECT DISTINCT symbol FROM funding_rates_hist WHERE venue = $1`, [venue]);
    let total = 0;
    for (const { symbol } of symRes.rows) {
      const sRes = await pool.query<{ t: string; r: number }>(
        `SELECT (extract(epoch from ts)*1000)::double precision AS t, funding_rate AS r FROM funding_rates_hist WHERE venue=$1 AND symbol=$2 ORDER BY ts`,
        [venue, symbol],
      );
      const series: FundingPoint[] = sRes.rows.map((x) => ({ time: Number(x.t), fundingRate: Number(x.r) }));
      for (const floor of floors) {
        const eps = buildEpisodes(series, { intervalHours: m.intervalHours, floorApr: floor, takerFee: m.taker, halfSpread: halfSpread(symbol), horizonDays: HORIZON_DAYS, cooldownIntervals: COOLDOWN });
        total += await insertEpisodes(pool, venue, symbol, m.intervalHours, floor, m.source, eps, check, recloseCensored);
      }
    }
    log(`EPISODES ${venue} DONE: ${symRes.rows.length} symbols × ${floors.length} floors, ${total} episodes upserted${check ? ' [CHECK]' : ''}${recloseCensored ? ' [reclose-censored]' : ''}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const phase = argv.find((a) => !a.startsWith('--')) ?? 'schema';
  const check = argv.includes('--check');
  const sinceCheckpoint = argv.includes('--since-checkpoint');
  const recloseCensored = argv.includes('--reclose-censored');
  const venueArg = argv.find((a) => a.startsWith('--venue='))?.split('=')[1];
  const limit = Number(argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? DEFAULT_SYMBOL_LIMIT);
  const floors = (argv.find((a) => a.startsWith('--floors='))?.split('=')[1]?.split(',').map((s) => Number(s) / 100)) ?? FLOORS_DEFAULT;
  const venues = venueArg ? (venueArg.split(',') as ExchangeId[]) : [...DEEP, ...FORWARD];

  log(`EDGE-CARRY-BACKFILL-W1 phase=${phase} venues=${venues.join(',')} limit=${limit} floors=${floors.join(',')} check=${check} sinceCheckpoint=${sinceCheckpoint} recloseCensored=${recloseCensored}`);
  const pool = makePool();
  try {
    if (!check) { await pool.query(SCHEMA_SQL); log('schema ensured'); }
    if (phase === 'schema') { log(check ? 'schema [CHECK — not applied]' : 'schema applied'); return; }
    if (phase === 'manifest') { const mani = await buildManifest(limit); log('manifest', JSON.stringify(mani)); return; }
    if (phase === 'raw' || phase === 'all') await phaseRaw(pool, venues, limit, check, sinceCheckpoint);
    if (phase === 'episodes' || phase === 'all') await phaseEpisodes(pool, venues, floors, check, recloseCensored);
    if (phase === 'report') { log('report phase — see CH4 report generator (reads funding_episodes)'); }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  void runScript('backfill-funding-episodes', main); // OPS-SCRIPT-EXIT-LIFECYCLE-W1
}

export { buildManifest, fetchVenueFunding, META, halfSpread, mondayOf, SCHEMA_SQL, phaseRaw, phaseEpisodes };

/**
 * retro-basis-backfill.ts — OPS-BASIS-RETRO-BACKFILL-W1
 *
 * Reconstructs historical perp BASIS (`(mark − index)/index × 1e4`) at 1h and writes it into the
 * structural stream as `source='retro-basis'` rows (oi/spread NULL). Banks basis's ≥90d of data for
 * the pre-registered B-DIR v3 diagnostic instead of waiting to accrue it forward.
 *
 * Universe = the LIVE stream's current top-`RANK_OI_SAMPLE_POOL` per venue (fetchVenueUniverse) — the
 * SAME selection the sampler uses, no new logic (architect Q3). Depth = `RETRO_BASIS_DAYS` (default
 * 400 — covers the 180d B-DIR v3 FULL test with wide margin; deeper is a one-env re-run, the
 * checkpoint makes extension cheap; architect Q4).
 *
 * Resumable + idempotent via DB-as-checkpoint (planRetroFetch): each (venue, coin) is filled OLDER
 * than its deepest existing retro ts; ON CONFLICT DO NOTHING skips the boundary + any live row. Built
 * to be driven by a HOST flock-cron with disjoint --venue lanes so a deploy container-recreate just
 * resumes on the next fire (the OPS-DIRECTIONAL-LABEL-HALT deploy-kill lesson). All venue calls ride
 * `upstreamFetch` (batch lane, venue weight budget, 418/429 NEVER retried).
 *
 *   docker exec <ctr> node dist/scripts/retro-basis-backfill.js --venue BINANCE
 *   docker exec <ctr> node dist/scripts/retro-basis-backfill.js --check        # read-only coverage
 */

import { runScript } from '../lib/script-lifecycle.js';
import { dbQuery } from '../lib/performance-db.js';
import { fetchVenueUniverse } from '../lib/exchange-universe.js';
import { normalizeBinanceCoin } from '../lib/coin-overrides.js';
import { upstreamFetch, VENUE_FETCH_CONFIGS } from '../lib/adapters/_upstream-fetch.js';
import { recordRetroBasisSnapshots, bucketHour } from '../lib/oi-snapshots.js';
import {
  fetchBasisSeries,
  planRetroFetch,
  buildBinanceLikeSymbolMap,
  isReconstructVenue,
  RECONSTRUCT_VENUES,
  type ReconstructVenue,
} from '../lib/retro-basis-sources.js';

const BAR = 3_600_000;
const DAYS = Number(process.env.RETRO_BASIS_DAYS ?? 400);
const POOL = Number(process.env.RANK_OI_SAMPLE_POOL ?? 60);
const PACING_MS = Number(process.env.RETRO_BASIS_PACING_MS ?? 250);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface VenueReport {
  venue: string;
  coins: number;
  coinsDone: number;
  rowsWritten: number;
  deepestTs: number | null;
  errors: number;
  note?: string;
}

/** Deepest (oldest) retro-basis ts already written for (venue, coin), or null. The checkpoint. */
async function existingRetroMinTs(venue: string, coin: string): Promise<number | null> {
  const rows = await dbQuery<{ mn: number | string | null }>(
    `SELECT MIN(ts) AS mn FROM oi_snapshots WHERE exchange = $1 AND symbol = $2 AND source = 'retro-basis'`,
    [venue, coin.toUpperCase()],
  );
  const mn = rows[0]?.mn;
  return mn == null ? null : Number(mn);
}

/** Binance/Aster coin → venue-kline symbol (1000× meme resolution) from exchangeInfo; {} on failure. */
async function binanceLikeSymbolMap(venue: 'BINANCE' | 'ASTER'): Promise<Map<string, string>> {
  const host = venue === 'BINANCE' ? 'https://fapi.binance.com' : 'https://fapi.asterdex.com';
  try {
    const info = await upstreamFetch<unknown>(VENUE_FETCH_CONFIGS[venue], {
      url: `${host}/fapi/v1/exchangeInfo`,
      method: 'GET',
      cls: 'batch',
    });
    return buildBinanceLikeSymbolMap(info, normalizeBinanceCoin);
  } catch (err) {
    console.error(`[retro-basis] ${venue} exchangeInfo failed:`, err instanceof Error ? err.message : err);
    return new Map();
  }
}

/** Reconstruct + write one venue's retro basis over the [start, end] depth window. */
export async function backfillVenue(venue: ReconstructVenue, nowMs: number): Promise<VenueReport> {
  const endMs = bucketHour(nowMs);
  const startMs = endMs - DAYS * 24 * BAR;
  const rep: VenueReport = { venue, coins: 0, coinsDone: 0, rowsWritten: 0, deepestTs: null, errors: 0 };

  let universe;
  try {
    universe = (await fetchVenueUniverse(venue)).slice(0, POOL);
  } catch (err) {
    rep.errors++;
    rep.note = `universe FAILED: ${err instanceof Error ? err.message : String(err)}`;
    return rep;
  }
  const symMap = venue === 'BINANCE' || venue === 'ASTER' ? await binanceLikeSymbolMap(venue) : null;

  for (const a of universe) {
    rep.coins++;
    try {
      const coin = a.coin;
      const existingMin = await existingRetroMinTs(venue, coin);
      const plan = planRetroFetch(existingMin, startMs, endMs);
      if (plan.done) {
        rep.coinsDone++;
        if (existingMin != null) rep.deepestTs = Math.min(rep.deepestTs ?? existingMin, existingMin);
        continue;
      }
      // Binance/Aster: a coin absent from exchangeInfo is delisted/renamed — skip, counted (never guessed).
      const resolved = symMap?.get(coin.toUpperCase());
      if ((venue === 'BINANCE' || venue === 'ASTER') && !resolved) continue;

      const rows = await fetchBasisSeries(venue, coin, plan.fetchStartMs, plan.fetchEndMs, resolved);
      if (rows.length > 0) {
        const n = await recordRetroBasisSnapshots(
          venue,
          rows.map((r) => ({ symbol: coin, ts: r.ts, mark: r.mark, index: r.index })),
        );
        rep.rowsWritten += n;
        const oldest = rows[0].ts;
        rep.deepestTs = rep.deepestTs === null ? oldest : Math.min(rep.deepestTs, oldest);
        if (oldest <= startMs + BAR) rep.coinsDone++;
      }
      if (PACING_MS > 0) await sleep(PACING_MS);
    } catch (err) {
      rep.errors++;
      console.error(`[retro-basis] ${venue}/${a.coin} fail-soft:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(
    `[retro-basis] ${venue}: wrote ${rep.rowsWritten} rows across ${rep.coins} coins ` +
      `(${rep.coinsDone} at floor) deepest=${rep.deepestTs ? new Date(rep.deepestTs).toISOString() : 'n/a'} errors=${rep.errors}`,
  );
  return rep;
}

export interface CheckReport {
  venue: string;
  retroRows: number;
  deepestTs: number | null;
  newestTs: number | null;
  coins: number;
  coinsAtFloor: number;
  coinsPending: number;
}

/** READ-ONLY (`--check`): coverage snapshot, zero venue-kline fetches, zero writes (idempotency proof). */
export async function checkVenue(venue: ReconstructVenue, nowMs: number): Promise<CheckReport> {
  const endMs = bucketHour(nowMs);
  const startMs = endMs - DAYS * 24 * BAR;
  const agg = await dbQuery<{ n: number | string; mn: number | string | null; mx: number | string | null }>(
    `SELECT COUNT(*) AS n, MIN(ts) AS mn, MAX(ts) AS mx FROM oi_snapshots WHERE exchange = $1 AND source = 'retro-basis'`,
    [venue],
  );
  const universe = (await fetchVenueUniverse(venue)).slice(0, POOL);
  let atFloor = 0;
  for (const a of universe) {
    const em = await existingRetroMinTs(venue, a.coin);
    if (planRetroFetch(em, startMs, endMs).done) atFloor++;
  }
  const rep: CheckReport = {
    venue,
    retroRows: Number(agg[0]?.n ?? 0),
    deepestTs: agg[0]?.mn == null ? null : Number(agg[0].mn),
    newestTs: agg[0]?.mx == null ? null : Number(agg[0].mx),
    coins: universe.length,
    coinsAtFloor: atFloor,
    coinsPending: universe.length - atFloor,
  };
  console.log(
    `[retro-basis][check] ${venue}: ${rep.retroRows} retro rows, ${rep.coinsAtFloor}/${rep.coins} coins at floor, ` +
      `${rep.coinsPending} pending, deepest=${rep.deepestTs ? new Date(rep.deepestTs).toISOString() : 'n/a'}`,
  );
  return rep;
}

export interface VerifyCheck {
  ts: number;
  liveMark: number | null;
  retroMark: number | null;
  liveBasisBps: number | null;
  retroBasisBps: number | null;
  markPctDiff: number | null;
  ok: boolean;
}
export interface VerifyReport {
  venue: string;
  checks: VerifyCheck[];
  pass: boolean;
  note?: string;
}

/**
 * R1 AGREEMENT GATE (`--verify`) — reconstruction must agree with the LIVE derivation before any bulk
 * write (AC1). For BTC, reconstruct the most-recent live-sampled hours from klines and compare to the
 * live-stored values. The gate is on `mark_price` within 1% (proves the fetcher hit the right symbol
 * and the parser picked the right CLOSE field); the live basis is a :17 point sample and the retro
 * basis is the hour-CLOSE, so their bps delta is reported (intra-hour offset), not tightly gated.
 */
export async function verifyVenue(venue: ReconstructVenue, nowMs: number): Promise<VerifyReport> {
  const coin = 'BTC';
  // Compare only CLOSED hours: the current in-progress hour is not yet served by the venues'
  // HISTORICAL kline endpoints (Bitget's history-candles, notably, omits the forming candle), so
  // including it would false-fail a correct reconstruction. `lastClosed` = the last fully-closed hour.
  const lastClosed = bucketHour(nowMs) - BAR;
  const live = await dbQuery<{ ts: number | string; mark_price: number | string; basis_bps: number | string }>(
    `SELECT ts, mark_price, basis_bps FROM oi_snapshots
     WHERE exchange = $1 AND symbol = $2 AND source IS NULL AND mark_price IS NOT NULL AND basis_bps IS NOT NULL
       AND ts <= $3
     ORDER BY ts DESC LIMIT 3`,
    [venue, coin, lastClosed],
  );
  if (live.length === 0) return { venue, checks: [], pass: false, note: 'no live BTC basis rows to check against' };
  const tss = live.map((r) => Number(r.ts));
  const resolved = venue === 'BINANCE' || venue === 'ASTER' ? (await binanceLikeSymbolMap(venue)).get('BTC') : undefined;
  const retro = await fetchBasisSeries(venue, coin, Math.min(...tss), Math.max(...tss), resolved);
  const byTs = new Map(retro.map((r) => [r.ts, r]));
  const checks: VerifyCheck[] = [];
  let pass = true;
  for (const lr of live) {
    const ts = Number(lr.ts);
    const r = byTs.get(ts);
    const liveMark = Number(lr.mark_price);
    const liveBasis = Number(lr.basis_bps);
    if (!r) {
      pass = false;
      checks.push({ ts, liveMark, retroMark: null, liveBasisBps: liveBasis, retroBasisBps: null, markPctDiff: null, ok: false });
      continue;
    }
    const markPct = liveMark > 0 ? (Math.abs(r.mark - liveMark) / liveMark) * 100 : Infinity;
    const retroBasis = ((r.mark - r.index) / r.index) * 1e4;
    const ok = markPct <= 1.0; // same hour, ~40min sample offset → 1% is generous for a mark price
    if (!ok) pass = false;
    checks.push({
      ts,
      liveMark,
      retroMark: r.mark,
      liveBasisBps: liveBasis,
      retroBasisBps: Number(retroBasis.toFixed(2)),
      markPctDiff: Number(markPct.toFixed(4)),
      ok,
    });
  }
  console.log(
    `[retro-basis][verify] ${venue}: ${pass ? 'PASS' : 'FAIL'} — ` +
      checks
        .map((c) => `@${new Date(c.ts).toISOString().slice(5, 16)} mark ${c.markPctDiff ?? 'n/a'}% (live ${c.liveBasisBps}bps / retro ${c.retroBasisBps}bps)`)
        .join(' | '),
  );
  return { venue, checks, pass };
}

function resolveVenues(): ReconstructVenue[] {
  const i = process.argv.indexOf('--venue');
  if (i < 0) return [...RECONSTRUCT_VENUES];
  const only = (process.argv[i + 1] ?? '').toUpperCase();
  if (!isReconstructVenue(only)) {
    throw new Error(`--venue ${only || '<missing>'} is not a reconstruct venue (${RECONSTRUCT_VENUES.join(', ')})`);
  }
  return [only];
}

if (require.main === module) {
  void runScript('retro-basis-backfill', async () => {
    const check = process.argv.includes('--check');
    const verify = process.argv.includes('--verify');
    const venues = resolveVenues();
    const nowMs = Date.now();

    if (verify) {
      const reports: VerifyReport[] = [];
      for (const v of venues) reports.push(await verifyVenue(v, nowMs));
      const failed = reports.filter((r) => !r.pass);
      console.log(`[retro-basis] verify done`, JSON.stringify({ reports }));
      if (failed.length > 0) {
        // Non-zero exit ⇒ the R1 gate BLOCKS the bulk lanes (AC1).
        throw new Error(`R1 agreement gate FAILED for: ${failed.map((r) => r.venue).join(', ')}`);
      }
      return;
    }

    const reports: Array<VenueReport | CheckReport> = [];
    for (const v of venues) reports.push(check ? await checkVenue(v, nowMs) : await backfillVenue(v, nowMs));
    console.log(`[retro-basis] done${check ? ' (CHECK — zero writes)' : ''}`, JSON.stringify({ days: DAYS, reports }));
  });
}

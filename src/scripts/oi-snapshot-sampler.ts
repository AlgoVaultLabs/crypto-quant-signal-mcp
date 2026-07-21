/**
 * oi-snapshot-sampler.ts — SCAN-RANKBY-W3 CH2 · widened by OPS-STRUCTURAL-FEATURE-ACCRUAL-W1
 *
 * Hourly cron. Snapshots the STRUCTURAL FEATURE TUPLE — USD-notional open interest, base-coin OI,
 * mark price, index price, basis_bps, spread_bps — for the top-RANK_OI_SAMPLE_POOL perps on each
 * PROMOTED venue into `oi_snapshots` (one row per (venue, symbol, hour-bucket); ON CONFLICT DO
 * NOTHING → idempotent). This is the ONLY structural fetcher: the oi_change lens, the
 * get_trade_call OI factor, and the future B-DIR v3 / carry-v2 consumers all read the store.
 *
 * W1 changed three things and nothing else:
 *   1. Structural fields ride along. `fetchVenueUniverse` already pulls a bulk payload per venue;
 *      5 venues (HL/BYBIT/BITGET/GATE/MEXC) carry mark+index+bid+ask inside it at ZERO extra cost.
 *      `fetchStructuralGaps` closes the rest with 10 targeted bulk calls/hour across 7 venues.
 *   2. Retention is PERMANENT (Q2a) — see oi-snapshots.ts::pruneOiSnapshots. The former
 *      `RANK_OI_RETENTION_H` 30-day default would have started deleting accrued B-DIR v3 training
 *      history on 2026-07-26 12:00 UTC.
 *   3. ASTER/BINGX now produce rows (Q4). Their `notionalOI_usd` is a 24h-VOLUME proxy so OI stays
 *      NULL — but their basis/spread is real, and ASTER is the fleet's #1 emitter.
 *
 * Fail-soft per venue (one venue's outage never blocks the others). Run from the host crontab:
 *   docker exec <ctr> node dist/scripts/oi-snapshot-sampler.js
 *   docker exec <ctr> node dist/scripts/oi-snapshot-sampler.js --check   # read-only, ZERO writes
 *
 * NB: the verdict engine gates get_trade_call to a venue's top-~50 by OI, so the default pool (60)
 * covers every coin the factor can serve; long-tail coins simply stay "warming" (never a wrong value).
 */

import type { ExchangeId } from '../types.js';
import { runScript } from '../lib/script-lifecycle.js';
import { fetchCurrentOiUsd } from '../lib/oi-sources.js';
import { fetchStructuralGaps, type StructuralPatch } from '../lib/structural-sources.js';
import { fetchVenueUniverse } from '../lib/exchange-universe.js';
import {
  recordOiSnapshots,
  bucketHour,
  pruneOiSnapshots,
  basisBps,
  spreadBps,
  type OiSnapshotInput,
} from '../lib/oi-snapshots.js';
import { PROMOTED_VENUE_IDS } from '../lib/capabilities.js';

// OPS-SCAN-UNIVERSE-EXPAND-W1: derive from EXCHANGES (all 12 promoted). W1: every venue is now
// sampled — oi-sources still returns [] for the volume-proxy venues (Aster/BingX), which now
// yields OI-NULL rows carrying real basis/spread rather than no row at all.
const PROMOTED_VENUES: readonly ExchangeId[] = PROMOTED_VENUE_IDS;
const POOL = Number(process.env.RANK_OI_SAMPLE_POOL ?? 60);

/** Per-venue field coverage, so the audit reports MEASURED counts instead of assumed ones. */
export interface VenueCoverage {
  rows: number;
  oi: number;
  mark: number;
  index: number;
  basis: number;
  spread: number;
}

export interface SamplerResult {
  bucket: number;
  total: number;
  perVenue: Record<string, number>;
  coverage: Record<string, VenueCoverage>;
}

function countCoverage(rows: OiSnapshotInput[]): VenueCoverage {
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? 1 : 0);
  return rows.reduce<VenueCoverage>(
    (acc, r) => ({
      rows: acc.rows + 1,
      oi: acc.oi + n(r.oi),
      mark: acc.mark + n(r.mark),
      index: acc.index + n(r.index),
      basis: acc.basis + (basisBps(r.mark, r.index) !== null ? 1 : 0),
      spread: acc.spread + (spreadBps(r.bid, r.ask) !== null ? 1 : 0),
    }),
    { rows: 0, oi: 0, mark: 0, index: 0, basis: 0, spread: 0 },
  );
}

/**
 * Build one venue's rows for `bucket`: OI from `fetchCurrentOiUsd` (unchanged), structural fields
 * from the universe payload, gaps patched by `fetchStructuralGaps`. Union of both key sets — a coin
 * with basis but no OI still gets a row (Aster/BingX), and vice versa.
 */
async function buildVenueRows(venue: ExchangeId, bucket: number): Promise<OiSnapshotInput[]> {
  // fetchCurrentOiUsd and fetchVenueUniverse hit the same venue payload; the gap call is separate.
  const [oiRows, universe, gaps] = await Promise.all([
    fetchCurrentOiUsd(venue, POOL),
    fetchVenueUniverse(venue),
    fetchStructuralGaps(venue),
  ]);
  const pool = universe.slice(0, POOL);
  const inline = new Map<string, StructuralPatch>(
    pool.map((a) => [a.coin, { markPx: a.markPx, indexPx: a.indexPx, bidPx: a.bidPx, askPx: a.askPx }]),
  );
  const oiByCoin = new Map(oiRows.map((r) => [r.coin, r]));
  // Union: every coin in the ranked pool, plus any OI row the pool slice missed.
  const coins = new Set<string>([...pool.map((a) => a.coin), ...oiByCoin.keys()]);
  const rows: OiSnapshotInput[] = [];
  for (const coin of coins) {
    const oi = oiByCoin.get(coin);
    const s = inline.get(coin) ?? {};
    const g = gaps.get(coin) ?? {};
    rows.push({
      symbol: coin,
      ts: bucket,
      oi: oi?.oi,
      contracts: oi?.contracts,
      // Inline (already-paid-for) value wins; the gap call only fills what the payload lacked.
      mark: s.markPx ?? g.markPx,
      index: s.indexPx ?? g.indexPx,
      bid: s.bidPx ?? g.bidPx,
      ask: s.askPx ?? g.askPx,
    });
  }
  return rows;
}

export async function runOiSnapshotSampler(
  nowMs: number = Date.now(),
  opts: { check?: boolean } = {},
): Promise<SamplerResult> {
  const bucket = bucketHour(nowMs);
  const perVenue: Record<string, number> = {};
  const coverage: Record<string, VenueCoverage> = {};
  let total = 0;
  for (const venue of PROMOTED_VENUES) {
    try {
      const rows = await buildVenueRows(venue, bucket);
      coverage[venue] = countCoverage(rows);
      // --check is READ-ONLY: it fetches + reports coverage and writes nothing.
      const n = opts.check ? 0 : await recordOiSnapshots(venue, rows);
      perVenue[venue] = n;
      total += n;
      const c = coverage[venue];
      console.log(
        `[oi-sampler] ${venue}: ${opts.check ? `${c.rows} rows (CHECK — 0 written)` : `${n} snapshots`} ` +
          `@ ${new Date(bucket).toISOString()} | oi=${c.oi} mark=${c.mark} index=${c.index} ` +
          `basis=${c.basis} spread=${c.spread}`,
      );
    } catch (err) {
      perVenue[venue] = 0;
      console.error(
        `[oi-sampler] ${venue} FAILED (fail-soft):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  // Q2a: PERMANENT retention. This call is a no-op guard, kept so the one place a future wave
  // would re-enable deletion stays visible; a finite retention now THROWS in oi-snapshots.ts.
  if (!opts.check) {
    try {
      await pruneOiSnapshots();
    } catch (err) {
      console.error('[oi-sampler] retention guard failed (non-fatal):', err instanceof Error ? err.message : err);
    }
  }
  return { bucket, total, perVenue, coverage };
}

// require.main guard (CJS, target ES2022) — cron invokes this directly.
if (require.main === module) {
  const check = process.argv.includes('--check');
  // OPS-SCRIPT-EXIT-LIFECYCLE-W1: the prior tail exited WITHOUT draining, which
  // could abort in-flight fire-and-forget writes (dbExec/dbRun are
  // fire-and-forget on PG). runScript drains first, then exits.
  void runScript('oi-snapshot-sampler', async () => {
    const r = await runOiSnapshotSampler(Date.now(), { check });
    console.log(`[oi-sampler] done${check ? ' (CHECK — zero writes)' : ''}`, JSON.stringify(r));
  });
}

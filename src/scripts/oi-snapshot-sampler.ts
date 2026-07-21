/**
 * oi-snapshot-sampler.ts — SCAN-RANKBY-W3 CH2
 *
 * Hourly cron. Snapshots USD-notional open interest for the top-RANK_OI_SAMPLE_POOL
 * perps on each of the 5 PROMOTED venues into `oi_snapshots` (one row per
 * (venue, symbol, hour-bucket); ON CONFLICT DO NOTHING → idempotent). This is the
 * ONLY OI fetcher — the oi_change lens + the get_trade_call factor read the store,
 * not the venues, so all per-venue OI cost stays off the request path here.
 *
 * Fail-soft per venue (one venue's outage never blocks the others). Append-only
 * with a retention prune tail. Run from the host crontab:
 *   docker exec <ctr> node dist/scripts/oi-snapshot-sampler.js
 *
 * NB: the verdict engine gates get_trade_call to a venue's top-~50 by OI, so the
 * default pool (60) covers every coin the factor can serve; long-tail coins simply
 * stay "warming" (the factor omits — never a wrong value).
 */

import type { ExchangeId } from '../types.js';
import { runScript } from '../lib/script-lifecycle.js';
import { fetchCurrentOiUsd } from '../lib/oi-sources.js';
import { recordOiSnapshots, bucketHour, pruneOiSnapshots } from '../lib/oi-snapshots.js';
import { PROMOTED_VENUE_IDS } from '../lib/capabilities.js';

// OPS-SCAN-UNIVERSE-EXPAND-W1: derive from EXCHANGES (all 12 promoted). oi-sources SKIPS the volume-
// proxy venues (Aster/BingX) — returning [] rather than volume-as-OI — so the sampler safely attempts
// all 12; the oi_change lens ends up covering the ~10 with a real OI source (incl. Binance's hist path).
const PROMOTED_VENUES: readonly ExchangeId[] = PROMOTED_VENUE_IDS;
const POOL = Number(process.env.RANK_OI_SAMPLE_POOL ?? 60);
const RETENTION_H = Number(process.env.RANK_OI_RETENTION_H ?? 30 * 24); // 30 days

export interface SamplerResult {
  bucket: number;
  total: number;
  perVenue: Record<string, number>;
}

export async function runOiSnapshotSampler(nowMs: number = Date.now()): Promise<SamplerResult> {
  const bucket = bucketHour(nowMs);
  const perVenue: Record<string, number> = {};
  let total = 0;
  for (const venue of PROMOTED_VENUES) {
    try {
      const rows = await fetchCurrentOiUsd(venue, POOL);
      const n = await recordOiSnapshots(
        venue,
        // CH3: carry base-coin OI (contracts) alongside notional; NULL where absent (warms forward).
        rows.map((r) => ({ symbol: r.coin, oi: r.oi, contracts: r.contracts, ts: bucket })),
      );
      perVenue[venue] = n;
      total += n;
      console.log(`[oi-sampler] ${venue}: ${n} OI snapshots @ ${new Date(bucket).toISOString()}`);
    } catch (err) {
      perVenue[venue] = 0;
      console.error(
        `[oi-sampler] ${venue} FAILED (fail-soft):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  try {
    await pruneOiSnapshots(RETENTION_H * 60 * 60 * 1000, nowMs);
  } catch (err) {
    console.error('[oi-sampler] retention prune failed (non-fatal):', err instanceof Error ? err.message : err);
  }
  return { bucket, total, perVenue };
}

// require.main guard (CJS, target ES2022) — cron invokes this directly.
if (require.main === module) {
  // OPS-SCRIPT-EXIT-LIFECYCLE-W1: the prior tail exited WITHOUT draining, which
  // could abort in-flight fire-and-forget writes (dbExec/dbRun are
  // fire-and-forget on PG). runScript drains first, then exits.
  void runScript('oi-snapshot-sampler', async () => {
    const r = await runOiSnapshotSampler();
    console.log('[oi-sampler] done', JSON.stringify(r));
  });
}

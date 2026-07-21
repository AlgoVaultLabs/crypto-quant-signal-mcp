/**
 * oi-snapshot-backfill.ts — SCAN-RANKBY-W3 CH2 (one-time, shrink warming)
 *
 * Backfills ~24h of hourly OI history into `oi_snapshots` for the venues with
 * clean USD-comparable OI-history (Binance + Bybit) so `oi_change` + the corrected
 * factor are usable well before the natural 24h warm-up of the hourly sampler.
 * OKX (per-CCY granularity) / Bitget (no history) / HL (none) warm forward.
 *
 * Idempotent (ON CONFLICT DO NOTHING — re-runnable; merges with sampler rows).
 * Run ONCE at deploy:  docker exec <ctr> node dist/scripts/oi-snapshot-backfill.js
 */

import type { ExchangeId } from '../types.js';
import { runScript } from '../lib/script-lifecycle.js';
import { fetchVenueUniverse } from '../lib/exchange-universe.js';
import { fetchOiHistoryUsd } from '../lib/oi-sources.js';
import { recordOiSnapshots, bucketHour, DEFAULT_OI_WINDOW_MS } from '../lib/oi-snapshots.js';

const BACKFILL_VENUES: ExchangeId[] = ['BINANCE', 'BYBIT'];
const POOL = Number(process.env.RANK_OI_SAMPLE_POOL ?? 60);
// Window + 2h margin: N hourly points span only (N−1)h, so a bare `window` (24) is 1h short of
// a 24h delta anchor → all coins stay "warming" until the next sampler tick extends the span.
const HOURS = Number(process.env.RANK_OI_BACKFILL_HOURS ?? (DEFAULT_OI_WINDOW_MS / (60 * 60 * 1000) + 2));

export interface BackfillResult {
  perVenue: Record<string, { coins: number; snapshots: number }>;
}

export async function runOiSnapshotBackfill(): Promise<BackfillResult> {
  const perVenue: Record<string, { coins: number; snapshots: number }> = {};
  for (const venue of BACKFILL_VENUES) {
    let coins = 0;
    let snapshots = 0;
    let pool: Array<{ coin: string }> = [];
    try {
      pool = (await fetchVenueUniverse(venue)).slice(0, POOL);
    } catch (err) {
      console.error(`[oi-backfill] ${venue} universe FAILED:`, err instanceof Error ? err.message : err);
      perVenue[venue] = { coins: 0, snapshots: 0 };
      continue;
    }
    for (const a of pool) {
      try {
        const hist = await fetchOiHistoryUsd(venue, a.coin, HOURS);
        if (!hist || hist.length === 0) continue;
        const n = await recordOiSnapshots(
          venue,
          hist.map((h) => ({ symbol: a.coin, oi: h.oi, ts: bucketHour(h.ts) })),
        );
        if (n > 0) coins += 1;
        snapshots += n;
      } catch (err) {
        console.error(
          `[oi-backfill] ${venue}/${a.coin} fail-soft:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    perVenue[venue] = { coins, snapshots };
    console.log(`[oi-backfill] ${venue}: ${snapshots} historical snapshots across ${coins} coins`);
  }
  console.log('[oi-backfill] OKX/BITGET/HL: warm-forward (no clean USD OI-history) — first deltas in ~24h');
  return { perVenue };
}

if (require.main === module) {
  void runScript('oi-snapshot-backfill', async () => {
    const r = await runOiSnapshotBackfill();
    console.log('[oi-backfill] done', JSON.stringify(r));
  }); // OPS-SCRIPT-EXIT-LIFECYCLE-W1
}

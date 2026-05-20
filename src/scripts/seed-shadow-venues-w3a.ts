#!/usr/bin/env tsx
/**
 * seed-shadow-venues-w3a.ts — One-shot bootstrap script for PILOT-ADAPTERS-W3A.
 *
 * Calls `venue-store.insertVenue()` for the 3 new Tier-A established CEX
 * shadow venues (Phemex + BingX + HTX) with Plan-Mode-probed asset_count
 * values (2026-05-20). Idempotent via `ON CONFLICT (exchange_id) DO NOTHING`
 * — safe to re-run.
 *
 * Usage (post-deploy, operator-side per chapter):
 *   ssh -i ~/.ssh/algovault_deploy root@204.168.185.24 'docker exec crypto-quant-signal-mcp-server-1 node /app/dist/scripts/seed-shadow-venues-w3a.js'
 *
 * Per-chapter activation:
 *   - C1: only PHEMEX is fully wired (adapter + dispatch + Zod + venue-coverage).
 *     BINGX/HTX insertVenue calls are GUARDED behind an env flag so this
 *     script can be safely run after C1 without erroring on missing adapters.
 *   - C2 lifts the BINGX guard.
 *   - C3 lifts the HTX guard.
 *
 * Plan-Mode probe (2026-05-20):
 *   - Phemex: 538 USDT-margined hedged perpetuals listed under data.perpProductsV2;
 *     $3.30B 24h OI; 100% PoR + 99.999% uptime claim; Tier-A reputation.
 *   - BingX: 638 USDT-perp listed (.data[currency=USDT,status=1]); $3.52B OI;
 *     88% derivs-mix; CoinGecko rank 19; Tier-A reputation.
 *   - HTX: 233 USDT swap listed; $4.75B OI; +14.48pp derivs swing Q1 2026;
 *     Tier-A reputation, recovery story.
 *
 * Status: shadow. evaluate-venues daily cron auto-tests each on the
 * promotion criteria (PFE WR ≥ 0.80 over asset_count × 10 BUY/SELL signals).
 */

import { insertVenue } from '../lib/venue-store.js';
import { closeDb } from '../lib/performance-db.js';

interface ShadowVenueSeed {
  exchangeId: string;
  assetCount: number;
  notes: string;
  guardEnv?: string;   // if set, only inserts when process.env[guardEnv] === '1'
}

const W3A_VENUES: ShadowVenueSeed[] = [
  {
    exchangeId: 'PHEMEX',
    assetCount: 538,
    notes: 'PILOT-ADAPTERS-W3A C1 (2026-05-20) — Phemex USDT-M Hedged Perpetual V2; $3.30B 24h OI / 538 USDT perps listed under perpProductsV2 / 100% PoR + 99.999% uptime / Tier-A reputation. Plan-Mode probe 2026-05-20 confirmed Rp/Rv/Rr REAL values (no Ev/Rv decoding required for V2 hedged family).',
  },
  {
    exchangeId: 'BINGX',
    assetCount: 638,
    notes: 'PILOT-ADAPTERS-W3A C2 (2026-05-20) — BingX Swap V2 USDT-M Perpetual; $3.52B 24h OI / 638 USDT perps / 88% derivs-mix / CoinGecko rank 19 / Tier-A reputation. Plan-Mode probe 2026-05-20 confirmed direct-float JSON shape (no encoding).',
    guardEnv: 'W3A_C2_ACTIVATED',
  },
  {
    exchangeId: 'HTX',
    assetCount: 233,
    notes: 'PILOT-ADAPTERS-W3A C3 (2026-05-20) — HTX (formerly Huobi) Linear USDT-Margined Swap; $4.75B 24h OI / 233 USDT swap perps / +14.48pp derivs swing Q1 2026 / 800req/s per-IP market-data rate limit / Tier-A reputation, recovery story.',
    guardEnv: 'W3A_C3_ACTIVATED',
  },
];

async function main(): Promise<void> {
  let inserted = 0;
  let skipped = 0;

  for (const venue of W3A_VENUES) {
    if (venue.guardEnv && process.env[venue.guardEnv] !== '1') {
      console.log(`[seed-shadow-venues-w3a] SKIP ${venue.exchangeId} (guard env ${venue.guardEnv}!=1; chapter not yet activated)`);
      skipped++;
      continue;
    }

    try {
      await insertVenue({
        exchangeId: venue.exchangeId,
        status: 'shadow',
        assetCount: venue.assetCount,
        // minBuySellSample defaults to assetCount × 10 per insertVenue helper
        integratedAt: new Date(),
        notes: venue.notes,
      });
      console.log(`[seed-shadow-venues-w3a] OK ${venue.exchangeId} status=shadow asset_count=${venue.assetCount} min_buy_sell_sample=${venue.assetCount * 10}`);
      inserted++;
    } catch (err) {
      console.error(`[seed-shadow-venues-w3a] ERROR ${venue.exchangeId}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  console.log(`[seed-shadow-venues-w3a] DONE inserted=${inserted} skipped=${skipped}`);
  await closeDb();
}

main().catch((err) => {
  console.error('[seed-shadow-venues-w3a] FATAL:', err);
  process.exit(1);
});

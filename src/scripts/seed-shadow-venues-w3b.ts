#!/usr/bin/env tsx
/**
 * seed-shadow-venues-w3b.ts — One-shot bootstrap for PILOT-ADAPTERS-W3B.
 *
 * Inserts 4 new emerging-tier CEX shadow venues (WEEX + Bitmart + XT + WhiteBIT)
 * into `venues` postgres with Plan-Mode-probed asset_count values (2026-05-20).
 * Idempotent via `ON CONFLICT (exchange_id) DO NOTHING`. Bypasses fire-and-
 * forget `dbRun` (per W3A C1 hotfix lesson `670d659`); uses `pg.Pool.query`
 * directly + `RETURNING exchange_id`.
 *
 * Per-chapter activation:
 *   - C1: WEEX always inserts (no guard).
 *   - C2: W3B_C2_ACTIVATED=1 unlocks BITMART.
 *   - C3: W3B_C3_ACTIVATED=1 unlocks XT.
 *   - C4: W3B_C4_ACTIVATED=1 unlocks WHITEBIT.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Pool } = require('pg');

interface ShadowVenueSeed {
  exchangeId: string;
  assetCount: number;
  notes: string;
  guardEnv?: string;
}

const W3B_VENUES: ShadowVenueSeed[] = [
  {
    exchangeId: 'WEEX',
    assetCount: 723,
    notes: 'PILOT-ADAPTERS-W3B C1 (2026-05-20) — WEEX USDT-M Perpetual; $8.48B OI / 723 USDT-perp listed under /capi/v2/market/contracts / 4h funding cadence (x2190 annualization, FIRST non-8h venue in adapter fleet) / derivatives-first venue / CoinGecko rank 8. Symbol convention cmt_<coin>usdt (lowercase + cmt_ prefix). NO public funding/OI endpoints surfaced — adapter returns funding=0/openInterest=0 per W3B Q-3 fail-soft (promotion criteria use PFE WR + sample count, not funding).',
  },
  {
    exchangeId: 'BITMART',
    assetCount: 949,
    notes: 'PILOT-ADAPTERS-W3B C2 (2026-05-20) — Bitmart Futures V2 USDT-M; $6.35B OI / 949 USDT-quote perps under /contract/public/details (977 total) / 2017-founded / CoinGecko rank 13. Symbol BTCUSDT (Binance-style no separator). kline step ENUM {1,3,5,15,30,60,120,240,720} minutes; limit not honored (uses start/end time window). Single /contract/public/details bundles funding + OI + mark.',
      },
  {
    exchangeId: 'XT',
    assetCount: 893,
    notes: 'PILOT-ADAPTERS-W3B C3 (2026-05-20) — XT.COM USDT-M Futures perpetual; $7.38B OI / 893 PERPETUAL contracts (943 total — 47 CURRENT_QUARTER + 3 NEXT_QUARTER dated futures filtered out) / mid-tier established / CoinGecko rank 11. Symbol btc_usdt (lowercase + underscore). Live API at /future/market/v1/public/... (NOT spec /future/api/v1/...). 2ND venue after Phemex with REAL S&P 500 perp (sp500_usdt = $7400 verified live; SP500 PARTIAL_COVERAGE extended to [HL, PHEMEX, XT]).',
    guardEnv: 'W3B_C3_ACTIVATED',
  },
  {
    exchangeId: 'WHITEBIT',
    assetCount: 315,
    notes: 'PILOT-ADAPTERS-W3B C4 (2026-05-20) — WhiteBIT USDT Perpetual (_PERP suffix); $4.62B OI / 315 USDT-settled perps (100% USDT — money_currency filter is no-op safety belt) / EU-regulated / up to 100x leverage / CoinGecko ~rank 14. Symbol BTC_PERP (UNIQUE — underscore + _PERP suffix; settlement currency implicit). Kline at /api/v1/public/kline (NOT v4); v4 /public/futures bundles instruments + funding + OI + mark + 24h vol in single call. FIRST W3-batch venue without SPX6900 memecoin trap.',
    guardEnv: 'W3B_C4_ACTIVATED',
  },
];

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL env var is required');
  }

  const pool = new Pool({ connectionString });
  let inserted = 0;
  let skipped = 0;
  let alreadyPresent = 0;

  try {
    for (const venue of W3B_VENUES) {
      if (venue.guardEnv && process.env[venue.guardEnv] !== '1') {
        console.log(`[seed-shadow-venues-w3b] SKIP ${venue.exchangeId} (guard env ${venue.guardEnv}!=1; chapter not yet activated)`);
        skipped++;
        continue;
      }

      const minBuySellSample = venue.assetCount * 10;
      const integratedAt = new Date();

      const result = await pool.query(
        `INSERT INTO venues (exchange_id, status, asset_count, min_buy_sell_sample, integrated_at, notes)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (exchange_id) DO NOTHING
         RETURNING exchange_id`,
        [venue.exchangeId, 'shadow', venue.assetCount, minBuySellSample, integratedAt, venue.notes]
      );

      if (result.rowCount > 0) {
        console.log(`[seed-shadow-venues-w3b] OK ${venue.exchangeId} status=shadow asset_count=${venue.assetCount} min_buy_sell_sample=${minBuySellSample}`);
        inserted++;
      } else {
        const existing = await pool.query(
          `SELECT status, asset_count, min_buy_sell_sample, integrated_at FROM venues WHERE exchange_id = $1`,
          [venue.exchangeId]
        );
        const row = existing.rows[0];
        console.log(`[seed-shadow-venues-w3b] PRESENT ${venue.exchangeId} status=${row?.status} asset_count=${row?.asset_count} min_buy_sell_sample=${row?.min_buy_sell_sample}`);
        alreadyPresent++;
      }
    }

    console.log(`[seed-shadow-venues-w3b] DONE inserted=${inserted} already_present=${alreadyPresent} skipped=${skipped}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[seed-shadow-venues-w3b] FATAL:', err);
  process.exit(1);
});

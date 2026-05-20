#!/usr/bin/env tsx
/**
 * seed-shadow-venues-w3a.ts — One-shot bootstrap script for PILOT-ADAPTERS-W3A.
 *
 * Inserts the 3 new Tier-A established CEX shadow venues (Phemex + BingX +
 * HTX) into the `venues` postgres table with Plan-Mode-probed asset_count
 * values (2026-05-20). Idempotent via `ON CONFLICT (exchange_id) DO NOTHING`.
 *
 * Implementation note: bypasses `venue-store.insertVenue()` because that
 * helper calls `dbRun(...)` which is fire-and-forget on the PgBackend
 * (`this.pool.query(...).catch(...)` — Promise dropped). In a one-shot
 * script context the pool gets closed BEFORE the INSERT actually commits.
 * This script uses `pg.Pool` directly + awaits the query result so the
 * INSERT lands before the pool ends. Same shape as the existing async
 * methods on PgBackend (`runAsync` / `execAsync` / `query`).
 *
 * Usage (post-deploy, operator-side per chapter):
 *   ssh -i ~/.ssh/algovault_deploy root@204.168.185.24 \
 *     'docker exec crypto-quant-signal-mcp-mcp-server-1 \
 *      node /app/dist/scripts/seed-shadow-venues-w3a.js'
 *
 * Per-chapter activation:
 *   - C1: PHEMEX always inserts.
 *   - C2: `W3A_C2_ACTIVATED=1` env unlocks BINGX.
 *   - C3: `W3A_C3_ACTIVATED=1` env unlocks HTX.
 *
 * Plan-Mode probe (2026-05-20):
 *   - Phemex: 538 USDT-margined hedged perpetuals (perpProductsV2); $3.30B OI;
 *     100% PoR + 99.999% uptime claim; Tier-A reputation.
 *   - BingX:  638 USDT-perp listed; $3.52B OI; CoinGecko rank 19; Tier-A.
 *   - HTX:    233 USDT swap listed; $4.75B OI; +14.48pp derivs swing Q1 2026;
 *     Tier-A recovery story.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Pool } = require('pg');

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
    notes: 'PILOT-ADAPTERS-W3A C2 (2026-05-20) — BingX Swap V2 USDT-M Perpetual; $3.52B 24h OI / 638 USDT perps / 88% derivs-mix / CoinGecko rank 19 / Tier-A reputation. Plan-Mode probe 2026-05-20 confirmed direct-float JSON shape (no encoding); kline limit normal integer range up to 1440. C2 ACTIVATED (guard removed).',
  },
  {
    exchangeId: 'HTX',
    assetCount: 233,
    notes: 'PILOT-ADAPTERS-W3A C3 (2026-05-20) — HTX (formerly Huobi) Linear USDT-Margined Swap; $4.75B 24h OI / 233 USDT swap perps / +14.48pp derivs swing Q1 2026 / 800req/s per-IP market-data rate limit / Tier-A reputation, recovery story.',
    guardEnv: 'W3A_C3_ACTIVATED',
  },
];

async function main(): Promise<void> {
  // Connection string from env — mirrors performance-db.ts PgBackend
  // constructor (which uses process.env.DATABASE_URL).
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL env var is required');
  }

  const pool = new Pool({ connectionString });
  let inserted = 0;
  let skipped = 0;
  let alreadyPresent = 0;

  try {
    for (const venue of W3A_VENUES) {
      if (venue.guardEnv && process.env[venue.guardEnv] !== '1') {
        console.log(`[seed-shadow-venues-w3a] SKIP ${venue.exchangeId} (guard env ${venue.guardEnv}!=1; chapter not yet activated)`);
        skipped++;
        continue;
      }

      const minBuySellSample = venue.assetCount * 10;
      const integratedAt = new Date();

      // INSERT with ON CONFLICT DO NOTHING; RETURNING * tells us if the row
      // actually landed (no-op when already present).
      const result = await pool.query(
        `INSERT INTO venues (exchange_id, status, asset_count, min_buy_sell_sample, integrated_at, notes)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (exchange_id) DO NOTHING
         RETURNING exchange_id`,
        [venue.exchangeId, 'shadow', venue.assetCount, minBuySellSample, integratedAt, venue.notes]
      );

      if (result.rowCount > 0) {
        console.log(`[seed-shadow-venues-w3a] OK ${venue.exchangeId} status=shadow asset_count=${venue.assetCount} min_buy_sell_sample=${minBuySellSample}`);
        inserted++;
      } else {
        // Row already present; verify by selecting it for the operator's audit trail
        const existing = await pool.query(
          `SELECT status, asset_count, min_buy_sell_sample, integrated_at FROM venues WHERE exchange_id = $1`,
          [venue.exchangeId]
        );
        const row = existing.rows[0];
        console.log(`[seed-shadow-venues-w3a] PRESENT ${venue.exchangeId} status=${row?.status} asset_count=${row?.asset_count} min_buy_sell_sample=${row?.min_buy_sell_sample} integrated_at=${row?.integrated_at}`);
        alreadyPresent++;
      }
    }

    console.log(`[seed-shadow-venues-w3a] DONE inserted=${inserted} already_present=${alreadyPresent} skipped=${skipped}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[seed-shadow-venues-w3a] FATAL:', err);
  process.exit(1);
});

/**
 * build-equity-universe.ts — EQUITIES-ENGINE-W1 C2 producer.
 *
 * Pulls ohlcv-1d for ALL_SYMBOLS over the lookback window (date-chunked to cap
 * memory), ranks by MEDIAN daily dollar volume (close*volume), and freezes the
 * top-N + ETF whitelist into equity_universe. Cost-gated, idempotent re-freeze.
 *
 * Run: docker exec crypto-quant-signal-mcp-mcp-server-1 node dist/scripts/build-equity-universe.js
 * CJS/Node16 (__dirname-safe; never import.meta).
 */
import { DatabentoEquityBarsProvider } from '../lib/equities/equity-bars-provider.js';
import { buildUniverse } from '../lib/equities/equity-universe-rank.js';
import { makeEquityPool, freezeUniverse } from '../lib/equities/equity-store.js';
import {
  UNIVERSE_TOP_N,
  ETF_WHITELIST,
  UNIVERSE_LOOKBACK_DAYS,
} from '../lib/equities/equity-constants.js';

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function log(msg: string): void { console.log(`[build-equity-universe] ${msg}`); }

export async function buildEquityUniverse(): Promise<{ active: number }> {
  const key = process.env.DATABENTO_API_KEY;
  if (!key) throw new Error('DATABENTO_API_KEY not set (append to container .env + `docker compose up -d mcp-server`).');

  const provider = new DatabentoEquityBarsProvider(key, { logger: log });
  const pool = makeEquityPool();
  try {
    const latest = await provider.getLatestAvailableSession();
    const endExclusive = addDays(latest, 1);
    const start = addDays(endExclusive, -UNIVERSE_LOOKBACK_DAYS);
    log(`window ${start}..${endExclusive} (latest session ${latest})`);

    const cost = await provider.getCostUsd('ALL_SYMBOLS', start, endExclusive);
    log(`estimated ALL_SYMBOLS ohlcv-1d cost: $${cost.toFixed(4)}`);

    // Date-chunk the pull so peak memory stays bounded (~45-day windows).
    const dollarVolumes = new Map<string, number[]>();
    let chunkStart = start;
    let totalRows = 0;
    while (chunkStart < endExclusive) {
      const chunkEnd = (() => { const e = addDays(chunkStart, 45); return e < endExclusive ? e : endExclusive; })();
      const bars = await provider.getDailyBars(['ALL_SYMBOLS'], chunkStart, chunkEnd);
      for (const b of bars) {
        const dv = b.close * b.volume;
        if (!Number.isFinite(dv) || dv <= 0) continue;
        let arr = dollarVolumes.get(b.symbol);
        if (!arr) { arr = []; dollarVolumes.set(b.symbol, arr); }
        arr.push(dv);
      }
      totalRows += bars.length;
      log(`chunk ${chunkStart}..${chunkEnd}: ${bars.length} rows (symbols so far ${dollarVolumes.size})`);
      chunkStart = chunkEnd;
    }
    log(`pulled ${totalRows} rows across ${dollarVolumes.size} symbols`);

    const rows = buildUniverse(dollarVolumes, UNIVERSE_TOP_N, ETF_WHITELIST);
    const active = await freezeUniverse(pool, rows);
    const etfCount = rows.filter((r) => r.is_etf).length;
    log(`froze universe: ${active} active (${etfCount} ETFs, top-N=${UNIVERSE_TOP_N})`);
    return { active };
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  buildEquityUniverse()
    .then((r) => { log(`DONE active=${r.active}`); process.exit(0); })
    .catch((e) => { console.error(`[build-equity-universe] FATAL ${e?.code ?? ''} ${e?.message ?? e}`); process.exit(1); });
}

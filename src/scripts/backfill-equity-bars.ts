/**
 * backfill-equity-bars.ts — EQUITIES-ENGINE-W1 C2 producer.
 *
 * Pulls ~2 years of ohlcv-1d for the FROZEN universe (universe-only — never
 * ALL_SYMBOLS) in bounded-concurrency symbol batches and idempotently upserts
 * into equity_bars_daily. Resumable: ON CONFLICT DO NOTHING + per-batch logs.
 *
 * Run: docker exec crypto-quant-signal-mcp-mcp-server-1 node dist/scripts/backfill-equity-bars.js
 * CJS/Node16.
 */
import pLimit from 'p-limit';
import { runScript } from '../lib/script-lifecycle.js';
import { DatabentoEquityBarsProvider } from '../lib/equities/equity-bars-provider.js';
import { makeEquityPool, getActiveUniverse, upsertBars, countBars } from '../lib/equities/equity-store.js';
import { BACKFILL_DAYS, DATABENTO_HISTORY_START } from '../lib/equities/equity-constants.js';

const SYMBOLS_PER_REQUEST = 40;   // bounded Databento request width
const CONCURRENCY = 4;            // bounded parallel requests

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function maxDate(a: string, b: string): string { return a >= b ? a : b; }
function log(msg: string): void { console.log(`[backfill-equity-bars] ${msg}`); }
function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export async function backfillEquityBars(): Promise<{ bars: number; batches: number }> {
  const key = process.env.DATABENTO_API_KEY;
  if (!key) throw new Error('DATABENTO_API_KEY not set.');

  const provider = new DatabentoEquityBarsProvider(key, { logger: log });
  const pool = makeEquityPool();
  try {
    const universe = await getActiveUniverse(pool);
    if (universe.length === 0) throw new Error('equity_universe is empty — run build-equity-universe first.');

    const latest = await provider.getLatestAvailableSession();
    const endExclusive = addDays(latest, 1);
    const start = maxDate(addDays(endExclusive, -BACKFILL_DAYS), DATABENTO_HISTORY_START);
    log(`backfilling ${universe.length} symbols, ${start}..${endExclusive}`);

    const cost = await provider.getCostUsd(universe.map((u) => u.symbol), start, endExclusive);
    log(`estimated universe ohlcv-1d 2y cost: $${cost.toFixed(4)}`);

    const batches = chunk(universe.map((u) => u.symbol), SYMBOLS_PER_REQUEST);
    const limit = pLimit(CONCURRENCY);
    let totalInserted = 0;
    let done = 0;

    await Promise.all(batches.map((batch, idx) => limit(async () => {
      try {
        const bars = await provider.getDailyBars(batch, start, endExclusive);
        const inserted = await upsertBars(pool, bars);
        totalInserted += inserted;
        done++;
        log(`batch ${done}/${batches.length} (${batch.length} syms): ${bars.length} bars, +${inserted} new`);
      } catch (e: unknown) {
        const err = e as { code?: string; message?: string };
        // Fail-open per batch: log, continue (resumable on re-run via ON CONFLICT).
        log(`batch ${idx + 1} ERROR ${err.code ?? ''} ${err.message ?? e} — continuing (resumable)`);
      }
    })));

    const total = await countBars(pool);
    log(`done: +${totalInserted} new this run; equity_bars_daily total=${total}`);
    return { bars: total, batches: batches.length };
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  void runScript('backfill-equity-bars', async () => {
    const r = await backfillEquityBars();
    log(`DONE bars=${r.bars} batches=${r.batches}`);
  }); // OPS-SCRIPT-EXIT-LIFECYCLE-W1
}

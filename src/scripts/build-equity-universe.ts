/**
 * build-equity-universe.ts — EQUITIES-ENGINE-W1 C2 producer.
 *
 * Pulls ohlcv-1d for ALL_SYMBOLS over the lookback window (date-chunked to cap
 * memory) keyed by instrument_id — Databento forbids map_symbols with
 * ALL_SYMBOLS — ranks by MEDIAN daily dollar volume, resolves the survivors'
 * instrument_ids to raw_symbols, and freezes the top-N + ETF whitelist into
 * equity_universe. Cost-gated, idempotent re-freeze.
 *
 * Run: docker exec crypto-quant-signal-mcp-mcp-server-1 node dist/scripts/build-equity-universe.js
 * CJS/Node16 (__dirname-safe; never import.meta).
 */
import { DatabentoEquityBarsProvider } from '../lib/equities/equity-bars-provider.js';
import { runScript } from '../lib/script-lifecycle.js';
import { buildUniverse, median } from '../lib/equities/equity-universe-rank.js';
import { makeEquityPool, freezeUniverse } from '../lib/equities/equity-store.js';
import {
  UNIVERSE_TOP_N,
  ETF_WHITELIST,
  UNIVERSE_LOOKBACK_DAYS,
} from '../lib/equities/equity-constants.js';

/** Resolution cushion: rank a few extra ids so symbology misses don't drop us below top-N. */
const RESOLVE_CUSHION = 60;

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

    // 1) Date-chunk the pull (bounded memory), aggregate $-vol per instrument_id.
    const dvById = new Map<string, number[]>();
    let chunkStart = start;
    let totalRows = 0;
    while (chunkStart < endExclusive) {
      const chunkEnd = (() => { const e = addDays(chunkStart, 45); return e < endExclusive ? e : endExclusive; })();
      const raws = await provider.getDailyBarsRaw(['ALL_SYMBOLS'], chunkStart, chunkEnd);
      for (const r of raws) {
        const dv = r.close * r.volume;
        if (!Number.isFinite(dv) || dv <= 0) continue;
        let arr = dvById.get(r.instrument_id);
        if (!arr) { arr = []; dvById.set(r.instrument_id, arr); }
        arr.push(dv);
      }
      totalRows += raws.length;
      log(`chunk ${chunkStart}..${chunkEnd}: ${raws.length} rows (instruments so far ${dvById.size})`);
      chunkStart = chunkEnd;
    }
    log(`pulled ${totalRows} rows across ${dvById.size} instruments`);

    // 2) Rank instrument_ids by median $-vol; take top-N + cushion.
    const rankedIds = [...dvById.entries()]
      .map(([id, samples]) => ({ id, med: median(samples) }))
      .sort((a, b) => b.med - a.med)
      .slice(0, UNIVERSE_TOP_N + RESOLVE_CUSHION)
      .map((x) => x.id);

    // 3) Resolve those instrument_ids -> raw_symbols.
    const idToSym = await provider.resolveSymbology(rankedIds, 'instrument_id', 'raw_symbol', start, latest);
    // 3b) Reverse-resolve ETF whitelist -> instrument_ids so their ADV is real.
    const etfSymToId = await provider.resolveSymbology([...ETF_WHITELIST], 'raw_symbol', 'instrument_id', start, latest);

    // 4) Re-key samples by symbol for the ranked survivors + ETFs.
    const dvBySymbol = new Map<string, number[]>();
    for (const id of rankedIds) {
      const sym = idToSym.get(id);
      if (sym && dvById.has(id)) dvBySymbol.set(sym, dvById.get(id)!);
    }
    for (const etf of ETF_WHITELIST) {
      const id = etfSymToId.get(etf);
      if (id && dvById.has(id) && !dvBySymbol.has(etf)) dvBySymbol.set(etf, dvById.get(id)!);
    }

    // 5) Build + freeze (buildUniverse caps the ranked set at UNIVERSE_TOP_N).
    const rows = buildUniverse(dvBySymbol, UNIVERSE_TOP_N, ETF_WHITELIST);
    const active = await freezeUniverse(pool, rows);
    const etfCount = rows.filter((r) => r.is_etf).length;
    log(`froze universe: ${active} active (${etfCount} ETFs, top-N=${UNIVERSE_TOP_N}, resolved=${idToSym.size}/${rankedIds.length})`);
    return { active };
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  void runScript('build-equity-universe', async () => {
    const r = await buildEquityUniverse();
    log(`DONE active=${r.active}`);
  }); // OPS-SCRIPT-EXIT-LIFECYCLE-W1
}

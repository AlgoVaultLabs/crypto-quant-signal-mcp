// sr-backtest/fetch-store.ts — EDGE-SR-LEVEL-BACKTEST-W1: the backtest's candle reads, on the operator's machine.
//
//   npx tsx src/scripts/sr-backtest/fetch-store.ts --store <dir> [--venue BINANCE] [--end <ISO>] [--panel <coins.json>]
//   npx tsx src/scripts/sr-backtest/fetch-store.ts --store <dir> [--venue BINANCE] --manifest
//
// Every bar comes from the venue adapter's own `getCandles` (the exchange-adapter interface, never a raw call),
// paged and paced like src/scripts/sr-probe/fetch-candles.ts and tagged with this entrypoint's own caller name.
// Closed bars only: the window ends at a UTC midnight already past. Resumable: the plan (window, panel as-of, every
// candidate's fate) is written after each candidate and a series already on disk for the same range is not re-read.
//
// The panel: candidates in descending 24h quote volume; a candidate joins when all four series hold every bar of
// the window plus the warm-up, and the walk stops at the panel size. For BINANCE the ranking is the adapter's own
// coalesced 24h ticker; any other venue takes its candidate order from --panel.
//
// The manifest (per series: range, bars, sha256; failures listed) is what the registration pins and what the
// outcome step re-derives before it reads anything.
import fs from 'node:fs';
import { getAdapter } from '../../lib/exchange-adapter.js';
import { runAsCaller } from '../../lib/upstream-weight-budget.js';
import { fromBinanceSymbol, getTicker24hrFullCoalesced } from '../../lib/adapters/binance.js';
import { historyMetaOf } from '../../lib/adapters/_history-plan.js';
import type { ExchangeId } from '../../types.js';
import { readSeries, seriesFile, WALK_VERSION, type StoredSeries } from '../sr-probe/store.js';
import { DAY, STUDY, TIMEFRAMES, type Timeframe } from './spec.js';
import { buildManifest, manifestFile, manifestText, missingBars, planFile, readPlan, seriesRange, sha256, writeAtomic, type StorePlan } from './store.js';

/** Minimum ms between two pages on one venue (the probe's measured pacing). */
const PACE_MS: Readonly<Record<string, number>> = Object.freeze({ BINANCE: 260, BYBIT: 200, OKX: 300, BITGET: 260 });
const PAGE_CAP: Readonly<Record<string, number>> = Object.freeze({ BINANCE: 200, BYBIT: 200, OKX: 100, BITGET: 200 });
const MAX_PAGES = 4000;
const MAX_RATE_LIMIT_STRIKES = 3;
/** Bases that are not a crypto asset's own market: USD stablecoins, the adapter's TradFi aliases, index perps. */
const EXCLUDED_BASES: ReadonlySet<string> = new Set([
  'USDC', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'BUSD', 'USDE', 'USD1', 'PYUSD', 'RLUSD', 'EUR', 'EURI',
  'XAU', 'XAG', 'XPT', 'XPD', 'GOLD', 'SILVER', 'PLATINUM', 'PALLADIUM', 'BTCDOM', 'DEFI', 'ALL',
]);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

class VenueAbort extends Error {}

interface Pace { last: number; strikes: number; pages: number }

/** One series over one range. The paging rule is the probe's (WALK_VERSION 2): the cursor sits one ms before the
 *  first wanted open and one ms after the newest bar in hand, and a window that holds no bar is stepped over. */
async function fetchSeries(venue: string, coin: string, tf: Timeframe, range: [number, number], pace: Pace): Promise<StoredSeries> {
  const adapter = getAdapter(venue as ExchangeId);
  const bars = new Map<number, [number, number, number, number, number]>();
  const branches: Record<string, number> = {};
  const span = (PAGE_CAP[venue] ?? 100) * tf.stepMs;
  const [startMs, endMs] = range;
  let cursor = startMs - 1;
  let pages = 0;
  while (cursor <= endMs && pages < MAX_PAGES) {
    const wait = pace.last + (PACE_MS[venue] ?? 500) - Date.now();
    if (wait > 0) await sleep(wait);
    pace.last = Date.now();
    let page;
    try {
      page = await adapter.getCandles(coin, tf.key, cursor, undefined, endMs);
      pace.strikes = 0;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'UPSTREAM_RATE_LIMIT' || code === 'WEIGHT_BUDGET_SKIP') {
        pace.strikes++;
        if (pace.strikes >= MAX_RATE_LIMIT_STRIKES) throw new VenueAbort(`${venue}: ${pace.strikes} rate-limit refusals in a row — stopping`);
        const retryAfter = (err as { retryAfterSeconds?: number | null }).retryAfterSeconds ?? 0;
        await sleep(Math.max(65, retryAfter + 5) * 1000);
        continue;
      }
      throw err;
    }
    pages++;
    pace.pages++;
    const meta = historyMetaOf(page);
    const branch = meta?.branch ?? 'none';
    branches[branch] = (branches[branch] ?? 0) + 1;
    let maxTime = cursor;
    let firstFresh = Infinity;
    for (const c of page ?? []) {
      if (c.time >= startMs && c.time <= endMs) bars.set(c.time, [c.time, c.open, c.high, c.low, c.close]);
      if (c.time <= cursor) continue;
      if (c.time < firstFresh) firstFresh = c.time;
      if (c.time > maxTime) maxTime = c.time;
    }
    const windowEmpty = firstFresh === Infinity || meta?.substitutedNewest === true || firstFresh > cursor + span;
    cursor = windowEmpty ? cursor + span : maxTime + 1;
  }
  return {
    exchange: venue, coin, key: tf.key, stepMs: tf.stepMs, ranges: [range], status: 'ok', pages, branches,
    fetchedAt: new Date().toISOString(), bars: [...bars.values()].sort((a, b) => a[0] - b[0]), walk: WALK_VERSION,
  };
}

/** Reads (or re-uses) one series and returns how many planned bars it lacks. A failed read is stored as failed. */
async function ensureSeries(store: string, venue: string, coin: string, tf: Timeframe, range: [number, number], pace: Pace): Promise<{ missing: number; error?: string }> {
  const prior = readSeries(store, { exchange: venue, coin, stepMs: tf.stepMs });
  if (prior && prior.status === 'ok' && JSON.stringify(prior.ranges) === JSON.stringify([range])) return { missing: missingBars(prior, range) };
  let stored: StoredSeries | null = null;
  // One retry: a single dropped connection must not cost a high-volume coin its place in the panel.
  for (let attempt = 0; attempt < 2 && (stored === null || stored.status !== 'ok'); attempt++) {
    if (attempt > 0) await sleep(5000);
    try {
      stored = await fetchSeries(venue, coin, tf, range, pace);
    } catch (err) {
      if (err instanceof VenueAbort) throw err;
      stored = {
        exchange: venue, coin, key: tf.key, stepMs: tf.stepMs, ranges: [range], status: 'failed',
        error: String((err as Error).message ?? err).slice(0, 300), pages: 0, branches: {}, fetchedAt: new Date().toISOString(), bars: [],
      };
    }
  }
  if (stored === null) throw new Error('unreachable');
  writeAtomic(seriesFile(store, { exchange: venue, coin, stepMs: tf.stepMs }), JSON.stringify(stored));
  if (stored.status !== 'ok') return { missing: Infinity, error: stored.error };
  return { missing: missingBars(stored, range) };
}

/** Candidate order: BINANCE from the adapter's coalesced 24h ticker; any other venue from --panel. */
async function candidateOrder(venue: string, panelArg: string | undefined): Promise<{ source: string; rows: Array<{ coin: string; symbol: string; quoteVolume: number }> }> {
  if (panelArg) {
    const coins = JSON.parse(fs.readFileSync(panelArg, 'utf8')) as string[];
    return { source: `--panel ${sha256(fs.readFileSync(panelArg))}`, rows: coins.map((coin) => ({ coin, symbol: coin, quoteVolume: 0 })) };
  }
  if (venue !== 'BINANCE') throw new Error(`${venue}: no built-in volume ranking — pass --panel <coins.json> (candidates in order)`);
  const tickers = await getTicker24hrFullCoalesced();
  const rows = tickers
    .filter((t) => /^[A-Z0-9]+USDT$/.test(t.symbol))
    .map((t) => ({ coin: fromBinanceSymbol(t.symbol), symbol: t.symbol, quoteVolume: Number(t.quoteVolume) }))
    .filter((r) => Number.isFinite(r.quoteVolume) && !EXCLUDED_BASES.has(r.coin) && !EXCLUDED_BASES.has(r.symbol.replace(/USDT$/, '')))
    .sort((a, b) => b.quoteVolume - a.quoteVolume || (a.symbol < b.symbol ? -1 : 1));
  return { source: 'BINANCE /fapi/v1/ticker/24hr via getTicker24hrFullCoalesced (USDT-quoted perps, quoteVolume descending)', rows };
}

async function run(store: string, venue: string): Promise<boolean> {
  let plan = readPlan(store, venue);
  if (!plan) {
    const endArg = arg('--end');
    const endMs = endArg ? Date.parse(endArg) : Math.floor(Date.now() / DAY) * DAY;
    if (!Number.isFinite(endMs) || endMs % DAY !== 0 || endMs > Date.now()) throw new Error('--end must be a UTC midnight that has passed');
    const order = await candidateOrder(venue, arg('--panel'));
    plan = {
      venue, endMs, startMs: endMs - STUDY.windowDays * DAY, warmupBars: STUDY.warmupBars, panelSize: STUDY.panelSize,
      panelAsOf: new Date().toISOString(), panelSource: order.source,
      candidates: order.rows.map((r) => ({ ...r, status: 'rejected' as const, reason: 'not walked' })), coins: [],
    };
    writeAtomic(planFile(store, venue), JSON.stringify(plan, null, 1));
  }
  const pace: Pace = { last: 0, strikes: 0, pages: 0 };
  // Coarsest first: a listing younger than the daily warm-up is turned away after four pages.
  const order = [...TIMEFRAMES].sort((a, b) => b.stepMs - a.stepMs);
  let aborted: string | null = null;
  for (const cand of plan.candidates) {
    if (plan.coins.length >= plan.panelSize) break;
    if (cand.status === 'accepted' || (cand.status === 'rejected' && cand.reason !== 'not walked')) continue;
    let reason: string | undefined;
    try {
      for (const tf of order) {
        const got = await ensureSeries(store, venue, cand.coin, tf, seriesRange(plan, tf.stepMs), pace);
        if (got.missing !== 0) {
          reason = got.error ? `${tf.key}: fetch failed — ${got.error}` : `${tf.key}: ${got.missing} planned bars absent`;
          break;
        }
      }
    } catch (err) {
      if (err instanceof VenueAbort) {
        aborted = err.message;
        break;
      }
      throw err;
    }
    if (reason) {
      cand.status = 'rejected';
      cand.reason = reason;
    } else {
      cand.status = 'accepted';
      delete cand.reason;
      plan.coins.push(cand.coin);
    }
    writeAtomic(planFile(store, venue), JSON.stringify(plan, null, 1));
    process.stderr.write(`[sr-backtest-fetch] ${cand.coin}: ${cand.status}${reason ? ` (${reason})` : ''} — panel ${plan.coins.length}/${plan.panelSize}, ${pace.pages} pages\n`);
  }
  if (aborted) process.stderr.write(`[sr-backtest-fetch] ${aborted}\n`);
  return aborted === null && plan.coins.length >= plan.panelSize;
}

async function main(): Promise<void> {
  const store = arg('--store');
  const venue = (arg('--venue') ?? 'BINANCE').toUpperCase();
  if (!store) {
    process.stderr.write('usage: fetch-store.ts --store <dir> [--venue BINANCE] [--end <ISO>] [--panel <coins.json>] [--manifest]\n');
    process.exitCode = 2;
    return;
  }
  const full = process.argv.includes('--manifest') ? true : await runAsCaller('sr-level-backtest', () => run(store, venue));
  const plan = readPlan(store, venue);
  if (!plan) throw new Error(`no plan at ${planFile(store, venue)} — run the fetch first`);
  const manifest = buildManifest(store, plan);
  const text = manifestText(manifest);
  writeAtomic(manifestFile(store, venue), text);
  const ok = full && manifest.failures.length === 0 && manifest.coins.length >= plan.panelSize;
  process.stdout.write(`${JSON.stringify({ venue, coins: manifest.coins.length, series: manifest.series.length, failures: manifest.failures.length, manifestSha256: sha256(text) })}\n`);
  // exitCode, never process.exit(): a queued pipe write would lose the token.
  process.stdout.write(`SR_BACKTEST_FETCH_VERDICT=${ok ? 'PASS' : 'INDETERMINATE'}\n`);
  process.exitCode = ok ? 0 : 3;
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[sr-backtest-fetch] ${String((err as Error).stack ?? err)}\n`);
    process.stdout.write('SR_BACKTEST_FETCH_VERDICT=INDETERMINATE\n');
    process.exitCode = 3;
  });
}

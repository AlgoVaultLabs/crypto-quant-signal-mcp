// sr-backtest/fetch-store.ts — EDGE-SR-LEVEL-BACKTEST-W1: the backtest's candle reads, on the operator's machine.
//
//   npx tsx src/scripts/sr-backtest/fetch-store.ts --store <dir> [--venue BINANCE] [--end <ISO>] [--panel <coins.json>]
//                                                  [--start <ISO>] [--label <name>] [--panel-size <n>] [--volume]
//   npx tsx src/scripts/sr-backtest/fetch-store.ts --store <dir> [--venue BINANCE] [--label <name>] --manifest
//   npx tsx src/scripts/sr-backtest/fetch-store.ts --listing --panel <coins.json> [--venue BINANCE] [--end <ISO>]
//
// EDGE-SR-HTF-LEVELS-W1 added the four bracketed flags of the first line and `--listing`; without them every byte
// this file writes is what it wrote before (tests/unit/sr-htf-store.test.ts):
//   --start       the window's first instant (a UTC midnight); default `--end` minus the registered 365 days
//   --label       names the plan and manifest files (`plan-<label>.json`): one store can hold one plan per coin
//                 when every coin has its own window; default the venue
//   --panel-size  the panel the walk stops at; default the registered 50
//   --volume      store version 2: every bar carries the venue's volume as a sixth field
//   --listing     reads nothing into the store: per coin, the first 15-minute bar the venue serves and the first
//                 full UTC day of its history
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

/** Store version 2: each bar is [openMs, open, high, low, close, volume]. Version 1 (no `version` field) is the
 *  five-field store every earlier series was written in. */
export const STORE_VERSION_VOLUME = 2;

/** A series as this fetcher writes it: the probe's shape, with a sixth field per bar in store version 2. */
type FetchedSeries = Omit<StoredSeries, 'bars'> & { bars: number[][]; version?: number };

/** The stored row of one candle: five fields, or six with the volume. */
export const barTuple = (c: { time: number; open: number; high: number; low: number; close: number; volume: number }, volume: boolean): number[] =>
  volume ? [c.time, c.open, c.high, c.low, c.close, c.volume] : [c.time, c.open, c.high, c.low, c.close];

/** The store version a series was written in (absent = 1). */
export const seriesVersion = (s: { version?: number }): number => s.version ?? 1;

/** The first full UTC day of a history whose first bar opens at `firstBarMs`: that day when the bar opens at
 *  midnight, else the next one. */
export const firstFullDay = (firstBarMs: number): number => (firstBarMs % DAY === 0 ? firstBarMs : (Math.floor(firstBarMs / DAY) + 1) * DAY);

/** The window of a new plan from the flags: `--end` (default the last UTC midnight) and `--start` (default `--end`
 *  minus the registered window). Both must be UTC midnights, the start before the end, the end already past. */
export function planWindow(o: { endArg?: string; startArg?: string; nowMs: number }): { startMs: number; endMs: number } {
  const endMs = o.endArg ? Date.parse(o.endArg) : Math.floor(o.nowMs / DAY) * DAY;
  if (!Number.isFinite(endMs) || endMs % DAY !== 0 || endMs > o.nowMs) throw new Error('--end must be a UTC midnight that has passed');
  const startMs = o.startArg ? Date.parse(o.startArg) : endMs - STUDY.windowDays * DAY;
  if (!Number.isFinite(startMs) || startMs % DAY !== 0 || startMs >= endMs) throw new Error('--start must be a UTC midnight before --end');
  return { startMs, endMs };
}

/** One series over one range. The paging rule is the probe's (WALK_VERSION 2): the cursor sits one ms before the
 *  first wanted open and one ms after the newest bar in hand, and a window that holds no bar is stepped over. */
async function fetchSeries(venue: string, coin: string, tf: Timeframe, range: [number, number], pace: Pace, volume: boolean): Promise<FetchedSeries> {
  const adapter = getAdapter(venue as ExchangeId);
  const bars = new Map<number, number[]>();
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
      if (c.time >= startMs && c.time <= endMs) bars.set(c.time, barTuple(c, volume));
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
    ...(volume ? { version: STORE_VERSION_VOLUME } : {}),
  };
}

/** Reads (or re-uses) one series and returns how many planned bars it lacks. A failed read is stored as failed.
 *  A series on disk is re-used only for the same range AND the same store version. */
async function ensureSeries(store: string, venue: string, coin: string, tf: Timeframe, range: [number, number], pace: Pace, volume: boolean): Promise<{ missing: number; error?: string }> {
  const prior = readSeries(store, { exchange: venue, coin, stepMs: tf.stepMs }) as (StoredSeries & { version?: number }) | null;
  if (prior && prior.status === 'ok' && JSON.stringify(prior.ranges) === JSON.stringify([range]) && seriesVersion(prior) === (volume ? STORE_VERSION_VOLUME : 1)) {
    return { missing: missingBars(prior, range) };
  }
  let stored: FetchedSeries | null = null;
  // One retry: a single dropped connection must not cost a high-volume coin its place in the panel.
  for (let attempt = 0; attempt < 2 && (stored === null || stored.status !== 'ok'); attempt++) {
    if (attempt > 0) await sleep(5000);
    try {
      stored = await fetchSeries(venue, coin, tf, range, pace, volume);
    } catch (err) {
      if (err instanceof VenueAbort) throw err;
      stored = {
        exchange: venue, coin, key: tf.key, stepMs: tf.stepMs, ranges: [range], status: 'failed',
        error: String((err as Error).message ?? err).slice(0, 300), pages: 0, branches: {}, fetchedAt: new Date().toISOString(), bars: [],
        ...(volume ? { version: STORE_VERSION_VOLUME } : {}),
      };
    }
  }
  if (stored === null) throw new Error('unreachable');
  writeAtomic(seriesFile(store, { exchange: venue, coin, stepMs: tf.stepMs }), JSON.stringify(stored));
  if (stored.status !== 'ok') return { missing: Infinity, error: stored.error };
  return { missing: missingBars(stored as unknown as StoredSeries, range) };
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

/** `--listing`: per --panel coin, the first 15-minute bar the venue serves (a history read from epoch 0) and the
 *  first full UTC day of that history. Writes nothing. True when every coin answered with a bar. */
async function listing(venue: string): Promise<boolean> {
  const panel = arg('--panel');
  if (!panel) throw new Error('--listing needs --panel <coins.json>');
  const { endMs } = planWindow({ endArg: arg('--end'), nowMs: Date.now() });
  const adapter = getAdapter(venue as ExchangeId);
  let last = 0;
  let all = true;
  for (const coin of JSON.parse(fs.readFileSync(panel, 'utf8')) as string[]) {
    const wait = last + (PACE_MS[venue] ?? 500) - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const page = await adapter.getCandles(coin, '15m', 0, undefined, endMs);
    const first = Math.min(...(page ?? []).map((c) => c.time));
    if (!Number.isFinite(first)) all = false;
    const day = Number.isFinite(first) ? firstFullDay(first) : null;
    process.stdout.write(`${JSON.stringify({ coin, firstBarMs: Number.isFinite(first) ? first : null, firstBarAt: Number.isFinite(first) ? new Date(first).toISOString() : null,
      firstFullDayMs: day, firstFullDay: day === null ? null : new Date(day).toISOString() })}\n`);
  }
  return all;
}

/** The fetch: the plan (written once, then resumed), then the panel walk. Exported for tests/unit/sr-htf-store.test.ts,
 *  which drives it on a fake adapter; the flags are read from process.argv. */
export async function run(store: string, venue: string, label: string, volumeFlag: boolean): Promise<boolean> {
  let plan = readPlan(store, label) as (StorePlan & { storeVersion?: number }) | null;
  if (!plan) {
    const { startMs, endMs } = planWindow({ endArg: arg('--end'), startArg: arg('--start'), nowMs: Date.now() });
    const sizeArg = arg('--panel-size');
    const panelSize = sizeArg === undefined ? STUDY.panelSize : Number(sizeArg);
    if (!Number.isInteger(panelSize) || panelSize < 1) throw new Error('--panel-size must be a positive integer');
    const order = await candidateOrder(venue, arg('--panel'));
    plan = {
      venue, endMs, startMs, warmupBars: STUDY.warmupBars, panelSize,
      panelAsOf: new Date().toISOString(), panelSource: order.source,
      candidates: order.rows.map((r) => ({ ...r, status: 'rejected' as const, reason: 'not walked' })), coins: [],
      ...(volumeFlag ? { storeVersion: STORE_VERSION_VOLUME } : {}),
    };
    writeAtomic(planFile(store, label), JSON.stringify(plan, null, 1));
  }
  const volume = (plan.storeVersion ?? 1) === STORE_VERSION_VOLUME;
  if (volume !== volumeFlag) throw new Error(`${planFile(store, label)} is store version ${plan.storeVersion ?? 1}: ${volume ? 'pass' : 'drop'} --volume to resume it`);
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
        const got = await ensureSeries(store, venue, cand.coin, tf, seriesRange(plan, tf.stepMs), pace, volume);
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
    writeAtomic(planFile(store, label), JSON.stringify(plan, null, 1));
    process.stderr.write(`[sr-backtest-fetch] ${cand.coin}: ${cand.status}${reason ? ` (${reason})` : ''} — panel ${plan.coins.length}/${plan.panelSize}, ${pace.pages} pages\n`);
  }
  if (aborted) process.stderr.write(`[sr-backtest-fetch] ${aborted}\n`);
  return aborted === null && plan.coins.length >= plan.panelSize;
}

async function main(): Promise<void> {
  const store = arg('--store');
  const venue = (arg('--venue') ?? 'BINANCE').toUpperCase();
  const listingMode = process.argv.includes('--listing');
  if (!store && !listingMode) {
    process.stderr.write('usage: fetch-store.ts --store <dir> [--venue BINANCE] [--end <ISO>] [--panel <coins.json>] [--start <ISO>] [--label <name>] [--panel-size <n>] [--volume] [--manifest]\n'
      + '       fetch-store.ts --listing --panel <coins.json> [--venue BINANCE] [--end <ISO>]\n');
    process.exitCode = 2;
    return;
  }
  const label = arg('--label') ?? venue;
  const volume = process.argv.includes('--volume');
  const full = process.argv.includes('--manifest') && !listingMode ? true
    : await runAsCaller('sr-level-backtest', () => (listingMode ? listing(venue) : run(store!, venue, label, volume)));
  if (listingMode) {
    process.stdout.write(`SR_BACKTEST_LISTING_VERDICT=${full ? 'PASS' : 'INDETERMINATE'}\n`);
    process.exitCode = full ? 0 : 3;
    return;
  }
  const plan = readPlan(store!, label);
  if (!plan) throw new Error(`no plan at ${planFile(store!, label)} — run the fetch first`);
  const manifest = buildManifest(store!, plan);
  const text = manifestText(manifest);
  writeAtomic(manifestFile(store!, label), text);
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

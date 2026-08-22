#!/usr/bin/env npx tsx
/**
 * sell-gate-fetch.ts — SIGNAL-SELL-GATE-SYMMETRY-W1 CH1, corpus builder.
 *
 * Pages the REAL `BinanceAdapter` (never a raw API call — CLAUDE.md codes against the
 * exchange-adapter interface) to assemble the pre-registered corpus:
 *   20 Binance perps × 10 served timeframes × 3,000 klines, plus per-coin funding history.
 *
 * `getCandles(coin, interval, startTime)` hardcodes `limit: 200` and returns bars FORWARD from
 * startTime, so 3,000 bars is 15 sequential pages per series. Pages are walked forward from
 * `now − 3000·interval`; each page resumes at the last bar's close so no bar is dropped or
 * double-counted, and the result is de-duplicated and sorted by open time regardless.
 *
 * Read-only: fetches public market data, writes ONLY to a scratch dir outside the repo.
 * Nothing here touches a database, a threshold, or any production surface.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { BinanceAdapter } from '../lib/adapters/binance.js';
import { intervalMsFor } from '../lib/candle-guard.js';

const OUT = process.env.SGS_DATA ?? '/tmp/sgs-data';
/** Pre-registered: 10 served timeframes, ordered by live 30-day emission volume. `1m` excluded. */
export const TFS = ['5m', '3m', '15m', '30m', '2h', '1h', '4h', '8h', '12h', '1d'] as const;
/** 20 liquid Binance perps — the same venue the prior wave measured, for comparability. */
export const COINS = [
  'BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT',
  'MATIC', 'LTC', 'NEAR', 'ATOM', 'UNI', 'APT', 'ARB', 'OP', 'FIL', 'INJ',
] as const;
/** Pre-registered corpus depth. 15 pages × 200 (the adapter's hardcoded limit). */
const TARGET_BARS = 3000;
const PAGE = 200;
/** Concurrency held under Binance's 2,400 req/min so the fetch never trips a rate limit. */
const POOL = 6;

export interface Candle {
  time: number; open: number; high: number; low: number; close: number; volume: number;
}

async function pool<T>(items: T[], n: number, fn: (t: T, i: number) => Promise<void>): Promise<void> {
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = idx++;
        if (i >= items.length) return;
        await fn(items[i], i);
      }
    }),
  );
}

/** Walk `getCandles` forward until TARGET_BARS is reached or the venue stops returning new bars. */
async function fetchSeries(a: BinanceAdapter, coin: string, tf: string): Promise<Candle[]> {
  const iv = intervalMsFor(tf);
  if (!iv) throw new Error(`no interval for ${tf}`);
  const seen = new Map<number, Candle>();
  let cursor = Date.now() - TARGET_BARS * iv;
  for (let page = 0; page < Math.ceil(TARGET_BARS / PAGE) + 3; page++) {
    if (seen.size >= TARGET_BARS) break;
    const batch = (await a.getCandles(coin, tf, cursor)) as unknown as Candle[];
    if (!batch || batch.length === 0) break;
    let maxT = cursor;
    for (const c of batch) {
      if (Number.isFinite(c.time) && Number.isFinite(c.close)) seen.set(c.time, c);
      if (c.time > maxT) maxT = c.time;
    }
    // No forward progress ⇒ the venue has no more history; stop rather than spin.
    if (maxT <= cursor) break;
    cursor = maxT + iv;
  }
  return [...seen.values()].sort((x, y) => x.time - y.time);
}

async function main(): Promise<number> {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const a = new BinanceAdapter();

  const jobs: { coin: string; tf: string }[] = [];
  for (const coin of COINS) for (const tf of TFS) jobs.push({ coin, tf });

  const series: Record<string, Candle[]> = {};
  let done = 0, failed = 0;
  await pool(jobs, POOL, async (j) => {
    try {
      const s = await fetchSeries(a, j.coin, j.tf);
      if (s.length >= 200) series[`${j.coin}|${j.tf}`] = s;
      else failed++;
    } catch {
      failed++;
    }
    if (++done % 25 === 0) console.log(`  candles ${done}/${jobs.length} (failed ${failed})`);
  });

  // Funding is per-COIN, not per-timeframe: 20 calls, not 200.
  const funding: Record<string, { time: number; fundingRate: number }[]> = {};
  const fundFrom = Date.now() - 400 * 86_400_000;
  await pool([...COINS], POOL, async (coin) => {
    try {
      funding[coin] = await a.getFundingHistory(coin, fundFrom);
    } catch {
      funding[coin] = [];
    }
  });

  writeFileSync(`${OUT}/series.json`, JSON.stringify(series));
  writeFileSync(`${OUT}/funding.json`, JSON.stringify(funding));

  const spans: string[] = [];
  for (const tf of TFS) {
    const keys = Object.keys(series).filter((k) => k.endsWith(`|${tf}`));
    const lens = keys.map((k) => series[k].length);
    const anyKey = keys[0];
    const spanDays = anyKey
      ? (series[anyKey][series[anyKey].length - 1].time - series[anyKey][0].time) / 86_400_000
      : 0;
    spans.push(
      `  ${tf.padEnd(4)} series=${String(keys.length).padStart(3)} ` +
      `bars=${String(Math.min(...lens, Infinity)).padStart(5)}..${String(Math.max(...lens, 0)).padStart(5)} ` +
      `span=${spanDays.toFixed(1)}d`,
    );
  }
  console.log(`\nseries fetched : ${Object.keys(series).length}/${jobs.length} (failed ${failed})`);
  console.log(`funding coins  : ${Object.values(funding).filter((f) => f.length > 0).length}/${COINS.length}`);
  console.log(spans.join('\n'));
  console.log(`\nwrote ${OUT}/series.json + ${OUT}/funding.json`);
  return Object.keys(series).length > 0 ? 0 : 1;
}

// Guarded with the `process.argv[1]` idiom (one of the four `check-entrypoint-guards.mjs`
// accepts). Not `require.main === module`, which `script-exit-lifecycle-canary` would then
// require to terminate through `runScript()` — this opens no pool and returns its own code.
if (process.argv[1]?.endsWith('sell-gate-fetch.ts') || process.argv[1]?.endsWith('sell-gate-fetch.js')) {
  main().then((c) => process.exit(c));
}

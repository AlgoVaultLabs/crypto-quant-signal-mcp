// sr-probe/fetch-candles.ts — EDGE-SR-LEVEL-PROBE-W1: the probe's candle reads, on the operator's machine.
//
//   npx tsx src/scripts/sr-probe/fetch-candles.ts --extract <extract.csv> --store <dir> [--plan] [--min-step-ms N]
//
// There is no persisted candle store, so every bar comes from the venue adapters' own `getCandles` (the exchange-
// adapter interface, never a raw call), paged like the labeller's ranged fetch, tagged with this entrypoint's own
// caller name and paced below the venue budgets. One worker per venue, coarsest series first — the primary cells'
// layers land before the descriptive cells'. Resumable: a series already on disk with the same plan is skipped.
// Reads the label-free extract only; no label and no database.

import fs from 'node:fs';
import path from 'node:path';
import { getAdapter } from '../../lib/exchange-adapter.js';
import { runAsCaller } from '../../lib/upstream-weight-budget.js';
import { historyMetaOf } from '../../lib/adapters/_history-plan.js';
import type { ExchangeId } from '../../types.js';
import { applySampling, PAGE_CAP, planSeries, readCalls, seriesCost, type SeriesPlan } from './plan.js';
import { coversRanges, readSeries, seriesFile, WALK_VERSION, type StoredSeries } from './store.js';

/** Minimum ms between two pages on one venue — each well under that venue's registered budget. */
// BYBIT at 130 ms answered "10006 Too many visits" on 3 of ~580 series (measured 2026-11-10), so it is paced
// slower; a failed series is stored as failed and re-read by the next run.
const PACE_MS: Readonly<Record<string, number>> = Object.freeze({ BINANCE: 260, BYBIT: 200, OKX: 300, BITGET: 260 });
const MAX_PAGES_PER_RANGE = 2000;
const MAX_RATE_LIMIT_STRIKES = 3;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

class VenueAbort extends Error {}

async function fetchSeries(s: SeriesPlan, state: { last: number; strikes: number }): Promise<StoredSeries> {
  const adapter = getAdapter(s.exchange as ExchangeId);
  const bars = new Map<number, [number, number, number, number, number]>();
  const branches: Record<string, number> = {};
  const span = (PAGE_CAP[s.exchange] ?? 100) * s.stepMs;
  let pages = 0;
  for (const [startMs, endMs] of s.ranges) {
    // One ms BEFORE the first wanted open and, below, one ms AFTER the newest bar in hand: OKX and BITGET read
    // `startTime` as strictly-newer-than, so a cursor placed exactly on a bar's open loses that bar at every page
    // boundary (measured 2026-11-10 on BTC 1d: one 2-step hole per boundary). Inclusive venues only re-serve a bar
    // the map already holds.
    let cursor = startMs - 1;
    let rangePages = 0;
    while (cursor <= endMs && rangePages < MAX_PAGES_PER_RANGE) {
      const wait = state.last + (PACE_MS[s.exchange] ?? 500) - Date.now();
      if (wait > 0) await sleep(wait);
      state.last = Date.now();
      let page;
      try {
        page = await adapter.getCandles(s.coin, s.key, cursor, undefined, endMs);
        state.strikes = 0;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'UPSTREAM_RATE_LIMIT' || code === 'WEIGHT_BUDGET_SKIP') {
          state.strikes++;
          if (state.strikes >= MAX_RATE_LIMIT_STRIKES) throw new VenueAbort(`${s.exchange}: ${state.strikes} rate-limit refusals in a row — stopping this venue`);
          const retryAfter = (err as { retryAfterSeconds?: number | null }).retryAfterSeconds ?? 0;
          await sleep(Math.max(65, retryAfter + 5) * 1000);
          continue;
        }
        throw err;
      }
      pages++;
      rangePages++;
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
      // A window that holds no bar is NOT the end of the series. A listing younger than the window answers an empty
      // page (BITGET) or its newest page in place of the one asked for (OKX, `substitutedNewest`) — measured
      // 2026-11-10: stopping there left young listings with no L2 / L3 bars at all. Step one page span and ask
      // again; the range's own end bounds the walk. Bars a substituted page holds inside the range are real and kept.
      const windowEmpty = firstFresh === Infinity || meta?.substitutedNewest === true || firstFresh > cursor + span;
      cursor = windowEmpty ? cursor + span : maxTime + 1;
    }
  }
  return {
    exchange: s.exchange, coin: s.coin, key: s.key, stepMs: s.stepMs, ranges: s.ranges, status: 'ok', pages, branches,
    fetchedAt: new Date().toISOString(), bars: [...bars.values()].sort((a, b) => a[0] - b[0]), walk: WALK_VERSION,
  };
}

async function venueWorker(venue: string, plan: SeriesPlan[], store: string): Promise<{ venue: string; done: number; skipped: number; failed: number; pages: number; aborted: string | null }> {
  const state = { last: 0, strikes: 0 };
  const out = { venue, done: 0, skipped: 0, failed: 0, pages: 0, aborted: null as string | null };
  for (const s of plan) {
    const prior = readSeries(store, s);
    if (prior && prior.status === 'ok' && JSON.stringify(prior.ranges) === JSON.stringify(s.ranges) && (prior.walk === WALK_VERSION || coversRanges(prior))) {
      out.skipped++;
      continue;
    }
    let stored: StoredSeries;
    try {
      stored = await fetchSeries(s, state);
    } catch (err) {
      if (err instanceof VenueAbort) {
        out.aborted = err.message;
        break;
      }
      stored = {
        exchange: s.exchange, coin: s.coin, key: s.key, stepMs: s.stepMs, ranges: s.ranges, status: 'failed',
        error: String((err as Error).message ?? err).slice(0, 300), pages: 0, branches: {}, fetchedAt: new Date().toISOString(), bars: [],
      };
      out.failed++;
    }
    const f = seriesFile(store, s);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(stored));
    fs.renameSync(`${f}.tmp`, f);
    if (stored.status === 'ok') out.done++;
    out.pages += stored.pages;
    if ((out.done + out.failed) % 50 === 0) process.stderr.write(`[sr-fetch] ${venue}: ${out.done} ok, ${out.failed} failed, ${out.pages} pages\n`);
  }
  return out;
}

async function main(): Promise<void> {
  const extract = arg('--extract');
  const store = arg('--store');
  if (!extract || !store) {
    process.stderr.write('usage: fetch-candles.ts --extract <extract.csv> --store <dir> [--plan] [--min-step-ms N]\n');
    process.exitCode = 2;
    return;
  }
  const minStep = Number(arg('--min-step-ms') ?? 0);
  const { kept, venues } = applySampling(readCalls(extract));
  const plan = planSeries(kept).filter((s) => s.stepMs >= minStep);
  const byVenue = new Map<string, SeriesPlan[]>();
  for (const s of plan) byVenue.set(s.exchange, [...(byVenue.get(s.exchange) ?? []), s]);
  const summary = [...byVenue.entries()].map(([venue, ss]) => ({
    venue, series: ss.length, pages: ss.reduce((n, s) => n + seriesCost(s).pages, 0), requests: ss.reduce((n, s) => n + seriesCost(s).requests, 0),
  }));
  if (process.argv.includes('--plan')) {
    process.stdout.write(`${JSON.stringify({ calls: kept.length, sampling: venues, plan: summary }, null, 2)}\n`);
    return;
  }
  process.stderr.write(`[sr-fetch] ${JSON.stringify(summary)}\n`);
  const results = await runAsCaller('sr-level-probe', () => Promise.all([...byVenue.entries()].map(([venue, ss]) => venueWorker(venue, ss, store))));
  process.stdout.write(`${JSON.stringify({ finishedAt: new Date().toISOString(), results }, null, 2)}\n`);
  const incomplete = results.some((r) => r.aborted !== null);
  // exitCode, never process.exit(): a queued pipe write would lose the token.
  process.stdout.write(`SR_FETCH_VERDICT=${incomplete ? 'INDETERMINATE' : 'PASS'}\n`);
  process.exitCode = incomplete ? 3 : 0;
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[sr-fetch] ${String((err as Error).stack ?? err)}\n`);
    process.stdout.write('SR_FETCH_VERDICT=INDETERMINATE\n');
    process.exitCode = 3;
  });
}

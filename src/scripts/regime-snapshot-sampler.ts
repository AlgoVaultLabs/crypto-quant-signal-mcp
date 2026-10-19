/**
 * regime-snapshot-sampler.ts — SCAN-MARKET-REGIMES-W1-V2 CH1
 *
 * Hourly producer of the bar-close market-regime snapshot. For every sampled venue × {1h, 4h, 1d}
 * it writes, once per closed bar, one `regime_snapshots` row per coin of the venue's admitted
 * universe — the `get_market_regime` classifier's OWN answer for that bar, computed by the shared
 * pure core (src/lib/market-regime-core.ts) — and one `regime_snapshot_runs` row saying what it did.
 *
 * It NEVER calls `getMarketRegime()`: that charges quota and fires HL `getPredictedFundings()` on
 * every call. Funding stays out of the snapshot (it moves within a bar).
 *
 * ── Window truth comes from the venue's own record (V2 §0 Q1) ─────────────────────────────────
 *   1. ref_close: the reference symbol's (BTC) newest CLOSED bar from a short recent window.
 *   2. Due: the bar is due unless it already has a COMPLETE / WINDOW_STALE run, or a PARTIAL at
 *      coverage. A due bar left PARTIAL below coverage, SKIPPED_BUDGET or FAILED is retried on the
 *      next tick, writing only the coins still missing.
 *   3. Pair pre-check: the reference symbol's FULL core window (the exact get_market_regime call).
 *      If its newest closed bar ≠ ref_close the venue serves a stale window for this timeframe:
 *      record WINDOW_STALE and skip the sweep — 1 request, not a 494/842-coin sweep.
 *   4. Per-coin backstop: a row is written only when the coin's emitted window ends at ref_close;
 *      anything else is counted in window_stale_n and never written.
 * No wall-clock bar arithmetic anywhere, so 16:00Z-aligned 1D bars (OKX, Bitget) need no case.
 *
 * ── Weight lanes (V2 §0 Q3) ────────────────────────────────────────────────────────────────────
 * The WHOLE per-venue body — universe, candles, asset class — runs inside
 * `runAsBatch(…, 'regime_snapshot_sampler')`; nothing here acquires the interactive class. ONE
 * asset-class warm per run (the shared 17-detector warm, incl. one HL call) starts CONCURRENTLY with
 * the sweeps and is awaited only when rows are written, so no sweep waits behind HL's batch lane.
 * No HL candles, no HL funding. The weight ledger is cross-process in the app container's /tmp, so
 * this runs via `docker exec` in that container, like oi-snapshot-sampler.
 *
 * Run from the signal-1 host crontab (11 * * * *, flock-guarded):
 *   docker exec <ctr> node dist/scripts/regime-snapshot-sampler.js
 *   docker exec <ctr> node dist/scripts/regime-snapshot-sampler.js --check   # read-only, ZERO writes
 *
 * Exit codes come from main()'s RETURN value (runScript ignores process.exitCode):
 *   run:     REGIME_SAMPLER_RUN_VERDICT=PASS|FAIL|INDETERMINATE   → 0 / 1 / 3
 *   --check: REGIME_SAMPLER_CHECK_VERDICT=PASS|FAIL|INDETERMINATE → 0 / 1 / 3
 */

import type { ExchangeId } from '../types.js';
import { runScript } from '../lib/script-lifecycle.js';
import { getAdapter } from '../lib/exchange-adapter.js';
import { fetchVenueUniverse } from '../lib/exchange-universe.js';
import { resolveAssetClass, type ResolvedAssetClass } from '../lib/underlying-type.js';
import { warmAssetClasses } from '../lib/asset-class-detection.js';
import { classifyUnderlyingSession } from '../lib/market-sessions.js';
import { intervalMsFor } from '../lib/candle-guard.js';
import { splitCandleWindow } from '../lib/candle-window.js';
import { InsufficientCandlesError } from '../lib/errors.js';
import { runAsBatch, WeightBudgetSkipError } from '../lib/upstream-weight-budget.js';
import { weightForBinance } from '../lib/adapters/binance.js';
import {
  computeMarketRegimeCore,
  regimeFetchWindow,
  MARKET_REGIME_RULE_VERSION,
  type MarketRegimeCore,
} from '../lib/market-regime-core.js';
import {
  REGIME_SNAPSHOT_TIMEFRAMES,
  sampledRegimeVenues,
  latestRunForBar,
  readGenerationRows,
  recordRegimeSnapshots,
  recordRegimeSnapshotRun,
  latestServableGeneration,
  latestRunDisposition,
  recentDueRuns,
  lastTickAt,
  isServableRun,
  regimeSnapshotMinCoverage,
  type RegimeRunDisposition,
  type RegimeSnapshotRow,
  type RegimeSnapshotRunRecord,
  type ServableGeneration,
} from '../lib/regime-snapshots.js';
import type { Candle } from '../types.js';

/** The reference symbol whose recent window is each venue's own bar-close record. Listed on all 4. */
export const REGIME_REFERENCE_SYMBOL = 'BTC';
/** Bars in the short reference read. Binance returned only 2 bars at 3 intervals (R0), so 4. */
export const REGIME_REFERENCE_SHORT_BARS = 4;
export const DEFAULT_REGIME_SNAPSHOT_CONCURRENCY = 4;
/** The OKX batch lane sits at its 350/min cap with waits in ~40 of 60 minutes (R0) → 1 by default. */
export const DEFAULT_REGIME_SNAPSHOT_CONCURRENCY_OKX = 1;
const MAX_CONCURRENCY = 16;

/** Default-deny integer parse: an integer in [1, MAX_CONCURRENCY], else the default. */
function parseConcurrency(raw: string | undefined, dflt: number): number {
  if (raw === undefined || raw.trim() === '') return dflt;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= MAX_CONCURRENCY ? n : dflt;
}

/**
 * Per-venue sweep concurrency: `REGIME_SNAPSHOT_CONCURRENCY_<VENUE>` when valid, else the venue
 * default (OKX 1), else `REGIME_SNAPSHOT_CONCURRENCY` (default 4).
 */
export function samplerConcurrency(venue: string, env: NodeJS.ProcessEnv = process.env): number {
  const global = parseConcurrency(env.REGIME_SNAPSHOT_CONCURRENCY, DEFAULT_REGIME_SNAPSHOT_CONCURRENCY);
  const venueDefault = venue === 'OKX' ? DEFAULT_REGIME_SNAPSHOT_CONCURRENCY_OKX : global;
  return parseConcurrency(env[`REGIME_SNAPSHOT_CONCURRENCY_${venue}`], venueDefault);
}

/** Close (ms) of the newest CLOSED bar in a window, or null when none closed. Does not mutate. */
export function lastClosedBarClose(candles: Candle[], intervalMs: number, nowMs: number): number | null {
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const { closed } = splitCandleWindow(sorted, intervalMs, nowMs);
  return closed.length ? closed[closed.length - 1].time + intervalMs : null;
}

/** Everything the sampler touches outside itself — injectable so the suite runs offline. */
export interface RegimeSamplerDeps {
  getAdapter(id: ExchangeId): { getCandles(coin: string, interval: string, startTime: number): Promise<Candle[]> };
  fetchVenueUniverse(venue: ExchangeId): Promise<Array<{ coin: string }>>;
  warmAssetClasses(): Promise<void>;
  resolveAssetClass(coin: string, venue: ExchangeId): Promise<ResolvedAssetClass>;
  sampledRegimeVenues(nowMs: number): Promise<ExchangeId[]>;
  latestRunForBar(exchange: string, timeframe: string, barCloseMs: number): Promise<RegimeSnapshotRunRecord | null>;
  readGenerationRows(exchange: string, timeframe: string, barCloseMs: number): Promise<RegimeSnapshotRow[]>;
  recordRegimeSnapshots(rows: RegimeSnapshotRow[]): Promise<number>;
  recordRegimeSnapshotRun(run: RegimeSnapshotRunRecord): Promise<void>;
  /** --check's serving-state read: the SAME readers scan_market_regimes and the freshness canary use. */
  latestServableGeneration(exchange: string, timeframe: string): Promise<ServableGeneration | null>;
  latestRunDisposition(exchange: string, timeframe: string): Promise<RegimeSnapshotRunRecord | null>;
  recentDueRuns(exchange: string, timeframe: string, limit: number): Promise<RegimeSnapshotRunRecord[]>;
  lastTickAt(exchange: string, timeframe?: string): Promise<number | null>;
  now(): number;
}

export const DEFAULT_REGIME_SAMPLER_DEPS: RegimeSamplerDeps = {
  getAdapter: (id) => getAdapter(id),
  fetchVenueUniverse: (v) => fetchVenueUniverse(v),
  warmAssetClasses: () => warmAssetClasses(),
  resolveAssetClass: (c, v) => resolveAssetClass(c, v),
  sampledRegimeVenues: (nowMs) => sampledRegimeVenues(nowMs),
  latestRunForBar,
  readGenerationRows,
  recordRegimeSnapshots,
  recordRegimeSnapshotRun,
  latestServableGeneration: (ex, tf) => latestServableGeneration(ex, tf),
  latestRunDisposition,
  recentDueRuns,
  lastTickAt,
  now: () => Date.now(),
};

export interface PairResult {
  venue: string;
  timeframe: string;
  disposition: RegimeRunDisposition | 'CHECK';
  ref_close: string | null;
  due: boolean | null;
  precheck: 'OK' | 'WINDOW_STALE' | null;
  universe_n: number;
  written_n: number;
  too_new_n: number;
  window_stale_n: number;
  skipped_n: number;
  errors_n: number;
  /** --check only: one candle request per coin is the floor (OKX 1h needs a second page). */
  projected_requests?: number;
  /** --check only: what a consumer would serve for this pair right now, read from the run record. */
  served?: { bar_close: string; disposition: string; coverage: number } | null;
  latest_disposition?: RegimeRunDisposition | null;
  last_tick?: string | null;
  /** --check only: the newest due-tick dispositions, newest first. */
  recent_due?: RegimeRunDisposition[];
  projected_weight?: number;
  /** The run row could not be recorded (DB) — the tick did not happen as far as consumers can tell. */
  record_error?: string;
  /** Upstream refused or failed the reference read. */
  ref_error?: string;
  ms: number;
}

export interface SamplerRunResult {
  tick_at: number;
  check: boolean;
  venues: string[];
  pairs: PairResult[];
  verdict: 'PASS' | 'FAIL' | 'INDETERMINATE';
  reasons: string[];
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** Bounded worker pool. Every item runs; one item's failure never stops the rest. */
async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

interface PairCtx {
  venue: ExchangeId;
  timeframe: string;
  tickAt: number;
  check: boolean;
  env: NodeJS.ProcessEnv;
  deps: RegimeSamplerDeps;
  universe: () => Promise<string[]>;
  warm: Promise<void>;
}

/**
 * One pair. The returned promise settles when the pair's UPSTREAM work is done (reference read,
 * pre-check, sweep); `result` settles when its rows and run row are written. The split is what lets
 * the next timeframe's sweep start while this one's rows wait for the asset-class warm (§0 Q3).
 */
async function samplePair(ctx: PairCtx): Promise<{ result: Promise<PairResult> }> {
  const { venue, timeframe, tickAt, check, env, deps } = ctx;
  const started = deps.now();
  const intervalMs = intervalMsFor(timeframe);
  const adapter = deps.getAdapter(venue);
  const out: PairResult = {
    venue, timeframe, disposition: 'FAILED', ref_close: null, due: null, precheck: null,
    universe_n: 0, written_n: 0, too_new_n: 0, window_stale_n: 0, skipped_n: 0, errors_n: 0, ms: 0,
  };
  const done = (result: Promise<PairResult>) => ({ result });
  const finish = async (disposition: RegimeRunDisposition, barCloseMs: number | null): Promise<PairResult> => {
    out.disposition = check ? 'CHECK' : disposition;
    out.ms = deps.now() - started;
    if (!check) {
      try {
        await deps.recordRegimeSnapshotRun({
          exchange: venue, timeframe, bar_close_ms: barCloseMs, tick_at: tickAt, disposition,
          universe_n: out.universe_n, written_n: out.written_n, too_new_n: out.too_new_n,
          window_stale_n: out.window_stale_n, skipped_n: out.skipped_n, errors_n: out.errors_n,
          finished_at: deps.now(),
        });
      } catch (e) {
        out.record_error = e instanceof Error ? e.message : String(e);
      }
    }
    return out;
  };
  if (intervalMs === null) {
    out.ref_error = `unmapped timeframe ${timeframe}`;
    return done(finish('FAILED', null));
  }

  if (check) {
    // The serving state as every consumer derives it — read first, so it is reported even when the
    // venue itself is unreachable below.
    const [served, latest, lastTick, recent] = await Promise.all([
      deps.latestServableGeneration(venue, timeframe),
      deps.latestRunDisposition(venue, timeframe),
      deps.lastTickAt(venue, timeframe),
      deps.recentDueRuns(venue, timeframe, 3),
    ]);
    out.served = served
      ? { bar_close: iso(served.bar_close_ms) as string, disposition: served.disposition, coverage: Number(served.coverage.toFixed(4)) }
      : null;
    out.latest_disposition = latest?.disposition ?? null;
    out.last_tick = iso(lastTick);
    out.recent_due = recent.map((r) => r.disposition);
  }

  // ── 1. ref_close — the venue's own record of its newest closed bar ──
  let refClose: number | null;
  try {
    const now = deps.now();
    const short = await adapter.getCandles(REGIME_REFERENCE_SYMBOL, timeframe, now - REGIME_REFERENCE_SHORT_BARS * intervalMs);
    refClose = lastClosedBarClose(short, intervalMs, deps.now());
  } catch (e) {
    out.ref_error = e instanceof Error ? e.message.slice(0, 200) : String(e);
    return done(finish(e instanceof WeightBudgetSkipError ? 'SKIPPED_BUDGET' : 'FAILED', null));
  }
  if (refClose === null) {
    out.ref_error = 'reference window returned no closed bar';
    return done(finish('FAILED', null));
  }
  out.ref_close = iso(refClose);

  // ── 2. due? ──
  const prior = await deps.latestRunForBar(venue, timeframe, refClose);
  const due = !(prior && (prior.disposition === 'COMPLETE' || prior.disposition === 'WINDOW_STALE' ||
    isServableRun(prior, regimeSnapshotMinCoverage(env))));
  out.due = due;
  if (!due && !check) return done(finish('NOT_DUE', refClose));

  // ── 3. pair pre-check — the reference symbol's FULL core window ──
  let refCandles: Candle[];
  let refStartTime: number;
  try {
    refStartTime = regimeFetchWindow(timeframe, deps.now()).startTime;
    refCandles = await adapter.getCandles(REGIME_REFERENCE_SYMBOL, timeframe, refStartTime);
  } catch (e) {
    out.ref_error = e instanceof Error ? e.message.slice(0, 200) : String(e);
    return done(finish(e instanceof WeightBudgetSkipError ? 'SKIPPED_BUDGET' : 'FAILED', refClose));
  }
  const coreLastClose = lastClosedBarClose(refCandles, intervalMs, deps.now());
  out.precheck = coreLastClose === refClose ? 'OK' : 'WINDOW_STALE';

  if (check) {
    try {
      out.universe_n = (await ctx.universe()).length;
    } catch (e) {
      out.ref_error = `universe: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`;
    }
    const perRequest = venue === 'BINANCE' ? weightForBinance('/fapi/v1/klines', { limit: 200 }) : 1;
    out.projected_requests = out.precheck === 'OK' && due ? out.universe_n : 0;
    out.projected_weight = out.projected_requests * perRequest;
    return done(finish('NOT_DUE', refClose)); // disposition is reported as CHECK; nothing is recorded
  }
  if (out.precheck === 'WINDOW_STALE') return done(finish('WINDOW_STALE', refClose));

  // ── 4. sweep (only the coins this bar is still missing) ──
  let coins: string[];
  try {
    coins = await ctx.universe();
  } catch (e) {
    out.ref_error = `universe: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`;
    return done(finish(e instanceof WeightBudgetSkipError ? 'SKIPPED_BUDGET' : 'FAILED', refClose));
  }
  out.universe_n = coins.length;
  if (coins.length === 0) {
    out.ref_error = 'universe returned no coins';
    return done(finish('FAILED', refClose));
  }
  const universeSet = new Set(coins);
  const existing = new Set(
    (await deps.readGenerationRows(venue, timeframe, refClose)).map((r) => r.coin).filter((c) => universeSet.has(c)),
  );
  const previous = new Map(
    (await deps.readGenerationRows(venue, timeframe, refClose - intervalMs)).map((r) => [r.coin, r] as const),
  );
  const todo = coins.filter((c) => !existing.has(c));
  const computed: Array<{ coin: string; core: MarketRegimeCore; computedAt: number }> = [];

  await pool(todo, samplerConcurrency(venue, env), async (coin) => {
    try {
      let candles: Candle[];
      let startTime: number;
      if (coin === REGIME_REFERENCE_SYMBOL) {
        // The pre-check already fetched exactly this window — reuse it, one request saved.
        candles = refCandles;
        startTime = refStartTime;
      } else {
        startTime = regimeFetchWindow(timeframe, deps.now()).startTime;
        candles = await adapter.getCandles(coin, timeframe, startTime);
      }
      const core = computeMarketRegimeCore({
        coin, exchange: venue, timeframe, candles, intervalMs, startTime, nowMs: deps.now(), candleBasis: 'closed',
      });
      // Per-coin backstop: a row is the classifier's answer for ref_close's bar, or it is not written.
      if (core.lastEmittedBarCloseMs !== refClose) {
        out.window_stale_n++;
        return;
      }
      computed.push({ coin, core, computedAt: deps.now() });
    } catch (e) {
      if (e instanceof InsufficientCandlesError) out.too_new_n++;
      else if (e instanceof WeightBudgetSkipError) out.skipped_n++;
      else {
        out.errors_n++;
        if (env.REGIME_SAMPLER_DEBUG === '1') {
          console.error(`[regime-sampler] ${venue}/${timeframe}/${coin}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  });

  // ── 5. rows — the one place the concurrent asset-class warm is awaited. Backgrounded: the venue's
  //    next timeframe sweeps while these rows wait for the warm. ──
  return done((async () => {
    await ctx.warm;
    const rows: RegimeSnapshotRow[] = [];
    for (const { coin, core, computedAt } of computed) {
      let assetClass: ResolvedAssetClass;
      try {
        assetClass = await deps.resolveAssetClass(coin, venue);
      } catch {
        assetClass = 'UNKNOWN'; // resolveAssetClass never throws; defensive only
      }
      const session = assetClass === 'UNKNOWN'
        ? 'UNKNOWN'
        : classifyUnderlyingSession({ assetClass, at: new Date(computedAt) }).state;
      const prev = previous.get(coin);
      // regime_since carries within one rule version, resets on a transition, and is NULL until seen.
      const regimeSince = prev && prev.rule_version === MARKET_REGIME_RULE_VERSION
        ? (prev.regime === core.regime ? prev.regime_since_ms : refClose)
        : null;
      rows.push({
        exchange: venue,
        timeframe,
        bar_close_ms: refClose,
        coin,
        regime: core.regime,
        confidence: core.confidence,
        trend_strength: core.trendStrength,
        adx: core.metrics.adx,
        adx_slope: core.metrics.adx_slope,
        volatility_ratio: core.metrics.volatility_ratio,
        price_structure: core.metrics.price_structure,
        asset_class: assetClass,
        underlying_session_at_compute: session,
        regime_since_ms: regimeSince,
        rule_version: MARKET_REGIME_RULE_VERSION,
        computed_at: computedAt,
      });
    }
    let inserted = 0;
    try {
      inserted = await deps.recordRegimeSnapshots(rows);
    } catch (e) {
      out.errors_n += rows.length;
      out.ref_error = `insert: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`;
    }
    out.written_n = existing.size + inserted;

    const writable = out.universe_n - out.too_new_n;
    const disposition: RegimeRunDisposition =
      out.written_n >= writable && writable > 0 ? 'COMPLETE'
        : out.written_n >= 1 ? 'PARTIAL'
          : out.skipped_n > 0 ? 'SKIPPED_BUDGET'
            : 'FAILED';
    return finish(disposition, refClose);
  })());
}

/** One sampler tick across every sampled venue × timeframe. */
export async function runRegimeSnapshotSampler(
  opts: { check?: boolean; env?: NodeJS.ProcessEnv } = {},
  deps: RegimeSamplerDeps = DEFAULT_REGIME_SAMPLER_DEPS,
): Promise<SamplerRunResult> {
  const check = opts.check === true;
  const env = opts.env ?? process.env;
  const tickAt = deps.now();
  const reasons: string[] = [];
  let venues: ExchangeId[];
  try {
    venues = await deps.sampledRegimeVenues(tickAt);
  } catch (e) {
    return { tick_at: tickAt, check, venues: [], pairs: [], verdict: 'INDETERMINATE',
      reasons: [`venue list unreadable: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (venues.length === 0) {
    return { tick_at: tickAt, check, venues: [], pairs: [], verdict: 'FAIL',
      reasons: ['no sampled venue: REGIME_SNAPSHOT_VENUES ∩ active promoted venues is empty'] };
  }

  // ONE batch scope for the whole tick (V2 CH1 R3): the warm, every venue's universe, candles and asset
  // classes all run in the batch class under one caller name — nothing here can reach the interactive
  // reserve, and the run has exactly one class-setting site.
  const perVenue = await runAsBatch(async () => {
    // ONE asset-class warm per run, started NOW and awaited only at row-write (§0 Q3). --check writes
    // no rows, so it starts none (zero HL).
    const warm: Promise<void> = check
      ? Promise.resolve()
      : deps.warmAssetClasses().catch((e: unknown) => {
          console.warn(`[regime-sampler] asset-class warm failed (rows fall back per resolveAssetClass): ${e instanceof Error ? e.message : e}`);
        });
    const results = await Promise.all(venues.map(async (venue) => {
      let universeP: Promise<string[]> | null = null;
      const universe = () => (universeP ??= deps.fetchVenueUniverse(venue).then((assets) =>
        [...new Set(assets.map((a) => a.coin.toUpperCase()).filter(Boolean))]));
      // A DB read in the due test or a generation read failed: nothing about this pair is known.
      const unknown = (timeframe: string, e: unknown): PairResult => ({
        venue, timeframe, disposition: 'FAILED', ref_close: null, due: null, precheck: null,
        universe_n: 0, written_n: 0, too_new_n: 0, window_stale_n: 0, skipped_n: 0, errors_n: 1,
        record_error: e instanceof Error ? e.message.slice(0, 200) : String(e), ms: 0,
      });
      // Sweeps run one timeframe at a time (pacing); each pair's row-write runs behind it.
      const pending: Promise<PairResult>[] = [];
      for (const timeframe of REGIME_SNAPSHOT_TIMEFRAMES) {
        let result: Promise<PairResult>;
        try {
          ({ result } = await samplePair({ venue, timeframe, tickAt, check, env, deps, universe, warm }));
        } catch (e) {
          result = Promise.resolve(unknown(timeframe, e));
        }
        pending.push(result.catch((e: unknown) => unknown(timeframe, e)).then((r) => {
          console.log(`[regime-sampler] ${JSON.stringify(r)}`);
          return r;
        }));
      }
      return Promise.all(pending);
    }));
    await warm;
    return results;
  }, 'regime_snapshot_sampler');
  const pairs = perVenue.flat();

  let verdict: SamplerRunResult['verdict'] = 'PASS';
  const unrecorded = pairs.filter((p) => p.record_error);
  if (check) {
    const unreachable = pairs.filter((p) => p.ref_error || p.record_error);
    if (unreachable.length) {
      verdict = 'INDETERMINATE';
      reasons.push(...unreachable.map((p) => `${p.venue}/${p.timeframe}: ${p.ref_error ?? p.record_error}`));
    }
  } else if (unrecorded.length === pairs.length) {
    verdict = 'INDETERMINATE';
    reasons.push('no run row could be recorded — the store is unreachable');
  } else {
    const failed = pairs.filter((p) => p.disposition === 'FAILED' || p.record_error);
    if (failed.length) {
      verdict = 'FAIL';
      reasons.push(...failed.map((p) => `${p.venue}/${p.timeframe}: ${p.disposition}${p.ref_error ? ` (${p.ref_error})` : ''}${p.record_error ? ` [record: ${p.record_error}]` : ''}`));
    }
  }
  return { tick_at: tickAt, check, venues, pairs, verdict, reasons };
}

const EXIT: Record<SamplerRunResult['verdict'], number> = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

/** The CLI body. RETURNS the exit code — runScript takes it only from here. */
export async function main(
  argv: string[] = process.argv,
  deps: RegimeSamplerDeps = DEFAULT_REGIME_SAMPLER_DEPS,
): Promise<number> {
  const check = argv.includes('--check');
  const r = await runRegimeSnapshotSampler({ check }, deps);
  for (const reason of r.reasons) console.error(`[regime-sampler] ${reason}`);
  console.log(`${check ? 'REGIME_SAMPLER_CHECK_VERDICT' : 'REGIME_SAMPLER_RUN_VERDICT'}=${r.verdict}`);
  return EXIT[r.verdict];
}

// require.main guard (CJS, target ES2022) — cron invokes this directly.
if (require.main === module) {
  // 50 min: a hung tick is killed before the next :11 fire (the host flock is the second guard).
  void runScript('regime-snapshot-sampler', () => main(), { watchdogMs: 50 * 60_000 });
}

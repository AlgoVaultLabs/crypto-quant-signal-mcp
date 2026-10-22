/**
 * regime-snapshot-sampler.test.ts — SCAN-MARKET-REGIMES-W1-V2 CH1 (AC1.2)
 *
 * The producer, end to end, offline: fake venues behind the real sampler, an in-memory store with
 * the store's semantics, a controllable clock. Covers due detection (incl. the retry of a PARTIAL
 * below coverage), the pair pre-check (WINDOW_STALE with zero sweep requests, and the derived
 * self-heal), the per-coin backstop, regime_since carry / reset / NULL, every disposition, --check
 * zero writes, the exit codes, per-venue pacing, and the §0 Q3 spy: at most ONE HL call per run,
 * made by the asset-class warm, in the batch class — and the sweep never waits for it.
 *
 * CH3 (AC3.1): the --freshness verdict over a fake producer RECORD — every FAIL rule from both sides,
 * the seed / hand-over / resolve / regression arms of the known-unserved set, INDETERMINATE.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/lib/performance-db.js', () => ({ dbQuery: vi.fn().mockResolvedValue([]), dbExec: vi.fn() }));

import {
  runRegimeSnapshotSampler,
  main,
  samplerConcurrency,
  lastClosedBarClose,
  DEFAULT_REGIME_SAMPLER_DEPS,
  REGIME_REFERENCE_SHORT_BARS,
  judgeRegimeFreshness,
  parseKnownUnserved,
  DEFAULT_REGIME_FRESHNESS_DEPS,
  FAILING_FRESHNESS_STATES,
  type RegimeSamplerDeps,
  type RegimeFreshnessDeps,
} from '../../src/scripts/regime-snapshot-sampler.js';
import { computeMarketRegimeCore, regimeFetchWindow, MARKET_REGIME_RULE_VERSION } from '../../src/lib/market-regime-core.js';
import { isServableRun, type RegimeSnapshotRow, type RegimeSnapshotRunRecord } from '../../src/lib/regime-snapshots.js';
import { WeightBudgetSkipError, currentWeightClass, currentCaller } from '../../src/lib/upstream-weight-budget.js';
import { _clearAssetClassCache, _setDetectorsForTest } from '../../src/lib/asset-class-detection.js';
import { _clearUnderlyingTypeCache, _setUnderlyingTypeFetcherForTest } from '../../src/lib/underlying-type.js';
import { classifyUnderlyingSession } from '../../src/lib/market-sessions.js';
import { StaleUpstreamWindowError } from '../../src/lib/errors.js';
import { HEAD_STALE_BARS } from '../../src/lib/serving-windows.js';
import type { Candle, ExchangeId } from '../../src/types.js';

const H = 3_600_000;
const IV: Record<string, number> = { '1h': H, '4h': 4 * H, '1d': 24 * H };
const T0 = Date.UTC(2026, 9, 19, 9, 11, 0); // a :11 fire

// ── a deterministic synthetic market ───────────────────────────────────────────────────────────
const seedOf = (coin: string) => [...coin].reduce((a, c) => a + c.charCodeAt(0), 0) % 17;
function bar(coin: string, t: number, iv: number): Candle {
  const k = Math.floor(t / iv);
  const s = seedOf(coin);
  const px = (j: number) => 100 * (1 + 0.06 * Math.sin(j / (5 + (s % 4)) + s) + 0.0015 * s * (j % 40));
  const close = px(k);
  const open = px(k - 1);
  return { time: t, open, high: Math.max(open, close) * 1.012, low: Math.min(open, close) * 0.988, close, volume: 1000 + (k % 13) * 37 };
}

interface VenueWorld {
  coins: string[];
  /** Venue recent-page cap (OKX = 100): a window reaching further back is served from its OLDEST end. */
  pageCap?: number;
  /** 1D bar alignment offset (OKX/Bitget open 1D at 16:00Z). */
  dayOffsetMs?: number;
  /** `${tf}|${coin}` → the window ends this many bars early (a stale per-coin window). */
  staleBars?: Record<string, number>;
  tooNew?: string[];
  skip?: string[];
  error?: string[];
  /** The reference SHORT read throws this. */
  refError?: Error;
  /** The reference CORE read (the pair pre-check) throws this. */
  coreError?: Error;
  /** These coins' windows are refused as stale at the getAdapter seam (StaleUpstreamWindowError). */
  refused?: string[];
  universeError?: Error;
}

function synthWindow(v: VenueWorld, coin: string, tf: string, startTime: number, nowMs: number): Candle[] {
  const iv = IV[tf];
  const off = tf === '1d' ? (v.dayOffsetMs ?? 0) : 0;
  let first = Math.ceil((startTime - off) / iv) * iv + off; // openTime >= startTime
  let last = Math.floor((nowMs - off) / iv) * iv + off; // includes the in-progress bar
  last -= (v.staleBars?.[`${tf}|${coin}`] ?? 0) * iv;
  if (v.pageCap && (last - first) / iv + 1 > v.pageCap) last = first + (v.pageCap - 1) * iv; // oldest page
  if (v.tooNew?.includes(coin)) first = last - 9 * iv;
  const out: Candle[] = [];
  for (let t = first; t <= last; t += iv) out.push(bar(coin, t, iv));
  return out;
}

// ── an in-memory store with the real store's semantics ─────────────────────────────────────────
class MemStore {
  rows = new Map<string, RegimeSnapshotRow>();
  runs: RegimeSnapshotRunRecord[] = [];
  snapshotWrites = 0;
  runWrites = 0;
  failRuns = false;
  latestRunForBar = async (ex: string, tf: string, bar: number) =>
    this.runs.filter((r) => r.exchange === ex && r.timeframe === tf && r.bar_close_ms === bar && r.disposition !== 'NOT_DUE')
      .sort((a, b) => b.tick_at - a.tick_at)[0] ?? null;
  readGenerationRows = async (ex: string, tf: string, bar: number) =>
    [...this.rows.values()].filter((r) => r.exchange === ex && r.timeframe === tf && r.bar_close_ms === bar)
      .sort((a, b) => a.coin.localeCompare(b.coin));
  recordRegimeSnapshots = async (rows: RegimeSnapshotRow[]) => {
    this.snapshotWrites++;
    for (const r of rows) {
      const k = `${r.exchange}|${r.timeframe}|${r.bar_close_ms}|${r.coin}`;
      if (!this.rows.has(k)) this.rows.set(k, { ...r });
    }
    return rows.length;
  };
  recordRegimeSnapshotRun = async (r: RegimeSnapshotRunRecord) => {
    this.runWrites++;
    if (this.failRuns) throw new Error('connect ECONNREFUSED');
    this.runs.push({ ...r });
  };
  private due = (ex: string, tf: string) =>
    this.runs.filter((r) => r.exchange === ex && r.timeframe === tf && r.disposition !== 'NOT_DUE').sort((a, b) => b.tick_at - a.tick_at);
  latestRunDisposition = async (ex: string, tf: string) => this.due(ex, tf)[0] ?? null;
  recentDueRuns = async (ex: string, tf: string, n: number) => this.due(ex, tf).slice(0, n);
  lastTickAt = async (ex: string, tf?: string) => {
    const t = this.runs.filter((r) => r.exchange === ex && (!tf || r.timeframe === tf)).map((r) => r.tick_at);
    return t.length ? Math.max(...t) : null;
  };
  latestServableGeneration = async (ex: string, tf: string) => {
    const bars = [...new Set(this.runs.filter((r) => r.exchange === ex && r.timeframe === tf && r.bar_close_ms !== null).map((r) => r.bar_close_ms as number))].sort((a, b) => b - a);
    for (const b of bars) {
      const latest = this.runs.filter((r) => r.exchange === ex && r.timeframe === tf && r.bar_close_ms === b && (r.disposition === 'COMPLETE' || r.disposition === 'PARTIAL'))
        .sort((x, y) => y.tick_at - x.tick_at)[0];
      if (latest && isServableRun(latest, 0.9)) {
        const denom = latest.universe_n - latest.too_new_n;
        return { exchange: ex, timeframe: tf, bar_close_ms: b, disposition: latest.disposition as 'COMPLETE' | 'PARTIAL', universe_n: latest.universe_n,
          written_n: latest.written_n, too_new_n: latest.too_new_n, window_stale_n: latest.window_stale_n,
          coverage: denom > 0 ? Math.min(1, latest.written_n / denom) : 0, tick_at: latest.tick_at, finished_at: latest.finished_at };
      }
    }
    return null;
  };
  runsAt = (tick: number) => this.runs.filter((r) => r.tick_at === tick);
  run = (tick: number, ex: string, tf: string) => this.runs.find((r) => r.tick_at === tick && r.exchange === ex && r.timeframe === tf);
  gen = (ex: string, tf: string, bar: number) =>
    [...this.rows.values()].filter((r) => r.exchange === ex && r.timeframe === tf && r.bar_close_ms === bar);
}

interface Req { venue: string; coin: string; tf: string; startTime: number; cls: string; caller: string }

function harness(world: Record<string, VenueWorld>, opts: { realAssetClass?: boolean } = {}) {
  const store = new MemStore();
  const clock = { now: T0 };
  const reqs: Req[] = [];
  const adapterIds: string[] = [];
  const lanes: Array<{ what: string; cls: string; caller: string }> = [];
  let inflight: Record<string, number> = {};
  const maxInflight: Record<string, number> = {};
  let warmCalls = 0;
  const deps: RegimeSamplerDeps = {
    getAdapter: (id: ExchangeId) => {
      adapterIds.push(id);
      return {
        getCandles: async (coin: string, tf: string, startTime: number) => {
          const v = world[id];
          reqs.push({ venue: id, coin, tf, startTime, cls: currentWeightClass(), caller: currentCaller() });
          inflight[id] = (inflight[id] ?? 0) + 1;
          maxInflight[id] = Math.max(maxInflight[id] ?? 0, inflight[id]);
          try {
            await new Promise((r) => setImmediate(r));
            const short = startTime >= clock.now - REGIME_REFERENCE_SHORT_BARS * IV[tf] - 1;
            if (short && coin === 'BTC' && v.refError) throw v.refError;
            if (!short && coin === 'BTC' && v.coreError) throw v.coreError;
            if (v.refused?.includes(coin)) throw staleRefusal(coin, id, tf);
            if (v.skip?.includes(coin)) throw new WeightBudgetSkipError(id, 2);
            if (v.error?.includes(coin)) throw new Error(`upstream 500 for ${coin}`);
            return synthWindow(v, coin, tf, startTime, clock.now);
          } finally {
            inflight[id]--;
          }
        },
      };
    },
    fetchVenueUniverse: async (venue: ExchangeId) => {
      lanes.push({ what: `universe:${venue}`, cls: currentWeightClass(), caller: currentCaller() });
      if (world[venue].universeError) throw world[venue].universeError;
      return world[venue].coins.map((coin) => ({ coin }));
    },
    warmAssetClasses: opts.realAssetClass ? DEFAULT_REGIME_SAMPLER_DEPS.warmAssetClasses : async () => { warmCalls++; },
    resolveAssetClass: opts.realAssetClass
      ? DEFAULT_REGIME_SAMPLER_DEPS.resolveAssetClass
      : async (coin: string) => (coin === 'TSLA' ? 'EQUITY' : 'CRYPTO'),
    sampledRegimeVenues: async () => Object.keys(world) as ExchangeId[],
    latestRunForBar: store.latestRunForBar,
    readGenerationRows: store.readGenerationRows,
    recordRegimeSnapshots: store.recordRegimeSnapshots,
    recordRegimeSnapshotRun: store.recordRegimeSnapshotRun,
    latestServableGeneration: store.latestServableGeneration,
    latestRunDisposition: store.latestRunDisposition,
    recentDueRuns: store.recentDueRuns,
    lastTickAt: store.lastTickAt,
    now: () => clock.now,
  };
  return { store, clock, reqs, adapterIds, lanes, maxInflight, deps, warmCalls: () => warmCalls, resetInflight: () => { inflight = {}; } };
}

/** What the getAdapter seam throws for a window ending 30 bars before T0 (src/lib/exchange-adapter.ts guardServingReads). */
function staleRefusal(coin: string, venue: string, tf: string): StaleUpstreamWindowError {
  return new StaleUpstreamWindowError({ coin, exchange: venue, timeframe: tf, newestBarAt: T0 - 30 * IV[tf], headGapBars: 29, headStaleBars: HEAD_STALE_BARS[tf] });
}

/** ref_close the venue's own record yields at `now` (the synthetic venue is fresh on the short path). */
const refClose = (tf: string, now: number, off = 0) => Math.floor((now - off) / IV[tf]) * IV[tf] + off;

const ENV = {} as NodeJS.ProcessEnv;
let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  _clearAssetClassCache();
  _clearUnderlyingTypeCache();
});

describe('due detection + the first generation', () => {
  it('a first tick writes every pair COMPLETE, each row the core answer for ref_close', async () => {
    const h = harness({ BINANCE: { coins: ['BTC', 'ETH', 'SOL', 'TSLA'] } });
    const r = await runRegimeSnapshotSampler({ env: ENV }, h.deps);
    expect(r.verdict).toBe('PASS');
    for (const tf of ['1h', '4h', '1d']) {
      const run = h.store.run(T0, 'BINANCE', tf)!;
      expect(run, tf).toMatchObject({ disposition: 'COMPLETE', bar_close_ms: refClose(tf, T0), universe_n: 4, written_n: 4, too_new_n: 0, window_stale_n: 0 });
      const gen = h.store.gen('BINANCE', tf, refClose(tf, T0));
      expect(gen.map((x) => x.coin).sort()).toEqual(['BTC', 'ETH', 'SOL', 'TSLA']);
      for (const row of gen) {
        // Single derivation: the stored row IS the core's answer on the same window.
        const w = regimeFetchWindow(tf, T0);
        const core = computeMarketRegimeCore({
          coin: row.coin, exchange: 'BINANCE', timeframe: tf, candles: synthWindow({ coins: [] }, row.coin, tf, w.startTime, T0),
          intervalMs: w.intervalMs, startTime: w.startTime, nowMs: T0, candleBasis: 'closed',
        });
        expect(row).toMatchObject({
          regime: core.regime, confidence: core.confidence, trend_strength: core.trendStrength, adx: core.metrics.adx,
          adx_slope: core.metrics.adx_slope, volatility_ratio: core.metrics.volatility_ratio, price_structure: core.metrics.price_structure,
          regime_since_ms: null, rule_version: MARKET_REGIME_RULE_VERSION, computed_at: T0,
        });
      }
    }
    const tsla = h.store.gen('BINANCE', '1h', refClose('1h', T0)).find((x) => x.coin === 'TSLA')!;
    expect(tsla.asset_class).toBe('EQUITY');
    expect(tsla.underlying_session_at_compute).toBe(classifyUnderlyingSession({ assetClass: 'EQUITY', at: new Date(T0) }).state);
  });

  it('the same bar on the next tick is NOT_DUE and costs only the short reference read', async () => {
    const h = harness({ BINANCE: { coins: ['BTC', 'ETH', 'SOL'] } });
    await runRegimeSnapshotSampler({ env: ENV }, h.deps);
    h.reqs.length = 0;
    h.clock.now = T0 + 20 * 60_000;
    await runRegimeSnapshotSampler({ env: ENV }, h.deps);
    expect(h.store.runsAt(h.clock.now).map((x) => x.disposition)).toEqual(['NOT_DUE', 'NOT_DUE', 'NOT_DUE']);
    expect(h.reqs).toHaveLength(3);
    for (const q of h.reqs) {
      expect(q.coin).toBe('BTC');
      expect(q.startTime).toBe(h.clock.now - REGIME_REFERENCE_SHORT_BARS * IV[q.tf]);
    }
  });

  it('a PARTIAL below coverage is retried next tick, fetching ONLY the missing coins', async () => {
    const world: Record<string, VenueWorld> = { BINANCE: { coins: ['BTC', 'ETH', 'SOL', 'XRP'], error: ['ETH', 'SOL'] } };
    const h = harness(world);
    await runRegimeSnapshotSampler({ env: ENV }, h.deps);
    const bar1h = refClose('1h', T0);
    const first = h.store.run(T0, 'BINANCE', '1h')!;
    expect(first).toMatchObject({ disposition: 'PARTIAL', written_n: 2, errors_n: 2 });
    expect(isServableRun(first, 0.9)).toBe(false);

    world.BINANCE.error = [];
    h.reqs.length = 0;
    h.clock.now = T0 + 15 * 60_000; // same hour, same bar
    await runRegimeSnapshotSampler({ env: ENV }, h.deps);
    const retried = h.store.run(h.clock.now, 'BINANCE', '1h')!;
    expect(retried).toMatchObject({ disposition: 'COMPLETE', bar_close_ms: bar1h, written_n: 4, universe_n: 4 });
    const swept1h = h.reqs.filter((q) => q.tf === '1h' && q.startTime < h.clock.now - REGIME_REFERENCE_SHORT_BARS * H).map((q) => q.coin);
    expect(swept1h.sort()).toEqual(['BTC', 'ETH', 'SOL']); // BTC = the pre-check, then only the 2 missing coins
    expect(h.store.gen('BINANCE', '1h', bar1h)).toHaveLength(4);
  });

  it('a PARTIAL at coverage is servable and is NOT retried', async () => {
    const coins = ['BTC', ...Array.from({ length: 19 }, (_, i) => `C${i}`)];
    const world: Record<string, VenueWorld> = { BINANCE: { coins, error: ['C3'] } };
    const h = harness(world);
    await runRegimeSnapshotSampler({ env: ENV }, h.deps);
    const run = h.store.run(T0, 'BINANCE', '1h')!;
    expect(run).toMatchObject({ disposition: 'PARTIAL', written_n: 19, universe_n: 20 });
    expect(isServableRun(run, 0.9)).toBe(true);
    world.BINANCE.error = [];
    h.clock.now = T0 + 30 * 60_000;
    await runRegimeSnapshotSampler({ env: ENV }, h.deps);
    expect(h.store.run(h.clock.now, 'BINANCE', '1h')!.disposition).toBe('NOT_DUE');
  });
});

describe('window truth — the pair pre-check and the per-coin backstop', () => {
  it('a venue serving a stale FULL window is WINDOW_STALE with zero sweep requests', async () => {
    // A venue whose recent page caps at 100 serves the 168-bar 1h window from its OLDEST end — OKX until
    // OPS-SERVED-CANDLE-TRUTH-W1 CH1. The sampler's own pre-check catches it here; the getAdapter seam now also refuses it
    // (the Q3b cases below).
    const h = harness({ OKX: { coins: ['BTC', 'ETH', 'SOL'], pageCap: 100 } });
    await runRegimeSnapshotSampler({ env: ENV }, h.deps);
    const run = h.store.run(T0, 'OKX', '1h')!;
    expect(run).toMatchObject({ disposition: 'WINDOW_STALE', bar_close_ms: refClose('1h', T0), universe_n: 0, written_n: 0 });
    const okx1h = h.reqs.filter((q) => q.venue === 'OKX' && q.tf === '1h');
    expect(okx1h.map((q) => q.coin)).toEqual(['BTC', 'BTC']); // the short read + the pre-check, nothing else
    expect(h.store.gen('OKX', '1h', refClose('1h', T0))).toHaveLength(0);
    // 4h (42 bars) and 1d (100 bars) fit the page: served normally.
    expect(h.store.run(T0, 'OKX', '4h')!.disposition).toBe('COMPLETE');
    expect(h.store.run(T0, 'OKX', '1d')!.disposition).toBe('COMPLETE');
  });

  it('WINDOW_STALE is not retried within its bar, recurs on the next bar, and self-heals when the venue does', async () => {
    const world: Record<string, VenueWorld> = { OKX: { coins: ['BTC', 'ETH'], pageCap: 100 } };
    const h = harness(world);
    await runRegimeSnapshotSampler({ env: ENV }, h.deps);
    h.clock.now = T0 + 25 * 60_000;
    await runRegimeSnapshotSampler({ env: ENV }, h.deps);
    expect(h.store.run(h.clock.now, 'OKX', '1h')!.disposition).toBe('NOT_DUE');
    h.clock.now = T0 + H;
    await runRegimeSnapshotSampler({ env: ENV }, h.deps);
    expect(h.store.run(h.clock.now, 'OKX', '1h')!.disposition).toBe('WINDOW_STALE');
    // The adapter owner ships: nothing here is edited, the record alone changes.
    delete world.OKX.pageCap;
    h.clock.now = T0 + 2 * H;
    await runRegimeSnapshotSampler({ env: ENV }, h.deps);
    expect(h.store.run(h.clock.now, 'OKX', '1h')).toMatchObject({ disposition: 'COMPLETE', written_n: 2 });
  });

  it('per-coin backstop: a coin whose emitted window does not end at ref_close is counted, never written', async () => {
    const h = harness({ BINANCE: { coins: ['BTC', 'ETH', 'SOL', 'XRP'], staleBars: { '1h|ETH': 2 } } });
    await runRegimeSnapshotSampler({ env: ENV }, h.deps);
    expect(h.store.run(T0, 'BINANCE', '1h')).toMatchObject({ disposition: 'PARTIAL', written_n: 3, window_stale_n: 1, universe_n: 4 });
    expect(h.store.gen('BINANCE', '1h', refClose('1h', T0)).map((x) => x.coin).sort()).toEqual(['BTC', 'SOL', 'XRP']);
    expect(h.store.run(T0, 'BINANCE', '4h')!.disposition).toBe('COMPLETE');
  });

  // OPS-SERVED-CANDLE-TRUTH-W1 Q3b: the getAdapter seam now refuses a stale serving window (StaleUpstreamWindowError) before
  // the sampler sees it. Each of the three reads maps the refusal onto the fact the sampler already records, never FAILED.
  it('Q3b: a refused SHORT reference read is WINDOW_STALE with no bar, never FAILED or SKIPPED_BUDGET', async () => {
    const h = harness({ BINANCE: { coins: ['BTC', 'ETH'], refError: staleRefusal('BTC', 'BINANCE', '1h') } });
    const r = await runRegimeSnapshotSampler({ env: ENV }, h.deps);
    expect(h.store.run(T0, 'BINANCE', '1h')).toMatchObject({ disposition: 'WINDOW_STALE', bar_close_ms: null, written_n: 0, errors_n: 0 });
    expect(h.reqs.filter((q) => q.tf === '1h').map((q) => q.coin)).toEqual(['BTC']); // the refused read, nothing after it
    const pair = r.pairs.find((p) => p.timeframe === '1h')!;
    expect(pair).toMatchObject({ precheck: 'WINDOW_STALE' });
    expect(pair.ref_error).toBeUndefined();
    expect(pair.stale_window).toContain('refused as stale');
    expect(r.verdict).toBe('PASS');
    // Two-way: any other error on the same read is still FAILED.
    const h2 = harness({ BINANCE: { coins: ['BTC'], refError: new Error('ETIMEDOUT') } });
    expect((await runRegimeSnapshotSampler({ env: ENV }, h2.deps)).verdict).toBe('FAIL');
    expect(h2.store.run(T0, 'BINANCE', '1h')!.disposition).toBe('FAILED');
  });

  it('Q3b: a refused pre-check (core) read is the pre-check\'s own WINDOW_STALE at ref_close, with zero sweep requests', async () => {
    const h = harness({ BINANCE: { coins: ['BTC', 'ETH', 'SOL'], coreError: staleRefusal('BTC', 'BINANCE', '1h') } });
    const r = await runRegimeSnapshotSampler({ env: ENV }, h.deps);
    expect(h.store.run(T0, 'BINANCE', '1h')).toMatchObject({ disposition: 'WINDOW_STALE', bar_close_ms: refClose('1h', T0), universe_n: 0, written_n: 0 });
    expect(h.reqs.filter((q) => q.tf === '1h').map((q) => q.coin)).toEqual(['BTC', 'BTC']); // the short read + the refused pre-check
    expect(h.store.gen('BINANCE', '1h', refClose('1h', T0))).toHaveLength(0);
    expect(r.pairs.find((p) => p.timeframe === '1h')).toMatchObject({ precheck: 'WINDOW_STALE' });
    expect(r.verdict).toBe('PASS');
    // --check: a reachable venue serving a stale window is reported, never INDETERMINATE (exit 3 means "could not reach").
    const c = harness({ BINANCE: { coins: ['BTC', 'ETH'], coreError: staleRefusal('BTC', 'BINANCE', '1h') } });
    const before = logSpy.mock.calls.length;
    expect(await main(['node', 'x', '--check'], c.deps)).toBe(0);
    const lines = logSpy.mock.calls.slice(before).map((x) => String(x[0]));
    const pairs = lines.filter((l) => l.startsWith('[regime-sampler] {')).map((l) => JSON.parse(l.slice('[regime-sampler] '.length)));
    expect(pairs.find((p) => p.timeframe === '1h')).toMatchObject({ disposition: 'CHECK', precheck: 'WINDOW_STALE', projected_requests: 0 });
    // Two-way: any other error on the same read is still FAILED at ref_close.
    const h2 = harness({ BINANCE: { coins: ['BTC'], coreError: new Error('ETIMEDOUT') } });
    await runRegimeSnapshotSampler({ env: ENV }, h2.deps);
    expect(h2.store.run(T0, 'BINANCE', '1h')).toMatchObject({ disposition: 'FAILED', bar_close_ms: refClose('1h', T0) });
  });

  it('Q3b: a coin refused at the seam is counted window_stale_n, never written and never an error', async () => {
    const h = harness({ BINANCE: { coins: ['BTC', 'ETH', 'SOL', 'XRP'], refused: ['ETH'] } });
    const r = await runRegimeSnapshotSampler({ env: ENV }, h.deps);
    expect(h.store.run(T0, 'BINANCE', '1h')).toMatchObject({ disposition: 'PARTIAL', written_n: 3, window_stale_n: 1, errors_n: 0, universe_n: 4 });
    expect(h.store.gen('BINANCE', '1h', refClose('1h', T0)).map((x) => x.coin).sort()).toEqual(['BTC', 'SOL', 'XRP']);
    expect(r.verdict).toBe('PASS');
    // Two-way: an ordinary upstream error on the same coin is errors_n, not window_stale_n.
    const h2 = harness({ BINANCE: { coins: ['BTC', 'ETH', 'SOL', 'XRP'], error: ['ETH'] } });
    await runRegimeSnapshotSampler({ env: ENV }, h2.deps);
    expect(h2.store.run(T0, 'BINANCE', '1h')).toMatchObject({ written_n: 3, window_stale_n: 0, errors_n: 1 });
  });

  it('16:00Z-aligned 1D bars are sampled at their OWN close — no wall-clock bar arithmetic', async () => {
    const off = 16 * H;
    const h = harness({ BITGET: { coins: ['BTC', 'ETH'], dayOffsetMs: off } });
    await runRegimeSnapshotSampler({ env: ENV }, h.deps);
    const run = h.store.run(T0, 'BITGET', '1d')!;
    expect(run).toMatchObject({ disposition: 'COMPLETE', bar_close_ms: Date.UTC(2026, 9, 18, 16) });
    expect(run.bar_close_ms).toBe(refClose('1d', T0, off));
  });
});

describe('regime_since — carry, reset, NULL', () => {
  it('carries within one rule version, resets on a transition, stays NULL until one is observed', async () => {
    const coins = ['BTC', 'ETH', 'SOL', 'TSLA'];
    const h = harness({ BINANCE: { coins } });
    const T1 = T0 + H;
    const bar0 = refClose('1h', T0);
    const bar1 = refClose('1h', T1);
    // Generation bar0, seeded relative to what the core will say at bar1.
    const w = regimeFetchWindow('1h', T1);
    const at1 = (coin: string) => computeMarketRegimeCore({
      coin, exchange: 'BINANCE', timeframe: '1h', candles: synthWindow({ coins: [] }, coin, '1h', w.startTime, T1),
      intervalMs: H, startTime: w.startTime, nowMs: T1, candleBasis: 'closed',
    }).regime;
    const other = (r: string) => (r === 'RANGING' ? 'TRENDING_UP' : 'RANGING');
    const seed = (coin: string, regime: string, since: number | null, ruleVersion = MARKET_REGIME_RULE_VERSION): RegimeSnapshotRow => ({
      exchange: 'BINANCE', timeframe: '1h', bar_close_ms: bar0, coin, regime, confidence: 50, trend_strength: 'WEAK', adx: 20,
      adx_slope: 0, volatility_ratio: 0.01, price_structure: 'MIXED', asset_class: 'CRYPTO', underlying_session_at_compute: 'ALWAYS_OPEN',
      regime_since_ms: since, rule_version: ruleVersion, computed_at: T0,
    });
    await h.store.recordRegimeSnapshots([
      seed('BTC', at1('BTC'), null),                       // same regime, unknown age → stays unknown
      seed('ETH', at1('ETH'), bar0 - 5 * H),               // same regime → carries
      seed('SOL', other(at1('SOL')), bar0 - 9 * H),        // transition → this bar
      seed('TSLA', at1('TSLA'), bar0 - 2 * H, 0),          // other rule version → not comparable → NULL
    ]);
    h.clock.now = T1;
    await runRegimeSnapshotSampler({ env: ENV }, h.deps);
    const since = Object.fromEntries(h.store.gen('BINANCE', '1h', bar1).map((r) => [r.coin, r.regime_since_ms]));
    expect(since).toEqual({ BTC: null, ETH: bar0 - 5 * H, SOL: bar1, TSLA: null });
  });

  it('a coin absent from the previous generation starts NULL', async () => {
    const h = harness({ BINANCE: { coins: ['BTC', 'NEWCOIN'] } });
    await runRegimeSnapshotSampler({ env: ENV }, h.deps);
    expect(h.store.gen('BINANCE', '1h', refClose('1h', T0)).every((r) => r.regime_since_ms === null)).toBe(true);
  });
});

describe('every disposition', () => {
  const tf = '1h';
  it('COMPLETE excludes too-new listings from the denominator', async () => {
    const h = harness({ BINANCE: { coins: ['BTC', 'ETH', 'BABY'], tooNew: ['BABY'] } });
    await runRegimeSnapshotSampler({ env: ENV }, h.deps);
    expect(h.store.run(T0, 'BINANCE', tf)).toMatchObject({ disposition: 'COMPLETE', written_n: 2, too_new_n: 1, universe_n: 3 });
  });

  it('SKIPPED_BUDGET when nothing was written and the lane skipped', async () => {
    const h = harness({ BINANCE: { coins: ['ETH', 'SOL'], skip: ['ETH', 'SOL'] } });
    await runRegimeSnapshotSampler({ env: ENV }, h.deps);
    expect(h.store.run(T0, 'BINANCE', tf)).toMatchObject({ disposition: 'SKIPPED_BUDGET', written_n: 0, skipped_n: 2 });
  });

  it('FAILED when nothing was written and nothing skipped', async () => {
    const h = harness({ BINANCE: { coins: ['ETH', 'SOL'], error: ['ETH', 'SOL'] } });
    const r = await runRegimeSnapshotSampler({ env: ENV }, h.deps);
    expect(h.store.run(T0, 'BINANCE', tf)).toMatchObject({ disposition: 'FAILED', errors_n: 2 });
    expect(r.verdict).toBe('FAIL');
  });

  it('a budget skip on the reference read is SKIPPED_BUDGET with no bar; an error is FAILED with no bar', async () => {
    const h1 = harness({ BINANCE: { coins: ['BTC'], refError: new WeightBudgetSkipError('Binance', 2) } });
    await runRegimeSnapshotSampler({ env: ENV }, h1.deps);
    expect(h1.store.run(T0, 'BINANCE', tf)).toMatchObject({ disposition: 'SKIPPED_BUDGET', bar_close_ms: null });
    const h2 = harness({ BINANCE: { coins: ['BTC'], refError: new Error('ETIMEDOUT') } });
    await runRegimeSnapshotSampler({ env: ENV }, h2.deps);
    expect(h2.store.run(T0, 'BINANCE', tf)).toMatchObject({ disposition: 'FAILED', bar_close_ms: null });
  });

  it('an empty or unreadable universe is FAILED, never COMPLETE over nothing', async () => {
    const h1 = harness({ BINANCE: { coins: [] } });
    await runRegimeSnapshotSampler({ env: ENV }, h1.deps);
    expect(h1.store.run(T0, 'BINANCE', tf)).toMatchObject({ disposition: 'FAILED', universe_n: 0 });
    const h2 = harness({ BINANCE: { coins: ['BTC'], universeError: new Error('ticker 503') } });
    await runRegimeSnapshotSampler({ env: ENV }, h2.deps);
    expect(h2.store.run(T0, 'BINANCE', tf)!.disposition).toBe('FAILED');
  });

  it('NOT_DUE is recorded every tick — it is the producer liveness the canary reads', async () => {
    const h = harness({ BINANCE: { coins: ['BTC'] } });
    await runRegimeSnapshotSampler({ env: ENV }, h.deps);
    h.clock.now = T0 + 40 * 60_000;
    await runRegimeSnapshotSampler({ env: ENV }, h.deps);
    expect(h.store.runsAt(h.clock.now)).toHaveLength(3);
  });
});

describe('--check is read-only', () => {
  it('ZERO writes, zero warm; reports due, ref_close, pre-check, universe and projected weight per pair', async () => {
    const h = harness({ BINANCE: { coins: ['BTC', 'ETH', 'SOL'] }, OKX: { coins: ['BTC', 'ETH'], pageCap: 100 } });
    const code = await main(['node', 'x', '--check'], h.deps);
    expect(code).toBe(0);
    expect(h.store.snapshotWrites).toBe(0);
    expect(h.store.runWrites).toBe(0);
    expect(h.warmCalls()).toBe(0);
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain('REGIME_SAMPLER_CHECK_VERDICT=PASS');
    const pairs = lines.filter((l) => l.startsWith('[regime-sampler] {')).map((l) => JSON.parse(l.slice('[regime-sampler] '.length)));
    expect(pairs).toHaveLength(6);
    const b1h = pairs.find((p) => p.venue === 'BINANCE' && p.timeframe === '1h');
    expect(b1h).toMatchObject({ disposition: 'CHECK', due: true, precheck: 'OK', universe_n: 3, projected_requests: 3, projected_weight: 6,
      ref_close: new Date(refClose('1h', T0)).toISOString() });
    expect(pairs.find((p) => p.venue === 'OKX' && p.timeframe === '1h')).toMatchObject({ precheck: 'WINDOW_STALE', projected_requests: 0 });
  });

  it('reports the serving state every consumer derives — served bar, latest disposition, last tick, recent due runs', async () => {
    const h = harness({ BINANCE: { coins: ['BTC', 'ETH'] }, OKX: { coins: ['BTC', 'ETH'], pageCap: 100 } });
    await runRegimeSnapshotSampler({ env: ENV }, h.deps);
    const writes = [h.store.snapshotWrites, h.store.runWrites];
    logSpy.mockClear();
    h.clock.now = T0 + 10 * 60_000;
    expect(await main(['node', 'x', '--check'], h.deps)).toBe(0);
    expect([h.store.snapshotWrites, h.store.runWrites]).toEqual(writes); // still zero writes
    const pairs = logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[regime-sampler] {'))
      .map((l) => JSON.parse(l.slice('[regime-sampler] '.length)));
    expect(pairs.find((p) => p.venue === 'BINANCE' && p.timeframe === '1h')).toMatchObject({
      due: false, served: { bar_close: new Date(refClose('1h', T0)).toISOString(), disposition: 'COMPLETE', coverage: 1 },
      latest_disposition: 'COMPLETE', last_tick: new Date(T0).toISOString(), recent_due: ['COMPLETE'],
    });
    expect(pairs.find((p) => p.venue === 'OKX' && p.timeframe === '1h')).toMatchObject({
      served: null, latest_disposition: 'WINDOW_STALE', recent_due: ['WINDOW_STALE'],
    });
  });

  it('an unreachable venue makes the check INDETERMINATE (exit 3), never PASS', async () => {
    const h = harness({ BINANCE: { coins: ['BTC'], refError: new Error('ECONNRESET') } });
    expect(await main(['node', 'x', '--check'], h.deps)).toBe(3);
    expect(logSpy.mock.calls.map((c) => String(c[0]))).toContain('REGIME_SAMPLER_CHECK_VERDICT=INDETERMINATE');
  });
});

describe('exit codes come from main()\'s return', () => {
  it('PASS → 0', async () => {
    const h = harness({ BINANCE: { coins: ['BTC', 'ETH'] } });
    expect(await main(['node', 'x'], h.deps)).toBe(0);
    expect(logSpy.mock.calls.map((c) => String(c[0]))).toContain('REGIME_SAMPLER_RUN_VERDICT=PASS');
  });
  it('a FAILED pair → 1', async () => {
    const h = harness({ BINANCE: { coins: ['ETH'], error: ['ETH'] } });
    expect(await main(['node', 'x'], h.deps)).toBe(1);
  });
  it('an unreachable store → 3 (no run row recorded anywhere)', async () => {
    const h = harness({ BINANCE: { coins: ['BTC'] } });
    h.store.failRuns = true;
    expect(await main(['node', 'x'], h.deps)).toBe(3);
    expect(logSpy.mock.calls.map((c) => String(c[0]))).toContain('REGIME_SAMPLER_RUN_VERDICT=INDETERMINATE');
  });
  it('no sampled venue → FAIL (an empty constructed corpus is never a pass)', async () => {
    const h = harness({});
    expect(await main(['node', 'x'], h.deps)).toBe(1);
  });
});

describe('V2 §0 Q3 spy — one HL call per run, made by the warm, batch class only; the sweep never waits for it', () => {
  it('≤1 HL call (the asset-class warm), zero HL adapter use, zero interactive acquisitions, warm concurrent with the sweep', async () => {
    _clearAssetClassCache();
    _clearUnderlyingTypeCache();
    const h = harness({ BINANCE: { coins: ['BTC', 'ETH', 'SOL', 'TSLA'] }, BYBIT: { coins: ['BTC', 'ETH', 'XAU'] } }, { realAssetClass: true });
    const hl: Array<{ cls: string; caller: string }> = [];
    let releaseWarm!: () => void;
    const warmGate = new Promise<void>((r) => { releaseWarm = r; });
    _setDetectorsForTest({
      HL: async () => {
        hl.push({ cls: currentWeightClass(), caller: currentCaller() });
        await warmGate; // the warm is SLOW (R0: a 31 s HL batch wait) — the sweep must not be behind it
        return new Map([['XAU', 'COMMODITY'], ['TSLA', 'EQUITY']]);
      },
    });
    const exchangeInfo: Array<{ cls: string; caller: string }> = [];
    _setUnderlyingTypeFetcherForTest(async () => {
      exchangeInfo.push({ cls: currentWeightClass(), caller: currentCaller() });
      return new Map([['BTCUSDT', { contractType: 'PERPETUAL', underlyingType: 'COIN' }], ['ETHUSDT', { contractType: 'PERPETUAL', underlyingType: 'COIN' }],
        ['SOLUSDT', { contractType: 'PERPETUAL', underlyingType: 'COIN' }], ['TSLAUSDT', { contractType: 'TRADIFI_PERPETUAL', underlyingType: 'EQUITY' }]]);
    });
    // Release the warm only once EVERY sweep of EVERY timeframe has run without it: BINANCE 3 coins × 3 tf
    // + BYBIT 2 × 3 = 15 non-reference candle requests. Were any sweep queued behind the warm, this deadlocks.
    const watcher = (async () => {
      while (h.reqs.filter((q) => q.coin !== 'BTC').length < 15) await new Promise((r) => setImmediate(r));
      releaseWarm();
    })();
    const res = await Promise.race([
      runRegimeSnapshotSampler({ env: ENV }, h.deps),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('sweep serialized behind the warm (deadlock)')), 4000)),
    ]);
    await watcher;
    expect(res.verdict).toBe('PASS');

    expect(hl).toHaveLength(1);
    expect(hl[0]).toEqual({ cls: 'batch', caller: 'regime_snapshot_sampler' });
    expect(h.adapterIds).not.toContain('HL'); // no HL candles, no HL funding
    const everything = [...h.reqs, ...h.lanes, ...exchangeInfo];
    expect(everything.length).toBeGreaterThan(10);
    for (const x of everything) expect(x, JSON.stringify(x)).toMatchObject({ cls: 'batch', caller: 'regime_snapshot_sampler' });

    // The warm's classes reached the rows (asset_class identical to get_market_regime's resolver).
    const bybitXau = h.store.gen('BYBIT', '1h', refClose('1h', T0)).find((r) => r.coin === 'XAU')!;
    expect(bybitXau.asset_class).toBe('COMMODITY');
    const binTsla = h.store.gen('BINANCE', '1h', refClose('1h', T0)).find((r) => r.coin === 'TSLA')!;
    expect(binTsla.asset_class).toBe('EQUITY');
  });
});

describe('pacing', () => {
  it('OKX sweeps at concurrency 1 by default; others parallelise up to REGIME_SNAPSHOT_CONCURRENCY', async () => {
    const coins = ['BTC', ...Array.from({ length: 12 }, (_, i) => `C${i}`)];
    const h = harness({ BINANCE: { coins }, OKX: { coins } });
    await runRegimeSnapshotSampler({ env: ENV }, h.deps);
    expect(h.maxInflight.OKX).toBe(1);
    expect(h.maxInflight.BINANCE).toBeGreaterThan(1);
    expect(h.maxInflight.BINANCE).toBeLessThanOrEqual(4);
  });

  it('concurrency env is default-deny, per venue', () => {
    expect(samplerConcurrency('BINANCE', {})).toBe(4);
    expect(samplerConcurrency('OKX', {})).toBe(1);
    expect(samplerConcurrency('BINANCE', { REGIME_SNAPSHOT_CONCURRENCY: '8' })).toBe(8);
    expect(samplerConcurrency('OKX', { REGIME_SNAPSHOT_CONCURRENCY: '8' })).toBe(1);
    expect(samplerConcurrency('OKX', { REGIME_SNAPSHOT_CONCURRENCY_OKX: '2' })).toBe(2);
    expect(samplerConcurrency('BITGET', { REGIME_SNAPSHOT_CONCURRENCY_BITGET: '2' })).toBe(2);
    for (const bad of ['0', '-1', '1.5', '17', 'x', '']) {
      expect(samplerConcurrency('BINANCE', { REGIME_SNAPSHOT_CONCURRENCY: bad }), bad).toBe(4);
      expect(samplerConcurrency('OKX', { REGIME_SNAPSHOT_CONCURRENCY_OKX: bad }), bad).toBe(1);
    }
  });
});

describe('lastClosedBarClose', () => {
  it('is the close of the newest closed bar, null when none closed, and never mutates its input', () => {
    const cs = [bar('BTC', 2 * H, H), bar('BTC', 0, H), bar('BTC', H, H)];
    const copy = JSON.stringify(cs);
    expect(lastClosedBarClose(cs, H, 2 * H + 30 * 60_000)).toBe(2 * H);
    expect(JSON.stringify(cs)).toBe(copy);
    expect(lastClosedBarClose([bar('BTC', 2 * H, H)], H, 2 * H + 60_000)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CH3 — the freshness verdict (AC3.1). A fake producer RECORD per pair: the newest due dispositions,
// the newest servable generation and the last tick. Every rule is driven from both sides.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('CH3 --freshness — the verdict judges only the producer\'s record', () => {
  const NOW = Date.UTC(2026, 9, 19, 10, 44, 0);          // a :44 canary fire
  const TICK = Date.UTC(2026, 9, 19, 10, 11, 0);          // the producer's :11 tick
  const VENUES = ['BINANCE', 'OKX'] as ExchangeId[];
  /** Fresh generation per tf as of TICK: the bar that closed at the top of the tick's hour / 4h / day. */
  const FRESH_BAR: Record<string, number> = {
    '1h': Date.UTC(2026, 9, 19, 10), '4h': Date.UTC(2026, 9, 19, 8), '1d': Date.UTC(2026, 9, 19, 0),
  };
  interface PairRec { due: RegimeSnapshotRunRecord['disposition'][]; gen: number | null; tick: number | null }
  const run = (venue: string, tf: string, d: RegimeSnapshotRunRecord['disposition'], i: number): RegimeSnapshotRunRecord => ({
    exchange: venue, timeframe: tf, bar_close_ms: FRESH_BAR[tf] - i * IV[tf], tick_at: TICK - i * H, disposition: d,
    universe_n: 10, written_n: 10, too_new_n: 0, window_stale_n: 0, skipped_n: 0, errors_n: 0, finished_at: TICK - i * H + 60_000,
  });
  function world(over: Record<string, Partial<PairRec>> = {}, opts: { venueTick?: Record<string, number | null>; throwOn?: string; tables?: boolean; venues?: ExchangeId[] } = {}) {
    const rec = (venue: string, tf: string): PairRec => ({
      due: ['COMPLETE', 'COMPLETE'], gen: FRESH_BAR[tf], tick: TICK, ...(over[`${venue}|${tf}`] ?? {}),
    });
    // OKX|1h is WINDOW_STALE in the baseline world — the live state the canary seeds from.
    if (!over['OKX|1h']) over['OKX|1h'] = { due: ['WINDOW_STALE', 'WINDOW_STALE'], gen: null };
    const maybeThrow = (what: string) => { if (opts.throwOn === what) throw new Error(`${what} unreachable`); };
    const deps: RegimeFreshnessDeps = {
      now: () => NOW,
      adoptTables: async () => { maybeThrow('adopt'); return opts.tables ?? true; },
      sampledRegimeVenues: async () => opts.venues ?? VENUES,
      latestRunDisposition: async (v, tf) => { maybeThrow('latest'); const d = rec(v, tf).due; return d.length ? run(v, tf, d[0], 0) : null; },
      recentDueRuns: async (v, tf, n) => rec(v, tf).due.slice(0, n).map((d, i) => run(v, tf, d, i)),
      latestServableGeneration: async (v, tf) => {
        const g = rec(v, tf).gen;
        return g === null ? null : { exchange: v, timeframe: tf, bar_close_ms: g, disposition: 'COMPLETE', universe_n: 10, written_n: 10, too_new_n: 0, window_stale_n: 0, coverage: 1, tick_at: TICK, finished_at: TICK + 60_000 };
      },
      lastTickAt: async (v, tf) => {
        if (tf === undefined) return opts.venueTick && v in opts.venueTick ? opts.venueTick[v] : TICK;
        return rec(v, tf).tick;
      },
    };
    return deps;
  }
  const state = (r: Awaited<ReturnType<typeof judgeRegimeFreshness>>, key: string) =>
    r.pairs.find((p) => `${p.venue}|${p.tf}` === key)?.state;

  it('SEED (state unset): today\'s WINDOW_STALE pair is seeded UNSERVED and never fails; the rest FRESH → PASS', async () => {
    const r = await judgeRegimeFreshness(undefined, world(), ENV);
    expect(r.mode).toBe('SEED');
    expect(r.verdict).toBe('PASS');
    expect(state(r, 'OKX|1h')).toBe('UNSERVED');
    expect(r.unserved).toEqual(['OKX|1h']);
    expect(r.known_unserved_next).toEqual(['OKX|1h']);
    expect(r.pairs).toHaveLength(6);                                       // one positive line per (venue, tf)
    expect(r.pairs.filter((p) => p.state === 'FRESH')).toHaveLength(5);
    expect(r.venues.map((v) => v.state)).toEqual(['LIVE', 'LIVE']);
  });

  it('JUDGE: a seeded pair stays UNSERVED every run; PASS', async () => {
    const r = await judgeRegimeFreshness('OKX|1h', world(), ENV);
    expect(r.mode).toBe('JUDGE');
    expect(r.verdict).toBe('PASS');
    expect(state(r, 'OKX|1h')).toBe('UNSERVED');
    expect(r.known_unserved_next).toEqual(['OKX|1h']);
  });

  it('a seeded pair turning servable is RESOLVED — reported, never failed — and leaves the set', async () => {
    const r = await judgeRegimeFreshness('OKX|1h', world({ 'OKX|1h': { due: ['COMPLETE', 'WINDOW_STALE'], gen: FRESH_BAR['1h'] } }), ENV);
    expect(r.verdict).toBe('PASS');
    expect(state(r, 'OKX|1h')).toBe('RESOLVED');
    expect(r.resolved).toEqual(['OKX|1h']);
    expect(r.known_unserved_next).toEqual([]);
  });

  it('the REGRESSION arm: a pair outside the set WINDOW_STALE for 2 due ticks → FAIL NEWLY_WINDOW_STALE', async () => {
    const r = await judgeRegimeFreshness('OKX|1h', world({ 'BINANCE|4h': { due: ['WINDOW_STALE', 'WINDOW_STALE'], gen: FRESH_BAR['4h'] - IV['4h'] } }), ENV);
    expect(r.verdict).toBe('FAIL');
    expect(state(r, 'BINANCE|4h')).toBe('NEWLY_WINDOW_STALE');
    expect(r.fail_keys).toEqual(['BINANCE|4h:NEWLY_WINDOW_STALE']);
    expect(r.known_unserved_next).toEqual(['OKX|1h']);                     // a regression is never adopted silently
  });

  it('…and after RESOLVED, a relapse of the once-seeded pair is a regression too', async () => {
    const r = await judgeRegimeFreshness('', world({ 'OKX|1h': { due: ['WINDOW_STALE', 'WINDOW_STALE'], gen: null } }), ENV);
    expect(r.verdict).toBe('FAIL');
    expect(state(r, 'OKX|1h')).toBe('NEWLY_WINDOW_STALE');
  });

  it('the 2-run sustain: ONE WINDOW_STALE due tick is WINDOW_STALE_PENDING — PASS, not a page', async () => {
    const r = await judgeRegimeFreshness('OKX|1h', world({ 'BINANCE|4h': { due: ['WINDOW_STALE', 'COMPLETE'], gen: FRESH_BAR['4h'] - IV['4h'] } }), ENV);
    expect(r.verdict).toBe('PASS');
    expect(state(r, 'BINANCE|4h')).toBe('WINDOW_STALE_PENDING');
  });

  it('(a) a venue with no tick in 2 h → FAIL PRODUCER_DEAD; a tick inside 2 h is LIVE', async () => {
    const dead = await judgeRegimeFreshness('OKX|1h', world({}, { venueTick: { BINANCE: NOW - 2 * H - 60_000 } }), ENV);
    expect(dead.verdict).toBe('FAIL');
    expect(dead.fail_keys).toContain('BINANCE|*:PRODUCER_DEAD');
    expect(dead.venues.find((v) => v.venue === 'BINANCE')?.state).toBe('PRODUCER_DEAD');
    const never = await judgeRegimeFreshness('OKX|1h', world({}, { venueTick: { OKX: null } }), ENV);
    expect(never.fail_keys).toContain('OKX|*:PRODUCER_DEAD');
    const live = await judgeRegimeFreshness('OKX|1h', world({}, { venueTick: { BINANCE: NOW - 2 * H + 60_000 } }), ENV);
    expect(live.verdict).toBe('PASS');
  });

  it('(b) a served pair older than factor × interval as of ITS last tick → FAIL STALE_GENERATION; at the bound it is FRESH', async () => {
    const over = await judgeRegimeFreshness('OKX|1h', world({ 'BINANCE|1h': { gen: TICK - 2 * H - 60_000 } }), ENV);
    expect(over.verdict).toBe('FAIL');
    expect(state(over, 'BINANCE|1h')).toBe('STALE_GENERATION');
    const at = await judgeRegimeFreshness('OKX|1h', world({ 'BINANCE|1h': { gen: TICK - 2 * H } }), ENV);
    expect(state(at, 'BINANCE|1h')).toBe('FRESH');
    // The bound is REGIME_SNAPSHOT_STALE_FACTOR × interval — the same knob the tool refuses on.
    const wide = await judgeRegimeFreshness('OKX|1h', world({ 'BINANCE|1h': { gen: TICK - 2 * H - 60_000 } }), { REGIME_SNAPSHOT_STALE_FACTOR: '3' });
    expect(state(wide, 'BINANCE|1h')).toBe('FRESH');
    // Measured against the producer's own tick, not the canary's clock: a fresh-as-of-tick pair is FRESH at any canary minute.
    expect(at.pairs.find((p) => p.venue === 'BINANCE' && p.tf === '1h')).toMatchObject({ age_min: 120, bound_min: 120 });
  });

  it('(b) a served pair with no servable generation at all → FAIL NO_SERVABLE_GENERATION', async () => {
    const r = await judgeRegimeFreshness('OKX|1h', world({ 'BINANCE|1d': { due: ['PARTIAL', 'PARTIAL'], gen: null } }), ENV);
    expect(r.verdict).toBe('FAIL');
    expect(state(r, 'BINANCE|1d')).toBe('NO_SERVABLE_GENERATION');
  });

  it('(c) 2 consecutive FAILED / SKIPPED_BUDGET due ticks → FAIL; one is not enough', async () => {
    const two = await judgeRegimeFreshness('OKX|1h', world({ 'BINANCE|1h': { due: ['FAILED', 'SKIPPED_BUDGET'] } }), ENV);
    expect(two.verdict).toBe('FAIL');
    expect(state(two, 'BINANCE|1h')).toBe('CONSECUTIVE_FAILED_TICKS');
    const one = await judgeRegimeFreshness('OKX|1h', world({ 'BINANCE|1h': { due: ['FAILED', 'COMPLETE'] } }), ENV);
    expect(state(one, 'BINANCE|1h')).toBe('FRESH');
  });

  it('a sampled pair the producer never recorded → FAIL NO_RUNS; absent tables → FAIL; no sampled venue → FAIL', async () => {
    const noRuns = await judgeRegimeFreshness('OKX|1h', world({ 'BINANCE|4h': { due: [] } }), ENV);
    expect(state(noRuns, 'BINANCE|4h')).toBe('NO_RUNS');
    expect(noRuns.verdict).toBe('FAIL');
    const absent = await judgeRegimeFreshness('OKX|1h', world({}, { tables: false }), ENV);
    expect(absent.verdict).toBe('FAIL');
    expect(absent.fail_keys).toEqual(['*|*:TABLES_ABSENT']);
    const empty = await judgeRegimeFreshness('OKX|1h', world({}, { venues: [] }), ENV);
    expect(empty.verdict).toBe('FAIL');
  });

  it('INDETERMINATE: an unreachable store, or a known set it was handed and cannot parse — and the set never shrinks on a blind run', async () => {
    const down = await judgeRegimeFreshness('OKX|1h,BITGET|1d', world({}, { throwOn: 'latest' }), ENV);
    expect(down.verdict).toBe('INDETERMINATE');
    expect(down.known_unserved_next).toEqual(['BITGET|1d', 'OKX|1h']);
    const adopt = await judgeRegimeFreshness('OKX|1h', world({}, { throwOn: 'adopt' }), ENV);
    expect(adopt.verdict).toBe('INDETERMINATE');
    const garbage = await judgeRegimeFreshness('OKX|1h,not a key', world(), ENV);
    expect(garbage.verdict).toBe('INDETERMINATE');
    expect(garbage.pairs).toHaveLength(0);
  });

  it('parseKnownUnserved: unset is SEED (null), empty is the EMPTY set — never the same thing', () => {
    expect(parseKnownUnserved(undefined)).toBeNull();
    expect(parseKnownUnserved('')).toEqual(new Set());
    expect(parseKnownUnserved(' OKX|1h , BITGET|1d ')).toEqual(new Set(['OKX|1h', 'BITGET|1d']));
    expect(() => parseKnownUnserved('OKX|15m')).toThrow();
    expect(() => parseKnownUnserved('okx|1h')).toThrow();
  });

  it('main --freshness: one positive line per venue and pair, the set, the token; RETURNS 0 / 1 / 3', async () => {
    const env = { ...ENV, REGIME_FRESHNESS_KNOWN_UNSERVED: 'OKX|1h' };
    expect(await main(['node', 'x', '--freshness'], DEFAULT_REGIME_SAMPLER_DEPS, world(), env)).toBe(0);
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.startsWith('[regime-freshness] PAIR '))).toHaveLength(6);
    expect(lines.filter((l) => l.startsWith('[regime-freshness] VENUE '))).toHaveLength(2);
    expect(lines).toContain('[regime-freshness] MODE=JUDGE');
    expect(lines).toContain('REGIME_FRESHNESS_KNOWN_UNSERVED_NEXT=OKX|1h');
    expect(lines).toContain('REGIME_FRESHNESS_UNSERVED=OKX|1h');
    expect(lines[lines.length - 1]).toBe('REGIME_SNAPSHOT_FRESHNESS_VERDICT=PASS');
    logSpy.mockClear();
    expect(await main(['node', 'x', '--freshness'], DEFAULT_REGIME_SAMPLER_DEPS, world({ 'BINANCE|1h': { due: ['FAILED', 'FAILED'] } }), env)).toBe(1);
    expect(logSpy.mock.calls.map((c) => String(c[0]))).toContain('REGIME_FRESHNESS_FAIL_KEYS=BINANCE|1h:CONSECUTIVE_FAILED_TICKS');
    logSpy.mockClear();
    expect(await main(['node', 'x', '--freshness'], DEFAULT_REGIME_SAMPLER_DEPS, world({}, { throwOn: 'latest' }), env)).toBe(3);
    expect(logSpy.mock.calls.map((c) => String(c[0]))).toContain('REGIME_SNAPSHOT_FRESHNESS_VERDICT=INDETERMINATE');
    // SEED is "variable unset", so main reads it from the env it is given, never a default.
    logSpy.mockClear();
    expect(await main(['node', 'x', '--freshness'], DEFAULT_REGIME_SAMPLER_DEPS, world(), { ...ENV })).toBe(0);
    expect(logSpy.mock.calls.map((c) => String(c[0]))).toContain('[regime-freshness] MODE=SEED');
  });

  it('the default deps are the store\'s own readers — the SAME ones scan_market_regimes serves from', () => {
    expect(DEFAULT_REGIME_FRESHNESS_DEPS.latestRunDisposition).toBe(DEFAULT_REGIME_SAMPLER_DEPS.latestRunDisposition);
    expect(DEFAULT_REGIME_FRESHNESS_DEPS.recentDueRuns).toBe(DEFAULT_REGIME_SAMPLER_DEPS.recentDueRuns);
    expect(DEFAULT_REGIME_FRESHNESS_DEPS.lastTickAt).toBe(DEFAULT_REGIME_SAMPLER_DEPS.lastTickAt);
    expect(FAILING_FRESHNESS_STATES.has('UNSERVED')).toBe(false);
    expect(FAILING_FRESHNESS_STATES.has('RESOLVED')).toBe(false);
    expect(FAILING_FRESHNESS_STATES.has('WINDOW_STALE_PENDING')).toBe(false);
  });
});

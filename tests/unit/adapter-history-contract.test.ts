/**
 * adapter-history-contract.test.ts — OPS-ADAPTER-HISTORY-ANCHOR-W1 CH1. The adapter history contract, RED-first.
 *
 * Every captured (venue, tf) pair is replayed through the SHIPPED adapter (tests/harness/adapter-history-model.ts
 * serves the venue's own captured bodies to the adapter's own requests; the network is stubbed). The measurement
 * uses ONE classification (`measure`), shared with the fixture tooling:
 *   EDIT class (OAH-Q1): C1 step fidelity, disposition `fix`. C3 adapter-side substitution of the newest page,
 *     disposition `report` via meta. The measured set must EQUAL tests/fixtures/adapter-history/BASELINE.json.
 *     CH1 pins today's violators as evidence while CI stays green. CH2 empties the file.
 *   REPORT class: front gap, C2 head gap, C4 holes, out-of-range bars, reach limits. They are measured for
 *     every pair and must EQUAL REACH.json. A venue that changes its reach reddens this test, and the JSON is
 *     updated consciously, never absorbed.
 *   UNSERVABLE (OAH-Q9): pairs the served lookup calls native but the venue will not serve, declared with a reason in
 *     UNSERVABLE.json and SKIPPED here. Emptied in OPS-SERVED-CANDLE-TRUTH-W1 CH2: its two pairs (OKX/8h, BYBIT/8h)
 *     left their adapters' maps. Any dead pair fails the test.
 *   SERVED-MAP TRUTH (OPS-SERVED-CANDLE-TRUTH-W1 CH2): every timeframe an adapter's map holds has captured evidence
 *     that the venue serves it — REACH.json for the cron timeframes, an S scenario for 1m — and the map the source
 *     declares is the map the runtime lookup reads. A pair a venue will not serve leaves the map.
 *   NO SILENT FALLBACK (OPS-SERVED-CANDLE-TRUTH-W1 CH2): no adapter falls back from an interval lookup
 *     (tests/harness/interval-fallback-scan.ts). The gate is proven on a planted `|| '1h'`.
 *   S (OPS-SERVED-CANDLE-TRUTH-W1 CH1): every serving window the product asks for (src/lib/serving-windows.ts
 *     SERVING_WINDOWS) on every faithful (venue, tf), read with no endTime. The 13 replay venues replay SERVING.json;
 *     BITGET and OKX run on the synthetic venue. Each window must reach the venue's newest bar (head gap within
 *     HEAD_ALLOWANCE_BARS) and pass the getAdapter seam's guard. The window set is re-derived from the registry, so a
 *     window change reddens S until every venue is recaptured for it.
 *   CH3a-R2 (Cowork Q14 A): on a TRADE_GATED_KLINE_VENUES venue (HL, KUCOIN) a short head is judged from the venue's
 *     recent trades. The measured KuCoin and HL trade-head reads replay to 0 FAIL; a synthetic head with a 20 s old
 *     trade in a later slot FAILs; trades that cannot be read are INDETERMINATE; every other venue's verdict does not
 *     depend on trades at all.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ReplayVenue, SYNTHETIC_VENUES, measure,
  type Bar, type Control, type Measurement, type RunResult, type Scenario, type Unservable, type VenueFixture,
} from '../harness/adapter-history-model.js';
import { SyntheticVenue, listingFromProbes } from '../harness/adapter-history-synthetic.js';
import { historyMetaOf, accountPage, HEAD_ALLOWANCE_BARS } from '../../src/lib/adapters/_history-plan.js';
import { SERVING_MAX_PAGES } from '../../src/lib/serving-windows.js';
import { servingWindowVerdict } from '../../src/lib/exchange-adapter.js';
import {
  BOUNDARY_LAG_MS, CLOSED_ONLY_BOUNDARY_LAG_MS, CLOSED_ONLY_KLINE_VENUES, SNAPSHOT_KLINE_MAX_LAG_MS, TICKER_PRICED_VENUES, TRADE_GATED_KLINE_VENUES,
  formingHeadVerdict, headLag, isHeadIndeterminate, isTickerPricedVenue, livePriceOf, LIVE_TICKER_MAX_AGE_MS,
  type HeadReference, type HeadTrades, type HeadVerdict,
} from '../../src/lib/live-price.js';
import { TIMEFRAMES } from '../../src/lib/capabilities.js';
import { servingSpans } from '../harness/serving-spans.js';
import { scanIntervalSource } from '../harness/interval-fallback-scan.js';

const { replay, hlMarketListing } = vi.hoisted(() => ({
  replay: { venue: null as null | { answer(url: string, body?: string | null): unknown }, coin: null as null | string },
  /** OPS-CANDLE-REQUEST-OWNER-DERIVATION-W1: HL's market listing is its own request class (pinned by
   *  tests/unit/hl-market-resolution.test.ts) and is never part of a captured scenario — the capture tool drops it.
   *  It is answered here with the scenario's coin as a STANDARD market, so the captured candle requests replay
   *  unchanged and a mis-routed request (`xyz:BTC`) is a REPLAY_MISS. undefined = not a listing read. */
  hlMarketListing(req: { url: string; body?: string }, coin: string | null): unknown {
    if (!req.url.includes('api.hyperliquid.xyz')) return undefined;
    let body: { type?: unknown; dex?: unknown };
    try { body = JSON.parse(req.body ?? '{}') as { type?: unknown; dex?: unknown }; } catch { return undefined; }
    if (body.type !== 'metaAndAssetCtxs') return undefined;
    if (!coin) throw new Error('adapter-history-contract: HL market listing read outside a scenario');
    const names = body.dex === 'xyz' ? ['xyz:CONTRACT-TEST-ONLY'] : [coin];
    return [{ universe: names.map((name) => ({ name })) }, names.map(() => ({}))];
  },
}));

vi.mock('../../src/lib/adapters/_upstream-fetch.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/adapters/_upstream-fetch.js')>()),
  upstreamFetch: vi.fn(async (_cfg: unknown, req: { url: string; body?: string }) => {
    const listing = hlMarketListing(req, replay.coin);
    if (listing !== undefined) return listing;
    if (!replay.venue) throw new Error('adapter-history-contract: no venue loaded');
    return replay.venue.answer(req.url, req.body ?? null);
  }),
}));

import * as aster from '../../src/lib/adapters/aster.js';
import * as binance from '../../src/lib/adapters/binance.js';
import * as bingx from '../../src/lib/adapters/bingx.js';
import * as bitget from '../../src/lib/adapters/bitget.js';
import * as bybit from '../../src/lib/adapters/bybit.js';
import * as gateio from '../../src/lib/adapters/gateio.js';
import * as hyperliquid from '../../src/lib/adapters/hyperliquid.js';
import * as htx from '../../src/lib/adapters/htx.js';
import * as kucoin from '../../src/lib/adapters/kucoin.js';
import * as mexc from '../../src/lib/adapters/mexc.js';
import * as okx from '../../src/lib/adapters/okx.js';
import * as phemex from '../../src/lib/adapters/phemex.js';
import * as weex from '../../src/lib/adapters/weex.js';
import * as whitebit from '../../src/lib/adapters/whitebit.js';
import * as xt from '../../src/lib/adapters/xt.js';
import { CRON_TIMEFRAMES, isTimeframeFaithful, servedTimeframes } from '../../src/lib/tf-support.js';
import { TF_MS } from '../../src/lib/pfe-mae.js';
import type { ExchangeAdapter, ExchangeId } from '../../src/types.js';

type AdapterModule = { servedIntervalMs: (tf: string) => number | null };
const VENUES: Record<string, { mod: AdapterModule; make: () => ExchangeAdapter }> = {
  ASTER: { mod: aster, make: () => new aster.AsterAdapter() },
  BINANCE: { mod: binance, make: () => new binance.BinanceAdapter() },
  BINGX: { mod: bingx, make: () => new bingx.BingxAdapter() },
  BITGET: { mod: bitget, make: () => new bitget.BitgetAdapter() },
  BYBIT: { mod: bybit, make: () => new bybit.BybitAdapter() },
  GATE: { mod: gateio, make: () => new gateio.GateAdapter() },
  HL: { mod: hyperliquid, make: () => new hyperliquid.HyperliquidAdapter() },
  HTX: { mod: htx, make: () => new htx.HTXAdapter() },
  KUCOIN: { mod: kucoin, make: () => new kucoin.KuCoinAdapter() },
  MEXC: { mod: mexc, make: () => new mexc.MEXCAdapter() },
  OKX: { mod: okx, make: () => new okx.OKXAdapter() },
  PHEMEX: { mod: phemex, make: () => new phemex.PhemexAdapter() },
  WEEX: { mod: weex, make: () => new weex.WeexAdapter() },
  WHITEBIT: { mod: whitebit, make: () => new whitebit.WhitebitAdapter() },
  XT: { mod: xt, make: () => new xt.XtAdapter() },
};

const ROOT = path.resolve(__dirname, '../..');
const FIX = path.join(ROOT, 'tests/fixtures/adapter-history');
const readJson = <T>(f: string): T => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8')) as T;

interface Universe { promoted: string[]; cronTimeframes: string[]; pairs: { pair: string; faithful: boolean; servedMs: number; requestedMs: number }[] }

const universe = readJson<Universe>('UNIVERSE.json');
const baseline = readJson<{ entries: Measurement['edit'] }>('BASELINE.json').entries;
const reachPinned = readJson<{ pairs: Measurement['reach'] }>('REACH.json').pairs;
const unservable = readJson<{ pairs: Unservable[] }>('UNSERVABLE.json').pairs;
const controls = readJson<{ controls: Control[] }>('CONTROLS.json').controls;
const vantages = readJson<{ scenarios: { id: string; agreeing: string[]; singleVantageReason?: string }[] }>('VANTAGES.json').scenarios;
const fixtures: VenueFixture[] = Object.keys(VENUES).map((v) => readJson<VenueFixture>(`${v}.json`));
const modelProbes = readJson<{ bitgetListingMs: number; okxListingMs: number }>('MODEL-PROBES.json');
interface ServingScenario extends Scenario { window: string; spanMs: number }
const serving = readJson<{ venues: string[]; scenarios: ServingScenario[] }>('SERVING.json');
const listingOf = listingFromProbes(modelProbes);

const netSpy = vi.fn(() => { throw new Error('adapter-history-contract: a real network call was attempted'); });
let measured: Measurement;

async function runScenario(s: Scenario): Promise<RunResult> {
  const synthetic = SYNTHETIC_VENUES.has(s.venue);
  const venue = synthetic ? null : new ReplayVenue();
  if (venue) { venue.load(s); replay.venue = venue; }
  else replay.venue = new SyntheticVenue(s.venue as 'BITGET' | 'OKX', () => Date.now(), listingOf);
  replay.coin = s.coin;
  hyperliquid._resetHyperliquidMetaCache(); // every scenario resolves its market at its own capture time
  vi.setSystemTime(s.calledAt);
  let out: Bar[] = [];
  let err: string | null = null;
  let meta: unknown = undefined;
  try {
    const page = await VENUES[s.venue].make().getCandles(s.coin, s.tf, s.from, undefined, s.to ?? undefined);
    meta = historyMetaOf(page);
    out = page.map((c) => ({ ts: c.time, open: c.open }));
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  } finally {
    replay.venue = null;
    replay.coin = null;
  }
  return { out, err, drained: venue ? venue.drained() : true, meta, synthetic };
}

beforeAll(async () => {
  vi.stubGlobal('fetch', netSpy);
  vi.useFakeTimers({ toFake: ['Date'] });
  measured = await measure(fixtures, controls, unservable, runScenario);
  vi.useRealTimers();
}, 120_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('adapter history contract — the universe', () => {
  it('pins the active promoted venues × faithful cron timeframes (OAH-Q9)', () => {
    const computed: string[] = [];
    for (const v of universe.promoted) for (const tf of CRON_TIMEFRAMES) if (isTimeframeFaithful(v as ExchangeId, tf)) computed.push(`${v}/${tf}`);
    expect(universe.cronTimeframes).toEqual([...CRON_TIMEFRAMES]);
    expect(universe.pairs.filter((p) => p.faithful).map((p) => p.pair).sort()).toEqual(computed.sort());
    expect(computed.length).toBeGreaterThan(0);
  });

  it('every pinned pair states the adapter\'s own served step (the leaf lookup)', () => {
    for (const p of universe.pairs) {
      const [v, tf] = p.pair.split('/');
      expect(VENUES[v].mod.servedIntervalMs(tf), p.pair).toBe(p.servedMs);
      expect(TF_MS[tf], p.pair).toBe(p.requestedMs);
    }
  });

  it('every pinned pair has a captured R and D scenario', () => {
    const captured = new Set(fixtures.flatMap((f) => f.pairs.map((p) => p.pair)));
    expect(universe.pairs.map((p) => p.pair).filter((p) => !captured.has(p))).toEqual([]);
  });

  it('every captured scenario agrees across two vantages, or states why it has one (OAH-Q9 AC2)', () => {
    const ids = new Set(vantages.map((s) => s.id));
    const all = fixtures.flatMap((f) => [...f.pairs.flatMap((p) => [p.R, p.D]), ...(f.extras ?? [])]).map((s) => `${s.venue}/${s.tf}/${s.tag}`);
    expect(all.filter((id) => !ids.has(id))).toEqual([]);
    for (const s of vantages) {
      if (s.agreeing.length < 2) expect(s.singleVantageReason, s.id).toBeTruthy();
    }
  });
});

describe('adapter history contract — measured against the pinned baseline', () => {
  it('replays every scenario exactly as captured (no REPLAY_MISS, no drift in the adapter output)', () => {
    expect(measured.replayFailures).toEqual([]);
  });

  it('classifies every pair (no incomplete window without a control, no unlisted dead pair)', () => {
    expect(measured.unclassified).toEqual([]);
  });

  it('the dead pairs are exactly the declared UNSERVABLE ones (SKIPPED_UNSERVABLE)', () => {
    expect(measured.unservable).toEqual(unservable.map((u) => u.pair).sort());
  });

  it('the EDIT-class violations EQUAL BASELINE.json (RED-first evidence; CH2 empties it)', () => {
    expect(measured.edit).toEqual(baseline);
  });

  it('the REPORT-class facts EQUAL REACH.json (a venue changing its reach reddens this; update consciously)', () => {
    expect(measured.reach).toEqual(reachPinned);
  });

  it('no real host was reached', () => {
    expect(netSpy).not.toHaveBeenCalled();
  });
});

const ADAPTER_DIR = path.join(ROOT, 'src/lib/adapters');
const scans = fs.readdirSync(ADAPTER_DIR).filter((f) => f.endsWith('.ts')).sort()
  .map((f) => scanIntervalSource(fs.readFileSync(path.join(ADAPTER_DIR, f), 'utf8'), f));

describe('adapter history contract — structure', () => {
  it('no adapter (and no history planner) imports tf-support: the adapter IS the leaf (OAH-Q3; a cycle returns the requested step)', () => {
    const dir = path.join(ROOT, 'src/lib/adapters');
    const offenders = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))
      .filter((f) => /from\s+['"][./]*(lib\/)?tf-support(\.js)?['"]|require\(\s*['"][./]*(lib\/)?tf-support/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('every venue adapter resolves its timeframe once, through resolveVenueInterval, on its own timeframe map (CH2)', () => {
    const venueFiles = scans.filter((s) => !s.file.startsWith('_'));
    expect(venueFiles.length).toBe(17); // the 15 promoted venues and the two retired ones (BITMART, EDGEX)
    for (const s of venueFiles) {
      expect(s.resolvedMaps.map((m) => m.name), s.file).toHaveLength(1);
      expect(s.timeframeMaps, s.file).toContain(s.resolvedMaps[0].name);
      expect(s.resolvedMaps[0].keys.length, s.file).toBeGreaterThan(0);
    }
  });

  it('a requested-step table read without a fallback (BAR_MS) holds every timeframe its interval map serves (CH2)', () => {
    const withSteps = scans.filter((s) => s.mapKeys.BAR_MS);
    expect(withSteps.map((s) => s.file)).toEqual(['bitget.ts', 'edgex.ts', 'okx.ts']);
    for (const s of withSteps) {
      const resolved = s.resolvedMaps[0].keys;
      expect(resolved.filter((k) => !s.mapKeys.BAR_MS.includes(k)), s.file).toEqual([]);
    }
  });

  it('no adapter falls back from an interval lookup: an unmapped timeframe is refused, never fetched as a default bar (CH2)', () => {
    expect(scans.flatMap((s) => s.fallbacks)).toEqual([]);
  });

  it('the no-fallback gate can fail: one planted `|| \'1h\'` reddens it, and so does each pre-CH2 form', () => {
    const okxSrc = fs.readFileSync(path.join(ADAPTER_DIR, 'okx.ts'), 'utf8');
    const call = "resolveVenueInterval(INTERVAL_MAP, interval, 'OKX')";
    expect(okxSrc.split(call)).toHaveLength(2);
    expect(scanIntervalSource(okxSrc.replace(call, `${call} || '1h'`), 'okx.ts').fallbacks).toHaveLength(1);
    expect(scanIntervalSource(okxSrc.replace(call, "INTERVAL_MAP[interval] || '1h'"), 'okx.ts').fallbacks).toHaveLength(1);
    expect(scanIntervalSource("const STEP_MAP = { '1h': 60, '4h': 240 };\nconst step = STEP_MAP[interval] ?? 60;", 'x.ts').fallbacks).toHaveLength(1);
    expect(scanIntervalSource("const BAR_MS = { '1h': 3600000 };\nconst ms = BAR_MS[interval] ? BAR_MS[interval] : 3600000;", 'x.ts').fallbacks).toHaveLength(1);
  });
});

describe('adapter history contract — served-map truth (CH2): every mapped timeframe has captured evidence', () => {
  const FILE: Record<string, string> = {
    ASTER: 'aster.ts', BINANCE: 'binance.ts', BINGX: 'bingx.ts', BITGET: 'bitget.ts', BYBIT: 'bybit.ts', GATE: 'gateio.ts',
    HL: 'hyperliquid.ts', HTX: 'htx.ts', KUCOIN: 'kucoin.ts', MEXC: 'mexc.ts', OKX: 'okx.ts', PHEMEX: 'phemex.ts',
    WEEX: 'weex.ts', WHITEBIT: 'whitebit.ts', XT: 'xt.ts',
  };
  /** Venue tokens for timeframes no product surface can request (capabilities.TIMEFRAMES is every tool's enum). */
  const NON_PRODUCT_KEYS: Record<string, string[]> = { BINGX: ['6h'], HL: ['3d', '1w', '1M'] };
  /** Mapped product timeframes with no captured body: 1m is outside the R/D universe (cron timeframes, OAH-Q9), and
   *  BITGET/OKX run S on the synthetic venue. Measured live in the wave's CH2 probe instead (status.md). */
  const UNEVIDENCED: Record<string, string> = {
    'BITGET/1m': '1m is not a cron timeframe (no R/D capture); BITGET runs S on the synthetic venue',
    'OKX/1m': '1m is not a cron timeframe (no R/D capture); OKX runs S on the synthetic venue',
  };
  const keysOf = (v: string) => scans.find((s) => s.file === FILE[v])!.resolvedMaps[0].keys;

  it('names every promoted venue\'s adapter file', () => {
    expect(Object.keys(FILE).sort()).toEqual([...universe.promoted].sort());
  });

  it('the map each adapter declares IS the map the runtime lookup reads (servedTimeframes)', () => {
    for (const v of universe.promoted) {
      const keys = keysOf(v);
      expect(TIMEFRAMES.filter((tf) => keys.includes(tf)), v).toEqual(servedTimeframes(v as ExchangeId));
      expect(keys.filter((k) => !TIMEFRAMES.includes(k)).sort(), `${v}: a venue-only timeframe token`).toEqual([...(NON_PRODUCT_KEYS[v] ?? [])].sort());
    }
  });

  it('every mapped cron timeframe has REACH evidence that the venue served it, and REACH holds no unmapped pair', () => {
    let judged = 0;
    for (const v of universe.promoted) {
      const mapped = CRON_TIMEFRAMES.filter((tf) => keysOf(v).includes(tf)).map((tf) => `${v}/${tf}`);
      judged += mapped.length;
      const reached = Object.keys(reachPinned).filter((p) => p.startsWith(`${v}/`));
      expect([...reached].sort(), v).toEqual([...mapped].sort());
      for (const p of mapped) {
        const r = (reachPinned as Record<string, { R: { returned: number; emptyWindow: boolean } }>)[p];
        expect(r.R.returned > 0 && !r.R.emptyWindow, `${p}: the recent page served no bar`).toBe(true);
      }
    }
    expect(judged).toBe(Object.keys(reachPinned).length); // every REACH pair was judged (vacuity guard)
    expect(judged).toBeGreaterThan(100);
  });

  it('every other mapped product timeframe has a served S scenario, except EXACTLY the declared unevidenced pairs', () => {
    const unevidenced: string[] = [];
    let evidenced = 0;
    for (const v of universe.promoted) {
      for (const tf of TIMEFRAMES.filter((t) => keysOf(v).includes(t) && !(CRON_TIMEFRAMES as readonly string[]).includes(t))) {
        const served = serving.scenarios.some((s) => s.venue === v && s.tf === tf && !s.error && s.output.length > 0);
        if (served) evidenced++; else unevidenced.push(`${v}/${tf}`);
      }
    }
    expect(unevidenced.sort()).toEqual(Object.keys(UNEVIDENCED).sort());
    expect(evidenced).toBe(universe.promoted.length - Object.keys(UNEVIDENCED).length); // 1m on every replay venue
  });
});

// ── S: every serving window the product asks for ─────────────────────────────────────────────────────
const sId = (v: string, tf: string, window: string) => `${v}/${tf}/S@${window}`;
const unservablePairs = new Set(unservable.map((u) => u.pair));
/** The S windows the registry declares for `venues`, on every faithful timeframe the product serves. */
function sExpected(venues: string[]): { id: string; venue: string; tf: string; window: string; spanMs: number }[] {
  return venues.flatMap((v) => TIMEFRAMES.filter((tf) => isTimeframeFaithful(v as ExchangeId, tf))
    .flatMap((tf) => servingSpans(tf, VENUES[v].mod.servedIntervalMs(tf)).map((w) => ({ id: sId(v, tf, w.label), venue: v, tf, window: w.label, spanMs: w.spanMs }))));
}
/** A serving page's head gap and the seam guard's verdict, judged at `nowMs`. */
function judge(out: Bar[], servedMs: number, tf: string, from: number, nowMs: number) {
  return {
    headGapBars: accountPage({ bars: out, servedStepMs: servedMs, from, to: null, nowMs }).headGapBars,
    stale: servingWindowVerdict({ bars: out.map((b) => ({ time: b.ts })), servedStepMs: servedMs, timeframe: tf, startTime: from, nowMs }).stale,
  };
}

/** Inside BOUNDARY_LAG_MS after a boundary a page may still end on the previous head (its basis: the R2 boundary census,
 *  src/lib/live-price.ts). */
/** The ONE head judgement (src/lib/live-price.ts), over a page as S records it. S captures read BTC: the liquid
 *  reference. S captures carry no trade read, so a trade-gated short head is INDETERMINATE here, never accepted. */
function headVerdict(
  out: Bar[], servedMs: number, calledAt: number, toleranceMs: number, venue: string, reference: HeadReference = 'liquid', trades?: HeadTrades,
): HeadVerdict {
  if (out.length === 0) return 'no bar';
  return formingHeadVerdict(out[out.length - 1].ts, servedMs, calledAt, venue, toleranceMs, reference, trades);
}
const verdictText = (v: HeadVerdict): string | null => (v !== null && isHeadIndeterminate(v) ? `INDETERMINATE: ${v.indeterminate}` : v);

describe('adapter history contract — S: every serving window the product asks for', () => {
  const replayVenues = universe.promoted.filter((v) => !SYNTHETIC_VENUES.has(v));
  const replayed = new Map<string, RunResult>();
  const synthetic: { id: string; out: Bar[]; err: string | null; requests: number; servedMs: number; tf: string; from: number; venue: string; listing: string; meta: ReturnType<typeof historyMetaOf> }[] = [];
  // Mid-slot on every grid (1D opens 16:00Z on both synthetic venues), and later than any capture: the OKX throttle
  // sleeps for any backward clock gap, and the R/D scenarios above ran these adapters at their capture instants.
  const NOW_S = Date.UTC(2030, 0, 2, 9, 30);

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    for (const s of serving.scenarios) replayed.set(sId(s.venue, s.tf, s.window), await runScenario(s));
    // OPS-SERVED-CANDLE-TRUTH-W1 CH3a: every window also for a YOUNG listing (inside the window), and for a listing
    // younger than Bitget's clipped 90-day page end where the window runs past it: the class P6's long-listed coin
    // could not show (a young Bitget listing was served from the closed-only history endpoint, one bar short).
    for (const w of sExpected([...SYNTHETIC_VENUES])) {
      const listings: [string, number][] = [['long-listed', Date.UTC(2019, 0, 1)], ['young', NOW_S - 0.5 * w.spanMs]];
      if (w.spanMs > 90 * 86_400_000) listings.push(['young-past-reach', NOW_S - 3 * 86_400_000]);
      for (const [listing, listingMs] of listings) {
        const venue = new SyntheticVenue(w.venue as 'BITGET' | 'OKX', () => NOW_S, () => ({ listingMs }));
        let requests = 0;
        replay.venue = { answer: (url: string) => { requests++; return venue.answer(url); } };
        vi.setSystemTime(NOW_S);
        const from = NOW_S - w.spanMs;
        let out: Bar[] = [];
        let err: string | null = null;
        let meta: ReturnType<typeof historyMetaOf> = undefined;
        try {
          const page = await VENUES[w.venue].make().getCandles('BTC', w.tf, from);
          meta = historyMetaOf(page);
          out = page.map((c) => ({ ts: c.time, open: c.open }));
        } catch (e) { err = e instanceof Error ? e.message : String(e); }
        replay.venue = null;
        synthetic.push({ id: `${w.id} ${listing}`, out, err, requests, servedMs: VENUES[w.venue].mod.servedIntervalMs(w.tf)!, tf: w.tf, from, venue: w.venue, listing, meta });
      }
    }
    vi.useRealTimers();
  }, 120_000);

  it('SERVING.json covers EXACTLY the registry × faithful universe of the replay venues (a missing or undeclared window reddens this)', () => {
    expect(serving.venues).toEqual(replayVenues);
    const want = sExpected(replayVenues);
    const got = serving.scenarios.map((s) => sId(s.venue, s.tf, s.window));
    expect(got.length).toBeGreaterThan(400); // the capture iterated the registry, not a hand list
    expect(new Set(got).size).toBe(got.length);
    expect([...got].sort()).toEqual(want.map((w) => w.id).sort());
    const span = new Map(want.map((w) => [w.id, w.spanMs]));
    for (const s of serving.scenarios) {
      const id = sId(s.venue, s.tf, s.window);
      expect(s.spanMs, id).toBe(span.get(id));
      expect(s.calledAt - s.from, id).toBe(s.spanMs);
      expect(s.to, id).toBeNull();
    }
  });

  it('replays every S scenario exactly as captured (no REPLAY_MISS, no drift in the adapter output)', () => {
    const drift = serving.scenarios.flatMap((s) => {
      const id = sId(s.venue, s.tf, s.window);
      const r = replayed.get(id)!;
      return r.err === s.error && r.drained && JSON.stringify(r.out) === JSON.stringify(s.output) ? [] : [`${id}: ${r.err ?? 'output drift'}${r.drained ? '' : ' (not drained)'}`];
    });
    expect(drift).toEqual([]);
  });

  it('every replay-venue window reached the venue\'s newest bar when captured, and the seam guard serves it', () => {
    const bad = serving.scenarios.flatMap((s) => {
      const id = sId(s.venue, s.tf, s.window);
      if (unservablePairs.has(`${s.venue}/${s.tf}`)) return s.output.length === 0 || s.error ? [] : [`${id}: declared UNSERVABLE but served`];
      if (s.error) return [`${id}: ${s.error}`];
      const j = judge(s.output, s.servedMs, s.tf, s.from, s.calledAt);
      return j.headGapBars !== null && j.headGapBars <= HEAD_ALLOWANCE_BARS && !j.stale ? [] : [`${id}: head gap ${j.headGapBars}${j.stale ? ' (refused)' : ''}`];
    });
    expect(bad).toEqual([]);
  });

  it('the synthetic venues serve every registry window head-complete, inside SERVING_MAX_PAGES', () => {
    expect(synthetic.length).toBeGreaterThan(60);
    const bad = synthetic.flatMap((r) => {
      if (unservablePairs.has(r.id.split('/S@')[0])) return r.err || r.out.length === 0 ? [] : [`${r.id}: declared UNSERVABLE but served`];
      if (r.err) return [`${r.id}: ${r.err}`];
      const j = judge(r.out, r.servedMs, r.tf, r.from, NOW_S);
      return j.headGapBars !== null && j.headGapBars <= HEAD_ALLOWANCE_BARS && !j.stale && r.requests <= SERVING_MAX_PAGES ? [] : [`${r.id}: head gap ${j.headGapBars}, ${r.requests} requests`];
    });
    expect(bad).toEqual([]);
  });

  it('CH3a / Q11: every replay-venue window ends on the head its venue\'s class owes — forming; forming - 1 on CLOSED_ONLY; at most the snapshot lag behind on SNAPSHOT_KLINE', () => {
    expect({ ...TICKER_PRICED_VENUES }).toEqual({ PHEMEX: 'CLOSED_ONLY', ASTER: 'SNAPSHOT_KLINE' });
    expect([...CLOSED_ONLY_KLINE_VENUES]).toEqual(['PHEMEX']);
    const bad = serving.scenarios.flatMap((s) => {
      if (s.error || unservablePairs.has(`${s.venue}/${s.tf}`)) return [];
      const why = verdictText(headVerdict(s.output, s.servedMs, s.calledAt, s.replayToleranceMs, s.venue));
      return why === null ? [] : [`${sId(s.venue, s.tf, s.window)}: ${why}`];
    });
    expect(bad).toEqual([]);
    // the declaration is evidence, not a waiver: every declared venue's every window is closed-only, so a venue that
    // starts serving its forming bar reddens this, and a venue that stops serving it reddens the line above
    for (const v of CLOSED_ONLY_KLINE_VENUES) expect(serving.scenarios.filter((s) => s.venue === v && !s.error).length, v).toBeGreaterThan(30);
    expect(serving.scenarios.filter((s) => s.venue === 'ASTER' && !s.error).length).toBeGreaterThan(30);
  });

  it('Q11: a SNAPSHOT_KLINE venue (ASTER) passes up to the measured snapshot lag and fails beyond it — slots and seconds both', () => {
    const aster = serving.scenarios.find((s) => s.venue === 'ASTER' && s.tf === '1m' && s.window === 'trade_call@100' && !s.error)!;
    const step = aster.servedMs;
    const newest = aster.output[aster.output.length - 1].ts;
    // the read instant `secs` into the bar after `newest + k·step`, with the page ending on `newest`
    const at = (slotsShort: number, secs: number) => newest + slotsShort * step + secs * 1000;
    expect(headVerdict(aster.output, step, aster.calledAt, aster.replayToleranceMs, 'ASTER')).toBeNull();
    expect(headVerdict(aster.output, step, at(0, 30), 0, 'ASTER')).toBeNull(); // the forming bar
    expect(headVerdict(aster.output, step, at(1, 58), 0, 'ASTER')).toBeNull(); // 1 slot, closed 58 s before (measured max 2026-10-23)
    expect(headVerdict(aster.output, step, at(2, (SNAPSHOT_KLINE_MAX_LAG_MS - step) / 1000), 0, 'ASTER')).toBeNull(); // 2 slots, 90 s
    expect(headVerdict(aster.output, step, at(2, (SNAPSHOT_KLINE_MAX_LAG_MS - step) / 1000 + 1), 0, 'ASTER')).toMatch(/snapshot kline/); // 91 s
    expect(headVerdict(aster.output, step, at(3, 0), 0, 'ASTER')).toMatch(/3 slot\(s\) before the forming bar, closed 120 s before the read/); // the slot bound is the age bound
    // the kind, not the venue name, decides: the same page judged as a non-declared venue fails one slot short
    expect(headVerdict(aster.output, step, at(1, 30), 0, 'BINANCE')).toMatch(/before the forming bar/);
    // a 1h ASTER page one slot short 2 min after the boundary is past the 90 s bound
    const h1 = serving.scenarios.find((s) => s.venue === 'ASTER' && s.tf === '1h' && !s.error)!;
    const n1 = h1.output[h1.output.length - 1].ts;
    expect(headVerdict(h1.output, h1.servedMs, n1 + h1.servedMs + 60_000, 0, 'ASTER')).toBeNull();
    expect(headVerdict(h1.output, h1.servedMs, n1 + h1.servedMs + 120_000, 0, 'ASTER')).toMatch(/closed 120 s before the read/);
    // a young/thin reference's head lag is a metric, never a FAIL (Q13)
    expect(headVerdict(aster.output, step, at(5, 0), 0, 'ASTER', 'thin')).toBeNull();
    expect(headLag(newest, step, at(2, 15), 'ASTER')).toEqual({ slots: 2, ageMs: 75_000 });
  });

  it('Q13: a CLOSED_ONLY venue (PHEMEX) fails on its forming bar on every reference, and on any head but forming - 1 on the liquid one only', () => {
    const phemex = serving.scenarios.find((s) => s.venue === 'PHEMEX' && s.tf === '1m' && !s.error)!;
    const step = phemex.servedMs;
    const newest = phemex.output[phemex.output.length - 1].ts;
    const midSlot = (slotsShort: number) => newest + slotsShort * step + 30_000;
    expect(headVerdict(phemex.output, step, midSlot(1), 0, 'PHEMEX')).toBeNull();
    expect(headVerdict(phemex.output, step, midSlot(3), 0, 'PHEMEX')).toMatch(/declared: 1 expected/);
    expect(headVerdict(phemex.output, step, midSlot(3), 0, 'PHEMEX', 'thin')).toBeNull(); // AGPU, 2026-10-23: 3 slots
    expect(headLag(newest, step, midSlot(3), 'PHEMEX')).toEqual({ slots: 2, ageMs: 2 * step + 30_000 });
    // inside CLOSED_ONLY_BOUNDARY_LAG_MS after a boundary the just-closed bar may not be out yet (measured to 25.9 s on
    // PHEMEX BTC): one slot more is accepted; a non-declared venue keeps BOUNDARY_LAG_MS
    expect(CLOSED_ONLY_BOUNDARY_LAG_MS).toBeGreaterThan(25_900);
    expect(headVerdict(phemex.output, step, newest + 2 * step + CLOSED_ONLY_BOUNDARY_LAG_MS, 0, 'PHEMEX')).toBeNull();
    expect(headVerdict(phemex.output, step, newest + 2 * step + CLOSED_ONLY_BOUNDARY_LAG_MS + 1, 0, 'PHEMEX')).toMatch(/declared: 1 expected/);
    expect(headVerdict(phemex.output, step, newest + step + BOUNDARY_LAG_MS + 1, 0, 'BINANCE')).toMatch(/before the forming bar/);
    for (const ref of ['liquid', 'thin'] as const) {
      expect(headVerdict(phemex.output, step, midSlot(0), 0, 'PHEMEX', ref)).toMatch(/served its forming bar/);
    }
  });

  it('CH3a: the forming-bar verdict can fail — a non-declared page one bar short, and a declared page that holds its forming bar', () => {
    const binance = serving.scenarios.find((s) => s.venue === 'BINANCE' && s.tf === '1h' && !s.error)!;
    expect(headVerdict(binance.output, binance.servedMs, binance.calledAt, binance.replayToleranceMs, 'BINANCE')).toBeNull();
    expect(headVerdict(binance.output.slice(0, -1), binance.servedMs, binance.calledAt + BOUNDARY_LAG_MS + 1, 0, 'BINANCE')).toMatch(/before the forming bar/);
    const phemex = serving.scenarios.find((s) => s.venue === 'PHEMEX' && s.tf === '1h' && !s.error)!;
    expect(headVerdict(phemex.output, phemex.servedMs, phemex.calledAt, phemex.replayToleranceMs, 'PHEMEX')).toBeNull();
    const withForming = [...phemex.output, { ts: phemex.output[phemex.output.length - 1].ts + phemex.servedMs, open: 1 }];
    expect(headVerdict(withForming, phemex.servedMs, phemex.calledAt, phemex.replayToleranceMs, 'PHEMEX')).toMatch(/served its forming bar/);
  });

  /** A paired kline + recent-trades read, measured 2026-10-24 (vault audits/OPS-SERVED-CANDLE-TRUTH-W1/ch3a-r2-*-trade-head.jsonl,
   *  copied verbatim): the newest served 1m bar and the venue's newest trade, both on the request-start clock. */
  interface TradeHeadRead { calledAt: string; newestOpen: string; headShort: boolean; lastTrade: string }
  const tradeHeads = (f: string) => fs.readFileSync(path.join(FIX, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TradeHeadRead);
  const M = 60_000;

  it('CH3a-R2 / Q14: the measured KuCoin and HL short heads replay to 0 FAIL — none had traded past its newest bar — and without trades the ones past BOUNDARY_LAG_MS are INDETERMINATE', () => {
    // [venue, file, reads, short heads, short heads past BOUNDARY_LAG_MS]
    for (const [venue, file, reads, shorts, pastLag] of [['KUCOIN', 'KUCOIN-TRADE-HEAD.jsonl', 240, 57, 18], ['HL', 'HL-TRADE-HEAD.jsonl', 48, 16, 7]] as const) {
      const rows = tradeHeads(file);
      expect(rows.length, file).toBe(reads);
      const short = rows.filter((r) => headLag(Date.parse(r.newestOpen), M, Date.parse(r.calledAt), venue).slots > 0);
      expect(short.length, file).toBe(shorts);
      expect(short.every((r) => r.headShort) && rows.filter((r) => r.headShort).length === shorts, file).toBe(true);
      for (const ref of ['liquid', 'thin'] as const) {
        const judge = (r: TradeHeadRead, v: string, trades?: HeadTrades) => formingHeadVerdict(Date.parse(r.newestOpen), M, Date.parse(r.calledAt), v, 0, ref, trades);
        const traded = rows.flatMap((r) => { const why = verdictText(judge(r, venue, [{ atMs: Date.parse(r.lastTrade) }])); return why === null ? [] : [`${r.calledAt}: ${why}`]; });
        expect(traded, `${file} ${ref}`).toEqual([]);
        const untraded = short.map((r) => judge(r, venue));
        expect(untraded.filter((v) => v !== null && isHeadIndeterminate(v)).length, `${file} ${ref}`).toBe(pastLag);
        expect(untraded.filter((v) => typeof v === 'string'), `${file} ${ref}`).toEqual([]);
        // the R1 rule — still every non-trade-gated venue's — FAILs exactly those reads
        expect(short.filter((r) => typeof judge(r, 'BINANCE') === 'string').length, `${file} ${ref}`).toBe(pastLag);
      }
    }
  });

  it('CH3a-R2 / Q14: a synthetic trade-gated head — a trade 20 s old in a later slot FAILs, one 5 s old is accepted, unreadable trades are INDETERMINATE', () => {
    const newest = Date.UTC(2026, 9, 24, 10, 49);
    const slotEnd = newest + M;
    const call = slotEnd + 30_000; // 1 slot short, 30 s after the boundary: past BOUNDARY_LAG_MS
    const inNewest = { atMs: slotEnd - 2_000 };
    for (const venue of TRADE_GATED_KLINE_VENUES) {
      for (const ref of ['liquid', 'thin'] as const) {
        const v = (trades?: HeadTrades, at = call, n = newest) => formingHeadVerdict(n, M, at, venue, 0, ref, trades);
        expect(v([inNewest, { atMs: call - 20_000 }])).toMatch(/1 slot\(s\) before the forming bar on a trade-gated venue, and it traded 20 s before the read in a later slot/);
        expect(v([inNewest, { atMs: call - 5_000 }])).toBeNull();
        expect(v([inNewest])).toBeNull();
        expect(v([inNewest, { atMs: call - BOUNDARY_LAG_MS }])).toBeNull(); // the lag bound is inclusive
        expect(v([inNewest, { atMs: call - BOUNDARY_LAG_MS - 1 }])).toMatch(/in a later slot/);
        expect(v([{ atMs: slotEnd - 1 }])).toBeNull(); // the last instant of the newest bar is inside it
        expect(v([{ atMs: slotEnd - 1 }, { atMs: slotEnd }])).toMatch(/in a later slot/); // its slot end is not
        // trades unavailable: never accepted, never failed
        for (const t of [undefined, { error: 'HTTP 429' }, [], [{ atMs: Number.NaN }]] as (HeadTrades | undefined)[]) {
          expect(v(t), JSON.stringify(t)).toEqual({ indeterminate: expect.stringMatching(/trade-gated venue, and its trade/) });
        }
        expect(v({ error: 'HTTP 429' })).toEqual({ indeterminate: expect.stringContaining('HTTP 429') });
        // a list that never reaches back past the slot end cannot tell "no trade yet" from a missing bar
        expect(v([{ atMs: call - 3_000 }, { atMs: call - 1_000 }])).toEqual({ indeterminate: expect.stringMatching(/do not reach back to the newest served bar's slot end/) });
        // two slots short: a trade in the middle slot is a missing traded bar; trades only in the newest bar are not
        const call2 = newest + 2 * M + 30_000;
        expect(v([inNewest, { atMs: slotEnd + 10_000 }], call2)).toMatch(/2 slot\(s\) before the forming bar on a trade-gated venue, and it traded 80 s before/);
        expect(v([inNewest], call2)).toBeNull();
        // unchanged: within BOUNDARY_LAG_MS one slot short is accepted with no trade read; the forming bar needs none
        expect(v(undefined, slotEnd + BOUNDARY_LAG_MS)).toBeNull();
        expect(isHeadIndeterminate(v(undefined, slotEnd + BOUNDARY_LAG_MS + 1) ?? 'accepted')).toBe(true);
        expect(v(undefined, call, slotEnd)).toBeNull();
      }
    }
  });

  it('CH3a-R2: every other venue\'s verdict does not depend on trades — every SERVING.json window and a synthetic head grid, byte-identical; on HL / KUCOIN trades change only a verdict that was INDETERMINATE', () => {
    const tradeSets = (newest: number, step: number): (HeadTrades | undefined)[] => [
      undefined, { error: 'x' }, [], [{ atMs: newest }], [{ atMs: newest }, { atMs: newest + step }], [{ atMs: newest + 3 * step }],
    ];
    let judged = 0;
    const check = (newest: number, step: number, at: number, venue: string, tol: number, id: string) => {
      for (const ref of ['liquid', 'thin'] as const) {
        const base = formingHeadVerdict(newest, step, at, venue, tol, ref);
        const gated = (TRADE_GATED_KLINE_VENUES as readonly string[]).includes(venue);
        if (!gated) expect(base === null || typeof base === 'string', id).toBe(true);
        if (base !== null && isHeadIndeterminate(base)) { expect(gated, id).toBe(true); continue; }
        for (const t of tradeSets(newest, step)) expect(formingHeadVerdict(newest, step, at, venue, tol, ref, t), `${id} ${ref} ${JSON.stringify(t)}`).toEqual(base);
        judged++;
      }
    };
    for (const s of serving.scenarios) {
      if (s.error || s.output.length === 0) continue;
      const newest = s.output[s.output.length - 1].ts;
      const id = sId(s.venue, s.tf, s.window);
      check(newest, s.servedMs, s.calledAt, s.venue, s.replayToleranceMs, id);
      for (let k = 0; k <= 3; k++) for (const d of [0, BOUNDARY_LAG_MS, BOUNDARY_LAG_MS + 1, CLOSED_ONLY_BOUNDARY_LAG_MS + 1, s.servedMs / 2]) {
        check(newest, s.servedMs, newest + k * s.servedMs + d, s.venue, 0, `${id} +${k}·${d}`);
      }
    }
    const newest = Date.UTC(2026, 9, 24, 10, 0);
    for (const venue of [...universe.promoted, 'X']) for (const step of [M, 3_600_000]) for (let k = 0; k <= 3; k++) {
      for (const d of [0, 1_000, BOUNDARY_LAG_MS, BOUNDARY_LAG_MS + 1, 59_000]) check(newest, step, newest + k * step + d, venue, 0, `${venue} grid +${k}·${d}`);
    }
    expect(judged).toBeGreaterThan(5_000);
  });

  it('CH3a: the synthetic venues end every window on the forming bar, young listings included, never from the closed-only endpoint', () => {
    const young = synthetic.filter((r) => r.listing !== 'long-listed');
    expect(young.length).toBeGreaterThan(60);
    expect(synthetic.some((r) => r.listing === 'young-past-reach' && r.venue === 'BITGET')).toBe(true);
    const bad = synthetic.flatMap((r) => {
      if (unservablePairs.has(r.id.split('/S@')[0]) || r.err) return [];
      const why = verdictText(headVerdict(r.out, r.servedMs, NOW_S, 0, r.venue));
      const flags = [why, r.meta?.headClosedOnly ? 'head from a closed-only endpoint' : null, r.requests > SERVING_MAX_PAGES ? `${r.requests} requests` : null].filter(Boolean);
      return flags.length ? [`${r.id}: ${flags.join(', ')}`] : [];
    });
    expect(bad).toEqual([]);
  });

  it('Q11: a SNAPSHOT_KLINE venue (ASTER) is priced from its ticker\'s last trade, never its snapshot close', async () => {
    const fx = JSON.parse(fs.readFileSync(path.join(FIX, 'ASTER-LIVE-PRICE.json'), 'utf8')) as {
      coin: string; tf: string; from: number; calledAt: number;
      kline: { url: string; body: unknown[][] }; premiumIndex: { url: string; body: unknown }; openInterest: { url: string; body: unknown };
      ticker: { url: string; body: { lastPrice: string; closeTime: number } };
    };
    const bodies = new Map([fx.kline, fx.premiumIndex, fx.openInterest, fx.ticker].map((r) => [new URL(r.url).pathname, r.body]));
    replay.venue = { answer: (url: string) => {
      const p = new URL(url).pathname;
      if (bodies.has(p)) return bodies.get(p);
      throw new Error(`ASTER-LIVE-PRICE: unexpected request ${url}`);
    } };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(fx.calledAt);
    try {
      const a = VENUES.ASTER.make();
      const bars = await a.getCandles(fx.coin, fx.tf, fx.from);
      const ctx = await a.getAssetContext(fx.coin);
      const servedMs = VENUES.ASTER.mod.servedIntervalMs(fx.tf)!;
      expect(headVerdict(bars.map((c) => ({ ts: c.time, open: c.open })), servedMs, fx.calledAt, 0, 'ASTER')).toBeNull();
      expect(ctx.lastTrade).toEqual({ price: Number(fx.ticker.body.lastPrice), atMs: fx.ticker.body.closeTime });
      // the capture is the measured class: the snapshot's newest close is not the last trade
      expect(bars[bars.length - 1].close).not.toBe(ctx.lastTrade!.price);
      const price = livePriceOf({ coin: fx.coin, timeframe: fx.tf, candles: bars, servedStepMs: servedMs }, ctx, 'ASTER', fx.calledAt);
      expect(price).toBe(ctx.lastTrade!.price);
      // no age bound on a SNAPSHOT_KLINE last trade: a thin book's last trade hours old still prices the call
      expect(livePriceOf({ coin: fx.coin, timeframe: fx.tf, candles: bars, servedStepMs: servedMs }, ctx, 'ASTER', fx.calledAt + 6 * 3_600_000)).toBe(price);
      // the non-declared path on the SAME window is the last close, byte-identical to the pre-wave read
      expect(livePriceOf({ coin: fx.coin, timeframe: fx.tf, candles: bars, servedStepMs: servedMs }, ctx, 'BINANCE', fx.calledAt)).toBe(bars[bars.length - 1].close);
    } finally {
      vi.useRealTimers();
      replay.venue = null;
    }
  });

  it('CH3a: a declared closed-only kline venue (PHEMEX) is served forming - 1 and priced from its fresh ticker, never its last close', async () => {
    const fx = JSON.parse(fs.readFileSync(path.join(FIX, 'PHEMEX-LIVE-PRICE.json'), 'utf8')) as {
      coin: string; tf: string; from: number; calledAt: number; kline: { url: string; body: unknown }; ticker: { url: string; body: { result: { closeRp: string; timestamp: number } } };
    };
    replay.venue = { answer: (url: string) => {
      const p = new URL(url).pathname;
      if (p === new URL(fx.kline.url).pathname) return fx.kline.body;
      if (p === new URL(fx.ticker.url).pathname) return fx.ticker.body;
      throw new Error(`PHEMEX-LIVE-PRICE: unexpected request ${url}`);
    } };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(fx.calledAt);
    try {
      const a = VENUES.PHEMEX.make();
      const bars = await a.getCandles(fx.coin, fx.tf, fx.from);
      const ctx = await a.getAssetContext(fx.coin);
      const servedMs = VENUES.PHEMEX.mod.servedIntervalMs(fx.tf)!;
      expect(headVerdict(bars.map((c) => ({ ts: c.time, open: c.open })), servedMs, fx.calledAt, 0, 'PHEMEX')).toBeNull();
      expect(ctx.lastTrade?.price).toBe(Number(fx.ticker.body.result.closeRp));
      expect(Math.abs(fx.calledAt - ctx.lastTrade!.atMs)).toBeLessThanOrEqual(LIVE_TICKER_MAX_AGE_MS);
      const price = livePriceOf({ coin: fx.coin, timeframe: fx.tf, candles: bars, servedStepMs: servedMs }, ctx, 'PHEMEX', fx.calledAt);
      expect(price).toBe(ctx.lastTrade!.price);
      // the non-declared path on the SAME window is the last close, byte-identical to the pre-wave read
      expect(livePriceOf({ coin: fx.coin, timeframe: fx.tf, candles: bars, servedStepMs: servedMs }, ctx, 'BINANCE', fx.calledAt)).toBe(bars[bars.length - 1].close);
    } finally {
      vi.useRealTimers();
      replay.venue = null;
    }
  });

  it('no real host was reached by S', () => {
    expect(netSpy).not.toHaveBeenCalled();
  });
});

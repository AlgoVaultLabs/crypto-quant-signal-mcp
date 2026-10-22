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

describe('adapter history contract — S: every serving window the product asks for', () => {
  const replayVenues = universe.promoted.filter((v) => !SYNTHETIC_VENUES.has(v));
  const replayed = new Map<string, RunResult>();
  const synthetic: { id: string; out: Bar[]; err: string | null; requests: number; servedMs: number; tf: string; from: number }[] = [];
  // Mid-slot on every grid (1D opens 16:00Z on both synthetic venues), and later than any capture: the OKX throttle
  // sleeps for any backward clock gap, and the R/D scenarios above ran these adapters at their capture instants.
  const NOW_S = Date.UTC(2030, 0, 2, 9, 30);

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    for (const s of serving.scenarios) replayed.set(sId(s.venue, s.tf, s.window), await runScenario(s));
    for (const w of sExpected([...SYNTHETIC_VENUES])) {
      const venue = new SyntheticVenue(w.venue as 'BITGET' | 'OKX', () => NOW_S, () => ({ listingMs: Date.UTC(2019, 0, 1) }));
      let requests = 0;
      replay.venue = { answer: (url: string) => { requests++; return venue.answer(url); } };
      vi.setSystemTime(NOW_S);
      const from = NOW_S - w.spanMs;
      let out: Bar[] = [];
      let err: string | null = null;
      try { out = (await VENUES[w.venue].make().getCandles('BTC', w.tf, from)).map((c) => ({ ts: c.time, open: c.open })); }
      catch (e) { err = e instanceof Error ? e.message : String(e); }
      replay.venue = null;
      synthetic.push({ id: w.id, out, err, requests, servedMs: VENUES[w.venue].mod.servedIntervalMs(w.tf)!, tf: w.tf, from });
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

  it('no real host was reached by S', () => {
    expect(netSpy).not.toHaveBeenCalled();
  });
});

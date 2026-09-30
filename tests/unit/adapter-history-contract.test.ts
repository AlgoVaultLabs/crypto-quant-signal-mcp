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
 *   UNSERVABLE (OAH-Q9): pairs the served lookup calls native but the venue will not serve. They are declared
 *     with a reason in UNSERVABLE.json and SKIPPED here. Any other dead pair fails the test.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ReplayVenue, SYNTHETIC_VENUES, measure,
  type Bar, type Control, type Measurement, type RunResult, type Scenario, type Unservable, type VenueFixture,
} from '../harness/adapter-history-model.js';
import { SyntheticVenue, listingFromProbes } from '../harness/adapter-history-synthetic.js';
import { historyMetaOf } from '../../src/lib/adapters/_history-plan.js';

const { replay } = vi.hoisted(() => ({ replay: { venue: null as null | { answer(url: string, body?: string | null): unknown } } }));

vi.mock('../../src/lib/adapters/_upstream-fetch.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/adapters/_upstream-fetch.js')>()),
  upstreamFetch: vi.fn(async (_cfg: unknown, req: { url: string; body?: string }) => {
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
import { CRON_TIMEFRAMES, isTimeframeFaithful } from '../../src/lib/tf-support.js';
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
const listingOf = listingFromProbes(modelProbes);

const netSpy = vi.fn(() => { throw new Error('adapter-history-contract: a real network call was attempted'); });
let measured: Measurement;

async function runScenario(s: Scenario): Promise<RunResult> {
  const synthetic = SYNTHETIC_VENUES.has(s.venue);
  const venue = synthetic ? null : new ReplayVenue();
  if (venue) { venue.load(s); replay.venue = venue; }
  else replay.venue = new SyntheticVenue(s.venue as 'BITGET' | 'OKX', () => Date.now(), listingOf);
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

describe('adapter history contract — structure', () => {
  it('no adapter (and no history planner) imports tf-support: the adapter IS the leaf (OAH-Q3; a cycle returns the requested step)', () => {
    const dir = path.join(ROOT, 'src/lib/adapters');
    const offenders = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))
      .filter((f) => /from\s+['"][./]*(lib\/)?tf-support(\.js)?['"]|require\(\s*['"][./]*(lib\/)?tf-support/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

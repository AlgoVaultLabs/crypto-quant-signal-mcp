/**
 * hl-market-resolution.test.ts — OPS-CANDLE-REQUEST-OWNER-DERIVATION-W1 CH1.
 *
 * WHY THIS EXISTS. Every per-coin Hyperliquid request names a MARKET: a HIP-3 perp on dex `xyz` is `xyz:<coin>`, a
 * standard perp is `<coin>`, and HL answers the wrong one with HTTP 500 (measured 2026-10-18: `xyz:SPCX` 200,
 * `SPCX` 500). Twelve call sites used to choose the market themselves — four from the static seed behind
 * `getDexForCoin`, which only a WARMED process extends with HL's live list — so every fill and label script asked
 * for the standard market, and ~2.7k published signals on 8 xyz coins went unfilled for five months. The adapter
 * now names the market from HL's own listing (`resolveHlMarket`); callers name the coin.
 *
 * What is pinned, against HL's transport stubbed at the ONE chokepoint (`upstreamFetch`) in a COLD process —
 * `warmTierCaches` never runs here, which is exactly the state every script was in:
 *   AC1  the adapter names `xyz:SPCX` / `SPX` / `BTC` whatever `dex` a caller passes, through every per-coin
 *        method; a coin HL lists nowhere gets NO request; executed again through two call sites' own code
 *        (the directional labeler's page probe, the TradFi funding fan-out); and a census of EVERY call
 *        expression in src/ proves no caller hands the adapter a market.
 *   AC2  fail-closed: a listing that cannot be had is a typed error and no request — never a default market.
 *        Each assertion was broken deliberately (the four AC2 breaks + a site re-passing a market) and seen red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

type HlBody = { type?: string; dex?: string; coin?: string; req?: { coin?: string; interval?: string } };

const { hl } = vi.hoisted(() => {
  // Per-market context prices, so a context read from the WRONG universe is visible in the value.
  const PX: Record<string, string> = {
    BTC: '100000', SPX: '6000', kPEPE: '0.01', MATIC: '0.5', GOLD: '1', 'xyz:SPCX': '42', 'xyz:GOLD': '2400',
  };
  const FUNDING: Record<string, string> = { 'xyz:SPCX': '0.0005' };
  const state = {
    standard: [] as string[],
    xyz: [] as string[],
    delisted: new Set<string>(),
    /** When set, every metaAndAssetCtxs read throws what it returns (HL refusing, or our own budget). */
    metaFailure: null as null | (() => Error),
    requests: [] as HlBody[],
    reset(): void {
      state.standard = ['BTC', 'SPX', 'kPEPE', 'MATIC'];
      state.xyz = ['xyz:SPCX', 'xyz:GOLD'];
      state.delisted = new Set(['MATIC']);
      state.metaFailure = null;
      state.requests = [];
    },
    of(type: string): HlBody[] { return state.requests.filter((b) => b.type === type); },
    candleCoins(): string[] { return state.of('candleSnapshot').map((b) => b.req?.coin ?? '<none>'); },
    metaReads(dex: 'standard' | 'xyz'): number {
      return state.of('metaAndAssetCtxs').filter((b) => (b.dex === 'xyz' ? 'xyz' : 'standard') === dex).length;
    },
    answer(url: string, rawBody?: string): unknown {
      if (!url.includes('api.hyperliquid.xyz')) throw new Error(`hl-market-resolution: no venue but HL is modelled (${url})`);
      const body = JSON.parse(rawBody ?? '{}') as HlBody;
      state.requests.push(body);
      if (body.type === 'metaAndAssetCtxs') {
        if (state.metaFailure) throw state.metaFailure();
        const names = body.dex === 'xyz' ? state.xyz : state.standard;
        return [
          { universe: names.map((name) => ({ name, ...(state.delisted.has(name) ? { isDelisted: true } : {}) })) },
          names.map((name) => ({
            funding: FUNDING[name] ?? '0.0001', openInterest: '1000', prevDayPx: PX[name] ?? '1',
            dayNtlVlm: '1000000', oraclePx: PX[name] ?? '1', markPx: PX[name] ?? '1',
          })),
        ];
      }
      if (body.type === 'candleSnapshot') {
        const t0 = 1_780_000_000_000;
        return Array.from({ length: 3 }, (_, i) => ({ t: t0 + i * 3_600_000, o: '1', h: '1', l: '1', c: '1', v: '1' }));
      }
      if (body.type === 'fundingHistory') return [{ time: 1, coin: body.coin, fundingRate: '0.0001', premium: '0' }];
      if (body.type === 'predictedFundings') return [];
      throw new Error(`hl-market-resolution: unmodelled HL info type ${String(body.type)}`);
    },
  };
  return { hl: state };
});

vi.mock('../../src/lib/adapters/_upstream-fetch.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/adapters/_upstream-fetch.js')>()),
  upstreamFetch: vi.fn(async (_cfg: unknown, req: { url: string; body?: string }) => hl.answer(req.url, req.body)),
}));

import {
  HyperliquidAdapter,
  HlMarketAmbiguousError,
  HlMarketNotListedError,
  HlMarketUnavailableError,
  buildHlMarketListing,
  resolveHlMarket,
  _resetHyperliquidMetaCache,
} from '../../src/lib/adapters/hyperliquid.js';
import { isKnownTradFi } from '../../src/lib/asset-tiers.js';
import { WeightBudgetSkipError } from '../../src/lib/upstream-weight-budget.js';
import { UpstreamRateLimitError } from '../../src/lib/errors.js';
import { marketUnserved } from '../../src/scripts/backfill-directional-labels.js';
import { fetchTradFiFundingByVenue, _clearTradFiFundingCache } from '../../src/lib/tradfi-funding.js';
import type { DexType } from '../../src/types.js';

const START = 1_780_000_000_000;
const END = START + 10 * 3_600_000;
const DEX_ARGS: (DexType | undefined)[] = [undefined, 'standard', 'xyz'];
/** The three coins the AC names, and the market HL lists each under. */
const PARITY: [coin: string, market: string][] = [['SPCX', 'xyz:SPCX'], ['SPX', 'SPX'], ['BTC', 'BTC']];

const adapter = new HyperliquidAdapter();

beforeEach(() => {
  hl.reset();
  _resetHyperliquidMetaCache();
  _clearTradFiFundingCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AC1 — a COLD process names the market from HL\'s own listing', () => {
  it('the process is cold: asset-tiers never loaded HL\'s live xyz list, and SPCX is absent from its static seed', () => {
    // This is the state every fill and label script was in. The retired router answered `standard` for SPCX here.
    expect(isKnownTradFi('SPCX')).toBe(false);
    expect(isKnownTradFi('SPX')).toBe(true); // the seed lists SPX, which HL lists only in the standard universe
  });

  it('getCandles names xyz:SPCX / SPX / BTC whatever `dex` the caller passes', async () => {
    for (const [coin, market] of PARITY) {
      for (const dex of DEX_ARGS) {
        hl.requests = [];
        const candles = await adapter.getCandles(coin, '1h', START, dex, END);
        expect(hl.candleCoins(), `${coin} dex=${String(dex)}`).toEqual([market]);
        expect(candles.length).toBe(3);
      }
    }
  });

  it('getAssetContext and getCurrentPrice read the coin\'s context from its own universe, whatever `dex` is passed', async () => {
    const px: Record<string, number> = { SPCX: 42, SPX: 6000, BTC: 100000 };
    for (const [coin] of PARITY) {
      for (const dex of DEX_ARGS) {
        const ctx = await adapter.getAssetContext(coin, dex);
        expect(ctx.coin).toBe(coin);
        expect(ctx.markPx, `${coin} dex=${String(dex)}`).toBe(px[coin]);
        expect(await adapter.getCurrentPrice(coin, dex)).toBe(px[coin]);
      }
    }
  });

  it('getFundingHistory requests the resolved market', async () => {
    for (const [coin, market] of PARITY) {
      hl.requests = [];
      await adapter.getFundingHistory(coin, START);
      expect(hl.of('fundingHistory').map((b) => b.coin)).toEqual([market]);
    }
  });

  it('a coin HL lists in NEITHER universe gets no request — an empty series, or a typed error where a value is required', async () => {
    await adapter.getCandles('SPCX', '1h', START, undefined, END); // warm the listing so only per-coin requests remain
    hl.requests = [];
    expect(await adapter.getCandles('NOPE', '1h', START, undefined, END)).toEqual([]);
    expect(await adapter.getCandles('NOPE', '1h', START, 'xyz', END)).toEqual([]);
    await expect(adapter.getAssetContext('NOPE')).rejects.toBeInstanceOf(HlMarketNotListedError);
    await expect(adapter.getAssetContext('NOPE')).rejects.toThrow('NOPE not found on Hyperliquid');
    expect(await adapter.getCurrentPrice('NOPE')).toBeNull();
    expect(await adapter.getFundingHistory('NOPE', START)).toEqual([]);
    expect(hl.requests).toEqual([]);
  });

  it('the market is HL\'s own spelling: exact and case-sensitive; delisted markets stay listed', async () => {
    await adapter.getCandles('kPEPE', '1h', START, undefined, END);
    await adapter.getCandles('KPEPE', '1h', START, undefined, END); // HL answers `KPEPE` with HTTP 500 — never asked
    await adapter.getCandles('MATIC', '1d', START, undefined, END); // delisted, still served (MATIC 1d, 200)
    expect(hl.candleCoins()).toEqual(['kPEPE', 'MATIC']);
  });

  it('one listing serves every request: single-flight, ONE read per universe for a concurrent burst', async () => {
    const coins = ['SPCX', 'SPX', 'BTC', 'GOLD', 'kPEPE', 'NOPE'];
    await Promise.all(Array.from({ length: 30 }, (_, i) => adapter.getCandles(coins[i % coins.length], '1h', START, undefined, END)));
    expect(hl.metaReads('standard')).toBe(1);
    expect(hl.metaReads('xyz')).toBe(1);
    expect(hl.candleCoins().filter((c) => c === 'NOPE')).toEqual([]);
    expect(new Set(hl.candleCoins())).toEqual(new Set(['xyz:SPCX', 'SPX', 'BTC', 'xyz:GOLD', 'kPEPE']));
  });

  it('a new listing is picked up within the 10-min TTL — HL\'s listing, never a seed, decides', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    expect(await resolveHlMarket('NEWCO')).toBeNull();
    hl.xyz = [...hl.xyz, 'xyz:NEWCO'];
    vi.setSystemTime(START + 10 * 60_000 + 1);
    expect(await resolveHlMarket('NEWCO')).toEqual({ coin: 'NEWCO', market: 'xyz:NEWCO', dex: 'xyz' });
  });
});

describe('AC1 — every HL call site hands the adapter the coin, never a market', () => {
  it('executed through the directional labeler\'s own page probe (marketUnserved → getCandles)', async () => {
    expect(await marketUnserved('HL', 'SPCX', '1h')).toBe(false);
    expect(hl.candleCoins()).toEqual(['xyz:SPCX']);
    hl.requests = [];
    expect(await marketUnserved('HL', 'NOPE', '1h')).toBe(false);
    expect(hl.candleCoins()).toEqual([]); // no request for a market HL does not list
  });

  it('executed through the TradFi funding fan-out (fetchTradFiFundingByVenue → getAssetContext)', async () => {
    const rows = await fetchTradFiFundingByVenue('SPCX'); // the other venues are unmodelled here and fail soft
    const hlRow = rows.find((r) => r.venue === 'HL');
    expect(hlRow?.rate).toBe(0.0005); // the xyz:SPCX context — not a standard-universe miss
    expect(hl.of('candleSnapshot')).toEqual([]);
  });

  // ── the census: EVERY candle / context / price / funding call expression in src/, outside the adapters ──
  const SRC = path.resolve(__dirname, '../../src');
  const ADAPTERS = path.join(SRC, 'lib', 'adapters');
  function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) return p === ADAPTERS ? [] : walk(p);
      return d.name.endsWith('.ts') ? [p] : [];
    });
  }
  /** Comments out, string and template contents kept (a URL's `//` is not a comment). */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
  }
  /** Top-level arguments of the call whose opening paren is at index `open`. */
  function argsAt(src: string, open: number): string[] {
    const args: string[] = [];
    let depth = 0;
    let cur = '';
    for (let i = open; i < src.length; i++) {
      const ch = src[i];
      if ('([{'.includes(ch)) { depth++; if (depth === 1) continue; }
      if (')]}'.includes(ch)) { depth--; if (depth === 0) { if (cur.trim() !== '') args.push(cur.trim()); return args; } }
      if (ch === ',' && depth === 1) { args.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    throw new Error('unbalanced call');
  }
  interface Site { file: string; receiver: string; method: string; args: string[] }
  function census(): Site[] {
    const sites: Site[] = [];
    for (const file of walk(SRC)) {
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      for (const m of src.matchAll(/\.(getCandles|getAssetContext|getCurrentPrice|getFundingHistory)\x28/g)) {
        const receiver = /([A-Za-z_$][\w$]*|\x29)\s*\??$/.exec(src.slice(0, m.index!))?.[1] ?? '';
        sites.push({ file: path.relative(path.resolve(SRC, '..'), file), receiver, method: m[1], args: argsAt(src, m.index! + m[0].length - 1) });
      }
    }
    return sites;
  }
  /** Injected seams that share a method NAME with the adapter but not its signature — each declared, each must
   *  still exist (a seam that vanished from this list's file is a stale exception, and fails the census). */
  const SEAMS: { file: string; receiver: string; method: string; why: string }[] = [
    { file: 'src/scripts/adapter-history-contiguity.ts', receiver: 'o', method: 'getCandles',
      why: '(venue, tf, from, to) test seam; its production binding is the adapter call `getCandles(COIN, tf, from, undefined, to)`, censused itself' },
  ];
  const isSeam = (s: Site): boolean => SEAMS.some((x) => x.file === s.file && x.receiver === s.receiver && x.method === s.method);
  /** The 0-based argument that used to carry a market, per method. */
  const MARKET_ARG: Record<string, number> = { getCandles: 3, getAssetContext: 1, getCurrentPrice: 1 };
  const passesMarket = (s: Site): boolean => {
    const i = MARKET_ARG[s.method];
    return !isSeam(s) && i !== undefined && s.args.length > i && s.args[i] !== 'undefined';
  };

  it('finds every known HL call site (the census is not vacuous)', () => {
    const sites = census();
    // K4 (12 sites in 11 files) + the R0.3 adds — each file must still be SEEN, or the census proves nothing.
    const KNOWN = [
      'src/scripts/backfill-outcomes.ts', 'src/resources/signal-performance.ts', 'src/lib/band-outcome-lane.ts',
      'src/scripts/backfill-directional-labels.ts', 'src/scripts/backfill-hold-decision-labels.ts',
      'src/scripts/frozen-window-attribution.ts', 'src/scripts/admission-verdict.ts', 'src/lib/rank-metrics.ts',
      'src/tools/get-trade-call.ts', 'src/tools/get-market-regime.ts', 'src/lib/tradfi-funding.ts',
      'src/tools/scan-funding-arb.ts', 'src/scripts/adapter-history-contiguity.ts',
    ];
    const seen = new Set(sites.map((s) => s.file));
    expect(KNOWN.filter((f) => !seen.has(f))).toEqual([]);
    expect(sites.length).toBeGreaterThanOrEqual(20); // measured 2026-10-18
    expect(SEAMS.filter((x) => !sites.some((s) => s.file === x.file && s.receiver === x.receiver && s.method === x.method))).toEqual([]);
  });

  it('no call site passes a market: the adapter alone names it', () => {
    const offenders = census().filter(passesMarket).map((s) => `${s.file} .${s.method}(${s.args.join(', ')})`);
    expect(offenders).toEqual([]);
  });

  it('no module re-derives the HL market: getDexForCoin is gone, and no request builds an `xyz:` prefix outside the adapter', () => {
    // A LABEL is not a request: tradfi-funding's `venueSymbol` names HL symbols for display only.
    const LABEL_ONLY = new Set(['src/lib/tradfi-funding.ts']);
    const hits: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(path.resolve(SRC, '..'), file);
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      if (/\bgetDexForCoin\b/.test(src)) hits.push(`${rel}: getDexForCoin`);
      if (/`xyz:\$\x7b/.test(src) && !LABEL_ONLY.has(rel)) hits.push(`${rel}: builds xyz:<coin>`);
    }
    expect(hits).toEqual([]);
    expect(fs.existsSync(path.join(ADAPTERS, 'hyperliquid.ts'))).toBe(true);
  });

  it('the fill and label paths defer a listing outage like a budget skip — no attempt recorded, no failed row', () => {
    // Req 2: `backfill-outcomes.ts:196` and the labelers' own budget-skip paths. Every WeightBudgetSkipError
    // check in them is paired with HlMarketUnavailableError, so neither can drift without the other.
    for (const rel of ['src/scripts/backfill-outcomes.ts', 'src/scripts/backfill-directional-labels.ts', 'src/scripts/backfill-hold-decision-labels.ts']) {
      const src = stripComments(fs.readFileSync(path.resolve(SRC, '..', rel), 'utf8'));
      const budget = src.match(/err instanceof WeightBudgetSkipError/g)?.length ?? 0;
      const paired = src.match(/err instanceof WeightBudgetSkipError \|\| err instanceof HlMarketUnavailableError/g)?.length ?? 0;
      expect(budget, rel).toBeGreaterThan(0);
      expect(paired, rel).toBe(budget);
    }
  });
});

describe('AC2 — fail-closed: a listing that cannot be had is a typed error and NO request', () => {
  it('no listing ever loaded + HL refuses the read → HlMarketUnavailableError, never a default market', async () => {
    hl.metaFailure = () => new Error('HL API 500: Internal Server Error');
    for (const coin of ['SPCX', 'BTC']) {
      await expect(adapter.getCandles(coin, '1h', START, undefined, END)).rejects.toBeInstanceOf(HlMarketUnavailableError);
      await expect(adapter.getAssetContext(coin)).rejects.toBeInstanceOf(HlMarketUnavailableError);
    }
    await expect(resolveHlMarket('SPCX')).rejects.toThrow(/listing unavailable \x28HL API 500/);
    expect(hl.candleCoins()).toEqual([]);
  });

  it('our own rate limiting keeps its type — every consumer already defers it', async () => {
    hl.metaFailure = () => new WeightBudgetSkipError('Hyperliquid', 20);
    await expect(adapter.getCandles('SPCX', '1h', START, undefined, END)).rejects.toBeInstanceOf(WeightBudgetSkipError);
    _resetHyperliquidMetaCache();
    hl.metaFailure = () => new UpstreamRateLimitError('Hyperliquid', 5);
    await expect(adapter.getAssetContext('SPCX')).rejects.toBeInstanceOf(UpstreamRateLimitError);
    expect(hl.candleCoins()).toEqual([]);
  });

  it('a payload with no universe is a FAILED load, never "nothing listed"', async () => {
    hl.xyz = [];
    await expect(adapter.getCandles('BTC', '1h', START, undefined, END)).rejects.toBeInstanceOf(HlMarketUnavailableError);
    expect(hl.candleCoins()).toEqual([]);
  });

  it('a failed load is memoised ~30 s: a script iterating thousands of rows cannot stampede HL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    hl.metaFailure = () => new Error('HL API 500: Internal Server Error');
    for (let i = 0; i < 50; i++) {
      await expect(adapter.getCandles('SPCX', '1h', START, undefined, END)).rejects.toBeInstanceOf(HlMarketUnavailableError);
    }
    expect(hl.metaReads('standard') + hl.metaReads('xyz')).toBeLessThanOrEqual(2); // ONE load attempt
    hl.metaFailure = null;
    vi.setSystemTime(START + 40_000); // past the jittered negative window → the next call re-reads, and recovers
    await adapter.getCandles('SPCX', '1h', START, undefined, END);
    expect(hl.candleCoins()).toEqual(['xyz:SPCX']);
  });

  it('stale-while-error: a listing ≤ 24 h old keeps serving through failed re-reads; older fails closed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    await adapter.getCandles('SPCX', '1h', START, undefined, END); // listing loaded at START
    hl.metaFailure = () => new Error('HL API 500: Internal Server Error');
    vi.setSystemTime(START + 11 * 60_000); // past the TTL: the re-read fails, the 11-min-old listing serves
    await adapter.getCandles('SPCX', '1h', START, undefined, END);
    vi.setSystemTime(START + 23 * 3_600_000);
    await adapter.getCandles('SPCX', '1h', START, undefined, END);
    expect(hl.candleCoins()).toEqual(['xyz:SPCX', 'xyz:SPCX', 'xyz:SPCX']);
    vi.setSystemTime(START + 24 * 3_600_000 + 60_000); // > 24 h: the market is no longer known
    await expect(adapter.getCandles('SPCX', '1h', START, undefined, END)).rejects.toBeInstanceOf(HlMarketUnavailableError);
    await expect(resolveHlMarket('SPCX')).rejects.toThrow(/last listing loaded/);
    expect(hl.candleCoins()).toHaveLength(3);
  });

  it('a name HL lists in two universes is refused, never guessed', async () => {
    hl.standard = [...hl.standard, 'GOLD']; // GOLD now in standard AND as xyz:GOLD
    await expect(adapter.getCandles('GOLD', '1h', START, undefined, END)).rejects.toBeInstanceOf(HlMarketAmbiguousError);
    expect(hl.candleCoins()).toEqual([]);
    // The rest of the listing is unaffected.
    await adapter.getCandles('SPCX', '1h', START, undefined, END);
    expect(hl.candleCoins()).toEqual(['xyz:SPCX']);
  });

  it('buildHlMarketListing: the wire name is HL\'s verbatim; a duplicate is ambiguous, never last-write-wins', () => {
    const l = buildHlMarketListing([
      { dex: 'standard', names: ['BTC', 'kPEPE', 'DUP'] },
      { dex: 'xyz', names: ['xyz:SPCX', 'xyz:DUP'] },
    ], START);
    expect(Object.fromEntries(l.markets)).toEqual({
      BTC: { market: 'BTC', dex: 'standard' },
      kPEPE: { market: 'kPEPE', dex: 'standard' },
      SPCX: { market: 'xyz:SPCX', dex: 'xyz' },
    });
    expect([...l.ambiguous]).toEqual(['DUP']);
  });
});

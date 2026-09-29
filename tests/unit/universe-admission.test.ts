/**
 * OPS-ALARM-SINGLE-DERIVATION-W1 CH2 — ONE admission predicate for every venue universe.
 *
 * THE DEFECT (measured at R0, 2026-09-29): both universe derivations admitted contracts the venue
 * itself had switched off. XT marks 339 of its 1,108 PERPETUAL∧state==0 contracts closed to new
 * positions or past their `offTime` (EPT since 2026-01-30, D since 2026-06-17 — CVP's frozen 24h
 * volume of 27 TRILLION ranked it first in the XT scan universe); HTX's OI feed carries 20 contracts
 * missing from its own `swap_contract_info` (LRDS, OI 1.86e-5 > 0); Aster lists 19 of 589 USDT perps
 * as SETTLING. The uncapped 1h–12h seed lanes evaluated every one of them on every fire.
 *
 * What this suite proves:
 *   1. the declaration record is exhaustive over ExchangeId, and removing a venue FAILS tsc;
 *   2. each kind decides only on explicit venue status, and unknown/absent values ADMIT (counted);
 *   3. stale, no-book and zero-liquidity rows are ADMITTED and counted — never excluded;
 *   4. PARITY: wherever a venue has two fetchers (scan SoT + seed-local) both admit the IDENTICAL
 *      coin set from one shared fixture — the single-derivation proof;
 *   5. the venue circuit, the failed-status path, and the kill switch (legacy byte-identical);
 *   6. isMemeCoinLiquid's live top-50: a switched-off row leaves, the 51st enters, no tradeable row leaves.
 *
 * SPAWN BUDGET DECLARED on the one spawning block (`scripts/check-test-budget.mjs`).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMISSION_SOURCES, admitRow, admitRows, circuitShare, formatAdmissionLine, resolveAdmissionMode,
  type AdmissionRow, type StatusMap,
} from '../../src/lib/universe-admission.js';

const REPO = path.resolve(__dirname, '../..');
const NOW = Date.parse('2026-09-29T06:00:00Z');
const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function exchangeIds(): string[] {
  const src = readFileSync(path.join(REPO, 'src/types.ts'), 'utf8');
  const m = /export type ExchangeId = ([^;]+);/.exec(src);
  if (!m) throw new Error('ExchangeId union not found in src/types.ts');
  return [...m[1].matchAll(/'([A-Z0-9]+)'/g)].map((x) => x[1]).sort();
}

function statusOf(entries: Record<string, Record<string, unknown>>): StatusMap {
  return new Map(Object.entries(entries));
}

describe('the declaration record is exhaustive — a venue without one does not compile', () => {
  it('declares exactly the ExchangeId union', () => {
    expect(Object.keys(ADMISSION_SOURCES).sort()).toEqual(exchangeIds());
  });

  it('tsc FAILS when any one venue is removed, and compiles when none is', { timeout: 120_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'admission-tsc-'));
    tmpDirs.push(dir);
    const union = `export type ExchangeId = ${exchangeIds().map((v) => `'${v}'`).join(' | ')};\n`;
    writeFileSync(path.join(dir, 'types.ts'), union);
    const src = readFileSync(path.join(REPO, 'src/lib/universe-admission.ts'), 'utf8').replace("from '../types.js'", "from './types.js'");
    const tsc = path.join(REPO, 'node_modules/.bin/tsc');
    const compile = (body: string) => {
      writeFileSync(path.join(dir, 'universe-admission.ts'), body);
      return spawnSync(tsc, ['--noEmit', '--strict', '--target', 'ES2022', '--module', 'Node16', '--moduleResolution', 'Node16',
        path.join(dir, 'universe-admission.ts')], { encoding: 'utf8' });
    };
    expect(compile(src).status).toBe(0);
    const removed = src.replace(/\n  WEEX: \{\n[\s\S]*?\n  \},\n/, '\n');
    expect(removed).not.toBe(src);
    const r = compile(removed);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/WEEX/);
  });

  it('every kind is one of the six the spec allows, and every none/retired carries a reason', () => {
    for (const [venue, d] of Object.entries(ADMISSION_SOURCES)) {
      expect(['flags', 'status_field', 'listing', 'legacy_oi_positive', 'none', 'retired']).toContain(d.kind);
      if (d.kind === 'none' || d.kind === 'retired') expect(d.reason.length, venue).toBeGreaterThan(20);
    }
  });
});

describe('admitRow — explicit venue status only; unknown admits', () => {
  it('XT: openSwitch off or a past offTime excludes; tradeSwitch alone does NOT (live TradFi perps)', () => {
    const st = statusOf({
      ept_usdt: { openSwitch: false, tradeSwitch: false, offTime: '2026-01-30T11:00:01.000Z' },
      au200aud_usdt: { openSwitch: true, tradeSwitch: false, offTime: null },
      kioxia_usdt: { openSwitch: false, tradeSwitch: false, offTime: '2026-09-28T13:00:01.000Z' },
      future_usdt: { openSwitch: true, tradeSwitch: true, offTime: '2026-12-01T00:00:00.000Z' },
      nofield_usdt: { tradeSwitch: true },
      pastoff_usdt: { openSwitch: true, tradeSwitch: true, offTime: '2026-09-15T09:00:00.000Z' },
    });
    // a past offTime alone is a switch-off, whatever the switches say
    expect(admitRow('XT', { symbol: 'pastoff_usdt' }, st, NOW)).toEqual({ admit: false, reason: 'venue_disabled' });
    expect(admitRow('XT', { symbol: 'ept_usdt' }, st, NOW)).toEqual({ admit: false, reason: 'venue_disabled' });
    expect(admitRow('XT', { symbol: 'au200aud_usdt' }, st, NOW)).toEqual({ admit: true, reason: 'admitted' });
    expect(admitRow('XT', { symbol: 'kioxia_usdt' }, st, NOW)).toEqual({ admit: false, reason: 'venue_disabled' });
    expect(admitRow('XT', { symbol: 'future_usdt' }, st, NOW)).toEqual({ admit: true, reason: 'admitted' });
    expect(admitRow('XT', { symbol: 'nofield_usdt' }, st, NOW)).toEqual({ admit: true, reason: 'admission_field_absent' });
    expect(admitRow('XT', { symbol: 'absent_usdt' }, st, NOW)).toEqual({ admit: true, reason: 'admission_field_absent' });
  });

  it('HTX (listing): absent from contract_info is venue_disabled; status 1 admits; a present row with no status admits', () => {
    const st = statusOf({ 'BTC-USDT': { contract_status: 1 }, 'SUS-USDT': { contract_status: 3 }, 'ODD-USDT': {} });
    expect(admitRow('HTX', { symbol: 'LRDS-USDT' }, st, NOW)).toEqual({ admit: false, reason: 'venue_disabled' });
    expect(admitRow('HTX', { symbol: 'BTC-USDT' }, st, NOW)).toEqual({ admit: true, reason: 'admitted' });
    expect(admitRow('HTX', { symbol: 'SUS-USDT' }, st, NOW)).toEqual({ admit: false, reason: 'venue_disabled' });
    expect(admitRow('HTX', { symbol: 'ODD-USDT' }, st, NOW)).toEqual({ admit: true, reason: 'admission_field_absent' });
  });

  it('ASTER: SETTLING excludes, TRADING admits, an unknown status value admits', () => {
    const st = statusOf({ TONUSDT: { status: 'SETTLING' }, NVOUSDT: { status: 'TRADING' }, NEWUSDT: { status: 'SOMETHING_NEW' } });
    expect(admitRow('ASTER', { symbol: 'TONUSDT' }, st, NOW).admit).toBe(false);
    // NVO is a genuinely THIN stock perp (K10) — thin is not switched off, and admission never judges liquidity
    expect(admitRow('ASTER', { symbol: 'NVOUSDT', volume24h_usd: 1159 }, st, NOW)).toEqual({ admit: true, reason: 'admitted' });
    expect(admitRow('ASTER', { symbol: 'NEWUSDT' }, st, NOW)).toEqual({ admit: true, reason: 'admission_field_absent' });
  });

  it('WHITEBIT: a FUTURE delistedAt is a schedule, not a switch-off (STORJ, 2026-09-30)', () => {
    const st = statusOf({
      STORJ_PERP: { tradesEnabled: true, delistedAt: 1790760600 },
      OLD_PERP: { tradesEnabled: true, delistedAt: 1780000000 },
      OFF_PERP: { tradesEnabled: false, delistedAt: null },
    });
    expect(admitRow('WHITEBIT', { symbol: 'STORJ_PERP' }, st, NOW).admit).toBe(true);
    expect(admitRow('WHITEBIT', { symbol: 'OLD_PERP' }, st, NOW).admit).toBe(false);
    expect(admitRow('WHITEBIT', { symbol: 'OFF_PERP' }, st, NOW).admit).toBe(false);
  });

  it('HL keeps its historical OI>0 filter as its declaration; none / retired admit everything', () => {
    expect(admitRow('HL', { symbol: 'MATIC', notionalOI_usd: 0 }, null, NOW)).toEqual({ admit: false, reason: 'venue_disabled' });
    expect(admitRow('HL', { symbol: 'BTC', notionalOI_usd: 1e9 }, null, NOW)).toEqual({ admit: true, reason: 'admitted' });
    expect(admitRow('WEEX', { symbol: 'BTCUSDT' }, null, NOW)).toEqual({ admit: true, reason: 'admitted' });
    expect(admitRow('BITMART', { symbol: 'BTCUSDT' }, null, NOW)).toEqual({ admit: true, reason: 'admitted' });
  });

  it('an unavailable status admits the row as field-absent — never an empty universe', () => {
    expect(admitRow('XT', { symbol: 'ept_usdt' }, null, NOW)).toEqual({ admit: true, reason: 'admission_field_absent' });
    expect(admitRow('HTX', { symbol: 'LRDS-USDT' }, null, NOW)).toEqual({ admit: true, reason: 'admission_field_absent' });
  });
});

describe('admitRows — evidence is counted, never used; circuit; kill switch', () => {
  const st = statusOf({
    a_usdt: { openSwitch: true }, b_usdt: { openSwitch: true }, c_usdt: { openSwitch: true },
    d_usdt: { openSwitch: true }, off_usdt: { openSwitch: false },
  });
  const rows: AdmissionRow[] = [
    { symbol: 'a_usdt', volume24h_usd: 1e6, hasBook: true, tickerTsMs: NOW - 60_000 },
    { symbol: 'b_usdt', volume24h_usd: 1e6, hasBook: true, tickerTsMs: NOW - 5 * 86_400_000 }, // stale
    { symbol: 'c_usdt', volume24h_usd: 1e6, hasBook: false, tickerTsMs: NOW - 60_000 },        // no book
    { symbol: 'd_usdt', volume24h_usd: 0, hasBook: true, tickerTsMs: NOW - 60_000 },           // zero liquidity
    { symbol: 'off_usdt', volume24h_usd: 5e7, hasBook: true, tickerTsMs: NOW - 60_000 },       // switched off
  ];

  it('stale, no-book and zero-liquidity rows are ADMITTED and counted; only the switched-off row leaves', () => {
    const { rows: kept, tally } = admitRows('XT', rows, st, NOW, 'enforce', 'sot', 'ok');
    expect(kept.map((r) => r.symbol)).toEqual(['a_usdt', 'b_usdt', 'c_usdt', 'd_usdt']);
    expect(tally).toMatchObject({ admitted: 4, excluded: 1, venueDisabled: 1, tickerStale: 1, noBook: 1, zeroLiquidity: 1, circuitOpen: false });
    expect(formatAdmissionLine(tally)).toBe(
      '[universe-admission] XT admitted 4 excluded 1 (venue_disabled 1 · field_absent 0) evidence(ticker_stale 1 · no_book 1 · zero_liquidity 1) side=sot mode=enforce source=flags status=ok',
    );
  });

  it('the venue circuit admits the legacy set when one fetch would exclude more than max(1.5 × measured, 50%)', () => {
    const allOff = statusOf(Object.fromEntries(rows.map((r) => [r.symbol, { openSwitch: false }])));
    const { rows: kept, tally } = admitRows('XT', rows, allOff, NOW, 'enforce', 'sot', 'ok');
    expect(kept).toHaveLength(rows.length);
    expect(tally.circuitOpen).toBe(true);
    expect(formatAdmissionLine(tally)).toContain('ADMISSION_CIRCUIT_OPEN would_exclude=5 of 5');
    expect(circuitShare('XT')).toBeCloseTo(0.5, 5); // 1.5 × 339/1108 = 0.459 < the 50% floor
  });

  it('legacy mode is byte-identical per side: the seed keeps everything, the SoT keeps only HL\'s filter', () => {
    expect(admitRows('XT', rows, st, NOW, 'legacy', 'seed', 'not_applicable').rows).toEqual(rows);
    expect(admitRows('XT', rows, st, NOW, 'legacy', 'sot', 'not_applicable').rows).toEqual(rows);
    const hl: AdmissionRow[] = [{ symbol: 'BTC', notionalOI_usd: 5 }, { symbol: 'MATIC', notionalOI_usd: 0 }];
    expect(admitRows('HL', hl, null, NOW, 'legacy', 'sot', 'not_applicable').rows.map((r) => r.symbol)).toEqual(['BTC']);
    expect(admitRows('HL', hl, null, NOW, 'legacy', 'seed', 'not_applicable').rows.map((r) => r.symbol)).toEqual(['BTC', 'MATIC']);
  });

  it('the mode resolver defaults to enforce and fails an unknown value toward LEGACY, loudly', () => {
    expect(resolveAdmissionMode(undefined)).toEqual({ mode: 'enforce', warning: null });
    expect(resolveAdmissionMode('enforce')).toEqual({ mode: 'enforce', warning: null });
    expect(resolveAdmissionMode('legacy')).toEqual({ mode: 'legacy', warning: null });
    const odd = resolveAdmissionMode('off');
    expect(odd.mode).toBe('legacy');
    expect(odd.warning).toMatch(/not enforce\|legacy.*LEGACY/);
  });
});

// ── integration: both derivations, one fixture ─────────────────────────────────────────────────

type Route = unknown | ((init?: RequestInit) => unknown);

function jsonResponse(json: unknown): Response {
  return {
    ok: true, status: 200, statusText: 'OK', headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => json, text: async () => JSON.stringify(json),
  } as unknown as Response;
}

/** Route every fetch by URL fragment. An unrouted URL throws — a test must never reach the network. */
function routeFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    for (const [frag, route] of Object.entries(routes)) {
      if (!url.includes(frag)) continue;
      const json = typeof route === 'function' ? (route as (i?: RequestInit) => unknown)(init) : route;
      if (json instanceof Error) throw json;
      return jsonResponse(json);
    }
    throw new Error(`unrouted fetch in test: ${url}`);
  });
  return calls;
}

let logs: string[] = [];
beforeEach(async () => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  delete process.env.UNIVERSE_ADMISSION_MODE;
  const eu = await import('../../src/lib/exchange-universe.js');
  eu._resetAdmissionStatusCacheForTest();
  const bin = await import('../../src/lib/adapters/binance.js');
  bin._resetBinanceAdapterCaches();
  const at = await import('../../src/lib/asset-tiers.js');
  at._clearLiquidCoinsByExchangeCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.UNIVERSE_ADMISSION_MODE;
});

const OLD = NOW - 30 * 86_400_000;
const FRESH = Date.now() - 60_000;

/** XT — the K8 shapes: EPT switched off with a frozen ticker; a live TradFi row with tradeSwitch false. */
const XT_ROUTES: Record<string, Route> = {
  'symbol/list': { result: [
    { symbol: 'btc_usdt', baseCoin: 'btc', contractType: 'PERPETUAL', state: 0, openSwitch: true, tradeSwitch: true, offTime: null },
    { symbol: 'eth_usdt', baseCoin: 'eth', contractType: 'PERPETUAL', state: 0, openSwitch: true, tradeSwitch: true, offTime: null },
    { symbol: 'ept_usdt', baseCoin: 'ept', contractType: 'PERPETUAL', state: 0, openSwitch: false, tradeSwitch: false, offTime: '2026-01-30T11:00:01.000Z' },
    { symbol: 'au200aud_usdt', baseCoin: 'au200aud', contractType: 'PERPETUAL', state: 0, openSwitch: true, tradeSwitch: false, offTime: null },
    { symbol: 'stale_usdt', baseCoin: 'stale', contractType: 'PERPETUAL', state: 0, openSwitch: true, tradeSwitch: true, offTime: null },
    { symbol: 'zero_usdt', baseCoin: 'zero', contractType: 'PERPETUAL', state: 0, openSwitch: true, tradeSwitch: true, offTime: null },
    { symbol: 'nobook_usdt', baseCoin: 'nobook', contractType: 'PERPETUAL', state: 0, openSwitch: true, tradeSwitch: true, offTime: null },
  ] },
  'agg-tickers': { result: [
    { s: 'btc_usdt', v: '1000000', a: '12', t: FRESH, bp: '1', ap: '1.1', r: '0.01' },
    { s: 'eth_usdt', v: '900000', a: '300', t: FRESH, bp: '1', ap: '1.1', r: '0.01' },
    { s: 'ept_usdt', v: '1908522', a: '13681467', t: OLD, bp: '0.0009', ap: '0.0022', r: '0' },
    { s: 'au200aud_usdt', v: '500000', a: '50', t: FRESH, bp: '1', ap: '1.1', r: '0' },
    { s: 'stale_usdt', v: '400000', a: '40', t: OLD, bp: '1', ap: '1.1', r: '0' },
    { s: 'zero_usdt', v: '0', a: '0', t: FRESH, bp: '1', ap: '1.1', r: '0' },
    { s: 'nobook_usdt', v: '300000', a: '30', t: FRESH, r: '0' },
  ] },
};

describe('PARITY — both derivations admit the identical set from ONE fixture', () => {
  it('XT: the scan SoT and the seed-local fetcher agree; only the switched-off row leaves', async () => {
    routeFetch(XT_ROUTES);
    const { fetchVenueUniverse } = await import('../../src/lib/exchange-universe.js');
    const { UNIVERSE_FETCHERS } = await import('../../src/scripts/seed-signals.js');
    const sot = new Set((await fetchVenueUniverse('XT')).map((a) => a.coin));
    const seed = new Set(await UNIVERSE_FETCHERS.XT(0));
    expect([...sot].sort()).toEqual(['AU200AUD', 'BTC', 'ETH', 'NOBOOK', 'STALE', 'ZERO']);
    expect([...seed].sort()).toEqual([...sot].sort());
    const sotLine = logs.find((l) => l.includes('[universe-admission] XT') && l.includes('side=sot')) ?? '';
    expect(sotLine).toContain('excluded 1 (venue_disabled 1');
    // Evidence is counted over EVERY fetched row: the switched-off EPT row carries a frozen ticker too,
    // so ticker_stale is 2 (EPT + STALE) — and STALE, NOBOOK and ZERO are still admitted above.
    expect(sotLine).toContain('evidence(ticker_stale 2 · no_book 1 · zero_liquidity 1)');
    expect(logs.some((l) => l.includes('[universe-admission] XT') && l.includes('side=seed') && l.includes('excluded 1'))).toBe(true);
  });

  it('HL: the SoT filter is unchanged and the seed now applies the SAME one', async () => {
    const meta = [
      { universe: [{ name: 'BTC' }, { name: 'MATIC', isDelisted: true }, { name: 'ETH' }] },
      [
        { openInterest: '10', markPx: '60000', dayNtlVlm: '1', prevDayPx: '60000', funding: '0' },
        { openInterest: '0', markPx: '0.2', dayNtlVlm: '0', prevDayPx: '0.2', funding: '0' },
        { openInterest: '100', markPx: '3000', dayNtlVlm: '1', prevDayPx: '3000', funding: '0' },
      ],
    ];
    routeFetch({
      'api.hyperliquid.xyz/info': (init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { type?: string; dex?: string };
        if (body.type === 'metaAndAssetCtxs' && !body.dex) return meta;
        return new Error('not routed in this fixture');
      },
    });
    const { fetchVenueUniverse } = await import('../../src/lib/exchange-universe.js');
    const { UNIVERSE_FETCHERS } = await import('../../src/scripts/seed-signals.js');
    const sot = (await fetchVenueUniverse('HL')).map((a) => a.coin).sort();
    const seed = (await UNIVERSE_FETCHERS.HL(0)).slice().sort();
    expect(sot).toEqual(['BTC', 'ETH']);
    expect(seed).toEqual(sot);
  });

  it('ASTER: SETTLING leaves the (delegating) seed and the SoT alike', async () => {
    routeFetch({
      'fapi/v1/ticker/24hr': [
        { symbol: 'BTCUSDT', quoteVolume: '1000', closeTime: FRESH },
        { symbol: 'TONUSDT', quoteVolume: '447548', closeTime: OLD },
        { symbol: 'NVOUSDT', quoteVolume: '1159', closeTime: FRESH },
      ],
      'fapi/v1/exchangeInfo': { symbols: [
        { symbol: 'BTCUSDT', status: 'TRADING' }, { symbol: 'TONUSDT', status: 'SETTLING' }, { symbol: 'NVOUSDT', status: 'TRADING' },
      ] },
    });
    const { fetchVenueUniverse } = await import('../../src/lib/exchange-universe.js');
    const { fetchAsterCoins } = await import('../../src/scripts/seed-signals.js');
    expect((await fetchVenueUniverse('ASTER')).map((a) => a.coin).sort()).toEqual(['BTC', 'NVO']);
    expect((await fetchAsterCoins(0)).slice().sort()).toEqual(['BTC', 'NVO']);
  });

  it('HTX: a contract absent from its own contract_info (LRDS) leaves', async () => {
    routeFetch({
      swap_open_interest: { data: [
        { contract_code: 'BTC-USDT', amount: 10, value: 600000 },
        { contract_code: 'LRDS-USDT', amount: 0.00103, value: 1.8643e-5 },
      ] },
      batch_merged: { ticks: [
        { contract_code: 'BTC-USDT', close: 60000, trade_turnover: 1e6, open: 59000, bid: [59999, 1], ask: [60001, 1] },
        { contract_code: 'LRDS-USDT', close: 0.018, trade_turnover: 0, open: 0.018, bid: null, ask: null },
      ] },
      swap_contract_info: { data: [{ contract_code: 'BTC-USDT', contract_status: 1 }] },
    });
    const { fetchVenueUniverse } = await import('../../src/lib/exchange-universe.js');
    const { fetchHtxCoins } = await import('../../src/scripts/seed-signals.js');
    expect((await fetchVenueUniverse('HTX')).map((a) => a.coin)).toEqual(['BTC']);
    expect(await fetchHtxCoins(0)).toEqual(['BTC']);
  });
});

describe('failure goes toward the LEGACY universe, never toward an empty one', () => {
  it('an unreachable status endpoint admits every row and says status=unavailable', async () => {
    routeFetch({ ...XT_ROUTES, 'symbol/list': new Error('ECONNRESET') });
    const { fetchVenueUniverse } = await import('../../src/lib/exchange-universe.js');
    expect((await fetchVenueUniverse('XT')).map((a) => a.coin)).toContain('EPT');
    expect(logs.some((l) => l.includes('XT status unavailable'))).toBe(true);
    expect(logs.some((l) => l.includes('[universe-admission] XT') && l.includes('status=unavailable'))).toBe(true);
  });

  it('the circuit opens on an API change that would empty most of a lane', async () => {
    const list = (XT_ROUTES['symbol/list'] as { result: Record<string, unknown>[] }).result.map((r) => ({ ...r, openSwitch: false }));
    routeFetch({ ...XT_ROUTES, 'symbol/list': { result: list } });
    const { fetchVenueUniverse } = await import('../../src/lib/exchange-universe.js');
    expect((await fetchVenueUniverse('XT'))).toHaveLength(7);
    expect(logs.some((l) => l.includes('ADMISSION_CIRCUIT_OPEN'))).toBe(true);
  });
});

describe('the kill switch — UNIVERSE_ADMISSION_MODE=legacy is byte-identical to today', () => {
  it('legacy admits the switched-off rows on both derivations and makes no status call', async () => {
    process.env.UNIVERSE_ADMISSION_MODE = 'legacy';
    const calls = routeFetch(XT_ROUTES);
    const { fetchVenueUniverse } = await import('../../src/lib/exchange-universe.js');
    const { UNIVERSE_FETCHERS } = await import('../../src/scripts/seed-signals.js');
    const sot = await fetchVenueUniverse('XT');
    // pre-wave fetchXt: every `_usdt` agg-ticker row, v-desc — exactly this order
    expect(sot.map((a) => a.coin)).toEqual(['EPT', 'BTC', 'ETH', 'AU200AUD', 'STALE', 'NOBOOK', 'ZERO']);
    expect(calls.filter((u) => u.includes('symbol/list'))).toHaveLength(0);
    // pre-wave fetchXtCoins: PERPETUAL∧state0 ∩ agg-tickers, a-desc
    expect(await UNIVERSE_FETCHERS.XT(0)).toEqual(['EPT', 'ETH', 'AU200AUD', 'STALE', 'NOBOOK', 'BTC', 'ZERO']);
  });

  it('an unrecognised mode resolves to legacy with a loud line', async () => {
    process.env.UNIVERSE_ADMISSION_MODE = 'off';
    routeFetch(XT_ROUTES);
    const { fetchVenueUniverse } = await import('../../src/lib/exchange-universe.js');
    expect((await fetchVenueUniverse('XT')).map((a) => a.coin)).toContain('EPT');
    expect(logs.some((l) => l.includes('resolving to LEGACY'))).toBe(true);
  });
});

describe('isMemeCoinLiquid — the live get_trade_call top-50', () => {
  it('a switched-off row in the top-50 leaves, the 51st enters, and no tradeable row leaves', async () => {
    const tickers = Array.from({ length: 60 }, (_, i) => ({
      symbol: `C${String(i + 1).padStart(2, '0')}USDT`, quoteVolume: String(200_000_000 - i * 1_000_000),
      lastPrice: '1', openPrice: '1', closeTime: FRESH,
    }));
    routeFetch({
      'fapi/v1/ticker/24hr': tickers,
      'fapi/v1/exchangeInfo': { symbols: tickers.map((t) => ({ symbol: t.symbol, status: t.symbol === 'C10USDT' ? 'SETTLING' : 'TRADING' })) },
    });
    const { getExchangeTopAssetsWithVolume } = await import('../../src/lib/exchange-universe.js');
    const top50 = (await getExchangeTopAssetsWithVolume('BINANCE', 50)).map((a) => a.coin);
    expect(top50).toHaveLength(50);
    expect(top50).not.toContain('C10');
    expect(top50).toContain('C51');
    const expected = Array.from({ length: 51 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`).filter((c) => c !== 'C10');
    expect(top50).toEqual(expected);
    const { isMemeCoinLiquid, _clearLiquidCoinsByExchangeCache } = await import('../../src/lib/asset-tiers.js');
    _clearLiquidCoinsByExchangeCache();
    expect(await isMemeCoinLiquid('C51', 'BINANCE')).toBe(true);
    expect(await isMemeCoinLiquid('C10', 'BINANCE')).toBe(false);
  });
});

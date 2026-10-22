/**
 * SCAN-MARKET-REGIMES-W1-V2 CH2 — the `scan_market_regimes` handler (AC2.1) and the
 * `scan_trade_calls` byte-identity proof for the shared extraction (AC2.2).
 *
 * The handler runs over seams (`RegimeScanHandlerDeps`) — no DB — with the REAL quota meter, so
 * "unbilled" is measured on the meter itself: every refusal leaves `checkQuota().used` unchanged, and
 * a served scan moves it by exactly `max(1, returned)`.
 *
 * AC2.2's goldens were RECORDED from the pre-extraction code (a scratch harness run against
 * origin/main before `scan-shared.ts` existed) and inlined below. They are a measurement of what
 * `scan_trade_calls` emitted, not a reconstruction of it; `toEqual` pins the values and the
 * `JSON.stringify` comparison pins the key ORDER, which is what a byte-identical wire means.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ExchangeAsset } from '../src/lib/exchange-universe.js';
import type { LicenseInfo } from '../src/types.js';

vi.mock('../src/lib/exchange-universe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/exchange-universe.js')>();
  return { ...actual, getExchangeTopAssetsWithVolume: vi.fn(), fetchVenueUniverse: vi.fn() };
});

import { getExchangeTopAssetsWithVolume, fetchVenueUniverse } from '../src/lib/exchange-universe.js';
import { _setScanScorerForTest, _clearScanCaches, _setLiquidityMapForTest, scanTradeCalls } from '../src/lib/trade-call-scanner.js';
import { trackCall, trackCallByKey, checkQuota, _resetCallTrackersForTest, resetLicenseCache } from '../src/lib/license.js';
import { runScanTradeCall } from '../src/tools/scan-trade-calls.js';
import {
  runScanMarketRegimes,
  SCAN_MARKET_REGIMES_SCHEMA,
  type RegimeScanHandlerDeps,
  type ScanMarketRegimesOutcome,
} from '../src/tools/scan-market-regimes.js';
import type { RegimeScannerDeps } from '../src/lib/market-regime-scanner.js';
import type { RegimeSnapshotRow, RegimeSnapshotRunRecord, ServableGeneration } from '../src/lib/regime-snapshots.js';
import { DEFAULT_REGIME_SNAPSHOT_VENUES } from '../src/lib/regime-snapshots.js';
import { SCAN_MARKET_REGIMES_DESCRIPTION } from '../src/tool-descriptions.js';
import { FREE_DAILY_CALLS } from '../src/lib/plans.js';
import { callTool, toMcpToolResult, type ValidatedToolInput } from '../src/lib/tool-call-pipeline.js';
import type { PromotedVenueId } from '../src/lib/capabilities.js';
import { PKG_VERSION } from '../src/lib/pkg-version.js';

const ROOT = join(__dirname, '..');
const H = 3_600_000;
const BAR = Date.parse('2026-10-19T09:00:00.000Z');
const NOW = BAR + 15 * 60_000;
const FORBIDDEN_KEYS = /"(outcome_return_pct|outcome_price|price_at_signal|reasoning)"\s*:/;
const WAVE_ID = /[A-Z]+-W\d+/;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Handler harness
// ─────────────────────────────────────────────────────────────────────────────────────────────

function row(coin: string, confidence: number, regime = 'TRENDING_UP'): RegimeSnapshotRow {
  return {
    exchange: 'BINANCE', timeframe: '1h', bar_close_ms: BAR, coin, regime, confidence,
    trend_strength: 'MODERATE', adx: 28, adx_slope: 0.4, volatility_ratio: 1.05, price_structure: 'MIXED',
    asset_class: 'CRYPTO', underlying_session_at_compute: 'ALWAYS_OPEN', regime_since_ms: BAR - H,
    rule_version: 1, computed_at: BAR + 11 * 60_000,
  };
}
const ROWS = [row('BTC', 81), row('ETH', 66), row('SOL', 52, 'RANGING'), row('DOGE', 74, 'VOLATILE')];

const GEN: ServableGeneration = {
  exchange: 'BINANCE', timeframe: '1h', bar_close_ms: BAR, disposition: 'COMPLETE',
  universe_n: 4, written_n: 4, too_new_n: 0, window_stale_n: 0, coverage: 1, tick_at: BAR + 11 * 60_000, finished_at: BAR + 12 * 60_000,
};

function run(exchange: string, timeframe: string, disposition: RegimeSnapshotRunRecord['disposition']): RegimeSnapshotRunRecord {
  return {
    exchange, timeframe, bar_close_ms: BAR, tick_at: BAR + 11 * 60_000, disposition,
    universe_n: 4, written_n: disposition === 'WINDOW_STALE' ? 0 : 4, too_new_n: 0, window_stale_n: 0, skipped_n: 0, errors_n: 0, finished_at: BAR + 12 * 60_000,
  };
}

/** Record state per `VENUE|TF`: the newest due disposition, and whether a servable generation exists. */
interface PairState { disposition: RegimeSnapshotRunRecord['disposition'] | null; servable: boolean }
function deps(opts: { sampled?: PromotedVenueId[]; pairs?: Record<string, PairState>; generation?: ServableGeneration | null } = {}): RegimeScanHandlerDeps & { reads: string[] } {
  const reads: string[] = [];
  const pairs = opts.pairs ?? {};
  const state = (ex: string, tf: string): PairState => pairs[`${ex}|${tf}`] ?? { disposition: 'COMPLETE', servable: true };
  const scanner: RegimeScannerDeps = {
    latestServableGeneration: async (ex, tf) => { reads.push(`gen:${ex}|${tf}`); return opts.generation === undefined ? (state(ex, tf).servable ? GEN : null) : opts.generation; },
    readGenerationRows: async (ex, tf, bar) => { reads.push(`rows:${ex}|${tf}`); return ROWS.filter((r) => r.bar_close_ms === bar); },
    getRankedUniverse: (async () => []) as RegimeScannerDeps['getRankedUniverse'],
    applyLiquidityFloor: async (_ex, c) => [...c],
    now: () => NOW,
  };
  return {
    reads,
    sampledRegimeVenues: async () => opts.sampled ?? ['BINANCE', 'BYBIT', 'OKX', 'BITGET'],
    latestRunDisposition: async (ex, tf) => {
      reads.push(`disp:${ex}|${tf}`);
      const d = state(ex, tf).disposition;
      return d ? run(ex, tf, d) : null;
    },
    latestServableGeneration: async (ex, tf) => (state(ex, tf).servable ? { ...GEN, exchange: ex, timeframe: tf } : null),
    scanner,
  };
}

let n = 0;
const keyed = (): LicenseInfo => ({ tier: 'free', key: `av_smr_${++n}` });
const used = (lic: LicenseInfo): number => checkQuota(lic).used;

function refusal(o: ScanMarketRegimesOutcome): Record<string, unknown> & { error: string } {
  if (o.kind !== 'refused') throw new Error(`expected a refusal, got ${o.kind}`);
  return o.payload as unknown as Record<string, unknown> & { error: string };
}

beforeEach(() => {
  _resetCallTrackersForTest();
  resetLicenseCache();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => { vi.useRealTimers(); });

// ─────────────────────────────────────────────────────────────────────────────────────────────
// AC2.1 — handler
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('schema', () => {
  const S = z.object(SCAN_MARKET_REGIMES_SCHEMA);

  it('defaults: BINANCE · 4h · all · confidence · limit 20 · offset 0; lens knobs default like scan_trade_calls', () => {
    expect(S.parse({})).toMatchObject({ exchange: 'BINANCE', timeframe: '4h', assetClass: 'all', sortBy: 'confidence', limit: 20, offset: 0, oiChangeWindow: '24h', oiBasis: 'notional' });
    expect(S.parse({}).rankBy).toBeUndefined(); // V2 §0 Q5: no lens default
    expect(S.parse({}).topN).toBeUndefined();
  });

  it('every served enum IS the declaration\'s array (identity, not a copy)', async () => {
    const decl = (await import('../src/lib/tool-param-schema.js')).SCAN_MARKET_REGIMES_PARAM_DECL.enums;
    const opts = (k: keyof typeof SCAN_MARKET_REGIMES_SCHEMA): readonly string[] => {
      let t = SCAN_MARKET_REGIMES_SCHEMA[k] as unknown as z.ZodTypeAny;
      while (!(t instanceof z.ZodEnum)) {
        const d = (t as unknown as { _def: { innerType?: z.ZodTypeAny; type?: z.ZodTypeAny } })._def;
        t = (d.innerType ?? d.type) as z.ZodTypeAny;
      }
      return (t as z.ZodEnum<[string, ...string[]]>).options;
    };
    for (const k of ['exchange', 'timeframe', 'regime', 'assetClass', 'sortBy', 'oiChangeWindow', 'oiBasis'] as const) {
      expect(opts(k), k).toEqual([...decl[k].values]);
    }
  });

  it('bounds refuse at the boundary', () => {
    const bad: Record<string, unknown>[] = [
      { timeframe: '15m' }, { exchange: 'NOPE' }, { regime: [] }, { regime: ['TRENDING_UP', 'TRENDING_DOWN', 'RANGING', 'VOLATILE', 'RANGING'] },
      { regime: ['SIDEWAYS'] }, { minConfidence: 101 }, { maxRegimeAgeBars: 0 }, { maxRegimeAgeBars: 501 }, { maxRegimeAgeBars: 1.5 },
      { assetClass: 'stocks' }, { minLiquidityUsd: -1 }, { coins: [] }, { coins: Array.from({ length: 201 }, (_, i) => `C${i}`) },
      { rankBy: 'x'.repeat(33) }, { topN: 0 }, { topN: 1001 }, { sortBy: 'price' }, { limit: 0 }, { limit: 101 }, { offset: -1 },
    ];
    for (const b of bad) expect(S.safeParse(b).success, JSON.stringify(b)).toBe(false);
    for (const g of [{ regime: ['VOLATILE'] }, { coins: ['BTC'] }, { topN: 1000 }, { maxRegimeAgeBars: 500 }, { limit: 100 }]) {
      expect(S.safeParse(g).success, JSON.stringify(g)).toBe(true);
    }
  });
});

describe('refusals — in order, each UNBILLED', () => {
  it('1a. an unknown lens is invalid_parameter, before any read', async () => {
    const lic = keyed(); const d = deps();
    const p = refusal(await runScanMarketRegimes({ exchange: 'BINANCE', timeframe: '1h', rankBy: 'garbage' }, lic, d));
    expect(p).toMatchObject({ error: 'invalid_parameter', code: 'invalid_parameter', param: 'rankBy' });
    expect(p.valid_values).toContain('funding_negative');
    expect(d.reads).toEqual([]);
    expect(used(lic)).toBe(0);
  });

  it('1b. sortBy rank without rankBy is invalid_parameter', async () => {
    const lic = keyed();
    const p = refusal(await runScanMarketRegimes({ exchange: 'BINANCE', timeframe: '1h', sortBy: 'rank' }, lic, deps()));
    expect(p).toMatchObject({ error: 'invalid_parameter', param: 'sortBy' });
    expect(used(lic)).toBe(0);
  });

  it('3. a venue outside the sampled set is venue_not_sampled, naming the sampled set', async () => {
    const lic = keyed();
    const o = await runScanMarketRegimes({ exchange: 'HL', timeframe: '4h' }, lic, deps());
    const p = refusal(o);
    expect(p).toMatchObject({ error: 'venue_not_sampled', exchange: 'HL', sampled_venues: ['BINANCE', 'BYBIT', 'OKX', 'BITGET'] });
    expect(o.kind === 'refused' && o.status).toBe(400);
    expect(used(lic)).toBe(0);
  });

  it('4. a WINDOW_STALE pair is timeframe_unserved, with alternatives DERIVED from the run record', async () => {
    const lic = keyed();
    const d = deps({
      pairs: {
        'OKX|1h': { disposition: 'WINDOW_STALE', servable: true }, // still holds an OLD generation — unserved anyway
        'OKX|1d': { disposition: 'COMPLETE', servable: false },     // never produced a servable bar → not offered
        'BITGET|1h': { disposition: 'WINDOW_STALE', servable: false },
      },
    });
    const p = refusal(await runScanMarketRegimes({ exchange: 'OKX', timeframe: '1h' }, lic, d));
    expect(p).toMatchObject({
      error: 'timeframe_unserved', code: 'timeframe_unserved', exchange: 'OKX', timeframe: '1h',
      served_timeframes_on_venue: ['4h'], venues_serving_timeframe: ['BINANCE', 'BYBIT'],
    });
    const text = JSON.stringify(p);
    expect(text).not.toMatch(WAVE_ID);            // no internal wave id in ANY field
    expect(text).not.toContain('get_market_regime'); // never the stale path for this pair
    expect(d.reads).not.toContain('rows:OKX|1h');
    expect(used(lic)).toBe(0);
  });

  it('4. a pair that HEALED serves on the next call — nothing is hand-kept', async () => {
    const d = deps({ pairs: { 'OKX|1h': { disposition: 'COMPLETE', servable: true } } });
    const o = await runScanMarketRegimes({ exchange: 'OKX', timeframe: '1h' }, keyed(), d);
    expect(o.kind).toBe('ok');
  });

  it('5. a quota-walled caller gets the SAME wall scan_trade_calls renders, unbilled', async () => {
    const lic = keyed();
    for (let i = 0; i < FREE_DAILY_CALLS; i++) trackCall(lic);
    const before = used(lic);
    const o = await runScanMarketRegimes({ exchange: 'BINANCE', timeframe: '1h' }, lic, deps());
    const p = refusal(o);
    expect(o.kind === 'refused' && o.status).toBe(429);
    expect(p).toMatchObject({ error: 'quota_exhausted', code: 'TIER_LIMIT_REACHED', limit: 'daily' });
    expect(typeof p.retry_after_hours).toBe('number');
    expect((p.quota as { binding: string }).binding).toBe('daily');
    expect(p.suggested_x402).toBeUndefined(); // x402: null — no pay-per-call branch for this tool
    expect((p._algovault as { tool: string }).tool).toBe('scan_market_regimes');
    expect(used(lic)).toBe(before);
    // Same builder, same keys, in the same order, as the scan_trade_calls wall for the same caller.
    const sibling = (await runScanTradeCall({ exchange: 'BINANCE' }, lic)) as unknown as Record<string, unknown>;
    expect(Object.keys(p)).toEqual(Object.keys(sibling));
  });

  it('6. no servable generation is snapshot_stale — refused, never thrown, unbilled', async () => {
    const lic = keyed();
    const o = await runScanMarketRegimes({ exchange: 'BINANCE', timeframe: '1h' }, lic, deps({ generation: null }));
    expect(refusal(o)).toMatchObject({ error: 'snapshot_stale', as_of: null });
    expect(o.kind === 'refused' && o.status).toBe(503);
    expect(used(lic)).toBe(0);
  });

  it('6. an over-age generation is snapshot_stale with its as_of', async () => {
    const old = { ...GEN, bar_close_ms: NOW - 3 * H };
    const p = refusal(await runScanMarketRegimes({ exchange: 'BINANCE', timeframe: '1h' }, keyed(), deps({ generation: old })));
    expect(p).toMatchObject({ error: 'snapshot_stale', as_of: new Date(NOW - 3 * H).toISOString() });
  });
});

describe('7. served scan — billing and envelope', () => {
  it('charges exactly max(1, returned): units === returned', async () => {
    const lic = keyed();
    const o = await runScanMarketRegimes({ exchange: 'BINANCE', timeframe: '1h', minConfidence: 60 }, lic, deps());
    if (o.kind !== 'ok') throw new Error('expected ok');
    expect(o.response.returned).toBe(3);
    expect(used(lic)).toBe(3);
    expect(o.response._algovault.quota.used).toBe(3);
    expect(o.response._algovault.tool).toBe('scan_market_regimes');
    expect((o.response._algovault as unknown as { auth?: unknown }).auth).toBeDefined(); // withAuthState-stamped
  });

  it('a scan that matches nothing still costs the one call it consumed', async () => {
    const lic = keyed();
    const o = await runScanMarketRegimes({ exchange: 'BINANCE', timeframe: '1h', regime: ['TRENDING_DOWN'] }, lic, deps());
    if (o.kind !== 'ok') throw new Error('expected ok');
    expect(o.response.returned).toBe(0);
    expect(used(lic)).toBe(1);
  });

  it('not_found symbols are listed and never billed', async () => {
    const lic = keyed();
    const o = await runScanMarketRegimes({ exchange: 'BINANCE', timeframe: '1h', coins: ['BTC', 'NOPE1', 'NOPE2'] }, lic, deps());
    if (o.kind !== 'ok') throw new Error('expected ok');
    expect(o.response.not_found).toEqual(['NOPE1', 'NOPE2']);
    expect(o.response.returned).toBe(1);
    expect(used(lic)).toBe(1);
  });

  it('the envelope carries the allow-listed fields only', async () => {
    const o = await runScanMarketRegimes({ exchange: 'BINANCE', timeframe: '1h' }, keyed(), deps());
    if (o.kind !== 'ok') throw new Error('expected ok');
    expect(Object.keys(o.response)).toEqual(['exchange', 'timeframe', 'as_of', 'computed_at', 'generation', 'matched', 'returned', 'offset', 'regimes', '_algovault']);
    expect(Object.keys(o.response._algovault)).toEqual(['tool', 'version', 'quota', 'session_id', 'auth']);
    const text = JSON.stringify(o.response);
    expect(text).not.toMatch(FORBIDDEN_KEYS);
    expect(text).not.toMatch(/"funding_rate"\s*:/);
  });

  it('the served shape is the one audits/scan-market-regimes-shape-snapshot-2026-10-19.json declares', async () => {
    const snap = JSON.parse(readFileSync(join(ROOT, 'audits/scan-market-regimes-shape-snapshot-2026-10-19.json'), 'utf8')) as {
      allowed_keys: string[]; generation_value_keys: string[]; regimes_row_keys: string[]; algovault_keys: string[]; forbidden_keys: string[];
    };
    const o = await runScanMarketRegimes({ exchange: 'BINANCE', timeframe: '1h', coins: ['BTC', 'NOPE'] }, keyed(), deps());
    if (o.kind !== 'ok') throw new Error('expected ok');
    for (const k of Object.keys(o.response)) expect(snap.allowed_keys, `top-level ${k}`).toContain(k);
    expect(Object.keys(o.response.generation)).toEqual(snap.generation_value_keys);
    expect(o.response.regimes.length).toBeGreaterThan(0); // vacuity guard: the row check below must see a row
    for (const r of o.response.regimes) expect(Object.keys(r)).toEqual(snap.regimes_row_keys);
    expect(Object.keys(o.response._algovault)).toEqual(snap.algovault_keys);
    const text = JSON.stringify(o.response);
    for (const f of snap.forbidden_keys) expect(text, f).not.toContain(`"${f}":`);
  });

  it('internal / x402 tiers are never charged', async () => {
    for (const tier of ['internal', 'x402'] as const) {
      const o = await runScanMarketRegimes({ exchange: 'BINANCE', timeframe: '1h' }, { tier, key: null }, deps());
      expect(o.kind, tier).toBe('ok');
    }
  });
});

describe('MCP envelope — refusals are isError, through the one pipeline', () => {
  it('an invalid lens refuses before any DB read and renders isError', async () => {
    const outcome = await callTool({
      tool: 'scan_market_regimes',
      input: { exchange: 'BINANCE', timeframe: '4h', rankBy: 'garbage', assetClass: 'all', sortBy: 'confidence', limit: 20, offset: 0 } as unknown as ValidatedToolInput,
      channel: 'mcp',
      license: { tier: 'free', key: null },
    });
    expect(outcome.ok).toBe(false);
    const mcp = toMcpToolResult(outcome);
    expect(mcp.isError).toBe(true);
    expect(JSON.parse(mcp.content[0].text)).toMatchObject({ error: 'invalid_parameter', param: 'rankBy' });
  });
});

describe('description + source contracts', () => {
  it('names exactly the default sampled venues, and states what a row is and how it bills', () => {
    const named = ['Binance', 'Bybit', 'OKX', 'Bitget'];
    expect(DEFAULT_REGIME_SNAPSHOT_VENUES.split(',')).toEqual(named.map((v) => v.toUpperCase()));
    expect(SCAN_MARKET_REGIMES_DESCRIPTION).toContain('Binance, Bybit, OKX and Bitget');
    expect(SCAN_MARKET_REGIMES_DESCRIPTION).toContain('last closed bar');
    expect(SCAN_MARKET_REGIMES_DESCRIPTION).toContain('one call per returned row');
    expect(SCAN_MARKET_REGIMES_DESCRIPTION).toContain('get_market_regime');
    expect(SCAN_MARKET_REGIMES_DESCRIPTION).toMatch(/refused/);
  });

  it('the /docs partial names the SAME sampled venues in one sentence (D8 pin)', () => {
    // The docs and the tool description must never disagree about where rows come from. The display
    // names map 1:1 onto DEFAULT_REGIME_SNAPSHOT_VENUES, pinned by the test above.
    const display: Record<string, string> = { BINANCE: 'Binance', BYBIT: 'Bybit', OKX: 'OKX', BITGET: 'Bitget' };
    const names = DEFAULT_REGIME_SNAPSHOT_VENUES.split(',').map((v) => display[v] ?? v);
    const sentence = `Rows are sampled on ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}.`;
    const partial = readFileSync(join(ROOT, 'docs-src/partials/scan-market-regimes.html'), 'utf8');
    expect(partial).toContain(sentence);
    expect(partial.split('Rows are sampled on').length - 1).toBe(1);
  });

  it('claims no zero cost, no real-time data, no performance or edge', () => {
    expect(SCAN_MARKET_REGIMES_DESCRIPTION).not.toMatch(/zero cost|no cost|free of charge|real[- ]time|live data|win rate|accura|edge|outperform|\d+%/i);
    expect(SCAN_MARKET_REGIMES_DESCRIPTION).not.toMatch(/intelligence layer|powerful|seamless|robust|cutting-edge|industry-leading/i);
    expect(SCAN_MARKET_REGIMES_DESCRIPTION).not.toMatch(WAVE_ID);
  });

  it('every _algovault envelope site in the tool module is stamped with withAuthState', () => {
    const src = readFileSync(join(ROOT, 'src/tools/scan-market-regimes.ts'), 'utf8')
      .replace(/^[ \t]*\/\/.*$/gm, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ');
    const stamped = (src.match(/_algovault:\s*(?:license\s*\?\s*)?withAuthState\(/g) ?? []).length;
    const constructed = (src.match(/_algovault:\s*(?:withAuthState\(|\{|license\s*\?)/g) ?? []).length;
    expect(constructed).toBeGreaterThanOrEqual(7); // vacuity guard: 6 refusals + the served envelope
    expect(stamped).toBe(constructed);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// AC2.2 — scan_trade_calls is byte-identical after the shared extraction
// ─────────────────────────────────────────────────────────────────────────────────────────────

const ASSETS: ExchangeAsset[] = [
  { coin: 'BTC', notionalOI_usd: 9e9, volume24h_usd: 3e9, changePct24h: 1.5 },
  { coin: 'ETH', notionalOI_usd: 5e9, volume24h_usd: 4e9, changePct24h: -2.25 },
  { coin: 'SOL', notionalOI_usd: 2e9, volume24h_usd: 1e9, changePct24h: 4.1 },
  { coin: 'THIN', notionalOI_usd: 2e5, volume24h_usd: 9e9, changePct24h: 30 },
] as ExchangeAsset[];

/** Recorded from the pre-extraction code — see the header. */
const GOLDEN_RECORDED: Record<string, unknown> = {
  "monthlyWallKeyless": {
    "error": "quota_exhausted",
    "code": "TIER_LIMIT_REACHED",
    "message": "Free monthly quota used: 1000/200. Access returns 2026-11-18 (30 days).\nRecommended for sustained volume: Starter — 10,000 calls/month, card required: https://api.algovault.com/signup?plan=starter&upgrade_from=limit\nKeep going free: refer a friend — you both get 500 bonus calls. Claim a free key — one call, no email. Your usage carries over, so nothing resets. → https://api.algovault.com/api/start-free",
    "quota": {
      "used": 1000,
      "total": 200,
      "remaining": 0,
      "resets_at": "2026-11-18T10:00:00.000Z",
      "binding": "monthly"
    },
    "usage_display": "1000/200",
    "resets_at": "2026-11-18T10:00:00.000Z",
    "retry_after_days": 30,
    "limit": "monthly",
    "recommended_path": "subscription",
    "suggested_action": "Subscribe to Starter (10,000 calls/month) at https://api.algovault.com/signup?plan=starter&upgrade_from=limit, or wait until 2026-11-18 for the free quota to reset.",
    "referral_hint": {
      "cta": "Create a free account to get your referral link — you both get 500 bonus calls",
      "link_or_path": "https://api.algovault.com/signup?upgrade_from=limit_referral",
      "bonus_calls": 500,
      "from": "limit"
    },
    "_algovault": {
      "tool": "scan_trade_calls",
      "version": "__PKG_VERSION__",
      "session_id": null,
      "auth": {
        "outcome": "ABSENT",
        "presented": false,
        "tier": "free"
      },
      "claim_url": "https://api.algovault.com/welcome?utm_source=mcp&utm_medium=envelope&utm_campaign=claim",
      "claim_hint": "Sign in to keep this key and get a heads-up before the cap."
    }
  },
  "dailyWallKeyed": {
    "error": "quota_exhausted",
    "code": "TIER_LIMIT_REACHED",
    "message": "Free daily quota used: 100/100. Access returns at 00:00 UTC (14 hours).\nRecommended for sustained volume: Starter — 10,000 calls/month, card required: https://api.algovault.com/signup?plan=starter&upgrade_from=limit\nRefer a friend — you both get 500 bonus calls toward your monthly allowance. Your link: algovault.com/join?ref=XLJK5X5D",
    "quota": {
      "used": 100,
      "total": 200,
      "remaining": 100,
      "resets_at": "2026-11-18T10:00:00.000Z",
      "daily": {
        "used": 100,
        "total": 100,
        "remaining": 0,
        "resets_at": "2026-10-20T00:00:00.000Z"
      },
      "binding": "daily"
    },
    "usage_display": "100/100",
    "resets_at": "2026-10-20T00:00:00.000Z",
    "retry_after_days": 1,
    "limit": "daily",
    "retry_after_hours": 14,
    "recommended_path": "subscription",
    "suggested_action": "Subscribe to Starter (10,000 calls/month) at https://api.algovault.com/signup?plan=starter&upgrade_from=limit, or wait until 00:00 UTC for the daily allowance to reset.",
    "referral_hint": {
      "cta": "Refer a friend — you both get 500 bonus calls",
      "link_or_path": "https://algovault.com/join?ref=XLJK5X5D",
      "bonus_calls": 500,
      "from": "limit"
    },
    "_algovault": {
      "tool": "scan_trade_calls",
      "version": "__PKG_VERSION__",
      "session_id": null,
      "auth": {
        "outcome": "RESOLVED",
        "presented": true,
        "tier": "free"
      }
    }
  },
  "servedAlgovault": {
    "tool": "scan_trade_calls",
    "version": "__PKG_VERSION__",
    "quota": {
      "used": 7,
      "total": 200,
      "remaining": 193,
      "resets_at": "2026-11-18T10:00:00.000Z",
      "daily": {
        "used": 7,
        "total": 100,
        "remaining": 93,
        "resets_at": "2026-10-20T00:00:00.000Z"
      },
      "binding": "daily"
    },
    "compatible_with": [],
    "signal_performance": "PFE win-rate track record: performance://signal-performance resource (or GET /api/performance-public).",
    "session_id": null,
    "auth": {
      "outcome": "RESOLVED",
      "presented": true,
      "tier": "free"
    }
  },
  "servedCalls": [
    {
      "coin": "THIN",
      "timeframe": "15m",
      "exchange": "BINANCE",
      "call": "BUY",
      "confidence": 80,
      "regime": "TRENDING_UP"
    },
    {
      "coin": "BTC",
      "timeframe": "15m",
      "exchange": "BINANCE",
      "call": "BUY",
      "confidence": 70,
      "regime": "TRENDING_UP"
    },
    {
      "coin": "ETH",
      "timeframe": "15m",
      "exchange": "BINANCE",
      "call": "SELL",
      "confidence": 70,
      "regime": "TRENDING_UP"
    },
    {
      "coin": "SOL",
      "timeframe": "15m",
      "exchange": "BINANCE",
      "call": "BUY",
      "confidence": 70,
      "regime": "TRENDING_UP"
    }
  ],
  "floorVolumeLens": {
    "scanned": 3,
    "eligible_non_hold": 3,
    "holds": 0,
    "errors": 0,
    "partial": false,
    "calls": [
      {
        "coin": "ETH",
        "timeframe": "1h",
        "exchange": "BINANCE",
        "call": "SELL",
        "confidence": 70,
        "regime": "TRENDING_UP",
        "rank_value": 4000000000,
        "volume_24h": 4000000000
      },
      {
        "coin": "BTC",
        "timeframe": "1h",
        "exchange": "BINANCE",
        "call": "BUY",
        "confidence": 70,
        "regime": "TRENDING_UP",
        "rank_value": 3000000000,
        "volume_24h": 3000000000
      },
      {
        "coin": "SOL",
        "timeframe": "1h",
        "exchange": "BINANCE",
        "call": "BUY",
        "confidence": 70,
        "regime": "TRENDING_UP",
        "rank_value": 1000000000,
        "volume_24h": 1000000000
      }
    ]
  },
  "floorGainersLens": {
    "scanned": 3,
    "eligible_non_hold": 3,
    "holds": 0,
    "errors": 0,
    "partial": false,
    "calls": [
      {
        "coin": "SOL",
        "timeframe": "1h",
        "exchange": "BINANCE",
        "call": "BUY",
        "confidence": 70,
        "regime": "TRENDING_UP",
        "rank_value": 4.1,
        "change_24h_pct": 4.1
      },
      {
        "coin": "BTC",
        "timeframe": "1h",
        "exchange": "BINANCE",
        "call": "BUY",
        "confidence": 70,
        "regime": "TRENDING_UP",
        "rank_value": 1.5,
        "change_24h_pct": 1.5
      },
      {
        "coin": "ETH",
        "timeframe": "1h",
        "exchange": "BINANCE",
        "call": "SELL",
        "confidence": 70,
        "regime": "TRENDING_UP",
        "rank_value": -2.25,
        "change_24h_pct": -2.25
      }
    ]
  },
  "floorDenyAll": {
    "scanned": 0,
    "eligible_non_hold": 0,
    "holds": 0,
    "errors": 0,
    "partial": false,
    "calls": []
  }
};

/** The release-owned version is not part of the extraction under test; it is substituted, never pinned. */
const GOLDEN = JSON.parse(JSON.stringify(GOLDEN_RECORDED).replaceAll('__PKG_VERSION__', PKG_VERSION)) as Record<string, unknown>;

describe('AC2.2 — scan_trade_calls byte-identity (goldens recorded before the extraction)', () => {
  it('quota walls, the served quota block, the liquidity floor and the lens echo are unchanged', async () => {
    vi.setSystemTime(new Date('2026-10-19T10:00:00.000Z'));
    vi.mocked(getExchangeTopAssetsWithVolume).mockImplementation((_ex, k: number) => Promise.resolve(ASSETS.slice(0, k)));
    vi.mocked(fetchVenueUniverse).mockResolvedValue(ASSETS);
    const scorer = async (coin: string, timeframe: string) => ({
      coin, timeframe, call: (coin === 'ETH' ? 'SELL' : 'BUY') as 'BUY' | 'SELL', confidence: coin.length * 10 + 40, regime: 'TRENDING_UP' as const,
    });
    const out: Record<string, unknown> = {};

    _resetCallTrackersForTest(); resetLicenseCache(); _clearScanCaches(); _setScanScorerForTest(scorer);
    trackCallByKey('free:anon', 'free', 1000);
    out.monthlyWallKeyless = await runScanTradeCall({ exchange: 'BINANCE' }, { tier: 'free', key: null });

    _resetCallTrackersForTest(); resetLicenseCache(); _clearScanCaches(); _setScanScorerForTest(scorer);
    const walled: LicenseInfo = { tier: 'free', key: 'av_golden_daily_wall' };
    for (let i = 0; i < FREE_DAILY_CALLS; i++) trackCall(walled);
    out.dailyWallKeyed = await runScanTradeCall({ exchange: 'BINANCE' }, walled);

    _resetCallTrackersForTest(); resetLicenseCache(); _clearScanCaches(); _setScanScorerForTest(scorer);
    const served: LicenseInfo = { tier: 'free', key: 'av_golden_served' };
    trackCall(served, 3);
    const r = (await runScanTradeCall({ exchange: 'BINANCE', topN: 4, limit: 10 }, served)) as { _algovault: unknown; calls: unknown };
    out.servedAlgovault = r._algovault;
    out.servedCalls = r.calls;

    _clearScanCaches(); _setScanScorerForTest(scorer);
    _setLiquidityMapForTest(() => new Map([['BTC', 9e9], ['ETH', 5e9], ['SOL', 2e9], ['THIN', 2e5]]));
    out.floorVolumeLens = await scanTradeCalls({ exchange: 'BINANCE', timeframe: '1h', topN: 4, rankBy: 'volume', minLiquidityUsd: 1e9 });
    out.floorGainersLens = await scanTradeCalls({ exchange: 'BINANCE', timeframe: '1h', topN: 4, rankBy: 'gainers', minLiquidityUsd: 1e6 });
    _setLiquidityMapForTest(() => new Map());
    out.floorDenyAll = await scanTradeCalls({ exchange: 'BINANCE', timeframe: '1h', topN: 4, minLiquidityUsd: 1 });
    _setLiquidityMapForTest(null);
    _setScanScorerForTest(null);

    expect(out).toEqual(GOLDEN);
    expect(JSON.stringify(out)).toBe(JSON.stringify(GOLDEN)); // key ORDER — what byte-identical means on the wire
  });
});

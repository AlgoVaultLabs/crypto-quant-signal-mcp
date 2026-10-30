/**
 * DECISION-CALL-V1-W2 R5 — `runPreTradeCheck`, the `pre_trade_check` handler.
 *
 * AC1: the refusal ORDER (each refusal tested with every later refusal's condition also true), every
 * refusal unbilled, exactly one unit on success (a WAIT included), zero forbidden keys anywhere in the
 * response, and the exact allow-list. AC2: 50 calls inside one cache TTL, 10 of them concurrent and
 * cold, cost at most one fetch per funding adapter and per venue universe — driven through the REAL
 * shared caches of `venue-market-state.ts` with only the network edge mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../src/lib/exchange-adapter.js', () => ({ getAdapter: vi.fn() }));
vi.mock('../../src/lib/exchange-universe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/exchange-universe.js')>();
  return { ...actual, fetchVenueUniverse: vi.fn() };
});

import { getAdapter } from '../../src/lib/exchange-adapter.js';
import { fetchVenueUniverse, type ExchangeAsset } from '../../src/lib/exchange-universe.js';
import {
  runPreTradeCheck,
  toPreTradeCheckResponse,
  DEFAULT_PRE_TRADE_CHECK_DEPS,
  PRE_TRADE_DATA_RETRY_AFTER_SECONDS,
  type PreTradeCheckDeps,
  type PreTradeCheckParams,
  type PreTradeCheckResponse,
} from '../../src/tools/pre-trade-check.js';
import { _resetVenueMarketStateCaches, type VenueUniverseState, type MergedFundingSnapshot, type VenueFundingRow } from '../../src/lib/venue-market-state.js';
import { checkQuota, trackCall, _resetCallTrackersForTest, resetLicenseCache } from '../../src/lib/license.js';
import { FREE_DAILY_CALLS } from '../../src/lib/plans.js';
import { TierLimitReachedError } from '../../src/lib/errors.js';
import { classifyUnderlyingSession, isClosedState } from '../../src/lib/market-sessions.js';
import { rankVenues, decide } from '../../src/lib/pre-trade-decision.js';
import type { ExchangeAdapter, ExchangeId, FundingData, LicenseInfo } from '../../src/types.js';
import type { RegimeSnapshotRow, ServableGeneration } from '../../src/lib/regime-snapshots.js';

const H = 3_600_000;
const NOW = Date.parse('2026-10-30T12:00:00Z');
const VENUES = ['BINANCE', 'BYBIT', 'OKX', 'BITGET'] as const;
const VENUE_STRING: Record<string, string> = { BINANCE: 'BinPerp', BYBIT: 'BybitPerp', OKX: 'OKXPerp', BITGET: 'BitgetPerp', HL: 'HlPerp' };
const INTERNAL: LicenseInfo = { tier: 'internal', key: null, outcome: 'RESOLVED' } as LicenseInfo;

const asset = (coin: string, over: Partial<ExchangeAsset> = {}): ExchangeAsset =>
  ({ coin, notionalOI_usd: 5e8, volume24h_usd: 1e10, ...over }) as ExchangeAsset;
const fundRow = (exchange: string, rate = 0.0001, next = NOW + 4 * H): VenueFundingRow =>
  ({ venue: VENUE_STRING[exchange], fundingRate: rate, nextFundingTime: next, intervalHours: 8 }) as VenueFundingRow;

interface Harness {
  deps: PreTradeCheckDeps;
  universeReads: string[];
  fundingSkips: ReadonlySet<string>[];
  regimeReads: string[];
}

/** A healthy world: BTC on all four venues, funding on all four, a fresh RANGING regime everywhere. */
function harness(over: {
  universes?: Partial<Record<string, VenueUniverseState>>;
  funding?: Partial<Record<string, VenueFundingRow | null>>;
  failedFunding?: string[];
  retired?: string[];
  generation?: (venue: string) => ServableGeneration | null;
  regimeRow?: (venue: string) => Partial<RegimeSnapshotRow> | null;
  assetClass?: string;
  now?: number;
} = {}): Harness {
  const now = over.now ?? NOW;
  const h: Harness = { universeReads: [], fundingSkips: [], regimeReads: [], deps: undefined as unknown as PreTradeCheckDeps };
  const fundingRows = VENUES.map((v) => (over.funding && v in over.funding ? over.funding[v] : fundRow(v))).filter(Boolean) as VenueFundingRow[];
  h.deps = {
    now: () => now,
    retiredVenues: async () => new Set(over.retired ?? []),
    venueUniverse: async (e) => {
      h.universeReads.push(e);
      return over.universes?.[e] ?? { rows: [asset('BTC'), asset('ETH')], failed: false };
    },
    fundingSnapshot: async (skip) => {
      h.fundingSkips.push(skip);
      const snap: MergedFundingSnapshot = { byCoin: new Map([['BTC', fundingRows]]), failedVenues: new Set((over.failedFunding ?? []) as ExchangeId[]) };
      return snap;
    },
    sampledRegimeVenues: async () => [...VENUES],
    latestServableGeneration: async (venue) => (over.generation
      ? over.generation(venue)
      : { exchange: venue, timeframe: '4h', bar_close_ms: now - H, disposition: 'COMPLETE', universe_n: 1, written_n: 1, too_new_n: 0, window_stale_n: 0, coverage: 1, tick_at: now - H, finished_at: now - H }),
    readGenerationRow: async (venue, _tf, bar, coin) => {
      h.regimeReads.push(venue);
      const r = over.regimeRow ? over.regimeRow(venue) : {};
      return r === null ? null : ({ exchange: venue, timeframe: '4h', bar_close_ms: bar, coin, regime: 'RANGING', confidence: 50, ...r } as RegimeSnapshotRow);
    },
    resolveAssetClass: async () => (over.assetClass ?? 'CRYPTO') as never,
    venueStatus: async () => 'promoted',
  };
  return h;
}

const P = (over: Partial<PreTradeCheckParams> = {}): PreTradeCheckParams => ({ coin: 'BTC', side: 'long', sizeUsd: 10_000, ...over });

let n = 0;
const freeLicense = (): LicenseInfo => ({ tier: 'free', key: `av_ptc_${++n}`, outcome: 'RESOLVED' } as LicenseInfo);
function walled(): LicenseInfo {
  const lic = freeLicense();
  for (let i = 0; i < FREE_DAILY_CALLS; i++) trackCall(lic);
  expect(checkQuota(lic).allowed, 'fixture must be walled').toBe(false);
  return lic;
}

async function ok(p: PreTradeCheckParams, h = harness(), lic: LicenseInfo = freeLicense()): Promise<PreTradeCheckResponse> {
  const out = await runPreTradeCheck(p, lic, h.deps);
  if (out.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(out.payload)}`);
  return out.response;
}

/** Every key at every depth (arrays walked). */
function allKeys(x: unknown, out: string[] = []): string[] {
  if (Array.isArray(x)) for (const v of x) allKeys(v, out);
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { out.push(k); allKeys(v, out); }
  return out;
}

const TOP_KEYS = ['coin', 'side', 'size_usd', 'hold_hours', 'timeframe', 'decision', 'reasons', 'best_venue', 'size_limit_usd',
  'size_limit_usd_total', 'split', 'timing', 'regime', 'underlying_session', 'venues', 'assumptions', 'fee_table_verified_at',
  'rule_version', 'as_of', '_algovault'];
const VENUE_KEYS = ['exchange', 'listed', 'excluded', 'liquidity_usd', 'volume_24h_usd', 'capacity_usd', 'size_pct_of_24h_volume',
  'funding_rate', 'funding_interval_hours', 'funding_interval_basis', 'next_funding_at', 'funding_events_in_hold', 'funding_cost_bps',
  'taker_fee_bps', 'round_trip_fee_bps', 'est_cost_bps', 'est_cost_usd', 'spread_bps', 'spread_basis'];
const FORBIDDEN = ['call', 'verdict', 'reasoning', 'price_at_signal'];

beforeEach(() => { _resetCallTrackersForTest(); resetLicenseCache(); });

describe('success — one decision, one unit', () => {
  it('a healthy BTC long: GO, four venues priced, the cheapest is best, the regime from the best venue', async () => {
    const lic = freeLicense();
    const before = checkQuota(lic).used;
    const r = await ok(P(), harness(), lic);
    expect(checkQuota(lic).used - before, 'exactly one unit').toBe(1);
    expect(r.decision).toBe('GO');
    expect(r.reasons).toEqual([]);
    expect(r.venues.map((v) => v.exchange)).toEqual([...VENUES]);
    expect(r.venues.every((v) => v.excluded === null && v.funding_interval_basis === 'contract')).toBe(true);
    // BINANCE and OKX tie at 5 bp taker → META order.
    expect(r.best_venue).toEqual({ exchange: 'BINANCE', est_cost_bps: 11, est_cost_usd: 11, capacity_usd: 10_000_000 });
    expect(r.regime).toEqual({ label: 'RANGING', confidence: 50, timeframe: '4h', as_of: new Date(NOW - H).toISOString(), source_exchange: 'BINANCE' });
    expect(r.timing).toEqual({ exchange: 'BINANCE', next_funding_at: new Date(NOW + 4 * H).toISOString(), minutes_to_next_funding: 240, side_pays_next_funding: true, saving_bps_if_entered_after_next_funding: 0 });
    expect(r.underlying_session).toBe('ALWAYS_OPEN');
    expect([r.rule_version, r.as_of, r.fee_table_verified_at]).toEqual([1, new Date(NOW).toISOString(), '2026-10-24']);
    expect(r.assumptions).toEqual({ funding: 'current rate held for the whole hold', fees: 'base-tier taker, no discounts; per-pair exceptions not modelled', size_guard_pct_of_24h_volume: 0.1 });
    expect(r._algovault).toMatchObject({ tool: 'pre_trade_check', exchange: 'BINANCE', venue_status: 'promoted', auth: expect.any(Object) });
    expect(r._algovault.quota).toBeDefined();
  });

  it('exact allow-list: the top level, every venue row, and nothing else', async () => {
    const r = await ok(P({ sizeUsd: 30_000_000 }));
    expect(Object.keys(r)).toEqual(TOP_KEYS);
    for (const v of r.venues) expect(Object.keys(v)).toEqual(VENUE_KEYS);
    expect(Object.keys(r.best_venue!)).toEqual(['exchange', 'est_cost_bps', 'est_cost_usd', 'capacity_usd']);
    expect(Object.keys(r.timing!)).toEqual(['exchange', 'next_funding_at', 'minutes_to_next_funding', 'side_pays_next_funding', 'saving_bps_if_entered_after_next_funding']);
    expect(Object.keys(r.regime!)).toEqual(['label', 'confidence', 'timeframe', 'as_of', 'source_exchange']);
    expect(r.split!.length).toBe(3);
    for (const l of r.split!) expect(Object.keys(l)).toEqual(['exchange', 'size_usd', 'est_cost_bps']);
    for (const x of r.reasons) expect(Object.keys(x)).toEqual(['code', 'severity', 'detail']);
  });

  it('zero forbidden keys at any depth, and no proposed side', async () => {
    const r = await ok(P({ sizeUsd: 30_000_000 }));
    const keys = allKeys(r);
    for (const f of FORBIDDEN) expect(keys, f).not.toContain(f);
    expect(keys.filter((k) => k.startsWith('outcome_'))).toEqual([]);
    expect(r.side).toBe('long'); // echoed, never chosen
  });

  it('a WAIT is a decision: billed one unit', async () => {
    const thin = { rows: [asset('BTC', { notionalOI_usd: 10 })], failed: false };
    const lic = freeLicense();
    const r = await ok(P(), harness({ universes: { BINANCE: thin, BYBIT: thin, OKX: thin, BITGET: thin } }), lic);
    expect(r.decision).toBe('WAIT');
    expect(r.best_venue).toBeNull();
    expect(r._algovault.exchange).toBeUndefined();
    expect(checkQuota(lic).used).toBe(1);
  });

  it('coin is trimmed and upper-cased; exchanges narrows to those venues in META order', async () => {
    const h = harness();
    const r = await ok(P({ coin: ' btc ', exchanges: ['OKX', 'BINANCE'] }), h);
    expect(r.coin).toBe('BTC');
    expect(r.venues.map((v) => v.exchange)).toEqual(['BINANCE', 'OKX']);
    expect(h.universeReads.sort()).toEqual(['BINANCE', 'OKX']);
  });

  it('the funding snapshot skips every adapter that feeds no priced venue, and the retired', async () => {
    const h = harness({ retired: ['BITGET'] });
    await ok(P(), h);
    expect([...h.fundingSkips[0]].sort()).toEqual(['ASTER', 'BITGET', 'GATE', 'HL', 'KUCOIN']);
  });
});

describe('regime — best venue, else the next sampled venue; fresh only', () => {
  it('a stale best-venue generation falls through to the next sampled venue', async () => {
    const h = harness({
      generation: (v) => ({ exchange: v, timeframe: '4h', bar_close_ms: v === 'BINANCE' ? NOW - 9 * H : NOW - H } as ServableGeneration),
    });
    const r = await ok(P(), h);
    expect(r.regime?.source_exchange).toBe('BYBIT');
    expect(h.regimeReads).toEqual(['BYBIT']); // the stale generation was never read
  });
  it('no row for the coin on the best venue: the next one', async () => {
    const r = await ok(P(), harness({ regimeRow: (v) => (v === 'BINANCE' ? null : { regime: 'TRENDING_DOWN', confidence: 65 }) }));
    expect(r.regime).toMatchObject({ label: 'TRENDING_DOWN', confidence: 65, source_exchange: 'BYBIT' });
    expect(r.decision).toBe('CAUTION');
    expect(r.reasons.map((x) => x.code)).toEqual(['REGIME_AGAINST_SIDE']);
  });
  it('none fresh anywhere: regime null, REGIME_UNAVAILABLE, still GO', async () => {
    const r = await ok(P(), harness({ generation: () => null }));
    expect(r.regime).toBeNull();
    expect(r.reasons.map((x) => x.code)).toEqual(['REGIME_UNAVAILABLE']);
    expect(r.decision).toBe('GO');
  });
});

describe('session — as get_market_regime classifies it', () => {
  it('a closed underlying market adjusts', async () => {
    const sunday = Date.parse('2026-11-01T15:00:00Z');
    const expected = classifyUnderlyingSession({ assetClass: 'EQUITY', at: new Date(sunday) }).state;
    expect(isClosedState(expected), 'fixture: a Sunday must be closed for US equity').toBe(true);
    const r = await ok(P(), harness({ assetClass: 'EQUITY', now: sunday }));
    expect(r.underlying_session).toBe(expected);
    expect(r.reasons.map((x) => x.code)).toContain('UNDERLYING_CLOSED');
  });
});

describe('refusals — in contract order, all unbilled', () => {
  async function refused(p: PreTradeCheckParams, h: Harness, lic: LicenseInfo) {
    const before = checkQuota(lic).used;
    const out = await runPreTradeCheck(p, lic, h.deps);
    expect(checkQuota(lic).used, 'a refusal is never billed').toBe(before);
    if (out.kind !== 'refused') throw new Error('expected a refusal');
    return out;
  }
  const dataDown = () => harness({ universes: Object.fromEntries(VENUES.map((v) => [v, { rows: [], failed: true }])) });

  it('1. invalid_parameter beats an unsupported venue, the quota wall and dead data', async () => {
    const h = dataDown();
    const out = await refused(P({ side: 'up', exchanges: ['HL'] }), h, walled());
    expect([out.status, out.payload.error]).toEqual([400, 'invalid_parameter']);
    expect(out.payload).toMatchObject({ code: 'invalid_parameter', param: 'side', _algovault: { tool: 'pre_trade_check', auth: expect.any(Object) } });
    expect(h.universeReads).toEqual([]);
  });

  it('2. venue_not_supported beats the quota wall — and lists the four priced venues', async () => {
    const h = dataDown();
    const out = await refused(P({ exchanges: ['HL'] }), h, walled());
    expect([out.status, out.payload.error]).toEqual([400, 'venue_not_supported']);
    expect(out.payload).toMatchObject({ requested: ['HL'], supported_venues: ['BINANCE', 'BYBIT', 'OKX', 'BITGET'] });
    expect(h.universeReads).toEqual([]);
  });

  it('a retired venue is not supported, even when named', async () => {
    const out = await refused(P({ exchanges: ['OKX'] }), harness({ retired: ['OKX'] }), freeLicense());
    expect(out.payload).toMatchObject({ error: 'venue_not_supported', supported_venues: ['BINANCE', 'BYBIT', 'BITGET'] });
  });

  it('3. the quota wall (TierLimitReachedError, as get_market_regime) beats dead data — before any read', async () => {
    const h = dataDown();
    const lic = walled();
    const before = checkQuota(lic).used;
    await expect(runPreTradeCheck(P(), lic, h.deps)).rejects.toBeInstanceOf(TierLimitReachedError);
    await runPreTradeCheck(P(), lic, h.deps).catch((e: TierLimitReachedError) => {
      expect(e.tool).toBe('pre_trade_check');
    });
    expect(checkQuota(lic).used).toBe(before);
    expect(h.universeReads).toEqual([]);
  });

  it(`4. data_unavailable {retry_after_seconds: ${PRE_TRADE_DATA_RETRY_AFTER_SECONDS}} beats coin_not_listed`, async () => {
    const out = await refused(P({ coin: 'NOTACOIN123' }), dataDown(), freeLicense());
    expect([out.status, out.payload]).toMatchObject([503, { error: 'data_unavailable', retry_after_seconds: 30 }]);
  });

  it('data_unavailable when every funding feed is down too (no venue usable)', async () => {
    const out = await refused(P(), harness({ failedFunding: [...VENUES] }), freeLicense());
    expect(out.payload.error).toBe('data_unavailable');
  });

  it('data_unavailable — not coin_not_listed — when no read venue lists it but one venue could not be read', async () => {
    const out = await refused(P({ coin: 'NOTACOIN123' }), harness({ universes: { OKX: { rows: [], failed: true } } }), freeLicense());
    expect(out.payload.error).toBe('data_unavailable');
  });

  it('5. coin_not_listed when every venue was read and none lists it', async () => {
    const out = await refused(P({ coin: 'NOTACOIN123' }), harness(), freeLicense());
    expect([out.status, out.payload]).toMatchObject([404, { error: 'coin_not_listed', coin: 'NOTACOIN123', supported_venues: ['BINANCE', 'BYBIT', 'OKX', 'BITGET'] }]);
  });

  it('one venue down is info, not a refusal', async () => {
    const r = await ok(P(), harness({ universes: { OKX: { rows: [], failed: true } } }));
    expect(r.reasons.map((x) => x.code)).toEqual(['VENUES_UNAVAILABLE']);
    expect(r.venues.find((v) => v.exchange === 'OKX')).toMatchObject({ listed: null, excluded: 'feed_unavailable' });
  });
});

describe('invalid_parameter — the declaration\'s bounds, held on every channel', () => {
  const bad: Array<[string, Partial<PreTradeCheckParams>]> = [
    ['coin', { coin: '   ' }], ['coin', { coin: 'X'.repeat(21) }], ['coin', { coin: 7 as unknown as string }],
    ['side', { side: 'buy' }],
    ['sizeUsd', { sizeUsd: 0 }], ['sizeUsd', { sizeUsd: -5 }], ['sizeUsd', { sizeUsd: 100_000_000.01 }], ['sizeUsd', { sizeUsd: Number.NaN }],
    ['holdHours', { holdHours: 0.24 }], ['holdHours', { holdHours: 720.5 }],
    ['timeframe', { timeframe: '15m' }],
    ['exchanges', { exchanges: [] }], ['exchanges', { exchanges: ['NOPE'] }], ['exchanges', { exchanges: ['OKX', 'OKX'] }],
    ['exchanges', { exchanges: Array(16).fill('OKX') }],
  ];
  for (const [param, over] of bad) {
    it(`${param}: ${JSON.stringify(over)}`, async () => {
      const out = await runPreTradeCheck(P(over), freeLicense(), harness().deps);
      expect(out.kind).toBe('refused');
      if (out.kind === 'refused') expect(out.payload).toMatchObject({ error: 'invalid_parameter', param });
    });
  }
  it('the edges of every range are accepted', async () => {
    for (const over of [{ sizeUsd: 100_000_000 }, { sizeUsd: 0.01 }, { holdHours: 0.25 }, { holdHours: 720 }, { coin: 'X'.repeat(20) }]) {
      const out = await runPreTradeCheck(P(over), INTERNAL, harness().deps);
      expect(out.kind === 'ok' || (out.kind === 'refused' && out.payload.error === 'coin_not_listed'), JSON.stringify(over)).toBe(true);
    }
  });
});

describe('the served shape is the one audits/pre-trade-check-shape-snapshot-2026-10-30.json declares', () => {
  const snap = JSON.parse(readFileSync(join(__dirname, '..', '..', 'audits', 'pre-trade-check-shape-snapshot-2026-10-30.json'), 'utf8')) as Record<string, string[]> & { endpoint: string; snapshot_date: string };

  it('carries the bundle builder\'s field names, and a unique endpoint', () => {
    expect(snap.endpoint).toBe('pre_trade_check (MCP tool)');
    expect(snap.snapshot_date).toBe('2026-10-30');
    expect(snap.allowed_keys).toEqual(TOP_KEYS);
    expect(snap.venues_row_keys).toEqual(VENUE_KEYS);
    for (const f of [...FORBIDDEN, 'outcome_return_pct', 'outcome_price']) expect(snap.forbidden_keys, f).toContain(f);
  });

  it('a split, timed, regime-bearing response matches every declared key list — and no forbidden key', async () => {
    const r = await ok(P({ sizeUsd: 30_000_000 }));
    expect(r.split, 'vacuity guard: the split rows must be checked').not.toBeNull();
    expect(Object.keys(r)).toEqual(snap.allowed_keys);
    for (const v of r.venues) expect(Object.keys(v)).toEqual(snap.venues_row_keys);
    expect(Object.keys(r.best_venue!)).toEqual(snap.best_venue_keys);
    for (const l of r.split!) expect(Object.keys(l)).toEqual(snap.split_row_keys);
    expect(Object.keys(r.timing!)).toEqual(snap.timing_keys);
    expect(Object.keys(r.regime!)).toEqual(snap.regime_keys);
    expect(Object.keys(r.assumptions)).toEqual(snap.assumptions_keys);
    for (const x of r.reasons) expect(Object.keys(x)).toEqual(snap.reasons_row_keys);
    expect(snap.decision_values).toContain(r.decision);
    for (const k of Object.keys(r._algovault)) expect(snap.algovault_keys, `_algovault.${k}`).toContain(k);
    for (const k of snap.algovault_required_keys) expect(r._algovault, `_algovault.${k}`).toHaveProperty(k);
    const text = JSON.stringify(r);
    for (const f of snap.forbidden_keys) expect(text, f).not.toContain(`"${f}":`);
  });

  it('every declared refusal is one the handler emits', () => {
    expect(snap.refusal_errors).toEqual(['invalid_parameter', 'venue_not_supported', 'data_unavailable', 'coin_not_listed']);
  });
});

describe('toPreTradeCheckResponse — the allow-list formatter copies, never spreads', () => {
  it('an extra engine field never reaches the wire', () => {
    const ranking = rankVenues({
      side: 'long', sizeUsd: 10_000, holdHours: 8, nowMs: NOW,
      venues: [{ exchange: 'BINANCE', universeOk: true, fundingFeedOk: true, asset: { liquidityUsd: 5e8, volume24hUsd: 1e10 },
        funding: { rate: 0.0001, intervalHours: 8, intervalBasis: 'contract', nextFundingTime: NOW + 4 * H }, takerFeeBps: 5 }],
    });
    const decided = decide({ coin: 'BTC', side: 'long', sizeUsd: 10_000, holdHours: 8, timeframe: '4h', nowMs: NOW, ranking, regime: null, underlyingClosed: false, staleFees: [] });
    // Pollute every engine object the formatter reads with keys the contract forbids.
    const poison = { verdict: 'BUY', call: 'LONG', reasoning: 'x', price_at_signal: 1, outcome_return_pct: 9 };
    Object.assign(ranking.best!, poison);
    for (const v of ranking.venues) Object.assign(v, poison);
    Object.assign(decided, poison);
    Object.assign(decided.timing!, poison);
    for (const x of decided.reasons) Object.assign(x, poison);
    const r = toPreTradeCheckResponse(
      { coin: 'BTC', side: 'long', sizeUsd: 10_000, holdHours: 8, timeframe: '4h', nowMs: NOW, ranking, decided,
        regime: Object.assign({ label: 'RANGING', confidence: 50, timeframe: '4h', asOfMs: NOW, sourceExchange: 'BINANCE' }, poison),
        underlyingSession: 'ALWAYS_OPEN', feeTableVerifiedAt: '2026-10-24' },
      { tool: 'pre_trade_check' } as never, INTERNAL,
    );
    expect(Object.keys(r)).toEqual(TOP_KEYS);
    const keys = allKeys({ ...r, _algovault: undefined });
    for (const k of Object.keys(poison)) expect(keys, k).not.toContain(k);
  });
});

// ── AC2 — the real shared caches, only the network edge mocked ───────────────────────────────────

describe('AC2 — 50 calls in one TTL, 10 concurrent cold: ≤ 1 fetch per adapter and per universe', () => {
  const universe = vi.mocked(fetchVenueUniverse);
  const fundingCalls = new Map<string, number>();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    _resetVenueMarketStateCaches();
    fundingCalls.clear();
    universe.mockReset();
    universe.mockImplementation(async () => [asset('BTC')]);
    vi.mocked(getAdapter).mockImplementation((id: ExchangeId) => ({
      getPredictedFundings: vi.fn(async (): Promise<FundingData[]> => {
        fundingCalls.set(id, (fundingCalls.get(id) ?? 0) + 1);
        const venue = VENUE_STRING[id];
        return venue ? [{ coin: 'BTC', venues: [{ venue, fundingRate: 0.0001, nextFundingTime: NOW + 4 * H, intervalHours: 8 }] }] : [];
      }),
    }) as unknown as ExchangeAdapter);
  });
  afterEach(() => { vi.useRealTimers(); _resetVenueMarketStateCaches(); });

  it('one universe read per venue and one funding read per priced adapter — none for the unpriced', async () => {
    const deps: PreTradeCheckDeps = {
      ...DEFAULT_PRE_TRADE_CHECK_DEPS,
      retiredVenues: async () => new Set(),
      sampledRegimeVenues: async () => [],
      resolveAssetClass: async () => 'CRYPTO' as never,
      venueStatus: async () => 'promoted',
    };
    const cold = await Promise.all(Array.from({ length: 10 }, () => runPreTradeCheck(P(), INTERNAL, deps)));
    for (let i = 0; i < 40; i++) cold.push(await runPreTradeCheck(P({ side: i % 2 ? 'short' : 'long' }), INTERNAL, deps));
    expect(cold).toHaveLength(50);
    expect(cold.every((o) => o.kind === 'ok')).toBe(true);

    const perVenue = new Map<string, number>();
    for (const [e] of universe.mock.calls) perVenue.set(e as string, (perVenue.get(e as string) ?? 0) + 1);
    expect(Object.fromEntries(perVenue)).toEqual({ BINANCE: 1, BYBIT: 1, OKX: 1, BITGET: 1 });
    expect(Object.fromEntries(fundingCalls)).toEqual({ BINANCE: 1, BYBIT: 1, OKX: 1, BITGET: 1 });
    expect(fundingCalls.has('HL') || fundingCalls.has('GATE') || fundingCalls.has('KUCOIN') || fundingCalls.has('ASTER')).toBe(false);
  });
});

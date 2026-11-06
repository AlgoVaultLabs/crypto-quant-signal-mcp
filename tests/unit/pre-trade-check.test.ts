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
import { z } from 'zod';

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
  PRE_TRADE_CHECK_SCHEMA,
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
import { PRE_TRADE_RULES } from '../../src/lib/pre-trade-rules.js';
import type { ExchangeAdapter, ExchangeId, FundingData, LicenseInfo } from '../../src/types.js';
import type { RegimeSnapshotRow, ServableGeneration } from '../../src/lib/regime-snapshots.js';
import type { MarginTierRead } from '../../src/lib/venue-margin-tiers.js';

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
  /** Snapshot reads at the regime timeframe; the 1h sigma read is logged apart, in `sigmaReads`. */
  regimeReads: string[];
  sigmaReads: string[];
  /** Every `marginTierAt` call: [venue, notional, refPx]. */
  tierReads: [string, number, number | null][];
}

/** A healthy world: BTC on all four venues, funding on all four, a fresh RANGING regime everywhere. */
function harness(over: {
  universes?: Partial<Record<string, VenueUniverseState>>;
  funding?: Partial<Record<string, VenueFundingRow | null>>;
  failedFunding?: string[];
  retired?: string[];
  generation?: (venue: string, timeframe: string) => ServableGeneration | null;
  regimeRow?: (venue: string) => Partial<RegimeSnapshotRow> | null;
  assetClass?: string;
  now?: number;
  tiers?: (venue: string) => MarginTierRead;
} = {}): Harness {
  const now = over.now ?? NOW;
  const h: Harness = { universeReads: [], fundingSkips: [], regimeReads: [], sigmaReads: [], tierReads: [], deps: undefined as unknown as PreTradeCheckDeps };
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
    latestServableGeneration: async (venue, tf) => (over.generation
      ? over.generation(venue, tf)
      : { exchange: venue, timeframe: '4h', bar_close_ms: now - H, disposition: 'COMPLETE', universe_n: 1, written_n: 1, too_new_n: 0, window_stale_n: 0, coverage: 1, tick_at: now - H, finished_at: now - H }),
    readGenerationRow: async (venue, tf, bar, coin) => {
      (tf === '1h' ? h.sigmaReads : h.regimeReads).push(venue);
      const r = over.regimeRow ? over.regimeRow(venue) : {};
      return r === null ? null : ({ exchange: venue, timeframe: '4h', bar_close_ms: bar, coin, regime: 'RANGING', confidence: 50, volatility_ratio: 0.01, ...r } as RegimeSnapshotRow);
    },
    resolveAssetClass: async () => (over.assetClass ?? 'CRYPTO') as never,
    venueStatus: async () => 'promoted',
    marginTierAt: async (venue, _coin, notional, refPx) => {
      h.tierReads.push([venue, notional, refPx]);
      if (over.tiers) return over.tiers(venue);
      return venue === 'BINANCE' ? { rate: null, basis: 'tier_table_requires_key' } : { rate: 0.004, basis: 'public_tier_table' };
    },
    // DECISION-CALL-V2-W2: no key here has a saved profile, so every keyed call decides as it did before v2.1.
    ruleProfile: async () => null,
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

const TOP_KEYS = ['coin', 'side', 'size_usd', 'hold_hours', 'timeframe', 'inputs', 'decision', 'reasons', 'rules', 'rules_summary', 'saved_rules', 'best_venue', 'size_limit_usd',
  'size_limit_usd_total', 'split', 'timing', 'regime', 'calc', 'underlying_session', 'venues', 'assumptions', 'fee_table_verified_at',
  'rule_version', 'as_of', 'ledger', '_algovault'];
const VENUE_KEYS = ['exchange', 'listed', 'excluded', 'liquidity_usd', 'volume_24h_usd', 'capacity_usd', 'size_pct_of_24h_volume',
  'funding_rate', 'funding_interval_hours', 'funding_interval_basis', 'next_funding_at', 'funding_events_in_hold', 'funding_cost_bps',
  'taker_fee_bps', 'round_trip_fee_bps', 'est_cost_bps', 'est_cost_usd', 'spread_bps', 'spread_basis',
  'maker_fee_bps', 'entry_fee_bps', 'round_trip_bps', 'maintenance_rate', 'liq_distance_pct', 'liq_basis', 'your_rules'];
const CALC_KEYS = ['sigma_1h_pct', 'sigma_hold_pct', 'expected_move_pct', 'round_trip_bps', 'accuracy_needed_pct', 'win_rate_needed_pct',
  'random_entry_target_first_pct', 'liq_distance_pct', 'liq_distance_sigma', 'liq_before_stop', 'loss_at_stop_pct_equity', 'one_sigma_day_pct_equity'];
/** The v1 keys, as origin/main served them (DECISION-CALL-V1-W2). */
const V1_TOP_KEYS = TOP_KEYS.filter((k) => !['inputs', 'rules', 'rules_summary', 'calc', 'ledger'].includes(k));
const V1_VENUE_KEYS = VENUE_KEYS.slice(0, VENUE_KEYS.indexOf('maker_fee_bps'));
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
    expect([r.rule_version, r.as_of, r.fee_table_verified_at]).toEqual([2, new Date(NOW).toISOString(), '2026-10-24']);
    expect(r.assumptions).toMatchObject({ funding: 'current rate held for the whole hold', fees: 'base-tier taker, no discounts; per-pair exceptions not modelled', size_guard_pct_of_24h_volume: 0.1 });
    expect(r._algovault).toMatchObject({ tool: 'pre_trade_check', exchange: 'BINANCE', venue_status: 'promoted', auth: expect.any(Object) });
    expect(r._algovault.quota).toBeDefined();
  });

  it('exact allow-list: the top level, every venue row, and nothing else', async () => {
    const r = await ok(P({ sizeUsd: 30_000_000 }));
    expect(Object.keys(r)).toEqual(TOP_KEYS);
    // DECISION-CALL-V2-W5: the receipt — on a logged (non-internal) call only, and nothing else changes.
    expect(Object.keys(r.ledger!)).toEqual(['id', 'leaf', 'verify']);
    const internal = await ok(P({ sizeUsd: 30_000_000 }), harness(), INTERNAL);
    expect(Object.keys(internal)).toEqual(TOP_KEYS.filter((k) => k !== 'ledger'));
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

describe('the served shape is the one audits/pre-trade-check-shape-snapshot-2026-11-06.json declares', () => {
  const snap = JSON.parse(readFileSync(join(__dirname, '..', '..', 'audits', 'pre-trade-check-shape-snapshot-2026-11-06.json'), 'utf8')) as Record<string, string[]> & { endpoint: string; snapshot_date: string };

  it('carries the bundle builder\'s field names, and a unique endpoint', () => {
    expect(snap.endpoint).toBe('pre_trade_check (MCP tool)');
    expect(snap.snapshot_date).toBe('2026-11-06');
    expect(snap.allowed_keys).toEqual(TOP_KEYS);
    expect(snap.venues_row_keys).toEqual(VENUE_KEYS);
    expect(snap.calc_keys).toEqual(CALC_KEYS);
    expect(snap.rule_ids).toEqual(PRE_TRADE_RULES.map((x) => x.id));
    for (const f of ['suggested_size', 'suggested_leverage', 'suggested_stop', 'win_probability']) expect(snap.forbidden_keys, f).toContain(f);
    // Additive: every v1 key is still declared, in v1's relative order.
    expect(snap.allowed_keys.filter((k) => V1_TOP_KEYS.includes(k))).toEqual(V1_TOP_KEYS);
    expect(snap.venues_row_keys.slice(0, V1_VENUE_KEYS.length)).toEqual(V1_VENUE_KEYS);
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
    expect(Object.keys(r.inputs)).toEqual(snap.inputs_keys);
    expect(Object.keys(r.calc)).toEqual(snap.calc_keys);
    expect(Object.keys(r.saved_rules)).toEqual(snap.saved_rules_keys);
    expect(Object.keys(r.ledger!)).toEqual(snap.ledger_keys);
    for (const v of r.venues) expect(snap.liq_basis_values).toContain(v.liq_basis);
    expect(snap.order_type_values).toContain(r.inputs.order_type);
    expect(Object.keys(r.assumptions)).toEqual(snap.assumptions_keys);
    for (const x of r.reasons) expect(Object.keys(x)).toEqual(snap.reasons_row_keys);
    expect(r.rules.length, 'vacuity guard: the default rules must be listed').toBeGreaterThan(0);
    for (const x of r.rules) {
      expect(Object.keys(x)).toEqual(snap.rules_row_keys);
      expect(snap.rule_ids).toContain(x.id);
      expect(snap.rule_source_values).toContain(x.source);
      expect(snap.rule_result_values).toContain(x.result);
    }
    expect(Object.keys(r.rules_summary)).toEqual(snap.rules_summary_keys);
    for (const v of r.venues) expect(snap.your_rules_values).toContain(v.your_rules);
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
    const calc = Object.assign(Object.fromEntries(CALC_KEYS.map((k) => [k, null])), poison) as never;
    const venueCosts = ranking.venues.map(() => Object.assign(
      { makerFeeBps: 2, entryFeeBps: 5, roundTripBps: 10, maintenanceRate: null, liqDistancePct: null, liqBasis: 'leverage_not_given' as const }, poison));
    const rules = [Object.assign({ id: 'maxFundingBps' as const, source: 'default' as const, limit: 10, value: 1, result: 'pass' as const, detail: 'x', failCode: null }, poison)];
    const r = toPreTradeCheckResponse(
      { coin: 'BTC', side: 'long', sizeUsd: 10_000, holdHours: 8, timeframe: '4h', nowMs: NOW, ranking, decided,
        rules, savedRules: Object.assign({ applied: false, updatedAt: null }, poison), sizeGuardPct: 0.1, yourRules: ranking.venues.map(() => null),
        inputs: Object.assign({ leverage: null, stop_pct: null, target_pct: null, equity_usd: null, order_type: 'market' as const }, poison),
        regime: Object.assign({ label: 'RANGING', confidence: 50, timeframe: '4h', asOfMs: NOW, sourceExchange: 'BINANCE' }, poison),
        calc, venueCosts, underlyingSession: 'ALWAYS_OPEN', feeTableVerifiedAt: '2026-10-24' },
      { tool: 'pre_trade_check' } as never, INTERNAL,
    );
    // An internal caller: every key but the receipt (DECISION-CALL-V2-W5 — `ledger` is the logged path's only).
    expect(Object.keys(r)).toEqual(TOP_KEYS.filter((k) => k !== 'ledger'));
    const keys = allKeys({ ...r, _algovault: undefined });
    for (const k of Object.keys(poison)) expect(keys, k).not.toContain(k);
    expect(keys, 'a rule\'s internal failCode never reaches the wire').not.toContain('failCode');
  });
});

// ── DECISION-CALL-V2-W1 CH1 — v2 inputs: calculators, tier tables, params ───────────────────────

const v1Projection = (r: PreTradeCheckResponse) => ({
  top: Object.fromEntries(V1_TOP_KEYS.filter((k) => k !== '_algovault').map((k) => [k, (r as unknown as Record<string, unknown>)[k]])),
  venues: r.venues.map((v) => Object.fromEntries(V1_VENUE_KEYS.map((k) => [k, (v as unknown as Record<string, unknown>)[k]]))),
});

describe('v2 CH1 — a v1-shape call is a v1 call, plus the figures it can compute', () => {
  it('AC1.3: every v1 key with its v1 value, sigma set, leverage_not_given on every venue, zero tier reads', async () => {
    const h = harness();
    const r = await ok(P(), h);
    expect(Object.keys(r).filter((k) => V1_TOP_KEYS.includes(k))).toEqual(V1_TOP_KEYS);
    for (const v of r.venues) expect(Object.keys(v).slice(0, V1_VENUE_KEYS.length)).toEqual(V1_VENUE_KEYS);
    expect(r.decision).toBe('GO');
    expect(r.reasons).toEqual([]);
    expect(r.best_venue).toEqual({ exchange: 'BINANCE', est_cost_bps: 11, est_cost_usd: 11, capacity_usd: 10_000_000 });
    expect(r.rule_version).toBe(2);
    expect(r.inputs).toEqual({ leverage: null, stop_pct: null, target_pct: null, equity_usd: null, order_type: 'market' });
    expect(r.calc).toEqual({
      sigma_1h_pct: 0.6267, sigma_hold_pct: 1.7725, expected_move_pct: 1.4142, round_trip_bps: 10, accuracy_needed_pct: 53.54,
      win_rate_needed_pct: null, random_entry_target_first_pct: null, liq_distance_pct: null, liq_distance_sigma: null,
      liq_before_stop: null, loss_at_stop_pct_equity: null, one_sigma_day_pct_equity: null,
    });
    expect(r.venues.map((v) => v.liq_basis)).toEqual(['leverage_not_given', 'leverage_not_given', 'leverage_not_given', 'leverage_not_given']);
    expect(r.venues.every((v) => v.liq_distance_pct === null && v.maintenance_rate === null)).toBe(true);
    expect(h.tierReads).toEqual([]);
    expect(h.sigmaReads, 'one 1h read, on the cheapest venue').toEqual(['BINANCE']);
  });

  it('per venue: maker fee, entry fee (taker on a market order) and the round trip from venue-fees.ts', async () => {
    const r = await ok(P());
    expect(r.venues.map((v) => [v.exchange, v.maker_fee_bps, v.entry_fee_bps, v.round_trip_bps])).toEqual([
      ['BINANCE', 2, 5, 10], ['BYBIT', 2, 5.5, 11], ['OKX', 2, 5, 10], ['BITGET', 2, 6, 12],
    ]);
  });

  it('a limit order enters at the maker fee; the exit stays taker', async () => {
    const r = await ok(P({ orderType: 'limit' }));
    expect(r.inputs.order_type).toBe('limit');
    expect(r.venues.map((v) => [v.exchange, v.entry_fee_bps, v.round_trip_bps])).toEqual([['BINANCE', 2, 7], ['BYBIT', 2, 7.5], ['OKX', 2, 7], ['BITGET', 2, 8]]);
    expect(r.calc.accuracy_needed_pct).toBe(52.47);
  });

  it('a quoted spread is part of the round trip (top_of_book only)', async () => {
    const quoted = { rows: [asset('BTC', { bidPx: 99_990, askPx: 100_010 })], failed: false };
    const r = await ok(P(), harness({ universes: { OKX: quoted } }));
    const okx = r.venues.find((v) => v.exchange === 'OKX')!;
    expect([okx.spread_basis, okx.spread_bps, okx.round_trip_bps]).toEqual(['top_of_book', 2, 12]);
  });

  it('v2 inputs never move a venue row\'s v1 figures', async () => {
    const plain = v1Projection(await ok(P()));
    const full = v1Projection(await ok(P({ leverage: 20, stopPct: 2, targetPct: 4, equityUsd: 50_000, orderType: 'limit' })));
    expect(full.venues).toEqual(plain.venues);
    for (const k of ['size_limit_usd_total', 'split', 'regime', 'underlying_session', 'fee_table_verified_at', 'as_of']) {
      expect(full.top[k], k).toEqual(plain.top[k]);
    }
  });
});

describe('v2 CH1 — the inputs: bounds held, unbilled', () => {
  const bad: Array<[string, Partial<PreTradeCheckParams>]> = [
    ['leverage', { leverage: 0 }], ['leverage', { leverage: 200.5 }], ['leverage', { leverage: Number.NaN }], ['leverage', { leverage: '10' as unknown as number }],
    ['stopPct', { stopPct: 0 }], ['stopPct', { stopPct: 50.01 }],
    ['targetPct', { targetPct: 0.009 }], ['targetPct', { targetPct: 1000.5 }],
    ['equityUsd', { equityUsd: 0 }], ['equityUsd', { equityUsd: -1 }], ['equityUsd', { equityUsd: 1e10 + 1 }],
    ['orderType', { orderType: 'stop' }],
  ];
  for (const [param, over] of bad) {
    it(`${param}: ${JSON.stringify(over)} → invalid_parameter, unbilled, nothing read`, async () => {
      const h = harness();
      const lic = freeLicense();
      const out = await runPreTradeCheck(P(over), lic, h.deps);
      expect(out.kind).toBe('refused');
      if (out.kind === 'refused') expect([out.status, out.payload]).toMatchObject([400, { error: 'invalid_parameter', param }]);
      expect(checkQuota(lic).used).toBe(0);
      expect([h.universeReads, h.tierReads]).toEqual([[], []]);
    });
  }
  it('the edges of every v2 range are accepted, and null reads as not sent', async () => {
    for (const over of [{ leverage: 1 }, { leverage: 200 }, { stopPct: 0.01 }, { stopPct: 50 }, { targetPct: 0.01 }, { targetPct: 1000 },
      { equityUsd: 1e10 }, { equityUsd: 0.01 }, { orderType: 'market' }, { leverage: null, stopPct: null, targetPct: null, equityUsd: null }]) {
      const out = await runPreTradeCheck(P(over), INTERNAL, harness().deps);
      expect(out.kind, JSON.stringify(over)).toBe('ok');
    }
    const r = await ok(P({ leverage: null, equityUsd: null }));
    expect(r.inputs).toEqual({ leverage: null, stop_pct: null, target_pct: null, equity_usd: null, order_type: 'market' });
  });
});

describe('v2 CH1 — liquidation from each venue\'s own tier table, read only when leverage is sent', () => {
  it('one read per LISTED venue, at the order notional and the venue\'s reference price (mid, else mark)', async () => {
    const h = harness({
      universes: {
        BYBIT: { rows: [asset('BTC', { markPx: 101_000 })], failed: false },
        OKX: { rows: [asset('BTC', { bidPx: 99_990, askPx: 100_010, markPx: 1 })], failed: false },
        BITGET: { rows: [asset('ETH')], failed: false },
      },
    });
    const r = await ok(P({ leverage: 20 }), h);
    expect(h.tierReads).toEqual([['BINANCE', 10_000, null], ['BYBIT', 10_000, 101_000], ['OKX', 10_000, 100_000]]);
    expect(r.venues.map((v) => [v.exchange, v.liq_basis, v.maintenance_rate, v.liq_distance_pct])).toEqual([
      ['BINANCE', 'tier_table_requires_key', null, null],
      ['BYBIT', 'public_tier_table', 0.004, 4.6185],
      ['OKX', 'public_tier_table', 0.004, 4.6185],
      ['BITGET', 'tier_unavailable', null, null],
    ]);
  });

  it('Bitget\'s row shows the m its distance used: the tier rate plus its taker fee', async () => {
    const r = await ok(P({ leverage: 20 }));
    const bitget = r.venues.find((v) => v.exchange === 'BITGET')!;
    expect([bitget.maintenance_rate, bitget.liq_distance_pct]).toEqual([0.0046, 4.561]);
  });

  it('a short is liquidated by a rise: the short formula', async () => {
    const r = await ok(P({ side: 'short', leverage: 20 }));
    expect(r.venues.find((v) => v.exchange === 'BYBIT')!.liq_distance_pct).toBe(4.5817);
  });

  it('a failing tier seam is tier_unavailable, never a thrown call', async () => {
    const h = harness({ tiers: () => { throw new Error('boom'); } });
    const r = await ok(P({ leverage: 20 }), h);
    expect(r.venues.map((v) => v.liq_basis)).toEqual(['tier_unavailable', 'tier_unavailable', 'tier_unavailable', 'tier_unavailable']);
  });
});

describe('v2 CH1 — calc on the decision venue; sigma from one fresh 1h snapshot', () => {
  it('stop, target and equity figures on the decision venue', async () => {
    const r = await ok(P({ stopPct: 2, targetPct: 4, equityUsd: 50_000 }));
    expect(r.best_venue?.exchange).toBe('BINANCE');
    expect(r.calc).toMatchObject({ round_trip_bps: 10, win_rate_needed_pct: 35, random_entry_target_first_pct: 33.33, loss_at_stop_pct_equity: 0.42, one_sigma_day_pct_equity: 0.614 });
    expect(r.inputs).toEqual({ leverage: null, stop_pct: 2, target_pct: 4, equity_usd: 50_000, order_type: 'market' });
  });

  it('with no decision venue, only the venue-free figures are set', async () => {
    const thin = { rows: [asset('BTC', { notionalOI_usd: 10 })], failed: false };
    const r = await ok(P({ equityUsd: 50_000 }), harness({ universes: { BINANCE: thin, BYBIT: thin, OKX: thin, BITGET: thin } }));
    expect(r.best_venue).toBeNull();
    expect(r.calc).toMatchObject({ sigma_1h_pct: 0.6267, round_trip_bps: null, accuracy_needed_pct: null, one_sigma_day_pct_equity: 0.614 });
  });

  it('a 1h regime timeframe shares its read with sigma: one read, not two', async () => {
    const h = harness();
    const r = await ok(P({ timeframe: '1h' }), h);
    expect([h.sigmaReads, h.regimeReads]).toEqual([['BINANCE'], []]);
    expect([r.regime?.timeframe, r.calc.sigma_1h_pct]).toEqual(['1h', 0.6267]);
  });

  it('sigma walks on when the cheapest venue has no row for the coin', async () => {
    const h = harness({ regimeRow: (v) => (v === 'BINANCE' ? null : { volatility_ratio: 0.02 }) });
    const r = await ok(P(), h);
    expect(h.sigmaReads).toEqual(['BINANCE', 'BYBIT']);
    expect(r.calc.sigma_1h_pct).toBe(1.2533);
  });

  it('no fresh 1h generation: sigma figures null, the regime and the v1 decision untouched', async () => {
    const h = harness({ generation: (v, tf) => ({ exchange: v, timeframe: tf, bar_close_ms: NOW - 3 * H } as ServableGeneration) });
    const r = await ok(P(), h);
    expect(h.sigmaReads).toEqual([]);
    expect(r.regime).toMatchObject({ label: 'RANGING', source_exchange: 'BINANCE' });
    expect([r.calc.sigma_1h_pct, r.calc.expected_move_pct, r.calc.accuracy_needed_pct]).toEqual([null, null, null]);
    expect([r.decision, r.reasons]).toEqual(['GO', []]);
  });
});

// ── DECISION-CALL-V2-W1 CH2 — your rules, checked ──────────────────────────────────────────────

const codes = (r: PreTradeCheckResponse) => r.reasons.map((x) => x.code);
const rule = (r: PreTradeCheckResponse, id: string) => r.rules.find((x) => x.id === id);
/** 1h generations stale (sigma unreadable), the 4h regime still fresh. */
const noSigma = () => harness({ generation: (v, tf) => ({ exchange: v, timeframe: tf, bar_close_ms: NOW - 3 * H } as ServableGeneration) });

describe('v2 CH2 — the rules on the decision venue: v1\'s checks are the defaults', () => {
  it('no rules sent: the four defaults in table order — v1\'s three judged, noLiqBeforeStop not evaluated and silent', async () => {
    const r = await ok(P());
    expect(r.rules).toEqual([
      { id: 'noLiqBeforeStop', source: 'default', limit: true, value: null, result: 'not_evaluated', detail: 'Send leverage and stopPct to check this rule.' },
      { id: 'maxFundingBps', source: 'default', limit: 10, value: 1, result: 'pass', detail: 'Funding over the hold 1 bps is below the limit of 10 bps.' },
      { id: 'maxSizePctOf24hVolume', source: 'default', limit: 0.1, value: 0.0001, result: 'pass', detail: 'The order is 0.0001% of 24h volume, within the limit of 0.1% ($10,000,000 on BINANCE).' },
      { id: 'regimeCheck', source: 'default', limit: true, value: 'RANGING', result: 'pass', detail: 'The 4h regime is RANGING at confidence 50.' },
    ]);
    expect(r.rules_summary).toEqual({ passed: 3, failed: 0, not_evaluated: 1 });
    expect(r.venues.map((v) => v.your_rules)).toEqual([null, null, null, null]);
    expect([r.decision, r.reasons]).toEqual(['GO', []]);
  });

  it('a failed DEFAULT keeps its v1 code: a regime against the side is REGIME_AGAINST_SIDE (CAUTION), never YOUR_RULE_FAILED', async () => {
    const r = await ok(P(), harness({ regimeRow: () => ({ regime: 'TRENDING_DOWN', confidence: 65 }) }));
    expect([r.decision, codes(r)]).toEqual(['CAUTION', ['REGIME_AGAINST_SIDE']]);
    expect(rule(r, 'regimeCheck')).toMatchObject({ source: 'default', result: 'fail', value: 'TRENDING_DOWN' });
  });
});

describe('v2 CH2 — AC2.3: the handler', () => {
  it('rules.maxLeverage 5 at leverage 20 → WAIT, YOUR_RULE_FAILED, one unit', async () => {
    const lic = freeLicense();
    const r = await ok(P({ leverage: 20, rules: { maxLeverage: 5 } }), harness(), lic);
    expect(checkQuota(lic).used, 'a WAIT is billed one unit').toBe(1);
    expect(r.decision).toBe('WAIT');
    expect(r.reasons).toEqual([{ code: 'YOUR_RULE_FAILED', severity: 'block', detail: 'Your rule failed on OKX: maxLeverage — Leverage 20x is above the limit of 5x.' }]);
    expect(r.rules[0]).toEqual({ id: 'maxLeverage', source: 'yours', limit: 5, value: 20, result: 'fail', detail: 'Leverage 20x is above the limit of 5x.' });
    expect(r.venues.map((v) => v.your_rules)).toEqual(['fail', 'fail', 'fail', 'fail']);
  });

  it('rules.foo → invalid_parameter rules.foo, zero units, nothing read', async () => {
    const h = harness();
    const lic = freeLicense();
    const out = await runPreTradeCheck(P({ rules: { foo: 1 } }), lic, h.deps);
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') {
      expect([out.status, out.payload]).toMatchObject([400, { error: 'invalid_parameter', code: 'invalid_parameter', param: 'rules.foo', message: 'rules.foo is not a rule.' }]);
      expect((out.payload as { suggested_action: string }).suggested_action).toBe(`Use only these rule keys: ${PRE_TRADE_RULES.map((x) => x.id).join(', ')}.`);
    }
    expect(checkQuota(lic).used).toBe(0);
    expect([h.universeReads, h.tierReads, h.regimeReads]).toEqual([[], [], []]);
  });

  it('leverage 25 with stopPct 5 on a 0.4% tier → CAUTION + LIQUIDATION_BEFORE_STOP', async () => {
    const r = await ok(P({ leverage: 25, stopPct: 5 }));
    expect([r.decision, codes(r)]).toEqual(['CAUTION', ['LIQUIDATION_BEFORE_STOP']]);
    expect(r.best_venue?.exchange).toBe('OKX');
    expect(r.reasons[0]).toEqual({ code: 'LIQUIDATION_BEFORE_STOP', severity: 'adjust', detail: 'On OKX: Isolated liquidation at 3.6145% from entry is at or inside the 5% stop.' });
    expect(rule(r, 'noLiqBeforeStop')).toEqual({ id: 'noLiqBeforeStop', source: 'default', limit: true, value: true, result: 'fail', detail: 'Isolated liquidation at 3.6145% from entry is at or inside the 5% stop.' });
    expect([r.calc.liq_distance_pct, r.calc.liq_before_stop]).toEqual([3.6145, true]);
  });

  it('leverage sent while BINANCE is cheapest → the cheapest venue with a public tier table decides', async () => {
    expect((await ok(P())).best_venue?.exchange, 'fixture: BINANCE is v1\'s best').toBe('BINANCE');
    const r = await ok(P({ leverage: 20 }));
    expect(r.best_venue).toEqual({ exchange: 'OKX', est_cost_bps: 11, est_cost_usd: 11, capacity_usd: 10_000_000 });
    expect(r.venues.find((v) => v.exchange === 'BINANCE')!.liq_basis).toBe('tier_table_requires_key');
    expect([r.timing?.exchange, r._algovault.exchange, r.calc.liq_distance_pct]).toEqual(['OKX', 'OKX', 4.6185]);
    expect([r.decision, r.reasons]).toEqual(['GO', []]);
  });
});

describe('v2 CH2 — the decision venue: no failed rule of yours, then the fewest not evaluated', () => {
  it('your rules all pass on a tier-publishing venue: GO there, not_evaluated on BINANCE', async () => {
    const r = await ok(P({ leverage: 10, stopPct: 2, equityUsd: 50_000, rules: { maxLeverage: 10, maxLossAtStopPctEquity: 1, minLiqDistanceSigma: 1 } }));
    expect(r.best_venue?.exchange).toBe('OKX');
    expect([r.decision, r.reasons]).toEqual(['GO', []]);
    expect(r.venues.map((v) => v.your_rules)).toEqual(['not_evaluated', 'pass', 'pass', 'pass']);
    expect(r.rules.map((x) => [x.id, x.source, x.result])).toEqual([
      ['maxLeverage', 'yours', 'pass'], ['noLiqBeforeStop', 'default', 'pass'], ['minLiqDistanceSigma', 'yours', 'pass'],
      ['maxLossAtStopPctEquity', 'yours', 'pass'], ['maxFundingBps', 'default', 'pass'], ['maxSizePctOf24hVolume', 'default', 'pass'],
      ['regimeCheck', 'default', 'pass'],
    ]);
    expect(r.rules_summary).toEqual({ passed: 7, failed: 0, not_evaluated: 0 });
  });

  it('a venue where your rule fails loses to one where it passes, even when cheaper', async () => {
    // BINANCE is strictly cheapest (no funding) but quotes a 10 bps book, so its round trip is 20 bps.
    const h = harness({
      funding: { BINANCE: fundRow('BINANCE', 0) },
      universes: { BINANCE: { rows: [asset('BTC', { bidPx: 99_950, askPx: 100_050 })], failed: false } },
    });
    expect((await ok(P(), h)).best_venue?.exchange, 'fixture: BINANCE is v1\'s best').toBe('BINANCE');
    const r = await ok(P({ rules: { maxRoundTripBps: 15 } }), h);
    expect(r.venues.map((v) => [v.exchange, v.est_cost_bps, v.round_trip_bps, v.your_rules])).toEqual([
      ['BINANCE', 10, 20, 'fail'], ['BYBIT', 12, 11, 'pass'], ['OKX', 11, 10, 'pass'], ['BITGET', 13, 12, 'pass'],
    ]);
    expect(r.best_venue?.exchange).toBe('OKX');
    expect([r.decision, r.reasons]).toEqual(['GO', []]);
  });

  it('failed everywhere: still judged on v1\'s best venue, and WAIT', async () => {
    const r = await ok(P({ rules: { maxFundingBps: 1 } }));
    expect(rule(r, 'maxFundingBps')).toEqual({ id: 'maxFundingBps', source: 'yours', limit: 1, value: 1, result: 'fail', detail: 'Funding over the hold 1 bps is at or above the limit of 1 bps.' });
    expect(r.best_venue?.exchange).toBe('BINANCE');
    expect([r.decision, codes(r)]).toEqual(['WAIT', ['YOUR_RULE_FAILED']]);
  });
});

describe('v2 CH2 — sent rules: a number replaces a default, false switches one off', () => {
  it('regimeCheck false drops the rule and its reason; the regime is still shown', async () => {
    const against = () => harness({ regimeRow: () => ({ regime: 'TRENDING_DOWN', confidence: 65 }) });
    const off = await ok(P({ rules: { regimeCheck: false } }), against());
    expect(off.rules.map((x) => x.id)).toEqual(['noLiqBeforeStop', 'maxFundingBps', 'maxSizePctOf24hVolume']);
    expect([off.decision, off.reasons]).toEqual(['GO', []]);
    expect(off.regime).toMatchObject({ label: 'TRENDING_DOWN', confidence: 65 });
  });

  it('regimeCheck true is yours: the same regime is YOUR_RULE_FAILED → WAIT', async () => {
    const r = await ok(P({ rules: { regimeCheck: true } }), harness({ regimeRow: () => ({ regime: 'TRENDING_DOWN', confidence: 65 }) }));
    expect(rule(r, 'regimeCheck')).toMatchObject({ source: 'yours', limit: true, result: 'fail' });
    expect([r.decision, codes(r)]).toEqual(['WAIT', ['YOUR_RULE_FAILED']]);
  });

  it('noLiqBeforeStop false: liquidation inside the stop is shown in calc, not judged', async () => {
    const r = await ok(P({ leverage: 25, stopPct: 5, rules: { noLiqBeforeStop: false } }));
    expect(rule(r, 'noLiqBeforeStop')).toBeUndefined();
    expect(r.calc.liq_before_stop).toBe(true);
    expect([r.decision, r.reasons]).toEqual(['GO', []]);
  });

  it('maxSizePctOf24hVolume moves capacity, the size limit, the split and the stated size guard', async () => {
    const r = await ok(P({ rules: { maxSizePctOf24hVolume: 0.00005 } }));
    expect(r.assumptions.size_guard_pct_of_24h_volume).toBe(0.00005);
    expect(r.venues.map((v) => v.capacity_usd)).toEqual([5000, 5000, 5000, 5000]);
    expect(r.size_limit_usd).toBe(5000);
    expect(r.split).toEqual([{ exchange: 'BINANCE', size_usd: 5000, est_cost_bps: 11 }, { exchange: 'OKX', size_usd: 5000, est_cost_bps: 11 }]);
    expect(rule(r, 'maxSizePctOf24hVolume')).toMatchObject({ source: 'yours', limit: 0.00005, result: 'fail',
      detail: 'The order is 0.0001% of 24h volume, above the limit of 0.00005% ($5,000 on BINANCE).' });
    expect([r.decision, codes(r)]).toEqual(['WAIT', ['YOUR_RULE_FAILED']]);
  });

  it('YOUR_RULE_NOT_CHECKED: a rule of yours whose inputs were not sent adjusts, and names what to send', async () => {
    const r = await ok(P({ rules: { maxLossAtStopPctEquity: 1 } }));
    expect(r.decision).toBe('CAUTION');
    expect(r.reasons).toEqual([{ code: 'YOUR_RULE_NOT_CHECKED', severity: 'adjust',
      detail: 'Your rule was not checked on BINANCE: maxLossAtStopPctEquity — Send stopPct and equityUsd to check this rule.' }]);
    expect(r.venues.map((v) => v.your_rules)).toEqual(['not_evaluated', 'not_evaluated', 'not_evaluated', 'not_evaluated']);
    expect(r.rules_summary).toEqual({ passed: 3, failed: 0, not_evaluated: 2 });
  });

  it('null reads as not sent, inside rules too', async () => {
    const r = await ok(P({ rules: { maxLeverage: null } as never }));
    expect(r.rules.map((x) => x.source)).toEqual(['default', 'default', 'default', 'default']);
    expect((await ok(P({ rules: null }))).rules).toHaveLength(4);
  });
});

describe('v2 CH2 — VOLATILITY_ and LIQUIDATION_UNAVAILABLE appear only for a v2 input', () => {
  it('no fresh 1h volatility: silent for a v1 call, info for a call that sends a v2 input', async () => {
    expect(codes(await ok(P(), noSigma()))).toEqual([]);
    const r = await ok(P({ equityUsd: 50_000 }), noSigma());
    expect(r.reasons).toEqual([{ code: 'VOLATILITY_UNAVAILABLE', severity: 'info',
      detail: 'No fresh 1h volatility is available for BTC, so the volatility, break-even and liquidation-distance-in-sigma figures are not computed.' }]);
    expect(r.decision).toBe('GO');
  });

  it('a rule of yours that needs sigma, without it: YOUR_RULE_NOT_CHECKED says so', async () => {
    const r = await ok(P({ rules: { maxAccuracyNeededPct: 60 } }), noSigma());
    expect(rule(r, 'maxAccuracyNeededPct')).toMatchObject({ result: 'not_evaluated', detail: 'No fresh 1h volatility is available.' });
    expect(codes(r)).toEqual(['YOUR_RULE_NOT_CHECKED', 'VOLATILITY_UNAVAILABLE']);
  });

  it('leverage sent and only BINANCE can take it: checked there, LIQUIDATION_UNAVAILABLE names why', async () => {
    const r = await ok(P({ leverage: 20, exchanges: ['BINANCE'] }));
    expect(r.best_venue?.exchange).toBe('BINANCE');
    expect(r.reasons).toEqual([{ code: 'LIQUIDATION_UNAVAILABLE', severity: 'info',
      detail: 'Liquidation is not computed on BINANCE: its maintenance tier table is published only to account holders.' }]);
    expect(r.decision).toBe('GO');
  });

  it('no venue can take it: your rules are judged on no venue — an input-only rule still fails', async () => {
    const thin = { rows: [asset('BTC', { notionalOI_usd: 10 })], failed: false };
    const r = await ok(P({ leverage: 20, rules: { maxLeverage: 5 } }), harness({ universes: { BINANCE: thin, BYBIT: thin, OKX: thin, BITGET: thin } }));
    expect([r.decision, codes(r)]).toEqual(['WAIT', ['NO_TRADABLE_VENUE', 'YOUR_RULE_FAILED']]);
    expect(r.reasons[1].detail).toBe('Your rule failed: maxLeverage — Leverage 20x is above the limit of 5x.');
    expect(rule(r, 'maxFundingBps')).toMatchObject({ result: 'not_evaluated', detail: 'No venue can take this order, so it was not checked.' });
    expect(r.venues.map((v) => v.your_rules)).toEqual([null, null, null, null]);
  });
});

describe('v2 CH2 — the outcome\'s internal facts: the decision venue\'s reference price, never on the wire', () => {
  it('the mid where the decision venue quotes both sides, else its mark; null with no decision venue', async () => {
    const h = harness({
      universes: {
        BINANCE: { rows: [asset('BTC', { markPx: 99_000 })], failed: false },
        OKX: { rows: [asset('BTC', { bidPx: 99_990, askPx: 100_010, markPx: 1 })], failed: false },
      },
    });
    const plain = await runPreTradeCheck(P(), INTERNAL, h.deps);
    const lev = await runPreTradeCheck(P({ leverage: 20 }), INTERNAL, h.deps);
    if (plain.kind !== 'ok' || lev.kind !== 'ok') throw new Error('expected ok');
    expect([plain.response.best_venue?.exchange, plain.facts]).toEqual(['BINANCE', { refMidPx: 99_000 }]);
    expect([lev.response.best_venue?.exchange, lev.facts]).toEqual(['OKX', { refMidPx: 100_000 }]);
    for (const k of ['refMidPx', 'ref_mid_px', 'facts']) expect(allKeys(lev.response), k).not.toContain(k);
    const thin = { rows: [asset('BTC', { notionalOI_usd: 10, markPx: 5 })], failed: false };
    const none = await runPreTradeCheck(P(), INTERNAL, harness({ universes: { BINANCE: thin, BYBIT: thin, OKX: thin, BITGET: thin } }).deps);
    expect(none.kind === 'ok' && none.facts).toEqual({ refMidPx: null });
  });
});

describe('v2 CH2 — rules: closed, bounded, unbilled on refusal', () => {
  const bad: Array<[string, unknown]> = [
    ['rules', 'x'], ['rules', []], ['rules', 7],
    ['rules.foo', { foo: 1 }], ['rules.maxLeverage', { maxLeverage: 0 }], ['rules.maxLeverage', { maxLeverage: 200.5 }],
    ['rules.maxSizePctOf24hVolume', { maxSizePctOf24hVolume: 0 }], ['rules.maxAccuracyNeededPct', { maxAccuracyNeededPct: 49.9 }],
    ['rules.regimeCheck', { regimeCheck: 'yes' }], ['rules.maxFundingBps', { maxFundingBps: false }], ['rules.noLiqBeforeStop', { noLiqBeforeStop: 1 }],
  ];
  for (const [param, rules] of bad) {
    it(`${JSON.stringify(rules)} → invalid_parameter ${param}, unbilled, nothing read`, async () => {
      const h = harness();
      const lic = freeLicense();
      const out = await runPreTradeCheck(P({ rules }), lic, h.deps);
      expect(out.kind).toBe('refused');
      if (out.kind === 'refused') expect([out.status, out.payload]).toMatchObject([400, { error: 'invalid_parameter', param }]);
      expect(checkQuota(lic).used).toBe(0);
      expect(h.universeReads).toEqual([]);
    });
  }

  it('the served zod schema is closed too: an unknown rules key fails before the handler runs; every table key at its bounds passes', () => {
    const schema = z.object(PRE_TRADE_CHECK_SCHEMA);
    const base = { coin: 'BTC', side: 'long', sizeUsd: 1 };
    const unknown = schema.safeParse({ ...base, rules: { foo: 1 } });
    expect(unknown.success).toBe(false);
    expect(JSON.stringify(unknown.error?.issues)).toContain('unrecognized_keys');
    expect(schema.safeParse({ ...base, rules: { maxSizePctOf24hVolume: 0 } }).success).toBe(false);
    const edges = { maxLeverage: 200, noLiqBeforeStop: false, minLiqDistanceSigma: 0, maxLossAtStopPctEquity: 100, maxDailyMovePctEquity: 0,
      maxRoundTripBps: 1000, maxAccuracyNeededPct: 50, maxFundingBps: 10_000, maxSizePctOf24hVolume: 100, regimeCheck: true };
    expect(Object.keys(edges)).toEqual(PRE_TRADE_RULES.map((x) => x.id));
    expect(schema.safeParse({ ...base, rules: edges }).success).toBe(true);
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

describe('DECISION-CALL-V2-AUDIT-W1 R3 — the 1h sigma read is fail-open on the paid rails', () => {
  const DB_FAULT = 'connection terminated unexpectedly';

  /** v1's regime read (4h, the default) succeeds; v2's own separate 1h sigma read rejects, as a faulting DB would. */
  function sigmaRejects(): Harness {
    const h = harness();
    const inner = h.deps.readGenerationRow;
    h.deps.readGenerationRow = async (venue, tf, bar, coin) => {
      if (tf === '1h') throw new Error(DB_FAULT);
      return inner(venue, tf, bar, coin);
    };
    return h;
  }

  it('a rejected sigma read on a call that sends a v2 input is served: sigma null, VOLATILITY_UNAVAILABLE, never a throw', async () => {
    const r = await ok(P({ equityUsd: 50_000 }), sigmaRejects());
    expect(r.calc.sigma_1h_pct).toBeNull();
    expect(codes(r)).toEqual(['VOLATILITY_UNAVAILABLE']);
    expect(r.decision).toBe('GO');
  });

  it('a rejected sigma read on a v1-shape call is served silently, as a missing row is', async () => {
    const r = await ok(P(), sigmaRejects());
    expect(r.calc.sigma_1h_pct).toBeNull();
    expect(codes(r)).toEqual([]);
  });

  it("the regime read is v1's and keeps v1's failure: when every snapshot read rejects, the call still rejects", async () => {
    const h = harness();
    h.deps.readGenerationRow = async () => { throw new Error(DB_FAULT); };
    await expect(runPreTradeCheck(P({ equityUsd: 50_000 }), freeLicense(), h.deps)).rejects.toThrow(DB_FAULT);
  });
});

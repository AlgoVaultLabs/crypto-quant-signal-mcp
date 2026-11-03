/**
 * DECISION-CALL-V2-W2 CH1 (AC1.1) — saved rule profiles: the store (`src/lib/pre-trade-rule-profiles.ts`), the
 * three layers (`activeRules`, `src/lib/pre-trade-rules.ts`) and the handler that applies them
 * (`Prompt/pre-trade-check-contract-v2.md` § v2.1).
 *
 * Layers, key by key: defaults, then the key's saved profile, then the call's own `rules`; a later layer replaces an
 * earlier one and `false` switches a boolean off at any layer. A saved rule is graded exactly as one sent with the
 * call — a failure is YOUR_RULE_FAILED (block), one not evaluated YOUR_RULE_NOT_CHECKED (adjust), and the decision
 * venue treats it as yours — which the corpus below pins by running every rule set both ways. An unreadable profile
 * is SAVED_RULES_UNAVAILABLE (adjust), so a keyed call is never GO without its saved rules. Keyless, x402 and
 * internal calls never read one.
 *
 * The handler runs on its data seam with the profile read as a counted dep; the store runs on `dbQuery` / `dbExec`
 * mocks that record every statement (and on a real SQLite backend in pre-trade-rules-api.test.ts).
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../src/lib/performance-db.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/performance-db.js')>()),
  dbQuery: vi.fn(),
  dbExec: vi.fn(),
}));

import { dbExec, dbQuery } from '../../src/lib/performance-db.js';
import {
  getProfile,
  profileKeyOf,
  profileRefOf,
  _resetRuleProfilesForTest,
  type PreTradeRuleProfile,
} from '../../src/lib/pre-trade-rule-profiles.js';
import { activeRules, isCallersRule, type PreTradeRulesInput } from '../../src/lib/pre-trade-rules.js';
import { PRE_TRADE_REASONS } from '../../src/lib/pre-trade-decision.js';
import {
  runPreTradeCheck,
  DEFAULT_PRE_TRADE_CHECK_DEPS,
  type PreTradeCheckDeps,
  type PreTradeCheckParams,
  type PreTradeCheckResponse,
} from '../../src/tools/pre-trade-check.js';
import { checkQuota, trackCall } from '../../src/lib/license.js';
import { FREE_DAILY_CALLS } from '../../src/lib/plans.js';
import { TierLimitReachedError } from '../../src/lib/errors.js';
import { callerRef } from '../../src/lib/lifecycle/identity.js';
import type { ExchangeAsset } from '../../src/lib/exchange-universe.js';
import type { RegimeSnapshotRow, ServableGeneration } from '../../src/lib/regime-snapshots.js';
import type { MergedFundingSnapshot, VenueFundingRow, VenueUniverseState } from '../../src/lib/venue-market-state.js';
import type { ExchangeId, LicenseInfo } from '../../src/types.js';

const ROOT = join(__dirname, '..', '..');
const H = 3_600_000;
const NOW = Date.parse('2026-10-30T12:00:00Z');
const VENUES = ['BINANCE', 'BYBIT', 'OKX', 'BITGET'] as const;
const VENUE_STRING: Record<string, string> = { BINANCE: 'BinPerp', BYBIT: 'BybitPerp', OKX: 'OKXPerp', BITGET: 'BitgetPerp' };
const SAVED_AT = '2026-11-02T09:15:00.000Z';
const q = vi.mocked(dbQuery);
const x = vi.mocked(dbExec);

// ── The handler's world: the healthy one the pre_trade_check suite builds ────────────────────────────

const asset = (coin: string, over: Partial<ExchangeAsset> = {}): ExchangeAsset =>
  ({ coin, notionalOI_usd: 5e8, volume24h_usd: 1e10, ...over }) as ExchangeAsset;
const fundRow = (exchange: string, rate = 0.0001): VenueFundingRow =>
  ({ venue: VENUE_STRING[exchange], fundingRate: rate, nextFundingTime: NOW + 4 * H, intervalHours: 8 }) as VenueFundingRow;

interface World {
  deps: PreTradeCheckDeps;
  /** Every key the profile read was called with. */
  profileReads: string[];
}

/** BTC on four venues, funding on four, a fresh RANGING regime; the profile read answers `profile`. */
function world(over: {
  profile?: (key: string) => Promise<PreTradeRuleProfile | null>;
  universes?: Partial<Record<string, VenueUniverseState>>;
  funding?: Partial<Record<string, VenueFundingRow>>;
  regime?: Partial<RegimeSnapshotRow>;
  generation?: (venue: string, timeframe: string) => ServableGeneration | null;
} = {}): World {
  const w: World = { profileReads: [], deps: undefined as unknown as PreTradeCheckDeps };
  const fundingRows = VENUES.map((v) => over.funding?.[v] ?? fundRow(v));
  w.deps = {
    now: () => NOW,
    retiredVenues: async () => new Set<string>(),
    venueUniverse: async (e) => over.universes?.[e] ?? { rows: [asset('BTC'), asset('ETH')], failed: false },
    fundingSnapshot: async () => ({ byCoin: new Map([['BTC', fundingRows]]), failedVenues: new Set<ExchangeId>() }) as MergedFundingSnapshot,
    sampledRegimeVenues: async () => [...VENUES],
    latestServableGeneration: async (venue, tf) => (over.generation
      ? over.generation(venue, tf)
      : { exchange: venue, timeframe: '4h', bar_close_ms: NOW - H, disposition: 'COMPLETE', universe_n: 1, written_n: 1, too_new_n: 0, window_stale_n: 0, coverage: 1, tick_at: NOW - H, finished_at: NOW - H } as ServableGeneration),
    readGenerationRow: async (venue, _tf, bar, coin) =>
      ({ exchange: venue, timeframe: '4h', bar_close_ms: bar, coin, regime: 'RANGING', confidence: 50, volatility_ratio: 0.01, ...over.regime }) as RegimeSnapshotRow,
    resolveAssetClass: async () => 'CRYPTO' as never,
    venueStatus: async () => 'promoted',
    marginTierAt: async (venue) => (venue === 'BINANCE' ? { rate: null, basis: 'tier_table_requires_key' } : { rate: 0.004, basis: 'public_tier_table' }),
    ruleProfile: async (key) => {
      w.profileReads.push(key);
      return over.profile ? over.profile(key) : null;
    },
  };
  return w;
}

const saved = (rules: PreTradeRulesInput) => async (): Promise<PreTradeRuleProfile> => ({ rules, createdAt: SAVED_AT, updatedAt: SAVED_AT });
const unreadable = async (): Promise<never> => { throw new Error('connection terminated unexpectedly'); };
const against = { regime: { regime: 'TRENDING_DOWN', confidence: 65 } };
const wideBinance = {
  funding: { BINANCE: fundRow('BINANCE', 0) },
  universes: { BINANCE: { rows: [asset('BTC', { bidPx: 99_950, askPx: 100_050 })], failed: false } },
};
const noSigma = { generation: (v: string, tf: string) => ({ exchange: v, timeframe: tf, bar_close_ms: NOW - 3 * H }) as ServableGeneration };

const P = (over: Partial<PreTradeCheckParams> = {}): PreTradeCheckParams => ({ coin: 'BTC', side: 'long', sizeUsd: 10_000, ...over });

let n = 0;
/** A keyed caller: a fresh synthetic free key (its own quota bucket), resolved. */
const keyed = (): LicenseInfo => ({ tier: 'free', key: `av_free_${(++n).toString(16).padStart(2, '0').repeat(12)}`, outcome: 'RESOLVED' });
const KEYLESS: LicenseInfo = { tier: 'free', key: null, outcome: 'ABSENT', anonymous: true };
const X402: LicenseInfo = { tier: 'x402', key: null, outcome: 'RESOLVED' };
const INTERNAL: LicenseInfo = { tier: 'internal', key: null, outcome: 'RESOLVED' };
/** The docs' top failure mode: an unexpanded env var, served as anonymous with the string kept (a Stripe outage). */
const MALFORMED: LicenseInfo = { tier: 'free', key: '${env:AV_API_KEY}', outcome: 'MALFORMED', anonymous: true };
const TOKEN_INVALID: LicenseInfo = { tier: 'free', key: null, outcome: 'TOKEN_INVALID', anonymous: true };

async function ok(p: PreTradeCheckParams, w: World, lic: LicenseInfo = keyed()): Promise<PreTradeCheckResponse> {
  const out = await runPreTradeCheck(p, lic, w.deps);
  if (out.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(out.payload)}`);
  return out.response;
}

const codes = (r: PreTradeCheckResponse) => r.reasons.map((x) => x.code);
/** What a rule set decides, with `saved` read as `yours` — the projection the two layers must agree on. */
const judged = (r: PreTradeCheckResponse) => ({
  decision: r.decision,
  reasons: r.reasons,
  rules: r.rules.map((x) => ({ ...x, source: x.source === 'saved' ? 'yours' : x.source })),
  rules_summary: r.rules_summary,
  best_venue: r.best_venue,
  your_rules: r.venues.map((v) => v.your_rules),
  split: r.split,
  size_guard: r.assumptions.size_guard_pct_of_24h_volume,
});

// ── activeRules: the three layers, key by key ───────────────────────────────────────────────────────

describe('activeRules — defaults, then saved, then the call, key by key', () => {
  const view = (sent?: PreTradeRulesInput, sv?: PreTradeRulesInput) => activeRules(sent, sv).map((r) => [r.id, r.source, r.limit]);

  it('nothing saved, nothing sent: v2\'s four defaults, unchanged — and the one-argument form is the two-layer form', () => {
    const defaults = [['noLiqBeforeStop', 'default', true], ['maxFundingBps', 'default', 10], ['maxSizePctOf24hVolume', 'default', 0.1], ['regimeCheck', 'default', true]];
    expect(view()).toEqual(defaults);
    expect(view({}, {})).toEqual(defaults);
    expect(view({ maxLeverage: 5 })).toEqual(view({ maxLeverage: 5 }, {}));
  });

  it('a saved number replaces a default and opts a rule in, as source saved', () => {
    expect(view({}, { maxFundingBps: 5, maxRoundTripBps: 15 })).toEqual([
      ['noLiqBeforeStop', 'default', true], ['maxRoundTripBps', 'saved', 15], ['maxFundingBps', 'saved', 5],
      ['maxSizePctOf24hVolume', 'default', 0.1], ['regimeCheck', 'default', true],
    ]);
  });

  it('the call replaces the saved value for its keys only; the other saved keys stay saved', () => {
    expect(view({ maxLeverage: 20 }, { maxLeverage: 10, maxFundingBps: 5 })).toEqual([
      ['maxLeverage', 'yours', 20], ['noLiqBeforeStop', 'default', true], ['maxFundingBps', 'saved', 5],
      ['maxSizePctOf24hVolume', 'default', 0.1], ['regimeCheck', 'default', true],
    ]);
  });

  it('false switches a boolean off at the saved layer', () => {
    expect(view({}, { regimeCheck: false, noLiqBeforeStop: false })).toEqual([['maxFundingBps', 'default', 10], ['maxSizePctOf24hVolume', 'default', 0.1]]);
  });

  it('false at the call layer switches off a saved true; true at the call layer switches a saved false back on, as yours', () => {
    expect(view({ regimeCheck: false }, { regimeCheck: true }).map(([id]) => id)).not.toContain('regimeCheck');
    expect(view({ regimeCheck: true }, { regimeCheck: false })).toContainEqual(['regimeCheck', 'yours', true]);
    expect(view({}, { noLiqBeforeStop: true })).toContainEqual(['noLiqBeforeStop', 'saved', true]);
  });

  it('table order whatever the layer', () => {
    expect(view({ regimeCheck: true }, { maxLeverage: 3, maxFundingBps: 2 }).map(([id]) => id))
      .toEqual(['maxLeverage', 'noLiqBeforeStop', 'maxFundingBps', 'maxSizePctOf24hVolume', 'regimeCheck']);
  });

  it('isCallersRule: yours and saved are the caller\'s, a default is not', () => {
    expect([isCallersRule('yours'), isCallersRule('saved'), isCallersRule('default')]).toEqual([true, true, false]);
  });
});

// ── The handler: a saved rule is graded exactly as a sent one ───────────────────────────────────────

describe('a saved rule is graded exactly as the same rule sent with the call', () => {
  const corpus: { name: string; p: Partial<PreTradeCheckParams>; w: Parameters<typeof world>[0]; rules: PreTradeRulesInput; decision: string }[] = [
    { name: 'maxLeverage 5 at leverage 20', p: { leverage: 20 }, w: {}, rules: { maxLeverage: 5 }, decision: 'WAIT' },
    { name: 'a venue where the rule fails loses to one where it passes', p: {}, w: wideBinance, rules: { maxRoundTripBps: 15 }, decision: 'GO' },
    { name: 'failed everywhere', p: {}, w: {}, rules: { maxFundingBps: 1 }, decision: 'WAIT' },
    { name: 'regimeCheck true against the side', p: {}, w: against, rules: { regimeCheck: true }, decision: 'WAIT' },
    { name: 'regimeCheck false against the side', p: {}, w: against, rules: { regimeCheck: false }, decision: 'GO' },
    { name: 'a size limit that moves capacity, the split and the size guard', p: {}, w: {}, rules: { maxSizePctOf24hVolume: 0.00005 }, decision: 'WAIT' },
    { name: 'a rule whose inputs were not sent', p: {}, w: {}, rules: { maxLossAtStopPctEquity: 1 }, decision: 'CAUTION' },
    { name: 'noLiqBeforeStop false with liquidation inside the stop', p: { leverage: 25, stopPct: 5 }, w: {}, rules: { noLiqBeforeStop: false }, decision: 'GO' },
    { name: 'three rules that all pass on a tier-publishing venue', p: { leverage: 10, stopPct: 2, equityUsd: 50_000 }, w: {},
      rules: { maxLeverage: 10, maxLossAtStopPctEquity: 1, minLiqDistanceSigma: 1 }, decision: 'GO' },
    { name: 'a sigma rule with no fresh 1h volatility', p: {}, w: noSigma, rules: { maxAccuracyNeededPct: 60 }, decision: 'CAUTION' },
  ];

  for (const c of corpus) {
    it(`${c.name}: ${c.decision} either way`, async () => {
      const sent = await ok(P({ ...c.p, rules: c.rules }), world(c.w));
      const fromProfile = await ok(P(c.p), world({ ...c.w, profile: saved(c.rules) }));
      expect(sent.decision, 'fixture: the sent rule set decides as recorded in DECISION-CALL-V2-W1').toBe(c.decision);
      expect(judged(fromProfile)).toEqual(judged(sent));
      expect(fromProfile.rules.filter((x) => Object.keys(c.rules).includes(x.id)).every((x) => x.source === 'saved')).toBe(true);
      expect(fromProfile.saved_rules).toEqual({ applied: true, updated_at: SAVED_AT });
      expect(sent.saved_rules).toEqual({ applied: false, updated_at: null });
    });
  }

  it('a failed saved rule: WAIT, YOUR_RULE_FAILED, rules[] marks it saved, one read, one unit', async () => {
    const w = world({ profile: saved({ maxLeverage: 5 }) });
    const lic = keyed();
    const r = await ok(P({ leverage: 20 }), w, lic);
    expect(r.decision).toBe('WAIT');
    expect(r.reasons).toEqual([{ code: 'YOUR_RULE_FAILED', severity: 'block', detail: 'Your rule failed on OKX: maxLeverage — Leverage 20x is above the limit of 5x.' }]);
    expect(r.rules[0]).toEqual({ id: 'maxLeverage', source: 'saved', limit: 5, value: 20, result: 'fail', detail: 'Leverage 20x is above the limit of 5x.' });
    expect(r.venues.map((v) => v.your_rules)).toEqual(['fail', 'fail', 'fail', 'fail']);
    expect(w.profileReads).toEqual([lic.key]);
    expect(checkQuota(lic).used, 'a WAIT is billed one unit').toBe(1);
  });

  it('a saved rule not evaluated: YOUR_RULE_NOT_CHECKED adjusts and names what to send', async () => {
    const r = await ok(P(), world({ profile: saved({ maxLeverage: 5 }) }));
    expect(r.decision).toBe('CAUTION');
    expect(r.reasons).toEqual([{ code: 'YOUR_RULE_NOT_CHECKED', severity: 'adjust', detail: 'Your rule was not checked on BINANCE: maxLeverage — Send leverage to check this rule.' }]);
    expect(r.rules[0]).toMatchObject({ id: 'maxLeverage', source: 'saved', result: 'not_evaluated' });
  });
});

describe('the layers through the handler: a call\'s own rule overrides the saved one for that call', () => {
  it('saved maxLeverage 5 + the call\'s maxLeverage 25 at leverage 20: the call\'s passes as yours; the other saved key still applies', async () => {
    const w = world({ profile: saved({ maxLeverage: 5, maxFundingBps: 1 }) });
    const r = await ok(P({ leverage: 20, rules: { maxLeverage: 25 } }), w);
    expect(r.rules.find((x) => x.id === 'maxLeverage')).toEqual({ id: 'maxLeverage', source: 'yours', limit: 25, value: 20, result: 'pass', detail: 'Leverage 20x is within the limit of 25x.' });
    expect(r.rules.find((x) => x.id === 'maxFundingBps')).toMatchObject({ source: 'saved', limit: 1, result: 'fail' });
    expect([r.decision, codes(r)]).toEqual(['WAIT', ['YOUR_RULE_FAILED']]);
    expect(r.saved_rules).toEqual({ applied: true, updated_at: SAVED_AT });
  });

  it('the call overriding every saved key: GO, and the profile still counts as applied', async () => {
    const r = await ok(P({ leverage: 20, rules: { maxLeverage: 25 } }), world({ profile: saved({ maxLeverage: 5 }) }));
    expect([r.decision, r.reasons]).toEqual(['GO', []]);
    expect(r.rules.map((x) => x.source)).toEqual(['yours', 'default', 'default', 'default', 'default']);
    expect(r.saved_rules.applied).toBe(true);
  });

  it('saved regimeCheck false drops the default against the side; the call\'s regimeCheck true turns it back on', async () => {
    const off = await ok(P(), world({ ...against, profile: saved({ regimeCheck: false }) }));
    expect([off.decision, off.reasons, off.rules.map((x) => x.id)]).toEqual(['GO', [], ['noLiqBeforeStop', 'maxFundingBps', 'maxSizePctOf24hVolume']]);
    const on = await ok(P({ rules: { regimeCheck: true } }), world({ ...against, profile: saved({ regimeCheck: false }) }));
    expect(on.rules.find((x) => x.id === 'regimeCheck')).toMatchObject({ source: 'yours', result: 'fail' });
    expect([on.decision, codes(on)]).toEqual(['WAIT', ['YOUR_RULE_FAILED']]);
  });

  it('an empty saved profile changes nothing but saved_rules', async () => {
    const none = await ok(P(), world());
    const empty = await ok(P(), world({ profile: saved({}) }));
    expect(judged(empty)).toEqual(judged(none));
    expect([none.saved_rules, empty.saved_rules]).toEqual([{ applied: false, updated_at: null }, { applied: true, updated_at: SAVED_AT }]);
  });
});

// ── An unreadable profile is never GO ───────────────────────────────────────────────────────────────

describe('an unreadable profile is never GO', () => {
  it('a read that fails: SAVED_RULES_UNAVAILABLE (adjust) → CAUTION, defaults only, applied false', async () => {
    const healthy = await ok(P(), world());
    expect([healthy.decision, healthy.reasons], 'vacuity guard: this world is GO without a profile').toEqual(['GO', []]);
    const r = await ok(P(), world({ profile: unreadable }));
    expect(r.decision).toBe('CAUTION');
    expect(r.reasons).toEqual([{ code: 'SAVED_RULES_UNAVAILABLE', severity: 'adjust', detail: 'Your saved rules could not be read, so this check did not apply them.' }]);
    expect(r.rules).toEqual(healthy.rules);
    expect(r.saved_rules).toEqual({ applied: false, updated_at: null });
  });

  it('SAVED_RULES_UNAVAILABLE is an adjust reason, after YOUR_RULE_NOT_CHECKED', () => {
    const order = Object.keys(PRE_TRADE_REASONS);
    expect(PRE_TRADE_REASONS.SAVED_RULES_UNAVAILABLE).toBe('adjust');
    expect(order.indexOf('SAVED_RULES_UNAVAILABLE')).toBe(order.indexOf('YOUR_RULE_NOT_CHECKED') + 1);
  });

  it('a synchronous throw, a rejected promise and a missing reader are all unreadable', async () => {
    const sync = world();
    sync.deps.ruleProfile = () => { throw new Error('ALGOVAULT_IP_HASH_KEY is not set'); };
    const missing = world();
    delete (missing.deps as Partial<PreTradeCheckDeps>).ruleProfile;
    for (const w of [sync, missing, world({ profile: unreadable })]) {
      const r = await ok(P(), w);
      expect([r.decision, codes(r), r.saved_rules.applied]).toEqual(['CAUTION', ['SAVED_RULES_UNAVAILABLE'], false]);
    }
  });

  it('unreadable with a failing sent rule: WAIT, and still says the saved rules were not applied', async () => {
    const r = await ok(P({ rules: { maxFundingBps: 1 } }), world({ profile: unreadable }));
    expect([r.decision, codes(r)]).toEqual(['WAIT', ['YOUR_RULE_FAILED', 'SAVED_RULES_UNAVAILABLE']]);
  });
});

// ── Who reads ───────────────────────────────────────────────────────────────────────────────────────

describe('a keyed call reads its profile once; keyless, x402 and internal calls never read', () => {
  it('zero reads for a keyless, an x402, an internal, a malformed and an invalid-token call — decided as with no profile', async () => {
    const reference = judged(await ok(P(), world()));
    for (const lic of [KEYLESS, X402, INTERNAL, MALFORMED, TOKEN_INVALID]) {
      const w = world({ profile: saved({ maxFundingBps: 1 }) });
      const r = await ok(P(), w, lic);
      expect(w.profileReads, `${lic.tier}/${lic.outcome}`).toEqual([]);
      expect(judged(r)).toEqual(reference);
      expect(r.saved_rules).toEqual({ applied: false, updated_at: null });
    }
  });

  it('exactly one read for a resolved key, and for a key whose tier could not be determined', async () => {
    for (const lic of [keyed(), { ...keyed(), outcome: 'INDETERMINATE' as const, indeterminate: true as const, retryable: true }]) {
      const w = world();
      await ok(P(), w, lic);
      expect(w.profileReads).toEqual([lic.key]);
    }
  });

  it('a refused call reads nothing: invalid_parameter, and the quota wall', async () => {
    const w = world({ profile: saved({ maxLeverage: 5 }) });
    const out = await runPreTradeCheck(P({ rules: { foo: 1 } }), keyed(), w.deps);
    expect(out.kind).toBe('refused');
    const lic = keyed();
    for (let i = 0; i < FREE_DAILY_CALLS; i++) trackCall(lic);
    await expect(runPreTradeCheck(P(), lic, w.deps)).rejects.toBeInstanceOf(TierLimitReachedError);
    expect(w.profileReads).toEqual([]);
  });
});

// ── The store ───────────────────────────────────────────────────────────────────────────────────────

const HASH_ENV = 'ALGOVAULT_IP_HASH_KEY';
const prevHashKey = process.env[HASH_ENV];
beforeAll(() => { process.env[HASH_ENV] = 'f3'.repeat(32); });
afterAll(() => { if (prevHashKey === undefined) delete process.env[HASH_ENV]; else process.env[HASH_ENV] = prevHashKey; });

const MIGRATION = readFileSync(join(ROOT, 'migrations/052_pre_trade_rule_profiles.sql'), 'utf8');
const DOWN = readFileSync(join(ROOT, 'migrations/052_pre_trade_rule_profiles.down.sql'), 'utf8');
const sqlOf = (i: number) => String(q.mock.calls[i][0]);
const creates = () => x.mock.calls.filter((c) => /CREATE TABLE IF NOT EXISTS pre_trade_rule_profiles/.test(String(c[0])));
/** The CREATE statement with its comments dropped and its whitespace collapsed (the migration's `;` cut off). */
const normalized = (sql: string) => {
  const s = sql.replace(/--[^\n]*/g, '');
  const start = s.indexOf('CREATE TABLE IF NOT EXISTS pre_trade_rule_profiles');
  return s.slice(start, s.lastIndexOf(')') + 1).replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();
};
const REF = () => profileRefOf(keyed().key as string);

describe('the store: one table, keyed by the pseudonym, a read error throws', () => {
  beforeEach(() => {
    _resetRuleProfilesForTest();
    q.mockReset();
    x.mockReset();
  });

  it('the lazy ensure IS migrations/052, and the down file drops only that table', async () => {
    q.mockResolvedValue([]);
    await getProfile(REF());
    expect(creates()).toHaveLength(1);
    expect(normalized(String(creates()[0][0]))).toBe(normalized(MIGRATION));
    expect(DOWN.replace(/--[^\n]*/g, '').trim()).toBe('DROP TABLE IF EXISTS pre_trade_rule_profiles;');
  });

  it('the table has nowhere to put a raw key, an address, an IP or equity: four columns', () => {
    const cols = normalized(MIGRATION).replace(/^.*?\(/, '').replace(/\)$/, '').split(',').map((c) => c.trim().split(' ')[0]);
    expect(cols).toEqual(['caller_ref', 'rules', 'created_at', 'updated_at']);
  });

  it('getProfile: ensure once, then one select by the ref; the rules parsed, the times ISO', async () => {
    const ref = REF();
    q.mockResolvedValueOnce([{ rules: { maxLeverage: 5, regimeCheck: false }, created_at: new Date(SAVED_AT), updated_at: new Date(SAVED_AT) }]);
    expect(await getProfile(ref)).toEqual({ rules: { maxLeverage: 5, regimeCheck: false }, createdAt: SAVED_AT, updatedAt: SAVED_AT });
    expect(sqlOf(0)).toMatch(/^SELECT rules, created_at, updated_at FROM pre_trade_rule_profiles WHERE caller_ref = \?$/);
    expect(q.mock.calls[0][1]).toEqual([ref]);
    q.mockResolvedValueOnce([]);
    expect(await getProfile(ref), 'no row: null').toBeNull();
    expect(creates(), 'the ensure ran once').toHaveLength(1);
    expect(q.mock.calls.some((c) => /CREATE/.test(String(c[0]))), 'DDL never goes through dbQuery (.all() on SQLite)').toBe(false);
  });

  it('the SQLite shapes read the same: jsonb as text, timestamps as text', async () => {
    q.mockResolvedValueOnce([{ rules: '{"maxFundingBps":3}', created_at: SAVED_AT, updated_at: SAVED_AT }]);
    expect(await getProfile(REF())).toEqual({ rules: { maxFundingBps: 3 }, createdAt: SAVED_AT, updatedAt: SAVED_AT });
  });

  it('two first reads at once issue one ensure; an ensure that throws fails that read, and the next read retries it', async () => {
    q.mockResolvedValue([]);
    await Promise.all([getProfile(REF()), getProfile(REF())]);
    expect(creates()).toHaveLength(1);
    _resetRuleProfilesForTest();
    q.mockReset();
    x.mockReset();
    q.mockResolvedValue([]);
    x.mockImplementationOnce(() => { throw new Error('permission denied for schema public'); });
    await expect(getProfile(REF())).rejects.toThrow('permission denied');
    expect(q, 'no read behind a failed ensure').not.toHaveBeenCalled();
    await getProfile(REF());
    expect(creates()).toHaveLength(2);
  });

  it('a read error throws — the caller decides', async () => {
    q.mockRejectedValueOnce(new Error('connection terminated unexpectedly'));
    await expect(getProfile(REF())).rejects.toThrow('connection terminated');
  });

  it('a stored value that no longer parses is a read error, never a partial profile', async () => {
    for (const rules of [{ maxLeverage: 5, foo: 1 }, { maxLeverage: 500 }, '[1]', 'not json', null]) {
      _resetRuleProfilesForTest();
      q.mockReset();
      q.mockResolvedValueOnce([{ rules, created_at: SAVED_AT, updated_at: SAVED_AT }]);
      await expect(getProfile(REF()), JSON.stringify(rules)).rejects.toThrow();
    }
    q.mockReset();
    q.mockResolvedValueOnce([{ rules: {}, created_at: 'yesterday', updated_at: SAVED_AT }]);
    await expect(getProfile(REF()), 'an unreadable timestamp').rejects.toThrow();
  });

  it('anything but a pc1 pseudonym is refused before any SQL — a raw key can never be a row id', async () => {
    for (const ref of [keyed().key as string, '', 'pc1:XYZ', `pc1:${'a'.repeat(31)}`, `pc2:${'a'.repeat(32)}`]) {
      await expect(getProfile(ref), ref).rejects.toThrow(/pseudonym/);
    }
    expect(q).not.toHaveBeenCalled();
    expect(x).not.toHaveBeenCalled();
  });

  it('profileRefOf is the check log\'s callerRef of the key: a pc1 pseudonym, one per key, never the key', () => {
    const a = keyed().key as string;
    const b = keyed().key as string;
    expect(profileRefOf(a)).toBe(callerRef({ licenseKey: a }));
    expect(profileRefOf(a)).toMatch(/^pc1:[0-9a-f]{32}$/);
    expect(profileRefOf(a)).not.toBe(profileRefOf(b));
    expect(profileRefOf(a)).not.toContain(a.slice(8));
  });

  it('profileKeyOf: the key of a keyed caller; null for keyless, x402, internal, malformed and invalid-token callers', () => {
    const k = keyed();
    expect(profileKeyOf(k)).toBe(k.key);
    expect(profileKeyOf({ tier: 'starter', key: k.key })).toBe(k.key);
    expect(profileKeyOf({ ...k, outcome: 'INDETERMINATE' })).toBe(k.key);
    expect(profileKeyOf({ ...k, anonymous: true }), 'an ephemeral free key is still a key').toBe(k.key);
    for (const lic of [KEYLESS, X402, INTERNAL, MALFORMED, TOKEN_INVALID, { tier: 'x402' as const, key: k.key }, { tier: 'internal' as const, key: k.key }]) {
      expect(profileKeyOf(lic), JSON.stringify(lic)).toBeNull();
    }
  });

  it('the handler\'s default reader is the store, by the pseudonym: the raw key reaches no statement', async () => {
    const lic = keyed();
    q.mockResolvedValueOnce([{ rules: { maxLeverage: 5 }, created_at: SAVED_AT, updated_at: SAVED_AT }]);
    expect(await DEFAULT_PRE_TRADE_CHECK_DEPS.ruleProfile(lic.key as string)).toEqual({ rules: { maxLeverage: 5 }, createdAt: SAVED_AT, updatedAt: SAVED_AT });
    expect(q.mock.calls[0][1]).toEqual([callerRef({ licenseKey: lic.key })]);
    expect(JSON.stringify([q.mock.calls, x.mock.calls])).not.toContain(lic.key as string);
  });

  it('without the hash key the default reader fails — so the handler reports the saved rules unavailable', async () => {
    const lic = keyed();
    delete process.env[HASH_ENV];
    try {
      const w = world();
      w.deps.ruleProfile = DEFAULT_PRE_TRADE_CHECK_DEPS.ruleProfile;
      const r = await ok(P(), w, lic);
      expect([r.decision, codes(r)]).toEqual(['CAUTION', ['SAVED_RULES_UNAVAILABLE']]);
      expect(q).not.toHaveBeenCalled();
    } finally {
      process.env[HASH_ENV] = 'f3'.repeat(32);
    }
  });

  it('a corrupt stored profile reaches the handler as unavailable, through the default reader', async () => {
    q.mockResolvedValueOnce([{ rules: { maxLeverage: 5, retired_rule: 1 }, created_at: SAVED_AT, updated_at: SAVED_AT }]);
    const w = world();
    w.deps.ruleProfile = DEFAULT_PRE_TRADE_CHECK_DEPS.ruleProfile;
    const r = await ok(P({ leverage: 20 }), w);
    expect([r.decision, codes(r)]).toEqual(['CAUTION', ['SAVED_RULES_UNAVAILABLE']]);
    expect(r.rules.map((x) => x.source)).toEqual(['default', 'default', 'default', 'default']);
  });
});

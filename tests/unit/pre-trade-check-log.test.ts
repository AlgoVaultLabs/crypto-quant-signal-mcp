/**
 * DECISION-CALL-V2-W1 CH3 (AC3.1) — the pre_trade_check check log (src/lib/pre-trade-check-log.ts).
 *
 * Driven through the REAL pipeline (`callTool`) and the REAL handler: only the handler's data seam is pinned
 * (no network), `dbQuery` is a mock that records every statement, and request_log's writer is silenced. So
 * "one row per served billed call" is measured where the row is written, with billing counted by the real
 * meter — never asserted on a stub of the writer.
 *
 * DECISION-CALL-V2-PAYER-REF-W1 — an x402 check is logged under its PAYER's pseudonym. The HTTP rail is driven
 * through the real route (`mountX402HttpRoutes` → the pipeline's `requestContext.run`); the MCP rail through
 * the real `resolveLicense` and the route's own seam (`resolvePayerWallet`), with the `/mcp` store literal
 * pinned by source because `startHttp` is not exported (the auth-refusal-mcp precedent). Only the payment
 * proof, its price binding and the claim's answer are levers (`pay`); off, they are the real modules.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ExchangeAsset } from '../../src/lib/exchange-universe.js';
import type { RegimeSnapshotRow, ServableGeneration } from '../../src/lib/regime-snapshots.js';
import type { VenueFundingRow } from '../../src/lib/venue-market-state.js';
import type { PreTradeCheckDeps } from '../../src/tools/pre-trade-check.js';

const H = 3_600_000;
const NOW = Date.parse('2026-10-30T12:00:00Z');
const VENUES = ['BINANCE', 'BYBIT', 'OKX', 'BITGET'] as const;
const VENUE_STRING: Record<string, string> = { BINANCE: 'BinPerp', BYBIT: 'BybitPerp', OKX: 'OKXPerp', BITGET: 'BitgetPerp' };

/** A healthy world, as the handler suite builds it: BTC on all four venues, quoted 99,990 / 100,010. */
const testDeps = vi.hoisted(() => ({ make: null as null | (() => PreTradeCheckDeps), dropFacts: false }));

vi.mock('../../src/lib/performance-db.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/performance-db.js')>()),
  // `residency:'hosted'`: the pipeline's admission reads this before the tool runs.
  isPgBackend: () => true,
  dbQuery: vi.fn(),
}));
vi.mock('../../src/lib/analytics.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/analytics.js')>()),
  logRequest: vi.fn(),
}));
vi.mock('../../src/tools/pre-trade-check.js', async (orig) => {
  const m = await orig<typeof import('../../src/tools/pre-trade-check.js')>();
  // The pipeline row calls runPreTradeCheck(params, license); pin its data seam, keep the engine and billing real.
  // `dropFacts` serves the real, billed outcome WITHOUT its internal facts — the shape the x402 suites stub.
  return {
    ...m,
    runPreTradeCheck: async (p: never, lic: never, deps?: PreTradeCheckDeps) => {
      const o = await m.runPreTradeCheck(p, lic, deps ?? testDeps.make!());
      return testDeps.dropFacts && o.kind === 'ok' ? { kind: o.kind, response: o.response } : o;
    },
  };
});

/**
 * The x402 levers (DECISION-CALL-V2-PAYER-REF-W1). Off — the default — every override below delegates to the real
 * module, so the suites that predate the payer run exactly as they did. On: a proof verifies with `from: pay.from`
 * and a fresh nonce, its price binding passes, the claim answers `pay.claim` (the replay lever
 * `tests/x402-mcp-replay.test.ts` uses) and settle / unserved are counted instead of sent.
 */
const pay = vi.hoisted(() => ({
  on: false,
  from: '',
  claim: 'CLAIMED' as 'CLAIMED' | 'ALREADY_CLAIMED' | 'INDETERMINATE',
  nonces: 0,
  settles: 0,
  unserved: 0,
}));
vi.mock('../../src/lib/x402.js', async (orig) => {
  const m = await orig<typeof import('../../src/lib/x402.js')>();
  const requirement = {
    scheme: 'exact', network: 'eip155:8453', amount: '20000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    payTo: '0x778A05280Fd8dB980E920fE9f31d0A8eAbD17d59', maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' },
  };
  return {
    ...m,
    isX402Configured: () => pay.on || m.isX402Configured(),
    verifyX402Payment: async (...a: Parameters<typeof m.verifyX402Payment>) => {
      if (!pay.on) return m.verifyX402Payment(...a);
      const nonce = `0x${(++pay.nonces).toString(16).padStart(64, 'c')}`;
      const authorization = { from: pay.from, to: requirement.payTo, value: requirement.amount, validAfter: '0', validBefore: '9999999999', nonce };
      return {
        valid: true,
        payer: pay.from,
        _settlement: { requirements: requirement, paymentPayload: { x402Version: 2, accepted: requirement, payload: { signature: '0xsig', authorization } } },
      };
    },
    paymentMatchesToolRoute: (...a: Parameters<typeof m.paymentMatchesToolRoute>) => pay.on || m.paymentMatchesToolRoute(...a),
    settleX402Async: (...a: Parameters<typeof m.settleX402Async>) => { if (pay.on) pay.settles += 1; else m.settleX402Async(...a); },
    markX402Unserved: (...a: Parameters<typeof m.markX402Unserved>) => { if (pay.on) pay.unserved += 1; else m.markX402Unserved(...a); },
  };
});
vi.mock('../../src/lib/x402-idempotency-store.js', async (orig) => {
  const m = await orig<typeof import('../../src/lib/x402-idempotency-store.js')>();
  return { ...m, tryClaimPayment: async (...a: Parameters<typeof m.tryClaimPayment>) => (pay.on ? pay.claim : m.tryClaimPayment(...a)) };
});

import { dbQuery } from '../../src/lib/performance-db.js';
import { callTool, type ValidatedToolInput } from '../../src/lib/tool-call-pipeline.js';
import { runPreTradeCheck } from '../../src/tools/pre-trade-check.js';
import {
  recordPreTradeCheck,
  toPreTradeCheckLogRow,
  adoptPreTradeCheckTable,
  countLoggedChecks,
  countServedChecks,
  firstLoggedCheckAt,
  _resetPreTradeCheckLogForTest,
  _preTradeCheckLogFailuresForTest,
} from '../../src/lib/pre-trade-check-log.js';
import { callerRef, hashEmail, PRE_TRADE_CALLER_REF_VERSION } from '../../src/lib/lifecycle/identity.js';
import {
  checkQuota,
  trackCall,
  _resetCallTrackersForTest,
  resetLicenseCache,
  requestContext,
  resolveLicense,
  resolvePayerWallet,
} from '../../src/lib/license.js';
import { FREE_DAILY_CALLS } from '../../src/lib/plans.js';
import type { LicenseInfo } from '../../src/types.js';

testDeps.make = (): PreTradeCheckDeps => ({
  now: () => NOW,
  retiredVenues: async () => new Set(),
  venueUniverse: async () => ({ rows: [{ coin: 'BTC', notionalOI_usd: 5e8, volume24h_usd: 1e10, bidPx: 99_990, askPx: 100_010 } as ExchangeAsset], failed: false }),
  fundingSnapshot: async () => ({
    byCoin: new Map([['BTC', VENUES.map((v) => ({ venue: VENUE_STRING[v], fundingRate: 0.0001, nextFundingTime: NOW + 4 * H, intervalHours: 8 }) as VenueFundingRow)]]),
    failedVenues: new Set(),
  }),
  sampledRegimeVenues: async () => [...VENUES],
  latestServableGeneration: async (venue, tf) => ({ exchange: venue, timeframe: tf, bar_close_ms: NOW - H, disposition: 'COMPLETE', universe_n: 1, written_n: 1, too_new_n: 0, window_stale_n: 0, coverage: 1, tick_at: NOW - H, finished_at: NOW - H }) as ServableGeneration,
  readGenerationRow: async (venue, tf, bar, coin) => ({ exchange: venue, timeframe: tf, bar_close_ms: bar, coin, regime: 'RANGING', confidence: 50, volatility_ratio: 0.01 }) as RegimeSnapshotRow,
  resolveAssetClass: async () => 'CRYPTO' as never,
  venueStatus: async () => 'promoted',
  marginTierAt: async (venue) => (venue === 'BINANCE' ? { rate: null, basis: 'tier_table_requires_key' } : { rate: 0.004, basis: 'public_tier_table' }),
});

const ROOT = resolve(__dirname, '../..');
const MIGRATION = readFileSync(join(ROOT, 'migrations/051_pre_trade_checks.sql'), 'utf8');
const STORE = readFileSync(join(ROOT, 'src/lib/pre-trade-check-log.ts'), 'utf8');
const KEY_ENV = 'ALGOVAULT_IP_HASH_KEY';
const TEST_KEY = 'pre-trade-check-log-test-key-0123456789abcdef';
/** Two wallets in their EIP-55 checksum form (the spec's own vectors; `viem.getAddress` agrees). */
const PAYER_A = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const PAYER_B = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
/**
 * R0 — `callerRef` of three keys under TEST_KEY, from the UNEDITED function at origin/main `793362cb`
 * (identity.ts sha256 da10cf03…) — a well-formed live key, a free key and the unexpanded-env compat string.
 * Both key bodies are ones the secret scan exempts (its documented fixture; ≤ 4 distinct hex digits).
 */
const R0_KEY_REFS: ReadonlyArray<readonly [string, string]> = [
  ['av_live_0123456789abcdef01234567', 'pc1:2404616e61e42f5e97e93a98b3fe3afb'],
  ['av_free_abcdabcdabcdabcdabcdabcd', 'pc1:2ed3dd48efc0a4b5dc8fe431097d7621'],
  ['${env:AV_API_KEY}', 'pc1:b5eb88ae18b8174713cf9e83d9d4d9cd'],
];

const q = vi.mocked(dbQuery);
const inserts = () => q.mock.calls.filter((c) => /INSERT INTO pre_trade_checks/.test(String(c[0])));
const creates = () => q.mock.calls.filter((c) => /CREATE TABLE IF NOT EXISTS pre_trade_checks/.test(String(c[0])));
/** The write is fire-and-forget: let every pending microtask and the next macrotask run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

let n = 0;
const freeLicense = (): LicenseInfo => ({ tier: 'free', key: `av_free_ptclog_${++n}`, outcome: 'RESOLVED' } as LicenseInfo);
const INTERNAL: LicenseInfo = { tier: 'internal', key: null, outcome: 'RESOLVED' } as LicenseInfo;
const X402: LicenseInfo = { tier: 'x402', key: null, outcome: 'RESOLVED' } as LicenseInfo;
const IN = (over: Record<string, unknown> = {}) => ({ coin: 'BTC', side: 'long', sizeUsd: 10_000, ...over }) as unknown as ValidatedToolInput;
const call = (license: LicenseInfo, input = IN(), channel: 'mcp' | 'httpX402' = 'mcp') =>
  callTool({ tool: 'pre_trade_check', channel, license, input, ...(channel === 'httpX402' ? { ctx: { sessionId: 's-1', ipHash: 'h-1', isAutomated: false } } : {}) });

let savedKey: string | undefined;
beforeAll(() => { savedKey = process.env[KEY_ENV]; });
afterAll(() => { if (savedKey === undefined) delete process.env[KEY_ENV]; else process.env[KEY_ENV] = savedKey; });
beforeEach(() => {
  process.env[KEY_ENV] = TEST_KEY;
  testDeps.dropFacts = false;
  q.mockReset();
  q.mockResolvedValue([]);
  _resetPreTradeCheckLogForTest();
  _resetCallTrackersForTest();
  resetLicenseCache();
});

/** Column `name type` pairs of the CREATE TABLE body (digits allowed in names: sigma_1h_pct). */
function columnsOf(sql: string): string[] {
  const start = sql.indexOf('CREATE TABLE IF NOT EXISTS pre_trade_checks');
  if (start === -1) return [];
  const open = sql.indexOf('(', start);
  let depth = 0, end = -1;
  for (let i = open; i < sql.length; i += 1) {
    if (sql[i] === '(') depth += 1;
    else if (sql[i] === ')') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  return sql.slice(open + 1, end).split('\n')
    .map((l) => l.replace(/--.*$/, '').trim())
    .filter((l) => /^[a-z_][a-z0-9_]*\s/.test(l))
    .map((l) => { const [name, type] = l.split(/\s+/); return `${name} ${type.replace(/,$/, '')}`; });
}

describe('AC3.1 — the schema: the lazy ensure IS migrations/051, and it has nowhere to put a secret', () => {
  it('same columns, same types, in the same order; the checked_at index in both', () => {
    const a = columnsOf(MIGRATION);
    expect(a.length, 'migration parser found nothing').toBeGreaterThan(15);
    expect(columnsOf(STORE)).toEqual(a);
    const idx = 'CREATE INDEX IF NOT EXISTS idx_pre_trade_checks_checked_at ON pre_trade_checks (checked_at)';
    expect(MIGRATION).toContain(idx);
    expect(STORE).toContain(idx);
  });

  it('the contract\'s columns, exactly — no equity, key, address, wallet, payer or IP column', () => {
    const cols = columnsOf(MIGRATION).map((c) => c.split(' ')[0]);
    expect(cols).toEqual(['id', 'checked_at', 'rule_version', 'channel', 'caller_ref', 'coin', 'side', 'size_usd', 'hold_hours', 'timeframe',
      'order_type', 'leverage', 'stop_pct', 'target_pct', 'decision', 'decision_venue', 'sigma_1h_pct', 'liq_distance_pct', 'ref_mid_px', 'rules', 'venues']);
    for (const c of cols) expect(c, c).not.toMatch(/equity|key|address|wallet|payer|(^|_)ip($|_)/);
  });

  it('the down migration drops only this table and its index, and says it is destructive', () => {
    const down = readFileSync(join(ROOT, 'migrations/051_pre_trade_checks.down.sql'), 'utf8');
    expect(down).toContain('DESTRUCTIVE');
    expect(down.split('\n').filter((l) => /^\s*DROP /.test(l))).toEqual(['DROP INDEX IF EXISTS idx_pre_trade_checks_checked_at;', 'DROP TABLE IF EXISTS pre_trade_checks;']);
  });

  it('never on a public surface: the only SQL against pre_trade_checks in src/ is the log module\'s', () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
    walk(join(ROOT, 'src'));
    expect(files.length, 'the scan must have a corpus').toBeGreaterThan(100);
    const hits = files.filter((f) => /(FROM|INTO|UPDATE|TABLE IF NOT EXISTS)\s+pre_trade_checks\b/.test(readFileSync(f, 'utf8')));
    expect(hits.map((f) => f.slice(ROOT.length + 1))).toEqual(['src/lib/pre-trade-check-log.ts']);
  });
});

describe('AC3.1 — callerRef: the hashEmail pattern under its own domain', () => {
  const keyRef = (licenseKey: string) => callerRef({ licenseKey });

  it('pc1:<32 hex>, stable per key, different across keys', () => {
    const a = keyRef('av_free_alpha');
    expect(a).toMatch(new RegExp(`^${PRE_TRADE_CALLER_REF_VERSION}:[0-9a-f]{32}$`));
    expect(keyRef('av_free_alpha')).toBe(a);
    expect(keyRef('av_free_beta')).not.toBe(a);
    expect(keyRef('AV_FREE_ALPHA'), 'a key is used exactly as presented').not.toBe(a);
  });

  it('domain-separated: never the email hash of the same string, and keyed — another secret, another pseudonym', () => {
    expect(keyRef('av_free_alpha')!.slice(4)).not.toBe(hashEmail('av_free_alpha').slice(4));
    const before = keyRef('av_free_alpha');
    process.env[KEY_ENV] = `${TEST_KEY}-rotated`;
    expect(keyRef('av_free_alpha')).not.toBe(before);
  });

  it('never an unkeyed value: no usable IP-hash key throws for a key and for a payer', () => {
    for (const caller of [{ licenseKey: 'av_free_alpha' }, { payerWallet: PAYER_A }]) {
      delete process.env[KEY_ENV];
      expect(() => callerRef(caller)).toThrow();
      process.env[KEY_ENV] = 'changeme';
      expect(() => callerRef(caller)).toThrow();
    }
  });
});

describe('DECISION-CALL-V2-PAYER-REF-W1 — callerRef: the license key, else the x402 payer, else null', () => {
  it('R0: a key returns exactly the bytes it did before the payer existed — and wins over a payer', () => {
    for (const [licenseKey, ref] of R0_KEY_REFS) {
      expect(callerRef({ licenseKey }), licenseKey).toBe(ref);
      expect(callerRef({ licenseKey, payerWallet: PAYER_A }), `${licenseKey} + a payer`).toBe(ref);
    }
  });

  it('a payer is pc1:<32 hex>; its checksum and lower-case forms are one wallet, one ref; two wallets, two refs', () => {
    const a = callerRef({ payerWallet: PAYER_A });
    expect(a).toMatch(new RegExp(`^${PRE_TRADE_CALLER_REF_VERSION}:[0-9a-f]{32}$`));
    expect(callerRef({ payerWallet: PAYER_A.toLowerCase() })).toBe(a);
    expect(callerRef({ licenseKey: null, payerWallet: PAYER_A.toUpperCase().replace('0X', '0x') })).toBe(a);
    expect(callerRef({ payerWallet: PAYER_B })).not.toBe(a);
  });

  it('a key equal to a payer string is another caller — in either case', () => {
    for (const s of [PAYER_A, PAYER_A.toLowerCase()]) {
      expect(callerRef({ licenseKey: s }), s).not.toBe(callerRef({ payerWallet: s }));
    }
  });

  it('a key spelled `payer:<address>` is not that payer — a non-key-shaped bearer is served with its raw string as the key while Stripe is indeterminate', () => {
    const lower = PAYER_A.toLowerCase();
    expect(callerRef({ licenseKey: `payer:${lower}` })).not.toBe(callerRef({ payerWallet: lower }));
  });

  it('neither → null, without reading the IP-hash key; an empty key is no key', () => {
    delete process.env[KEY_ENV];
    expect(callerRef({})).toBeNull();
    expect(callerRef({ licenseKey: null, payerWallet: null })).toBeNull();
    process.env[KEY_ENV] = TEST_KEY;
    expect(callerRef({ licenseKey: '' })).toBeNull();
    expect(callerRef({ licenseKey: '', payerWallet: PAYER_A })).toBe(callerRef({ payerWallet: PAYER_A }));
  });
});

describe('AC3.1 — one row per served, billed call, through the real pipeline', () => {
  it('MCP, a keyed caller: ONE row, every column from the served response, one unit billed', async () => {
    const lic = freeLicense();
    const out = await call(lic);
    await settle();
    if (!out.ok) throw new Error('expected a served call');
    const r = out.result as Record<string, any>;
    expect(checkQuota(lic).used, 'billing: exactly one unit').toBe(1);
    expect(inserts()).toHaveLength(1);
    const params = inserts()[0][1] as unknown[];
    expect(params.slice(0, 18)).toEqual([
      new Date(NOW).toISOString(), 2, 'mcp', callerRef({ licenseKey: lic.key }), 'BTC', 'long', 10_000, 8, '4h', 'market',
      null, null, null, r.decision, 'BINANCE', 0.6267, null, 100_000,
    ]);
    expect(JSON.parse(params[18] as string)).toEqual(r.rules);
    expect(JSON.parse(params[19] as string)).toEqual(r.venues.map((v: Record<string, unknown>) => ({
      exchange: v.exchange, est_cost_bps: v.est_cost_bps, round_trip_bps: v.round_trip_bps, liq_distance_pct: v.liq_distance_pct, your_rules: v.your_rules,
    })));
    expect(String(inserts()[0][0])).toMatch(/\$19::jsonb, \$20::jsonb\)$/);
  });

  it('each call is its own row; the lazy ensure runs once per process', async () => {
    await call(freeLicense());
    await call(freeLicense());
    await settle();
    expect(inserts()).toHaveLength(2);
    expect(creates()).toHaveLength(1);
  });

  it('the x402 rail with no payer in its ctx: channel httpX402, and no caller_ref — the license has no key', async () => {
    const out = await call(X402, IN(), 'httpX402');
    await settle();
    expect(out.ok).toBe(true);
    const params = inserts()[0][1] as unknown[];
    expect([params[2], params[3]]).toEqual(['httpX402', null]);
  });

  it('a call with v2 inputs logs them — and never the equity it was sent, nor the raw key', async () => {
    const lic = freeLicense();
    await call(lic, IN({ leverage: 20, stopPct: 2, targetPct: 4, equityUsd: 51_234, orderType: 'limit', rules: { maxLeverage: 25 } }));
    await settle();
    const params = inserts()[0][1] as unknown[];
    expect([params[9], params[10], params[11], params[12], params[14], params[17]]).toEqual(['limit', 20, 2, 4, 'OKX', 100_000]);
    const text = JSON.stringify(params);
    expect(text).not.toContain('51234');
    expect(text).not.toContain(lic.key!);
    expect(JSON.parse(params[18] as string)[0]).toMatchObject({ id: 'maxLeverage', source: 'yours', result: 'pass' });
  });

  it('none for a refusal (unbilled)', async () => {
    const lic = freeLicense();
    const out = await call(lic, IN({ side: 'up' }));
    await settle();
    expect(out.ok).toBe(false);
    expect([inserts().length, checkQuota(lic).used]).toEqual([0, 0]);
  });

  it('none for the quota wall (the handler throws before it bills)', async () => {
    const lic = freeLicense();
    for (let i = 0; i < FREE_DAILY_CALLS; i++) trackCall(lic);
    expect(checkQuota(lic).allowed, 'fixture must be walled').toBe(false);
    const out = await call(lic);
    await settle();
    expect(out.ok === false && out.kind).toBe('threw');
    expect(inserts()).toHaveLength(0);
  });

  it('none for an internal caller', async () => {
    const out = await call(INTERNAL);
    await settle();
    expect(out.ok).toBe(true);
    expect(inserts()).toHaveLength(0);
  });

  it('none for the health probe: it calls the ENGINE, and the engine never writes — the row lives in the pipeline only', async () => {
    const out = await runPreTradeCheck({ coin: 'BTC', side: 'long', sizeUsd: 10_000, holdHours: 8, timeframe: '4h' }, freeLicense(), testDeps.make!());
    await settle();
    expect(out.kind).toBe('ok');
    expect(q.mock.calls).toHaveLength(0);
  });
});

describe('AC3.1 — fail-open: a throwing insert leaves the response and billing unchanged', () => {
  const strip = (x: unknown) => JSON.parse(JSON.stringify(x));
  afterEach(() => { vi.useRealTimers(); });

  it('the insert throws: same response as a logged call, one unit billed, the counter bumped, ONE line', async () => {
    // Each license's monthly window is anchored at its own first call on the real clock; freeze it so the
    // two responses are comparable byte for byte, with no field carved out of the comparison.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    const control = await call(freeLicense());
    await settle();
    expect(inserts()).toHaveLength(1);

    q.mockImplementation(async (sql: string) => { if (/INSERT INTO pre_trade_checks/.test(sql)) throw new Error('connection terminated'); return []; });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lic = freeLicense();
    const out = await call(lic);
    await settle();
    expect(out.ok).toBe(true);
    if (!out.ok || !control.ok) throw new Error('expected served calls');
    expect(strip(out.result)).toEqual(strip(control.result));
    expect(checkQuota(lic).used).toBe(1);
    expect(_preTradeCheckLogFailuresForTest()).toBe(1);
    const lines = err.mock.calls.map((c) => c.join(' ')).filter((l) => l.startsWith('[pre-trade-check-log]'));
    expect(lines).toEqual(['[pre-trade-check-log] row not written (failures since start: 1): Error: connection terminated']);
    err.mockRestore();
    vi.useRealTimers();
  });

  it('the pseudonym cannot be derived (no IP-hash key): no row, the call still served and billed', async () => {
    delete process.env[KEY_ENV];
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lic = freeLicense();
    const out = await call(lic);
    await settle();
    expect(out.ok).toBe(true);
    expect(checkQuota(lic).used).toBe(1);
    expect([inserts().length, _preTradeCheckLogFailuresForTest()]).toEqual([0, 1]);
    err.mockRestore();
  });

  it('an outcome the log cannot read (no facts: a stub\'s shape) is still served and billed: no row, the counter bumped', async () => {
    testDeps.dropFacts = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lic = freeLicense();
    const out = await call(lic);
    await settle();
    expect(out.ok).toBe(true);
    expect(checkQuota(lic).used).toBe(1);
    expect([inserts().length, _preTradeCheckLogFailuresForTest()]).toEqual([0, 1]);
    err.mockRestore();
  });

  it('recordPreTradeCheck itself never rejects', async () => {
    q.mockRejectedValue(new Error('down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await runPreTradeCheck({ coin: 'BTC', side: 'long', sizeUsd: 10_000 }, INTERNAL, testDeps.make!());
    if (out.kind !== 'ok') throw new Error('expected ok');
    await expect(recordPreTradeCheck({ response: out.response, facts: out.facts, channel: 'mcp', licenseKey: 'av_x' })).resolves.toBe(false);
    err.mockRestore();
  });
});

describe('DECISION-CALL-V2-PAYER-REF-W1 — an x402 check is logged under its payer, on both rails', () => {
  const ENV: Record<string, string | undefined> = {
    X402_FACILITATOR: 'cdp', BAZAAR_DISCOVERABLE: 'true', CDP_API_KEY_ID: 'test-id', CDP_API_KEY_SECRET: 'test-secret',
    CQS_API_KEY: undefined, // a downgraded proof falls through to the bearer lane: no operator key may answer it
  };
  const saved: Record<string, string | undefined> = {};
  let server: Server | undefined;

  beforeEach(() => {
    Object.assign(pay, { on: true, from: PAYER_A, claim: 'CLAIMED', settles: 0, unserved: 0 });
    for (const [k, v] of Object.entries(ENV)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  afterEach(async () => {
    pay.on = false;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  /** One paid POST to the REAL `/x402/pre_trade_check` route: its ctx enters the pipeline's `requestContext.run`. */
  async function httpCall(): Promise<Response> {
    const express = (await import('express')).default;
    const { mountX402HttpRoutes } = await import('../../src/lib/x402-http-routes.js');
    const app = express();
    expect(mountX402HttpRoutes(app), 'the route must actually be mounted').toContain('/x402/pre_trade_check');
    server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/x402/pre_trade_check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-payment': 'present' },
      body: JSON.stringify({ coin: 'BTC', side: 'long', sizeUsd: 10_000 }),
    });
    await new Promise((r) => setTimeout(r, 20)); // the row and the settle are fire-and-forget after the response
    return res;
  }

  /**
   * The `/mcp` POST for a priced tools/call, as `startHttp` runs it: `resolveLicense` bound to the tool, the payer
   * from the route's own seam, that store installed, then the SDK handler's `callTool` with NO ctx — it inherits
   * the store. `startHttp` is not exported, so the route's store literal is pinned by source below.
   */
  async function mcpCall() {
    const resolved = await resolveLicense({ 'x-payment': 'present' }, { tool: 'pre_trade_check', oauth: true });
    const out = await requestContext.run(
      { license: resolved.license, sessionId: 'mcp-s', ipHash: 'mcp-h', payerWallet: resolvePayerWallet(resolved.pendingSettlement) },
      () => callTool({ tool: 'pre_trade_check', channel: 'mcp', license: resolved.license, input: IN() }),
    );
    await settle();
    return { ...resolved, out };
  }

  const theRow = (): unknown[] => {
    expect(inserts(), 'exactly one row — none would make every caller_ref assertion vacuous').toHaveLength(1);
    return inserts()[0][1] as unknown[];
  };

  it('HTTP rail: the paid call writes its payer\'s pc1 ref, never the address — and still settles exactly once', async () => {
    const res = await httpCall();
    expect(res.status).toBe(200);
    const params = theRow();
    expect([params[2], params[3]]).toEqual(['httpX402', callerRef({ payerWallet: PAYER_A })]);
    expect(JSON.stringify(params).toLowerCase()).not.toContain(PAYER_A.slice(2).toLowerCase());
    expect([pay.settles, pay.unserved]).toEqual([1, 0]);
  });

  it('HTTP rail: a proof whose `from` is not an address writes NULL, and the paid path is unchanged', async () => {
    pay.from = 'not-an-address';
    const res = await httpCall();
    expect(res.status).toBe(200);
    expect(theRow()[3]).toBeNull();
    expect([pay.settles, pay.unserved]).toEqual([1, 0]);
  });

  it('MCP rail: the paid call writes its payer\'s pc1 ref', async () => {
    const { license, pendingSettlement, out } = await mcpCall();
    expect([license.tier, pendingSettlement !== undefined, out.ok]).toEqual(['x402', true, true]);
    const params = theRow();
    expect([params[2], params[3]]).toEqual(['mcp', callerRef({ payerWallet: PAYER_A })]);
  });

  it('MCP rail: a downgraded proof (its nonce replayed) is served free and writes NULL — its wallet is never stamped', async () => {
    pay.claim = 'ALREADY_CLAIMED';
    const { x402Downgrade, license, pendingSettlement, out } = await mcpCall();
    expect([x402Downgrade?.reason, license.tier, license.key, pendingSettlement, out.ok]).toEqual(['replayed', 'free', null, undefined, true]);
    expect(theRow()[3]).toBeNull();
  });

  it('MCP rail: an unusable IP-hash key costs only the row — the paid call is still served', async () => {
    delete process.env[KEY_ENV];
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { out } = await mcpCall();
    expect(out.ok).toBe(true);
    expect([inserts().length, _preTradeCheckLogFailuresForTest()]).toEqual([0, 1]);
    err.mockRestore();
  });

  it('the /mcp route derives the payer from resolveLicense\'s settlement and stamps it into the store it runs the call in', () => {
    const INDEX = readFileSync(join(ROOT, 'src/index.ts'), 'utf8');
    const start = INDEX.indexOf("app.all('/mcp', express.json()");
    const end = INDEX.indexOf('mountX402HttpRoutes(app)', start);
    expect(start, 'the /mcp route registration moved — re-anchor this pin').toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const route = INDEX.slice(start, end);
    const iResolved = route.indexOf('const { license, pendingSettlement, x402Downgrade } = isPricedTool');
    const iPayer = route.indexOf('const payerWallet = resolvePayerWallet(pendingSettlement);');
    const iRun = route.indexOf('await requestContext.run({ license,');
    expect(iResolved).toBeGreaterThan(-1);
    expect(iPayer, 'the payer comes from resolveLicense\'s settlement').toBeGreaterThan(iResolved);
    expect(iRun, 'and is stamped into the store installed after it').toBeGreaterThan(iPayer);
    const store = route.slice(iRun, route.indexOf('}, async () => {', iRun));
    expect(store.split(/[{},]/).map((s) => s.trim())).toContain('payerWallet');
  });
});

describe('the row projection and the parity reads', () => {
  it('toPreTradeCheckLogRow names every column and nothing else — no equity, no key, at any depth', async () => {
    const out = await runPreTradeCheck({ coin: 'BTC', side: 'long', sizeUsd: 10_000, equityUsd: 50_000, leverage: 10 }, INTERNAL, testDeps.make!());
    if (out.kind !== 'ok') throw new Error('expected ok');
    const row = toPreTradeCheckLogRow({ response: out.response, facts: out.facts, channel: 'mcp', licenseKey: 'av_free_row' });
    expect(Object.keys(row)).toEqual(columnsOf(MIGRATION).map((c) => c.split(' ')[0]).filter((c) => c !== 'id'));
    const keys: string[] = [];
    const walk = (x: unknown) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { keys.push(k); walk(v); } };
    walk(row);
    for (const k of keys) expect(k, k).not.toMatch(/equity|key|address|wallet|payer|(^|_)ip($|_)/);
    expect(JSON.stringify(row)).not.toContain('av_free_row');
    // An x402 row: the payer's pseudonym, never the address in either case.
    const paid = toPreTradeCheckLogRow({ response: out.response, facts: out.facts, channel: 'httpX402', licenseKey: null, payerWallet: PAYER_A });
    expect(paid.caller_ref).toBe(callerRef({ payerWallet: PAYER_A }));
    expect(JSON.stringify(paid).toLowerCase()).not.toContain(PAYER_A.slice(2).toLowerCase());
  });

  it('adoption probes both relations with to_regclass and issues no DDL; true marks the ensure done', async () => {
    q.mockResolvedValueOnce([{ t: true, i: true }]);
    expect(await adoptPreTradeCheckTable()).toBe(true);
    expect(String(q.mock.calls[0][0])).toBe("SELECT to_regclass('pre_trade_checks') IS NOT NULL AS t, to_regclass('idx_pre_trade_checks_checked_at') IS NOT NULL AS i");
    const out = await runPreTradeCheck({ coin: 'BTC', side: 'long', sizeUsd: 10_000 }, INTERNAL, testDeps.make!());
    if (out.kind !== 'ok') throw new Error('expected ok');
    await recordPreTradeCheck({ response: out.response, facts: { refMidPx: null }, channel: 'mcp', licenseKey: null });
    expect(creates()).toHaveLength(0);
  });

  it('a missing index is not an adopted table', async () => {
    q.mockResolvedValueOnce([{ t: true, i: false }]);
    expect(await adoptPreTradeCheckTable()).toBe(false);
  });

  it('firstLoggedCheckAt: the log\'s first row as epoch ms — a Date or ISO text; null while empty; unreadable throws', async () => {
    q.mockResolvedValueOnce([{ first: new Date(NOW - 2 * H) }]);
    expect(await firstLoggedCheckAt()).toBe(NOW - 2 * H);
    expect(q.mock.calls[0]).toEqual(['SELECT MIN(checked_at) AS first FROM pre_trade_checks']);
    q.mockResolvedValueOnce([{ first: new Date(NOW - H).toISOString() }]);
    expect(await firstLoggedCheckAt()).toBe(NOW - H);
    q.mockResolvedValueOnce([{ first: null }]);
    expect(await firstLoggedCheckAt()).toBeNull();
    q.mockResolvedValueOnce([{ first: 'not-a-time' }]);
    await expect(firstLoggedCheckAt()).rejects.toThrow(/unreadable/);
  });

  it('countLoggedChecks: the window on checked_at', async () => {
    q.mockResolvedValueOnce([{ n: '7' }]);
    expect(await countLoggedChecks(NOW - 24 * H)).toBe(7);
    expect(q.mock.calls[0]).toEqual(['SELECT COUNT(*) AS n FROM pre_trade_checks WHERE checked_at >= $1', [new Date(NOW - 24 * H).toISOString()]]);
  });

  it('countServedChecks: the request_log predicate — this tool, not internal, inside the window', async () => {
    q.mockResolvedValueOnce([{ n: 9 }]);
    expect(await countServedChecks(NOW - 24 * H)).toBe(9);
    expect(q.mock.calls[0]).toEqual([
      "SELECT COUNT(*) AS n FROM request_log WHERE tool_name = 'pre_trade_check' AND is_bot_internal IS NOT TRUE AND timestamp >= $1",
      [new Date(NOW - 24 * H).toISOString()],
    ]);
  });
});

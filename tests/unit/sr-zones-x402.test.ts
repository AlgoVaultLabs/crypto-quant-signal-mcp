/**
 * SR-ZONES-W2 CH3 — get_support_resistance_zones on the x402 rails at a flat $0.02 per call (§0.4), and the two gate rows.
 *
 *   1. The row and its projections: `channels.httpX402` true and `x402.basePriceUsd` 0.02 (bot, webhook, a2mcp, acp
 *      off); TOOL_PRICING, HTTP_TOOLS and the Bazaar declaration follow. The Bazaar input schema IS the published
 *      validator for `/x402/get_support_resistance_zones`, so it must equal the served tools/list schema; its description is the
 *      served one (Beta mark included) and its output example is a subset of the documented production response.
 *   2. AC3.1, end to end through the REAL handler, pipeline, route and settle decision (venue and SDK faked, as in
 *      x402-settle-gate): unpaid → 402 at "20000" ($0.02); a proof below the price → 402, nothing served; a paid call
 *      serving 1 of 3 timeframes → 200 and ONE settle of the $0.02 requirement; a paid call serving none → its refusal,
 *      never settled, the claim marked unserved once.
 *   3. AC3.2, the two gate rows: a planted bare `_algovault` envelope in get-sr-zones.ts is an R5 finding of the
 *      credential-outcome gate (it is when the file is in LIVE_TOOL_ENVELOPES; the same plant in an unlisted file is
 *      not), and a planted direct `runGetSrZones` call outside the pipeline is a dispatch-boundary violation with the
 *      engines row and passes without it.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import ts from 'typescript';
import { getFeature, servedDescription } from '../../src/lib/feature-registry.js';
import { TOOL_PRICING } from '../../src/lib/x402.js';
import { HTTP_TOOLS } from '../../src/lib/x402-http-routes.js';
import { BAZAAR_ROUTES, FORBIDDEN_BAZAAR_TOKENS } from '../../src/lib/x402-bazaar.js';
import { intervalMsFor } from '../../src/lib/candle-guard.js';
import type { Candle } from '../../src/types.js';
import { runRules, strip, stripTypeBlocks } from '../../scripts/check-credential-outcome-conformance.mjs';
import { analyze, loadConfig, loadCorpus } from '../../scripts/check-tool-dispatch-boundary.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── 1 ─────────────────────────────────────────────────────────────────────────────────────────

/** tools/list's get_support_resistance_zones entry from the REAL server factory. */
async function servedTool(): Promise<{ description: string; inputSchema: Record<string, unknown> }> {
  const { createSandboxServer } = await import('../../src/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const server = createSandboxServer();
  const client = new Client({ name: 'sr-zones-x402', version: '0.0.0' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverT);
    await client.connect(clientT);
    const t = (await client.listTools()).tools.find((x) => x.name === 'get_support_resistance_zones');
    if (!t) throw new Error('get_support_resistance_zones is not on tools/list');
    return t as unknown as { description: string; inputSchema: Record<string, unknown> };
  } finally {
    await client.close();
    await server.close();
  }
}

/** The documented production response (the docs partial's example), the one sample this wave measured. */
function docsExample(): Record<string, unknown> {
  const partial = fs.readFileSync(path.join(ROOT, 'docs-src', 'partials', 'get-support-resistance-zones.html'), 'utf8');
  const blocks = [...partial.matchAll(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)].map((m) => m[1]);
  return JSON.parse(blocks[1]) as Record<string, unknown>;
}

describe('SR-ZONES-W2 CH3 — the registry row prices get_support_resistance_zones at a flat $0.02, x402 only', () => {
  it('httpX402 on, $0.02; bot, webhook, a2mcp and acp stay off; the quota rail is unchanged', () => {
    const f = getFeature('get_support_resistance_zones')!;
    expect(f.x402).toEqual({ basePriceUsd: 0.02 });
    expect(f.channels).toEqual({ mcp: true, httpX402: true, bot: false, webhook: false, a2mcp: false, acp: false });
    expect(f.quota).toEqual({ unit: 'per-verdict', holdFree: false });
  });

  it('TOOL_PRICING, HTTP_TOOLS and the Bazaar declaration follow the row', () => {
    expect((TOOL_PRICING as Record<string, number>).get_support_resistance_zones).toBe(0.02);
    expect(HTTP_TOOLS).toContain('get_support_resistance_zones');
    expect(BAZAAR_ROUTES.get_support_resistance_zones?.toolName).toBe('get_support_resistance_zones');
  });

  it('the Bazaar description is the served description, Beta mark included, and leaks nothing', () => {
    const spec = BAZAAR_ROUTES.get_support_resistance_zones!;
    expect(spec.description).toBe(servedDescription('get_support_resistance_zones'));
    expect(spec.description.endsWith(' (Beta)')).toBe(true);
    const all = JSON.stringify(spec).toLowerCase();
    for (const t of FORBIDDEN_BAZAAR_TOKENS) expect(all).not.toContain(t);
  });

  it('the Bazaar input schema (the /x402 validator) equals the served tools/list schema', async () => {
    const { $schema: _s, ...served } = (await servedTool()).inputSchema;
    expect(BAZAAR_ROUTES.get_support_resistance_zones!.inputSchema).toEqual(served);
  });

  it('the input example validates strictly; the validator refuses what tools/list refuses', () => {
    const validate = new Ajv({ strict: true, allErrors: true }).compile(BAZAAR_ROUTES.get_support_resistance_zones!.inputSchema);
    expect(BAZAAR_ROUTES.get_support_resistance_zones!.example).toEqual({ coin: 'BTC', timeframes: ['1d'] });
    expect(validate(BAZAAR_ROUTES.get_support_resistance_zones!.example)).toBe(true);
    for (const bad of [
      {}, { coin: 'BTC' }, { coin: 'BTC', timeframes: [] }, { coin: 'BTC', timeframes: ['1d', '4h', '1h', '15m'] },
      { coin: 'BTC', timeframes: ['1w'] }, { coin: 'BTC', timeframes: ['1d'], venue: 'HL' }, { coin: 'BTC', timeframes: ['1d'], venue: 'bybit' },
      { coin: '', timeframes: ['1d'] }, { coin: 'BTC', timeframes: ['1d'], extra: 1 },
    ]) expect(validate(bad), JSON.stringify(bad)).toBe(false);
    // SR-ZONES-W3: the four venues of the enum validate.
    for (const venue of ['BINANCE', 'BYBIT', 'OKX', 'BITGET']) expect(validate({ coin: 'BTC', timeframes: ['1d'], venue }), venue).toBe(true);
  });

  it('the output example is a subset of the documented production response — no invented value', () => {
    const out = BAZAAR_ROUTES.get_support_resistance_zones!.output!.example as Record<string, unknown> & { results: Array<Record<string, unknown>> };
    const doc = docsExample() as Record<string, unknown> & { results: Array<Record<string, unknown> & { support: unknown[]; resistance: unknown[] }> };
    for (const k of Object.keys(out)) if (k !== 'results') expect(out[k], k).toEqual(doc[k]);
    expect(out.results).toHaveLength(1);
    const [r] = out.results as Array<Record<string, unknown> & { support: unknown[]; resistance: unknown[] }>;
    for (const k of Object.keys(r)) if (k !== 'support' && k !== 'resistance') expect(r[k], k).toEqual(doc.results[0][k]);
    expect(r.support).toEqual(doc.results[0].support.slice(0, r.support.length));
    expect(r.resistance).toEqual(doc.results[0].resistance.slice(0, r.resistance.length));
    expect(r.support.length + r.resistance.length).toBeGreaterThan(0);
  });

  it('R7 + R8: the output example carries no `order`, `formed_from`, `formed_to` or `note`', () => {
    const text = JSON.stringify(BAZAAR_ROUTES.get_support_resistance_zones!.output!.example);
    expect(text).toContain('"distance_pct":');
    for (const k of ['order', 'formed_from', 'formed_to', 'note']) expect(text, k).not.toContain(`"${k}":`);
  });
});

// ── 2 ─────────────────────────────────────────────────────────────────────────────────────────

const ORIG_ENV = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATABASE_URL: process.env.DATABASE_URL,
  X402_FACILITATOR: process.env.X402_FACILITATOR,
  BAZAAR_DISCOVERABLE: process.env.BAZAAR_DISCOVERABLE,
  X402_WALLET_ADDRESS: process.env.X402_WALLET_ADDRESS,
  X402_NETWORK: process.env.X402_NETWORK,
  CDP_API_KEY_ID: process.env.CDP_API_KEY_ID,
  CDP_API_KEY_SECRET: process.env.CDP_API_KEY_SECRET,
};
afterAll(() => {
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else (process.env as Record<string, string | undefined>)[k] = v;
  }
});

/** A seeded random walk for `tf`, `bars` candles ending with the one forming NOW (the handler reads Date.now()). */
function walkToNow(tf: string, bars: number, seed: number): Candle[] {
  const step = intervalMsFor(tf)!;
  const formingOpen = Math.floor(Date.now() / step) * step;
  let a = seed >>> 0;
  const rand = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const out: Candle[] = [];
  let close = 60_000;
  for (let i = bars - 1; i >= 0; i--) {
    const open = close;
    close = open * (1 + 0.02 * (rand() - 0.5));
    out.push({
      time: formingOpen - i * step,
      open,
      high: Math.max(open, close) * (1 + 0.004 * rand()),
      low: Math.min(open, close) * (1 - 0.004 * rand()),
      close,
      volume: 100 + 50 * rand(),
    });
  }
  return out;
}

describe('SR-ZONES-W2 AC3.1 — POST /x402/get_support_resistance_zones, end to end through the real handler', () => {
  const WALLET = '0x778A05280Fd8dB980E920fE9f31d0A8eAbD17d59';
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const atomic = (usd: number) => Math.round(usd * 1_000_000).toString();
  const req = (usd: number) => ({
    scheme: 'exact', network: 'eip155:8453', amount: atomic(usd), asset: USDC,
    payTo: WALLET, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' },
  });
  const MOCKED = [
    '../../src/lib/x402-facilitator.js', '@x402/core/server', '@x402/core/http', '@x402/extensions/bazaar',
    '../../src/lib/license.js', '../../src/lib/analytics.js', '../../src/lib/x402-idempotency-store.js',
    '../../src/lib/exchange-adapter.js',
  ];
  /** Binance as the fake answers it: BTC 1d only; every other read is a 400 (not transient). */
  const SERIES: Record<string, Candle[]> = {};

  let server: http.Server | undefined;
  let baseUrl = '';
  let home = '';
  let settled: Array<{ amount?: string }> = [];
  let unservedMarks = 0;
  let nextSettlement: { requirements: unknown; paymentPayload: unknown } | null = null;
  let seq = 0;

  function setProof(requirement: Record<string, unknown>): string {
    const nonce = `0x${(++seq).toString(16).padStart(64, 'c')}`;
    nextSettlement = {
      requirements: requirement,
      paymentPayload: {
        x402Version: 2, accepted: requirement,
        payload: { signature: '0xsig', authorization: { from: '0xPAYER', to: WALLET, value: requirement.amount, validAfter: '0', validBefore: '9999999999', nonce } },
      },
    };
    return nonce;
  }

  beforeEach(async () => {
    process.env.X402_WALLET_ADDRESS = WALLET;
    process.env.X402_NETWORK = 'base-mainnet';
    process.env.X402_FACILITATOR = 'cdp';
    process.env.BAZAAR_DISCOVERABLE = 'true';
    process.env.CDP_API_KEY_ID = 'test-cdp-key-id';
    process.env.CDP_API_KEY_SECRET = 'test-cdp-key-secret';
    delete process.env.DATABASE_URL;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-srz-x402-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    vi.resetModules();
    settled = [];
    unservedMarks = 0;
    nextSettlement = null;
    SERIES['BTC/1d'] ??= walkToNow('1d', 1500, 11);
    // Listed but too young for any zone: candles load, no timeframe is served.
    SERIES['YOUNG/1d'] ??= walkToNow('1d', 15, 12);

    vi.doMock('../../src/lib/x402-facilitator.js', () => ({
      resolveFacilitatorFromEnv: () => ({ effectiveChoice: 'cdp', discoveryEnabled: true }),
      createFacilitatorClient: () => ({}),
    }));
    vi.doMock('@x402/core/server', () => ({
      x402ResourceServer: class {
        register() {}
        registerExtension() {}
        async initialize() {}
        getSupportedKind() { return true; }
        async buildPaymentRequirements(cfg: { price: string }) { return [req(parseFloat(String(cfg.price).replace('$', '')))]; }
        findMatchingRequirements() { return null; }
        async verifyPayment() { return { isValid: true }; }
        settlePayment(_payload: unknown, requirements: { amount?: string }) { settled.push(requirements); return Promise.resolve({ success: true }); }
      },
    }));
    vi.doMock('@x402/core/http', () => ({ encodePaymentRequiredHeader: () => 'stub-header' }));
    vi.doMock('@x402/extensions/bazaar', () => ({
      bazaarResourceServerExtension: {},
      declareDiscoveryExtension: () => ({ bazaar: { info: { input: { type: 'http' } } } }),
    }));
    vi.doMock('../../src/lib/license.js', async (orig) => ({
      ...(await orig<typeof import('../../src/lib/license.js')>()),
      resolveLicense: async () =>
        nextSettlement
          ? { license: { tier: 'x402', key: null }, pendingSettlement: nextSettlement }
          : { license: { tier: 'free', key: null } },
    }));
    vi.doMock('../../src/lib/analytics.js', async (orig) => ({
      ...(await orig<typeof import('../../src/lib/analytics.js')>()),
      hashIp: () => 'h',
      logRequest: () => {},
    }));
    vi.doMock('../../src/lib/x402-idempotency-store.js', async (orig) => {
      const m = await orig<typeof import('../../src/lib/x402-idempotency-store.js')>();
      return {
        ...m,
        recordUnservedClaim: async (...a: Parameters<typeof m.recordUnservedClaim>) => { unservedMarks++; return m.recordUnservedClaim(...a); },
      };
    });
    vi.doMock('../../src/lib/exchange-adapter.js', async (orig) => ({
      ...(await orig<typeof import('../../src/lib/exchange-adapter.js')>()),
      getAdapter: () => ({
        getCandles: async (coin: string, tf: string, startTime: number) => {
          const series = SERIES[`${coin}/${tf}`];
          if (!series) throw new Error('Binance API 400: Bad Request');
          return series.filter((c) => c.time >= startTime).slice(0, 200);
        },
        getPriceTick: async () => 0.1,
      }),
    }));

    const express = (await import('express')).default;
    const { initX402 } = await import('../../src/lib/x402.js');
    await initX402();
    const { mountX402HttpRoutes } = await import('../../src/lib/x402-http-routes.js');
    const app = express();
    expect(mountX402HttpRoutes(app)).toContain('/x402/get_support_resistance_zones');
    server = await new Promise<http.Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    for (const m of MOCKED) vi.doUnmock(m);
    const { closeDb } = await import('../../src/lib/performance-db.js');
    closeDb();
    vi.resetModules();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /** Settle and mark are fire-and-forget AFTER the response, so give the server a tick. */
  const tick = () => new Promise((r) => setTimeout(r, 80));
  const post = (body: Record<string, unknown>, paid = true) => fetch(`${baseUrl}/x402/get_support_resistance_zones`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(paid ? { 'x-payment': 'present' } : {}) },
    body: JSON.stringify(body),
  });
  async function stateOf(n: string): Promise<string | undefined> {
    const { dbQuery } = await import('../../src/lib/performance-db.js');
    return (await dbQuery<{ settlement_state: string }>('SELECT settlement_state FROM processed_x402_payments WHERE nonce = ?', [n]))[0]?.settlement_state;
  }

  it('unpaid → 402 declaring $0.02 ("20000") for the get_support_resistance_zones resource, with its description', async () => {
    const res = await post({ coin: 'BTC', timeframes: ['1d'] }, false);
    expect(res.status).toBe(402);
    const body = await res.json() as { accepts: Array<{ amount: string }>; resource: { url: string; description: string } };
    expect(body.accepts.map((a) => a.amount)).toEqual(['20000']);
    expect(body.resource.url.endsWith('/x402/get_support_resistance_zones')).toBe(true);
    expect(body.resource.description).toBe(servedDescription('get_support_resistance_zones'));
    await tick();
    expect(settled).toEqual([]);
  });

  it('a proof below $0.02 → 402, nothing served, nothing settled', async () => {
    setProof(req(0.01));
    const res = await post({ coin: 'BTC', timeframes: ['1d'] });
    expect(res.status).toBe(402);
    await tick();
    expect(settled).toEqual([]);
    expect(unservedMarks).toBe(0);
  });

  it('a paid call serving 1 of 3 timeframes → 200 and ONE settle of the $0.02 requirement', async () => {
    const n = setProof(req(0.02));
    const res = await post({ coin: 'BTC', timeframes: ['1d', '4h', '1h'] });
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Array<{ timeframe: string; support: Array<{ low: number; high: number }>; resistance: Array<{ low: number; high: number }> }>; unserved: Array<{ timeframe: string }> };
    expect(body.results.map((r) => r.timeframe)).toEqual(['1d']);
    expect(body.unserved.map((u) => u.timeframe)).toEqual(['4h', '1h']);
    // The same served edges as MCP: rounded outward on the call's step (price ~6e4, tick 0.1 → 10).
    for (const z of [...body.results[0].support, ...body.results[0].resistance]) {
      expect(Number.isInteger(z.low / 10) && Number.isInteger(z.high / 10), `${z.low}–${z.high}`).toBe(true);
    }
    await tick();
    expect(settled.map((r) => r.amount)).toEqual(['20000']);
    expect(unservedMarks).toBe(0);
    expect(await stateOf(n)).toBe('SETTLED');
  });

  it.each([
    ['the venue refuses every read', 'NOPE'],
    ['the candles load but are too few for any zone', 'YOUNG'],
  ])('a paid call that serves NO timeframe (%s) → its refusal, never settled, marked unserved once', async (_why, coin) => {
    const n = setProof(req(0.02));
    const res = await post({ coin, timeframes: ['1d'] });
    expect(res.status).toBe(422);
    const body = await res.json() as { code?: string; unserved?: Array<{ timeframe: string }> };
    expect(body.code).toBe('no_timeframe_served');
    expect(body.unserved?.map((u) => u.timeframe)).toEqual(['1d']);
    await tick();
    expect(settled).toEqual([]);
    expect(unservedMarks).toBe(1);
    expect(await stateOf(n)).toBe('CLAIMED_UNSERVED');
  });
});

// ── 3 ─────────────────────────────────────────────────────────────────────────────────────────

describe('SR-ZONES-W2 AC3.2 — the two gate rows bring get_support_resistance_zones under both gates', () => {
  const HANDLER = 'src/tools/get-sr-zones.ts';
  const handlerSrc = fs.readFileSync(path.join(ROOT, HANDLER), 'utf8');
  const prepared = (src: string) => stripTypeBlocks(strip(src));
  /** One served envelope rebuilt by hand — a caller there could not tell whether their key worked. */
  const plantBareEnvelope = (src: string): string => {
    const site = '_algovault: withAuthState(ident(), license),';
    expect(src.split(site).length - 1, 'the plant needs its anchor').toBeGreaterThan(0);
    return src.replace(site, '_algovault: { ...ident(), quota: null },');
  };

  it('credential-outcome R5: the real handler is clean', () => {
    const { findings } = runRules(new Map([[HANDLER, prepared(handlerSrc)]]));
    expect(findings).toEqual([]);
  });

  it('credential-outcome R5: a bare envelope in get-sr-zones.ts is a finding (the LIVE_TOOL_ENVELOPES row) …', () => {
    const { findings } = runRules(new Map([[HANDLER, prepared(plantBareEnvelope(handlerSrc))]]));
    expect(findings.map((f: { rule: string; file: string }) => `${f.rule} ${f.file}`)).toEqual([`R5 ${HANDLER}`]);
  });

  it('… and the same plant in a file without a row is not — the row is what covers it', () => {
    const { findings } = runRules(new Map([['src/tools/unlisted-tool.ts', prepared(plantBareEnvelope(handlerSrc))]]));
    expect(findings).toEqual([]);
  });

  const PLANT_FILE = 'src/lib/sr-zones-planted-dispatch.ts';
  const PLANT = [
    "import { runGetSrZones } from '../tools/get-sr-zones.js';",
    'export async function plantedDirectDispatch() {',
    "  return runGetSrZones({ coin: 'BTC', timeframes: ['1d'] }, { tier: 'internal', key: null } as never);",
    '}',
  ].join('\n');

  it('dispatch boundary: the engines row lists runGetSrZones, and the real tree has no violation', () => {
    const { cfg } = loadConfig(ROOT);
    expect(cfg.engines).toContainEqual({ symbol: 'runGetSrZones', module: HANDLER });
    const r = analyze(loadCorpus(ROOT), cfg, ts);
    expect(r.indeterminate).toBeUndefined();
    expect([r.violations, r.stale]).toEqual([[], []]);
  });

  it('dispatch boundary: a direct runGetSrZones call outside the pipeline FAILS with the row, PASSES without it', () => {
    const { cfg } = loadConfig(ROOT);
    const files = loadCorpus(ROOT);
    files.set(PLANT_FILE, PLANT);
    const withRow = analyze(files, cfg, ts);
    expect(withRow.violations.map((v: { file: string; symbol: string }) => `${v.file} ${v.symbol}`)).toEqual([`${PLANT_FILE} runGetSrZones`]);
    const withoutRow = analyze(files, { ...cfg, engines: cfg.engines.filter((e: { symbol: string }) => e.symbol !== 'runGetSrZones') }, ts);
    expect(withoutRow.violations).toEqual([]);
  });
});

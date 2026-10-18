/**
 * tests/unit/tool-call-parity.test.ts — ARCH-MCP-CALL-PIPELINE-W1 CH1 R1: the cross-channel
 * parity harness.
 *
 * WHAT IT MEASURES. Every tool that FEATURE_REGISTRY flags on ≥2 channels is driven through each
 * channel's REAL entry, in-process, with ONE shared fake venue, and the public outputs are compared
 * channel-vs-MCP. Every divergence is a NAMED row in the exported `DIVERGENCES` table and is
 * asserted to EXIST, so the harness goes red when a known divergence silently changes (in either
 * direction) and when a new one appears. No `it.skip`.
 *
 * THE FOUR ENTRIES (the arbiter for R-1 byte-parity):
 *   MCP     `createSandboxServer()` (src/index.ts) + the SDK `InMemoryTransport` + `Client`, with the
 *           request context installed through `requestContext.run` exactly as `/mcp` installs it.
 *   x402    the Express router `mountX402HttpRoutes` builds (`initX402` first), driven over a real
 *           ephemeral port with a Payment-Signature built from the route's OWN 402 challenge.
 *   A2MCP   the LIVE route handler `mountOkxA2mcpRoutes` mounts (`@okxweb3/x402-express` payment
 *           middleware over the OKX facilitator), driven the same way.
 *   ACP     `requirementToParams` + the seller-worker `callTool` path (`handleAcpEntry`), with the
 *           exported production wiring `acpCallTool` (what `startAcpSellerWorker` installs).
 *
 * SEAMS — system boundaries only, never an in-repo logic module (upstream tdd/mocking.md):
 *   • `src/lib/adapters/_upstream-fetch.js#upstreamFetch` — the ONE transport every venue REST call
 *     crosses (OPS-ADAPTER-RATELIMIT-UNIFY-W1). Replaced by `syntheticVenue.answer`, a deterministic
 *     model of the Binance USDⓈ-M futures REST and Hyperliquid `/info` endpoints the engines hit.
 *     Every other host is UNMODELLED and throws a named error, so an engine's fail-soft path runs
 *     identically on every channel (recorded, see `PARITY_UNMODELLED`).
 *   • `src/lib/x402-facilitator.js#createFacilitatorClient` — the one-line factory that constructs
 *     the SDK's `HTTPFacilitatorClient`; it returns a fake that implements the SDK's
 *     `FacilitatorClient` interface (getSupported / verify / settle). The real `@x402/core`
 *     resource server, scheme registration, requirement matching and price binding all run.
 *     (The CDP auth-header generator needs a real EC key, so faking `fetch` alone cannot reach it.)
 *   • `globalThis.fetch` for `https://web3.okx.com` ONLY — the OKX managed facilitator's HTTP
 *     surface (`/api/v6/pay/x402/{supported,verify,settle}`); every other URL passes through.
 *   • Exported test seams already in the tree (`_setSnapshotForTest`, `_clearCache`) hold the
 *     cross-asset grid at an EMPTY snapshot so enrichment fields do not race a background refresh
 *     between two channels' calls.
 *   The DB is the existing SQLite backend at a per-run temp path (PERFORMANCE_DB_PATH).
 *
 * NORMALISATION is CLOSED: `STRIPPED_FIELDS` below is the whole list, each with a reason.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The ONE fake venue — hoisted so the vi.mock factory below can reach it.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const syntheticVenue = vi.hoisted(() => {
  /** Frozen at module evaluation: every candle series ends at the same bar on every channel. */
  const NOW = Date.now();
  const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT', 'LTC', 'BNB', 'ATOM'];
  const BASE: Record<string, number> = {
    BTC: 65_000, ETH: 3_200, SOL: 150, XRP: 0.6, DOGE: 0.12, ADA: 0.45,
    AVAX: 30, LINK: 14, DOT: 6, LTC: 80, BNB: 580, ATOM: 7,
  };
  const IV: Record<string, number> = {
    '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3, '30m': 1_800e3, '1h': 3_600e3,
    '2h': 7_200e3, '4h': 14_400e3, '8h': 28_800e3, '12h': 43_200e3, '1d': 86_400e3,
  };
  const calls: string[] = [];
  const unmodelled: string[] = [];

  function hash(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h;
  }
  /** Deterministic mark price for (coin, slot): a slow wave + a hashed jitter. */
  function px(coin: string, slot: number): number {
    const b = BASE[coin] ?? 10;
    const w = 0.012 * Math.sin(slot / 9) + 0.004 * Math.cos(slot / 3.7) + 0.002 * (((hash(coin + ':' + slot) % 1000) / 1000) - 0.5);
    return b * (1 + w);
  }
  /**
   * The LAST `count` bars for (coin, interval), ending at the bar containing NOW. The request's own
   * startTime is deliberately IGNORED: the engines compute it from the live clock, so honouring it
   * would let a slot boundary between two channels' calls produce a different window — a false
   * divergence. Both channels must see the same series; this is what makes that structural.
   */
  function candles(coin: string, interval: string, count = 100): Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> {
    const iv = IV[interval] ?? 3_600e3;
    const last = Math.floor(NOW / iv) * iv;
    const out: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> = [];
    for (let k = count - 1; k >= 0; k--) {
      const t = last - k * iv;
      const slot = Math.floor(t / iv);
      const o = px(coin, slot - 1);
      const c = px(coin, slot);
      out.push({ t, o, h: Math.max(o, c) * 1.0015, l: Math.min(o, c) * 0.9985, c, v: 1_000 + (hash(coin + ':v:' + slot) % 500) });
    }
    return out;
  }
  const s = (n: number): string => n.toPrecision(10);
  const funding = (coin: string): number => ((hash(coin + ':f') % 200) - 100) / 1_000_000; // ±0.0001
  const oi = (coin: string): number => 1_000 + (hash(coin + ':oi') % 9_000);
  const lastPx = (coin: string): number => px(coin, Math.floor(NOW / 900e3));
  const prevDayPx = (coin: string): number => px(coin, Math.floor(NOW / 900e3) - 96);
  const vol24 = (coin: string): number => 50_000_000 + (hash(coin + ':vol') % 450_000_000);

  function binance(url: URL): unknown {
    const p = url.pathname;
    const sym = url.searchParams.get('symbol');
    const coinOf = (x: string | null): string | null => (x && x.endsWith('USDT') ? x.slice(0, -4) : null);
    if (p === '/fapi/v1/klines') {
      const coin = coinOf(sym);
      if (!coin || !COINS.includes(coin)) return [];
      const interval = url.searchParams.get('interval') ?? '1h';
      return candles(coin, interval).map((c) => [c.t, s(c.o), s(c.h), s(c.l), s(c.c), s(c.v), c.t + (IV[interval] ?? 3_600e3) - 1, s(c.v * c.c), 100, s(c.v / 2), s((c.v / 2) * c.c), '0']);
    }
    if (p === '/fapi/v1/premiumIndex') {
      const row = (coin: string) => ({ symbol: `${coin}USDT`, markPrice: s(lastPx(coin)), indexPrice: s(lastPx(coin)), estimatedSettlePrice: s(lastPx(coin)), lastFundingRate: s(funding(coin)), interestRate: '0.00010000', nextFundingTime: Math.ceil(NOW / 28_800e3) * 28_800e3, time: NOW });
      if (sym) { const coin = coinOf(sym); return coin ? row(coin) : {}; }
      return COINS.map(row);
    }
    if (p === '/fapi/v1/ticker/24hr') {
      const row = (coin: string) => ({ symbol: `${coin}USDT`, priceChange: s(lastPx(coin) - prevDayPx(coin)), priceChangePercent: s(((lastPx(coin) - prevDayPx(coin)) / prevDayPx(coin)) * 100), weightedAvgPrice: s(lastPx(coin)), lastPrice: s(lastPx(coin)), lastQty: '1', openPrice: s(prevDayPx(coin)), highPrice: s(lastPx(coin) * 1.02), lowPrice: s(lastPx(coin) * 0.98), volume: s(vol24(coin) / lastPx(coin)), quoteVolume: s(vol24(coin)), openTime: NOW - 86_400e3, closeTime: NOW, firstId: 1, lastId: 2, count: 1_000 });
      if (sym) { const coin = coinOf(sym); return coin ? row(coin) : {}; }
      return COINS.map(row);
    }
    if (p === '/fapi/v1/openInterest') {
      const coin = coinOf(sym);
      return { symbol: sym, openInterest: s(coin ? oi(coin) : 0), time: NOW };
    }
    if (p === '/futures/data/openInterestHist') {
      const coin = coinOf(sym);
      const o = coin ? oi(coin) : 0;
      return Array.from({ length: 24 }, (_, i) => ({ symbol: sym, sumOpenInterest: s(o * (1 + i / 1_000)), sumOpenInterestValue: s(o * (1 + i / 1_000) * (coin ? lastPx(coin) : 0)), timestamp: NOW - (24 - i) * 3_600e3 }));
    }
    if (p === '/fapi/v1/fundingRate') {
      const coin = coinOf(sym);
      return Array.from({ length: 12 }, (_, i) => ({ symbol: sym, fundingTime: NOW - (12 - i) * 28_800e3, fundingRate: s(coin ? funding(coin) * (1 + i / 50) : 0), markPrice: s(coin ? lastPx(coin) : 0) }));
    }
    if (p === '/fapi/v1/exchangeInfo') {
      return { symbols: COINS.map((coin) => ({ symbol: `${coin}USDT`, pair: `${coin}USDT`, contractType: 'PERPETUAL', status: 'TRADING', underlyingType: 'COIN', quoteAsset: 'USDT', baseAsset: coin })) };
    }
    unmodelled.push(url.toString());
    throw new Error(`[synthetic-venue] unmodelled Binance endpoint ${p}`);
  }

  function hyperliquid(bodyRaw: string | undefined): unknown {
    const body = (bodyRaw ? JSON.parse(bodyRaw) : {}) as { type?: string; dex?: string; req?: { coin?: string; interval?: string }; coin?: string };
    const type = body.type ?? '';
    const universe = COINS.map((name) => ({ name, szDecimals: 3, maxLeverage: 50, onlyIsolated: false }));
    const ctx = (coin: string) => ({ funding: s(funding(coin)), openInterest: s(oi(coin)), prevDayPx: s(prevDayPx(coin)), dayNtlVlm: s(vol24(coin)), premium: '0.0001', oraclePx: s(lastPx(coin)), markPx: s(lastPx(coin)), midPx: s(lastPx(coin)), impactPxs: [s(lastPx(coin) * 0.9995), s(lastPx(coin) * 1.0005)] });
    if (type === 'candleSnapshot') {
      const coin = (body.req?.coin ?? '').replace(/^xyz:/, '');
      if (!COINS.includes(coin)) return [];
      const interval = body.req?.interval ?? '1h';
      return candles(coin, interval).map((c) => ({ t: c.t, T: c.t + (IV[interval] ?? 3_600e3) - 1, s: coin, i: interval, o: s(c.o), h: s(c.h), l: s(c.l), c: s(c.c), v: s(c.v), n: 100 }));
    }
    // OPS-CANDLE-REQUEST-OWNER-DERIVATION-W1: HL lists HIP-3 perps per dex, and the adapter reads both universes to
    // name a coin's market — so dex `xyz` is modelled as its own disjoint, `xyz:`-prefixed universe, as HL's is.
    if (type === 'metaAndAssetCtxs' && body.dex === 'xyz') {
      return [{ universe: [{ name: 'xyz:XYZ100', szDecimals: 4, maxLeverage: 20, onlyIsolated: true }] }, [ctx(COINS[0])]];
    }
    if (type === 'metaAndAssetCtxs') return [{ universe }, COINS.map(ctx)];
    if (type === 'meta') return { universe };
    if (type === 'allMids') return Object.fromEntries(COINS.map((coin) => [coin, s(lastPx(coin))]));
    if (type === 'predictedFundings') {
      return COINS.map((coin) => [coin, [
        ['BinPerp', { fundingRate: s(funding(coin) * 0.8), nextFundingTime: Math.ceil(NOW / 28_800e3) * 28_800e3 }],
        ['HlPerp', { fundingRate: s(funding(coin)), nextFundingTime: Math.ceil(NOW / 3_600e3) * 3_600e3 }],
        ['BybitPerp', { fundingRate: s(funding(coin) * 1.3), nextFundingTime: Math.ceil(NOW / 28_800e3) * 28_800e3 }],
      ]]);
    }
    if (type === 'fundingHistory') {
      const coin = body.coin ?? 'BTC';
      return Array.from({ length: 48 }, (_, i) => ({ time: NOW - (48 - i) * 3_600e3, coin, fundingRate: s(funding(coin) * (1 + i / 100)), premium: '0.0001' }));
    }
    unmodelled.push(`hl:${type}`);
    throw new Error(`[synthetic-venue] unmodelled Hyperliquid info type ${type}`);
  }

  function answer(cfg: { exchangeId?: string }, req: { url: string; body?: string }): unknown {
    const url = new URL(req.url);
    calls.push(`${cfg?.exchangeId ?? '?'} ${url.host}${url.pathname}`);
    if (url.host === 'fapi.binance.com') return binance(url);
    if (url.host === 'api.hyperliquid.xyz') return hyperliquid(req.body);
    unmodelled.push(url.toString());
    throw new Error(`[synthetic-venue] unmodelled upstream ${url.host}`);
  }
  return { NOW, COINS, calls, unmodelled, answer };
});

vi.mock('../../src/lib/adapters/_upstream-fetch.js', async (orig) => {
  const real = await orig<typeof import('../../src/lib/adapters/_upstream-fetch.js')>();
  return {
    ...real,
    upstreamFetch: async (cfg: { exchangeId?: string }, req: { url: string; body?: string }) => syntheticVenue.answer(cfg, req),
  };
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The x402 facilitator at the SDK boundary: a fake FacilitatorClient behind the real resource server.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const PAYER = '0x00000000000000000000000000000000000000aa';
const facilitatorFake = vi.hoisted(() => {
  const payer = '0x00000000000000000000000000000000000000aa';
  const client = {
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453', extra: {} }], extensions: ['bazaar'], signers: {} };
    },
    async verify() { return { isValid: true, payer }; },
    async settle() { return { success: true, transaction: `0x${'ab'.repeat(32)}`, network: 'eip155:8453', payer }; },
  };
  return { client };
});
vi.mock('../../src/lib/x402-facilitator.js', async (orig) => {
  const real = await orig<typeof import('../../src/lib/x402-facilitator.js')>();
  return { ...real, createFacilitatorClient: () => facilitatorFake.client as never };
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Divergence contract
// ─────────────────────────────────────────────────────────────────────────────────────────────
export type Channel = 'mcp' | 'x402' | 'a2mcp' | 'acp';
export type ObsStatus = 'ok' | 'tool_error' | 'rejected' | 'threw';

/** One divergence between a channel's output and MCP's for the same (tool, input). */
export interface DivergenceRow {
  tool: string;
  channel: Exclude<Channel, 'mcp'>;
  /** The CASES entry name (see CASES). */
  input: string;
  /**
   * Dotted path into the normalised payload, or one of the structural markers:
   *   `$outcome` — the two channels ended in different outcome CLASSES / envelope shapes
   *                (values are `envelopeShape()` tokens, e.g. `isError:text(sdk-validation)` vs
   *                `http400:json[code,details,error,suggested_fix]`);
   *   `$route`   — the registry declares the channel for this tool but nothing serves it (or vice versa).
   */
  field: string;
  mcp: unknown;
  channel_value: unknown;
  /** Why it diverges today — the fact Mr.1 rules on in Q-PIPE-2. */
  note: string;
  /**
   * Paths (exact, or a prefix ending in `.`) whose divergence is a CONSEQUENCE of this row's root
   * cause — e.g. a different default timeframe moves every verdict field. They are covered by this
   * row and need no row of their own; the root field itself must still be observed.
   */
  consequents?: string[];
}

/**
 * The DECLARED divergences. The harness asserts BOTH directions: every observed divergence must be
 * declared, and every declared divergence must be observed with the same (summarised) values. A
 * silently-healed or silently-moved divergence therefore goes red. Filled from the measured run
 * (audit §R1, 2026-10-15 at origin/main 221d3a0a).
 */
const VERDICT_CONSEQUENTS = ['confidence', 'price', 'call', 'regime', 'reasoning', 'indicators.', '_receipts.', 'hold_rescue', 'try_next', 'closest_tradeable'];
const SDK_VALIDATION = 'isError:text(sdk-validation)';
const HTTP400 = 'http400:json[code,details,error,suggested_fix]';
const ACP_SKIP = 'acp:skipped:invalid_requirement';
const NOTE_INVALID_ENVELOPE = 'invalid input is refused by a different layer per channel: MCP = the SDK zod reject (prose text, isError:true) · x402/A2MCP = validateToolInput → 400 JSON {error,code,details,suggested_fix} · ACP = requirement schema → job skipped, no deliverable';
export const DIVERGENCES: DivergenceRow[] = [
  // ── F3 CLOSED by CH2 (Q-PIPE-2 rows 1–2 = (a)): every channel's get_trade_call now goes through routeTradeCall, so the ACP bare-coin and coin+exchange rows that read 15m vs 1h on the CH1 tree are EQUAL and have no row here ──
  // ── ACP requirement schema is narrower than the MCP schema (additionalProperties:false) ──
  { tool: 'get_trade_call', channel: 'acp', input: 'all-optional', field: '$outcome', mcp: 'ok', channel_value: ACP_SKIP,
    note: 'ACP Trade Call requirementSchema declares coin/timeframe/exchange only; `includeReasoning` is rejected as an unknown property, so the job is skipped.' },
  { tool: 'get_trade_call', channel: 'acp', input: 'assetClass-perp', field: '$outcome', mcp: 'ok', channel_value: ACP_SKIP,
    note: '`assetClass` exists only on the MCP zod schema (TRADE-CALL-ROUTING-RESOLVER-W1); undeclared on ACP → skipped.' },
  // ── Bazaar input schemas are narrower than the MCP schema (additionalProperties:false) ──
  { tool: 'get_trade_call', channel: 'x402', input: 'assetClass-perp', field: '$outcome', mcp: 'ok', channel_value: HTTP400,
    note: '`assetClass` is not in BAZAAR_ROUTES.get_trade_signal.inputSchema → validateToolInput 400 X402_HTTP_INVALID_INPUT.' },
  { tool: 'get_trade_call', channel: 'a2mcp', input: 'assetClass-perp', field: '$outcome', mcp: 'ok', channel_value: HTTP400,
    note: 'same Bazaar schema through the shared validateToolInput → 400 OKX_A2MCP_INVALID_INPUT.' },
  { tool: 'scan_trade_calls', channel: 'x402', input: 'mcp-only-params', field: '$outcome', mcp: 'ok', channel_value: HTTP400,
    note: 'rankBy / includeReasoning (and oiChangeWindow, oiBasis, minLiquidityUsd) exist only on the MCP zod schema; the Bazaar scan schema rejects them.' },
  { tool: 'scan_trade_calls', channel: 'a2mcp', input: 'mcp-only-params', field: '$outcome', mcp: 'ok', channel_value: HTTP400,
    note: 'same Bazaar schema via validateToolInput.' },
  { tool: 'scan_trade_calls', channel: 'acp', input: 'mcp-only-params', field: '$outcome', mcp: 'ok', channel_value: ACP_SKIP,
    note: 'ACP Market Scan schema declares rankBy but not includeReasoning → skipped.' },
  // ── invalid input: each channel refuses from a different layer, with a different envelope ──
  { tool: 'get_trade_call', channel: 'x402', input: 'invalid-timeframe', field: '$outcome', mcp: SDK_VALIDATION, channel_value: HTTP400, note: NOTE_INVALID_ENVELOPE },
  { tool: 'get_trade_call', channel: 'a2mcp', input: 'invalid-timeframe', field: '$outcome', mcp: SDK_VALIDATION, channel_value: HTTP400, note: NOTE_INVALID_ENVELOPE },
  { tool: 'get_trade_call', channel: 'acp', input: 'invalid-timeframe', field: '$outcome', mcp: SDK_VALIDATION, channel_value: 'acp:error(log only, no deliverable)',
    note: 'Q-PIPE-2 row 12 = (a) through the pipeline: ACP declares `timeframe` as a free string, so 7m reached the engine on the CH1 tree and was SERVED as 1h candles labelled 7m; the pipeline\'s timeframe admission now REFUSES it before dispatch (400 INVALID_TIMEFRAME) and the ACP job delivers nothing — decision parity with MCP\'s zod refusal, envelope differs by design.' },
  { tool: 'get_market_regime', channel: 'x402', input: 'invalid-timeframe', field: '$outcome', mcp: SDK_VALIDATION, channel_value: HTTP400, note: NOTE_INVALID_ENVELOPE },
  { tool: 'get_market_regime', channel: 'a2mcp', input: 'invalid-timeframe', field: '$outcome', mcp: SDK_VALIDATION, channel_value: HTTP400, note: NOTE_INVALID_ENVELOPE },
  { tool: 'scan_funding_arb', channel: 'x402', input: 'invalid-limit', field: '$outcome', mcp: SDK_VALIDATION, channel_value: HTTP400, note: NOTE_INVALID_ENVELOPE },
  { tool: 'scan_funding_arb', channel: 'a2mcp', input: 'invalid-limit', field: '$outcome', mcp: SDK_VALIDATION, channel_value: HTTP400, note: NOTE_INVALID_ENVELOPE },
  { tool: 'scan_funding_arb', channel: 'acp', input: 'invalid-limit', field: '$outcome', mcp: SDK_VALIDATION, channel_value: ACP_SKIP, note: NOTE_INVALID_ENVELOPE },
  { tool: 'scan_trade_calls', channel: 'x402', input: 'invalid-topN', field: '$outcome', mcp: SDK_VALIDATION, channel_value: HTTP400, note: NOTE_INVALID_ENVELOPE },
  { tool: 'scan_trade_calls', channel: 'a2mcp', input: 'invalid-topN', field: '$outcome', mcp: SDK_VALIDATION, channel_value: HTTP400, note: NOTE_INVALID_ENVELOPE },
  { tool: 'scan_trade_calls', channel: 'acp', input: 'invalid-topN', field: '$outcome', mcp: SDK_VALIDATION, channel_value: ACP_SKIP, note: NOTE_INVALID_ENVELOPE },
  // ── the engine-error arm: MCP maps a thrown error to a structured isError payload, the x402 route to 500 JSON ──
  { tool: 'get_equity_call', channel: 'x402', input: 'defaults', field: '$outcome', mcp: 'isError:json[error]', channel_value: 'http500:json[code,error,message]',
    note: 'the equity engine throws (no Postgres pool here, as on every SQLite-backed test and any outage): MCP → toolErrorContent {error} isError:true · x402 → 500 X402_HTTP_HANDLER_ERROR. Same thrown error, two envelopes.' },
  { tool: 'get_equity_regime', channel: 'x402', input: 'defaults', field: '$outcome', mcp: 'isError:json[error]', channel_value: 'http500:json[code,error,message]',
    note: 'as get_equity_call.' },
  // ── the equity-universe ticker (new-rows rule): on SQLite the universe read fails open to perp on every channel; the venue has no AAPL so the engine throws — same thrown error, three envelopes ──
  { tool: 'get_trade_call', channel: 'x402', input: 'bare-equity-ticker', field: '$outcome', mcp: 'isError:json[error]', channel_value: 'http500:json[code,error,message]',
    note: 'engine throws (AAPL unknown to the synthetic venue; the equity universe read fails open → perp): MCP toolErrorContent {error} · x402 500. Equity branch needs the Postgres lane.' },
  { tool: 'get_trade_call', channel: 'a2mcp', input: 'bare-equity-ticker', field: '$outcome', mcp: 'isError:json[error]', channel_value: 'http500:json[code,error,message]', note: 'as x402.' },
  { tool: 'get_trade_call', channel: 'acp', input: 'bare-equity-ticker', field: '$outcome', mcp: 'isError:json[error]', channel_value: 'acp:error(log only, no deliverable)', note: 'as x402; ACP logs and returns error, no deliverable.' },
  // ── scan_trade_calls invalid timeframe (new-rows rule) ──
  { tool: 'scan_trade_calls', channel: 'x402', input: 'invalid-timeframe', field: '$outcome', mcp: SDK_VALIDATION, channel_value: HTTP400, note: NOTE_INVALID_ENVELOPE },
  { tool: 'scan_trade_calls', channel: 'a2mcp', input: 'invalid-timeframe', field: '$outcome', mcp: SDK_VALIDATION, channel_value: HTTP400, note: NOTE_INVALID_ENVELOPE },
  { tool: 'scan_trade_calls', channel: 'acp', input: 'invalid-timeframe', field: '$outcome', mcp: SDK_VALIDATION, channel_value: 'acp:error(log only, no deliverable)',
    note: 'second instance of the row-12 class: ACP Market Scan declares `timeframe` as a free string; the pipeline\'s timeframe admission refuses 7m before dispatch (CH1 tree: served on the engine fallback window).' },
  // ── the alias is DECLARED on a2mcp/acp but only canonical names are routed (open register row DECLARED-NOT-SERVED get_trade_signal alias) ──
  { tool: 'get_trade_signal', channel: 'a2mcp', input: 'bare-coin', field: '$route', mcp: 'served', channel_value: 'not_served (registry a2mcp:true)',
    note: '/capabilities projects get_trade_call\'s channels onto the alias; okxA2mcpTools() routes canonical names only (/a2mcp/get_trade_signal → 404). Register row owner: OPS-A2MCP-SERVED-TRUTH-W1 finding, rides with the next feature-registry alias-projection wave.' },
  { tool: 'get_trade_signal', channel: 'acp', input: 'bare-coin', field: '$route', mcp: 'served', channel_value: 'not_served (registry acp:true)',
    note: 'ACP offerings are keyed by canonical tool (offerings.ts); the alias has no offering.' },
];

/**
 * CLOSED normalisation list. Only these paths are removed before comparison, each for the reason
 * given; anything else that differs is a divergence.
 */
export const STRIPPED_FIELDS: Array<{ path: string; reason: string }> = [
  { path: '_algovault.session_id', reason: 'request id — derived from the request context each channel installs (track-token ?? ipHash ?? uuid); A2MCP/ACP install none' },
  { path: 'timestamp', reason: 'wall-clock seconds at response time (scan_funding_arb)' },
  { path: '_algovault.quota.resets_at', reason: 'wall-clock: monthResetAtMs() is `periodStart ?? Date.now()` + 30d, and an x402 caller has no tracker, so two calls ms apart differ (scan_trade_calls)' },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Input matrix
// ─────────────────────────────────────────────────────────────────────────────────────────────
interface Case { tool: string; name: string; args: Record<string, unknown> }
/**
 * Per tool: (a) all defaults, (b) every optional parameter the channels SHARE, (b′) the MCP-only
 * parameters, (c) one invalid input. get_trade_call also: bare coin · coin+timeframe · coin+exchange ·
 * assetClass:'perp'. The MCP alias get_trade_signal is driven as its own served name. Distinct coins
 * per case keep the funding z-score store below its sample floor. No 1m/3m/5m: those carry an x402
 * timeframe premium and the GET 402 advertises the base price.
 */
export const CASES: Case[] = [
  { tool: 'get_trade_call', name: 'bare-coin', args: { coin: 'BTC' } },
  { tool: 'get_trade_call', name: 'coin+timeframe', args: { coin: 'ETH', timeframe: '1h' } },
  { tool: 'get_trade_call', name: 'coin+exchange', args: { coin: 'SOL', exchange: 'HL' } },
  { tool: 'get_trade_call', name: 'all-optional', args: { coin: 'XRP', timeframe: '4h', exchange: 'BINANCE', includeReasoning: false } },
  { tool: 'get_trade_call', name: 'assetClass-perp', args: { coin: 'DOGE', assetClass: 'perp' } },
  { tool: 'get_trade_call', name: 'invalid-timeframe', args: { coin: 'ADA', timeframe: '7m' } },
  // Q-PIPE ruling (new-rows rule): a bare EQUITY-universe ticker. On the SQLite backend the universe
  // read fails open to perp (no Postgres pool), so every channel routes to perp BINANCE 15m; the
  // equity branch itself needs the Postgres lane. The venue carries no AAPL, so the engine refuses.
  { tool: 'get_trade_call', name: 'bare-equity-ticker', args: { coin: 'AAPL' } },
  { tool: 'get_trade_signal', name: 'bare-coin', args: { coin: 'LINK' } },
  { tool: 'get_market_regime', name: 'defaults', args: { coin: 'BTC' } },
  { tool: 'get_market_regime', name: 'all-optional', args: { coin: 'ETH', timeframe: '1h', exchange: 'BINANCE' } },
  { tool: 'get_market_regime', name: 'invalid-timeframe', args: { coin: 'SOL', timeframe: '2h' } },
  { tool: 'scan_funding_arb', name: 'defaults', args: {} },
  { tool: 'scan_funding_arb', name: 'all-optional', args: { minSpreadBps: 1, limit: 5 } },
  { tool: 'scan_funding_arb', name: 'invalid-limit', args: { limit: 0 } },
  { tool: 'scan_trade_calls', name: 'defaults', args: {} },
  { tool: 'scan_trade_calls', name: 'all-optional-shared', args: { topN: 5, timeframe: '1h', exchange: 'BINANCE', minConfidence: 10, includeHolds: true, limit: 5 } },
  { tool: 'scan_trade_calls', name: 'mcp-only-params', args: { topN: 5, rankBy: 'oi', includeReasoning: true } },
  { tool: 'scan_trade_calls', name: 'invalid-topN', args: { topN: 0 } },
  { tool: 'scan_trade_calls', name: 'invalid-timeframe', args: { timeframe: '7m' } },
  { tool: 'get_equity_call', name: 'defaults', args: { symbol: 'AAPL' } },
  { tool: 'get_equity_regime', name: 'defaults', args: {} },
];

/** The /x402 route each served name is driven on (the paid get_trade_call alias is the documented one). */
const X402_ROUTE_OF: Record<string, string> = {
  get_trade_call: '/x402/get_trade_call', get_trade_signal: '/x402/get_trade_signal', get_market_regime: '/x402/get_market_regime',
  scan_funding_arb: '/x402/scan_funding_arb', scan_trade_calls: '/x402/scan_trade_calls',
  get_equity_call: '/x402/get_equity_call', get_equity_regime: '/x402/get_equity_regime',
};
/** The /a2mcp routes the live mount serves — canonical names only (okxA2mcpTools()). */
const A2MCP_SERVED = new Set(['get_trade_call', 'get_market_regime', 'scan_funding_arb', 'scan_trade_calls']);
/** ACP offering name per served tool (offerings.ts) — canonical names only. */
const ACP_OFFERING_OF: Record<string, string> = {
  get_trade_call: 'AlgoVault Trade Call', scan_trade_calls: 'AlgoVault Market Scan', scan_funding_arb: 'AlgoVault Funding Arb',
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Harness state
// ─────────────────────────────────────────────────────────────────────────────────────────────
const SESSION = 'parity-harness-session';
const X402_LICENSE = { tier: 'x402' as const, key: null, outcome: 'RESOLVED' as const };
const OKX_ENV = { OKX_AI_ENABLED: 'true', OKX_API_KEY: 'k', OKX_SECRET_KEY: 's', OKX_PASSPHRASE: 'p', OKX_A2MCP_PAYTO: '0x62366c50e1bb14ed4ff2b6c8c143f6049df075b9' };
const ORIG_ENV = { ...process.env };
const realFetch = globalThis.fetch;

interface Observation { channel: Channel; status: ObsStatus; httpStatus?: number; payload: unknown; extra?: string[]; acpStep?: string }
type Driver = (c: Case) => Promise<Observation>;

let tempHome = '';
let srcIndex: typeof import('../../src/index.js');
let license: typeof import('../../src/lib/license.js');
let grid: typeof import('../../src/lib/cross-asset-grid.js');
let x402http: typeof import('@x402/core/http');
let okxhttp: typeof import('@okxweb3/x402-core/http');
let mcpClient: import('@modelcontextprotocol/sdk/client/index.js').Client;
let mcpServer: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
let x402Server: Server | undefined; let x402Base = '';
let a2mcpServer: Server | undefined; let a2mcpBase = '';
let acp: { handleAcpEntry: typeof import('../../src/channels/acp/seller-worker.js').handleAcpEntry; acpPriceUsd: typeof import('../../src/channels/acp/seller-worker.js').acpPriceUsd; acpCallTool: typeof import('../../src/channels/acp/seller-worker.js').acpCallTool };
let channelsOf: (tool: string) => Record<string, boolean>;
let requestLogCount: () => number;
let requestLogProbeError = '';
const requestLogRowsByChannel: Record<Channel, number> = { mcp: 0, x402: 0, a2mcp: 0, acp: 0 };

/**
 * Q-PIPE-1 condition 3 — R-6 is ROW- and COLUMN-exact. Every call's writes are read back off the
 * SQLite file and compared to `tests/fixtures/tool-call-parity/recorded-rows.json`, captured on the
 * CH1 tree (origin/main 221d3a0a, before the pipeline existed). Time-varying columns are dropped;
 * venue-dependent columns (the verdict and its HOLD-capture siblings) are projected to presence,
 * because the synthetic venue's prices move with the frozen clock while the COLUMN pattern — which
 * channel fills which column — is what the ruling freezes. `PARITY_WRITE_FIXTURE=1` rewrites it.
 */
const FIXTURE_PATH = path.resolve(__dirname, '..', 'fixtures', 'tool-call-parity', 'recorded-rows.json');
const WRITE_FIXTURE = process.env.PARITY_WRITE_FIXTURE === '1';
const TIME_VARYING_COLUMNS = new Set(['id', 'timestamp', 'response_time_ms']);
const VENUE_DEPENDENT_COLUMNS = new Set(['verdict', 'confidence', 'regime', 'exchange', 'would_be_side', 'price_at_decision']);
interface RecordedWrites { request_log: Array<Record<string, unknown>>; agent_session_call_count_delta: number; funnel_events_delta: number }
let readDb: () => { requestLog: Array<Record<string, unknown>>; agentCallCount: number; funnelCount: number };
const recorded: Record<string, RecordedWrites> = {};
let fixture: Record<string, RecordedWrites> | null = null;
/**
 * The HOLD-capture quartet is stamped by the engine ONLY on a HOLD verdict (hold-decision-capture.ts),
 * so on the MCP channel — which records inside the request scope — its presence follows the synthetic
 * verdict and is not stable run to run. MCP's own quartet is pinned by regime-request-observability;
 * what THIS fixture freezes is that every other channel never fills it (Q-PIPE-1 condition 3).
 */
const HOLD_CAPTURE_COLUMNS = new Set(['would_be_side', 'exchange', 'regime', 'price_at_decision']);
function projectRow(r: Record<string, unknown>, inScopeChannel: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (TIME_VARYING_COLUMNS.has(k)) continue;
    if (inScopeChannel && HOLD_CAPTURE_COLUMNS.has(k)) { out[k] = '<verdict-dependent>'; continue; }
    out[k] = VENUE_DEPENDENT_COLUMNS.has(k) ? (v === null || v === undefined ? null : '<set>') : v;
  }
  return out;
}
/** Run `fn`, return what it wrote (projected), and record/compare it under `key`. */
async function recordWrites<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const before = readDb();
  const out = await fn();
  const after = readDb();
  const writes: RecordedWrites = {
    request_log: after.requestLog.slice(before.requestLog.length).map((r) => projectRow(r, key.endsWith('/mcp'))),
    agent_session_call_count_delta: after.agentCallCount - before.agentCallCount,
    funnel_events_delta: after.funnelCount - before.funnelCount,
  };
  recorded[key] = writes;
  if (!WRITE_FIXTURE) {
    expect(fixture, 'recorded-rows fixture missing — run once with PARITY_WRITE_FIXTURE=1 on the reference tree').not.toBeNull();
    expect(writes, `recorded writes drifted from the CH1 fixture for ${key}`).toEqual(fixture![key]);
  }
  return out;
}
let nonceSeq = 0;
const freshNonce = () => `0x${(++nonceSeq).toString(16).padStart(64, '0')}`;

const ctxFor = () => ({ license: X402_LICENSE, sessionId: SESSION, ipHash: 'v2:parityharness0000', isAutomated: false, userAgent: 'parity-harness', source: null as string | null });

function parseJsonText(text: string): { ok: true; value: unknown } | { ok: false } {
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; }
}

// ── channel drivers ─────────────────────────────────────────────────────────────────────────
const driveMcp: Driver = async (c) => {
  const r = await license.requestContext.run(ctxFor() as never, () => mcpClient.callTool({ name: c.tool, arguments: c.args })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  const content = r.content ?? [];
  const first = content[0]?.text ?? '';
  const parsed = parseJsonText(first);
  const extra = content.slice(1).map((b) => b.text ?? '');
  if (r.isError) {
    // The SDK's own zod rejection is prose ("MCP error -32602: Input validation error…"); an
    // engine's structured refusal (toolErrorContent) is JSON.
    return parsed.ok ? { channel: 'mcp', status: 'tool_error', payload: parsed.value, extra } : { channel: 'mcp', status: 'rejected', payload: { text: first }, extra };
  }
  return { channel: 'mcp', status: 'ok', payload: parsed.ok ? parsed.value : { text: first }, extra };
};

async function paidX402Headers(route: string): Promise<Record<string, string>> {
  const g = await realFetch(`${x402Base}${route}`);
  if (g.status !== 402) throw new Error(`x402 GET ${route} → ${g.status}, expected 402`);
  const required = x402http.decodePaymentRequiredHeader(g.headers.get('payment-required')!);
  const accepted = required.accepts[0];
  const payload = {
    x402Version: 2,
    resource: required.resource,
    accepted,
    payload: {
      signature: `0x${'11'.repeat(65)}`,
      authorization: { from: PAYER, to: accepted.payTo, value: String(accepted.amount), validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 600), nonce: freshNonce() },
    },
  };
  return { 'content-type': 'application/json', 'payment-signature': x402http.encodePaymentSignatureHeader(payload as never), 'x-algovault-track-token': SESSION };
}

const driveX402: Driver = async (c) => {
  const route = X402_ROUTE_OF[c.tool];
  const headers = await paidX402Headers(route);
  const res = await realFetch(`${x402Base}${route}`, { method: 'POST', headers, body: JSON.stringify(c.args) });
  const body = await res.json();
  const status: ObsStatus = res.status === 200 ? 'ok' : res.status === 400 ? 'rejected' : 'threw';
  return { channel: 'x402', status, httpStatus: res.status, payload: body };
};

async function paidA2mcpHeaders(route: string): Promise<Record<string, string>> {
  const g = await realFetch(`${a2mcpBase}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  if (g.status !== 402) throw new Error(`a2mcp unpaid POST ${route} → ${g.status}, expected 402`);
  const required = okxhttp.decodePaymentRequiredHeader(g.headers.get('payment-required')!);
  const accepted = required.accepts[0];
  const payload = {
    x402Version: 2,
    resource: required.resource,
    accepted,
    payload: {
      signature: `0x${'11'.repeat(65)}`,
      authorization: { from: PAYER, to: OKX_ENV.OKX_A2MCP_PAYTO, value: String(accepted.amount), validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 600), nonce: freshNonce() },
    },
  };
  return { 'content-type': 'application/json', 'payment-signature': okxhttp.encodePaymentSignatureHeader(payload as never) };
}

const driveA2mcp: Driver = async (c) => {
  const route = `/a2mcp/${c.tool}`;
  const headers = await paidA2mcpHeaders(route);
  const res = await realFetch(`${a2mcpBase}${route}`, { method: 'POST', headers, body: JSON.stringify(c.args) });
  const text = await res.text();
  const parsed = parseJsonText(text);
  const status: ObsStatus = res.status === 200 ? 'ok' : res.status === 400 ? 'rejected' : 'threw';
  return { channel: 'a2mcp', status, httpStatus: res.status, payload: parsed.ok ? parsed.value : { text } };
};

const driveAcp: Driver = async (c) => {
  const submits: string[] = [];
  const budgets: Array<{ amount: number; symbol: string }> = [];
  const log: string[] = [];
  const requirementEntry = { kind: 'message' as const, contentType: 'requirement', content: JSON.stringify(c.args) };
  // A real JobSession carries the requirement message in its history; the worker re-reads it on
  // `job.funded` (latestRequirement), so the funded session must carry the entry too.
  const mk = (status: string, entries: Array<typeof requirementEntry>) => ({
    jobId: `job-${c.tool}-${c.name}`, chainId: 8453, roles: ['provider'], status,
    job: { description: ACP_OFFERING_OF[c.tool] }, entries,
    async setBudget(a: { amount: number; symbol: string }) { budgets.push(a); },
    async submit(d: string) { submits.push(d); },
  });
  // Exactly how startAcpSellerWorker wires the worker: the exported production callTool (the pipeline with the ACP license).
  const deps = {
    usdc: (amount: number) => ({ amount, symbol: 'USDC' }),
    callTool: acp.acpCallTool,
    priceFor: acp.acpPriceUsd,
    submitted: new Set<string>(),
    log: (m: string) => log.push(m),
  };
  const r1 = await acp.handleAcpEntry(mk('open', []) as never, requirementEntry, deps as never);
  if (r1 !== 'budget_set') return { channel: 'acp', status: 'rejected', payload: { step: r1 }, acpStep: r1 };
  const r2 = await acp.handleAcpEntry(mk('funded', [requirementEntry]) as never, { kind: 'system', event: { type: 'job.funded' } }, deps as never);
  if (r2 !== 'submitted') return { channel: 'acp', status: r2 === 'error' ? 'threw' : 'rejected', payload: { step: r2, log }, acpStep: r2 };
  const parsed = parseJsonText(submits[0] ?? '');
  return { channel: 'acp', status: 'ok', payload: parsed.ok ? parsed.value : { text: submits[0] } };
};

// ── normalisation + diff ────────────────────────────────────────────────────────────────────
function deleteAtPath(obj: unknown, dotted: string): void {
  const parts = dotted.split('.');
  let cur: unknown = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur || typeof cur !== 'object') return;
    cur = (cur as Record<string, unknown>)[parts[i]];
  }
  if (cur && typeof cur === 'object') delete (cur as Record<string, unknown>)[parts[parts.length - 1]];
}
export function normalise(payload: unknown): unknown {
  const clone = JSON.parse(JSON.stringify(payload ?? null));
  for (const { path: p } of STRIPPED_FIELDS) deleteAtPath(clone, p);
  return clone;
}
export function deepDiff(a: unknown, b: unknown, at = ''): Array<{ field: string; mcp: unknown; channel_value: unknown }> {
  if (a === b) return [];
  const isObj = (x: unknown) => x !== null && typeof x === 'object';
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) return [{ field: at || '$', mcp: a, channel_value: b }];
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return [{ field: `${at}.length`, mcp: a.length, channel_value: b.length }];
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  const out: Array<{ field: string; mcp: unknown; channel_value: unknown }> = [];
  for (const k of keys) out.push(...deepDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], at ? `${at}.${k}` : k));
  return out;
}
/** Compress a leaf value for the DIVERGENCES table: long strings/objects become a shape token. */
function summarise(v: unknown): unknown {
  if (v === undefined) return '<absent>';
  if (typeof v === 'string') return v.length > 80 ? `<string ${v.length} chars>` : v;
  if (v && typeof v === 'object') return `<${Array.isArray(v) ? 'array' : 'object'} ${Object.keys(v).length}>`;
  return v;
}
/** The outcome CLASS + envelope shape of an observation — what `$outcome` rows compare. */
export function envelopeShape(o: Observation): string {
  if (o.status === 'ok') return 'ok';
  const keys = (p: unknown) => (p && typeof p === 'object' && !Array.isArray(p) ? Object.keys(p as object).sort().join(',') : typeof p);
  if (o.channel === 'mcp') return o.status === 'rejected' ? 'isError:text(sdk-validation)' : `isError:json[${keys(o.payload)}]`;
  if (o.channel === 'acp') return o.status === 'threw' ? 'acp:error(log only, no deliverable)' : `acp:${o.acpStep ?? 'skipped'}`;
  return `http${o.httpStatus}:json[${keys(o.payload)}]`;
}

const observed: Array<{ tool: string; input: string; channel: Channel; status: ObsStatus; httpStatus?: number; diffs: Array<{ field: string; mcp: unknown; channel_value: unknown }> }> = [];

// ─────────────────────────────────────────────────────────────────────────────────────────────
beforeAll(async () => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-parity-'));
  process.env.HOME = tempHome; process.env.USERPROFILE = tempHome;
  delete process.env.DATABASE_URL;
  process.env.PERFORMANCE_DB_PATH = path.join(tempHome, 'performance.db');
  process.env.ALGOVAULT_IP_HASH_KEY = 'parity-harness-ip-hash-key-0123456789abcdef0123456789abcdef';
  process.env.X402_WALLET_ADDRESS = '0x778A05280Fd8dB980E920fE9f31d0A8eAbD17d59';
  process.env.X402_NETWORK = 'base-mainnet';
  process.env.X402_FACILITATOR = 'cdp'; process.env.BAZAAR_DISCOVERABLE = 'true';
  process.env.CDP_API_KEY_ID = 'parity-test-key-id'; process.env.CDP_API_KEY_SECRET = 'parity-test-key-secret';
  Object.assign(process.env, OKX_ENV);
  process.env.EQUITY_TOOLS_ENABLED = '1';
  process.env.SCAN_DEADLINE_MS = '120000';
  for (const k of ['X402_NUDGE_ENABLED', 'CANDLE_BASIS', 'STEPUP_MODE', 'ACP_ENABLED', 'CIRCLE_GATEWAY_ENABLED', 'MCP_STATELESS']) delete process.env[k];

  // Only the OKX facilitator's HTTP surface is faked; everything else is the real fetch.
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    if (!u.startsWith('https://web3.okx.com')) return realFetch(url as never, init);
    const json = (data: unknown) => new Response(JSON.stringify({ code: '0', msg: '', data }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.includes('/x402/supported')) return json({ kinds: [{ scheme: 'exact', network: 'eip155:196', x402Version: 2, extra: null }], signers: { 'eip155:196': ['0x0000000000000000000000000000000000000001'] }, extensions: [] });
    if (u.includes('/x402/verify')) return json({ isValid: true, payer: PAYER });
    if (u.includes('/x402/settle')) return json({ success: true, status: 'success', transaction: `0x${'cd'.repeat(32)}`, network: 'eip155:196', payer: PAYER });
    return new Response('{"code":"1","msg":"unmodelled"}', { status: 404 });
  }));

  srcIndex = await import('../../src/index.js');
  license = await import('../../src/lib/license.js');
  grid = await import('../../src/lib/cross-asset-grid.js');
  x402http = await import('@x402/core/http');
  okxhttp = await import('@okxweb3/x402-core/http');
  const registry = await import('../../src/lib/feature-registry.js');
  channelsOf = (tool) => registry.getFeature(tool)!.channels as unknown as Record<string, boolean>;
  const routes = await import('../../src/lib/x402-http-routes.js');
  const seller = await import('../../src/channels/acp/seller-worker.js');
  acp = { handleAcpEntry: seller.handleAcpEntry, acpPriceUsd: seller.acpPriceUsd, acpCallTool: seller.acpCallTool };

  // request_log row counter straight off the SQLite file — the R-6 fact (which channels record).
  const Database = (await import('better-sqlite3')).default;
  requestLogCount = () => {
    try {
      const db = new Database(process.env.PERFORMANCE_DB_PATH!, { readonly: true, fileMustExist: true });
      const n = (db.prepare('SELECT COUNT(*) AS n FROM request_log').get() as { n: number }).n;
      db.close();
      return n;
    } catch (e) { requestLogProbeError = e instanceof Error ? e.message : String(e); return 0; }
  };
  readDb = () => {
    const out = { requestLog: [] as Array<Record<string, unknown>>, agentCallCount: 0, funnelCount: 0 };
    try {
      const db = new Database(process.env.PERFORMANCE_DB_PATH!, { readonly: true, fileMustExist: true });
      try { out.requestLog = db.prepare('SELECT * FROM request_log ORDER BY id').all() as Array<Record<string, unknown>>; } catch { /* table not yet created */ }
      try { out.agentCallCount = ((db.prepare('SELECT call_count FROM agent_sessions WHERE session_id = ?').get(SESSION) as { call_count?: number } | undefined)?.call_count) ?? 0; } catch { /* not yet created */ }
      try { out.funnelCount = (db.prepare('SELECT COUNT(*) AS n FROM funnel_events').get() as { n: number }).n; } catch { /* not yet created */ }
      db.close();
    } catch (e) { requestLogProbeError = e instanceof Error ? e.message : String(e); }
    return out;
  };
  if (!WRITE_FIXTURE && fs.existsSync(FIXTURE_PATH)) fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, RecordedWrites>;

  // The analytics schema (request_log) is created by the boot step both transports run
  // (index.ts startHttp/startStdio → initAnalytics); without it every logRequest INSERT fails
  // silently inside its own try/catch and the R-6 measurement reads zero rows for every channel.
  const analytics = await import('../../src/lib/analytics.js');
  analytics.initAnalytics();

  // Hold the cross-asset grid at an EMPTY, fresh snapshot (existing exported test seam, not a mock).
  grid._clearCache(); grid._setSnapshotForTest([]);

  // MCP: the real server factory over the SDK's in-memory transport.
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  mcpServer = srcIndex.createSandboxServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverT);
  mcpClient = new Client({ name: 'tool-call-parity', version: '0.0.0' });
  await mcpClient.connect(clientT);

  // x402 HTTP: the real router over a real port.
  const express = (await import('express')).default;
  const { initX402 } = await import('../../src/lib/x402.js');
  await initX402();
  const x402App = express();
  const mounted = routes.mountX402HttpRoutes(x402App);
  if (mounted.length === 0) throw new Error('x402 routes did not mount — two-flag firewall resolved OFF');
  x402Server = await new Promise<Server>((r) => { const s = x402App.listen(0, '127.0.0.1', () => r(s)); });
  x402Base = `http://127.0.0.1:${(x402Server.address() as AddressInfo).port}`;

  // A2MCP: the LIVE mount (OKX facilitator faked at its HTTP surface), real port.
  const okx = await import('../../src/lib/okx-a2mcp.js');
  const a2App = express();
  const noTimers = { setTimeout: () => 0 as never, now: () => Date.now(), random: () => 0.5 };
  const a2Mounted = await okx.mountOkxA2mcpRoutes(a2App, { ...process.env, ...OKX_ENV } as never, { timers: noTimers as never });
  if (a2Mounted.length === 0) throw new Error('a2mcp routes did not mount');
  a2mcpServer = await new Promise<Server>((r) => { const s = a2App.listen(0, '127.0.0.1', () => r(s)); });
  a2mcpBase = `http://127.0.0.1:${(a2mcpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  try { await mcpClient?.close(); await mcpServer?.close(); } catch { /* best-effort */ }
  if (x402Server) await new Promise<void>((r) => x402Server!.close(() => r()));
  if (a2mcpServer) await new Promise<void>((r) => a2mcpServer!.close(() => r()));
  vi.unstubAllGlobals();
  for (const k of Object.keys(process.env)) if (!(k in ORIG_ENV)) delete process.env[k];
  Object.assign(process.env, ORIG_ENV);
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
const DRIVERS: Record<Exclude<Channel, 'mcp'>, { flag: string; drive: Driver; serves: (tool: string) => boolean }> = {
  x402: { flag: 'httpX402', drive: driveX402, serves: (t) => t in X402_ROUTE_OF },
  a2mcp: { flag: 'a2mcp', drive: driveA2mcp, serves: (t) => A2MCP_SERVED.has(t) },
  acp: { flag: 'acp', drive: driveAcp, serves: (t) => t in ACP_OFFERING_OF },
};

/** Compare one channel's observation to MCP's; returns the divergence list for the row contract. */
function compare(mcp: Observation, other: Observation): Array<{ field: string; mcp: unknown; channel_value: unknown }> {
  const a = envelopeShape(mcp); const b = envelopeShape(other);
  if (a !== b) return [{ field: '$outcome', mcp: a, channel_value: b }];
  return deepDiff(normalise(mcp.payload), normalise(other.payload));
}

/** True when `field` is covered by a declared row — its own field, or one of its consequents (exact or `prefix.`). */
function coveredBy(row: DivergenceRow, field: string): boolean {
  if (row.field === field) return true;
  return (row.consequents ?? []).some((c) => (c.endsWith('.') ? field.startsWith(c) : field === c));
}

function assertDeclared(tool: string, channel: Exclude<Channel, 'mcp'>, input: string, diffs: Array<{ field: string; mcp: unknown; channel_value: unknown }>): void {
  const declared = DIVERGENCES.filter((r) => r.tool === tool && r.channel === channel && r.input === input);
  const undeclared = diffs.filter((x) => !declared.some((r) => coveredBy(r, x.field)));
  const unobserved = declared.filter((r) => !diffs.some((x) => x.field === r.field));
  expect(undeclared.map((x) => ({ field: x.field, mcp: summarise(x.mcp), channel_value: summarise(x.channel_value) })), `UNDECLARED divergence(s) for ${tool}/${channel}/${input}`).toEqual([]);
  expect(unobserved.map((r) => r.field), `DECLARED divergence(s) no longer observed for ${tool}/${channel}/${input} — the table must change WITH the behaviour`).toEqual([]);
  for (const r of declared) {
    const x = diffs.find((y) => y.field === r.field)!;
    expect({ mcp: summarise(x.mcp), channel_value: summarise(x.channel_value) }, `declared values drifted for ${tool}/${channel}/${input} ${r.field}`).toEqual({ mcp: r.mcp, channel_value: r.channel_value });
  }
}

describe('tool-call parity — every channel against MCP', () => {
  const byTool = new Map<string, Case[]>();
  for (const c of CASES) byTool.set(c.tool, [...(byTool.get(c.tool) ?? []), c]);

  for (const [tool, cases] of byTool) {
    describe(tool, () => {
      for (const c of cases) {
        it(`[${c.name}] MCP is deterministic (two calls, same normalised output)`, async () => {
          grid._setSnapshotForTest([]);
          const before = requestLogCount();
          const a = await recordWrites(`${tool}/${c.name}/mcp`, () => driveMcp(c));
          const b = await driveMcp(c);
          requestLogRowsByChannel.mcp += requestLogCount() - before;
          expect(a.status).toBe(b.status);
          expect(deepDiff(normalise(a.payload), normalise(b.payload))).toEqual([]);
        });

        for (const [channel, d] of Object.entries(DRIVERS) as Array<[Exclude<Channel, 'mcp'>, (typeof DRIVERS)[Exclude<Channel, 'mcp'>]]>) {
          it(`[${c.name}] ${channel} ≡ MCP (registry channels.${d.flag})`, async () => {
            const declaredOn = Boolean(channelsOf(tool)[d.flag]);
            const served = d.serves(tool);
            if (!declaredOn && !served) return; // not this channel's tool — nothing to compare
            if (declaredOn !== served) {
              // The registry and the mount disagree: a `$route` divergence (e.g. the get_trade_signal alias
              // declared a2mcp:true / acp:true while only canonical names are routed — the open
              // DECLARED-NOT-SERVED register row).
              const diffs = [{ field: '$route', mcp: 'served', channel_value: `${served ? 'served' : 'not_served'} (registry ${d.flag}:${declaredOn})` }];
              observed.push({ tool, input: c.name, channel, status: 'rejected', diffs });
              assertDeclared(tool, channel, c.name, diffs);
              return;
            }
            grid._setSnapshotForTest([]);
            const mcp = await driveMcp(c);
            const before = requestLogCount();
            const other = await recordWrites(`${tool}/${c.name}/${channel}`, () => d.drive(c));
            requestLogRowsByChannel[channel] += requestLogCount() - before;
            const diffs = compare(mcp, other);
            // Q-PIPE-2 rows 10–20 (ruled (b) for the ENVELOPE): decision parity — an invalid input is
            // refused on every channel; none serves it. The envelope may differ; the decision may not.
            if (c.name.startsWith('invalid')) {
              expect(mcp.status, `MCP served an invalid input (${tool}/${c.name})`).not.toBe('ok');
              expect(other.status, `${channel} served an invalid input MCP refuses (${tool}/${c.name})`).not.toBe('ok');
            }
            observed.push({ tool, input: c.name, channel, status: other.status, httpStatus: other.httpStatus, diffs });
            assertDeclared(tool, channel, c.name, diffs);
          });
        }
      }
    });
  }

  it('prints the measured parity record (PARITY_* lines are the audit source)', () => {
    const divergent = observed.filter((o) => o.diffs.length > 0);
    const rows = divergent.flatMap((o) => o.diffs.map((x) => ({ tool: o.tool, channel: o.channel, input: o.input, field: x.field, mcp: summarise(x.mcp), channel_value: summarise(x.channel_value) })));
    // eslint-disable-next-line no-console
    console.log(`PARITY_OBSERVATIONS=${observed.length}`);
    for (const o of observed) console.log(`PARITY_OBS ${o.tool} ${o.channel} ${o.input} status=${o.status}${o.httpStatus ? ` http=${o.httpStatus}` : ''} diffs=${o.diffs.length}`);
    for (const r of rows) console.log(`PARITY_DIVERGENCE ${JSON.stringify(r)}`);
    console.log(`PARITY_DIVERGENCES=${DIVERGENCES.length}`);
    console.log(`PARITY_REQUEST_LOG_ROWS mcp=${requestLogRowsByChannel.mcp} x402=${requestLogRowsByChannel.x402} a2mcp=${requestLogRowsByChannel.a2mcp} acp=${requestLogRowsByChannel.acp}${requestLogProbeError ? ` probe_error=${JSON.stringify(requestLogProbeError)}` : ''}`);
    console.log(`PARITY_UNMODELLED ${JSON.stringify([...new Set(syntheticVenue.unmodelled)])}`);
    console.log(`PARITY_RECORDED_KEYS=${Object.keys(recorded).length} fixture=${WRITE_FIXTURE ? 'WRITTEN' : fixture ? 'COMPARED' : 'ABSENT'}`);
    if (WRITE_FIXTURE) {
      fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
      fs.writeFileSync(FIXTURE_PATH, JSON.stringify(recorded, null, 2) + '\n');
      console.log(`PARITY_FIXTURE_WRITTEN ${FIXTURE_PATH}`);
    }
    console.log(`PARITY_VENUE_CALLS=${syntheticVenue.calls.length} hosts=${JSON.stringify([...new Set(syntheticVenue.calls.map((c) => c.split(' ')[1].split('/')[0]))])}`);
    expect(observed.length).toBeGreaterThan(0);
  });

  it('R-6 recording: MCP and x402 write request_log rows; A2MCP and ACP write none', () => {
    expect(requestLogProbeError, 'the request_log probe must be able to read the SQLite file').toBe('');
    expect(requestLogRowsByChannel.mcp).toBeGreaterThan(0);
    expect(requestLogRowsByChannel.x402).toBeGreaterThan(0);
    expect(requestLogRowsByChannel.a2mcp).toBe(0);
    expect(requestLogRowsByChannel.acp).toBe(0);
  });
});

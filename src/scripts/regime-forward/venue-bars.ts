// regime-forward/venue-bars.ts — EDGE-REGIME-FORWARD-W1: the outcome source, the venues' own closed bars.
//
// Each venue's REST klines at the label's timeframe over key A's span — the bars T3's `buildKeyA` reads, opening at
// or after W0 − 14 bars and closing at or before W1 + 14 bars (src/scripts/regime-diag/keys.ts) — for the
// instrument the served label was computed on (the adapters' own symbol maps). The adapters' getCandles is not used:
// it serves a window ending now, and Bybit's takes no end time (src/lib/adapters/bybit.ts getCandles), so it cannot
// return a past window. The endpoints are the ones probed in CH1 (vault audits/EDGE-REGIME-FORWARD-W1-evidence.md P3).
//
// Every bar is fetched BEFORE the seal, on or after not_before, into the read's own store (bar-store.ts); after
// the seal no venue is asked (registration §1; CH3 F16). The network door is `restSource()`: it takes nothing
// injected, and every request it sends first passes `networkRefusal` — the real clock before not_before, and the
// seal in the fixed home — which no lever disables (lesson 10). The pager, the reply classifier, the parsers and
// the pacer are pure functions the tests drive. `guardedSource` sits in front of any source: the clock, a
// census-panel coin, the read's own seal and a range outside key A's span each refuse before the source is called.
import path from 'node:path';
import type { Candle } from '../../types.js';
import { toBinanceSymbol } from '../../lib/adapters/binance.js';
import { toBybitSymbol } from '../../lib/adapters/bybit.js';
import { toOKXInstId } from '../../lib/adapters/okx.js';
import { toBitgetSymbol } from '../../lib/adapters/bitget.js';
import type { Bars } from '../regime-diag/archive.js';
import { HISTORY_BARS, MUTATE, NOT_BEFORE_MS, W0_MS, originMs, tfMs, windowEndMs, type Tf, type Venue } from './forward-spec.js';
import { SEAL, entryExists, forwardHome } from './forward-guard.js';

export type BarSource = (venue: Venue, coin: string, tf: Tf, startMs: number, endMs: number) => Promise<Candle[]>;

/** A rule of the read refused the request: a fault of the read, never retried and never skipped. */
export class RefusedError extends Error {}
/** The venue throttled or banned the read: no request goes to it before `untilMs` (pre-seal: the read is retried). */
export class RateLimitedError extends Error { constructor(readonly venue: Venue, readonly untilMs: number, why: string) { super(why); } }
/** The venue could not be reached (network, timeout, 5xx, a reply that is not JSON) after three tries. */
export class UnreachedError extends Error { constructor(readonly venue: Venue, why: string) { super(why); } }

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Key A's span of one venue × timeframe on the venue grid (origin + k·I): bar k is in it when it opens at or after
 * W0 − 14 bars and closes at or before W1 + 14 bars — `buildKeyA`'s `k ≥ ⌈lo⌉`, `(k + 1)·I ≤ hi`. Both ends are
 * judged on the bar itself, its open at the start and its close at the end (CH3 F5), so no bar that closes after
 * the look-ahead is ever asked for and the store does not depend on the instant of the read. Opens in [startMs, endMs).
 */
export function spanOf(v: Venue, tf: Tf): { k0: number; nb: number; startMs: number; endMs: number } {
  const I = tfMs(tf), o = originMs(v);
  const k0 = Math.ceil((W0_MS - HISTORY_BARS * I - o) / I), nb = Math.floor((windowEndMs(tf) - o) / I);
  return { k0, nb, startMs: o + k0 * I, endMs: o + nb * I };
}

/** Why a range [startMs, endMs) of opens may not be asked: a bar of the venue grid in it opens before key A's span or closes after it. */
export function spanRefusal(v: Venue, tf: Tf, startMs: number, endMs: number): string | null {
  if (!(endMs > startMs)) return `[${startMs}, ${endMs}) is empty`;
  const I = tfMs(tf), o = originMs(v), s = spanOf(v, tf);
  const first = Math.ceil((startMs - o) / I), last = Math.ceil((endMs - o) / I) - 1;
  if (first < s.k0) return `[${startMs}, ${endMs}) opens a ${tf.key} bar at ${iso(o + first * I)}, before key A's span (${iso(s.startMs)})`;
  if (last >= s.nb) return `[${startMs}, ${endMs}) holds a ${tf.key} bar that closes at ${iso(o + (last + 1) * I)}, after key A's span (${iso(windowEndMs(tf))})`;
  return null;
}

/**
 * The door in front of any bar source: the clock, a census-panel coin, the read's own seal (no request after it)
 * and key A's span each refuse before the source is called.
 */
export function guardedSource(src: BarSource, now: () => number, panel: ReadonlySet<string>, home: string): BarSource {
  return async (venue, coin, tf, startMs, endMs) => {
    if (now() < NOT_BEFORE_MS && MUTATE !== 'clock') throw new RefusedError(`no bar is fetched before not_before ${iso(NOT_BEFORE_MS)}`);
    if (panel.has(coin) && MUTATE !== 'panel') throw new RefusedError(`${coin} is a census-panel coin: T9's corpus, never fetched by T5`);
    if (entryExists(path.join(home, SEAL)) && MUTATE !== 'postseal') throw new RefusedError('no bar is fetched once the read is sealed: every bar is fetched before the seal');
    const why = spanRefusal(venue, tf, startMs, endMs);
    if (why) throw new RefusedError(why);
    return src(venue, coin, tf, startMs, endMs);
  };
}

const INTERVAL: Readonly<Record<Venue, Readonly<Record<Tf['key'], string>>>> = Object.freeze({
  BINANCE: { '1h': '1h', '4h': '4h', '1d': '1d' },
  BYBIT: { '1h': '60', '4h': '240', '1d': 'D' },
  OKX: { '1h': '1H', '4h': '4H', '1d': '1D' },
  BITGET: { '1h': '1H', '4h': '4H', '1d': '1D' },
});

/** One request's URL: the bars that open in [from, to], `limit` of them at most. */
export function klineUrl(v: Venue, coin: string, tf: Tf, from: number, to: number, limit: number): string {
  const iv = INTERVAL[v][tf.key];
  switch (v) {
    case 'BINANCE': return `https://fapi.binance.com/fapi/v1/klines?symbol=${toBinanceSymbol(coin)}&interval=${iv}&startTime=${from}&endTime=${to}&limit=${limit}`;
    case 'BYBIT': return `https://api.bybit.com/v5/market/kline?category=linear&symbol=${toBybitSymbol(coin)}&interval=${iv}&start=${from}&end=${to}&limit=${limit}`;
    // history-candles: `after` returns bars older than the ts; one page is at most 100 bars.
    case 'OKX': return `https://www.okx.com/api/v5/market/history-candles?instId=${toOKXInstId(coin)}&bar=${iv}&after=${to + 1}&before=${from - 1}&limit=${limit}`;
    // history-candles filters on the bar's CLOSE (measured 2026-11-18 on an October range: [from, to] returned the bars
    // opening one bar earlier), so the request is shifted one bar later to return the bars that OPEN in [from, to].
    case 'BITGET': return `https://api.bitget.com/api/v2/mix/market/history-candles?symbol=${toBitgetSymbol(coin)}&productType=USDT-FUTURES&granularity=${iv}&startTime=${from + tfMs(tf)}&endTime=${to + tfMs(tf)}&limit=${limit}`;
  }
}

/** Rows of a venue reply as [open, o, h, l, c, v]; throws on an error reply. */
export function rowsOf(v: Venue, body: unknown): Array<Array<string | number>> {
  const b = body as { code?: unknown; retCode?: unknown; msg?: unknown; result?: { list?: unknown }; data?: unknown };
  if (v === 'BINANCE') { if (!Array.isArray(body)) throw new Error(`BINANCE: ${JSON.stringify(body).slice(0, 160)}`); return body as Array<Array<string | number>>; }
  if (v === 'BYBIT') { if (b.retCode !== 0 || !Array.isArray(b.result?.list)) throw new Error(`BYBIT: ${JSON.stringify(body).slice(0, 160)}`); return b.result!.list as Array<Array<string>>; }
  if (String(b.code) !== '0' && String(b.code) !== '00000') throw new Error(`${v}: ${JSON.stringify(body).slice(0, 160)}`);
  if (!Array.isArray(b.data)) throw new Error(`${v}: no data`);
  return b.data as Array<Array<string>>;
}

/**
 * Bars per request, at most: Binance 1,000 (a 1,500-bar request costs weight 10, a 1,000-bar one 5), Bybit 1,000,
 * OKX history-candles 100, Bitget history-candles 200. Each request asks `limit` = the bars of its page, no more.
 */
export const PAGE_MAX: Readonly<Record<Venue, number>> = Object.freeze({ BINANCE: 1000, BYBIT: 1000, OKX: 100, BITGET: 200 });
/** Binance fapi klines request weight by `limit` (its documented table; 499 → 2, 1000 → 5 and 1500 → 10 measured at CH3). */
export const binanceWeight = (limit: number): number => (limit < 100 ? 1 : limit < 500 ? 2 : limit <= 1000 ? 5 : 10);

export interface Page { from: number; to: number; limit: number; weight: number; url: string }

/** The requests that cover [startMs, endMs) of opens: pages of at most PAGE_MAX bars, each asking exactly its bars. */
export function pagesOf(v: Venue, coin: string, tf: Tf, startMs: number, endMs: number): Page[] {
  const I = tfMs(tf), out: Page[] = [];
  for (let from = startMs; from < endMs; from += PAGE_MAX[v] * I) {
    const to = Math.min(endMs, from + PAGE_MAX[v] * I) - 1, limit = Math.ceil((to + 1 - from) / I);
    out.push({ from, to, limit, weight: v === 'BINANCE' ? binanceWeight(limit) : 1, url: klineUrl(v, coin, tf, from, to, limit) });
  }
  return out;
}

/**
 * The rate-limit answers of each venue: the statuses and body codes of `VENUE_FETCH_CONFIGS` in
 * src/lib/adapters/_upstream-fetch.ts (a test holds them equal), plus Binance's body code -1003 (TOO_MANY_REQUESTS).
 * A rate limit is never retried (retrying a ban extends it): the venue stops until its Retry-After.
 */
export const BAN_STATUSES: Readonly<Record<Venue, readonly number[]>> = Object.freeze({ BINANCE: [418, 429], BYBIT: [403, 418, 429], OKX: [418, 429], BITGET: [418, 429] });
export const BAN_BODY_CODES: Readonly<Record<Venue, ReadonlyArray<string | number>>> = Object.freeze({ BINANCE: [-1003], BYBIT: [], OKX: [], BITGET: [45001, 40725, 40808] });
/** The wait when a rate-limit answer names none. */
export const DEFAULT_RETRY_AFTER_MS = 60_000;
export const retryAfterMsOf = (h: string | null): number => (h !== null && /^\d+$/.test(h.trim()) ? Number(h.trim()) * 1000 : DEFAULT_RETRY_AFTER_MS);

/** A venue's reply as the network gave it. */
export interface Reply { status: number; retryAfter: string | null; text: string }
export type Verdict =
  | { kind: 'rows'; rows: Array<Array<string | number>> }
  | { kind: 'rate'; retryAfterMs: number; why: string }
  | { kind: 'transient'; why: string }
  | { kind: 'error'; why: string };

/**
 * What a reply is: rows; a rate limit (a ban status or body code); transient (5xx, or not JSON); or the venue's
 * error answer (any other reply its parser refuses, such as an unknown symbol).
 */
export function classify(v: Venue, r: Reply): Verdict {
  if (BAN_STATUSES[v].includes(r.status)) return { kind: 'rate', retryAfterMs: retryAfterMsOf(r.retryAfter), why: `HTTP ${r.status}` };
  let body: unknown;
  try { body = JSON.parse(r.text); } catch { return { kind: 'transient', why: `HTTP ${r.status}: the reply is not JSON` }; }
  const code = (body as { code?: unknown } | null)?.code;
  if (code !== undefined && BAN_BODY_CODES[v].some((c) => String(c) === String(code))) return { kind: 'rate', retryAfterMs: retryAfterMsOf(r.retryAfter), why: `body code ${String(code)}` };
  if (r.status >= 500) return { kind: 'transient', why: `HTTP ${r.status}` };
  try { return { kind: 'rows', rows: rowsOf(v, body) }; } catch (e) { return { kind: 'error', why: (e as Error).message }; }
}

/** The bars of a page's rows, inside [from, to], as candles. */
export const candlesOf = (rows: ReadonlyArray<ReadonlyArray<string | number>>, from: number, to: number): Candle[] =>
  rows.map((r) => ({ time: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }))
    .filter((c) => c.time >= from && c.time <= to);

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * One venue's pace: a minimum gap between requests and a request weight budget over any 60 s (Binance's weight;
 * every other venue's request counts 1 against an unbounded budget, so its gap paces it). Pure over its clock.
 */
export class Pacer {
  private sent: Array<{ t: number; w: number }> = [];
  private last = -Infinity;
  constructor(readonly gapMs: number, readonly budgetPerMin: number, readonly now: () => number = Date.now, readonly sleep: (ms: number) => Promise<void> = realSleep) {}

  /** Waits until a request of weight `w` keeps the last 60 s within the budget, and records it. */
  async take(w: number): Promise<void> {
    let t = Math.max(this.now(), this.last + this.gapMs);
    for (;;) {
      this.sent = this.sent.filter((e) => e.t > t - 60_000);
      const used = this.sent.reduce((s, e) => s + e.w, 0);
      if (this.sent.length === 0 || used + w <= this.budgetPerMin) break;
      t = this.sent[0].t + 60_000;
    }
    const d = t - this.now();
    if (d > 0) await this.sleep(d);
    this.last = t;
    this.sent.push({ t, w });
  }
}

/** Binance's declared weight budget per minute: under the repo's 2,000 ceiling (src/lib/venue-budget-registry.ts) and Binance's 2,400. */
export const BINANCE_WEIGHT_BUDGET = 1500;
/** The gap between two requests to one venue, under each venue's public request limit. */
export const PACE_MS: Readonly<Record<Venue, number>> = Object.freeze({ BINANCE: 120, BYBIT: 120, OKX: 120, BITGET: 80 });
export const pacerOf = (v: Venue, now?: () => number, sleep?: (ms: number) => Promise<void>): Pacer =>
  new Pacer(PACE_MS[v], v === 'BINANCE' ? BINANCE_WEIGHT_BUDGET : Infinity, now, sleep);

export type Send = (v: Venue, url: string) => Promise<Reply>;

/**
 * The pages of one coin × timeframe, paced, each tried three times. A rate limit throws `RateLimitedError` at once
 * (never retried); three transient failures throw `UnreachedError`; three error answers throw the venue's error;
 * a `RefusedError` from `send` is a rule of the read and passes straight through.
 */
export async function pagedFetch(v: Venue, coin: string, tf: Tf, startMs: number, endMs: number, send: Send, pacer: Pacer): Promise<Candle[]> {
  const out = new Map<number, Candle>();
  for (const p of pagesOf(v, coin, tf, startMs, endMs)) {
    let rows: Array<Array<string | number>> | null = null, last: Verdict | null = null;
    for (let attempt = 0; attempt < 3 && rows === null; attempt++) {
      if (attempt > 0) await pacer.sleep(1000 * attempt);
      await pacer.take(p.weight);
      let r: Verdict;
      try { r = classify(v, await send(v, p.url)); } catch (e) { if (e instanceof RefusedError) throw e; r = { kind: 'transient', why: (e as Error).message }; }
      if (r.kind === 'rows') rows = r.rows;
      else if (r.kind === 'rate') throw new RateLimitedError(v, pacer.now() + r.retryAfterMs, `${v} ${r.why}: no request to it before ${iso(pacer.now() + r.retryAfterMs)}`);
      else last = r;
    }
    if (rows === null) {
      if (last?.kind === 'transient') throw new UnreachedError(v, `${v} unreached after three tries: ${last.why}`);
      throw new Error(last?.why ?? `${v}: no reply`);
    }
    for (const c of candlesOf(rows, p.from, p.to)) if (!out.has(c.time)) out.set(c.time, c);
  }
  return [...out.values()].sort((a, b) => a.time - b.time);
}

/**
 * Why the network may not be asked now (lesson 10: the module's own network path refuses on its own, whoever calls
 * it): before not_before by the real clock, and once the read's seal exists in its fixed home — every bar is
 * fetched before the seal (CH3 F16). No lever disables either.
 */
export function networkRefusal(nowMs = Date.now(), sealed = (): boolean => entryExists(path.join(forwardHome(), SEAL))): string | null {
  if (nowMs < NOT_BEFORE_MS) return `no venue is asked before not_before ${iso(NOT_BEFORE_MS)}`;
  if (sealed()) return 'no venue is asked once the read is sealed: every bar is fetched before the seal';
  return null;
}

/** The one request that reaches a venue: `networkRefusal` first, every time; a 20 s bound on the reply. */
async function realSend(_v: Venue, url: string): Promise<Reply> {
  const why = networkRefusal();
  if (why) throw new RefusedError(why);
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 20_000);
  try {
    const res = await fetch(url, { signal: ac.signal });
    return { status: res.status, retryAfter: res.headers.get('retry-after'), text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

const NETWORK_DOOR: unique symbol = Symbol('regime-forward network source');

/** The network source. It takes nothing injected (CH3 F2): the venues, paced per venue, behind `networkRefusal`. */
export function restSource(): BarSource {
  const pacers = new Map<Venue, Pacer>();
  const src: BarSource = (v, coin, tf, startMs, endMs) => {
    if (!pacers.has(v)) pacers.set(v, pacerOf(v));
    return pagedFetch(v, coin, tf, startMs, endMs, realSend, pacers.get(v) as Pacer);
  };
  return Object.assign(src, { [NETWORK_DOOR]: true });
}

/** True for a source `restSource()` made: a test seam refuses it, so no seam reaches a venue (re-check R3). */
export const isNetworkSource = (s: BarSource): boolean => (s as BarSource & { [NETWORK_DOOR]?: boolean })[NETWORK_DOOR] === true;

export interface BarsRead { bars: Bars; misaligned: number; open: number; bad: number }

/**
 * T3's `Bars` on the venue grid (origin 2026-11-01 at its daily boundary): bar k opens at origin + k·I, for k below
 * key A's span end (`spanOf(v, tf).nb`). A bar is full (`cnt[k] = tf.min`) when it is aligned, inside that range,
 * closed by `nowMs`, and its four prices are positive and finite.
 */
export function barsOf(candles: readonly Candle[], v: Venue, tf: Tf, nowMs: number): BarsRead {
  const I = tfMs(tf), o = originMs(v), nb = spanOf(v, tf).nb;
  const f = (): Float64Array => new Float64Array(nb).fill(NaN);
  const bars: Bars = { min: tf.min, nb, O: f(), H: f(), L: f(), C: f(), V: new Float64Array(nb), cnt: new Int32Array(nb) };
  let misaligned = 0, open = 0, bad = 0;
  for (const c of candles) {
    const k = (c.time - o) / I;
    if (!Number.isInteger(k) || k < 0 || k >= nb) { misaligned++; continue; }
    if (c.time + I > nowMs) { open++; continue; }
    if (![c.open, c.high, c.low, c.close].every((x) => Number.isFinite(x) && x > 0)) { bad++; continue; }
    if (bars.cnt[k]) continue;
    bars.O[k] = c.open; bars.H[k] = c.high; bars.L[k] = c.low; bars.C[k] = c.close; bars.V[k] = Number.isFinite(c.volume) ? c.volume : 0; bars.cnt[k] = tf.min;
  }
  return { bars, misaligned, open, bad };
}

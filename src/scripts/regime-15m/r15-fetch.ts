// regime-15m/r15-fetch.ts — EDGE-REGIME-15M-BACKTEST-W1, item 6 (PROCEDURE §4e): the check venues' bars, fetched.
//
// Each check venue's public historical kline endpoint (Bybit v5 kline, OKX history-candles, Bitget history-candles),
// at the resolution R0 registered for it, over the study window, for every census panel coin the venue lists. Run
// once, before the registration lands, into the study's home; the manifest's sha256 is then pinned by the
// registration and the read checks every byte against it. The fetch refuses once the read's seal exists and never
// writes over a manifest that exists. The read never imports this file: its closure holds no network code.
// No coin is named in this file: the panel comes from the census at run time.
//
//   npx tsx src/scripts/regime-15m/r15-fetch.ts --census <regime-census-2026-11-16.json>
//
// prints `REGIME_15M_CHECK_FETCH=DONE manifest=<path> sha256=<sha256>` (exit 0), or `REGIME_15M_CHECK_FETCH=REFUSED`
// with its reason (exit 1), or `REGIME_15M_CHECK_FETCH=INDETERMINATE` when it threw (exit 3).
import fs from 'node:fs';
import path from 'node:path';
import { MIN_MS } from '../regime-diag/diag-spec.js';
import { CENSUS_SHA256, CHECK_MANIFEST, CHECK_PACE_MS, CHECK_PAGE_MAX, CHECK_RESOLUTION_MIN, CHECK_VENUES, STUDY_SPAN, WAVE, WINDOW_END_MS, type CheckVenue } from './r15-spec.js';
import { parseCensus } from '../regime-diag/frame.js';
import { checkDirOf, homeOf, sealed, sha256, type CheckManifest, type CoinRecord, type VenueRecord } from './r15-venues.js';

const iso = (t: number): string => new Date(t).toISOString();
const DAY_MS = 86_400_000;

// ── the requests ────────────────────────────────────────────────────────────────────────────────────────────

/** The instrument of a coin on a venue: the form the repository's adapters build for a crypto coin. */
export const venueSymbol = (v: CheckVenue, coin: string): string => (v === 'OKX' ? `${coin}-USDT-SWAP` : `${coin}USDT`);
const INTERVAL: Readonly<Record<CheckVenue, Readonly<Record<number, string>>>> = Object.freeze({
  BYBIT: { 1: '1', 3: '3', 5: '5', 15: '15', 1440: 'D' },
  OKX: { 1: '1m', 3: '3m', 5: '5m', 15: '15m', 1440: '1Dutc' },
  BITGET: { 1: '1m', 3: '3m', 5: '5m', 15: '15m', 1440: '1Dutc' },
});
/** Bitget answers a history-candles range longer than 90 days with an error (R0); a daily page stays inside it. */
const BITGET_MAX_RANGE_MS = 90 * DAY_MS;

/** One request: the bars of `minutes` that OPEN in [from, to], `limit` at most. */
export function klineUrl(v: CheckVenue, coin: string, minutes: number, from: number, to: number, limit: number): string {
  const iv = INTERVAL[v][minutes], I = minutes * MIN_MS, s = venueSymbol(v, coin);
  if (iv === undefined) throw new Error(`regime-15m: ${v} has no ${minutes}-minute interval in this study`);
  switch (v) {
    case 'BYBIT': return `https://api.bybit.com/v5/market/kline?category=linear&symbol=${s}&interval=${iv}&start=${from}&end=${to}&limit=${limit}`;
    // `after` asks for bars older than the ts, `before` for newer: the bars opening in [from, to]
    case 'OKX': return `https://www.okx.com/api/v5/market/history-candles?instId=${s}&bar=${iv}&after=${to + 1}&before=${from - 1}&limit=${limit}`;
    // history-candles filters on the bar's close, so the range is shifted one bar later (regime-forward CH1, re-measured in R0)
    case 'BITGET': return `https://api.bitget.com/api/v2/mix/market/history-candles?symbol=${s}&productType=USDT-FUTURES&granularity=${iv}&startTime=${from + I}&endTime=${to + I}&limit=${limit}`;
  }
}

export interface Page { from: number; to: number; limit: number; url: string }
/** The pages that cover the opens [startMs, endMs): at most `max` bars each, each asking exactly its bars. */
export function pagesOf(v: CheckVenue, coin: string, minutes: number, startMs: number, endMs: number, max: number = CHECK_PAGE_MAX[v]): Page[] {
  const I = minutes * MIN_MS, out: Page[] = [];
  if (startMs % I !== 0) throw new Error(`regime-15m: a page starts on a ${minutes}-minute boundary, not at ${iso(startMs)}`);
  for (let from = startMs; from < endMs; from += max * I) {
    const to = Math.min(endMs, from + max * I) - 1, limit = Math.ceil((to + 1 - from) / I);
    out.push({ from, to, limit, url: klineUrl(v, coin, minutes, from, to, limit) });
  }
  return out;
}

/** A venue's reply as the network gave it. */
export interface Reply { status: number; retryAfter: string | null; text: string }
export type Row = [string, string, string, string, string, string];
export type Verdict = { kind: 'rows'; rows: Row[] } | { kind: 'rate'; why: string; retryAfterMs: number | null } | { kind: 'transient'; why: string } | { kind: 'error'; why: string; code: string };

/** Rate-limit answers: the HTTP statuses and the body codes each venue sends when throttling. */
const RATE_STATUS = [403, 418, 429];
const RATE_CODES: Readonly<Record<CheckVenue, readonly string[]>> = Object.freeze({ BYBIT: ['10006', '10018'], OKX: ['50011', '50061'], BITGET: ['429', '45001', '40725', '40808'] });

/** What a reply is: rows (as the venue's own strings), a throttle, a transient failure, or the venue's error answer. */
export function classify(v: CheckVenue, r: Reply): Verdict {
  let body: { retCode?: unknown; code?: unknown; msg?: unknown; result?: { list?: unknown }; data?: unknown } | null = null;
  try { body = JSON.parse(r.text); } catch { /* not JSON */ }
  const code = body ? String(v === 'BYBIT' ? body.retCode : body.code) : '';
  const retryAfterMs = r.retryAfter !== null && /^\d+$/.test(r.retryAfter.trim()) ? Number(r.retryAfter.trim()) * 1000 : null;
  if (RATE_STATUS.includes(r.status) || RATE_CODES[v].includes(code)) return { kind: 'rate', why: `HTTP ${r.status}, code ${code || 'none'}`, retryAfterMs };
  if (!body) return { kind: 'transient', why: `HTTP ${r.status}: the reply is not JSON` };
  if (r.status >= 500) return { kind: 'transient', why: `HTTP ${r.status}` };
  const ok = v === 'BYBIT' ? code === '0' : code === '0' || code === '00000';
  const list = v === 'BYBIT' ? body.result?.list : body.data;
  if (!ok || !Array.isArray(list)) return { kind: 'error', why: `HTTP ${r.status}: ${r.text.slice(0, 160)}`, code };
  const rows: Row[] = [];
  for (const x of list) {
    if (!Array.isArray(x) || x.length < 6) return { kind: 'error', why: `a row that is not [open, o, h, l, c, v]: ${JSON.stringify(x).slice(0, 80)}`, code };
    rows.push([String(x[0]), String(x[1]), String(x[2]), String(x[3]), String(x[4]), String(x[5])]);
  }
  return { kind: 'rows', rows };
}

export type Send = (url: string) => Promise<Reply>;
export type Sleep = (ms: number) => Promise<void>;
/** The venue's own error answer (never retried), with its body code. */
export class VenueAnswerError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}
/** The body codes with which a venue answers that an instrument does not exist (R0: OKX 51001, Bitget 40034; Bybit 10001). */
export const NOT_LISTED_CODES: Readonly<Record<CheckVenue, readonly string[]>> = Object.freeze({ BYBIT: ['10001'], OKX: ['51001'], BITGET: ['40034'] });

/** One venue's pace: a minimum gap between two requests' starts. Pure over its clock. */
export class Pacer {
  private last = -Infinity;
  constructor(readonly gapMs: number, readonly now: () => number, readonly sleep: Sleep) {}
  async take(): Promise<void> {
    const t = Math.max(this.now(), this.last + this.gapMs), d = t - this.now();
    if (d > 0) await this.sleep(d);
    this.last = t;
  }
}

export interface Tally { requests: number; throttled: number; transient: number }

/**
 * The rows of one page. A throttle waits (its Retry-After, else 5 s doubling to 60 s) and asks again, up to 30
 * times; a transient failure is tried 5 times; the venue's error answer throws `VenueAnswerError` at once.
 */
export async function getPage(v: CheckVenue, p: Page, send: Send, pacer: Pacer, tally: Tally): Promise<Row[]> {
  let transient = 0, throttled = 0, wait = 5_000;
  for (;;) {
    await pacer.take();
    tally.requests++;
    let r: Verdict;
    try { r = classify(v, await send(p.url)); } catch (e) { r = { kind: 'transient', why: (e as Error).message }; }
    if (r.kind === 'rows') return r.rows.filter((row) => Number(row[0]) >= p.from && Number(row[0]) <= p.to);
    if (r.kind === 'error') throw new VenueAnswerError(`${v}: ${r.why}`, r.code);
    if (r.kind === 'rate') {
      tally.throttled++;
      if (++throttled > 30) throw new Error(`${v}: throttled 30 times on one page: ${r.why}`);
      await pacer.sleep(r.retryAfterMs ?? wait);
      wait = Math.min(60_000, wait * 2);
      continue;
    }
    tally.transient++;
    if (++transient >= 5) throw new Error(`${v}: unreached after 5 tries: ${r.why}`);
    await pacer.sleep(1_000 * transient);
  }
}

/** The first UTC day inside the window on which the venue has a daily bar; null when it has none in the window. */
export async function firstDayOf(v: CheckVenue, coin: string, send: Send, pacer: Pacer, tally: Tally): Promise<number | null> {
  const step = v === 'BITGET' ? BITGET_MAX_RANGE_MS : v === 'OKX' ? 100 * DAY_MS : 200 * DAY_MS;
  for (let a = STUDY_SPAN.t0Ms; a < WINDOW_END_MS; a += step) {
    const z = Math.min(WINDOW_END_MS, a + step), limit = Math.round((z - a) / DAY_MS);
    const rows = await getPage(v, { from: a, to: z - 1, limit, url: klineUrl(v, coin, 1440, a, z - 1, limit) }, send, pacer, tally);
    if (rows.length) return Math.min(...rows.map((r) => Number(r[0])));
  }
  return null;
}

/** The bars of one coin at `minutes` from `startMs` to the window's end, deduplicated by open, in time order, as CSV text. */
export async function fetchCoin(v: CheckVenue, coin: string, minutes: number, startMs: number, send: Send, pacer: Pacer, tally: Tally): Promise<{ text: string; rows: number; first: number | null; last: number | null }> {
  const byOpen = new Map<number, Row>();
  for (const p of pagesOf(v, coin, minutes, startMs, WINDOW_END_MS)) for (const r of await getPage(v, p, send, pacer, tally)) if (!byOpen.has(Number(r[0]))) byOpen.set(Number(r[0]), r);
  const opens = [...byOpen.keys()].sort((a, b) => a - b);
  const text = `open_time,open,high,low,close,volume\n${opens.map((t) => (byOpen.get(t) as Row).join(',')).join('\n')}${opens.length ? '\n' : ''}`;
  return { text, rows: opens.length, first: opens.length ? opens[0] : null, last: opens.length ? opens[opens.length - 1] : null };
}

export interface FetchInput {
  panel: readonly string[]; censusSha256: string;
  /** The study's home; the store is its `check/` directory. */
  home: string;
  send: Send; now: () => number; sleep: Sleep;
  log?: (line: string) => void;
}

/** Why the fetch may not run, or null: never after the seal, never over a manifest that exists. */
export function fetchRefusal(home: string): string | null {
  if (sealed(home)) return 'the read has claimed its seal: no venue is asked after it';
  if (fs.lstatSync(path.join(checkDirOf(home), CHECK_MANIFEST), { throwIfNoEntry: false })) return `${CHECK_MANIFEST} exists: the registered bars are never fetched over`;
  return null;
}

/** One venue: every panel coin, in panel order. A file is written under a temporary name and renamed into place. */
async function fetchVenue(v: CheckVenue, x: FetchInput): Promise<VenueRecord> {
  const R = CHECK_RESOLUTION_MIN[v], dir = path.join(checkDirOf(x.home), v), t0 = x.now();
  fs.mkdirSync(dir, { recursive: true });
  const pacer = new Pacer(CHECK_PACE_MS[v], x.now, x.sleep), tally: Tally = { requests: 0, throttled: 0, transient: 0 };
  const coins: CoinRecord[] = [];
  for (const [i, coin] of x.panel.entries()) {
    let first: number | null;
    try { first = await firstDayOf(v, coin, x.send, pacer, tally); } catch (e) {
      if (!(e instanceof VenueAnswerError) || !NOT_LISTED_CODES[v].includes(e.code)) throw e;
      coins.push({ coin, position: i + 1, status: 'not_listed', answer: e.message.slice(0, 200) });
      x.log?.(`${v} P${i + 1}: not listed`);
      continue;
    }
    if (first === null) { coins.push({ coin, position: i + 1, status: 'no_bars_in_window' }); x.log?.(`${v} P${i + 1}: no bars in the window`); continue; }
    const got = await fetchCoin(v, coin, R, Math.max(STUDY_SPAN.t0Ms, first), x.send, pacer, tally);
    if (got.rows === 0) { coins.push({ coin, position: i + 1, status: 'no_bars_in_window' }); continue; }
    const name = `${coin}-${R}m.csv`, file = path.join(dir, name);
    fs.writeFileSync(`${file}.part`, got.text);
    fs.renameSync(`${file}.part`, file);
    coins.push({ coin, position: i + 1, status: 'bars', first: iso(got.first as number), last: iso(got.last as number), rows: got.rows, file: `${v}/${name}`, bytes: Buffer.byteLength(got.text), sha256: sha256(got.text) });
    x.log?.(`${v} P${i + 1}: ${got.rows} bars, ${tally.requests} requests so far`);
  }
  const t1 = x.now();
  return { venue: v, resolution_min: R, pace_ms: CHECK_PACE_MS[v], page_max: CHECK_PAGE_MAX[v], coins, ...tally, started_at: iso(t0), finished_at: iso(t1), seconds: Math.round((t1 - t0) / 1000) };
}

/** The whole fetch: the three venues side by side (three hosts), each paced on its own. Writes the manifest last. */
export async function fetchCheck(x: FetchInput): Promise<{ manifest: string; sha256: string }> {
  const why = fetchRefusal(x.home);
  if (why) throw new Error(`regime-15m: ${why}`);
  // every venue runs to its end before anything is decided: a failed venue leaves no loop running behind the throw
  const settled = await Promise.allSettled(CHECK_VENUES.map((v) => fetchVenue(v, x)));
  const failed = settled.flatMap((r, i) => (r.status === 'rejected' ? [`${CHECK_VENUES[i]}: ${(r.reason as Error)?.message ?? String(r.reason)}`] : []));
  if (failed.length) throw new Error(`regime-15m: the fetch failed and wrote no manifest — ${failed.join('; ')}`);
  const venues = settled.map((r) => (r as PromiseFulfilledResult<VenueRecord>).value);
  const fetcher = fs.readFileSync(path.resolve(__dirname, '../../..', 'src/scripts/regime-15m/r15-fetch.ts'));
  const m: CheckManifest = { wave: WAVE, window: { from: iso(STUDY_SPAN.t0Ms), to: iso(WINDOW_END_MS) }, census_sha256: x.censusSha256, fetcher_sha256: sha256(fetcher), venues };
  const text = `${JSON.stringify(m, null, 1)}\n`, file = path.join(checkDirOf(x.home), CHECK_MANIFEST);
  if (fetchRefusal(x.home)) throw new Error('regime-15m: the seal or a manifest appeared while the fetch ran: nothing is written over it');
  fs.writeFileSync(file, text, { flag: 'wx' });
  return { manifest: file, sha256: sha256(text) };
}

/** The real network: one GET, a 20 s bound, a generic client. */
export const realSend: Send = async (url) => {
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 20_000);
  try {
    const res = await fetch(url, { signal: ac.signal });
    return { status: res.status, retryAfter: res.headers.get('retry-after'), text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
};

// ── the command ─────────────────────────────────────────────────────────────────────────────────────────────

const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main(argv: string[]): Promise<number> {
  const at = argv.indexOf('--census'), census = at >= 0 ? argv[at + 1] : undefined;
  if (!census || argv.length !== 2) { process.stdout.write('REGIME_15M_CHECK_FETCH=REFUSED usage: r15-fetch.ts --census <file>\n'); return 1; }
  const text = fs.readFileSync(census);
  if (sha256(text) !== CENSUS_SHA256) { process.stdout.write('REGIME_15M_CHECK_FETCH=REFUSED the census is not the registered one\n'); return 1; }
  const home = homeOf(), why = fetchRefusal(home);
  if (why) { process.stdout.write(`REGIME_15M_CHECK_FETCH=REFUSED ${why}\n`); return 1; }
  const { panel } = parseCensus(text.toString('utf8'));
  const r = await fetchCheck({ panel, censusSha256: CENSUS_SHA256, home, send: realSend, now: Date.now, sleep: realSleep, log: (l) => process.stderr.write(`${iso(Date.now())} ${l}\n`) });
  process.stdout.write(`REGIME_15M_CHECK_FETCH=DONE manifest=${r.manifest} sha256=${r.sha256}\n`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.stdout.write('REGIME_15M_CHECK_FETCH=INDETERMINATE the fetch threw\n');
    process.exitCode = 3;
  });
}

/**
 * book-liveness-probe.ts — OPS-BOOK-LIVENESS-W2 CH1 (ARC-BOOK-LIVENESS-ALERT-TRUTH T2 + T3). The
 * book-liveness canary's window onto the app's own adapters and the emit gate's own predicate.
 *
 *   node dist/scripts/book-liveness-probe.js --sentinels
 *   node dist/scripts/book-liveness-probe.js --rows '<VENUE|COIN|TF|entryEpochSec|signalId> …'
 *
 * WHY. The canary used to page on a suppression COUNT pinned at 3 x a September maximum, and on a
 * frozen-row RATE. Both paged on the gate's correct work: 10 of 10 breach books were equities the venue
 * had paused or thinned (OPS-BOOK-LIVENESS-W1, 19 of 19 decisions CORRECT_SUPPRESSION), and 30 of 30
 * frozen rows were books that read live at entry and closed afterwards. Two questions replace them, and
 * both are answered HERE, from inside the app container, with the code the gate itself runs:
 *
 *  * --sentinels — is a venue's adapter blind? One known-live book per active venue (BTC when the venue's
 *    universe lists it, else the highest-volume admitted book of that same fetch, else BTC and the output
 *    says the universe was unreadable), 24 x 1 h through the adapter's SERVING read — the read shape
 *    `get_trade_call` makes before `assessBookLiveness` — judged by the shipped predicate. A sentinel read
 *    FROZEN is the parse-defect detector the floor used to be: a volume the adapter mis-parses as 0, null or
 *    an unparseable string fails `Number(volume) > 0` on EVERY bar, which no live BTC book does.
 *    `LIVE` · `FROZEN` · `UNREADABLE` (fewer than BOOK_LIVENESS_WINDOW bars, or a read refused after one
 *    retry). A short read is never live: the predicate fails OPEN below its window, so this script refuses
 *    to hand it one.
 *  * --rows — should the gate have withheld this emitted call? For each row, the bars strictly before entry
 *    at its own timeframe, last BOOK_LIVENESS_WINDOW, exactly as `frozen-window-attribution.ts` sets
 *    `wouldSuppress` (null below BOOK_LIVENESS_MIN_GENUINE_BARS bars). `GATE_MISS` (would suppress),
 *    `FROZE_AFTER` (the book was live at entry), `UNVERIFIABLE` (too few bars, or a read refused after one
 *    retry) — each with its reason. Bars are taken as the adapter serves that timeframe, never normalised:
 *    the live gate sees the same bars.
 *
 * The venue set is DERIVED: every ExchangeId whose `ADMISSION_SOURCES[v].kind` is not `retired`. A new
 * venue is a sentinel the day its declaration lands; a retired one leaves by the same edit.
 *
 * Prints ONE JSON line, then `BOOK_LIVENESS_PROBE_EMIT=PASS` (exit 0). Bad arguments, or any unexpected
 * throw, print `BOOK_LIVENESS_PROBE_EMIT=INDETERMINATE` and NO JSON (exit 3, the token-law default for a new
 * gate). Read-only: no database, no writes. Every upstream call runs under the BATCH weight class — this is
 * background monitoring and must never take an interactive caller's budget.
 */
import { fetchVenueUniverse } from '../lib/exchange-universe.js';
import { getAdapter } from '../lib/exchange-adapter.js';
import { ADMISSION_SOURCES } from '../lib/universe-admission.js';
import { assessBookLiveness, BOOK_LIVENESS_MIN_GENUINE_BARS, BOOK_LIVENESS_WINDOW } from '../lib/book-liveness.js';
import { TF_MS } from '../lib/pfe-mae.js';
import { runAsBatch } from '../lib/upstream-weight-budget.js';
import { runScript } from '../lib/script-lifecycle.js';
import type { Candle, ExchangeId } from '../types.js';

export const VERDICT_TOKEN = 'BOOK_LIVENESS_PROBE_EMIT';
export const SENTINEL_COIN = 'BTC';
export const SENTINEL_TIMEFRAME = '1h';
const BAR_MS = 3_600_000;
/** One history range per (venue, coin, timeframe) is read forward in pages; this bounds a runaway venue. */
const MAX_PAGES_PER_RANGE = 60;
const REASON_CHARS = 200;

export type SentinelState = 'LIVE' | 'FROZEN' | 'UNREADABLE';
export type BookSource = 'universe_btc' | 'universe_top_volume' | 'fallback_btc';
export type RowVerdict = 'GATE_MISS' | 'FROZE_AFTER' | 'UNVERIFIABLE';

/** The seams, injectable so the CLI is a pure function of argv + deps. */
export interface ProbeDeps {
  nowMs: () => number;
  /** The scan's own universe fetch: the ADMITTED rows. Throws when the venue cannot be read. */
  fetchVenueUniverse: (venue: ExchangeId) => Promise<ReadonlyArray<{ coin: string; volume24h_usd: number }>>;
  /** A serving read (no end time) — the shape the emit gate reads before it judges a book. */
  servingBars: (venue: ExchangeId, coin: string, timeframe: string, startMs: number) => Promise<ReadonlyArray<Candle>>;
  /** A history read of [startMs, endMs] — the shape `frozen-window-attribution.ts` replays a row with. */
  historyBars: (venue: ExchangeId, coin: string, timeframe: string, startMs: number, endMs: number) => Promise<ReadonlyArray<Candle>>;
}

export interface SentinelLine {
  venue: ExchangeId;
  state: SentinelState;
  coin: string;
  book_source: BookSource;
  bars: number;
  genuine_bars: number | null;
  reason: string;
}

export interface ProbeRow { venue: ExchangeId; coin: string; timeframe: string; entrySec: number; signalId: number }

export interface RowLine {
  signal_id: number;
  venue: ExchangeId;
  coin: string;
  timeframe: string;
  entry: string;
  verdict: RowVerdict;
  pre_bars: number;
  genuine_bars: number | null;
  reason: string;
}

type Args = { mode: 'sentinels' } | { mode: 'rows'; rows: ProbeRow[] };

function isVenue(v: string): v is ExchangeId {
  return Object.prototype.hasOwnProperty.call(ADMISSION_SOURCES, v);
}

/** Every venue the probe reads, in a stable order: each ExchangeId not declared `retired`. */
export function activeVenues(): ExchangeId[] {
  return (Object.keys(ADMISSION_SOURCES) as ExchangeId[]).filter((v) => ADMISSION_SOURCES[v].kind !== 'retired').sort();
}

/** The venues the derivation excludes, reported beside the sentinels so the exclusion is visible. */
export function retiredVenues(): ExchangeId[] {
  return (Object.keys(ADMISSION_SOURCES) as ExchangeId[]).filter((v) => ADMISSION_SOURCES[v].kind === 'retired').sort();
}

function why(e: unknown): string {
  const s = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim();
  return s.length > REASON_CHARS ? `${s.slice(0, REASON_CHARS - 1)}…` : s;
}

/** One retry, then the second error stands. A refusal is a fact about the read, never about the book. */
async function withOneRetry<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch {
    return read();
  }
}

// One row token: VENUE|COIN|TF|entryEpochSec|signalId. The coin admits every script, like admission-verdict's.
const ROW_RE = /^([A-Z][A-Z0-9]*)\|([\p{L}\p{M}\p{N}._:@-]+)\|([0-9]{1,2}[mhd])\|([0-9]{9,11})\|([1-9][0-9]{0,15})$/u;

/** `--rows` tokens → rows. null = malformed, empty, an unknown venue or timeframe, or a signal id twice. */
export function parseProbeRows(raw: string): ProbeRow[] | null {
  const tokens = raw.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  const out: ProbeRow[] = [];
  const ids = new Set<number>();
  for (const t of tokens) {
    const m = ROW_RE.exec(t);
    if (!m || !isVenue(m[1]) || !Object.prototype.hasOwnProperty.call(TF_MS, m[3])) return null;
    const signalId = Number(m[5]);
    if (!Number.isSafeInteger(signalId) || ids.has(signalId)) return null;
    ids.add(signalId);
    out.push({ venue: m[1], coin: m[2], timeframe: m[3], entrySec: Number(m[4]), signalId });
  }
  return out;
}

/** Exactly one of `--sentinels` or `--rows '<rows>'`, nothing else. null = usage error. */
export function parseProbeArgs(argv: readonly string[]): Args | null {
  if (argv.length === 1 && argv[0] === '--sentinels') return { mode: 'sentinels' };
  if (argv.length === 2 && argv[0] === '--rows') {
    const rows = parseProbeRows(argv[1]);
    return rows === null ? null : { mode: 'rows', rows };
  }
  return null;
}

/** Ascending, de-duplicated by open time, nothing after `nowMs`, the last BOOK_LIVENESS_WINDOW. */
function lastWindow(bars: ReadonlyArray<Candle>, nowMs: number): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const b of bars) if (Number.isFinite(b.time) && b.time <= nowMs) byTime.set(b.time, b);
  return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-BOOK_LIVENESS_WINDOW);
}

/** BTC when the universe lists it; else the highest-volume admitted book; else BTC, saying why. */
async function chooseBook(venue: ExchangeId, deps: ProbeDeps): Promise<{ coin: string; source: BookSource; note: string }> {
  let rows: ReadonlyArray<{ coin: string; volume24h_usd: number }>;
  try {
    rows = await deps.fetchVenueUniverse(venue);
  } catch (e) {
    return { coin: SENTINEL_COIN, source: 'fallback_btc', note: `universe unreadable (${why(e)}), so the book is BTC` };
  }
  if (rows.length === 0) {
    return { coin: SENTINEL_COIN, source: 'fallback_btc', note: 'universe unreadable (the fetch returned no rows), so the book is BTC' };
  }
  if (rows.some((r) => r.coin === SENTINEL_COIN)) return { coin: SENTINEL_COIN, source: 'universe_btc', note: 'the universe lists BTC' };
  let top: { coin: string; volume24h_usd: number } | null = null;
  for (const r of rows) {
    if (Number.isFinite(r.volume24h_usd) && (top === null || r.volume24h_usd > top.volume24h_usd)) top = r;
  }
  if (top === null) {
    return { coin: SENTINEL_COIN, source: 'fallback_btc', note: 'the universe lists no BTC and no row carries a finite volume, so the book is BTC' };
  }
  return { coin: top.coin, source: 'universe_top_volume', note: `the universe lists no BTC; the highest 24h volume of ${rows.length} admitted rows` };
}

async function sentinelFor(venue: ExchangeId, deps: ProbeDeps): Promise<SentinelLine> {
  const book = await chooseBook(venue, deps);
  const nowMs = deps.nowMs();
  // From one bar before the oldest of BOOK_LIVENESS_WINDOW bars ending with the forming one, so a venue whose
  // serving endpoint holds closed bars only still yields a full window.
  const startMs = Math.floor(nowMs / BAR_MS) * BAR_MS - BOOK_LIVENESS_WINDOW * BAR_MS;
  const base = { venue, coin: book.coin, book_source: book.source };
  let win: Candle[];
  try {
    win = lastWindow(await withOneRetry(() => deps.servingBars(venue, book.coin, SENTINEL_TIMEFRAME, startMs)), nowMs);
  } catch (e) {
    return { ...base, state: 'UNREADABLE', bars: 0, genuine_bars: null, reason: `read refused after one retry: ${why(e)}; ${book.note}` };
  }
  if (win.length < BOOK_LIVENESS_WINDOW) {
    return { ...base, state: 'UNREADABLE', bars: win.length, genuine_bars: null,
      reason: `short read: ${win.length} of ${BOOK_LIVENESS_WINDOW} bars (a short read is never live); ${book.note}` };
  }
  const a = assessBookLiveness(win);
  return { ...base, state: a.live ? 'LIVE' : 'FROZEN', bars: a.barsExamined, genuine_bars: a.genuineBars,
    reason: `${a.genuineBars} of ${a.barsExamined} bars traded (k=${BOOK_LIVENESS_MIN_GENUINE_BARS}); ${book.note}` };
}

/** Every active venue's sentinel. Venues are independent budgets, so they are read concurrently. */
export async function probeSentinels(deps: ProbeDeps): Promise<SentinelLine[]> {
  return Promise.all(activeVenues().map((v) => sentinelFor(v, deps)));
}

/**
 * One (venue, coin, timeframe) group: ONE forward range read covering every row's pre-entry window, paged
 * the way `frozen-window-attribution.ts` pages (no forward progress = the venue's horizon). A refusal ends
 * the range; rows whose entry the pages already reached are still judged, the rest are UNVERIFIABLE.
 */
async function judgeGroup(rows: ProbeRow[], deps: ProbeDeps): Promise<RowLine[]> {
  const { venue, coin, timeframe } = rows[0];
  const tfMs = TF_MS[timeframe];
  const entries = rows.map((r) => r.entrySec * 1000);
  const startMs = Math.min(...entries) - (BOOK_LIVENESS_WINDOW + 2) * tfMs;
  const endMs = Math.max(...entries);
  const cache = new Map<number, Candle>();
  let cursor = startMs;
  let pages = 0;
  let stop: string | null = null;
  for (;;) {
    if (cursor > endMs) break;
    if (pages >= MAX_PAGES_PER_RANGE) { stop = `the range needed more than ${MAX_PAGES_PER_RANGE} pages`; break; }
    pages++;
    let page: ReadonlyArray<Candle>;
    try {
      page = await withOneRetry(() => deps.historyBars(venue, coin, timeframe, cursor, endMs));
    } catch (e) {
      stop = `read refused after one retry: ${why(e)}`;
      break;
    }
    let maxTime = -Infinity;
    for (const c of page) {
      if (!Number.isFinite(c.time)) continue;
      cache.set(c.time, c);
      if (c.time > maxTime) maxTime = c.time;
    }
    if (!(maxTime >= cursor)) break; // empty page or no forward progress: the venue's horizon
    cursor = maxTime + 1;
  }
  // Everything before `cursor` has been read when the loop stopped early; a row whose pre-entry window lies
  // wholly before it is judged on complete bars.
  const judgeableToMs = stop === null ? Infinity : cursor;
  const asc = [...cache.values()].sort((a, b) => a.time - b.time);
  return rows.map((r): RowLine => {
    const entryMs = r.entrySec * 1000;
    const base = { signal_id: r.signalId, venue, coin, timeframe, entry: new Date(entryMs).toISOString() };
    if (entryMs > judgeableToMs) {
      return { ...base, verdict: 'UNVERIFIABLE', pre_bars: 0, genuine_bars: null, reason: stop ?? 'unread' };
    }
    const pre = asc.filter((c) => c.time < entryMs).slice(-BOOK_LIVENESS_WINDOW);
    // The SHIPPED predicate, never a copy. It fails OPEN below its window, so a short read is "cannot say",
    // exactly as frozen-window-attribution.ts sets wouldSuppress.
    const liveness = assessBookLiveness(pre);
    const wouldSuppress = pre.length < BOOK_LIVENESS_MIN_GENUINE_BARS ? null : !liveness.live;
    if (wouldSuppress === null) {
      return { ...base, verdict: 'UNVERIFIABLE', pre_bars: pre.length, genuine_bars: null,
        reason: `${pre.length} bar(s) before entry, fewer than k=${BOOK_LIVENESS_MIN_GENUINE_BARS}` };
    }
    return {
      ...base,
      verdict: wouldSuppress ? 'GATE_MISS' : 'FROZE_AFTER',
      pre_bars: pre.length,
      genuine_bars: liveness.genuineBars,
      reason: wouldSuppress
        ? `the gate would have withheld it: ${liveness.genuineBars} of ${pre.length} bars before entry traded (k=${BOOK_LIVENESS_MIN_GENUINE_BARS})`
        : `pre-entry window live (${liveness.genuineBars}/${pre.length})`,
    };
  });
}

/** Every row's verdict, in input order. Groups on one venue run in turn; venues run concurrently. */
export async function probeRows(rows: ProbeRow[], deps: ProbeDeps): Promise<RowLine[]> {
  const groups = new Map<string, ProbeRow[]>();
  for (const r of rows) {
    const k = `${r.venue}|${r.coin}|${r.timeframe}`;
    const g = groups.get(k);
    if (g) g.push(r); else groups.set(k, [r]);
  }
  const byVenue = new Map<ExchangeId, ProbeRow[][]>();
  for (const g of groups.values()) {
    const list = byVenue.get(g[0].venue);
    if (list) list.push(g); else byVenue.set(g[0].venue, [g]);
  }
  const judged = new Map<number, RowLine>();
  await Promise.all([...byVenue.values()].map(async (venueGroups) => {
    for (const g of venueGroups) for (const line of await judgeGroup(g, deps)) judged.set(line.signal_id, line);
  }));
  return rows.map((r) => judged.get(r.signalId)!);
}

/** The CLI as a function of argv + deps: the lines to print and the exit code. */
export async function runBookLivenessProbe(argv: readonly string[], deps: ProbeDeps): Promise<{ lines: string[]; exitCode: number }> {
  const indeterminate = (reason: string) => ({ lines: [`[book-liveness-probe] ${reason}`, `${VERDICT_TOKEN}=INDETERMINATE`], exitCode: 3 });
  const args = parseProbeArgs(argv);
  if (args === null) {
    return indeterminate(`usage: --sentinels | --rows '<VENUE|COIN|TF|entryEpochSec|signalId> …' (got ${JSON.stringify(argv)})`);
  }
  try {
    const head = {
      generated_at: new Date(deps.nowMs()).toISOString(),
      mode: args.mode,
      predicate: { window: BOOK_LIVENESS_WINDOW, min_genuine_bars: BOOK_LIVENESS_MIN_GENUINE_BARS },
    };
    const doc = args.mode === 'sentinels'
      ? { ...head, timeframe: SENTINEL_TIMEFRAME, sentinels: await probeSentinels(deps), excluded_retired: retiredVenues() }
      : { ...head, rows: await probeRows(args.rows, deps) };
    return { lines: [JSON.stringify(doc), `${VERDICT_TOKEN}=PASS`], exitCode: 0 };
  } catch (e) {
    return indeterminate(`unexpected throw: ${why(e)}`);
  }
}

/** Production seams: the scan's own universe fetch and the venue adapters behind the getAdapter guards. */
const productionDeps: ProbeDeps = {
  nowMs: () => Date.now(),
  fetchVenueUniverse: (venue) => fetchVenueUniverse(venue),
  servingBars: (venue, coin, timeframe, startMs) => getAdapter(venue).getCandles(coin, timeframe, startMs),
  historyBars: (venue, coin, timeframe, startMs, endMs) => getAdapter(venue).getCandles(coin, timeframe, startMs, undefined, endMs),
};

if (require.main === module) {
  // runScript: drain-then-exit on every path (OPS-SCRIPT-EXIT-LIFECYCLE-W1), so the verdict token is flushed
  // before exit and can never be cut off the pipe the canary reads through `docker exec`.
  void runScript('book-liveness-probe', async () => {
    const r = await runAsBatch(() => runBookLivenessProbe(process.argv.slice(2), productionDeps), 'book-liveness-probe');
    for (const line of r.lines) console.log(line);
    return r.exitCode;
  });
}

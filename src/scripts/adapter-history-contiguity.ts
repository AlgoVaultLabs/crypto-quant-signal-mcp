/**
 * adapter-history-contiguity.ts — OPS-ADAPTER-HISTORY-ANCHOR-W1 CH3: the live adapter-history canary.
 *
 * The contract suite (tests/unit/adapter-history-contract.test.ts) guards the CODE on captured fixtures.
 * Only a live probe guards the VENUES: WEEX changed its served interval on 2026-09-03 with nothing watching.
 * This script asks every active promoted venue × faithful cron timeframe, THROUGH the adapters (metered by
 * _upstream-fetch.ts's budget, batch class, caller tag 'adapter-history-canary'; never a bare fetch), at
 * ≥ 1.2 s between calls, and judges each pair with the ONE page accounting (src/lib/adapters/_history-plan.ts):
 *
 *   R  the recent page of the last 2W served candles (no endTime, as serving asks). Its reach CLASS — front
 *      gap, holes, head gap beyond the forming allowance, off-grid bars, out-of-range bars, empty window — must
 *      equal the class pinned in tests/fixtures/adapter-history/REACH.json (OAH-Q10). Drift is FAIL.
 *   D  on the two venues with a history fallback (BITGET, OKX), one closed window beyond the recent reach:
 *      from = now − (RECENT_PAGE_CAP + 2W + 6)·s, to = from + 2W·s. It must be COMPLETE (C1) and the page must
 *      carry its meta (C3 reported, OAH-Q5). A missing meta or an incomplete window is FAIL.
 *
 *   S  (OPS-SERVED-CANDLE-TRUTH-W1 CH2) every serving window the product asks for (src/lib/serving-windows.ts
 *      `servingSpans`, the derivation contract-suite S reads) on every faithful timeframe of every active venue,
 *      read through the `getAdapter` seam with no endTime: from = now − span. The window must reach the venue's
 *      newest bar (head gap ≤ HEAD_ALLOWANCE_BARS). A window the seam REFUSES (StaleUpstreamWindowError) is the defect
 *      S exists for: FAIL, never INDETERMINATE. The S probes run after R/D in venue-INTERLEAVED order (one window per
 *      venue in turn), so a venue sees one request per ~venues × PACE_MS while the run keeps ≥ PACE_MS between calls.
 *      CH3a: its newest bar must also be the head the venue's class owes (src/lib/live-price.ts `formingHeadVerdict`,
 *      the judgement contract-suite S reads): the FORMING bar on a non-declared venue; on a declared ticker-priced
 *      venue (Cowork Q11 / Q13) forming − 1 exactly on a CLOSED_ONLY venue's liquid reference, and at most
 *      SNAPSHOT_KLINE_MAX_LAG_MS behind the forming bar on a SNAPSHOT_KLINE venue's. Closed-bar
 *      arithmetic cannot see a window one bar short at the head; this can, and it goes red the day a non-declared
 *      venue turns closed-only, or a CLOSED_ONLY one starts serving its forming bar. Every window also carries its
 *      head lag (`headLagSlots`, `headLagMs`: how far its head sits behind the owed one) as a metric.
 *
 *   Y  (CH3a, Cowork Q5) a YOUNG-listing reference per venue: the class BTC cannot show (a young Bitget listing was
 *      served from the closed-only history endpoint). Candidates are the venue's coins most recently first seen in our
 *      own signals (read-only, one GROUP BY); the first whose longest serving window starts more than
 *      YOUNG_FRONT_BARS before its first bar is the reference, and every faithful timeframe's longest window is read
 *      for it and judged as S, as a THIN reference: on a declared ticker-priced venue its head lag — the head gap and
 *      the forming check alike — is a metric, never a FAIL (Q13: a thin book's late bars move no price there), while an
 *      empty window or a CLOSED_ONLY venue serving its forming bar still FAILs. A venue with no young candidate is listed, not failed; no candidate on ANY venue, or an unreadable
 *      candidate query, is INDETERMINATE (the corpus this leg had to build is empty).
 *
 *   T  (CH3a, Cowork Q8 / Q11) every active declared ticker-priced venue's ticker: it must price a call by its kind's
 *      check (`tickerFreshness`). FAIL when it cannot: livePriceOf would refuse every call on that venue.
 *
 * UNSERVABLE pairs (UNSERVABLE.json) and retired venues are SKIPPED and listed. A venue that is unreachable,
 * rate-limits (418/429) or throws is INDETERMINATE for that pair — fail-open, counted, never a page. An R probe the
 * seam refuses reads INDETERMINATE the same way (judgePair is unchanged); S judges that staleness, as FAIL.
 * The expectations arrive on --expect <file|-> as {"reach": REACH.json.pairs, "unservable": UNSERVABLE.json.pairs},
 * read by the host wrapper from the deployed checkout's fixtures: ONE copy of the expectations, never a
 * second table in src.
 *
 * Output: one `[adapter-history] PAIR {json}` line per R/D pair, one `[adapter-history] SERVE {json}` line per S, Y
 * and T result (Y windows labelled `young:<COIN>@<window>`, T as timeframe `ticker`; the host wrapper streaks them per
 * venue × timeframe with S), one `RESULT_JSON=` summary, and exactly one terminal `ADAPTER_HISTORY_VERDICT=PASS|FAIL|INDETERMINATE`
 * (exit 0 / 1 / 3) over both. Callers gate on the TOKEN.
 * No labels, no postgres writes, no alerts (the host wrapper streaks and pages).
 */
import fs from 'node:fs';
import { getAdapter } from '../lib/exchange-adapter.js';
import { getActivePromotedVenueIds } from '../lib/venue-store.js';
import { PROMOTED_VENUE_IDS } from '../lib/capabilities.js';
import { CRON_TIMEFRAMES, faithfulTimeframes, isTimeframeFaithful, servedCandleStepMs } from '../lib/tf-support.js';
import { TIMEFRAMES } from '../lib/capabilities.js';
import { servingSpans } from '../lib/serving-windows.js';
import { StaleUpstreamWindowError } from '../lib/errors.js';
import { TF_MS } from '../lib/pfe-mae.js';
import { EVAL_CANDLES } from './directional-labeler.js';
import { accountPage, historyMetaOf, incompleteWindow, HEAD_ALLOWANCE_BARS, type PageFacts } from '../lib/adapters/_history-plan.js';
import { RECENT_PAGE_CAP as BITGET_RECENT_CAP } from '../lib/adapters/bitget.js';
import { RECENT_PAGE_CAP as OKX_RECENT_CAP } from '../lib/adapters/okx.js';
import { runAsBatch } from '../lib/upstream-weight-budget.js';
import { runScript } from '../lib/script-lifecycle.js';
import { dbQuery } from '../lib/performance-db.js';
import { formingHeadVerdict, headLag, isTickerPricedVenue, tickerFreshness, type HeadReference } from '../lib/live-price.js';
import type { ExchangeId } from '../types.js';

const TAG = '[adapter-history]';
const COIN = 'BTC';
/** A venue may publish a just-closed candle a moment late: one missing closed slot at the head is allowed. Owned by
 *  src/lib/adapters/_history-plan.ts (the serving assembler reads it too); re-exported for this script's tests
 *  (OPS-SERVED-CANDLE-TRUTH-W1 Q3c). */
export { HEAD_ALLOWANCE_BARS };
/** ≥ 1.2 s between calls (spec), so the whole probe stays a trickle against every venue budget. */
export const PACE_MS = 1_200;
/** The two venues whose getCandles has a history fallback (the deep probe exercises it). */
export const DEEP_PROBE_RECENT_CAP: Partial<Record<string, number>> = { BITGET: BITGET_RECENT_CAP, OKX: OKX_RECENT_CAP };

export type PairVerdict = 'PASS' | 'FAIL' | 'INDETERMINATE' | 'SKIPPED';

export interface ReachClass { front: boolean; holes: boolean; head: boolean; offGrid: boolean; outOfRange: boolean; empty: boolean }

/** The reach CLASS of a page: what must stay stable night over night (counts move with the clock, classes not). */
export function reachClass(f: Pick<PageFacts, 'frontGapBars' | 'gapSlots' | 'headGapBars' | 'offGridBars' | 'outOfRangeBars' | 'emptyWindow'>): ReachClass {
  return {
    front: (f.frontGapBars ?? 0) > 0,
    holes: f.gapSlots > 0,
    head: (f.headGapBars ?? 0) > HEAD_ALLOWANCE_BARS,
    offGrid: f.offGridBars > 0,
    outOfRange: f.outOfRangeBars > 0,
    empty: f.emptyWindow,
  };
}

export interface Expectations {
  reach: Record<string, Record<string, PageFacts>>;
  unservable: { pair: string; reason?: string }[];
}

export interface PairResult {
  venue: string;
  tf: string;
  servedStepMs: number | null;
  phaseMs: number | null;
  pageCap: number | null;
  gapSlots: number | null;
  headGapBars: number | null;
  frontGapBars: number | null;
  outOfRangeBars: number | null;
  substitutedNewest: number;
  deep: { complete: boolean; meta: boolean; substitutedNewest: boolean } | null;
  verdict: PairVerdict;
  reasons: string[];
}

/** Judge one pair from its measured pages (pure). */
export function judgePair(p: {
  venue: string;
  tf: string;
  expected: Expectations;
  recent: { facts: PageFacts; phaseMs: number | null } | { error: string };
  deep: { facts: PageFacts; meta: { complete?: boolean; substitutedNewest?: boolean } | undefined } | { error: string } | null;
  servedStepMs: number | null;
}): PairResult {
  const pair = `${p.venue}/${p.tf}`;
  const base: PairResult = {
    venue: p.venue, tf: p.tf, servedStepMs: p.servedStepMs, phaseMs: null, pageCap: DEEP_PROBE_RECENT_CAP[p.venue] ?? null,
    gapSlots: null, headGapBars: null, frontGapBars: null, outOfRangeBars: null, substitutedNewest: 0, deep: null,
    verdict: 'PASS', reasons: [],
  };
  if (p.expected.unservable.some((u) => u.pair === pair)) return { ...base, verdict: 'SKIPPED', reasons: ['UNSERVABLE'] };
  if ('error' in p.recent) return { ...base, verdict: 'INDETERMINATE', reasons: [`recent: ${p.recent.error}`] };
  const f = p.recent.facts;
  const out: PairResult = {
    ...base, phaseMs: p.recent.phaseMs, gapSlots: f.gapSlots, headGapBars: f.headGapBars, frontGapBars: f.frontGapBars,
    outOfRangeBars: f.outOfRangeBars,
  };
  const pinned = p.expected.reach[pair]?.R;
  if (!pinned) {
    out.verdict = 'FAIL';
    out.reasons.push('no pinned REACH class for this pair (a new or re-mapped pair: capture it first)');
  } else {
    const want = reachClass(pinned);
    const got = reachClass(f);
    for (const k of Object.keys(want) as (keyof ReachClass)[]) {
      if (want[k] !== got[k]) { out.verdict = 'FAIL'; out.reasons.push(`reach drift: ${k} ${want[k]} → ${got[k]}`); }
    }
  }
  if (p.deep) {
    if ('error' in p.deep) {
      if (out.verdict === 'PASS') out.verdict = 'INDETERMINATE';
      out.reasons.push(`deep: ${p.deep.error}`);
    } else {
      const d = p.deep.facts;
      const complete = !incompleteWindow(d);
      const meta = p.deep.meta;
      out.deep = { complete, meta: meta != null, substitutedNewest: meta?.substitutedNewest === true };
      if (meta?.substitutedNewest === true) out.substitutedNewest += 1;
      const pinnedD = p.expected.reach[pair]?.D;
      if (!pinnedD) {
        out.verdict = 'FAIL';
        out.reasons.push('no pinned REACH deep class for this pair');
      } else if (!complete && !incompleteWindow(pinnedD as PageFacts)) {
        out.verdict = 'FAIL';
        out.reasons.push('C1: the deep history window is incomplete (pinned complete)');
      } else {
        const want = reachClass(pinnedD);
        const got = reachClass(d);
        for (const k of Object.keys(want) as (keyof ReachClass)[]) {
          if (want[k] !== got[k]) { out.verdict = 'FAIL'; out.reasons.push(`deep reach drift: ${k} ${want[k]} → ${got[k]}`); }
        }
      }
      if (meta == null) { out.verdict = 'FAIL'; out.reasons.push('C3: the history page carries no meta'); }
      else if (typeof meta.complete === 'boolean' && meta.complete !== complete) {
        out.verdict = 'FAIL';
        out.reasons.push(`meta disagrees with the data: meta.complete=${meta.complete}, measured ${complete}`);
      }
    }
  }
  return out;
}

/** The aggregate token: any FAIL → FAIL; else any INDETERMINATE → INDETERMINATE; else PASS (SKIPPED neutral). R/D
 *  pairs and S windows alike. */
export function aggregate(results: readonly { verdict: PairVerdict }[]): 'PASS' | 'FAIL' | 'INDETERMINATE' {
  if (results.some((r) => r.verdict === 'FAIL')) return 'FAIL';
  if (results.some((r) => r.verdict === 'INDETERMINATE')) return 'INDETERMINATE';
  return 'PASS';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 200);

/** Probe every pair (I/O; injectable for tests). */
export async function probeAll(o: {
  venues: readonly string[];
  expected: Expectations;
  nowMs: () => number;
  getCandles: (venue: string, tf: string, from: number, to?: number) => Promise<{ time: number }[]>;
  served: (venue: string, tf: string) => number | null;
  timeframes: (venue: string) => readonly string[];
  pace?: (ms: number) => Promise<void>;
}): Promise<PairResult[]> {
  const pace = o.pace ?? sleep;
  const results: PairResult[] = [];
  let first = true;
  const call = async (venue: string, tf: string, from: number, to?: number) => {
    if (!first) await pace(PACE_MS);
    first = false;
    return o.getCandles(venue, tf, from, to);
  };
  for (const venue of o.venues) {
    for (const tf of o.timeframes(venue)) {
      const pair = `${venue}/${tf}`;
      const s = o.served(venue, tf);
      const W = EVAL_CANDLES[tf];
      if (o.expected.unservable.some((u) => u.pair === pair)) {
        results.push(judgePair({ venue, tf, expected: o.expected, recent: { error: 'unservable' }, deep: null, servedStepMs: s }));
        continue;
      }
      if (s == null || W == null) {
        results.push({ ...judgePair({ venue, tf, expected: o.expected, recent: { error: 'no served step / window' }, deep: null, servedStepMs: s }) });
        continue;
      }
      let recent: { facts: PageFacts; phaseMs: number | null } | { error: string };
      try {
        const now = o.nowMs();
        const from = now - (2 * W + 1) * s;
        const page = await call(venue, tf, from);
        const facts = accountPage({ bars: page.map((c) => ({ ts: c.time })), servedStepMs: s, from, to: null, nowMs: o.nowMs() });
        recent = { facts, phaseMs: page.length ? ((page[0].time % s) + s) % s : null };
      } catch (e) { recent = { error: errText(e) }; }
      let deep: { facts: PageFacts; meta: { complete?: boolean; substitutedNewest?: boolean } | undefined } | { error: string } | null = null;
      const cap = DEEP_PROBE_RECENT_CAP[venue];
      if (cap != null && !('error' in recent)) {
        try {
          const now = o.nowMs();
          const from = now - (cap + 2 * W + 6) * s;
          const to = from + 2 * W * s;
          const page = await call(venue, tf, from, to);
          const facts = accountPage({ bars: page.map((c) => ({ ts: c.time })), servedStepMs: s, from, to, nowMs: o.nowMs() });
          deep = { facts, meta: historyMetaOf(page as unknown[]) };
        } catch (e) { deep = { error: errText(e) }; }
      }
      results.push(judgePair({ venue, tf, expected: o.expected, recent, deep, servedStepMs: s }));
    }
  }
  return results;
}

// ── S: every serving window the product asks for (OPS-SERVED-CANDLE-TRUTH-W1 CH2) ─────────────────────────────────

export interface ServeWindow {
  venue: string; tf: string; window: string; spanMs: number; servedStepMs: number; coin: string;
  /** Which reference the head is judged on (formingHeadVerdict): S reads the liquid one (BTC), Y a young/thin one. */
  reference?: HeadReference;
}

export interface ServeResult extends ServeWindow {
  bars: number | null;
  headGapBars: number | null;
  /** The head lag metric (live-price.ts `headLag`): slots behind the head the venue's class owes, and how long before
   *  the call the newest served bar closed. Null when no bar was read. */
  headLagSlots: number | null;
  headLagMs: number | null;
  branch: string | null;
  verdict: Exclude<PairVerdict, 'SKIPPED'>;
  reasons: string[];
}

export type ServeRead =
  /** newestMs: the newest bar at or before answeredAtMs (null when none); the venue answered in [calledAtMs, answeredAtMs]. */
  | { facts: PageFacts; branch: string | null; newestMs: number | null; calledAtMs: number; answeredAtMs: number }
  | { refused: { headGapBars: number; newestBarAt: string } }
  | { error: string };

/** Judge one S window (pure). PASS when the served page reaches the venue's newest bar (head gap ≤
 *  HEAD_ALLOWANCE_BARS, the bound contract-suite S holds every venue to) AND that bar is a head the venue's class may
 *  serve on the window's reference (formingHeadVerdict, CH3a / Q11 / Q13). FAIL when it does not, when the window
 *  holds no bar, or when the `getAdapter` seam refused it as stale. INDETERMINATE only when the read could not be
 *  made. */
export function judgeServe(w: ServeWindow, read: ServeRead): ServeResult {
  const base: ServeResult = { ...w, bars: null, headGapBars: null, headLagSlots: null, headLagMs: null, branch: null, verdict: 'PASS', reasons: [] };
  if ('error' in read) return { ...base, verdict: 'INDETERMINATE', reasons: [read.error] };
  if ('refused' in read) {
    return {
      ...base, headGapBars: read.refused.headGapBars, verdict: 'FAIL',
      reasons: [`STALE_UPSTREAM_WINDOW: the getAdapter seam refused the window (head gap ${read.refused.headGapBars} bars, newest bar ${read.refused.newestBarAt})`],
    };
  }
  const f = read.facts;
  const out: ServeResult = { ...base, bars: f.inWindow, headGapBars: f.headGapBars, branch: read.branch };
  // Q13: on a declared ticker-priced venue a THIN reference's late bars move no price, so its head gap is the recorded
  // headGapBars / headLag metric, never a FAIL (PHEMEX AGPU, 2026-10-23: head gap 2). An empty window still FAILs.
  const lagIsMetric = w.reference === 'thin' && isTickerPricedVenue(w.venue);
  if (f.emptyWindow || f.headGapBars === null) { out.verdict = 'FAIL'; out.reasons.push('no bar in the window'); }
  else if (f.headGapBars > HEAD_ALLOWANCE_BARS && !lagIsMetric) {
    out.verdict = 'FAIL';
    out.reasons.push(`head gap ${f.headGapBars} bars > ${HEAD_ALLOWANCE_BARS}: the window does not reach the venue's newest bar`);
  }
  if (read.newestMs !== null) {
    const lag = headLag(read.newestMs, w.servedStepMs, read.calledAtMs, w.venue);
    out.headLagSlots = lag.slots;
    out.headLagMs = lag.ageMs;
    const why = formingHeadVerdict(
      read.newestMs, w.servedStepMs, read.calledAtMs, w.venue, Math.max(0, read.answeredAtMs - read.calledAtMs), w.reference ?? 'liquid',
    );
    if (why !== null) { out.verdict = 'FAIL'; out.reasons.push(`head: ${why}`); }
  }
  return out;
}

/** One serving read as S, Y and T judge it: no endTime, from = now − span, timed on both sides. */
async function readServe(
  getCandles: (venue: string, tf: string, from: number, coin: string) => Promise<{ time: number }[]>,
  nowMs: () => number,
  w: ServeWindow,
): Promise<ServeRead> {
  try {
    const calledAtMs = nowMs();
    const from = calledAtMs - w.spanMs;
    const page = await getCandles(w.venue, w.tf, from, w.coin);
    const answeredAtMs = nowMs();
    const facts = accountPage({ bars: page.map((c) => ({ ts: c.time })), servedStepMs: w.servedStepMs, from, to: null, nowMs: answeredAtMs });
    const past = page.map((c) => c.time).filter((t) => t <= answeredAtMs);
    return { facts, branch: historyMetaOf(page as unknown[])?.branch ?? null, newestMs: past.length ? Math.max(...past) : null, calledAtMs, answeredAtMs };
  } catch (e) {
    return e instanceof StaleUpstreamWindowError
      ? { refused: { headGapBars: e.headGapBars, newestBarAt: new Date(e.newestBarAt).toISOString() } }
      : { error: errText(e) };
  }
}

/** The S windows, venue-INTERLEAVED: the first window of every venue, then the second of every venue, and so on. */
export function servingProbePlan(
  venues: readonly string[],
  timeframes: (venue: string) => readonly string[],
  served: (venue: string, tf: string) => number | null,
): ServeWindow[] {
  const perVenue = venues.map((venue) => timeframes(venue).flatMap((tf) => {
    const s = served(venue, tf);
    if (s == null) return [];
    return servingSpans(tf, s, TF_MS[tf]).map((w) => ({ venue, tf, window: w.label, spanMs: w.spanMs, servedStepMs: s, coin: COIN }));
  }));
  const out: ServeWindow[] = [];
  for (let i = 0; perVenue.some((l) => i < l.length); i++) for (const l of perVenue) if (i < l.length) out.push(l[i]);
  return out;
}

/** Probe every S window (I/O; injectable for tests). Paces BEFORE every call, so the first S read also keeps
 *  PACE_MS from the last R/D read. */
export async function probeServing(o: {
  venues: readonly string[];
  nowMs: () => number;
  getCandles: (venue: string, tf: string, from: number, coin: string) => Promise<{ time: number }[]>;
  served: (venue: string, tf: string) => number | null;
  timeframes: (venue: string) => readonly string[];
  pace?: (ms: number) => Promise<void>;
}): Promise<ServeResult[]> {
  const pace = o.pace ?? sleep;
  const results: ServeResult[] = [];
  for (const w of servingProbePlan(o.venues, o.timeframes, o.served)) {
    await pace(PACE_MS);
    results.push(judgeServe(w, await readServe(o.getCandles, o.nowMs, w)));
  }
  return results;
}

// ── Y: a young-listing reference per venue (OPS-SERVED-CANDLE-TRUTH-W1 CH3a, Cowork Q5) ─────────────────────────────

/** A candidate is YOUNG when its longest serving window starts more than this many bars before its first bar. */
export const YOUNG_FRONT_BARS = 5;
/** Candidates screened per venue, most recently first seen first. */
export const YOUNG_CANDIDATES_PER_VENUE = 6;
/** Candidates are coins first seen in our signals within this many days. */
export const YOUNG_CANDIDATE_DAYS = 90;
/** Read-only; one pass over `signals` (measured 340 ms on 1.16 M rows, 2026-10-23). */
export const YOUNG_CANDIDATES_SQL =
  'SELECT exchange, coin, MIN(created_at) AS first_at FROM signals GROUP BY exchange, coin HAVING MIN(created_at) > $1 ORDER BY first_at DESC, coin';

export interface YoungOutcome {
  results: ServeResult[];
  /** venue → its young reference coin */
  refs: Record<string, string>;
  /** venues with a timeframe to judge but no young candidate */
  none: string[];
}

/** Each venue's longest serving window per faithful timeframe, longest first (the first one screens candidates). */
function longestWindows(venue: string, timeframes: readonly string[], served: (venue: string, tf: string) => number | null): Omit<ServeWindow, 'coin'>[] {
  return timeframes.flatMap((tf) => {
    const s = served(venue, tf);
    if (s == null) return [];
    const spans = servingSpans(tf, s, TF_MS[tf]);
    if (spans.length === 0) return [];
    const w = spans.reduce((a, b) => (b.spanMs > a.spanMs ? b : a));
    return [{ venue, tf, window: w.label, spanMs: w.spanMs, servedStepMs: s }];
  }).sort((a, b) => b.spanMs - a.spanMs);
}

/** Probe the young references (I/O; injectable). Venue-INTERLEAVED like S: one read per venue in turn, paced before
 *  every call. A screen read the seam REFUSES adopts that candidate (a refused young window is the defect itself); a
 *  candidate that errors, holds no bar, or is not young is passed over. */
export async function probeYoung(o: {
  venues: readonly string[];
  candidates: Readonly<Record<string, readonly string[]>>;
  nowMs: () => number;
  getCandles: (venue: string, tf: string, from: number, coin: string) => Promise<{ time: number }[]>;
  served: (venue: string, tf: string) => number | null;
  timeframes: (venue: string) => readonly string[];
  pace?: (ms: number) => Promise<void>;
}): Promise<YoungOutcome> {
  const pace = o.pace ?? sleep;
  const out: YoungOutcome = { results: [], refs: {}, none: [] };
  const states = o.venues.map((venue) => ({
    venue,
    plan: longestWindows(venue, o.timeframes(venue), o.served),
    cands: [...(o.candidates[venue] ?? [])].slice(0, YOUNG_CANDIDATES_PER_VENUE),
    coin: null as string | null,
    next: 0,
  }));
  const label = (w: Omit<ServeWindow, 'coin'>, coin: string): ServeWindow => ({ ...w, coin, window: `young:${coin}@${w.window}`, reference: 'thin' });
  const read = async (w: ServeWindow) => { await pace(PACE_MS); return readServe(o.getCandles, o.nowMs, w); };
  const live = (st: (typeof states)[number]) => st.plan.length > 0 && (st.coin === null ? st.cands.length > 0 : st.next < st.plan.length);
  for (const st of states) if (st.plan.length > 0 && st.cands.length === 0) out.none.push(st.venue);
  while (states.some(live)) {
    for (const st of states) {
      if (!live(st)) continue;
      if (st.coin === null) {
        const coin = st.cands.shift()!;
        const w = label(st.plan[0], coin);
        const r = await read(w);
        const young = 'refused' in r || ('facts' in r && !r.facts.emptyWindow && (r.facts.frontGapBars ?? 0) > YOUNG_FRONT_BARS);
        if (young) {
          st.coin = coin;
          st.next = 1;
          out.refs[st.venue] = coin;
          out.results.push(judgeServe(w, r));
        } else if (st.cands.length === 0) out.none.push(st.venue);
        continue;
      }
      const w = label(st.plan[st.next++], st.coin);
      out.results.push(judgeServe(w, await read(w)));
    }
  }
  return out;
}

/** The candidate corpus, per venue, most recently first seen first. Throws on an unreadable query. */
export function youngCandidatesByVenue(rows: readonly { exchange: string; coin: string }[]): Record<string, string[]> {
  const by: Record<string, string[]> = {};
  for (const r of rows) (by[r.exchange] ??= []).push(r.coin);
  return by;
}

// ── T: a declared ticker-priced venue's ticker (OPS-SERVED-CANDLE-TRUTH-W1 CH3a / Q11, Cowork Q8) ───────────────────

/** Judge one ticker read (pure): PASS when its last trade can price a call now by the venue's kind (tickerFreshness),
 *  FAIL when it cannot (every call on that venue would be refused), INDETERMINATE when the ticker could not be read. */
export function judgeTicker(venue: string, read: { lastTrade: { price: number; atMs: number } | undefined; nowMs: number } | { error: string }): ServeResult {
  const base: ServeResult = { venue, tf: 'ticker', window: `ticker:${COIN}`, spanMs: 0, servedStepMs: 0, coin: COIN, bars: null, headGapBars: null, headLagSlots: null, headLagMs: null, branch: null, verdict: 'PASS', reasons: [] };
  if ('error' in read) return { ...base, verdict: 'INDETERMINATE', reasons: [read.error] };
  const why = tickerFreshness(read.lastTrade, read.nowMs, venue);
  return why === null ? base : { ...base, verdict: 'FAIL', reasons: [`${venue} cannot price a call: ${why}`] };
}

function readExpectations(arg: string | undefined): Expectations {
  if (!arg) throw new Error('missing --expect <file|-> ({"reach": REACH.json.pairs, "unservable": UNSERVABLE.json.pairs})');
  const raw = fs.readFileSync(arg === '-' ? 0 : arg, 'utf8');
  const j = JSON.parse(raw) as Partial<Expectations>;
  if (!j || typeof j.reach !== 'object' || !Array.isArray(j.unservable)) throw new Error('--expect: not {reach, unservable}');
  if (Object.keys(j.reach!).length === 0) throw new Error('--expect: reach is empty (vacuity)');
  return j as Expectations;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const i = args.indexOf('--expect');
  let expected: Expectations;
  try { expected = readExpectations(i >= 0 ? args[i + 1] : undefined); }
  catch (e) { console.log(`${TAG} ADAPTER_HISTORY_VERDICT=INDETERMINATE expectations unreadable: ${errText(e)}`); return 3; }
  const active = await getActivePromotedVenueIds();
  // Y's corpus is BUILT here, so its vacuity guard is here: an unreadable query or no candidate anywhere is INDETERMINATE.
  let candidates: Record<string, string[]> | { error: string };
  try {
    const rows = await dbQuery<{ exchange: string; coin: string }>(YOUNG_CANDIDATES_SQL, [Math.floor(Date.now() / 1000) - YOUNG_CANDIDATE_DAYS * 86_400]);
    candidates = youngCandidatesByVenue(rows);
  } catch (e) { candidates = { error: errText(e) }; }
  const retired = PROMOTED_VENUE_IDS.filter((v: string) => !active.includes(v as never));
  // ONE batch scope for both legs, under the canary's own name: the entrypoint keeps the single class-setting
  // site tests/unit/caller-tags.test.ts pins for it, and neither leg can spend a venue's interactive reserve.
  const { results, serving, young, tickers } = await runAsBatch(async () => {
    const results = await probeAll({
      venues: active,
      expected,
      nowMs: () => Date.now(),
      getCandles: (venue, tf, from, to) => getAdapter(venue as ExchangeId).getCandles(COIN, tf, from, undefined, to),
      served: (venue, tf) => servedCandleStepMs(venue, tf),
      timeframes: (venue) => CRON_TIMEFRAMES.filter((tf) => faithfulTimeframes(venue as ExchangeId).has(tf)),
    });
    for (const r of results) console.log(`${TAG} PAIR ${JSON.stringify(r)}`);
    const servingTfs = (venue: string) => TIMEFRAMES.filter((tf) => isTimeframeFaithful(venue as ExchangeId, tf));
    const serveRead = (venue: string, tf: string, from: number, coin: string) => getAdapter(venue as ExchangeId).getCandles(coin, tf, from);
    const serving = await probeServing({
      venues: active,
      nowMs: () => Date.now(),
      getCandles: serveRead,
      served: (venue, tf) => servedCandleStepMs(venue, tf),
      timeframes: servingTfs,
    });
    const young = 'error' in candidates ? null : await probeYoung({
      venues: active,
      candidates,
      nowMs: () => Date.now(),
      getCandles: serveRead,
      served: (venue, tf) => servedCandleStepMs(venue, tf),
      timeframes: servingTfs,
    });
    const tickers: ServeResult[] = [];
    for (const venue of active.filter(isTickerPricedVenue)) {
      await sleep(PACE_MS);
      try {
        const ctx = await getAdapter(venue as ExchangeId).getAssetContext(COIN);
        tickers.push(judgeTicker(venue, { lastTrade: ctx.lastTrade, nowMs: Date.now() }));
      } catch (e) { tickers.push(judgeTicker(venue, { error: errText(e) })); }
    }
    return { results, serving, young, tickers };
  }, 'adapter-history-canary');
  const youngResults = young?.results ?? [];
  for (const r of [...serving, ...youngResults, ...tickers]) console.log(`${TAG} SERVE ${JSON.stringify(r)}`);
  const youngLeg: { verdict: PairVerdict; reason: string | null } = 'error' in candidates
    ? { verdict: 'INDETERMINATE', reason: `young-candidate query: ${candidates.error}` }
    : Object.keys(young?.refs ?? {}).length === 0
      ? { verdict: 'INDETERMINATE', reason: 'no young-listing reference on any venue (the corpus this leg builds is empty)' }
      : { verdict: 'PASS', reason: null };
  const verdict = aggregate([...results, ...serving, ...youngResults, ...tickers, youngLeg]);
  const count = (v: PairVerdict) => results.filter((r) => r.verdict === v).length;
  const sCount = (v: PairVerdict) => serving.filter((r) => r.verdict === v).length;
  const sId = (r: ServeResult) => `${r.venue}/${r.tf}/${r.window}`;
  const summary = {
    verdict, pairs: results.length, pass: count('PASS'), fail: count('FAIL'), indeterminate: count('INDETERMINATE'),
    skipped: count('SKIPPED'), retired_skipped: retired,
    failing: results.filter((r) => r.verdict === 'FAIL').map((r) => `${r.venue}/${r.tf}`),
    indeterminate_pairs: results.filter((r) => r.verdict === 'INDETERMINATE').map((r) => `${r.venue}/${r.tf}`),
    substituted_newest: results.reduce((n, r) => n + r.substitutedNewest, 0),
    serving: {
      windows: serving.length, pairs: new Set(serving.map((r) => `${r.venue}/${r.tf}`)).size,
      pass: sCount('PASS'), fail: sCount('FAIL'), indeterminate: sCount('INDETERMINATE'),
      failing: serving.filter((r) => r.verdict === 'FAIL').map(sId),
      indeterminate_windows: serving.filter((r) => r.verdict === 'INDETERMINATE').map(sId),
    },
    young: {
      verdict: youngLeg.verdict, reason: youngLeg.reason, refs: young?.refs ?? {}, no_young_listing: young?.none ?? [],
      windows: youngResults.length, fail: youngResults.filter((r) => r.verdict === 'FAIL').map(sId),
      indeterminate: youngResults.filter((r) => r.verdict === 'INDETERMINATE').map(sId),
    },
    tickers: tickers.map((r) => ({ venue: r.venue, verdict: r.verdict, reasons: r.reasons })),
  };
  console.log(`${TAG} RESULT_JSON=${JSON.stringify(summary)}`);
  console.log(`${TAG} ADAPTER_HISTORY_VERDICT=${verdict} pairs=${summary.pairs} pass=${summary.pass} fail=${summary.fail} indeterminate=${summary.indeterminate} skipped=${summary.skipped} serving_windows=${summary.serving.windows} serving_fail=${summary.serving.fail} serving_indeterminate=${summary.serving.indeterminate} young_refs=${Object.keys(summary.young.refs).length} young_fail=${summary.young.fail.length} ticker_fail=${tickers.filter((r) => r.verdict === 'FAIL').length}`);
  return verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 3;
}

if (require.main === module) {
  // 90 min: one cron-shaped run took 2742 s, 1589 s of it batch_wait on saturated lanes (cron-interlock-registry.json);
  // the 50 min this replaced was a projection that left that run 9 % headroom. A backstop, not a scheduler.
  void runScript('adapter-history-contiguity', main, { watchdogMs: 90 * 60_000 });
}

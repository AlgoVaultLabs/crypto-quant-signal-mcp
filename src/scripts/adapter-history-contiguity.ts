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
 * UNSERVABLE pairs (UNSERVABLE.json) and retired venues are SKIPPED and listed. A venue that is unreachable,
 * rate-limits (418/429) or throws is INDETERMINATE for that pair — fail-open, counted, never a page.
 * The expectations arrive on --expect <file|-> as {"reach": REACH.json.pairs, "unservable": UNSERVABLE.json.pairs},
 * read by the host wrapper from the deployed checkout's fixtures: ONE copy of the expectations, never a
 * second table in src.
 *
 * Output: one `[adapter-history] PAIR {json}` line per pair, one `RESULT_JSON=` summary, and exactly one
 * terminal `ADAPTER_HISTORY_VERDICT=PASS|FAIL|INDETERMINATE` (exit 0 / 1 / 3). Callers gate on the TOKEN.
 * No labels, no postgres writes, no alerts (the host wrapper streaks and pages).
 */
import fs from 'node:fs';
import { getAdapter } from '../lib/exchange-adapter.js';
import { getActivePromotedVenueIds } from '../lib/venue-store.js';
import { PROMOTED_VENUE_IDS } from '../lib/capabilities.js';
import { CRON_TIMEFRAMES, faithfulTimeframes, servedCandleStepMs } from '../lib/tf-support.js';
import { EVAL_CANDLES } from './directional-labeler.js';
import { accountPage, historyMetaOf, incompleteWindow, type PageFacts } from '../lib/adapters/_history-plan.js';
import { RECENT_PAGE_CAP as BITGET_RECENT_CAP } from '../lib/adapters/bitget.js';
import { RECENT_PAGE_CAP as OKX_RECENT_CAP } from '../lib/adapters/okx.js';
import { runAsBatch } from '../lib/upstream-weight-budget.js';
import { runScript } from '../lib/script-lifecycle.js';
import type { ExchangeId } from '../types.js';

const TAG = '[adapter-history]';
const COIN = 'BTC';
/** A venue may publish a just-closed candle a moment late: one missing closed slot at the head is allowed. */
export const HEAD_ALLOWANCE_BARS = 1;
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

/** The aggregate token: any FAIL → FAIL; else any INDETERMINATE → INDETERMINATE; else PASS (SKIPPED neutral). */
export function aggregate(results: readonly PairResult[]): 'PASS' | 'FAIL' | 'INDETERMINATE' {
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
  const retired = PROMOTED_VENUE_IDS.filter((v: string) => !active.includes(v as never));
  const results = await runAsBatch(() => probeAll({
    venues: active,
    expected,
    nowMs: () => Date.now(),
    getCandles: (venue, tf, from, to) => getAdapter(venue as ExchangeId).getCandles(COIN, tf, from, undefined, to),
    served: (venue, tf) => servedCandleStepMs(venue, tf),
    timeframes: (venue) => CRON_TIMEFRAMES.filter((tf) => faithfulTimeframes(venue as ExchangeId).has(tf)),
  }), 'adapter-history-canary');
  for (const r of results) console.log(`${TAG} PAIR ${JSON.stringify(r)}`);
  const verdict = aggregate(results);
  const count = (v: PairVerdict) => results.filter((r) => r.verdict === v).length;
  const summary = {
    verdict, pairs: results.length, pass: count('PASS'), fail: count('FAIL'), indeterminate: count('INDETERMINATE'),
    skipped: count('SKIPPED'), retired_skipped: retired,
    failing: results.filter((r) => r.verdict === 'FAIL').map((r) => `${r.venue}/${r.tf}`),
    indeterminate_pairs: results.filter((r) => r.verdict === 'INDETERMINATE').map((r) => `${r.venue}/${r.tf}`),
    substituted_newest: results.reduce((n, r) => n + r.substitutedNewest, 0),
  };
  console.log(`${TAG} RESULT_JSON=${JSON.stringify(summary)}`);
  console.log(`${TAG} ADAPTER_HISTORY_VERDICT=${verdict} pairs=${summary.pairs} pass=${summary.pass} fail=${summary.fail} indeterminate=${summary.indeterminate} skipped=${summary.skipped}`);
  return verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 3;
}

if (require.main === module) {
  void runScript('adapter-history-contiguity', main, { watchdogMs: 30 * 60_000 });
}

/**
 * sr-zones-contiguity.ts — SR-ZONES-W3 AC2.1. A wave check and T3's proof: no cron, no host install.
 *
 * For every venue × SR timeframe (srZonesTimeframes: native or built, R5), on BTC, ETH and the venue's young listing
 * (R0 P6), it runs get_support_resistance_zones's own window read — readSrZonesWindow → fetchWindow: the plan, the
 * venue's page span, the UTC guard (R6), the build — through the real adapters, and judges what it would serve:
 *   - bars: WINDOW_BARS (1001), or fewer only at the listing start: one read below the oldest bar (one bucket lower for
 *     a built pair, whose first, partial bucket is left out) must return nothing older;
 *   - contiguity: consecutive open times exactly one step apart, each on a UTC multiple of the step — the shared
 *     accounting (_history-plan.ts accountPage: gapSlots, offGridBars) plus the UTC check;
 *   - head: within one closed candle of now (accountPage headGapBars ≤ HEAD_ALLOWANCE_BARS).
 * A built pair walks its constituent bars (2002 for 1001 buckets of two); its window is the built one.
 *
 * The nightly adapter-history canary's S probes read SERVING_WINDOWS spans in one recent read, never this 1001-bar
 * backward walk (the 9th probe), so this does not duplicate it.
 *
 * Verdict (verification-gates.md): one PAIR line per pair, one RESULT_JSON line, and exactly one terminal
 * `SR_ZONES_CONTIGUITY_VERDICT=PASS|FAIL|INDETERMINATE pairs=<n> …`, exit 0 / 1 / 3. A read that could not be made (an
 * unreachable venue, a throttle, an error the venue answered) is INDETERMINATE, never PASS; a window that was read and
 * is wrong is FAIL. The corpus is built here, so its vacuity guard is here: no pair judged is INDETERMINATE.
 *
 * `--self-test` runs the judge over planted cases, two-way: clean windows pass, and each defect — a planted hole, a
 * planted stale head, an off-UTC bar, a window short of the listing start — fails; the self-test takes the judge as a
 * parameter so tests/unit/sr-zones-contiguity.test.ts proves each leg can fail. Prints SR_ZONES_CONTIGUITY_SELFTEST.
 *
 * Run: `node dist/scripts/sr-zones-contiguity.js` (local vantage reaches all four venues, R0 P5); inside the app
 * container only read-only (`docker exec … node dist/scripts/sr-zones-contiguity.js`). Reads run in the batch class
 * under get_sr_zones (readSrZonesWindow), so the check never spends a venue's interactive reserve.
 */
import type { Candle } from '../types.js';
import { getAdapter } from '../lib/exchange-adapter.js';
import { accountPage, HEAD_ALLOWANCE_BARS } from '../lib/adapters/_history-plan.js';
import { SR_ZONES_VENUES } from '../lib/tool-param-schema.js';
import { readSrZonesWindow, srZonesTimeframes, srZonesPlan, type SrZonesVenue } from '../tools/get-sr-zones.js';
import { SR_ZONES_PARAMS } from '../lib/sr-zones/params.js';
import { runScript } from '../lib/script-lifecycle.js';

const TAG = '[sr-zones-contiguity]';
/** A full window: H closed candles and the forming one. */
export const WINDOW_BARS = SR_ZONES_PARAMS.historyBars + 1;
/** R0 P6: one young listing per venue with under 1001 daily bars (ASTER, listed 2025-09-17..19 on all four). */
export const YOUNG_LISTING: Readonly<Record<SrZonesVenue, string>> = { BINANCE: 'ASTER', BYBIT: 'ASTER', OKX: 'ASTER', BITGET: 'ASTER' };
/** Native bars read below the oldest one to prove the listing start. */
const BELOW_BARS = 5;

export type PairVerdict = 'PASS' | 'FAIL' | 'INDETERMINATE';

/** What one pair's read produced, for the judge. */
export interface PairRead {
  venue: string;
  coin: string;
  tf: string;
  /** The served step and the step read (equal unless built). */
  stepMs: number;
  readStepMs: number;
  nowMs: number;
  /** The window the call would serve, ascending; null when the read failed. */
  window: Candle[] | null;
  /** How many bars a read below the window's floor returned (older than the floor); null when not needed or not read. */
  olderBelow: number | null;
  /** Why the read failed: `verified` = the venue answered and the window is refused (FAIL), `unreachable` otherwise. */
  error?: { kind: 'verified' | 'unreachable'; message: string };
}

export interface PairResult {
  venue: string;
  coin: string;
  tf: string;
  verdict: PairVerdict;
  bars: number | null;
  gapSlots: number | null;
  headGapBars: number | null;
  reasons: string[];
}

/** The judge (pure). */
export function judgePair(r: PairRead): PairResult {
  const base = { venue: r.venue, coin: r.coin, tf: r.tf };
  if (r.error) {
    return { ...base, verdict: r.error.kind === 'verified' ? 'FAIL' : 'INDETERMINATE', bars: null, gapSlots: null, headGapBars: null, reasons: [r.error.message] };
  }
  const w = r.window ?? [];
  if (w.length === 0) return { ...base, verdict: 'FAIL', bars: 0, gapSlots: null, headGapBars: null, reasons: ['no bars'] };
  const facts = accountPage({ bars: w.map((c) => ({ ts: c.time })), servedStepMs: r.stepMs, from: w[0].time, to: null, nowMs: r.nowMs });
  const reasons: string[] = [];
  if (facts.gapSlots > 0) reasons.push(`${facts.gapSlots} missing bars inside the window`);
  if (facts.offGridBars > 0) reasons.push(`${facts.offGridBars} bars off the step grid`);
  const offUtc = w.filter((c) => c.time % r.stepMs !== 0).length;
  if (offUtc > 0) reasons.push(`${offUtc} bars not on a UTC multiple of the step`);
  const steps = w.slice(1).filter((c, i) => c.time - w[i].time !== r.stepMs).length;
  if (steps > 0) reasons.push(`${steps} consecutive opens not one step apart`);
  const headGap = facts.headGapBars ?? 0;
  if (headGap > HEAD_ALLOWANCE_BARS) reasons.push(`head ${headGap} closed candles behind now (allowed ${HEAD_ALLOWANCE_BARS})`);
  if (w.length < WINDOW_BARS && r.olderBelow !== null && r.olderBelow > 0) {
    reasons.push(`${w.length} of ${WINDOW_BARS} bars, yet ${r.olderBelow} older bars exist below the window (not the listing start)`);
  }
  const out = { ...base, bars: w.length, gapSlots: facts.gapSlots, headGapBars: headGap };
  if (reasons.length > 0) return { ...out, verdict: 'FAIL', reasons };
  // Short, clean so far, and the listing start unproven: nothing wrong was seen, nothing complete was verified.
  if (w.length < WINDOW_BARS && r.olderBelow === null) return { ...out, verdict: 'INDETERMINATE', reasons: [`${w.length} bars and the listing start could not be read`] };
  return { ...out, verdict: 'PASS', reasons };
}

/** FAIL over INDETERMINATE over PASS; an empty corpus is INDETERMINATE (nothing was verified). */
export function aggregate(results: readonly PairResult[]): PairVerdict {
  if (results.length === 0) return 'INDETERMINATE';
  if (results.some((r) => r.verdict === 'FAIL')) return 'FAIL';
  if (results.some((r) => r.verdict === 'INDETERMINATE')) return 'INDETERMINATE';
  return 'PASS';
}

const H = 3_600_000;

/** A contiguous UTC series of `n` bars of `stepMs` whose newest opens in the candle forming at `nowMs`. */
function series(n: number, stepMs: number, nowMs: number): Candle[] {
  const forming = Math.floor(nowMs / stepMs) * stepMs;
  return Array.from({ length: n }, (_, i) => {
    const time = forming - (n - 1 - i) * stepMs;
    return { time, open: 100, high: 101, low: 99, close: 100, volume: 1 };
  });
}

/** The self-test's cases: [name, the read, the verdict a correct judge gives]. */
export function selfTestCases(): Array<[string, PairRead, PairVerdict]> {
  const nowMs = Date.parse('2026-11-20T05:30:00.000Z');
  const read = (tf: string, stepMs: number, window: Candle[] | null, more: Partial<PairRead> = {}): PairRead =>
    ({ venue: 'BYBIT', coin: 'BTC', tf, stepMs, readStepMs: stepMs, nowMs, window, olderBelow: null, ...more });
  const full = series(WINDOW_BARS, 4 * H, nowMs);
  return [
    ['a clean 1001-bar window passes', read('4h', 4 * H, full), 'PASS'],
    ['a clean built window passes', read('8h', 8 * H, series(WINDOW_BARS, 8 * H, nowMs), { readStepMs: 4 * H }), 'PASS'],
    ['a young listing short of 1001 at its listing start passes', read('1d', 24 * H, series(428, 24 * H, nowMs), { olderBelow: 0 }), 'PASS'],
    ['a planted hole fails', read('4h', 4 * H, full.filter((_, i) => i !== 500)), 'FAIL'],
    ['a planted stale head fails', read('4h', 4 * H, full.slice(0, -3)), 'FAIL'],
    ['a bar off its UTC multiple fails', read('8h', 8 * H, series(WINDOW_BARS, 8 * H, nowMs).map((c) => ({ ...c, time: c.time + 4 * H }))), 'FAIL'],
    ['a window short of 1001 with older bars below fails (truncated)', read('1d', 24 * H, series(367, 24 * H, nowMs), { olderBelow: 4 }), 'FAIL'],
    ['a short window whose listing start could not be read is INDETERMINATE', read('1d', 24 * H, series(367, 24 * H, nowMs)), 'INDETERMINATE'],
    ['an unreachable venue is INDETERMINATE', read('4h', 4 * H, null, { error: { kind: 'unreachable', message: 'fetch failed' } }), 'INDETERMINATE'],
    ['a refused window (off-UTC bars) fails', read('1d', 24 * H, null, { error: { kind: 'verified', message: 'OffUtcCandleError' } }), 'FAIL'],
  ];
}

/** Two-way self-test over `judge` (the real one by default) and the aggregate. */
export function runSelfTest(judge: (r: PairRead) => PairResult = judgePair): { pass: boolean; legs: Array<{ name: string; ok: boolean }> } {
  const legs = selfTestCases().map(([name, r, want]) => {
    let ok = false;
    try { ok = judge(r).verdict === want; } catch { ok = false; }
    return { name, ok };
  });
  const v = (verdict: PairVerdict): PairResult => ({ venue: 'X', coin: 'X', tf: '1h', verdict, bars: 0, gapSlots: 0, headGapBars: 0, reasons: [] });
  legs.push(
    { name: 'the aggregate: FAIL over INDETERMINATE over PASS', ok: aggregate([v('PASS'), v('INDETERMINATE'), v('FAIL')]) === 'FAIL' && aggregate([v('PASS'), v('INDETERMINATE')]) === 'INDETERMINATE' && aggregate([v('PASS')]) === 'PASS' },
    { name: 'the aggregate: an empty corpus is INDETERMINATE', ok: aggregate([]) === 'INDETERMINATE' },
  );
  return { pass: legs.every((l) => l.ok), legs };
}

const errText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
/** A read the venue answered and the handler refused as wrong (FAIL), as opposed to one that could not be made. */
const VERIFIED_ERRORS = new Set(['OffUtcCandleError', 'EmptyCandleWindowError']);

/** One pair: the handler's read, then (if short) one read below its floor. Never throws. */
async function readPair(venue: SrZonesVenue, coin: string, tf: string): Promise<PairRead> {
  const plan = srZonesPlan(venue, tf)!;
  const nowMs = Date.now();
  const at = { venue, coin, tf, stepMs: plan.readStepMs * plan.k, readStepMs: plan.readStepMs, nowMs };
  let window: Candle[];
  try {
    window = (await readSrZonesWindow(venue, coin, tf)).window.candles;
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    return { ...at, window: null, olderBelow: null, error: { kind: VERIFIED_ERRORS.has(name) ? 'verified' : 'unreachable', message: errText(e) } };
  }
  if (window.length === 0 || window.length >= WINDOW_BARS) return { ...at, window, olderBelow: null };
  // The listing start: nothing older than the floor (the oldest bar; one bucket lower for a built pair).
  const floor = window[0].time - (plan.k > 1 ? at.stepMs : 0);
  try {
    const below = await getAdapter(venue).getCandles(coin, plan.readTf, floor - BELOW_BARS * plan.readStepMs, undefined, floor - 1, { utcBars: true });
    return { ...at, window, olderBelow: below.filter((c) => c.time < floor).length };
  } catch {
    return { ...at, window, olderBelow: null };
  }
}

async function main(): Promise<number> {
  if (process.argv.includes('--self-test')) {
    const st = runSelfTest();
    for (const l of st.legs) console.log(`${l.ok ? 'PASS' : 'FAIL'}  ${l.name}`);
    console.log(`SR_ZONES_CONTIGUITY_SELFTEST=${st.pass ? 'PASS' : 'FAIL'}`);
    return st.pass ? 0 : 1;
  }
  const results: PairResult[] = [];
  for (const venue of SR_ZONES_VENUES) {
    for (const coin of ['BTC', 'ETH', YOUNG_LISTING[venue]]) {
      for (const tf of srZonesTimeframes(venue)) {
        const r = judgePair(await readPair(venue, coin, tf));
        results.push(r);
        console.log(`${TAG} PAIR ${JSON.stringify(r)}`);
      }
    }
  }
  const verdict = aggregate(results);
  const count = (v: PairVerdict) => results.filter((r) => r.verdict === v).length;
  const id = (r: PairResult) => `${r.venue}/${r.coin}/${r.tf}`;
  const summary = {
    verdict, pairs: results.length, pass: count('PASS'), fail: count('FAIL'), indeterminate: count('INDETERMINATE'),
    failing: results.filter((r) => r.verdict === 'FAIL').map(id),
    indeterminate_pairs: results.filter((r) => r.verdict === 'INDETERMINATE').map(id),
  };
  console.log(`${TAG} RESULT_JSON=${JSON.stringify(summary)}`);
  console.log(`SR_ZONES_CONTIGUITY_VERDICT=${verdict} pairs=${summary.pairs} pass=${summary.pass} fail=${summary.fail} indeterminate=${summary.indeterminate}`);
  return verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 3;
}

if (require.main === module) {
  void runScript('sr-zones-contiguity', main, { watchdogMs: 30 * 60_000 });
}

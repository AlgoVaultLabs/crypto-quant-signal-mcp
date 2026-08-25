/**
 * frozen-window-attribution.ts — EDGE-SELL-RESOLUTION-ASYMMETRY-W1 R0.
 *
 * READ-ONLY. Attributes the SELL barrier-timeout excess over BUY to frozen (non-trading)
 * books, by REFETCHING each sampled signal's evaluation window and classifying it on VOLUME.
 *
 * ── WHY A REFETCH AND NOT A SQL PROXY ──
 *
 * `directional_labels` stores mfe/mae but no volume, so the DB alone cannot tell a book that
 * was SHUT from one that merely did not move. The tempting proxy `pfe = 0 XOR mae = 0` is
 * INVALID — `OPS-PFE-METRIC-INTEGRITY-W1` §J measured it at 13–16% on venues with ZERO frozen
 * rows, a ~50× overstatement. The tighter `mfe = 0 AND mae = 0` is a much better prior but is
 * still a proxy: a book that TRADES at a single price all window is flat with positive volume,
 * and the shipped gate (`volume > 0`) would NOT suppress it. Separating those two is the whole
 * job, and only the bars can do it.
 *
 * ── THE TWO WINDOWS, FROM ONE FETCH ──
 *
 *  - EVALUATION window `[entry, entry + W·tf)` — what the triple barrier raced over. Classified
 *    REAL / PARTIAL(j of W) / ALL_ZERO_VOL / NO_CANDLES.
 *  - EMIT-TIME window — the 24 bars immediately BEFORE entry, i.e. what `get_trade_call` held
 *    when it decided. Fed to the SHIPPED `assessBookLiveness` (never reimplemented) to answer
 *    R0.4: would the k=12/N=24 gate have suppressed this emission?
 *
 * ── FAITHFUL REPLICATION, INCLUDING THE UGLY PART ──
 *
 * Bars are taken exactly as the adapter returns them for that timeframe, and sliced by COUNT —
 * because that is what `backfill-directional-labels.ts` did when it wrote the label being
 * explained. On HTX/XT this means a `2h`/`8h`/`12h`/`3m` request is served from a different
 * base interval (`INTERVAL_MAP` fallback; no adapter aggregates), so those windows span a
 * different wall-clock than their name suggests. Normalising here would classify a window the
 * labeler never looked at. The served-interval is REPORTED per cell instead.
 *
 * ── INDEPENDENCE ──
 *
 * Rows are not independent: the SELL timeout population concentrates on a handful of books.
 * Every interval is therefore a cluster bootstrap over `(venue, coin)`, and the cluster count
 * is reported beside it. A row-binomial CI here would be fake precision.
 *
 * Usage (in-container on prod 204 — several venues TCP-block the Mac egress):
 *   node dist/scripts/frozen-window-attribution.js --days 30 --buy-sample 600 --out /tmp/r0.json
 */

import { dbQuery } from '../lib/performance-db.js';
import { runScript } from '../lib/script-lifecycle.js';
import { getAdapter } from '../lib/exchange-adapter.js';
import { getDexForCoin } from '../lib/asset-tiers.js';
import { runAsCaller, WeightBudgetSkipError } from '../lib/upstream-weight-budget.js';
import { assessBookLiveness, BOOK_LIVENESS_WINDOW, BOOK_LIVENESS_MIN_GENUINE_BARS } from '../lib/book-liveness.js';
import { EVAL_CANDLES, TF_MS } from './directional-labeler.js';
import type { Candle, ExchangeId } from '../types.js';
import { writeFileSync } from 'node:fs';

const DELAY_BETWEEN_FETCHES_MS = 250;
const MAX_PAGES_PER_RANGE = 60;
const FETCH_BUFFER_CANDLES = 2;
const BOOTSTRAP_DRAWS = 2000;
const DEFAULT_SPEC = 'tau1.0-floor0.30-v1';

type Side = 'BUY' | 'SELL';
export type EvalClass = 'REAL' | 'PARTIAL' | 'ALL_ZERO_VOL' | 'NO_CANDLES';

export interface SignalRow {
  id: number;
  created_at: number;
  signal: Side;
  exchange: string;
  coin: string;
  timeframe: string;
  label: number;
  mfe_return_pct: number | null;
  mae_return_pct: number | null;
}

export interface Classified extends SignalRow {
  evalClass: EvalClass;
  barsExamined: number;
  zeroVolBars: number;
  /** Bars found strictly before entry, capped at the liveness window. */
  preBars: number;
  /** The SHIPPED predicate's verdict on the emit-time window; null = not enough bars fetched. */
  wouldSuppress: boolean | null;
  genuineBarsPre: number;
}

const ts = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Deterministic PRNG — a seeded bootstrap must be re-runnable to the same interval. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Paginated fetch, stopping at the venue horizon. Mirrors
 * `backfill-directional-labels.ts::fetchRangeInto` deliberately: the same transport, the same
 * no-forward-progress break, so a book unreachable HERE was unreachable THERE too.
 */
async function fetchRangeInto(
  cache: Map<number, Candle>,
  exchangeId: ExchangeId,
  coin: string,
  timeframe: string,
  startMs: number,
  endMs: number,
): Promise<void> {
  const tfMs = TF_MS[timeframe];
  const adapter = getAdapter(exchangeId);
  const dex = exchangeId === 'HL' ? getDexForCoin(coin) : undefined;
  let cursor = startMs;
  let pages = 0;
  while (cursor <= endMs && pages < MAX_PAGES_PER_RANGE) {
    pages++;
    const page = await adapter.getCandles(coin, timeframe, cursor, dex, endMs);
    if (!page || page.length === 0) break;
    let maxTime = cursor;
    for (const c of page) {
      cache.set(c.time, c);
      if (c.time > maxTime) maxTime = c.time;
    }
    if (maxTime <= cursor) break; // venue horizon / recent-only endpoint
    cursor = maxTime + tfMs;
    await sleep(DELAY_BETWEEN_FETCHES_MS);
  }
}

/** `volume > 0` — the SHIPPED predicate's genuineness test, applied bar-by-bar. */
const isGenuine = (c: Candle): boolean => Number(c.volume) > 0;

export function classifyEvalWindow(forwardAsc: Candle[], W: number): {
  evalClass: EvalClass; barsExamined: number; zeroVolBars: number;
} {
  const win = forwardAsc.slice(0, W);
  if (win.length < W) {
    // Same reachability bar the labeler used to REFUSE writing a timeout. Short here means the
    // instrument could not see the window, never that the book was dead.
    return { evalClass: 'NO_CANDLES', barsExamined: win.length, zeroVolBars: 0 };
  }
  const zero = win.filter((c) => !isGenuine(c)).length;
  if (zero === W) return { evalClass: 'ALL_ZERO_VOL', barsExamined: W, zeroVolBars: zero };
  if (zero > 0) return { evalClass: 'PARTIAL', barsExamined: W, zeroVolBars: zero };
  return { evalClass: 'REAL', barsExamined: W, zeroVolBars: 0 };
}

async function loadSample(days: number, spec: string, buySample: number): Promise<SignalRow[]> {
  const cutoff = `extract(epoch from now()) - ${days} * 86400`;
  const base = `FROM signals s JOIN directional_labels dl ON dl.signal_id = s.id
    WHERE dl.barrier_spec = $1 AND dl.low_vol_history = false AND s.created_at > ${cutoff}`;

  // SELL: the whole labelled population. It is small enough to take entire, which removes
  // sampling error from the side the wave is about.
  const sells = await dbQuery<SignalRow>(
    `SELECT s.id, s.created_at, s.signal, s.exchange, s.coin, s.timeframe,
            dl.label, dl.mfe_return_pct, dl.mae_return_pct ${base} AND s.signal = 'SELL'
     ORDER BY s.created_at`,
    [spec],
  );

  // BUY control: stratified to the SELL (venue, timeframe) mix, so the comparison is not merely
  // a comparison of WHERE each side happens to be emitted. The join to `cells` also restricts
  // BUY to cells that carry SELLs at all — an unrestricted BUY arm would be a different
  // population, not a control. Ordering by id makes the draw deterministic and re-runnable.
  const buys = await dbQuery<SignalRow>(
    `WITH cells AS (
       SELECT s.exchange, s.timeframe, count(*)::float AS n
       FROM signals s JOIN directional_labels dl ON dl.signal_id = s.id
       WHERE dl.barrier_spec = $1 AND dl.low_vol_history = false
         AND s.created_at > ${cutoff} AND s.signal = 'SELL'
       GROUP BY 1, 2),
     tot AS (SELECT sum(n) AS t FROM cells),
     ranked AS (
       SELECT s.id, s.created_at, s.signal, s.exchange, s.coin, s.timeframe,
              dl.label, dl.mfe_return_pct, dl.mae_return_pct,
              row_number() OVER (PARTITION BY s.exchange, s.timeframe ORDER BY s.id) AS rn,
              ceil(c.n / t.t * $2) AS quota
       FROM signals s
       JOIN directional_labels dl ON dl.signal_id = s.id
       JOIN cells c ON c.exchange = s.exchange AND c.timeframe = s.timeframe
       CROSS JOIN tot t
       WHERE dl.barrier_spec = $1 AND dl.low_vol_history = false
         AND s.created_at > ${cutoff} AND s.signal = 'BUY')
     SELECT id, created_at, signal, exchange, coin, timeframe, label, mfe_return_pct, mae_return_pct
     FROM ranked WHERE rn <= quota ORDER BY created_at`,
    [spec, buySample],
  );
  console.log(`[${ts()}] sample: SELL ${sells.length} · BUY ${buys.length} (stratified to the SELL venue×tf mix)`);
  return [...sells, ...buys];
}

async function classifyAll(rows: SignalRow[]): Promise<Classified[]> {
  const groups = new Map<string, SignalRow[]>();
  for (const r of rows) {
    const k = `${r.exchange}|${r.coin}|${r.timeframe}`;
    const a = groups.get(k);
    if (a) a.push(r); else groups.set(k, [r]);
  }
  console.log(`[${ts()}] ${groups.size} (venue, coin, timeframe) groups to refetch`);

  const out: Classified[] = [];
  let done = 0;
  for (const [key, sigs] of groups) {
    const [exchange, coin, timeframe] = key.split('|');
    const W = EVAL_CANDLES[timeframe];
    const tfMs = TF_MS[timeframe];
    done++;
    if (!W || !tfMs) continue; // retired/unknown timeframe — never labelled either

    const entries = sigs.map((s) => s.created_at * 1000);
    const startMs = Math.min(...entries) - (BOOK_LIVENESS_WINDOW + FETCH_BUFFER_CANDLES) * tfMs;
    const endMs = Math.max(...entries) + (W + FETCH_BUFFER_CANDLES) * tfMs;

    const cache = new Map<number, Candle>();
    try {
      await fetchRangeInto(cache, exchange as ExchangeId, coin, timeframe, startMs, endMs);
    } catch (err) {
      if (err instanceof WeightBudgetSkipError) {
        console.warn(`[${ts()}] BUDGET-SKIP ${key} — ${sigs.length} signal(s) unclassified`);
      } else {
        console.warn(`[${ts()}] FETCH-FAIL ${key}: ${(err as Error).message}`);
      }
    }
    const asc = [...cache.values()].sort((a, b) => a.time - b.time);

    for (const s of sigs) {
      const entryMs = s.created_at * 1000;
      const forwardAsc = asc.filter((c) => c.time >= entryMs);
      const pre = asc.filter((c) => c.time < entryMs).slice(-BOOK_LIVENESS_WINDOW);
      const ev = classifyEvalWindow(forwardAsc, W);

      // The SHIPPED predicate, not a copy. It fails OPEN below its window, so a short prefetch
      // must be reported as "cannot say" rather than silently as "would not suppress".
      const liveness = assessBookLiveness(pre);
      const wouldSuppress = pre.length < BOOK_LIVENESS_MIN_GENUINE_BARS ? null : !liveness.live;

      out.push({
        ...s, ...ev,
        preBars: pre.length,
        wouldSuppress,
        genuineBarsPre: liveness.genuineBars,
      });
    }
    if (done % 20 === 0) console.log(`[${ts()}] ${done}/${groups.size} groups`);
  }
  return out;
}

// ── aggregation ────────────────────────────────────────────────────────────

export const timeoutRate = (rs: Classified[]) => (rs.length ? rs.filter((r) => r.label === 0).length / rs.length : NaN);

/**
 * Cluster bootstrap over `(venue, coin)`. Resamples BOOKS with replacement and recomputes the
 * whole statistic each draw, so a book contributing 200 correlated rows moves the interval once.
 */
export function clusterBootstrapCI(
  rows: Classified[],
  stat: (rs: Classified[]) => number,
  seed = 20260825,
): { lo: number; hi: number; clusters: number } {
  const byBook = new Map<string, Classified[]>();
  for (const r of rows) {
    const k = `${r.exchange}|${r.coin}`;
    const a = byBook.get(k);
    if (a) a.push(r); else byBook.set(k, [r]);
  }
  const books = [...byBook.values()];
  if (books.length < 2) return { lo: NaN, hi: NaN, clusters: books.length };
  const rnd = mulberry32(seed);
  const draws: number[] = [];
  for (let b = 0; b < BOOTSTRAP_DRAWS; b++) {
    const resampled: Classified[] = [];
    for (let i = 0; i < books.length; i++) resampled.push(...books[Math.floor(rnd() * books.length)]);
    const v = stat(resampled);
    if (Number.isFinite(v)) draws.push(v);
  }
  draws.sort((a, b) => a - b);
  return {
    lo: draws[Math.floor(0.025 * draws.length)],
    hi: draws[Math.floor(0.975 * draws.length)],
    clusters: books.length,
  };
}

export function frozenAttributableShare(sells: Classified[], buys: Classified[]): number {
  // Excess as observed, minus the excess that SURVIVES removing the suppressible emissions.
  const excess = timeoutRate(sells) - timeoutRate(buys);
  const sK = sells.filter((r) => r.wouldSuppress === false);
  const bK = buys.filter((r) => r.wouldSuppress === false);
  if (!sK.length || !bK.length) return NaN;
  const residual = timeoutRate(sK) - timeoutRate(bK);
  return excess === 0 ? NaN : (excess - residual) / excess;
}

function summarise(all: Classified[]) {
  const bySide = (s: Side) => all.filter((r) => r.signal === s);
  const sells = bySide('SELL');
  const buys = bySide('BUY');

  const classBreakdown = (rs: Classified[]) => {
    const c: Record<EvalClass, number> = { REAL: 0, PARTIAL: 0, ALL_ZERO_VOL: 0, NO_CANDLES: 0 };
    for (const r of rs) c[r.evalClass]++;
    return c;
  };
  const suppression = (rs: Classified[]) => {
    const decidable = rs.filter((r) => r.wouldSuppress !== null);
    return {
      decidable: decidable.length,
      indeterminate: rs.length - decidable.length,
      would_suppress: decidable.filter((r) => r.wouldSuppress).length,
      rate: decidable.length ? decidable.filter((r) => r.wouldSuppress).length / decidable.length : NaN,
    };
  };

  const perCell: Record<string, unknown>[] = [];
  const cells = new Map<string, Classified[]>();
  for (const r of all) {
    const k = `${r.exchange}|${r.timeframe}|${r.signal}`;
    const a = cells.get(k);
    if (a) a.push(r); else cells.set(k, [r]);
  }
  for (const [k, rs] of [...cells.entries()].sort()) {
    const [venue, timeframe, side] = k.split('|');
    const cb = classBreakdown(rs);
    perCell.push({
      venue, timeframe, side, n: rs.length,
      timeout_pct: +(timeoutRate(rs) * 100).toFixed(2),
      ...cb,
      frozen_pct: +(((cb.ALL_ZERO_VOL + cb.PARTIAL) / rs.length) * 100).toFixed(2),
      would_suppress_pct: +(suppression(rs).rate * 100).toFixed(2),
      books: new Set(rs.map((r) => r.coin)).size,
    });
  }

  const sellSurvivors = sells.filter((r) => r.wouldSuppress === false);
  const buySurvivors = buys.filter((r) => r.wouldSuppress === false);
  const attribCI = clusterBootstrapCI([...sells, ...buys],
    (rs) => frozenAttributableShare(rs.filter((r) => r.signal === 'SELL'), rs.filter((r) => r.signal === 'BUY')));
  const sellCfCI = clusterBootstrapCI(sells,
    (rs) => timeoutRate(rs.filter((r) => r.wouldSuppress === false)));

  return {
    generated_at: ts(),
    predicate: { window: BOOK_LIVENESS_WINDOW, min_genuine_bars: BOOK_LIVENESS_MIN_GENUINE_BARS, test: 'volume > 0' },
    sides: {
      SELL: {
        n: sells.length, timeout_pct: +(timeoutRate(sells) * 100).toFixed(2),
        classes: classBreakdown(sells), suppression: suppression(sells),
      },
      BUY: {
        n: buys.length, timeout_pct: +(timeoutRate(buys) * 100).toFixed(2),
        classes: classBreakdown(buys), suppression: suppression(buys),
      },
    },
    counterfactual: {
      sell_timeout_pct_post_suppression: +(timeoutRate(sellSurvivors) * 100).toFixed(2),
      sell_timeout_ci95: [+(sellCfCI.lo * 100).toFixed(2), +(sellCfCI.hi * 100).toFixed(2)],
      sell_clusters: sellCfCI.clusters,
      buy_timeout_pct_post_suppression: +(timeoutRate(buySurvivors) * 100).toFixed(2),
      sell_emissions_suppressed: sells.length - sellSurvivors.length,
      buy_emissions_suppressed: buys.length - buySurvivors.length,
    },
    attribution: {
      frozen_attributable_share_pct: +(frozenAttributableShare(sells, buys) * 100).toFixed(2),
      ci95_pct: [+(attribCI.lo * 100).toFixed(2), +(attribCI.hi * 100).toFixed(2)],
      clusters: attribCI.clusters,
      note: 'cluster bootstrap over (venue, coin); n is a COVERAGE figure, never a power claim',
    },
    per_cell: perCell,
  };
}

async function main(): Promise<void> {
  const days = Number(arg('--days') ?? 30);
  const spec = arg('--spec') ?? DEFAULT_SPEC;
  const buySample = Number(arg('--buy-sample') ?? 600);
  const out = arg('--out') ?? '/tmp/frozen-window-attribution.json';

  const rows = await loadSample(days, spec, buySample);
  const classified = await classifyAll(rows);
  const summary = summarise(classified);
  writeFileSync(out, JSON.stringify({ ...summary, params: { days, spec, buySample } }, null, 2));
  console.log(`[${ts()}] wrote ${out}`);
  console.log(JSON.stringify(summary.sides, null, 2));
  console.log(JSON.stringify(summary.counterfactual, null, 2));
  console.log(JSON.stringify(summary.attribution, null, 2));
}

if (require.main === module) {
  void runScript('frozen-window-attribution', () => runAsCaller('dwr-backfill', main));
}

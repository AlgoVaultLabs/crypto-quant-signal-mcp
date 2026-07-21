/**
 * EDGE-CARRY-BACKFILL-W1 CH4 — the honest carry baseline report.
 *
 * Reads funding_episodes + funding_rates_hist (prod) and emits the machine JSON the ranker wave is
 * judged against: per venue×floor stats (×1 AND ×2 cost), block-bootstrap (symbol×ISO-week) CI vs zero,
 * the naive top-5-by-current-APR portfolio (the benchmark the ranker must beat) + beta-to-BTC
 * (market-neutrality check), and the n≥50 ranker-eligibility table. Prints JSON to stdout.
 *
 * Expected + SUCCESS: naive selection ≈ breakeven-to-negative net of costs (Step-0: median net-APR
 * negative at every floor under ×2 hedged) — the honest floor that makes the ranker's job measurable.
 * net_carry / net_apr are INTERNAL (never exposed). Deterministic bootstrap (seeded LCG).
 */
import { buildPoolConfig } from '../lib/performance-db.js';
import { runScript } from '../lib/script-lifecycle.js';
import { annualizeFunding } from '../lib/rank-constants.js';
import { getAdapter } from '../lib/exchange-adapter.js';
import type { ExchangeId } from '../types.js';

type Pool = import('pg').Pool;
function makePool(): Pool {
  const cs = process.env.DATABASE_URL;
  if (!cs) throw new Error('DATABASE_URL required (prod)');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pool } = require('pg') as typeof import('pg');
  return new Pool(buildPoolConfig(cs));
}

const VENUES: ExchangeId[] = ['BINANCE', 'BYBIT', 'HL', 'ASTER', 'KUCOIN', 'OKX', 'GATE'];
const FLOORS = [0.08, 0.12, 0.2];
const INTERVAL_H: Record<string, number> = { HL: 1 }; // else 8
const ih = (v: string): number => INTERVAL_H[v] ?? 8;

// ── pure stats ──
function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [NaN, NaN];
  const p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [round(100 * (c - h), 1), round(100 * (c + h), 1)];
}
function pct(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b), k = (s.length - 1) * p, lo = Math.floor(k), hi = Math.ceil(k);
  return round(lo === hi ? s[lo] : s[lo] * (hi - k) + s[hi] * (k - lo), 4);
}
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const round = (x: number, d = 3): number => { const m = 10 ** d; return Math.round(x * m) / m; };
// seeded LCG so the bootstrap is reproducible (Date.now/Math.random-free, deterministic across runs).
function lcg(seed: number): () => number { let s = seed >>> 0; return () => (s = (1664525 * s + 1013904223) >>> 0) / 4294967296; }

/** Block bootstrap over cluster keys: resample WHOLE clusters (symbol×ISO-week), 1000 iters → 95% CI of the mean. */
function blockBootstrapCI(byCluster: Map<string, number[]>, iters = 1000, seed = 12345): [number, number] {
  const clusters = [...byCluster.values()];
  const nC = clusters.length;
  if (nC < 2) return [NaN, NaN];
  const rnd = lcg(seed);
  const means: number[] = [];
  for (let it = 0; it < iters; it++) {
    let sum = 0, cnt = 0;
    for (let c = 0; c < nC; c++) {
      const cl = clusters[Math.floor(rnd() * nC)];
      for (const v of cl) { sum += v; cnt++; }
    }
    if (cnt) means.push(sum / cnt);
  }
  return [pct(means, 0.025), pct(means, 0.975)];
}

interface EpRow { symbol: string; floor: number; gross: number; rt: number; net: number; net_apr: number; gross_apr: number; held: number; dur: number; exit: string; np: boolean; week: string; entry_ms: number; exit_ms: number; }

async function loadEpisodes(pool: Pool, venue: string): Promise<EpRow[]> {
  const r = await pool.query(
    `SELECT symbol, entry_floor_apr::float f, gross_carry::float g, rt_cost::float rt, net_carry::float net,
            net_apr::float na, gross_apr::float ga, held_intervals::int held,
            EXTRACT(epoch FROM (exit_ts-entry_ts))/86400.0 dur, exit_reason ex, net_positive np,
            cluster_week::text wk, (EXTRACT(epoch FROM entry_ts)*1000)::float ems, (EXTRACT(epoch FROM exit_ts)*1000)::float xms
     FROM funding_episodes WHERE venue=$1`, [venue]);
  return r.rows.map((x) => ({ symbol: x.symbol, floor: x.f, gross: x.g, rt: x.rt, net: x.net, net_apr: x.na, gross_apr: x.ga, held: x.held, dur: x.dur, exit: x.ex, np: x.np, week: x.wk, entry_ms: x.ems, exit_ms: x.xms }));
}

/** Per venue×floor cell: n, survival+Wilson, net-APR percentiles (×1 stored + ×2 = gross−2·rt recomputed), exit mix, duration, bootstrap CI. */
function cellStats(rows: EpRow[], venue: string) {
  const out: Record<string, unknown>[] = [];
  for (const floor of FLOORS) {
    const c = rows.filter((r) => Math.abs(r.floor - floor) < 1e-9);
    if (!c.length) continue;
    const k = c.filter((r) => r.np).length;
    const naprX1 = c.map((r) => r.net_apr);
    // ×2 fully-hedged: net = gross − 2·rt; net_apr = net/dur·365
    const naprX2 = c.map((r) => (r.dur > 0 ? ((r.gross - 2 * r.rt) / r.dur) * 365 : 0));
    const exitMix: Record<string, number> = {};
    for (const r of c) exitMix[r.exit] = (exitMix[r.exit] ?? 0) + 1;
    const byCluster = new Map<string, number[]>();
    for (const r of c) { const key = `${r.symbol}|${r.week}`; (byCluster.get(key) ?? byCluster.set(key, []).get(key)!).push(r.net); }
    out.push({
      venue, floor_pct: Math.round(floor * 100), n: c.length,
      survival_pct: round((100 * k) / c.length, 1), survival_ci95: wilson(k, c.length),
      net_apr_x1: { p25: pct(naprX1, 0.25), med: pct(naprX1, 0.5), p75: pct(naprX1, 0.75) },
      net_apr_x2: { p25: pct(naprX2, 0.25), med: pct(naprX2, 0.5), p75: pct(naprX2, 0.75) },
      mean_net_carry: round(mean(c.map((r) => r.net)), 6),
      boot_ci95_mean_net_carry: blockBootstrapCI(byCluster),
      dur_days: { p25: pct(c.map((r) => r.dur), 0.25), med: pct(c.map((r) => r.dur), 0.5), p75: pct(c.map((r) => r.dur), 0.75) },
      exit_mix: exitMix, ranker_eligible: c.length >= 50,
    });
  }
  return out;
}

/** Naive top-5-by-current-APR portfolio (the benchmark the ranker must beat): each interval, hold the 5
 *  highest |APR| symbols equal-weight; realise NEXT funding; charge turnover (rt/2 per leg entering/leaving).
 *  Returns net APR + a week-block bootstrap CI. */
async function naivePortfolio(pool: Pool, venue: string) {
  const r = await pool.query(
    `SELECT symbol, (EXTRACT(epoch FROM ts)*1000)::float t, funding_rate::float fr,
            date_trunc('week', ts)::text wk FROM funding_rates_hist WHERE venue=$1 ORDER BY ts`, [venue]);
  const interval = ih(venue);
  // group by timestamp
  const byT = new Map<number, { symbol: string; fr: number; wk: string }[]>();
  for (const x of r.rows) { const t = x.t as number; (byT.get(t) ?? byT.set(t, []).get(t)!).push({ symbol: x.symbol, fr: x.fr, wk: x.wk }); }
  const ts = [...byT.keys()].sort((a, b) => a - b);
  if (ts.length < 10) return { net_apr: NaN, ci95: [NaN, NaN] as [number, number], n_intervals: ts.length };
  const HALF = 0.00055; // avg per-leg cost (≈ taker+half-spread); turnover charge
  let prev = new Set<string>();
  const perWeek = new Map<string, number[]>();
  for (let i = 0; i < ts.length - 1; i++) {
    const nowRows = byT.get(ts[i])!, nextMap = new Map(byT.get(ts[i + 1])!.map((x) => [x.symbol, x.fr]));
    const top = [...nowRows].sort((a, b) => Math.abs(annualizeFunding(b.fr, interval) ?? 0) - Math.abs(annualizeFunding(a.fr, interval) ?? 0)).slice(0, 5);
    const cur = new Set(top.map((x) => x.symbol));
    let entering = 0, leaving = 0;
    for (const s of cur) if (!prev.has(s)) entering++;
    for (const s of prev) if (!cur.has(s)) leaving++;
    const funding = top.length ? mean(top.map((x) => Math.abs(nextMap.get(x.symbol) ?? 0))) : 0;
    const cost = top.length ? ((entering + leaving) * HALF) / Math.max(1, top.length) : 0;
    const net = funding - cost;
    const wk = nowRows[0].wk;
    (perWeek.get(wk) ?? perWeek.set(wk, []).get(wk)!).push(net);
    prev = cur;
  }
  const allNet: number[] = [];
  for (const arr of perWeek.values()) allNet.push(...arr);
  const perYr = (24 / interval) * 365;
  const netApr = mean(allNet) * perYr;
  const boot = blockBootstrapCI(perWeek);
  return { net_apr: round(netApr, 4), ci95: [round((boot[0] || 0) * perYr, 4), round((boot[1] || 0) * perYr, 4)] as [number, number], n_intervals: ts.length };
}

/** Beta of episode net_carry to BTC price return over the episode window (market-neutrality: CI should include 0). */
async function betaToBtc(rows: EpRow[]): Promise<{ beta: number; ci95: [number, number]; n: number }> {
  // BTC daily closes (Binance) covering the whole window; per-episode return = close[exit]/close[entry]−1.
  let candles: { time: number; close: number }[] = [];
  try {
    const start = Math.min(...rows.map((r) => r.entry_ms));
    candles = (await getAdapter('BINANCE').getCandles('BTC', '1d', start)).map((c) => ({ time: c.time, close: c.close }));
  } catch { /* fail-soft */ }
  if (candles.length < 10) return { beta: NaN, ci95: [NaN, NaN], n: 0 };
  candles.sort((a, b) => a.time - b.time);
  const priceAt = (ms: number): number => { let lo = 0, hi = candles.length - 1, ans = candles[0].close; while (lo <= hi) { const m = (lo + hi) >> 1; if (candles[m].time <= ms) { ans = candles[m].close; lo = m + 1; } else hi = m - 1; } return ans; };
  const xs: number[] = [], ys: number[] = [];
  for (const r of rows) { const p0 = priceAt(r.entry_ms), p1 = priceAt(r.exit_ms); if (p0 > 0) { xs.push(p1 / p0 - 1); ys.push(r.net); } }
  if (xs.length < 10) return { beta: NaN, ci95: [NaN, NaN], n: xs.length };
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0; for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const beta = sxx > 0 ? sxy / sxx : NaN;
  // residual SE → beta SE → 95% CI
  let sse = 0; for (let i = 0; i < xs.length; i++) { const yhat = my + beta * (xs[i] - mx); sse += (ys[i] - yhat) ** 2; }
  const se = sxx > 0 ? Math.sqrt(sse / (xs.length - 2) / sxx) : NaN;
  return { beta: round(beta, 4), ci95: [round(beta - 1.96 * se, 4), round(beta + 1.96 * se, 4)], n: xs.length };
}

async function main(): Promise<void> {
  const pool = makePool();
  try {
    const cells: Record<string, unknown>[] = [];
    const naive: Record<string, unknown>[] = [];
    const beta: Record<string, unknown>[] = [];
    const coverage: Record<string, unknown>[] = [];
    for (const v of VENUES) {
      const rows = await loadEpisodes(pool, v);
      if (!rows.length) continue;
      cells.push(...cellStats(rows, v));
      coverage.push({ venue: v, episodes: rows.length, symbols: new Set(rows.map((r) => r.symbol)).size, interval_h: ih(v) });
      // portfolio + beta only for venues with real depth (skip the ~1-page seeds where a portfolio is meaningless)
      if (v !== 'OKX' && v !== 'GATE') {
        naive.push({ venue: v, ...(await naivePortfolio(pool, v)) });
        beta.push({ venue: v, ...(await betaToBtc(rows)) });
      }
    }
    const report = {
      wave: 'EDGE-CARRY-BACKFILL-W1', chapter: 'CH4', generated_utc: new Date().toISOString(),
      cost_model: 'x1 = perp round-trip (2·taker+2·half_spread); x2 = fully-hedged (4 fills). net INTERNAL.',
      hl_note: 'HL PARTIAL — top-17 by OI backfilled; tail (~35 lower-OI perps, mostly < $5M/leg) deferred to forward-accumulation.',
      survivorship_note: 'Universe = current top-N by OI ≥ $5M/leg (survivorship-biased toward listings alive today); forward accumulation cures it.',
      coverage, cells, naive_portfolio_ranker_must_beat: naive, beta_to_btc: beta,
    };
    console.log(JSON.stringify(report));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  void runScript('funding-baseline-report', main); // OPS-SCRIPT-EXIT-LIFECYCLE-W1
}

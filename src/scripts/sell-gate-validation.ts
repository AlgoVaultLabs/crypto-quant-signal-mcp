#!/usr/bin/env npx tsx
/**
 * sell-gate-validation.ts — SIGNAL-SELL-GATE-SYMMETRY-W1 CH1.
 *
 * Adjudicates the pre-registered grid in
 * `<vault>/audits/SIGNAL-SELL-GATE-SYMMETRY-W1-2026-08-22.md` (frozen 2026-08-22T08:04:08Z,
 * amended 08:12:23Z, both BEFORE any measurement ran).
 *
 * ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────────────────────
 * It does not re-implement the scorer. `computeIndicatorScores` / `deriveVerdict` are imported
 * from `get-trade-call.ts`, and Wilson CI + Benjamini-Hochberg + walk-forward come from the
 * shipped `edgeMetricReport()` in `calibration-audit.ts`. No statistics are re-derived here.
 *
 * ── THE DEGENERACY THIS AVOIDS, AND WHY IT MATTERS ───────────────────────────────────────────
 * A SELL-ONLY cell cannot show excess edge. `naiveRate = max(up, n-up)/n` is the best fixed
 * direction on the same rows, so on an all-SELL population the engine IS always-SELL and excess
 * is <= 0 identically. A harness that fed SELL-only cells to edgeMetricReport would print a
 * guaranteed null and look rigorous doing it.
 *
 *   F1 (DECISION, FDR-gated) — population = ALL directional emissions at (tf, sellThreshold).
 *                              Lowering the threshold changes the MIX; that is the real effect.
 *   F2 (DESCRIPTIVE)         — admitted-SELL down-rate vs that timeframe's own base down-rate.
 *                              This re-derives SIGNAL-VERDICT-MIX-REPLAY-W1 R3's +15.38 rather
 *                              than inheriting it. It CANNOT qualify a cell.
 *
 * Read-only: reads a scratch corpus, writes nothing but stdout.
 */
import { readFileSync } from 'node:fs';
import { computeIndicatorScores, deriveVerdict } from '../tools/get-trade-call.js';
import { edgeMetricReport, type EdgeCell } from './calibration-audit.js';
import { R4_DEFAULTS, R4_DIRECTION_THRESHOLDS } from '../lib/r4-relax-flag.js';
import { FUNDING_Z_WINDOW_DAYS } from '../lib/funding-window.js';
import { intervalMsFor } from '../lib/candle-guard.js';

const DATA = process.env.SGS_DATA ?? '/tmp/sgs-data';
const FUNDING_CSV = process.env.SGS_FUNDING ?? '/tmp/sgs-funding.csv';

/** PRE-REGISTERED — not to be widened. `54` is the far side of the measured 19x cliff. */
export const THRESHOLDS = [55, 54, 50, 45, 40, 35] as const;
/** PRE-REGISTERED order: live 30-day emission volume, highest first. */
export const TF_ORDER = ['5m', '3m', '15m', '30m', '2h', '1h', '4h', '8h', '12h', '1d'] as const;
export const BUY_BASE = 40;          // get-trade-call.ts:173, read not assumed
export const FORWARD_BARS = 24;      // inherited from SIGNAL-VERDICT-MIX-REPLAY-W1
export const WINDOW_BARS = 99;       // production drops the in-progress bar
export const HOLDOUT_FRAC = 0.20;    // forward-only, most-recent 20% of origins
const FDR_Q = 0.05;
const MIN_N = 30;
/** Binance settles funding 8-hourly: 3 x 365. `binance.ts` annualizes with this factor. */
const ANNUALIZE = 1095;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
interface Acc { n: number; hits: number; up: number }
const mkAcc = (): Acc => ({ n: 0, hits: 0, up: 0 });

/**
 * REFUSES to aggregate across timeframes. The always-SELL base rate swings 45.59% -> 62.64%
 * across the horizons this wave pools over, so a pooled figure is an average of two opposite
 * regimes — it is what hid the sign flip that produced the predecessor wave. This throws rather
 * than returning a number, because a silently-averaged metric is indistinguishable from a real
 * one at the call site.
 */
export function assertSingleTimeframe(cells: { tf: string }[]): void {
  const tfs = [...new Set(cells.map((c) => c.tf))];
  if (tfs.length > 1) {
    throw new Error(`POOLED_METRIC_REFUSED: ${tfs.length} timeframes (${tfs.join(',')}) — base rates differ by ~17 points; report per timeframe`);
  }
}

/**
 * Forward-only split: the holdout is the most RECENT `frac` of origins, never interleaved.
 * Returns the first holdout index. `[0, start)` is train and `[start, count)` is holdout, so
 * the two are disjoint and exhaustive by construction.
 */
export function holdoutStartIndex(count: number, frac = HOLDOUT_FRAC): number {
  if (!(count > 0)) return 0;
  if (!(frac > 0 && frac < 1)) throw new Error(`BAD_HOLDOUT_FRAC: ${frac}`);
  return Math.floor(count * (1 - frac));
}

/** Sample stddev z of `rate` against the trailing FUNDING_Z_WINDOW_DAYS of hourly samples. */
function fundingZ(times: number[], rates: number[], idx: number, rate: number): number | null {
  const from = times[idx] - FUNDING_Z_WINDOW_DAYS * 86400;
  let lo = idx;
  while (lo > 0 && times[lo - 1] >= from) lo--;
  const n = idx - lo + 1;
  if (n < 20) return null;
  let sum = 0;
  for (let i = lo; i <= idx; i++) sum += rates[i];
  const mean = sum / n;
  let v = 0;
  for (let i = lo; i <= idx; i++) v += (rates[i] - mean) ** 2;
  const sd = Math.sqrt(v / (n - 1));
  return sd > 0 ? (rate - mean) / sd : null;
}

/** Index of the last funding sample at or before `atSec`, or -1. */
function fundingIdx(times: number[], atSec: number): number {
  let lo = 0, hi = times.length - 1, best = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (times[m] <= atSec) { best = m; lo = m + 1; } else hi = m - 1;
  }
  return best;
}

function loadFunding(): Map<string, { t: number[]; r: number[] }> {
  const out = new Map<string, { t: number[]; r: number[] }>();
  for (const line of readFileSync(FUNDING_CSV, 'utf8').split('\n')) {
    if (!line) continue;
    const [coin, hr, rate] = line.split(',');
    if (!coin || !hr || rate === undefined) continue;
    let e = out.get(coin);
    if (!e) { e = { t: [], r: [] }; out.set(coin, e); }
    e.t.push(Number(hr)); e.r.push(Number(rate));
  }
  return out;
}

export interface CellStats {
  key: string; tf: string; variant: string;
  full: Acc; train: Acc; holdout: Acc;
  /** blast radius (AC1.8) */
  sells: number; buys: number; volFloor: number; rsiNeutral: number;
  /** F2 descriptive */
  sellDown: number;
}

function main(): number {
  const series: Record<string, Candle[]> = JSON.parse(readFileSync(`${DATA}/series.json`, 'utf8'));
  const funding = loadFunding();

  // Uniform instrument: every origin must sit inside the funding-available window (AMENDMENT A2).
  let fundMin = Infinity, fundMax = -Infinity;
  for (const f of funding.values()) { fundMin = Math.min(fundMin, f.t[0]); fundMax = Math.max(fundMax, f.t[f.t.length - 1]); }
  const fundMinMs = fundMin * 1000;

  const cells = new Map<string, CellStats>();
  const cell = (tf: string, variant: string): CellStats => {
    const key = `${tf}|${variant}`;
    let c = cells.get(key);
    if (!c) {
      c = { key, tf, variant, full: mkAcc(), train: mkAcc(), holdout: mkAcc(), sells: 0, buys: 0, volFloor: 0, rsiNeutral: 0, sellDown: 0 };
      cells.set(key, c);
    }
    return c;
  };
  /** Per-timeframe base rates over ALL origins — F2's denominator. */
  const tfBase = new Map<string, { n: number; down: number }>();
  const originCount = new Map<string, number>();

  const variants: { name: string; sell: number; r4: typeof R4_DEFAULTS }[] = [
    ...THRESHOLDS.map((t) => ({ name: `sell${t}`, sell: t, r4: R4_DEFAULTS })),
    { name: 'r4-sell-revert', sell: 55, r4: R4_DIRECTION_THRESHOLDS['sell-revert'] },
  ];

  for (const [skey, allRaw] of Object.entries(series)) {
    const [coin, tf] = skey.split('|');
    if (!TF_ORDER.includes(tf as typeof TF_ORDER[number])) continue;
    const iv = intervalMsFor(tf);
    const f = funding.get(coin);
    if (!iv || !f) continue;

    const all = allRaw.filter((c) => c.time >= fundMinMs).sort((a, b) => a.time - b.time);
    const barsPerDay = Math.max(1, Math.round(86_400_000 / iv));

    // Enumerate origins first so the holdout is the most recent 20% BY ORIGIN, forward-only.
    const origins: number[] = [];
    for (let i = WINDOW_BARS; i + FORWARD_BARS - 1 < all.length; i++) origins.push(i);
    if (origins.length === 0) continue;
    originCount.set(tf, (originCount.get(tf) ?? 0) + origins.length);
    const holdoutStart = holdoutStartIndex(origins.length);

    for (let oi = 0; oi < origins.length; oi++) {
      const i = origins[oi];
      const win = all.slice(i - WINDOW_BARS, i);
      const entry = all[i - 1];
      const exit = all[i + FORWARD_BARS - 1];
      if (!entry || !exit) continue;

      const atSec = Math.floor(entry.time / 1000);
      const fi = fundingIdx(f.t, atSec);
      if (fi < 0) continue;
      const annual = f.r[fi] * ANNUALIZE;
      const z = fundingZ(f.t, f.r, fi, f.r[fi]);

      const dayAgo = all[i - 1 - barsPerDay];
      const priceChange = dayAgo ? (entry.close - dayAgo.close) / dayAgo.close : 0;

      // Scores are THRESHOLD-INDEPENDENT — computed once, reused across all 7 variants.
      const s = computeIndicatorScores({
        candles: win, fundingRateAnnualized: annual, priceChange, openInterest: 1, trendMode: false,
      });

      const wentUp = exit.close > entry.close;
      const isHoldout = oi >= holdoutStart;
      const b = tfBase.get(tf) ?? { n: 0, down: 0 };
      b.n++; if (!wentUp) b.down++; tfBase.set(tf, b);

      for (const v of variants) {
        const out = deriveVerdict(s, {
          fundingZScore: z, fundingRateAnnualized: annual, hurstVal: s.hurstVal,
          squeezeActive: s.squeezeActive, r4Thresholds: v.r4,
          buyThreshold: BUY_BASE, sellThreshold: v.sell,
        });
        if (out.signal !== 'BUY' && out.signal !== 'SELL') continue;
        const c = cell(tf, v.name);
        const hit = out.signal === 'BUY' ? wentUp : !wentUp;
        for (const acc of [c.full, isHoldout ? c.holdout : c.train]) {
          acc.n++; if (hit) acc.hits++; if (wentUp) acc.up++;
        }
        if (out.signal === 'SELL') {
          c.sells++;
          if (!wentUp) c.sellDown++;
          if (s.volumeScore === -70) c.volFloor++;
          if (s.rsiScore === 0) c.rsiNeutral++;
        } else c.buys++;
      }
    }
  }

  // ── F1: the FDR-gated decision family ──────────────────────────────────────────────────────
  const list = [...cells.values()];
  const edgeCells: EdgeCell[] = list.map((c) => ({
    key: c.key,
    full: { n: c.full.n, engineHits: c.full.hits, upCount: c.full.up },
    train: { n: c.train.n, engineHits: c.train.hits, upCount: c.train.up },
    holdout: { n: c.holdout.n, engineHits: c.holdout.hits, upCount: c.holdout.up },
  }));
  const report = edgeMetricReport(edgeCells, { q: FDR_Q, minN: MIN_N });

  const pct = (x: number, n: number) => (n > 0 ? (100 * x / n).toFixed(2) : '  -  ');
  console.log('\n================ CORPUS ================');
  console.log(`funding window : ${new Date(fundMin * 1000).toISOString().slice(0, 10)} -> ${new Date(fundMax * 1000).toISOString().slice(0, 10)}`);
  console.log('tf    origins   base_down%');
  for (const tf of TF_ORDER) {
    const b = tfBase.get(tf);
    console.log(`${tf.padEnd(5)} ${String(originCount.get(tf) ?? 0).padStart(7)}   ${b ? pct(b.down, b.n) : '  -  '}%`);
  }

  console.log('\n================ F1 — DECISION METRIC (FDR-gated) ================');
  console.log(`family=${report.familySize} q=${report.q} minN=${report.minN} rawPass=${report.rawPass} fdrPass=${report.fdrPass} bonf=${report.bonferroniPass} VALIDATED=${report.validated}`);
  console.log(`VERDICT: ${report.verdict}`);
  console.log('\ncell                  n    engine%   naive%   excess    z     fdr   hoN   hoExcess  VALID');
  for (const c of report.cells) {
    console.log(
      `${c.key.padEnd(20)} ${String(c.n).padStart(6)} ${(100 * c.realizedHit).toFixed(2).padStart(8)} ${(100 * c.naive).toFixed(2).padStart(8)} ` +
      `${(100 * c.excess).toFixed(2).padStart(8)} ${c.z.toFixed(2).padStart(6)} ${String(c.fdrReject).padStart(6)} ${String(c.holdoutN).padStart(5)} ` +
      `${(100 * c.holdoutExcess).toFixed(2).padStart(9)} ${c.validated ? ' ***VALIDATED***' : ''}`,
    );
  }
  const excluded = list.filter((c) => c.full.n < MIN_N);
  if (excluded.length) {
    console.log(`\nEXCLUDED for power (n < ${MIN_N}) — reported as insufficient power, NOT as a negative result:`);
    for (const c of excluded) console.log(`  ${c.key.padEnd(20)} n=${c.full.n}`);
  }

  console.log('\n================ AC1.8 — BLAST RADIUS + F2 DESCRIPTIVE ================');
  console.log('cell                 SELLs   BUYs   volFloor%  rsiNeut%   F2:sellDown%  tfBaseDown%   F2excess');
  for (const tf of TF_ORDER) {
    // Load-bearing, not decorative: every figure below is compared against THIS timeframe's own
    // base rate, so the guard fires if a refactor ever widens this loop's collection.
    assertSingleTimeframe([...cells.values()].filter((c) => c.tf === tf));
    for (const v of variants) {
      const c = cells.get(`${tf}|${v.name}`);
      if (!c) continue;
      const b = tfBase.get(tf);
      const base = b && b.n > 0 ? 100 * b.down / b.n : 0;
      const sd = c.sells > 0 ? 100 * c.sellDown / c.sells : 0;
      console.log(
        `${c.key.padEnd(20)} ${String(c.sells).padStart(6)} ${String(c.buys).padStart(6)} ` +
        `${pct(c.volFloor, c.sells).padStart(9)}% ${pct(c.rsiNeutral, c.sells).padStart(8)}% ` +
        `${(c.sells ? sd.toFixed(2) : '  -  ').padStart(12)}% ${base.toFixed(2).padStart(10)}% ` +
        `${(c.sells ? (sd - base).toFixed(2) : '  -  ').padStart(10)}`,
      );
    }
  }

  console.log('\n================ 55 -> 54 DISCONTINUITY (per TF) ================');
  console.log('tf     SELLs@55  SELLs@54   multiple');
  for (const tf of TF_ORDER) {
    const a = cells.get(`${tf}|sell55`)?.sells ?? 0;
    const b = cells.get(`${tf}|sell54`)?.sells ?? 0;
    console.log(`${tf.padEnd(6)} ${String(a).padStart(8)} ${String(b).padStart(9)}   ${a > 0 ? (b / a).toFixed(1) + 'x' : b > 0 ? 'inf (0 at 55)' : 'n/a'}`);
  }

  console.log(`\nSELL_GATE_VALIDATION_VERDICT=${report.validated > 0 ? 'EDGE-FOUND' : 'NO-VALIDATED-CELL'}`);
  return 0;
}

// Guarded with the `process.argv[1]` idiom — one of the four `check-entrypoint-guards.mjs`
// accepts — rather than `require.main === module`, which `script-exit-lifecycle-canary` would
// then require to terminate through runScript(). This opens no pool and returns its own code.
if (process.argv[1]?.endsWith('sell-gate-validation.ts') || process.argv[1]?.endsWith('sell-gate-validation.js')) {
  process.exit(main());
}

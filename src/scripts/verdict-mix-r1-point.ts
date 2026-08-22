#!/usr/bin/env npx tsx
/**
 * verdict-mix-r1-point.ts — SIGNAL-VERDICT-MIX-REPLAY-W1 R1, the DISCRIMINATING fidelity gate.
 *
 * ── WHY THIS REPLACES THE CONTAINMENT GATE ───────────────────────────────────────────────────
 * The first R1 asked whether the stored |rawScore| fell inside the interval the replay could
 * reach across every unreconstructable funding/OI value. It passed at 100% — and then the
 * deliberate-break proof showed it ALSO passed at 100% with the window shifted 1, 6 and even 24
 * bars into the past (99.71%). Mean interval width was 48 of a possible 89 raw points, so
 * containment simply could not discriminate. A gate that passes a 24-hour window error is not a
 * gate, and loosening or accepting it would have been the exact failure R1 exists to prevent.
 *
 * This version reconstructs the remaining inputs and compares a POINT estimate:
 *   funding  — nearest `funding_history` sample at or before the bar; Binance annualizes ×1095
 *   fundingZ — (rate − mean) / sample-stddev over FUNDING_Z_WINDOW_DAYS = 14
 *   oi       — used by the scorer only as a `> 0` boolean gate, so no value is needed
 *   priceChange — 24h close-to-close from the same kline series
 *
 * TOLERANCE, STATED BEFORE RUNNING: >= 90% of rows must land with the replayed |rawScore| inside
 * the stored confidence band. The band is +/-0.445 raw points wide (confidence is a rounded
 * integer percentage of 89), so this is a tight point test, not a containment test. The 10%
 * allowance covers funding-sampling error near a bucket boundary and 24h-window approximation —
 * both named, both bounded. The gate is only meaningful if it FAILS under a wrong window, so
 * `R1_SHIFT` must drive it well below the threshold; that proof runs alongside the real result.
 */
import { readFileSync } from 'node:fs';
import { parseShadowCsv, storedRawBand, windowAt, loadCandlesCsv } from './verdict-mix-replay.js';
import { computeIndicatorScores, deriveVerdict } from '../tools/get-trade-call.js';
import { getR4Thresholds } from '../lib/r4-relax-flag.js';
import { FUNDING_Z_WINDOW_DAYS } from '../lib/funding-window.js';

const DATA = process.env.R1_DATA ?? '/tmp/r1data';
const TOLERANCE = 0.90;
const SHIFT = Number(process.env.R1_SHIFT ?? 0);
const IV_MS: Record<string, number> = { '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
/** Binance funding settles 8-hourly: 3 × 365. `binance.ts:322` — `fundingRaw * 1095`. */
const ANNUALIZE = 1095;

interface F { rate: number; at: number }

function loadFunding(path: string): Map<string, F[]> {
  const out = new Map<string, F[]>();
  for (const line of readFileSync(path, 'utf8').trim().split('\n').slice(1)) {
    if (!line) continue;
    const [coin, rate, at] = line.split(',');
    if (!out.has(coin)) out.set(coin, []);
    out.get(coin)!.push({ rate: Number(rate), at: Number(at) });
  }
  for (const a of out.values()) a.sort((x, y) => x.at - y.at);
  return out;
}

/** Nearest sample at or before `atSec`, by binary search. */
function fundingAt(arr: F[], atSec: number): F | null {
  let lo = 0, hi = arr.length - 1, best: F | null = null;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (arr[m].at <= atSec) { best = arr[m]; lo = m + 1; } else hi = m - 1;
  }
  return best;
}

/** z of `rate` against the trailing FUNDING_Z_WINDOW_DAYS, sample stddev (matches STDDEV_SAMP). */
function fundingZ(arr: F[], atSec: number, rate: number): number | null {
  const from = atSec - FUNDING_Z_WINDOW_DAYS * 86400;
  const win = arr.filter((f) => f.at >= from && f.at <= atSec);
  if (win.length < 20) return null;
  const mean = win.reduce((a, f) => a + f.rate, 0) / win.length;
  const varr = win.reduce((a, f) => a + (f.rate - mean) ** 2, 0) / (win.length - 1);
  const sd = Math.sqrt(varr);
  if (!(sd > 0)) return null;
  return (rate - mean) / sd;
}

function main(): number {
  const shadow = parseShadowCsv(readFileSync(`${DATA}/shadow.csv`, 'utf8'));
  const candles = loadCandlesCsv(`${DATA}/klines.csv`);
  const funding = loadFunding(`${DATA}/funding.csv`);

  let considered = 0, hit = 0, miss = 0, skipped = 0;
  const errs: number[] = [];
  const examples: string[] = [];

  for (const row of shadow) {
    const all = candles.get(`${row.symbol}|${row.timeframe}`);
    const iv = IV_MS[row.timeframe];
    const fa = funding.get(row.symbol);
    if (!all || !iv || !fa) { skipped++; continue; }

    const at = row.ts - SHIFT * iv;
    const win = windowAt(all, at, iv);
    if (win.length < 30) { skipped++; continue; }

    const atSec = Math.floor(at / 1000);
    const f = fundingAt(fa, atSec);
    if (!f) { skipped++; continue; }
    const annual = f.rate * ANNUALIZE;
    const z = fundingZ(fa, atSec, f.rate);

    // 24h close-to-close from the same series — the venue's rolling 24h open is not stored.
    const cur = win[win.length - 1].close;
    const dayAgo = all.filter((c) => c.time + iv <= at - 86_400_000).slice(-1)[0];
    const priceChange = dayAgo ? (cur - dayAgo.close) / dayAgo.close : 0;

    const s = computeIndicatorScores({
      candles: win, fundingRateAnnualized: annual, priceChange, openInterest: 1, trendMode: false,
    });
    const v = deriveVerdict(s, {
      fundingZScore: z, fundingRateAnnualized: annual, hurstVal: s.hurstVal,
      squeezeActive: s.squeezeActive, r4Thresholds: getR4Thresholds(),
      buyThreshold: 40, sellThreshold: 55,
    });

    const band = storedRawBand(row.conf);
    const abs = Math.abs(v.rawScore);
    const inBand = abs >= band.lo && abs <= band.hi;
    considered++;
    if (inBand) hit++; else {
      miss++;
      const centre = band.hi === Infinity ? band.lo : (band.lo + band.hi) / 2;
      errs.push(Math.abs(abs - centre));
      if (examples.length < 5) {
        examples.push(`${row.symbol}/${row.timeframe} conf=${row.conf} stored|raw|~${centre.toFixed(1)} replayed=${abs.toFixed(2)} z=${z === null ? 'null' : z.toFixed(2)} fundAnn=${annual.toFixed(2)}`);
      }
    }
  }

  const pct = considered ? hit / considered : 0;
  const medErr = errs.length ? errs.sort((a, b) => a - b)[Math.floor(errs.length / 2)] : 0;
  console.log('');
  if (SHIFT) console.log(`⚠️  MUST-FAIL MODE: window shifted back ${SHIFT} bars — a PASS here means the gate is vacuous`);
  console.log(`considered   : ${considered}   skipped: ${skipped}`);
  console.log(`POINT match  : ${hit}  (${(100 * pct).toFixed(2)}%)   miss: ${miss}`);
  console.log(`median |err| on misses: ${medErr.toFixed(2)} raw pts`);
  if (examples.length) { console.log('miss examples:'); for (const e of examples) console.log(`  ${e}`); }
  console.log(`tolerance (pre-stated): >= ${(100 * TOLERANCE).toFixed(0)}%`);
  if (pct >= TOLERANCE) { console.log('R1_POINT_VERDICT=PASS'); return 0; }
  console.log('R1_POINT_VERDICT=FAIL');
  return 1;
}

// Deliberately NOT `runScript()`: this is a GATE, and its exit code IS its verdict
// (0 PASS / 1 FAIL / 3 INDETERMINATE). runScript collapses every outcome to 0-or-1, which
// would erase the INDETERMINATE code. It opens no pool and cannot hang, so the zombie
// class `script-exit-lifecycle-canary` guards against is not reachable here.
process.exit(main());

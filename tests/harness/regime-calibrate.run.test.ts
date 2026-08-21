/**
 * regime-calibrate.run.test.ts — SIGNAL-REGIME-LABEL-RULE-FIX-W1-V2, B/K calibration.
 *
 * Gated behind `REGIME_CALIBRATE=1`; never runs in CI or the pre-push gate.
 *
 * Two things happen here, in this order, and the order is the point:
 *   1. the |sep| histogram is plotted BEFORE any threshold is chosen, so the band cannot be
 *      placed on a mass point (the predecessor's discrete-score-space lesson: a threshold
 *      chosen without looking at the local neighbourhood is a cliff edge wearing a
 *      calibration's clothes);
 *   2. only then is (B, K) swept, with `lag` MEASURED per candidate on the deterministic
 *      reversal fixture rather than assumed — adding a confirmation delay changes the
 *      detection lag, so reusing the predecessor's 11.64 would be measuring the wrong rule.
 */
import { describe, it } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { getAdapter } from '../../src/lib/exchange-adapter.js';
import { runAsBatch } from '../../src/lib/upstream-weight-budget.js';
import { ema, atr } from '../../src/lib/indicators.js';
import type { Candle, ExchangeId, RegimeType } from '../../src/types.js';
import * as H from './regime-replay.js';

const ENABLED = process.env.REGIME_CALIBRATE === '1';
const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'ADA', 'AVAX'];
const TFS: Array<[string, number, number]> = [
  ['15m', 900_000, 30],
  ['1h', 3_600_000, 60],
  ['4h', 14_400_000, 90],
];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function fetchSeries(venue: ExchangeId, coin: string, tf: string, tfMs: number, days: number): Promise<Candle[]> {
  const end = Date.now();
  const start = end - days * 86_400_000;
  const adapter = getAdapter(venue);
  const cache = new Map<number, Candle>();
  let cursor = start;
  for (let page = 0; page < 40 && cursor <= end; page++) {
    const rows = await adapter.getCandles(coin, tf, cursor, undefined, end);
    if (!rows?.length) break;
    let maxTime = cursor;
    for (const c of rows) {
      if (c.time >= start && c.time <= end) cache.set(c.time, c);
      if (c.time > maxTime) maxTime = c.time;
    }
    if (maxTime <= cursor) break;
    cursor = maxTime + tfMs;
    await sleep(200);
  }
  return [...cache.values()].sort((a, b) => a.time - b.time);
}

/**
 * Separation of the EMA pair NORMALISED BY ATRP — i.e. in units of the asset's own recent
 * range. This is the quantity the band is a threshold on, so it is the quantity whose
 * histogram must be flat where the multiplier lands.
 */
function sepAt(candles: Candle[], i: number): number | null {
  const start = Math.max(0, i - H.PRODUCTION_WINDOW_BARS + 1);
  const win = candles.slice(start, i + 1);
  const closes = win.map((c) => c.close);
  const f = ema(closes, H.EMA_FAST);
  const s = ema(closes, H.EMA_SLOW);
  if (!f || !s) return null;
  const a = f[f.length - 1];
  const b = s[s.length - 1];
  if (isNaN(a) || isNaN(b) || b === 0) return null;
  const av = atr(win.map((c) => c.high), win.map((c) => c.low), closes, 14);
  const last = closes[closes.length - 1];
  if (av === null || !(last > 0)) return null;
  const atrp = av / last;
  if (!(atrp > 0)) return null;
  return ((a - b) / b) / atrp;   // separation measured in ATRs
}

/** The CANDIDATE rule: separation band + K-bar confirmation, no RSI veto. */
function candidateSeries(candles: Candle[], bandMult: number, confirmBars: number): RegimeType[] {
  const band = bandMult;
  const sides: number[] = []; // +1 / -1 / 0 (contested)
  for (let i = 0; i < candles.length; i++) {
    const sep = sepAt(candles, i);
    sides.push(sep === null ? 0 : Math.abs(sep) < band ? 0 : Math.sign(sep));
  }
  const out: RegimeType[] = [];
  let held: RegimeType = 'RANGING';
  for (let i = 0; i < candles.length; i++) {
    if (i >= confirmBars - 1) {
      const w = sides.slice(i - confirmBars + 1, i + 1);
      if (w.every((v) => v === w[0])) {
        held = w[0] > 0 ? 'TRENDING_UP' : w[0] < 0 ? 'TRENDING_DOWN' : 'RANGING';
      }
    }
    out.push(held);
  }
  return out;
}

function metricsOf(labels: RegimeType[], from: number, to: number, roundTripWindow = 10) {
  const idx: number[] = [];
  for (let i = from + 1; i < to; i++) if (labels[i] !== labels[i - 1]) idx.push(i);
  const dwell: number[] = [];
  for (let k = 1; k < idx.length; k++) dwell.push(idx[k] - idx[k - 1]);
  dwell.sort((a, b) => a - b);
  let rt = 0;
  for (let k = 0; k < idx.length; k++) {
    for (let m = k + 1; m < idx.length; m++) {
      if (idx[m] - idx[k] > roundTripWindow) break;
      if (labels[idx[m]] === labels[idx[k] - 1]) { rt += 1; break; }
    }
  }
  const bars = to - from;
  return {
    flips_per_100: bars > 0 ? (idx.length * 100) / bars : 0,
    n_flips: idx.length,
    dwell_p50: dwell.length ? dwell[Math.floor(dwell.length / 2)] : null,
    round_trip: idx.length ? rt / idx.length : null,
  };
}

/** MEASURED detection lag: bars from the reversal to the label flip, on the deterministic fixture. */
function measuredLag(bandBps: number, confirmBars: number): number | null {
  const s = H.trendReversalSeries(260, 1.0);
  const labels = candidateSeries(s, bandBps, confirmBars);
  const reversalBar = 259;
  for (let i = reversalBar; i < labels.length; i++) {
    if (labels[i] === 'TRENDING_DOWN') return i - reversalBar;
  }
  return null;
}

describe.skipIf(!ENABLED)('regime rule calibration', () => {
  it('plots the |sep| histogram, then sweeps (B, K)', { timeout: 3_600_000 }, async () => {
    const series: Array<{ coin: string; tf: string; candles: Candle[] }> = [];
    await runAsBatch(async () => {
      for (const coin of ASSETS) {
        for (const [tf, tfMs, days] of TFS) {
          const c = await fetchSeries('HL', coin, tf, tfMs, days);
          series.push({ coin, tf, candles: c });
          console.log(`fetched ${coin}/${tf}: ${c.length} bars`);
        }
      }
    }, 'regime-calibrate');

    // ── 1. HISTOGRAM FIRST ────────────────────────────────────────────────
    const allSepBps: number[] = [];
    for (const s of series) {
      for (let i = H.EDGE_DISCARD_BARS; i < s.candles.length - H.EDGE_DISCARD_BARS; i++) {
        const v = sepAt(s.candles, i);
        if (v !== null) allSepBps.push(Math.abs(v));
      }
    }
    allSepBps.sort((a, b) => a - b);
    const q = (p: number): number => allSepBps[Math.floor((p / 100) * allSepBps.length)];
    console.log(`\n=== |sep| / ATRP DISTRIBUTION (in ATRs), n=${allSepBps.length} ===`);
    for (const p of [1, 5, 10, 15, 20, 25, 30, 40, 50, 75, 90]) {
      console.log(`  p${p} = ${q(p).toFixed(3)} ATR`);
    }
    console.log('\n=== LOCAL HISTOGRAM 0.00-0.60 ATR (flatness — the multiplier must not land on a spike) ===');
    for (let lo = 0; lo < 0.60; lo += 0.05) {
      const n = allSepBps.filter((v) => v >= lo && v < lo + 0.05).length;
      const pctOfAll = (100 * n) / allSepBps.length;
      console.log(`  [${lo.toFixed(2)},${(lo + 0.05).toFixed(2)}) ATR: ${String(n).padStart(6)}  ${pctOfAll.toFixed(2)}%  ${'#'.repeat(Math.round(pctOfAll))}`);
    }

    // ── 2. ONLY NOW sweep (B, K) ──────────────────────────────────────────
    console.log('\n=== (B,K) SWEEP — lag MEASURED per candidate, not assumed ===');
    console.log('    B    K    lag  dwell_p50  dwell/lag  flips/100  round_trip');
    const rows: Array<Record<string, unknown>> = [];
    for (const B of [0.05, 0.10, 0.15, 0.20, 0.30, 0.45]) {
      for (const K of [12]) {
        const lag = measuredLag(B, K);
        const agg = { flips: [] as number[], dwell: [] as number[], rt: [] as number[] };
        for (const s of series) {
          const labels = candidateSeries(s.candles, B, K);
          const m = metricsOf(labels, H.EDGE_DISCARD_BARS, s.candles.length - H.EDGE_DISCARD_BARS);
          agg.flips.push(m.flips_per_100);
          if (m.dwell_p50 !== null) agg.dwell.push(m.dwell_p50);
          if (m.round_trip !== null) agg.rt.push(m.round_trip);
        }
        const med = (a: number[]): number => { const x = [...a].sort((p, r) => p - r); return x.length ? x[Math.floor(x.length / 2)] : NaN; };
        const dwell = med(agg.dwell);
        const ratio = lag !== null && lag > 0 ? dwell / lag : NaN;
        let up=0, dn=0, rg=0, tot=0;
        for (const s2 of series) {
          const labels = candidateSeries(s2.candles, B, K);
          for (let i = H.EDGE_DISCARD_BARS; i < s2.candles.length - H.EDGE_DISCARD_BARS; i++) {
            tot++; if (labels[i]==='TRENDING_UP') up++; else if (labels[i]==='TRENDING_DOWN') dn++; else rg++;
          }
        }
        const perTf: Record<string, {rg:number; tot:number}> = {};
        for (const s2 of series) {
          const labels = candidateSeries(s2.candles, B, K);
          perTf[s2.tf] ??= {rg:0, tot:0};
          for (let i = H.EDGE_DISCARD_BARS; i < s2.candles.length - H.EDGE_DISCARD_BARS; i++) {
            perTf[s2.tf].tot++; if (labels[i]==='RANGING') perTf[s2.tf].rg++;
          }
        }
        const tfShare = Object.fromEntries(Object.entries(perTf).map(([k,v]) => [k, Number((100*v.rg/v.tot).toFixed(1))]));
        const vals = Object.values(tfShare) as number[];
        const spread = Math.max(...vals) - Math.min(...vals);
        rows.push({ B, K, lag, dwell_p50: dwell, dwell_over_lag: ratio, flips_per_100: med(agg.flips), round_trip: med(agg.rt),
                    share_up: up/tot, share_down: dn/tot, share_ranging: rg/tot,
                    ranging_by_tf: tfShare, I7_spread_pp: Number(spread.toFixed(1)),
                    trend_claim_by_tf: Object.fromEntries(Object.entries(tfShare).map(([k,v]) => [k, Number((100-(v as number)).toFixed(1))])) });
        console.log(
          `  ${String(B).padStart(4)} ${String(K).padStart(4)} ${String(lag ?? '-').padStart(6)} ${String(dwell).padStart(10)} ${ratio.toFixed(3).padStart(10)} ${med(agg.flips).toFixed(2).padStart(10)} ${med(agg.rt).toFixed(3).padStart(11)}`,
        );
      }
    }
    mkdirSync(resolve(process.cwd(), 'audits'), { recursive: true });
    writeFileSync(
      resolve(process.cwd(), 'audits/regime-rule-calibration-atr-2026-08-07.json'),
      JSON.stringify({ sep_percentiles: Object.fromEntries([1, 5, 10, 15, 20, 25, 30, 40, 50, 75, 90].map((p) => [`p${p}`, q(p)])), n_sep_samples: allSepBps.length, sweep: rows }, null, 2),
    );
    console.log('\nWROTE audits/regime-rule-calibration-atr-2026-08-07.json');
  });
});

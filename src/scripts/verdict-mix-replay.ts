#!/usr/bin/env npx tsx
/**
 * verdict-mix-replay.ts — SIGNAL-VERDICT-MIX-REPLAY-W1
 *
 * Scores historical bars under BOTH states of SIGNAL-TREND-BLINDNESS-FIX-W1's trend-mode flag.
 *
 * ── WHY THIS IS NOT `scripts/backtest.ts` ────────────────────────────────────────────────────
 * That file walks bars, but its own header says the scoring is "replicated verbatim" — it is a
 * HAND-COPIED fork of the scorer, and a stale one. Measured at Step-0: its RSI ladder has FIVE
 * rungs against production's SEVEN, missing `< 25 → +100` and `> 75 → −100` — which are exactly
 * the rungs trend mode flips. It carries no `WEIGHTS`, no thresholds and no regime, and cites
 * `src/tools/get-trade-signal.ts`, a path renamed away. Extending it would replay a rule
 * production has never run, blind to the region under test.
 *
 * This file imports `computeIndicatorScores` and `deriveVerdict` — the REAL exported functions —
 * so it is not a second derivation. It is the first replay that honours the single-derivation law.
 *
 * ── WHY THE FLAG NEEDS NO ENV MANIPULATION ───────────────────────────────────────────────────
 * `IndicatorInputs.trendMode?: boolean` is an INJECTED optional field. Production reads the env
 * once at its own call site and passes the boolean in; a replay simply passes both values. The
 * two arms therefore differ in exactly one input, which is what makes the delta exact.
 *
 * ── READ-ONLY ────────────────────────────────────────────────────────────────────────────────
 * Fetches public klines and reads pre-extracted CSVs. Touches no database, writes no repo file,
 * and cannot reach an anchored row.
 */
import { readFileSync } from 'node:fs';
import { computeIndicatorScores, deriveVerdict } from '../tools/get-trade-call.js';
import { getR4Thresholds } from '../lib/r4-relax-flag.js';
import { splitCandleWindow } from '../lib/candle-window.js';
import type { Candle, RegimeType, SignalVerdict } from '../types.js';

// ── Sweep points for the terms this replay CANNOT reconstruct ───────────────────────────────
// These are INPUT values chosen to land on each ladder rung, not a copy of the scoring rule:
// nothing here computes a score. The achievable-score set is enumerated by running the REAL
// `deriveVerdict` at each combination, so the adjustment logic is never restated.
const W = { rsi: 0.30, ema: 0.10, funding: 0.25, oi: 0.15, volume: 0.20 } as const;
/** One representative annualized funding per `fundingScore` rung (80/40/0/-40/-80). */
const FUNDING_SWEEP = [-10, -2, 0, 6, 10];
/** One representative 24h priceChange per `oiScore` rung (60/20/0/-20/-60). */
const PRICE_CHANGE_SWEEP = [0.03, 0.01, 0, -0.01, -0.03];
/** Spans every `fundingZScore` branch in `deriveVerdict`, including the null fallback. */
const FUNDING_Z_SWEEP: Array<number | null> = [null, -3, -1.6, 0, 2, 3];
const MAX_RAW_SCORE = 89;

export interface ShadowRow {
  ts: number; exchange: string; symbol: string; timeframe: string;
  call: SignalVerdict; conf: number;
}

export function parseShadowCsv(text: string): ShadowRow[] {
  const [, ...lines] = text.trim().split('\n');
  return lines.filter(Boolean).map((l) => {
    const [ts, exchange, symbol, timeframe, call, conf] = l.split(',');
    return {
      ts: Number(ts), exchange, symbol, timeframe,
      call: call as SignalVerdict, conf: Number(conf),
    };
  });
}

/**
 * The stored |rawScore|, recovered from the stored confidence.
 *
 * `confidence = min(round(|raw| / 89 * 100), 100)`, so a confidence of C implies
 * `|raw| ∈ [(C − 0.5)/100 × 89, (C + 0.5)/100 × 89)` — a band, never a point. Confidence 100 is
 * SATURATED (the min() clips), so it implies only `|raw| ≥ 99.5/100 × 89` with no upper bound.
 */
export function storedRawBand(conf: number): { lo: number; hi: number } {
  const lo = ((conf - 0.5) / 100) * MAX_RAW_SCORE;
  const hi = conf >= 100 ? Number.POSITIVE_INFINITY : ((conf + 0.5) / 100) * MAX_RAW_SCORE;
  return { lo: Math.max(0, lo), hi };
}

/**
 * The set of |rawScore| values this bar could actually produce, ENUMERATED by running the REAL
 * `deriveVerdict` across every value the unreconstructable terms can take.
 *
 * This is what makes R1 possible without reconstructing funding — and it is deliberately NOT a
 * hand-derived bound. An earlier draft summed the adjustment extremes by hand and produced an
 * interval of roughly [0, 86] against a stored |raw| <= 89: a gate that could not fail, and it
 * duly reported 100%. The terms that draft treated as uncertain include Hurst and squeeze, which
 * are CANDLE-DERIVED and therefore exact — taking them from the real bar is most of the tightening.
 */
export function achievableAbsRaw(
  s: ReturnType<typeof computeIndicatorScores>,
  buyThreshold = 40, sellThreshold = 55,
): { lo: number; hi: number; n: number } {
  const vals: number[] = [];
  for (const f of FUNDING_RUNG_SCORES) for (const o of OI_RUNG_SCORES) for (const z of FUNDING_Z_SWEEP) {
    for (const fr of FUNDING_SWEEP) {
      const v = deriveVerdict(
        { rsiScore: s.rsiScore, emaScore: s.emaScore, fundingScore: f, oiScore: o, volumeScore: s.volumeScore },
        {
          fundingZScore: z, fundingRateAnnualized: fr, hurstVal: s.hurstVal,
          squeezeActive: s.squeezeActive, r4Thresholds: getR4Thresholds(),
          buyThreshold, sellThreshold,
        },
      );
      vals.push(Math.abs(v.rawScore));
    }
  }
  return { lo: Math.min(...vals), hi: Math.max(...vals), n: vals.length };
}

/** The `fundingScore` / `oiScore` rungs, as the ladders emit them. */
const FUNDING_RUNG_SCORES = [80, 40, 0, -40, -80];
const OI_RUNG_SCORES = [60, 20, 0, -20, -60];

export interface ReplayedBar {
  ts: number; symbol: string; timeframe: string;
  regimeOff: RegimeType; regimeOn: RegimeType;
  rsiVal: number | null;
  certainOff: number; certainOn: number;
  scoresOff: ReturnType<typeof computeIndicatorScores>;
  scoresOn: ReturnType<typeof computeIndicatorScores>;
}

/** The weighted sum of ONLY the terms this replay reconstructs exactly. */
export function certainPart(s: { rsiScore: number; emaScore: number; volumeScore: number }): number {
  return s.rsiScore * W.rsi + s.emaScore * W.ema + s.volumeScore * W.volume;
}

/**
 * The exact window production scores at `atMs`, reconstructed from its own two steps:
 *
 *   1. fetch `startTime = atMs - 100 * intervalMs`, and the venue returns bars with
 *      `openTime >= startTime` (Binance semantics);
 *   2. `splitCandleWindow(..., atMs)` drops the IN-PROGRESS bar, leaving the closed ones.
 *
 * The result is **99** closed bars, not 100, and that off-by-one is load-bearing rather than
 * cosmetic. `hurstExponent` returns null below 100 closes, so at 99 bars production applies NO
 * Hurst adjustment — while a naive `slice(-100)` turns it ON and adds a ±10/±25 term production
 * never applied. Measured on BTC/1h ts=1786165266077: at 99 bars the achievable |raw| is
 * [0.0, 47.0] and contains the stored value; at 100 bars it is [10.0, 57.0] and excludes it.
 * R1 caught this, which is the entire reason R1 blocks R2-R4.
 */
export function windowAt(all: Candle[], atMs: number, intervalMs: number): Candle[] {
  const startTime = atMs - 100 * intervalMs;
  return all.filter((c) => c.time >= startTime && c.time + intervalMs <= atMs);
}

export function replayBar(
  candles: Candle[], atMs: number, intervalMs: number,
  fundingAnnualized: number, priceChange: number,
): ReplayedBar | null {
  const win = windowAt(candles, atMs, intervalMs);
  if (win.length < 30) return null;
  const common = { candles: win, fundingRateAnnualized: fundingAnnualized, priceChange, openInterest: 1 };
  const off = computeIndicatorScores({ ...common, trendMode: false });
  const on = computeIndicatorScores({ ...common, trendMode: true });
  return {
    ts: atMs, symbol: '', timeframe: '',
    regimeOff: off.regime, regimeOn: on.regime, rsiVal: off.rsiVal,
    certainOff: certainPart(off), certainOn: certainPart(on),
    scoresOff: off, scoresOn: on,
  };
}

/** Verdict under a given sell threshold — R3 sweeps this; production uses 55. */
export function verdictAt(
  s: ReturnType<typeof computeIndicatorScores>,
  fundingAnnualized: number, buyThreshold: number, sellThreshold: number,
): ReturnType<typeof deriveVerdict> {
  return deriveVerdict(s, {
    fundingZScore: null,
    fundingRateAnnualized: fundingAnnualized,
    hurstVal: s.hurstVal,
    squeezeActive: s.squeezeActive,
    r4Thresholds: getR4Thresholds(),
    buyThreshold, sellThreshold,
  });
}

export function loadCandlesCsv(path: string): Map<string, Candle[]> {
  const out = new Map<string, Candle[]>();
  for (const line of readFileSync(path, 'utf8').trim().split('\n').slice(1)) {
    if (!line) continue;
    const [key, time, open, high, low, close, volume] = line.split(',');
    if (!out.has(key)) out.set(key, []);
    out.get(key)!.push({
      time: Number(time), open: Number(open), high: Number(high),
      low: Number(low), close: Number(close), volume: Number(volume),
    });
  }
  for (const arr of out.values()) arr.sort((a, b) => a.time - b.time);
  return out;
}

export { splitCandleWindow, MAX_RAW_SCORE, W, FUNDING_SWEEP, PRICE_CHANGE_SWEEP, FUNDING_Z_SWEEP };

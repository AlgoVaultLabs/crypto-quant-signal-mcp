/**
 * regime-band-sweep.run.test.ts — SIGNAL-TREND-BLINDNESS-FIX-W1 CH2, the registered K sweep.
 *
 * Gated behind `REGIME_BAND_SWEEP=1`; never runs in CI or the pre-push gate. That gate is not
 * decoration: this file WRITES a tracked artifact under `audits/`, and a test that mutates a shared
 * repo file mid-suite races any test that reads it — the runner isolates modules, not the
 * filesystem. Env-gated-off-by-default is what makes the write safe.
 *
 * It answers three questions the chapter is required to answer with numbers, not adjectives:
 *
 *   1. Does the K retune pay for itself?  (CH2 step 3's FALSIFIER — re-run on the CORRECTED
 *      `agrees` predicate, because the first sweep ran under the old one and step 6 changed it.)
 *   2. What was the disagree rate under the PRE-WAVE rule, on the SAME corpus?  (CH2 step 6 — the
 *      only way to know whether the >50% figure was a regression this wave would have introduced
 *      or a pre-existing condition it inherits.)
 *   3. Does the local sweep reproduce production exactly?  (The PIN. A calibration harness that has
 *      drifted from the thing it calibrates is measuring a rule nobody runs — the branch's own
 *      `sweepMatchesProductionAt921` exists for the same reason.)
 *
 * ARTIFACT LOCATION — tracked `audits/`, deliberately. These are label-DISTRIBUTION statistics
 * (RANGING share, flip rate, disagree rate): descriptive engine behaviour, not performance claims,
 * not revenue, under no publication hold. HARD BOUNDARY: the moment a file here would mix them with
 * ANY win-rate, edge, PFE or revenue figure it goes to the private vault instead. No mixed files.
 */
import { describe, it } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { getAdapter } from '../../src/lib/exchange-adapter.js';
import { ema, atr, rsi } from '../../src/lib/indicators.js';
import { splitCandleWindow } from '../../src/lib/candle-window.js';
import {
  classifyRegimeLabel, REGIME_SEPARATION_ATR_MULT, REGIME_CONFIRM_BARS,
} from '../../src/tools/get-trade-call.js';
import type { Candle, RegimeType } from '../../src/types.js';

const ENABLED = process.env.REGIME_BAND_SWEEP === '1';
const COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT',
  'LTC', 'TRX', 'NEAR', 'APT', 'ARB', 'OP', 'SUI', 'INJ', 'TIA', 'FIL'];
const TFS: Array<[string, number]> = [['1h', 3_600_000], ['4h', 14_400_000], ['1d', 86_400_000]];
const KS = [4, 6, 8, 10, 12];
/** Production fetches 100 bars, so a per-bar reconstruction must read the same trailing window. */
const PROD_WINDOW = 100;
/**
 * The FETCH lookback, and it must not exceed the adapter's own kline cap.
 *
 * MEASURED 2026-08-21, and it invalidated an earlier run of this harness: Binance's adapter sends
 * `limit: 200` and the venue returns bars FORWARD from `startTime`, so a 250-period lookback yields
 * the OLDEST 200 — a window that ENDS ~50 periods in the past. On BTC/4h that inverted the label
 * against production at the same instant: lookback 100 gave `sep +4.747% / side +1 / TRENDING_UP`
 * while lookback 250 gave `sep -0.400% / side -1 / TRENDING_DOWN`, because the second was reading
 * data that stopped ~8 days earlier. Both were internally consistent, so nothing looked wrong.
 *
 * Matching production's 100 keeps the sweep measuring the rule production actually runs, and keeps
 * the PIN below meaningful rather than merely self-consistent.
 */
const FETCH_LOOKBACK = PROD_WINDOW;

type Agg = { n: number; rang: number; flips: number; disPre: number; disOldPred: number; disNewPred: number };
const zero = (): Agg => ({ n: 0, rang: 0, flips: 0, disPre: 0, disOldPred: 0, disNewPred: 0 });

/** The PRE-WAVE label rule, verbatim from the retired get-trade-call.ts:385-388. */
function preWaveLabel(closes: number[]): RegimeType {
  const r = rsi(closes, 14);
  const f = ema(closes, 9); const s = ema(closes, 21);
  let cross: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (f && s) {
    const a = f[f.length - 1]; const b = s[s.length - 1];
    if (!isNaN(a) && !isNaN(b)) cross = a > b ? 'BULLISH' : a < b ? 'BEARISH' : 'NEUTRAL';
  }
  if (cross === 'BULLISH' && r !== null && r < 70) return 'TRENDING_UP';
  if (cross === 'BEARISH' && r !== null && r > 30) return 'TRENDING_DOWN';
  return 'RANGING';
}

/** `agrees` BEFORE CH2 step 6 — RANGING required an exact EMA tie. */
const agreesOld = (L: RegimeType, e: number) =>
  (L === 'TRENDING_UP' && e > 0) || (L === 'TRENDING_DOWN' && e < 0) || (L === 'RANGING' && e === 0);
/** `agrees` AFTER CH2 step 6 — RANGING is a verdict about the spread, so it agrees. */
const agreesNew = (L: RegimeType, e: number) =>
  (L === 'TRENDING_UP' && e > 0) || (L === 'TRENDING_DOWN' && e < 0) || L === 'RANGING';

describe.skipIf(!ENABLED)('CH2 — separation-band K sweep (REGIME_BAND_SWEEP=1)', () => {
  it('sweeps K, measures both agrees predicates, and pins against production', { timeout: 900_000 }, async () => {
    const ad = getAdapter('BINANCE');
    const acc: Record<number, Record<string, Agg>> = {};
    for (const K of KS) { acc[K] = {}; for (const [tf] of TFS) acc[K][tf] = zero(); }
    let pinN = 0; let pinFail = 0; const pairs: string[] = [];

    for (const coin of COINS) for (const [tf, ms] of TFS) {
      let c: Candle[];
      try {
        const raw = await ad.getCandles(coin, tf, Date.now() - FETCH_LOOKBACK * ms);
        raw.sort((a, b) => a.time - b.time);
        c = splitCandleWindow(raw, ms, Date.now()).closed;
      } catch { continue; }
      if (c.length < 60) continue;   // a short series cannot carry a K-sweep
      pairs.push(`${coin}/${tf}`);

      const closes = c.map(x => x.close);
      const f = ema(closes, 9); const s = ema(closes, 21);
      const a = atr(c.map(x => x.high), c.map(x => x.low), closes, 14);
      if (!f || !s || a === null) continue;
      const band = REGIME_SEPARATION_ATR_MULT * (a / closes[closes.length - 1]);
      const sides = f.map((_, k) => {
        const A = f[k]; const B = s[k];
        if (isNaN(A) || isNaN(B) || B === 0) return 0;
        const sep = (A - B) / B;
        return Math.abs(sep) < band ? 0 : Math.sign(sep);
      });
      const emaScoreAt = f.map((_, k) =>
        isNaN(f[k]) || isNaN(s[k]) ? 0 : (f[k] > s[k] ? 100 : f[k] < s[k] ? -100 : 0));
      // PRE-WAVE label per bar, reconstructed over the SAME trailing window production reads.
      const pre = closes.map((_, k) => preWaveLabel(closes.slice(Math.max(0, k - PROD_WINDOW + 1), k + 1)));

      for (const K of KS) {
        let held: RegimeType = 'RANGING'; let prev = '';
        for (let k = K - 1; k < sides.length; k++) {
          const w = sides.slice(k - K + 1, k + 1);
          if (new Set(w).size === 1) held = w[0] > 0 ? 'TRENDING_UP' : w[0] < 0 ? 'TRENDING_DOWN' : 'RANGING';
          const A = acc[K][tf]; const e = emaScoreAt[k];
          A.n++;
          if (held === 'RANGING') A.rang++;
          if (!agreesOld(held, e)) A.disOldPred++;
          if (!agreesNew(held, e)) A.disNewPred++;
          if (!agreesOld(pre[k], e)) A.disPre++;   // pre-wave rule AND pre-wave predicate
          if (prev && held !== prev) A.flips++;
          prev = held;
        }
      }
      pinN++;
      let h: RegimeType = 'RANGING';
      for (let k = REGIME_CONFIRM_BARS - 1; k < sides.length; k++) {
        const w = sides.slice(k - REGIME_CONFIRM_BARS + 1, k + 1);
        if (new Set(w).size === 1) h = w[0] > 0 ? 'TRENDING_UP' : w[0] < 0 ? 'TRENDING_DOWN' : 'RANGING';
      }
      if (h !== classifyRegimeLabel(c)) pinFail++;
    }

    const rows = KS.map(K => {
      const tot = TFS.reduce((x, [tf]) => x + acc[K][tf].n, 0);
      const share = Object.fromEntries(TFS.map(([tf]) =>
        [tf, +(acc[K][tf].rang / acc[K][tf].n * 100).toFixed(1)]));
      const vals = Object.values(share) as number[];
      const sum = (f: (g: Agg) => number) => TFS.reduce((x, [tf]) => x + f(acc[K][tf]), 0);
      return {
        K, n: tot,
        ranging_share_pct_by_tf: share,
        cross_timeframe_spread_pp: +(Math.max(...vals) - Math.min(...vals)).toFixed(1),
        flips_per_100_bars: +(sum(g => g.flips) / tot * 100).toFixed(2),
        disagree_pct_prewave_rule_and_predicate: +(sum(g => g.disPre) / tot * 100).toFixed(1),
        disagree_pct_newrule_old_predicate: +(sum(g => g.disOldPred) / tot * 100).toFixed(1),
        disagree_pct_newrule_new_predicate: +(sum(g => g.disNewPred) / tot * 100).toFixed(1),
      };
    });

    const out = {
      wave: 'SIGNAL-TREND-BLINDNESS-FIX-W1',
      chapter: 'CH2',
      generated_by: 'tests/harness/regime-band-sweep.run.test.ts (REGIME_BAND_SWEEP=1)',
      contains: 'label-distribution statistics ONLY — no win-rate, edge, PFE or revenue figure',
      instrument: {
        venue: 'BINANCE', basis: 'closed (CANDLE_BASIS=closed)', accounting: 'per-bar',
        coins: COINS.length, timeframes: TFS.map(([t]) => t),
        prewave_reconstruction_window_bars: PROD_WINDOW,
        fetch_lookback_periods: FETCH_LOOKBACK,
        band_multiplier: REGIME_SEPARATION_ATR_MULT, shipped_K: REGIME_CONFIRM_BARS,
        pairs: pairs.length, pair_list: pairs,
      },
      production_pin: { pairs: pinN, mismatches: pinFail, exact: pinFail === 0 },
      sweep: rows,
    };
    mkdirSync('audits', { recursive: true });
    // Date read at WRITE time, never hardcoded from the session's start — a stamped date that
    // came from when the work began rather than when the file was written is a small lie that
    // outlives the run. Naming matches the branch's regime-rule-calibration-atr-2026-08-07.json.
    const stamp = new Date().toISOString().slice(0, 10);
    const path = `audits/regime-separation-band-sweep-${stamp}.json`;
    writeFileSync(path, JSON.stringify(out, null, 2));
    console.log(`\nPIN ${pinN - pinFail}/${pinN} exact${pinFail ? '  *** DIVERGENT ***' : ''}   pairs=${pairs.length}`);
    console.log(' K | RANGING by tf         | spread | flips/100 | disagree: pre-wave / new-rule+old-pred / new-rule+NEW-pred');
    for (const r of rows) {
      const sh = TFS.map(([tf]) => `${(r.ranging_share_pct_by_tf as any)[tf]}%`).join(' ');
      console.log(`${String(r.K).padStart(2)} | ${sh.padEnd(21)} | ${String(r.cross_timeframe_spread_pp).padStart(4)}pp | ${String(r.flips_per_100_bars).padStart(9)} | ${String(r.disagree_pct_prewave_rule_and_predicate).padStart(8)}% / ${String(r.disagree_pct_newrule_old_predicate).padStart(6)}% / ${String(r.disagree_pct_newrule_new_predicate).padStart(6)}%`);
    }
    console.log(`\nwrote ${path}  (n=${rows[0]?.n})`);
  });
});

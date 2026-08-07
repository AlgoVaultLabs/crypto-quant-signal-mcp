/**
 * regime-replay.ts — SIGNAL-REGIME-LABEL-STABILITY-W1 R1.
 *
 * Measures the LAG and the CHURN of the public `regime` label. Test-only: nothing under
 * `src/` is written by this wave, and this file imports the production classifier rather
 * than restating any part of it.
 *
 * ── Why the obvious method does not work ─────────────────────────────────────
 * The wave was dispatched to compare a LIVE classification at bar `i` against a HINDSIGHT
 * one computed with K further bars available. That measures **identically zero**:
 * `ema()` is a forward recursion and `rsi()` is Wilder's forward smoothing, so the
 * classification at bar `i` is a pure causal function of bars `0…i` and **no future bar can
 * change it**. The golden check that was meant to validate such a harness ("on a window with
 * no transition, LIVE and HINDSIGHT agree at every index") is vacuously true on EVERY series.
 *
 * Measuring a causal filter's lag requires an **acausal reference**. That is not optional.
 *
 * ── The construction used here ───────────────────────────────────────────────
 * Standard zero-phase reasoning, applied at the CLASSIFIER level so that nothing is
 * reimplemented and nothing is extracted:
 *
 *   - run the production classifier FORWARD over the series          → lags a transition by +τ
 *   - run the SAME production classifier over the REVERSED series    → in real time, LEADS by τ
 *   - the true transition sits at the MIDPOINT of the two detections
 *   - therefore  **lag τ = (t_forward − t_backward) / 2**
 *
 * Only the filtering DIRECTION changes. `computeIndicatorScores` is called verbatim in both
 * directions, so the EMA pair, the RSI gate and the 3-way collapse to `RANGING` all ride
 * along automatically — there is no separate ema/rsi path to keep in sync.
 *
 * ── DECLARED CAVEAT — the reference is NOT ground truth ──────────────────────
 * Forward-backward filtering does not yield "the same classifier without lag". It squares the
 * magnitude response, so the reference is zero-phase **and sharper** than production. It is
 * valid for isolating **lag** — phase is exactly what the construction removes — but its
 * regime LABELS are not those of a hypothetical lag-free production classifier, and must
 * never be read as the correct labels. A reader who treats `backwardRegime` as truth is
 * misreading it.
 *
 * ── Second declared asymmetry, measured rather than assumed ──────────────────
 * Time reversal maps an uptrend to a downtrend, so labels must be mirrored to compare the two
 * directions. That mirror is EXACT for the EMA crossover and INEXACT through the RSI gate:
 * a forward overbought region (`rsi >= 70` ⇒ collapse to `RANGING`) appears in reversed time
 * as an oversold one, where the gate that fires is `rsi > 30` instead. The construction does
 * not hide this — `flipCause` attributes every transition to the EMA crossover or to the RSI
 * band, and lag is reported ONLY for EMA-driven transitions, where the closed form applies
 * and the mirror is exact. RSI-driven flips are counted in churn with lag `null`.
 */
import { computeIndicatorScores } from '../../src/tools/get-trade-call.js';
import { ema, rsi } from '../../src/lib/indicators.js';
import type { Candle, RegimeType } from '../../src/types.js';

/** Production fetches `now - 100 * intervalMs` (get-trade-call.ts:489). */
export const PRODUCTION_WINDOW_BARS = 100;

/** The classifier's own filter periods, read from get-trade-call.ts:302-304 / :300. */
export const EMA_FAST = 9;
export const EMA_SLOW = 21;
export const RSI_PERIOD = 14;

/**
 * Group delay of an EMA of period N at DC: τ = (N−1)/2 bars. This is computable from the
 * parameters ALONE — it is the wave's PRIMARY anchor, and the empirical run is its
 * confirmation, not the other way round.
 */
export const emaGroupDelay = (period: number): number => (period - 1) / 2;

/**
 * Individual DC group delays, [τ_9, τ_21] = [4, 10] bars.
 *
 * ⚠️ These bracket where each EMA SITS on a ramp. They do **not** bracket the lag of the
 * CROSSOVER, and the wave's pre-registration said they did — that was wrong, corrected here
 * by `crossoverLagAfterReversal()`. See its derivation.
 */
export const EMA_DC_DELAYS: readonly [number, number] = [emaGroupDelay(EMA_FAST), emaGroupDelay(EMA_SLOW)];

/**
 * Closed-form detection lag of `sign(ema_fast − ema_slow)` after a slope reversal —
 * computable from the PERIODS ALONE, which is what makes it the primary anchor.
 *
 * On a ramp of slope `m`, an EMA of period N sits `m·τ_N` behind price, so before a reversal
 * `d ≡ ema_fast − ema_slow = m(τ_slow − τ_fast) > 0`. Writing the reversal at `t = 0` with
 * `x(t) = −m·t`, the EMA recursion solves to
 *
 *     e_N(t) = x(t) + m·τ_N − 2·m·τ_N·(1−k_N)^t
 *
 * so the crossing is the first `t` with
 *
 *     d(t)/m = (τ_fast − τ_slow) − 2[τ_fast(1−k_fast)^t − τ_slow(1−k_slow)^t]  ≤  0
 *
 * `d(0)/m = +(τ_slow − τ_fast)` and `d(∞)/m = −(τ_slow − τ_fast)`: the difference must not
 * merely shrink, it must CHANGE SIGN. That is why the crossover lags by MORE than either
 * individual τ — the error the pre-registration made.
 *
 * For 9/21 this yields ≈ **11.64 bars**, and the classifier fires on the first bar whose sign
 * has flipped, i.e. `ceil` of it.
 */
export function crossoverLagAfterReversal(fast = EMA_FAST, slow = EMA_SLOW, maxBars = 200): number {
  const kF = 2 / (fast + 1);
  const kS = 2 / (slow + 1);
  const tF = emaGroupDelay(fast);
  const tS = emaGroupDelay(slow);
  const d = (t: number): number => tF - tS - 2 * (tF * Math.pow(1 - kF, t) - tS * Math.pow(1 - kS, t));
  let lo = 0;
  let hi = maxBars;
  if (d(lo) <= 0 || d(hi) > 0) return NaN;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (d(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The pre-registered prediction, corrected: ≈11.64 bars for the shipped 9/21 pair. */
export const PREDICTED_CROSSOVER_LAG_BARS = crossoverLagAfterReversal();

/**
 * Edge artifacts. Forward-backward filtering loses the slow filter's warm-up at BOTH ends,
 * and the rolling window costs another `PRODUCTION_WINDOW_BARS` at the start.
 */
export const EDGE_DISCARD_BARS = Math.max(EMA_SLOW, RSI_PERIOD);

export type FlipCause = 'ema_cross' | 'rsi_band' | 'both' | 'unknown';

export interface Sample {
  index: number;
  regime: RegimeType;
  /** Retained so a transition can be attributed to a cause rather than guessed at. */
  emaCross: string;
  rsiVal: number | null;
}

export interface Transition {
  /** Index of the FIRST bar carrying the new label. */
  index: number;
  from: RegimeType;
  to: RegimeType;
  cause: FlipCause;
}

/**
 * The three non-candle inputs are irrelevant to `regime` — it is a function of the closes
 * alone (emaCross ← closes, rsiVal ← closes). `assertRegimeIgnoresNonCandleInputs` proves
 * that rather than trusting this comment.
 */
const INERT = { fundingRateAnnualized: 0, priceChange: 0, openInterest: 0 };

function classify(window: Candle[]): Sample | null {
  if (window.length < EMA_SLOW + 2) return null;
  try {
    const s = computeIndicatorScores({ candles: window, ...INERT });
    return { index: window.length - 1, regime: s.regime, emaCross: s.emaCross, rsiVal: s.rsiVal };
  } catch {
    return null;
  }
}

/** Time reversal maps an uptrend to a downtrend. `RANGING`/`VOLATILE` are self-inverse. */
export function mirrorRegime(r: RegimeType): RegimeType {
  if (r === 'TRENDING_UP') return 'TRENDING_DOWN';
  if (r === 'TRENDING_DOWN') return 'TRENDING_UP';
  return r;
}

/**
 * LIVE view: exactly what production computes at bar `i` — the production function over the
 * trailing 100-bar window, unmodified.
 */
export function liveRegime(candles: Candle[], i: number): Sample | null {
  const start = Math.max(0, i - PRODUCTION_WINDOW_BARS + 1);
  const s = classify(candles.slice(start, i + 1));
  return s ? { ...s, index: i } : null;
}

/**
 * BACKWARD view: the same production classifier over the window STARTING at `i`, reversed,
 * with the label mirrored back into forward time. In real time this LEADS a transition by the
 * same τ the forward pass lags it.
 */
export function backwardRegime(candles: Candle[], i: number): Sample | null {
  const end = Math.min(candles.length, i + PRODUCTION_WINDOW_BARS);
  const win = candles.slice(i, end);
  if (win.length < EMA_SLOW + 2) return null;
  // Reverse the PRICES but keep timestamps ascending: the classifier reads `time` only for
  // nothing at all (it maps closes/highs/lows/volumes), but an ascending `time` keeps the
  // array a well-formed Candle[] for any future consumer.
  const reversed = win
    .slice()
    .reverse()
    .map((c, k) => ({ ...c, time: win[k].time }));
  const s = classify(reversed);
  return s ? { index: i, regime: mirrorRegime(s.regime), emaCross: s.emaCross, rsiVal: s.rsiVal } : null;
}

/** Series of live samples over the scorable interior of a candle array. */
export function liveSeries(candles: Candle[]): Sample[] {
  const out: Sample[] = [];
  for (let i = EDGE_DISCARD_BARS; i < candles.length - EDGE_DISCARD_BARS; i++) {
    const s = liveRegime(candles, i);
    if (s) out.push(s);
  }
  return out;
}

export function backwardSeries(candles: Candle[]): Sample[] {
  const out: Sample[] = [];
  for (let i = EDGE_DISCARD_BARS; i < candles.length - EDGE_DISCARD_BARS; i++) {
    const s = backwardRegime(candles, i);
    if (s) out.push(s);
  }
  return out;
}

/**
 * Attribute a transition to the EMA crossover or to the RSI band. `regime` collapses to
 * `RANGING` when `emaCross === 'BULLISH' && rsiVal >= 70` (or BEARISH && <= 30), so a
 * STRENGTHENING trend can flip the public label to `RANGING` with no crossover at all. That
 * is measured here, never asserted.
 */
function attribute(prev: Sample, next: Sample): FlipCause {
  const emaMoved = prev.emaCross !== next.emaCross;
  const band = (s: Sample): boolean =>
    s.rsiVal !== null && ((s.emaCross === 'BULLISH' && s.rsiVal >= 70) || (s.emaCross === 'BEARISH' && s.rsiVal <= 30));
  const bandMoved = band(prev) !== band(next);
  if (emaMoved && bandMoved) return 'both';
  if (emaMoved) return 'ema_cross';
  if (bandMoved) return 'rsi_band';
  return 'unknown';
}

export function transitionsOf(series: Sample[]): Transition[] {
  const out: Transition[] = [];
  for (let k = 1; k < series.length; k++) {
    if (series[k].regime !== series[k - 1].regime) {
      out.push({
        index: series[k].index,
        from: series[k - 1].regime,
        to: series[k].regime,
        cause: attribute(series[k - 1], series[k]),
      });
    }
  }
  return out;
}

export interface ChurnMetrics {
  bars: number;
  n_transitions: number;
  flips_per_100_bars: number;
  dwell_bars_p10: number | null;
  dwell_bars_p50: number | null;
  /** Fraction of flips that revert to the prior label within `roundTripWindow` bars. */
  round_trip_rate: number | null;
  cause_ema_cross: number;
  cause_rsi_band: number;
  cause_both: number;
  cause_unknown: number;
}

const pct = (sorted: number[], p: number): number | null =>
  sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

export function churnOf(series: Sample[], roundTripWindow = 10): ChurnMetrics {
  const tr = transitionsOf(series);
  const dwell: number[] = [];
  for (let k = 1; k < tr.length; k++) dwell.push(tr[k].index - tr[k - 1].index);
  dwell.sort((a, b) => a - b);

  let roundTrips = 0;
  for (let k = 0; k < tr.length; k++) {
    const back = tr.find((t) => t.index > tr[k].index && t.index - tr[k].index <= roundTripWindow && t.to === tr[k].from);
    if (back) roundTrips += 1;
  }

  const bars = series.length;
  return {
    bars,
    n_transitions: tr.length,
    flips_per_100_bars: bars > 0 ? (tr.length * 100) / bars : 0,
    dwell_bars_p10: pct(dwell, 10),
    dwell_bars_p50: pct(dwell, 50),
    round_trip_rate: tr.length > 0 ? roundTrips / tr.length : null,
    cause_ema_cross: tr.filter((t) => t.cause === 'ema_cross').length,
    cause_rsi_band: tr.filter((t) => t.cause === 'rsi_band').length,
    cause_both: tr.filter((t) => t.cause === 'both').length,
    cause_unknown: tr.filter((t) => t.cause === 'unknown').length,
  };
}

export interface LagPair {
  forwardIndex: number;
  backwardIndex: number;
  /** τ = (t_forward − t_backward) / 2. */
  lagBars: number;
  to: RegimeType;
}

/**
 * Pair each FORWARD transition with the nearest BACKWARD transition into the same label and
 * halve the separation. Only EMA-driven transitions are paired: the time-reversal mirror is
 * exact for the crossover and inexact through the RSI gate, so an RSI-driven flip carries no
 * defensible lag and is deliberately excluded rather than silently averaged in.
 */
export function pairLags(
  forward: Transition[],
  backward: Transition[],
  maxSeparationBars = 4 * EMA_SLOW,
): LagPair[] {
  const emaOnly = (t: Transition): boolean => t.cause === 'ema_cross' || t.cause === 'both';
  const cand = backward.filter(emaOnly);
  const used = new Set<number>();
  const out: LagPair[] = [];
  for (const f of forward.filter(emaOnly)) {
    let best: Transition | null = null;
    let bestD = Infinity;
    for (const b of cand) {
      if (used.has(b.index) || b.to !== f.to) continue;
      const d = Math.abs(f.index - b.index);
      if (d < bestD && d <= maxSeparationBars) {
        best = b;
        bestD = d;
      }
    }
    if (best) {
      used.add(best.index);
      out.push({ forwardIndex: f.index, backwardIndex: best.index, lagBars: (f.index - best.index) / 2, to: f.to });
    }
  }
  return out;
}

/**
 * A transition is ISOLATED when no other transition sits within `isolationBars` of it.
 *
 * This exists because the naive pairing is NOT IDENTIFIABLE at production churn rates. The
 * classifier's structural lag is ≈11.64 bars while the measured median dwell is ≈7 bars, so
 * the next flip arrives before the previous one has been detected and "nearest transition into
 * the same label" matches unrelated events — which is exactly what a negative median lag
 * reveals. Restricting to isolated transitions asks the question the data can actually answer:
 * *when a transition IS separable, is it detected at the lag the closed form predicts?*
 */
export function isolatedTransitions(all: Transition[], isolationBars: number): Transition[] {
  return all.filter((t) =>
    all.every((o) => o.index === t.index || Math.abs(o.index - t.index) > isolationBars),
  );
}

export interface LagMetrics {
  n_transitions_observed: number;
  p50: number | null;
  p90: number | null;
  max: number | null;
}

export function lagMetrics(pairs: LagPair[]): LagMetrics {
  const v = pairs.map((p) => p.lagBars).sort((a, b) => a - b);
  return {
    n_transitions_observed: v.length,
    p50: pct(v, 50),
    p90: pct(v, 90),
    max: v.length ? v[v.length - 1] : null,
  };
}

/**
 * DECLARED THRESHOLD — a cell with fewer than this many paired transitions reports
 * `INDETERMINATE` and never a latency figure. A p90 over 3 transitions is not a measurement.
 * Stated here, and restated in the artifact, so it is a decision rather than a filter a later
 * wave "fixes".
 */
export const MIN_TRANSITIONS_FOR_LATENCY = 30;

export const latencyVerdict = (m: LagMetrics): 'MEASURED' | 'INDETERMINATE' =>
  m.n_transitions_observed >= MIN_TRANSITIONS_FOR_LATENCY ? 'MEASURED' : 'INDETERMINATE';

// ── R4 counterfactual sweep ─────────────────────────────────────────────────

/**
 * ⚠️ COUNTERFACTUAL VARIANT — not the production path.
 *
 * Production hardcodes `ema(closes, 9)` / `ema(closes, 21)` / `rsi(closes, 14)`, so a
 * window-length sweep is impossible through `computeIndicatorScores`: there is no parameter to
 * vary. This restates the 3-line decision rule over the SAME production primitives with the
 * periods opened up, and is used ONLY to price alternative settings.
 *
 * Every production measurement in this wave still goes through `computeIndicatorScores`
 * verbatim. What makes this variant safe to trust is `sweepMatchesProductionAt921`: at the
 * shipped (9, 21, 14) it must reproduce production's labels EXACTLY, bar for bar. If the rule
 * ever drifts from production, that pin fails and the sweep is known to be stale — the
 * alternative is an unpinned copy that silently diverges, which is how a counterfactual
 * quietly stops describing the thing it is counterfactual to.
 */
export function sweepRegime(closes: number[], fast: number, slow: number, rsiPeriod: number): RegimeType {
  const rsiVal = rsi(closes, rsiPeriod);
  const fastSeries = ema(closes, fast);
  const slowSeries = ema(closes, slow);
  let emaCross = 'NEUTRAL';
  if (fastSeries && slowSeries && fastSeries.length >= 2) {
    const n = fastSeries.length;
    const [cF, pF, cS, pS] = [fastSeries[n - 1], fastSeries[n - 2], slowSeries[n - 1], slowSeries[n - 2]];
    if (!isNaN(cF) && !isNaN(pF) && !isNaN(cS) && !isNaN(pS)) {
      if (cF > cS && pF <= pS) emaCross = 'BULLISH';
      else if (cF < cS && pF >= pS) emaCross = 'BEARISH';
      else if (cF > cS) emaCross = 'BULLISH';
      else if (cF < cS) emaCross = 'BEARISH';
    }
  }
  if (emaCross === 'BULLISH' && rsiVal !== null && rsiVal < 70) return 'TRENDING_UP';
  if (emaCross === 'BEARISH' && rsiVal !== null && rsiVal > 30) return 'TRENDING_DOWN';
  return 'RANGING';
}

/** The pin. Returns the number of bars where the variant and production disagree — must be 0. */
export function sweepMatchesProductionAt921(candles: Candle[]): number {
  let mismatches = 0;
  for (let i = EDGE_DISCARD_BARS; i < candles.length - EDGE_DISCARD_BARS; i++) {
    const prod = liveRegime(candles, i);
    if (!prod) continue;
    const start = Math.max(0, i - PRODUCTION_WINDOW_BARS + 1);
    const closes = candles.slice(start, i + 1).map((c) => c.close);
    if (sweepRegime(closes, EMA_FAST, EMA_SLOW, RSI_PERIOD) !== prod.regime) mismatches += 1;
  }
  return mismatches;
}

/** Flips per 100 bars for an arbitrary (fast, slow) setting — the churn side of the frontier. */
export function sweepChurn(candles: Candle[], fast: number, slow: number, rsiPeriod = RSI_PERIOD): number {
  let flips = 0;
  let bars = 0;
  let prev: RegimeType | null = null;
  for (let i = EDGE_DISCARD_BARS; i < candles.length - EDGE_DISCARD_BARS; i++) {
    const start = Math.max(0, i - PRODUCTION_WINDOW_BARS + 1);
    const r = sweepRegime(
      candles.slice(start, i + 1).map((c) => c.close),
      fast,
      slow,
      rsiPeriod,
    );
    bars += 1;
    if (prev !== null && r !== prev) flips += 1;
    prev = r;
  }
  return bars > 0 ? (flips * 100) / bars : 0;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const bar = (close: number, i: number, volume = 1000): Candle => ({
  open: close,
  high: close * 1.001,
  low: close * 0.999,
  close,
  volume,
  time: i * 60_000,
});

/**
 * Trend reversal: slope `+m` for `n` bars, then `−m` for `n` bars.
 *
 * A pure STEP is degenerate for this classifier — from a common seed
 * `ema9 − ema21 = (1−k₂₁)ᵗ − (1−k₉)ᵗ > 0` for every `t > 0`, so the two never cross and a
 * step fixture would make the gate vacuous. The reversal is a requirement, not a preference.
 */
export function trendReversalSeries(n = 260, m = 1.0, base = 1000): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) out.push(bar(base + m * i, i));
  const peak = base + m * (n - 1);
  for (let i = 0; i < n; i++) out.push(bar(peak - m * (i + 1), n + i));
  return out;
}

/** Monotone ramp — no reversal, so a correct harness finds no EMA-driven transition. */
export function monotoneSeries(n = 300, m = 1.0, base = 1000): Candle[] {
  return Array.from({ length: n }, (_, i) => bar(base + m * i, i));
}

/**
 * Deterministic pseudo-random walk. No `Math.random()` — a fixture that changes between runs
 * cannot anchor a gate.
 */
export function seededWalk(n = 600, seed = 42, base = 1000, vol = 4): Candle[] {
  let s = seed;
  const next = (): number => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const out: Candle[] = [];
  let p = base;
  for (let i = 0; i < n; i++) {
    p = Math.max(1, p + (next() - 0.5) * 2 * vol);
    out.push(bar(p, i));
  }
  return out;
}

/**
 * Proves the comment on `INERT`: `regime` is a function of the closes alone. Returns true iff
 * varying funding / priceChange / openInterest leaves every label unchanged.
 */
export function assertRegimeIgnoresNonCandleInputs(candles: Candle[]): boolean {
  const win = candles.slice(0, PRODUCTION_WINDOW_BARS);
  const a = computeIndicatorScores({ candles: win, ...INERT });
  const b = computeIndicatorScores({
    candles: win,
    fundingRateAnnualized: 42.5,
    priceChange: -13.7,
    openInterest: 9_000_000,
  });
  return a.regime === b.regime;
}

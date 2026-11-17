// regime-challenge/challenger-replay.ts — EDGE-REGIME-CHALLENGE-R1-W1: the challenger replays.
//
// A challenger's label is the landed core's own classification with one input changed:
//   C1 (M01)  the indicators come from `regimeIndicatorsAt`, a copy of the core's computeRegimeIndicators whose
//             only difference is the ADX smoothing period it is given. At period 14 it IS the served rule, and
//             the parity check below holds it to that, label for label.
//   C2 (M08)  the core's own indicators, with the price structure set to neither HIGHER_HIGHS nor LOWER_LOWS, so
//             the core's trending branch falls through to ±DI. Nothing else is touched.
//   C3 (M12)  no replay: the served rule at another timeframe (the frame's own 1h rows).
// Every verdict goes through the core's `projectRegime` → `classifyRegime`: the rule is called, never rewritten.
import { REQUIRED_CANDLES, computeRegimeIndicators, projectRegime, type RegimeIndicators } from '../../lib/market-regime-core.js';
import { adx, atr, detectPriceStructure } from '../../lib/indicators.js';
import { splitCandleWindow } from '../../lib/candle-window.js';
import type { Candle } from '../../types.js';
import { aggregate, type Bars, type Grid } from '../regime-diag/archive.js';
import { LABELS, NO_LABEL, TFS, type Tf, type Win } from '../regime-diag/diag-spec.js';
import { N_TF, posName, type Frame, type Lab, type Loaded } from '../regime-diag/frame.js';
import { MUTATE } from '../regime-diag/mutate.js';
import { PARITY_FIXTURE } from '../regime-diag/parity.js';
import { candlesAt, quietly, type CandleWindow, type Series } from '../regime-diag/replay.js';
import { synthGrid } from '../regime-diag/synth.js';
import { SERVED_ADX_PERIOD, SERVED_DIAL, dialRefusal, type Dial } from './challenge-spec.js';

/**
 * The harness copy of `computeRegimeIndicators` (src/lib/market-regime-core.ts), taking the ADX smoothing period.
 * Everything else is the core's line for line: the slope length 5, `atr(…, 14)`, the price structure.
 */
export function regimeIndicatorsAt(candles: Candle[], adxPeriod: number): RegimeIndicators {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);

  // MUTATE=c1copy (tests only): the copy smooths over one bar more than it was asked to
  const adxResult = adx(highs, lows, closes, MUTATE === 'c1copy' ? adxPeriod + 1 : adxPeriod, 5);
  return {
    adxVal: adxResult?.adx ?? null,
    adxSlope: adxResult?.adxSlope ?? null,
    plusDI: adxResult?.plusDI ?? null,
    minusDI: adxResult?.minusDI ?? null,
    atrVal: atr(highs, lows, closes, 14),
    structure: detectPriceStructure(highs, lows, closes, volumes),
  };
}

/** One rule's reading of one call: the label (index into LABELS) and its confidence. */
export interface Verdict { label: number; confidence: number }

/** The verdict of `dial` on the closed bars of a call, at the call's price (the close of the bar in progress). */
export function verdictOf(closed: Candle[], price: number, dial: Dial): Verdict {
  const why = dialRefusal(dial);
  if (why) throw new Error(`regime-challenge: ${why}`);
  let ind: RegimeIndicators;
  if (dial.direction === 'di') {
    const core = computeRegimeIndicators(closed);
    ind = { ...core, structure: { ...core.structure, structure: 'MIXED' } };
  } else {
    ind = regimeIndicatorsAt(closed, dial.adxPeriod);
  }
  const p = projectRegime(ind, price);
  return { label: LABELS.indexOf(p.regime), confidence: p.confidence };
}

/**
 * The verdict of each dial on one candle window — the window the serving path holds at the call (replay.ts).
 * The closed bars are the core's own split of it; a window the core would refuse is refused here.
 */
export function dialVerdicts(w: CandleWindow, dials: readonly Dial[]): Verdict[] {
  const closed = splitCandleWindow(w.candles, w.intervalMs, w.nowMs).closed;
  if (closed.length < REQUIRED_CANDLES) throw new Error(`regime-challenge: ${closed.length} closed bars, the core needs ${REQUIRED_CANDLES}`);
  const price = w.candles[w.candles.length - 1].close;
  return dials.map((d) => verdictOf(closed, price, d));
}

// ── a frame's challenger columns ─────────────────────────────────────────────────────────────────────────────────

/** Per dial: the challenger's label and confidence at every frame row, and its per-closed-bar series inside the window. */
export interface ChallengerCols {
  dials: readonly Dial[];
  /** [dial] — by frame row `e·3 + τ`; NO_LABEL where the frame has no served row. */
  labs: Lab[];
  /** [dial][coin index of the frame][τ] — the served series with the label and confidence replaced; closes outside the window carry no call. */
  series: Series[][][];
  calls: number;
}

/** The closes of a series that lie inside a window (the closes `barSeq` reads at lead 0). */
const closesIn = (s: Series, win: Win): [number, number] => [Math.max(1, Math.ceil(win.lo / s.tf.min)), Math.min(s.nb, Math.ceil(win.hi / s.tf.min) - 1)];

/**
 * The challenger columns of a frame, one coin at a time: the same calls the frame made (every row it has, every
 * close of its series inside the window), each read under every dial. Labels only — no outcome is touched.
 */
export function challengerColumns(f: Frame, load: (pos: number) => Loaded, dials: readonly Dial[]): ChallengerCols {
  const rows = f.has.length;
  const labs: Lab[] = dials.map(() => ({ lab: new Uint8Array(rows).fill(NO_LABEL), conf: new Uint8Array(rows) }));
  const series: Series[][][] = dials.map(() => []);
  let calls = 0;
  for (const c of f.coins) {
    const { g } = load(c.pos);
    if (!g) throw new Error(`regime-challenge: ${posName(c.pos)} has no archive now, and had one when the frame was built`);
    const bars: Bars[] = TFS.map((tf) => aggregate(g, tf.min));
    const mine: Series[][] = dials.map(() => c.series.map((s) => ({ ...s, ok: new Uint8Array(s.nb + 1), label: new Uint8Array(s.nb + 1), conf: new Uint8Array(s.nb + 1), age: new Int32Array(s.nb + 1), calls: 0, refusals: 0 })));
    quietly(() => {
      for (let e = c.e0; e < c.e1; e++) {
        for (let t = 0; t < N_TF; t++) {
          const r = e * N_TF + t;
          if (!f.has[r]) continue;
          const v = dialVerdicts(candlesAt(g, bars[t], TFS[t], f.eM[e]), dials);
          calls++;
          v.forEach((x, d) => { labs[d].lab[r] = x.label; labs[d].conf[r] = x.confidence; });
        }
      }
      c.series.forEach((s, t) => {
        const [j0, j1] = closesIn(s, f.win);
        for (let j = j0; j <= j1; j++) {
          if (!s.ok[j]) continue;
          const v = dialVerdicts(candlesAt(g, bars[t], s.tf, j * s.tf.min), dials);
          calls++;
          v.forEach((x, d) => { const q = mine[d][t]; q.ok[j] = 1; q.label[j] = x.label; q.conf[j] = x.confidence; q.calls++; });
        }
      });
    });
    mine.forEach((m, d) => series[d].push(m));
  }
  return { dials, labs, series, calls };
}

// ── parity: at the served value a challenger IS the served rule ──────────────────────────────────────────────────

export interface ParityReport { ok: boolean; calls: number; mismatches: number; reason: string }

/**
 * Replays T3's core-parity fixture under the served dial through the copy: every call must return the fixture's
 * label and confidence. Not ok — reason named — on any difference, or on a fixture that holds no call.
 */
export function checkChallengerParity(text: string): ParityReport {
  let want: Array<{ tf: string; m: number; label: string; confidence: number }>, span: { t0Ms: number; n: number }, key: string;
  try {
    const j = JSON.parse(text) as { calls: typeof want; t0Ms: number; minutes: number; key: string };
    want = j.calls; span = { t0Ms: j.t0Ms, n: j.minutes }; key = j.key;
  } catch {
    return { ok: false, calls: 0, mismatches: 0, reason: `${PARITY_FIXTURE} is not JSON` };
  }
  if (!Array.isArray(want) || want.length === 0 || !Number.isFinite(span.t0Ms) || !Number.isFinite(span.n) || typeof key !== 'string') {
    return { ok: false, calls: 0, mismatches: 0, reason: `${PARITY_FIXTURE} holds no call to replay` };
  }
  const g: Grid = synthGrid(span, key);
  const bars = new Map<string, Bars>(TFS.map((tf) => [tf.key, aggregate(g, tf.min)]));
  let mismatches = 0;
  for (const c of want) {
    const tf = TFS.find((t) => t.key === c.tf) as Tf | undefined;
    if (!tf) { mismatches++; continue; }
    let v: Verdict;
    try { v = quietly(() => dialVerdicts(candlesAt(g, bars.get(tf.key) as Bars, tf, c.m), [SERVED_DIAL])[0]); } catch { mismatches++; continue; }
    if (LABELS[v.label] !== c.label || v.confidence !== c.confidence) mismatches++;
  }
  return mismatches === 0
    ? { ok: true, calls: want.length, mismatches: 0, reason: 'ok' }
    : { ok: false, calls: want.length, mismatches, reason: `the challenger copy at period ${SERVED_ADX_PERIOD} differs from the served rule on ${mismatches} of ${want.length} fixture calls` };
}

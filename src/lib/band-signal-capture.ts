/**
 * band-signal-capture.ts — OPS-SIGNAL-PERSISTENCE-BAND-CAPTURE-W1 R2.
 *
 * Records the directional calls the engine EMITS and has never written down.
 *
 * `recordSignal` persists only `signal !== 'HOLD' && confidence >= MIN_TRACKABLE_CONFIDENCE (52)`.
 * BUY emits at `raw > 40`, i.e. confidence >= 45. So a BUY in the 45-51 band is returned to a
 * paying caller and stored nowhere. Measured on `request_log` 2026-08-30: 1368 of 2197 emitted
 * BUYs all-time — **62.27%** — and 39 of 53 (73.58%) over the source audit's 3.2252-day window.
 *
 * Two consequences, and the second is why this module exists. Every BUY/SELL share computed from
 * `signals` is a LOWER BOUND; and the public track record covers a subset of what callers
 * actually receive, with no public surface saying so.
 *
 * ── WHY CAPTURE RATHER THAN JUST LOWER THE GATE ──────────────────────────────────────────────
 *
 * Because nobody knows how this band performs — precisely because it has never been recorded.
 * Lowering `MIN_TRACKABLE_CONFIDENCE` to 45 would move the published win rate by an unknown
 * amount in an unknown direction: a public-number change made blind, on a record that is
 * Merkle-anchored and can never be restated. Capture first, decide on evidence. The decision is
 * `OPS-TRACK-RECORD-BAND-DECISION-W{NEXT}`, gated on a stated row count of RESOLVED band rows.
 *
 * ── THE ARM IS RESOLVED HERE, NOT AT THE CALL SITE ───────────────────────────────────────────
 *
 * Same reason as `hold-decision-capture.ts`, and using that module's EXPORTED `resolveCaptureArm`
 * rather than a second copy: the answer needs `currentCaller()` from `upstream-weight-budget`,
 * which sits in the documented init cycle, so it has to be read inside the deferred import. One
 * derivation of "request vs fleet" serves both capture paths; two would drift, and the two
 * corpora would then disagree about which population they were describing.
 *
 * ── UNSAMPLED, DELIBERATELY ──────────────────────────────────────────────────────────────────
 *
 * `hold_decisions` samples its fleet arm because that firehose is ~437k rows/day. The band is
 * estimated at 5.6k-8.9k/day against a tracked stream of ~2,820/day — two orders of magnitude
 * smaller — so full capture is affordable, and a sampler would inject a selection effect into a
 * corpus whose entire purpose is to be an unbiased view of what we emit. The cap below is a
 * RUNAWAY GUARD, not a sampler: it exists so that a future threshold change cannot quietly turn a
 * bounded table into an unbounded one between two monitoring cycles, and it sits far above the
 * measured rate so it never binds in normal operation.
 */
import type { ScorerParts } from './scorer-input-codes.js';
import { resolveCaptureArm, type CaptureArm } from './hold-decision-capture.js';
import { MIN_TRACKABLE_CONFIDENCE } from './published-population.js';

/** Everything `band_signals` needs, computed once at the emit site. */
export interface BandSignalCapture {
  /** Epoch SECONDS — the same unit and meaning as `signals.created_at`. */
  decidedAt: number;
  coin: string;
  signal: 'BUY' | 'SELL';
  /** The true computed confidence, below the recording gate. Asserted by `isBandConfidence`. */
  confidence: number;
  timeframe: string;
  exchange: string;
  regime: string | null;
  priceAtSignal: number;
  isBotInternal: boolean | null;
  /**
   * OPS-SCORER-INPUT-PERSISTENCE-W1 R1 — the scorer's own inputs for this decision.
   *
   * REQUIRED, not optional, and that is the point: an optional field is one a future edit can
   * drop in silence, and capture is FORWARD-ONLY — a dropped part is not a bug you find later,
   * it is data that never existed. The compiler refuses a capture that forgot them.
   */
  parts: ScorerParts;
}

/**
 * Capture is ON by default — it is this wave's deliverable — and `BAND_SIGNAL_CAPTURE_ENABLED=0`
 * is the no-rebuild kill switch for a new write path on the hot serving path.
 *
 * Note which flag this is NOT. `BAND_OUTCOME_ENABLED` (default OFF) gates the separate lane that
 * EVALUATES these rows against venue candles. Capture is cheap and local; evaluation costs
 * upstream budget that the published metric's own evaluator also draws on. Two concerns, two
 * flags, and conflating them would make "stop the expensive thing" also mean "stop measuring".
 */
export function bandCaptureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.BAND_SIGNAL_CAPTURE_ENABLED ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false';
}

/**
 * THE BAND PREDICATE — the exact complement of the persistence gate, and side-agnostic.
 *
 * NOT "BUY 45-51". SELL emits at confidence >= 62 today, above the gate, so today the band is
 * BUY-dominated — but `request_log` already holds 2 emitted SELLs below 52 (min confidence 30),
 * and `getThresholdForTF` (identity today, live code) can move either side with no diff here.
 * Keying on the SIDE rather than the predicate would silently stop capturing the moment a
 * threshold moved, which is exactly when the corpus would matter most.
 */
export function isBandConfidence(confidence: number): boolean {
  return Number.isFinite(confidence) && confidence >= 0 && confidence < MIN_TRACKABLE_CONFIDENCE;
}

// ── Runaway guard (see the header: a GUARD, not a sampler) ──
let bandDayBucket = -1;
let bandCapturedToday = 0;
let capWarnedForDay = -1;

/** Test seam — the counter is module state, so a suite exercising the cap must reset it. */
export function _resetBandCapForTest(): void {
  bandDayBucket = -1;
  bandCapturedToday = 0;
  capWarnedForDay = -1;
}

/**
 * Default 200,000/day: ~22x the high end of the measured-rate estimate (5.6k-8.9k/day), so it
 * cannot bind in normal operation and only fires on a genuine runaway. R2b replaces the estimate
 * with a measurement; if the real rate lands materially above the estimate, that is itself a
 * finding and this number gets re-derived from it rather than nudged.
 */
export function bandDailyCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.BAND_CAPTURE_DAILY_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 200_000;
}

/**
 * Admit-or-drop against the process-local daily cap.
 *
 * NO SILENT TRUNCATION: crossing the cap logs once per UTC day, with the count. A capture path
 * that drops rows without saying so reads downstream as "the band was small that day", which is
 * the one conclusion this corpus must never manufacture.
 */
export function admitBandCapture(decidedAt: number, cap: number): boolean {
  const day = Math.floor(decidedAt / 86_400);
  if (day !== bandDayBucket) {
    bandDayBucket = day;
    bandCapturedToday = 0;
  }
  if (bandCapturedToday >= cap) {
    if (capWarnedForDay !== day) {
      capWarnedForDay = day;
      console.warn(
        `[band-signal-capture] daily cap ${cap} reached for UTC day ${day}; further band ` +
          `captures DROPPED until 00:00Z. The band is UNSAMPLED by design, so this is a runaway ` +
          `signal, not routine throttling — investigate emission-threshold movement before ` +
          `raising BAND_CAPTURE_DAILY_CAP.`,
      );
    }
    return false;
  }
  bandCapturedToday += 1;
  return true;
}

/**
 * Record one emitted-but-untracked directional call. Fire-and-forget, fail-open, silent on
 * success.
 *
 * Returns `void` synchronously — no `await` reaches the request path, so "this adds no latency to
 * a caller's response" is a property of the shape rather than a benchmark that came out flat.
 * A capture failure must never affect what the caller receives: we are measuring the product, not
 * changing it.
 */
export function recordBandSignalCapture(c: BandSignalCapture): void {
  if (!bandCaptureEnabled()) return;
  // Offline under vitest by default so a trade-call test never spins up the SQLite backend —
  // the same seam `hold-decision-capture` uses, and it earns its keep: running the full suite
  // with `BAND_CAPTURE_TEST=1` set globally TIMES OUT the trade-call suites, which is precisely
  // the backend spin-up this guard exists to prevent. Set it per-file, never for a whole run.
  // The population-invariance suite does not need it — it calls the DB writer directly.
  if (process.env.VITEST && process.env.BAND_CAPTURE_TEST !== '1') return;
  if (!admitBandCapture(c.decidedAt, bandDailyCap())) return;
  void import('./upstream-weight-budget.js')
    .then(async (wb) => {
      const arm: CaptureArm = resolveCaptureArm(wb.currentCaller());
      const db = await import('./performance-db.js');
      db.recordBandSignal(
        c.coin, c.signal, c.confidence, c.timeframe, c.priceAtSignal,
        c.exchange, c.regime, arm, c.isBotInternal, c.parts,
      );
    })
    .catch((e) =>
      console.warn(
        `[band-signal-capture] record failed (fail-open): ${e instanceof Error ? e.message : e}`,
      ),
    );
}

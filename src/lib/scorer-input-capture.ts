/**
 * scorer-input-capture.ts — OPS-SCORER-INPUT-PERSISTENCE-W1 R1b.
 *
 * The EMITTED arm's capture seam: the fire-and-forget wrapper around `recordScorerInputs`.
 *
 * The hold and band arms need no module like this — their parts ride inside the capture payloads
 * their own seams already send, so they inherit those seams' flag, cap, arm resolution and
 * fail-open behaviour for free. The emitted arm has no such seam (`recordSignal` writes the
 * anchored table directly and must not grow a second concern), so it gets this one, shaped
 * deliberately like `band-signal-capture.ts` rather than invented afresh.
 *
 * ── THE KILL SWITCH IS ONE FLAG FOR ALL THREE ARMS ───────────────────────────────────────────
 *
 * `SCORER_INPUT_CAPTURE_ENABLED=0` stops capture everywhere, with no rebuild and no deploy. One
 * flag rather than three because the thing an operator would want to stop is "the new write on
 * the serving path", which is a single concern that happens to have three sites; three flags
 * would mean an incident is resolved by remembering all of them, and a partly-disabled capture
 * produces a corpus whose arms cover different time ranges — the worst of both outcomes.
 *
 * Capture is ON by default: it is this wave's deliverable, it is forward-only, and every day it
 * does not run is a day of permanently lost data.
 */
import { scorerCaptureEnabled, type ScorerParts } from './scorer-input-codes.js';
import { resolveCaptureArm, type CaptureArm } from './hold-decision-capture.js';

export interface ScorerInputCapture {
  /** Epoch SECONDS — the same unit and meaning as `signals.created_at`. */
  decidedAt: number;
  /**
   * The parent row's anchor identity, computed at the call site and passed unchanged to
   * `recordSignal`, so the two cannot disagree about which decision this is.
   */
  signalHash: string;
  coin: string;
  signal: 'BUY' | 'SELL';
  confidence: number;
  timeframe: string;
  exchange: string;
  regime: string | null;
  isBotInternal: boolean | null;
  parts: ScorerParts;
}

/**
 * Record the scorer's inputs for one EMITTED (tracked) call. Fire-and-forget, fail-open, silent
 * on success.
 *
 * Returns `void` synchronously — no `await` is added to the request path, which is what makes the
 * byte-identical-latency requirement a property of the SHAPE rather than a benchmark that
 * happened to come out flat. The DB write lands in a microtask after the response is built.
 *
 * NO DAILY CAP, and unlike the band arm's runaway guard that is a considered choice rather than
 * an omission. The emitted arm is bounded by `recordSignal` itself: a row exists here only when a
 * tracked signal was written, measured at ~3.5k/day against the band's ~3.8k and the hold arm's
 * ~117k. A cap would add a silent drop path to the smallest, most valuable arm — the one whose
 * rows carry an anchored parent and an existing triple-barrier label.
 */
export function recordScorerInputCapture(c: ScorerInputCapture): void {
  if (!scorerCaptureEnabled()) return;
  // Offline under vitest by default so a trade-call test never spins up the SQLite backend. The
  // sibling seams use the same guard and it earns its keep there — running the full suite with
  // the band flag set globally TIMES OUT the trade-call suites. Set it per-file, never per-run.
  if (process.env.VITEST && process.env.SCORER_CAPTURE_TEST !== '1') return;
  void import('./upstream-weight-budget.js')
    .then(async (wb) => {
      // Resolved from `currentCaller()` inside the seam, never guessed at the call site — the
      // request path and the fleet seeder both reach `getTradeSignal`, and only this module can
      // tell them apart. Same contract as `hold_decisions.arm` and `band_signals.arm`.
      const arm: CaptureArm = resolveCaptureArm(wb.currentCaller());
      const db = await import('./performance-db.js');
      db.recordScorerInputs({ ...c, arm });
    })
    .catch((e) =>
      console.warn(
        `[scorer-input-capture] record failed (fail-open): ${e instanceof Error ? e.message : e}`,
      ),
    );
}

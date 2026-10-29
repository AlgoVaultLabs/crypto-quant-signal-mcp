/**
 * OPS-DIGEST-EVAL-COVERAGE-W1 (2026-10-29): pure renderer for the count lines of the daily Telegram digest's
 * 📈 Signal Performance section.
 *
 * Same shape as `merkle-anchor-format.ts`: extracted from `src/scripts/monitor.ts` so the layout is
 * golden-testable in isolation. Returns the lines WITHOUT the section header; the caller splices them in
 * above the merkle anchoring lines.
 *
 * WHY IT EXISTS. `runDigest` computed `pending = total − overall.totalEvaluated`. When OPS-SERVED-CANDLE-TRUTH-W1
 * CH3 narrowed `totalEvaluated` to win-rate-ELIGIBLE rows (`SQL_PFE_ELIGIBLE`), "Evaluated" silently became
 * "scored" and ~81.7k evaluated-but-excluded rows started reading as "Pending evaluation". A consumer that
 * subtracts two producer aggregates changes meaning whenever the producer redefines either one.
 *
 * So every count here projects from ONE aggregate (`PerformanceStats.overall`, one scan on every producer), each
 * labelled by what it counts, and the only arithmetic is between counts of NESTED populations of non-HOLD calls:
 *   T  totalCalls       every call
 *   E  totalWithResult  the evaluator wrote a result     (`isEvaluatedRow` / `SQL_EVALUATED`)
 *   S  totalEvaluated   scored for win rate              (`isPfeEligible` / `SQL_PFE_ELIGIBLE`)
 *   P = T − E           no result yet (`pfeExclusionOf` = 'unevaluated')
 *   X = E − S           evaluated, excluded from scoring ('frozen' + 'defect_window')
 * A redefinition of S moves X and leaves P alone, which is the property the old line lacked (test-pinned against
 * `pfeExclusionOf` class counts, with a mutant that must fail).
 *
 * A count that is non-finite or negative, or a difference that goes negative (S > E, E > T: the nesting broke),
 * renders `⚠️ counts inconsistent (T/E/S)` and NO number. A wrong number in an operator digest is acted on; a
 * refusal is investigated. This module owns no Telegram call and never throws.
 */

import { PFE_EXCLUSION_CLASS_NAMED_BY } from './pfe-scoring.js';
import type { PerformanceStats } from '../types.js';

/**
 * S2's words in `SCORING_EXCLUSIONS_RULE`. The frozen book is a predicate (`isFrozenEvaluation`), not a registry
 * class, so `PFE_EXCLUSION_CLASS_NAMED_BY` has no entry for it. Test-pinned as a substring of the rule, like every
 * registry class's words are.
 */
export const FROZEN_CLASS_NAMED_BY = 'on a market that did not trade during the evaluation window';

/** What "excluded" counts: the frozen class, then every registry class, in the public rule's own words. */
export const EXCLUDED_LABEL = [FROZEN_CLASS_NAMED_BY, ...Object.values(PFE_EXCLUSION_CLASS_NAMED_BY)].join('; ');

export const COUNTS_INCONSISTENT_LINE = '• ⚠️ counts inconsistent (T/E/S)';

export interface SignalPerformanceCounts {
  total: number;
  evaluated: number;
  scored: number;
  excluded: number;
  pending: number;
}

/** T/E/S and the two differences, or `null` when any of the five is non-finite or negative. */
export function signalPerformanceCounts(overall: PerformanceStats['overall'] | null | undefined): SignalPerformanceCounts | null {
  const total = overall?.totalCalls;
  const evaluated = overall?.totalWithResult;
  const scored = overall?.totalEvaluated;
  if (typeof total !== 'number' || typeof evaluated !== 'number' || typeof scored !== 'number') return null;
  const c: SignalPerformanceCounts = { total, evaluated, scored, excluded: evaluated - scored, pending: total - evaluated };
  return Object.values(c).every((v) => Number.isFinite(v) && v >= 0) ? c : null;
}

// Pinned locale, as in merkle-anchor-format.ts: a bare toLocaleString() makes the golden tests host-dependent.
const num = (n: number): string => n.toLocaleString('en-US');

/** E/T, floored to 0.1 %: it never reads 100.0 % while a call is still pending. */
function share(part: number, whole: number): string {
  return whole > 0 ? `${(Math.floor((part / whole) * 1000) / 10).toFixed(1)}%` : '—';
}

export function formatSignalPerformance(overall: PerformanceStats['overall'] | null | undefined): string[] {
  const c = signalPerformanceCounts(overall);
  if (!c) return [COUNTS_INCONSISTENT_LINE];
  const w = overall?.pfeWinRate;
  return [
    `• Total trade calls: ${num(c.total)}`,
    `• Evaluated: ${num(c.evaluated)} (${share(c.evaluated, c.total)})`,
    `• Scored for win rate: ${num(c.scored)} · ${num(c.excluded)} excluded (${EXCLUDED_LABEL})`,
    `• PFE Win Rate: ${typeof w === 'number' && Number.isFinite(w) ? `${(w * 100).toFixed(1)}%` : 'N/A'}`,
    `• Pending evaluation: ${num(c.pending)}`,
  ];
}

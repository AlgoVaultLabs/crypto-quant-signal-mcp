import { getAdapter } from '../lib/exchange-adapter.js';
import { assertVenueNotRetired } from '../lib/venue-store.js';
// `emaLast` dropped (SIGNAL-CLOSEDBAR-SHADOW-W1 CH2): its only two call sites assigned
// `ema9Val`/`ema21Val`, which nothing ever read — dead on origin/main, so that was two
// full EMA passes per signal on a path `scan_trade_calls` fans out across many assets.
// The extraction surfaced it; the golden fixture proves removing it changed no output.
import { rsi, ema, atr, hurstExponent, detectSqueeze } from '../lib/indicators.js';
import { canAccessCoin, canAccessTimeframe, freeGateMessage, isFreeTier, checkQuota, trackCall, getUpgradeHint, getRequestSessionId, getMonthlyQuota, monthResetAtMs, periodStartMs, utcDayResetAtMs, setRequestHoldCapture } from '../lib/license.js'
import type { TrackCallResult } from '../lib/license.js';
import { recordSignal, recordFunding, getFundingZScore, recordHoldCount } from '../lib/performance-db.js';
import { MIN_TRACKABLE_CONFIDENCE } from '../lib/published-population.js';
import { FUNDING_Z_WINDOW_DAYS } from '../lib/funding-window.js';
import { buildFactorLedger, renderVerdictReasoning } from '../lib/verdict-factors.js';
import { hashSignal } from '../lib/merkle.js';
import { getDexForCoin, classifyAsset, isMemeCoinLiquid, isKnownTradFi, getTop20ByOI } from '../lib/asset-tiers.js';
import { getVenuesSupporting, COVERAGE_PROBED_AT } from '../lib/venue-coverage.js';
import { TradFiSymbolUnsupportedOnVenueError, TierLimitReachedError, InsufficientCandlesError } from '../lib/errors.js';
import { referralCodeForKey } from '../lib/referral-store.js'; // REFERRAL-INPRODUCT-NUDGE-W1: keyed→code, keyless→null
import { resolveAssetClass } from '../lib/underlying-type.js';
import { classifyUnderlyingSession, isClosedState } from '../lib/market-sessions.js';
import { tradfiFundingAnnotation } from '../lib/tradfi-funding.js';
// OPS-PFE-METRIC-INTEGRITY-W1 R2/R3: emit-time book-liveness gate + its fail-open counter.
import { assessBookLiveness, getBookLivenessMode, BOOK_LIVENESS_WINDOW, BOOK_LIVENESS_MIN_GENUINE_BARS } from '../lib/book-liveness.js';
import { recordEmitSuppression, suppressionReasonFor } from '../lib/emit-suppressions.js';
// OPS-HOLD-DECISION-CAPTURE-W1 R1. Safe to import statically: like emit-suppressions above,
// hold-decision-capture has ZERO static imports of its own, so it can never join the
// documented performance-db -> ... -> upstream-weight-budget init cycle.
import { recordHoldDecision, wouldBeSideFromRawScore } from '../lib/hold-decision-capture.js';
// `intervalMsFor` joins the EXISTING candle-guard import rather than arriving as a second
// import of the same module. candle-guard owns TF_INTERVAL_MS outright: this file's private
// getIntervalMs was a THIRD copy of that table and is deleted below.
import { computeSuggestedTimeframes, suggestedActionFor, intervalMsFor } from '../lib/candle-guard.js';
import { withTierWarning, withQuotaState, withAuthState, DEFAULT_UPGRADE_URL } from '../lib/tier-warning.js';
import { computeOiDelta, DEFAULT_OI_WINDOW_MS } from '../lib/oi-snapshots.js';
import { getVenueStatus } from '../lib/venue-shadow.js';
import { PKG_VERSION } from '../lib/pkg-version.js';
import { getClosestTradeable, getTryNext } from '../lib/cross-asset-grid.js';
import { trimToLeaderboardCell } from '../lib/leaderboard-cell.js';
import { formatReceipts } from '../lib/receipts.js';
import { getReceiptTrackRecord } from '../lib/receipts-track-record.js';
import type { TradeCallResult, SignalVerdict, EmaCrossDirection, RegimeType, LicenseInfo, ExchangeId, Candle } from '../types.js';
// The five `*Prose` helpers are no longer imported: `reasoning` is now a projection of
// the factor ledger (V2 R3). They remain EXPORTED from indicator-buckets.ts — their unit
// test is the moat-1 forbidden-token regression guard, which is worth keeping green
// independently of whether this file happens to call them.
import { bucketTrendPersistence, bucketFundingState, bucketBreakoutPending } from '../lib/indicator-buckets.js';
import { getThresholdForTF } from '../lib/pertf-thresholds.js';
import { recordOiScoreShadow } from '../lib/oiscore-shadow.js';
import { getOiScoreSource } from '../lib/oiscore-source-flag.js';
import { splitCandleWindow } from '../lib/candle-window.js';
import { getCandleBasis } from '../lib/candle-basis-flag.js';
import { getTrendMode } from '../lib/trend-mode-flag.js';

interface TradeSignalInput {
  coin: string;
  timeframe?: string;
  includeReasoning?: boolean;
  exchange?: ExchangeId;
  license?: LicenseInfo;
  /**
   * Internal mode: bypass license gates (so the cross-asset grid can score
   * cells outside the caller's tier), skip quota tracking, performance-db
   * `recordSignal` / `recordHoldCount` persistence, and the upgrade-hint
   * envelope fields. Used exclusively by `src/lib/cross-asset-grid.ts` when
   * refreshing the 24-cell grid — those cells are server-side-computed and
   * must not pollute the per-agent quota counters or the track-record DB.
   * External callers never set this.
   */
  internal?: boolean;
}

// ── Indicator weights (v1.5) ──
// Rebalanced from PFE/MAE analysis: EMA was too dominant (death cross = -20 pts),
// causing 97% SELL bias. Halved EMA, redistributed to funding (cross-venue edge) and OI.
// - RSI 30% (best mean-reversion signal — unchanged)
// - EMA 10% (halved — was too persistent, single death cross dominated scoring)
// - Funding 25% (increased — cross-venue edge, Moat Layer 4)
// - OI 15% (increased — real-time directional confirmation)
// - Volume 20% (conviction filter — unchanged)
const WEIGHTS = {
  rsi: 0.30,
  ema: 0.10,
  funding: 0.25,
  oi: 0.15,
  volume: 0.20,
};

// ── The LIVE directional rule, stated as MEASURED (SIGNAL-CLOSEDBAR-FLIP-W1 CH1, 2026-08-07) ──
//   BUY  iff  rawScore  >  40   (BUY_BASE_THRESHOLD)
//   SELL iff |rawScore| >  55   (SELL_THRESHOLD_GATED)
// Both are resolved at the call site through getThresholdForTF(); there is NO regime gating.
//
// The rule is ASYMMETRIC, and this wave deliberately leaves it so.
//
// The v1.5 "symmetric thresholds — both directions require equal conviction" design was
// NEVER WIRED. `SELL_BASE_THRESHOLD = 40` and `BUY_THRESHOLD_GATED = 55` sat here, defined
// and never read — by any call site, test, or dynamic lookup (proven by a full-tree grep
// across every file type before deletion). The sell path has always passed
// SELL_THRESHOLD_GATED as its fallback, so the regime-aware gating those two constants
// described has never existed either. They are deleted rather than left in place, because a
// never-read constant that LOOKS live is a trap: the next person recalibrates by editing the
// dead one and observes no effect. The intent is recorded here precisely because it was real
// and unrealised — a recalibration wave should know it was tried, not rediscover it.
//
// DO NOT "symmetrise" these without measuring first. Over the 7-day shadow window
// (n = 2,733,170): `|raw| > 54` admits 13,152 rows, `|raw| > 55` admits 281 — a 47× cliff,
// because 12,873 rows sit at EXACTLY raw = −55. The score space is DISCRETE (fixed indicator
// ladders × fixed weights), so raw scores pile into atoms and a threshold routinely lands on
// one. Moving SELL by a single point is a 47× emission change, not a tuning nudge.
//
// ── PROVENANCE CORRECTED, AND THE ASYMMETRY RATIFIED (OPS-CLOSEDBAR-SELL-ASYMMETRY-W1, 2026-08-08) ──
// "NEVER WIRED" above is FALSE, and is kept visible because the wrong answer is the lesson.
// The v1.5 symmetric design WAS wired — in `b671c52` (2026-04-10) — and ran for four days.
// `29d9576` (2026-04-14, "R4") DELIBERATELY removed the regime gating on both sides and wired
// BUY→base(40) / SELL→gated(55), stating the intent outright: "Combined effect: BUY has a
// consistent 15-point structural advantage (40 vs 55) regardless of regime … Target: BUY share
// >= 60%". It was flips #4 and #5 of five, applied against a scoring skew `b671c52` had measured
// at 97% SELL share. Only the narrower claim survives: AFTER R4 those two constants were genuinely
// dead, which is why `dc42b38` could delete them.
//   Why the wrong answer looked right: a `-S` pickaxe scoped to THIS path cannot cross the
//   `73e34e5` RENAME (get-trade-signal.ts → get-trade-call.ts) and stops there, showing all four
//   constants as /dev/null additions. Scope provenance pickaxes to a DIRECTORY or use --follow.
//
// SO THE 15-POINT GAP IS AN ARTIFACT — DESIGNED bias-compensation whose cause and whose
// justification have both since dissolved:
//   - the bearish pull it offset was substantially removed by SIGNAL-CLOSEDBAR-FLIP-W1
//     (volume-floor incidence measured 60.06% live basis → 35.26% closed basis), and
//   - `9a0bd02` (2026-05-28) re-measured the differential that justified it at +3.17pp against a
//     pre-declared +5pp KEEP bar and returned verdict RELAX.
//
// IT IS RATIFIED AND DELIBERATELY RETAINED ANYWAY. **DO NOT "FIX" THE ASYMMETRY.** No reachable
// candidate exists: the atom sits at EXACTLY −55 and the rule is strict, so every downward move
// admits it whole. Measured twice, on different windows, same conclusion — cite the right one:
//   FLIP-W1 (n = 2,733,170):  >54 admits 13,152  vs  >55 admits 281  → 47× cliff, 12,873 at −55
//   ASYM-W1 (n = 3,109,879):  >54 admits  4,592  vs  >55 admits 241  → 19× cliff,  4,352 at −55
// And what a relaxation admits is 94.8–98.9% volume-floor + RSI-neutral rows (RSI saying nothing),
// against 10.8% of what is emitted today. Symmetric-40 would emit 55,439 SELLs — 230×.
// Ratified in SIGNAL-CLOSEDBAR-FLIP-W1 Q4, OPS-CLOSEDBAR-RECALIBRATE-READINESS-W1,
// OPS-CLOSEDBAR-DIRECTIONAL-BALANCE-W1, and OPS-CLOSEDBAR-SELL-ASYMMETRY-W1.
// Full evidence: audits/OPS-CLOSEDBAR-SELL-ASYMMETRY-W1-2026-08-08.md
//
// ⚠ EXPIRY CONDITION — THIS RATIFICATION IS NOT PERMANENT, AND IS NOT INHERITABLE.
// "No reachable candidate" is a property of the CURRENT SCORE LADDER, not of the engine. The
// atoms exist only because the score space is DISCRETE: fixed indicator bucket values × fixed
// `WEIGHTS`. `raw` is exactly `Σ bucket_i × WEIGHTS_i` (see deriveVerdict), so the reachable
// score set — and therefore WHERE the atoms sit and how big they are — is a pure function of
// those two inputs. Change EITHER and the atom map moves.
//
// That means a retune from ANY source RE-OPENS the asymmetry question rather than settling it:
//   - editing `WEIGHTS` above (rsi .30 / ema .10 / funding .25 / oi .15 / volume .20);
//   - editing ANY bucket ladder — the volume ladder (100/80/50/10/−30/−70) is the one that
//     produces the current −55 atom, but rsi/ema/funding/oi are equally load-bearing;
//   - an AOE weight promotion becoming live. NOTE, because this is the silent one:
//     `src/lib/aoe-config-reader.ts` ALREADY implements that path — Redis
//     `algovault:aoe:recommended_weights:<venue>:<strategy>`, 60 s cache — and it has ZERO
//     consumers today, so `WEIGHTS` is currently code-only and can move only by editing this
//     file. THE DAY IT IS WIRED INTO THE SCORER, weights become runtime-mutable with no deploy
//     and no diff, and this verdict expires WITHOUT ANY CODE CHANGE TO OBSERVE.
//
// ── DISCHARGED FOR ONE SPECIFIC CHANGE (SIGNAL-TREND-BLINDNESS-FIX-W1 CH3, 2026-08-21) ──
// CH3's trend mode edits the RSI ladder, so it owes this re-derivation. It is discharged
// STRUCTURALLY, and the result is stronger than the warning above assumes: trend mode is a SIGN
// FLIP (`rsiScore = -rsiScore`), and the RSI value set {-100,-80,-40,0,40,80,100} is SYMMETRIC
// under negation — so the flip is a BIJECTION on that set. The reachable rsiScore values do not
// change, therefore neither does the reachable raw-score set. Enumerated exhaustively: 155 atom
// POSITIONS under both flag states, identical; -55 is still an atom and so is +40. The atom map
// does NOT move for this change. Pinned by tests/unit/scorer-trend-mode.test.ts so the next edit
// that DOES move it — an asymmetric ladder, a new bucket value, a WEIGHTS change — fails loudly.
// What moves is the MASS on those atoms, which is emission-weighted and is CH4's to measure.
//
// So whoever wires it, or retunes a ladder, OWNS re-deriving this: re-run the atom histogram and
// the per-candidate counterfactual on the new ladder (§2–§3 of the audit are the template) BEFORE
// assuming 55 is still correct. Do NOT carry the 47×/19× cliff forward as a standing fact — it is
// a measurement of one ladder, and a re-derivation may well find a reachable candidate that does
// not exist today. Related coupling: `MAX_RAW_SCORE = 89` is itself derived from these same
// weights (30+10+20+9+20), and it is PUBLIC-COPY — so a retune also moves every published
// confidence number. One retune, three things to re-derive.
const BUY_BASE_THRESHOLD = 40;
const SELL_THRESHOLD_GATED = 55;

// ── R4 funding-z gate constants (OPS-R4-RELAX-RETIRE-W1, 2026-08-30) ──
// Formerly resolved through the 2-flag firewall `src/lib/r4-relax-flag.ts`
// (`ENABLE_R4_RELAX` / `R4_RELAX_DIRECTION`), retired with that module. The outer flag was
// `0` in production for the whole ~13 weeks it existed, so the firewall's lookup returned
// exactly these two values on every call ever made — the substitution is byte-identical,
// and was PROVEN so over a 571,536-case `deriveVerdict` grid straddling both branches
// below rather than assumed (see the status.md entry).
//
// It was retired rather than enabled because the lever was MEASURED not to exist. Its
// ratified `sell-revert` direction moves `sellSofteningZ` -2.0 -> -2.5, withdrawing the
// `+20` softening below from rows in the band. Re-derived live 2026-08-30 by
// reconstructing the funding z in SQL over `hold_decisions` x `funding_history` (14d
// rolling window, STDDEV_SAMP, n>=20): 2 flip-eligible would-be-SELL rows in 3.232 days
// = +0.62 SELL/day against 33.27/day = +1.9% SELL emission, ~0.05% of the 38.97pp gap to
// the `29d9576` "Target: BUY share >= 60%", and ZERO rows on the -55 atom. 17,966 of
// 17,969 flip-eligible rows (99.98%) were never softened at all: the softening and the
// |raw| threshold select near-disjoint populations.
//
// Deliberately NOT env-configurable. Two committed deploy writers used to re-append the
// pair on every deploy, so deleting the prod `.env` keys alone silently self-healed; both
// writers were removed in the same wave. Moving these values re-opens the atom map — see
// the EXPIRY CONDITION above, and route it through the scoring-ladder wave.
export const R4_THRESHOLDS: { buyPenaltyZ: number; sellSofteningZ: number } = {
  /** Z-Score above which BUY direction gets penalized (rawScore -= 20). */
  buyPenaltyZ: 2.5,
  /** Z-Score below which SELL direction gets softened (rawScore += 20). */
  sellSofteningZ: -2.0,
};

// Theoretical max |rawScore| for proper confidence scaling
// RSI(100)*0.30 + EMA(100)*0.10 + Funding(80)*0.25 + OI(60)*0.15 + Vol(100)*0.20 = 30+10+20+9+20 = 89
// (R1 from generator audit 2026-04-14: prior value 74 was computed from the wrong per-feature maxes,
//  which inflated every confidence output by ~1.20× and clipped the high tail to 100)
const MAX_RAW_SCORE = 89;

// Minimum confidence to record in track record (filters noise).
//
// OPS-SIGNAL-PERSISTENCE-BAND-CAPTURE-W1 R1: RELOCATED to `src/lib/published-population.ts`
// (imported above), value UNCHANGED at 52. It moved because it is not only a write gate — it is
// the population boundary every public aggregate must now state explicitly, and
// `performance-db.ts` cannot import it from here (this module imports THAT one, so the constant
// had to live in a leaf both can reach). One literal, no cycle.
//
// The R6 (2026-04-15) derivation that produced 52 travelled with it and is recorded in the leaf.


// ── SCAN-RANKBY-REFINEMENTS-W1 CH4: the score→verdict tail as a PURE function ──
// Extracted VERBATIM from the inline tail so the live verdict + the oiScore shadow both
// project from ONE derivation (single-derivation LAW). The live path (default
// OISCORE_SOURCE='price') is BYTE-IDENTICAL to the pre-extraction behaviour — guarded by
// the existing get-trade-signal tests + the deriveVerdict golden table (oiscore-shadow.test).
export interface VerdictScoreInputs {
  rsiScore: number;
  emaScore: number;
  fundingScore: number;
  oiScore: number;
  volumeScore: number;
}
export interface VerdictGateInputs {
  fundingZScore: number | null;
  fundingRateAnnualized: number;
  hurstVal: number | null;
  squeezeActive: boolean;
  r4Thresholds: typeof R4_THRESHOLDS;
  buyThreshold: number;
  sellThreshold: number;
  /**
   * OPS-PFE-METRIC-INTEGRITY-W1 R2: false ⇒ the book is not trading, so no directional call
   * may be emitted into it (the verdict collapses to HOLD).
   *
   * OPTIONAL and defaulting to live-when-absent, deliberately: `deriveVerdict` is a pure
   * exported function with several test call sites, and per CLAUDE.md an optional TRAILING
   * field keeps every existing caller assignable instead of forcing an N-site cascade. Absent
   * ⇒ legacy behaviour, byte-identical.
   */
  bookLive?: boolean;
}
export interface VerdictOutcome {
  signal: SignalVerdict;
  confidence: number;
  rawScore: number;
  scoreAdjustments: string[];
  /**
   * OPS-BOOK-LIVENESS-EXPLAIN-HOLD-W1: the directional call the book-liveness gate WITHHELD.
   * `null` ⇒ nothing was suppressed — the common case, and every legacy caller.
   *
   * THE SINGLE DERIVATION of "was this a suppressed HOLD, and of what". Assigned in the one
   * branch that suppresses, from the same `signal` the note interpolates, so the public
   * sentence, `emit_suppressions` and `hold_decisions` cannot disagree about what happened.
   *
   * It REPLACES `scoreAdjustments.some(a => a.startsWith('Book not trading'))`, which three
   * consumers would otherwise each re-derive by string prefix — the shape that drifts. The
   * equivalence is exact rather than approximate: that branch is the ONLY writer of both, so
   * the field is non-null exactly when the prefix is present. Pinned in both directions by
   * `tests/unit/verdict-reasoning-suppressed.test.ts`, which also asserts no OTHER push in
   * this function can produce that prefix.
   */
  suppressedSide: 'BUY' | 'SELL' | null;
}
export function deriveVerdict(s: VerdictScoreInputs, g: VerdictGateInputs): VerdictOutcome {
  let rawScore =
    s.rsiScore * WEIGHTS.rsi +
    s.emaScore * WEIGHTS.ema +
    s.fundingScore * WEIGHTS.funding +
    s.oiScore * WEIGHTS.oi +
    s.volumeScore * WEIGHTS.volume;
  const scoreAdjustments: string[] = [];
  if (g.fundingZScore !== null) {
    if (rawScore > 0 && g.fundingZScore > g.r4Thresholds.buyPenaltyZ) {
      rawScore -= 20;
      scoreAdjustments.push(`Funding Z-Score ${g.fundingZScore.toFixed(2)} (>+${g.r4Thresholds.buyPenaltyZ}) — extreme crowded longs. BUY penalized 20 pts.`);
    }
    if (rawScore < 0 && g.fundingZScore < g.r4Thresholds.sellSofteningZ) {
      rawScore += 20;
      scoreAdjustments.push(`Funding Z-Score ${g.fundingZScore.toFixed(2)} (<${g.r4Thresholds.sellSofteningZ}) — extreme short crowding. SELL softened 20 pts.`);
    }
    if (rawScore > 0 && g.fundingZScore < -1.5) {
      rawScore += 10;
      scoreAdjustments.push(`Funding Z-Score ${g.fundingZScore.toFixed(2)} (<-1.5) — contrarian bullish. BUY bonus +10 pts.`);
    }
  } else {
    if (rawScore < 0 && g.fundingRateAnnualized > 4.38) {
      rawScore += 15;
      scoreAdjustments.push(`Funding annualized +${g.fundingRateAnnualized.toFixed(2)} — longs crowded, squeeze risk. SELL softened 15 pts (raw fallback, R4 inverted).`);
    }
    if (rawScore > 0 && g.fundingRateAnnualized < -4.38) {
      rawScore += 10;
      scoreAdjustments.push(`Funding annualized ${g.fundingRateAnnualized.toFixed(2)} (<-4.38) — contrarian BUY bonus +10 pts (raw fallback).`);
    }
  }
  if (g.hurstVal !== null) {
    if (g.hurstVal < 0.45) {
      rawScore = rawScore > 0 ? rawScore - 25 : rawScore + 25;
      scoreAdjustments.push(`Hurst ${g.hurstVal.toFixed(3)} (<0.45) — mean-reverting/choppy regime. Directional signal penalized 25 pts.`);
    } else if (g.hurstVal > 0.55) {
      rawScore = rawScore > 0 ? rawScore + 10 : rawScore - 10;
      scoreAdjustments.push(`Hurst ${g.hurstVal.toFixed(3)} (>0.55) — trending/persistent. Directional signal boosted 10 pts.`);
    }
  }
  if (g.squeezeActive && Math.abs(rawScore) > 10) {
    rawScore = rawScore > 0 ? rawScore + 12 : rawScore - 12;
    scoreAdjustments.push(`Volatility squeeze detected (BB inside KC). Breakout setup — directional signal boosted 12 pts.`);
  }
  let signal: SignalVerdict;
  const absScore = Math.abs(rawScore);
  if (rawScore > 0) {
    signal = rawScore > g.buyThreshold ? 'BUY' : 'HOLD';
  } else {
    signal = absScore > g.sellThreshold ? 'SELL' : 'HOLD';
  }

  // OPS-PFE-METRIC-INTEGRITY-W1 R2: book-liveness gate. A book that is not trading has no
  // counterparty, so a directional call into it is unactionable regardless of how good the
  // score is — and it is scored later on zero-volume synthetic flat candles, which the PFE
  // evaluator records as a LOSS (a shut market booked as a wrong call).
  //
  // Applied AFTER the threshold comparison, deliberately: `rawScore` and `confidence` stay the
  // true computed values, so diagnostics, the oiScore shadow and any downstream confidence
  // consumer see what the engine actually thought. Only the ACTION is withheld.
  //
  // `bookLive === false` is the only suppressing value — `undefined` (legacy callers, tests)
  // and `true` both pass through untouched.
  let suppressedSide: 'BUY' | 'SELL' | null = null;
  if (g.bookLive === false && signal !== 'HOLD') {
    scoreAdjustments.push(
      `Book not trading — fewer than ${BOOK_LIVENESS_MIN_GENUINE_BARS} of the last ${BOOK_LIVENESS_WINDOW} bars carried volume. ${signal} suppressed to HOLD (no counterparty to act against).`,
    );
    // Captured BEFORE the overwrite below, from the same value the note interpolates — one
    // derivation, two projections (the internal note, and everything that reads the field).
    suppressedSide = signal;
    signal = 'HOLD';
  }

  const confidence = Math.min(Math.round((absScore / MAX_RAW_SCORE) * 100), 100);
  return { signal, confidence, rawScore, scoreAdjustments, suppressedSide };
}

/**
 * CH4 SHADOW candidate: map a real OI %Δ (contracts basis) → an OI-momentum score,
 * mirroring the priceChange oiScore thresholds onto the OI %Δ (percent). PROVISIONAL —
 * the FLIP wave (SCAN-OISCORE-FLIP-W1) ratifies the final mapping after matured-outcome
 * WR measurement. Same shape/scale as the priceChange oiScore so divergence is meaningful.
 */
export function oiScoreFromOiDelta(oiChangePct: number): number {
  if (oiChangePct > 5) return 60;
  if (oiChangePct > 0) return 20;
  if (oiChangePct < -5) return -60;
  if (oiChangePct < 0) return -20;
  return 0;
}

/**
 * Inputs to the indicator pass. SIGNAL-CLOSEDBAR-SHADOW-W1 CH2.
 *
 * The split is the whole point: `candles` is the ONLY field that changes between the
 * live and closed bases. Everything else is passed in already-resolved so both bases
 * see identical values — which is what makes a divergence attributable to the candle
 * window and nothing else.
 */
export interface IndicatorInputs {
  /** The window to score on — ALL bars (live) or closed-only. ASCENDING. */
  candles: Candle[];
  /** Annualized funding. Not candle-derived; identical under both bases. */
  fundingRateAnnualized: number;
  /**
   * 24h price change. ALWAYS derived from the LIVE current price, under both bases.
   * Price is a LEVEL — valid at any instant — whereas volume is an INTEGRAL over a bar
   * and is only complete once the bar closes. Only integrals move to the closed basis.
   */
  priceChange: number;
  /** Open interest from the asset context. Not candle-derived. */
  openInterest: number;
  /**
   * SIGNAL-TREND-BLINDNESS-FIX-W1 CH3 — is the regime-conditioned RSI polarity ACTIVE?
   *
   * OPTIONAL and defaulting to OFF-when-absent, deliberately. `computeIndicatorScores` is a pure
   * exported function with several test call sites, and per CLAUDE.md an optional TRAILING field
   * keeps every existing caller assignable instead of forcing an N-site cascade. Absent ⇒ legacy
   * behaviour, byte-identical. Same shape as `VerdictGateInputs.bookLive`.
   *
   * It is PASSED IN rather than read here because this function is pure — "zero I/O, zero
   * process.env, zero Date.now()" — and it must stay safe to call twice over two candle windows.
   * The env read happens once, at the caller.
   */
  trendMode?: boolean;
}

/** The five verdict scores plus the candle-derived context the envelope and gates need. */
export interface IndicatorScores extends VerdictScoreInputs {
  regime: RegimeType;
  hurstVal: number | null;
  squeezeActive: boolean;
  emaCross: EmaCrossDirection;
  rsiVal: number | null;
  avgCandleVol: number;
  lastCandleVol: number;
}

/**
 * How many ATRs of separation the EMA pair needs before it counts as a SIDE rather than
 * CONTESTED. This is what gives `RANGING` a MEANING — "the two EMAs are not meaningfully
 * apart, RELATIVE TO HOW MUCH THIS ASSET MOVES" — instead of the fallthrough residue of an
 * RSI band test.
 *
 * ── Why RELATIVE and not an absolute bps figure ─────────────────────────────
 * The first cut of this rule used an absolute 10 bps and was REJECTED at measurement. EMA
 * separation scales with per-bar volatility, so one absolute band means different things at
 * different cadences AND across the asset universe. Measured over 90 cells, the `RANGING`
 * share went 7.3% → 43.8% at 15m, 7.8% → 7.8% at 1h, and 8.6% → **2.9%** at 4h — i.e. at 4h
 * the label claimed a trend 97.1% of the time against 91.4% before, making the wave's PRIMARY
 * defect worse on a timeframe while the 28.7% aggregate looked like the intended correction.
 * An aggregate can be neutral while every component moves.
 *
 * Timeframe is only a PROXY for volatility, and a poor one — BTC at 1h and a low-cap alt at
 * 1h differ just as much. Normalising by the asset's own recent range fixes both axes at once.
 *
 * ── Reused, not invented ────────────────────────────────────────────────────
 * The scale is **ATRP = ATR(14) / price**, which is already this repo's canonical volatility
 * derivation (`rank-constants.ts:26`, the `volatility` rankBy lens; `atr()` in
 * `lib/indicators.ts`). Scaling a threshold by ATR/price is likewise already the idiom here —
 * `computeCrossVenueFundingSentiment` (`get-market-regime.ts:531`) replaced a fixed 1 bps
 * threshold with exactly this. And normalising against an entity's own recent distribution is
 * what `funding_state` already does with its per-asset z-score. A second volatility derivation
 * in this tree would be the defect this arc has spent five waves retiring.
 *
 * ATR's period stays the canonical 14 for the same reason: it is the shipped derivation, and
 * it sits between the classifier's own 9 and 21 rather than being a fast measure read against
 * a slow trend.
 *
 * ── Chosen by INVARIANCE, not by picking a level ────────────────────────────
 * The defensible target is that "contested" means the SAME THING at every cadence; no
 * particular `RANGING` share was aimed at. Swept 0.05→0.45 with the normalised histogram
 * plotted first (flat: 6.33/6.30/6.34/6.10/5.88/5.64/5.46/5.04/4.85/4.62/4.63/4.08% across
 * 0.00→0.60 ATR, against 35.6%-then-collapsing for the rejected absolute band — normalising
 * also made the distribution well-conditioned). 0.30 gives the TIGHTEST cross-timeframe
 * spread, 1.5pp against 40.9pp for the absolute band, and lands on flat ground (5.46%, with
 * 5.64% and 5.04% either side). The resulting level — `RANGING` ≈ 27.8/26.7/28.2% — is
 * REPORTED, not targeted.
 *
 * Values ≤ 0.15 are excluded by the hard gate: every one of them leaves at least one
 * timeframe claiming a trend MORE often than the pre-wave rule did, which would make this
 * wave's primary defect worse on that timeframe.
 *
 * ── RE-MEASURED 2026-08-21 (SIGNAL-TREND-BLINDNESS-FIX-W1 CH2 step 11): 0.30 STANDS ───────────
 * INSTRUMENT, because a baseline without one is not comparable to anything: 20 Binance perps ×
 * {1h, 4h, 1d}, closed basis, PER-BAR accounting (not per-pair), fetch lookback = PRODUCTION's 100
 * periods, n = 5,760 bar-observations, measured 2026-08-21. Pinned against production
 * `classifyRegimeLabel` at K = 12, 60/60 exact — the same derivation, not a second one.
 *
 *   RANGING share  54.1 / 74.0 / 48.9%  (1h / 4h / 1d)   cross-timeframe spread 25.1pp
 *   the figures above this line, from 2026-08-07: 27.8 / 26.7 / 28.2%, spread 1.5pp
 *
 * ⚠️ AN EARLIER RUN OF THIS SWEEP REPORTED 43.6 / 43.1 / 38.8% AND A 4.7pp SPREAD. IT WAS INVALID,
 * and the wrong numbers are kept visible because the error is the lesson. It fetched a 250-period
 * lookback, but the Binance adapter sends `limit: 200` and the venue returns bars FORWARD from
 * `startTime` — so every series ENDED ~50 periods in the PAST. Nothing looked wrong: the run was
 * internally consistent and its PIN passed 57/57. Measured on BTC/4h at ONE instant, the two
 * lookbacks disagreed on the LABEL itself — 100 gave `sep +4.747% / side +1 / TRENDING_UP`, 250
 * gave `sep -0.400% / side -1 / TRENDING_DOWN`. Never fetch beyond the adapter's own cap.
 *
 * ⚠️ ON THE CORRECTED WINDOW THE INVARIANCE CLAIM DOES NOT REPRODUCE. Spread is 19.2-25.1pp across
 * K ∈ {4,6,8,10,12} — nowhere near the 1.5pp claimed above, and much closer to the 40.9pp of the
 * absolute-bps band this coefficient was chosen OVER. A LEVEL that moves with volatility is
 * expected of an ATR-scaled band; a SPREAD that wide is not, and the spread IS the property 0.30
 * was selected for. `0.30` is RETAINED for this wave by architect ruling — re-deriving it is a
 * chapter of work, and it was retained on the belief that the property held — but that belief is
 * now in doubt and the re-derivation is OWED: `SIGNAL-REGIME-BAND-RECALIBRATE-W{NEXT}`.
 * Do not cite 1.5pp, or the 4.7pp that replaced it, as a live figure.
 *
 * A high RANGING share remains the SAFE direction — the failure that matters is a label claiming a
 * trend it cannot support — and 26-51% non-RANGING is still ample for CH3's trend mode.
 *
 * The dated revisit marker that stood here is DELETED rather than re-dated (the literal token is
 * deliberately not reproduced — a scanner cannot tell a live marker from a quotation of one). A
 * dated marker that has expired once is prose, not a control, and a calendar-triggered gate was
 * retired by
 * OPS-TEST-BUDGET-PROMOTION-FIX-W1 for redding the repo on a date. Its replacement is a ticket:
 * SIGNAL-REGIME-BAND-RECALIBRATE-W{NEXT}.
 */
export const REGIME_SEPARATION_ATR_MULT = 0.30;

/**
 * Consecutive bars a side must hold before the label may flip to it. This is HYSTERESIS,
 * and it is new — the pre-wave classifier had none of any kind (no confirmation margin, no
 * minimum dwell), which is why its label reverted within 10 bars 53% of the time.
 *
 * It is computed INSIDE the candle window rather than persisted, so the function stays pure
 * and the server stays stateless (the remote transport runs `sessionIdGenerator: undefined`
 * — session affinity is forbidden).
 *
 * K = 12 is chosen so that minimum dwell ≥ 12 exceeds the pre-wave structural detection lag
 * of 11.64 bars. That makes `dwell/lag ≥ 1` — *a label must outlive its own detection lag* —
 * a STRUCTURAL property of the rule rather than a number reached by tuning. Measured
 * achieved ratio at (10, 12): 1.54, against 0.601 before.
 *
 * ── K = 12 HELD 2026-08-21 (SIGNAL-TREND-BLINDNESS-FIX-W1 CH2 step 3) ────────────────────────
 * A retune to K = 10 was specified and then REVERSED on the measurement. Same instrument as the
 * band constant above (20 coins × 3 tf, per-bar, n = 11,340):
 *
 *   K   RANGING (1h/4h/1d)        spread   flips/100bar   disagree (post-step-6)
 *   10  52.4 / 70.7 / 48.2%       22.5pp   2.24           3.9%
 *   12  54.1 / 74.0 / 48.9%       25.1pp   1.84           4.8%
 *
 * K = 10 costs +21.7% flips per 100 bars — billed per delivery on the `regime_shift` webhook — to
 * buy 0.9pp of disagreement. It DOES gain 2.6pp of spread, so it is not dominated; but neither is
 * it the knee by a clear margin, which is the bar the falsifier set. K = 12 holds.
 * (Re-measured on production's 100-period window. An earlier stale-window run of this same table
 * read 2.33/2.74 flips and 54.3%/51.0% disagree — see the correction on the band constant above.)
 *
 * The deeper reason to hold is that the two RANGINGs are not the same failure. The retired rule's
 * RANGING was STRUCTURAL BLINDNESS — RSI 93.8 permanently disqualified TRENDING_UP, so no amount
 * of waiting fixed it. This rule's RANGING is CONFIRMATION LAG, which is what hysteresis is FOR.
 * Only the first is a bug. K = 10's original basis was a SINGLE wall-clock observation (BTC/4h
 * sitting at run = 11 against K = 12 at one instant); that tape reversed to side −1 within the same
 * session. A permanent constant must not be fitted to one bar of one coin at one moment.
 *
 * FALSIFIER, so this is a decision and not a preference: the sweep above ran under the PRE-step-6
 * predicate. Re-report flips/100bar and disagree on the corrected predicate; if K = 10 is still the
 * knee by a clear margin, take 10 and say so with the numbers.
 *
 * The dated revisit marker is DELETED here for the same reason as on the band constant above.
 */
export const REGIME_CONFIRM_BARS = 12;

/**
 * The public `regime` label: a separation band plus a K-bar confirmation over the closes.
 *
 * ── What changed and why ────────────────────────────────────────────────────
 * The pre-wave rule was:
 *
 *     let regime = 'RANGING';
 *     if (emaCross === 'BULLISH' && rsiVal !== null && rsiVal < 70) regime = 'TRENDING_UP';
 *     else if (emaCross === 'BEARISH' && rsiVal !== null && rsiVal > 30) regime = 'TRENDING_DOWN';
 *
 * Two defects, both measured by SIGNAL-REGIME-LABEL-STABILITY-W1:
 *
 *  1. **The RSI conjunction inverted its own input.** A saturating RSI is *evidence of* a
 *     strong trend, but it FAILED the band test, so a perfect monotone uptrend was labelled
 *     `RANGING` for all 257 of its scorable bars. ~49% of all label changes were an
 *     oscillator crossing 70/30 rather than a trend changing. RSI is no longer consulted.
 *  2. **`RANGING` was the fallthrough default** — the residue of whatever the band rejected,
 *     rather than a statement about the market. It now means one thing: the EMAs are inside
 *     `REGIME_SEPARATION_BPS` of each other, i.e. the cross is genuinely contested.
 *
 * ── Why the confirmation is a look-back, not persisted state ─────────────────
 * Recomputing the whole sequence from the passed window each call is equivalent to carrying
 * state, because the held label converges: with K = 12 over a ~100-bar window there are ~88
 * confirmation opportunities, and if NONE of them agrees then `RANGING` is the honest answer
 * anyway. Pinned by the window-convergence assertion in
 * `tests/unit/regime-label-invariants.test.ts`.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
 * Nothing here feeds a score. `emaScore` reads `emaCross`; this reads `closes`. No verdict
 * can move because of this function, and `regime-label-invariants` asserts that on live data.
 */
export function classifyRegimeLabel(candles: Candle[]): RegimeType {
  const closes = candles.map((c) => c.close);
  const fast = ema(closes, 9);
  const slow = ema(closes, 21);
  if (!fast || !slow) return 'RANGING';

  // The band, in fractional terms, scaled by the asset's own recent range. Computed from the
  // SAME candle array the trend is measured on, so it inherits the selected candle basis
  // (`CANDLE_BASIS=closed` ⇒ complete bars only) rather than reimporting partial-bar
  // contamination through a separate fetch.
  const atrVal = atr(candles.map((c) => c.high), candles.map((c) => c.low), closes, 14);
  const lastClose = closes[closes.length - 1];
  const atrp = atrVal !== null && lastClose > 0 ? atrVal / lastClose : null;
  // No ATR (too few bars) ⇒ no defensible band ⇒ CONTESTED, which reads as `RANGING`. That is
  // the honest answer, and it default-denies rather than asserting a trend on thin data.
  if (atrp === null || !(atrp > 0)) return 'RANGING';
  const band = REGIME_SEPARATION_ATR_MULT * atrp;

  // +1 / −1 = a side; 0 = contested (inside the band, or not yet computable).
  const sides: number[] = [];
  for (let k = 0; k < fast.length; k++) {
    const a = fast[k];
    const b = slow[k];
    if (isNaN(a) || isNaN(b) || b === 0) { sides.push(0); continue; }
    const sep = (a - b) / b;
    sides.push(Math.abs(sep) < band ? 0 : Math.sign(sep));
  }

  let held: RegimeType = 'RANGING';
  for (let k = REGIME_CONFIRM_BARS - 1; k < sides.length; k++) {
    const first = sides[k - REGIME_CONFIRM_BARS + 1];
    let unanimous = true;
    for (let m = k - REGIME_CONFIRM_BARS + 2; m <= k; m++) {
      if (sides[m] !== first) { unanimous = false; break; }
    }
    if (unanimous) held = first > 0 ? 'TRENDING_UP' : first < 0 ? 'TRENDING_DOWN' : 'RANGING';
  }
  return held;
}

/**
 * The indicator pass, extracted PURE so it can be run twice over two candle windows.
 * Mirrors the existing `deriveVerdict` extraction: this function is the score half,
 * `deriveVerdict` is the score→verdict half, and both are exported and unit-testable.
 *
 * Behaviour is byte-identical to the inline block it replaces — pinned by
 * `tests/fixtures/get-trade-call-golden-preclosedbar.json`, recorded from the
 * pre-extraction code. Zero I/O, zero `process.env`, zero `Date.now()`: the funding
 * writes/reads that used to sit in the middle of this block stay in `getTradeSignal`,
 * because a function that must be safe to call twice cannot carry side effects.
 */
export function computeIndicatorScores(i: IndicatorInputs): IndicatorScores {
  const { candles, fundingRateAnnualized, priceChange, openInterest } = i;
  const trendMode = i.trendMode === true;

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  // ── Compute indicators ──
  const rsiVal = rsi(closes, 14);

  // EMA crossover detection.
  //
  // SIGNAL-REGIME-LABEL-RULE-FIX-W1-V2 deleted two branches here. The pre-wave code read
  // `prev9`/`prev21` to distinguish a FRESH cross from a SUSTAINED one:
  //
  //     if (curr9 > curr21 && prev9 <= prev21) emaCross = 'BULLISH';       // ← deleted
  //     else if (curr9 < curr21 && prev9 >= prev21) emaCross = 'BEARISH';  // ← deleted
  //     else if (curr9 > curr21) emaCross = 'BULLISH';
  //     else if (curr9 < curr21) emaCross = 'BEARISH';
  //
  // The trailing pair are SUPERSETS of the leading pair and assign the same value, so the
  // two `prev` reads could not change the result — `emaCross` was already exactly
  // `sign(ema9 − ema21)`. Measured by SIGNAL-REGIME-LABEL-STABILITY-W1. Code that reads a
  // variable it cannot act on is a lie in the source, so the dead branches are gone rather
  // than kept for symmetry. This was NOT an unfinished hysteresis design — no comment ever
  // claimed one; hysteresis is introduced separately, below, and for the first time.
  //
  // `emaScore` (10% weight) derives from `emaCross` and is UNTOUCHED by this wave. The
  // regime label is a RENDERING of the cross, never an input to it — which is what makes
  // every verdict byte-identical across this change.
  const ema9Series = ema(closes, 9);
  const ema21Series = ema(closes, 21);
  let emaCross: EmaCrossDirection = 'NEUTRAL';
  if (ema9Series && ema21Series && ema9Series.length >= 2) {
    const len = ema9Series.length;
    const curr9 = ema9Series[len - 1];
    const curr21 = ema21Series[len - 1];
    if (!isNaN(curr9) && !isNaN(curr21)) {
      if (curr9 > curr21) emaCross = 'BULLISH';
      else if (curr9 < curr21) emaCross = 'BEARISH';
    }
  }

  // Volume
  const avgCandleVol = candles.reduce((s, c) => s + c.volume, 0) / candles.length;
  const lastCandleVol = candles[candles.length - 1].volume;

  // ── v1.4 indicators ──
  const hurstVal = hurstExponent(closes);
  const squeezeActive = detectSqueeze(highs, lows, closes);

  // ── The public regime LABEL (see classifyRegimeLabel) ──
  //
  // Read by nothing in this function's scoring. It is a public rendering, not a gate — the
  // pre-wave comment here claimed it was "used for asymmetric thresholds", which was FALSE
  // (there is no `regime ===` anywhere in the verdict path; the asymmetric-threshold design
  // it referred to was defined and never wired). Corrected by
  // SIGNAL-REGIME-LABEL-RULE-FIX-W1-V2.
  const regime: RegimeType = classifyRegimeLabel(candles);

  // ── Score each indicator (-100 to +100) ──

  // RSI (30% weight): contrarian — oversold = bullish, overbought = bearish
  let rsiScore = 0;
  if (rsiVal !== null) {
    if (rsiVal < 25) rsiScore = 100;
    else if (rsiVal < 30) rsiScore = 80;
    else if (rsiVal < 40) rsiScore = 40;
    else if (rsiVal <= 60) rsiScore = 0;
    else if (rsiVal <= 70) rsiScore = -40;
    else if (rsiVal <= 75) rsiScore = -80;
    else rsiScore = -100;
  }

  // ── SIGNAL-TREND-BLINDNESS-FIX-W1 CH3: TREND MODE, and it is a SIGN FLIP, not a retune ──
  //
  // The ladder above is contrarian in every regime, and saturates: RSI > 75 scores -100 at 0.30
  // weight while a bullish EMA cross scores +100 at 0.10. On BTC 4h through a +20%/3-day advance
  // that nets -20 before anything else is considered — the strongest available evidence of a bull
  // market read as the single most bearish input. Mean-reversion with no trend mode, because the
  // v1.5 refactor deleted the regime branch that would have been one.
  //
  // In a CONFIRMED trend the overbought region flips sign WITH the trend. `regime` alone gates it
  // (get_trade_call emits no trend_strength — a non-RANGING label already implies |sep| > band AND
  // K unanimous bars, so the strength filter is baked into the label).
  //
  // The flip starts at 70, not 75: at 75 a confirmed TRENDING_UP at RSI 72 would still score
  // -80 x 0.30 = -24, and trend mode would do nothing in precisely the band where trends live.
  // The 60-70 rung keeps its -40 — 60-70 is not overbought, and leaving it keeps some
  // mean-reversion character rather than turning the engine into a pure momentum chaser.
  //
  // 🔒 NEGATION is why MAX_RAW_SCORE = 89 cannot move. `-x` preserves `|x|`, so the ladder's range
  // stays exactly [-100, +100] and the theoretical max |rawScore| — 30+10+20+9+20 — is untouched.
  // That number is the DIVISOR of every published confidence value and every anchored row's
  // `confidence` field, so LAW 0 forbids moving it. Weight redistribution was considered and
  // rejected for exactly that reason. Asserted in tests/unit/scorer-trend-mode.test.ts.
  //
  // RANGING and VOLATILE are untouched under both flag states: the blast radius is confined to
  // labels that survived a K-bar confirmation.
  if (trendMode && rsiVal !== null) {
    if (regime === 'TRENDING_UP' && rsiVal > 70) rsiScore = -rsiScore;
    else if (regime === 'TRENDING_DOWN' && rsiVal < 30) rsiScore = -rsiScore;
  }

  // EMA cross (10% weight): trend confirmation
  let emaScore = 0;
  if (emaCross === 'BULLISH') emaScore = 100;
  else if (emaCross === 'BEARISH') emaScore = -100;

  // Funding rate (25% weight): contrarian signal
  // Negative funding = shorts paying = contrarian bullish
  // High positive funding = crowded longs = bearish
  // R2: thresholds are in ANNUALIZED rate (cost of carry as % per year).
  //     Old HL-calibrated raw thresholds { -0.0005, 0, 0.0005, 0.001 } × 8760 = { -4.38, 0, 4.38, 8.76 }.
  //     This preserves HL behavior exactly while making CEX 8h funding directly comparable.
  let fundingScore = 0;
  if (fundingRateAnnualized < -4.38) fundingScore = 80;
  else if (fundingRateAnnualized < 0) fundingScore = 40;
  else if (fundingRateAnnualized > 8.76) fundingScore = -80;
  else if (fundingRateAnnualized > 4.38) fundingScore = -40;

  // OI + price direction (15% weight): momentum confirmation
  // Only score when price direction CONFIRMS the signal, not as standalone
  let oiScore = 0;
  if (openInterest > 0) {
    if (priceChange > 0.02) oiScore = 60;       // Strong up move, moderate bullish
    else if (priceChange > 0) oiScore = 20;      // Weak up, slight bullish
    else if (priceChange < -0.02) oiScore = -60;  // Strong down move, moderate bearish
    else if (priceChange < 0) oiScore = -20;      // Weak down, slight bearish
  }

  // Volume (20% weight): conviction filter
  // High volume confirms the move, low volume = fade
  //
  // SIGNAL-CLOSEDBAR-SHADOW-W1: this is the ladder the wave exists for. Under the LIVE
  // basis `lastCandleVol` is the IN-PROGRESS bar, so volRatio ≈ elapsed_fraction ×
  // true_relative_volume — a bar 10% elapsed scores the −70 floor no matter how heavy
  // it is actually trading. Under the closed basis it is the last COMPLETE bar.
  let volumeScore = 0;
  if (avgCandleVol > 0) {
    const volRatio = lastCandleVol / avgCandleVol;
    if (volRatio > 3.0) volumeScore = 100;
    else if (volRatio > 2.0) volumeScore = 80;
    else if (volRatio > 1.5) volumeScore = 50;
    else if (volRatio > 1.0) volumeScore = 10;
    else if (volRatio > 0.5) volumeScore = -30;
    else volumeScore = -70;
  }

  return {
    rsiScore, emaScore, fundingScore, oiScore, volumeScore,
    regime, hurstVal, squeezeActive, emaCross, rsiVal, avgCandleVol, lastCandleVol,
  };
}

export async function getTradeSignal(input: TradeSignalInput): Promise<TradeCallResult> {
  const coin = input.coin.toUpperCase();
  const timeframe = input.timeframe || '1h';
  const includeReasoning = input.includeReasoning !== false;

  // License gate — bypassed for internal grid-refresh calls so the 24-cell
  // grid can score cells across all assets and timeframes regardless of the
  // ambient request's tier.
  if (!input.internal) {
    if (!canAccessCoin(coin, input.license) || !canAccessTimeframe(timeframe, input.license)) {
      const msg = freeGateMessage(coin, timeframe);
      throw new Error(msg);
    }
  }

  // Quota gate. PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 (R-F): the CHECK happens here, before
  // the upstream venue fetch, so an exhausted caller no longer burns a fetch to be told no —
  // CH1 measured 13,973 such fetches in 30 days on the free tier alone. The INCREMENT still
  // happens after a successful result, because an error is not a verdict and is never charged.
  // Internal grid-refresh calls skip quota entirely — they are server-side
  // pre-computation, not per-agent usage.
  // Typed as the full TrackCallResult so the internal-skip literal and the real result are ONE
  // shape. Left as a narrowed literal the union drops `limit`/`daily_*`, and the refusal below
  // cannot see which meter fired — the branch never refuses, but the TYPE is what carries the
  // discriminator to the throw site.
  const quota: TrackCallResult = input.internal
    ? { allowed: true, used: 0, total: 0, remaining: Infinity, overage: 0, limit: null }
    // AUTH-THREE-STATE-W1 CH3: the no-license fallback is stamped ABSENT rather than left
    // unstamped. `credentialOutcomeOf` would derive the same value, so nothing changes at run
    // time — what changes is that the literal shape the conformance gate bans (`{tier:'free',
    // key:null}` with no outcome) no longer exists anywhere in src/, so the ban can be absolute
    // instead of carrying an exemption for the one site that is actually fine.
    : checkQuota(input.license || { tier: 'free', key: null, outcome: 'ABSENT' });
  if (!quota.allowed) {
    const licenseForReset = input.license || { tier: 'free' as const, key: null, outcome: 'ABSENT' as const };
    // OPS-QUOTA-METER-SURFACE-CONFORMANCE-W1 CH2 (instance 9): ONE discriminator, read once and
    // used for BOTH the `wall` noun and the horizon underneath it. Before this, `wall` was derived
    // correctly right here while `resetAtMs` stayed unconditionally monthly — so an agent branching
    // on `resets_at`, the field `quota-notice.ts` documents as "Machines branch on this", was told
    // to come back in 30 days for a wall that lifts at the next 00:00 UTC.
    const isDailyWall = quota.limit === 'daily';
    throw new TierLimitReachedError({
      currentUsage: quota.used,
      monthlyLimit: quota.total,
      tier: licenseForReset.tier,
      suggestedUpgradeUrl: 'https://api.algovault.com/signup?plan=starter&utm_source=mcp_tool&utm_campaign=tier_limit_reached',
      // OPS-QUOTA-EXHAUSTION-NOTICE-W1: the reset INSTANT (retry_after_days is derived from it),
      // plus the period anchor so the notice can rank subscription vs x402 by measured burn rate.
      // The instant belongs to the wall that REFUSED — `utcDayResetAtMs()` is the same derivation
      // the daily meter enforces against, so `resets_at` cannot disagree with the
      // `retry_after_hours` rendered beside it. Shape copied verbatim from scan-trade-calls.ts,
      // which has had it right since the parent wave's CH3; deriving it a second way here would be
      // exactly the second meter test this arc exists to retire.
      resetAtMs: isDailyWall ? utcDayResetAtMs() : monthResetAtMs(licenseForReset),
      periodStartMs: periodStartMs(licenseForReset),
      referralCode: referralCodeForKey(licenseForReset.key),
      tool: 'get_trade_call', // FUNNEL-FIX-AGENT-X402-NUDGE-W1: enables the suggested_x402 branch,
      // CH1: the wall discriminator + the DAILY pair travel WITH the refusal. Passing
      // `quota.limit` alone would let a daily wall render the monthly numbers again, which is the
      // defect this closes — so the three move together, from the ONE `checkQuota` result.
      wall: isDailyWall ? 'daily' : 'monthly',
      dailyUsed: quota.daily_used,
      dailyLimit: quota.daily_total,
    });
  }

  const exchange = input.exchange || 'BINANCE';

  // Retired-venue gate (OPS-BITMART-RETIRE-W1 Q3): a request naming a venue that has been wound down
  // is declined BY NAME here, before we touch its adapter — otherwise the call hangs on the dead
  // upstream API and returns a raw timeout. No-op for live venues and for internal grid-refresh.
  await assertVenueNotRetired(exchange, input.internal);

  // Venue-coverage gate (TRADFI-SYMBOL-ALIAS-W1 / v1.11.1): if the coin is a
  // known TradFi symbol AND the requested venue does NOT carry it (per the
  // static coverage matrix derived from live CEX exchangeInfo probes), throw
  // a structured `TRADFI_SYMBOL_UNSUPPORTED_ON_VENUE` error with
  // `suggested_venues` so LLM agents can self-retry instead of seeing a raw
  // `400 Bad Request` from the upstream API. Crypto majors / alts / memes
  // fall through unchanged — adapter-level errors still bubble up generically.
  if (isKnownTradFi(coin)) {
    const supported = getVenuesSupporting(coin);
    if (!supported.includes(exchange)) {
      throw new TradFiSymbolUnsupportedOnVenueError(coin, exchange, supported, COVERAGE_PROBED_AT);
    }
  }

  // Determine which HL dex this coin trades on (standard vs xyz/TradFi)
  // Only applicable for Hyperliquid — Binance doesn't have dex types
  const dex = exchange === 'HL' ? getDexForCoin(coin) : undefined;

  // Meme coin liquidity gate — reject illiquid micro-caps before wasting API calls.
  // OPS-3M-EXPAND-W1 (2026-05-22): outer `if (exchange === 'HL')` guard REMOVED;
  // gate now runs for ALL 17 ExchangeId values uniformly via per-exchange-AND
  // semantics in isMemeCoinLiquid. Shadow venues (12 of 17) short-circuit TRUE
  // at the gate level pending per-venue promotion to PUBLIC tier.
  //
  // OPS-TIER4-CLASSIFY-W1 (2026-05-22): pass the actual top-20-by-HL-OI set
  // (1h-cached via getTop20ByOI) instead of the hardcoded `null` that
  // short-circuited the Tier-2 branch inside classifyAsset. Without this,
  // every major-alt coin (anything not TIER_1/TradFi/MEME_KNOWN) defaulted
  // to Tier 4 + routed through isMemeCoinLiquid — incorrectly rejecting
  // top-20-by-OI coins (e.g. AVAX rank 16, LINK rank 17) as "illiquid
  // micro-caps". Steady-state cost: 1h cache hit ≈ free. Cold-start path
  // has static FALLBACK_TOP20 inside getTop20ByOI so this never blocks.
  const top20 = await getTop20ByOI();
  const tier = classifyAsset(coin, top20, exchange); // venue-aware: a CEX tokenized stock won't be wrongly meme-gated (OPS-TIER-CLASSIFIER-XVENUE-W1)
  if (tier === 4) {
    const liquid = await isMemeCoinLiquid(coin, exchange);
    if (!liquid) {
      throw new Error(
        `Signal generation unavailable for ${coin} on ${exchange}: not in ${exchange}'s top-50 by OI ` +
        `or <$10M 24h volume on ${exchange}. TA signals are unreliable for illiquid micro-caps.`
      );
    }
  }

  const adapter = getAdapter(exchange);

  // Fetch candles (100 candles back)
  // `?? 3_600_000` reproduces the deleted private getIntervalMs EXACTLY: for every mapped
  // timeframe the table value is a positive number so `||` and `??` agree, and for an
  // unknown timeframe both yield the 1h fallback. Verified value-identical across all 11
  // keys against candle-guard's TF_INTERVAL_MS before the swap.
  const intervalMs = intervalMsFor(timeframe) ?? 3_600_000;
  const startTime = Date.now() - 100 * intervalMs;
  const [candles, assetCtx] = await Promise.all([
    adapter.getCandles(coin, timeframe, startTime, dex),
    adapter.getAssetContext(coin, dex),
  ]);
  // Everything below assumes oldest-first candles (closes[length-1] = current
  // price, indicators walk forward); a newest-first venue payload would price
  // the signal at the stalest close. No-op for ascending venues.
  candles.sort((a, b) => a.time - b.time);

  // ── SIGNAL-CLOSEDBAR-SHADOW-W1 CH2: split the window ONCE, here, right after the sort
  //    that guarantees ascending order (splitCandleWindow's documented precondition). ──
  //    Named `candleWindow`, never `window`, which would shadow the DOM global.
  const candleBasis = getCandleBasis();
  const candleWindow = splitCandleWindow(candles, intervalMs, Date.now());

  // The window that gates EMISSION. `CANDLE_BASIS` unset ⇒ 'live' ⇒ this is `candles`
  // itself, so the guard below is byte-identical to its pre-wave form. Under the closed
  // basis the count drops by one, which is exactly why the guard must follow the basis
  // rather than always reading the raw array.
  const emittedCandles = candleBasis === 'closed' ? candleWindow.closed : candles;

  const REQUIRED_CANDLES = 30;
  if (emittedCandles.length < REQUIRED_CANDLES) {
    const firstCandleTimeMs = emittedCandles.length > 0 ? emittedCandles[0].time : Date.now();
    const suggestedTimeframes = computeSuggestedTimeframes({
      firstCandleTimeMs,
      nowMs: Date.now(),
      requiredCandles: REQUIRED_CANDLES,
      requestedTimeframe: timeframe,
    });
    throw new InsufficientCandlesError({
      coin,
      exchange,
      timeframe,
      candlesAvailable: emittedCandles.length,
      candlesRequired: REQUIRED_CANDLES,
      suggestedTimeframes,
      suggestedAction: suggestedActionFor(suggestedTimeframes),
    });
  }

  // ── OPS-PFE-METRIC-INTEGRITY-W1 R2: MEASURE book liveness here, immediately after the
  //    REQUIRED_CANDLES guard, where `candles` is sorted ascending and length-validated.
  //    The DECISION happens inside `deriveVerdict` (below) — never as an early return here,
  //    which would bypass ~130 lines of envelope construction AND the `recordHoldCount` write,
  //    making the suppressed emission vanish from `totalGenerated` and shrink the published
  //    hold-rate denominator. Measure early, decide once, in the pure function. ──
  const bookLivenessMode = getBookLivenessMode();
  const bookLiveness = bookLivenessMode === 'off'
    ? null
    : assessBookLiveness(candles);

  // ── Underlying-market session + TradFi funding interpretation
  //    (TRADIFI-SIGNAL-HARDENING-W1). Best-effort; resolveAssetClass never
  //    throws and fails open to UNKNOWN (renders no caveat / no note). ──
  const assetClass = await resolveAssetClass(coin, exchange);
  const session = assetClass === 'UNKNOWN'
    ? { state: 'UNKNOWN' as const, note: '' }
    : classifyUnderlyingSession({ assetClass, at: new Date() });
  const fundingAnnotation = tradfiFundingAnnotation(assetClass);

  const closes = candles.map(c => c.close);
  // ── §7: `currentPrice` stays LIVE under BOTH bases, always. Price is a LEVEL and is
  //    valid at any instant; volume is an INTEGRAL and is only meaningful once its bar
  //    closes. So the reported `price`, the track-record entry price and `recordSignal`
  //    are untouched by this wave — ONLY indicator inputs move to the closed basis.
  //    A future wave will otherwise "helpfully" move this and silently re-price the
  //    entire track record. Do not. ──
  const currentPrice = closes[closes.length - 1];

  // Funding data
  // R2: raw rate is kept for display/API compat and for scale-invariant per-coin Z-score history.
  //     Annualized rate is used by the scorer so HL (1h) and CEX (8h) feeds are comparable.
  const fundingRate = assetCtx.funding;
  const fundingRateAnnualized = assetCtx.fundingAnnualized;
  const funding24hAvg = fundingRate;

  // Price change (24h)
  const priceChange = assetCtx.prevDayPx > 0 ? (currentPrice - assetCtx.prevDayPx) / assetCtx.prevDayPx : 0;

  // Volume
  const volume24h = assetCtx.volume24h;

  // Record funding for Z-Score history (fire-and-forget)
  try { recordFunding(coin, fundingRate); } catch (e) { console.debug('recordFunding failed:', e instanceof Error ? e.message : e); }
  // Fetch Z-Score (async — may return null if < 20 data points)
  let fundingZScore: number | null = null;
  try { fundingZScore = await getFundingZScore(coin, fundingRate); } catch (e) { console.debug('getFundingZScore failed:', e instanceof Error ? e.message : e); }

  // R4: pre-IPO funding is administratively FIXED, not a z-score-bucketed
  // sentiment read — override the bucket for PREMARKET. EQUITY/COMMODITY keep
  // their (structurally-small) z-score bucket but gain an interpretation note.
  const fundingState = fundingAnnotation.fundingStateOverride ?? bucketFundingState(fundingZScore);

  // ── SIGNAL-CLOSEDBAR-SHADOW-W1 CH2 — derive BOTH bases, select ONE. ──
  //
  //    There is deliberately NO `scoringCandles` variable. A single mutable "which
  //    candles" binding is precisely how a later edit silently moves the LIVE path;
  //    two named derivations and one selection cannot do that by accident.
  const indicatorInputs = {
    fundingRateAnnualized,
    priceChange,
    openInterest: assetCtx.openInterest,
    // CH3: read ONCE here, so `computeIndicatorScores` stays pure and both candle bases see the
    // same value. Default-deny — anything but the exact string 'on' is 'off'.
    trendMode: getTrendMode() === 'on',
  };
  const liveBasisScores = computeIndicatorScores({ candles, ...indicatorInputs });

  //    The closed pass runs ONLY when the closed basis is actually selected. It used to
  //    also run for the shadow (`candleShadowEnabled || …`); OPS-CANDLE-BASIS-SHADOW-DECOM-W1
  //    removed the shadow, so the disjunct went with it. This derivation is NOT shadow work
  //    and must never be deleted alongside one: under `CANDLE_BASIS=closed` — the live
  //    production setting since SIGNAL-CLOSEDBAR-FLIP-W1 — `closedBasisScores` IS the
  //    emitted verdict, selected 25 lines below.
  let closedBasisScores: IndicatorScores | null = null;
  if (candleBasis === 'closed') {
    try {
      //  Dropping the in-progress bar reduces the count by ONE, so an asset sitting at
      //  exactly REQUIRED_CANDLES legitimately fails here. That must never reach the live
      //  path — which is why the whole DERIVATION is isolated, not merely the write.
      if (candleWindow.closed.length < REQUIRED_CANDLES) {
        throw new InsufficientCandlesError({
          coin,
          exchange,
          timeframe,
          candlesAvailable: candleWindow.closed.length,
          candlesRequired: REQUIRED_CANDLES,
          suggestedTimeframes: [],
          suggestedAction: '',
        });
      }
      closedBasisScores = computeIndicatorScores({ candles: candleWindow.closed, ...indicatorInputs });
    } catch {
      //  Swallowed deliberately: `closedBasisScores` stays null and `emittedScores` below
      //  falls back to the live basis. The error CLASS used to be captured here for the
      //  shadow row's `error_class` column; with the shadow gone it had no reader, and a
      //  write-only variable is the residue OPS-CANDLE-BASIS-SHADOW-DECOM-W1 exists to remove.
      //
      //  Precise scope, because the obvious reading is wrong: the InsufficientCandles branch
      //  just above is UNREACHABLE under `CANDLE_BASIS=closed`, since the REQUIRED_CANDLES
      //  guard higher up reads `emittedCandles` — which IS the closed window — and throws
      //  first. It stays as a belt-and-braces isolation of the derivation; what this catch
      //  actually still absorbs is a genuine `computeIndicatorScores` fault.
      //  Pinned by candle-basis-regime-wiring.test.ts "the guard follows the basis".
    }
  }

  //    `CANDLE_BASIS` unset ⇒ 'live' ⇒ the emitted scores ARE the live scores ⇒ the
  //    response is byte-identical to pre-wave. This is the chapter's single most
  //    important property, and it is pinned by the golden fixture.
  const emittedScores = candleBasis === 'closed' && closedBasisScores
    ? closedBasisScores
    : liveBasisScores;

  //    Every downstream consumer — verdictGates, deriveVerdict, the reasoning builder and
  //    the envelope's indicators block — projects from this ONE selected object.
  const {
    rsiScore, emaScore, fundingScore, oiScore, volumeScore,
    regime, hurstVal, squeezeActive,
  } = emittedScores;

  // ── SCAN-RANKBY-REFINEMENTS-W1 CH4: the score→verdict tail is now the PURE deriveVerdict
  //    (single-derivation — the live verdict + the oiScore shadow both project from it). The
  //    oiScore re-base is SHADOW-ONLY: OISCORE_SOURCE defaults to 'price' ⇒ the live
  //    call/confidence are BYTE-IDENTICAL to the priceChange-derived behaviour. ──
  // OPS-TRADE-CALL-CLUSTER-W1: per-TF thresholds resolved here (a pure env read; order vs
  // the score is irrelevant) and passed into deriveVerdict alongside the R4 gate constants.
  // The R4 half is NO LONGER an env read — OPS-R4-RELAX-RETIRE-W1 retired that firewall and
  // inlined it as `R4_THRESHOLDS` above.
  const r4Thresholds = R4_THRESHOLDS;
  const buyThreshold = getThresholdForTF(timeframe, 'buy', BUY_BASE_THRESHOLD);
  const sellThreshold = getThresholdForTF(timeframe, 'sell', SELL_THRESHOLD_GATED);
  // `hurstVal` / `squeezeActive` are CANDLE-DERIVED, so the closed basis needs its own
  // gates — reusing the live gates would mix bases and make the divergence unreadable.
  const gatesFor = (s: IndicatorScores): VerdictGateInputs => ({
    fundingZScore, fundingRateAnnualized,
    hurstVal: s.hurstVal, squeezeActive: s.squeezeActive,
    r4Thresholds, buyThreshold, sellThreshold,
    // Only `enforce` may change a verdict. In `shadow` the measurement still runs and is still
    // counted below, but `bookLive` is left undefined so the emitted call is byte-identical to
    // legacy — that is what makes the shadow-compare report trustworthy.
    bookLive: bookLivenessMode === 'enforce' ? (bookLiveness?.live ?? true) : undefined,
  });
  const verdictGates: VerdictGateInputs = gatesFor(emittedScores);

  // oiScore_price = the priceChange-derived score computed above (gated on openInterest>0).
  const oiScorePrice = oiScore;
  // oiScore_oi (SHADOW) = real OI momentum from the CONTRACTS-basis delta (CH3), same OI>0
  // guard. try/catch-isolated: a store error → no shadow this signal, NEVER the live verdict.
  let oiScoreOi: number | null = null;
  try {
    if (assetCtx.openInterest > 0) {
      const oiDeltaContracts = await computeOiDelta(coin, exchange, DEFAULT_OI_WINDOW_MS, 'contracts');
      if (oiDeltaContracts !== null) oiScoreOi = oiScoreFromOiDelta(oiDeltaContracts.oi_change_pct);
    }
  } catch {
    /* shadow source unavailable → no shadow; the live verdict is untouched */
  }

  const priceVerdict = deriveVerdict(
    { rsiScore, emaScore, fundingScore, oiScore: oiScorePrice, volumeScore },
    verdictGates,
  );
  const oiVerdict =
    oiScoreOi !== null
      ? deriveVerdict({ rsiScore, emaScore, fundingScore, oiScore: oiScoreOi, volumeScore }, verdictGates)
      : null;
  // LIVE verdict: default OISCORE_SOURCE='price' ⇒ priceVerdict (byte-identical). The FLIP
  // wave (SCAN-OISCORE-FLIP-W1) sets OISCORE_SOURCE='oi' once matured-outcome WR
  // non-regression is proven; it flips back instantly by unsetting the env.
  const liveVerdict = getOiScoreSource() === 'oi' && oiVerdict ? oiVerdict : priceVerdict;
  const signal: SignalVerdict = liveVerdict.signal;
  const confidence = liveVerdict.confidence;

  // ── OPS-PFE-METRIC-INTEGRITY-W1 R3: count the suppression. C3 — "the rate is MEASURED, not
  //    argued". Fires in BOTH shadow and enforce, so the shadow-compare report and the live
  //    rate are produced by the SAME code path and cannot disagree.
  //
  //    In `shadow` the verdict was NOT gated, so "would have been suppressed" is exactly
  //    `!bookLiveness.live && liveVerdict.signal !== 'HOLD'`. In `enforce` the verdict already
  //    collapsed to HOLD, so that second clause would never fire — hence the mode split.
  //    Internal callers (scan cells, grid warmers) are excluded: they don't mature into
  //    outcomes, and counting them would inflate the rate against a denominator of real
  //    emissions. Fire-and-forget; `recordEmitSuppression` can never throw into this path. ──
  if (!input.internal && bookLiveness && !bookLiveness.live) {
    // OPS-BOOK-LIVENESS-EXPLAIN-HOLD-W1 (architect Q2): reads the STRUCTURED field instead of
    // re-deriving by string prefix. Behaviour-identical — the branch that pushes that note is
    // the only writer of both — and it keeps "was this suppressed" a SINGLE derivation now
    // that a third consumer (the public `reasoning`) exists.
    const wouldSuppress = bookLivenessMode === 'enforce'
      ? liveVerdict.suppressedSide !== null
      : liveVerdict.signal !== 'HOLD';
    // The MODE is recorded with the row (EDGE-SELL-RESOLUTION-ASYMMETRY-W1 Q3). Both stages
    // write here on purpose; without the mode in the data, a reader over the pg-tunnel cannot
    // tell "we withheld this" from "we would have", and the AOE digest's frozen-book footnote
    // was hiding itself on a bare row count — i.e. the moment SHADOW began.
    if (wouldSuppress) {
      recordEmitSuppression(exchange, timeframe, coin, suppressionReasonFor(bookLivenessMode));
    }
  }

  // SHADOW divergence log — fire-and-forget + try/catch-isolated (NEVER blocks/fails the
  // verdict — Data Integrity). Real signals only (skip internal scan cells; they don't
  // mature into Phase-E outcomes). The read-only harness (oiscore-shadow-measure) + the
  // FLIP wave consume this.
  if (!input.internal && oiVerdict && oiScoreOi !== null) {
    void recordOiScoreShadow({
      coin,
      exchange,
      timeframe,
      oiScorePrice,
      oiScoreOi,
      callPrice: priceVerdict.signal,
      callOi: oiVerdict.signal,
      confPrice: priceVerdict.confidence,
      confOi: oiVerdict.confidence,
    }).catch(() => {});
  }

  // OPS-CANDLE-BASIS-SHADOW-DECOM-W1 removed the SIGNAL-CLOSEDBAR-SHADOW-W1 CH2 candle-basis
  // divergence log that sat here. The candle-basis shadow TABLE had become write-only: both
  // readers were retired by OPS-RECALIBRATE-HARNESS-RETIRE-W1 and the closed-bar arc is deferred, so
  // it was a producer with no consumer accruing ~425K rows/day (5.42M rows / 1398 MB at
  // removal). The block derived `liveBasisVerdict` + `closedBasisVerdict` PURELY to populate
  // that row — neither fed the response — so it went whole. The closed-basis SCORES
  // derivation above is a different thing and stays: it is the emitted verdict.
  // A compact signed-raw histogram is archived in the private vault.

  // OPS-TRADE-CALL-CLUSTER-W1 CH5 (2026-05-28) — OPS-TRADE-CALL-CALIBRATION-AUDIT-W1
  // R3 confidence-bucket logger RETIRED. Code-side strip lands today; Hetzner-side
  // env-strip + logrotate-strip + container force-recreate scheduled for
  // 2026-06-04T06:00:00Z (7d capture window honored per Plan-Mode #6 Path B
  // ratification). Captured logs preserved at /var/log/algovault-seed-confidence
  // /*.log.gz via logrotate weekly rotation.

  // ── Reasoning is now a PROJECTION of the factor ledger — built further down ──
  // SIGNAL-REASONING-PROJECTION-W1-V2 R3. The v1.10.0 five-slot bucket template used to
  // be assembled HERE, independently of the score vector that produced the verdict, and
  // that independence was the defect: `regimeProse` + `fundingProse` + … read BUCKET
  // LABELS, so the prose could — and in public did — contradict the call. A BUY at 62%
  // narrated as "no clear direction"; two assets with opposite-signed open interest
  // emitting BYTE-IDENTICAL strings.
  //
  // It moves DOWN this function rather than changing in place, because the ledger needs
  // `oi_change_pct`, which is not resolved until the `computeOiDelta` call below. The
  // `indicator-buckets.ts` helpers stay exported: their unit test is the moat-1
  // forbidden-token regression guard and is worth keeping green on its own.

  // Increment the quota counter on every successful verdict (R-A — HOLD included; see the
  // note further down for why the branch that used to sit here is gone).
  // Internal grid-refresh calls skip the counter entirely.
  const license = input.license || { tier: 'free' as const, key: null, outcome: 'ABSENT' as const };
  // OPS-QUOTA-EXHAUSTION-NOTICE-W1: keep the POST-charge meter reading for `_algovault.quota`.
  // `quota` above is the pre-charge `checkQuota` read, so on a billable call it is one behind —
  // an advance-warning field that under-reports by one is exactly the kind of off-by-one a
  // caller would mistrust. `upgradeHint` deliberately still reads the pre-charge value so the
  // 80% nudge threshold is unchanged by this wave.
  // R-A: every successful verdict is one metered call — HOLD included. The verdict-conditional
  // skip that used to live here is gone; "which verdicts are free" is no longer representable.
  let charged: ReturnType<typeof trackCall> | null = null;
  if (!input.internal) {
    charged = trackCall(license);
  }

  // Upgrade hint: free tier only, never for internal grid-refresh calls (their meta block is
  // discarded anyway). No longer suppressed on HOLD — a HOLD now consumes quota, so withholding
  // the nudge on exactly the verdict that spends their allowance would be the wrong silence.
  const upgradeHint = !input.internal
    ? getUpgradeHint(license, {
        used: quota.used,
        total: quota.total,
        // OPS-QUOTA-BINDING-METER-AND-CONVERSION-W1 CH2: the daily pair `checkQuota` ALREADY
        // returns. Without it the hint divides by the monthly limit, so a 100/day caller sits at
        // 0.40 forever and is nudged on no call at all, right up to the wall.
        dailyUsed: quota.daily_used,
        dailyTotal: quota.daily_total,
      })
    : undefined;

  // EXCHANGE-SHADOW-PROMOTE-W1 / C2: venue lifecycle status surfaced in every
  // tool response envelope. `'promoted'` for the 5 production venues; `'shadow'`
  // for experimental venues onboarded under the SHADOW-PROMOTE state machine.
  // Defaults to `'promoted'` for unknown venues (backward-compat).
  const venueStatus = await getVenueStatus(exchange);

  let meta: TradeCallResult['_algovault'] = {
    version: PKG_VERSION,
    tool: 'get_trade_call',
    compatible_with: ['crypto-quant-risk-mcp', 'crypto-quant-backtest-mcp'],
    session_id: getRequestSessionId() ?? null,
    exchange,
    venue_status: venueStatus,
  };
  if (upgradeHint) meta.upgrade_hint = upgradeHint;
  // ACTIVATION-PAYWALL-W1: structured tier_warning at 75%+ / 90%+ thresholds for
  // free-tier (paid + bot-internal + internal-grid-refresh paths are no-op via
  // withTierWarning's internal gate).
  if (!input.internal) {
    meta = withTierWarning(meta, {
      tier: license.tier,
      currentUsage: quota.used,
      monthlyLimit: quota.total || getMonthlyQuota(license.tier),
      // CH2: the DAILY pair + BOTH horizons. The warning now fires on whichever meter binds, and
      // names that meter's own reset instant — a warning naming the wrong horizon is the defect
      // `quota-notice.ts` records running in production for a day and a half.
      dailyUsage: quota.daily_used,
      dailyLimit: quota.daily_total,
      monthlyResetAtMs: monthResetAtMs(license),
      dailyResetAtMs: utcDayResetAtMs(),
      isBotInternal: license.tier === 'internal',
      upgradeUrl: DEFAULT_UPGRADE_URL,
      tool: 'get_trade_call', // FUNNEL-FIX-AGENT-X402-NUDGE-W1: hard-warning suggested_x402 branch
    });
    // OPS-QUOTA-EXHAUSTION-NOTICE-W1 (R3): always-on quota state — the advance warning that
    // `tier_warning` (80%+) cannot give. Additive; omitted for unmetered/bot-internal callers.
    meta = withQuotaState(meta, {
      tier: license.tier,
      used: (charged ?? quota).used,
      total: (charged ?? quota).total || getMonthlyQuota(license.tier),
      resetAtMs: monthResetAtMs(license),
      // CH2: the POST-CHARGE daily pair, from the same `charged ?? quota` read as the monthly one
      // above — two reads would be two derivations and could disagree by one call.
      dailyUsed: (charged ?? quota).daily_used,
      dailyTotal: (charged ?? quota).daily_total,
      dailyResetAtMs: utcDayResetAtMs(),
      isBotInternal: license.tier === 'internal',
    });
  }

  // v1.10.0: `call` is the canonical verdict field. The legacy `signal` field
  // and all 7 raw indicators (rsi/ema_cross/ema_9/ema_21/hurst/funding_z_score/
  // squeeze_active) are stripped in this chapter — agents reading the response
  // see only the bucketed surface (closes moat-1 quant-weighting leakage).
  // SCAN-RANKBY-W3: oi_change_pct now reads the REAL OI delta from the oi_snapshots
  // store (computeOiDelta — the SAME source the oi_change lens reads → single-derivation),
  // NOT the old priceChange×100 proxy (CH1: that was a 24h PRICE change mislabeled as OI;
  // BTC live showed "OI +1.4% bullish" while real OI fell −1.0%). OMITTED while the store
  // is warming (< 2 snapshots spanning 24h) — omission beats a wrong sign. Fail-soft: a
  // store error never breaks the verdict. The internal verdict scoring (oiScore, ~L307,
  // also priceChange-derived) is UNCHANGED → call/confidence byte-identical.
  let oiDelta: Awaited<ReturnType<typeof computeOiDelta>> = null;
  try {
    oiDelta = await computeOiDelta(coin, exchange, DEFAULT_OI_WINDOW_MS);
  } catch {
    /* oi_snapshots unavailable → omit the OI factor; never break the verdict */
  }
  // Indicators key-order: funding_rate, funding_24h_avg, funding_state,
  // oi_change_pct (+ oi_change_window) [omitted while warming], volume_24h, trend_persistence, breakout_pending.
  // Hoisted out of the `result` literal (key order preserved byte-for-byte) so the
  // factor ledger reads the SAME object the wire carries — a second inline copy here
  // would be a second derivation of the very thing this wave collapses to one.
  const indicators: TradeCallResult['indicators'] = {
    funding_rate: fundingRate,
    funding_24h_avg: funding24hAvg,
    funding_state: fundingState,
    ...(oiDelta ? { oi_change_pct: oiDelta.oi_change_pct, oi_change_window: oiDelta.oi_change_window } : {}),
    volume_24h: volume24h,
    trend_persistence: bucketTrendPersistence(hurstVal),
    breakout_pending: bucketBreakoutPending(squeezeActive),
    underlying_session: session.state,
    ...(fundingAnnotation.fundingNote ? { funding_note: fundingAnnotation.fundingNote } : {}),
  };

  // ── SIGNAL-REASONING-PROJECTION-W1-V2 R1/R3: ONE ledger, three projections ──
  //    `WEIGHTS` is passed IN. The leaf renders public copy, so it must be structurally
  //    unable to leak a coefficient: it cannot print what it never holds. `rawScore` is
  //    passed rather than re-summed — reconstructing the net from the rows would be a
  //    second derivation of the exact quantity this wave exists to unify.
  const factorLedger = buildFactorLedger({
    coin,
    scores: emittedScores,
    weights: WEIGHTS,
    outcome: { rawScore: liveVerdict.rawScore },
    regime,
    indicators,
    gates: { fundingZScore, fundingWindowDays: FUNDING_Z_WINDOW_DAYS },
  });
  const reasoning = includeReasoning
    // OPS-BOOK-LIVENESS-EXPLAIN-HOLD-W1: `suppressedSide` rides in so the caller is TOLD the
    // call was withheld. `confidence` is already a parameter and is the withheld call's own
    // conviction — the renderer states whose number it is rather than changing it.
    ? renderVerdictReasoning(factorLedger, signal, confidence, {
      marketClosed: isClosedState(session.state),
      suppressedSide: liveVerdict.suppressedSide,
      // INJECTED, never imported by the renderer — that module holds zero imports and no
      // constants so it cannot print a figure it does not hold. These are the SAME two
      // constants the internal note at the suppression branch interpolates, so the public
      // sentence and the telemetry note can never quote different pins.
      suppressionPin: { minGenuineBars: BOOK_LIVENESS_MIN_GENUINE_BARS, window: BOOK_LIVENESS_WINDOW },
    })
    : '';

  const result: TradeCallResult = {
    call: signal,
    confidence,
    price: currentPrice,
    indicators,
    regime,
    reasoning,
    timestamp: Math.floor(Date.now() / 1000),
    coin,
    timeframe,
    // AUTH-THREE-STATE-W1 CH2: stamped at the RETURN, not inside the conditional quota block
    // above — auth is orthogonal to metering and must survive every branch that skips quota.
    _algovault: withAuthState(meta, license),
  };

  // P0 VERDICT-WITH-RECEIPTS-W1: attach the inline-proof block. Single-derivation —
  // `formatReceipts` projects from the verdict JUST computed (never re-derives the
  // call) and reads the cached in-process track record (omitted fail-open when the
  // source is momentarily unavailable). Skipped for internal grid-refresh cells,
  // which are trimmed to leaderboard cells downstream and never user-facing.
  if (!input.internal) {
    // V2 R2: the ledger rides in so `factor_ledger[]` and the frozen `factors[]` are two
    // fidelities of ONE derivation. `factors[]` stays byte-identical — both digest
    // renderers `slice(0,3)` it and the bot mirrors that in Python, so widening it here
    // would silently rewrite every Telegram scan line.
    result._receipts = formatReceipts(result, { trackRecord: getReceiptTrackRecord(), ledger: factorLedger });
  }

  // v1.9.0 L2 + L4: HOLD rescue + next-calls hints.
  // Both features read from the same lazy, TTL-cached cross-asset grid. The
  // grid self-refreshes via a promise-coalesced single-flight and silently
  // absorbs per-cell scorer failures, so failures here never degrade the
  // primary response. Fields are OMITTED (not null/[]) when the grid has no
  // matching cell — matches the AlgoVault positioning rule: these are signal
  // surfaces, not trade recommendations.
  //
  // Skipped for internal grid-refresh calls — the AsyncLocalStorage re-entry
  // guard in getGridSnapshot would short-circuit anyway, but guarding at the
  // call site avoids the unnecessary indirection and keeps cell computation
  // leaner.
  if (!input.internal) {
    try {
      const tryNext = await getTryNext({ coin, timeframe }, 3);
      // v1.10.0: `also_see` is the only cross-asset-leaderboard surface;
      // legacy `try_next` field stripped per spec OUTPUT-SANITIZE-W1 C5.
      if (tryNext.length > 0) {
        result.also_see = tryNext.map(trimToLeaderboardCell);
      }
      if (signal === 'HOLD') {
        const closest = await getClosestTradeable({ coin, timeframe });
        if (closest) result.closest_tradeable = trimToLeaderboardCell(closest);
      }
    } catch (e) {
      console.debug('cross-asset-grid enrichment failed:', e instanceof Error ? e.message : e);
    }
  }

  // Record for performance tracking — only high-confidence actionable signals.
  // Internal grid-refresh calls skip persistence entirely so the 24-cell-per-
  // minute grid doesn't pollute the signals / hold_counts tables with
  // duplicate synthetic records.
  if (!input.internal) {
    if (signal !== 'HOLD' && confidence >= MIN_TRACKABLE_CONFIDENCE) {
      try {
        const sigHash = hashSignal({
          coin, signal: signal as 'BUY' | 'SELL', confidence, timeframe,
          timestamp: Math.floor(Date.now() / 1000), price: currentPrice,
        });
        recordSignal(coin, signal, confidence, timeframe, currentPrice, sigHash, exchange, regime);
      } catch (e) {
        console.debug('recordSignal failed:', e instanceof Error ? e.message : e);
      }
    } else if (signal === 'HOLD') {
      try {
        recordHoldCount(coin, timeframe);
      } catch (e) {
        console.debug('recordHoldCount failed:', e instanceof Error ? e.message : e);
      }
      // ── OPS-HOLD-DECISION-CAPTURE-W1 R1 — the capture seam ──
      //
      // THIS IS THE ONLY PLACE IN THE CODEBASE THAT SEES EVERY HOLD. The request path
      // (index.ts:482 → routeTradeCall → getTradeSignal) and the fleet path
      // (seed-signals.ts:774 → getTradeSignal) both arrive here, which is why `hold_counts`
      // above records ~437k/day. Everything the analysis needs is already in scope: the venue,
      // the regime, the live price, and — critically — `liveVerdict.rawScore`, whose SIGN is
      // discarded ten lines into `deriveVerdict` by `Math.abs()` at :273 and exists nowhere else.
      //
      // SINGLE-DERIVATION. The tuple is computed ONCE here and projected two ways: persisted to
      // `hold_decisions` (the labeling work-list, both arms) and stamped into the request-scoped
      // ALS so `logRequest` can write the matching `request_log` columns for the request arm. The
      // two consumers can never disagree about what this decision was, because neither of them
      // re-derives it.
      //
      // NO NEW LATENCY, STRUCTURALLY. Both projections are synchronous, non-awaited and
      // fail-open; the DB write happens in a microtask. Nothing here can delay or fail a response
      // — which is a property of the shape, not a benchmark that happened to come out flat.
      try {
        const capture = {
          decidedAt: Math.floor(Date.now() / 1000),
          coin,
          timeframe,
          exchange: exchange ?? null,
          regime: regime ?? null,
          // POST-adjustment sign. NOT B-DIR's pre-adjustment score — see
          // `wouldBeSideFromRawScore`'s docstring before using this number anywhere.
          wouldBeSide: wouldBeSideFromRawScore(liveVerdict.rawScore),
          confidence,
          priceAtDecision: currentPrice,
          // `arm` is resolved inside recordHoldDecision, not here: it needs `currentCaller()`
          // from upstream-weight-budget, which sits in the documented init cycle.
          isBotInternal: license.tier === 'internal',
          // Reuses the EXACT predicate the shadow-compare above already uses, rather than a
          // second reading of the same condition. OPS-BOOK-LIVENESS-EXPLAIN-HOLD-W1 (architect
          // Q2) moved BOTH onto `suppressedSide`; the prior string-prefix form is behaviourally
          // identical, and consolidating was the point — a third consumer now exists.
          suppressionReason: liveVerdict.suppressedSide !== null
            ? ('book_liveness' as const)
            : ('below_threshold' as const),
        };
        recordHoldDecision(capture);
        setRequestHoldCapture({
          wouldBeSide: capture.wouldBeSide,
          exchange: capture.exchange,
          regime: capture.regime,
          priceAtDecision: capture.priceAtDecision,
        });
      } catch (e) {
        console.debug('hold-decision capture failed:', e instanceof Error ? e.message : e);
      }
    }
  }

  return result;
}

// getIntervalMs DELETED (SIGNAL-CLOSEDBAR-SHADOW-W1 CH2) — it was a third copy of the
// tf→ms table. `intervalMsFor` in src/lib/candle-guard.ts is the single owner; callers
// supply their own fallback, because the two pre-existing call sites already disagreed
// about it (`?? 900_000` vs `|| 3_600_000`), which proves the fallback is caller policy
// and not primitive policy. Three tables → two.

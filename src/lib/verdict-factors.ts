/**
 * verdict-factors.ts — SIGNAL-REASONING-PROJECTION-W1-V2 R1/R3.
 *
 * The ONE factor ledger every verdict projection reads. Before this file the
 * verdict, the `reasoning` prose and `_receipts.factors[]` were THREE independent
 * derivations of one decision, and they drifted to contradiction in public:
 * `factors[]` shipped `oi_change_pct` with a verdict `direction` while open
 * interest enters no verdict score at all, so a BUY could be justified by a
 * factor that never touched the score. Now the score vector is the single source
 * and everything else is a projection of THIS ledger.
 *
 * ── Purity, and why it is stricter than "no I/O" ──────────────────────────────
 * ZERO imports — not even `import type`. Every type is declared inline and matched
 * STRUCTURALLY, so a caller passes its own `RegimeType` / `IndicatorScores` with no
 * cast and no coupling. Same discipline as `candle-window.ts`.
 *
 * The weight vector is INJECTED, never held. That is not ceremony: this module is
 * the one that renders public copy, so it must be structurally incapable of leaking
 * a coefficient. It cannot print what it does not have. `get-trade-call.ts` owns
 * `WEIGHTS`; this file only ever sees the products.
 *
 * ── What "contributes" means, and why it is the load-bearing field ────────────
 * A public indicator is NOT the same thing as a scored input, and it reaches the
 * verdict through one of TWO channels. The full wiring is declared once in
 * `VERDICT_INPUT_CHANNELS` below — this is the summary, not a second copy:
 *
 *   weight     — a term in `rawScore = Σ(score × weight)`
 *   adjustment — a direct `rawScore ±= n` applied after that sum
 *
 * Both genuinely move the score, so `contributes` is true for either. It is a pure
 * function of the field NAME (SIGNAL-LEDGER-INTEGRITY-W1 CH2): it shipped as a
 * per-response condition at three sites and returned `true` for `trend_persistence`
 * on one asset and `false` on three others measured the same hour, which made a
 * structural claim behave like a reading.
 *
 * `contributes:false` rows — `oi_change_pct`, `volume_24h` — are CONTEXT and may never
 * produce a driver sentence or a direction arrow. That single flag is what makes the
 * old "OI +2.4% → bullish" claim unrepresentable rather than merely discouraged.
 *
 * ── Amplifiers have no direction of their own ────────────────────────────────
 * The Hurst and squeeze gates do `rawScore > 0 ? +x : -x` — they scale whatever the
 * net already is. They argue "more of this", never "bullish" or "bearish". They
 * therefore carry `direction:'neutral'` permanently, and by CH3's biconditional their
 * `strength` is permanently `none` — which is what retired the live `neutral` +
 * `dominant` row. Encoding that in data (`kind: 'amplifier'`) rather than in the
 * renderer is what keeps a future edit from re-inventing a signed Hurst.
 */

// ── Public value types (declared inline — see the purity note above) ──

export type FactorDirection = 'bullish' | 'bearish' | 'neutral';
// CH3/A2: `dominant` -> `primary`. The BAND is the truthful semantics (contributions
// within 1% of each other are not a hierarchy), so the threshold stayed and the WORD
// changed — `dominant` naming two rows is a word that has lost its meaning. Renamed one
// day after the field shipped, while it appears in no declared schema and the population
// branching on it is ~0; in 12 months this costs a deprecation cycle instead.
export type FactorStrength = 'primary' | 'supporting' | 'marginal' | 'none';
export type LedgerNet = 'bullish' | 'bearish' | 'neutral';
export type RemainderNet = 'bullish' | 'bearish' | 'flat';

/**
 * The exact frame emitted when the funding z-score is unavailable for want of
 * history. Exported because the renderer and the gate BOTH have to recognise this
 * state, and a second copy of the sentence is a second thing that can drift.
 *
 * D9: `getFundingZScore` returns null below the sample floor, and
 * `bucketFundingState(null)` answers `NORMAL` — a silent default-deny that presents
 * as a real measurement. "Funding is normal" and "we could not measure funding" are
 * different claims and only one of them is true here.
 */
export const FUNDING_HISTORY_TOO_SHORT = 'history too short to score';

/**
 * The 15% term's lookback. `priceChange` is computed against `AssetContext.prevDayPx`,
 * so 24h is the adapter's own semantics rather than a choice made here.
 *
 * Named and EXPORTED because the R4 gate refuses any prose number it cannot source, and
 * a constant passed explicitly to that gate is the only way a figure is allowed to
 * appear (R3.3). The first draft hand-typed "24h" into the frame; the gate caught it,
 * which is the behaviour the gate exists for.
 */
export const PRICE_CHANGE_WINDOW_HOURS = 24;

// ═══════════════════════════════════════════════════════════════════════════════
// CH2 — `contributes` is a DECLARED STRUCTURAL FACT, never a reading
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ── Why this map exists ──────────────────────────────────────────────────────
 * `contributes` shipped as a per-response CONDITION at three sites — `ema !== 0`,
 * `hurst` outside its band, `squeezeActive` — so `trend_persistence` came back `true`
 * on one asset and `false` on the next three. It answers "does this indicator feed the
 * verdict", which is a fact about the MODEL, and a fact about the model cannot legally
 * differ between two calls to the same tool.
 *
 * That is the V2-D5 defect — conflating "is in the model" with "is non-default this
 * time" — recurring inside the code written to retire it. So the fix is a DECLARATION,
 * not a better condition: `contributes` now reads this map by field NAME and touches no
 * value, threshold or reading.
 *
 * ── Two channels, and why the public field stays one boolean ─────────────────
 * A public indicator reaches the verdict two ways:
 *   `weight`     — a term in `rawScore = Σ(score × weight)`
 *   `adjustment` — a direct `rawScore ±= n` applied after that sum
 * Both genuinely move the score, so a "weight terms only" reading would mark
 * `funding_state`, `trend_persistence` and `breakout_pending` as non-contributing while
 * they are worth ±20, ∓25/±10 and ±12 points respectively. That is the lie the boolean
 * exists to prevent.
 *
 * The CHANNEL is recorded here for internal fidelity; the public field remains a single
 * boolean. Exposing two booleans would disclose more model structure — that there are
 * two channels and which factors sit in which — for information no consumer needs.
 */

/** The five weighted score terms. Closed: `Record<WeightTerm, …>` below is exhaustive. */
export type WeightTerm = 'rsi' | 'ema' | 'funding' | 'oi' | 'volume';

/** The verdict adjustments applied to `rawScore` AFTER the weighted sum. */
export type AdjustmentTerm = 'fundingZ' | 'hurst' | 'squeeze';

/** Every ledger row name. Closed, so the channel map cannot silently miss one. */
export type LedgerField =
  | 'funding_state'
  | 'price_change_24h'
  | 'regime'
  | 'trend_persistence'
  | 'breakout_pending'
  | 'oi_change_pct'
  | 'volume_24h';

export type VerdictInput =
  | { channel: 'weight'; term: WeightTerm }
  | { channel: 'adjustment'; term: AdjustmentTerm };

/**
 * BOTH channels are measured in the same unit — points of `rawScore`.
 *
 * Verified against `get-trade-call.ts`: `rawScore = Σ(score × weight)` accumulates the
 * weight terms, and every adjustment is `rawScore ±= 20 | 25 | 10 | 12` on that SAME
 * accumulator. So a cross-channel `|contribution|` comparison is already apples-to-apples
 * and the normalisation CH3 applies is the IDENTITY.
 *
 * Declared as a constant anyway, and asserted by a cross-channel fixture in
 * `verdict-factors-strength.test.ts`: the one thing that would silently break the ranking
 * is a future edit putting one channel on a different unit, and an identity that is
 * pinned is the cheapest possible guard against it.
 */
export const CONTRIBUTION_SCALE = 'rawScorePoints' as const;

export interface ChannelBinding {
  /** Every verdict channel this field feeds. EMPTY ⇒ `contributes: false`. */
  feeds: readonly VerdictInput[];
  /**
   * `directional` — carries a sign of its own.
   * `amplifier`   — scales whatever the net already is (`rawScore > 0 ? +n : -n`), so it
   *                 argues "more of this" and never "bullish"/"bearish". Permanently
   *                 `direction: 'neutral'`, which by CH3's biconditional makes its
   *                 `strength` permanently `none` — this is what retires the
   *                 `neutral`+`primary` row.
   */
  kind: 'directional' | 'amplifier' | null;
  /** Why a field feeds nothing. Present iff `feeds` is empty — an exemption on the ROW. */
  reason?: string;
}

/** The ONE declaration. `Record` over a closed union ⇒ a new field must be mapped to build. */
export const VERDICT_INPUT_CHANNELS: Record<LedgerField, ChannelBinding> = {
  funding_state: {
    feeds: [{ channel: 'weight', term: 'funding' }, { channel: 'adjustment', term: 'fundingZ' }],
    kind: 'directional',
  },
  price_change_24h: {
    // Named for what it READS. The internal identifier is `oiScore`, a historical
    // misnomer: the term is valued from 24h price change and never from open interest.
    feeds: [{ channel: 'weight', term: 'oi' }],
    kind: 'directional',
  },
  regime: {
    feeds: [{ channel: 'weight', term: 'ema' }],
    kind: 'directional',
  },
  trend_persistence: {
    feeds: [{ channel: 'adjustment', term: 'hurst' }],
    kind: 'amplifier',
  },
  breakout_pending: {
    feeds: [{ channel: 'adjustment', term: 'squeeze' }],
    kind: 'amplifier',
  },
  oi_change_pct: {
    feeds: [],
    kind: null,
    reason: 'computeOiDelta output; enters no weight term and no adjustment',
  },
  volume_24h: {
    feeds: [],
    kind: null,
    reason: '24h notional; the scored volume term reads a per-bar candle-volume ratio, a different quantity',
  },
};

/**
 * The inverse map: which public field names each weight term, or `null` when moat-1
 * withholds it.
 *
 * `Record<WeightTerm, …>` is the tsc-exhaustiveness guard CH2 asks for — adding a sixth
 * weight term without deciding whether it is nameable fails the BUILD, not a review.
 * CH4's arithmetic (`withheld + mapped = 5`) is derived from this one object, so the two
 * cannot disagree.
 */
export const WEIGHT_TERM_FIELD: Record<WeightTerm, LedgerField | null> = {
  rsi: null,      // withheld by moat-1 — RSI is in `forbidden_keys`
  ema: 'regime',
  funding: 'funding_state',
  oi: 'price_change_24h',
  volume: null,   // withheld by moat-1 — the scored quantity has no public counterpart
};

/** Weight terms moat-1 withholds. CONSTANT for a given model — see CH4. */
export const WITHHELD_WEIGHT_TERMS: readonly WeightTerm[] =
  (Object.keys(WEIGHT_TERM_FIELD) as WeightTerm[]).filter((t) => WEIGHT_TERM_FIELD[t] === null);

/**
 * `contributes` — a pure function of the field NAME.
 *
 * Takes no value, no threshold, no reading. The same field yields the same answer on
 * every call, forever, which is the entire point of CH2.
 */
/** The withheld block exactly as it reaches the wire. */
export interface WireStrippedRemainder {
  count: number;
  withheld_term_count: number;
  unnameable_this_response: string[];
  unevaluated_terms: string[];
  net: RemainderNet;
}

/**
 * The ONE place the withheld block's wire names are written.
 *
 * It lives in the leaf rather than inline in `receipts.ts` so the field names have a
 * single definition — a second snake_case literal in the formatter is a second
 * derivation of the same contract, which is the failure mode this whole wave repairs.
 * Explicit field copy, never a spread (allow-list LAW).
 */
export function formatFactorLedgerRemainder(r: StrippedRemainder): WireStrippedRemainder {
  return {
    count: r.count,
    withheld_term_count: r.withheldTermCount,
    unnameable_this_response: [...r.unnameableThisResponse],
    unevaluated_terms: [...r.unevaluatedTerms],
    net: r.net,
  };
}

export function fieldContributes(field: string): boolean {
  const binding = VERDICT_INPUT_CHANNELS[field as LedgerField];
  return binding !== undefined && binding.feeds.length > 0;
}

/** `amplifier` rows never carry a direction of their own. Also name-keyed only. */
export function fieldKind(field: string): 'directional' | 'amplifier' | null {
  return VERDICT_INPUT_CHANNELS[field as LedgerField]?.kind ?? null;
}

export interface FactorRow {
  /** Public indicator name — the same vocabulary `_receipts.factors[]` uses. */
  factor: string;
  direction: FactorDirection;
  /** Human/agent-readable value (bucket name, signed percent, or a direction word). */
  value: string;
  /** True iff this indicator feeds a weight term or a verdict adjustment. */
  contributes: boolean;
  strength: FactorStrength;
  /** The reference-frame clause the prose needs. Never a score or a coefficient. */
  humanFrame: string;
  /**
   * 1-based ordering by |contribution|. INTERNAL — the public formatter MUST strip
   * it (D1: rank is an ordinal projection of the weight vector; `strength` is not,
   * because it is scaled to the largest contribution in THIS call).
   */
  rank: number;
}

/**
 * The moat-1-withheld weight terms, accounted for so the ledger adds up.
 *
 * CH4 splits what was one ambiguous number, because a reader has two questions and one
 * scalar cannot answer both: "how many terms are withheld" is a property of the MODEL,
 * "which one could not be named today" is a property of THIS response. V2's D7 specified
 * "count + net sign of moat-1-stripped contributing rows" without saying whether a
 * neutral withheld row counted — the implementation resolved it one way and a reader the
 * other, which is how an ambiguous spec ships an ambiguous field.
 */
export interface StrippedRemainder {
  /**
   * DEPRECATED — retained one cycle so no consumer loses a key in this wave. Now equal
   * to `withheldTermCount`; it used to be a filtered count of non-zero contributions,
   * which is a different statistic wearing a cardinality's name.
   */
  count: number;
  /**
   * How many weight terms moat-1 withholds. CONSTANT for a given model (2 today: `rsi`,
   * `volume`), derived from `WEIGHT_TERM_FIELD` so it cannot drift from CH2's map.
   * A bare `count` beside a noun-less label is what produced the `(new: 6)` misread of
   * 2026-08-01; the name is the fix.
   */
  withheldTermCount: number;
  /**
   * Weight terms that ARE nameable in principle but could not be named this response —
   * today only `ema`, when the regime label and the moving-average read diverge. Empty is
   * the normal case and is a first-class value, not an absence.
   */
  unnameableThisResponse: string[];
  /**
   * Withheld terms whose input was MISSING, so no contribution could be computed —
   * `rsi` when there are too few candles for RSI, `volume` when the average bar volume
   * is zero. Distinct from a term that WAS evaluated and came back neutral.
   *
   * Without this, "they cancelled out" and "we could not measure them" both render
   * `net: 'flat'`. That is the V2-D9 defect (a silent default-deny presenting as a real
   * measurement) applied to a second field, and it is the reason `flat` needs a
   * companion rather than a fourth enum value: `net` stays a direction, and the
   * evaluability fact gets its own name.
   */
  unevaluatedTerms: string[];
  /** Net direction of the WITHHELD terms' contributions, over that constant set. */
  net: RemainderNet;
}

export interface FactorLedger {
  rows: FactorRow[];
  netDirection: LedgerNet;
  /** Highest-ranked contributing row whose direction opposes the net. */
  counterweight: FactorRow | null;
  strippedRemainder: StrippedRemainder;
}

// ── Input (structural — callers pass their own nominal types unchanged) ──

export interface FactorLedgerInput {
  /** Base asset, for the per-asset funding frame ("unusually negative for XRP"). */
  coin: string;
  /** `computeIndicatorScores()` output. The SoT; never recomputed here. */
  scores: {
    rsiScore: number;
    emaScore: number;
    fundingScore: number;
    oiScore: number;
    volumeScore: number;
    hurstVal: number | null;
    squeezeActive: boolean;
    /**
     * CH4 — evaluability of the WITHHELD terms. Both already ride on
     * `computeIndicatorScores()`'s output, so the call site passes them for free.
     * A score of 0 is ambiguous on its own: `rsiScore` is 0 both when RSI sits mid-band
     * AND when there were too few candles to compute it. These two fields are what let
     * the ledger tell "measured, neutral" from "not measured".
     * Optional so existing callers stay assignable (an optional TRAILING field, per the
     * repo's N-implementor rule); absent ⇒ treated as evaluated.
     */
    rsiVal?: number | null;
    avgCandleVol?: number;
  };
  /** `WEIGHTS`, injected by the owner. This module never holds a coefficient. */
  weights: { rsi: number; ema: number; funding: number; oi: number; volume: number };
  /**
   * `deriveVerdict()` output, READ not recomputed. `netDirection` is the sign of the
   * one `rawScore` the verdict used — reconstructing it from the rows would be a
   * second derivation of exactly the thing this file exists to unify.
   */
  outcome: { rawScore: number };
  regime: 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'VOLATILE';
  /** The already-public indicators block. */
  indicators: {
    funding_rate: number;
    funding_state: 'NORMAL' | 'ELEVATED' | 'EXTREME' | 'FIXED_PREIPO';
    oi_change_pct?: number;
    oi_change_window?: string;
    volume_24h?: number;
    trend_persistence: 'LOW' | 'MEDIUM' | 'HIGH';
    breakout_pending: 'INACTIVE' | 'IMMINENT';
  };
  gates: {
    /** null ⇒ below the sample floor. NOT a neutral reading (D9). */
    fundingZScore: number | null;
    /**
     * The z-score lookback in days. A NUMBER, not a label, so the leaf can render both
     * grammatical forms ("over 14 days" / "its normal 14-day band") from the one value
     * the scorer actually uses — passed in rather than redeclared here, so the prose
     * cannot cite a window the z-score never had.
     */
    fundingWindowDays: number;
  };
}

// ── Formatting helpers ──

function signedPct(n: number, dp: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(dp)}%`;
}

/** `-0.00006641` → `-0.0066%`. The same projection the funding frame cites. */
export function formatFundingPct(rate: number): string {
  return signedPct(rate * 100, 4);
}

/** `1144569969` → `$1.14B`. Context only — 24h notional feeds no score. */
function humanizeUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${Math.round(n)}`;
}

function dirOf(signed: number): FactorDirection {
  if (signed > 0) return 'bullish';
  if (signed < 0) return 'bearish';
  return 'neutral';
}

// ── Row construction ──

/** A row plus the signed contribution that ranks it. Contribution never leaves this module. */
interface Scored {
  /**
   * A row builder produces the CONTRIBUTION and the copy. It does NOT produce
   * `direction` or `strength` — `classifyContribution` owns both, from one input.
   * They were assigned here too until CH3; `buildFactorLedger` overwrote them, so
   * the expressions were dead AND readable as authoritative, which is how a second
   * derivation survives a review.
   */
  row: Omit<FactorRow, 'rank' | 'strength' | 'direction'>;
  signedContribution: number;
}

/**
 * Funding: the 25% base term plus the z-score adjustments, as ONE row — because the
 * public surface has one funding concept and splitting it would produce two funding
 * sentences describing the same pressure.
 */
function fundingRow(i: FactorLedgerInput): Scored {
  const { funding_rate: rate, funding_state: state } = i.indicators;
  const z = i.gates.fundingZScore;
  const base = i.scores.fundingScore * i.weights.funding;
  const value = formatFundingPct(rate);
  const side = rate < 0 ? 'shorts pay longs' : rate > 0 ? 'longs pay shorts' : 'neither side pays';

  // D9 — no distribution, so no "unusual"/"normal" claim is available. The BASE term
  // still scored (it reads the annualized ladder, not the z-score), so the row keeps
  // its contribution and its direction; only the FRAME degrades.
  if (z === null) {
    return {
      row: {
        factor: 'funding_state',
        value,
        contributes: fieldContributes('funding_state'),
        humanFrame: `means ${side}, but ${i.coin} funding ${FUNDING_HISTORY_TOO_SHORT}`,
      },
      signedContribution: base,
    };
  }

  if (state === 'FIXED_PREIPO') {
    return {
      row: {
        factor: 'funding_state',
        value,
        // CH2: pre-IPO funding carries no SENTIMENT, but the funding term still reads the
        // annualized rate and still scores it — so the field is wired in either way. The
        // "not a sentiment read" fact belongs in the frame and the neutral direction,
        // which is where it now lives. A per-response `false` here was the same
        // is-in-the-model / is-meaningful-today conflation as the other three sites.
        contributes: fieldContributes('funding_state'),
        humanFrame: 'is administratively fixed pre-IPO, not a sentiment read',
      },
      signedContribution: 0,
    };
  }

  // Two independent reads of funding are live and they can disagree: the z-BUCKET
  // (`funding_state`, per-asset) can say NORMAL while the annualized LADDER
  // (`fundingScore`, global) scores it directional — measured on SOL, funding NORMAL
  // yet contrarian-bullish. The frame states both rather than picking one, because
  // "normal → bullish" with no explanation is the contradiction this wave exists to end.
  const days = i.gates.fundingWindowDays;
  const unusual = state === 'ELEVATED' || state === 'EXTREME';
  const polarity = rate < 0 ? 'negative' : 'positive';
  const humanFrame = base !== 0
    ? unusual
      ? `is unusually ${polarity} for ${i.coin} over ${days} days: ${side}`
      : `is ${polarity} at a normal level for ${i.coin}: ${side}`
    : unusual
      ? `is unusual for ${i.coin} over ${days} days but too small to score`
      : `sits in ${i.coin}'s normal ${days}-day band: no crowd pressure either way`;

  // The z gates in `deriveVerdict` are worth up to 20 points against a 25%-weight base
  // term, so an ELEVATED/EXTREME reading is a real part of this row's weight, not decoration.
  // `rate === 0` has no side, so it leans neither way. The first form was
  // `rate < 0 ? 1 : -1`, which silently bucketed zero as positive and made an ELEVATED
  // state at exactly-zero funding read BEARISH while `factors[]` correctly read neutral.
  // Found by the CH5 divergence gate, not by review — it is precisely the kind of
  // boundary an enumerated-condition gate exists to surface.
  const rateSide = rate < 0 ? 1 : rate > 0 ? -1 : 0;
  const zLean = unusual ? rateSide * Math.min(Math.abs(z), 3) : 0;
  return {
    row: {
      factor: 'funding_state',
      value,
      contributes: fieldContributes('funding_state'),
      humanFrame,
    },
    signedContribution: base + zLean,
  };
}

/**
 * The 15% term. Named for what it actually reads — 24h PRICE change — rather than
 * for the internal `oiScore` identifier, which is a historical misnomer and the
 * direct cause of the public mislabelling this wave retires.
 *
 * No decimal: the 24h change is not emitted in the response, and a prose number with
 * no payload counterpart is exactly what the R4 gate refuses.
 */
function priceChangeRow(i: FactorLedgerInput): Scored {
  const s = i.scores.oiScore;
  const strong = Math.abs(s) >= 60;
  const value = s > 0 ? (strong ? 'sharply up' : 'up') : s < 0 ? (strong ? 'sharply down' : 'down') : 'flat';
  const w = `${PRICE_CHANGE_WINDOW_HOURS}h`;
  return {
    row: {
      factor: 'price_change_24h',
      value,
      contributes: fieldContributes('price_change_24h'),
      humanFrame: s === 0 ? `over ${w}, with no momentum either way` : `over ${w}, the momentum term behind the call`,
    },
    signedContribution: s * i.weights.oi,
  };
}

/**
 * Regime is the public face of the 10% EMA term — but only when they agree.
 *
 * ⚠️ REWRITTEN by SIGNAL-REGIME-LABEL-RULE-FIX-W1-V2. The previous text said:
 *
 *   > Measured (CH1.4): `TRENDING_UP` requires `emaCross === 'BULLISH'` and
 *   > `TRENDING_DOWN` requires `'BEARISH'`, so regime can NEVER carry the opposite sign
 *   > to `emaScore`. It CAN be neutral where emaScore is signed — `RANGING` also absorbs
 *   > a bullish cross at RSI ≥ 70, a bearish cross at RSI ≤ 30, and any null RSI.
 *
 * Both sentences are now FALSE, and the second one is why:
 *
 *  - **RSI no longer participates.** The label is a separation band plus a 12-bar
 *    confirmation over the closes (`classifyRegimeLabel`), so `RANGING` no longer absorbs
 *    an RSI-saturated cross. It now means the EMAs are within `REGIME_SEPARATION_BPS`.
 *  - **Regime CAN now carry the OPPOSITE sign to `emaScore`.** The old conjunction made
 *    that structurally impossible; hysteresis makes it ordinary. `emaCross` is
 *    `sign(ema9 − ema21)` at the CURRENT bar, while the label only flips once a side has
 *    held for `REGIME_CONFIRM_BARS`. In the window between a fresh cross and its
 *    confirmation, the label still reads the OLD side while `emaScore` already reads the
 *    new one. That is the hysteresis doing its job, not a defect.
 *
 * The code below needs no change: `agrees` is a sign comparison, and on ANY disagreement —
 * opposite-sign (new) or signed-vs-neutral (old) — the row degrades to context and the EMA
 * contribution moves to `strippedRemainder`, so the accounting still totals (D4). What the
 * change does is make that branch fire in a new situation, so `stripped_remainder` VALUES
 * move; that shift carries its own sign-off row rather than riding along unannounced.
 */
function regimeRow(i: FactorLedgerInput): { scored: Scored; emaNameable: boolean } {
  const ema = i.scores.emaScore;
  // SIGNAL-TREND-BLINDNESS-FIX-W1 CH2 step 6 — `RANGING` AGREES, unconditionally.
  //
  // It used to require `RANGING && ema === 0`. That predicate was written for the OLD axis, where
  // `RANGING` meant "no EMA-confirmed trend" and could therefore be read as the absence of an EMA
  // opinion. Under the separation band `RANGING` is a verdict ABOUT that same EMA spread — that its
  // magnitude sits below the volatility-scaled noise floor — so scoring it as a DISAGREEMENT is a
  // category error inherited from the retired rule.
  //
  // It was also not a rare one. `emaScore === 0` requires `emaCross === 'NEUTRAL'`, i.e. an EXACT
  // EMA tie, while the band calls `RANGING` whenever `|sep| < band` with `sep` still non-zero — so
  // EVERY `RANGING` bar disagreed, by construction. Measured 2026-08-21 over 20 coins × {1h,4h,1d},
  // per-bar, n = 11,340: 54.3% of bar-observations disagreed at K=12. Leaving it would have pushed
  // the EMA term into `strippedRemainder` on more than half of all public receipts — a reduction of
  // user-visible data as a side effect of a refactor, which Data Integrity forbids outright.
  //
  // The narrow residue that REMAINS a disagreement is the one hysteresis actually creates: a held
  // `TRENDING_*` label surviving across a fresh opposite cross. That is a real divergence between
  // the label and the raw cross, and the row should still degrade to context there.
  const agrees =
    (i.regime === 'TRENDING_UP' && ema > 0) ||
    (i.regime === 'TRENDING_DOWN' && ema < 0) ||
    i.regime === 'RANGING';
  // CH2 step 7 — an unmapped label renders as its OWN lowercased name, never as another label's.
  // The catch-all used to be `: 'volatile'`, so ANY unmapped regime was published on a public
  // receipt as the word "volatile" — a collision with a MEANINGFUL label, which is the defect; the
  // absence of a word never was. Lowercasing cannot be wrong, introduces no new public vocabulary,
  // and adds nothing to a surface that publicly claims four labels. It does not THROW: a rendering
  // fault must never take down a live serving path.
  const label =
    i.regime === 'TRENDING_UP' ? 'trending up'
      : i.regime === 'TRENDING_DOWN' ? 'trending down'
        : i.regime === 'RANGING' ? 'ranging'
          : i.regime === 'VOLATILE' ? 'volatile'
            : String(i.regime).toLowerCase();

  // CH2: `contributes` is the DECLARED map's answer, never `ema !== 0`. Regime feeds the
  // EMA weight term as a matter of wiring, whether or not that term scored today — a
  // dormant term is still in the model. When the signs diverge the row loses its
  // DIRECTION (it can no longer honestly name the term) and the EMA contribution moves to
  // the withheld accounting, but the field's `contributes` answer does not move with it.
  if (!agrees) {
    return {
      scored: {
        row: {
          factor: 'regime',
          value: label,
          contributes: fieldContributes('regime'),
          humanFrame: 'while the moving-average read disagrees — shown as context only',
        },
        signedContribution: 0,
      },
      emaNameable: false,
    };
  }
  return {
    scored: {
      row: {
        factor: 'regime',
        value: label,
        contributes: fieldContributes('regime'),
        humanFrame:
          i.regime === 'RANGING'
            // CH2 step 6: a RANGING bar still carries a signed EMA term — the spread is simply
            // below the noise floor. Naming that honestly is what keeps the term on the receipt.
            //
            // The word "volatility" is DELIBERATELY avoided here. It is `breakout_pending`'s
            // rendered SUBJECT marker (verdict-reasoning-consistency.test.ts SUBJECTS), so a
            // regime clause containing it gets parsed as a breakout clause and this row's
            // direction arrow is attributed to the wrong factor on a PUBLIC receipt. Measured:
            // an earlier draft read "inside the volatility band" and tripped R5.1/R5.2 with
            // `"breakout_pending" arrow bullish ≠ ledger neutral`. Subject markers are reserved
            // vocabulary — check SUBJECTS before wording any humanFrame.
            ? (ema === 0
                ? 'with no trend structure to lean on'
                : 'with the moving averages inside the noise band')
            : 'on the moving-average cross',
      },
      signedContribution: ema * i.weights.ema,
    },
    emaNameable: true,
  };
}

/** Hurst — an AMPLIFIER. Permanently `direction:'neutral'`; see the header note. */
function trendPersistenceRow(i: FactorLedgerInput): Scored {
  const h = i.scores.hurstVal;
  const v = i.indicators.trend_persistence;
  const fires = h !== null && (h < 0.45 || h > 0.55);
  const humanFrame = !fires
    ? 'gives no persistence edge either way'
    : h !== null && h < 0.45
      ? 'is mean-reverting, which dampens any directional read'
      : 'is persistent, which amplifies the net read';
  // Contribution is attached by `buildFactorLedger` via `amplifierMagnitude` — an
  // amplifier's weight comes from the adjustment ladder, not from a weighted score.
  //
  // CH2: `contributes` is the map's answer, NOT `fires`. This row is the one that shipped
  // `true` on XRP (`HIGH`) and `false` on three other assets (`MEDIUM`) — because `fires`
  // asks "did the Hurst gate move the score THIS time", which is a reading, while
  // `contributes` asks "is this indicator wired into the verdict", which is a fact.
  // Whether the gate fired is still expressed, in `humanFrame` and in the contribution.
  return {
    row: {
      factor: 'trend_persistence',
      value: v,
      contributes: fieldContributes('trend_persistence'),
      humanFrame,
    },
    signedContribution: 0,
  };
}

/** Squeeze — an AMPLIFIER. Permanently `direction:'neutral'`. */
function breakoutRow(i: FactorLedgerInput): Scored {
  const imminent = i.indicators.breakout_pending === 'IMMINENT';
  return {
    row: {
      factor: 'breakout_pending',
      value: i.indicators.breakout_pending,
      // CH2 — the third value-keyed site. Same correction: the squeeze gate is wired in
      // whether or not compression is present right now.
      contributes: fieldContributes('breakout_pending'),
      humanFrame: imminent
        ? 'is compressing with a breakout pending — direction unresolved'
        : 'is neither expanding nor compressed',
    },
    signedContribution: 0,
  };
}

/**
 * Open interest — CONTEXT, never a driver (D5). Its `direction` still uses the same
 * ±0.5% rule `_receipts.factors[]` uses, so the two public views agree on the sign;
 * `contributes:false` is what stops that sign from being read as a reason.
 */
function oiRow(i: FactorLedgerInput): Scored | null {
  const pct = i.indicators.oi_change_pct;
  if (pct === undefined) return null;
  const window = i.indicators.oi_change_window ?? '24h';
  // CH3: this row used to carry the ±0.5% direction so the two public views agreed on
  // the sign. They no longer do, and that is the correction: `contributes:false` ⇒
  // `direction:'neutral'`, because a row that moved nothing has no verdict direction to
  // report. The SIGN is not lost — it is right there in `value` (`+2.4%`), which is where
  // a reader should take it from. What is gone is the implication that it was a reason.
  // (The legacy `factors[]` array still ships the ±0.5% direction; that divergence is now
  // BOUNDED and pinned by the CH5 gate rather than left to be discovered.)
  return {
    row: {
      factor: 'oi_change_pct',
      value: signedPct(pct, 1),
      contributes: fieldContributes('oi_change_pct'),
      // Short by necessity: this frame competes for a 280-char budget. The full
      // statement is carried by `contributes: false` on the wire, which is the field an
      // agent branches on — prose does not have to re-explain what the schema says.
      humanFrame: `over ${window}, context only and not a verdict input`,
    },
    signedContribution: 0,
  };
}

/** 24h notional — CONTEXT. The scored volume term reads a candle ratio, a different quantity. */
function volumeRow(i: FactorLedgerInput): Scored | null {
  const v = i.indicators.volume_24h;
  if (v === undefined) return null;
  return {
    row: {
      factor: 'volume_24h',
      value: humanizeUsd(v),
      contributes: fieldContributes('volume_24h'),
      humanFrame: 'over 24h — context; the scored volume read is a per-bar ratio',
    },
    signedContribution: 0,
  };
}

/**
 * Amplifier magnitudes, read off `deriveVerdict`'s own ladder so the ranking reflects
 * what the gates are actually worth. Kept here rather than injected because these are
 * ADJUSTMENT sizes, not model coefficients — they are already narrated in the internal
 * `scoreAdjustments` strings and never reach a public field.
 */
const HURST_MEAN_REVERT_PENALTY = 25;
const HURST_TRENDING_BOOST = 10;
const SQUEEZE_BOOST = 12;

function amplifierMagnitude(i: FactorLedgerInput, factor: string): number {
  if (factor === 'trend_persistence') {
    const h = i.scores.hurstVal;
    if (h === null) return 0;
    if (h < 0.45) return HURST_MEAN_REVERT_PENALTY;
    if (h > 0.55) return HURST_TRENDING_BOOST;
    return 0;
  }
  if (factor === 'breakout_pending') {
    return i.scores.squeezeActive && Math.abs(i.outcome.rawScore) > 10 ? SQUEEZE_BOOST : 0;
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CH3 — `direction` and `strength` are ONE derivation, mutually consistent
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * `strength` is a SHARE of the largest contribution in this call, never an absolute
 * point scale and never the weight coefficient. An absolute scale would let a reader
 * infer coefficient magnitudes across observations; a within-call share conveys only
 * relative ordering — and it preserves V2-D1's requirement that a 10%-weight factor at
 * an extreme value can legitimately be the top contributor.
 *
 * A BAND, not a strict top-one, is the truthful semantics: forcing "exactly one winner"
 * onto contributions within 1% of each other asserts a hierarchy that does not exist,
 * and exact ties would yield ZERO top rows while two strong drivers are plainly present.
 * The band was right; only the WORD was wrong — hence `dominant` → `primary` (CH3/A2).
 *
 * TODO: revisit by 2026-08-21 — these two ratios were chosen in
 * SIGNAL-REASONING-PROJECTION-W1-V2 by judgement, not calibration. Registered in
 * `Claude files/defensive-reductions-to-revisit.md`.
 */
const PRIMARY_SHARE = 0.6;
const SUPPORTING_SHARE = 0.25;

/**
 * The ONE derivation of `direction` and `strength`. Neither may be computed anywhere
 * else — they are two projections of a single contribution, and V2 shipped them from
 * independent expressions, which is how `direction: neutral` + `strength: dominant`
 * reached a live response.
 *
 * The biconditional `direction === 'neutral' ⟺ strength === 'none'` holds by
 * CONSTRUCTION here rather than by assertion downstream: every branch that returns a
 * neutral direction returns `'none'` with it, and a non-neutral direction always has
 * `|signed| > 0`, so its share is at least `marginal`. The illegal state is
 * unrepresentable, not merely tested for.
 *
 * `maxAbs` is the largest |contribution| among DIRECTIONAL contributing rows — not
 * among all rows. That distinction is what guarantees ≥1 `primary` whenever any
 * contributing row is non-neutral: the top such row has share 1.0. It also removes a
 * real bias, because an amplifier's adjustment (25 pts) outranks every visible weight
 * term (funding ≤20, ema ≤10, oi ≤9) and was silently setting the denominator.
 */
export function classifyContribution(input: {
  signedContribution: number;
  /** Max |contribution| among directional contributing rows. */
  maxAbs: number;
  contributes: boolean;
  kind: 'directional' | 'amplifier' | null;
}): { direction: FactorDirection; strength: FactorStrength } {
  const { signedContribution: signed, maxAbs, contributes, kind } = input;

  // A field that feeds nothing has no direction to report and no share to hold.
  if (!contributes) return { direction: 'neutral', strength: 'none' };

  // An amplifier scales whatever the net already is (`rawScore > 0 ? +n : -n`). It
  // argues "more of this", never "bullish" or "bearish" — so it is permanently neutral,
  // and the biconditional therefore makes it permanently `none`. This single branch is
  // what retires the `neutral`+`dominant` row: an amplifier can no longer hold a share.
  if (kind === 'amplifier') return { direction: 'neutral', strength: 'none' };

  const direction = dirOf(signed);
  if (direction === 'neutral') return { direction, strength: 'none' };

  const abs = Math.abs(signed);
  const share = maxAbs > 0 ? abs / maxAbs : 0;
  const strength: FactorStrength =
    share >= PRIMARY_SHARE ? 'primary' : share >= SUPPORTING_SHARE ? 'supporting' : 'marginal';
  return { direction, strength };
}

export function buildFactorLedger(i: FactorLedgerInput): FactorLedger {
  const { scored: regimeScored, emaNameable } = regimeRow(i);

  const scoredRows: Scored[] = [fundingRow(i), priceChangeRow(i), regimeScored];

  // Amplifiers: build the row, then attach the adjustment magnitude as its (unsigned)
  // contribution so it ranks by what it is actually worth to the score.
  for (const build of [trendPersistenceRow, breakoutRow]) {
    const s = build(i);
    scoredRows.push({ row: s.row, signedContribution: s.row.contributes ? amplifierMagnitude(i, s.row.factor) : 0 });
  }

  for (const maybe of [oiRow(i), volumeRow(i)]) {
    if (maybe) scoredRows.push(maybe);
  }

  // The denominator is the largest |contribution| among DIRECTIONAL contributing rows.
  // Taking it over ALL rows let an amplifier (25 pts) set the scale that every visible
  // weight term (≤20) was then measured against — which is how a real driver could read
  // `marginal` while a directionless row read `dominant`.
  const maxAbs = scoredRows.reduce(
    (m, s) => (s.row.contributes && fieldKind(s.row.factor) === 'directional'
      ? Math.max(m, Math.abs(s.signedContribution))
      : m),
    0,
  );

  const rows: FactorRow[] = scoredRows
    .slice()
    .sort((a, b) => Math.abs(b.signedContribution) - Math.abs(a.signedContribution))
    .map((s, idx) => {
      // ONE call site. `direction` and `strength` arrive together, from one input.
      const { direction, strength } = classifyContribution({
        signedContribution: s.signedContribution,
        maxAbs,
        contributes: s.row.contributes,
        kind: fieldKind(s.row.factor),
      });
      return { ...s.row, direction, strength, rank: idx + 1 };
    });

  // netDirection is READ from the one rawScore the verdict used — never re-summed.
  const netDirection: LedgerNet = dirOf(i.outcome.rawScore);

  const counterweight =
    netDirection === 'neutral'
      ? null
      : rows.find((r) => r.contributes && r.direction !== 'neutral' && r.direction !== netDirection) ?? null;

  // ── CH4 — the withheld accounting, with BOTH variances removed ──
  //
  // `count` moved 1,1,1,2 across four live samples under a label that reads as a fixed
  // cardinality, for TWO independent reasons, and fixing only one would have reproduced
  // the bug behind a more confident name:
  //   1. the SET was not fixed — the EMA term was folded in whenever regime could not
  //      name it, so it was 2 or 3;
  //   2. the COUNT filtered to non-zero contributions — a filtered count is a different
  //      statistic from a cardinality.
  //
  // Now: the count is the MODEL's withheld set, constant by construction (it is derived
  // from `WEIGHT_TERM_FIELD`, the same object CH2's arithmetic reads). `net` is summed
  // over that same constant set, so the denominator is stable and the value is externally
  // verifiable. The EMA case is a different fact and gets its own field rather than being
  // hidden inside a number.
  const withheldSigned: Record<string, number> = {
    rsi: i.scores.rsiScore * i.weights.rsi,
    volume: i.scores.volumeScore * i.weights.volume,
  };
  const withheldNet = Object.values(withheldSigned).reduce((a, v) => a + v, 0);

  // Evaluability, term by term. `rsiVal === null` and `avgCandleVol === 0` are the two
  // states `computeIndicatorScores` collapses to a 0 score — the same collapse that made
  // `funding_state` report NORMAL over an unmeasurable z-score.
  const unevaluatedTerms: string[] = [];
  if (i.scores.rsiVal === null) unevaluatedTerms.push('rsi');
  if (i.scores.avgCandleVol === 0) unevaluatedTerms.push('volume');

  // A weight term that IS nameable in principle but could not be named this response.
  // Naming "ema" here discloses nothing new — the live prose already says "on the
  // moving-average cross", so the term is public today.
  const unnameableThisResponse: string[] = emaNameable ? [] : ['ema'];

  return {
    rows,
    netDirection,
    counterweight,
    strippedRemainder: {
      // Retained one deprecation cycle so no consumer loses a key in this wave. It now
      // equals `withheld_term_count` rather than the filtered statistic it used to be.
      count: WITHHELD_WEIGHT_TERMS.length,
      withheldTermCount: WITHHELD_WEIGHT_TERMS.length,
      unnameableThisResponse,
      unevaluatedTerms,
      net: withheldNet > 0 ? 'bullish' : withheldNet < 0 ? 'bearish' : 'flat',
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// R3 — `reasoning` as a projection of the ledger above
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Hard ceiling on the whole string. Set by the CONSUMER, not by taste: the Telegram
 * bot renders `reasoning[:280]` (`algovault-bot` `alert_engine.py`), so anything longer
 * reaches a real user cut mid-word. The previous 5-slot template ran ~700 chars against
 * a shipped `<=500` assertion that had never been exercised by a consumer that truncates.
 */
export const REASONING_MAX_CHARS = 280;

/** Exactly three: driver, context-or-counterweight, flip. */
export const REASONING_SENTENCE_COUNT = 3;

// ── R4: the payload-pinned decimal allow-list ──

/**
 * Every way a payload number is allowed to appear in prose. Small and CLOSED on
 * purpose — it is the whole security property. A prose decimal is legitimate only if
 * some emitted value, run through one of these, reproduces it byte-for-byte.
 */
const DECIMAL_PROJECTIONS: ReadonlyArray<(v: number) => string> = [
  (v) => String(v),
  (v) => v.toFixed(1),
  (v) => v.toFixed(2),
  (v) => v.toFixed(4),
  (v) => (v * 100).toFixed(1),
  (v) => (v * 100).toFixed(2),
  (v) => (v * 100).toFixed(4),
];

/** Every numeric leaf of an emitted response, at any depth. */
export function collectPayloadNumbers(value: unknown, out: number[] = []): number[] {
  if (typeof value === 'number' && Number.isFinite(value)) out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectPayloadNumbers(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectPayloadNumbers(v, out);
  return out;
}

/**
 * The decimals in `prose` that NO emitted number can account for. Empty ⇒ every number
 * the reader sees is checkable against the same response.
 *
 * This REPLACES the old blanket `/\d+\.\d+/` ban on the emitted string, and it is a
 * strictly stronger gate rather than a relaxation: the blanket ban permitted any
 * integer (a fabricated "62% conviction cap" sailed straight through it) and forbade
 * numbers that were already public two fields away. This forbids any number, decimal
 * or otherwise, that the payload cannot produce.
 *
 * Integers are checked too, against the payload OR an explicitly-passed set of code
 * constants — R3.3's rule that a number may be stated only when it is read from one.
 * "14 days" qualifies because the caller passes `FUNDING_Z_WINDOW_DAYS`, the same
 * constant the z-score's own query uses; a hand-typed 14 would not.
 */
export function unbackedProseNumbers(
  prose: string,
  payloadNumbers: readonly number[],
  allowedConstants: readonly number[] = [],
): string[] {
  const tokens = prose.match(/-?\d+(?:\.\d+)?/g) ?? [];
  const backed = new Set<string>();
  const add = (s: string) => {
    backed.add(s);
    backed.add(s.replace(/^-/, ''));
  };
  for (const v of payloadNumbers) for (const project of DECIMAL_PROJECTIONS) add(project(v));
  for (const v of allowedConstants) add(String(v));
  return tokens.filter((t) => !backed.has(t) && !backed.has(t.replace(/^[+-]/, '')));
}

/** Sentence subject per public factor name. */
const SUBJECT: Record<string, string> = {
  funding_state: 'Funding at',
  price_change_24h: 'Price is',
  regime: 'Regime is',
  trend_persistence: 'Trend persistence',
  breakout_pending: 'Volatility',
  oi_change_pct: 'Open interest is',
  volume_24h: '24h volume is',
};

/**
 * Rows whose `value` is a bucket enum the frame already says in words. Printing it
 * gives "Volatility INACTIVE is neither expanding nor compressed". The enum stays on
 * the wire (it is the `factors[]` vocabulary agents parse); only the prose drops it.
 */
const VALUE_IS_REDUNDANT_IN_PROSE = new Set(['trend_persistence', 'breakout_pending']);

/**
 * `${subject} ${value} ${frame}`, plus an arrow ONLY when the row actually moved the
 * verdict.
 *
 * The arrow suppression on `contributes:false` is the single most load-bearing line in
 * this renderer. An arrow is a causal claim, and open interest carries a real sign while
 * entering no score — printing "open interest -1.2% → bearish" inside a reason is
 * precisely the mislabelling this wave exists to retire. Context rows may be MENTIONED;
 * they may never be pointed at.
 */
function clauseFor(row: FactorRow): string {
  const value = VALUE_IS_REDUNDANT_IN_PROSE.has(row.factor) ? '' : ` ${row.value}`;
  const head = `${SUBJECT[row.factor] ?? row.factor}${value} ${row.humanFrame}`.replace(/\s+/g, ' ').trim();
  return row.direction === 'neutral' || !row.contributes ? head : `${head} → ${row.direction}`;
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * What would change the call. Deliberately NOT the driver by default: the most
 * informative answer is usually the largest term currently sitting DORMANT at zero
 * contribution — for a HOLD whose funding is exactly neutral, "funding moves off
 * neutral" is the real answer and "the trend strengthens" is not.
 *
 * Never states a numeric threshold (R3.3): the buy/sell cut is a tunable env-gated
 * constant, and a number quoted here would be both a leak and a staleness risk.
 */
function flipSentence(ledger: FactorLedger, call: string, driver: FactorRow | null): string {
  const rows = ledger.rows;

  // A pending breakout is the one genuinely unresolved thing on the board; when the
  // call is HOLD it dominates any "if X strengthens" phrasing.
  // CH2 consequence: `contributes` is now STRUCTURAL, so it is true for this row on every
  // response and can no longer stand in for "is a breakout pending right now". That
  // question is about the VALUE. Reading the flag here made the flip sentence say
  // "if the breakout resolves" on assets with no compression at all.
  const squeeze = rows.find((r) => r.factor === 'breakout_pending' && r.value === 'IMMINENT');
  if (call === 'HOLD' && squeeze) return 'Becomes actionable if the breakout resolves';

  const dormant = rows.find((r) => r.contributes && r.direction === 'neutral' && r.strength === 'none' && r.factor === 'funding_state');
  // Same CH2 consequence: the last-resort pivot must be a row that can actually MOVE, so
  // it takes a directional contributor rather than the first structurally-contributing
  // row — which, post-CH2, would happily be an amplifier with nothing to say.
  const pivot = dormant ?? driver ?? rows.find((r) => r.contributes && fieldKind(r.factor) === 'directional') ?? null;
  if (!pivot) return 'Becomes actionable once any factor scores';

  const change =
    pivot.factor === 'funding_state'
      // With no distribution there is no "normal" to return to, so the honest flip
      // condition is that the history itself accumulates (D9).
      ? pivot.humanFrame.includes(FUNDING_HISTORY_TOO_SHORT) ? 'enough funding history accumulates to score'
        : pivot.direction === 'neutral' ? 'funding moves off neutral' : 'funding normalises'
      : pivot.factor === 'price_change_24h' ? 'the 24h price move reverses'
        : pivot.factor === 'regime' ? 'the trend structure turns'
          : pivot.factor === 'trend_persistence' ? 'persistence fades'
            : pivot.factor === 'breakout_pending' ? 'the breakout resolves'
              : `${pivot.factor} turns`;

  if (call === 'BUY' || call === 'SELL') return `Flips to HOLD if ${change}`;
  return `Turns directional if ${change}`;
}

/**
 * Project the ledger to the public `reasoning` string.
 *
 * Pure and total. The invariants the gate pins — only `contributes:true` rows may be
 * named as drivers, every named direction matches the ledger's, exactly three
 * sentences, `<=280` chars — are properties of THIS function, so a future edit that
 * breaks one turns a test red rather than shipping a contradiction.
 */
export function renderVerdictReasoning(
  ledger: FactorLedger,
  call: string,
  _confidencePct?: number,
  opts: { marketClosed?: boolean } = {},
): string {
  const { rows, netDirection, counterweight } = ledger;

  // The driver is what produced the CALL, so it must be a contributing row that AGREES
  // with the net. There is deliberately no fallback to "top directional row": that
  // fallback existed in the first draft and produced `Against: price is sharply down …`
  // duplicating sentence 1 verbatim, because the only directional row on the board was
  // the one OPPOSING the net. A row cannot be both the reason and the objection.
  const agreeing = rows.filter((r) => r.contributes && r.direction === netDirection && r.direction !== 'neutral');
  const driver = agreeing[0] ?? null;

  // ── 1. Driver ──
  const unmeasuredFunding = rows.find((r) => r.humanFrame.includes(FUNDING_HISTORY_TOO_SHORT));
  const anyDirectional = rows.some((r) => r.contributes && r.direction !== 'neutral');
  const { count: strippedCount, net: strippedNet } = ledger.strippedRemainder;
  let s1: string;
  if (driver) {
    s1 = clauseFor(driver);
  } else if (unmeasuredFunding) {
    // R5.8 — "no factor cleared its threshold" asserts factors were MEASURED and came
    // back flat. Over an unmeasured row that is the same false-measurement claim in
    // different words, so insufficient history gets its own sentence.
    s1 = clauseFor(unmeasuredFunding);
  } else if (netDirection === 'neutral' && anyDirectional) {
    s1 = 'Bullish and bearish factors cancel out, so no call';
  } else if (strippedCount > 0 && strippedNet !== 'flat') {
    // D7 — no publishable row agrees with the net, so the call rests on the moat-1
    // stripped terms. Naming the COUNT and the net sign is the honest disclosure;
    // silently attributing the call to a visible row would be a fabricated reason.
    s1 = `${strippedCount} internal factors not shown here net ${strippedNet}, and they carry this read`;
  } else {
    s1 = 'No factor cleared its threshold, so no call';
  }

  // ── 2. Counterweight, else the strongest context that is not the driver ──
  const others = rows.filter((r) => r !== driver && r !== counterweight);
  let s2: string;
  if (opts.marketClosed) {
    // A TradFi perp whose cash market is shut is priced off a CAPPED synthetic index,
    // so the directional read is provisional. This used to ride as a 4th appended
    // sentence, which both broke the sentence count and pushed the string past the
    // consumer's 280-char cut — meaning the one caveat that matters got truncated
    // first. It takes slot 2 instead: it IS the most important context in that state.
    s2 = 'Underlying market closed, so candles are capped synthetic pricing and this read is provisional';
  } else if (counterweight) {
    s2 = `Against: ${lowerFirst(clauseFor(counterweight))}`;
  } else {
    // A DORMANT contributor — one that feeds the score but scored nothing this call —
    // is the most informative context there is, because "the big term isn't firing" is
    // usually the whole reason a call is a HOLD. It outranks regime/volatility colour.
    // DORMANT means "feeds the score but scored nothing this call" — informative because
    // it explains a HOLD. An AMPLIFIER is not dormant, it is directionless: CH3 gives it
    // `strength: 'none'` permanently, so without the `kind` filter every amplifier matches
    // here and hijacks the slot from the term that is genuinely sitting at zero.
    const dormant = others.find((r) => r.contributes && r.strength === 'none' && fieldKind(r.factor) === 'directional');
    // Preference order, not ledger rank: regime and volatility describe the SETUP, while
    // open interest is the most asset-discriminating figure available — it is what told
    // SOL and DOGE apart on the day they emitted byte-identical prose. OI is included
    // precisely BECAUSE it does not contribute: `clauseFor` will mention it without an
    // arrow, which is the difference between reporting a fact and claiming a reason.
    const CONTEXT_PREFERENCE = ['regime', 'oi_change_pct', 'breakout_pending'];
    const ctx = dormant
      ? [dormant]
      : CONTEXT_PREFERENCE.map((f) => others.find((r) => r.factor === f)).filter((r): r is FactorRow => !!r).slice(0, 2);
    s2 = ctx.length === 0
      ? `Nothing else scored, so the read rests on ${driver ? driver.factor.replace(/_/g, ' ') : 'no measured factor'}`
      : ctx.length === 1
        ? clauseFor(ctx[0])
        : `${clauseFor(ctx[0])} and ${lowerFirst(clauseFor(ctx[1]))}`;
  }

  // ── 3. Flip ──
  const s3 = flipSentence(ledger, call, driver);

  // Fit to the consumer's ceiling by DEGRADING slot 2, never by dropping a slot: the
  // driver and the flip are the two the reader cannot do without, and a 2-sentence
  // variant would make the sentence count a function of string length.
  const join = (a: string, b: string, c: string) => [a, b, c].map((s) => s.replace(/\.*$/, '')).join('. ') + '.';
  let out = join(s1, s2, s3);
  if (out.length > REASONING_MAX_CHARS && !counterweight && !opts.marketClosed) {
    const ctx = others.filter((r) => r.factor === 'regime' || r.factor === 'breakout_pending' || r.factor === 'oi_change_pct');
    if (ctx.length) out = join(s1, clauseFor(ctx[0]), s3);
  }
  if (out.length > REASONING_MAX_CHARS && !opts.marketClosed) {
    const short = counterweight
      ? `Against: ${counterweight.factor.replace(/_/g, ' ')} reads ${counterweight.direction}`
      : 'Nothing else cleared its threshold';
    out = join(s1, short, s3);
  }
  return out;
}


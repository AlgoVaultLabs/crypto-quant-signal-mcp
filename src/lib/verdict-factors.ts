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
 * A public indicator is NOT the same thing as a scored input. Measured:
 *
 *   weight term   →  public face                     contributes
 *   rsi    .30    →  none (stripped by moat-1)       true  (folded into strippedRemainder)
 *   funding .25   →  indicators.funding_rate         true
 *   volume .20    →  none (volume_24h is a DIFFERENT quantity — 24h notional,
 *                    not the candle-volume ratio the score reads)
 *                                                    true  (folded into strippedRemainder)
 *   oi     .15    →  24h PRICE change, not OI        true
 *   ema    .10    →  regime, when their signs agree  true
 *
 *   public indicator          feeds a weight term?
 *   oi_change_pct             NO  — computeOiDelta output; enters no score
 *   volume_24h                NO  — display only
 *   funding_24h_avg           NO  — a literal alias of funding_rate
 *   underlying_session        NO  — drives only the closed-market caveat
 *   trend_persistence         via the Hurst ADJUSTMENT, not a weight term
 *   breakout_pending          via the squeeze ADJUSTMENT, not a weight term
 *
 * So `contributes:false` rows (open interest, 24h volume) are CONTEXT and may never
 * produce a driver sentence. That single flag is what makes the old "OI +2.4% →
 * bullish" claim unrepresentable rather than merely discouraged.
 *
 * ── Amplifiers have no direction of their own ────────────────────────────────
 * The Hurst and squeeze gates do `rawScore > 0 ? +x : -x` — they scale whatever the
 * net already is. They argue "more of this", never "bullish" or "bearish". They
 * therefore carry `direction:'neutral'` permanently, which by construction bars them
 * from being a driver (drivers need a direction) and from being a counterweight
 * (a neutral direction opposes nothing). Encoding that in data rather than in the
 * renderer is what keeps a future edit from re-inventing a signed Hurst.
 */

// ── Public value types (declared inline — see the purity note above) ──

export type FactorDirection = 'bullish' | 'bearish' | 'neutral';
export type FactorStrength = 'dominant' | 'supporting' | 'marginal' | 'none';
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

/** The moat-1-stripped contributors, accounted for as a count and a net sign (D7). */
export interface StrippedRemainder {
  count: number;
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
  row: Omit<FactorRow, 'rank' | 'strength'>;
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
        direction: dirOf(base),
        value,
        contributes: true,
        humanFrame: `means ${side}, but ${i.coin} funding ${FUNDING_HISTORY_TOO_SHORT}`,
      },
      signedContribution: base,
    };
  }

  if (state === 'FIXED_PREIPO') {
    return {
      row: {
        factor: 'funding_state',
        direction: 'neutral',
        value,
        contributes: false,
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
  const zLean = unusual ? (rate < 0 ? 1 : -1) * Math.min(Math.abs(z), 3) : 0;
  return {
    row: {
      factor: 'funding_state',
      direction: dirOf(base !== 0 ? base : zLean),
      value,
      contributes: true,
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
      direction: dirOf(s),
      value,
      contributes: true,
      humanFrame: s === 0 ? `over ${w}, with no momentum either way` : `over ${w}, the momentum term behind the call`,
    },
    signedContribution: s * i.weights.oi,
  };
}

/**
 * Regime is the public face of the 10% EMA term — but only when they agree.
 *
 * Measured (CH1.4): `TRENDING_UP` requires `emaCross === 'BULLISH'` and
 * `TRENDING_DOWN` requires `'BEARISH'`, so regime can NEVER carry the opposite sign
 * to `emaScore`. It CAN be neutral where emaScore is signed — `RANGING` also absorbs
 * a bullish cross at RSI ≥ 70, a bearish cross at RSI ≤ 30, and any null RSI. On that
 * divergence the row degrades to context and the EMA contribution moves to
 * `strippedRemainder`, so the accounting still totals (D4).
 */
function regimeRow(i: FactorLedgerInput): { scored: Scored; emaNameable: boolean } {
  const ema = i.scores.emaScore;
  const agrees =
    (i.regime === 'TRENDING_UP' && ema > 0) ||
    (i.regime === 'TRENDING_DOWN' && ema < 0) ||
    (i.regime === 'RANGING' && ema === 0);
  const label =
    i.regime === 'TRENDING_UP' ? 'trending up'
      : i.regime === 'TRENDING_DOWN' ? 'trending down'
        : i.regime === 'RANGING' ? 'ranging' : 'volatile';

  if (!agrees) {
    return {
      scored: {
        row: {
          factor: 'regime',
          direction: 'neutral',
          value: label,
          contributes: false,
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
        direction: dirOf(ema),
        value: label,
        contributes: ema !== 0,
        humanFrame: ema === 0 ? 'with no trend structure to lean on' : 'on the moving-average cross',
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
  return {
    row: { factor: 'trend_persistence', direction: 'neutral', value: v, contributes: fires, humanFrame },
    signedContribution: 0,
  };
}

/** Squeeze — an AMPLIFIER. Permanently `direction:'neutral'`. */
function breakoutRow(i: FactorLedgerInput): Scored {
  const imminent = i.indicators.breakout_pending === 'IMMINENT';
  return {
    row: {
      factor: 'breakout_pending',
      direction: 'neutral',
      value: i.indicators.breakout_pending,
      contributes: imminent && i.scores.squeezeActive,
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
  const dir: FactorDirection = pct >= 0.5 ? 'bullish' : pct <= -0.5 ? 'bearish' : 'neutral';
  const window = i.indicators.oi_change_window ?? '24h';
  return {
    row: {
      factor: 'oi_change_pct',
      direction: dir,
      value: signedPct(pct, 1),
      contributes: false,
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
      direction: 'neutral',
      value: humanizeUsd(v),
      contributes: false,
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

/**
 * `strength` is scaled to the LARGEST contribution in this call, not to an absolute
 * point scale. Two reasons, and the second is the one that matters: an absolute scale
 * would let a reader infer coefficient magnitudes across observations, whereas a
 * within-call ratio conveys only relative ordering — and it satisfies D1's requirement
 * that a 10%-weight factor at an extreme value can legitimately read `dominant`.
 */
const DOMINANT_RATIO = 0.6;
const SUPPORTING_RATIO = 0.25;

function strengthOf(abs: number, maxAbs: number): FactorStrength {
  if (abs === 0 || maxAbs === 0) return 'none';
  if (abs >= DOMINANT_RATIO * maxAbs) return 'dominant';
  if (abs >= SUPPORTING_RATIO * maxAbs) return 'supporting';
  return 'marginal';
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

  const maxAbs = scoredRows.reduce((m, s) => Math.max(m, Math.abs(s.signedContribution)), 0);

  const rows: FactorRow[] = scoredRows
    .slice()
    .sort((a, b) => Math.abs(b.signedContribution) - Math.abs(a.signedContribution))
    .map((s, idx) => ({
      ...s.row,
      rank: idx + 1,
      strength: strengthOf(Math.abs(s.signedContribution), maxAbs),
    }));

  // netDirection is READ from the one rawScore the verdict used — never re-summed.
  const netDirection: LedgerNet = dirOf(i.outcome.rawScore);

  const counterweight =
    netDirection === 'neutral'
      ? null
      : rows.find((r) => r.contributes && r.direction !== 'neutral' && r.direction !== netDirection) ?? null;

  // D7 — the moat-1-stripped contributors, as a count and a net sign. RSI and the
  // volume ratio are always stripped; the EMA term joins them only when regime could
  // not name it (see regimeRow), which is what keeps the accounting total.
  const strippedSigned: number[] = [i.scores.rsiScore * i.weights.rsi, i.scores.volumeScore * i.weights.volume];
  if (!emaNameable) strippedSigned.push(i.scores.emaScore * i.weights.ema);
  const strippedNet = strippedSigned.reduce((a, v) => a + v, 0);

  return {
    rows,
    netDirection,
    counterweight,
    strippedRemainder: {
      count: strippedSigned.filter((v) => v !== 0).length,
      net: strippedNet > 0 ? 'bullish' : strippedNet < 0 ? 'bearish' : 'flat',
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
  const squeeze = rows.find((r) => r.factor === 'breakout_pending' && r.contributes);
  if (call === 'HOLD' && squeeze) return 'Becomes actionable if the breakout resolves';

  const dormant = rows.find((r) => r.contributes && r.direction === 'neutral' && r.strength === 'none' && r.factor === 'funding_state');
  const pivot = dormant ?? driver ?? rows.find((r) => r.contributes) ?? null;
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
    const dormant = others.find((r) => r.contributes && r.strength === 'none');
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


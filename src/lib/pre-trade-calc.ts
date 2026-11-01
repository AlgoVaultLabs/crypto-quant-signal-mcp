/**
 * pre-trade-calc.ts — DECISION-CALL-V2-W1 CH1.
 *
 * The survival and break-even figures `pre_trade_check` v2 adds, per `Prompt/pre-trade-check-contract-v2.md`
 * § Calculators: where isolated liquidation sits, what the round trip costs, what direction accuracy the
 * hold needs to break even, and what the order means against the caller's equity. PURE: no I/O, no clock —
 * every input is an argument, so each golden vector is a plain call.
 *
 * WHAT IT NEVER DOES. It describes the order the caller already chose. It never proposes a size, a
 * leverage, a stop or a target, and it states no probability that the trade works: `accuracy_needed_pct`
 * and `win_rate_needed_pct` are break-even THRESHOLDS, and `random_entry_target_first_pct` is the
 * driftless benchmark the second is read against.
 *
 * VOLATILITY. A 1h regime snapshot carries `volatility_ratio` = ATR(14) / price. The expected range of a
 * normal 1h move is σ·√(8/π), so sigma_1h = ratio ÷ √(8/π). sigma_H = sigma_1h·√hold (square-root of
 * time), and the expected absolute move over the hold is E = sigma_H·√(2/π) — the mean of |N(0, sigma_H²)|.
 *
 * LIQUIDATION (isolated, leverage L, maintenance rate m at the order's notional): long d = (1/L − m)/(1 − m),
 * short d = (1/L − m)/(1 + m). The maintenance deduction is ignored, so the distance is never overstated;
 * a venue whose published formula adds its taker fee to m gets it added by the caller
 * (`liquidationMaintenanceRate`, venue-margin-tiers.ts).
 *
 * ONE ROUNDING. Every figure is rounded ONCE, here, from unrounded inputs: price-scale figures (bps, and
 * percents of price or equity) to 4 decimals, as `pre-trade-decision.ts` rounds bps; the three
 * probabilities to 2. A rule compares the rounded figure, so what is shown is what is judged.
 */
import type { PreTradeSide } from './pre-trade-costs.js';

/** E[range of a normal 1h move] / σ — turns ATR(14) / price back into a 1h sigma. */
export const ATR_RANGE_PER_SIGMA = Math.sqrt(8 / Math.PI);
/** E|N(0, σ²)| / σ — the expected absolute move per sigma. */
export const ABS_MOVE_PER_SIGMA = Math.sqrt(2 / Math.PI);

/** Price-scale figures (bps, % of price, % of equity) and ratios: 4 decimals; `+ 0` folds −0 into 0. */
const r4 = (x: number): number => Math.round(x * 1e4) / 1e4 + 0;
/** The three probabilities: 2 decimals. */
const r2 = (x: number): number => Math.round(x * 100) / 100 + 0;

const finite = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);
const positive = (x: number | null | undefined): x is number => finite(x) && x > 0;

/** A fee schedule PERCENT as bps, to 1e-6 bp — the rounding `takerFeeBps` (venue-fees.ts) applies. */
export function feeBpsFromPct(pct: number): number {
  return Math.round(pct * 100 * 1e6) / 1e6;
}

/** sigma_1h (a fraction of price) from ATR(14) / price; null for anything not a positive finite ratio. */
export function sigma1hFromVolatilityRatio(volatilityRatio: number | null | undefined): number | null {
  return positive(volatilityRatio) ? volatilityRatio / ATR_RANGE_PER_SIGMA : null;
}

/**
 * The round trip in bps: the entry fee (taker, or maker for a limit entry) + the taker exit fee + the quoted
 * top-of-book spread where the venue quotes one (else + 0). Null without both fees.
 */
export function roundTripBps(args: { entryFeeBps: number | null; exitFeeBps: number | null; spreadBps: number | null }): number | null {
  const { entryFeeBps, exitFeeBps, spreadBps } = args;
  if (!finite(entryFeeBps) || !finite(exitFeeBps)) return null;
  return r4(entryFeeBps + exitFeeBps + (finite(spreadBps) ? spreadBps : 0));
}

/** Isolated liquidation distance as a FRACTION of entry; negative when 1/L is already below m. */
export function liquidationDistance(side: PreTradeSide, leverage: number, maintenanceRate: number): number {
  const margin = 1 / leverage - maintenanceRate;
  return side === 'long' ? margin / (1 - maintenanceRate) : margin / (1 + maintenanceRate);
}

export interface PreTradeCalcInput {
  side: PreTradeSide;
  sizeUsd: number;
  holdHours: number;
  /** sigma_1h as a fraction of price (unrounded), or null when no fresh 1h snapshot was read. */
  sigma1h: number | null;
  /** The venue's round trip in bps, or null without a fee row. */
  roundTripBps: number | null;
  leverage: number | null;
  /** m: the tier maintenance rate, with any taker fee the venue's formula adds; null without a tier rate. */
  maintenanceRate: number | null;
  stopPct: number | null;
  targetPct: number | null;
  equityUsd: number | null;
}

/** The contract's `calc` block. Every figure is null when an input it needs is absent — never a guessed 0. */
export interface PreTradeCalc {
  sigma_1h_pct: number | null;
  sigma_hold_pct: number | null;
  expected_move_pct: number | null;
  round_trip_bps: number | null;
  accuracy_needed_pct: number | null;
  win_rate_needed_pct: number | null;
  random_entry_target_first_pct: number | null;
  liq_distance_pct: number | null;
  liq_distance_sigma: number | null;
  liq_before_stop: boolean | null;
  loss_at_stop_pct_equity: number | null;
  one_sigma_day_pct_equity: number | null;
}

/** Every figure of one venue, computed from unrounded inputs and rounded once. */
export function computePreTradeCalc(i: PreTradeCalcInput): PreTradeCalc {
  const sigma1h = positive(i.sigma1h) ? i.sigma1h : null;
  const sigmaH = sigma1h === null ? null : sigma1h * Math.sqrt(i.holdHours);
  const move = sigmaH === null ? null : sigmaH * ABS_MOVE_PER_SIGMA;
  const rt = finite(i.roundTripBps) ? i.roundTripBps : null;
  const stop = positive(i.stopPct) ? i.stopPct : null;
  const target = positive(i.targetPct) ? i.targetPct : null;
  const equity = positive(i.equityUsd) ? i.equityUsd : null;

  // Accuracy needed: a call right with probability p over moves of size E nets (2p − 1)E − round trip, so
  // p = 50% + round trip / 2E. Uncapped — at or above 100 the expected move cannot cover the round trip.
  const accuracy = move !== null && move > 0 && rt !== null ? r2(50 + (100 * (rt / 1e4)) / (2 * move)) : null;

  // With a stop s and a target t: k = t / s, c = round trip / s; break-even p = (1 + c)/(k + 1); a driftless
  // random entry reaches the target first with probability 1/(k + 1).
  const k = stop !== null && target !== null ? target / stop : null;
  const winRate = k !== null && rt !== null ? r2((100 * (1 + rt / 100 / (stop as number))) / (k + 1)) : null;
  const randomFirst = k !== null ? r2(100 / (k + 1)) : null;

  const liq = positive(i.leverage) && finite(i.maintenanceRate) ? liquidationDistance(i.side, i.leverage, i.maintenanceRate) : null;
  const liqPct = liq === null ? null : r4(liq * 100);

  return {
    sigma_1h_pct: sigma1h === null ? null : r4(sigma1h * 100),
    sigma_hold_pct: sigmaH === null ? null : r4(sigmaH * 100),
    expected_move_pct: move === null ? null : r4(move * 100),
    round_trip_bps: rt,
    accuracy_needed_pct: accuracy,
    win_rate_needed_pct: winRate,
    random_entry_target_first_pct: randomFirst,
    liq_distance_pct: liqPct,
    liq_distance_sigma: liq !== null && sigmaH !== null ? r4(liq / sigmaH) : null,
    // Judged on the SHOWN distance: liquidation at or inside the stop distance comes first.
    liq_before_stop: liqPct !== null && stop !== null ? liqPct <= stop : null,
    loss_at_stop_pct_equity: equity !== null && stop !== null && rt !== null ? r4((100 * i.sizeUsd * (stop / 100 + rt / 1e4)) / equity) : null,
    one_sigma_day_pct_equity: equity !== null && sigma1h !== null ? r4((100 * i.sizeUsd * sigma1h * Math.sqrt(24)) / equity) : null,
  };
}

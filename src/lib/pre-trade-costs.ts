/**
 * pre-trade-costs.ts — DECISION-CALL-V1-W2 R2.
 *
 * The cost arithmetic behind `pre_trade_check`, one venue at a time. PURE: no I/O, no clock — the
 * instant is always an argument, so every boundary is testable with plain numbers.
 *
 * SIGN CONVENTION. A funding figure is POSITIVE when the caller's side PAYS it and negative when the
 * side receives it. A positive rate means longs pay shorts, so the side multiplier is +1 for a long
 * and −1 for a short; every function below takes the side and returns the side's own view.
 *
 * FUNDING WINDOW. A hold entered at `now` for `holdHours` pays every funding event in the half-open
 * window (now, now + hold]: an event AT the exit instant counts (the position is still open when the
 * venue snapshots it — the conservative reading), an event at the entry instant does not (it has
 * already settled). The current rate is assumed to hold for the whole window; the response states
 * that assumption, it is not hidden here.
 */
/** The direction of the order the caller intends to place. */
export type PreTradeSide = 'long' | 'short';

const HOUR_MS = 3_600_000;

/** +1 when the side pays a positive rate (long), −1 when it receives it (short). */
export function sideSign(side: PreTradeSide): 1 | -1 {
  return side === 'long' ? 1 : -1;
}

export interface FundingEventsInHold {
  /** Funding events the hold pays. An integer when `exact`; `hold / interval` (fractional) when not. */
  events: number;
  /** True when counted from a known next funding time; false when estimated from the interval alone. */
  exact: boolean;
  /** The next funding instant (epoch ms) after `nowMs`, rolled forward when stale; null when unknown. */
  nextFundingAt: number | null;
}

/** A next-funding time is usable only when it is a positive finite epoch. */
function knownTime(t: number | null | undefined): t is number {
  return typeof t === 'number' && Number.isFinite(t) && t > 0;
}

/**
 * The funding events in (now, now + hold].
 *
 * Exact from the next funding time. A STALE one (≤ now — HL's `predictedFundings` has been measured
 * serving the previous hour's) is rolled forward by whole intervals to the first instant after now,
 * never discarded. With no next time at all the count is `hold / interval` and `exact: false`.
 */
export function fundingEventsInHold(args: {
  nextFundingTime: number | null | undefined;
  intervalHours: number;
  holdHours: number;
  nowMs: number;
}): FundingEventsInHold {
  const { nextFundingTime, intervalHours, holdHours, nowMs } = args;
  if (!knownTime(nextFundingTime)) {
    return { events: holdHours / intervalHours, exact: false, nextFundingAt: null };
  }
  const intervalMs = intervalHours * HOUR_MS;
  let next = nextFundingTime;
  if (next <= nowMs) next += (Math.floor((nowMs - next) / intervalMs) + 1) * intervalMs;
  const endMs = nowMs + holdHours * HOUR_MS;
  const events = next > endMs ? 0 : Math.floor((endMs - next) / intervalMs) + 1;
  return { events, exact: true, nextFundingAt: next };
}

/** Funding over the hold in bps of notional, from the side's view (+ = the side pays). */
export function fundingCostBps(args: { rate: number; side: PreTradeSide; events: number }): number {
  return sideSign(args.side) * args.rate * args.events * 10_000;
}

/**
 * What entering just AFTER the next funding saves, in bps (+ = cheaper to wait), holding for the same
 * `holdHours`: the funding of a hold entered now minus that of a hold entered at the next funding
 * instant. It is not simply "one payment": a hold of a whole number of intervals pays the same count
 * either way (the shifted window picks up the following event), so the saving is 0 there. Null when
 * the next funding time is unknown — a saving cannot be timed without it.
 */
export function entryAfterNextFundingSavingBps(args: {
  rate: number;
  side: PreTradeSide;
  nextFundingTime: number | null | undefined;
  intervalHours: number;
  holdHours: number;
  nowMs: number;
}): number | null {
  const { rate, side, intervalHours, holdHours, nowMs } = args;
  const nowWindow = fundingEventsInHold({ nextFundingTime: args.nextFundingTime, intervalHours, holdHours, nowMs });
  if (!nowWindow.exact || nowWindow.nextFundingAt === null) return null;
  const entryAt = nowWindow.nextFundingAt;
  const afterWindow = fundingEventsInHold({ nextFundingTime: entryAt, intervalHours, holdHours, nowMs: entryAt });
  return fundingCostBps({ rate, side, events: nowWindow.events }) - fundingCostBps({ rate, side, events: afterWindow.events });
}

export interface TopOfBookSpread {
  /** (ask − bid) / mid in bps; null when the book is not readable. */
  spreadBps: number | null;
  /** `top_of_book` when the venue's bulk feed carries a best bid AND ask; `unavailable` otherwise. */
  basis: 'top_of_book' | 'unavailable';
}

/** The quoted top-of-book spread. A missing, non-positive or crossed side is `unavailable`, never 0. */
export function topOfBookSpread(book: { bidPx?: number | null; askPx?: number | null }): TopOfBookSpread {
  const { bidPx, askPx } = book;
  if (typeof bidPx !== 'number' || typeof askPx !== 'number') return { spreadBps: null, basis: 'unavailable' };
  if (!(Number.isFinite(bidPx) && Number.isFinite(askPx) && bidPx > 0 && askPx >= bidPx)) {
    return { spreadBps: null, basis: 'unavailable' };
  }
  const mid = (bidPx + askPx) / 2;
  return { spreadBps: ((askPx - bidPx) / mid) * 10_000, basis: 'top_of_book' };
}

/**
 * The size a venue can take for this coin: `maxPctOfVolume` (a fraction) of its 24h USD volume.
 * Null when the volume is absent or not a positive finite number — a capacity is never guessed.
 */
export function venueCapacityUsd(volume24hUsd: number | null | undefined, maxPctOfVolume: number): number | null {
  if (typeof volume24hUsd !== 'number' || !Number.isFinite(volume24hUsd) || volume24hUsd <= 0) return null;
  return volume24hUsd * maxPctOfVolume;
}

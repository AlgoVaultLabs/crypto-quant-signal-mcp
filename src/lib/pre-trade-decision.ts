/**
 * pre-trade-decision.ts — DECISION-CALL-V1-W2 R3. The `pre_trade_check` engine.
 *
 * Two pure steps, per `Prompt/pre-trade-check-contract.md` § Engine:
 *
 *   rankVenues  every venue's costs from its market inputs, the FIRST failing exclusion, the
 *               candidates ordered by estimated cost, the best venue, the size limits and — when the
 *               order is above the best venue's limit — a split filled cheapest-first.
 *   decide      the reasons and the GO / CAUTION / WAIT that follows from them, plus the funding
 *               timing on the best venue.
 *
 * VERSIONED. `PRE_TRADE_RULE_VERSION` is served on every response; changing ANY constant below is a
 * new rule and bumps it, so two responses with the same version were judged by the same thresholds.
 *
 * PURE. No I/O, no clock, no env: the instant, the regime and the session are inputs. The handler
 * (`src/tools/pre-trade-check.ts`) gathers them; nothing here can fetch, bill or log.
 *
 * ONE DERIVATION FOR WHAT IS SHOWN AND WHAT IS JUDGED. Every bps figure is rounded to 4 decimals and
 * every USD figure to cents ONCE, here, and the thresholds compare those same rounded values — so a
 * response can never show `10` beside a verdict that judged `9.99996`.
 *
 * NO DIRECTION. The engine never proposes a side and never reads AlgoVault's directional call; the
 * side is the caller's own intent, and every reason is about executing THAT order.
 */
import {
  fundingEventsInHold,
  fundingCostBps,
  entryAfterNextFundingSavingBps,
  topOfBookSpread,
  venueCapacityUsd,
  sideSign,
  type PreTradeSide,
} from './pre-trade-costs.js';
import { FEE_TABLE_MAX_AGE_DAYS } from './venue-fees.js';

export type { PreTradeSide };

// ── The rule (a change to any value here is a new PRE_TRADE_RULE_VERSION) ─────────────────────────

export const PRE_TRADE_RULE_VERSION = 1;
/** A venue whose liquidity (OI, or 24h volume where the venue has no bulk OI) is below this is excluded. */
export const MIN_VENUE_LIQUIDITY_USD = 1_000_000;
/** A top-of-book spread above this many bps excludes the venue (only where a book is quoted). */
export const WIDE_SPREAD_BPS = 50;
/** Best-venue funding at or above this many bps over the hold is FUNDING_COST_HIGH. */
export const HIGH_CARRY_BPS = 10;
/** A paid funding event at most this many minutes away can be worth waiting out. */
export const FUNDING_SOON_MINUTES = 30;
/** …when entering after it saves at least this many bps. */
export const MIN_TIMING_SAVING_BPS = 1;
/** A regime against the side counts from this confidence. */
export const REGIME_AGAINST_MIN_CONFIDENCE = 60;
/** VOLATILE counts from this confidence. */
export const VOLATILE_MIN_CONFIDENCE = 70;
/** A venue's size limit: this FRACTION of its 24h USD volume (0.001 = 0.1%). */
export const SIZE_MAX_PCT_OF_24H_VOLUME = 0.001;

/** Exclusions, in the order they are tested — a venue carries the FIRST that fails. */
export const VENUE_EXCLUSIONS = [
  'feed_unavailable',
  'not_listed',
  'thin_liquidity',
  'wide_book',
  'funding_unavailable',
  'fee_unknown',
  'volume_unavailable',
] as const;
export type VenueExclusion = (typeof VENUE_EXCLUSIONS)[number];

export type PreTradeDecision = 'GO' | 'CAUTION' | 'WAIT';
export type PreTradeReasonSeverity = 'block' | 'adjust' | 'info';

/** Every reason code with its severity — the emission order of `decide` follows this order. */
export const PRE_TRADE_REASONS = {
  NO_TRADABLE_VENUE: 'block',
  SIZE_ABOVE_VENUE_LIMIT: 'adjust',
  SIZE_ABOVE_TOTAL_CAPACITY: 'adjust',
  FUNDING_COST_HIGH: 'adjust',
  FUNDING_DUE_SOON: 'adjust',
  REGIME_AGAINST_SIDE: 'adjust',
  REGIME_VOLATILE: 'adjust',
  UNDERLYING_CLOSED: 'adjust',
  REGIME_UNAVAILABLE: 'info',
  VENUES_UNAVAILABLE: 'info',
  NEXT_FUNDING_UNKNOWN: 'info',
  FUNDING_INCOME: 'info',
  FEE_TABLE_STALE: 'info',
} as const satisfies Record<string, PreTradeReasonSeverity>;
export type PreTradeReasonCode = keyof typeof PRE_TRADE_REASONS;

export interface PreTradeReason {
  code: PreTradeReasonCode;
  severity: PreTradeReasonSeverity;
  /** One plain sentence with the numbers; no internal identifiers. */
  detail: string;
}

// ── Inputs ───────────────────────────────────────────────────────────────────────────────────────

/** One venue's market facts for the coin, as the handler gathered them. */
export interface VenueMarketInput {
  exchange: string;
  /** False ⇔ the venue's universe read failed or came back empty this cycle. */
  universeOk: boolean;
  /** False ⇔ the venue's funding feed failed or came back empty this cycle. */
  fundingFeedOk: boolean;
  /** The coin's universe row on the venue; null ⇔ not listed (or the universe is unreadable). */
  asset: {
    /** USD liquidity — notional OI, or 24h volume on a venue with no bulk OI (`effectiveLiquidityUsd`). */
    liquidityUsd: number;
    volume24hUsd: number | null;
    bidPx?: number | null;
    askPx?: number | null;
  } | null;
  /** The coin's usable funding row on the venue; null ⇔ none. */
  funding: {
    rate: number;
    intervalHours: number;
    intervalBasis: 'contract' | 'declared';
    nextFundingTime: number | null;
  } | null;
  /** Base-tier taker fee in bps; null ⇔ no fee row. */
  takerFeeBps: number | null;
}

export interface RankVenuesInput {
  /** In FUNDING_VENUE_META order — the input index is the last tie-break. */
  venues: readonly VenueMarketInput[];
  side: PreTradeSide;
  sizeUsd: number;
  holdHours: number;
  nowMs: number;
}

/** One venue, evaluated. Every figure null when its input is missing; never a guessed 0. */
export interface VenueEvaluation {
  exchange: string;
  /** Null when the universe could not be read (listing unknown). */
  listed: boolean | null;
  excluded: VenueExclusion | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  capacityUsd: number | null;
  /** The order as a PERCENT of the venue's 24h volume. */
  sizePctOf24hVolume: number | null;
  fundingRate: number | null;
  fundingIntervalHours: number | null;
  fundingIntervalBasis: 'contract' | 'declared' | null;
  /** The next funding instant after now (rolled forward when stale); null when unknown. */
  nextFundingAtMs: number | null;
  fundingEventsInHold: number | null;
  fundingEventsExact: boolean | null;
  fundingCostBps: number | null;
  takerFeeBps: number | null;
  roundTripFeeBps: number | null;
  estCostBps: number | null;
  estCostUsd: number | null;
  spreadBps: number | null;
  spreadBasis: 'top_of_book' | 'unavailable';
}

export interface SplitLeg {
  exchange: string;
  sizeUsd: number;
  estCostBps: number;
}

export interface VenueRanking {
  /** Every venue, in input order. */
  venues: VenueEvaluation[];
  /** The non-excluded venues: cost ascending, then liquidity descending, then input order. */
  candidates: VenueEvaluation[];
  best: VenueEvaluation | null;
  /** The best venue's capacity. */
  sizeLimitUsd: number | null;
  /** Every candidate's capacity, summed. */
  sizeLimitUsdTotal: number | null;
  /** Cheapest-first fill to each venue's capacity — only when the order is above the best venue's limit. */
  split: SplitLeg[] | null;
}

// ── Rounding: the one place a figure becomes what is shown AND judged ───────────────────────────

/** bps to 4 decimals; `+ 0` folds −0 into 0. */
const bps4 = (x: number): number => Math.round(x * 1e4) / 1e4 + 0;
/** A funding-event count to 6 decimals (a fractional estimate can be 0.03125). */
const events6 = (x: number): number => Math.round(x * 1e6) / 1e6 + 0;
/** USD to cents. */
const usd2 = (x: number): number => Math.round(x * 100) / 100 + 0;

const positiveOrNull = (x: number | null | undefined): number | null =>
  typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null;

function evaluateVenue(v: VenueMarketInput, input: RankVenuesInput): VenueEvaluation {
  const { side, sizeUsd, holdHours, nowMs } = input;
  const asset = v.universeOk ? v.asset : null;
  const listed = v.universeOk ? asset !== null : null;

  const liquidityUsd = asset ? usd2(Number.isFinite(asset.liquidityUsd) && asset.liquidityUsd > 0 ? asset.liquidityUsd : 0) : null;
  const volume24hUsd = asset ? positiveOrNull(asset.volume24hUsd) : null;
  const rawCapacity = venueCapacityUsd(volume24hUsd, SIZE_MAX_PCT_OF_24H_VOLUME);
  const capacityUsd = rawCapacity === null ? null : usd2(rawCapacity);
  const sizePctOf24hVolume = volume24hUsd === null ? null : bps4((sizeUsd / volume24hUsd) * 100);
  const book = asset ? topOfBookSpread(asset) : { spreadBps: null, basis: 'unavailable' as const };
  const spreadBps = book.spreadBps === null ? null : bps4(book.spreadBps);

  const funding = v.fundingFeedOk ? v.funding : null;
  const events = funding
    ? fundingEventsInHold({ nextFundingTime: funding.nextFundingTime, intervalHours: funding.intervalHours, holdHours, nowMs })
    : null;
  const fundingCost = funding && events ? bps4(fundingCostBps({ rate: funding.rate, side, events: events.events })) : null;
  const takerFeeBps = v.takerFeeBps;
  const roundTripFeeBps = takerFeeBps === null ? null : bps4(2 * takerFeeBps);
  const estCostBps = roundTripFeeBps !== null && fundingCost !== null ? bps4(roundTripFeeBps + fundingCost) : null;
  const estCostUsd = estCostBps === null ? null : usd2((estCostBps / 10_000) * sizeUsd);

  let excluded: VenueExclusion | null = null;
  if (!v.universeOk || !v.fundingFeedOk) excluded = 'feed_unavailable';
  else if (!asset) excluded = 'not_listed';
  else if ((liquidityUsd ?? 0) < MIN_VENUE_LIQUIDITY_USD) excluded = 'thin_liquidity';
  else if (book.basis === 'top_of_book' && spreadBps !== null && spreadBps > WIDE_SPREAD_BPS) excluded = 'wide_book';
  else if (!funding) excluded = 'funding_unavailable';
  else if (takerFeeBps === null) excluded = 'fee_unknown';
  else if (capacityUsd === null) excluded = 'volume_unavailable';

  return {
    exchange: v.exchange,
    listed,
    excluded,
    liquidityUsd,
    volume24hUsd: volume24hUsd === null ? null : usd2(volume24hUsd),
    capacityUsd,
    sizePctOf24hVolume,
    fundingRate: funding ? funding.rate : null,
    fundingIntervalHours: funding ? funding.intervalHours : null,
    fundingIntervalBasis: funding ? funding.intervalBasis : null,
    nextFundingAtMs: events ? events.nextFundingAt : null,
    fundingEventsInHold: events ? events6(events.events) : null,
    fundingEventsExact: events ? events.exact : null,
    fundingCostBps: fundingCost,
    takerFeeBps,
    roundTripFeeBps,
    estCostBps,
    estCostUsd,
    spreadBps,
    spreadBasis: book.basis,
  };
}

/**
 * Evaluate every venue and pick the best: the lowest `estCostBps` among candidates whose capacity
 * fits the order, else among all candidates. Ties: higher liquidity, then input (META) order. When
 * the order is above the best venue's capacity, `split` fills candidates cheapest-first, each to its
 * capacity, until the order is placed or every candidate is full.
 */
export function rankVenues(input: RankVenuesInput): VenueRanking {
  const evaluated = input.venues.map((v, index) => ({ e: evaluateVenue(v, input), index }));
  const candidates = evaluated
    .filter(({ e }) => e.excluded === null)
    .sort((a, b) =>
      (a.e.estCostBps as number) - (b.e.estCostBps as number)
      || (b.e.liquidityUsd as number) - (a.e.liquidityUsd as number)
      || a.index - b.index)
    .map(({ e }) => e);

  const fits = candidates.filter((c) => (c.capacityUsd as number) >= input.sizeUsd);
  const best = fits[0] ?? candidates[0] ?? null;
  const sizeLimitUsdTotal = candidates.length ? usd2(candidates.reduce((s, c) => s + (c.capacityUsd as number), 0)) : null;

  let split: SplitLeg[] | null = null;
  if (best && (best.capacityUsd as number) < input.sizeUsd) {
    split = [];
    let remaining = input.sizeUsd;
    for (const c of candidates) {
      if (remaining <= 0) break;
      const take = Math.min(c.capacityUsd as number, remaining);
      if (take <= 0) continue;
      split.push({ exchange: c.exchange, sizeUsd: usd2(take), estCostBps: c.estCostBps as number });
      remaining -= take;
    }
  }

  return {
    venues: evaluated.map(({ e }) => e),
    candidates,
    best,
    sizeLimitUsd: best ? best.capacityUsd : null,
    sizeLimitUsdTotal,
    split,
  };
}

// ── decide ───────────────────────────────────────────────────────────────────────────────────────

/** The regime the handler found for the coin (a fresh bar-close snapshot row), or null. */
export interface RegimeRead {
  label: string;
  confidence: number;
  timeframe: string;
  asOfMs: number;
  sourceExchange: string;
}

export interface DecideInput {
  coin: string;
  side: PreTradeSide;
  sizeUsd: number;
  holdHours: number;
  timeframe: string;
  nowMs: number;
  ranking: VenueRanking;
  regime: RegimeRead | null;
  /** True when the underlying market is in a closed session state. */
  underlyingClosed: boolean;
  /** Fee rows (of the priced venues) older than the fee-table bound. */
  staleFees: readonly { exchange: string; verifiedAt: string }[];
}

export interface PreTradeTiming {
  exchange: string;
  nextFundingAtMs: number | null;
  minutesToNextFunding: number | null;
  sidePaysNextFunding: boolean;
  savingBpsIfEnteredAfterNextFunding: number | null;
}

export interface DecideResult {
  decision: PreTradeDecision;
  reasons: PreTradeReason[];
  timing: PreTradeTiming | null;
}

const EXCLUSION_TEXT: Readonly<Record<VenueExclusion, string>> = {
  feed_unavailable: 'market data unavailable',
  not_listed: 'not listed',
  thin_liquidity: `liquidity below $${MIN_VENUE_LIQUIDITY_USD.toLocaleString('en-US')}`,
  wide_book: `book spread above ${WIDE_SPREAD_BPS} bps`,
  funding_unavailable: 'no funding rate',
  fee_unknown: 'no fee schedule',
  volume_unavailable: 'no 24h volume',
};

const fmtUsd = (x: number): string => `$${Math.round(x).toLocaleString('en-US')}`;
const fmtBps = (x: number): string => `${Number(Math.abs(x).toFixed(2))} bps`;
const fmtHold = (h: number): string => `${Number(h.toFixed(2))}-hour hold`;
const fmtVolumePct = `${SIZE_MAX_PCT_OF_24H_VOLUME * 100}%`;

function reason(code: PreTradeReasonCode, detail: string): PreTradeReason {
  return { code, severity: PRE_TRADE_REASONS[code], detail };
}

/** The funding timing on the best venue. */
function timingFor(best: VenueEvaluation, input: DecideInput): PreTradeTiming {
  const rate = best.fundingRate as number;
  const next = best.nextFundingAtMs;
  const minutes = next === null ? null : Math.round(((next - input.nowMs) / 60_000) * 10) / 10;
  const saving = entryAfterNextFundingSavingBps({
    rate,
    side: input.side,
    nextFundingTime: next,
    intervalHours: best.fundingIntervalHours as number,
    holdHours: input.holdHours,
    nowMs: input.nowMs,
  });
  return {
    exchange: best.exchange,
    nextFundingAtMs: next,
    minutesToNextFunding: minutes,
    sidePaysNextFunding: sideSign(input.side) * rate > 0,
    savingBpsIfEnteredAfterNextFunding: saving === null ? null : bps4(saving),
  };
}

/**
 * The reasons, in contract order, and the decision: any block → WAIT; else any adjust → CAUTION;
 * else GO.
 */
export function decide(input: DecideInput): DecideResult {
  const { coin, side, sizeUsd, holdHours, timeframe, ranking, regime } = input;
  const best = ranking.best;
  const reasons: PreTradeReason[] = [];
  const timing = best ? timingFor(best, input) : null;

  // block
  if (!best) {
    const why = ranking.venues.map((v) => `${v.exchange} ${EXCLUSION_TEXT[v.excluded ?? 'feed_unavailable']}`).join('; ');
    reasons.push(reason('NO_TRADABLE_VENUE', `No venue can take this ${side} on ${coin}: ${why}.`));
  }

  // adjust
  if (best && (best.capacityUsd as number) < sizeUsd) {
    const total = ranking.sizeLimitUsdTotal as number;
    if (total < sizeUsd) {
      reasons.push(reason('SIZE_ABOVE_TOTAL_CAPACITY',
        `The order of ${fmtUsd(sizeUsd)} is above the ${fmtUsd(total)} combined size limit of the priced venues (${fmtVolumePct} of each venue's 24h volume); the split fills every venue to its limit.`));
    } else {
      reasons.push(reason('SIZE_ABOVE_VENUE_LIMIT',
        `The order of ${fmtUsd(sizeUsd)} is above the ${fmtUsd(best.capacityUsd as number)} size limit on ${best.exchange} (${fmtVolumePct} of its 24h volume); the split spreads it across ${ranking.split?.length ?? 0} venues.`));
    }
  }
  if (best && (best.fundingCostBps as number) >= HIGH_CARRY_BPS) {
    reasons.push(reason('FUNDING_COST_HIGH',
      `Funding on ${best.exchange} costs this ${side} about ${fmtBps(best.fundingCostBps as number)} over the ${fmtHold(holdHours)} at the current rate.`));
  }
  if (
    timing
    && timing.sidePaysNextFunding
    && timing.minutesToNextFunding !== null
    && timing.minutesToNextFunding <= FUNDING_SOON_MINUTES
    && timing.savingBpsIfEnteredAfterNextFunding !== null
    && timing.savingBpsIfEnteredAfterNextFunding >= MIN_TIMING_SAVING_BPS
  ) {
    reasons.push(reason('FUNDING_DUE_SOON',
      `This ${side} pays the next ${timing.exchange} funding in ${timing.minutesToNextFunding} minutes; entering after it saves about ${fmtBps(timing.savingBpsIfEnteredAfterNextFunding)}.`));
  }
  if (regime) {
    const against = (side === 'long' && regime.label === 'TRENDING_DOWN') || (side === 'short' && regime.label === 'TRENDING_UP');
    if (against && regime.confidence >= REGIME_AGAINST_MIN_CONFIDENCE) {
      reasons.push(reason('REGIME_AGAINST_SIDE',
        `The ${regime.timeframe} market regime is ${regime.label} (confidence ${regime.confidence}), against a ${side}.`));
    }
    if (regime.label === 'VOLATILE' && regime.confidence >= VOLATILE_MIN_CONFIDENCE) {
      reasons.push(reason('REGIME_VOLATILE',
        `The ${regime.timeframe} market regime is VOLATILE (confidence ${regime.confidence}); expect wide swings.`));
    }
  }
  if (input.underlyingClosed) {
    reasons.push(reason('UNDERLYING_CLOSED',
      `The underlying market for ${coin} is closed, so the perpetual trades on capped synthetic pricing until it reopens.`));
  }

  // info
  if (!regime) {
    reasons.push(reason('REGIME_UNAVAILABLE', `No fresh ${timeframe} market regime is available for ${coin}.`));
  }
  const down = ranking.venues.filter((v) => v.excluded === 'feed_unavailable').map((v) => v.exchange);
  if (down.length) {
    reasons.push(reason('VENUES_UNAVAILABLE', `Market data from ${down.join(', ')} was unavailable, so ${down.length === 1 ? 'it was' : 'they were'} not compared.`));
  }
  if (best && best.fundingEventsExact === false) {
    reasons.push(reason('NEXT_FUNDING_UNKNOWN',
      `The next funding time on ${best.exchange} is unknown; the funding cost assumes one payment every ${best.fundingIntervalHours} hours.`));
  }
  if (best && (best.fundingCostBps as number) < 0) {
    reasons.push(reason('FUNDING_INCOME',
      `At the current rate this ${side} receives funding on ${best.exchange}: about ${fmtBps(best.fundingCostBps as number)} over the ${fmtHold(holdHours)}.`));
  }
  if (input.staleFees.length) {
    const rows = input.staleFees.map((f) => `${f.exchange} (${f.verifiedAt})`).join(', ');
    reasons.push(reason('FEE_TABLE_STALE', `The base-tier fee schedule for ${rows} was last verified more than ${FEE_TABLE_MAX_AGE_DAYS} days ago.`));
  }

  const decision: PreTradeDecision = reasons.some((r) => r.severity === 'block')
    ? 'WAIT'
    : reasons.some((r) => r.severity === 'adjust') ? 'CAUTION' : 'GO';
  return { decision, reasons, timing };
}

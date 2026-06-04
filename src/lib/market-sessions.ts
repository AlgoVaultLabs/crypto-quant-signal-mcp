/**
 * Pure underlying-market session classifier (TRADFI-SIGNAL-HARDENING-W1).
 *
 * No I/O, no module state — deterministic given `{assetClass, at}`. The
 * resolver that maps a coin/venue to an `AssetClass` (with live `exchangeInfo`
 * auto-detection + 3-tier fallback) lives separately in `underlying-type.ts`;
 * this module answers only "given the class and the clock, is the underlying
 * market open?".
 *
 * SESSION-WINDOW SOURCE OF TRUTH: the Binance TradFi-perp FAQ price-index modes
 * (Standard / Fast-Decay EWMA / Slow-Decay EWMA / Fixed / Orderbook-EWMA;
 * https://www.binance.com/en/support/faq/detail/fe7dcdf24f1943d98b368f5f9f744398,
 * updated 2026-05-27). The Orderbook-EWMA (weekend) + Fixed (pre-IPO) modes are
 * exactly the "synthetic, capped" regimes a session caveat should flag.
 *
 * v1 GRANULARITY (documented simplifications):
 *  - EQUITY uses US cash-session hours via `America/New_York` (handles DST):
 *    RTH 09:30–16:00 ET, extended 04:00–20:00 ET, weekend + NYSE full-holiday
 *    closures. Weekday overnight (20:00–04:00 ET) folds into OPEN_EXTENDED.
 *    1pm early-close days are treated as open (underlying still trades).
 *  - KR_EQUITY + COMMODITY are modeled at WEEKEND-LEVEL only (Sat/Sun closed,
 *    weekday open); intraday local-exchange hours + local holidays are NOT
 *    modeled in v1. The returned `note` names this simplification.
 *  - CRYPTO → ALWAYS_OPEN; PREMARKET → PREIPO_INTERNAL (no external market).
 */
import type { AssetClass } from './market-sessions-constants.js';
import { isUsMarketHoliday } from './market-sessions-constants.js';

export type UnderlyingSessionState =
  | 'OPEN_REGULAR'
  | 'OPEN_EXTENDED'
  | 'CLOSED_WEEKEND'
  | 'CLOSED_HOLIDAY'
  | 'ALWAYS_OPEN'
  | 'PREIPO_INTERNAL'
  | 'UNKNOWN';

export interface SessionClassification {
  state: UnderlyingSessionState;
  /**
   * Human-readable context. EMPTY STRING for the "uninteresting" states
   * (ALWAYS_OPEN / OPEN_REGULAR / UNKNOWN) so callers can gate on
   * `note !== ''` to decide whether to surface a `session_note` field.
   */
  note: string;
}

/** States where the underlying cash market is fully closed (synthetic-index regime). */
export const CLOSED_STATES: ReadonlySet<UnderlyingSessionState> = new Set([
  'CLOSED_WEEKEND',
  'CLOSED_HOLIDAY',
]);

/** True for CLOSED_WEEKEND / CLOSED_HOLIDAY — the states that warrant a suggestion caveat. */
export function isClosedState(state: UnderlyingSessionState): boolean {
  return CLOSED_STATES.has(state);
}

// US RTH window in minutes-of-day (ET): 09:30 (570) inclusive → 16:00 (960) exclusive.
// Everything else on a non-holiday weekday (pre-market, after-hours, and the
// 20:00–04:00 overnight gap) folds into OPEN_EXTENDED in v1.
const RTH_OPEN_MIN = 9 * 60 + 30;   // 570
const RTH_CLOSE_MIN = 16 * 60;      // 960

interface NyParts {
  /** 0 = Sunday … 6 = Saturday (America/New_York local weekday). */
  weekday: number;
  /** YYYY-MM-DD in America/New_York local terms. */
  isoDate: string;
  /** Minutes since local midnight (0–1439). */
  minutesOfDay: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/**
 * Decompose an instant into America/New_York local weekday / date / minutes.
 * Uses `Intl` with `hourCycle: 'h23'` to avoid the midnight "24" quirk some
 * runtimes emit under `hour12:false`. No new dependency.
 */
function nyParts(at: Date): NyParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(at);
  const get = (type: string): string => parts.find(p => p.type === type)?.value ?? '';
  const weekday = WEEKDAY_INDEX[get('weekday')] ?? 0;
  const isoDate = `${get('year')}-${get('month')}-${get('day')}`;
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  return { weekday, isoDate, minutesOfDay: hour * 60 + minute };
}

function isWeekend(weekday: number): boolean {
  return weekday === 0 || weekday === 6;
}

const NOTE_US_EXTENDED =
  'US underlying in extended/off-hours — thinner liquidity; perp index may diverge from cash.';
const NOTE_US_WEEKEND =
  'US cash market closed for the weekend — equity-perp candles reflect a capped synthetic index (Orderbook-EWMA, ±3% cap), not price discovery.';
const NOTE_ASIA_WEEKEND_SIMPLIFIED =
  'Underlying closed for the weekend (v1 weekend-level approximation — intraday local-exchange hours not modeled).';
const NOTE_PREIPO =
  'Pre-IPO synthetic mark (internal trade-price, no external cash market); funding is administratively fixed.';

/**
 * Classify the current underlying-market session for an asset class.
 */
export function classifyUnderlyingSession(input: {
  assetClass: AssetClass;
  at: Date;
}): SessionClassification {
  const { assetClass, at } = input;

  if (assetClass === 'CRYPTO') {
    return { state: 'ALWAYS_OPEN', note: '' };
  }
  if (assetClass === 'PREMARKET') {
    return { state: 'PREIPO_INTERNAL', note: NOTE_PREIPO };
  }

  const { weekday, isoDate, minutesOfDay } = nyParts(at);

  // KR_EQUITY + COMMODITY: v1 weekend-level only (no intraday / holiday model).
  if (assetClass === 'KR_EQUITY' || assetClass === 'COMMODITY') {
    if (isWeekend(weekday)) {
      return { state: 'CLOSED_WEEKEND', note: NOTE_ASIA_WEEKEND_SIMPLIFIED };
    }
    return { state: 'OPEN_REGULAR', note: '' };
  }

  // EQUITY: full US session model.
  if (assetClass === 'EQUITY') {
    if (isWeekend(weekday)) {
      return { state: 'CLOSED_WEEKEND', note: NOTE_US_WEEKEND };
    }
    if (isUsMarketHoliday(isoDate)) {
      return {
        state: 'CLOSED_HOLIDAY',
        note: 'US cash market closed for a NYSE holiday — equity-perp candles reflect a capped synthetic index, not price discovery.',
      };
    }
    if (minutesOfDay >= RTH_OPEN_MIN && minutesOfDay < RTH_CLOSE_MIN) {
      return { state: 'OPEN_REGULAR', note: '' };
    }
    // Pre-market / after-hours / weekday overnight all fold into OPEN_EXTENDED in v1.
    return { state: 'OPEN_EXTENDED', note: NOTE_US_EXTENDED };
  }

  // Defensive default (e.g. a future AssetClass not yet modeled): no claim.
  return { state: 'UNKNOWN', note: '' };
}

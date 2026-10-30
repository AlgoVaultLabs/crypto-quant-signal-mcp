/**
 * venue-fees.ts — DECISION-CALL-V1-W2 R1.
 *
 * The base-tier perpetual-futures fee table `pre_trade_check` prices a round trip with. One row per
 * venue, each carrying the page it was read from and the day it was read, because a fee is a fact
 * about a venue's published schedule on a date — not a constant of nature. The rows are the
 * venue's DEFAULT (non-VIP, no token or referral discount) USDT-margined perpetual tier; per-pair
 * exceptions are not modelled, and the response says so in `assumptions.fees`.
 *
 * Sources, verified 2026-10-24 (Bitget 2026-10-27):
 *   BINANCE 0.020 / 0.050  https://www.binance.com/en/support/faq/360033544231
 *   BYBIT   0.020 / 0.055  https://www.bybit.com/en/help-center/article/Trading-Fee-Structure
 *   OKX     0.020 / 0.050  https://www.okx.com/help/advance-notice-adjustment-to-vip-tier-and-future-fees
 *   BITGET  0.020 / 0.060  https://www.bitget.com/support/articles/12560603892734
 *
 * THE DECISION SET is these rows ∩ the funding-venue SoT (`FUNDING_VENUE_META`) minus the retired
 * venues, in META order — a venue is priced only when it has a fee row AND a funding feed AND is
 * live. A row for a venue outside META is a CI failure (tests/unit/venue-fees.test.ts), never a
 * silent drop: it would be a fee nobody can pair with a funding rate.
 *
 * STALENESS. A row older than `FEE_TABLE_MAX_AGE_DAYS` still prices (a fee schedule rarely moves
 * overnight), but the response carries a FEE_TABLE_STALE note naming the venue and the date, so
 * an old figure is never served as a fresh one. Re-verify the page, then bump `verifiedAt`.
 *
 * PURE. No I/O; the retired set and the clock are inputs.
 */
import { FUNDING_VENUE_META } from './funding-venues.js';
import type { ExchangeId } from '../types.js';

export interface VenueFeeRow {
  readonly exchange: ExchangeId;
  /** Base-tier maker fee, in PERCENT of notional (0.020 = 0.02%). */
  readonly makerPct: number;
  /** Base-tier taker fee, in PERCENT of notional (0.050 = 0.05%). */
  readonly takerPct: number;
  /** What the figures are: the venue's default USDT-margined perpetual tier, no discounts. */
  readonly basis: 'base_tier_usdt_perpetual';
  readonly sourceUrl: string;
  /** UTC day (`YYYY-MM-DD`) the row was checked against `sourceUrl`. */
  readonly verifiedAt: string;
}

const FEE_ROWS: readonly VenueFeeRow[] = [
  { exchange: 'BINANCE', makerPct: 0.02, takerPct: 0.05, basis: 'base_tier_usdt_perpetual', sourceUrl: 'https://www.binance.com/en/support/faq/360033544231', verifiedAt: '2026-10-24' },
  { exchange: 'BYBIT', makerPct: 0.02, takerPct: 0.055, basis: 'base_tier_usdt_perpetual', sourceUrl: 'https://www.bybit.com/en/help-center/article/Trading-Fee-Structure', verifiedAt: '2026-10-24' },
  { exchange: 'OKX', makerPct: 0.02, takerPct: 0.05, basis: 'base_tier_usdt_perpetual', sourceUrl: 'https://www.okx.com/help/advance-notice-adjustment-to-vip-tier-and-future-fees', verifiedAt: '2026-10-24' },
  { exchange: 'BITGET', makerPct: 0.02, takerPct: 0.06, basis: 'base_tier_usdt_perpetual', sourceUrl: 'https://www.bitget.com/support/articles/12560603892734', verifiedAt: '2026-10-27' },
];

/** The table, frozen row by row so no consumer can edit a fee in place. */
export const VENUE_FEE_ROWS: readonly VenueFeeRow[] = Object.freeze(FEE_ROWS.map((r) => Object.freeze({ ...r })));

/** A row older than this many days is served with a FEE_TABLE_STALE note. Exactly 90 days is not stale. */
export const FEE_TABLE_MAX_AGE_DAYS = 90;

const DAY_MS = 86_400_000;

/** `verifiedAt` as epoch ms (UTC midnight of that day). */
export function feeRowVerifiedAtMs(row: Pick<VenueFeeRow, 'verifiedAt'>): number {
  return Date.parse(`${row.verifiedAt}T00:00:00Z`);
}

/**
 * The base-tier taker fee in basis points (0.050% → 5), or `null` for a venue with no row.
 * Rounded to 1e-6 bp so `0.055 × 100` reads 5.5, not 5.500000000000001.
 */
export function takerFeeBps(exchange: string): number | null {
  const row = VENUE_FEE_ROWS.find((r) => r.exchange === exchange);
  return row ? Math.round(row.takerPct * 100 * 1e6) / 1e6 : null;
}

/** The rows older than `FEE_TABLE_MAX_AGE_DAYS` at `nowMs`, in table order (an unparseable date is stale). */
export function staleFeeRows(nowMs: number, rows: readonly VenueFeeRow[] = VENUE_FEE_ROWS): VenueFeeRow[] {
  return rows.filter((r) => {
    const at = feeRowVerifiedAtMs(r);
    return !Number.isFinite(at) || nowMs - at > FEE_TABLE_MAX_AGE_DAYS * DAY_MS;
  });
}

/**
 * The venues `pre_trade_check` prices: fee rows ∩ `FUNDING_VENUE_META` venues − `retired`, in META
 * declaration order (the engine's last tie-break). META is iterated, so a row outside it never
 * enters the set — and the unit test turns that into a CI failure rather than a quiet omission.
 */
export function decisionVenueSet(retired: ReadonlySet<string>, rows: readonly VenueFeeRow[] = VENUE_FEE_ROWS): ExchangeId[] {
  const priced = new Set<string>(rows.map((r) => r.exchange));
  const out: ExchangeId[] = [];
  for (const m of Object.values(FUNDING_VENUE_META)) {
    if (priced.has(m.exchangeId) && !retired.has(m.exchangeId) && !out.includes(m.exchangeId)) out.push(m.exchangeId);
  }
  return out;
}

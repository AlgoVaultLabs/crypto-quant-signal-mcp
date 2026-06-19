/**
 * REFERRAL-LIGHT-W1 / C1 — Referral program terms, the SINGLE source of truth.
 *
 * Every referral surface (account portal, welcome + referred-free emails, the
 * /referral-terms page, and future TG/landing consumers) interpolates these
 * values through the pure renderers below. NO other module may hardcode the
 * program numbers (500 / 0.30 / 12 / 50) — a chapter gate greps for them so
 * terms drift is structurally impossible (numerical-citation LAW).
 *
 * Benchmarks shipped against: Token Metrics 40% / 12mo / $100-min; Bybit 20-30%.
 * AlgoVault ships 30% / 12 months / $50-min, + a 500-call referee bonus.
 */

export const REFERRAL_TERMS = {
  /** Referee bonus calls, granted on top of the monthly free allowance. */
  BONUS_CALLS: 500,
  /** Referrer commission as a fraction of referred Stripe invoice revenue. */
  COMMISSION_RATE: 0.3,
  /** Commission window length (months) from the referred customer's first invoice. */
  COMMISSION_MONTHS: 12,
  /** Minimum accrued USD before a USDC-on-Base payout is eligible (manual approve). */
  USDC_MIN_PAYOUT_USD: 50,
  /** Referral code format: 6-16 uppercase alphanumerics. */
  CODE_RE: /^[A-Z0-9]{6,16}$/,
} as const;

/** "30%" — commission rate as a display percentage. */
export function commissionPct(): string {
  return `${Math.round(REFERRAL_TERMS.COMMISSION_RATE * 100)}%`;
}

/** "12 months" — commission window phrase. */
export function commissionMonthsLabel(): string {
  return `${REFERRAL_TERMS.COMMISSION_MONTHS} months`;
}

/** "500" — referee bonus calls as a string. */
export function bonusCallsLabel(): string {
  return String(REFERRAL_TERMS.BONUS_CALLS);
}

/** "$50" — minimum USDC payout threshold as a display string. */
export function usdcMinPayoutLabel(): string {
  return `$${REFERRAL_TERMS.USDC_MIN_PAYOUT_USD}`;
}

/**
 * Structural validity of a referral code (does NOT check existence in the DB).
 * Used by the capture path (invalid → ignore, never block checkout) and by
 * partner-code minting.
 */
export function isValidCodeFormat(code: unknown): code is string {
  return typeof code === 'string' && REFERRAL_TERMS.CODE_RE.test(code);
}

/** The canonical share link for a code (interpolated everywhere, never hardcoded). */
export function shareLink(code: string, baseUrl = 'https://api.algovault.com'): string {
  return `${baseUrl}/signup?ref=${encodeURIComponent(code)}`;
}

/** Convert integer e2-cents (USD × 100) to a "$X.YY" display string. */
export function formatUsdE2(usdE2: number): string {
  const sign = usdE2 < 0 ? '-' : '';
  const abs = Math.abs(Math.round(usdE2));
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

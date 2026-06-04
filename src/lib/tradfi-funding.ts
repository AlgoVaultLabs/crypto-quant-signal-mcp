/**
 * TradFi funding interpretation (TRADIFI-SIGNAL-HARDENING-W1, R4).
 *
 * Pure mapping from an underlying AssetClass to the funding annotation our
 * tools surface. The numeric funding rate is correct already; what was missing
 * is INTERPRETATION:
 *  - PREMARKET (pre-IPO) funding is administratively FIXED (+0.005%/8h on
 *    Binance) until the IPO transition — it is NOT a market-sentiment signal,
 *    so we override `funding_state` to a dedicated FIXED_PREIPO bucket.
 *  - EQUITY / KR_EQUITY / COMMODITY perp funding has a 0% interest component
 *    (vs crypto's 0.01%/day) and is structurally near-zero; small absolute
 *    values are normal and should not be read as crowd pressure.
 *  - CRYPTO / UNKNOWN: no annotation (existing crypto thresholds untouched).
 */
import type { AssetClass } from './market-sessions-constants.js';
import { FUNDING_NOTE_PREIPO, FUNDING_NOTE_TRADFI } from './market-sessions-constants.js';
import type { FundingState } from './indicator-buckets.js';

export interface FundingAnnotation {
  /** When set, REPLACES the z-score-bucketed funding_state (PREMARKET → FIXED_PREIPO). */
  fundingStateOverride: FundingState | null;
  /** One-liner appended to `indicators.funding_note`; null = omit the field. */
  fundingNote: string | null;
}

/**
 * Resolve the funding annotation for an asset class. `'UNKNOWN'` (resolver
 * could not classify) is treated like CRYPTO: no annotation.
 */
export function tradfiFundingAnnotation(assetClass: AssetClass | 'UNKNOWN'): FundingAnnotation {
  switch (assetClass) {
    case 'PREMARKET':
      return { fundingStateOverride: 'FIXED_PREIPO', fundingNote: FUNDING_NOTE_PREIPO };
    case 'EQUITY':
    case 'KR_EQUITY':
    case 'COMMODITY':
      return { fundingStateOverride: null, fundingNote: FUNDING_NOTE_TRADFI };
    case 'CRYPTO':
    case 'UNKNOWN':
    default:
      return { fundingStateOverride: null, fundingNote: null };
  }
}

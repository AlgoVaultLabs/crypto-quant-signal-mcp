/**
 * venue-budget-registry.ts — OPS-ADAPTER-RATELIMIT-UNIFY-W1 (C2 owns this; C1 seeds it)
 *
 * Single lookup point mapping an `exchangeId` to its cross-process weight budget
 * (or null when the venue is delay-paced only). `_upstream-fetch.ts` consults it
 * before every venue fetch.
 *
 * C1 form (this commit): **re-export only** — the HL + Binance singletons stay
 * defined in `upstream-weight-budget.ts` and are imported here; `getVenueBudget`
 * adds zero new budget state, so C2's move-in (relocating the singleton
 * DEFINITIONS into this file) is provably byte-identical. Ledger paths +
 * HL 1150/450 + Binance 2000/800 are frozen throughout.
 *
 * weightFor is intentionally thin: HL/Binance compute their venue-specific weight
 * in the adapter and pass it as `req.weightHint`; this registry just reads it. C3
 * adds the request-count venues (BYBIT/OKX/BITGET) with `weightFor = () => 1`.
 */
import { hlWeightBudget, binanceWeightBudget, type WeightBudget } from './upstream-weight-budget.js';

export interface VenueBudgetEntry {
  budget: WeightBudget;
  /** Maps an upstream request to its weight. HL/Binance pass `weightHint`; request-count venues return 1. */
  weightFor: (req: { weightHint?: number }) => number;
}

export function getVenueBudget(exchangeId: string): VenueBudgetEntry | null {
  switch (exchangeId) {
    case 'HL':
      return { budget: hlWeightBudget, weightFor: (req) => req.weightHint ?? 20 };
    case 'BINANCE':
      return { budget: binanceWeightBudget, weightFor: (req) => req.weightHint ?? 5 };
    // C3 (OPS-ADAPTER-RATELIMIT-UNIFY-W1): BYBIT / OKX / BITGET request-count budgets.
    default:
      return null; // delay-paced only (the 12 shadow venues) → no cross-process budget
  }
}

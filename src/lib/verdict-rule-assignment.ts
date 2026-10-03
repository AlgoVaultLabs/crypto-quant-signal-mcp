/**
 * verdict-rule-assignment.ts — SIGNAL-VERDICT-RULE-REGISTRY-W1 CH2 R1: THE COMMITTED ASSIGNMENT.
 *
 * Pure data, zero imports. Which verdict rule each cell serves, where a cell is
 * (timeframe × confirmed-trend direction) and the direction is `classifyRegimeLabel`'s label under
 * `regime_rule_version = 3` — exactly the condition the RSI negation reads. Never keyed on the
 * emitted side: a side-keyed switch has to see its own answer first.
 *
 *   M — today's rule (the RSI ladder negated in its saturated region inside a confirmed trend).
 *   F — fade: on a trend-mode-decisive call, the opposite side at the same |raw| and confidence.
 *   H — hold: HOLD on a trend-mode-decisive call. REFUSED by the registry until a quarantined
 *       H-hold store ships (ruling Q3, 2026-10-02).
 *
 * A switch is a commit to THIS file, made by a separate switch dispatch after Mr.1 approves a gate
 * recommendation (`ops/monitoring/verdict-rule-gate.py`, CH3). The gate never writes it. Changing a
 * value here changes `rule_config_id` on every row written afterwards, which is what partitions
 * the forward record by the assignment that produced it.
 *
 * The cell list is the registration's (`audits/verdict-rule-registry-preregistration-2026-10-02.md`
 * §0); `tests/unit/verdict-rule-registry.test.ts` pins the two together. A timeframe outside it
 * (`1m` exists in `candle-guard.ts`) and every RANGING call are never cells, so they always serve M.
 */
export const REGISTRY_TIMEFRAMES = ['3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d'] as const;
export type RegistryTimeframe = (typeof REGISTRY_TIMEFRAMES)[number];

export const TREND_REGIMES = ['TRENDING_UP', 'TRENDING_DOWN'] as const;
export type TrendRegime = (typeof TREND_REGIMES)[number];

export type RuleVariant = 'M' | 'F' | 'H';

/** Exhaustive by type: a missing timeframe or direction is a compile error, not a silent default. */
export type VerdictRuleAssignment = {
  readonly [T in RegistryTimeframe]: { readonly [R in TrendRegime]: RuleVariant };
};

/** All 20 cells = M. SIGNAL-VERDICT-RULE-REGISTRY-W1 ruling Q3 = A: nothing moves until evidence does. */
export const VERDICT_RULE_ASSIGNMENT: VerdictRuleAssignment = {
  '3m': { TRENDING_UP: 'M', TRENDING_DOWN: 'M' },
  '5m': { TRENDING_UP: 'M', TRENDING_DOWN: 'M' },
  '15m': { TRENDING_UP: 'M', TRENDING_DOWN: 'M' },
  '30m': { TRENDING_UP: 'M', TRENDING_DOWN: 'M' },
  '1h': { TRENDING_UP: 'M', TRENDING_DOWN: 'M' },
  '2h': { TRENDING_UP: 'M', TRENDING_DOWN: 'M' },
  '4h': { TRENDING_UP: 'M', TRENDING_DOWN: 'M' },
  '8h': { TRENDING_UP: 'M', TRENDING_DOWN: 'M' },
  '12h': { TRENDING_UP: 'M', TRENDING_DOWN: 'M' },
  '1d': { TRENDING_UP: 'M', TRENDING_DOWN: 'M' },
};

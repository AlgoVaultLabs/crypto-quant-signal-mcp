/**
 * tool-admission-timeframes.ts — REGIME-15M-SERVE-W1 CH2. The ONE declaration of which timeframes each tool admits.
 *
 * Two readers, one source:
 *   - the pipeline (`tool-call-pipeline.ts`): each TOOLS row's `timeframes` IS its entry here, so a DEFINED
 *     `input.timeframe` outside it is refused before dispatch (Q-PIPE-2 row 12) — the admission and its refusal
 *     are unchanged, only where the set is written moved;
 *   - GET /capabilities (`projectCapabilities`, feature-registry.ts): each tool with an entry publishes it as
 *     `timeframes`, ordered by bar duration, so an integrator (and the bot, TG-REGIME-15M-W1) can read what a tool
 *     admits before calling it.
 *
 * A LEAF because the obvious home is a cycle: the pipeline imports `getFeature` from feature-registry at runtime, and
 * feature-registry is data + types only (it must never import the pipeline and its tool graph). Both import this.
 * Its runtime imports are the three set declarations, all pure; `RegistryToolName` is a type import, erased.
 *
 * `null` = the tool has no single-`timeframe` admission (get_support_resistance_zones takes the plural
 * `timeframes` array, validated by its own schema). The keys are tsc-exhaustive over the registry's canonical names.
 */
import type { RegistryToolName } from './feature-registry.js';
import { TIMEFRAMES } from './capabilities.js';
import { REGIME_TIMEFRAMES } from './tool-param-schema.js';
import { REGIME_SNAPSHOT_TIMEFRAMES } from './regime-snapshot-timeframes.js';

export const TOOL_ADMISSION_TIMEFRAMES: { readonly [K in RegistryToolName]: readonly string[] | null } = Object.freeze({
  get_trade_call: TIMEFRAMES,
  // get_market_regime computes live: every timeframe with a served window (REGIME_SERVED_TIMEFRAMES).
  get_market_regime: REGIME_TIMEFRAMES,
  scan_funding_arb: null,
  scan_trade_calls: TIMEFRAMES,
  get_equity_call: TIMEFRAMES,
  get_equity_regime: null,
  chat_knowledge: null,
  search_knowledge: null,
  get_track_record: null,
  // The snapshot-served tools admit only what the bar-close sampler writes (REGIME-TF-ADMISSION-W1).
  scan_market_regimes: REGIME_SNAPSHOT_TIMEFRAMES,
  pre_trade_check: REGIME_SNAPSHOT_TIMEFRAMES,
  get_support_resistance_zones: null,
});

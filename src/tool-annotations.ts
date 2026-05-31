import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

/**
 * Generator-level single source of truth for the MCP tool-annotation hints
 * carried by every PUBLIC AlgoVault tool (get_trade_call, get_trade_signal,
 * scan_funding_arb, get_market_regime, search_knowledge, chat_knowledge).
 *
 * Why centralise: the OpenAI Apps SDK / ChatGPT App Directory relies on these
 * hints to classify the app as safe, read-only decision-support — no
 * confirmation gate, no autonomous money movement. A single constant means
 * every future tool inherits the correct, policy-clean hints by importing this
 * value instead of hand-writing an annotations object that can silently drift
 * (the failure mode that left destructiveHint unset on all six tools).
 *
 * Semantics (CHATGPT-APP-DIRECTORY-SUBMIT-W1, architect-confirmed 2026-05-31):
 *   readOnlyHint    true  — tools only retrieve/compute; they never write or
 *                           send data on the caller's behalf.
 *   openWorldHint   true  — tools surface LIVE external market data (exchange
 *                           funding / price / regime), i.e. an open, changing
 *                           world. Kept TRUE deliberately because it is
 *                           accurate; the directory's read-only + non-
 *                           destructive hints are what the policy review keys
 *                           on, not openWorldHint.
 *   destructiveHint false — no irreversible side effects in any code path.
 */
export const PUBLIC_READONLY_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: true,
  destructiveHint: false,
};

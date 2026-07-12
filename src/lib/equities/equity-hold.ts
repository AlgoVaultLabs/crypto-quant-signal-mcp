/**
 * equity-hold.ts — the single-derivation SoT for the equity PUBLIC-COPY HOLD.
 *
 * `EQUITY_PUBLIC_COPY_HOLD` was defined in `scripts/tool-readiness-report.ts`; it is relocated
 * here (FUNNEL-FIX-AGENT-X402-NUDGE-W1) as a PURE, side-effect-free, import-safe constant so a
 * runtime `lib` consumer can key off it WITHOUT importing the ops/report script. That report
 * now imports the flag from here — ONE definition, no drift.
 *
 * Semantics (Mr.1 2026-06-04, reaffirmed 2026-06-08): while the HOLD is in force, the equity
 * tools stay INTERNAL for ALL public / discovery surfaces — release copy, the CDP Bazaar
 * promotion, AND the agent x402 nudge (`suggested_x402` is another public discovery surface, so
 * surfacing the equity pay route there would contradict "keep equity dark until public launch").
 * When EQUITY-CALIBRATION-AUDIT-W1 lifts the HOLD, flip this to `false` and every consumer
 * AUTO-INCLUDES equities with zero code change (the WEBSITE-X402-SCANNER-EQUITY-CARD trigger).
 */

/** True while equities are held from all public/discovery surfaces. Flip to false to launch. */
export const EQUITY_PUBLIC_COPY_HOLD = true;

/**
 * The equity MCP tools suppressed from PUBLIC discovery surfaces while the HOLD is in force.
 * (They remain x402-payable at the transport layer; this only governs public SURFACING.)
 */
export const EQUITY_HELD_TOOLS: readonly string[] = ['get_equity_call', 'get_equity_regime'];

/**
 * Is this tool currently suppressed from public discovery surfaces by the equity HOLD?
 * When `EQUITY_PUBLIC_COPY_HOLD` flips false, this returns false for every tool (auto-join).
 */
export function isHeldFromPublicSurfaces(toolName: string): boolean {
  return EQUITY_PUBLIC_COPY_HOLD && EQUITY_HELD_TOOLS.includes(toolName);
}

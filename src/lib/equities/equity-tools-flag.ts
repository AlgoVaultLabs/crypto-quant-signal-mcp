/**
 * EQUITY-TOOLS-DARK-RETIRE-W1 — the single reversible lever for the equity MCP tools.
 *
 * `EQUITY_TOOLS_ENABLED` (env, default OFF) gates BOTH the live tools/list
 * registration (index.ts) AND the equity readiness card (venue-readiness-report.ts)
 * from ONE predicate — they cannot drift. Mirrors the `a2mcp`/`acp` pattern already
 * codified in feature-registry.ts (FeatureSpec doc): FEATURE_REGISTRY keeps DECLARING
 * both equity tools (`allToolNames()`=9, `/capabilities`=9, the `HTTP_TOOLS` x402 rail
 * unchanged — the capability + paid reach are PRESERVED); THIS flag decides whether they
 * mount on the free MCP `tools/list` surface. Re-enable = set the env var + recreate the
 * container (a flag flip, not a rebuild). See docs/RUNBOOK-EQUITY-TOOLS-REENABLE.md.
 *
 * Pure DATA + a pure env read — import-safe (no runtime handlers, no cycle).
 */
import { allToolNames } from '../feature-registry.js';

/** The two equity MCP tools this flag gates off the live tools/list. */
export const EQUITY_TOOL_NAMES = ['get_equity_call', 'get_equity_regime'] as const;

const EQUITY_TOOL_NAME_SET: ReadonlySet<string> = new Set<string>(EQUITY_TOOL_NAMES);

/** True iff `name` is one of the flag-gated equity tools. */
export function isEquityToolName(name: string): boolean {
  return EQUITY_TOOL_NAME_SET.has(name);
}

/**
 * Whether the equity MCP tools are live on THIS process. Default FALSE (dark-retired).
 * Accepts `1` OR `true` (case-insensitive) — bakes in the X402_NUDGE_ENABLED hotfix
 * lesson (a `=== 'true'`-only parser silently no-op'd the documented `=1` go-live value,
 * status.md 2026-07-12).
 */
export function isEquityToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.EQUITY_TOOLS_ENABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

/**
 * The tool names the live MCP server registers on `tools/list`, given the flag.
 * OFF → the crypto set (6 canonical + the `get_trade_signal` alias = 7); the two equity
 * tools are absent. ON → every declared name (9). This IS the single derivation the
 * registry-driven registration loop in index.ts consumes — the unit test pins both states
 * (7 vs 9), so the live behavior is proven at the same seam it's produced.
 */
export function liveMcpToolNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const equityLive = isEquityToolsEnabled(env);
  return allToolNames().filter((n) => equityLive || !isEquityToolName(n));
}

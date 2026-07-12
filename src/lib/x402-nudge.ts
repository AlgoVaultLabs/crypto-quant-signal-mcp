/**
 * x402-nudge.ts — FUNNEL-FIX-AGENT-X402-NUDGE-W1.
 *
 * Closes the agent-funnel leak the dual-funnel scoreboard exposed: at the free 100/mo quota
 * edge the shipped nudge points a MACHINE at a HUMAN Stripe subscription (~0 convert). This
 * helper derives the in-protocol x402 pay-per-call rail(s) an agent can settle AUTONOMOUSLY
 * (its own wallet, no signup) for the tool it just called, so the envelope can offer a
 * `suggested_x402` branch alongside the intact Stripe/referral fields.
 *
 * RAIL-AGNOSTIC + SINGLE-DERIVATION (Mr.1 ratifications, base 075d408):
 *   - the rail SET = the feature-registry `channels{}` reach flags (`httpX402`, `a2mcp`) AND
 *     each rail's live runtime predicate — Bazaar: `resolveFacilitatorFromEnv().discoveryEnabled`
 *     (the SAME predicate `mountX402HttpRoutes` gates on); okx.ai A2MCP: `selectOkxA2mcp().mode==='live'`.
 *   - price = the ONE registry `x402.basePriceUsd` SoT (what `TOOL_PRICING`/`okxA2mcpPriceUsdt0` derive from).
 *   - route = `/x402|/a2mcp/<the-called-tool>` (canonical name; every tool points at its OWN route).
 *   - never hardcode a rail; never surface a DARK rail; a rail flag flipped in the SoT+env
 *     changes the output with ZERO code change (the AC2/R4 rail-agnostic proof).
 *   - ACP is EXCLUDED (Q1→A): the Virtuals seller-worker protocol has NO HTTP settle route an
 *     agent can act on, so it cannot be a {url,method,price} rail.
 *   - HELD tools (equities while `EQUITY_PUBLIC_COPY_HOLD`) are never surfaced (Q5) — the nudge
 *     is another public discovery surface; equities AUTO-JOIN when the HOLD flag flips.
 *
 * LEAF MODULE (breaks the consumer init cycle): imports ONLY pure-data / SDK-transport modules
 * (feature-registry, x402-facilitator, the pure okx-a2mcp-config, equity-hold, x402-bazaar's
 * base-URL const, types) — NEVER a tool handler / x402-http-routes / errors / tier-warning. So
 * every consumer (index.ts error path, tier-warning hard path, scan-trade-calls envelope) can
 * import it without the `x402-nudge → okx-a2mcp → x402-http-routes → <tool>` cycle.
 *
 * FLAG: `X402_NUDGE_ENABLED` (default OFF) is checked by the WIRING (via `isX402NudgeEnabled`),
 * not here — this fn is pure rail-derivation so the rail-agnostic tests need no nudge flag.
 */
import { getFeature } from './feature-registry.js';
import { resolveFacilitatorFromEnv } from './x402-facilitator.js';
import { X402_HTTP_BASE } from './x402-bazaar.js';
import {
  resolveOkxA2mcpConfig,
  selectOkxA2mcp,
  XLAYER_NETWORK,
  A2MCP_PREFIX,
} from './okx-a2mcp-config.js';
import { isHeldFromPublicSurfaces } from './equities/equity-hold.js';
import type { SuggestedX402, X402Rail } from '../types.js';

type NudgeEnv = Record<string, string | undefined>;

/** Base network CAIP-2 by X402_NETWORK (prod = base-mainnet). */
const BASE_CAIP2: Record<string, string> = {
  'base-mainnet': 'eip155:8453',
  'base-sepolia': 'eip155:84532',
};

/**
 * The `X402_NUDGE_ENABLED` feature flag (default OFF). Checked by the WIRING (the tier-limit
 * payload / hard tier_warning / scanner envelope) — NOT by `buildSuggestedX402`, which stays a
 * pure rail-derivation so the rail-agnostic tests need no nudge flag. OFF ⇒ the field is never
 * added ⇒ the envelope is byte-identical to today.
 */
export function isX402NudgeEnabled(env: NudgeEnv = process.env): boolean {
  // Funnel-flag convention (auth-providers.ts `NEW_SIGNUP_ENABLED`/`UNIFIED_SIGNIN_ENABLED` both
  // accept `=== '1' || === 'true'`): the documented go-live value is `X402_NUDGE_ENABLED=1`, so a
  // `=== 'true'`-only parse would leave the flag dark after the operator's `=1` flip. Accept both.
  // NB: 3rd funnel flag with this exact parse → a shared `parseFunnelFlag` helper is a WIS
  // extraction candidate (3-example threshold; deferred, not inline-extracted here).
  const v = env.X402_NUDGE_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true';
}

/** Agent-relayable copy; price interpolated from the SoT (NEVER hardcoded — scan_funding_arb is $0.01). */
function buildInstructions(priceUsd: number): string {
  return (
    'Free monthly quota reached. Pay per call with your own wallet — no signup: POST to the ' +
    `x402 route below (HTTP 402 → sign ERC-3009 → resend with x-payment). $${priceUsd} per call.`
  );
}

/**
 * The in-protocol x402 rail(s) for the tool an agent just called, or `undefined` when no
 * public (non-HELD) x402 rail is live (default-deny ⇒ the envelope stays unchanged).
 */
export function buildSuggestedX402(toolNameOrAlias: string, env: NudgeEnv = process.env): SuggestedX402 | undefined {
  const feat = getFeature(toolNameOrAlias);
  if (!feat || !feat.x402) return undefined; // unknown or unpriced (knowledge tools) ⇒ no rail
  // HELD tools (equities while EQUITY_PUBLIC_COPY_HOLD) are never surfaced on this public
  // discovery surface (Q5); they AUTO-JOIN when the HOLD flag flips — single-derivation.
  if (isHeldFromPublicSurfaces(feat.name)) return undefined;
  const price = feat.x402.basePriceUsd;

  const rails: X402Rail[] = [];

  // Bazaar (Base/USDC) — primary. Gated on the SAME predicate the route-mount uses.
  if (feat.channels.httpX402 && resolveFacilitatorFromEnv(env).discoveryEnabled) {
    rails.push({
      rail: 'x402_bazaar',
      label: 'CDP x402 Bazaar (Base/USDC)',
      method: 'POST',
      url: `${X402_HTTP_BASE}/x402/${feat.name}`,
      network: BASE_CAIP2[env.X402_NETWORK ?? 'base-mainnet'] ?? 'eip155:8453',
      asset: 'USDC',
      price_usd: price,
      scheme: 'exact',
    });
  }

  // okx.ai A2MCP (X Layer/USDT0) — alternative. Only when the rail is LIVE (real OKX-facilitator
  // settlement), never stub (OKX_AI_ENABLED=true but uncredentialed): a stub route can't take the
  // agent's money. Toggling OKX_AI_ENABLED in the SoT+env flips this with zero code change (AC2/R4).
  if (feat.channels.a2mcp && selectOkxA2mcp(resolveOkxA2mcpConfig(env)).mode === 'live') {
    rails.push({
      rail: 'okx_a2mcp',
      label: 'okx.ai A2MCP (X Layer/USDT0)',
      method: 'POST',
      url: `${X402_HTTP_BASE}${A2MCP_PREFIX}/${feat.name}`,
      network: XLAYER_NETWORK,
      asset: 'USDT0',
      price_usd: price,
      scheme: 'exact',
    });
  }

  if (rails.length === 0) return undefined; // no live public rail ⇒ default-deny
  const [primary, ...alternatives] = rails;
  return { tool: feat.name, instructions: buildInstructions(price), primary, alternatives };
}

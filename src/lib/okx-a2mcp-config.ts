/**
 * okx-a2mcp-config.ts — PURE config / derivation for the okx.ai A2MCP rail (X Layer · USDT0).
 *
 * Extracted from `okx-a2mcp.ts` (FUNNEL-FIX-AGENT-X402-NUDGE-W1) as a LEAF module: the
 * env→config→pure-decision + the registry-derived listed set + the price, importing ONLY
 * `feature-registry` (a DATA+TYPES leaf) — NO `@okxweb3/*` SDK, NO `x402-http-routes`, NO tool
 * handlers. This lets SDK-free consumers (the agent x402 nudge) import `selectOkxA2mcp` /
 * `okxA2mcpTools` / the X-Layer constants WITHOUT dragging the whole `okx-a2mcp` mount graph
 * (which imports `x402-http-routes` → every tool handler → a module-init cycle).
 *
 * `okx-a2mcp.ts` re-exports every symbol here, so its existing importers (index.ts, the okx
 * test) are byte-unchanged. Single-derivation: this is the ONE source for the okx rail's
 * constants + enable-decision + listed-set + price. Side-effect-free.
 */
import { FEATURE_REGISTRY, getFeature } from './feature-registry.js';

// ─────────────────────── X Layer constants (on-chain-verified 2026-06-30) ───────────────────────
/** CAIP-2 for X Layer mainnet (`eth_chainId`=0xc4=196). */
export const XLAYER_NETWORK = 'eip155:196';
/** USDT0 on X Layer — 6-dec, EIP-3009 (`transferWithAuthorization`) SUPPORTED. */
export const XLAYER_USDT0 = '0x779Ded0c9e1022225f8E0630b35a9b54bE713736';
export const XLAYER_USDT0_DECIMALS = 6;
/** On-chain `name()` = EIP-712 domain name; confirm the full domain via `getSupported()` at enablement. */
export const XLAYER_USDT0_EIP712_NAME = 'USD₮0';
export const OKX_FACILITATOR_DEFAULT_URL = 'https://web3.okx.com';
export const A2MCP_PREFIX = '/a2mcp';

// ─────────────────────── registry-derived listed set (NO hardcoded okx.ai tool list) ───────────────────────
/** The tools listed on okx.ai A2MCP — DERIVED from the registry (`channels.a2mcp` + enabled). */
export function okxA2mcpTools(): string[] {
  return FEATURE_REGISTRY.filter((f) => f.enabled && f.channels.a2mcp).map((f) => f.name);
}

/**
 * okx.ai per-call price in USDT0 — DERIVED 1:1 from the TOOL_PRICING SoT (the registry
 * `x402.basePriceUsd`), denominated USDT0. Same product, same price on every channel
 * (Mr.1 R4 sign-off 2026-06-30): OKX take-rate=0 (UA §2.3) + gas subsidized (feePayer=true)
 * → nothing to pad; NO separate/higher schedule. Editable later once ranked. The drift
 * canary asserts this equals the registry basePriceUsd for every a2mcp tool.
 */
export function okxA2mcpPriceUsdt0(tool: string): number {
  return getFeature(tool)?.x402?.basePriceUsd ?? 0.02;
}

// ─────────────────────── env → config → pure selection (mirrors selectFacilitator) ───────────────────────
export interface OkxA2mcpEnv {
  OKX_AI_ENABLED?: string;
  OKX_API_KEY?: string;
  OKX_SECRET_KEY?: string;
  OKX_PASSPHRASE?: string;
  /** X Layer recipient (Mr.1's Agentic-Wallet address); unset → stub-fallback. */
  OKX_A2MCP_PAYTO?: string;
  /** Optional facilitator baseUrl override (default web3.okx.com). */
  OKX_FACILITATOR_URL?: string;
}

export interface OkxA2mcpConfig {
  enabled: boolean;
  apiKey?: string;
  secretKey?: string;
  passphrase?: string;
  payTo?: string;
  baseUrl?: string;
}

export function resolveOkxA2mcpConfig(env: OkxA2mcpEnv = process.env): OkxA2mcpConfig {
  return {
    enabled: env.OKX_AI_ENABLED?.trim().toLowerCase() === 'true',
    apiKey: env.OKX_API_KEY || undefined,
    secretKey: env.OKX_SECRET_KEY || undefined,
    passphrase: env.OKX_PASSPHRASE || undefined,
    payTo: env.OKX_A2MCP_PAYTO || undefined,
    baseUrl: env.OKX_FACILITATOR_URL || undefined,
  };
}

export type OkxA2mcpMode = 'off' | 'stub' | 'live';

export interface ResolvedOkxA2mcp {
  /** True when routes should mount (mode !== 'off'). */
  active: boolean;
  mode: OkxA2mcpMode;
  /** True when enabled but creds/payTo were missing → fell back to the stub. */
  stubFellBack: boolean;
  apiKey?: string;
  secretKey?: string;
  passphrase?: string;
  payTo?: string;
  baseUrl?: string;
}

/**
 * PURE decision — no client construction, no logging. The two-flag + stub-fallback rule:
 *   OKX_AI_ENABLED!=true                        → off  (nothing mounts; byte-identical prod)
 *   enabled + apiKey+secretKey+passphrase+payTo → live (OKX managed facilitator)
 *   enabled + any missing                       → stub (dark [STUB]; the wave ships regardless)
 * This is the unit-test seam.
 */
export function selectOkxA2mcp(cfg: OkxA2mcpConfig): ResolvedOkxA2mcp {
  if (!cfg.enabled) return { active: false, mode: 'off', stubFellBack: false };
  const credsPresent = Boolean(cfg.apiKey && cfg.secretKey && cfg.passphrase && cfg.payTo);
  if (credsPresent) {
    return {
      active: true, mode: 'live', stubFellBack: false,
      apiKey: cfg.apiKey, secretKey: cfg.secretKey, passphrase: cfg.passphrase,
      payTo: cfg.payTo, baseUrl: cfg.baseUrl,
    };
  }
  return { active: true, mode: 'stub', stubFellBack: true };
}

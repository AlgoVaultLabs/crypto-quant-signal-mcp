/**
 * FUNNEL-FIX-AGENT-X402-NUDGE-W1 — suggested_x402 helper.
 *
 * The helper derives the agent-actionable in-protocol x402 pay-per-call rail(s) for the tool
 * an agent just called, from the feature-registry channels{} SoT + the live rail-enable
 * predicates + the one price SoT. Rail-agnostic (never hardcodes a rail), single-derivation
 * (price = registry basePriceUsd; route = /x402|/a2mcp/<the-called-tool>), default-deny (no
 * live public rail ⇒ returns undefined ⇒ envelope unchanged), and it never surfaces a HELD
 * tool (equities while EQUITY_PUBLIC_COPY_HOLD).
 */
import { describe, it, expect } from 'vitest';
import { buildSuggestedX402, isX402NudgeEnabled } from '../src/lib/x402-nudge.js';

/** Bazaar (Base/USDC) live; OKX a2mcp OFF. */
const BAZAAR_ONLY_ENV: Record<string, string | undefined> = {
  X402_FACILITATOR: 'cdp',
  CDP_API_KEY_ID: 'test-id',
  CDP_API_KEY_SECRET: 'test-secret',
  BAZAAR_DISCOVERABLE: 'true',
  X402_NETWORK: 'base-mainnet',
  // OKX_AI_ENABLED unset ⇒ okx off
};

describe('buildSuggestedX402 — Bazaar rail', () => {
  it('offers the Bazaar (Base/USDC) rail for get_trade_call at its own /x402 route + registry price', () => {
    const sx = buildSuggestedX402('get_trade_call', BAZAAR_ONLY_ENV);
    expect(sx).toBeDefined();
    expect(sx!.tool).toBe('get_trade_call');
    expect(sx!.primary.rail).toBe('x402_bazaar');
    expect(sx!.primary.method).toBe('POST');
    expect(sx!.primary.url).toBe('https://api.algovault.com/x402/get_trade_call');
    expect(sx!.primary.network).toBe('eip155:8453');
    expect(sx!.primary.asset).toBe('USDC');
    expect(sx!.primary.price_usd).toBe(0.02);
    expect(sx!.primary.scheme).toBe('exact');
    expect(sx!.alternatives).toEqual([]); // okx off
    expect(sx!.instructions).toContain('$0.02'); // price interpolated, not hardcoded
  });
});

/** Bazaar live AND okx.ai A2MCP live (flag + creds ⇒ mode 'live'). */
const BOTH_RAILS_ENV: Record<string, string | undefined> = {
  ...BAZAAR_ONLY_ENV,
  OKX_AI_ENABLED: 'true',
  OKX_API_KEY: 'k',
  OKX_SECRET_KEY: 's',
  OKX_PASSPHRASE: 'p',
  OKX_A2MCP_PAYTO: '0xpayto',
};

describe('buildSuggestedX402 — okx.ai A2MCP alternative rail', () => {
  it('adds okx a2mcp (X Layer/USDT0) as alternatives[0] when live; Bazaar stays primary (Q2)', () => {
    const sx = buildSuggestedX402('get_trade_call', BOTH_RAILS_ENV);
    expect(sx).toBeDefined();
    expect(sx!.primary.rail).toBe('x402_bazaar'); // broadest agent rail first
    expect(sx!.alternatives).toHaveLength(1);
    const okx = sx!.alternatives[0];
    expect(okx.rail).toBe('okx_a2mcp');
    expect(okx.method).toBe('POST');
    expect(okx.url).toBe('https://api.algovault.com/a2mcp/get_trade_call');
    expect(okx.network).toBe('eip155:196'); // X Layer
    expect(okx.asset).toBe('USDT0');
    expect(okx.price_usd).toBe(0.02);
  });

  it('does NOT surface okx when OKX_AI_ENABLED is off (dark rail never offered)', () => {
    const sx = buildSuggestedX402('get_trade_call', BAZAAR_ONLY_ENV);
    expect(sx!.alternatives).toEqual([]);
  });

  it('does NOT surface okx in stub mode (enabled but creds missing — not a real settle rail)', () => {
    const stubEnv = { ...BAZAAR_ONLY_ENV, OKX_AI_ENABLED: 'true' }; // no OKX creds ⇒ stub
    const sx = buildSuggestedX402('get_trade_call', stubEnv);
    expect(sx!.alternatives).toEqual([]);
  });
});

describe('buildSuggestedX402 — HELD tools + default-deny (Q5)', () => {
  it('never surfaces a HELD equity tool while EQUITY_PUBLIC_COPY_HOLD (even though it is x402-payable)', () => {
    // Bazaar live + get_equity_call has channels.httpX402=true, but it is on the equity public-copy HOLD.
    expect(buildSuggestedX402('get_equity_call', BOTH_RAILS_ENV)).toBeUndefined();
    expect(buildSuggestedX402('get_equity_regime', BOTH_RAILS_ENV)).toBeUndefined();
  });

  it('returns undefined for an unpriced tool (knowledge tools: x402=null)', () => {
    expect(buildSuggestedX402('chat_knowledge', BOTH_RAILS_ENV)).toBeUndefined();
    expect(buildSuggestedX402('search_knowledge', BOTH_RAILS_ENV)).toBeUndefined();
  });

  it('returns undefined for an unknown tool', () => {
    expect(buildSuggestedX402('does_not_exist', BOTH_RAILS_ENV)).toBeUndefined();
  });

  it('default-deny: no live rail (Bazaar off, okx off) ⇒ undefined ⇒ envelope unchanged', () => {
    expect(buildSuggestedX402('get_trade_call', {})).toBeUndefined();
  });

  it('resolves an alias to its canonical route (get_trade_signal → get_trade_call)', () => {
    const sx = buildSuggestedX402('get_trade_signal', BAZAAR_ONLY_ENV);
    expect(sx!.tool).toBe('get_trade_call');
    expect(sx!.primary.url).toBe('https://api.algovault.com/x402/get_trade_call');
  });
});

describe('buildSuggestedX402 — rail-agnostic (AC2/R4) + per-tool single-derivation (Q3/Q6)', () => {
  it('AC2: toggling OKX_AI_ENABLED in the SoT surfaces/hides the okx rail with ZERO code change', () => {
    const okxLive = { ...BAZAAR_ONLY_ENV, OKX_AI_ENABLED: 'true', OKX_API_KEY: 'k', OKX_SECRET_KEY: 's', OKX_PASSPHRASE: 'p', OKX_A2MCP_PAYTO: '0xp' };
    const okxOff = { ...okxLive, OKX_AI_ENABLED: 'false' };
    // same fn, same tool — only the SoT flag differs
    expect(buildSuggestedX402('get_trade_call', okxLive)!.alternatives.map((r) => r.rail)).toEqual(['okx_a2mcp']);
    expect(buildSuggestedX402('get_trade_call', okxOff)!.alternatives).toEqual([]);
  });

  it('Q3/Q6: route + price are per-tool from the SoT — scan_funding_arb is $0.01 at its own route', () => {
    const sx = buildSuggestedX402('scan_funding_arb', BAZAAR_ONLY_ENV);
    expect(sx!.primary.url).toBe('https://api.algovault.com/x402/scan_funding_arb');
    expect(sx!.primary.price_usd).toBe(0.01); // NOT 0.02 — proves price interpolates from TOOL_PRICING
    expect(sx!.instructions).toContain('$0.01');
    expect(sx!.instructions).not.toContain('$0.02');
  });

  it('Q3: get_market_regime points at its OWN canonical /x402 route', () => {
    const sx = buildSuggestedX402('get_market_regime', BAZAAR_ONLY_ENV);
    expect(sx!.primary.url).toBe('https://api.algovault.com/x402/get_market_regime');
  });
});

describe('isX402NudgeEnabled', () => {
  it('is true for the funnel-flag go-live values 1/true (default OFF ⇒ envelope byte-identical)', () => {
    expect(isX402NudgeEnabled({ X402_NUDGE_ENABLED: '1' })).toBe(true); // the documented go-live value (auth-providers.ts convention)
    expect(isX402NudgeEnabled({ X402_NUDGE_ENABLED: 'true' })).toBe(true);
    expect(isX402NudgeEnabled({ X402_NUDGE_ENABLED: 'TRUE' })).toBe(true);
    expect(isX402NudgeEnabled({})).toBe(false);
    expect(isX402NudgeEnabled({ X402_NUDGE_ENABLED: 'false' })).toBe(false);
    expect(isX402NudgeEnabled({ X402_NUDGE_ENABLED: '0' })).toBe(false);
  });
});

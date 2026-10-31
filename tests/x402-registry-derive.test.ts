/**
 * FEATURE-REGISTRY-SOT-W1 CH3 — x402 pricing DERIVES from the feature registry (the SoT).
 *
 * Proves the canonical-key gap closure is ADDITIVE and behavior-preserving:
 *  (a) TOOL_PRICING is registry-derived: each priced feature's canonical + every alias
 *      maps to the feature's basePriceUsd.
 *  (b) The 3 pre-existing prices keep IDENTICAL values; the ONLY new key is canonical
 *      `get_trade_call` (architect A3 allowed-delta).
 *  (c) effectivePrice() alias-resolves: `get_trade_call` AND `get_trade_signal` price
 *      identically, base + 1m premium.
 *  (d) `get_trade_call` is priced-for-RESOLUTION but stays NON-gated + NON-discoverable
 *      (ratified Cowork A2): NOT in HTTP_TOOLS, NOT in BAZAAR_ROUTES, declareBazaarRoute
 *      returns {} → CDP Bazaar listing integrity preserved (3 routes).
 *  (e) CH4-canary parity: HTTP_TOOLS alias-resolved to canonical == registry httpX402.
 */
import { describe, it, expect } from 'vitest';
import { FEATURE_REGISTRY, getFeature } from '../src/lib/feature-registry.js';
import { TOOL_PRICING, effectivePrice } from '../src/lib/x402.js';
import { BAZAAR_ROUTES, declareBazaarRoute } from '../src/lib/x402-bazaar.js';
import { HTTP_TOOLS } from '../src/lib/x402-http-routes.js';

describe('FEATURE-REGISTRY-SOT-W1 CH3 — TOOL_PRICING derives from the registry', () => {
  it('emits a key for every priced feature canonical + each alias, at the feature price', () => {
    for (const f of FEATURE_REGISTRY) {
      if (!f.x402) continue;
      for (const name of [f.name, ...f.aliases]) {
        expect(TOOL_PRICING[name as keyof typeof TOOL_PRICING]).toBe(f.x402.basePriceUsd);
      }
    }
  });

  it('keeps the 3 pre-existing prices IDENTICAL (byte-equivalence)', () => {
    expect(TOOL_PRICING.get_trade_signal).toBe(0.02);
    expect(TOOL_PRICING.scan_funding_arb).toBe(0.01);
    expect(TOOL_PRICING.get_market_regime).toBe(0.02);
  });

  it('additive priced keys vs the legacy 3 = get_trade_call + the 3 newly-priced (OPS-X402-PRICING-EXPANSION-W1) + pre_trade_check (DECISION-CALL-V1-W3)', () => {
    const legacy = ['get_trade_signal', 'scan_funding_arb', 'get_market_regime'];
    const newKeys = Object.keys(TOOL_PRICING).filter((k) => !legacy.includes(k)).sort();
    expect(newKeys).toEqual(['get_equity_call', 'get_equity_regime', 'get_trade_call', 'pre_trade_check', 'scan_trade_calls']);
    expect(TOOL_PRICING.get_trade_call).toBe(0.02);
    expect(TOOL_PRICING.scan_trade_calls).toBe(0.02);
    expect(TOOL_PRICING.get_equity_call).toBe(0.02);
    expect(TOOL_PRICING.get_equity_regime).toBe(0.02);
    expect(TOOL_PRICING.pre_trade_check).toBe(0.02);
  });

  it('does NOT price the still-unpriced features (chat / search stay registry x402:null)', () => {
    for (const f of FEATURE_REGISTRY) {
      if (f.x402) continue;
      for (const name of [f.name, ...f.aliases]) {
        expect(TOOL_PRICING[name as keyof typeof TOOL_PRICING]).toBeUndefined();
      }
    }
  });
});

describe('FEATURE-REGISTRY-SOT-W1 CH3 — effectivePrice alias-resolves (canonical-key gap closed)', () => {
  it('canonical get_trade_call and alias get_trade_signal price IDENTICALLY (base)', () => {
    expect(effectivePrice('get_trade_call')).toBe(0.02);
    expect(effectivePrice('get_trade_signal')).toBe(0.02);
  });

  it('canonical and alias price IDENTICALLY with the 1m premium', () => {
    expect(effectivePrice('get_trade_call', '1m')).toBe(0.05);
    expect(effectivePrice('get_trade_signal', '1m')).toBe(0.05);
  });

  it('the other priced tools resolve at base, premium does NOT apply to them', () => {
    expect(effectivePrice('scan_funding_arb')).toBe(0.01);
    expect(effectivePrice('scan_funding_arb', '1m')).toBe(0.01);
    expect(effectivePrice('get_market_regime')).toBe(0.02);
    expect(effectivePrice('get_market_regime', '1m')).toBe(0.02);
  });

  it('returns undefined for an unknown / still-unpriced tool', () => {
    expect(effectivePrice('unknown_tool')).toBeUndefined();
    expect(effectivePrice('chat_knowledge')).toBeUndefined();
    expect(effectivePrice('search_knowledge')).toBeUndefined();
  });
});

describe('FEATURE-REGISTRY-SOT-W1 CH3 — get_trade_call priced-for-resolution but NOT gated/discoverable (A2)', () => {
  it('get_trade_call gets NO Bazaar discovery extension (not in BAZAAR_ROUTES; listing is the 7 gated tools)', () => {
    expect(declareBazaarRoute('get_trade_call')).toEqual({});
    expect(Object.keys(BAZAAR_ROUTES).sort()).toEqual(
      ['get_equity_call', 'get_equity_regime', 'get_market_regime', 'get_trade_signal', 'pre_trade_check', 'scan_funding_arb', 'scan_trade_calls'],
    );
  });

  it('get_trade_call is NOT in the gated HTTP_TOOLS allow-list (free caller stays free)', () => {
    expect([...HTTP_TOOLS]).not.toContain('get_trade_call');
    expect([...HTTP_TOOLS].sort()).toEqual(
      ['get_equity_call', 'get_equity_regime', 'get_market_regime', 'get_trade_signal', 'pre_trade_check', 'scan_funding_arb', 'scan_trade_calls'],
    );
  });

  it('CH4-canary parity: HTTP_TOOLS alias-resolved to canonical == registry httpX402 set', () => {
    const regHttpX402 = FEATURE_REGISTRY.filter((f) => f.channels.httpX402 && f.x402)
      .map((f) => f.name).sort();
    const httpResolved = [...new Set([...HTTP_TOOLS].map((n) => getFeature(n)?.name))].sort();
    expect(httpResolved).toEqual(regHttpX402);
  });
});

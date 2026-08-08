/**
 * OPS-X402-PRICING-EXPANSION-W1 — price the 3 last-unpriced metered tools in x402.
 *
 * scan_trade_calls / get_equity_call / get_equity_regime = $0.02 FLAT (the x402 rail
 * declares the price before running, so it cannot bill per-result). The free-100 rail
 * is unchanged. get_trade_call stays free/un-gated (W1 A2).
 */
import { describe, it, expect } from 'vitest';
import { effectivePrice } from '../src/lib/x402.js';
import { HTTP_TOOLS } from '../src/lib/x402-http-routes.js';
import { BAZAAR_ROUTES } from '../src/lib/x402-bazaar.js';
import { getFeature } from '../src/lib/feature-registry.js';

const NEW = ['scan_trade_calls', 'get_equity_call', 'get_equity_regime'] as const;
const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d'];

describe('x402 pricing expansion — the 3 new prices', () => {
  it('effectivePrice == 0.02 for each new tool', () => {
    for (const t of NEW) expect(effectivePrice(t)).toBe(0.02);
  });

  it('FLAT across ALL timeframes — no premium for the 3 (only get_trade_call has a premium)', () => {
    for (const t of NEW) for (const tf of TIMEFRAMES) expect(effectivePrice(t, tf)).toBe(0.02);
  });

  it('the 3 EXISTING prices are byte-identical (regression firewall)', () => {
    expect(effectivePrice('get_trade_call')).toBe(0.02);
    expect(effectivePrice('get_trade_signal')).toBe(0.02);
    expect(effectivePrice('scan_funding_arb')).toBe(0.01);
    expect(effectivePrice('get_market_regime')).toBe(0.02);
  });

  it('registry: the 3 carry x402 0.02 + channels.httpX402=true', () => {
    for (const t of NEW) {
      const f = getFeature(t);
      expect(f).toBeTruthy();
      expect(f!.channels.httpX402).toBe(true);
      expect(f!.x402?.basePriceUsd).toBe(0.02);
    }
  });
});

describe('x402 pricing expansion — gated/discoverable set (+3 named; get_trade_call untouched)', () => {
  it('HTTP_TOOLS includes the 3 new tools', () => {
    for (const t of NEW) expect((HTTP_TOOLS as readonly string[]).includes(t)).toBe(true);
  });

  it('get_trade_call stays OUT of HTTP_TOOLS (free/un-gated); get_trade_signal alias stays IN', () => {
    expect((HTTP_TOOLS as readonly string[]).includes('get_trade_call')).toBe(false);
    expect((HTTP_TOOLS as readonly string[]).includes('get_trade_signal')).toBe(true);
  });

  it('HTTP_TOOLS == BAZAAR_ROUTES keys (route ↔ discovery parity, now 6)', () => {
    expect([...HTTP_TOOLS].sort()).toEqual(Object.keys(BAZAAR_ROUTES).sort());
    expect(HTTP_TOOLS.length).toBe(6);
  });

  it('each new tool has a complete BazaarRouteSpec', () => {
    for (const t of NEW) {
      const spec = BAZAAR_ROUTES[t];
      expect(spec, `BAZAAR_ROUTES[${t}]`).toBeTruthy();
      expect(spec.inputSchema).toBeTruthy();
      expect(spec.example).toBeTruthy();
      expect(spec.output?.example).toBeTruthy();
    }
  });
});

describe('x402 pricing expansion — the free-quota rule is now FLAT (R3 superseded by R-A/R-G)', () => {
  it('registry quota.unit for the 3, after the flat-billing flip', () => {
    // This assertion originally pinned the units as "byte-unchanged" to prove the x402 PRICING
    // wave had not disturbed the free rail. PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 changes the
    // free rail deliberately (architect R-A/R-G), so the pin moves with it. What it still
    // guards is unchanged: the x402 per-call PRICES are a separate axis and must not have moved
    // — asserted in the describe blocks above.
    expect(getFeature('scan_trade_calls')!.quota.unit).toBe('per-verdict');
    expect(getFeature('get_equity_call')!.quota.unit).toBe('per-call');
    expect(getFeature('get_equity_regime')!.quota.unit).toBe('per-call');
    // ...and no live feature may reintroduce a verdict-conditional freebie.
    expect(getFeature('scan_trade_calls')!.quota.holdFree).toBe(false);
    expect(getFeature('get_equity_call')!.quota.holdFree).toBe(false);
  });
});

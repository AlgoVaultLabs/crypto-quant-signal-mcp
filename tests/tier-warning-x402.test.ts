/**
 * FUNNEL-FIX-AGENT-X402-NUDGE-W1 — suggested_x402 on the HARD tier_warning (R3).
 *
 * The hard warning (approaching the wall, 90–99%) also offers the additive in-protocol x402
 * branch, dark behind X402_NUDGE_ENABLED. Soft warnings never carry it; a HELD tool never does.
 */
import { describe, it, expect } from 'vitest';
import { computeTierWarning } from '../src/lib/tier-warning.js';

/** Bazaar live so a rail exists; nudge flag ON. */
const NUDGE_ON_ENV: Record<string, string | undefined> = {
  X402_NUDGE_ENABLED: 'true',
  X402_FACILITATOR: 'cdp',
  CDP_API_KEY_ID: 'k',
  CDP_API_KEY_SECRET: 's',
  BAZAAR_DISCOVERABLE: 'true',
  X402_NETWORK: 'base-mainnet',
};

describe('computeTierWarning — suggested_x402 on the hard warning', () => {
  it('attaches suggested_x402 on a HARD warning when the nudge flag is on', () => {
    const w = computeTierWarning({ tier: 'free', currentUsage: 95, monthlyLimit: 100, tool: 'get_trade_call', env: NUDGE_ON_ENV });
    expect(w?.level).toBe('hard');
    expect(w?.suggested_x402).toBeDefined();
    expect(w?.suggested_x402?.primary.url).toBe('https://api.algovault.com/x402/get_trade_call');
    expect(w?.suggested_upgrade_url).toBeDefined(); // Stripe path intact
  });

  it('omits suggested_x402 when the nudge flag is off (byte-identical hard warning)', () => {
    const env = { ...NUDGE_ON_ENV, X402_NUDGE_ENABLED: 'false' };
    const w = computeTierWarning({ tier: 'free', currentUsage: 95, monthlyLimit: 100, tool: 'get_trade_call', env });
    expect(w?.level).toBe('hard');
    expect(w?.suggested_x402).toBeUndefined();
    expect('suggested_x402' in (w as object)).toBe(false);
  });

  it('never attaches suggested_x402 on a SOFT warning', () => {
    const w = computeTierWarning({ tier: 'free', currentUsage: 82, monthlyLimit: 100, tool: 'get_trade_call', env: NUDGE_ON_ENV });
    expect(w?.level).toBe('soft');
    expect(w?.suggested_x402).toBeUndefined();
  });

  it('never attaches suggested_x402 for a HELD tool (equity) even on a hard warning', () => {
    const w = computeTierWarning({ tier: 'free', currentUsage: 95, monthlyLimit: 100, tool: 'get_equity_call', env: NUDGE_ON_ENV });
    expect(w?.level).toBe('hard');
    expect(w?.suggested_x402).toBeUndefined();
  });
});

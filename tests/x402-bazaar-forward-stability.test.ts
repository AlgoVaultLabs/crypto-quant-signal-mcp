/**
 * Forward-stability + compliance canary for BAZAAR_ROUTES descriptions.
 * (X402-BAZAAR-R4-TDQS-W1 — recommended by audits/x402-bazaar-discoverability-2026-06-30.md)
 *
 * The CDP x402 Bazaar resource descriptions are public, agent-facing copy AND the master
 * discovery-rank lever (TDQS). This canary makes three regressions STRUCTURALLY IMPOSSIBLE on
 * every current AND future BAZAAR_ROUTES entry (it iterates the live object, so a newly-added
 * tool is covered automatically — no per-tool maintenance):
 *   1. a hardcoded venue/asset/market COUNT (drift-prone the instant we promote a venue — the
 *      reason the old "17 derivatives venues" copy was de-counted to "major CEX and perp-DEX venues"),
 *   2. advice / recommendation framing (compliance: AlgoVault returns read-only signals, never advice),
 *   3. an internal identifier (wave-ID / outcome WR / Phase-E) leaking into public copy.
 *
 * A bare param domain like "0–100" / "top-N" / "1–100" is NOT a volatile count: the regex is
 * scoped to <number><unit> where unit is a capability count we would grow over time.
 */
import { describe, it, expect } from 'vitest';
import { BAZAAR_ROUTES } from '../src/lib/x402-bazaar.js';

const VOLATILE_COUNT = /\b\d+\+?\s*(derivatives\s+)?(venues?|exchanges?|assets?|markets?)\b/i;
const WINRATE = /\b\d{2}(\.\d+)?\s*%/;
const ADVICE = /\b(advice|recommend|recommendation|portfolio|managed|fund-management|guarantee|should\s+(buy|sell))\b/i;
const INTERNAL_ID = /(\bW\d+\b|OPS-|outcome_return|outcome_price|Phase-?E\b|outcome\s+wr)/i;

describe('BAZAAR_ROUTES descriptions — forward-stability + compliance canary', () => {
  const entries = Object.entries(BAZAAR_ROUTES);

  it('covers every declared route (>=6)', () => {
    expect(entries.length).toBeGreaterThanOrEqual(6);
  });

  for (const [name, spec] of entries) {
    const desc = spec.description;

    it(`${name}: no hardcoded venue/asset/market count (forward-stability)`, () => {
      expect(VOLATILE_COUNT.test(desc), `volatile count in ${name}: "${desc.match(VOLATILE_COUNT)?.[0]}"`).toBe(false);
      expect(WINRATE.test(desc), `baked win-rate % in ${name}: "${desc.match(WINRATE)?.[0]}"`).toBe(false);
    });

    it(`${name}: no advice/recommendation framing (compliance)`, () => {
      expect(ADVICE.test(desc), `advice token in ${name}: "${desc.match(ADVICE)?.[0]}"`).toBe(false);
    });

    it(`${name}: no internal identifier leak`, () => {
      expect(INTERNAL_ID.test(desc), `internal identifier in ${name}: "${desc.match(INTERNAL_ID)?.[0]}"`).toBe(false);
    });
  }
});

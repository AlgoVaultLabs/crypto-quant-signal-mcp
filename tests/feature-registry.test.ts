/**
 * FEATURE-REGISTRY-SOT-W1 CH1 — the registry reproduces CURRENT reality EXACTLY.
 * (a) name ∪ aliases == live tools/list (9). (b) x402 basePriceUsd for the 3 priced
 * tools == current TOOL_PRICING. (c) projectCapabilities() emits ZERO internal fields.
 */
import { describe, it, expect } from 'vitest';
import {
  FEATURE_REGISTRY,
  allToolNames,
  getFeature,
  projectCapabilities,
} from '../src/lib/feature-registry.js';
import { TOOL_PRICING } from '../src/lib/x402.js';
import { RANK_BY_VALUES } from '../src/lib/rank-constants.js';

// The DECLARED tool set (name ∪ aliases): 9 canonical + the get_trade_signal alias.
// DEV-TRACK-RECORD-TOOL-PARITY-W1 CH2 added `get_track_record` (9 → 10 declared, 7 → 8 on the
// live tools/list — the two equity tools stay flag-gated OFF; see equity-tools-dark-retire).
const LIVE_TOOLS = [
  'get_trade_call', 'get_trade_signal', 'get_market_regime', 'scan_funding_arb',
  'scan_trade_calls', 'get_equity_call', 'get_equity_regime', 'chat_knowledge', 'search_knowledge',
  'get_track_record',
].sort();

// Price-key tolerant of CH3's re-keying (alias-keyed today → canonical after CH3).
const price = (canonical: string, alias?: string): number | undefined =>
  (TOOL_PRICING as Record<string, number>)[canonical] ??
  (alias ? (TOOL_PRICING as Record<string, number>)[alias] : undefined);

describe('FEATURE-REGISTRY-SOT-W1 CH1 — registry == current reality', () => {
  it('(a) name ∪ aliases == the declared tool set (10 names, alias included)', () => {
    expect([...allToolNames()].sort()).toEqual(LIVE_TOOLS);
  });

  it('(b) x402 basePriceUsd for the 3 priced tools == current TOOL_PRICING', () => {
    expect(getFeature('get_trade_call')!.x402!.basePriceUsd).toBe(price('get_trade_call', 'get_trade_signal'));
    expect(getFeature('get_trade_signal')!.x402!.basePriceUsd).toBe(price('get_trade_call', 'get_trade_signal'));
    expect(getFeature('scan_funding_arb')!.x402!.basePriceUsd).toBe(price('scan_funding_arb'));
    expect(getFeature('get_market_regime')!.x402!.basePriceUsd).toBe(price('get_market_regime'));
    // Concrete pinning (no value drift this wave):
    expect(getFeature('get_trade_call')!.x402!.basePriceUsd).toBe(0.02);
    expect(getFeature('scan_funding_arb')!.x402!.basePriceUsd).toBe(0.01);
    expect(getFeature('get_market_regime')!.x402!.basePriceUsd).toBe(0.02);
  });

  it('(b2) chat/search stay x402:null; scanner + equity now priced $0.02 (OPS-X402-PRICING-EXPANSION-W1)', () => {
    for (const n of ['chat_knowledge', 'search_knowledge']) {
      expect(getFeature(n)!.x402).toBeNull();
    }
    for (const n of ['scan_trade_calls', 'get_equity_call', 'get_equity_regime']) {
      expect(getFeature(n)!.x402?.basePriceUsd).toBe(0.02);
    }
  });

  it('(c) projectCapabilities() emits ZERO internal fields', () => {
    const json = JSON.stringify(projectCapabilities());
    expect(json).not.toMatch(/outcome_|eligible_non_hold|descriptionRef|trackCall|owner_key|ipHash/);
  });

  it('(c2) projection lists all 10 callable names with public fields only', () => {
    const proj = projectCapabilities().tools;
    expect(proj.map((t) => t.name).sort()).toEqual(LIVE_TOOLS);
    const BASE = ['canonical', 'channels', 'description', 'enabled', 'name', 'quota', 'x402'];
    for (const t of proj) {
      for (const k of BASE) expect(t).toHaveProperty(k);
      // `lenses` is the ONLY allowed additive public key (SCAN-RANKBY-W1); nothing else.
      const extra = Object.keys(t).filter((k) => !BASE.includes(k));
      expect(extra.every((k) => k === 'lenses')).toBe(true);
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  it('(c3) SCAN-RANKBY-W1: scan_trade_calls advertises the rankBy lens set; nothing else does', () => {
    const proj = projectCapabilities().tools;
    const scan = proj.find((t) => t.name === 'scan_trade_calls')!;
    expect(scan.lenses?.param).toBe('rankBy');
    // Drift-proof: the projection IS the registry's single source (W2 added 'volatility').
    expect(scan.lenses?.values).toEqual([...RANK_BY_VALUES]);
    expect(scan.lenses?.values).toContain('volatility');
    expect(scan.lenses?.default).toBe('oi');
    expect(scan.lenses?.aliases.nfr).toBe('funding_negative');
    expect(scan.lenses?.aliases.atr).toBe('volatility'); // SCAN-RANKBY-W2
    expect(proj.filter((t) => t.lenses).map((t) => t.name)).toEqual(['scan_trade_calls']);
  });

  it('getFeature resolves the alias → canonical (closes the canonical-key gap)', () => {
    expect(getFeature('get_trade_signal')!.name).toBe('get_trade_call');
    expect(getFeature('get_trade_call')!.name).toBe('get_trade_call');
    expect(getFeature('nonexistent_tool')).toBeUndefined();
  });

  it('registry has 9 canonical specs; chat/search/track-record are rate-limited (not call-metered)', () => {
    expect(FEATURE_REGISTRY).toHaveLength(9);
    expect(getFeature('chat_knowledge')!.quota.unit).toBe('rate-limited');
    expect(getFeature('search_knowledge')!.quota.unit).toBe('rate-limited');
    // DEV-TRACK-RECORD-TOOL-PARITY-W1: get_track_record reads a cached aggregate and calls no
    // exchange, so it is unmetered like the knowledge tools. `call-class.ts` DERIVES
    // UNMETERED_TOOLS from this field, so asserting it here is asserting the billing axis.
    expect(getFeature('get_track_record')!.quota.unit).toBe('rate-limited');
    expect(getFeature('get_track_record')!.x402).toBeNull();
    expect(getFeature('get_track_record')!.publicListing).toBe(false);
  });
});

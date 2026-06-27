/**
 * SCAN-RANKBY-W1 CH1 — pure rankBy constants + resolver + funding annualization.
 */
import { describe, it, expect } from 'vitest';
import {
  RANK_BY_VALUES,
  RANK_BY_ALIASES,
  rankByTokens,
  resolveRankBy,
  isFundingRank,
  rankDescending,
  annualizeFunding,
} from '../../src/lib/rank-constants.js';

describe('resolveRankBy — the single alias map', () => {
  it('passes canonical values through', () => {
    for (const v of RANK_BY_VALUES) expect(resolveRankBy(v)).toBe(v);
  });

  it('resolves every alias to its canonical', () => {
    expect(resolveRankBy('vol')).toBe('volume');
    expect(resolveRankBy('gain')).toBe('gainers');
    expect(resolveRankBy('lose')).toBe('losers');
    expect(resolveRankBy('move')).toBe('movers');
    expect(resolveRankBy('pfr')).toBe('funding_positive');
    expect(resolveRankBy('nfr')).toBe('funding_negative');
    expect(resolveRankBy('oi')).toBe('oi');
  });

  it('is case-insensitive + trims whitespace', () => {
    expect(resolveRankBy('  NFR ')).toBe('funding_negative');
    expect(resolveRankBy('Volume')).toBe('volume');
    expect(resolveRankBy('FUNDING_POSITIVE')).toBe('funding_positive');
  });

  it('returns null for unknown / empty / nullish (caller default-denies)', () => {
    expect(resolveRankBy('garbage')).toBeNull();
    expect(resolveRankBy('')).toBeNull();
    expect(resolveRankBy('   ')).toBeNull();
    expect(resolveRankBy(undefined)).toBeNull();
    expect(resolveRankBy(null)).toBeNull();
    expect(resolveRankBy('funding')).toBeNull(); // not a valid token on its own
  });
});

describe('rankByTokens — advertised set (canonical + distinct aliases)', () => {
  it('includes all 7 canonical + 6 distinct aliases (oi alias == canonical)', () => {
    const tokens = rankByTokens();
    for (const v of RANK_BY_VALUES) expect(tokens).toContain(v);
    for (const alias of Object.keys(RANK_BY_ALIASES)) {
      if (!RANK_BY_VALUES.includes(alias as never)) expect(tokens).toContain(alias);
    }
    expect(tokens.length).toBe(7 + 6); // 7 canonical + vol/gain/lose/move/pfr/nfr
    expect(new Set(tokens).size).toBe(tokens.length); // no dupes
  });

  it('every advertised token resolves to a canonical', () => {
    for (const t of rankByTokens()) expect(resolveRankBy(t)).not.toBeNull();
  });
});

describe('isFundingRank / rankDescending', () => {
  it('flags only the two funding lenses', () => {
    expect(isFundingRank('funding_positive')).toBe(true);
    expect(isFundingRank('funding_negative')).toBe(true);
    expect(isFundingRank('oi')).toBe(false);
    expect(isFundingRank('gainers')).toBe(false);
  });
  it('losers + funding_negative ascend; the rest descend', () => {
    expect(rankDescending('losers')).toBe(false);
    expect(rankDescending('funding_negative')).toBe(false);
    expect(rankDescending('gainers')).toBe(true);
    expect(rankDescending('funding_positive')).toBe(true);
    expect(rankDescending('oi')).toBe(true);
  });
});

describe('annualizeFunding — APR = rate × (24/interval) × 365', () => {
  it('8h interval: 0.01%/8h ≈ 10.95% APR', () => {
    expect(annualizeFunding(0.0001, 8)).toBeCloseTo(0.1095, 6);
  });
  it('Hyperliquid HOURLY (1h): ×8760, NOT ×1095', () => {
    expect(annualizeFunding(0.0001, 1)).toBeCloseTo(0.876, 6); // 0.0001 × 24 × 365
    // 8× the 8h figure — the exact landmine the spec would have hit.
    expect(annualizeFunding(0.0001, 1)).toBeCloseTo(annualizeFunding(0.0001, 8)! * 8, 6);
  });
  it('negative rate annualizes signed', () => {
    expect(annualizeFunding(-0.0002, 8)).toBeCloseTo(-0.219, 6);
  });
  it('returns null when interval is unknown/invalid (never guesses)', () => {
    expect(annualizeFunding(0.0001, null)).toBeNull();
    expect(annualizeFunding(0.0001, undefined)).toBeNull();
    expect(annualizeFunding(0.0001, 0)).toBeNull();
    expect(annualizeFunding(0.0001, -8)).toBeNull();
    expect(annualizeFunding(0.0001, NaN)).toBeNull();
  });
  it('returns null on a non-finite rate', () => {
    expect(annualizeFunding(NaN, 8)).toBeNull();
    expect(annualizeFunding(Infinity, 8)).toBeNull();
  });
});

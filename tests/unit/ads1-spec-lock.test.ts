// EDGE-ADS1-SCORECARD-W1-V2 CH2 (D1, D12, D24) — the ADS-1 constants' single source and its locks.
//
//  * TS == JSON: `ops/ads1-spec.json` is the byte-exact output of `serializeAds1Spec()` — the file the
//    autonomous-optimizer repo vendors with a pinned sha256. Regenerate with
//    `npm run build && node scripts/emit-ads1-spec.mjs --write`.
//  * The barrier literals are ONE set: ads1 imports them; the primary equals FRESHNESS_BARRIER_SPEC; the
//    hold labeler's own copy (a file this wave does not touch) still names the same three strings.
//  * The power floors are DERIVED here from the normal quantiles, not trusted as literals.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  BARRIER_SPECS,
  BANDS,
  COST_TIERS_PCT,
  FLAT_FLOOR_PCT,
  N_EFF_FLOOR,
  PRIMARY_BARRIER_SPEC,
  T_DIAG_END,
  T_FLIP,
  Z_ONE_SIDED,
  serializeAds1Spec,
} from '../../src/scripts/ads1/spec.js';
import { FRESHNESS_BARRIER_SPEC } from '../../src/lib/venue-slo-tiers.js';
import { ROUND_TRIP_COST_PCT, FLOOR_PCT } from '../../src/scripts/directional-labeler.js';

const ROOT = path.resolve(__dirname, '../..');

describe('ADS-1 spec lock', () => {
  it('ops/ads1-spec.json is byte-identical to serializeAds1Spec()', () => {
    expect(readFileSync(path.join(ROOT, 'ops', 'ads1-spec.json'), 'utf8')).toBe(serializeAds1Spec());
  });

  it('the JSON carries no "name" / "version" key (the system-map gate reads those as manifest edits)', () => {
    expect(serializeAds1Spec()).not.toMatch(/"(name|version)":/);
  });

  it('one barrier literal set: primary == FRESHNESS_BARRIER_SPEC == BARRIER_SPECS[0]', () => {
    expect(PRIMARY_BARRIER_SPEC).toBe(FRESHNESS_BARRIER_SPEC);
    expect(BARRIER_SPECS[0].spec).toBe(FRESHNESS_BARRIER_SPEC);
    expect(BARRIER_SPECS.map((b) => b.spec)).toEqual(['tau1.0-floor0.30-v1', 'tau0.5-floor0.30-v1', 'tau2.0-floor0.30-v1']);
  });

  it("the hold labeler's untouched copy names the same three strings", () => {
    const src = readFileSync(path.join(ROOT, 'src/scripts/backfill-hold-decision-labels.ts'), 'utf8');
    const found = [...src.matchAll(/'(tau\d\.\d-floor0\.30-v1)'/g)].map((m) => m[1]);
    expect(new Set(found)).toEqual(new Set(BARRIER_SPECS.map((b) => b.spec)));
  });

  it('the label writer uses the shared set, not a retyped literal', () => {
    const src = readFileSync(path.join(ROOT, 'src/scripts/backfill-directional-labels.ts'), 'utf8');
    expect(src).toMatch(/const ALL_SPECS = BARRIER_SPECS;/);
    expect(src).not.toMatch(/spec: 'tau\d\.\d-floor0\.30-v1'/);
  });

  it('derived constants: FLAT floor = the label floor; taker = ROUND_TRIP_COST_PCT; T_FLIP < T_DIAG_END', () => {
    expect(FLAT_FLOOR_PCT).toBe(FLOOR_PCT);
    expect(FLAT_FLOOR_PCT).toBe(0.3);
    expect(COST_TIERS_PCT.taker).toBe(ROUND_TRIP_COST_PCT);
    expect(T_FLIP).toBe(1788169595);
    expect(T_DIAG_END).toBe(1790402400);
    expect(T_FLIP).toBeLessThan(T_DIAG_END);
  });

  it('power floors are the ceilings of the one-sided α=.05, power=.8 sample sizes (D12)', () => {
    const zBeta = 0.8416212335729143; // Φ⁻¹(0.80)
    const n = (p1: number) => ((Z_ONE_SIDED * 0.5 + zBeta * Math.sqrt(p1 * (1 - p1))) / (p1 - 0.5)) ** 2;
    expect(n(0.52)).toBeCloseTo(3862.005, 2);
    expect(Math.ceil(n(0.52))).toBe(N_EFF_FLOOR);
    expect(Math.ceil(n(0.55))).toBe(BANDS.auditMinNeff);
  });
});

/**
 * OPS-LABEL-FRESHNESS-W1 R2 — venue SLO-tier SoT + single-derivation lock.
 *
 * The H1 root cause was the scheduler (labeler) and the monitor (canary) optimising /
 * measuring DIFFERENT objectives. These tests pin the ONE tier SoT (src/lib/venue-slo-tiers.ts)
 * and lock its emitted mirror (ops/monitoring/venue-slo-tiers.json — the file the Python
 * freshness canary reads on the host) byte-for-byte, so the labeler's major-set can never
 * drift from the canary's. This IS the "scheduler major-set == canary major-set" AC.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FRESHNESS_BARRIER_SPEC,
  LONGTAIL_SLO_HOURS,
  MAJOR_SLO_HOURS,
  MAJOR_VENUES,
  isMajor,
  serializeTierSot,
  sloHoursFor,
  tierOf,
} from '../../src/lib/venue-slo-tiers.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIRROR = path.join(REPO, 'ops', 'monitoring', 'venue-slo-tiers.json');

describe('venue-slo-tiers SoT', () => {
  it('classifies majors vs long-tail and returns each venue’s own tier SLO', () => {
    expect(isMajor('BINANCE')).toBe(true);
    expect(isMajor('MEXC')).toBe(false);
    expect(tierOf('OKX')).toBe('major');
    expect(tierOf('ASTER')).toBe('long-tail');
    expect(sloHoursFor('HL')).toBe(MAJOR_SLO_HOURS);
    expect(sloHoursFor('BINGX')).toBe(LONGTAIL_SLO_HOURS);
  });

  it('a new/unknown venue defaults to the long-tail SLO (never silently a major)', () => {
    expect(isMajor('SOMENEWVENUE')).toBe(false);
    expect(sloHoursFor('SOMENEWVENUE')).toBe(LONGTAIL_SLO_HOURS);
  });

  it('the committed mirror equals serializeTierSot() byte-for-byte (regen with emit-venue-slo-tiers.mjs)', () => {
    expect(readFileSync(MIRROR, 'utf8')).toBe(serializeTierSot());
  });

  it('the mirror the canary reads carries the SAME major set + SLOs + barrier spec (single-derivation)', () => {
    const mirror = JSON.parse(readFileSync(MIRROR, 'utf8'));
    expect(mirror.majors.slice().sort()).toEqual([...MAJOR_VENUES].sort());
    expect(mirror.major_slo_hours).toBe(MAJOR_SLO_HOURS);
    expect(mirror.longtail_slo_hours).toBe(LONGTAIL_SLO_HOURS);
    expect(mirror.barrier_spec).toBe(FRESHNESS_BARRIER_SPEC);
  });
});

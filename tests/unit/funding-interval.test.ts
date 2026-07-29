import { describe, it, expect } from 'vitest';
import { annualizeFunding } from '../../src/lib/rank-constants.js';
import { FUNDING_VENUE_META } from '../../src/lib/funding-venues.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const src = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/**
 * OPS-AUDIT-REMEDIATION-HIGH-W1 · Ch3 · SEC-06.
 *
 * scan_funding_arb annualized EVERY contract at its venue's single constant interval — 8h for
 * Gate and KuCoin. Live-probed 2026-07-29 that assumption is wrong for most of their books:
 *
 *   Gate    860 contracts — 520x 8h, 336x 4h, 4x 1h   → 39.5% non-8h
 *   KuCoin  675 contracts — 256x 8h, 413x 4h, 5x 1h   → 62.1% non-8h  (+1 publishing 0)
 *
 * A 4h contract annualized as 8h understates that leg ~2x; 1h understates ~8x. Because only ONE
 * leg is mis-scaled, the spread's SIGN can flip — the tool then names the wrong long/short pair
 * on a paid, Merkle-anchored surface.
 */

/** The engine's own selection rule, extracted so the test pins BEHAVIOUR, not source text. */
function resolveInterval(rowInterval: number | undefined, venueDefault: number): number | null {
  if (rowInterval !== undefined && !(Number.isFinite(rowInterval) && rowInterval > 0)) return null; // row self-skips
  return rowInterval ?? venueDefault;
}

describe('per-contract funding interval (SEC-06)', () => {
  it('a 4h contract annualizes ~2x what the 8h assumption produced', () => {
    const rate = 0.00005; // +5e-05, the audit's WIF example
    const wrong = annualizeFunding(rate, 8);   // pre-fix: venue constant
    const right = annualizeFunding(rate, 4);   // post-fix: the contract's real period
    expect(wrong).not.toBeNull();
    expect(right).not.toBeNull();
    expect(right! / wrong!).toBeCloseTo(2, 6);
    // The audit's arithmetic: 5e-05 * (24/8) * 365 = 5.475%, true 4h value 10.95%.
    // annualizeFunding returns a FRACTION (0.05475), not a percentage — assert in its own unit.
    expect(wrong!).toBeCloseTo(0.05475, 6);
    expect(right!).toBeCloseTo(0.1095, 6);
  });

  it('a 1h contract annualizes ~8x the 8h assumption', () => {
    const rate = 0.00005;
    expect(annualizeFunding(rate, 1)! / annualizeFunding(rate, 8)!).toBeCloseTo(8, 6);
  });

  it('prefers the row interval over the venue constant', () => {
    expect(resolveInterval(4, 8)).toBe(4);
    expect(resolveInterval(1, 8)).toBe(1);
  });

  it('falls back to the venue DECLARED cadence when the row publishes none', () => {
    // Aster exposes only nextFundingTime — no derivable per-contract period. Its META entry is a
    // published fixed cadence, so falling back is a declared constant, not a guess.
    expect(resolveInterval(undefined, FUNDING_VENUE_META.AsterPerp.intervalHours)).toBe(8);
    expect(resolveInterval(undefined, FUNDING_VENUE_META.HlPerp.intervalHours)).toBe(1);
  });

  it('self-skips a row whose published interval is INVALID rather than inheriting 8h', () => {
    // KuCoin live-publishes one contract with granularity 0. Pre-fix it silently annualized at 8h.
    for (const bad of [0, -4, NaN, Infinity]) {
      expect(resolveInterval(bad, 8)).toBeNull();
    }
  });

  it('a sign INVERSION is possible under the old rule and gone under the new one', () => {
    // Two legs, same coin: an 8h leg at +8e-05 vs a 4h leg at +5e-05.
    const legA = { rate: 0.00008, interval: 8 };
    const legB = { rate: 0.00005, interval: 4 };
    // Pre-fix both were annualized at 8h → A looks richer than B.
    const preA = annualizeFunding(legA.rate, 8)!;
    const preB = annualizeFunding(legB.rate, 8)!;
    expect(preA).toBeGreaterThan(preB);
    // Post-fix, B's real 4h period makes it the richer leg — the spread flips direction.
    const postA = annualizeFunding(legA.rate, legA.interval)!;
    const postB = annualizeFunding(legB.rate, legB.interval)!;
    expect(postB).toBeGreaterThan(postA);
    expect(Math.sign(preA - preB)).not.toBe(Math.sign(postA - postB));
  });

  it('the public funding_venue_count is unchanged — no venue was dropped', () => {
    // The generator fix is a per-ROW skip, deliberately NOT a per-VENUE removal: dropping Aster
    // would move funding_venue_count (a live public SoT field) from 7, which is out of scope.
    expect(Object.keys(FUNDING_VENUE_META).length).toBe(7);
  });
});

describe('adapters emit the interval they actually publish', () => {
  it('Gate reads funding_interval (seconds)', () => {
    expect(src('src/lib/adapters/gateio.ts')).toContain('c.funding_interval / 3600');
  });
  it('KuCoin reads fundingRateGranularity (milliseconds)', () => {
    expect(src('src/lib/adapters/kucoin.ts')).toContain('c.fundingRateGranularity / 3_600_000');
  });
  it('OKX derives the period from its two funding stamps', () => {
    const okx = src('src/lib/adapters/okx.ts');
    expect(okx).toContain('okxIntervalHours(fr.fundingTime, fr.nextFundingTime)');
    // Guard the divide-by-zero / implausible-gap cases.
    expect(okx).toContain('b <= a) return undefined');
  });
  it('the consumer prefers the row interval', () => {
    expect(src('src/tools/scan-funding-arb.ts')).toContain('rowInterval ?? meta.intervalHours');
  });
});

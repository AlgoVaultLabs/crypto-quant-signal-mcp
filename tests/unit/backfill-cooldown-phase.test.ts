/**
 * backfill-cooldown-phase.test.ts — OPS-VENUE-MARKET-CLOSED-W1 CH1: the backfill's retry schedule must WALK the clock.
 *
 * A maxed-out row is retried once per `BACKFILL_ATTEMPT_COOLDOWN_S`. At 86,400 s every retry landed at the same UTC
 * hour as the failure, so a market closed at that hour (BingX's session-gated NC* markets, open ~13:30–20:00Z on
 * weekdays) was retried closed forever: R0 measured 158 of 162 such rows last attempted outside the session. The
 * property below is TIME OF DAY only — `retryPhaseCoverage` is test-local on purpose, so the production constant is
 * the only production input. A second, calendar property pins the weekend worst case the cooldown comment quotes.
 */
import { describe, it, expect } from 'vitest';
import { BACKFILL_ATTEMPT_COOLDOWN_S } from '../../src/lib/performance-db.js';

const H = 3_600;
const DAY = 86_400;
const WEEK = 7 * DAY;

/**
 * Do `retries` attempts spaced `cooldownS` apart, starting at phase `phiS`, hit EVERY time-of-day window of width
 * `windowS`? A half-open window avoids every phase iff some circular gap between consecutive phases exceeds it, so
 * the answer is `maxGap <= windowS`. PURE.
 */
function retryPhaseCoverage(cooldownS: number, retries: number, windowS: number, phiS: number): { covered: boolean; maxGapS: number; phases: number[] } {
  const phases = [...new Set(Array.from({ length: retries }, (_, k) => (((phiS + k * cooldownS) % DAY) + DAY) % DAY))].sort((a, b) => a - b);
  let maxGapS = 0;
  for (let i = 0; i < phases.length; i++) {
    const next = i + 1 < phases.length ? phases[i + 1] : phases[0] + DAY;
    maxGapS = Math.max(maxGapS, next - phases[i]);
  }
  return { covered: maxGapS <= windowS, maxGapS, phases };
}

/** A weekday 13:30–20:00Z session (the US cash session BingX's NC* markets follow). Epoch 0 was a Thursday. */
function inSession(tS: number): boolean {
  const t = ((tS % WEEK) + WEEK) % WEEK;
  const dow = (Math.floor(t / DAY) + 3) % 7; // 0 = Monday
  const tod = t % DAY;
  return dow < 5 && tod >= 13.5 * H && tod < 20 * H;
}
/** The first retry k ≥ 1 that lands inside the session, or null within `cap`. */
function retriesToSession(cooldownS: number, phiS: number, cap = 64): number | null {
  for (let k = 1; k <= cap; k++) if (inSession(phiS + k * cooldownS)) return k;
  return null;
}

describe('the retry schedule walks the clock (time of day)', () => {
  it('the live cooldown is 18 h', () => {
    expect(BACKFILL_ATTEMPT_COOLDOWN_S).toBe(64_800);
  });

  it('4 retries of the live cooldown hit every time-of-day window ≥ 6 h, from every phase', () => {
    for (let phi = 0; phi < DAY; phi += 600) {
      const r = retryPhaseCoverage(BACKFILL_ATTEMPT_COOLDOWN_S, 4, 6 * H, phi);
      expect(r.covered, `phase ${phi}s: max gap ${r.maxGapS}s`).toBe(true);
    }
    // the phases themselves: φ, φ−6 h, φ+12 h, φ+6 h
    expect(retryPhaseCoverage(BACKFILL_ATTEMPT_COOLDOWN_S, 4, 6 * H, 0).phases).toEqual([0, 6 * H, 12 * H, 18 * H]);
  });

  it('THE BREAK, recorded: at 86,400 every retry is the same phase, so a 6 h window is missed forever', () => {
    const r = retryPhaseCoverage(86_400, 4, 6 * H, 0);
    expect(r.phases).toEqual([0]);
    expect(r.maxGapS).toBe(DAY);
    expect(r.covered).toBe(false);
    // and no number of retries rescues it
    expect(retryPhaseCoverage(86_400, 1000, 6 * H, 0).covered).toBe(false);
  });
});

describe('the retry schedule reaches a weekday session (calendar)', () => {
  it('from every 10-minute phase of the week, the live cooldown lands in session within 8 retries', () => {
    let worst = 0;
    for (let phi = 0; phi < WEEK; phi += 600) {
      const k = retriesToSession(BACKFILL_ATTEMPT_COOLDOWN_S, phi);
      expect(k, `phase ${phi}s never lands in session`).not.toBeNull();
      worst = Math.max(worst, k!);
    }
    expect(worst).toBeLessThanOrEqual(8);
  });

  it('THE BREAK, recorded: at 86,400 most phases of the week never land in session at all', () => {
    let never = 0;
    for (let phi = 0; phi < WEEK; phi += 600) if (retriesToSession(86_400, phi) === null) never++;
    expect(never).toBe(735); // of 1,008 phases — every phase outside 13:30–20:00Z, measured at authoring
  });
});

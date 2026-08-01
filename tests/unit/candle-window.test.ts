/**
 * SIGNAL-CLOSEDBAR-SHADOW-W1 CH1 — contract tests for the confirmed-bar primitive,
 * plus the interval-table ↔ capabilities-SoT canary.
 *
 * ── Note on the canary's SHAPE (deviation from the literal AC2 wording) ──
 * AC2 asks for `Object.keys(TF_INTERVAL_MS)` deep-equals `capabilities.TIMEFRAMES`.
 * `TF_INTERVAL_MS` is **module-private** in `src/lib/candle-guard.ts` (declared
 * `const`, not `export const`), and this chapter's AC5 + verification gate require
 * `candle-guard.ts` to be BYTE-UNCHANGED. Exporting it to satisfy the literal form
 * would fail the chapter's own gate.
 *
 * So the canary is expressed BEHAVIOURALLY over the exported accessor, which covers
 * the exact bug class AC2 names — "adding a timeframe to the capabilities SoT without
 * an interval entry currently degrades SILENTLY to the 1h fallback":
 *
 *   forward  (load-bearing, fully covered): every capabilities.TIMEFRAMES entry MUST
 *            resolve to a non-null interval.
 *   reverse  (an interval key absent from TIMEFRAMES): NOT coverable while the table
 *            is private and the file is frozen. Deliberately left to the follow-up
 *            that unfreezes `candle-guard.ts`; recorded here so it is not mistaken
 *            for an oversight.
 */
import { describe, it, expect } from 'vitest';
import { TIMEFRAMES } from '../../src/lib/capabilities.js';
import { intervalMsFor } from '../../src/lib/candle-guard.js';
import {
  splitCandleWindow,
  CLOCK_SKEW_TOLERANCE_MS,
  type CandleWindow,
} from '../../src/lib/candle-window.js';

const HOUR = 3_600_000;
/** Minimal structural bar — `splitCandleWindow` only requires `time`. */
const bar = (time: number, volume = 1) => ({ time, volume });

describe('interval-table ↔ capabilities-SoT canary (AC2)', () => {
  it('every capabilities.TIMEFRAMES entry has an interval-table entry', () => {
    const missing = TIMEFRAMES.filter(tf => intervalMsFor(tf) === null);
    expect(
      missing,
      `Timeframes present in capabilities.TIMEFRAMES but MISSING from candle-guard's ` +
        `TF_INTERVAL_MS: [${missing.join(', ')}]. ` +
        `capabilities.TIMEFRAMES = [${TIMEFRAMES.join(', ')}]. ` +
        `A timeframe added to the capabilities SoT without an interval entry degrades ` +
        `SILENTLY to the 1h fallback at the get-trade-call call site.`,
    ).toEqual([]);
  });

  it('covers all 11 SUPPORTED timeframes, not merely the 9 currently seeded', () => {
    expect([...TIMEFRAMES].sort()).toEqual(
      ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d'].sort(),
    );
  });

  it('an unknown timeframe returns null — the null IS the contract, not a default', () => {
    expect(intervalMsFor('7h')).toBeNull();
    expect(intervalMsFor('')).toBeNull();
    // Guards the Q1 ratification: the fallback is CALLER policy (rank-metrics uses
    // `?? 900_000`, get-trade-call uses `?? 3_600_000`). A default pushed into the
    // shared accessor would silently change one of them.
    expect(intervalMsFor('1h')).toBe(HOUR);
  });
});

describe('splitCandleWindow — empty input', () => {
  it('returns an empty window without throwing', () => {
    const w = splitCandleWindow([], HOUR, 1_000_000);
    expect(w).toEqual({ closed: [], partial: null, elapsedFraction: null });
  });
});

describe('splitCandleWindow — no partial (venue omits the in-progress bar)', () => {
  it('keeps the FULL array and never drops a genuinely-closed newest bar', () => {
    const candles = [bar(0), bar(HOUR), bar(2 * HOUR)];
    // Newest bar opened at 2h and closed at 3h; now is exactly 3h.
    const w = splitCandleWindow(candles, HOUR, 3 * HOUR);
    expect(w.partial).toBeNull();
    expect(w.elapsedFraction).toBeNull();
    expect(w.closed).toHaveLength(3);
    expect(w.closed[w.closed.length - 1].time).toBe(2 * HOUR);
  });

  it('returns a copy, so mutating the result cannot corrupt the caller array', () => {
    const candles = [bar(0), bar(HOUR)];
    const w = splitCandleWindow(candles, HOUR, 2 * HOUR);
    w.closed.push(bar(99));
    expect(candles).toHaveLength(2);
  });
});

describe('splitCandleWindow — partial present', () => {
  it('excludes the in-progress bar from `closed` and reports elapsedFraction', () => {
    const candles = [bar(0), bar(HOUR), bar(2 * HOUR)];
    // 30 minutes into the 2h bar.
    const w = splitCandleWindow(candles, HOUR, 2 * HOUR + HOUR / 2);
    expect(w.partial?.time).toBe(2 * HOUR);
    expect(w.closed).toHaveLength(2);
    expect(w.closed.at(-1)?.time).toBe(HOUR);
    expect(w.elapsedFraction).toBeCloseTo(0.5, 10);
  });

  it('is the unit fix: `closed` volume is a complete-bar integral', () => {
    // The partial bar carries a fraction of an hour's volume; including it in a mean
    // of complete bars is the mismatch this primitive exists to prevent.
    const candles = [bar(0, 100), bar(HOUR, 100), bar(2 * HOUR, 7)];
    const w = splitCandleWindow(candles, HOUR, 2 * HOUR + HOUR / 10);
    const closedVols = w.closed.map(c => c.volume);
    expect(closedVols).toEqual([100, 100]);
    expect(w.partial?.volume).toBe(7);
  });
});

describe('splitCandleWindow — clock skew', () => {
  it('treats a bar closing within CLOCK_SKEW_TOLERANCE_MS as CLOSED', () => {
    expect(CLOCK_SKEW_TOLERANCE_MS).toBe(2_000);
    const candles = [bar(0), bar(HOUR)];
    // Bar closes at 2h; our clock reads 1.5s early — inside tolerance.
    const w = splitCandleWindow(candles, HOUR, 2 * HOUR - 1_500);
    expect(w.partial).toBeNull();
    expect(w.closed).toHaveLength(2);
  });

  it('leaves a bar beyond the tolerance as PARTIAL', () => {
    const candles = [bar(0), bar(HOUR)];
    // 3s early — outside the 2s tolerance.
    const w = splitCandleWindow(candles, HOUR, 2 * HOUR - 3_000);
    expect(w.partial?.time).toBe(HOUR);
    expect(w.closed).toHaveLength(1);
  });
});

describe('splitCandleWindow — descending input', () => {
  it('throws rather than silently mis-splitting', () => {
    const descending = [bar(2 * HOUR), bar(HOUR), bar(0)];
    expect(() => splitCandleWindow(descending, HOUR, 3 * HOUR)).toThrow(/ascending/i);
  });

  it('tolerates equal timestamps (not descending)', () => {
    const flat = [bar(HOUR), bar(HOUR)];
    expect(() => splitCandleWindow(flat, HOUR, 5 * HOUR)).not.toThrow();
  });
});

describe('splitCandleWindow — elapsedFraction clamping', () => {
  it('clamps to 0 when the newest bar opens in the future (skewed venue clock)', () => {
    const candles = [bar(2 * HOUR)];
    const w = splitCandleWindow(candles, HOUR, 2 * HOUR - 200_000);
    expect(w.partial?.time).toBe(2 * HOUR);
    expect(w.elapsedFraction).toBe(0);
  });

  it('never reports a fraction outside [0,1]', () => {
    const nows = [0, HOUR / 4, HOUR / 2, HOUR - 1, 2 * HOUR - 2_001];
    for (const now of nows) {
      const w: CandleWindow<{ time: number; volume: number }> = splitCandleWindow(
        [bar(HOUR)],
        HOUR,
        now,
      );
      if (w.elapsedFraction !== null) {
        expect(w.elapsedFraction).toBeGreaterThanOrEqual(0);
        expect(w.elapsedFraction).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('splitCandleWindow — invalid interval', () => {
  it('throws on a non-positive or non-finite intervalMs', () => {
    expect(() => splitCandleWindow([bar(0)], 0, 1)).toThrow(/positive finite/i);
    expect(() => splitCandleWindow([bar(0)], -HOUR, 1)).toThrow(/positive finite/i);
    expect(() => splitCandleWindow([bar(0)], Number.NaN, 1)).toThrow(/positive finite/i);
  });

  it('does not validate the interval for an empty array (empty is always valid)', () => {
    expect(() => splitCandleWindow([], 0, 1)).not.toThrow();
  });
});

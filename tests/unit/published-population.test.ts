/**
 * published-population.test.ts — OPS-SIGNAL-PERSISTENCE-BAND-CAPTURE-W1 R1.
 *
 * Three properties, and the third is the wave's real deliverable.
 *
 *  1. The TS predicate and its SQL projection agree over a fixture matrix. They are two
 *     projections of one rule and the SQL one is the LIVE path in prod
 *     (`PERF_STATS_SQL_PUSHDOWN=1`), so a change to only one is a silent no-op on the published
 *     number — the exact failure `pfe-scoring.ts` records having already happened once.
 *
 *  2. The relocation of `MIN_TRACKABLE_CONFIDENCE` out of `get-trade-call.ts` did not move it.
 *
 *  3. **The predicate value equals the value the PUBLIC disclosure states.** `METHODOLOGY
 *     .signalFilter` is served on `/api/performance-public`, `performance://signal-performance`
 *     and `get_track_record`. Before this wave the disclosure claimed a population the read path
 *     did not enforce; now it enforces exactly what is disclosed. Pinning them against each other
 *     is what makes that un-driftable — change either alone and this fails.
 */
import { describe, it, expect } from 'vitest';
import {
  MIN_TRACKABLE_CONFIDENCE,
  isPublishedPopulation,
  sqlPublishedPopulation,
  SQL_PUBLISHED_POPULATION,
} from '../../src/lib/published-population.js';
import { METHODOLOGY } from '../../src/lib/performance-db.js';

/** Evaluate the SQL projection in JS, the way Postgres would. NULL >= n is NULL ⇒ not matched. */
function sqlMatches(confidence: number | null | undefined): boolean {
  if (confidence == null) return false;
  const m = /^confidence >= (\d+)$/.exec(SQL_PUBLISHED_POPULATION);
  if (!m) throw new Error(`SQL projection is not the expected shape: ${SQL_PUBLISHED_POPULATION}`);
  return confidence >= Number(m[1]);
}

describe('published-population — one rule, two projections', () => {
  it('the TS predicate and the SQL projection agree on every fixture', () => {
    const fixtures: (number | null | undefined)[] = [
      0, 1, 30, 44, 45, 46, 50, 51,          // the band — emitted, never published
      52, 53, 60, 62, 89, 100,               // the published population
      -1, null, undefined,                   // degenerate
    ];
    for (const c of fixtures) {
      expect(
        isPublishedPopulation({ confidence: c }),
        `disagreement at confidence=${String(c)}`,
      ).toBe(sqlMatches(c));
    }
  });

  it('the boundary is inclusive on 52 and exclusive on 51 — on BOTH projections', () => {
    expect(isPublishedPopulation({ confidence: 52 })).toBe(true);
    expect(isPublishedPopulation({ confidence: 51 })).toBe(false);
    expect(sqlMatches(52)).toBe(true);
    expect(sqlMatches(51)).toBe(false);
  });

  it('a NULL/absent confidence default-DENIES rather than defaulting open', () => {
    expect(isPublishedPopulation({ confidence: null })).toBe(false);
    expect(isPublishedPopulation({})).toBe(false);
  });

  it('the aliased form qualifies the column and nothing else', () => {
    expect(sqlPublishedPopulation('s')).toBe(`s.confidence >= ${MIN_TRACKABLE_CONFIDENCE}`);
    expect(sqlPublishedPopulation()).toBe(SQL_PUBLISHED_POPULATION);
  });
});

describe('published-population — the relocation moved no value', () => {
  it('MIN_TRACKABLE_CONFIDENCE is still 52', () => {
    // OPS-SIGNAL-PERSISTENCE-BAND-CAPTURE-W1 moved this constant from
    // `src/tools/get-trade-call.ts` into the leaf so `performance-db.ts` could reach it without
    // an import cycle. A relocation is not a threshold change, and this is what says so.
    // Changing it is a PUBLIC-NUMBER change: it is the disclosed population boundary on three
    // public channels and it decides which rows the on-chain Merkle anchor covers.
    expect(MIN_TRACKABLE_CONFIDENCE).toBe(52);
  });

  it('the SQL projection is built from the constant, not a second literal', () => {
    expect(SQL_PUBLISHED_POPULATION).toBe(`confidence >= ${MIN_TRACKABLE_CONFIDENCE}`);
  });
});

describe('published-population — code and PUBLIC disclosure cannot drift apart', () => {
  it('the enforced predicate equals the confidence the public methodology discloses', () => {
    // THE AC-BLOCKING ASSERTION. `METHODOLOGY.signalFilter` is public copy on three channels.
    // It reads: "Recording gate: non-HOLD calls with confidence >= 52% at signal time.
    //            Aggregation excludes HOLD and applies no further confidence filter."
    //
    // The read-path predicate is set to EXACTLY that disclosed gate, which is why R1 adds no
    // FURTHER restriction and the wording stays byte-true and byte-unchanged. If a future wave
    // moves the predicate without moving the disclosure — or the reverse — this fails, and it
    // fails before the number reaches a customer rather than after.
    const disclosed = /confidence\s*>=\s*(\d+)\s*%/.exec(String(METHODOLOGY.signalFilter));
    expect(disclosed, 'methodology.signalFilter no longer states a confidence floor').not.toBeNull();
    expect(Number(disclosed![1])).toBe(MIN_TRACKABLE_CONFIDENCE);
  });

  it('the disclosure still describes a RECORDING gate, so "no further filter" stays true', () => {
    // The read-path predicate is the recording gate restated, never a tighter one. Were it ever
    // set above MIN_TRACKABLE_CONFIDENCE it WOULD be a further filter, the public sentence would
    // become false, and this pair of assertions is where that gets caught.
    const s = String(METHODOLOGY.signalFilter).toLowerCase();
    expect(s).toContain('recording gate');
    expect(s).toContain('no further confidence filter');
    // Compare the ENFORCED value against the DISCLOSED one — never against the constant both are
    // derived from, which is an assertion that two things which move together still agree, and
    // therefore cannot fail. (Caught by deliberately breaking this file: at 52→55 every other
    // assertion here went red and this one stayed green.)
    const enforced = Number(/(\d+)/.exec(SQL_PUBLISHED_POPULATION)![1]);
    const disclosedFloor = Number(/confidence\s*>=\s*(\d+)\s*%/.exec(String(METHODOLOGY.signalFilter))![1]);
    expect(enforced).toBeLessThanOrEqual(disclosedFloor);
  });
});

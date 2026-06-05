/**
 * tests/unit/monitor-seed-freshness.test.ts — OPS-SEED-ORCHESTRATOR-W1 / CH2
 *
 * Pure-evaluator coverage for the monitor venue-freshness check. The monitor
 * wires the DB query (per-venue MAX(created_at) for promoted venues) + the
 * consecutive-gated alert path; evaluateSeedFreshness is the pure verdict core:
 * fresh / stale / mixed / empty-venue (never pages) / threshold boundary.
 *
 * Audit reference: audits/OPS-SEED-ORCHESTRATOR-W1-endpoint-truth.md
 */

import { describe, it, expect } from 'vitest';
import { evaluateSeedFreshness } from '../../src/scripts/monitor-seed-freshness.js';

const NOW = 1_800_000_000_000; // fixed epoch ms (deterministic — no Date.now())
const minAgo = (m: number): number => NOW - m * 60_000;

describe('evaluateSeedFreshness — venue freshness verdict (R2.1)', () => {
  it('a fresh venue (signal 10 min ago) is not stale', () => {
    const v = evaluateSeedFreshness([{ exchange: 'HL', lastCreatedAtMs: minAgo(10) }], NOW);
    expect(v).toEqual([{ venue: 'HL', staleMin: 10, stale: false }]);
  });

  it('a stale venue (signal 60 min ago) is stale at the default 45-min threshold', () => {
    const v = evaluateSeedFreshness([{ exchange: 'BINANCE', lastCreatedAtMs: minAgo(60) }], NOW);
    expect(v[0].stale).toBe(true);
    expect(v[0].staleMin).toBe(60);
  });

  it('mixed: flags only the stale venues, leaves the fresh ones', () => {
    const v = evaluateSeedFreshness(
      [
        { exchange: 'HL', lastCreatedAtMs: minAgo(5) },
        { exchange: 'BINANCE', lastCreatedAtMs: minAgo(50) },
        { exchange: 'OKX', lastCreatedAtMs: minAgo(2) },
        { exchange: 'BYBIT', lastCreatedAtMs: minAgo(90) },
      ],
      NOW,
    );
    const staleVenues = v.filter((x) => x.stale).map((x) => x.venue).sort();
    expect(staleVenues).toEqual(['BINANCE', 'BYBIT']);
    expect(v).toHaveLength(4); // every venue reported
  });

  it('an empty venue (no signal ever) is reported but NEVER pages', () => {
    const v = evaluateSeedFreshness([{ exchange: 'BITGET', lastCreatedAtMs: null }], NOW);
    expect(v).toEqual([{ venue: 'BITGET', staleMin: -1, stale: false }]);
  });

  it('boundary: 44 min is fresh, 46 min is stale (45-min threshold)', () => {
    expect(evaluateSeedFreshness([{ exchange: 'HL', lastCreatedAtMs: minAgo(44) }], NOW)[0].stale).toBe(false);
    expect(evaluateSeedFreshness([{ exchange: 'HL', lastCreatedAtMs: minAgo(46) }], NOW)[0].stale).toBe(true);
  });

  it('exactly at the threshold (45 min) is stale (>= semantics)', () => {
    expect(evaluateSeedFreshness([{ exchange: 'HL', lastCreatedAtMs: minAgo(45) }], NOW)[0].stale).toBe(true);
  });

  it('honours a custom threshold', () => {
    const rows = [{ exchange: 'HL', lastCreatedAtMs: minAgo(20) }];
    expect(evaluateSeedFreshness(rows, NOW, 15)[0].stale).toBe(true);
    expect(evaluateSeedFreshness(rows, NOW, 30)[0].stale).toBe(false);
  });

  it('empty input → empty verdict (no promoted venues / never pages on nothing)', () => {
    expect(evaluateSeedFreshness([], NOW)).toEqual([]);
  });
});

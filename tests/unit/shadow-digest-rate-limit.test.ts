/**
 * tests/unit/shadow-digest-rate-limit.test.ts — OPS-RATELIMIT-TELEMETRY-DIGEST-W1 R4
 *
 * buildDigest() renders the rate-limit telemetry section from the per-venue query,
 * emits the W{NEXT} trigger lines only when thresholds trip, and stays silent
 * (zeros) otherwise. dbQuery is mocked per-statement.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbQuery = vi.fn();
vi.mock('../../src/lib/performance-db.js', () => ({
  dbQuery: (...args: unknown[]) => dbQuery(...args),
  closeDb: vi.fn(),
}));

import { buildDigest } from '../../src/scripts/shadow-digest-weekly.js';

beforeEach(() => dbQuery.mockReset());

function routeQueries(rateLimitCounts: unknown[], hlWaits: unknown[]) {
  dbQuery.mockImplementation(async (sql: string) => {
    if (/FROM signals/i.test(sql)) return []; // no signal data needed for these assertions
    if (/GROUP BY venue, kind, class/i.test(sql)) return rateLimitCounts;
    if (/wait_ms IS NOT NULL/i.test(sql)) return hlWaits;
    return [];
  });
}

describe('buildDigest — rate-limit telemetry section', () => {
  it('renders the per-venue section + BOTH trigger lines when thresholds trip', async () => {
    routeQueries(
      [
        { venue: 'Aster', kind: 'throw', class: 'batch', n: '4' },          // shadow ≥3 → SHADOW-BUDGET
        { venue: 'Hyperliquid', kind: 'wait', class: 'batch', n: '3' },
      ],
      [{ wait_ms: 25000 }, { wait_ms: 30000 }],                              // HL p95 30s > 20s → HL-WEBSOCKET
    );
    const { text } = await buildDigest();
    expect(text).toContain('⚡ *Rate-limit telemetry (7d)*');
    expect(text).toContain('*Aster*: 4 throws (i:0/b:4)');
    expect(text).toContain('HL batch-wait p95: 30.0s');
    expect(text).toContain('OPS-SHADOW-BUDGET-W{NEXT}');
    // OPS-RATELIMIT-TIDYUP-W1: HL action redirected (OPS-HL-WEBSOCKET cancelled) — the HL
    // trigger still fires but now recommends attribution, not the cancelled structural wave.
    expect(text).toContain('investigate the HL interactive driver');
    expect(text).not.toContain('OPS-HL-WEBSOCKET');
    expect(text).not.toMatch(/-W\d/); // never a literal wave number
  });

  it('renders zeros + NO trigger lines when there are no events', async () => {
    routeQueries([], []);
    const { text } = await buildDigest();
    expect(text).toContain('⚡ *Rate-limit telemetry (7d)*');
    expect(text).toContain('(no rate-limit events — all venues healthy)');
    expect(text).not.toContain('Action: dispatch');
  });

  it('renders the section but NO trigger line when below thresholds (2 shadow throws, 19s p95)', async () => {
    routeQueries(
      [{ venue: 'Aster', kind: 'throw', class: 'batch', n: '2' }, { venue: 'Hyperliquid', kind: 'wait', class: 'batch', n: '1' }],
      [{ wait_ms: 19000 }],
    );
    const { text } = await buildDigest();
    expect(text).toContain('*Aster*: 2 throws');
    expect(text).not.toContain('Action: dispatch');
  });

  it('fail-open: a telemetry query error degrades to a notice, never crashes the digest', async () => {
    dbQuery.mockImplementation(async (sql: string) => {
      if (/rate_limit_events/i.test(sql)) throw new Error('relation "rate_limit_events" does not exist');
      return [];
    });
    const { text } = await buildDigest();
    expect(text).toContain('rate-limit telemetry unavailable');
    expect(text).toContain('SHADOW-SEED WEEKLY DIGEST'); // rest of the digest still renders
  });
});

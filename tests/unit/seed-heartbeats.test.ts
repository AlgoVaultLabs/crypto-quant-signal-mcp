/**
 * tests/unit/seed-heartbeats.test.ts — OPS-SEED-ORCHESTRATOR-W1 V2-RESUME (CH3-PRE)
 *
 * Unit coverage for the attempt-recency heartbeat module (the V5(ii) gate +
 * future heartbeat-pager data source). dbQuery is mocked — these assert the
 * SQL/param contract (table ensure once, upsert shape, epoch-seconds default,
 * the V5(ii) per-venue max(last_attempt_at) read).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));
vi.mock('../../src/lib/performance-db.js', () => ({ dbQuery }));

import {
  recordSeedHeartbeat,
  getSeedHeartbeats,
  _resetSeedHeartbeatEnsure,
} from '../../src/lib/seed-heartbeats.js';

describe('seed-heartbeats (V2-RESUME CH3-PRE)', () => {
  beforeEach(() => {
    dbQuery.mockReset();
    dbQuery.mockResolvedValue([]);
    _resetSeedHeartbeatEnsure();
  });

  it('ensures the table once, then upserts (exchange, timeframe, epoch-seconds)', async () => {
    await recordSeedHeartbeat('HL', '5m', 1_800_000_000);
    expect(dbQuery).toHaveBeenCalledTimes(2); // CREATE TABLE + upsert
    expect(dbQuery.mock.calls[0][0]).toMatch(/CREATE TABLE IF NOT EXISTS seed_heartbeats/);
    const [sql, params] = dbQuery.mock.calls[1];
    expect(sql).toMatch(/INSERT INTO seed_heartbeats/);
    expect(sql).toMatch(/ON CONFLICT \(exchange, timeframe\) DO UPDATE/);
    expect(params).toEqual(['HL', '5m', 1_800_000_000]);
  });

  it('ensures the table only ONCE per process (subsequent records skip CREATE)', async () => {
    await recordSeedHeartbeat('HL', '5m', 1);
    await recordSeedHeartbeat('BINANCE', '5m', 2);
    expect(dbQuery).toHaveBeenCalledTimes(3); // 1 CREATE + 2 upserts
    expect(dbQuery.mock.calls.filter((c) => /CREATE TABLE/.test(c[0] as string))).toHaveLength(1);
  });

  it('defaults last_attempt_at to now in epoch SECONDS', async () => {
    await recordSeedHeartbeat('OKX', '15m');
    const params = dbQuery.mock.calls[1][1] as number[];
    const nowS = Math.floor(Date.now() / 1000);
    expect(params[2]).toBeGreaterThanOrEqual(nowS - 2);
    expect(params[2]).toBeLessThanOrEqual(nowS + 2);
  });

  it('getSeedHeartbeats issues the V5(ii) per-venue max(last_attempt_at) query for a TF', async () => {
    dbQuery.mockResolvedValue([{ exchange: 'HL', last_attempt_at: 123 }]);
    const rows = await getSeedHeartbeats('5m');
    const [sql, params] = dbQuery.mock.calls[0];
    expect(sql).toMatch(/max\(last_attempt_at\)/);
    expect(sql).toMatch(/WHERE timeframe = \$1 GROUP BY exchange/);
    expect(params).toEqual(['5m']);
    expect(rows).toEqual([{ exchange: 'HL', last_attempt_at: 123 }]);
  });
});

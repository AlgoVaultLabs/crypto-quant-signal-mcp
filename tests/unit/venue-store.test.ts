/**
 * EXCHANGE-SHADOW-PROMOTE-W1 / C1 — venue-store unit tests.
 *
 * Mocks `performance-db` exports (dbQuery / dbRun / dbExec). Asserts:
 *   - initVenuesTable runs CREATE TABLE + CREATE INDEX + seed SQL once
 *   - getVenue returns full record for known venue, null for unknown
 *   - listVenues filters by status when provided
 *   - setStatus updates the correct lifecycle timestamp per branch
 *   - recordEval writes pfe_wr + count without mutating status
 *   - incrementExtension uses additive UPDATE (not SET = N)
 *   - insertVenue defaults min_buy_sell_sample to asset_count × 10
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/performance-db.js', () => ({
  dbQuery: vi.fn(),
  dbRun: vi.fn(),
  dbExec: vi.fn(),
}));

import {
  initVenuesTable,
  getVenue,
  listVenues,
  setStatus,
  recordEval,
  incrementExtension,
  stampSeedingStarted,
  insertVenue,
  refreshAssetCount,
  _resetInitForTest,
} from '../../src/lib/venue-store.js';
import { dbQuery, dbRun, dbExec } from '../../src/lib/performance-db.js';

const mockQuery = vi.mocked(dbQuery);
const mockRun = vi.mocked(dbRun);
const mockExec = vi.mocked(dbExec);

const binanceRow = {
  exchange_id: 'BINANCE',
  status: 'promoted',
  asset_count: 423,
  min_buy_sell_sample: 4230,
  integrated_at: new Date('2026-01-15T00:00:00Z'),
  promoted_at: new Date('2026-05-16T12:00:00Z'),
  retired_at: null,
  extension_count: 0,
  last_eval_at: null,
  last_eval_pfe_wr: null,
  last_eval_buy_sell_count: null,
  notes: 'Backfilled by venue-store.initVenuesTable',
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetInitForTest();
  mockQuery.mockResolvedValue([]);
});

describe('initVenuesTable — idempotent bootstrap', () => {
  it('runs CREATE TABLE + CREATE INDEX + seed SQL on first call', async () => {
    await initVenuesTable();
    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(mockExec.mock.calls[0][0]).toMatch(/CREATE TABLE IF NOT EXISTS venues/);
    expect(mockExec.mock.calls[1][0]).toMatch(/CREATE INDEX IF NOT EXISTS idx_venues_status/);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toMatch(/INSERT INTO venues/);
    expect(mockQuery.mock.calls[0][0]).toMatch(/ON CONFLICT \(exchange_id\) DO NOTHING/);
  });

  it('is a no-op on subsequent calls (initialized flag)', async () => {
    await initVenuesTable();
    await initVenuesTable();
    await initVenuesTable();
    expect(mockExec).toHaveBeenCalledTimes(2); // only the first call's 2 exec runs
    expect(mockQuery).toHaveBeenCalledTimes(1); // only the first call's seed
  });

  it('survives seed failure non-fatally (table still created)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('signals table empty'));
    await expect(initVenuesTable()).resolves.toBeUndefined();
    expect(mockExec).toHaveBeenCalledTimes(2);
  });
});

describe('getVenue', () => {
  it('returns full VenueRecord for known venue (BINANCE)', async () => {
    mockQuery
      .mockResolvedValueOnce([]) // initVenuesTable seed call
      .mockResolvedValueOnce([binanceRow]); // getVenue SELECT
    const result = await getVenue('BINANCE');
    expect(result).not.toBeNull();
    expect(result!.exchange_id).toBe('BINANCE');
    expect(result!.status).toBe('promoted');
    expect(result!.asset_count).toBe(423);
    expect(result!.min_buy_sell_sample).toBe(4230);
    expect(result!.extension_count).toBe(0);
    expect(result!.integrated_at).toBe('2026-01-15T00:00:00.000Z');
    expect(result!.promoted_at).toBe('2026-05-16T12:00:00.000Z');
    expect(result!.retired_at).toBeNull();
    expect(result!.last_eval_pfe_wr).toBeNull();
  });

  it('returns null (NOT throws) for unknown venue', async () => {
    mockQuery
      .mockResolvedValueOnce([]) // init seed
      .mockResolvedValueOnce([]); // SELECT returns no rows
    const result = await getVenue('UNKNOWN');
    expect(result).toBeNull();
  });

  it('parameterizes the WHERE clause (no SQL injection)', async () => {
    mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await getVenue("BINANCE'; DROP TABLE venues;--");
    const selectCall = mockQuery.mock.calls[1];
    expect(selectCall[0]).toMatch(/WHERE exchange_id = \?/);
    expect(selectCall[1]).toEqual(["BINANCE'; DROP TABLE venues;--"]);
  });
});

describe('listVenues', () => {
  it('without status returns all venues ordered by exchange_id', async () => {
    mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([binanceRow]);
    const result = await listVenues();
    expect(result).toHaveLength(1);
    expect(mockQuery.mock.calls[1][0]).toMatch(/SELECT \* FROM venues ORDER BY exchange_id/);
    expect(mockQuery.mock.calls[1][0]).not.toMatch(/WHERE status/);
  });

  it("with status='shadow' filters and returns [] when no shadow venues exist (post-C1 backfill state)", async () => {
    mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const result = await listVenues('shadow');
    expect(result).toEqual([]);
    expect(mockQuery.mock.calls[1][0]).toMatch(/WHERE status = \?/);
    expect(mockQuery.mock.calls[1][1]).toEqual(['shadow']);
  });

  it("with status='promoted' returns 5 promoted venues (post-backfill expected state)", async () => {
    const fiveRows = ['BINANCE', 'BITGET', 'BYBIT', 'HL', 'OKX'].map((id) => ({
      ...binanceRow,
      exchange_id: id,
    }));
    mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce(fiveRows);
    const result = await listVenues('promoted');
    expect(result).toHaveLength(5);
    expect(result.map(r => r.exchange_id)).toEqual(['BINANCE', 'BITGET', 'BYBIT', 'HL', 'OKX']);
    expect(result.every(r => r.status === 'promoted')).toBe(true);
  });
});

describe('setStatus', () => {
  it("promoted branch updates status + promoted_at (default to NOW)", async () => {
    const before = new Date();
    await setStatus('NEW_VENUE', 'promoted');
    expect(mockRun).toHaveBeenCalledTimes(1);
    const call = mockRun.mock.calls[0];
    expect(call[0]).toMatch(/UPDATE venues SET status = \?, promoted_at = \?/);
    expect(call[1]).toBe('promoted');
    const promotedAt = call[2] as Date;
    expect(promotedAt).toBeInstanceOf(Date);
    expect(promotedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it("promoted branch honors explicit promoted_at option", async () => {
    const fixed = new Date('2026-06-01T00:00:00Z');
    await setStatus('NEW_VENUE', 'promoted', { promoted_at: fixed });
    const call = mockRun.mock.calls[0];
    expect(call[2]).toEqual(fixed);
  });

  it("retired branch updates status + retired_at", async () => {
    await setStatus('OLD_VENUE', 'retired', { notes: 'manual retire' });
    const call = mockRun.mock.calls[0];
    expect(call[0]).toMatch(/UPDATE venues SET status = \?, retired_at = \?/);
    expect(call[1]).toBe('retired');
    expect(call[2]).toBeInstanceOf(Date);
    expect(call[3]).toBe('manual retire');
  });

  it("shadow branch updates status without touching promoted_at/retired_at", async () => {
    await setStatus('REGRESSED_VENUE', 'shadow');
    const call = mockRun.mock.calls[0];
    expect(call[0]).toMatch(/UPDATE venues SET status = \?,/);
    expect(call[0]).not.toMatch(/promoted_at = /);
    expect(call[0]).not.toMatch(/retired_at = /);
    expect(call[1]).toBe('shadow');
  });
});

describe('recordEval', () => {
  it('writes pfe_wr + buy_sell_count + last_eval_at without changing status', async () => {
    const evalAt = new Date('2026-05-30T06:00:00Z');
    await recordEval('SHADOW_X', 0.82, 7200, evalAt);
    const call = mockRun.mock.calls[0];
    expect(call[0]).toMatch(/UPDATE venues/);
    expect(call[0]).toMatch(/last_eval_at = \?/);
    expect(call[0]).toMatch(/last_eval_pfe_wr = \?/);
    expect(call[0]).toMatch(/last_eval_buy_sell_count = \?/);
    expect(call[0]).not.toMatch(/SET status/);
    expect(call[1]).toEqual(evalAt);
    expect(call[2]).toBe(0.82);
    expect(call[3]).toBe(7200);
    expect(call[4]).toBe('SHADOW_X');
  });

  it('accepts pfe_wr=null (no Phase E outcomes yet)', async () => {
    await recordEval('FRESH_SHADOW', null, 0);
    const call = mockRun.mock.calls[0];
    expect(call[2]).toBeNull();
    expect(call[3]).toBe(0);
  });
});

describe('incrementExtension', () => {
  it('uses additive UPDATE (extension_count = extension_count + 1)', async () => {
    await incrementExtension('SHADOW_NEAR_DAY15');
    const call = mockRun.mock.calls[0];
    expect(call[0]).toMatch(/extension_count = extension_count \+ 1/);
    expect(call[1]).toBe('SHADOW_NEAR_DAY15');
  });
});

describe('insertVenue', () => {
  it("defaults min_buy_sell_sample to asset_count × 10", async () => {
    await insertVenue({
      exchangeId: 'NEW_PILOT',
      status: 'shadow',
      assetCount: 250,
    });
    const call = mockRun.mock.calls[0];
    expect(call[0]).toMatch(/INSERT INTO venues/);
    expect(call[0]).toMatch(/ON CONFLICT \(exchange_id\) DO NOTHING/);
    expect(call[1]).toBe('NEW_PILOT');
    expect(call[2]).toBe('shadow');
    expect(call[3]).toBe(250);
    expect(call[4]).toBe(2500); // 250 × 10
  });

  it("honors explicit minBuySellSample override", async () => {
    await insertVenue({
      exchangeId: 'CUSTOM',
      status: 'shadow',
      assetCount: 100,
      minBuySellSample: 5000,
    });
    const call = mockRun.mock.calls[0];
    expect(call[4]).toBe(5000);
  });
});

describe('refreshAssetCount', () => {
  it("recomputes min_buy_sell_sample as newAssetCount × 10", async () => {
    await refreshAssetCount('BINANCE', 500);
    const call = mockRun.mock.calls[0];
    expect(call[0]).toMatch(/UPDATE venues/);
    expect(call[0]).toMatch(/asset_count = \?/);
    expect(call[0]).toMatch(/min_buy_sell_sample = \?/);
    expect(call[1]).toBe(500);
    expect(call[2]).toBe(5000);
    expect(call[3]).toBe('BINANCE');
  });
});

describe('stampSeedingStarted (OPS-SHADOW-PIPELINE-W1/C3)', () => {
  it('issues a shadow-only, NULL-guarded UPDATE via awaited dbQuery', async () => {
    mockQuery.mockResolvedValue([]); // init seed + the UPDATE
    const when = new Date('2026-06-01T08:00:00Z');
    await stampSeedingStarted('WEEX', when);
    // find the UPDATE call (not the init seed INSERT)
    const updateCall = mockQuery.mock.calls.find(c => /UPDATE venues/.test(String(c[0])) && /seeding_started_at/.test(String(c[0])));
    expect(updateCall).toBeDefined();
    const sql = String(updateCall![0]);
    expect(sql).toMatch(/seeding_started_at = \?/);
    expect(sql).toMatch(/seeding_started_at IS NULL/);   // idempotent: stamps once
    expect(sql).toMatch(/status = 'shadow'/);            // promoted venues never stamped
    expect(updateCall![1]).toEqual([when, 'WEEX']);
  });
});

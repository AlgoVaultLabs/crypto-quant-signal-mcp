/**
 * tests/unit/oi-snapshots.test.ts — SCAN-RANKBY-W3 CH2
 *
 * The pure OI-delta derivation (oiDeltaFromSnapshots) gets real unit coverage;
 * the DB wrappers (record / computeOiDelta / computeOiDeltaForPool / prune) assert
 * the SQL+param CONTRACT with dbQuery mocked (the $N SQL is PG-only — exercised
 * live post-deploy, per the dual-backend deferral). Mirrors seed-heartbeats.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));
vi.mock('../../src/lib/performance-db.js', () => ({ dbQuery }));

import {
  oiDeltaFromSnapshots,
  recordOiSnapshots,
  computeOiDelta,
  computeOiDeltaForPool,
  pruneOiSnapshots,
  bucketHour,
  _resetOiSnapshotsEnsure,
  OI_BUCKET_MS,
  DEFAULT_OI_WINDOW_MS,
  OI_WINDOWS,
  DEFAULT_OI_WINDOW,
  oiWindowLabelForMs,
} from '../../src/lib/oi-snapshots.js';

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000; // fixed epoch ms

describe('oiDeltaFromSnapshots (pure — the ONE OI-delta derivation)', () => {
  it('computes the % change current vs the ≥window-ago snapshot', () => {
    const d = oiDeltaFromSnapshots(
      [{ ts: NOW - 24 * HOUR, oi: 100 }, { ts: NOW, oi: 110 }],
      DEFAULT_OI_WINDOW_MS,
      NOW,
    );
    expect(d).toEqual({ oi_change_pct: 10, oi_change_window: '24h' });
  });

  it('returns a NEGATIVE delta when OI fell (sign correctness — the CH1 bug)', () => {
    const d = oiDeltaFromSnapshots(
      [{ ts: NOW - 24 * HOUR, oi: 200 }, { ts: NOW, oi: 180 }],
      DEFAULT_OI_WINDOW_MS,
      NOW,
    );
    expect(d?.oi_change_pct).toBe(-10);
  });

  it('returns null ("warming") with < 2 points', () => {
    expect(oiDeltaFromSnapshots([{ ts: NOW, oi: 100 }], DEFAULT_OI_WINDOW_MS, NOW)).toBeNull();
    expect(oiDeltaFromSnapshots([], DEFAULT_OI_WINDOW_MS, NOW)).toBeNull();
  });

  it('returns null when no point spans the window (only recent samples)', () => {
    const d = oiDeltaFromSnapshots(
      [{ ts: NOW - 2 * HOUR, oi: 100 }, { ts: NOW - HOUR, oi: 105 }, { ts: NOW, oi: 110 }],
      DEFAULT_OI_WINDOW_MS, // 24h — none of these is ≥ 24h old
      NOW,
    );
    expect(d).toBeNull();
  });

  it('picks the nearest snapshot at-or-before (current − window), not an over-old one', () => {
    const d = oiDeltaFromSnapshots(
      [
        { ts: NOW - 26 * HOUR, oi: 100 },
        { ts: NOW - 25 * HOUR, oi: 105 },
        { ts: NOW - 24 * HOUR, oi: 108 }, // ← the ≥24h-ago anchor
        { ts: NOW - HOUR, oi: 119 },
        { ts: NOW, oi: 120 },
      ],
      DEFAULT_OI_WINDOW_MS,
      NOW,
    );
    expect(d?.oi_change_pct).toBe(parseFloat((((120 - 108) / 108) * 100).toFixed(2))); // 11.11
  });

  it('ignores non-positive OI and future-dated points', () => {
    const d = oiDeltaFromSnapshots(
      [
        { ts: NOW - 24 * HOUR, oi: 0 }, // dropped (oi<=0)
        { ts: NOW - 24 * HOUR, oi: 100 },
        { ts: NOW + HOUR, oi: 999 }, // dropped (future)
        { ts: NOW, oi: 130 },
      ],
      DEFAULT_OI_WINDOW_MS,
      NOW,
    );
    expect(d?.oi_change_pct).toBe(30);
  });
});

describe('bucketHour', () => {
  it('floors to the hour', () => {
    expect(bucketHour(NOW + 37 * 60 * 1000 + 12_345)).toBe(NOW); // NOW is hour-aligned
    expect(OI_BUCKET_MS).toBe(HOUR);
  });
});

describe('OI_WINDOWS / oiWindowLabelForMs (SCAN-RANKBY-REFINEMENTS-W1 CH1 — selectable window)', () => {
  it('maps each label to its ms; 24h is the default', () => {
    expect(OI_WINDOWS).toEqual({ '1h': HOUR, '4h': 4 * HOUR, '24h': 24 * HOUR });
    expect(OI_WINDOWS['24h']).toBe(DEFAULT_OI_WINDOW_MS);
    expect(DEFAULT_OI_WINDOW).toBe('24h');
  });
  it('oiWindowLabelForMs reverses ms → label (unknown ms → 24h default)', () => {
    expect(oiWindowLabelForMs(HOUR)).toBe('1h');
    expect(oiWindowLabelForMs(4 * HOUR)).toBe('4h');
    expect(oiWindowLabelForMs(24 * HOUR)).toBe('24h');
    expect(oiWindowLabelForMs(999)).toBe('24h');
  });
  it('oiDeltaFromSnapshots echoes the passed window label (4h)', () => {
    const d = oiDeltaFromSnapshots(
      [{ ts: NOW - 4 * HOUR, oi: 100 }, { ts: NOW, oi: 112 }],
      OI_WINDOWS['4h'],
      NOW,
      oiWindowLabelForMs(OI_WINDOWS['4h']),
    );
    expect(d).toEqual({ oi_change_pct: 12, oi_change_window: '4h' });
  });
});

describe('recordOiSnapshots (SQL/param contract)', () => {
  beforeEach(() => {
    dbQuery.mockReset();
    dbQuery.mockResolvedValue([]);
    _resetOiSnapshotsEnsure();
  });

  it('ensures the table+index once, then bulk-inserts with ON CONFLICT DO NOTHING', async () => {
    const n = await recordOiSnapshots('BYBIT', [
      { symbol: 'BTC', oi: 1000, ts: NOW },
      { symbol: 'eth', oi: 2000, ts: NOW }, // lowercased → upper in params
    ]);
    expect(n).toBe(2);
    expect(dbQuery.mock.calls[0][0]).toMatch(/CREATE TABLE IF NOT EXISTS oi_snapshots/);
    expect(dbQuery.mock.calls[1][0]).toMatch(/CREATE INDEX IF NOT EXISTS/);
    const [sql, params] = dbQuery.mock.calls[2];
    expect(sql).toMatch(/INSERT INTO oi_snapshots \(exchange, symbol, ts, oi\)/);
    expect(sql).toMatch(/ON CONFLICT \(exchange, symbol, ts\) DO NOTHING/);
    expect(params).toEqual(['BYBIT', 'BTC', NOW, 1000, 'BYBIT', 'ETH', NOW, 2000]);
  });

  it('skips non-finite / non-positive OI and no-ops on an empty set', async () => {
    const n = await recordOiSnapshots('HL', [
      { symbol: 'A', oi: 0, ts: NOW },
      { symbol: 'B', oi: NaN, ts: NOW },
      { symbol: 'C', oi: -5, ts: NOW },
    ]);
    expect(n).toBe(0);
    expect(dbQuery).not.toHaveBeenCalled(); // not even ensureTable
  });
});

describe('computeOiDelta / computeOiDeltaForPool (query contract)', () => {
  beforeEach(() => {
    dbQuery.mockReset();
    _resetOiSnapshotsEnsure();
  });

  it('computeOiDelta queries one (exchange, symbol) window then derives the delta', async () => {
    dbQuery.mockResolvedValue([
      { ts: NOW - 24 * HOUR, oi: '100' },
      { ts: NOW, oi: '125' },
    ]);
    const d = await computeOiDelta('btc', 'BINANCE', DEFAULT_OI_WINDOW_MS, NOW);
    const [sql, params] = dbQuery.mock.calls[0];
    expect(sql).toMatch(/SELECT ts, oi FROM oi_snapshots WHERE exchange = \$1 AND symbol = \$2 AND ts >= \$3/);
    expect(params[0]).toBe('BINANCE');
    expect(params[1]).toBe('BTC'); // upper-cased
    expect(params[2]).toBe(NOW - DEFAULT_OI_WINDOW_MS - 2 * HOUR);
    expect(d?.oi_change_pct).toBe(25);
  });

  it('computeOiDeltaForPool groups by symbol; warming symbols are omitted', async () => {
    dbQuery.mockResolvedValue([
      { symbol: 'BTC', ts: NOW - 24 * HOUR, oi: '100' },
      { symbol: 'BTC', ts: NOW, oi: '120' },
      { symbol: 'SOL', ts: NOW - HOUR, oi: '50' }, // only one recent point → warming
      { symbol: 'SOL', ts: NOW, oi: '60' },
    ]);
    const m = await computeOiDeltaForPool('BYBIT', DEFAULT_OI_WINDOW_MS, NOW);
    expect(m.get('BTC')?.oi_change_pct).toBe(20);
    expect(m.has('SOL')).toBe(false); // warming → not in the map
    const [sql] = dbQuery.mock.calls[0];
    expect(sql).toMatch(/WHERE exchange = \$1 AND ts >= \$2 ORDER BY symbol ASC, ts ASC/);
  });

  it('computeOiDeltaForPool with the 4h window derives the "4h" label echo (CH1)', async () => {
    dbQuery.mockResolvedValue([
      { symbol: 'BTC', ts: NOW - 4 * HOUR, oi: '100' },
      { symbol: 'BTC', ts: NOW, oi: '105' },
    ]);
    const m = await computeOiDeltaForPool('BYBIT', OI_WINDOWS['4h'], NOW);
    expect(m.get('BTC')).toEqual({ oi_change_pct: 5, oi_change_window: '4h' });
  });
});

describe('pruneOiSnapshots', () => {
  beforeEach(() => {
    dbQuery.mockReset();
    dbQuery.mockResolvedValue([]);
    _resetOiSnapshotsEnsure();
  });

  it('deletes rows older than the retention cutoff', async () => {
    await pruneOiSnapshots(30 * 24 * HOUR, NOW);
    const del = dbQuery.mock.calls.find((c) => /DELETE FROM oi_snapshots WHERE ts < \$1/.test(c[0] as string));
    expect(del).toBeTruthy();
    expect((del as unknown[])[1]).toEqual([NOW - 30 * 24 * HOUR]);
  });
});

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
  basisBps,
  spreadBps,
  RETENTION_MS_PERMANENT,
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

  it('ensures the table+index+columns+view once, then bulk-inserts with ON CONFLICT DO NOTHING', async () => {
    const n = await recordOiSnapshots('BYBIT', [
      { symbol: 'BTC', oi: 1000, ts: NOW },
      { symbol: 'eth', oi: 2000, ts: NOW }, // lowercased → upper in params
    ]);
    expect(n).toBe(2);
    const ddl = dbQuery.mock.calls.map((c) => c[0] as string);
    expect(ddl[0]).toMatch(/CREATE TABLE IF NOT EXISTS oi_snapshots/);
    // W1 Q2b: the read-path index is (exchange, ts) — NOT the PK-duplicating (exchange, symbol, ts).
    expect(ddl[1]).toMatch(/CREATE INDEX IF NOT EXISTS idx_oi_snapshots_exch_ts ON oi_snapshots \(exchange, ts\)/);
    // W1 Q8: the byte-identical duplicate of the PK is dropped, and never recreated by the ensure.
    expect(ddl[2]).toMatch(/DROP INDEX IF EXISTS idx_oi_snapshots_exch_sym_ts/);
    expect(ddl.some((s) => /CREATE INDEX[^;]*idx_oi_snapshots_exch_sym_ts/.test(s))).toBe(false);
    expect(ddl.some((s) => /ADD COLUMN IF NOT EXISTS contracts_oi/.test(s))).toBe(true); // CH3
    for (const col of ['mark_price', 'index_price', 'basis_bps', 'spread_bps']) {
      expect(ddl.some((s) => new RegExp(`ADD COLUMN IF NOT EXISTS ${col}`).test(s))).toBe(true);
    }
    expect(ddl.some((s) => /ALTER COLUMN oi DROP NOT NULL/.test(s))).toBe(true);
    expect(ddl.some((s) => /CREATE OR REPLACE VIEW structural_snapshots/.test(s))).toBe(true);

    const insert = dbQuery.mock.calls.find((c) => /INSERT INTO oi_snapshots/.test(c[0] as string))!;
    expect(insert[0]).toMatch(
      /INSERT INTO oi_snapshots \(exchange, symbol, ts, oi, contracts_oi, mark_price, index_price, basis_bps, spread_bps\)/,
    );
    expect(insert[0]).toMatch(/ON CONFLICT \(exchange, symbol, ts\) DO NOTHING/);
    // W1: 9 cols/row; every absent structural field is NULL, never 0.
    expect(insert[1]).toEqual([
      'BYBIT', 'BTC', NOW, 1000, null, null, null, null, null,
      'BYBIT', 'ETH', NOW, 2000, null, null, null, null, null,
    ]);
  });

  it('CH3: carries contracts_oi (base-coin OI) in the insert; NULL when absent', async () => {
    await recordOiSnapshots('OKX', [
      { symbol: 'BTC', oi: 1000, contracts: 7.5, ts: NOW },
      { symbol: 'ETH', oi: 2000, ts: NOW }, // no contracts → NULL
    ]);
    const insert = dbQuery.mock.calls.find((c) => /INSERT INTO oi_snapshots/.test(c[0] as string))!;
    expect(insert[1]).toEqual([
      'OKX', 'BTC', NOW, 1000, 7.5, null, null, null, null,
      'OKX', 'ETH', NOW, 2000, null, null, null, null, null,
    ]);
  });

  it('W1: derives basis_bps + spread_bps into the insert from mark/index/bid/ask', async () => {
    await recordOiSnapshots('GATE', [
      { symbol: 'BTC', oi: 1000, ts: NOW, mark: 101, index: 100, bid: 99.5, ask: 100.5 },
    ]);
    const insert = dbQuery.mock.calls.find((c) => /INSERT INTO oi_snapshots/.test(c[0] as string))!;
    const params = insert[1] as unknown[];
    expect(params.slice(0, 7)).toEqual(['GATE', 'BTC', NOW, 1000, null, 101, 100]);
    expect(params[7]).toBeCloseTo(100, 6);  // basis_bps: (101-100)/100 * 1e4
    expect(params[8]).toBeCloseTo(100, 6);  // spread_bps: 1/100.0 * 1e4
  });

  it('W1 Q4: writes an OI-NULL row when the venue has only structural data (ASTER/BINGX)', async () => {
    const n = await recordOiSnapshots('ASTER', [
      { symbol: 'BTC', ts: NOW, mark: 101, index: 100, bid: 99.5, ask: 100.5 },
    ]);
    expect(n).toBe(1);
    const insert = dbQuery.mock.calls.find((c) => /INSERT INTO oi_snapshots/.test(c[0] as string))!;
    const params = insert[1] as unknown[];
    expect(params[3]).toBeNull();          // oi NULL — volume proxy is NEVER recorded as OI
    expect(params[5]).toBe(101);           // but mark/index/basis/spread are real
    expect(params[7]).toBeCloseTo(100, 6);
  });

  it('drops rows carrying NO measurement at all, and no-ops on an empty set', async () => {
    const n = await recordOiSnapshots('HL', [
      { symbol: 'A', oi: 0, ts: NOW },
      { symbol: 'B', oi: NaN, ts: NOW },
      { symbol: 'C', oi: -5, ts: NOW },
      { symbol: 'D', ts: NOW }, // no oi, no structural → an all-empty row is a false "we sampled"
    ]);
    expect(n).toBe(0);
    expect(dbQuery).not.toHaveBeenCalled(); // not even ensureTable
  });
});

describe('basisBps / spreadBps (pure — the ONE structural derivation, W1)', () => {
  it('basis is signed: premium positive, discount negative', () => {
    expect(basisBps(101, 100)).toBeCloseTo(100, 9);
    expect(basisBps(99, 100)).toBeCloseTo(-100, 9);
    expect(basisBps(100, 100)).toBe(0);
  });

  it('spread is over the MID, not the bid', () => {
    // bid 99.5 / ask 100.5 → mid 100, spread 1 → 100 bps (over the bid it would be 100.50…)
    expect(spreadBps(99.5, 100.5)).toBeCloseTo(100, 9);
  });

  it('a crossed/locked book yields a real non-positive value, not null', () => {
    expect(spreadBps(100.5, 99.5)).toBeCloseTo(-100, 9); // crossed — real microstructure
    expect(spreadBps(100, 100)).toBe(0);                 // locked
  });

  it('returns null — never 0 — when either side is absent or non-positive', () => {
    for (const bad of [undefined, null, NaN, Infinity, 0, -1, 'abc']) {
      expect(basisBps(bad, 100)).toBeNull();
      expect(basisBps(100, bad)).toBeNull();
      expect(spreadBps(bad, 100)).toBeNull();
      expect(spreadBps(100, bad)).toBeNull();
    }
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
    const d = await computeOiDelta('btc', 'BINANCE', DEFAULT_OI_WINDOW_MS, 'notional', NOW);
    const [sql, params] = dbQuery.mock.calls[0];
    expect(sql).toMatch(/SELECT ts, oi FROM oi_snapshots WHERE exchange = \$1 AND symbol = \$2 AND ts >= \$3/);
    // W1: `oi` is nullable now (ASTER/BINGX structural-only rows) → the notional path guards it too.
    expect(sql).toMatch(/AND oi IS NOT NULL/);
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
    const m = await computeOiDeltaForPool('BYBIT', DEFAULT_OI_WINDOW_MS, 'notional', NOW);
    expect(m.get('BTC')?.oi_change_pct).toBe(20);
    expect(m.has('SOL')).toBe(false); // warming → not in the map
    const [sql] = dbQuery.mock.calls[0];
    expect(sql).toMatch(/WHERE exchange = \$1 AND ts >= \$2 AND oi IS NOT NULL ORDER BY symbol ASC, ts ASC/);
  });

  it('computeOiDeltaForPool with the 4h window derives the "4h" label echo (CH1)', async () => {
    dbQuery.mockResolvedValue([
      { symbol: 'BTC', ts: NOW - 4 * HOUR, oi: '100' },
      { symbol: 'BTC', ts: NOW, oi: '105' },
    ]);
    const m = await computeOiDeltaForPool('BYBIT', OI_WINDOWS['4h'], 'notional', NOW);
    expect(m.get('BTC')).toEqual({ oi_change_pct: 5, oi_change_window: '4h' });
  });

  it('computeOiDeltaForPool basis="contracts" selects contracts_oi + NOT NULL guard (CH3)', async () => {
    dbQuery.mockResolvedValue([
      { symbol: 'BTC', ts: NOW - 24 * HOUR, oi: '10' },
      { symbol: 'BTC', ts: NOW, oi: '12' },
    ]);
    const m = await computeOiDeltaForPool('OKX', DEFAULT_OI_WINDOW_MS, 'contracts', NOW);
    expect(m.get('BTC')?.oi_change_pct).toBe(20); // base-coin %Δ (price-independent)
    const [sql] = dbQuery.mock.calls[0];
    expect(sql).toMatch(/SELECT symbol, ts, contracts_oi AS oi FROM oi_snapshots/);
    expect(sql).toMatch(/AND contracts_oi IS NOT NULL/);
  });

  it('computeOiDelta basis="contracts" selects contracts_oi for one coin (CH4 shadow source)', async () => {
    dbQuery.mockResolvedValue([
      { ts: NOW - 24 * HOUR, oi: '100' },
      { ts: NOW, oi: '90' },
    ]);
    const d = await computeOiDelta('eth', 'OKX', DEFAULT_OI_WINDOW_MS, 'contracts', NOW);
    expect(d?.oi_change_pct).toBe(-10);
    const [sql] = dbQuery.mock.calls[0];
    expect(sql).toMatch(/SELECT ts, contracts_oi AS oi FROM oi_snapshots/);
    expect(sql).toMatch(/AND contracts_oi IS NOT NULL/);
  });
});

describe('pruneOiSnapshots — retention is PERMANENT (W1 Q2a)', () => {
  beforeEach(() => {
    dbQuery.mockReset();
    dbQuery.mockResolvedValue([]);
    _resetOiSnapshotsEnsure();
  });

  it('NEVER issues a DELETE under the permanent default', async () => {
    await pruneOiSnapshots();
    const del = dbQuery.mock.calls.find((c) => /DELETE FROM oi_snapshots/.test(c[0] as string));
    expect(del).toBeUndefined();
  });

  it('throws rather than deleting when handed a finite retention', async () => {
    // The pre-W1 default was RANK_OI_RETENTION_H=720h with the env UNSET in prod — a 30-day delete
    // that would have started erasing accrued B-DIR v3 training history on 2026-07-26 12:00 UTC.
    // Re-enabling a prune must be a deliberate code change, never an env slip.
    await expect(pruneOiSnapshots(30 * 24 * HOUR, NOW)).rejects.toThrow(/retention is PERMANENT/);
    expect(dbQuery.mock.calls.find((c) => /DELETE FROM oi_snapshots/.test(c[0] as string))).toBeUndefined();
  });

  it('RETENTION_MS_PERMANENT is the sentinel the guard accepts', async () => {
    expect(RETENTION_MS_PERMANENT).toBe(Infinity);
    await expect(pruneOiSnapshots(RETENTION_MS_PERMANENT)).resolves.toBeUndefined();
  });
});

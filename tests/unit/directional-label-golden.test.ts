import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';

// OPS-BDIR-V3-PANEL-READINESS-W1 CH2 R4(a) — GOLDEN: identical rows → byte-identical labels.
//
// The CH2 change decides WHICH rows the nightly labeler reaches (worklist order, venue order). It
// must never change WHAT label a row gets. This drives the REAL `processGroup` (the code that fetches
// candles, computes σ, runs the triple barrier and writes the row) over a fixed fixture — seeded
// synthetic candles and signals, DB and adapter replaced at their seams — and pins every inserted row
// to a snapshot RECORDED FROM origin/main BEFORE the change (a92bfb30; `GOLDEN_RECORD=1` rewrites it).
// It also proves ORDER-INDEPENDENCE: the same groups processed in reverse order write the same rows —
// the property the new order relies on, asserted rather than rented from the loop.

const SNAPSHOT = path.resolve(__dirname, '../fixtures/directional-label-golden.json');

// ── deterministic fixture ──────────────────────────────────────────────────────────────────────
const TF_MS: Record<string, number> = { '5m': 300_000, '1h': 3_600_000 };
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
function candleSeries(seed: number, tf: string, startMs: number, n: number, p0: number) {
  const r = lcg(seed);
  const out: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = [];
  let p = p0;
  for (let i = 0; i < n; i++) {
    const open = p;
    const drift = (r() - 0.5) * 0.02 * p;
    const close = Math.max(0.01, open + drift);
    const high = Math.max(open, close) * (1 + r() * 0.006);
    const low = Math.min(open, close) * (1 - r() * 0.006);
    out.push({ time: startMs + i * TF_MS[tf], open, high, low, close, volume: 1000 + Math.floor(r() * 500) });
    p = close;
  }
  return out;
}
const T0 = 1_790_000_000_000; // ms, fixed
const FIXTURE = {
  'BINANCE|BTC|1h': { candles: candleSeries(7, '1h', T0 - 700 * 3_600_000, 900, 60_000) },
  'GATE|ETH|5m': { candles: candleSeries(11, '5m', T0 - 900 * 300_000, 1100, 3_000) },
} as const;
type Key = keyof typeof FIXTURE;
function signalsFor(key: Key) {
  const [ex, , tf] = key.split('|');
  const c = FIXTURE[key].candles;
  const base = ex === 'BINANCE' ? 1000 : 2000;
  // 8 signals inside the candle span, each with a full sigma window before and a forward window after
  return Array.from({ length: 8 }, (_, i) => {
    const bar = c[700 + i * (tf === '1h' ? 20 : 30)];
    return {
      id: base + i,
      created_at: Math.floor(bar.time / 1000),
      price_at_signal: bar.close,
      signal: i % 3 === 0 ? 'SELL' : 'BUY',
      pfe_return_pct: 0.5 + i * 0.1,
      mae_return_pct: -0.3 - i * 0.05,
    };
  });
}

// ── seams ─────────────────────────────────────────────────────────────────────────────────────
const env = vi.hoisted(() => ({ inserted: [] as unknown[][] }));
vi.mock('../../src/lib/performance-db.js', () => ({
  dbExec: () => undefined,
  dbQuery: async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM signals') && sql.includes('WHERE exchange = $1 AND coin = $2 AND timeframe = $3')) {
      return signalsFor(`${params[0]}|${params[1]}|${params[2]}` as Key);
    }
    if (sql.includes('SELECT signal_id, barrier_spec FROM directional_labels')) return [];
    if (sql.includes('INSERT INTO directional_labels')) {
      const rows: unknown[][] = [];
      for (let i = 0; i < params.length; i += 9) rows.push(params.slice(i, i + 9));
      env.inserted.push(...rows);
      return rows.map((r) => ({ signal_id: r[0] }));
    }
    throw new Error(`unexpected SQL in golden: ${sql.slice(0, 80)}`);
  },
}));
vi.mock('../../src/lib/exchange-adapter.js', () => ({
  getAdapter: (exchange: string) => ({
    getCandles: async (coin: string, tf: string, start: number, _dex: unknown, end?: number) => {
      const key = `${exchange}|${coin}|${tf}` as Key;
      const all = FIXTURE[key]?.candles ?? [];
      return all.filter((c) => c.time >= start && (end === undefined || c.time <= end)).slice(0, 1000);
    },
  }),
}));

import { processGroup, parseCli } from '../../src/scripts/backfill-directional-labels.js';

const GROUPS = [
  { exchange: 'BINANCE', coin: 'BTC', timeframe: '1h' },
  { exchange: 'GATE', coin: 'ETH', timeframe: '5m' },
];

async function labelAll(order: typeof GROUPS): Promise<string[]> {
  env.inserted.length = 0;
  const cli = parseCli([]);
  for (const g of order) await processGroup(cli, g);
  // canonical: sorted by (signal_id, spec) so a processing order can never be mistaken for a label change
  return env.inserted
    .map((r) => JSON.stringify(r))
    .sort();
}

beforeEach(() => { env.inserted.length = 0; });

describe('directional labels — golden (WHICH rows, never WHAT label)', () => {
  it('the fixture writes every (signal, spec) row — 16 signals x 3 specs', { timeout: 30_000 }, async () => {
    expect(await labelAll(GROUPS)).toHaveLength(48);
  });

  it('labels are byte-identical to the snapshot recorded from origin/main before the change', { timeout: 30_000 }, async () => {
    const rows = await labelAll(GROUPS);
    if (process.env.GOLDEN_RECORD === '1') {
      writeFileSync(SNAPSHOT, JSON.stringify({ recorded_from: process.env.GOLDEN_RECORDED_FROM ?? 'unknown', rows }, null, 1) + '\n');
    }
    expect(existsSync(SNAPSHOT), 'golden snapshot must be committed').toBe(true);
    const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { recorded_from: string; rows: string[] };
    expect(snap.recorded_from).toMatch(/^[0-9a-f]{8}/); // recorded from a real commit, not by hand
    expect(rows).toEqual(snap.rows);
  });

  it('order-independence: the same groups processed in reverse write the same rows', { timeout: 30_000 }, async () => {
    const forward = await labelAll(GROUPS);
    const reverse = await labelAll([...GROUPS].reverse());
    expect(reverse).toEqual(forward);
  });

  it('the fixture exercises every outcome the pins would need to catch (not a vacuous corpus)', { timeout: 30_000 }, async () => {
    const rows = (await labelAll(GROUPS)).map((s) => JSON.parse(s) as unknown[]);
    const labels = new Set(rows.map((r) => r[2]));
    expect(labels.size, `labels seen: ${[...labels].join(',')}`).toBeGreaterThanOrEqual(2);
    expect(new Set(rows.map((r) => r[1])).size).toBe(3); // all three barrier specs
  });
});

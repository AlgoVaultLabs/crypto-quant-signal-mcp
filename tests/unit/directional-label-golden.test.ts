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
const env = vi.hoisted(() => ({ inserted: [] as unknown[][], cols: 0 }));
vi.mock('../../src/lib/performance-db.js', () => ({
  dbExec: () => undefined,
  dbQuery: async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM signals') && sql.includes('WHERE exchange = $1 AND coin = $2 AND timeframe = $3')) {
      return signalsFor(`${params[0]}|${params[1]}|${params[2]}` as Key);
    }
    if (sql.includes('SELECT signal_id, barrier_spec FROM directional_labels')) return [];
    if (sql.includes('INSERT INTO directional_labels')) {
      // the column list is parsed from the statement, so the chunking can never disagree with it
      env.cols = (sql.match(/\(([^)]*)\)\s*VALUES/) ?? ['', ''])[1].split(',').length;
      const rows: unknown[][] = [];
      for (let i = 0; i < params.length; i += env.cols) rows.push(params.slice(i, i + env.cols));
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

import { processGroup, parseCli, INSERT_COLUMNS } from '../../src/scripts/backfill-directional-labels.js';
import { EVAL_CANDLES } from '../../src/scripts/directional-labeler.js';

/** The nine LABEL fields — what the a92bfb30 snapshot pins. EDGE-ADS1-SCORECARD-W1-V2 CH2 appended a
 *  tenth column (ret_at_expiry_pct); it is a fact about the price path, pinned by its own test below,
 *  and the label fields must stay byte-identical to the snapshot recorded before it existed. */
const LABEL_FIELDS = 9;

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
    .map((r) => JSON.stringify(r.slice(0, LABEL_FIELDS)))
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

  it('the tenth column is ret_at_expiry_pct = close(W-th forward candle) / entry − 1, in percent', { timeout: 30_000 }, async () => {
    // Only Date is faked (the fetch delays stay real): the fixture's windows close after T0, so the
    // labeler must be run at an instant after every window has closed for the expiry to be known.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(T0 + 400 * 86_400_000));
    env.inserted.length = 0;
    const cli = parseCli([]);
    try {
      for (const g of GROUPS) await processGroup(cli, g);
    } finally {
      vi.useRealTimers();
    }
    expect(env.cols).toBe(INSERT_COLUMNS.length);
    expect(INSERT_COLUMNS[9]).toBe('ret_at_expiry_pct');
    expect(env.inserted.length).toBe(48);
    let checked = 0;
    for (const g of GROUPS) {
      const key = `${g.exchange}|${g.coin}|${g.timeframe}` as Key;
      const W = EVAL_CANDLES[g.timeframe];
      for (const sig of signalsFor(key)) {
        const fwd = FIXTURE[key].candles.filter((c) => c.time >= sig.created_at * 1000);
        const want = (fwd[W - 1].close / sig.price_at_signal - 1) * 100;
        const got = env.inserted.filter((r) => r[0] === sig.id).map((r) => r[9]);
        expect(got).toHaveLength(3); // one per spec, all equal — expiry is a fact of the path, not of tau
        for (const v of got) expect(v as number).toBeCloseTo(want, 12);
        checked++;
      }
    }
    expect(checked).toBe(16);
  });

  it('a window that had not closed when the candles were fetched gets a NULL expiry, never a live price', { timeout: 30_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // the first BINANCE signal's window (W = 8 hourly candles) closes ≤ 9 h after entry; stop the clock at +8.5 h
    const first = signalsFor('BINANCE|BTC|1h')[0];
    vi.setSystemTime(new Date(first.created_at * 1000 + 8.5 * 3_600_000));
    env.inserted.length = 0;
    try {
      await processGroup(parseCli([]), GROUPS[0]);
    } finally {
      vi.useRealTimers();
    }
    const firstRows = env.inserted.filter((r) => r[0] === first.id);
    expect(firstRows.length).toBeGreaterThan(0); // the race itself may still resolve early...
    for (const r of firstRows) expect(r[9]).toBeNull(); // ...but its expiry is not known yet
  });
});

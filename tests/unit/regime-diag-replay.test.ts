// EDGE-REGIME-DIAG-W1 CH2 — AC2.1: the replay calls the landed core (harness labels equal direct core calls), and
// the 1 m -> bar aggregation equals the venue's own klines, both on synthetic fixtures. AC2.4: the replay call,
// broken, turns the parity assertion red. Also: the registered constants against the code they were read from.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { computeMarketRegimeCore } from '../../src/lib/market-regime-core.js';
import { CANDLE_COUNTS } from '../../src/lib/serving-windows.js';
import { takerFeeBps } from '../../src/lib/venue-fees.js';
import type { Candle } from '../../src/types.js';
import { aggregate, buildGrid, emptyGrid, finishGrid, months, noGap, putCsv, putRow, unzipSingle } from '../../src/scripts/regime-diag/archive.js';
import { PARITY_FIXTURE, checkCoreParity } from '../../src/scripts/regime-diag/parity.js';
import * as replay from '../../src/scripts/regime-diag/replay.js';
import { mulberry32, rngFor, sampleWithoutReplacement, seedOf } from '../../src/scripts/regime-diag/rng.js';
import * as spec from '../../src/scripts/regime-diag/diag-spec.js';
import { synthCsv, synthGrid } from '../../src/scripts/regime-diag/synth.js';
import { aggregationParity, parityFixtureText, zipSingle } from '../fixtures/regime-diag/synth-study.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SPAN: spec.Span = { t0Ms: Date.UTC(2021, 0, 1), n: 130 * 1440 };
const TF = (key: string): spec.Tf => spec.TFS.find((t) => t.key === key)!;

/** The same module, loaded with the mutation lever set. */
async function mutated<T>(lever: string, fn: (m: typeof replay) => T): Promise<T> {
  process.env.REGIME_DIAG_MUTATE = lever;
  vi.resetModules();
  try {
    return fn(await import('../../src/scripts/regime-diag/replay.js'));
  } finally {
    delete process.env.REGIME_DIAG_MUTATE;
    vi.resetModules();
  }
}

/** The test's own reading of the csv: plain arrays, no harness code. */
function rows(text: string): { t: number; o: number; h: number; l: number; c: number; v: number }[] {
  return text.trim().split('\n').map((ln) => { const f = ln.split(','); return { t: +f[0], o: +f[1], h: +f[2], l: +f[3], c: +f[4], v: +f[5] }; });
}

/** The candle window of §4.1, built the long way from the 1 m rows, and the direct core call on it. */
function direct(r: ReturnType<typeof rows>, tf: spec.Tf, m: number): { regime: string; confidence: number; vol: number } {
  const I = tf.min;
  const bar = (a: number, b: number): Candle => {
    const s = r.slice(a, b);
    return { time: SPAN.t0Ms + a * 60_000, open: s[0].o, high: Math.max(...s.map((x) => x.h)), low: Math.min(...s.map((x) => x.l)), close: s[s.length - 1].c, volume: s.reduce((q, x) => q + x.v, 0) };
  };
  const candles: Candle[] = [];
  const lastOpen = Math.floor(m / I) * I;
  for (let a = Math.ceil((m - tf.n * I) / I) * I; a < lastOpen; a += I) candles.push(bar(a, a + I));
  const px = r[m].o;
  if (lastOpen < m) { const b = bar(lastOpen, m); candles.push({ ...b, high: Math.max(b.high, px), low: Math.min(b.low, px), close: px }); }
  else candles.push({ time: SPAN.t0Ms + m * 60_000, open: px, high: px, low: px, close: px, volume: 0 });
  const nowMs = SPAN.t0Ms + m * 60_000;
  const keep = console.error; console.error = () => {};
  try {
    const out = computeMarketRegimeCore({ coin: 'SYNTH', exchange: 'BINANCE', timeframe: tf.key, candles, intervalMs: I * 60_000, startTime: nowMs - tf.n * I * 60_000, nowMs, candleBasis: 'closed' });
    return { regime: out.regime, confidence: out.confidence, vol: out.volatilityRatio };
  } finally { console.error = keep; }
}

const csv = synthCsv(SPAN, 'replay');
const R = rows(csv);
const G = synthGrid(SPAN, 'replay');

/** AC2.1's assertion, on whichever copy of the replay module it is handed. */
function parity(mod: typeof replay): number {
  let n = 0;
  const labels = new Set<string>();
  for (const [key, instants] of [['1h', [10_080, 10_081, 10_139, 20_000, 31_337, 40_320, 55_555, 60_000, 77_777, 100_800]], ['4h', [10_080, 12_345, 23_040, 44_444, 88_888]], ['1d', [144_000, 150_001, 172_800]]] as const) {
    const tf = TF(key);
    const b = aggregate(G, tf.min);
    for (const m of instants) {
      const got = mod.quietly(() => mod.served(G, b, tf, m, 'SYNTH'));
      const want = direct(R, tf, m);
      expect([key, m, spec.LABELS[got.label], got.confidence, got.vol]).toEqual([key, m, want.regime, want.confidence, want.vol]);
      labels.add(want.regime);
      n++;
    }
  }
  // The per-closed-bar series is the same call at every close.
  const tf = TF('1h');
  const b = aggregate(G, 60);
  const s = mod.quietly(() => mod.buildSeries(G, b, tf, 'SYNTH'));
  for (let j = 168; j <= b.nb - 1; j += 97) {
    const want = direct(R, tf, j * 60);
    expect([j, s.ok[j], spec.LABELS[s.label[j]], s.conf[j], s.vol[j]]).toEqual([j, 1, want.regime, want.confidence, want.vol]);
    labels.add(want.regime);
    n++;
  }
  expect([...labels].sort()).toEqual(['RANGING', 'TRENDING_DOWN', 'TRENDING_UP', 'VOLATILE']);
  return n;
}

describe('regime-diag: registered constants', () => {
  it('the dials outside the core carry the values the code has (drift test; the study imports neither file)', () => {
    const rules = readFileSync('src/lib/pre-trade-rules.ts', 'utf8');
    expect(rules).toContain(`export const REGIME_AGAINST_MIN_CONFIDENCE = ${spec.REGIME_AGAINST_MIN_CONFIDENCE};`);
    expect(rules).toContain(`export const VOLATILE_MIN_CONFIDENCE = ${spec.VOLATILE_MIN_CONFIDENCE};`);
    expect(readFileSync('src/tools/get-market-regime.ts', 'utf8')).toContain(`const timeframe = input.timeframe || '${spec.DEFAULT_TIMEFRAME}';`);
    for (const f of readFileSync('src/scripts/regime-diag/diag-spec.ts', 'utf8').match(/from '([^']+)'/g) ?? []) expect(f).not.toMatch(/pre-trade-rules|get-market-regime/);
    expect(spec.TFS.map((t) => [t.key, t.min, t.n])).toEqual([['1h', 60, CANDLE_COUNTS['1h']], ['4h', 240, CANDLE_COUNTS['4h']], ['1d', 1440, CANDLE_COUNTS['1d']]]);
    expect(spec.FEE_PCT).toBeCloseTo((2 * takerFeeBps('BINANCE')!) / 100, 12);
    // confidence >= 70 on a VOLATILE label is volatilityRatio >= 0.03475
    expect(Math.min(85, Math.round(spec.VOL_LINE_CONF70 * 2000))).toBe(70);
    expect(Math.min(85, Math.round((spec.VOL_LINE_CONF70 - 1e-9) * 2000))).toBe(69);
  });

  it('the grid, the windows and the cells are the registered ones', () => {
    expect(new Date(spec.SPAN.t0Ms).toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(new Date(spec.SPAN.t0Ms + (spec.SPAN.n - 1) * 60_000).toISOString()).toBe('2026-10-31T23:59:00.000Z');
    expect(new Date(spec.SPAN.t0Ms + spec.FIT.hi * 60_000).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect([spec.HOLDOUT.lo, spec.HOLDOUT.hi]).toEqual([spec.FIT.hi, spec.SPAN.n]);
    expect(months()).toHaveLength(34);
    expect([spec.N_CELLS, spec.N_CS, spec.SHAPES.map((s) => s.id).join(''), spec.HOLDS_H.join()]).toEqual([45, 90, 'S1S2S3S4S5S6S7S8S9', '0.5,4,8,24,72']);
    expect(spec.SHAPES.filter((s) => s.sigma).map((s) => s.id)).toEqual(['S5', 'S7', 'S9']);
  });

  it('the statistic registry has one id per stream, and an unregistered id has no seed', () => {
    expect(new Set(spec.STAT_IDS).size).toBe(spec.STAT_IDS.length);
    expect(spec.SECONDARY_IDS).toHaveLength(14);
    for (const id of spec.SECONDARY_IDS) expect(spec.STAT_IDS).toContain(id);
    expect(spec.seedArm('fit', 'A1.S', 'bootstrap')).toBe('fit|A1.S|bootstrap');
    expect(spec.seedArm('holdout', 'A3.S@panel13', 'shuffle')).toBe('holdout|A3.S@panel13|shuffle');
    expect(() => spec.seedArm('fit', 'A9.S', 'bootstrap')).toThrow(/not in the statistic registry/);
    // 1,000 shuffles cannot reach 0.025 / 36; A3's selected cell has enough.
    expect(1 / (1 + spec.B_SHUFFLE)).toBeGreaterThan(spec.ALPHA / spec.A3_FAMILY);
    expect(1 / (1 + spec.statDef('A3.S').shuffle)).toBeLessThan(spec.ALPHA / spec.A3_FAMILY);
    // A2 by timeframe is descriptive: a bootstrap stream of its own, no shuffle.
    expect(spec.TFS.map((tf) => { const d = spec.statDef(`A2.tf.${tf.key}`); return [d.boot, d.shuffle, d.perm]; })).toEqual([[spec.B_BOOT, 0, 0], [spec.B_BOOT, 0, 0], [spec.B_BOOT, 0, 0]]);
  });

  it('the entry stream is mulberry32 seeded from the first four bytes of the sha256', () => {
    expect(seedOf('20261116|fit|P01')).toBe(parseInt(require('node:crypto').createHash('sha256').update('20261116|fit|P01').digest('hex').slice(0, 8), 16));
    const a = rngFor('20261116|fit|P01'), b = mulberry32(seedOf('20261116|fit|P01'));
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    const pool = Int32Array.from({ length: 5000 }, (_, i) => i * 3);
    const pick = sampleWithoutReplacement(pool, 400, rngFor('x'));
    expect(pick).toHaveLength(400);
    expect(new Set(pick).size).toBe(400);
    expect([...pick]).toEqual([...pick].sort((x, y) => x - y));
    expect([...pick].every((v) => v % 3 === 0)).toBe(true);
    expect([...sampleWithoutReplacement(pool, 400, rngFor('x'))]).toEqual([...pick]);
  });
});

describe('regime-diag: archives', () => {
  it('reads a monthly zip into the grid, strictly: a bad field, an off-grid or a non-positive row is rejected and counted', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'regime-diag-zip-'));
    try {
      const f = path.join(dir, 'SYNTHUSDT-1m-2021-01.zip');
      writeFileSync(f, zipSingle('SYNTHUSDT-1m-2021-01.csv', Buffer.from(`open_time,open,high,low,close,volume\n${synthCsv(SPAN, 'replay', { to: 3000 })}`)));
      expect(unzipSingle(readFileSync(f)).toString().split('\n')[1]).toBe(csv.split('\n')[0]);
      const g = buildGrid(SPAN, [f]);
      expect([g.counts.months, g.counts.rows, g.counts.rejected, g.first, g.last]).toEqual([1, 3000, 0, 0, 2999]);
      expect([g.O[1234], g.C[2999]]).toEqual([R[1234].o, R[2999].c]);
      expect(() => unzipSingle(Buffer.from('not a zip'))).toThrow(/zip:/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    const g = emptyGrid(SPAN);
    const t = SPAN.t0Ms;
    putRow(g, [`${t}`, '1', '2', '0.5', '1.5', '10']);
    putRow(g, [`${(t + 60_000) * 1000}`, '1', '2', '0.5', '1.5', '10']); // microseconds, the venue's 2025+ files
    putRow(g, [`${t + 120_000}`, '1e3', '2', '0.5', '1.5', '10']); // not a plain decimal
    putRow(g, [`${t + 120_000}`, '1', '2', '0', '1.5', '10']); // a non-positive price
    putRow(g, [`${t + 150_000}`, '1', '2', '0.5', '1.5', '10']); // not a whole minute
    putRow(g, [`${t - 60_000}`, '1', '2', '0.5', '1.5', '10']); // before the grid
    putRow(g, [`${t}`, '1', '2', '0.5', '1.5']); // a field short
    putRow(g, [`${t}`, '3', '4', '2', '3.5', '1']); // a duplicate minute: the later row stands, counted
    finishGrid(g);
    expect(g.counts).toMatchObject({ rows: 8, rejected: 5, dups: 1 });
    expect([g.has[0], g.has[1], g.has[2], g.O[0], g.first, g.last]).toEqual([1, 1, 0, 3, 0, 1]);
  });

  it('gaps: noGap sees every missing minute, and a series has no call where its window is broken', () => {
    const holes = new Set([20_000, 20_001, 50_000]);
    const g = synthGrid(SPAN, 'replay', { holes, to: 60_000 });
    expect(g.counts.gapsInside).toBe(3);
    expect([noGap(g, 19_000, 20_000), noGap(g, 19_000, 20_001), noGap(g, 20_002, 50_000), noGap(g, 20_002, 50_001), noGap(g, -1, 10), noGap(g, 59_000, 60_001)]).toEqual([true, false, true, false, false, false]);
    const tf = TF('1h');
    const s = replay.quietly(() => replay.buildSeries(g, aggregate(g, 60), tf, 'SYNTH'));
    // the hole at minute 20,000 breaks every window that reaches back over it: closes 334 … 501
    expect([s.ok[333], s.ok[334], s.ok[501], s.ok[502]]).toEqual([1, 0, 0, 1]);
    expect(Number.isNaN(s.close[334])).toBe(true); // bar 333 holds the hole
    expect(s.age[502]).toBe(1); // a label's age restarts after a hole
    let run = 0;
    for (let j = 168; j <= 333; j++) { run = s.label[j] === s.label[j - 1] && s.ok[j - 1] ? run + 1 : 1; expect(s.age[j]).toBe(run); }
  });

  it('AC2.1: the 1 m -> bar aggregation equals the venue-format klines of the same series, and one changed kline is seen', () => {
    for (const min of [60, 240, 1440]) {
      // the venue's own bar file, written by the test from the 1 m rows
      const lines: string[] = [];
      for (let a = 0; a + min <= 40 * 1440; a += min) {
        const s = R.slice(a, a + min);
        lines.push([SPAN.t0Ms + a * 60_000, s[0].o.toFixed(8), Math.max(...s.map((x) => x.h)).toFixed(8), Math.min(...s.map((x) => x.l)).toFixed(8), s[min - 1].c.toFixed(8), s.reduce((q, x) => q + x.v, 0).toFixed(5)].join(','));
      }
      const ok = aggregationParity(G, min, `${lines.join('\n')}\n`);
      expect([min, ok.compared, ok.mismatches, ok.skipped]).toEqual([min, (40 * 1440) / min, 0, 0]);
      const f = lines[7].split(',');
      f[2] = (Number(f[2]) * 1.0001).toFixed(8);
      lines[7] = f.join(',');
      expect(aggregationParity(G, min, `${lines.join('\n')}\n`).mismatches).toBe(1);
    }
    const holed = synthGrid(SPAN, 'replay', { holes: new Set([61]), to: 600 });
    const b = aggregate(holed, 60);
    expect([b.cnt[0], b.cnt[1], b.cnt[2]]).toEqual([60, 59, 60]);
    expect(aggregationParity(holed, 60, `${SPAN.t0Ms + 3_600_000},1,1,1,1,1\n`)).toMatchObject({ compared: 0, skipped: 1 });
  });
});

describe('regime-diag: the replay', () => {
  it('AC2.1: harness labels equal direct core calls, at bar boundaries and inside bars, at every timeframe', () => {
    expect(parity(replay)).toBeGreaterThan(40);
  });

  it('the window is n closed bars and a zero-length bar on a boundary, n − 1 and a bar in progress inside one', () => {
    const tf = TF('1h');
    const b = aggregate(G, 60);
    const on = replay.candlesAt(G, b, tf, 12_000);
    expect([on.candles.length, on.candles[0].time, on.candles[168].time, on.candles[168].volume, on.startTime]).toEqual([169, SPAN.t0Ms + (12_000 - 168 * 60) * 60_000, SPAN.t0Ms + 12_000 * 60_000, 0, SPAN.t0Ms + (12_000 - 168 * 60) * 60_000]);
    const off = replay.candlesAt(G, b, tf, 12_017);
    expect([off.candles.length, off.candles[0].time, off.candles[167].time, off.candles[167].open, off.candles[167].close]).toEqual([168, SPAN.t0Ms + (12_000 - 167 * 60) * 60_000, SPAN.t0Ms + 12_000 * 60_000, R[12_000].o, R[12_017].o]);
    expect([replay.servable(G, tf, 10_080), replay.servable(G, tf, 10_079)]).toEqual([true, false]);
  });

  it('AC2.4: with the replay call broken, the parity assertion is red; restored, green', async () => {
    await expect(mutated('replay', (m) => parity(m))).rejects.toThrow(/to deeply equal/);
    expect(parity(replay)).toBeGreaterThan(40);
    expect((await import('../../src/scripts/regime-diag/mutate.js')).MUTATE).toBe('');
  });

  it('the core-parity fixture is what the generator writes, reproduces label for label, and one changed label is seen', () => {
    const text = readFileSync(PARITY_FIXTURE, 'utf8');
    expect(text).toBe(parityFixtureText());
    const ok = checkCoreParity(text);
    expect(ok.ok).toBe(true);
    expect(ok.calls).toBeGreaterThanOrEqual(60);
    expect(new Set(JSON.parse(text).calls.map((c: { label: string }) => c.label)).size).toBe(4);
    const j = JSON.parse(text);
    j.calls[5].confidence += 1;
    expect(checkCoreParity(JSON.stringify(j))).toMatchObject({ ok: false, mismatches: 1 });
    expect(checkCoreParity('{"calls":[]}').ok).toBe(false); // nothing to reproduce is not a pass
    expect(checkCoreParity('not json').ok).toBe(false);
  });
});

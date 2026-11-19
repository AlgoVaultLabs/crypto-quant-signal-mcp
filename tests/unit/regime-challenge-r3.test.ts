// tests/unit/regime-challenge-r3.test.ts — EDGE-REGIME-CHALLENGE-R3-W1 CH3: round 3's alt panel — the label-free
// volume screen and rule R3-X, the chunked frame with its UTC-day clusters and per-coin-month weights, the month
// guards both ways, the store and output allow-lists, the selection of at most three dials and the power gate — and
// its in-sample pre-score on synthetic archives in a sandbox repository. Synthetic symbols only: no coin is named.
// The suite's homes, network and clock are its own (arc lesson 14: the isolate is imported first).
import { TEST_HOMEDIR } from '../fixtures/regime-challenge/isolate.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { archiveName, months, sha256, type ArchiveStore } from '../../src/scripts/regime-diag/archive.js';
import type { Run } from '../../src/scripts/regime-diag/bars.js';
import { ALPHA, MIN_MS, TFS } from '../../src/scripts/regime-diag/diag-spec.js';
import { context } from '../../src/scripts/regime-diag/engine.js';
import { N_TF, buildFrames, dayOf, parseCensus, withOutcomes, type Frame, type Loaded } from '../../src/scripts/regime-diag/frame.js';
import * as guard from '../../src/scripts/regime-diag/guard.js';
import { seedsFor } from '../../src/scripts/regime-diag/prims.js';
import { synthCsv } from '../../src/scripts/regime-diag/synth.js';
import { outRefusal } from '../../src/scripts/regime-challenge/challenge-guard.js';
import { REQUIRED_PINS, monthRefusal, type Candidate, type ChallengeRecord } from '../../src/scripts/regime-challenge/challenge-spec.js';
import { challengerColumns } from '../../src/scripts/regime-challenge/challenger-replay.js';
import * as stats from '../../src/scripts/regime-challenge/paired-stats.js';
import type { PrescoreRow } from '../../src/scripts/regime-challenge/challenge-run.js';
import { FRAME_KEYS, MAX_CHUNK, a5By, buildChunk, chunkRefusal, chunked, chunkedFrame, mergeFrames, r3Context, r3Pair, stintsOf, strataOf, type PanelMonths } from '../../src/scripts/regime-challenge/challenge-r3-frame.js';
import { classOf, dayVolumes, nbaseOf, screen, stateOf, type R3Rule, type ScreenInput, type Snapshot } from '../../src/scripts/regime-challenge/challenge-r3-screen.js';
import * as r3 from '../../src/scripts/regime-challenge/challenge-r3.js';
import { SYN_CENSUS_TEXT, SYN_FIT, SYN_PRESCORE, SYN_SPAN, synFullLoad, writeSynArchives } from '../fixtures/regime-challenge/synth-challenge.js';
import { zipSingle } from '../fixtures/regime-diag/synth-study.js';

const REPO = path.resolve(__dirname, '../..');
afterEach(() => new Promise<void>((done) => { setImmediate(done); }));
const WTF = parseCensus(SYN_CENSUS_TEXT).wTf;
const cand = (id: string): Candidate => r3.R3_CANDIDATES.find((c) => c.id === id) as Candidate;
const minute = (ym: string): number => (Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1) - SYN_SPAN.t0Ms) / MIN_MS;
const monthAt = (m: number): string => new Date(SYN_SPAN.t0Ms + m * MIN_MS).toISOString().slice(0, 7);

// ── the volume screen and rule R3-X ─────────────────────────────────────────────────────────────────────────────────

describe('regime-challenge round 3: the volume screen is label-free and rule R3-X is mechanical', () => {
  const RULE: R3Rule = { served: ['XQSRV', 'XQSRW'], stable: ['XQPEG'], assetBacked: ['XQGLD'], indexAbsent: ['XQIDX'] };
  const SNAP: Snapshot = {
    XQREUSEUSDT: { contractType: 'TRADIFI_PERPETUAL', underlyingType: 'EQUITY', onboardMonth: '2026-01' },
    XQINDUSDT: { contractType: 'PERPETUAL', underlyingType: 'INDEX', onboardMonth: '2021-06' },
    XQCOINUSDT: { contractType: 'PERPETUAL', underlyingType: 'COIN', onboardMonth: '2023-01' },
    XQSRVUSDT: { contractType: 'TRADIFI_PERPETUAL', underlyingType: 'EQUITY', onboardMonth: '2019-01' },
  };

  it('the base asset: USDT and a leading contract multiplier are stripped, and nothing else', () => {
    expect(['XQAUSDT', '1000XQAUSDT', '1000000XQAUSDT', '10000XQAUSDT', '1MXQAUSDT', '1XQAUSDT', 'XQ1000USDT'].map(nbaseOf)).toEqual(['XQA', 'XQA', 'XQA', 'XQA', 'XQA', '1XQA', 'XQ1000']);
  });

  it('R3-X applies served, not a single crypto coin, stablecoin, alt — in that order, and the snapshot only from its onboard month', () => {
    const c = (s: string, ym = '2024-01'): string => classOf(s, ym, RULE, SNAP);
    expect([c('XQSRVUSDT'), c('1000XQSRWUSDT')]).toEqual(['served', 'served']);
    expect([c('XQREUSEUSDT', '2023-05'), c('XQREUSEUSDT', '2025-12'), c('XQREUSEUSDT', '2026-01')]).toEqual(['alt', 'alt', 'not_coin']);
    expect([c('XQINDUSDT', '2021-05'), c('XQINDUSDT', '2021-06')]).toEqual(['alt', 'not_coin']);
    expect([c('XQGLDUSDT'), c('XQIDXUSDT'), c('XQPEGUSDT'), c('1000XQPEGUSDT'), c('XQCOINUSDT'), c('XQNEWUSDT')]).toEqual(['not_coin', 'not_coin', 'stable', 'stable', 'alt', 'alt']);
  });

  it('a daily kline is read for its open time and quote-asset volume only: poisoned price columns change nothing', () => {
    const t0 = Date.UTC(2024, 0, 1), D = 86_400_000;
    const row = (i: number, cells: string[]): string => [String(t0 + i * D), ...cells.slice(0, 6), String(1e7 + i), ...cells.slice(6)].join(',');
    const clean = ['open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore',
      ...[0, 1, 2].map((i) => row(i, ['1', '2', '0.5', '1.5', '100', String(t0 + (i + 1) * D - 1), '7', '50', '5e6', '0']))].join('\n');
    const poisoned = [0, 1, 2].map((i) => row(i, ['NaN', '-1e308', 'x', '1e999', 'oops', '', '', '', '', ''])).join('\n');
    const micro = [0, 1, 2].map((i) => [String((t0 + i * D) * 1000), '1', '2', '0.5', '1.5', '100', '0', String(1e7 + i), '7', '50', '5e6', '0'].join(',')).join('\n');
    const want = new Map([['2024-01-01', 1e7], ['2024-01-02', 1e7 + 1], ['2024-01-03', 1e7 + 2]]);
    expect(dayVolumes(clean)).toEqual(want);
    expect(dayVolumes(poisoned)).toEqual(want);
    expect(dayVolumes(micro)).toEqual(want);
  });

  const daysFrom = (first: string, last: string, v: (d: string) => number): Map<string, number> => {
    const out = new Map<string, number>();
    for (let t = Date.parse(`${first}T00:00:00Z`); t <= Date.parse(`${last}T00:00:00Z`); t += 86_400_000) { const d = new Date(t).toISOString().slice(0, 10); out.set(d, v(d)); }
    return out;
  };
  const input = (vol: Map<string, number>, arch = ['2024-01', '2024-02', '2024-03', '2024-04']): ScreenInput =>
    ({ months: ['2024-03'], archiveMonths: { XQAUSDT: arch }, volumes: { XQAUSDT: vol }, rule: RULE, snapshot: SNAP });

  it('a month\'s state: whole, seasoned 30 days, 20 days present, and a mean ≥ 10,000,000 over the days present', () => {
    const st = (vol: Map<string, number>, arch?: string[]): string => stateOf('XQAUSDT', '2024-03', input(vol, arch));
    expect(st(daysFrom('2023-12-01', '2024-03-31', () => 1e7))).toBe('panel');
    expect(st(daysFrom('2023-12-01', '2024-03-31', () => 1e7 - 1))).toBe('thin');
    expect(st(daysFrom('2023-12-01', '2024-03-31', () => 1e7), ['2024-02', '2024-03'])).toBe('partial');
    expect(st(daysFrom('2023-12-01', '2024-03-31', () => 1e7), ['2024-03', '2024-04'])).toBe('partial');
    // 2024-02 has 29 days: a coin first archived on February 1 is 29 days old on March 1; on January 31, 30 days old
    expect(st(daysFrom('2024-02-01', '2024-03-31', () => 1e9))).toBe('unseasoned');
    expect(st(daysFrom('2024-01-31', '2024-03-31', () => 1e7))).toBe('panel');
    // seasoned, and 19 or 20 of the 30 trailing days present
    const sparse = (k: number): Map<string, number> => { const m = daysFrom('2024-01-01', '2024-03-31', () => 1e7); for (let i = 1; i <= 30 - k; i++) m.delete(new Date(Date.UTC(2024, 2, 1 - i)).toISOString().slice(0, 10)); return m; };
    expect([st(sparse(19)), st(sparse(20))]).toEqual(['sparse', 'panel']);
    // a gap is an archive gap, not zero volume: three days missing, the rest exactly at the threshold
    const gap = daysFrom('2023-12-01', '2024-03-31', () => 1e7);
    for (const d of ['2024-02-26', '2024-02-27', '2024-02-28']) gap.delete(d);
    expect(st(gap)).toBe('panel');
    // the volume of March itself (the month decided) is never read
    expect(st(daysFrom('2023-12-01', '2024-03-31', (d) => (d >= '2024-03-01' ? 0 : 1e7)))).toBe('panel');
  });

  it('screen decides every month a symbol has an archive for, and only those, in sorted order', () => {
    const vol = daysFrom('2023-10-01', '2024-04-30', () => 2e7);
    const t = screen({ months: ['2024-01', '2024-02', '2024-03', '2024-04'], archiveMonths: { XQBUSDT: ['2024-02', '2024-03'], XQAUSDT: ['2023-12', '2024-01', '2024-02', '2024-03', '2024-04', '2024-05'], XQSRVUSDT: ['2024-01'] }, volumes: { XQAUSDT: vol, XQBUSDT: vol }, rule: RULE, snapshot: SNAP });
    expect(Object.keys(t)).toEqual(['XQAUSDT', 'XQBUSDT', 'XQSRVUSDT']);
    expect(t).toEqual({ XQAUSDT: { '2024-01': 'panel', '2024-02': 'panel', '2024-03': 'panel', '2024-04': 'panel' }, XQBUSDT: { '2024-02': 'partial', '2024-03': 'partial' }, XQSRVUSDT: { '2024-01': 'served' } });
  });
});

// ── the chunked frame ───────────────────────────────────────────────────────────────────────────────────────────────

describe('regime-challenge round 3: the frame is built in chunks of at most 255 coins and never wraps', () => {
  it('a chunk of 256 or more coins is refused before any archive is loaded; 255 is the most a chunk takes', () => {
    expect([chunkRefusal(1), chunkRefusal(MAX_CHUNK), MAX_CHUNK]).toEqual([null, null, 255]);
    expect(chunkRefusal(256)).toMatch(/a chunk of 256 coins: .* at most 255 coins/);
    let loads = 0;
    const load = (): Loaded => { loads++; return { g: null, noArchive: 1 }; };
    const coins = Array.from({ length: 256 }, (_, i) => `Q${i}`);
    expect(() => buildChunk(SYN_SPAN, SYN_FIT, coins, WTF, load, { outcomes: false, seed: 's' })).toThrow(/a chunk of 256 coins/);
    expect(loads).toBe(0);
    expect(() => chunked(coins, 256)).toThrow(/a chunk of 256 coins/);
    expect(chunked(coins).map((c) => c.length)).toEqual([255, 1]);
    expect(buildChunk(SYN_SPAN, SYN_FIT, coins.slice(0, 255), WTF, load, { outcomes: false, seed: 's' }).nE).toBe(0);
    expect(loads).toBe(255);
  });

  it('a frame of 258 coins indexes every position past 255 as itself (the pinned one-byte index would wrap 257 onto 1)', { timeout: 120_000 }, () => {
    const coins = Array.from({ length: 258 }, (_, i) => `Q${i}`), have = new Map([[0, 0], [254, 1], [255, 1], [257, 0]]);
    const f = chunkedFrame(SYN_SPAN, SYN_FIT, coins, WTF, (pos) => (have.has(pos) ? synFullLoad(have.get(pos) as number) : { g: null, noArchive: 1 }), { outcomes: false, seed: 's' });
    expect(f.census.panel.length).toBe(258);
    expect(f.coins.map((c) => c.pos)).toEqual([0, 254, 255, 257]);
    for (const c of f.coins) {
      expect(c.e1).toBeGreaterThan(c.e0);
      for (let e = c.e0; e < c.e1; e++) if (f.ePos[e] !== c.pos) throw new Error(`entry ${e} of position ${c.pos} is indexed ${f.ePos[e]}`);
    }
    expect(Math.max(...Array.from(f.ePos as unknown as Int32Array))).toBe(257);
  });

  it('the merged frame is the chunks\' frames end to end, field for field, each chunk under its own seed label', { timeout: 120_000 }, () => {
    const f = chunkedFrame(SYN_SPAN, SYN_FIT, ['SYNA', 'SYNB'], WTF, synFullLoad, { outcomes: false, seed: 's' }, 1);
    const one = (i: number): Frame => buildFrames(SYN_SPAN, [SYN_FIT], { panel: [['SYNA', 'SYNB'][i]], wCoin: [1], wTf: [...WTF] }, () => synFullLoad(i), { outcomes: false, seed: `s|chunk-${i}` })[0];
    const a = one(0), b = one(1);
    expect(Object.keys(a).sort()).toEqual([...FRAME_KEYS].sort());
    expect(f.nE).toBe(a.nE + b.nE);
    const cat = (x: ArrayLike<number>, y: ArrayLike<number>): number[] => [...Array.from(x), ...Array.from(y)];
    for (const k of ['eM', 'has', 'phase', 'volLeg', 'adx', 'adxSlope', 'plusDI', 'minusDI', 'vol', 'slope', 'structure', 'age'] as const) expect(Array.from(f[k]), k).toEqual(cat(a[k], b[k]));
    for (const k of ['S', 'B', 'B7', 'B28'] as const) expect([Array.from(f[k].lab), Array.from(f[k].conf)], k).toEqual([cat(a[k].lab, b[k].lab), cat(a[k].conf, b[k].conf)]);
    expect(Array.from(f.ePos)).toEqual([...Array.from(a.ePos), ...Array.from(b.ePos, (p) => p + 1)]);
    expect(f.coins.map((c) => [c.pos, c.e0, c.e1])).toEqual([[0, 0, a.nE], [1, a.nE, a.nE + b.nE]]);
    expect(f.drops).toEqual(Object.fromEntries([...new Set([...Object.keys(a.drops), ...Object.keys(b.drops)])].map((k) => [k, (a.drops[k] ?? 0) + (b.drops[k] ?? 0)])));
    // a frame with a key the merge does not know is refused, never merged short of a field
    expect(() => mergeFrames([{ f: { ...a, extra: new Uint8Array(1) } as unknown as Frame, off: 0 }], a.census)).toThrow(/keys the merge does not know: extra/);
  });
});

// ── clusters, weights, stints ───────────────────────────────────────────────────────────────────────────────────────

describe('regime-challenge round 3: UTC-day clusters and equal weights per coin-month, on the panel\'s months only', () => {
  let f: Frame;
  // SYNA in the panel all five months; SYNB in March and April only
  const P: PanelMonths = {
    '2024-01': { pos: new Set([0]), n: 1 }, '2024-02': { pos: new Set([0]), n: 1 }, '2024-03': { pos: new Set([0, 1]), n: 2 },
    '2024-04': { pos: new Set([0, 1]), n: 2 }, '2024-05': { pos: new Set([0]), n: 1 },
  };
  const WHOLE: PanelMonths = Object.fromEntries(Object.keys(P).map((m) => [m, { pos: new Set([0, 1]), n: 1 }]));
  beforeAll(() => { f = chunkedFrame(SYN_SPAN, SYN_FIT, ['SYNA', 'SYNB'], WTF, synFullLoad, { outcomes: false, seed: 's' }); }, 120_000);

  it('every panel entry of a UTC day sits in that day\'s one cluster, in one stratum; an entry out of the panel has no cluster and no weight', { timeout: 60_000 }, () => {
    const ctx = r3Context(f, P, 'day');
    const dayCl = new Map<number, number>();
    let out = 0, shared = 0;
    for (let e = 0; e < f.nE; e++) {
      const ym = monthAt(f.eM[e]), inside = P[ym].pos.has(f.ePos[e]);
      if (!inside) {
        out++;
        expect(ctx.clOf[e]).toBe(-1);
        for (let t = 0; t < N_TF; t++) expect(ctx.w[e * N_TF + t]).toBe(0);
        continue;
      }
      const d = dayOf(f.eM[e]);
      if (dayCl.has(d)) { if (f.ePos[e] === 1) shared++; expect(ctx.clOf[e]).toBe(dayCl.get(d)); } else dayCl.set(d, ctx.clOf[e]);
      for (let t = 0; t < N_TF; t++) expect(ctx.w[e * N_TF + t]).toBe(WTF[t] / P[ym].n);
    }
    expect(out).toBeGreaterThan(0);
    expect(shared).toBeGreaterThan(0);
    expect([ctx.nCl, ctx.nStrata, new Set(ctx.strata).size, ctx.strata[0]]).toEqual([dayCl.size, 1, 1, 0]);
    const cd = r3Context(f, P, 'coinday');
    expect(cd.nStrata).toBe(2);
    expect(cd.nCl).toBeGreaterThan(ctx.nCl);
    expect(Array.from(cd.w)).toEqual(Array.from(ctx.w));
  });

  it('with every coin in the panel and one coin a month, the contexts are the pinned engine\'s day and coin × day contexts', { timeout: 60_000 }, () => {
    for (const [mine, theirs] of [[r3Context(f, WHOLE, 'day'), context(f, 'day')], [r3Context(f, WHOLE, 'coinday'), context(f)]] as const) {
      expect([mine.nCl, mine.nStrata, Array.from(mine.clOf), Array.from(mine.strata)]).toEqual([theirs.nCl, theirs.nStrata, Array.from(theirs.clOf), Array.from(theirs.strata)]);
      expect(Array.from(mine.w)).toEqual(Array.from(theirs.w));
    }
  });

  it('a stint is a coin\'s consecutive panel months: A5 reads each coin inside its stints, and pairOf\'s sequences when the stint is the window', { timeout: 120_000 }, () => {
    expect(stintsOf(f, P)).toEqual([{ pos: 0, lo: SYN_FIT.lo, hi: SYN_FIT.hi }, { pos: 1, lo: minute('2024-03'), hi: minute('2024-05') }]);
    const gap: PanelMonths = { ...P, '2024-04': { pos: new Set([0]), n: 1 }, '2024-05': { pos: new Set([0, 1]), n: 2 } };
    expect(stintsOf(f, gap).filter((s) => s.pos === 1)).toEqual([{ pos: 1, lo: minute('2024-03'), hi: minute('2024-04') }, { pos: 1, lo: minute('2024-05'), hi: SYN_FIT.hi }]);
    // a month absent from the panel's months ends every stint it would have joined
    const noApril: PanelMonths = Object.fromEntries(Object.entries(P).filter(([m]) => m !== '2024-04'));
    expect(stintsOf(f, noApril)).toEqual([
      { pos: 0, lo: SYN_FIT.lo, hi: minute('2024-04') }, { pos: 0, lo: minute('2024-05'), hi: SYN_FIT.hi },
      { pos: 1, lo: minute('2024-03'), hi: minute('2024-04') },
    ]);
    const whole = stintsOf(f, WHOLE);
    const cols = challengerColumns(f, synFullLoad, [cand('C2').dial as NonNullable<Candidate['dial']>]);
    for (const id of ['C4.45', 'C3', 'C2']) {
      const theirs = stats.pairOf(f, cand(id), cols), mine = r3Pair(f, cand(id), cols, whole);
      expect([mine.chalSeqs, mine.servSeqs], id).toEqual([theirs.chalSeqs, theirs.servSeqs]);
      expect(mine.chal60, id).toEqual(theirs.chal60);
    }
    const inside = r3Pair(f, cand('C4.45'), null, stintsOf(f, P)).servSeqs.filter((q) => q.pos === 1);
    expect(inside.length).toBe(N_TF);
    for (const q of inside) for (const j of Array.from(q.j)) { const m = j * TFS[q.t].min; if (m < minute('2024-03') || m >= minute('2024-05')) throw new Error(`a close of position 1 at ${monthAt(m)} is outside its stint`); }
  });

  it('A5\'s runs take the weight of their first close\'s month, their UTC day as the cluster, one stratum', () => {
    const by = a5By(f, P);
    const run = (pos: number, ym: string, t: number): Run => ({ seq: 0, block: 0, i0: 0, j0: Math.floor((minute(ym) + 9 * 1440) / TFS[t].min), len: 2, pos, t, up: true, y: 1, signed: 1 });
    expect([by.weight(run(1, '2024-03', 1)), by.weight(run(0, '2024-01', 0)), by.weight(run(1, '2024-01', 1))]).toEqual([WTF[1] / 2, WTF[0], 0]);
    expect([by.key(run(0, '2024-03', 1)), by.key(run(1, '2024-03', 2)), by.stratum(run(1, '2024-03', 1))]).toEqual([dayOf(minute('2024-03') + 9 * 1440), dayOf(minute('2024-03') + 9 * 1440), 0]);
  });

  it('A5\'s sums with a RunBy: each run in the cluster its key names, at its weight, in its stratum; without one, round 1\'s coin × day clusters', { timeout: 60_000 }, () => {
    const seqs = r3Pair(f, cand('C4.45'), null, stintsOf(f, P)).servSeqs, by = a5By(f, P), calls: Run[] = [];
    const spy: stats.RunBy = { weight: (r) => { calls.push(r); return by.weight(r); }, key: by.key, stratum: by.stratum };
    const mine = stats.armSums(f.census, seqs, 20, 7, spy), theirs = stats.armSums(f.census, seqs, 20, 7);
    expect(calls.length).toBeGreaterThan(0);
    expect([mine.runs, mine.unreferenced, calls.length]).toEqual([theirs.runs, theirs.unreferenced, theirs.runs - theirs.unreferenced]);
    expect([...mine.clusters.keys()].sort((a, b) => a - b)).toEqual([...new Set(calls.map(by.key))].sort((a, b) => a - b));
    expect([...mine.clusters.values()].every((c) => c.pos === 0)).toBe(true);
    const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
    expect(sum([...mine.clusters.values()].map((c) => c.w))).toBeCloseTo(sum(calls.map(by.weight)), 12);
    expect(calls.some((r) => by.weight(r) !== WTF[r.t])).toBe(true);
    expect([...theirs.clusters.entries()].every(([k, c]) => Math.floor(k / 100_000) === c.pos)).toBe(true);
    expect(new Set([...theirs.clusters.values()].map((c) => c.pos))).toEqual(new Set([0, 1]));
  });

  it('the strata tables count the panel\'s rows, label-free', () => {
    const s = strataOf(f, P);
    let entries = 0;
    const rows = [0, 0, 0];
    for (let e = 0; e < f.nE; e++) {
      if (monthAt(f.eM[e]) !== '2024-03') continue;
      entries++;
      for (let t = 0; t < N_TF; t++) if (f.has[e * N_TF + t]) rows[t]++;
    }
    expect([s['2024-03'].coins, s['2024-03'].entries, s['2024-03'].rows]).toEqual([2, entries, rows]);
    expect(s['2024-01'].coins).toBe(1);
  });
});

// ── the record, its months, its stores ─────────────────────────────────────────────────────────────────────────────

describe('regime-challenge round 3: the pre-score\'s months, both ways, and the one store and home it uses', () => {
  it('the pre-score opens 2024-01 … 2025-12 only, for an outcome and for an archive; 2020–23 and 2026 are refused', () => {
    const ALLM = months('2019-09', '2026-12');
    for (const use of ['outcome', 'archive'] as const) expect(ALLM.filter((ym) => monthRefusal(r3.R3_PRESCORE, ym, use) === null)).toEqual(months('2024-01', '2025-12'));
    expect(r3.r3WindowRefusal(r3.R3_PRESCORE)).toBeNull();
    const bad: Array<Partial<ChallengeRecord>> = [
      { outcomes: { first: '2023-12', last: '2024-05' } }, { archives: { first: '2020-01', last: '2024-05' } },
      { outcomes: { first: '2025-06', last: '2026-01' } }, { archives: { first: '2024-01', last: '2026-01' } },
    ];
    for (const b of bad) expect(r3.r3WindowRefusal({ ...r3.R3_PRESCORE, ...b })).toMatch(/round 3's pre-score reads (outcome|archive) months of 2024-01 … 2025-12 only/);
    expect([r3.R3_PRESCORE.id, r3.R3_PRESCORE.file, r3.R3_PRESCORE.line, r3.R3_PRESCORE.seal, r3.R3_JUDGE_OUTCOMES]).toEqual(['challenge-r3-prescore', 'regime-challenge-r3-prescore.json', 'REGIME_CHALLENGE_R3_PRESCORE', null, { first: '2020-01', last: '2023-12' }]);
    expect(r3.R3_CANDIDATES.map((c) => c.id)).toEqual(['C1.7', 'C1.10', 'C2', 'C3', 'C4.45', 'C4.55', 'C5.50', 'C5.70']);
    expect(REQUIRED_PINS.filter((p) => p.includes('challenge-r3'))).toEqual(['src/scripts/regime-challenge/challenge-r3.ts', 'src/scripts/regime-challenge/challenge-r3-frame.ts', 'src/scripts/regime-challenge/challenge-r3-screen.ts']);
  });

  it('the archives are round 3\'s 2024–25 store and no other; the output lies only in round 3\'s home under the cache', () => {
    const cache = path.join(TEST_HOMEDIR, '.cache', 'algovault');
    const at = (...p: string[]): ArchiveStore => ({ cache: path.join(cache, ...p), overlay: path.join(cache, ...p) });
    expect(r3.r3ArchiveRoot()).toBe(path.join(cache, 'regime-challenge-r3', 'archives', '1m-2024-25'));
    expect(r3.r3ArchivesRefusal(at('regime-challenge-r3', 'archives', '1m-2024-25'))).toBeNull();
    for (const p of [['regime-challenge-r3', 'archives', '1m-2020-23'], ['odds-calibration-study'], ['regime-diag', 'archives'], ['regime-diag', 'store'], ['regime-challenge-r2'], ['regime-challenge'], ['regime-challenge-r3']]) {
      expect(r3.r3ArchivesRefusal(at(...p)), p.join('/')).toMatch(/is not round 3's 2024–25 store/);
    }
    const store = at('regime-challenge-r3', 'archives', '1m-2024-25');
    expect(outRefusal(path.join(cache, 'regime-challenge-r3', 'out'), r3.R3_HOME, guard.sealHome(), store)).toBeNull();
    expect(outRefusal(path.join(cache, 'regime-challenge-r2', 'out'), r3.R3_HOME, guard.sealHome(), store)).toMatch(/outside regime-challenge-r3\//);
    expect(outRefusal(path.join(store.cache, 'x'), r3.R3_HOME, guard.sealHome(), store)).toMatch(/an archive store the run reads/);
  });

  it('the panel: its coins, its months\' sizes, and each coin\'s archive months m − 4 … m + 1 clipped to the record and the store', () => {
    const file: r3.PanelFile = {
      kind: 'regime-challenge-r3-panel', rule: { served: ['XQSRV'], stable: [], assetBacked: [], indexAbsent: [] },
      archive_months: { XQAUSDT: months('2024-01', '2024-08'), XQBUSDT: months('2024-01', '2025-12'), XQCUSDT: months('2024-01', '2024-06'), XQSRVUSDT: months('2024-01', '2025-12') },
      table: { XQBUSDT: { '2024-01': 'panel', '2025-12': 'panel' }, XQAUSDT: { '2020-05': 'panel', '2024-06': 'panel', '2024-07': 'thin' }, XQCUSDT: { '2024-03': 'thin' }, XQSRVUSDT: { '2024-03': 'served' } },
    };
    const p = r3.panelOf(file, r3.R3_PRESCORE) as r3.R3Panel;
    expect([p.symbols, p.names]).toEqual([['XQAUSDT', 'XQBUSDT'], ['XQA', 'XQB']]);
    expect([...(p.allowed.get('XQA') as Set<string>)].sort()).toEqual(months('2024-02', '2024-07'));
    expect([...(p.allowed.get('XQB') as Set<string>)].sort()).toEqual(['2024-01', '2024-02', ...months('2025-08', '2025-12')]);
    expect([p.months['2024-06'], p.months['2024-01'], p.months['2024-03']]).toEqual([{ pos: new Set([0]), n: 1 }, { pos: new Set([1]), n: 1 }, { pos: new Set(), n: 0 }]);
    expect([p.sizes.prescore['2024-06'], p.sizes.prescore['2024-03'], Object.keys(p.sizes.prescore).length, p.sizes.judge['2020-05'], p.sizes.judge['2020-06'], Object.keys(p.sizes.judge).length]).toEqual([1, 0, 24, 1, 0, 48]);
    expect(r3.panelOf({ ...file, table: { ...file.table, XQSRVUSDT: { '2024-03': 'panel' } } }, r3.R3_PRESCORE)).toMatch(/the panel holds a coin of the served segment/);
    expect(r3.panelOf({ ...file, kind: 'x' }, r3.R3_PRESCORE)).toBe('the panel file is malformed');
  });

  it('the CLI takes exactly one mode and known valued flags, each once', () => {
    expect(r3.r3ArgvRefusal(['--prescore', '--out', 'x'])).toBeNull();
    expect(r3.r3ArgvRefusal(['--prescore', '--judge'])).toBe('unknown argument \'--judge\'');
    expect(r3.r3ArgvRefusal(['--prescore', '--strata'])).toMatch(/exactly one of/);
    expect(r3.r3ArgvRefusal(['--out', 'x'])).toMatch(/exactly one of/);
    expect(r3.r3ArgvRefusal(['--prescore', '--out'])).toBe('--out needs a value');
    expect(r3.r3ArgvRefusal(['--prescore', '--out', 'a', '--out', 'b'])).toBe('--out is given twice');
  });
});

// ── selection and the gate ──────────────────────────────────────────────────────────────────────────────────────────

describe('regime-challenge round 3: at most three dials by largest point, then the power gate', () => {
  const row = (id: string, point: number, guards: PrescoreRow['guards'] = ['holds', 'holds', 'holds']): PrescoreRow => ({ id: id as PrescoreRow['id'], challenger: cand(id).challenger, identifiable: true, point, guards });

  it('round 1\'s rule picks one value per dial; the three largest points go forward, a tie to the dial listed first', () => {
    const rows = [row('C1.7', 1), row('C1.10', 2), row('C2', 0.5), row('C3', 3), row('C4.45', -1), row('C4.55', 0.2), row('C5.50', 9, ['holds', 'fails', 'holds']), row('C5.70', 1)];
    const m = r3.membersOf(rows);
    expect(m.judged).toEqual(['C1.10', 'C2', 'C3', 'C4.55']);
    expect(m.members).toEqual(['C3', 'C1.10', 'C2']);
    expect(m.verdicts).toEqual({ C1: 'JUDGE', C2: 'JUDGE', C3: 'JUDGE', C4: 'KEEP (pre-score)', C5: 'KEEP (pre-score)' });
    expect(m.causes.C4).toBe('C4.55: its point is not among the 3 largest of the dials selected');
    const tie = r3.membersOf([row('C1.7', 1), row('C2', 1), row('C3', 1), row('C4.45', 1), row('C5.70', 1)]);
    expect(tie.members).toEqual(['C1.7', 'C2', 'C3']);
  });

  it('the gate recovers ρ from the design effect and moves the day-cluster SE to the smaller judge panel', () => {
    // a known world: σ² = 1, ρ = 0.27, mean(1/n) 0.005 over 700 days in sample, 0.02 over 1,200 days in the judge window
    const rho = 0.27, pre = { days: 700, meanInvN: 0.005 }, judge = { days: 1200, meanInvN: 0.02 };
    const seDay = Math.sqrt((rho + (1 - rho) * pre.meanInvN) / pre.days), seCd = Math.sqrt(pre.meanInvN / pre.days);
    const g = r3.gateOf({ point: 0.8, hDay: 1.96 * seDay, hCoinDay: 1.96 * seCd, pre, judge });
    expect(g.rho).toBeCloseTo(rho, 12);
    const seJ = Math.sqrt((rho + (1 - rho) * judge.meanInvN) / judge.days);
    expect(g.power.se).toBeCloseTo(seJ, 12);
    expect(g.power.multiple).toBeCloseTo((2.8 * seJ / 0.4) ** 2, 9);
    expect(g.passes).toBe(g.power.multiple <= 1);
    // clamped to [0, 1], the raw value kept
    const lo = r3.gateOf({ point: 1, hDay: 0.1, hCoinDay: 0.2, pre, judge }), hi = r3.gateOf({ point: 1, hDay: 10, hCoinDay: 0.01, pre, judge });
    expect([lo.rho, lo.rho_raw < 0, hi.rho, hi.rho_raw > 1]).toEqual([0, true, 1, true]);
    // a large point passes, a small one does not
    expect([r3.gateOf({ point: 100, hDay: 1.96 * seDay, hCoinDay: 1.96 * seCd, pre, judge }).passes, r3.gateOf({ point: 1e-6, hDay: 1.96 * seDay, hCoinDay: 1.96 * seCd, pre, judge }).passes]).toEqual([true, false]);
  });

  it('the days of a panel: each day of a month once, at the month\'s size; an empty month adds none', () => {
    expect(r3.dayPanel({ '2024-02': 2, '2024-03': 0, '2024-04': 1 })).toEqual({ days: 59, meanInvN: (29 / 2 + 30) / 59 });
  });
});

// ── the pre-score, in a sandbox repository ──────────────────────────────────────────────────────────────────────────

const git = (repo: string, ...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const SYN_R3: ChallengeRecord = Object.freeze({ ...r3.R3_PRESCORE, span: SYN_PRESCORE.span, win: SYN_PRESCORE.win, outcomes: SYN_PRESCORE.outcomes, archives: SYN_PRESCORE.archives });
// the store holds the panel table's fetch and nothing else: SYNC's months end at April (its last panel month, March, + 1)
const MORE = [{ coin: 'SYNC', key: 'r3|C', last: '2024-04' }, { coin: 'SYND', key: 'r3|D', last: '2024-07' }];

describe('regime-challenge round 3: the pre-score, in a sandbox repository', () => {
  let dir = '', repo = '', censusFile = '', panelFile = '', manifest = '', out = '';
  let archives: ArchiveStore = { cache: '', overlay: '' };
  let pins = { census: '', archives: '', panel: '' };
  let pre: { verdict: string; reason: string; line: string | null; file: string | null };
  const lines: string[] = [];
  const json = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8')); // eslint-disable-line @typescript-eslint/no-explicit-any
  const study = (more: Partial<r3.R3Study> = {}): r3.R3Study => ({ rec: SYN_R3, counts: { boot: 200, shuffle: 50 }, floorClusters: 5, log: (l) => lines.push(l), pins, ...more });
  const input = (more: Partial<r3.R3Input> = {}): r3.R3Input => ({ repo, censusFile, panelFile, archives, manifest, out, study: study(), ...more });
  // SYNA in the panel every month; SYNB from February; SYNC January … March; SYND March … May; and 2020 counts for the gate
  const TABLE: Record<string, Record<string, string>> = {
    SYNAUSDT: { '2020-02': 'panel', '2020-03': 'panel', '2024-01': 'panel', '2024-02': 'panel', '2024-03': 'panel', '2024-04': 'panel', '2024-05': 'panel' },
    SYNBUSDT: { '2020-03': 'panel', '2024-01': 'unseasoned', '2024-02': 'panel', '2024-03': 'panel', '2024-04': 'panel', '2024-05': 'panel' },
    SYNCUSDT: { '2024-01': 'panel', '2024-02': 'panel', '2024-03': 'panel', '2024-04': 'thin', '2024-05': 'thin' },
    SYNDUSDT: { '2024-01': 'thin', '2024-02': 'thin', '2024-03': 'panel', '2024-04': 'panel', '2024-05': 'panel' },
  };
  const panelText = (table = TABLE, served = ['XQSRV']): string => `${JSON.stringify({ kind: 'regime-challenge-r3-panel', rule: { served, stable: [], assetBacked: [], indexAbsent: [] }, archive_months: Object.fromEntries(Object.keys(table).map((s) => [s, months('2024-01', '2024-08')])), table }, null, 1)}\n`;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-challenge-r3-'));
    repo = path.join(dir, 'repo'); censusFile = path.join(dir, 'census.json'); panelFile = path.join(dir, 'panel.json'); manifest = path.join(dir, 'archives.json');
    const root = r3.r3ArchiveRoot();
    archives = { cache: root, overlay: root };
    out = path.join(TEST_HOMEDIR, '.cache', 'algovault', 'regime-challenge-r3', 'out', 'pre');
    for (const d of [root, path.join(dir, 'no-hooks')]) fs.mkdirSync(d, { recursive: true });
    git(dir, 'init', '-q', '--bare', '--initial-branch=main', 'origin.git');
    git(dir, 'init', '-q', '--initial-branch=main', 'repo');
    for (const [k, v] of [['user.email', 'sandbox@example.invalid'], ['user.name', 'sandbox'], ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(dir, 'no-hooks')]]) git(repo, 'config', k, v);
    git(repo, 'remote', 'add', 'origin', path.join(dir, 'origin.git'));
    for (const rel of [...guard.HARNESS_FILES, ...REQUIRED_PINS]) {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.cpSync(path.join(REPO, rel), path.join(repo, rel));
      git(repo, 'add', rel);
    }
    git(repo, 'commit', '-q', '-m', 'the harness');
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    expect(writeSynArchives(archives).length).toBeGreaterThan(10);
    for (const s of MORE) {
      const by = new Map<string, string[]>();
      for (const l of synthCsv(SYN_SPAN, s.key).split('\n')) { if (!l) continue; const ym = new Date(Number(l.slice(0, l.indexOf(',')))).toISOString().slice(0, 7); by.set(ym, [...(by.get(ym) ?? []), l]); }
      for (const [ym, rows] of by) { if (ym > s.last) continue; const name = archiveName(s.coin, '1m', ym); fs.writeFileSync(path.join(root, name), zipSingle(name.replace('.zip', '.csv'), Buffer.from(`${rows.join('\n')}\n`))); }
    }
    fs.writeFileSync(censusFile, SYN_CENSUS_TEXT);
    fs.writeFileSync(panelFile, panelText());
    const panel = r3.panelOf(json(panelFile), SYN_R3) as r3.R3Panel;
    fs.writeFileSync(manifest, r3.r3ManifestText(archives, panel));
    pins = { census: sha256(SYN_CENSUS_TEXT), archives: sha256(fs.readFileSync(manifest)), panel: sha256(fs.readFileSync(panelFile)) };
    pre = r3.r3PrescoreRun(input());
    expect([pre.verdict, pre.reason]).toEqual(['PASS', 'ok']);
  }, 600_000);
  afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it('the pre-score reads its own months, candidates and names, on the panel\'s coins with day clusters', { timeout: 60_000 }, () => {
    const o = json(pre.file as string);
    expect([o.wave, o.kind, o.study, o.record, o.seed, o.clusters]).toEqual(['EDGE-REGIME-CHALLENGE-R3-W1', 'prescore', 'injected', 'challenge-r3-prescore', 'regime-challenge-r3', 'utc-day']);
    expect(o.months_opened).toEqual(['2024-01', '2024-02', '2024-03', '2024-04', '2024-05']);
    expect(Object.keys(o.candidates)).toEqual(r3.R3_CANDIDATES.map((c) => c.id));
    expect(o.panel).toEqual({ coins: 4, sizes: { prescore: { '2024-01': 2, '2024-02': 3, '2024-03': 4, '2024-04': 3, '2024-05': 3 }, judge: { ...Object.fromEntries(months('2020-01', '2023-12').map((m) => [m, 0])), '2020-02': 1, '2020-03': 2 } } });
    expect(o.line).toMatch(/^REGIME_CHALLENGE_R3_PRESCORE=C1:[^;]+;C2:[^;]+;C3:[^;]+;C4:[^;]+;C5:[^;]+$/);
    expect(fs.readdirSync(out).sort()).toEqual(['regime-challenge-r3-prescore.json', 'regime-challenge-r3-prescore.log']);
    const log = fs.readFileSync(path.join(out, r3.R3_LOG), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(log.map((e) => [e.record, e.ok, e.leg])).toEqual([['challenge-r3-prescore', true, 'frame'], ['challenge-r3-prescore', true, 'outcomes'], ['challenge-r3-prescore', true, 'result']]);
    expect(log[0].strata_sha256).toBe(o.strata_sha256);
  });

  it('the selection is round 1\'s rule then the three largest; each member\'s gate is the arithmetic of its recorded inputs', { timeout: 60_000 }, () => {
    const o = json(pre.file as string);
    const rows: PrescoreRow[] = r3.R3_CANDIDATES.map((c) => { const x = o.candidates[c.id]; return { id: c.id, challenger: c.challenger, identifiable: x.support.identifiable, point: x.ddelta1?.point ?? NaN, guards: [x.a4?.guard ?? 'unreadable', x.a5?.guard ?? 'unreadable', x.coverage.guard] }; });
    const m = r3.membersOf(rows);
    expect([o.selection.judged, o.selection.members]).toEqual([m.judged, m.members]);
    expect(Object.keys(o.gate)).toEqual(m.members);
    const judgeDays = r3.dayPanel(o.panel.sizes.judge);
    expect(judgeDays).toEqual({ days: 60, meanInvN: (29 + 31 / 2) / 60 });
    for (const id of m.members) {
      const g = o.gate[id], x = o.candidates[id];
      expect(g.inputs).toEqual({ point: x.ddelta1.point, hDay: (x.ddelta1.ub - x.ddelta1.lb) / 2, hCoinDay: (x.ddelta1_coinday.ub - x.ddelta1_coinday.lb) / 2, pre: r3.dayPanel(o.panel.sizes.prescore), judge: judgeDays });
      expect(JSON.parse(JSON.stringify(r3.gateOf(g.inputs)))).toEqual(g);
      expect(o.selection.verdicts[cand(id).challenger]).toBe(g.passes ? 'JUDGE' : 'KEEP — underpowered before any read');
    }
  });

  it('the primary is ΔΔ1 on the panel\'s rows under UTC-day clusters and equal weights per coin-month, and A5 reads the stints', { timeout: 300_000 }, () => {
    const o = json(pre.file as string);
    const panel = r3.panelOf(json(panelFile), SYN_R3) as r3.R3Panel;
    const f = chunkedFrame(SYN_R3.span, SYN_R3.win, panel.names, WTF, r3.r3Loader(SYN_R3, archives, panel, new Map()), { outcomes: false, seed: SYN_R3.entrySeed });
    const fo = withOutcomes(f, r3.r3Loader(SYN_R3, archives, panel, new Map()));
    const id = r3.R3_CANDIDATES.find((c) => c.arm && o.candidates[c.id].support.identifiable)?.id as string;
    const keys = [`${id}|ddelta1|bootstrap`, `${id}|a5|shuffle`, 'served|a5|shuffle', `${id}|a5|bootstrap`].map((k) => `challenge-r3-prescore|${k}`);
    const [sDd, sCh, sSv, sA5] = seedsFor(r3.R3_SEED, keys);
    const pair = r3Pair(f, cand(id), null, stintsOf(f, panel.months));
    const want = stats.deltaDelta1(fo, r3Context(f, panel.months, 'day'), pair, { B: 200, alpha: ALPHA, seed: sDd, arms: true });
    expect([o.candidates[id].ddelta1.point, o.candidates[id].ddelta1.lb, o.candidates[id].ddelta1.ub, o.candidates[id].ddelta1.clusters]).toEqual([want.point, want.lb, want.ub, want.clusters]);
    // the clusters are days: no more than the window's days
    expect(want.clusters).toBeLessThanOrEqual(SYN_FIT.hi / 1440);
    // A5 on the stints' series, the runs weighed per coin-month and clustered by UTC day in one stratum
    const by = a5By(f, panel.months);
    const a5 = stats.a5Ratio(fo.census, id, stats.armSums(fo.census, pair.chalSeqs, 50, sCh, by), stats.armSums(fo.census, pair.servSeqs, 50, sSv, by), { B: 200, alpha: ALPHA, seed: sA5, arms: true });
    expect([o.candidates[id].a5.point, o.candidates[id].a5.lb, o.candidates[id].a5.ub, o.candidates[id].a5.clusters]).toEqual([a5.point, a5.lb, a5.ub, a5.clusters]);
  });

  it('refusals come before anything is written: the output, the window, the store, the panel and the pins', { timeout: 120_000 }, () => {
    const cache = path.join(TEST_HOMEDIR, '.cache', 'algovault');
    const cases: Array<[Partial<r3.R3Input>, RegExp]> = [
      [{ out: path.join(cache, 'regime-challenge-r2', 'out') }, /outside regime-challenge-r3\//],
      [{ out: path.join(repo, 'tmp-r3-out') }, /must sit outside the repository/],
      [{ study: study({ rec: { ...SYN_R3, outcomes: { first: '2023-12', last: '2024-05' } } }) }, /reads outcome months of 2024-01 … 2025-12 only/],
      [{ study: study({ rec: { ...SYN_R3, archives: { first: '2020-01', last: '2024-05' } } }) }, /reads archive months of 2024-01 … 2025-12 only/],
      [{ archives: { cache: path.join(cache, 'regime-challenge-r3', 'archives', '1m-2020-23'), overlay: path.join(cache, 'regime-challenge-r3', 'archives', '1m-2020-23') } }, /is not round 3's 2024–25 store/],
    ];
    for (const [more, why] of cases) {
      const o = more.out ?? path.join(dir, `refused-${Math.random().toString(36).slice(2)}`);
      const r = r3.r3PrescoreRun(input({ ...more, out: o }));
      expect([r.verdict, r.reason], String(why)).toEqual(['REFUSED', expect.stringMatching(why)]);
      expect(fs.existsSync(o), o).toBe(false);
    }
    const o2 = path.join(dir, 'refused-pins');
    for (const [p, why] of [[{ ...pins, panel: '0'.repeat(64) }, /the panel file is not the registered one/], [{ ...pins, archives: '0'.repeat(64) }, /the archive manifest is not the registered one/], [{ ...pins, census: '0'.repeat(64) }, /the census is not the registered one/]] as const) {
      const r = r3.r3PrescoreRun(input({ out: o2, study: study({ pins: p }) }));
      expect([r.verdict, r.reason]).toEqual(['REFUSED', expect.stringMatching(why)]);
      expect(fs.readdirSync(o2)).toEqual([r3.R3_LOG]);
    }
    // a panel that holds a coin of the served segment is refused: the served segment never enters the alt frame
    fs.writeFileSync(path.join(dir, 'served-panel.json'), panelText(TABLE, ['SYNC']));
    const served = r3.r3PrescoreRun(input({ out: o2, panelFile: path.join(dir, 'served-panel.json'), study: study({ pins: { ...pins, panel: sha256(fs.readFileSync(path.join(dir, 'served-panel.json'))) } }) }));
    expect([served.verdict, served.reason]).toEqual(['REFUSED', expect.stringMatching(/the panel holds a coin of the served segment/)]);
  });

  it('the loader opens a coin\'s allowed months only: a file on disk at a month its table does not allow throws', { timeout: 60_000 }, () => {
    const panel = r3.panelOf(json(panelFile), SYN_R3) as r3.R3Panel;
    expect(panel.names).toEqual(['SYNA', 'SYNB', 'SYNC', 'SYND']);
    expect([...(panel.allowed.get('SYNC') as Set<string>)].sort()).toEqual(['2024-01', '2024-02', '2024-03', '2024-04']);
    const opened = new Map<string, number>();
    expect(r3.r3Loader(SYN_R3, archives, panel, opened)(2).g).not.toBeNull();
    expect([...opened.keys()].sort()).toEqual(['2024-01', '2024-02', '2024-03', '2024-04']);
    const narrow: r3.R3Panel = { ...panel, allowed: new Map([...panel.allowed, ['SYNC', new Set(['2024-01', '2024-02', '2024-03'])]]) };
    expect(() => r3.r3Loader(SYN_R3, archives, narrow, new Map())(2)).toThrow(/an archive of position 3 at 2024-04 lies outside the months the panel table allows it/);
  });

  it('the strata run writes the label-free tables the pre-score recorded', { timeout: 300_000 }, () => {
    const o = json(pre.file as string);
    const r = r3.r3StrataRun(input({ out: path.join(TEST_HOMEDIR, '.cache', 'algovault', 'regime-challenge-r3', 'out', 'strata') }));
    expect(r.verdict).toBe('PASS');
    const s = json(r.file as string);
    expect(s.strata).toEqual(o.strata);
    expect(`${JSON.stringify(s.strata, null, 1)}\n`).toBe(`${JSON.stringify(o.strata, null, 1)}\n`);
    expect(sha256(`${JSON.stringify(s.strata, null, 1)}\n`)).toBe(o.strata_sha256);
  });
});

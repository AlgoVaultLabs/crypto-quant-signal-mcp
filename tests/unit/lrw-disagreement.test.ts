import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

// EDGE-LABELER-RACE-WINDOW-V2-W1 CH3 — the registered disagreement table (registration §4, §4.1, §5), on
// hand-computed fixtures. Synthetic rows only.

import {
  parseExtract, parseStrata, axesOf, newAcc, addRow, readAcc, comparators, buildTable, renderMarkdown, E_CELLS, E4_PAIRS,
  HEADER_CLAUSE, parsePullMeta, main, gridClass, type ExtractRow, type Strata,
} from '../../src/scripts/lrw/disagreement.js';
import { EXTRACT_HEADER } from '../../src/scripts/lrw/extract-sql.js';
import { T_CUT_EPOCH } from '../../src/scripts/lrw/registered.js';
import { coarserV1LagTable } from '../../src/scripts/backfill-directional-labels.js';

const T0 = 1789000000; // inside T_CAP, after T_FLIP
const empty = (): Strata => ({ worklist: new Map(), delta: new Map(), crossed: new Map(), retiredUc: new Set(), manifest: new Map(), adapterBefore: new Set() });
const row = (o: Partial<ExtractRow> & { id: number }): ExtractRow => ({
  createdAt: T0, exchange: 'BINANCE', coin: 'BTC', timeframe: '1h', side: 'BUY', spec: 'tau1.0-floor0.30-v1',
  labelV1: 1, ambV1: false, lowvolV1: false, barrierV1: 1, gapV1: 0, computedV1: T0 + 3600, hasV2: true,
  labelV2: 1, ambV2: false, barrierV2: 1, ...o,
});
const csvLine = (r: ExtractRow) => [r.id, r.createdAt, r.exchange, r.coin, r.timeframe, r.side, r.spec, r.labelV1, r.ambV1 ? 't' : 'f',
  r.lowvolV1 ? 't' : 'f', r.barrierV1, r.gapV1 ?? '', r.computedV1, r.hasV2 ? 't' : 'f', r.labelV2 ?? '', r.ambV2 === null ? '' : r.ambV2 ? 't' : 'f', r.barrierV2 ?? ''].join(',');

describe('parsing — the allow-list header, typed or refused', () => {
  it('parses a twin and a non-twin; refuses a drifted header, a bad side or a bad boolean', () => {
    const a = row({ id: 1 });
    const b = row({ id: 2, hasV2: false, labelV2: null, ambV2: null, barrierV2: null, gapV1: null });
    const text = [EXTRACT_HEADER.join(','), csvLine(a), csvLine(b)].join('\n');
    expect(parseExtract(text)).toEqual([a, b]);
    expect(() => parseExtract(text.replace('label_v1', 'labelv1'))).toThrow(/header/);
    expect(() => parseExtract(text.replace(',BUY,', ',LONG,'))).toThrow(/side/);
    expect(() => parseExtract(text.replace(',t,1,', ',x,1,'))).toThrow();
  });

  it('strata: worklist / delta / crossed / retired-uc keyed (signal, spec); the manifest by signal', () => {
    const s = parseStrata({
      worklist: 'signal_id,barrier_spec,gap_served_L,gap_served_U,gap_served_Uc,ambiguous_L_Uc,tail_served_L,gap_requested_L,sigma_holes_L,forming\n5,tau1.0-floor0.30-v1,2,2,2,1,0,2,3,0',
      delta: 'signal_id,barrier_spec,gap_served_L,sigma_holes_L\n6,tau1.0-floor0.30-v1,1,0',
      crossed: 'signal_id,barrier_spec,crossed_L,fwd_len_L\n5,tau1.0-floor0.30-v1,0,8',
      retiredUc: 'signal_id,barrier_spec,gap_served_L,gap_served_Uc_worklist,gap_served_Uc_with_retired\n7,tau1.0-floor0.30-v1,0,0,2',
      adapterBefore: 'signal_id,barrier_spec\n11,tau1.0-floor0.30-v2\n11,tau0.5-floor0.30-v2',
      manifest: ['noise\nLRW_MANIFEST 8 deferred\nLRW_MANIFEST 9 unreachable:history\n', 'LRW_MANIFEST 8 refused:gap\n'],
    });
    expect(s.worklist.get('5|tau1.0-floor0.30-v1')).toEqual({ sigmaHoles: 3, ambiguousUc: 1, forming: 0 });
    expect(s.delta.get('6|tau1.0-floor0.30-v1')).toEqual({ sigmaHoles: 0 });
    expect(s.crossed.get('5|tau1.0-floor0.30-v1')).toBe(0);
    expect(s.retiredUc.has('7|tau1.0-floor0.30-v1')).toBe(true);
    expect([...s.manifest.entries()]).toEqual([[8, 'refused:gap'], [9, 'unreachable:history']]); // the later log wins
    // the pre-T_ADAPTER -v2 rows are keyed on their -v1 twin's spec
    expect([...s.adapterBefore].sort()).toEqual(['11|tau0.5-floor0.30-v1', '11|tau1.0-floor0.30-v1']);
  });

  it('a header-only stratum is a wrong file, not an empty stratum; an unregistered manifest class refuses', () => {
    const ok = {
      worklist: 'signal_id,barrier_spec,gap_served_L,gap_served_U,gap_served_Uc,ambiguous_L_Uc,tail_served_L,gap_requested_L,sigma_holes_L,forming\n5,tau1.0-floor0.30-v1,2,2,2,1,0,2,3,0',
      delta: 'signal_id,barrier_spec,gap_served_L,sigma_holes_L\n6,tau1.0-floor0.30-v1,1,0',
      crossed: 'signal_id,barrier_spec,crossed_L,fwd_len_L\n5,tau1.0-floor0.30-v1,0,8',
      retiredUc: 'signal_id,barrier_spec,gap_served_L,gap_served_Uc_worklist,gap_served_Uc_with_retired\n7,tau1.0-floor0.30-v1,0,0,2',
      adapterBefore: 'signal_id,barrier_spec\n',
      manifest: [''],
    };
    expect(() => parseStrata(ok)).not.toThrow();
    expect(() => parseStrata({ ...ok, delta: 'signal_id,barrier_spec,gap_served_L,sigma_holes_L\n' })).toThrow(/delta: no data row/);
    expect(() => parseStrata({ ...ok, manifest: ['LRW_MANIFEST 8 error'] })).toThrow(/registered form/);
    // the pinned pre-T_ADAPTER snapshot may be empty (pinned by sha), but its header and its -v2 rows are checked
    expect(() => parseStrata({ ...ok, adapterBefore: 'id,spec\n' })).toThrow(/adapter-before: header/);
    expect(() => parseStrata({ ...ok, adapterBefore: 'signal_id,barrier_spec\n11,tau1.0-floor0.30-v1' })).toThrow(/not a -v2 row/);
  });
});

describe('§4.1 strata of a row', () => {
  it('race gap, σ input, crossed, grid, WEEX-pre, phase, the BITGET 2h/8h cell, model ambiguity, provenance', () => {
    const s = empty();
    s.worklist.set('1|tau1.0-floor0.30-v1', { sigmaHoles: 0, ambiguousUc: 0, forming: 0 });
    s.worklist.set('2|tau1.0-floor0.30-v1', { sigmaHoles: 4, ambiguousUc: 1, forming: 0 });
    s.crossed.set('2|tau1.0-floor0.30-v1', 0);
    s.delta.set('3|tau1.0-floor0.30-v1', { sigmaHoles: 0 });
    expect(axesOf(row({ id: 1 }), s)).toMatchObject({ gap: '0', crossed: 'no-race-hole', sigmaChanged: 'no', grid: 'same', provenance: 'replay', modelAmbiguity: 'no', forming: 'no' });
    expect(axesOf(row({ id: 2, gapV1: 5 }), s)).toMatchObject({ gap: '3+', gapDetail: '5', crossed: 'zero-crossed', sigmaChanged: 'yes', modelAmbiguity: 'yes' });
    // the delta replay carries σ holes only: ambiguity and forming are UNKNOWN for its rows, never clean
    expect(axesOf(row({ id: 3, gapV1: 1 }), s)).toMatchObject({ gap: '1', crossed: 'unknown', provenance: 'delta', sigmaChanged: 'no', modelAmbiguity: 'unknown', forming: 'unknown' });
    expect(axesOf(row({ id: 4, exchange: 'GATE', timeframe: '3m', gapV1: null }), s)).toMatchObject({ gap: 'unannotated', crossed: 'unknown', grid: 'coarser', sigmaChanged: 'yes', provenance: 'none' });
    // a row in neither file: every file-borne fact unknown
    expect(axesOf(row({ id: 8 }), s)).toMatchObject({ sigmaChanged: 'unknown', modelAmbiguity: 'unknown', forming: 'unknown', provenance: 'none' });
    expect(axesOf(row({ id: 5, exchange: 'WEEX', timeframe: '30m', computedV1: 1788432899 }), s).weexPre).toBe(true);
    expect(axesOf(row({ id: 5, exchange: 'WEEX', timeframe: '30m', computedV1: 1788432900 }), s).weexPre).toBe(false);
    expect(axesOf(row({ id: 6, exchange: 'OKX', timeframe: '1d' }), s).phase).toBe(true);
    expect(axesOf(row({ id: 7, exchange: 'BITGET', timeframe: '8h' }), s)).toMatchObject({ adapterCell: true, phase: true });
    expect(axesOf(row({ id: 7, exchange: 'BITGET', timeframe: '4h' }), s).adapterCell).toBe(false);
    expect(gridClass('GATE', '2h')).toBe('finer');
  });

  it('E1 is the noise-floor conjunction and nothing looser — an unknown fact never passes as clean', () => {
    const s = empty();
    for (const id of [1, 2, 3, 4]) s.worklist.set(`${id}|tau1.0-floor0.30-v1`, { sigmaHoles: 0, ambiguousUc: 0, forming: 0 });
    s.delta.set('5|tau1.0-floor0.30-v1', { sigmaHoles: 0 });
    const ok = row({ id: 1 });
    expect(E_CELLS['E1 noise floor'](axesOf(ok, s))).toBe(true);
    for (const bad of [
      row({ id: 2, gapV1: 1 }), row({ id: 3, exchange: 'GATE', timeframe: '2h' }), row({ id: 4, exchange: 'OKX', timeframe: '12h' }),
      row({ id: 5 }), // delta-replay row: ambiguity / forming unknown
      row({ id: 6 }), // in no file
    ]) {
      expect(E_CELLS['E1 noise floor'](axesOf(bad, s))).toBe(false);
    }
  });
});

describe('§4 measures under the §5 floors', () => {
  it('P(differ), the transition matrix, decided / same-candle deltas, barrier ratio — on twins; low-vol and non-twins counted apart', () => {
    const s = empty();
    s.manifest.set(900, 'refused:gap');
    const a = newAcc();
    const rows: ExtractRow[] = [];
    for (let i = 0; i < 40; i++) rows.push(row({ id: i, labelV1: 1, labelV2: i < 10 ? 0 : 1, barrierV2: i < 20 ? 2 : 1, ambV2: i === 0 }));
    rows.push(row({ id: 500, lowvolV1: true }));
    rows.push(row({ id: 900, hasV2: false, labelV2: null, ambV2: null, barrierV2: null }));
    rows.push(row({ id: 901, exchange: 'EDGEX', hasV2: false, labelV2: null, ambV2: null, barrierV2: null }));
    for (const r of rows) addRow(a, r, s);
    const r = readAcc(a);
    expect(r).toMatchObject({
      registered: 43, low_vol_excluded: 1, twins: 40, status: 'ok', differ: 10, p_differ: 0.25,
      transition: { '1>0': 10, '1>1': 30 }, decided_share_v1: 1, decided_share_v2: 0.75, decided_share_delta: -0.25,
      same_candle_share_delta: 1 / 40, barrier_ratio_median: 1.5, barrier_ratio_share_ne_1: 0.5,
      non_twins: { 'refused:gap': 1, 'unreachable:retired': 1 },
    });
  });

  it('< 30 twins prints counts only (thin); zero twins with registered rows is UNDEFINED, never 0 %', () => {
    const s = empty();
    const thin = newAcc();
    for (let i = 0; i < 29; i++) addRow(thin, row({ id: i, labelV2: -1 }), s);
    const t = readAcc(thin);
    expect(t.status).toBe('thin');
    expect('p_differ' in t).toBe(false);
    expect(t.transition).toEqual({ '1>-1': 29 });
    const none = newAcc();
    addRow(none, row({ id: 1, hasV2: false, labelV2: null, ambV2: null, barrierV2: null }), s);
    expect(readAcc(none)).toMatchObject({ status: 'UNDEFINED', twins: 0, registered: 1, non_twins: { 'not-reached': 1 } });
  });

  it('comparators: decided always-side shares (a same-candle race loses for both) and the mix-matched null; never max()', () => {
    const rs = [
      row({ id: 1, side: 'BUY', labelV1: 1, labelV2: 1 }), // BUY wins → upper
      row({ id: 2, side: 'SELL', labelV1: 1, labelV2: -1 }), // v1: SELL wins → lower · v2: SELL stopped → upper
      row({ id: 3, side: 'BUY', labelV1: -1, ambV1: true, labelV2: 0 }), // v1: same-candle → loss for both · v2: timeout, not decided
      row({ id: 4, side: 'SELL', labelV1: 0, labelV2: 1 }), // v1 timeout · v2: SELL wins → lower
    ];
    const c = comparators(rs) as { pooled: Record<string, Record<string, number>>; per_day: unknown; pooled_delta: Record<string, number> };
    // v1 decided = 3: upper 1 (id1), lower 1 (id2), ambiguous 1 (id3); BUY share 2/3
    expect(c.pooled.v1.q_buy).toBeCloseTo(1 / 3);
    expect(c.pooled.v1.q_sell).toBeCloseTo(1 / 3);
    expect(c.pooled.v1.p0).toBeCloseTo((2 / 3) * (1 / 3) + (1 / 3) * (1 / 3));
    // v2 decided = 3: upper 2 (id1, id2), lower 1 (id4); BUY share 1/3
    expect(c.pooled.v2.q_buy).toBeCloseTo(2 / 3);
    expect(c.pooled.v2.p0).toBeCloseTo((1 / 3) * (2 / 3) + (2 / 3) * (1 / 3));
    expect(c.pooled_delta.q_buy).toBeCloseTo(1 / 3);
    expect(c.per_day).toMatchObject({ status: 'under-clustered' });
  });

  it('per-UTC-day cluster means exist only with ≥ 20 days of ≥ 30 twins; v1, v2 and the per-day DELTA over the SAME days', () => {
    // day d: 30 BUY twins; -v1 always wins, -v2 wins on the odd ids → per-day q_buy 1 vs 0.5, delta −0.5
    const mk = (days: number, extra: ExtractRow[] = []) => {
      const rs: ExtractRow[] = [...extra];
      for (let d = 0; d < days; d++) for (let i = 0; i < 30; i++) rs.push(row({ id: d * 100 + i, createdAt: T0 + d * 86_400, labelV2: i % 2 ? 1 : -1 }));
      return comparators(rs) as { per_day: Record<string, unknown> };
    };
    expect(mk(19).per_day).toMatchObject({ status: 'under-clustered', days_qualifying: 19, days_used: 19 });
    const p = mk(20).per_day as { days_used: number; v1: Record<string, number>; v2: Record<string, number>; delta: Record<string, number> };
    expect(p).toMatchObject({ status: 'ok', days_qualifying: 20, days_used: 20 });
    expect(p.v1.q_buy).toBeCloseTo(1);
    expect(p.v2.q_buy).toBeCloseTo(0.5);
    expect(p.delta.q_buy).toBeCloseTo(-0.5);
    // a 21st qualifying day on which -v2 decides nothing (all timeouts) is dropped for BOTH versions
    const dead = Array.from({ length: 30 }, (_, i) => row({ id: 9000 + i, createdAt: T0 + 40 * 86_400, labelV2: 0 }));
    expect(mk(20, dead).per_day).toMatchObject({ days_qualifying: 21, days_used: 20 });
  });
});

describe('the table, the headline and the CLI verdict', () => {
  it('windows and specs are never pooled; the headline places the flips by hole count', () => {
    const s = empty();
    const rows: ExtractRow[] = [];
    for (let i = 0; i < 100; i++) rows.push(row({ id: i, gapV1: i < 60 ? 0 : i < 80 ? 2 : 5, labelV2: i >= 90 || (i >= 70 && i < 80) ? -1 : 1 }));
    rows.push(row({ id: 1000, spec: 'tau0.5-floor0.30-v1', createdAt: 1780000000, labelV2: -1 })); // pre-flip, other spec
    const t = buildTable({ rows, strata: s, countsApart: [], v2WithoutV1: [], meta: {} });
    // flips: gap 2 → ids 70..79 (10), gap 5 → ids 90..99 (10)
    expect(t.headline).toMatchObject({ spec: 'tau1.0-floor0.30-v1', window: 'FULL', n: 100, k: 20, share: 0.2, flips_by_race_gap: { '2': 10, '5': 10 }, hole_count_holding_half_the_flips_at_or_above: 5, hole_count_holding_90pct_of_flips_at_or_above: 2 });
    const fleet = t.cells.filter((c) => c.key.cell === 'fleet');
    expect(fleet.map((c) => `${c.key.spec}|${c.key.window}|${c.read.registered}`).sort()).toEqual([
      'tau0.5-floor0.30-v1|FULL|1', 'tau1.0-floor0.30-v1|FULL|100', 'tau1.0-floor0.30-v1|POST_FLIP|100',
    ]);
    // every other spec × window has its own headline-form sensitivity line (§4)
    expect(t.sensitivity.map((h) => `${h.spec}|${h.window}|${h.n}`).sort()).toEqual(['tau0.5-floor0.30-v1|FULL|1', 'tau0.5-floor0.30-v1|POST_FLIP|0', 'tau1.0-floor0.30-v1|POST_FLIP|100']);
  });

  it('coarser-served pairs enter NO pooled cell, comparator or headline — each is its own E4 cell', () => {
    const s = empty();
    const rows: ExtractRow[] = [];
    // 40 same-grid BINANCE 3m twins, identical under both versions; 40 GATE 3m (coarser-served) twins all flipped
    for (let i = 0; i < 40; i++) rows.push(row({ id: i, timeframe: '3m' }));
    for (let i = 0; i < 40; i++) rows.push(row({ id: 100 + i, exchange: 'GATE', timeframe: '3m', labelV2: 0 }));
    const t = buildTable({ rows, strata: s, countsApart: [], v2WithoutV1: [], meta: {} });
    const full = (pred: (k: Record<string, string>) => boolean) => t.cells.filter((c) => c.key.spec === 'tau1.0-floor0.30-v1' && c.key.window === 'FULL' && pred(c.key));
    expect(full((k) => k.cell === 'fleet')[0].read).toMatchObject({ registered: 40, p_differ: 0 });
    expect(full((k) => k.timeframe === '3m')[0].read).toMatchObject({ registered: 40, p_differ: 0 });
    expect(full((k) => k.grid !== undefined).map((c) => c.key.grid)).toEqual(['same']);
    expect(t.headline).toMatchObject({ n: 40, k: 0 });
    const fleetCmp = t.comparators.find((c) => c.key.spec === 'tau1.0-floor0.30-v1' && c.key.window === 'FULL' && c.key.rollup.startsWith('fleet'))!;
    expect(fleetCmp.read.twins).toBe(40);
    expect(full((k) => k.registered_cell === 'E4 coarser GATE:3m')[0].read).toMatchObject({ registered: 40, p_differ: 1 });
    // the per-venue cell of a coarser pair is one grid class — it is printed, apart
    expect(full((k) => k['timeframe|venue'] === '3m|GATE')[0].read).toMatchObject({ registered: 40 });
  });

  it('the E4 pairs are the labeller\'s own coarser-served pairs', () => {
    expect(E4_PAIRS).toEqual(coarserV1LagTable().map((p) => `${p.venue}:${p.timeframe}`).sort());
    expect(E4_PAIRS.length).toBeGreaterThan(0);
  });

  it('the BITGET 2h/8h cell (amendment 2026-10-01): pre-T_ADAPTER -v2 rows counted unreachable-pending, the rest its own cell, never pooled', () => {
    const s = empty();
    s.adapterBefore.add('201|tau1.0-floor0.30-v1');
    const rows: ExtractRow[] = [];
    for (let i = 0; i < 40; i++) rows.push(row({ id: i, timeframe: '2h' })); // BINANCE 2h, identical twins
    rows.push(row({ id: 201, exchange: 'BITGET', timeframe: '2h', labelV2: -1 })); // -v2 written before T_ADAPTER
    for (let i = 0; i < 35; i++) rows.push(row({ id: 300 + i, exchange: 'BITGET', timeframe: '8h', labelV2: 0 })); // reached
    const t = buildTable({ rows, strata: s, countsApart: [], v2WithoutV1: [], meta: {} });
    const full = (pred: (k: Record<string, string>) => boolean) => t.cells.filter((c) => c.key.spec === 'tau1.0-floor0.30-v1' && c.key.window === 'FULL' && pred(c.key));
    // pooled lines carry BINANCE only
    expect(full((k) => k.cell === 'fleet')[0].read).toMatchObject({ registered: 40, twins: 40, p_differ: 0 });
    expect(full((k) => k.timeframe === '2h')[0].read).toMatchObject({ registered: 40 });
    expect(t.headline).toMatchObject({ n: 40, k: 0 });
    expect(t.comparators.find((c) => c.key.window === 'FULL' && c.key.spec === 'tau1.0-floor0.30-v1' && c.key.rollup.startsWith('fleet'))!.read.twins).toBe(40);
    // the cell: 35 reached twins compared; the pre-T_ADAPTER row counted under its kept class, its labels never compared
    const e5 = full((k) => k.registered_cell === 'E5 BITGET 2h/8h reached via adapter fix')[0].read;
    expect(e5).toMatchObject({ registered: 36, twins: 35, p_differ: 1, non_twins: { 'unreachable:adapter-pending': 1 } });
    expect(full((k) => k['timeframe|venue'] === '2h|BITGET')[0].read).toMatchObject({ registered: 1, twins: 0, non_twins: { 'unreachable:adapter-pending': 1 } });
  });

  it('every registered cell is printed — EMPTY when no row occupies it, UNDEFINED with rows but no twin; §8 states', () => {
    const rows = Array.from({ length: 31 }, (_, i) => row({ id: i }));
    rows.push(row({ id: 500, exchange: 'BITGET', timeframe: '8h', hasV2: false, labelV2: null, ambV2: null, barrierV2: null }));
    const t = buildTable({ rows, strata: empty(), countsApart: [], v2WithoutV1: [], meta: {} });
    const reg = t.cells.filter((c) => c.key.window === 'FULL' && c.key.registered_cell !== undefined);
    expect(reg.map((c) => c.key.registered_cell).sort()).toEqual([...Object.keys(E_CELLS), ...E4_PAIRS.map((p) => `E4 coarser ${p}`)].sort());
    expect(reg.find((c) => c.key.registered_cell === 'E2 race-invariant')!.read.status).toBe('EMPTY');
    expect(reg.find((c) => c.key.registered_cell === 'E5 BITGET 2h/8h reached via adapter fix')!.read).toMatchObject({ status: 'UNDEFINED', registered: 1, twins: 0 });
    const st = (e: string) => t.expectations.find((x) => x.window === 'FULL' && x.expectation === e)!;
    // E5's "no twins" expectation was amended away (2026-10-01, OAH-Q8): the cell is read as its own, never judged
    expect(st('E5').state).toMatch(/^amended 2026-10-01 \(OAH-Q8\)/);
    expect(st('E3')).toMatchObject({ state: 'indeterminate' });
    expect(st('E1')).toMatchObject({ state: 'indeterminate' }); // all facts unknown here → the E1 cell is EMPTY
  });

  it('E3 reads consistent when P(differ) is non-decreasing in race gap and names the broken step otherwise', () => {
    const s = empty();
    const mk = (flipsAt: Record<string, number>) => {
      const rows: ExtractRow[] = [];
      let id = 0;
      for (const [g, flips] of Object.entries(flipsAt)) {
        for (let i = 0; i < 30; i++) {
          s.worklist.set(`${id}|tau1.0-floor0.30-v1`, { sigmaHoles: 0, ambiguousUc: 0, forming: 0 });
          rows.push(row({ id: id++, gapV1: Number(g), labelV2: i < flips ? -1 : 1 }));
        }
      }
      return buildTable({ rows, strata: s, countsApart: [], v2WithoutV1: [], meta: {} }).expectations.find((e) => e.window === 'FULL' && e.expectation === 'E3')!;
    };
    expect(mk({ 1: 3, 2: 6, 4: 9 })).toMatchObject({ state: 'consistent', cells: [] });
    expect(mk({ 1: 6, 2: 3, 4: 9 })).toMatchObject({ state: 'inconsistent', cells: ['gap 1 > gap 2'] });
  });

  it('the report opens with the registration header clause, VERBATIM', () => {
    const reg = readFileSync('audits/labeler-race-window-v2-preregistration-2026-09-28.md', 'utf8').split('\n');
    const start = reg.findIndex((l) => l.startsWith('> ## ⚠️ HEADER CLAUSE'));
    let end = start;
    while (end < reg.length && reg[end].startsWith('>')) end++;
    expect(HEADER_CLAUSE).toBe(reg.slice(start, end).join('\n'));
    const t = buildTable({ rows: [row({ id: 1 })], strata: empty(), countsApart: [], v2WithoutV1: [], meta: { cells_tested: 0 } });
    expect(renderMarkdown(t).startsWith(HEADER_CLAUSE + '\n')).toBe(true);
  });

  it('the pull record: PASS, the pinned T_CUT, a recorded manifest — else refused', () => {
    const ok = ['t_cut=' + T_CUT_EPOCH, 'manifest_sha256=' + 'a'.repeat(64), 'b'.repeat(64) + '  extract.csv', 'LRW_PULL_VERDICT=PASS'].join('\n');
    expect(parsePullMeta(ok).shas.get('extract.csv')).toBe('b'.repeat(64));
    expect(() => parsePullMeta(ok.replace('PASS', 'FAIL'))).toThrow(/did not PASS/);
    expect(() => parsePullMeta(ok.replace(`t_cut=${T_CUT_EPOCH}`, 't_cut=1790754894'))).toThrow(/pinned T_CUT/);
    expect(() => parsePullMeta(ok.replace(`t_cut=${T_CUT_EPOCH}`, 't_cut=1790754894743'))).toThrow(/pinned T_CUT/);
    expect(() => parsePullMeta(ok.replace(/manifest_sha256=\w+/, 'manifest_sha256='))).toThrow(/manifest/);
  });

  it('main() refuses (INDETERMINATE, exit 3) an unverified corpus: a missing input, a file the pull did not hash, an unpinned stratum', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lrw-dis-'));
    const w = (n: string, t: string, gz = false) => { const p = join(dir, n); writeFileSync(p, gz ? gzipSync(t) : t); return p; };
    const rs = Array.from({ length: 31 }, (_, i) => row({ id: i }));
    const extract = w('extract.csv', [EXTRACT_HEADER.join(','), ...rs.map(csvLine)].join('\n'));
    const counts = w('counts-apart.csv', 'spec_v1,exchange,timeframe,after_cut,n\ntau1.0-floor0.30-v1,BINANCE,1h,f,31');
    const v2w = w('v2-without-v1.csv', 'spec_v2,exchange,timeframe,n_v2_without_v1\n');
    const man = w('m.txt', 'LRW_MANIFEST 1 refused:gap\n');
    const h = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
    const meta = (extractSha = h(extract)) => w('pull-meta.txt', [
      't_cut=' + T_CUT_EPOCH, 'manifest_sha256=' + h(man), `${extractSha}  extract.csv`, `${h(counts)}  counts-apart.csv`, `${h(v2w)}  v2-without-v1.csv`, 'LRW_PULL_VERDICT=PASS',
    ].join('\n'));
    const args = (m: string) => [
      '--extract', extract, '--counts-apart', counts, '--v2-without-v1', v2w, '--pull-meta', m,
      '--worklist', w('w.csv.gz', 'signal_id,barrier_spec,gap_served_L,gap_served_U,gap_served_Uc,ambiguous_L_Uc,tail_served_L,gap_requested_L,sigma_holes_L,forming\n1,tau1.0-floor0.30-v1,0,0,0,0,0,0,0,0', true),
      '--delta', w('d.csv.gz', 'signal_id,barrier_spec,gap_served_L,sigma_holes_L\n2,tau1.0-floor0.30-v1,0,0', true),
      '--crossed', w('k.csv.gz', 'signal_id,barrier_spec,crossed_L,fwd_len_L\n1,tau1.0-floor0.30-v1,0,8', true),
      '--retired-uc', w('r.csv', 'signal_id,barrier_spec,gap_served_L,gap_served_Uc_worklist,gap_served_Uc_with_retired\n3,tau1.0-floor0.30-v1,0,0,0'),
      '--adapter-before', w('a.csv', 'signal_id,barrier_spec\n'),
      '--manifest', man, '--out-dir', join(dir, 'out'),
    ];
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    try {
      // everything the pull hashed matches — the synthetic strata are not the registered files: refused by pin
      expect(main(args(meta()))).toBe(3);
      expect(logs.at(-1)).toMatch(/^LRW_DISAGREEMENT_VERDICT=INDETERMINATE --worklist: sha256 is not the registered 58dcff766db9/);
      expect(main(args(meta('0'.repeat(64))))).toBe(3);
      expect(logs.at(-1)).toMatch(/INDETERMINATE --extract: not the extract.csv the pull hashed/);
      const a = args(meta());
      a[a.indexOf('--manifest') + 1] = w('m2.txt', 'LRW_MANIFEST 1 refused:anchor\n');
      expect(main(a)).toBe(3);
      expect(logs.at(-1)).toMatch(/INDETERMINATE --manifest: not the manifest files the pull recorded/);
      expect(main(args(meta()).filter((x) => x !== '--pull-meta' && !x.endsWith('pull-meta.txt')))).toBe(3);
      expect(logs.at(-1)).toMatch(/INDETERMINATE missing --pull-meta/);
    } finally {
      console.log = orig;
    }
  });
});

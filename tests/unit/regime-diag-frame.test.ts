// EDGE-REGIME-DIAG-W1 CH2 — the frame of a window and the label-free skeleton, on a synthetic study.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { aggregate } from '../../src/scripts/regime-diag/archive.js';
import { buildFrames, confBin, dayOf, diffSkeleton, parseCensus, phaseLab, posName, registeredSkeleton, skeletonOf, withOutcomes, type Frame } from '../../src/scripts/regime-diag/frame.js';
import { keyBAt, phaseAt, volLeg } from '../../src/scripts/regime-diag/keys.js';
import { labelEntry, newCellTable } from '../../src/scripts/regime-diag/labeler.js';
import { quietly, served } from '../../src/scripts/regime-diag/replay.js';
import * as spec from '../../src/scripts/regime-diag/diag-spec.js';
import { SYNTH_CENSUS_TEXT, SYNTH_FIT, SYNTH_HOLDOUT, SYNTH_HOLE, SYNTH_SPAN, synthLoad } from '../../src/scripts/regime-diag/synth.js';
import { sigma1hFromVolatilityRatio } from '../../src/lib/pre-trade-calc.js';

const census = parseCensus(SYNTH_CENSUS_TEXT);
let fit: Frame, hold: Frame, bare: Frame;
beforeAll(() => {
  [fit, hold] = buildFrames(SYNTH_SPAN, [SYNTH_FIT, SYNTH_HOLDOUT], census, synthLoad, { outcomes: true });
  [bare] = buildFrames(SYNTH_SPAN, [SYNTH_HOLDOUT], census, synthLoad, { outcomes: false });
}, 240_000);

describe('regime-diag: the census', () => {
  it('reads the panel and the weights in panel order, and refuses a census without them', () => {
    expect(census).toEqual({ panel: ['SYNA', 'SYNB', 'SYNC'], wCoin: [0.5, 0.3, 0.2], wTf: [0.2, 0.5, 0.3] });
    expect(posName(0)).toBe('P01');
    expect(() => parseCensus('{}')).toThrow(/t3_weights/);
    expect(() => parseCensus(JSON.stringify({ t3_weights: { panel: ['A'], coins: { A: 0 }, timeframes: { '1h': 1, '4h': 1, '1d': 1 } } }))).toThrow(/positive/);
    expect(() => parseCensus(JSON.stringify({ t3_weights: { panel: ['../x'], coins: {}, timeframes: {} } }))).toThrow(/not a coin/);
  });
});

describe('regime-diag: the frame', () => {
  it('draws 24 entries per eligible coin-day and counts every excluded minute under one name', () => {
    expect([fit.nE, fit.coins.map((c) => [c.pos, c.eligible, c.e1 - c.e0])]).toEqual([2520 + 1560, [[0, 151_201, 2520], [1, 93_601, 1560]]]);
    expect([hold.nE, hold.coins.map((c) => c.eligible)]).toEqual([576, [17_281, 17_281]]);
    expect([fit.drops.path_beyond_window, fit.drops.short_history, fit.drops.gap, fit.drops.no_archive]).toEqual([2 * 4319, 2 * 10_080, 14_399, 6]);
    expect([hold.drops.path_beyond_window, hold.drops.short_history ?? 0, hold.drops.gap ?? 0]).toEqual([2 * 4319, 0, 0]);
    // entries of a position are in time order, inside the window, and none sees the hole
    for (const f of [fit, hold]) {
      for (const c of f.coins) {
        for (let e = c.e0; e < c.e1; e++) {
          expect(f.ePos[e]).toBe(c.pos);
          if (e > c.e0) expect(f.eM[e]).toBeGreaterThan(f.eM[e - 1]);
          expect(f.eM[e] >= f.win.lo && f.eM[e] + spec.PATH_MIN <= f.win.hi).toBe(true);
          if (c.pos === 1) expect(f.eM[e] - spec.HISTORY_MIN > SYNTH_HOLE || f.eM[e] + spec.PATH_MIN <= SYNTH_HOLE).toBe(true);
        }
      }
    }
  });

  it('every row is the direct call at its timeframe; an entry without 100 days of history has no 1d row', () => {
    const grids = [synthLoad(0).g!, synthLoad(1).g!];
    const bars = grids.map((g) => spec.TFS.map((tf) => aggregate(g, tf.min)));
    let rows = 0, no1d = 0, keyBNull = 0, undated = 0, labels = new Set<number>();
    for (const f of [fit, hold]) {
      for (let e = 0; e < f.nE; e += 7) {
        const p = f.ePos[e], m = f.eM[e], g = grids[p];
        spec.TFS.forEach((tf, t) => {
          const r = e * 3 + t;
          if (m - tf.n * tf.min < Math.max(0, g.first) || (p === 1 && m - tf.n * tf.min <= SYNTH_HOLE && SYNTH_HOLE < m)) { expect([t, f.has[r], f.S.lab[r]]).toEqual([2, 0, spec.NO_LABEL]); no1d++; return; }
          const s = quietly(() => served(g, bars[p][t], tf, m, census.panel[p]));
          expect([f.has[r], f.S.lab[r], f.S.conf[r], f.vol[r], f.adx[r], f.slope[r], f.structure[r]]).toEqual([1, s.label, s.confidence, s.vol, s.adx, s.slope, s.structure]);
          const b = quietly(() => keyBAt(g, bars[p][t], tf, f.win, m, census.panel[p]));
          expect([f.B.lab[r], f.B.conf[r]]).toEqual(b ? [b.label, b.confidence] : [spec.NO_LABEL, 0]);
          const b7 = quietly(() => keyBAt(g, bars[p][t], tf, f.win, m, census.panel[p], 7));
          expect(f.B7.lab[r]).toBe(b7 ? b7.label : spec.NO_LABEL);
          const c = f.coins.find((x) => x.pos === p)!;
          expect(f.phase[r]).toBe(phaseAt(c.keyA[t], m));
          expect(f.volLeg[r]).toEqual(volLeg(bars[p][t], f.win, m, g.O[m]));
          const j = Math.floor(m / tf.min), sr = c.series[t];
          expect(f.age[r]).toBe(sr.ok[j] && sr.label[j] === s.label ? sr.age[j] : 0);
          if (!b) keyBNull++;
          if (!f.phase[r]) undated++;
          labels.add(s.label); rows++;
        });
        const want = newCellTable(1);
        labelEntry(g, m, sigma1hFromVolatilityRatio(f.vol[e * 3]), want, 0);
        expect([...f.cells!.out.subarray(e * spec.N_CS, (e + 1) * spec.N_CS)]).toEqual([...want.out]);
        expect([...f.cells!.aT.subarray(e * spec.N_CS, (e + 1) * spec.N_CS)]).toEqual([...want.aT]);
        expect([...f.cells!.bS.subarray(e * spec.N_CS, (e + 1) * spec.N_CS)]).toEqual([...want.bS]);
      }
    }
    expect(rows).toBeGreaterThan(1000);
    expect([no1d > 0, keyBNull > 0, undated > 0, labels.size]).toEqual([true, true, true, 4]);
    // the counted drops are the rows the frame lacks
    const lacking = (f: Frame, t: number): number => { let n = 0; for (let e = 0; e < f.nE; e++) if (!f.has[e * 3 + t]) n++; return n; };
    expect([lacking(fit, 0), lacking(fit, 1), lacking(fit, 2), fit.drops.core_refusal ?? 0]).toEqual([0, 0, fit.drops.no_1d_history, 0]);
    expect(fit.drops.no_1d_history).toBeGreaterThan(3000);
    expect(hold.drops.no_1d_history ?? 0).toBeLessThan(hold.nE);
    let nob = 0, und = 0;
    for (let r = 0; r < hold.nE * 3; r++) { if (hold.has[r] && hold.B.lab[r] === spec.NO_LABEL) nob++; if (hold.has[r] && !hold.phase[r]) und++; }
    expect([hold.drops.key_b_beyond_window, hold.drops.undated]).toEqual([nob, und]);
    const pl = phaseLab(hold);
    for (let r = 0; r < hold.nE * 3; r += 11) expect(pl.lab[r]).toBe(!hold.has[r] || !hold.phase[r] ? spec.NO_LABEL : hold.phase[r] === 1 ? spec.L_UP : spec.L_DOWN);
  });

  it('a frame built without outcomes has the same rows and no path label, no odds', () => {
    expect(bare.cells).toBeNull();
    expect(bare.outcomes).toBe(false);
    expect([bare.nE, [...bare.eM], [...bare.S.lab], [...bare.B.lab], [...bare.phase]]).toEqual([hold.nE, [...hold.eM], [...hold.S.lab], [...hold.B.lab], [...hold.phase]]);
    expect(bare.drops.both_touch).toBeUndefined();
    expect(hold.drops.both_touch + hold.drops.null_odds).toBeGreaterThanOrEqual(0);
    expect(fit.cells!.out.length).toBe(fit.nE * 90);
  });

  it('withOutcomes adds the path labels and odds to a bare frame: the same frame as one built with them', () => {
    const loads: number[] = [];
    const full = withOutcomes(bare, (pos) => { loads.push(pos); return synthLoad(pos); });
    expect(loads).toEqual([0, 1]);
    expect(full.outcomes).toBe(true);
    expect(full.cells).toEqual(hold.cells);
    expect(full.drops).toEqual(hold.drops);
    expect([full.nE, full.S, full.B, full.phase, full.coins]).toEqual([bare.nE, bare.S, bare.B, bare.phase, bare.coins]);
    // the bare frame is left as it was, and a frame that has outcomes is not labelled twice
    expect([bare.cells, bare.outcomes, bare.drops.both_touch]).toEqual([null, false, undefined]);
    expect(() => withOutcomes(hold, synthLoad)).toThrow(/already has outcomes/);
    expect(() => withOutcomes(bare, () => ({ g: null, noArchive: 0 }))).toThrow(/no archive/);
  });
});

describe('regime-diag: the skeleton', () => {
  it('counts calls, key A bars, entries, row sets and slices; the tables agree with each other', () => {
    const sk = skeletonOf([fit, hold]);
    const calls = (f: Frame, t: number): number => f.coins.reduce((n, c) => { for (let j = Math.ceil(f.win.lo / spec.TFS[t].min); j * spec.TFS[t].min < f.win.hi; j++) n += c.series[t].ok[j]; return n; }, 0);
    for (const [f, w] of [[fit, 'fit'], [hold, 'hold-out']] as const) {
      spec.TFS.forEach((tf, t) => {
        const a = sk['2a'][`all|${tf.key}|${w}`] as number[];
        expect(a[0]).toBe(calls(f, t));
        expect(a[1] + a[2] + a[3] + a[4]).toBe(a[0]);
        expect(sk['2a'][`P01–P08|${tf.key}|${w}`]).toEqual(a);
        expect(sk['2a'][`P09–P15|${tf.key}|${w}`]).toEqual([0, 0, 0, 0, 0, 0, 0]);
        const b = sk['2b'][`${tf.key}|${w}`] as number[];
        expect(b).toEqual([f.coins.reduce((n, c) => n + c.keyA[t].nBars, 0), f.coins.reduce((n, c) => n + c.keyA[t].turns.idx.length, 0), f.coins.reduce((n, c) => n + c.keyA[t].dated, 0), f.coins.reduce((n, c) => n + c.keyA[t].up, 0)]);
        const e = sk['2e'][`${w}|${tf.key}`] as number[];
        const tr = (sk['2d'][`${w}|TRENDING`] as number[])[3 + t];
        expect(e[4] + e[5] + e[6]).toBe(tr);
        expect(e[10] + e[11] + e[12] + e[13] + e[14]).toBe(tr);
        expect(e[0] + e[1] + e[2] + e[3]).toBeLessThanOrEqual(tr);
        expect(e[12] + e[13] + e[14]).toBe((sk['2d'][`${w}|TRENDING, confidence ≥ 60`] as number[])[3 + t]);
        expect(e[16] + e[17]).toBe((sk['2d'][`${w}|VOLATILE, confidence ≥ 70`] as number[])[3 + t]);
        expect(e[9]).toBeLessThanOrEqual(e[8]);
      });
      const d = (k: string): number[] => sk['2d'][`${w}|${k}`] as number[];
      let has = 0; for (let r = 0; r < f.nE * 3; r++) has += f.has[r];
      expect([d('all')[0], d('all')[3], d('all')[2]]).toEqual([has, f.nE, 2]);
      expect(d('all')[3] + d('all')[4] + d('all')[5]).toBe(d('all')[0]);
      expect(d('TRENDING')[0] + d('RANGING')[0] + d('VOLATILE')[0]).toBe(d('all')[0]);
      expect(d('TRENDING, confidence ≥ 60')[0] + d('TRENDING, confidence < 60')[0]).toBe(d('TRENDING')[0]);
      expect(d('all')[1]).toBe(new Set(Array.from({ length: f.nE }, (_, e) => f.ePos[e] * 1000 + dayOf(f.eM[e]))).size);
      expect(d('all')[6]).toBeNull();
      expect(d('TRENDING')[6]).toBeGreaterThan(0);
      expect(d('TRENDING')[6]).toBeLessThanOrEqual(0.5);
      expect(sk['2c'][w]).toEqual([f.coins.reduce((n, c) => n + c.eligible, 0), f.nE, d('all')[5], 2, w === 'fit' ? 2520 : 288]);
    }
    expect(diffSkeleton(sk, sk)).toEqual([]);
    const other = JSON.parse(JSON.stringify(sk));
    other['2d']['fit|RANGING'][1] += 1;
    delete other['2b']['1d|hold-out'];
    expect(diffSkeleton(other, sk)).toEqual(['Table 2b row 1d|hold-out: not computed', `Table 2d row fit|RANGING column 2: computed ${(sk['2d']['fit|RANGING'][1] as number) + 1}, registered ${sk['2d']['fit|RANGING'][1]}`]);
    expect([confBin(49), confBin(50), confBin(69), confBin(70), confBin(100)]).toEqual([0, 1, 2, 3, 4]);
  });

  it('reads the registered tables out of the registration, and the real windows give the registered entries per position', () => {
    const reg = registeredSkeleton(readFileSync(spec.REGISTRATION, 'utf8'));
    expect(Object.fromEntries(Object.entries(reg).map(([k, v]) => [k, Object.keys(v).length]))).toEqual({ '2a': 18, '2b': 6, '2c': 2, '2d': 16, '2e': 6 });
    expect(reg['2c']).toEqual({ fit: [12_104_833, 201_748, 172_567, 13, 17_304], 'hold-out': [6_311_565, 105_193, 100_717, 15, 7_224] });
    expect(reg['2a']['P09–P15|1d|hold-out']).toEqual([1_809, 579, 319, 177, 734, 528, 663]);
    expect(reg['2d']['fit|TRENDING, confidence ≥ 60']).toEqual([195_503, 6_912, 13, 60_246, 79_420, 55_837, 0.4555]);
    expect(reg['2d']['hold-out|all'][6]).toBeNull();
    expect(reg['2e']['hold-out|1d']).toHaveLength(18);
    const per = (w: spec.Win): number => Math.round((spec.ENTRIES_PER_DAY * (w.hi - spec.PATH_MIN - Math.max(w.lo, spec.HISTORY_MIN) + 1)) / 1440);
    expect([per(spec.FIT), per(spec.HOLDOUT)]).toEqual([17_304, 7_224]);
    expect(() => registeredSkeleton('no tables here')).toThrow(/Table 2a/);
  });
});

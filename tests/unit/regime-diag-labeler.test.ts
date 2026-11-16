// EDGE-REGIME-DIAG-W1 CH2 — AC2.2: the 1 m path labeler excludes and counts both-touch bars; the entry draw and
// the baselines (a), (b) are the registered ones. AC2.4: the both-touch rule, broken, turns its assertion red.
import { describe, expect, it, vi } from 'vitest';
import { noEdgeOdds } from '../../src/lib/pre-trade-calc.js';
import { emptyGrid, finishGrid, type Grid } from '../../src/scripts/regime-diag/archive.js';
import * as labeler from '../../src/scripts/regime-diag/labeler.js';
import { rngFor, sampleWithoutReplacement } from '../../src/scripts/regime-diag/rng.js';
import { FEE_PCT, HOLDS_H, N_CS, SHAPES, cellOf, csOf, type Span, type Win } from '../../src/scripts/regime-diag/diag-spec.js';
import { synthGrid } from '../../src/scripts/regime-diag/synth.js';

const { OUT_BOTH, OUT_NULL, OUT_STOP, OUT_TARGET, OUT_TIMEOUT } = labeler;

async function mutated<T>(lever: string, fn: (m: typeof labeler) => T): Promise<T> {
  process.env.REGIME_DIAG_MUTATE = lever;
  vi.resetModules();
  try {
    return fn(await import('../../src/scripts/regime-diag/labeler.js'));
  } finally {
    delete process.env.REGIME_DIAG_MUTATE;
    vi.resetModules();
  }
}

/** A flat path at 100 with a few bars that reach out. Entry at minute 20,000. */
const M = 20_000;
function flat(bars: Record<number, [number, number]>): Grid {
  const g = emptyGrid({ t0Ms: Date.UTC(2021, 0, 1), n: 30_000 });
  for (let i = 0; i < g.span.n; i++) { g.O[i] = 100; g.H[i] = 100.01; g.L[i] = 99.99; g.C[i] = 100; g.V[i] = 1; g.has[i] = 1; }
  for (const [i, [h, l]] of Object.entries(bars)) { g.H[M + Number(i)] = h; g.L[M + Number(i)] = l; }
  return finishGrid(g);
}
const S = (id: string): number => SHAPES.findIndex((s) => s.id === id);
const H = (h: number): number => HOLDS_H.indexOf(h);
const cs = (shape: string, hold: number, side: 0 | 1): number => csOf(cellOf(S(shape), H(hold)), side);
const LONG = 0, SHORT = 1;
const SIGMA_1H = 0.004;

/** Bar 3 reaches 100.6 and 99.4; bar 10 reaches 102.1; bar 40 reaches down to 97.4. */
const PATH = { 3: [100.6, 99.4], 10: [102.1, 99.99], 40: [100.01, 97.4] } as Record<number, [number, number]>;

/** AC2.2's assertion: a bar that touches both barriers is neither a target nor a stop; it is excluded and counted. */
function bothTouch(mod: typeof labeler): number {
  const t = mod.newCellTable(1);
  mod.labelEntry(flat(PATH), M, SIGMA_1H, t, 0);
  // S6 (0.5, 0.5): 100.5 and 99.5 are both inside bar 3, on either side, at every hold
  for (const h of HOLDS_H) for (const side of [LONG, SHORT] as const) expect([h, side, t.out[cs('S6', h, side)]]).toEqual([h, side, OUT_BOTH]);
  // S5 (1 sigma, 2 sigma) at 0.5 h: sigma_H = 0.2828 %, so 100.566 and 99.717 are both inside bar 3
  expect(t.out[cs('S5', 0.5, LONG)]).toBe(OUT_BOTH);
  const n = mod.countOutcomes(t);
  expect(n[OUT_BOTH]).toBeGreaterThanOrEqual(11);
  expect(n[OUT_TIMEOUT] + n[OUT_TARGET] + n[OUT_STOP] + n[OUT_BOTH] + n[OUT_NULL]).toBe(N_CS);
  return n[OUT_BOTH];
}

describe('regime-diag: the 1 m path labeler', () => {
  it('AC2.2: excludes and counts both-touch bars', () => {
    expect(bothTouch(labeler)).toBeGreaterThanOrEqual(11);
  });

  it('AC2.4: with the both-touch rule broken, its assertion is red; restored, green', async () => {
    await expect(mutated('bothtouch', (m) => bothTouch(m))).rejects.toThrow(/to deeply equal/);
    expect(bothTouch(labeler)).toBeGreaterThanOrEqual(11);
  });

  it('first touch decides, per side; no touch by the end of the hold is a time-out; the entry bar is on the path', () => {
    const t = labeler.newCellTable(1);
    labeler.labelEntry(flat(PATH), M, SIGMA_1H, t, 0);
    // S1 (0.5, 0.75): bar 3 reaches the long's stop 99.5 but not its target 100.75; the short's stop 100.5, not its target 99.25
    expect([t.out[cs('S1', 4, LONG)], t.out[cs('S1', 4, SHORT)]]).toEqual([OUT_STOP, OUT_STOP]);
    // S2 (1, 2): bar 10 reaches the long's target 102 before anything reaches 99; the short's stop 101
    expect([t.out[cs('S2', 0.5, LONG)], t.out[cs('S2', 0.5, SHORT)]]).toEqual([OUT_TARGET, OUT_STOP]);
    // S3 (2.5, 5): only bar 40 reaches 97.5 — outside a 30-bar hold, inside a 240-bar one. The short's target is 95.
    expect([t.out[cs('S3', 0.5, LONG)], t.out[cs('S3', 4, LONG)], t.out[cs('S3', 72, SHORT)]]).toEqual([OUT_TIMEOUT, OUT_STOP, OUT_TIMEOUT]);
    // S4 (5, 10): never reached
    expect([t.out[cs('S4', 72, LONG)], t.out[cs('S4', 72, SHORT)]]).toEqual([OUT_TIMEOUT, OUT_TIMEOUT]);
    // S5 at 4 h: sigma_H = 0.8 %: 99.2 and 101.6. Bar 3 reaches neither; bar 10 reaches the long's target and the short's stop 100.8.
    expect([t.out[cs('S5', 4, LONG)], t.out[cs('S5', 4, SHORT)]]).toEqual([OUT_TARGET, OUT_STOP]);
    // S8 (1, 0.5): bar 3 reaches the long's target 100.5 and not its stop 99
    expect(t.out[cs('S8', 0.5, LONG)]).toBe(OUT_TARGET);
    // the bar that opens at the entry instant counts: a touch in bar 0
    const t0 = labeler.newCellTable(1);
    labeler.labelEntry(flat({ 0: [100.8, 99.99] }), M, SIGMA_1H, t0, 0);
    expect([t0.out[cs('S1', 0.5, LONG)], t0.out[cs('S1', 0.5, SHORT)]]).toEqual([OUT_TARGET, OUT_STOP]);
    // a touch in the last bar of a hold counts, one bar later does not
    const tl = labeler.newCellTable(2);
    labeler.labelEntry(flat({ 29: [100.8, 99.99] }), M, SIGMA_1H, tl, 0);
    labeler.labelEntry(flat({ 30: [100.8, 99.99] }), M, SIGMA_1H, tl, 1);
    expect([tl.out[cs('S1', 0.5, LONG)], tl.out[N_CS + cs('S1', 0.5, LONG)], tl.out[N_CS + cs('S1', 4, LONG)]]).toEqual([OUT_TARGET, OUT_TIMEOUT, OUT_TARGET]);
  });

  it('baselines (a) and (b) are noEdgeOdds on the realized bracket, the fee on the target line only; null odds drop the bracket', () => {
    const t = labeler.newCellTable(1);
    labeler.labelEntry(flat(PATH), M, SIGMA_1H, t, 0);
    for (const [shape, hold, side] of [['S2', 4, LONG], ['S2', 4, SHORT], ['S5', 24, LONG], ['S9', 72, SHORT], ['S6', 0.5, LONG]] as const) {
      const sh = SHAPES[S(shape)];
      const sigmaHoldPct = SIGMA_1H * Math.sqrt(hold) * 100;
      const stopPct = sh.sigma ? sh.stop * sigmaHoldPct : sh.stop;
      const targetPct = sh.sigma ? sh.target * sigmaHoldPct : sh.target;
      const o = noEdgeOdds({ side: side === LONG ? 'long' : 'short', stopPct, targetPct, sigmaHoldPct, liqDistancePct: null });
      const k = cs(shape, hold, side);
      expect(o.raw.targetFirst).not.toBeNull();
      expect([t.aT[k], t.aS[k], t.bT[k], t.bS[k]]).toEqual([Math.min(1, o.raw.targetFirst! + ((o.raw.targetFirst! + o.raw.stopFirst!) * FEE_PCT) / (stopPct + targetPct)), o.raw.stopFirst, o.pTargetFirst, o.pStopFirst]);
      expect(t.aT[k]).toBeGreaterThan(o.raw.targetFirst!);
    }
    // a long and a short bracket of equal percentages are not the same bracket in log space
    expect(t.aT[cs('S2', 4, LONG)]).not.toBe(t.aT[cs('S2', 4, SHORT)]);
    const none = labeler.newCellTable(1);
    labeler.labelEntry(flat(PATH), M, null, none, 0);
    expect(labeler.countOutcomes(none)[OUT_NULL]).toBe(N_CS);
  });
});

describe('regime-diag: the entry draw', () => {
  const span: Span = { t0Ms: Date.UTC(2021, 0, 1), n: 40 * 1440 };
  const win: Win = { name: 'fit', lo: 0, hi: 30 * 1440 };
  const g = synthGrid(span, 'entries', { holes: new Set([15 * 1440]) });

  it('eligible instants have 10,080 unbroken minutes behind, an unbroken 72 h path, and t + 72 h inside the window', () => {
    const e = labeler.eligibleMinutes(g, win);
    // history starts at the corpus start; the hole at day 15 removes the instants whose history or path covers it
    const want: number[] = [];
    for (let m = 0; m < win.hi; m++) {
      const hole = 15 * 1440;
      if (m - 10_080 >= 0 && m + 4_320 <= win.hi && !(hole >= m - 10_080 && hole < m + 4_320)) want.push(m);
    }
    expect(e.length).toBe(want.length);
    expect([e[0], e[e.length - 1]]).toEqual([want[0], want[want.length - 1]]);
    expect([e[0], want.includes(15 * 1440 - 4_320), want.includes(15 * 1440 - 4_319), want.includes(15 * 1440 + 10_080), want.includes(15 * 1440 + 10_081)]).toEqual([10_080, true, false, false, true]);
    // a second window starts its own draw, with history reaching back into the first
    const later = labeler.eligibleMinutes(g, { name: 'holdout', lo: 30 * 1440, hi: 40 * 1440 });
    expect([later[0], later[later.length - 1]]).toEqual([30 * 1440, 40 * 1440 - 4_320]);
  });

  it('one seeded draw per window × position: round(24 × eligible / 1,440) instants, without replacement, reproducible', () => {
    const e = labeler.eligibleMinutes(g, win);
    const d = labeler.drawEntries(g, win, 'P03', '20261116');
    expect([d.eligible, d.picks.length]).toEqual([e.length, Math.round((24 * e.length) / 1440)]);
    expect([...d.picks]).toEqual([...sampleWithoutReplacement(e, d.picks.length, rngFor('20261116|fit|P03'))]);
    expect(new Set(d.picks).size).toBe(d.picks.length);
    expect([...labeler.drawEntries(g, win, 'P03', '20261116').picks]).toEqual([...d.picks]);
    expect([...labeler.drawEntries(g, win, 'P04', '20261116').picks]).not.toEqual([...d.picks]);
    expect([...labeler.drawEntries(g, { ...win, name: 'holdout' }, 'P03', '20261116').picks]).not.toEqual([...d.picks]);
    // the label is the study's: another study draws other instants of the same eligible minutes
    const other = labeler.drawEntries(g, win, 'P03', '20261117');
    expect([other.eligible, other.picks.length]).toEqual([d.eligible, d.picks.length]);
    expect([...other.picks]).toEqual([...sampleWithoutReplacement(e, d.picks.length, rngFor('20261117|fit|P03'))]);
    expect([...other.picks]).not.toEqual([...d.picks]);
  });
});

// EDGE-REGIME-DIAG-W1 CH2 — AC2.2: key A dates the known turns of a synthetic series; key B has zero lag on a
// synthetic step. AC2.4: key B's centring, broken, turns the step assertion red.
import { describe, expect, it, vi } from 'vitest';
import { aggregate, type Bars } from '../../src/scripts/regime-diag/archive.js';
import * as keys from '../../src/scripts/regime-diag/keys.js';
import { buildSeries, quietly, served } from '../../src/scripts/regime-diag/replay.js';
import { KEY_A, KEY_B_LEAD, LABELS, L_UP, TFS, type Span, type Win } from '../../src/scripts/regime-diag/diag-spec.js';
import { synthGrid } from '../../src/scripts/regime-diag/synth.js';

const TF1H = TFS[0];

async function mutated<T>(lever: string, fn: (m: typeof keys) => T): Promise<T> {
  process.env.REGIME_DIAG_MUTATE = lever;
  vi.resetModules();
  try {
    return fn(await import('../../src/scripts/regime-diag/keys.js'));
  } finally {
    delete process.env.REGIME_DIAG_MUTATE;
    vi.resetModules();
  }
}

/** A triangle of log closes: slope ±s, turning at the listed bars, with one counter-move too small to date. */
function zigzag(n: number, turns: number[], s: number, blipAt = -1): Float64Array {
  const x = new Float64Array(n);
  let dir = 1, t = 0;
  for (let k = 1; k < n; k++) {
    if (t < turns.length && k - 1 === turns[t]) { dir = -dir; t++; }
    // an 8-bar counter-move at half slope: a swing of 4s, under the 6-sigma threshold
    const blip = blipAt >= 0 && k > blipAt && k <= blipAt + 8;
    x[k] = x[k - 1] + (blip ? -dir * s * 0.5 : dir * s);
  }
  return x;
}

describe('regime-diag: key A (CEILING)', () => {
  const TURNS = [40, 95, 150, 190, 260, 300];
  it('AC2.2: dates the known turns of a synthetic series, and drops a swing under the threshold', () => {
    const x = zigzag(340, TURNS, 0.004, 210);
    const t = keys.keyATurns(x, KEY_A.w, KEY_A.lambda);
    expect(t.idx).toEqual(TURNS);
    expect(t.kind).toEqual([1, -1, 1, -1, 1, -1]);
    // the counter-move is a candidate pair on its own (a local peak and a local trough within 7 bars each side)
    const raw = keys.keyATurns(x, KEY_A.w, 0);
    expect(raw.idx).toEqual([40, 95, 150, 190, 210, 218, 260, 300]);
    expect(t.theta).toBeGreaterThan(4 * 0.004);
    expect(t.theta).toBeLessThan(55 * 0.004);
  });

  it('a tie goes to the first bar, a flat stretch has no candidate, a short series has no turn', () => {
    const x = zigzag(120, [40, 80], 0.004);
    x[41] = x[40]; // two equal maxima: the first one is the peak
    expect(keys.keyATurns(x, 7, 6).idx).toEqual([40, 80]);
    expect(keys.keyATurns(new Float64Array(200).fill(1), 7, 6).idx).toEqual([]);
    expect(keys.keyATurns(zigzag(15, [7], 0.004), 7, 6).idx).toEqual([]);
  });

  it('phases: up from a trough to the next peak, down from a peak to the next trough, undated outside the turns and off the series', () => {
    const x = zigzag(340, TURNS, 0.004, 210);
    const min = 60;
    // bars 100 … 439 of the grid are the window; bar 250 is short of a minute and leaves the series
    const nb = 500;
    const b: Bars = { min, nb, O: new Float64Array(nb), H: new Float64Array(nb), L: new Float64Array(nb), C: new Float64Array(nb).fill(NaN), V: new Float64Array(nb), cnt: new Int32Array(nb).fill(min) };
    const win: Win = { name: 'fit', lo: 100 * min, hi: 441 * min };
    let i = 0;
    for (let k = 100; k < 441; k++) { if (k === 250) { b.cnt[k] = 59; continue; } b.C[k] = Math.exp(x[i++]); }
    const a = keys.buildKeyA(b, TF1H, win);
    expect([a.nBars, a.holes, a.turns.idx]).toEqual([340, 1, TURNS]);
    const bar = (s: number): number => (s < 150 ? 100 + s : 101 + s); // series index -> grid bar
    expect([a.phase[bar(39)], a.phase[bar(40)], a.phase[bar(94)], a.phase[bar(95)], a.phase[bar(149)], a.phase[bar(150)], a.phase[bar(299)], a.phase[bar(300)]]).toEqual([0, 2, 2, 1, 1, 2, 2, 0]);
    expect([a.phase[250], a.phase[99], a.phase[441]]).toEqual([0, 0, 0]);
    expect([a.dated, a.up]).toEqual([260, (150 - 95) + (260 - 190)]);
    // an entry takes the phase of its last closed bar
    expect([keys.phaseAt(a, bar(95) * min + 60), keys.phaseAt(a, bar(95) * min + 119), keys.phaseAt(a, bar(95) * min + 59)]).toEqual([1, 1, 2]);
  });

  it('the volatility leg is the mean true range of the 14 bars after the call over the entry price; a short or broken stretch has none', () => {
    const min = 60, nb = 40;
    const b: Bars = { min, nb, O: new Float64Array(nb).fill(100), H: new Float64Array(nb).fill(101), L: new Float64Array(nb).fill(99), C: new Float64Array(nb).fill(100), V: new Float64Array(nb), cnt: new Int32Array(nb).fill(min) };
    const win: Win = { name: 'fit', lo: 0, hi: nb * min };
    b.H[12] = 107; // one wide bar among the 14 after minute 600: bars 10 … 23
    expect(keys.volLeg(b, win, 600, 100)).toBeCloseTo((13 * 2 + 8) / 14 / 100, 12);
    expect(keys.volLeg(b, win, 601, 50)).toBeCloseTo((13 * 2 + 8) / 14 / 50, 12); // inside bar 10: bars 11 … 24
    expect(keys.volLeg(b, win, 12 * 60 + 1, 100)).toBeCloseTo(2 / 100, 12); // bars 13 … 26: the wide bar is behind the call
    b.C[9] = 90; // the true range reads the previous close
    expect(keys.volLeg(b, win, 600, 100)).toBeCloseTo((11 + 12 * 2 + 8) / 14 / 100, 12);
    expect(Number.isNaN(keys.volLeg(b, win, 27 * 60, 100))).toBe(true); // bars 27 … 40 run past the window
    b.cnt[15] = 59;
    expect(Number.isNaN(keys.volLeg(b, win, 600, 100))).toBe(true);
  });
});

describe('regime-diag: key B (NO_LAG)', () => {
  // a quiet range, then a steady rise from bar 480
  const SPAN: Span = { t0Ms: Date.UTC(2021, 0, 1), n: 32 * 1440 };
  const STEP = 20 * 24;
  const g = synthGrid(SPAN, 'step', { segments: [{ minutes: STEP * 60, drift: 0, vol: 0.0003 }, { minutes: 12 * 1440, drift: 0.00008, vol: 0.0003 }] });
  const b = aggregate(g, 60);
  const win: Win = { name: 'fit', lo: 0, hi: SPAN.n };
  const s = quietly(() => buildSeries(g, b, TF1H, 'SYNTH'));
  const firstUp = (label: (j: number) => number): number => { for (let j = STEP - 40; j < STEP + 60; j++) if (label(j) === L_UP && label(j + 1) === L_UP && label(j + 2) === L_UP) return j; return -1; };

  /** AC2.2's assertion: the served label reaches the step late; key B, the same rule centred, is there at the step. */
  function zeroLag(mod: typeof keys): number {
    const servedAt = firstUp((j) => s.label[j]);
    const keyBAt = firstUp((j) => quietly(() => mod.keyBAt(g, b, TF1H, win, j * 60, 'SYNTH'))?.label ?? -1);
    const servedLag = servedAt - STEP;
    expect(servedLag).toBeGreaterThan(0);
    expect(servedLag).toBeLessThanOrEqual(KEY_B_LEAD);
    expect(Math.max(0, keyBAt - STEP)).toBe(0); // zero lag
    expect(keyBAt).toBe(servedAt - KEY_B_LEAD); // the centring: the same rule, 14 bars of hindsight
    return servedLag;
  }

  it('AC2.2: key B has zero lag on a synthetic step', () => {
    expect(LABELS[s.label[STEP - 1]]).toBe('RANGING');
    expect(zeroLag(keys)).toBeGreaterThan(0);
  });

  it('key B is the served call 14 bars later, inside a bar too, and has no label past the window or over a hole', () => {
    for (const m of [STEP * 60, STEP * 60 + 17, 300 * 60 + 59]) {
      expect(quietly(() => keys.keyBAt(g, b, TF1H, win, m, 'SYNTH'))).toEqual(quietly(() => served(g, b, TF1H, m + 14 * 60, 'SYNTH')));
      expect(quietly(() => keys.keyBAt(g, b, TF1H, win, m, 'SYNTH', 7))).toEqual(quietly(() => served(g, b, TF1H, m + 7 * 60, 'SYNTH')));
    }
    const short: Win = { name: 'fit', lo: 0, hi: STEP * 60 + 14 * 60 };
    expect(keys.keyBAt(g, b, TF1H, short, STEP * 60, 'SYNTH')).toBeNull(); // t + 14 bars is the window's end, not inside it
    expect(keys.keyBAt(g, b, TF1H, short, STEP * 60 - 1, 'SYNTH')).not.toBeNull();
    const holed = synthGrid(SPAN, 'step', { holes: new Set([STEP * 60 + 100]) });
    expect(keys.keyBAt(holed, aggregate(holed, 60), TF1H, win, STEP * 60, 'SYNTH')).toBeNull();
  });

  it('AC2.4: with the centring broken (no lead), the step assertion is red; restored, green', async () => {
    await expect(mutated('keyb', (m) => zeroLag(m))).rejects.toThrow(/expected/);
    expect(zeroLag(keys)).toBeGreaterThan(0);
  });
});

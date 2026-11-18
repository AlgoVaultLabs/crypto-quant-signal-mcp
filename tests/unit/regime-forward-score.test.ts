// tests/unit/regime-forward-score.test.ts — EDGE-REGIME-FORWARD-W1: T3's answers 4 and 5 on served series.
//
// Synthetic venues only (tests/fixtures/regime-forward/synth.ts): labels that follow key A must read PASS on A4,
// labels that oppose it FAIL, one label everywhere NOT_IDENTIFIABLE, and too few clusters INDETERMINATE — the three
// states of registration §6, each reachable. The run-truncation that keeps runs starting at or after W1 out of A5,
// the venue-grid series and the bars rule are pinned here too.
// lesson 14: imported first — the homes resolve under the suite's own directory, fetch throws (isolate.ts)
import '../fixtures/regime-forward/isolate.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { L_DOWN, L_RANGING, L_UP, L_VOLATILE } from '../../src/scripts/regime-diag/diag-spec.js';
import { TFS, VENUES, W0_MS, W1_MS, originMs, tfMs, windowEndMs, type Venue } from '../../src/scripts/regime-forward/forward-spec.js';
import { a5Frame, emptySeries, flipflopsOf, labelFloors, scoreVenue, servedSeries, t5Census, truncateForRuns, windowLags, type ScoreOpts, type VenueData } from '../../src/scripts/regime-forward/score.js';
import { buildKeyA, type KeyA } from '../../src/scripts/regime-diag/keys.js';
import { barSeq, lagOf } from '../../src/scripts/regime-diag/bars.js';
import { kishOf } from '../../src/scripts/regime-diag/prims.js';
import { keyWin, scoreWin } from '../../src/scripts/regime-forward/forward-spec.js';
import { labelParity, lineOf, withBarsRule } from '../../src/scripts/regime-forward/forward-run.js';
import { loadSnapshot } from '../../src/scripts/regime-forward/snapshot.js';
import { SYNTH_COINS, snapLine, synthBars, synthRows, type Mode } from '../fixtures/regime-forward/synth.js';
import { SNAP_COLS } from '../../src/scripts/regime-forward/forward-spec.js';

// The resamples block the worker; one setImmediate per test lets vitest's RPC replies drain (as regime-diag-guard).
afterEach(() => new Promise<void>((done) => { setImmediate(done); }));

/** Coin tokens come only from the synthetic generator (R6). */
const C1 = SYNTH_COINS[0], C2 = SYNTH_COINS[1];
const OPTS: ScoreOpts = { B: 199, shuffleB: 99, permB: 99, seeds: { a4Boot: 11, a4Shuffle: 12, a5Boot: 13, a5Shuffle: 14, mono: 15 }, floorClusters: 20 };
const W_TF = [0.5, 0.3, 0.2];

function venue(v: Venue, mode: Mode): VenueData {
  const coins = [...SYNTH_COINS];
  const bars = coins.map((_, pos) => TFS.map((_, t) => synthBars(v, t, pos)));
  const series = coins.map((coin, pos) => TFS.map((_, t) => servedSeries(v, t, synthRows(v, t, coin, bars[pos][t], mode), bars[pos][t])));
  return { venue: v, coins, series, bars };
}

describe('the served series sits on the venue grid', () => {
  it('a row at close origin + j·I lands at j, with the close of bar j − 1', () => {
    for (const v of VENUES) {
      const b = synthBars(v, 1, 0), I = tfMs(TFS[1]), j = (W0_MS - originMs(v)) / I + 3;
      const s = servedSeries(v, 1, [{ venue: v, t: 1, coin: C1, bar: originMs(v) + j * I, label: L_UP, conf: 70, vol: 1 }], b);
      expect(Number.isInteger(j)).toBe(true);
      expect([s.ok[j], s.label[j], s.conf[j], s.close[j]]).toEqual([1, L_UP, 70, b.C[j - 1]]);
      expect(s.ok.reduce((a, x) => a + x, 0)).toBe(1);
    }
  });

  it('OKX and Bitget close daily bars at 16:00Z; Binance and Bybit at 00:00Z', () => {
    expect(VENUES.map((v) => new Date(originMs(v)).toISOString())).toEqual(['2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-01T16:00:00.000Z', '2026-11-01T16:00:00.000Z']);
  });
});

describe('A5 never counts a run that starts at or after W1 (registration §4.3)', () => {
  const v: Venue = 'BINANCE', t = 0, I = tfMs(TFS[0]);
  const jW1 = (W1_MS - originMs(v)) / I, jEnd = (windowEndMs(TFS[0]) - originMs(v)) / I;
  const s0 = (labels: Array<[number, number]>): ReturnType<typeof emptySeries> => {
    const s = emptySeries(t, jEnd + 5);
    for (let j = jW1 - 10; j < jEnd; j++) s.ok[j] = 1;
    for (const [from, l] of labels) for (let j = from; j < jEnd; j++) s.label[j] = l;
    return s;
  };

  it('the run crossing W1 ends at its first change, which carries a label that opens no run; nothing after it is kept', () => {
    const s = truncateForRuns(s0([[jW1 - 10, L_UP], [jW1 + 3, L_DOWN]]), v);
    expect(s.label[jW1 + 2]).toBe(L_UP);
    expect([s.ok[jW1 + 3], s.label[jW1 + 3]]).toEqual([1, L_RANGING]);
    expect(s.ok[jW1 + 4]).toBe(0);
  });

  it('a change at W1 itself is the end of the run before it, never the start of one', () => {
    const s = truncateForRuns(s0([[jW1 - 10, L_RANGING], [jW1, L_UP]]), v);
    expect([s.ok[jW1], s.label[jW1]]).toEqual([1, L_VOLATILE]);
    expect(s.ok[jW1 + 1]).toBe(0);
  });

  it('a run with no change inside the look-ahead stays open (censored): every close to the look-ahead end is kept', () => {
    const s = truncateForRuns(s0([[jW1 - 10, L_UP]]), v);
    expect(s.ok[jEnd - 1]).toBe(1);
    expect(s.ok[jEnd]).toBe(0);
  });

  it('a hole after W1 cuts the series before it', () => {
    const raw = s0([[jW1 - 10, L_UP]]);
    raw.ok[jW1 + 2] = 0;
    const s = truncateForRuns(raw, v);
    expect([s.ok[jW1], s.ok[jW1 + 1], s.ok[jW1 + 2], s.ok[jW1 + 3]]).toEqual([1, 1, 0, 0]);
  });
});

describe('lag reads the turns dated inside the window only (registration §4.4)', () => {
  it('the window\'s turns are the ones whose bar closes in [W0, W1); the history and look-ahead turns are not read', () => {
    // the daily series of this synthetic coin has a turn in the history, in the window and in the look-ahead
    const v: Venue = 'BITGET', t = 2, b = synthBars(v, t, 1), ka = buildKeyA(b, TFS[t], keyWin(v, TFS[t])), m = TFS[t].min;
    const s = servedSeries(v, t, synthRows(v, t, C2, b, 'agree'), b), w = scoreWin(v);
    const inside = ka.turns.idx.filter((i) => (ka.bars[i] + 1) * m >= w.lo && (ka.bars[i] + 1) * m < w.hi).length;
    const before = ka.turns.idx.filter((i) => (ka.bars[i] + 1) * m < w.lo).length, after = ka.turns.idx.filter((i) => (ka.bars[i] + 1) * m >= w.hi).length;
    expect(before).toBeGreaterThan(0);
    expect(after).toBeGreaterThan(0);
    const x = windowLags(ka, s, v);
    expect(x.turns).toBe(inside);
    expect(x.turns + x.censored).toBeGreaterThan(0);
    expect(x.lags.length + x.censored).toBe(inside);
    expect(lagOf(ka, s).turns).toBe(before + inside + after);
  });
});

describe('answers 4 and 5 reach each of the three states', () => {
  it('labels that follow key A: A4 PASS', () => {
    const d = venue('BINANCE', 'agree');
    const r = scoreVenue(d, t5Census(d.coins, W_TF), OPTS);
    expect(r.A4.identifiable).toBe(true);
    expect([r.A4.state, r.A4.cause]).toEqual(['PASS', expect.stringContaining('every comparator')]);
    expect(r.cluster_sensitive).toEqual({ state: 'UNDEFINED', dayClusters: expect.any(Number), needed: 50 });
    expect(r.cluster_sensitive.dayClusters).toBeLessThanOrEqual(31);
    expect(['PASS', 'FAIL', 'INDETERMINATE']).toContain(r.A5.state);
  }, 120_000);

  it('labels that oppose key A: A4 FAIL', () => {
    const d = venue('OKX', 'oppose');
    const r = scoreVenue(d, t5Census(d.coins, W_TF), OPTS);
    expect(r.A4.state).toBe('FAIL');
  }, 120_000);

  it('one label everywhere: A4 INDETERMINATE, NOT_IDENTIFIABLE, and no A4 statistic is computed', () => {
    const d = venue('BYBIT', 'up');
    const r = scoreVenue(d, t5Census(d.coins, W_TF), OPTS);
    expect([r.A4.state, r.A4.cause, r.A4.reading]).toEqual(['INDETERMINATE', 'NOT_IDENTIFIABLE', null]);
  }, 120_000);

  it('F7 (ZZ6): too few clusters for the floor — both answers INDETERMINATE, both readings null, and no bootstrap, shuffle or permutation runs', () => {
    const d = venue('BITGET', 'agree');
    const ops = bridgeOps(() => scoreVenue(d, t5Census(d.coins, W_TF), { ...OPTS, floorClusters: 1e6 }));
    const r = ops.value;
    expect([r.A4.state, r.A5.state]).toEqual(['INDETERMINATE', 'INDETERMINATE']);
    expect([r.A4.cause, r.A5.cause]).toEqual(['fewer than 1000000 effective clusters', 'fewer than 1000000 effective clusters']);
    expect([r.A4.reading, r.A5.reading, r.descriptive.mono]).toEqual([null, null, null]);
    expect(r.A4.eff).toBeGreaterThan(0);
    expect(r.A5.eff).toBeGreaterThan(0);
    expect(ops.names.filter((n) => n === 'bounds' || n === 'perm')).toEqual([]);
    expect(ops.names).toContain('kish');
  }, 120_000);

  it('above the floor the same venue computes its readings (the bridge log is not blind)', () => {
    const d = venue('BITGET', 'agree');
    const ops = bridgeOps(() => scoreVenue(d, t5Census(d.coins, W_TF), OPTS));
    expect(ops.value.A4.reading).not.toBeNull();
    expect(ops.names).toContain('bounds');
    expect(ops.names).toContain('perm');
  }, 120_000);

  it('the label-only floors need no bar and count what A4 and A5 will read', () => {
    const d = venue('BINANCE', 'agree');
    const none: VenueData = { ...d, bars: d.bars.map((x) => x.map(() => null)) };
    const f = labelFloors(none, t5Census(d.coins, W_TF));
    expect(f.a4TrendingRows).toBeGreaterThan(0);
    expect(f.a5Runs).toBeGreaterThan(0);
    expect(f.dayClusters).toBeLessThanOrEqual(31);
    expect(f.labelMinority).toBeGreaterThan(0.3);
  }, 120_000);
});

describe('the floors on disk before the seal count the populations the read computes (arc lesson 2)', () => {
  it('with every bar present, A5\'s pre-seal run count is the run count A5 reads, and A4\'s TRENDING closes bound its rows', () => {
    const d = venue('BINANCE', 'agree'), census = t5Census(d.coins, W_TF);
    const f = labelFloors({ ...d, bars: d.bars.map((x) => x.map(() => null)) }, census), r = scoreVenue(d, census, OPTS);
    expect(r.A5.reading?.runs).toBe(f.a5Runs);
    expect(r.A4.reading?.rows).toBeGreaterThan(0);
    expect(r.A4.reading?.rows).toBeLessThanOrEqual(f.a4TrendingRows);
  }, 120_000);
});

describe('the bars rule and the verdict line', () => {
  const base = { venue: 'BINANCE' as Venue, coins: 100, A4: { state: 'PASS' as const, cause: 'x', identifiable: true, phaseMinority: 0.4, phaseBound: 80, reading: null },
    A5: { state: 'FAIL' as const, cause: 'y', reading: null }, cluster_sensitive: { state: 'UNDEFINED' as const, dayClusters: 30, needed: 50 }, descriptive: { lag: [], flipflops: [], mono: null } };

  it('5 % of coins without bars keeps the states; more turns both answers INDETERMINATE', () => {
    expect(withBarsRule(base, 5, 100)).toBe(base);
    const r = withBarsRule(base, 6, 100);
    expect([r.A4.state, r.A5.state]).toEqual(['INDETERMINATE', 'INDETERMINATE']);
    expect(r.A4.cause).toMatch(/^BARS_UNAVAILABLE/);
  });

  it('the line names every venue and both answers', () => {
    expect(lineOf(VENUES.map((v) => ({ ...base, venue: v })))).toBe('REGIME_FORWARD_VERDICT=BINANCE:A4=PASS,A5=FAIL;BYBIT:A4=PASS,A5=FAIL;OKX:A4=PASS,A5=FAIL;BITGET:A4=PASS,A5=FAIL');
  });
});

describe('label parity counts what a caller received against the last served close', () => {
  it('F13: a call stamped exactly at a close is read against the close before it ("before", not "at or before")', () => {
    const I = tfMs(TFS[0]), bar = W0_MS + 2 * I;
    const text = [SNAP_COLS.join('|'), snapLine({ venue: 'BINANCE', tf: '1h', coin: C1, bar, label: L_UP, conf: 50 }), snapLine({ venue: 'BINANCE', tf: '1h', coin: C1, bar: bar + I, label: L_DOWN, conf: 50 })].join('\n');
    const loaded = loadSnapshot(text, new Set());
    expect(labelParity(loaded, [{ venue: 'BINANCE', t: 0, coin: C1, atMs: bar + I, label: L_UP }])).toEqual({ calls: 1, equal: 1, differ: 0, no_row: 0 });
    expect(labelParity(loaded, [{ venue: 'BINANCE', t: 0, coin: C1, atMs: bar, label: L_UP }])).toEqual({ calls: 1, equal: 0, differ: 0, no_row: 1 });
  });

  it('equal, different and before-any-row are counted; nothing else is read of a call', () => {
    const I = tfMs(TFS[0]), bar = W0_MS + 2 * I;
    const text = [SNAP_COLS.join('|'), snapLine({ venue: 'BINANCE', tf: '1h', coin: C1, bar, label: L_UP, conf: 50 }), snapLine({ venue: 'BINANCE', tf: '1h', coin: C1, bar: bar + I, label: L_DOWN, conf: 50 })].join('\n');
    const loaded = loadSnapshot(text, new Set());
    const p = labelParity(loaded, [
      { venue: 'BINANCE', t: 0, coin: C1, atMs: bar + 60_000, label: L_UP },
      { venue: 'BINANCE', t: 0, coin: C1, atMs: bar + I + 60_000, label: L_UP },
      { venue: 'BINANCE', t: 0, coin: C1, atMs: bar - 1, label: L_UP },
      { venue: 'BYBIT', t: 0, coin: C1, atMs: bar + 60_000, label: L_UP },
    ]);
    expect(p).toEqual({ calls: 4, equal: 1, differ: 1, no_row: 2 });
  });
});

describe('F10: how far the look-ahead is read (registration §3, §4.3, §4.4)', () => {
  it('A5 reads each series from its first close at or after W0 to its cut: the closes after W1 up to the cut are in its sequence', () => {
    const v: Venue = 'BINANCE', d = venue(v, 'agree'), f = a5Frame(d, t5Census(d.coins, W_TF));
    let reachesPastW1 = 0;
    for (const c of f.coins) c.series.forEach((s, t) => {
      const q = barSeq(s, f.win, c.pos, t, 0), min = TFS[t].min, o = originMs(v);
      const cut = truncateForRuns(d.series[c.pos][t], v);
      let last = -1;
      for (let j = 0; j <= cut.nb; j++) if (cut.ok[j]) last = j;
      expect(q.n).toBeGreaterThan(0);
      expect(q.j[0]).toBe(Math.ceil((W0_MS - o) / 60_000 / min));
      expect(q.j[q.n - 1]).toBe(last);
      expect(o + q.j[q.n - 1] * min * 60_000).toBeLessThan(windowEndMs(TFS[t]));
      if (o + q.j[q.n - 1] * min * 60_000 >= W1_MS) reachesPastW1++;
    });
    expect(reachesPastW1).toBeGreaterThan(0);
  });

  it('a window turn\'s lag may end on a close of the look-ahead, before the next turn', () => {
    const v: Venue = 'BINANCE', tf = TFS[0], I = tfMs(tf), o = originMs(v), jW1 = (W1_MS - o) / I, jEnd = (windowEndMs(tf) - o) / I;
    const kTurn = jW1 - 3, kNext = jW1 + 10;
    const ka: KeyA = { tf, win: keyWin(v, tf), bars: Int32Array.from([kTurn, kNext]), turns: { idx: [0, 1], kind: [-1, 1], theta: 0 }, phase: new Uint8Array(0), nBars: 2, holes: 0, dated: 0, up: 0 };
    const s = emptySeries(0, jEnd + 2);
    for (let j = jW1 - 10; j < jEnd; j++) { s.ok[j] = 1; s.label[j] = j >= jW1 + 3 ? L_UP : L_RANGING; }
    const x = windowLags(ka, s, v);
    expect([x.turns, x.censored, x.lags]).toEqual([1, 0, [5]]);
    expect(o + (kTurn + 1) * I).toBeLessThan(W1_MS);           // the turn's bar closes inside the window
    expect(o + (kTurn + 1 + 5) * I).toBeGreaterThan(W1_MS);     // its lag ends on a look-ahead close
  });
});

describe('F11: flip-flops are counted on [W0, W1) only', () => {
  it('a series whose flip-flops all lie in the look-ahead counts none; the same flip-flops inside the window count', () => {
    const v: Venue = 'OKX', d = venue(v, 'up'), I = tfMs(TFS[0]), o = originMs(v), jW1 = (W1_MS - o) / I;
    const flip = (from: number): VenueData => {
      const series = d.series.map((perTf) => perTf.map((s, t) => {
        if (t !== 0) return s;
        const c = { ...s, label: s.label.slice() };
        for (let j = from; j < from + 6; j++) if (c.ok[j]) c.label[j] = j % 2 ? L_DOWN : L_UP;
        return c;
      }));
      return { ...d, series };
    };
    expect(flipflopsOf(d)[0].changes).toBe(0);
    const late = flipflopsOf(flip(jW1 + 2))[0], early = flipflopsOf(flip(jW1 - 10))[0];
    expect([late.changes, late.per1000]).toEqual([0, 0]);
    expect(early.changes).toBeGreaterThan(0);
    expect(early.per1000).toBeGreaterThan(0);
  });
});

describe('F12: the label-side effective clusters are an estimate, not a bound', () => {
  it('Kish\'s count is not monotone in the rows: removing rows can raise it', () => {
    const [whole, fewer] = kishOf([[3, 1, 1], [1, 1, 1]]);
    expect(fewer).toBeGreaterThan(whole); // [3,1,1] → 25/11; drop two of the first cluster's rows → [1,1,1] → 3
  });
});

/** Runs `f` with python3 wrapped so every bridge request's op names are logged, and returns them with f's value. */
function bridgeOps<T>(f: () => T): { value: T; names: string[] } {
  const real = execFileSync('/usr/bin/env', ['which', 'python3'], { encoding: 'utf8' }).trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-forward-pylog-')), logFile = path.join(dir, 'ops.log');
  fs.writeFileSync(path.join(dir, 'python3'), [
    '#!/bin/sh',
    'IN=$(cat)',
    `printf '%s' "$IN" | "${real}" -I -c 'import json,sys; d=json.loads(sys.stdin.read() or "{}"); print(",".join(o.get("op","?") for o in d.get("ops",[])))' >> "${logFile}"`,
    `printf '%s' "$IN" | exec "${real}" "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  const old = process.env.PATH;
  process.env.PATH = `${dir}:${old}`;
  try {
    const value = f();
    return { value, names: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split(/[\n,]/).filter(Boolean) : [] };
  } finally {
    process.env.PATH = old;
  }
}

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

// EDGE-SR-LEVEL-PROBE-W1 CH1 — the frozen Level v0 definition, held to known answers (AC1.1), to the mirror
// property (AC1.2), and to two mutations that MUST break those (AC1.3); the label-free statement's column list,
// parsed from the generator's executed output (AC1.4); and the pins that tie the registration to the code it
// registers. Internal META research: nothing under test here is imported by a serving path.

import {
  V0, asOfBars, callFeatures, layerLevels, pivotPrices, wilderAtr,
  type Bar, type CallFeatures, type LayerSeries, type Side, type V0Params,
} from '../../src/scripts/sr-probe/level-v0.js';
import { layersFor, seededShuffle, PRIMARY_TIMEFRAMES, DESCRIPTIVE_TIMEFRAMES } from '../../src/scripts/sr-probe/plan.js';
import {
  LABELFREE_HEADER, LABELS_HEADER, OUTCOME_COLUMNS, SR_VENUES, labelFreeSql, labelTableColumns, partDefects, selectedColumns,
  sessionScript,
} from '../../src/scripts/sr-probe/sr-extract-sql.js';

const H = 3_600_000;
const T0 = Date.UTC(2026, 8, 1);
const closeOf = (i: number): number => T0 + (i + 1) * H;

/** 45 one-hour bars on integer ticks: a triangle wave (period 14, 4 ticks a bar), three tweaked bars. Seen whole,
 *  it has swing highs at bars 7, 21, 35 (428, 429, 436) and swing lows at bars 14, 28 (398, 399). */
function fixture(): Bar[] {
  const tri = (i: number): number => 7 - Math.abs(7 - (i % 14));
  const bars = Array.from({ length: 45 }, (_, i) => {
    const high = 400 + 4 * tri(i);
    return { time: T0 + i * H, open: high - 1, high, low: high - 2, close: high - 1 };
  });
  bars[21].high = 429;
  bars[35].high = 436;
  bars[28].high = 401;
  bars[28].low = 399;
  return bars;
}

type Want = Partial<Pick<CallFeatures, 'opposing' | 'f' | 'fBin' | 'behind' | 'naive' | 'opposingStrong' | 'nOpposing'>>;
interface Case { name: string; side: Side; entry: number; dist: number; upTo: number; layer: number; want: Want }

const CASES: readonly Case[] = [
  { name: 'BUY under a two-touch level inside the target', side: 'BUY', entry: 416, dist: 16, upTo: 44, layer: 1, want: { opposing: true, f: 0.78125, fBin: 'F3', behind: false, nOpposing: 1, naive: false, opposingStrong: false } },
  { name: 'BUY, the level is past the target', side: 'BUY', entry: 416, dist: 12, upTo: 44, layer: 1, want: { opposing: false, f: null, fBin: 'CLEAR' } },
  { name: 'BUY, the level sits exactly on the target (strictly between only)', side: 'BUY', entry: 412.5, dist: 16, upTo: 44, layer: 1, want: { opposing: false, fBin: 'CLEAR' } },
  { name: 'BUY, near bin', side: 'BUY', entry: 426, dist: 16, upTo: 44, layer: 1, want: { opposing: true, f: 0.15625, fBin: 'F1' } },
  { name: 'BUY, middle bin', side: 'BUY', entry: 420, dist: 16, upTo: 44, layer: 1, want: { opposing: true, f: 0.53125, fBin: 'F2' } },
  { name: 'BUY just above a level: CLEAR and BEHIND', side: 'BUY', entry: 400, dist: 8, upTo: 44, layer: 1, want: { opposing: false, behind: true } },
  { name: 'BEHIND is inclusive at 0.25 x barrier distance', side: 'BUY', entry: 400.5, dist: 8, upTo: 44, layer: 1, want: { behind: true } },
  { name: 'just past the BEHIND band', side: 'BUY', entry: 400.75, dist: 8, upTo: 44, layer: 1, want: { behind: false } },
  { name: 'SELL over a two-touch level inside the target', side: 'SELL', entry: 410, dist: 16, upTo: 44, layer: 1, want: { opposing: true, f: 0.71875, fBin: 'F3', behind: false, naive: true } },
  { name: 'SELL just under a level: CLEAR and BEHIND', side: 'SELL', entry: 427, dist: 8, upTo: 44, layer: 1, want: { opposing: false, behind: true } },
  { name: 'a level exactly at the entry is neither opposing nor behind', side: 'BUY', entry: 428.5, dist: 8, upTo: 44, layer: 1, want: { opposing: false, behind: false } },
  { name: 'a single-touch level never opposes; the naive high does', side: 'BUY', entry: 430, dist: 8, upTo: 44, layer: 1, want: { opposing: false, behind: true, naive: true } },
  { name: 'two touches on L2 weigh 4: strong', side: 'BUY', entry: 416, dist: 16, upTo: 44, layer: 2, want: { opposing: true, opposingStrong: true } },
  { name: 'two touches on L3 weigh 6: strong', side: 'BUY', entry: 416, dist: 16, upTo: 44, layer: 3, want: { opposing: true, opposingStrong: true } },
  // The call lands at the close of bar 23: bar 21's swing high needs bar 24 to be confirmed, so it is not a pivot yet.
  { name: 'a pivot is not usable before its third bar after closes', side: 'BUY', entry: 416, dist: 16, upTo: 23, layer: 1, want: { opposing: false, fBin: 'CLEAR', nOpposing: 0 } },
];

function featuresOf(c: Case, p: V0Params, bars: Bar[] = fixture()): CallFeatures {
  return callFeatures(c.side, c.entry, c.dist, closeOf(c.upTo), [{ layer: c.layer, stepMs: H, bars }], p);
}

/** AC1.1 as a function of the definition's parameters: the known answers it gets wrong (empty = all right). */
function checkAc11(p: V0Params): string[] {
  const fails: string[] = [];
  const asOf = asOfBars(fixture(), H, closeOf(44), p);
  const piv = pivotPrices(asOf, p.pivotK);
  if (JSON.stringify(piv) !== JSON.stringify({ highs: [428, 429, 436], lows: [398, 399] })) fails.push('pivots of the whole fixture');
  const lv = layerLevels(asOf, 1, p).map((l) => [l.price, l.touches, l.strength]);
  if (JSON.stringify(lv) !== JSON.stringify([[398.5, 2, 2], [428.5, 2, 2], [436, 1, 1]])) fails.push('levels of the whole fixture');
  for (const c of CASES) {
    const got = featuresOf(c, p) as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(c.want)) if (got[k] !== v) fails.push(`${c.name}: ${k} = ${String(got[k])}, want ${String(v)}`);
  }
  return fails;
}

// ── AC1.2: the mirror ────────────────────────────────────────────────────────────────────────────────────────

const mirrorBars = (bars: readonly Bar[], K: number): Bar[] =>
  bars.map((b) => ({ time: b.time, open: K - b.open, high: K - b.low, low: K - b.high, close: K - b.close }));
const flip = (s: Side): Side => (s === 'BUY' ? 'SELL' : 'BUY');
const COMPARED = ['opposing', 'f', 'fBin', 'behind', 'naive', 'opposingStrong', 'nOpposing', 'nQualifying'] as const;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Walk { side: Side; entry: number; dist: number; createdAt: number; layers: LayerSeries[]; mirrored: LayerSeries[]; K: number }

/** One seeded call on three layers of integer random walks. Each series — and, separately, its mirror — carries
 *  two bars that open AT or AFTER the call, and those are NOT mirror images of each other: a definition that reads
 *  one bar past the call sees different things on the two sides. */
function walk(seed: number): Walk {
  const r = rng(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
  const K = 4000;
  const createdAt = T0 + 400 * 24 * H;
  const series = (layer: number, stepMs: number, n: number): { own: LayerSeries; mir: LayerSeries } => {
    const bars: Bar[] = [];
    let close = 1000 + int(-50, 50);
    for (let i = n; i >= 1; i--) {
      const open = close;
      close = open + int(-6, 6);
      bars.push({ time: createdAt - i * stepMs, open, high: Math.max(open, close) + int(0, 4), low: Math.min(open, close) - int(0, 4), close });
    }
    const after = (spike: number): Bar[] => [0, 1].map((j) => ({ time: createdAt + j * stepMs, open: close, high: close + spike, low: close - 1, close }));
    return {
      own: { layer, stepMs, bars: [...bars, ...after(500)] },
      mir: { layer, stepMs, bars: [...mirrorBars(bars, K), ...after(900).map((b) => ({ ...b, open: K - close, close: K - close, low: K - close - 1, high: K - close + 900 }))] },
    };
  };
  const built = [series(1, H, 330), series(2, 4 * H, 120), series(3, 24 * H, 60)];
  const lastClose = built[0].own.bars[329].close;
  return {
    side: r() < 0.5 ? 'BUY' : 'SELL', entry: lastClose + int(-3, 3) + (r() < 0.5 ? 0.5 : 0), dist: int(4, 40), createdAt, K,
    layers: built.map((b) => b.own), mirrored: built.map((b) => b.mir),
  };
}

const WALKS: readonly Walk[] = Array.from({ length: 200 }, (_, i) => walk(20261110 + i));

function sameStratum(a: CallFeatures, b: CallFeatures): boolean {
  return COMPARED.every((k) => a[k] === b[k]) && JSON.stringify(a.layerBars) === JSON.stringify(b.layerBars);
}

/** AC1.2 as a function of the parameters: the calls whose mirror image lands in a different stratum or f. */
function checkAc12(p: V0Params): string[] {
  const fails: string[] = [];
  const K = 1000;
  for (const c of CASES) {
    const a = featuresOf(c, p);
    const b = callFeatures(flip(c.side), K - c.entry, c.dist, closeOf(c.upTo), [{ layer: c.layer, stepMs: H, bars: mirrorBars(fixture(), K) }], p);
    if (!sameStratum(a, b)) fails.push(`fixture: ${c.name}`);
  }
  WALKS.forEach((w, i) => {
    const a = callFeatures(w.side, w.entry, w.dist, w.createdAt, w.layers, p);
    const b = callFeatures(flip(w.side), w.K - w.entry, w.dist, w.createdAt, w.mirrored, p);
    if (!sameStratum(a, b)) fails.push(`walk ${i}`);
  });
  return fails;
}

const LOOKAHEAD: V0Params = { ...V0, lookaheadBars: 1 };
const K2: V0Params = { ...V0, pivotK: 2 };

describe('Level v0 — known answers (AC1.1)', () => {
  it('every fixture answer holds under the registered parameters', () => {
    expect(checkAc11(V0)).toEqual([]);
  });

  it('the registered constants are the frozen ones', () => {
    expect(V0).toEqual({ pivotK: 3, lookbackBars: 300, atrPeriod: 14, mergeAtrMult: 0.25, minTouches: 2, strongMin: 4, behindFrac: 0.25, naiveBars: 50, lookaheadBars: 0 });
    expect(Object.isFrozen(V0)).toBe(true);
  });

  it('a bar is visible only once it has closed, and only the last 300 are kept', () => {
    const bars = fixture();
    expect(asOfBars(bars, H, closeOf(23)).map((b) => b.time)).toEqual(bars.slice(0, 24).map((b) => b.time));
    expect(asOfBars(bars, H, closeOf(23) - 1)).toHaveLength(23); // one ms before bar 23 closes
    const long = Array.from({ length: 320 }, (_, i) => ({ time: T0 + i * H, open: 1, high: 2, low: 0, close: 1 }));
    const kept = asOfBars([...long, long[5]], H, closeOf(319));
    expect(kept).toHaveLength(300);
    expect(kept[0].time).toBe(long[20].time);
  });

  it('ATR14 is Wilder\'s, as of the last bar, and undefined under 15 bars', () => {
    const flat = (n: number): Bar[] => Array.from({ length: n }, (_, i) => ({ time: T0 + i * H, open: 100, high: 100.5, low: 99.5, close: 100 }));
    expect(wilderAtr(flat(14))).toBeNull();
    expect(wilderAtr(flat(15))).toBe(1);
    expect(wilderAtr(flat(40))).toBe(1);
    const jump = [...flat(15), { time: T0 + 15 * H, open: 100, high: 114.5, low: 99.5, close: 100 }];
    expect(wilderAtr(jump)).toBe(2); // (13 x 1 + 15) / 14
    expect(layerLevels(flat(14), 1)).toEqual([]);
  });

  it('a plateau counts every tied bar as a pivot, and the merge is single-link on 0.25 x ATR', () => {
    const bars = fixture();
    bars[8].high = 428; // ties bar 7
    expect(pivotPrices(asOfBars(bars, H, closeOf(44))).highs).toEqual([428, 428, 429, 436]);
    const lv = layerLevels(asOfBars(bars, H, closeOf(44)), 1);
    expect(lv.map((l) => [l.price, l.touches])).toEqual([[398.5, 2], [428, 3], [436, 1]]);
    // 436 stays apart: 7 ticks from 429 against a gap of about 1.3
    expect(lv[1].atr * V0.mergeAtrMult).toBeGreaterThan(1);
    expect(lv[1].atr * V0.mergeAtrMult).toBeLessThan(7);
  });
});

describe('Level v0 — the mirror property (AC1.2)', () => {
  it('p -> K - p with highs <-> lows and BUY <-> SELL swapped gives the same stratum and f: fixtures and 200 seeded walks', () => {
    expect(checkAc12(V0)).toEqual([]);
  });

  it('the walks reach every stratum, so the property is not held vacuously', () => {
    const got = WALKS.map((w) => callFeatures(w.side, w.entry, w.dist, w.createdAt, w.layers));
    const count = (f: (x: CallFeatures) => boolean): number => got.filter(f).length;
    expect(count((x) => x.opposing)).toBeGreaterThanOrEqual(20);
    expect(count((x) => !x.opposing)).toBeGreaterThanOrEqual(20);
    expect(count((x) => x.behind)).toBeGreaterThanOrEqual(10);
    expect(count((x) => x.naive)).toBeGreaterThanOrEqual(10);
    expect(count((x) => x.opposingStrong)).toBeGreaterThanOrEqual(10);
    for (const bin of ['F1', 'F2', 'F3']) expect(count((x) => x.fBin === bin)).toBeGreaterThanOrEqual(3);
    expect(got.every((x) => x.layerBars[0] === 300 && x.layerBars[1] === 120 && x.layerBars[2] === 60)).toBe(true);
  });
});

describe('Level v0 — the tests can fail (AC1.3)', () => {
  it('a variant that admits one bar past created_at fails AC1.1 and AC1.2', () => {
    const a = checkAc11(LOOKAHEAD);
    expect(a.length).toBeGreaterThan(0);
    expect(a.some((f) => f.startsWith('a pivot is not usable before its third bar after closes'))).toBe(true);
    expect(checkAc12(LOOKAHEAD).some((f) => f.startsWith('walk'))).toBe(true);
  });

  it('a k = 2 variant fails AC1.1', () => {
    const a = checkAc11(K2);
    expect(a.length).toBeGreaterThan(0);
    expect(a.some((f) => f.startsWith('a pivot is not usable before its third bar after closes'))).toBe(true);
  });
});

describe('the label-free statement (AC1.4)', () => {
  it('its column list, parsed from the generator\'s executed output, is the label-free header and holds no outcome column', { timeout: 120_000 }, () => {
    const r = spawnSync('npx', ['tsx', 'src/scripts/sr-probe/sr-extract-sql.ts', '--part', 'labelfree'], { encoding: 'utf8', timeout: 90_000 });
    expect(r.status).toBe(0);
    const script = r.stdout;
    expect(script).toBe(sessionScript('labelfree'));
    const at = script.indexOf("\\echo '===EXTRACT==='");
    expect(at).toBeGreaterThan(0);
    const cols = selectedColumns(script.slice(at));
    expect(cols).toEqual([...LABELFREE_HEADER]);
    for (const bad of OUTCOME_COLUMNS) expect(cols).not.toContain(bad);
    expect(labelTableColumns(script).filter((c) => OUTCOME_COLUMNS.includes(c))).toEqual([]);
    // the same parser DOES see an outcome column where there is one
    const labels = sessionScript('labels');
    expect(labelTableColumns(labels)).toContain('label');
    expect(selectedColumns(labels.slice(labels.indexOf("\\echo '===LABELS==='")))).toEqual([...LABELS_HEADER]);
    // the generator's own refusal: clean as written, and red on a label-free statement that reads a label
    expect(partDefects('labelfree')).toEqual([]);
    expect(partDefects('labels')).toEqual([]);
    const leaky = labelFreeSql().replace('d.barrier_pct', 'd.label, d.barrier_pct');
    const defects = partDefects('labelfree', [{ name: 'extract', sql: leaky, header: LABELFREE_HEADER }]);
    expect(defects.some((d) => d.includes('reads outcome column(s) label'))).toBe(true);
    expect(defects.some((d) => d.startsWith('extract: selects ['))).toBe(true);
    for (const s of [script, labels]) {
      expect(s).toContain('BEGIN READ ONLY;');
      expect(s.includes('1790402400')).toBe(true); // T_DIAG_END bounds both statements
    }
  });
});

describe('the layer ladder (ruling Q2 = A): served steps only, never an invented interval', () => {
  const steps = (v: string, tf: string): string[] =>
    layersFor(v, tf).map((l) => `${l.stepMs % (24 * H) === 0 ? `${l.stepMs / (24 * H)}d` : l.stepMs % H === 0 ? `${l.stepMs / H}h` : `${l.stepMs / 60_000}m`}:${l.key}`);

  it('the per-venue table is the registered one', () => {
    const all = (tf: string): string[][] => SR_VENUES.map((v) => steps(v, tf));
    const same = (tf: string, want: string[]): void => expect(all(tf)).toEqual([want, want, want, want]);
    same('3m', ['3m:3m', '15m:15m', '1h:1h']);
    same('15m', ['15m:15m', '1h:1h', '4h:4h']);
    same('1h', ['1h:1h', '4h:4h', '1d:1d']);
    same('4h', ['4h:4h', '1d:1d']);
    same('12h', ['12h:12h']);
    same('1d', ['1d:1d']);
    // BINANCE, BYBIT, OKX, BITGET
    expect(all('5m')).toEqual([['5m:5m', '30m:30m', '2h:2h'], ['5m:5m', '30m:30m', '2h:2h'], ['5m:5m', '30m:30m', '2h:2h'], ['5m:5m', '30m:30m', '4h:4h']]);
    expect(all('30m')).toEqual([['30m:30m', '2h:2h', '8h:8h'], ['30m:30m', '2h:2h', '12h:12h'], ['30m:30m', '2h:2h', '12h:12h'], ['30m:30m', '4h:4h', '12h:12h']]);
    expect(all('2h')).toEqual([['2h:2h', '8h:8h'], ['2h:2h', '12h:12h'], ['2h:2h', '12h:12h'], ['1h:1h', '12h:12h']]);
    expect(steps('BINANCE', '8h')).toEqual(['8h:8h']);
    expect(steps('BITGET', '8h')).toEqual(['6h:8h']);
    // BYBIT and OKX have no 8h key (and no 8h call in the corpus): the ladder refuses rather than inventing one
    expect(() => layersFor('BYBIT', '8h')).toThrow(/sr-probe\/plan/);
    expect(() => layersFor('OKX', '8h')).toThrow(/sr-probe\/plan/);
  });

  it('the primary and descriptive cells partition the ten timeframes', () => {
    expect([...PRIMARY_TIMEFRAMES]).toEqual(['1h', '2h', '4h', '8h', '12h']);
    expect([...DESCRIPTIVE_TIMEFRAMES]).toEqual(['3m', '5m', '15m', '30m', '1d']);
  });

  it('the registered coin draw is a seeded permutation', () => {
    const coins = Array.from({ length: 40 }, (_, i) => `C${i}`);
    const a = seededShuffle(coins, 20261110);
    expect(a).toEqual(seededShuffle(coins, 20261110));
    expect(a).not.toEqual(seededShuffle(coins, 20261111));
    expect([...a].sort()).toEqual([...coins].sort());
    expect(a).not.toEqual(coins);
  });
});

describe('the probe\'s own gates can fail', () => {
  const analyze = (env: Record<string, string>): { status: number | null; stdout: string } => {
    const r = spawnSync('python3', ['-I', 'scripts/sr-probe/sr_analyze.py', '--self-test'], { encoding: 'utf8', timeout: 90_000, env: { ...process.env, ...env } });
    return { status: r.status, stdout: r.stdout };
  };

  it('the statistics harness self-test passes, and a broken derivation or a dropped 30-row floor turns it red', { timeout: 300_000 }, () => {
    const ok = analyze({ SR_ANALYZE_MUTATE: '' });
    expect(ok.stdout).toContain('SR_ANALYZE_SELFTEST_VERDICT=PASS');
    expect(ok.status).toBe(0);
    for (const m of ['swap_wins', 'no_min_arm']) {
      const bad = analyze({ SR_ANALYZE_MUTATE: m });
      expect(bad.stdout).toContain('SR_ANALYZE_SELFTEST_VERDICT=FAIL');
      expect(bad.status).toBe(1);
    }
  });

  it('the pull script\'s self-test passes', { timeout: 120_000 }, () => {
    const r = spawnSync('bash', ['scripts/sr-probe/sr-pull.sh', '--self-test'], { encoding: 'utf8', timeout: 90_000 });
    expect(r.stdout).toContain('SR_PULL_SELFTEST_VERDICT=PASS');
    expect(r.status).toBe(0);
  });
});

describe('what was registered is what is run', () => {
  const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
  const regs = readdirSync('audits').filter((f) => /^sr-level-probe-preregistration-\d{4}-\d{2}-\d{2}\.md$/.test(f));

  it('exactly one registration exists and it names the two read statements and the frozen code by sha256', () => {
    expect(regs).toHaveLength(1);
    const reg = readFileSync(`audits/${regs[0]}`, 'utf8');
    expect(reg).toContain(sha(sessionScript('labelfree')));
    expect(reg).toContain(sha(sessionScript('labels')));
    for (const f of ['src/scripts/sr-probe/level-v0.ts', 'src/scripts/sr-probe/sr-features.ts', 'src/scripts/sr-probe/plan.ts', 'scripts/sr-probe/sr_analyze.py']) {
      expect(reg, f).toContain(sha(readFileSync(f)));
    }
  });
});

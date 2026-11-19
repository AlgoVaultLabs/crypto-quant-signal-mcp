// tests/unit/regime-challenge-r2.test.ts — EDGE-REGIME-CHALLENGE-R2-W1 CH3: round 2's two new challengers as one-dial
// arms on the served label — C4 (M05, the strong tier's confidence cap) and C5 (M10, the TRENDING ≥ 60 trigger) —
// and their in-sample pre-score (AC3: parity at the served value, the month guard both ways, the sealed windows).
// Synthetic archives and a sandbox repository with a bare origin; the suite's homes, network and clock are its own
// (arc lesson 14: the isolate is imported first). The C4 copy is held to a frozen table, never to the live served
// core (arc lesson 15): the live check is `armParity` inside the run, on the frame it reads.
import { FIXED_NOW, TEST_HOMEDIR, offlineFetch } from '../fixtures/regime-challenge/isolate.js';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { months, sha256, type ArchiveStore } from '../../src/scripts/regime-diag/archive.js';
import { ALPHA, L_DOWN, L_UP, NO_LABEL, REGIME_AGAINST_MIN_CONFIDENCE } from '../../src/scripts/regime-diag/diag-spec.js';
import { context } from '../../src/scripts/regime-diag/engine.js';
import { buildFrames, isTrending, parseCensus, skeletonOf, type Census, type Frame, type Skeleton } from '../../src/scripts/regime-diag/frame.js';
import * as guard from '../../src/scripts/regime-diag/guard.js';
import { seedsFor } from '../../src/scripts/regime-diag/prims.js';
import { outRefusal } from '../../src/scripts/regime-challenge/challenge-guard.js';
import * as run from '../../src/scripts/regime-challenge/challenge-run.js';
import { R2_JUDGE_OUTCOMES, R2_ROUND, SERVED_CAP, SERVED_TRIGGER, STRONG_ADX } from '../../src/scripts/regime-challenge/challenge-r2.js';
import { CANDIDATES, CHALLENGE_SEED, JUDGE, JUDGE_FILE, PRESCORE, R1_ROUND, REQUIRED_PINS, judgeStudyRecord, monthRefusal, monthsOpened, type Candidate, type ChallengeRecord } from '../../src/scripts/regime-challenge/challenge-spec.js';
import * as replay from '../../src/scripts/regime-challenge/challenger-replay.js';
import * as stats from '../../src/scripts/regime-challenge/paired-stats.js';
import { SYN_CENSUS_TEXT, SYN_FIT, SYN_HOLD, SYN_PRESCORE, SYN_SPAN, synFullLoad, writeSynArchives } from '../fixtures/regime-challenge/synth-challenge.js';

const REPO = path.resolve(__dirname, '../..');
// One setImmediate per test lets the worker answer vitest between long synchronous tests (the measurement behind
// this hook is in tests/unit/regime-diag-guard.test.ts).
afterEach(() => new Promise<void>((done) => { setImmediate(done); }));

type Mods = { replay: typeof replay; stats: typeof stats; run: typeof run };
async function mutated<T>(lever: string, fn: (m: Mods) => T): Promise<T> {
  process.env.REGIME_DIAG_MUTATE = lever;
  vi.resetModules();
  try {
    return fn({
      replay: await import('../../src/scripts/regime-challenge/challenger-replay.js'),
      stats: await import('../../src/scripts/regime-challenge/paired-stats.js'),
      run: await import('../../src/scripts/regime-challenge/challenge-run.js'),
    });
  } finally {
    delete process.env.REGIME_DIAG_MUTATE;
    vi.resetModules();
  }
}

const R2 = R2_ROUND.candidates;
const candOf = (id: string): Candidate => R2.find((c) => c.id === id) as Candidate;
/** A candidate of round 2's shape at another value of its dial (the served value, for parity). */
const at = (id: string, value: number): Candidate => {
  const c = candOf(id), arm = c.arm as NonNullable<Candidate['arm']>;
  return { ...c, arm: arm.kind === 'cap' ? { kind: 'cap', cap: value } : { kind: 'trigger', min: value } };
};
/**
 * The frozen table of C4's copy (arc lesson 15: no live served code). Each row is a STRONG trending input of the core's
 * ladder — ADX, ADX slope (null: absent) — and the confidence the served core gave it at 0ef89d88 (cap 90), then the
 * registered arm's confidence at cap 45 and at cap 55. The rows span the ladder's branches: an absent slope, the −15
 * floor and the +10 ceiling of the slope adjustment, the 95 clamp, and ADX at .25 / .75 where `round(2·ADX)` rounds up.
 */
type Row = readonly [adx: number, slope: number | null, cap90: number, cap45: number, cap55: number];
const FROZEN: readonly Row[] = [
  [40.01, null, 80, 45, 55], [40.01, -9, 65, 30, 40], [40.01, -1.3, 74, 39, 49], [40.01, 0.1, 81, 46, 56], [40.01, 0.99, 85, 50, 60], [40.01, 2.1, 90, 55, 65], [40.01, 9, 90, 55, 65],
  [40.25, null, 81, 45, 55], [40.25, -9, 66, 30, 40], [40.25, -1.3, 75, 39, 49], [40.25, 0.1, 82, 46, 56], [40.25, 0.99, 86, 50, 60], [40.25, 2.1, 91, 55, 65], [40.25, 9, 91, 55, 65],
  [40.49, null, 81, 45, 55], [40.49, -9, 66, 30, 40], [40.49, -1.3, 75, 39, 49], [40.49, 0.1, 82, 46, 56], [40.49, 0.99, 86, 50, 60], [40.49, 2.1, 91, 55, 65], [40.49, 9, 91, 55, 65],
  [41.3, null, 83, 45, 55], [41.3, -9, 68, 30, 40], [41.3, -1.3, 77, 39, 49], [41.3, 0.1, 84, 46, 56], [41.3, 0.99, 88, 50, 60], [41.3, 2.1, 93, 55, 65], [41.3, 9, 93, 55, 65],
  [42.75, null, 86, 45, 55], [42.75, -9, 71, 30, 40], [42.75, -1.3, 80, 39, 49], [42.75, 0.1, 87, 46, 56], [42.75, 0.99, 91, 50, 60], [42.75, 2.1, 95, 55, 65], [42.75, 9, 95, 55, 65],
  [44.75, null, 90, 45, 55], [44.75, -9, 75, 30, 40], [44.75, -1.3, 84, 39, 49], [44.75, 0.1, 91, 46, 56], [44.75, 0.99, 95, 50, 60], [44.75, 2.1, 95, 55, 65], [44.75, 9, 95, 55, 65],
  [45, null, 90, 45, 55], [45, -9, 75, 30, 40], [45, -1.3, 84, 39, 49], [45, 0.1, 91, 46, 56], [45, 0.99, 95, 50, 60], [45, 2.1, 95, 55, 65], [45, 9, 95, 55, 65],
  [45.25, null, 90, 45, 55], [45.25, -9, 75, 30, 40], [45.25, -1.3, 84, 39, 49], [45.25, 0.1, 91, 46, 56], [45.25, 0.99, 95, 50, 60], [45.25, 2.1, 95, 55, 65], [45.25, 9, 95, 55, 65],
  [47.75, null, 90, 45, 55], [47.75, -9, 75, 30, 40], [47.75, -1.3, 84, 39, 49], [47.75, 0.1, 91, 46, 56], [47.75, 0.99, 95, 50, 60], [47.75, 2.1, 95, 55, 65], [47.75, 9, 95, 55, 65],
  [52.6, null, 90, 45, 55], [52.6, -9, 75, 30, 40], [52.6, -1.3, 84, 39, 49], [52.6, 0.1, 91, 46, 56], [52.6, 0.99, 95, 50, 60], [52.6, 2.1, 95, 55, 65], [52.6, 9, 95, 55, 65],
  [63.1, null, 90, 45, 55], [63.1, -9, 75, 30, 40], [63.1, -1.3, 84, 39, 49], [63.1, 0.1, 91, 46, 56], [63.1, 0.99, 95, 50, 60], [63.1, 2.1, 95, 55, 65], [63.1, 9, 95, 55, 65],
  [88, null, 90, 45, 55], [88, -9, 75, 30, 40], [88, -1.3, 84, 39, 49], [88, 0.1, 91, 46, 56], [88, 0.99, 95, 50, 60], [88, 2.1, 95, 55, 65], [88, 9, 95, 55, 65],
];
/** Rows of a frozen frame that are not strong: [label, ADX, slope, confidence] — moderate, early trend, ranging, volatile. */
const OTHER: ReadonlyArray<readonly [number, number, number, number]> = [[L_UP, 35, 1.2, 70], [L_DOWN, 22, 1, 44], [0, 50, 0, 80], [3, 45, NaN, 60], [L_UP, 31, -0.4, 60], [L_DOWN, 28, 0.6, 51]];
/** A frame built from the frozen rows (strong rows alternate up and down; one row has no call): only what the arms read. */
function frozenFrame(conf90: readonly number[] = FROZEN.map((r) => r[2]), adxOf = (a: number): number => a): Frame {
  const n = FROZEN.length + OTHER.length + 1;
  const has = new Uint8Array(n), lab = new Uint8Array(n).fill(NO_LABEL), conf = new Uint8Array(n), adx = new Float64Array(n).fill(NaN), adxSlope = new Float64Array(n).fill(NaN);
  FROZEN.forEach(([a, sl], i) => { has[i] = 1; lab[i] = i % 2 ? L_DOWN : L_UP; conf[i] = conf90[i]; adx[i] = adxOf(a); adxSlope[i] = sl === null ? NaN : sl; });
  OTHER.forEach(([l, a, sl, c], j) => { const i = FROZEN.length + j; has[i] = 1; lab[i] = l; conf[i] = c; adx[i] = a; adxSlope[i] = sl; });
  return { has, S: { lab, conf }, adx, adxSlope, coins: [] } as unknown as Frame;
}
/** How many frozen rows the copy at `cap` disagrees with (column `col` of the table). */
const againstTable = (m: typeof replay, cap: number, col: 2 | 3 | 4): number => FROZEN.filter((r) => m.capConfidence(r[0], r[1] === null ? NaN : r[1], cap) !== r[col]).length;

describe('regime-challenge round 2: C4 and C5 against frozen tables (no served code is called)', () => {
  it('#4 C4 parity: the copy at the served cap is the frozen core table on every strong input, and at 45 and 55 the registered arm', { timeout: 60_000 }, () => {
    expect(FROZEN.length).toBe(84);
    expect([againstTable(replay, SERVED_CAP, 2), againstTable(replay, 45, 3), againstTable(replay, 55, 4)]).toEqual([0, 0, 0]);
    // the table spans the ladder's branches, so a copy that drops one of them disagrees with it
    const has = (f: (r: Row) => boolean): boolean => FROZEN.some(f);
    expect([has((r) => r[1] === null), has((r) => r[1] !== null && Math.round(r[1] * 5) < -15), has((r) => r[1] !== null && Math.round(r[1] * 5) > 10),
      has((r) => r[2] === 95), has((r) => (r[0] * 4) % 2 === 1), has((r) => r[2] < 90 && r[2] > 65)]).toEqual([true, true, true, true, true, true]);
    // neither candidate value is the served rule
    expect([againstTable(replay, 45, 2), againstTable(replay, 55, 2)].every((n) => n === FROZEN.length)).toBe(true);
  });

  it('#4 armParity on a frozen frame: ok on every strong row; one row it does not reproduce, or no strong row, refuses', { timeout: 60_000 }, () => {
    const f = frozenFrame();
    expect(replay.armParity(f)).toEqual({ ok: true, calls: FROZEN.length, mismatches: 0, reason: 'ok' });
    const bad = replay.armParity(frozenFrame(FROZEN.map((r, i) => r[2] + (i === 5 ? 1 : 0))));
    expect(bad).toEqual({ ok: false, calls: FROZEN.length, mismatches: 1, reason: `the C4 copy at the served cap ${SERVED_CAP} differs from the served confidence on 1 of ${FROZEN.length} strong rows` });
    const none = replay.armParity(frozenFrame(undefined, () => 40));
    expect([none.ok, none.calls, none.reason]).toEqual([false, 0, 'the frame holds no strong trending row: the C4 copy cannot be shown to be the core']);
  });

  it('#4 the pairs on a frozen frame: at the served cap and trigger the arm IS the served arm; at 45, 55, 50, 70 each reads its rule', { timeout: 60_000 }, () => {
    const f = frozenFrame();
    for (const c of [at('C4.45', SERVED_CAP), at('C5.50', SERVED_TRIGGER)]) {
      const p = stats.pairOf(f, c, null);
      expect(Buffer.from(p.chal60).equals(Buffer.from(p.serv60)), c.id).toBe(true);
      expect(Buffer.from(p.chalLab.conf).equals(Buffer.from(f.S.conf))).toBe(true);
    }
    const dir = (r: number, lab: { lab: Uint8Array; conf: Uint8Array }, lo: number): number => (f.has[r] && isTrending(lab.lab[r]) && lab.conf[r] >= lo ? (lab.lab[r] === L_UP ? 1 : 2) : 0);
    const strong = (r: number): boolean => r < FROZEN.length;
    const want: Record<string, (r: number) => number> = {
      'C4.45': (r) => (strong(r) ? (FROZEN[r][3] >= 60 ? dir(r, f.S, 0) : 0) : dir(r, f.S, 60)),
      'C4.55': (r) => (strong(r) ? (FROZEN[r][4] >= 60 ? dir(r, f.S, 0) : 0) : dir(r, f.S, 60)),
      'C5.50': (r) => dir(r, f.S, 50),
      'C5.70': (r) => dir(r, f.S, 70),
    };
    for (const c of R2) {
      const p = stats.pairOf(f, c, null);
      expect([...p.chal60], c.id).toEqual([...p.chal60].map((_, r) => want[c.id](r)));
      expect(Buffer.from(p.chal60).equals(Buffer.from(p.serv60)), `${c.id} moves rows`).toBe(false);
    }
  });

  it('#4 a broken copy is caught on the frozen inputs: c4copy turns the table and armParity red, c5copy the C5 pair', { timeout: 60_000 }, async () => {
    await mutated('c4copy', (m) => {
      expect(againstTable(m.replay, SERVED_CAP, 2)).toBeGreaterThan(0);
      expect(m.replay.armParity(frozenFrame()).ok).toBe(false);
    });
    await mutated('c5copy', (m) => {
      const p = m.stats.pairOf(frozenFrame(), at('C5.50', SERVED_TRIGGER), null);
      expect(Buffer.from(p.chal60).equals(Buffer.from(p.serv60))).toBe(false);
    });
    expect([againstTable(replay, SERVED_CAP, 2), replay.armParity(frozenFrame()).ok]).toEqual([0, true]);
  });

  it('#1 the CLI refuses every token outside its flags and their values: an = form, a typo, a stray word, a repeat, a missing value', { timeout: 60_000 }, () => {
    const pre = ['--prescore', '--round', 'r2', '--census', 'c', '--cache', 'k', '--overlay', 'o', '--manifest', 'm', '--out', 'x'];
    expect(run.argvRefusal(pre)).toBeNull();
    expect(run.argvRefusal(['--judge', '--census', 'c', '--cache', 'k', '--overlay', 'o', '--store', 's', '--prescore-result', 'p', '--out', 'x'])).toBeNull();
    expect(run.argvRefusal(['--init-store', '--census', 'c', '--cache', 'k', '--overlay', 'o', '--store', 's'])).toBeNull();
    expect(run.argvRefusal(['--prescore', '--round=r2', ...pre.slice(3)])).toBe("unknown argument '--round=r2'");
    expect(run.argvRefusal([...pre, '--ouT', 'y'])).toBe("unknown argument '--ouT'");
    expect(run.argvRefusal([...pre, 'stray'])).toBe("unknown argument 'stray'");
    expect(run.argvRefusal([...pre, '--out', 'y'])).toBe('--out is given twice');
    expect(run.argvRefusal(['--prescore', '--round'])).toBe('--round needs a value');
    expect(run.argvRefusal(['--prescore', '--out', '--census', 'c'])).toBe('--out needs a value');
  });
});

describe('regime-challenge round 2: the C4 and C5 arms on a replayed synthetic frame, before any outcome', () => {
  let f: Frame;
  let strong: Uint8Array;
  beforeAll(() => {
    f = buildFrames(SYN_SPAN, [SYN_FIT], parseCensus(SYN_CENSUS_TEXT), synFullLoad, { outcomes: false, seed: PRESCORE.entrySeed })[0];
    strong = Uint8Array.from(f.has, (h, r) => (h && isTrending(f.S.lab[r]) && f.adx[r] > 40 ? 1 : 0));
  }, 120_000);

  it('the suite\'s homes, network and clock are its own (arc lesson 14)', { timeout: 60_000 }, () => {
    expect(guard.sealHome()).toBe(path.join(TEST_HOMEDIR, '.cache', 'algovault', 'regime-diag', 'store'));
    expect(os.userInfo().homedir).toBe(TEST_HOMEDIR);
    expect(globalThis.fetch).toBe(offlineFetch);
    expect(Date.now()).toBe(FIXED_NOW);
  });

  it('round 2\'s challengers are one-dial arms of the served label: C4 moves the strong tier\'s cap, C5 the trigger', { timeout: 60_000 }, () => {
    expect(R2.map((c) => [c.id, c.challenger, c.map, c.dial, c.arm])).toEqual([
      ['C4.45', 'C4', 'M05', null, { kind: 'cap', cap: 45 }],
      ['C4.55', 'C4', 'M05', null, { kind: 'cap', cap: 55 }],
      ['C5.50', 'C5', 'M10', null, { kind: 'trigger', min: 50 }],
      ['C5.70', 'C5', 'M10', null, { kind: 'trigger', min: 70 }],
    ]);
    expect([SERVED_CAP, SERVED_TRIGGER, STRONG_ADX]).toEqual([90, REGIME_AGAINST_MIN_CONFIDENCE, 40]);
    // round 1's challengers carry no arm, and none of round 2's is a round-1 candidate
    expect(CANDIDATES.every((c) => c.arm === undefined)).toBe(true);
    expect(R2.some((c) => CANDIDATES.some((x) => x.id === c.id))).toBe(false);
  });

  it('C4 and C5 read the rows their registered words name, row for row', { timeout: 60_000 }, () => {
    const serv60 = stats.pairOf(f, candOf('C4.45'), null).serv60;
    const slopeOk = (r: number): boolean => Number.isFinite(f.adxSlope[r]) && Math.round(f.adxSlope[r] * 5) >= 5;
    const dir = (r: number, lo: number): number => (f.has[r] && isTrending(f.S.lab[r]) && f.S.conf[r] >= lo ? (f.S.lab[r] === L_UP ? 1 : 2) : 0);
    const want: Record<string, (r: number) => number> = {
      // cap 45: every strong row reads at most 55, below the trigger; every other row is the served row
      'C4.45': (r) => (strong[r] ? 0 : serv60[r]),
      // cap 55: a strong row stays at 60 or above only when the slope adds 5 or more
      'C4.55': (r) => (strong[r] && !slopeOk(r) ? 0 : serv60[r]),
      'C5.50': (r) => dir(r, 50),
      'C5.70': (r) => dir(r, 70),
    };
    for (const c of R2) {
      const p = stats.pairOf(f, c, null);
      const wanted = Uint8Array.from(p.chal60, (_, r) => want[c.id](r));
      expect(Buffer.from(p.chal60).equals(Buffer.from(wanted)), c.id).toBe(true);
      expect(Buffer.from(p.chal60).equals(Buffer.from(p.serv60)), `${c.id} moves rows`).toBe(false);
      // the labels are the served labels: A4's rows and A5's sequences are the served arm's, so the guards compare like with like
      expect(Buffer.from(p.chalAny).equals(Buffer.from(p.servAny))).toBe(true);
      expect(p.chalLab.lab).toBe(f.S.lab);
      expect(p.chalSeqs.map((q) => [q.pos, q.t, q.n, Buffer.from(q.label).toString('hex')])).toEqual(p.servSeqs.map((q) => [q.pos, q.t, q.n, Buffer.from(q.label).toString('hex')]));
      expect([...p.chalRows]).toEqual([...p.servRows]);
    }
    // C4.55 keeps some strong rows and drops others, so both of its branches are exercised here
    const kept = strong.reduce((s, x, r) => s + (x && slopeOk(r) ? 1 : 0), 0);
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(strong.reduce((s, x) => s + x, 0));
  });

  it('the month guard, both ways: round 2\'s pre-score opens 2024-01 … 2025-12 and refuses every other month', { timeout: 60_000 }, () => {
    const rec = R2_ROUND.rec;
    const all = months('2019-01', '2027-06');
    for (const use of ['outcome', 'archive'] as const) {
      expect(all.filter((ym) => monthRefusal(rec, ym, use) === null)).toEqual(months('2024-01', '2025-12'));
    }
    expect(monthsOpened(rec)).toEqual(months('2024-01', '2025-12'));
    expect(monthRefusal(rec, '2023-12', 'archive')).toBe('challenge-r2-prescore opens archives of 2024-01 … 2025-12 only: 2023-12 is outside');
    expect(monthRefusal(rec, '2026-01', 'outcome')).toBe('challenge-r2-prescore reads outcomes of 2024-01 … 2025-12 only: 2026-01 is outside');
    expect([rec.span, rec.win, rec.entrySeed, rec.seal]).toEqual([PRESCORE.span, PRESCORE.win, PRESCORE.entrySeed, null]);
    expect([rec.id, rec.wave, rec.file, rec.line]).toEqual(['challenge-r2-prescore', 'EDGE-REGIME-CHALLENGE-R2-W1', 'regime-challenge-r2-prescore.json', 'REGIME_CHALLENGE_R2_PRESCORE']);
    expect(R2_JUDGE_OUTCOMES).toEqual({ first: '2020-01', last: '2023-12' });
    expect([R2_ROUND.seed, R2_ROUND.log, R2_ROUND.coinDays]).toEqual(['regime-challenge-r2', 'regime-challenge-r2-prescore.log', { prescore: 450 * 24, judge: 450 * 48 }]);
    // round 1's round is round 1's constants, unchanged
    expect([R1_ROUND.rec, R1_ROUND.seed, R1_ROUND.log, R1_ROUND.candidates, R1_ROUND.coinDays]).toEqual([PRESCORE, CHALLENGE_SEED, 'regime-challenge-r1-prescore.log', CANDIDATES, { prescore: 10_800, judge: 4_500 }]);
  });
});

// ── the pre-score, in a sandbox repository ───────────────────────────────────────────────────────────────────────

const git = (repo: string, ...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const KEY_COLS: Record<string, number> = { '2a': 3, '2b': 2, '2c': 1, '2d': 2, '2e': 2 };
/** Tables 2a–2e as T3's registration carries them, rendered from a skeleton. */
const tables = (sk: Skeleton): string => (Object.keys(KEY_COLS) as Array<keyof Skeleton>).map((id) => {
  const rows = Object.entries(sk[id]), width = KEY_COLS[id] + rows[0][1].length;
  return [`**Table ${id} — synthetic.**`, '', `|${' c |'.repeat(width)}`, `|${'---|'.repeat(width)}`,
    ...rows.map(([k, v]) => `| ${[...k.split('|'), ...v.map((x) => (x === null ? 'n/a' : String(x)))].join(' | ')} |`), ''].join('\n');
}).join('\n');
const TABLES = 'audits/reg-tables.md';
const COUNTS = { boot: 200, shuffle: 50 }, FLOOR = 5;
/** Round 2's pre-score record on the synthetic round's grid and months. */
const SYN_R2: ChallengeRecord = Object.freeze({ ...R2_ROUND.rec, span: SYN_PRESCORE.span, win: SYN_PRESCORE.win, outcomes: SYN_PRESCORE.outcomes, archives: SYN_PRESCORE.archives });

describe('regime-challenge round 2: the pre-score, in a sandbox repository', () => {
  let dir = '', repo = '', store = '', censusFile = '';
  let archives: ArchiveStore = { cache: '', overlay: '' };
  let census: Census;
  let made: { archivesSha256: string; guardStoreSha256: string; archiveFiles: number };
  let pre: run.RunResult;
  let preLines: string[] = [];
  const lines: string[] = [];
  const json = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8')); // eslint-disable-line @typescript-eslint/no-explicit-any
  const study = (rec: ChallengeRecord = SYN_R2): run.ChallengeStudy =>
    ({ rec, counts: COUNTS, floorClusters: FLOOR, log: (l) => lines.push(l), pins: { census: sha256(SYN_CENSUS_TEXT), archives: made.archivesSha256 } });
  const prescore = (out: string, more: Partial<run.PrescoreInput> = {}): run.RunResult => {
    lines.length = 0;
    return run.prescoreRun({ repo, censusFile, archives, manifest: guard.archivesFile(store), out: path.join(dir, out), tables: TABLES, round: R2_ROUND, study: study(), ...more });
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-challenge-r2-'));
    repo = path.join(dir, 'repo'); store = path.join(dir, 'store'); censusFile = path.join(dir, 'census.json');
    archives = { cache: path.join(dir, 'cache'), overlay: path.join(dir, 'overlay') };
    for (const d of [archives.cache, archives.overlay, path.join(dir, 'no-hooks')]) fs.mkdirSync(d, { recursive: true });
    git(dir, 'init', '-q', '--bare', '--initial-branch=main', 'origin.git');
    git(dir, 'init', '-q', '--initial-branch=main', 'repo');
    for (const [k, v] of [['user.email', 'sandbox@example.invalid'], ['user.name', 'sandbox'], ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(dir, 'no-hooks')]]) git(repo, 'config', k, v);
    git(repo, 'remote', 'add', 'origin', path.join(dir, 'origin.git'));
    for (const rel of [...guard.HARNESS_FILES, ...REQUIRED_PINS]) {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.cpSync(path.join(REPO, rel), path.join(repo, rel));
    }
    expect(writeSynArchives(archives).length).toBe(15);
    fs.writeFileSync(censusFile, SYN_CENSUS_TEXT);
    census = parseCensus(SYN_CENSUS_TEXT);
    made = guard.initStore(store, archives, census.panel, judgeStudyRecord(''));
    const sk = skeletonOf(buildFrames(SYN_SPAN, [SYN_FIT, SYN_HOLD], census, synFullLoad, { outcomes: false, seed: PRESCORE.entrySeed }));
    fs.mkdirSync(path.join(repo, 'audits'));
    fs.writeFileSync(path.join(repo, TABLES), tables(sk));
    for (const rel of [...guard.HARNESS_FILES, ...REQUIRED_PINS, TABLES]) git(repo, 'add', rel);
    git(repo, 'commit', '-q', '-m', 'the harness and the registered tables');
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    pre = prescore('out-pre');
    preLines = [...lines];
    expect([pre.verdict, pre.reason]).toEqual(['PASS', 'ok']);
  }, 300_000);
  afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it('the pre-score of round 2 reads its own candidates, its own seed and its own months, and writes its own names', { timeout: 60_000 }, () => {
    const out = json(pre.file as string);
    expect(path.basename(pre.file as string)).toBe('regime-challenge-r2-prescore.json');
    expect([out.wave, out.kind, out.study, out.record, out.seed, out.entry_seed]).toEqual(['EDGE-REGIME-CHALLENGE-R2-W1', 'prescore', 'injected', 'challenge-r2-prescore', 'regime-challenge-r2', PRESCORE.entrySeed]);
    expect(out.months_opened).toEqual(['2024-01', '2024-02', '2024-03', '2024-04', '2024-05']);
    expect(Object.keys(out.candidates)).toEqual(['C4.45', 'C4.55', 'C5.50', 'C5.70']);
    expect(out.challenger_calls).toBe(0);
    expect(out.coin_days).toEqual({ prescore: 10_800, judge: 21_600, scale: Math.sqrt(10_800 / 21_600) });
    expect(out.line).toMatch(/^REGIME_CHALLENGE_R2_PRESCORE=C4:(JUDGE|KEEP \(pre-score\));C5:(JUDGE|KEEP \(pre-score\))$/);
    expect(fs.readdirSync(path.join(dir, 'out-pre')).sort()).toEqual(['regime-challenge-r2-prescore.json', 'regime-challenge-r2-prescore.log']);
    const log = fs.readFileSync(path.join(dir, 'out-pre', 'regime-challenge-r2-prescore.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(log.map((e) => [e.wave, e.record, e.ok, e.leg])).toEqual([['EDGE-REGIME-CHALLENGE-R2-W1', 'challenge-r2-prescore', true, 'frame'], ['EDGE-REGIME-CHALLENGE-R2-W1', 'challenge-r2-prescore', true, 'outcomes'], ['EDGE-REGIME-CHALLENGE-R2-W1', 'challenge-r2-prescore', true, 'result']]);
    expect(log[2].result_sha256).toBe(sha256(fs.readFileSync(pre.file as string)));
    expect(preLines.join('|')).toMatch(/arms: parity ok on \d+ strong rows/);
  });

  it('each arm is read in-sample with both arms\' values; A4 is zero by construction; selection is round 1\'s rule', { timeout: 60_000 }, () => {
    const out = json(pre.file as string);
    const rows: run.PrescoreRow[] = [];
    let read = 0;
    for (const c of R2) {
      const x = out.candidates[c.id];
      expect([x.challenger, x.map, x.what]).toEqual([c.challenger, c.map, c.what]);
      rows.push({ id: c.id, challenger: c.challenger, identifiable: x.support.identifiable, point: x.ddelta1?.point ?? NaN, guards: [x.a4?.guard ?? 'unreadable', x.a5?.guard ?? 'unreadable', x.coverage.guard] });
      if (!x.support.identifiable) { expect([x.ddelta1, x.a4, x.a5, x.judge_power]).toEqual([null, null, null, null]); continue; }
      read++;
      expect(x.ddelta1.point).toBe(x.ddelta1.arms.challenger - x.ddelta1.arms.served);
      // the arms share their labels: S4 is the same number on both, on every resample
      expect([x.a4.point, x.a4.lb, x.a4.ub, x.a4.guard]).toEqual([0, 0, 0, 'holds']);
      const se = ((x.ddelta1.ub - x.ddelta1.lb) / 2 / 1.96) * out.coin_days.scale;
      expect(x.judge_power.se).toBeCloseTo(se, 12);
      expect(x.judge_power.effect).toBeCloseTo(Math.abs(x.ddelta1.point) / 2, 12);
    }
    expect(read).toBeGreaterThanOrEqual(2);
    expect(out.selection).toEqual(run.selectionOf(rows));
    // the result is the paired statistic of the pair, under round 2's seed label
    const f = buildFrames(SYN_SPAN, [SYN_FIT], census, synFullLoad, { outcomes: true, seed: PRESCORE.entrySeed })[0];
    const c = R2.find((x) => out.candidates[x.id].support.identifiable) as Candidate;
    const seed = seedsFor('regime-challenge-r2', [`challenge-r2-prescore|${c.id}|ddelta1|bootstrap`])[0];
    const want = stats.deltaDelta1(f, context(f), stats.pairOf(f, c, null), { B: COUNTS.boot, alpha: ALPHA, seed, arms: true });
    expect([out.candidates[c.id].ddelta1.point, out.candidates[c.id].ddelta1.lb, out.candidates[c.id].ddelta1.ub]).toEqual([want.point, want.lb, want.ub]);
  });

  it('no pre-score of either round reads a sealed judge window: round 1\'s or round 2\'s, refused before anything is written', { timeout: 60_000 }, () => {
    const r1Window = `overlap the judge window ${JUDGE.outcomes.first} … ${JUDGE.outcomes.last}: the pre-score never reads it`;
    const r2Window = 'overlap round 2\'s judge window 2020-01 … 2023-12: only round 2\'s sealed judge reads it';
    const cases: Array<[ChallengeRecord, string]> = [
      [{ ...SYN_R2, outcomes: { first: '2023-12', last: '2024-05' } }, r2Window],
      [{ ...SYN_R2, outcomes: { first: '2019-06', last: '2020-01' } }, r2Window],
      [{ ...SYN_R2, outcomes: { first: '2025-12', last: '2026-01' } }, r1Window],
    ];
    for (const round of [R2_ROUND, R1_ROUND]) {
      for (const [rec, tail] of cases) {
        const r = prescore('out-pre-sealed', { round, study: study(rec) });
        expect([r.verdict, r.reason]).toEqual(['REFUSED', `the record's outcome months ${rec.outcomes.first} … ${rec.outcomes.last} ${tail}`]);
        expect(lines).toEqual([]);
      }
    }
    expect(fs.existsSync(path.join(dir, 'out-pre-sealed'))).toBe(false);
    // the months either side of round 2's window are not its window
    for (const outcomes of [{ first: '2019-01', last: '2019-12' }, { first: '2024-01', last: '2025-12' }]) {
      expect(prescore('out-pre-edge', { study: study({ ...SYN_R2, outcomes }) }).reason).not.toMatch(/judge window/);
    }
  });

  it('round 1\'s judge refuses an injected record on round 2\'s window before any line, write or seal', { timeout: 60_000 }, () => {
    const home = path.join(dir, 'home-r2w'), js = path.join(dir, 'store-r2w'), out = path.join(dir, 'out-r2w');
    for (const outcomes of [{ first: '2020-01', last: '2020-02' }, { first: '2023-11', last: '2024-02' }]) {
      lines.length = 0;
      const r = run.judgeRun({ repo, store: js, censusFile, archives, prescore: path.join(dir, 'absent.json'), out, tables: TABLES,
        study: { rec: { ...JUDGE, outcomes }, counts: COUNTS, floorClusters: FLOOR, log: (l) => lines.push(l), sealHome: home } });
      expect([r.verdict, r.reason]).toEqual(['REFUSED', `the record's outcome months ${outcomes.first} … ${outcomes.last} overlap round 2's judge window 2020-01 … 2023-12: only round 2's sealed judge reads it`]);
      expect(lines).toEqual([]);
    }
    for (const p of [home, js, out, path.join(TEST_HOME_SEAL(), JUDGE.seal as string)]) expect(fs.existsSync(p), p).toBe(false);
    expect(fs.existsSync(path.join(out, JUDGE_FILE))).toBe(false);
  });

  it('a frame on which the C4 copy is not the served confidence refuses the pre-score at its parity leg, before any outcome', { timeout: 60_000 }, async () => {
    const bad = { ok: false, calls: 7, mismatches: 2, reason: `the C4 copy at the served cap ${SERVED_CAP} differs from the served confidence on 2 of 7 strong rows` };
    const REPLAY = '../../src/scripts/regime-challenge/challenger-replay.js';
    vi.resetModules();
    vi.doMock(REPLAY, async (orig) => ({ ...(await orig<typeof replay>()), armParity: () => bad }));
    try {
      const m = await import('../../src/scripts/regime-challenge/challenge-run.js');
      lines.length = 0;
      const r = m.prescoreRun({ repo, censusFile, archives, manifest: guard.archivesFile(store), out: path.join(dir, 'out-pre-parity'), tables: TABLES, round: R2_ROUND, study: study() });
      expect([r.verdict, r.reason]).toEqual(['REFUSED', bad.reason]);
      expect(lines.join('|')).toMatch(/skeleton: equal/);
      expect(lines.join('|')).not.toMatch(/arms: parity ok|outcomes/);
      const log = fs.readFileSync(path.join(dir, 'out-pre-parity', 'regime-challenge-r2-prescore.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(log.map((e) => [e.ok, e.leg, e.reason])).toEqual([[false, 'parity', bad.reason]]);
      expect(fs.existsSync(path.join(dir, 'out-pre-parity', 'regime-challenge-r2-prescore.json'))).toBe(false);
    } finally {
      vi.doUnmock(REPLAY);
      vi.resetModules();
    }
  });

  it('a deliberately broken arm computes nothing: under c4copy and c5copy the pre-score refuses', { timeout: 60_000 }, async () => {
    for (const lever of ['c4copy', 'c5copy']) {
      const p = await mutated(lever, (m) => m.run.prescoreRun({ repo, censusFile, archives, manifest: guard.archivesFile(store), out: path.join(dir, 'out-pre-m'), tables: TABLES, round: R2_ROUND, study: study() }));
      expect([p.verdict, p.reason]).toEqual(['REFUSED', `REGIME_DIAG_MUTATE is set (${lever}): a deliberately broken harness computes no outcome`]);
    }
    expect(fs.existsSync(path.join(dir, 'out-pre-m', 'regime-challenge-r2-prescore.json'))).toBe(false);
  });

  it('the CLI takes round 2 for the pre-score only: --round r2 with --judge or --init-store is refused, and an unknown round is not a round', { timeout: 90_000 }, async () => {
    const tsx = promisify(execFile);
    const cli = (args: string[]): Promise<string> => tsx(path.join(REPO, 'node_modules/.bin/tsx'), [path.join(REPO, 'src/scripts/regime-challenge/challenge-run.ts'), ...args], { timeout: 60_000 })
      .then((r) => r.stdout, (e: { stdout?: string; code?: number }) => `${e.stdout ?? ''}exit=${e.code}`);
    const common = ['--census', censusFile, '--cache', archives.cache, '--overlay', archives.overlay];
    const [judge, init, other, eq] = await Promise.all([
      cli(['--judge', '--round', 'r2', ...common, '--store', path.join(dir, 'cli-store'), '--prescore-result', path.join(dir, 'absent.json'), '--out', path.join(dir, 'cli-out')]),
      cli(['--init-store', '--round', 'r2', ...common, '--store', path.join(dir, 'cli-store')]),
      cli(['--prescore', '--round', 'r3', ...common, '--manifest', guard.archivesFile(store), '--out', path.join(dir, 'cli-out')]),
      // #1: an = form is no flag of this CLI — it is refused, never read as round 1's pre-score
      cli(['--prescore', '--round=r2', ...common, '--manifest', guard.archivesFile(store), '--out', path.join(dir, 'cli-eq-out')]),
    ]);
    for (const o of [judge, init]) expect(o).toBe('REGIME_CHALLENGE_RUN_VERDICT=INDETERMINATE — round 2 has no judge yet: --round r2 takes --prescore only\nexit=3');
    expect(other).toBe('REGIME_CHALLENGE_RUN_VERDICT=INDETERMINATE — --round is r1 or r2\nexit=3');
    expect(eq).toBe("REGIME_CHALLENGE_RUN_VERDICT=INDETERMINATE — unknown argument '--round=r2'\nexit=3");
    for (const p of ['cli-store', 'cli-out', 'cli-eq-out']) expect(fs.existsSync(path.join(dir, p))).toBe(false);
  });

  // ── #2: no output directory is, holds or lies inside a root no run writes into (identity: `within`) ────────────
  const HOME_CACHE = path.join(TEST_HOMEDIR, '.cache', 'algovault');
  /** Each form of `out` refused with `why`, before a directory, a log line or a frame — and nothing made where it pointed. */
  const refusedOuts = (forms: ReadonlyArray<readonly [string, string]>): void => {
    for (const [out, why] of forms) {
      lines.length = 0;
      const before = fs.existsSync(out);
      const r = run.prescoreRun({ repo, censusFile, archives, manifest: guard.archivesFile(store), out, tables: TABLES, round: R2_ROUND, study: study() });
      expect([r.verdict, r.reason], out).toEqual(['REFUSED', why]);
      expect(lines, out).toEqual([]);
      expect(fs.existsSync(out), out).toBe(before);
      expect(fs.existsSync(path.join(out, 'regime-challenge-r2-prescore.log')), out).toBe(false);
    }
  };
  const isIn = (what: string): string => `the output directory is ${what} or lies inside it: no run writes there`;
  const holds = (what: string): string => `the output directory holds ${what}: no run writes there`;
  const outsideOwn = (own: string): string => `the output directory lies under ~/.cache/algovault outside ${own}/, the running round's home: no run writes there`;

  it('#2 the seal home: as the output, inside it, through a link to it, or holding it — refused', { timeout: 60_000 }, () => {
    const home = guard.sealHome();
    expect(home.startsWith(TEST_HOMEDIR)).toBe(true);
    fs.mkdirSync(home, { recursive: true });
    const link = path.join(dir, 'link-to-seal-home');
    fs.symlinkSync(home, link);
    refusedOuts([[home, isIn('the seal home')], [path.join(home, 'out'), isIn('the seal home')], [path.join(link, 'out'), isIn('the seal home')],
      [path.join(HOME_CACHE, 'regime-diag'), holds('the seal home')], [TEST_HOMEDIR, holds('the seal home')]]);
  });

  it('#2 round 1\'s tree: as round 2\'s output, or inside it — refused; round 2\'s home beside it is not; each round writes only in its own home', { timeout: 60_000 }, () => {
    const r1 = path.join(HOME_CACHE, 'regime-challenge');
    fs.mkdirSync(path.join(r1, 'judge-r1'), { recursive: true });
    refusedOuts([[r1, outsideOwn('regime-challenge-r2')], [path.join(r1, 'judge-r1'), outsideOwn('regime-challenge-r2')], [path.join(r1, 'new'), outsideOwn('regime-challenge-r2')]]);
    // a sibling whose name starts with round 1's is not inside it, by spelling or by identity
    expect(outRefusal(path.join(HOME_CACHE, 'regime-challenge-r2', 'out'), R2_ROUND.home, guard.sealHome(), archives)).toBeNull();
    // round 1's own runs write in round 1's tree, and never in round 2's home
    expect(outRefusal(path.join(r1, 'judge-r1'), R1_ROUND.home, guard.sealHome(), archives)).toBeNull();
    expect(outRefusal(path.join(HOME_CACHE, 'regime-challenge-r2', 'out'), R1_ROUND.home, guard.sealHome(), archives)).toBe(outsideOwn('regime-challenge'));
    expect([R1_ROUND.home, R2_ROUND.home]).toEqual(['regime-challenge', 'regime-challenge-r2']);
  });

  it('#2 T3\'s archive stores: either one as the output, inside it, or held by it — refused', { timeout: 60_000 }, () => {
    const odds = path.join(HOME_CACHE, 'odds-calibration-study'), diag = path.join(HOME_CACHE, 'regime-diag', 'archives');
    for (const d of [odds, diag]) fs.mkdirSync(d, { recursive: true });
    refusedOuts([[odds, outsideOwn('regime-challenge-r2')], [path.join(odds, 'x'), outsideOwn('regime-challenge-r2')],
      [diag, outsideOwn('regime-challenge-r2')], [path.join(diag, 'x'), outsideOwn('regime-challenge-r2')]]);
  });

  it('#2 the archive stores the run reads: as the output, inside one, or holding one — refused; round 1\'s judge refuses an output in its seal home too', { timeout: 60_000 }, () => {
    refusedOuts([[archives.cache, isIn('an archive store the run reads')], [path.join(archives.overlay, 'x'), isIn('an archive store the run reads')]]);
    const both = path.join(dir, 'both');
    const twin: ArchiveStore = { cache: path.join(both, 'cache'), overlay: path.join(both, 'overlay') };
    expect(outRefusal(both, R2_ROUND.home, guard.sealHome(), twin)).toBe(holds('an archive store the run reads'));
    // round 1's judge: an injected study's seal home, by identity, before any line or write
    const home = path.join(dir, 'judge-home'), out = path.join(home, 'out');
    fs.mkdirSync(home);
    lines.length = 0;
    const j = run.judgeRun({ repo, store: path.join(dir, 'judge-store'), censusFile, archives, prescore: path.join(dir, 'absent.json'), out, tables: TABLES,
      study: { rec: { ...JUDGE, outcomes: { first: '2024-06', last: '2024-07' } }, counts: COUNTS, floorClusters: FLOOR, log: (l) => lines.push(l), sealHome: home } });
    expect([j.verdict, j.reason]).toEqual(['REFUSED', isIn('the seal home')]);
    expect([lines, fs.readdirSync(home), fs.existsSync(path.join(dir, 'judge-store'))]).toEqual([[], [], false]);
  });

  // #2, completed (review round 2, NOTE 1): under the cache the output is an allow-list — the running round's home only
  const FOREIGN: ReadonlyArray<readonly [string, string]> = [
    ['T3\'s results directory', path.join('regime-diag', 'out')], ['T3\'s r0 directory', path.join('regime-diag', 'r0')],
    ['the census store', 'regime-census'], ['the forward store', 'regime-forward'],
  ];
  for (const [name, rel] of FOREIGN) {
    it(`#2 allow-list: ${name} under the cache is refused as the output, and inside it`, { timeout: 60_000 }, () => {
      const root = path.join(HOME_CACHE, rel);
      fs.mkdirSync(root, { recursive: true });
      refusedOuts([[root, outsideOwn('regime-challenge-r2')], [path.join(root, 'out'), outsideOwn('regime-challenge-r2')]]);
    });
  }

  it('#2 allow-list: round 2\'s own home under the cache is accepted, and so is a temporary directory outside it', { timeout: 60_000 }, () => {
    const own = path.join(HOME_CACHE, 'regime-challenge-r2', 'out-own');
    lines.length = 0;
    const r = run.prescoreRun({ repo, censusFile, archives, manifest: guard.archivesFile(store), out: own, tables: TABLES, round: R2_ROUND, study: study() });
    expect([r.verdict, r.reason]).toEqual(['PASS', 'ok']);
    expect(fs.readdirSync(own).sort()).toEqual(['regime-challenge-r2-prescore.json', 'regime-challenge-r2-prescore.log']);
    // an output that holds the cache is refused even where no seal home lies in it
    expect(outRefusal(path.join(TEST_HOMEDIR, '.cache'), R2_ROUND.home, undefined, archives)).toBe('the output directory holds ~/.cache/algovault: no run writes there');
    expect(outRefusal(path.join(dir, 'tmp-out'), R2_ROUND.home, guard.sealHome(), archives)).toBeNull();
    // the suite's own pre-score wrote in a temporary directory outside the cache
    expect([pre.verdict, path.dirname(pre.file as string).startsWith(fs.realpathSync(os.tmpdir())) || path.dirname(pre.file as string).startsWith(os.tmpdir())]).toEqual(['PASS', true]);
  });
});

/** The seal home the code derives inside this suite: the isolate's, never the user's. */
function TEST_HOME_SEAL(): string { return guard.sealHome(); }

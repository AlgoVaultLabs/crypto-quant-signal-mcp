// tests/unit/regime-challenge-spec.test.ts — EDGE-REGIME-CHALLENGE-R1-W1 CH1: the two records and their months
// (AC1.1 the window refusals: the pre-score refuses any month after 2025-12, the judge any month outside
// 2026-01 … 2026-10; AC1.2: let the judge read 2026-11 → red). The archives here are synthetic, two hours each.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { archiveName, months, type ArchiveStore } from '../../src/scripts/regime-diag/archive.js';
import { FIT, HOLDOUT, PATH_MIN, SEED, SPAN, STUDIES, studyOf } from '../../src/scripts/regime-diag/diag-spec.js';
import { synthCsv } from '../../src/scripts/regime-diag/synth.js';
import * as guard from '../../src/scripts/regime-challenge/challenge-guard.js';
import * as spec from '../../src/scripts/regime-challenge/challenge-spec.js';
import { zipSingle } from '../fixtures/regime-diag/synth-study.js';
import { minuteOfMonth } from '../fixtures/regime-challenge/synth-challenge.js';

const REPO = path.resolve(__dirname, '../..');
type Mods = { spec: typeof spec; guard: typeof guard };
afterEach(() => new Promise<void>((done) => { setImmediate(done); }));

async function mutated<T>(lever: string, fn: (m: Mods) => T): Promise<T> {
  process.env.REGIME_DIAG_MUTATE = lever;
  vi.resetModules();
  try {
    return fn({
      spec: await import('../../src/scripts/regime-challenge/challenge-spec.js'),
      guard: await import('../../src/scripts/regime-challenge/challenge-guard.js'),
    });
  } finally {
    delete process.env.REGIME_DIAG_MUTATE;
    vi.resetModules();
  }
}

/** A month of the registered grid's calendar and its neighbours, as text. */
const ALL = months('2023-06', '2027-06');
/** One synthetic coin with a two-hour archive in each of these months — two of them no record of this round may open. */
const ON_DISK = ['2025-08', '2025-12', '2026-01', '2026-10', '2026-11'];
const PANEL = ['SYNA'];
let dir: string, store: ArchiveStore;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-challenge-spec-'));
  store = { cache: path.join(dir, 'cache'), overlay: path.join(dir, 'overlay') };
  fs.mkdirSync(store.cache); fs.mkdirSync(store.overlay);
  for (const ym of ON_DISK) {
    const from = minuteOfMonth(SPAN, ym), name = archiveName('SYNA', '1m', ym);
    fs.writeFileSync(path.join(store.cache, name), zipSingle(name.replace('.zip', '.csv'), Buffer.from(synthCsv(SPAN, 'challenge|spec', { from, to: from + 120 }))));
  }
}, 300_000);
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** The months a run of `rec` opens over the store above, and the grid it builds. */
const openedBy = (m: Mods, rec: spec.ChallengeRecord): { yms: string[]; rows: number; rejected: number; n: number } => {
  const opened: guard.Opened = new Map();
  const { g } = m.guard.recordLoader(rec, store, PANEL, opened)(0);
  if (!g) throw new Error('the loader found no archive');
  return { yms: [...opened.keys()], rows: g.counts.rows - g.counts.rejected, rejected: g.counts.rejected, n: g.span.n };
};

/** The judge stays inside 2026-01 … 2026-10 and the label-free history before it: no later month, by any road. */
const judgeStaysInside = (m: Mods): void => {
  expect(m.spec.monthsOpened(m.spec.JUDGE)).toEqual(months('2025-09', '2026-10'));
  expect(m.spec.monthRefusal(m.spec.JUDGE, '2026-11', 'archive')).toMatch(/2026-11 is after 2026-10/);
  expect(m.spec.monthRefusal(m.spec.JUDGE, '2026-11', 'outcome')).toMatch(/2026-11 is after 2026-10/);
  expect(openedBy(m, m.spec.JUDGE).yms).toEqual(['2025-12', '2026-01', '2026-10']);
};

describe('regime-challenge: the two records', () => {
  it('the pre-score is T3\'s fit window on a grid that ends with it; the judge is T3\'s hold-out window on T3\'s grid', { timeout: 60_000 }, () => {
    const { PRESCORE, JUDGE } = spec;
    expect([PRESCORE.id, PRESCORE.seal, PRESCORE.entrySeed, PRESCORE.file, PRESCORE.line]).toEqual(['challenge-r1-prescore', null, SEED, 'regime-challenge-r1-prescore.json', 'REGIME_CHALLENGE_PRESCORE']);
    expect([PRESCORE.span.t0Ms, PRESCORE.span.n, PRESCORE.win.lo, PRESCORE.win.hi]).toEqual([SPAN.t0Ms, FIT.hi, FIT.lo, FIT.hi]);
    expect([PRESCORE.outcomes, PRESCORE.archives]).toEqual([{ first: '2024-01', last: '2025-12' }, { first: '2024-01', last: '2025-12' }]);
    expect([JUDGE.id, JUDGE.seal, JUDGE.entrySeed, JUDGE.file, JUDGE.line]).toEqual(['challenge-r1', 'challenge-r1.seal', SEED, 'regime-challenge-r1.json', 'REGIME_CHALLENGE_VERDICT']);
    expect([JUDGE.span, JUDGE.win]).toEqual([SPAN, HOLDOUT]);
    // outcomes: the window's months. Archives: those, and before them the history a 1d call needs (100 daily bars)
    expect([JUDGE.outcomes, JUDGE.archives]).toEqual([{ first: '2026-01', last: '2026-10' }, { first: '2025-09', last: '2026-10' }]);
    expect([PRESCORE.id, JUDGE.id]).toEqual(['challenge-r1-prescore', 'challenge-r1']);
    expect([spec.coinDaysOf(PRESCORE), spec.coinDaysOf(JUDGE)]).toEqual([10_800, 4_500]);
  });

  it('the judge is no study of T3\'s or T9\'s: its own id, its own seal, T3\'s archive months, no carry of theirs', { timeout: 60_000 }, () => {
    const s = spec.judgeStudyRecord('audits/regime-challenge-r1-preregistration-2026-11-17.md');
    expect([s.id, s.wave, s.seal, s.registration]).toEqual(['challenge-r1', 'EDGE-REGIME-CHALLENGE-R1-W1', 'challenge-r1.seal', 'audits/regime-challenge-r1-preregistration-2026-11-17.md']);
    expect(s.months).toEqual({ first: '2024-01', pinned: '2026-10', last: '2026-10' });
    expect([s.span, s.windows, s.carry, s.notBefore, s.closed]).toEqual([SPAN, [HOLDOUT], null, null, false]);
    expect(studyOf(s.id)).toBeNull();
    expect(STUDIES.map((x) => x.seal)).not.toContain(s.seal);
    expect(STUDIES.map((x) => x.seed)).not.toContain(s.seed);
    expect(spec.REGISTRATION_RE.test(s.registration)).toBe(true);
    for (const x of STUDIES) expect(spec.REGISTRATION_RE.test(x.registration)).toBe(false);
  });

  it('round 1 holds four candidates of three challengers, one dial each', { timeout: 60_000 }, () => {
    expect(spec.CANDIDATES.map((c) => [c.id, c.challenger, c.map])).toEqual([['C1.7', 'C1', 'M01'], ['C1.10', 'C1', 'M01'], ['C2', 'C2', 'M08'], ['C3', 'C3', 'M12']]);
    expect(spec.CANDIDATES.map((c) => c.dial)).toEqual([{ adxPeriod: 7, direction: 'served' }, { adxPeriod: 10, direction: 'served' }, { adxPeriod: 14, direction: 'di' }, null]);
    expect(spec.SERVED_DIAL).toEqual({ adxPeriod: 14, direction: 'served' });
    for (const c of spec.CANDIDATES) {
      if (!c.dial) continue;
      const moved = Number(c.dial.adxPeriod !== spec.SERVED_DIAL.adxPeriod) + Number(c.dial.direction !== spec.SERVED_DIAL.direction);
      expect(moved).toBe(1);
    }
    expect([spec.candidateOf('C2')?.map, spec.candidateOf('C4'), spec.candidateOf(7)]).toEqual(['M08', null, null]);
    expect([spec.SERVED_TF, spec.C3_TF]).toEqual([1, 0]);
    expect([spec.A4_GUARD_PP, spec.A5_GUARD_RATIO, spec.COVERAGE_FLOOR]).toEqual([-3, 1 / 1.1, 0.5]);
  });

  // T3's control ("HARNESS_FILES is the harness directory, file for file"), on the rounds' own directory: a file
  // there that a judge registration is not required to pin would run bound to nothing. Round 2 adds one file, round 3 three.
  it('REQUIRED_PINS is the rounds\' directory, file for file', { timeout: 60_000 }, () => {
    const DIR = 'src/scripts/regime-challenge';
    const onDisk = fs.readdirSync(path.join(REPO, DIR)).map((f) => `${DIR}/${f}`).sort();
    expect(spec.REQUIRED_PINS.filter((f) => f.startsWith(`${DIR}/`)).slice().sort()).toEqual(onDisk);
    expect(onDisk.length).toBe(9);
    for (const f of spec.REQUIRED_PINS) expect(fs.existsSync(path.join(REPO, f)), f).toBe(true);
  });
});

describe('regime-challenge: the window refusals', () => {
  it('AC1.1 the pre-score refuses every month after 2025-12, for an outcome and for an archive', { timeout: 60_000 }, () => {
    for (const use of ['outcome', 'archive'] as const) {
      const ok = ALL.filter((ym) => spec.monthRefusal(spec.PRESCORE, ym, use) === null);
      expect(ok).toEqual(months('2024-01', '2025-12'));
    }
    expect(spec.monthRefusal(spec.PRESCORE, '2026-01', 'outcome')).toMatch(/challenge-r1-prescore reads outcomes of 2024-01 … 2025-12 only: 2026-01 is outside/);
    expect(spec.monthRefusal(spec.PRESCORE, '2026-01', 'archive')).toMatch(/challenge-r1-prescore opens archives of 2024-01 … 2025-12 only: 2026-01 is outside/);
    expect(spec.monthRefusal(spec.PRESCORE, '2026-11', 'archive')).toMatch(/2026-11 is after 2026-10/);
    expect(spec.monthsOpened(spec.PRESCORE)).toEqual(months('2024-01', '2025-12'));
  });

  it('AC1.1 the judge refuses every month outside 2026-01 … 2026-10; before the window it opens label-free history only', { timeout: 60_000 }, () => {
    expect(ALL.filter((ym) => spec.monthRefusal(spec.JUDGE, ym, 'outcome') === null)).toEqual(months('2026-01', '2026-10'));
    expect(ALL.filter((ym) => spec.monthRefusal(spec.JUDGE, ym, 'archive') === null)).toEqual(months('2025-09', '2026-10'));
    expect(spec.monthRefusal(spec.JUDGE, '2025-12', 'outcome')).toMatch(/challenge-r1 reads outcomes of 2026-01 … 2026-10 only: 2025-12 is outside/);
    expect(spec.monthRefusal(spec.JUDGE, '2025-08', 'archive')).toMatch(/challenge-r1 opens archives of 2025-09 … 2026-10 only: 2025-08 is outside/);
    for (const bad of ['2026-13', '2026-1', '2026-00', '202601', '', '2026-11-01']) {
      for (const rec of [spec.PRESCORE, spec.JUDGE]) expect(spec.monthRefusal(rec, bad, 'archive')).toMatch(/is not a month/);
    }
    judgeStaysInside({ spec, guard });
  });

  it('AC1.1 a frame is a record\'s only when every entry and the end of its outcome path sit in the record\'s months', { timeout: 60_000 }, () => {
    const frame = (rec: spec.ChallengeRecord, ...m: number[]): { span: typeof SPAN; win: typeof FIT; eM: Int32Array } => ({ span: rec.span, win: rec.win, eM: Int32Array.from(m) });
    const { PRESCORE, JUDGE } = spec;
    expect(spec.windowRefusal(PRESCORE, frame(PRESCORE, 10_080, FIT.hi - PATH_MIN))).toBeNull();
    // one minute later the path's last minute is 2026-01-01T00:00Z
    expect(spec.windowRefusal(PRESCORE, frame(PRESCORE, 10_080, FIT.hi - PATH_MIN + 1))).toMatch(/entry 1: challenge-r1-prescore reads outcomes of 2024-01 … 2025-12 only: 2026-01 is outside/);
    expect(spec.windowRefusal(JUDGE, frame(JUDGE, HOLDOUT.lo, HOLDOUT.hi - PATH_MIN))).toBeNull();
    expect(spec.windowRefusal(JUDGE, frame(JUDGE, HOLDOUT.lo, HOLDOUT.hi - PATH_MIN + 1))).toMatch(/entry 1: 2026-11 is after 2026-10/);
    expect(spec.windowRefusal(JUDGE, frame(JUDGE, HOLDOUT.lo - 1))).toMatch(/entry 0: challenge-r1 reads outcomes of 2026-01 … 2026-10 only: 2025-12 is outside/);
    // another record's grid or window is refused before any entry is looked at
    expect(spec.windowRefusal(PRESCORE, frame(JUDGE))).toMatch(/the frame's grid is not challenge-r1-prescore's/);
    expect(spec.windowRefusal(JUDGE, { span: JUDGE.span, win: FIT, eM: new Int32Array(0) })).toMatch(/the frame's window is not challenge-r1's/);
    expect(spec.windowRefusal(PRESCORE, { span: PRESCORE.span, win: { ...FIT, hi: FIT.hi + 1 }, eM: new Int32Array(0) })).toMatch(/the frame's window is not challenge-r1-prescore's/);
  });

  it('AC1.1 the loader opens a record\'s months and no other: the pre-score never 2026, the judge never 2026-11', { timeout: 60_000 }, () => {
    const mods = { spec, guard };
    const pre = openedBy(mods, spec.PRESCORE);
    // 2026-01, 2026-10 and 2026-11 are on disk and are not opened; the grid has no minute of 2026 to put a row in
    expect([pre.yms, pre.rows, pre.rejected, pre.n]).toEqual([['2025-08', '2025-12'], 240, 0, FIT.hi]);
    const judge = openedBy(mods, spec.JUDGE);
    expect([judge.yms, judge.rows, judge.rejected, judge.n]).toEqual([['2025-12', '2026-01', '2026-10'], 360, 0, SPAN.n]);
    // a position with no archive in the record's months has no grid, and every month counts as absent
    const none = guard.recordLoader(spec.JUDGE, store, ['SYNZ'], new Map())(0);
    expect([none.g, none.noArchive]).toEqual([null, 14]);
  });

  it('no record, however it is written, opens a month after 2026-10: the loader throws before the file is resolved', { timeout: 60_000 }, () => {
    for (const rec of [spec.PRESCORE, spec.JUDGE]) {
      const late: spec.ChallengeRecord = { ...rec, archives: { first: '2026-09', last: '2026-11' } };
      const opened: guard.Opened = new Map();
      expect(() => guard.recordLoader(late, store, PANEL, opened)(0)).toThrow(/regime-challenge: 2026-11 is after 2026-10/);
      expect([...opened.keys()]).not.toContain('2026-11');
    }
  });

  it('AC1.2 let the judge read 2026-11 → red; restored, green', { timeout: 60_000 }, async () => {
    await expect(mutated('judgemonth', (m) => judgeStaysInside(m))).rejects.toThrow(/to deeply equal/);
    // the lever is the read itself: under it the loader opens the 2026-11 archive, and the month passes the refusal
    const leaked = await mutated('judgemonth', (m) => ({ yms: openedBy(m, m.spec.JUDGE).yms, why: m.spec.monthRefusal(m.spec.JUDGE, '2026-11', 'archive'), pre: m.spec.monthsOpened(m.spec.PRESCORE) }));
    expect(leaked.yms).toContain('2026-11');
    expect(leaked.why).toBeNull();
    // the lever is the judge's alone: the pre-score is as it was
    expect(leaked.pre).toEqual(months('2024-01', '2025-12'));
    judgeStaysInside({ spec, guard });
  });
});

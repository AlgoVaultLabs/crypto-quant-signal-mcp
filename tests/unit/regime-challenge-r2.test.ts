// tests/unit/regime-challenge-r2.test.ts — EDGE-REGIME-CHALLENGE-R2-W1 CH3: round 2's two new challengers as one-dial
// arms on the served label — C4 (M05, the strong tier's confidence cap) and C5 (M10, the TRENDING ≥ 60 trigger) —
// and their in-sample pre-score (AC3: parity at the served value, the month guard both ways, the sealed windows).
// Synthetic archives and a sandbox repository with a bare origin; the suite's homes, network and clock are its own
// (arc lesson 14: the isolate is imported first).
import { FIXED_NOW, TEST_HOMEDIR, offlineFetch } from '../fixtures/regime-challenge/isolate.js';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { classifyRegime } from '../../src/lib/market-regime-core.js';
import { months, sha256, type ArchiveStore } from '../../src/scripts/regime-diag/archive.js';
import { ALPHA, L_UP, REGIME_AGAINST_MIN_CONFIDENCE } from '../../src/scripts/regime-diag/diag-spec.js';
import { context } from '../../src/scripts/regime-diag/engine.js';
import { buildFrames, isTrending, parseCensus, skeletonOf, type Census, type Frame, type Skeleton } from '../../src/scripts/regime-diag/frame.js';
import * as guard from '../../src/scripts/regime-diag/guard.js';
import { seedsFor } from '../../src/scripts/regime-diag/prims.js';
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
/** The strong trending inputs of the core's ladder: ADX above 40 at many fractional parts, the slope absent or at many values. */
const SLOPES: ReadonlyArray<number | null> = [null, -9, -3.1, -3, -2.9, -1.01, -0.5, -0.1, 0, 0.1, 0.3, 0.5, 0.99, 1, 1.5, 2, 2.1, 3, 9];
const ADXS: readonly number[] = [...Array.from({ length: 170 }, (_, i) => 40.05 + i * 0.35), 40.25, 44.75, 45.25, 47.25, 47.75, 55.25];
const core = (adx: number, slope: number | null): ReturnType<typeof classifyRegime> =>
  classifyRegime({ adxVal: adx, adxSlope: slope, plusDI: 30, minusDI: 10, slopeCategory: 'FLAT', priceStructure: 'HIGHER_HIGHS', volatilityRatio: 0.01 });
/** How many strong inputs the copy at `cap` disagrees with the core on (and how many it was asked). */
const againstCore = (m: typeof replay, cap: number): { n: number; differ: number } => {
  let n = 0, differ = 0;
  for (const a of ADXS) {
    for (const s of SLOPES) {
      const c = core(a, s);
      expect([c.regime, c.trendStrength === 'STRONG' || c.trendStrength === 'MODERATE']).toEqual(['TRENDING_UP', true]);
      n++;
      if (m.capConfidence(a, s === null ? NaN : s, cap) !== c.confidence) differ++;
    }
  }
  return { n, differ };
};

describe('regime-challenge round 2: the C4 and C5 arms, before any outcome', () => {
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

  it('C4 parity: at the served cap the copy is the core\'s confidence on every strong input; at 45 and 55 it is not', { timeout: 60_000 }, () => {
    const served = againstCore(replay, SERVED_CAP);
    expect(served.n).toBe(ADXS.length * SLOPES.length);
    expect(served.differ).toBe(0);
    // the dial moves the confidence: neither candidate value is the served rule
    for (const cap of [45, 55]) expect(againstCore(replay, cap).differ).toBeGreaterThan(served.n / 2);
  });

  it('C4 parity on a frame: armParity holds at the served cap on every strong row, and refuses a frame it does not reproduce', { timeout: 60_000 }, () => {
    const n = strong.reduce((s, x) => s + x, 0);
    expect(n).toBeGreaterThan(1000);
    expect(replay.armParity(f)).toEqual({ ok: true, calls: n, mismatches: 0, reason: 'ok' });
    // one strong row whose served confidence the copy does not reproduce
    const r = strong.indexOf(1);
    const conf = Uint8Array.from(f.S.conf);
    conf[r] += 1;
    const bad = replay.armParity({ ...f, S: { lab: f.S.lab, conf } });
    expect([bad.ok, bad.calls, bad.mismatches]).toEqual([false, n, 1]);
    expect(bad.reason).toBe(`the C4 copy at the served cap ${SERVED_CAP} differs from the served confidence on 1 of ${n} strong rows`);
    // a frame with no strong row cannot show the copy is the core
    const none = replay.armParity({ ...f, adx: f.adx.map((a) => Math.min(a, 40)) });
    expect([none.ok, none.calls]).toEqual([false, 0]);
    expect(none.reason).toBe('the frame holds no strong trending row: the C4 copy cannot be shown to be the core');
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

  it('parity of the pair: at the served cap and the served trigger the challenger arm IS the served arm', { timeout: 60_000 }, () => {
    for (const c of [at('C4.45', SERVED_CAP), at('C5.50', SERVED_TRIGGER)]) {
      const p = stats.pairOf(f, c, null);
      expect(Buffer.from(p.chal60).equals(Buffer.from(p.serv60)), c.id).toBe(true);
      expect(Buffer.from(p.chalLab.conf).equals(Buffer.from(f.S.conf))).toBe(true);
      expect(p.serv60.some((x) => x > 0)).toBe(true);
    }
  });

  it('a broken copy is caught: c4copy turns both C4 parity checks red, c5copy the C5 pair\'s', { timeout: 60_000 }, async () => {
    await mutated('c4copy', (m) => {
      expect(againstCore(m.replay, SERVED_CAP).differ).toBeGreaterThan(0);
      const p = m.replay.armParity(f);
      expect([p.ok, p.mismatches > 0]).toEqual([false, true]);
    });
    await mutated('c5copy', (m) => {
      const p = m.stats.pairOf(f, at('C5.50', SERVED_TRIGGER), null);
      expect(Buffer.from(p.chal60).equals(Buffer.from(p.serv60))).toBe(false);
    });
    // and unset, both are green again
    expect(replay.armParity(f).ok).toBe(true);
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
    const [judge, init, other] = await Promise.all([
      cli(['--judge', '--round', 'r2', ...common, '--store', path.join(dir, 'cli-store'), '--prescore-result', path.join(dir, 'absent.json'), '--out', path.join(dir, 'cli-out')]),
      cli(['--init-store', '--round', 'r2', ...common, '--store', path.join(dir, 'cli-store')]),
      cli(['--prescore', '--round', 'r3', ...common, '--manifest', guard.archivesFile(store), '--out', path.join(dir, 'cli-out')]),
    ]);
    for (const o of [judge, init]) expect(o).toBe('REGIME_CHALLENGE_RUN_VERDICT=INDETERMINATE — round 2 has no judge yet: --round r2 takes --prescore only\nexit=3');
    expect(other).toBe('REGIME_CHALLENGE_RUN_VERDICT=INDETERMINATE — --round is r1 or r2\nexit=3');
    for (const p of ['cli-store', 'cli-out']) expect(fs.existsSync(path.join(dir, p))).toBe(false);
  });
});

/** The seal home the code derives inside this suite: the isolate's, never the user's. */
function TEST_HOME_SEAL(): string { return guard.sealHome(); }

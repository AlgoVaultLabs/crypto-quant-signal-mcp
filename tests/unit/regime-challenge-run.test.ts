// tests/unit/regime-challenge-run.test.ts — EDGE-REGIME-CHALLENGE-R1-W1 CH1: the two runs, in a sandbox repository
// (AC1.1: the window refusals, the judge seal claimed once, the carry accepted only by its sha256). Everything
// runs on synthetic monthly archives with a bare origin, and the synthetic judge keeps its seal in the sandbox:
// no test reads a real archive, T3's store, or the registered round's seal home.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { archiveName, sha256, type ArchiveManifest, type ArchiveStore } from '../../src/scripts/regime-diag/archive.js';
import { ALPHA, FLOOR_PP } from '../../src/scripts/regime-diag/diag-spec.js';
import { context } from '../../src/scripts/regime-diag/engine.js';
import { buildFrames, parseCensus, skeletonOf, type Census, type Skeleton } from '../../src/scripts/regime-diag/frame.js';
import * as guard from '../../src/scripts/regime-diag/guard.js';
import { seedsFor } from '../../src/scripts/regime-diag/prims.js';
import { archivesRefusal, registrationOnMain } from '../../src/scripts/regime-challenge/challenge-guard.js';
import * as run from '../../src/scripts/regime-challenge/challenge-run.js';
import {
  CANDIDATES, CHALLENGE_SEED, CHALLENGE_WAVE, JUDGE, JUDGE_FILE, PRESCORE, PRESCORE_FILE, PRESCORE_PIN, REGISTRATION_RE, REQUIRED_PINS, judgeStudyRecord,
  type Candidate, type Dial,
} from '../../src/scripts/regime-challenge/challenge-spec.js';
import { challengerColumns } from '../../src/scripts/regime-challenge/challenger-replay.js';
import { coverageRatio, deltaDelta1, pairOf, supportOf, type ArmSupport } from '../../src/scripts/regime-challenge/paired-stats.js';
import { zipSingle } from '../fixtures/regime-diag/synth-study.js';
import { SYN_AFTER, SYN_CENSUS_TEXT, SYN_FIT, SYN_HOLD, SYN_JUDGE, SYN_PRESCORE, SYN_SPAN, synFullLoad, writeSynArchives } from '../fixtures/regime-challenge/synth-challenge.js';

const REPO = path.resolve(__dirname, '../..');
// One setImmediate per test lets the worker answer vitest between long synchronous tests (the measurement behind
// this hook is in tests/unit/regime-diag-guard.test.ts).
afterEach(() => new Promise<void>((done) => { setImmediate(done); }));
const CHALLENGE_FILES = ['challenge-spec', 'challenger-replay', 'paired-stats', 'challenge-guard', 'challenge-run'].map((n) => `src/scripts/regime-challenge/${n}.ts`);
// the harness list the pinned guard asks for, and what the judge asks for beyond it: this round's files and the
// modules outside the harness list
const COPIED = [...guard.HARNESS_FILES, ...REQUIRED_PINS];
const GOOD = 'audits/regime-challenge-r1-preregistration-2024-08-01.md';
const TABLES = 'audits/reg-tables.md', MOVED = 'audits/reg-tables-moved.md';
const DECISION = '(WINS|KEEP|KEEP — underpowered|NOT_IDENTIFIABLE)';
const COUNTS = { boot: 200, shuffle: 50 }, FLOOR = 5;
const cand = (id: string): Candidate => CANDIDATES.find((c) => c.id === id) as Candidate;

const git = (repo: string, ...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const pinTable = (pins: Record<string, string>): string =>
  ['# A registration', '', '## Pinned artifacts', '', '| artifact | sha256 |', '|---|---|', ...Object.entries(pins).map(([k, v]) => `| \`${k}\` | \`${v}\` |`), ''].join('\n');
const KEY_COLS: Record<string, number> = { '2a': 3, '2b': 2, '2c': 1, '2d': 2, '2e': 2 };
/** Tables 2a–2e as T3's registration carries them, rendered from a skeleton. */
const tables = (sk: Skeleton): string => (Object.keys(KEY_COLS) as Array<keyof Skeleton>).map((id) => {
  const rows = Object.entries(sk[id]), width = KEY_COLS[id] + rows[0][1].length;
  return [`**Table ${id} — synthetic.**`, '', `|${' c |'.repeat(width)}`, `|${'---|'.repeat(width)}`,
    ...rows.map(([k, v]) => `| ${[...k.split('|'), ...v.map((x) => (x === null ? 'n/a' : String(x)))].join(' | ')} |`), ''].join('\n');
}).join('\n');
const withFile = <T>(file: string, change: (s: string) => string, fn: () => T): T => {
  const keep = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, change(keep));
  try { return fn(); } finally { fs.writeFileSync(file, keep); }
};
/** Every key of a JSON value, at any depth. */
const keysOf = (x: unknown, into = new Set<string>()): Set<string> => {
  if (Array.isArray(x)) for (const v of x) keysOf(v, into);
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { into.add(k); keysOf(v, into); }
  return into;
};

async function mutated<T>(lever: string, fn: (m: typeof run) => T): Promise<T> {
  process.env.REGIME_DIAG_MUTATE = lever;
  vi.resetModules();
  try {
    return fn(await import('../../src/scripts/regime-challenge/challenge-run.js'));
  } finally {
    delete process.env.REGIME_DIAG_MUTATE;
    vi.resetModules();
  }
}

describe('regime-challenge: the pre-score and the judge, in a sandbox repository', () => {
  let dir = '', repo = '', store = '', home = '', censusFile = '', carry = '', seal = '';
  let archives: ArchiveStore = { cache: '', overlay: '' };
  let census: Census;
  let made: { archivesSha256: string; guardStoreSha256: string; archiveFiles: number };
  let unlandedPre: run.RunResult, pre: run.RunResult, unlandedJudge: run.RunResult;
  let preLines: string[] = [];
  const lines: string[] = [];
  const pins: Record<string, string> = {};
  const json = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8')); // eslint-disable-line @typescript-eslint/no-explicit-any
  const logged = (): Array<Record<string, unknown>> => (fs.existsSync(guard.guardLog(store)) ? fs.readFileSync(guard.guardLog(store), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>) : []);
  const preStudy = (more: Partial<run.ChallengeStudy> = {}): run.ChallengeStudy =>
    ({ rec: SYN_PRESCORE, counts: COUNTS, floorClusters: FLOOR, log: (l) => lines.push(l), pins: { census: sha256(SYN_CENSUS_TEXT), archives: made.archivesSha256 }, ...more });
  const judgeStudy = (more: Partial<run.ChallengeStudy> = {}): run.ChallengeStudy => ({ rec: SYN_JUDGE, counts: COUNTS, floorClusters: FLOOR, log: (l) => lines.push(l), sealHome: home, ...more });
  const prescore = (out: string, more: Partial<run.PrescoreInput> = {}): run.RunResult => {
    lines.length = 0;
    return run.prescoreRun({ repo, censusFile, archives, manifest: guard.archivesFile(store), out: path.join(dir, out), tables: TABLES, study: preStudy(), ...more });
  };
  const judge = (out: string, more: Partial<run.JudgeInput> = {}): run.RunResult => {
    lines.length = 0;
    return run.judgeRun({ repo, registration: GOOD, store, censusFile, archives, prescore: carry, out: path.join(dir, out), tables: TABLES, study: judgeStudy(), ...more });
  };
  /** A refusal computes nothing: no seal, and no result where the run would have written one. */
  const nothingRead = (out: string): void => {
    expect(fs.existsSync(seal)).toBe(false);
    expect(fs.existsSync(path.join(dir, out, JUDGE_FILE))).toBe(false);
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-challenge-run-'));
    repo = path.join(dir, 'repo'); store = path.join(dir, 'store'); home = path.join(dir, 'seal-home'); censusFile = path.join(dir, 'census.json');
    carry = path.join(dir, 'carry', PRESCORE_FILE); seal = path.join(home, JUDGE.seal as string);
    archives = { cache: path.join(dir, 'cache'), overlay: path.join(dir, 'overlay') };
    for (const d of [archives.cache, archives.overlay, path.join(dir, 'no-hooks'), path.dirname(carry)]) fs.mkdirSync(d, { recursive: true });
    git(dir, 'init', '-q', '--bare', '--initial-branch=main', 'origin.git');
    git(dir, 'init', '-q', '--initial-branch=main', 'repo');
    for (const [k, v] of [['user.email', 'sandbox@example.invalid'], ['user.name', 'sandbox'], ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(dir, 'no-hooks')]]) git(repo, 'config', k, v);
    git(repo, 'remote', 'add', 'origin', path.join(dir, 'origin.git'));
    fs.writeFileSync(path.join(repo, 'README.md'), 'sandbox\n');
    git(repo, 'add', 'README.md'); git(repo, 'commit', '-q', '-m', 'base'); git(repo, 'push', '-q', '-u', 'origin', 'main');

    for (const rel of COPIED) {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.cpSync(path.join(REPO, rel), path.join(repo, rel));
    }
    // the synthetic round's archives: January … July for two positions, and two hours of August for the first
    expect(writeSynArchives(archives).length).toBe(15);
    fs.writeFileSync(censusFile, SYN_CENSUS_TEXT);
    census = parseCensus(SYN_CENSUS_TEXT);
    // the judge's own store; its archive manifest also stands in for T3's, which the pre-score is held to
    made = guard.initStore(store, archives, census.panel, judgeStudyRecord(''));
    expect(made.archiveFiles).toBe(15);

    // the registered tables: ONE build of both windows on the whole grid, as T3 registered its own
    const sk = skeletonOf(buildFrames(SYN_SPAN, [SYN_FIT, SYN_HOLD], census, synFullLoad, { outcomes: false, seed: PRESCORE.entrySeed }));
    const moved: Skeleton = JSON.parse(JSON.stringify(sk)) as Skeleton;
    (moved['2c'].fit[1] as number) += 1; (moved['2c']['hold-out'][1] as number) += 1;
    fs.mkdirSync(path.join(repo, 'audits'));
    fs.writeFileSync(path.join(repo, TABLES), tables(sk));
    fs.writeFileSync(path.join(repo, MOVED), tables(moved));
    for (const rel of [...COPIED, TABLES, MOVED]) git(repo, 'add', rel);
    git(repo, 'commit', '-q', '-m', 'the harness, the challengers and the registered tables');
    // before the push: the sources are committed, and not landed
    unlandedPre = prescore('out-pre-unlanded');
    git(repo, 'push', '-q', 'origin', 'main');

    pre = prescore('out-pre');
    preLines = [...lines];
    expect([pre.verdict, pre.reason]).toEqual(['PASS', 'ok']);
    // The judge's mechanics do not depend on what a synthetic pre-score happened to select: the carried result is
    // the pre-score's own output with a selection of two challengers (the third a pre-score KEEP).
    const out = json(pre.file as string);
    const sent = ['C1.7', 'C3'];
    const point = (id: string): number => (typeof out.candidates[id].ddelta1?.point === 'number' ? out.candidates[id].ddelta1.point : 1);
    const carried = (over: Record<string, unknown>): string => `${JSON.stringify({
      ...out, selection: { judged: sent, verdicts: { C1: 'JUDGE', C2: 'KEEP (pre-score)', C3: 'JUDGE' }, causes: {} },
      candidates: { ...out.candidates, ...Object.fromEntries(sent.map((id) => [id, { ...out.candidates[id], ddelta1: { ...out.candidates[id].ddelta1, point: point(id) } }])) }, ...over,
    }, null, 1)}\n`;
    const variants: Record<string, string> = {
      good: carried({}),
      other: carried({ study: 'registered' }),
      empty: carried({ selection: { judged: [], verdicts: { C1: 'KEEP (pre-score)', C2: 'KEEP (pre-score)', C3: 'KEEP (pre-score)' }, causes: {} } }),
      twice: carried({ selection: { judged: ['C1.7', 'C1.10'], verdicts: { C1: 'JUDGE' }, causes: {} } }),
      unknown: carried({ selection: { judged: ['C9'], verdicts: { C9: 'JUDGE' }, causes: {} } }),
    };
    for (const [name, text] of Object.entries(variants)) fs.writeFileSync(name === 'good' ? carry : path.join(dir, 'carry', `${name}.json`), text);

    for (const rel of [...COPIED, TABLES]) pins[rel] = sha256(fs.readFileSync(path.join(repo, rel)));
    pins['store:manifest-BINANCE.json'] = made.guardStoreSha256;
    pins[guard.CENSUS_PIN] = sha256(SYN_CENSUS_TEXT);
    pins[guard.ARCHIVES_PIN] = made.archivesSha256;
    pins[PRESCORE_PIN] = sha256(variants.good);
    const without = (k: string): Record<string, string> => Object.fromEntries(Object.entries(pins).filter(([x]) => x !== k));
    const regs: Record<string, string> = {
      [GOOD]: pinTable(pins),
      'audits/reg-nocarry.md': pinTable(without(PRESCORE_PIN)),
      'audits/reg-notables.md': pinTable(without(TABLES)),
      'audits/reg-moved.md': pinTable({ ...pins, [MOVED]: sha256(fs.readFileSync(path.join(repo, MOVED))) }),
      'audits/reg-nochallenge.md': pinTable(without(CHALLENGE_FILES[2])),
      'audits/reg-nooutside.md': pinTable(without('src/lib/indicators.ts')),
      ...Object.fromEntries(['other', 'empty', 'twice', 'unknown'].map((n) => [`audits/reg-${n}.md`, pinTable({ ...pins, [PRESCORE_PIN]: sha256(variants[n]) })])),
    };
    for (const [rel, text] of Object.entries(regs)) { fs.writeFileSync(path.join(repo, rel), text); git(repo, 'add', rel); }
    git(repo, 'commit', '-q', '-m', 'registrations');
    // before the push: the registration is committed, and not landed
    unlandedJudge = judge('out-judge-unlanded');
    git(repo, 'push', '-q', 'origin', 'main');
  }, 300_000);
  afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  // ── the pre-score ────────────────────────────────────────────────────────────────────────────────────────────

  it('the pre-score refuses a checkout that is not landed, and one with a tracked change', { timeout: 60_000 }, () => {
    expect(unlandedPre.verdict).toBe('REFUSED');
    expect(unlandedPre.reason).toMatch(/HEAD is not on origin\/main/);
    expect(fs.existsSync(path.join(dir, 'out-pre-unlanded', PRESCORE_FILE))).toBe(false);
    const dirty = withFile(path.join(repo, 'README.md'), (s) => `${s}changed\n`, () => prescore('out-pre-dirty'));
    expect(dirty.verdict).toBe('REFUSED');
    expect(dirty.reason).toMatch(/tracked changes/);
    expect(lines.join('|')).not.toMatch(/outcomes/);
  });

  it('AC1.1 the pre-score reads its own months and no other: the result, the months it opened, and its log', { timeout: 60_000 }, () => {
    const out = json(pre.file as string);
    expect(path.basename(pre.file as string)).toBe(PRESCORE_FILE);
    expect([out.wave, out.kind, out.study, out.record, out.seed]).toEqual([CHALLENGE_WAVE, 'prescore', 'injected', PRESCORE.id, CHALLENGE_SEED]);
    expect(out.window).toEqual({ outcomes: { first: '2024-01', last: '2024-05' }, archives: { first: '2024-01', last: '2024-05' } });
    // the archives of June, July and August sit in the same store: none was opened
    expect(out.months_opened).toEqual(['2024-01', '2024-02', '2024-03', '2024-04', '2024-05']);
    for (const ym of ['2024-06', '2024-07', SYN_AFTER]) expect(fs.existsSync(path.join(archives.cache, archiveName('SYNA', '1m', ym)))).toBe(true);
    expect(out.entries).toBeGreaterThan(1000);
    expect(out.challenger_calls).toBeGreaterThan(out.entries);
    expect(Object.keys(out.candidates)).toEqual(['C1.7', 'C1.10', 'C2', 'C3']);
    expect(out.coin_days).toEqual({ prescore: 10_800, judge: 4_500, scale: Math.sqrt(10_800 / 4_500) });
    expect(pre.line).toBe(out.line);
    expect(out.line).toMatch(/^REGIME_CHALLENGE_PRESCORE=C1:(JUDGE|KEEP \(pre-score\));C2:(JUDGE|KEEP \(pre-score\));C3:(JUDGE|KEEP \(pre-score\))$/);
    const log = fs.readFileSync(path.join(dir, 'out-pre', 'regime-challenge-r1-prescore.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(log.map((e) => [e.ok, e.leg])).toEqual([[true, 'frame'], [true, 'outcomes'], [true, 'result']]);
    expect(log[2].last_month_opened).toBe('2024-05');
    expect(log[2].result_sha256).toBe(sha256(fs.readFileSync(pre.file as string)));
    expect(preLines.join('|')).toMatch(/skeleton: equal/);
    expect(fs.existsSync(path.join(dir, 'out-pre', JUDGE_FILE))).toBe(false);
    expect(fs.existsSync(seal)).toBe(false);
  });

  it('the pre-score reads every candidate in-sample, with both arms, and selects by the rule', { timeout: 60_000 }, () => {
    const out = json(pre.file as string);
    const rows: run.PrescoreRow[] = [];
    let read = 0;
    for (const c of CANDIDATES) {
      const x = out.candidates[c.id];
      expect([x.challenger, x.map]).toEqual([c.challenger, c.map]);
      expect(typeof x.support.identifiable).toBe('boolean');
      rows.push({ id: c.id, challenger: c.challenger, identifiable: x.support.identifiable, point: x.ddelta1?.point ?? NaN, guards: [x.a4?.guard ?? 'unreadable', x.a5?.guard ?? 'unreadable', x.coverage.guard] });
      if (!x.support.identifiable) { expect([x.ddelta1, x.a4, x.a5, x.judge_power]).toEqual([null, null, null, null]); continue; }
      read++;
      // in-sample, a reading carries each arm's own value, and the paired quantity is their difference (or ratio)
      expect(x.ddelta1.point).toBe(x.ddelta1.arms.challenger - x.ddelta1.arms.served);
      expect(x.a4.point).toBe(x.a4.arms.challenger - x.a4.arms.served);
      expect(x.a5.point).toBeCloseTo(x.a5.arms.challenger / x.a5.arms.served, 12);
      expect(x.ddelta1.B).toBe(COUNTS.boot);
      // T3 §5's instrument, moved to the judge window and tested at half the point
      const se = ((x.ddelta1.ub - x.ddelta1.lb) / 2 / 1.96) * out.coin_days.scale;
      expect(x.judge_power.se).toBeCloseTo(se, 12);
      expect(x.judge_power.detectable).toBeCloseTo(2.8 * se, 12);
      expect(x.judge_power.effect).toBeCloseTo(Math.abs(x.ddelta1.point) / 2, 12);
      expect(x.judge_power.underpowered).toBe(!(x.judge_power.detectable <= x.judge_power.effect));
    }
    expect(read).toBeGreaterThanOrEqual(3);
    expect(out.selection).toEqual(run.selectionOf(rows));
    // the readings are the full grid's: the grid that ends with the window gives the frame one build of both windows gives
    const f = buildFrames(SYN_SPAN, [SYN_FIT], census, synFullLoad, { outcomes: true, seed: PRESCORE.entrySeed })[0];
    expect(f.nE).toBe(out.entries);
    const c2 = cand('C2'), cols = challengerColumns(f, synFullLoad, [c2.dial as Dial]);
    const seed = seedsFor(CHALLENGE_SEED, [`${PRESCORE.id}|C2|ddelta1|bootstrap`])[0];
    const want = deltaDelta1(f, context(f), pairOf(f, c2, cols), { B: COUNTS.boot, alpha: ALPHA, seed, arms: true });
    expect([out.candidates.C2.ddelta1.point, out.candidates.C2.ddelta1.lb, out.candidates.C2.ddelta1.ub]).toEqual([want.point, want.lb, want.ub]);
  });

  it('the pre-score is held to its census, its archive manifest and the registered tables', { timeout: 60_000 }, () => {
    const inside = prescore('x', { out: path.join(repo, 'out') });
    expect([inside.verdict, inside.reason]).toEqual(['REFUSED', 'the output directory must sit outside the repository']);
    expect(fs.existsSync(path.join(repo, 'out'))).toBe(false);
    const nopins = prescore('out-pre-r', { study: preStudy({ pins: undefined }) });
    expect(nopins.reason).toMatch(/must name the sha256 of its census/);
    const census2 = prescore('out-pre-r', { study: preStudy({ pins: { census: 'f'.repeat(64), archives: made.archivesSha256 } }) });
    expect([census2.verdict, census2.reason]).toEqual(['REFUSED', 'the census file is not the registered one']);
    const manifest2 = prescore('out-pre-r', { study: preStudy({ pins: { census: sha256(SYN_CENSUS_TEXT), archives: 'e'.repeat(64) } }) });
    expect([manifest2.verdict, manifest2.reason]).toEqual(['REFUSED', 'the archive-store manifest is not the registered one']);
    expect(prescore('out-pre-r', { manifest: path.join(dir, 'absent.json') }).verdict).toBe('INDETERMINATE');
    expect(prescore('out-pre-r', { censusFile: path.join(dir, 'absent.json') }).verdict).toBe('INDETERMINATE');
    expect(prescore('out-pre-r', { tables: 'audits/absent.md' }).verdict).toBe('INDETERMINATE');
    const skel = prescore('out-pre-r', { tables: MOVED });
    expect(skel.verdict).toBe('REFUSED');
    expect(skel.reason).toMatch(/^skeleton: \d+ cells differ from the registered fit tables/);
    expect(lines.join('|')).not.toMatch(/outcomes/);
    // not one of these wrote a result
    expect(fs.existsSync(path.join(dir, 'out-pre-r', PRESCORE_FILE))).toBe(false);
    const log = fs.readFileSync(path.join(dir, 'out-pre-r', 'regime-challenge-r1-prescore.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(log.every((e) => e.ok === false)).toBe(true);
    expect(log.map((e) => e.leg)).toEqual(['pins', 'census', 'archives', 'archives', 'census', 'skeleton', 'skeleton']);
  });

  it('an archive of a record\'s months that is not the registered one refuses the run; a month outside them is never opened', { timeout: 60_000 }, () => {
    const manifest = json(guard.archivesFile(store)) as ArchiveManifest;
    expect(archivesRefusal(SYN_PRESCORE, archives, census.panel, manifest)).toBeNull();
    expect(archivesRefusal(SYN_JUDGE, archives, census.panel, manifest)).toBeNull();
    const other = (ym: string): string => path.join(archives.overlay, archiveName('SYNA', '1m', ym));
    const put = (ym: string): void => { fs.writeFileSync(other(ym), zipSingle(archiveName('SYNA', '1m', ym).replace('.zip', '.csv'), Buffer.from('1,1,1,1,1,1\n'))); };
    try {
      // March: inside both records' months
      put('2024-03');
      expect(archivesRefusal(SYN_PRESCORE, archives, census.panel, manifest)).toBe('SYNAUSDT-1m-2024-03.zip is not the registered archive');
      const r = prescore('out-pre-archive');
      expect([r.verdict, r.reason]).toEqual(['REFUSED', 'SYNAUSDT-1m-2024-03.zip is not the registered archive']);
      expect(fs.existsSync(path.join(dir, 'out-pre-archive', PRESCORE_FILE))).toBe(false);
      fs.rmSync(other('2024-03'));
      // July: the judge's month. The pre-score does not look at it; the judge's check does
      put('2024-07');
      expect(archivesRefusal(SYN_PRESCORE, archives, census.panel, manifest)).toBeNull();
      expect(archivesRefusal(SYN_JUDGE, archives, census.panel, manifest)).toBe('SYNAUSDT-1m-2024-07.zip is not the registered archive');
      fs.rmSync(other('2024-07'));
      // January: before the judge's history. The judge does not look at it
      put('2024-01');
      expect(archivesRefusal(SYN_JUDGE, archives, census.panel, manifest)).toBeNull();
    } finally {
      for (const ym of ['2024-01', '2024-03', '2024-07']) fs.rmSync(other(ym), { force: true });
    }
    // an archive the manifest names and the disk lacks, and one the disk holds and the manifest lacks
    const fewer: ArchiveManifest = { ...manifest, files: manifest.files.filter((x) => x.name !== 'SYNBUSDT-1m-2024-04.zip') };
    expect(archivesRefusal(SYN_PRESCORE, archives, census.panel, fewer)).toBe('SYNBUSDT-1m-2024-04.zip is on disk and not in the registered archive manifest');
    const more: ArchiveManifest = { ...manifest, files: [...manifest.files, { ...manifest.files[0], name: 'SYNCUSDT-1m-2024-02.zip' }] };
    expect(archivesRefusal(SYN_PRESCORE, archives, census.panel, more)).toBe('SYNCUSDT-1m-2024-02.zip is in the registered archive manifest and not on disk');
  });

  // ── the judge: every refusal comes before the seal ──────────────────────────────────────────────────────────

  it('the judge refuses a registration that is not landed, and reads nothing', { timeout: 60_000 }, () => {
    expect(unlandedJudge.verdict).toBe('REFUSED');
    expect(unlandedJudge.reason).toMatch(/^guard \(registration\): .*not on origin\/main/);
    nothingRead('out-judge-unlanded');
  });

  it('the judge keeps its store and its results outside the repository, and a synthetic study names its own seal home', { timeout: 60_000 }, () => {
    const s = judge('out-j1', { store: path.join(repo, 'store') });
    expect([s.verdict, s.reason]).toEqual(['REFUSED', 'the store must sit outside the repository']);
    expect(fs.existsSync(path.join(repo, 'store'))).toBe(false);
    const o = judge('x', { out: path.join(repo, 'out') });
    expect([o.verdict, o.reason]).toEqual(['REFUSED', 'the output directory must sit outside the repository']);
    const h = judge('out-j1', { study: judgeStudy({ sealHome: undefined }) });
    expect([h.verdict, h.reason]).toEqual(['REFUSED', 'a synthetic study must name its own seal home']);
    nothingRead('out-j1');
    expect(logged().slice(-2).map((e) => [e.ok, e.leg, e.wave])).toEqual([[false, 'out', CHALLENGE_WAVE], [false, 'seal-home', CHALLENGE_WAVE]]);
  });

  it('the judge runs the files its registration pins: one that is not pinned, or not the pinned bytes, refuses', { timeout: 60_000 }, () => {
    // the five files of this round and the fourteen modules outside the harness list: T3's and its successor's registrations pin the same fourteen
    expect(CHALLENGE_FILES.every((f) => REQUIRED_PINS.includes(f))).toBe(true);
    expect(REQUIRED_PINS.length).toBe(19);
    expect(REQUIRED_PINS.some((f) => guard.HARNESS_FILES.includes(f))).toBe(false);
    for (const reg of ['audits/regime-diagnostic-preregistration-2026-11-16.md', 'audits/regime-confirmation-preregistration-2026-11-17.md']) {
      const rows = [...fs.readFileSync(path.join(REPO, reg), 'utf8').matchAll(/^\| `([^`]+)` \| `[0-9a-f]{64}` \|/gm)].map((m) => m[1]).filter((k) => !/^(store|census|spec|carry):/.test(k));
      // (a registration re-pins a file in an amendment: each file once)
      expect([...new Set(rows.filter((k) => !guard.HARNESS_FILES.includes(k)))].sort()).toEqual(REQUIRED_PINS.filter((f) => !CHALLENGE_FILES.includes(f)).sort());
    }
    // a registration that leaves one out binds nothing to it: the judge under it is refused
    const unpinned = judge('out-j2', { registration: 'audits/reg-nochallenge.md' });
    expect([unpinned.verdict, unpinned.reason]).toEqual(['REFUSED', `the registration does not pin ${CHALLENGE_FILES[2]}, which the judge runs`]);
    const outside = judge('out-j2', { registration: 'audits/reg-nooutside.md' });
    expect([outside.verdict, outside.reason]).toEqual(['REFUSED', 'the registration does not pin src/lib/indicators.ts, which the judge runs']);
    expect(logged().slice(-1).map((e) => [e.ok, e.leg])).toEqual([[false, 'pins']]);
    // a pinned file that is not the pinned bytes: the pinned guard refuses
    const changed = withFile(path.join(repo, CHALLENGE_FILES[2]), (s) => `${s}// changed\n`, () => judge('out-j2'));
    expect(changed.verdict).toBe('REFUSED');
    expect(changed.reason).toMatch(/^guard \(pins\): .*paired-stats\.ts/);
    const harness = withFile(path.join(repo, 'src/scripts/regime-diag/stats.ts'), (s) => `${s}// changed\n`, () => judge('out-j2'));
    expect(harness.verdict).toBe('REFUSED');
    expect(harness.reason).toMatch(/^guard \(pins\): .*stats\.ts/);
    expect(lines.join('|')).not.toMatch(/guard: ok/);
    nothingRead('out-j2');
  });

  it('AC1.1 the carry is accepted only by its sha256: absent, other bytes, or no pin — refused before the seal', { timeout: 60_000 }, () => {
    const absent = judge('out-j3', { prescore: path.join(dir, 'carry', 'absent.json') });
    expect([absent.verdict, absent.reason]).toEqual(['REFUSED', 'the pre-score result is absent']);
    // the pre-score's own output is not the file the registration pins
    const otherBytes = judge('out-j3', { prescore: pre.file as string });
    expect(otherBytes.verdict).toBe('REFUSED');
    expect(otherBytes.reason).toMatch(/^the pre-score result is not the one the registration pins \(sha256 [0-9a-f]{12}… read, [0-9a-f]{12}… pinned\)$/);
    // one byte more
    const longer = path.join(dir, 'carry', 'longer.json');
    fs.writeFileSync(longer, `${fs.readFileSync(carry, 'utf8')}\n`);
    expect(judge('out-j3', { prescore: longer }).reason).toMatch(/is not the one the registration pins/);
    const nopin = judge('out-j3', { registration: 'audits/reg-nocarry.md' });
    expect([nopin.verdict, nopin.reason]).toEqual(['REFUSED', `the registration does not pin ${PRESCORE_PIN}`]);
    expect(lines.join('|')).not.toMatch(/outcomes|seal/);
    nothingRead('out-j3');
    // on the store's record: the absent file is refused before the guard is asked; the others after it passed
    expect(logged().slice(-7).map((e) => [e.ok, e.leg])).toEqual([[false, 'carry'], [true, 'ok'], [false, 'carry'], [true, 'ok'], [false, 'carry'], [true, 'ok'], [false, 'carry']]);
  });

  it('a pinned pre-score of another study, with no challenger sent, or malformed, is refused before the seal', { timeout: 60_000 }, () => {
    const at = (n: string): Partial<run.JudgeInput> => ({ registration: `audits/reg-${n}.md`, prescore: path.join(dir, 'carry', `${n}.json`) });
    const other = judge('out-j4', at('other'));
    expect([other.verdict, other.reason]).toEqual(['REFUSED', 'the pre-score result is from another study (registered, this run is injected)']);
    const empty = judge('out-j4', at('empty'));
    expect([empty.verdict, empty.reason]).toEqual(['REFUSED', 'the pre-score sent no challenger to the judge']);
    // two candidates of one challenger: the pre-score picks one period
    expect(judge('out-j4', at('twice')).reason).toBe('the pre-score result is malformed');
    expect(judge('out-j4', at('unknown')).reason).toBe('the pre-score result is malformed');
    nothingRead('out-j4');
  });

  it('the frame is checked against tables the registration pins, before the seal: unpinned tables, or a frame that is not the registered one, refuse', { timeout: 60_000 }, () => {
    const unpinned = judge('out-j5', { registration: 'audits/reg-notables.md' });
    expect([unpinned.verdict, unpinned.reason]).toEqual(['REFUSED', `the registration does not pin ${TABLES}, whose tables the frame is checked against`]);
    const movedUnpinned = judge('out-j5', { tables: MOVED });
    expect(movedUnpinned.reason).toBe(`the registration does not pin ${MOVED}, whose tables the frame is checked against`);
    const skel = judge('out-j5', { registration: 'audits/reg-moved.md', tables: MOVED });
    expect(skel.verdict).toBe('REFUSED');
    expect(skel.reason).toMatch(/^skeleton: \d+ cells differ from the registered hold-out tables/);
    expect(lines.join('|')).toMatch(/guard: ok/);
    expect(lines.join('|')).not.toMatch(/identifiability|seal|outcomes/);
    nothingRead('out-j5');
    expect(logged().slice(-1).map((e) => [e.ok, e.leg])).toEqual([[false, 'skeleton']]);
  });

  it('a deliberately broken harness computes nothing: under a mutation lever both runs refuse', { timeout: 60_000 }, async () => {
    for (const lever of ['c1copy', 'judgemonth']) {
      const j = await mutated(lever, (m) => m.judgeRun({ repo, registration: GOOD, store, censusFile, archives, prescore: carry, out: path.join(dir, 'out-j6'), tables: TABLES, study: judgeStudy() }));
      expect(j.verdict).toBe('REFUSED');
      expect(j.reason).toBe(`guard (mutation): REGIME_DIAG_MUTATE is set (${lever}): a deliberately broken harness computes no outcome`);
      const p = await mutated(lever, (m) => m.prescoreRun({ repo, censusFile, archives, manifest: guard.archivesFile(store), out: path.join(dir, 'out-pre-m'), tables: TABLES, study: preStudy() }));
      expect([p.verdict, p.reason]).toEqual(['REFUSED', `REGIME_DIAG_MUTATE is set (${lever}): a deliberately broken harness computes no outcome`]);
    }
    nothingRead('out-j6');
    expect(fs.existsSync(path.join(dir, 'out-pre-m', PRESCORE_FILE))).toBe(false);
  });

  it('a run of the registered round is read by the landed sources of its own repository, never a copy', { timeout: 60_000 }, () => {
    expect(run.isChallengeSource(path.join(REPO, CHALLENGE_FILES[4]), REPO)).toBe(true);
    expect(run.isChallengeSource(path.join(REPO, CHALLENGE_FILES[4]), repo)).toBe(false);
    expect(run.isChallengeSource(path.join(REPO, CHALLENGE_FILES[3]), REPO)).toBe(false);
    // with no synthetic study, the running file must be the repository's own: the sandbox's is a copy
    const p = run.prescoreRun({ repo, censusFile, archives, manifest: guard.archivesFile(store), out: path.join(dir, 'out-pre-s') });
    expect(p.verdict).toBe('REFUSED');
    expect(p.reason).toMatch(/never a compiled or copied harness/);
    const j = run.judgeRun({ repo, registration: GOOD, store, censusFile, archives, prescore: carry, out: path.join(dir, 'out-j7') });
    expect(j.verdict).toBe('REFUSED');
    expect(j.reason).toMatch(/never a compiled or copied harness/);
    nothingRead('out-j7');
    expect(logged().slice(-1).map((e) => [e.ok, e.leg])).toEqual([[false, 'source']]);
  });

  it('the judge reads the one registration of its name on origin/main: none, or more than one, is no registration', { timeout: 60_000 }, () => {
    expect(registrationOnMain(repo, REGISTRATION_RE)).toEqual({ path: GOOD, reason: 'ok' });
    expect(registrationOnMain(repo, /^audits\/none-.*\.md$/)).toEqual({ path: null, reason: 'origin/main holds no judge registration' });
    expect(registrationOnMain(repo, /^audits\/reg-tables/)).toEqual({ path: null, reason: 'origin/main holds 2 judge registrations: the judge reads one' });
    expect(registrationOnMain(path.join(dir, 'no-such-repo'), REGISTRATION_RE).reason).toMatch(/origin could not be read/);
    expect(REGISTRATION_RE.test(GOOD)).toBe(true);
    expect(REGISTRATION_RE.test('audits/regime-diagnostic-preregistration-2026-11-16.md')).toBe(false);
  });

  // ── the judge: the one read ────────────────────────────────────────────────────────────────────────────────

  it('AC1.1 the judge: one read, in T3\'s order — guard, skeleton, identifiability, seal, outcomes — of its own months only', { timeout: 120_000 }, () => {
    const before = logged().length;
    expect(fs.existsSync(seal)).toBe(false);
    // the carried file is accepted by its bytes, wherever it sits and whatever it is called; the registration is found by its name
    const elsewhere = path.join(dir, 'elsewhere', 'renamed.json');
    fs.mkdirSync(path.dirname(elsewhere));
    fs.copyFileSync(carry, elsewhere);
    const r = judge('out-judge', { prescore: elsewhere, registration: undefined });
    expect([r.verdict, r.reason]).toEqual(['PASS', 'ok']);
    expect(r.line).toMatch(new RegExp(`^REGIME_CHALLENGE_VERDICT=C1:${DECISION};C2:KEEP \\(pre-score\\);C3:${DECISION}$`));
    expect(r.file).toBe(path.join(dir, 'out-judge', JUDGE_FILE));
    // the seal: claimed once, in the seal home, with the read's record
    const sealed = json(seal);
    expect([sealed.wave, sealed.prescore_sha256]).toEqual([CHALLENGE_WAVE, sha256(fs.readFileSync(carry))]);
    expect(sealed.registration_commit).toBe(git(repo, 'log', '-1', '--format=%H', 'origin/main', '--', GOOD));
    // the order, on the store's record: nothing is read before the guard, the identifiability and the seal
    expect(logged().slice(before).map((e) => [e.ok, e.leg])).toEqual([[true, 'ok'], [true, 'identifiability'], [true, 'seal'], [true, 'outcomes'], [true, 'result']]);
    const at = (s: string): number => lines.findIndex((l) => l.startsWith(s));
    const order = ['guard: ok', 'skeleton: equal', 'challengers:', 'identifiability: judge', 'seal: claimed', 'outcomes: judge', 'paired:'].map(at);
    expect(order.every((x) => x >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    const out = json(r.file as string);
    expect([out.wave, out.kind, out.study, out.record, out.seed]).toEqual([CHALLENGE_WAVE, 'judge', 'injected', JUDGE.id, CHALLENGE_SEED]);
    expect(out.registration.path).toBe(GOOD);
    expect(out.prescore_sha256).toBe(sha256(fs.readFileSync(carry)));
    expect(out.window).toEqual({ outcomes: { first: '2024-06', last: '2024-07' }, archives: { first: '2024-02', last: '2024-07' } });
    // January is before its history and August after its window: both archives sit in the store, neither was opened
    expect(out.months_opened).toEqual(['2024-02', '2024-03', '2024-04', '2024-05', '2024-06', '2024-07']);
    for (const ym of ['2024-01', SYN_AFTER]) expect(fs.existsSync(path.join(archives.cache, archiveName('SYNA', '1m', ym)))).toBe(true);
    expect(out.family).toEqual(['C1.7', 'C3']);
    expect(Object.keys(out.candidates)).toEqual(['C1.7', 'C3']);
    expect(out.line).toBe(r.line);
    expect(logged().slice(-1)[0].result_sha256).toBe(sha256(fs.readFileSync(r.file as string)));
  });

  it('before the seal the judge writes what its decision reads from the labels: identifiability, each arm\'s support, coverage, beside the floors', { timeout: 60_000 }, () => {
    const all = logged();
    const at = all.findIndex((e) => e.leg === 'identifiability');
    // one line, from the one read, written before the seal was claimed
    expect(all.filter((e) => e.leg === 'identifiability')).toHaveLength(1);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(all.findIndex((e) => e.leg === 'seal' && e.ok === true));
    const line = all[at] as { ok: boolean; floor_clusters: number; floor_pp: number; candidates: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect([line.ok, line.floor_clusters, line.floor_pp]).toEqual([true, FLOOR, FLOOR_PP]);
    // label-only: the line carries no key a reading or an outcome carries
    expect([...keysOf(line.candidates)].filter((k) => !(k in line.candidates)).sort()).toEqual(['arms', 'bound', 'challenger', 'coverage', 'eff', 'identifiable', 'served', 'share']);
    // equal to the decision's inputs: recomputed from the labels of the same frame, and the decision the result wrote
    const out = json(path.join(dir, 'out-judge', JUDGE_FILE));
    const f = buildFrames(SYN_SPAN, [SYN_HOLD], census, synFullLoad, { outcomes: false, seed: JUDGE.entrySeed })[0];
    const ctx = context(f);
    const judged = (out.family as string[]).map(cand);
    expect(Object.keys(line.candidates)).toEqual(out.family);
    const dials = judged.flatMap((c) => (c.dial ? [c.dial] : []));
    const cols = dials.length ? challengerColumns(f, synFullLoad, dials) : null;
    const fin = (x: number | null): number | null => (x !== null && Number.isFinite(x) ? x : null);
    const arm = (a: ArmSupport): Record<string, number | null> => ({ eff: fin(a.eff), share: fin(a.share), bound: fin(a.bound) });
    for (const c of judged) {
      const pair = pairOf(f, c, cols), s = supportOf(f, ctx, pair, FLOOR);
      expect(line.candidates[c.id]).toEqual({ identifiable: s.identifiable, arms: { challenger: arm(s.challenger), served: arm(s.served) }, coverage: fin(coverageRatio(ctx.w, pair)) });
      expect(line.candidates[c.id].identifiable).toBe(out.candidates[c.id].identifiable);
      expect(line.candidates[c.id].coverage).toBe(out.candidates[c.id].coverage.ratio);
      // the arms' own facts decide the boolean: each arm at or above the cluster floor and the attainable floor
      const ok = (a: Record<string, number | null>): boolean => (a.eff as number) >= line.floor_clusters && a.bound !== null && a.bound >= line.floor_pp;
      expect(line.candidates[c.id].identifiable).toBe(ok(line.candidates[c.id].arms.challenger) && ok(line.candidates[c.id].arms.served));
    }
  });

  it('the judge result holds paired quantities only: no arm\'s own value, and no served-only key', { timeout: 60_000 }, () => {
    const out = json(path.join(dir, 'out-judge', JUDGE_FILE));
    const keys = keysOf(out);
    // the walk can fail: the in-sample result carries each arm
    expect(keysOf(json(pre.file as string)).has('arms')).toBe(true);
    for (const k of keys) expect(k).not.toMatch(/arms|served|support|share|drops/i);
    const PAIRED = ['point', 'lb', 'ub', 'alpha', 'rows', 'clusters', 'eff', 'B', 'undefined_replicates'];
    const levels: number[] = [];
    let read = 0;
    for (const id of out.family as string[]) {
      const x = out.candidates[id];
      expect(Object.keys(x)).toEqual(['challenger', 'map', 'what', 'decision', 'cause', 'identifiable', 'ddelta1', 'holm', 'a4', 'a5', 'coverage', 'prescore_point', 'power']);
      expect(Object.keys(x.coverage)).toEqual(['ratio', 'guard']);
      levels.push(x.holm.level);
      // the decision written is the decision rule's, on what is written beside it
      const d = run.decisionOf({ identifiable: x.identifiable, rejects: x.holm.rejects, guards: [x.a4?.guard ?? 'unreadable', x.a5?.guard ?? 'unreadable', x.coverage.guard],
        lb: x.ddelta1?.lb ?? NaN, ub: x.ddelta1?.ub ?? NaN, prescorePoint: x.prescore_point });
      expect([x.decision, x.cause]).toEqual([d.decision, d.cause]);
      if (!x.identifiable) { expect([x.ddelta1, x.a4, x.a5, x.decision]).toEqual([null, null, null, 'NOT_IDENTIFIABLE']); continue; }
      read++;
      expect(Object.keys(x.ddelta1)).toEqual(PAIRED);
      expect(Object.keys(x.a4)).toEqual([...PAIRED, 'guard']);
      expect(Object.keys(x.a5)).toEqual([...PAIRED, 'guard']);
      expect(x.ddelta1.B).toBe(COUNTS.boot);
    }
    expect(read).toBeGreaterThanOrEqual(1);
    // Holm across the two judged: α/2 and α
    expect(levels.sort()).toEqual([ALPHA / 2, ALPHA]);
    expect(out.candidates['C1.7'].identifiable).toBe(true);
    // the reading is the full grid's: the months before the judge's history change nothing it reads
    const f = buildFrames(SYN_SPAN, [SYN_HOLD], census, synFullLoad, { outcomes: true, seed: JUDGE.entrySeed })[0];
    expect(f.nE).toBe(out.entries);
    const c1 = cand('C1.7'), cols = challengerColumns(f, synFullLoad, [c1.dial as Dial]);
    const seed = seedsFor(CHALLENGE_SEED, [`${JUDGE.id}|C1.7|ddelta1|bootstrap`])[0];
    const want = deltaDelta1(f, context(f), pairOf(f, c1, cols), { B: COUNTS.boot, alpha: ALPHA, seed, arms: false });
    expect([out.candidates['C1.7'].ddelta1.point, out.candidates['C1.7'].ddelta1.lb, out.candidates['C1.7'].ddelta1.ub]).toEqual([want.point, want.lb, want.ub]);
  });

  it('AC1.1 the judge seal is claimed once: a second read refuses, whatever store or output it names, and the result stands', { timeout: 60_000 }, () => {
    const result = path.join(dir, 'out-judge', JUDGE_FILE), kept = fs.readFileSync(result), sealed = fs.readFileSync(seal);
    const again = judge('out-judge');
    expect([again.verdict, again.reason]).toEqual(['REFUSED', 'guard (seal): the hold-out seal exists: the hold-out has been read']);
    expect(lines.join('|')).not.toMatch(/outcomes/);
    // another output directory, and another store with the same manifests: the seal has one home
    const store2 = path.join(dir, 'store2');
    guard.initStore(store2, archives, census.panel, judgeStudyRecord(''));
    const moved = judge('out-judge-2', { store: store2 });
    expect([moved.verdict, moved.reason]).toEqual(['REFUSED', 'guard (seal): the hold-out seal exists: the hold-out has been read']);
    expect(fs.existsSync(path.join(dir, 'out-judge-2', JUDGE_FILE))).toBe(false);
    // the claim itself is exclusive: a second claim of the seal is refused and changes nothing
    const claim = guard.claimSeal(home, store, { seal: JUDGE.seal as string, wave: JUDGE.wave }, { again: true });
    expect(claim).toEqual({ ok: false, reason: 'the hold-out seal exists: the hold-out has been read' });
    expect(fs.readFileSync(seal).equals(sealed)).toBe(true);
    expect(fs.readFileSync(result).equals(kept)).toBe(true);
    expect(logged().slice(-1).map((e) => [e.ok, e.leg])).toEqual([[false, 'seal']]);
    // this round's seal is its own: neither T3's nor its successor's
    expect(fs.readdirSync(home)).toEqual([JUDGE.seal]);
    expect(JUDGE.seal).toBe('challenge-r1.seal');
  });
});

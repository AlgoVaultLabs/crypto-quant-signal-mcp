// tests/unit/regime-diag-guard.test.ts — EDGE-REGIME-DIAG-W1 CH2: the outcome guard, the hold-out seal and the run
// (AC2.3: an unlanded registration, a pin mismatch and a second hold-out read are refused; AC2.4: the seal's
// mutation proof). Everything runs in a sandbox repository with a bare origin, on synthetic archives, and the
// synthetic study keeps its seal in the sandbox: no test reads or writes the registered study's seal home.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { archiveManifestText, buildArchiveManifest, coinArchives, resolveArchive, sha256, type ArchiveStore } from '../../src/scripts/regime-diag/archive.js';
import { buildFrames, parseCensus, skeletonOf, type Skeleton } from '../../src/scripts/regime-diag/frame.js';
import * as guard from '../../src/scripts/regime-diag/guard.js';
import { PARITY_FIXTURE } from '../../src/scripts/regime-diag/parity.js';
import * as run from '../../src/scripts/regime-diag/run.js';
import { pinsOf, storePin } from '../../src/scripts/sr-backtest/guard.js';
import { REGISTRATION, SPAN, STATISTICS, VENUE, type Win } from '../../src/scripts/regime-diag/diag-spec.js';
import { synthCsv } from '../../src/scripts/regime-diag/synth.js';
import { SYNTH_CENSUS_TEXT, SYNTH_SPAN, synthLoad, zipSingle } from '../fixtures/regime-diag/synth-study.js';

const REPO = path.resolve(__dirname, '../..');
// Most tests here block the worker (git, the replay, the resamples), and back-to-back synchronous tests never
// give it a macrotask turn to read vitest's RPC replies: past 60 s the file ends "Timeout calling onTaskUpdate"
// (exit 1) with every test green. Measured here 2026-11-16: the eight regime-diag files run together ended that
// way without this hook. One setImmediate per test lets the poll phase drain the replies (the same hook, and the
// measurement behind it, as tests/unit/worktree-reclaim.test.ts).
afterEach(() => new Promise<void>((done) => { setImmediate(done); }));
const EXTRA = ['src/lib/market-regime-core.ts', 'src/scripts/cluster-perm-stats.py', 'ops/monitoring/population_comparison.py', 'src/scripts/sr-backtest/guard.ts', 'src/scripts/sr-backtest/store.ts'];
const D = 1440;
const FIT: Win = { name: 'fit', lo: 0, hi: 75 * D };
const HOLD: Win = { name: 'holdout', lo: 75 * D, hi: 130 * D };
const FIT_STATE = '(works|broken|too_little_data)', HOLD_STATE = '(CONFIRMED|NOT_CONFIRMED|NOT_IDENTIFIABLE)';
const five = (s: string): string => [1, 2, 3, 4, 5].map((i) => `A${i}:${s}`).join(';');

const git = (repo: string, ...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const pinTable = (pins: Record<string, string>): string =>
  ['# A registration', '', '## Pinned artifacts', '', '| artifact | sha256 |', '|---|---|', ...Object.entries(pins).map(([k, v]) => `| \`${k}\` | \`${v}\` |`), ''].join('\n');
const KEY_COLS: Record<string, number> = { '2a': 3, '2b': 2, '2c': 1, '2d': 2, '2e': 2 };
/** Tables 2a–2e as the registration carries them, rendered from a skeleton. */
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
const within = (p: string, root: string): boolean => { const rel = path.relative(root, p); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
const corrupt = (fixture: string): string => fixture.replace(/"confidence": (\d+)/, (_, c: string) => `"confidence": ${Number(c) + 1}`);

async function mutated<T>(lever: string, fn: (m: typeof guard) => T): Promise<T> {
  process.env.REGIME_DIAG_MUTATE = lever;
  vi.resetModules();
  try {
    return fn(await import('../../src/scripts/regime-diag/guard.js'));
  } finally {
    delete process.env.REGIME_DIAG_MUTATE;
    vi.resetModules();
  }
}

describe('regime-diag: the outcome guard, the seal and the run, in a sandbox repository', () => {
  let dir = '', repo = '', store = '', home = '', censusFile = '';
  let archives: ArchiveStore = { cache: '', overlay: '' };
  let unlanded: guard.DiagGuardResult, unlandedRun: run.RunResult;
  const lines: string[] = [];
  const study = (): run.Study => ({ span: SYNTH_SPAN, fit: FIT, holdout: HOLD, load: synthLoad, counts: () => ({ boot: 200, shuffle: 100, perm: 50 }), floorClusters: 25, log: (l) => lines.push(l), sealHome: home });
  const inp = (registration: string, mode: 'fit' | 'holdout' = 'fit'): guard.DiagGuardInput => ({ repo, registration, store, sealHome: home, censusFile, archives, mode });
  const go = (mode: 'fit' | 'holdout', out: string, more: Partial<run.RunInput> = {}): run.RunResult => {
    lines.length = 0;
    return run.outcomeRun({ mode, repo, registration: 'audits/reg-good.md', store, censusFile, archives, out: path.join(dir, out), study: study(), ...more });
  };
  const logged = (): Array<Record<string, unknown>> => fs.readFileSync(guard.guardLog(store), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const json = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8')); // eslint-disable-line @typescript-eslint/no-explicit-any
  /** A two-hour archive of one month: each month's rows sit in their own minutes of the registered span. */
  const zip = (name: string, key: string): Buffer => {
    const from = name.includes('-2024-02') ? 31 * 1440 : 0;
    return zipSingle(name.replace('.zip', '.csv'), Buffer.from(synthCsv(SPAN, key, { from, to: from + 120 })));
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-diag-guard-'));
    repo = path.join(dir, 'repo'); store = path.join(dir, 'store'); home = path.join(dir, 'seal-home'); censusFile = path.join(dir, 'census.json');
    archives = { cache: path.join(dir, 'cache'), overlay: path.join(dir, 'overlay') };
    for (const d of [archives.cache, archives.overlay, path.join(dir, 'no-hooks')]) fs.mkdirSync(d, { recursive: true });
    git(dir, 'init', '-q', '--bare', '--initial-branch=main', 'origin.git');
    git(dir, 'init', '-q', '--initial-branch=main', 'repo');
    for (const [k, v] of [['user.email', 'sandbox@example.invalid'], ['user.name', 'sandbox'], ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(dir, 'no-hooks')]]) git(repo, 'config', k, v);
    git(repo, 'remote', 'add', 'origin', path.join(dir, 'origin.git'));
    fs.writeFileSync(path.join(repo, 'README.md'), 'sandbox\n');
    git(repo, 'add', 'README.md'); git(repo, 'commit', '-q', '-m', 'base'); git(repo, 'push', '-q', '-u', 'origin', 'main');

    for (const rel of [...guard.HARNESS_FILES, ...EXTRA]) {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.cpSync(path.join(REPO, rel), path.join(repo, rel));
    }
    // synthetic archives: two months for the first position (the second month also in the overlay), one for the second
    fs.writeFileSync(path.join(archives.cache, 'SYNAUSDT-1m-2024-01.zip'), zip('SYNAUSDT-1m-2024-01.zip', 'a1'));
    fs.writeFileSync(path.join(archives.cache, 'SYNAUSDT-1m-2024-02.zip'), zip('SYNAUSDT-1m-2024-02.zip', 'a2-cache'));
    fs.writeFileSync(path.join(archives.overlay, 'SYNAUSDT-1m-2024-02.zip'), zip('SYNAUSDT-1m-2024-02.zip', 'a2-overlay'));
    fs.writeFileSync(path.join(archives.cache, 'SYNBUSDT-1m-2024-01.zip'), zip('SYNBUSDT-1m-2024-01.zip', 'b1'));
    fs.writeFileSync(censusFile, SYNTH_CENSUS_TEXT);
    const census = parseCensus(SYNTH_CENSUS_TEXT);
    const made = guard.initStore(store, archives, census.panel);
    expect(made.archiveFiles).toBe(3);

    const sk = skeletonOf(buildFrames(SYNTH_SPAN, [FIT, HOLD], census, synthLoad, { outcomes: false }));
    const pins: Record<string, string> = {};
    for (const rel of [...guard.HARNESS_FILES, ...EXTRA]) pins[rel] = sha256(fs.readFileSync(path.join(repo, rel)));
    pins['store:manifest-BINANCE.json'] = made.guardStoreSha256;
    pins[guard.CENSUS_PIN] = sha256(SYNTH_CENSUS_TEXT);
    pins[guard.ARCHIVES_PIN] = made.archivesSha256;
    const without = (k: string): Record<string, string> => Object.fromEntries(Object.entries(pins).filter(([x]) => x !== k));
    const moved: Skeleton = JSON.parse(JSON.stringify(sk)) as Skeleton;
    (moved['2c'].fit[1] as number) += 1;
    const regs: Record<string, string> = {
      good: `${pinTable(pins)}\n${tables(sk)}`,
      noharness: `${pinTable(without('src/scripts/regime-diag/diag-spec.ts'))}\n${tables(sk)}`,
      nocensus: `${pinTable(without(guard.CENSUS_PIN))}\n${tables(sk)}`,
      badcensus: `${pinTable({ ...pins, [guard.CENSUS_PIN]: 'f'.repeat(64) })}\n${tables(sk)}`,
      noarchives: `${pinTable(without(guard.ARCHIVES_PIN))}\n${tables(sk)}`,
      badarchives: `${pinTable({ ...pins, [guard.ARCHIVES_PIN]: 'e'.repeat(64) })}\n${tables(sk)}`,
      parity: `${pinTable({ ...pins, [PARITY_FIXTURE]: sha256(corrupt(fs.readFileSync(path.join(repo, PARITY_FIXTURE), 'utf8'))) })}\n${tables(sk)}`,
      skel: `${pinTable(pins)}\n${tables(moved)}`,
    };
    fs.mkdirSync(path.join(repo, 'audits'));
    for (const [name, text] of Object.entries(regs)) { fs.writeFileSync(path.join(repo, 'audits', `reg-${name}.md`), text); git(repo, 'add', `audits/reg-${name}.md`); }
    for (const rel of [...guard.HARNESS_FILES, ...EXTRA]) git(repo, 'add', rel);
    git(repo, 'commit', '-q', '-m', 'registrations');
    // before the push: the registration is committed, and not landed
    unlanded = guard.checkDiagGuard(inp('audits/reg-good.md'));
    unlandedRun = go('fit', 'out-unlanded');
    unlanded = { ...unlanded, reason: `${unlanded.reason}|${lines.join('|')}` };
    git(repo, 'push', '-q', 'origin', 'main');
  }, 300_000);
  afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it('AC2.3 refuses an unlanded registration, and the run computes nothing', { timeout: 60_000 }, () => {
    expect([unlanded.ok, unlanded.leg]).toEqual([false, 'registration']);
    expect(unlanded.reason).toMatch(/not on origin\/main/);
    expect(unlanded.reason).not.toMatch(/outcomes/);
    expect(unlandedRun.verdict).toBe('REFUSED');
    expect(unlandedRun.reason).toMatch(/^guard \(registration\)/);
    expect([unlandedRun.line, unlandedRun.file, fs.existsSync(path.join(dir, 'out-unlanded', 'regime-diag-fit.json'))]).toEqual([null, null, false]);
  });

  it('passes once the registration is landed: pins, the landed text and a first-seen clock that does not move', { timeout: 60_000 }, () => {
    const before = logged().length;
    const a = guard.checkDiagGuard(inp('audits/reg-good.md')), b = guard.checkDiagGuard(inp('audits/reg-good.md'));
    expect([a.ok, a.leg, a.reason]).toEqual([true, 'ok', 'ok']);
    expect(a.registrationText).toContain('**Table 2a ');
    expect(a.registrationCommit).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(a.originMain).toBe(a.registrationCommit);
    expect(a.pins[guard.CENSUS_PIN]).toBe(sha256(SYNTH_CENSUS_TEXT));
    expect(a.pins[guard.ARCHIVES_PIN]).toBe(sha256(fs.readFileSync(guard.archivesFile(store))));
    expect(Object.keys(a.pins)).toEqual(expect.arrayContaining([...guard.HARNESS_FILES, ...EXTRA, 'store:manifest-BINANCE.json']));
    expect(a.landedAt?.commit_time).toBe(git(repo, 'show', '-s', '--format=%cI', 'HEAD'));
    expect(b.landedAt).toEqual(a.landedAt);
    expect(Date.parse(a.landedAt?.first_seen ?? '')).toBeGreaterThan(0);
    // every call is logged, pass or refusal
    const log = logged();
    expect(log.length).toBe(before + 2);
    expect(log.slice(-2).map((l) => [l.ok, l.leg, l.mode, l.registration_commit])).toEqual([[true, 'ok', 'fit', a.registrationCommit], [true, 'ok', 'fit', a.registrationCommit]]);
    expect(log[0]).toMatchObject({ ok: false, leg: 'registration', wave: 'EDGE-REGIME-DIAG-W1' });
  });

  it('AC2.3 refuses a pin mismatch: a harness file, a registered library file, a missing pin', { timeout: 60_000 }, () => {
    const before = logged().length;
    const harness = withFile(path.join(repo, 'src/scripts/regime-diag/diag-spec.ts'), (s) => `${s}\n// changed\n`, () => guard.checkDiagGuard(inp('audits/reg-good.md')));
    expect([harness.ok, harness.leg]).toEqual([false, 'pins']);
    expect(harness.reason).toMatch(/regime-diag\/diag-spec\.ts is not the registered file/);
    const lib = withFile(path.join(repo, 'src/lib/market-regime-core.ts'), (s) => `${s}\n// changed\n`, () => guard.checkDiagGuard(inp('audits/reg-good.md')));
    expect([lib.ok, lib.leg]).toEqual([false, 'pins']);
    expect(lib.reason).toMatch(/market-regime-core\.ts is not the registered file/);
    const missing = guard.checkDiagGuard(inp('audits/reg-noharness.md'));
    expect([missing.ok, missing.leg]).toEqual([false, 'pins']);
    expect(missing.reason).toMatch(/does not pin src\/scripts\/regime-diag\/diag-spec\.ts/);
    expect(logged().slice(before).map((l) => [l.ok, l.leg])).toEqual([[false, 'pins'], [false, 'pins'], [false, 'pins']]);
    expect(guard.checkDiagGuard(inp('audits/reg-good.md')).ok).toBe(true);
  });

  it('refuses a census or an archive store that is not the registered one', { timeout: 60_000 }, () => {
    const leg = (reg: string, more: Partial<guard.DiagGuardInput> = {}): [boolean, string, string] => {
      const r = guard.checkDiagGuard({ ...inp(`audits/reg-${reg}.md`), ...more });
      return [r.ok, r.leg, r.reason];
    };
    expect(leg('nocensus').slice(0, 2)).toEqual([false, 'census']);
    expect(leg('badcensus')).toEqual([false, 'census', expect.stringMatching(/not the registered one/)]);
    const other = path.join(dir, 'census-other.json');
    fs.writeFileSync(other, SYNTH_CENSUS_TEXT.replace('0.5', '0.4'));
    expect(leg('good', { censusFile: other })).toEqual([false, 'census', expect.stringMatching(/not the registered one/)]);
    expect(leg('good', { censusFile: path.join(dir, 'absent.json') })).toEqual([false, 'census', expect.stringMatching(/absent/)]);
    expect(leg('noarchives').slice(0, 2)).toEqual([false, 'archives']);
    expect(leg('badarchives')).toEqual([false, 'archives', expect.stringMatching(/not the registered one/)]);
    // an archive that arrives after the manifest was pinned
    const late = path.join(archives.overlay, 'SYNBUSDT-1m-2024-02.zip');
    fs.writeFileSync(late, zip('SYNBUSDT-1m-2024-02.zip', 'late'));
    try { expect(leg('good')).toEqual([false, 'archives', expect.stringMatching(/no longer match/)]); } finally { fs.rmSync(late); }
    expect(leg('good').slice(0, 2)).toEqual([true, 'ok']);
  });

  it('refuses a core-parity fixture that does not reproduce, even when it is the pinned one', { timeout: 60_000 }, () => {
    const r = withFile(path.join(repo, PARITY_FIXTURE), corrupt, () => guard.checkDiagGuard(inp('audits/reg-parity.md')));
    expect([r.ok, r.leg]).toEqual([false, 'parity']);
    // the same registration with the true fixture on disk fails on the pin instead
    expect(guard.checkDiagGuard(inp('audits/reg-parity.md')).leg).toBe('pins');
  });

  it('a deliberately broken harness computes no outcome', { timeout: 60_000 }, async () => {
    const r = await mutated('seal', (m) => m.checkDiagGuard(inp('audits/reg-good.md')));
    expect([r.ok, r.leg]).toEqual([false, 'mutation']);
    expect(r.reason).toMatch(/REGIME_DIAG_MUTATE is set \(seal\)/);
  });

  it('HARNESS_FILES is the harness directory, file for file', { timeout: 60_000 }, () => {
    const onDisk = fs.readdirSync(path.join(REPO, 'src/scripts/regime-diag')).map((f) => `src/scripts/regime-diag/${f}`).sort();
    expect(guard.HARNESS_FILES.filter((f) => f.startsWith('src/')).slice().sort()).toEqual(onDisk);
    expect(fs.readdirSync(path.join(REPO, 'scripts/regime-diag'))).toEqual(['prims.py']);
    for (const f of guard.HARNESS_FILES) expect(fs.existsSync(path.join(REPO, f)), f).toBe(true);
  });

  /**
   * One claim is permitted; the second is refused and leaves the first record in place — from the same store or
   * from another one. The seal sits in its home, never in a store; each store logs its own claim or refusal.
   */
  const sealOnce = (m: typeof guard): void => {
    const h = path.join(fs.mkdtempSync(path.join(dir, 'seal-')), 'home', 'not-yet-made'), s1 = fs.mkdtempSync(path.join(dir, 'seal-store-')), s2 = fs.mkdtempSync(path.join(dir, 'seal-store-'));
    const first = m.claimSeal(h, s1, { n: 1 }), second = m.claimSeal(h, s1, { n: 2 }), third = m.claimSeal(h, s2, { n: 3 });
    const kept = (JSON.parse(fs.readFileSync(m.sealFile(h), 'utf8')) as { n: number; wave: string });
    expect([first.ok, second.ok, third.ok, kept.n, kept.wave]).toEqual([true, false, false, 1, 'EDGE-REGIME-DIAG-W1']);
    expect([second.reason, third.reason]).toEqual([expect.stringMatching(/seal exists/), expect.stringMatching(/seal exists/)]);
    expect(m.sealFile(h)).toBe(path.join(h, 'holdout.seal'));
    expect([s1, s2].map((s) => fs.readdirSync(s))).toEqual([['guard.log'], ['guard.log']]);
    const log = (s: string): Array<[boolean, string]> => fs.readFileSync(m.guardLog(s), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { ok: boolean; leg: string }).map((l) => [l.ok, l.leg]);
    expect([log(s1), log(s2)]).toEqual([[[true, 'seal'], [false, 'seal']], [[false, 'seal']]]);
  };
  it('AC2.4 the seal permits exactly one claim (red when the seal is broken, green restored)', { timeout: 60_000 }, async () => {
    await expect(mutated('seal', (m) => sealOnce(m))).rejects.toThrow(/to deeply equal/);
    sealOnce(guard);
  });

  it('the overlay supersedes the cache; the manifest is deterministic; the registered study reads the store', { timeout: 60_000 }, () => {
    expect(resolveArchive(archives, 'SYNA', '1m', '2024-02')).toEqual({ file: path.join(archives.overlay, 'SYNAUSDT-1m-2024-02.zip'), source: 'overlay' });
    expect(resolveArchive(archives, 'SYNA', '1m', '2024-01')?.source).toBe('cache');
    expect(resolveArchive(archives, 'SYNA', '1m', '2024-03')).toBeNull();
    expect(coinArchives(archives, 'SYNA').map((f) => path.basename(path.dirname(f)))).toEqual(['cache', 'overlay']);
    const panel = parseCensus(SYNTH_CENSUS_TEXT).panel;
    const m = buildArchiveManifest(archives, panel);
    expect(m.files.map((f) => [f.name, f.source])).toEqual([['SYNAUSDT-1m-2024-01.zip', 'cache'], ['SYNAUSDT-1m-2024-02.zip', 'overlay'], ['SYNBUSDT-1m-2024-01.zip', 'cache']]);
    expect(m.files[1].sha256).toBe(sha256(fs.readFileSync(path.join(archives.overlay, 'SYNAUSDT-1m-2024-02.zip'))));
    expect(archiveManifestText(buildArchiveManifest(archives, panel))).toBe(fs.readFileSync(guard.archivesFile(store), 'utf8'));
    const st = run.registeredStudy(archives, panel);
    expect([st.span, st.fit.name, st.holdout.name, st.counts, st.floorClusters]).toEqual([SPAN, 'fit', 'holdout', undefined, undefined]);
    const first = st.load(0), third = st.load(2);
    expect([first.g?.counts.rows, first.noArchive]).toEqual([240, 32]);
    expect(third).toEqual({ g: null, noArchive: 34 });
  });

  it('refuses a store or an output directory inside the repository, and writes nothing there', { timeout: 60_000 }, () => {
    const before = logged().length;
    const a = go('fit', 'unused', { out: path.join(repo, 'out') });
    // the store is outside the repository, so this refusal is logged like every other
    expect(logged().slice(before)).toEqual([expect.objectContaining({ ok: false, leg: 'out', mode: 'fit', reason: a.reason })]);
    const b = go('fit', 'unused', { store: path.join(repo, 'store') });
    // a store inside the repository is never written to, its log included
    expect(logged()).toHaveLength(before + 1);
    expect([a.verdict, b.verdict]).toEqual(['REFUSED', 'REFUSED']);
    expect(a.reason).toMatch(/output directory must sit outside the repository/);
    expect(b.reason).toMatch(/store must sit outside the repository/);
    expect([fs.existsSync(path.join(repo, 'out')), fs.existsSync(path.join(repo, 'store'))]).toEqual([false, false]);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('the registered study is read by the pinned sources of the repository it guards, never a copied or compiled harness', { timeout: 60_000 }, () => {
    const self = 'src/scripts/regime-diag/run.ts';
    expect(run.isPinnedSource(path.join(REPO, self), REPO)).toBe(true);
    expect(run.isPinnedSource(path.join(REPO, 'dist/scripts/regime-diag/run.js'), REPO)).toBe(false);
    expect(run.isPinnedSource(path.join(REPO, self), repo)).toBe(false);
    // no study injected: this is the registered study, and the harness running it is not the sandbox repository's own
    const before = logged().length;
    const r = run.outcomeRun({ mode: 'fit', repo, registration: 'audits/reg-good.md', store, censusFile, archives, out: path.join(dir, 'out-copied') });
    expect([r.verdict, r.line, r.file]).toEqual(['REFUSED', null, null]);
    expect(r.reason).toMatch(/pinned sources/);
    expect(logged().slice(before)).toMatchObject([{ ok: false, leg: 'source', mode: 'fit', reason: r.reason }]);
    expect(fs.existsSync(path.join(dir, 'out-copied'))).toBe(false);
  });

  it('a skeleton that differs from the registered tables stops the read before any outcome', { timeout: 60_000 }, () => {
    const r = go('fit', 'out-skel', { registration: 'audits/reg-skel.md' });
    expect(r.verdict).toBe('REFUSED');
    expect(r.reason).toMatch(/skeleton.*Table 2c row fit column 2/);
    expect(lines).toContain('guard: ok');
    expect(lines.some((l) => l.startsWith('outcomes'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'out-skel', 'regime-diag-fit.json'))).toBe(false);
    expect(logged().at(-1)).toMatchObject({ ok: false, leg: 'skeleton', mode: 'fit' });
  });

  let fitFile = '';
  it('fit: guard, skeleton, floors, then the outcomes — every answer gets a state', { timeout: 120_000 }, () => {
    const t0 = Date.now();
    const r = go('fit', 'out-fit');
    expect(r.reason).toBe('ok');
    expect(r.verdict).toBe('PASS');
    expect(r.line).toMatch(new RegExp(`^REGIME_DIAG_FIT=${five(FIT_STATE)}$`));
    fitFile = r.file as string;
    expect(fitFile).toBe(path.join(dir, 'out-fit', 'regime-diag-fit.json'));
    // the order of the read
    const at = (p: string): number => lines.findIndex((l) => l.startsWith(p));
    expect(at('guard: ok')).toBeGreaterThanOrEqual(0);
    expect(at('skeleton: equal')).toBeGreaterThan(at('guard: ok'));
    expect(at('floors: fit')).toBeGreaterThan(at('skeleton: equal'));
    expect(at('outcomes: fit')).toBeGreaterThan(at('floors: fit'));
    expect(lines.some((l) => l.startsWith('outcomes: holdout'))).toBe(false);
    expect(fs.existsSync(guard.sealFile(home))).toBe(false);
    const j = json(fitFile);
    expect([j.kind, j.study, j.line, j.floor_clusters]).toEqual(['fit', 'injected', r.line, 25]);
    expect(Date.parse(j.clocks.outcome_read_at)).toBeGreaterThanOrEqual(Date.parse(j.clocks.registration_landed_at.first_seen));
    expect(j.registration.commit).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(j.positions).toEqual([0, 1]);
    // A2 has too few effective clusters in this study: named, and not computed
    expect([j.primaries.A2.state, j.primaries.A2.reading]).toEqual(['too_little_data', null]);
    expect(j.primaries.A2.cause).toMatch(/fewer than 25 effective clusters/);
    expect(j.primaries.A2.pre.eff).toBeLessThan(25);
    // A1 and A4 are computed, with a bootstrap and a shuffle of the injected sizes
    for (const a of ['A1', 'A4']) {
      expect(j.primaries[a].reading.B, a).toBe(200);
      expect(j.primaries[a].reading.shuffle.n, a).toBe(100);
      expect(j.primaries[a].reading.reps, a).toBeUndefined();
      expect(j.primaries[a].pre.eff, a).toBeGreaterThanOrEqual(25);
    }
    expect(j.primaries.A5.reading.runs).toBeGreaterThan(0);
    expect(j.primaries.A3.cells).toHaveLength(36);
    expect(j.primaries.A3.family).toHaveLength(36);
    expect(j.secondary).toHaveLength(14);
    expect(j.secondary.map((s: { id: string }) => s.id)).toEqual(['M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'M07', 'M08', 'M09', 'M10', 'M11', 'M12', 'A1.all', 'A2.all']);
    for (const s of j.secondary) { expect(s.state, s.id).toMatch(new RegExp(`^${FIT_STATE}$`)); expect(typeof s.read_under, s.id).toBe('string'); }
    expect(Object.keys(j.variants)).toEqual(['day', 'week', 'unit']);
    for (const v of Object.values(j.variants) as Array<{ states: string[] }>) expect(v.states).toHaveLength(5);
    expect(Object.keys(j.keys)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5']);
    expect(j.keys.A4.ceiling.state).toBe('by_construction');
    expect(j.keys.A1.ladder.diagnosis).toMatch(/^(NO_ROOM|INPUTS|LAG|NO_DEFECT|TOO_LITTLE_DATA|INCONSISTENT)$/);
    expect(j.floors.filter((x: { window: string }) => x.window === 'fit')).toHaveLength(8);
    expect(Object.keys(j.descriptives)).toEqual(expect.arrayContaining(['lag', 'flip_flops', 'a4_mono', 'runs', 'delta1_by_tf_hold', 'key_b_leads', 'a2_by_tf', 'unshufflable', 'null_odds']));
    expect(j.descriptives.lag).toHaveLength(3);
    expect(j.fit_points.A2).toBeNull();
    expect(typeof j.fit_points.A1).toBe('number');
    // a key reading below the cluster floor is named, and not computed either
    expect([j.keys.A2.no_lag.state, j.keys.A2.no_lag.reading]).toEqual(['too_little_data', null]);
    expect(j.keys.A2.no_lag.cause).toMatch(/fewer than 25 effective clusters/);
    expect(j.keys.A2.no_lag.eff).toBeLessThan(25);
    expect(j.keys.A1.no_lag.eff).toBeGreaterThanOrEqual(25);
    expect(j.keys.A1.no_lag.reading.shuffle.n).toBe(100);
    // and so is a descriptive slice
    for (const lead of ['7', '28']) {
      expect(j.descriptives.key_b_leads[lead].A2, lead).toMatchObject({ state: 'too little data', point: null });
      expect(j.descriptives.key_b_leads[lead].A2.eff, lead).toBeLessThan(25);
      expect(j.descriptives.key_b_leads[lead].A1.state, lead).toBe('reported');
      expect(typeof j.descriptives.key_b_leads[lead].A1.point, lead).toBe('number');
    }
    expect(j.descriptives.delta1_by_tf_hold.map((x: { tf: string }) => x.tf)).toEqual(['4h', '1h', '1d']);
    for (const x of j.descriptives.delta1_by_tf_hold) expect([x.state, x.by_hold], x.tf).toEqual(['too little data', null]); // no entry has a 1d row in this window
    // the underpowered report: only where the half-width is above the floor; the fit window needs the coin-days it lacks
    const under = j.primaries.A1.underpowered;
    expect(j.primaries.A1.state).toBe('too_little_data');
    expect(under.label).toBe('too little data — underpowered');
    expect(under.half_width).toBeCloseTo((j.primaries.A1.reading.ub[0] - j.primaries.A1.reading.lb[0]) / 2, 9);
    expect(under.multiple).toBeGreaterThan(1);
    expect(under.multiple).toBeCloseTo((under.half_width / 3) ** 2, 9);
    expect(under.coin_days_needed).toBeCloseTo((under.multiple - 1) * under.coin_days_in_window, 6);
    expect(under.month).toMatch(/^20\d\d-\d\d$/);
    // the guard log carries the read's clock and its result
    const log = logged();
    expect(log.some((l) => l.leg === 'outcomes' && l.mode === 'fit' && l.outcome_read_at === j.clocks.outcome_read_at)).toBe(true);
    expect(log.at(-1)).toMatchObject({ leg: 'result', mode: 'fit', line: r.line });
    expect(Date.now() - t0).toBeLessThan(45_000);
  });

  it('fit: the same registration, store and seeds give the same result', { timeout: 120_000 }, () => {
    const again = go('fit', 'out-fit-2');
    expect(again.verdict).toBe('PASS');
    const strip = (file: string): unknown => { const j = json(file); delete j.clocks; return j; };
    expect(strip(again.file as string)).toEqual(strip(fitFile));
  });

  it('hold-out: a fit result that is absent, or from another study, is refused before the seal is claimed', { timeout: 60_000 }, () => {
    const none = go('holdout', 'out-hold', { fitResult: path.join(dir, 'absent.json') });
    expect([none.verdict, none.reason]).toEqual(['REFUSED', expect.stringMatching(/fit result/)]);
    const foreign = path.join(dir, 'fit-foreign.json');
    fs.writeFileSync(foreign, JSON.stringify({ ...json(fitFile), study: 'registered' }));
    const other = go('holdout', 'out-hold', { fitResult: foreign });
    expect([other.verdict, other.reason]).toEqual(['REFUSED', expect.stringMatching(/fit result.*study/)]);
    const missing = go('holdout', 'out-hold');
    expect([missing.verdict, missing.reason]).toEqual(['REFUSED', expect.stringMatching(/fit result/)]);
    expect(missing.reason).not.toBe(other.reason);
    expect(logged().at(-1)).toMatchObject({ ok: false, leg: 'fit-result', mode: 'holdout', reason: missing.reason });
    expect(fs.existsSync(guard.sealFile(home))).toBe(false);
    expect(lines.some((l) => l.startsWith('outcomes'))).toBe(false);
  });

  let holdFile = '';
  it('hold-out: read once, behind the seal', { timeout: 120_000 }, () => {
    const t0 = Date.now();
    const r = go('holdout', 'out-hold', { fitResult: fitFile });
    expect(r.reason).toBe('ok');
    expect(r.verdict).toBe('PASS');
    expect(r.line).toMatch(new RegExp(`^REGIME_DIAG_VERDICT=${five(HOLD_STATE)}$`));
    holdFile = r.file as string;
    const at = (p: string): number => lines.findIndex((l) => l.startsWith(p));
    expect(at('floors: holdout')).toBeGreaterThan(at('skeleton: equal'));
    expect(at('seal: claimed')).toBeGreaterThan(at('floors: holdout'));
    expect(at('outcomes: holdout')).toBeGreaterThan(at('seal: claimed'));
    expect(lines.some((l) => l.startsWith('outcomes: fit'))).toBe(false);
    const j = json(holdFile), fit = json(fitFile);
    const seal = json(guard.sealFile(home));
    // the seal is in its home and nowhere in the store
    expect(fs.readdirSync(home)).toEqual(['holdout.seal']);
    expect(fs.existsSync(path.join(store, 'holdout.seal'))).toBe(false);
    expect(seal).toMatchObject({ wave: 'EDGE-REGIME-DIAG-W1', registration_commit: fit.registration.commit, fit_result_sha256: sha256(fs.readFileSync(fitFile)) });
    expect(Date.parse(j.clocks.outcome_read_at)).toBeGreaterThanOrEqual(Date.parse(seal.claimed_at));
    expect([j.kind, j.study, j.line]).toEqual(['holdout', 'injected', r.line]);
    // A2 has no fit estimate: its hold-out is computed and cannot be confirmed
    expect(j.primaries.A2.fit_point).toBeNull();
    expect(j.primaries.A2.state).toBe('NOT_CONFIRMED');
    for (const a of ['A1', 'A2', 'A4']) {
      expect(j.primaries[a].reading.alpha, a).toBe(0.025);
      expect(j.primaries[a].reading.shuffle.n, a).toBe(100);
    }
    // the underpowered report: absent where the half-width is already at or below the floor; the hold-out cannot be
    // extended, so a successor needs the whole multiple on new months
    const half = (a: string): number => (j.primaries[a].reading.ub[0] - j.primaries[a].reading.lb[0]) / 2;
    expect(half('A2')).toBeLessThanOrEqual(3);
    expect(j.primaries.A2.underpowered).toBeNull();
    expect(half('A1')).toBeGreaterThan(3);
    const under = j.primaries.A1.underpowered;
    expect([j.primaries.A1.state, under.label]).toEqual(['NOT_CONFIRMED', 'too little data — underpowered']);
    expect(under.coin_days_needed).toBeCloseTo(under.multiple * under.coin_days_in_window, 6);
    for (const x of j.descriptives.delta1_by_tf_hold) {
      expect(x.state === 'reported', x.tf).toBe(x.eff >= 25);
      if (x.state === 'reported') { expect(x.by_hold, x.tf).toHaveLength(5); for (const v of x.by_hold) expect(typeof v, x.tf).toBe('number'); } else expect(x.by_hold, x.tf).toBeNull();
    }
    expect(typeof j.primaries.A1.shrinkage).toBe('number');
    expect(j.primaries.A1.shrinkage).toBeCloseTo(j.primaries.A1.reading.point[0] - fit.fit_points.A1, 9);
    expect(Object.keys(j.variants)).toEqual(['day', 'week', 'unit', 'panel13']);
    // A3 reads the fit-selected cell alone, or is not identifiable without one
    if (fit.primaries.A3.selected === null) expect([j.primaries.A3.state, j.primaries.A3.reading]).toEqual(['NOT_IDENTIFIABLE', null]);
    else expect(j.primaries.A3.cell).toBe(fit.primaries.A3.selected);
    expect(j.floors.filter((x: { window: string }) => x.window === 'hold-out')).toHaveLength(8);
    expect(logged().at(-1)).toMatchObject({ leg: 'result', mode: 'holdout', line: r.line });
    expect(Date.now() - t0).toBeLessThan(45_000);
  });

  it('AC2.3 a second hold-out read is refused: the seal exists', { timeout: 60_000 }, () => {
    const before = fs.readFileSync(holdFile, 'utf8'), seal = fs.readFileSync(guard.sealFile(home), 'utf8');
    const r = go('holdout', 'out-hold-2', { fitResult: fitFile });
    expect(r.verdict).toBe('REFUSED');
    expect(r.reason).toMatch(/^guard \(seal\): the hold-out seal exists/);
    expect(lines.some((l) => l.startsWith('outcomes'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'out-hold-2'))).toBe(false);
    expect([fs.readFileSync(holdFile, 'utf8'), fs.readFileSync(guard.sealFile(home), 'utf8')]).toEqual([before, seal]);
    expect(guard.checkDiagGuard(inp('audits/reg-good.md', 'holdout')).leg).toBe('seal');
    // the fit window can still be read: the seal guards the hold-out alone
    expect(guard.checkDiagGuard(inp('audits/reg-good.md', 'fit')).ok).toBe(true);
    expect(logged().filter((l) => l.leg === 'seal').map((l) => l.ok)).toEqual([true, false, false]);
  });

  it('AC2.3 the seal has one place: a second store directory that reproduces both pinned manifests does not re-open the hold-out', { timeout: 120_000 }, () => {
    const store2 = path.join(dir, 'store-2');
    const made = guard.initStore(store2, archives, parseCensus(SYNTH_CENSUS_TEXT).panel);
    const first = guard.checkDiagGuard(inp('audits/reg-good.md', 'fit'));
    // the second store reproduces both pinned manifests: only the seal stands between it and a second read
    expect([made.archivesSha256, made.guardStoreSha256]).toEqual([first.pins[guard.ARCHIVES_PIN], first.pins[storePin(VENUE)]]);
    expect(guard.checkDiagGuard({ ...inp('audits/reg-good.md', 'fit'), store: store2 }).ok).toBe(true);
    expect(fs.existsSync(path.join(store2, 'holdout.seal'))).toBe(false);
    const held = fs.readFileSync(holdFile, 'utf8'), seal = fs.readFileSync(guard.sealFile(home), 'utf8');
    const r = go('holdout', 'out-hold-3', { fitResult: fitFile, store: store2 });
    expect(r.verdict).toBe('REFUSED');
    expect(r.reason).toMatch(/^guard \(seal\): the hold-out seal exists/);
    expect(lines.some((l) => l.startsWith('outcomes'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'out-hold-3'))).toBe(false);
    expect(fs.existsSync(path.join(store2, 'holdout.seal'))).toBe(false);
    expect([fs.readFileSync(holdFile, 'utf8'), fs.readFileSync(guard.sealFile(home), 'utf8')]).toEqual([held, seal]);
    expect(guard.checkDiagGuard({ ...inp('audits/reg-good.md', 'holdout'), store: store2 }).leg).toBe('seal');
    // the refusal is logged in the store the run named, and no outcome was read from it
    const log2 = fs.readFileSync(guard.guardLog(store2), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(log2.at(-1)).toMatchObject({ ok: false, leg: 'seal', mode: 'holdout' });
    expect(log2.some((l) => l.leg === 'outcomes')).toBe(false);
  });

  it('the registered study\'s seal home is one fixed directory: no store, and no HOME, moves it', { timeout: 60_000 }, () => {
    const fixed = path.join(os.userInfo().homedir, '.cache', 'algovault', 'regime-diag', 'store');
    expect(guard.sealHome()).toBe(fixed);
    expect(path.isAbsolute(fixed)).toBe(true);
    expect(guard.sealHome.length).toBe(0); // it takes no argument: a run has nothing to pass it
    const keep = process.env.HOME;
    process.env.HOME = path.join(dir, 'another-home');
    try { expect(guard.sealHome()).toBe(fixed); } finally { if (keep === undefined) delete process.env.HOME; else process.env.HOME = keep; }
    expect(guard.sealFile(guard.sealHome())).toBe(path.join(fixed, 'holdout.seal'));
    // the sandbox's seal is not there: the synthetic study names its own home
    expect(within(home, dir)).toBe(true);
    expect(within(guard.sealHome(), dir)).toBe(false);
  });

  it('a synthetic study that names no seal home is refused before the guard: it can never reach the registered study\'s seal', { timeout: 60_000 }, () => {
    const before = logged().length;
    for (const mode of ['fit', 'holdout'] as const) {
      const r = go(mode, 'out-no-home', { fitResult: fitFile, study: { ...study(), sealHome: undefined } });
      expect([r.verdict, r.reason, r.line, r.file]).toEqual(['REFUSED', 'a synthetic study must name its own seal home', null, null]);
    }
    expect(logged().slice(before)).toMatchObject([{ ok: false, leg: 'seal-home', mode: 'fit' }, { ok: false, leg: 'seal-home', mode: 'holdout' }]);
    expect(lines).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'out-no-home'))).toBe(false);
  });

  const cli =(...args: string[]): Promise<{ code: number; stdout: string }> =>
    promisify(execFile)(path.join(REPO, 'node_modules/.bin/tsx'), [path.join(REPO, 'src/scripts/regime-diag/run.ts'), ...args], { cwd: REPO, timeout: 80_000 })
      .then((x) => ({ code: 0, stdout: x.stdout }), (e: { code: number; stdout: string }) => ({ code: e.code, stdout: e.stdout }));

  it('the CLI names a usage error INDETERMINATE and exits 3', { timeout: 90_000 }, async () => {
    const r = await cli('--fit');
    expect(r.code).toBe(3);
    expect(r.stdout).toMatch(/^REGIME_DIAG_RUN_VERDICT=INDETERMINATE — usage/m);
    expect(r.stdout).not.toMatch(/REGIME_DIAG_RUN_VERDICT=PASS/);
  });

  it('the CLI refuses a store inside the repository: REFUSED, exit 1, nothing written', { timeout: 90_000 }, async () => {
    const inside = path.join(REPO, 'tests/fixtures/regime-diag/no-such-store');
    const r = await cli('--init-store', '--census', censusFile, '--cache', archives.cache, '--overlay', archives.overlay, '--store', inside);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^REGIME_DIAG_RUN_VERDICT=REFUSED — the store must sit outside the repository$/m);
    expect(r.stdout).not.toMatch(/REGIME_DIAG_RUN_VERDICT=PASS/);
    expect(fs.existsSync(inside)).toBe(false);
  });

  it('the CLI never passes a skeleton it could not build: empty archive stores are INDETERMINATE, exit 3', { timeout: 90_000 }, async () => {
    const empty = { cache: path.join(dir, 'empty-cache'), overlay: path.join(dir, 'empty-overlay') };
    for (const d of Object.values(empty)) fs.mkdirSync(d, { recursive: true });
    const r = await cli('--skeleton', '--census', censusFile, '--cache', empty.cache, '--overlay', empty.overlay);
    expect(r.code).toBe(3);
    expect(r.stdout).toMatch(/^REGIME_DIAG_RUN_VERDICT=INDETERMINATE — skeleton: the study holds no entry$/m);
    expect(r.stdout).not.toMatch(/REGIME_DIAG_RUN_VERDICT=(PASS|REFUSED)/);
  });
});

describe('regime-diag: what was registered is what is run', () => {
  const found = (): string[] => fs.readdirSync(path.join(REPO, 'audits')).filter((f) => /^regime-diagnostic-preregistration-\d{4}-\d{2}-\d{2}\.md$/.test(f));
  const bytes = (): Buffer => fs.readFileSync(path.join(REPO, REGISTRATION));
  /** The registration as it landed (commit 3935d83c): its length in bytes and its sha256. */
  const LANDED = { bytes: 80_855, sha256: '4cec7d3088b4c4e95793453140e9bad0c16978862b8a9f0807d97a1bd2688325' };

  it('there is exactly one registration, and it is the one the harness names', () => {
    expect(found().map((f) => `audits/${f}`)).toEqual([REGISTRATION]);
  });

  it('the landed body is never edited: its bytes open the file, and everything after them is appended', () => {
    const b = bytes();
    expect(b.length).toBeGreaterThan(LANDED.bytes);
    expect(sha256(b.subarray(0, LANDED.bytes))).toBe(LANDED.sha256);
    expect(b.subarray(LANDED.bytes).toString('utf8')).toMatch(/^\n## Amendment \d{4}-\d{2}-\d{2} — /);
  });

  it('it pins every harness file, the archive-store manifest, the guard\'s store manifest and the census', () => {
    const p = pinsOf(bytes().toString('utf8'));
    for (const rel of [...guard.HARNESS_FILES, guard.ARCHIVES_PIN, storePin(VENUE), guard.CENSUS_PIN]) expect(p.get(rel), rel).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the pinned harness files are the files in this checkout', () => {
    const p = pinsOf(bytes().toString('utf8'));
    for (const rel of guard.HARNESS_FILES) expect(p.get(rel), rel).toBe(sha256(fs.readFileSync(path.join(REPO, rel))));
  });

  it('the statistic registry it states is the registry the harness holds, id for id and count for count', () => {
    const appended = bytes().subarray(LANDED.bytes).toString('utf8');
    const stated = new Map<string, number[]>();
    for (const m of appended.matchAll(/^\|\s*`([A-Za-z0-9.@]+)`\s*\|\s*([\d,]+)\s*\|\s*([\d,]+)\s*\|\s*([\d,]+)\s*\|/gm)) stated.set(m[1], [m[2], m[3], m[4]].map((x) => Number(x.replace(/,/g, ''))));
    expect([...stated.entries()]).toEqual(STATISTICS.map((s) => [s.id, [s.boot, s.shuffle, s.perm]]));
  });
});

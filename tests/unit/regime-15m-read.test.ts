// tests/unit/regime-15m-read.test.ts — EDGE-REGIME-15M-BACKTEST-W1 CH1/CH2: the read, end to end, in a sandbox
// repository with a bare origin (tests/fixtures/regime-15m/sandbox.ts), and the differential against T3's harness
// (test a): T3's own `outcomeRun` reads the synthetic panel's fit, and the sibling's parity leg must reproduce its
// output byte for byte from a different construction of the same rows. Then the guard, leg by leg. Synthetic data
// only; every seal lives in the sandbox.
import { settle } from '../fixtures/regime-15m/isolate.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type ArchiveManifest } from '../../src/scripts/regime-diag/archive.js';
import { N_TF } from '../../src/scripts/regime-diag/frame.js';
import {
  archivesRefusal, checkRefusal, claimSeal, harnessRefusal, leverRefusal, memoryPlan, memoryRefusal, monthRefusal, outRefusal, pinsOf, pinsRefusal, rehearse, sealState, skeletonRefusal, targetRefusal, within,
} from '../../src/scripts/regime-15m/r15-guard.js';
import { parityOf, recomputeT3Labels, recomputeT3Outcomes, t3FiguresOf, type T3Figures } from '../../src/scripts/regime-15m/r15-parity.js';
import { readRun, type ReadInput, type ReadResult } from '../../src/scripts/regime-15m/r15-run.js';
import {
  ARCHIVES_PIN, CENSUS_PIN, CHECK_MANIFEST, CHECK_PIN, LOG_FILE, OUT_FILES, PRE_FILE, RERUN_SEAL_FILE, RESULT_FILE, RESULT_SHA_FILE, SEAL_DIR, SEAL_FILE, T3_FIT_PIN, T3_REGISTRATION, TF_KEYS,
} from '../../src/scripts/regime-15m/r15-spec.js';
import { tfMeasures } from '../../src/scripts/regime-15m/r15-stats.js';
import { checkDirOf, homeOf, type CheckManifest } from '../../src/scripts/regime-15m/r15-venues.js';
import { CHECK_PLAN, REGISTRATION_PATH, git, makeSandbox, pinTable, type Sandbox } from '../fixtures/regime-15m/sandbox.js';
import { W_CENSUS, world } from '../fixtures/regime-15m/world.js';

afterEach(() => new Promise<void>((done) => { setImmediate(done); }));
const sha = (s: string | Buffer): string => crypto.createHash('sha256').update(s).digest('hex');
const B = 100, F = 5;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readJson = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8'));
/** T3's figures recomputed whole: the label-only leg and the path-label leg together, as the differential compares them. */
const recomputeT3 = (f: Parameters<typeof recomputeT3Labels>[0], F_: number, B_: number): T3Figures => ({ ...recomputeT3Labels(f, B_), ...recomputeT3Outcomes(f, F_, B_) });

describe('regime-15m: the read in a sandbox repository', () => {
  let sb: Sandbox;
  const lines: string[] = [];
  let unlanded: ReadResult, first: ReadResult, second: ReadResult, unlandedOut = '', firstOut = '', secondOut = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any;
  const inp = (out: string, more: Partial<ReadInput> = {}): ReadInput => ({
    repo: sb.repo, censusFile: sb.censusFile, archives: sb.archives, archiveManifest: sb.archiveManifest, t3Fit: sb.t3Fit, out, home: sb.home, log: (l) => lines.push(l), ...more,
  });

  beforeAll(async () => {
    await settle();
    sb = makeSandbox({ B, F });
    unlandedOut = sb.out('unlanded');
    unlanded = readRun(inp(unlandedOut), sb.seam);
    sb.push();
    await settle();
    firstOut = sb.out('first');
    first = readRun(inp(firstOut), sb.seam);
    secondOut = sb.out('second');
    second = readRun(inp(secondOut), sb.seam);
    result = readJson(path.join(firstOut, RESULT_FILE));
  }, 900_000);
  afterAll(() => { if (sb) fs.rmSync(sb.dir, { recursive: true, force: true }); });

  it('refuses a registration that has not landed: no outcome read, nothing sealed, no output', () => {
    expect(unlanded.verdict).toBe('REFUSED');
    expect(unlanded.reason).toMatch(/^source: HEAD is not on origin\/main/);
    expect([unlanded.line, unlanded.file]).toEqual([null, null]);
    for (const f of OUT_FILES) expect(fs.existsSync(path.join(unlandedOut, f)), f).toBe(false);
    // the first read after the landing is the first: the refusal claimed no seal
    expect(result.read).toBe('first');
  });

  it('reads once: the outputs record the registration commit, which landed before every output', () => {
    expect([first.verdict, first.reason]).toEqual(['PASS', '']);
    expect(first.line).toMatch(/^REGIME_15M_BACKTEST=(PASS|FAIL|FAIL \(underpowered\)|INDETERMINATE \([a-z_, ]+\))$/);
    const commit = git(sb.repo, 'log', '--diff-filter=A', '--format=%H', 'origin/main', '--', REGISTRATION_PATH);
    expect(result.registration).toMatchObject({ path: REGISTRATION_PATH, commit, origin_main: git(sb.repo, 'rev-parse', 'origin/main') });
    const text = fs.readFileSync(path.join(firstOut, RESULT_FILE), 'utf8');
    expect(fs.readFileSync(path.join(firstOut, RESULT_SHA_FILE), 'utf8')).toBe(`${sha(text)}  ${RESULT_FILE}\nregistration_commit: ${commit}\n`);
    const pre = readJson(path.join(firstOut, PRE_FILE));
    expect([pre.registration.commit, pre.kind, sha(fs.readFileSync(path.join(firstOut, PRE_FILE)))]).toEqual([commit, 'pre-outcome', result.pre_sha256]);
    const landed = Date.parse(git(sb.repo, 'show', '-s', '--format=%cI', commit));
    for (const f of [...OUT_FILES, LOG_FILE]) expect(fs.statSync(path.join(firstOut, f)).mtimeMs, f).toBeGreaterThanOrEqual(landed);
    expect(result.verdict.line).toBe(first.line);
    expect([result.study, result.F, result.B, result.timeframes]).toEqual(['injected', F, B, TF_KEYS]);
  });

  it('runs its legs in the registered order, each logged before the next, the seal after the floors are on disk', () => {
    const log = fs.readFileSync(path.join(firstOut, LOG_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { leg: string; ok: boolean });
    expect(log.filter((l) => l.leg !== 'rehearsal').map((l) => [l.leg, l.ok])).toEqual(
      ['registration', 'pins', 'inputs', 'skeleton', 'parity-labels', 'memory', 'pre', 'seal', 'main', 'result'].map((leg) => [leg, true]));
    expect(log.filter((l) => l.leg === 'rehearsal')).toHaveLength(2);
  });

  it('every measure for all four timeframes, and every check row holds a value, NO_HISTORY or not listed', () => {
    expect(result.main.measures.tfs.map((t: { tf: string }) => t.tf)).toEqual(['15m', '1h', '4h', '1d']);
    for (const t of result.main.measures.tfs) expect(Object.keys(t)).toEqual(['tf', 'a4', 'd1', 'flip_flops', 'lag', 'runs']);
    expect(result.criteria.map((c: { id: string }) => c.id)).toEqual(['A4', 'D1', 'FF']);
    const want = { value: 'value', bars: 'value', no_bars_in_window: 'NO_HISTORY', not_listed: 'not listed' } as const;
    for (const v of result.check.venues as Array<{ venue: 'BYBIT' | 'OKX' | 'BITGET'; coins: Array<{ coverage: string }>; errors: string[]; twin: unknown; venue_run: unknown; no_binance_test: unknown }>) {
      // a coin Binance does not have reads `no Binance test` (PROCEDURE §4e); the others read as the venue answered
      expect(v.coins.map((c) => c.coverage), v.venue).toEqual(CHECK_PLAN[v.venue].map((s, i) => (s === 'bars' && i === 2 ? 'no Binance test' : want[s])));
      expect(v.errors, v.venue).toEqual([]);
      expect(v.venue_run, v.venue).not.toBeNull();
    }
    const [bybit, okx, bitget] = result.check.venues;
    // the twin at 1 m on the same coins is the main read itself; at 3 m it is its own run, like for like
    expect([bybit.twin, typeof okx.twin, typeof bitget.twin]).toEqual(['main read', 'object', 'object']);
    expect([bybit.no_binance_test, okx.no_binance_test, bitget.no_binance_test === null]).toEqual([null, null, false]);
    expect([okx.resolution_min, okx.twin.coins, okx.venue_run.coins]).toEqual([3, 1, 1]);
  });

  it('the differential (test a): T3\'s harness output on the synthetic panel is reproduced byte for byte', { timeout: 120_000 }, () => {
    // inside the read: T3's outcomeRun (a 130-day grid of the walk) against the sibling (a 120-day grid from archives)
    expect(result.parity.ok).toBe(true);
    expect(result.parity.misses).toEqual([]);
    expect(result.parity.compared).toBeGreaterThan(60);
    expect(result.verdict.causes).not.toContain('parity');
    // a third construction of the same rows: the world's grids, built directly on the 120-day span
    const w = world();
    const p = parityOf(t3FiguresOf(sb.t3Result), recomputeT3(w.f, F, B));
    expect([p.ok, p.misses, p.compared]).toEqual([true, [], result.parity.compared]);
    // the per-timeframe Δ1 by hold of the sibling's views, on map row 12's rows, is T3's table
    const keep3 = new Uint8Array(w.f.nE).map((_, e) => (w.f.has[e * N_TF] && w.f.has[e * N_TF + 1] && w.f.has[e * N_TF + 2] ? 1 : 0));
    const t3 = (sb.t3Result.descriptives as { delta1_by_tf_hold: Array<{ tf: string; eff: number; by_hold: number[] }> }).delta1_by_tf_hold;
    for (const tf of ['1h', '4h', '1d'] as const) {
      const mine = tfMeasures(w.f, w.r15, keep3, { key: tf, min: 0, n: 0 }, { B: 0, alpha: 0.025, seeds: new Map([[`A4.${tf}`, 1], [`D1.${tf}`, 2]]), run: 'x' });
      const want = t3.find((x) => x.tf === tf) as { eff: number; by_hold: number[] };
      expect(JSON.stringify([mine.d1.by_hold, mine.d1.eff]), tf).toBe(JSON.stringify([want.by_hold, want.eff]));
    }
  });

  it('opens only the window\'s months, each byte checked', () => {
    expect(result.archive_months_opened).toEqual(['2021-01', '2021-02', '2021-03', '2021-04']);
    expect(monthRefusal('2021-05', { first: '2021-01', last: '2021-04' })).toMatch(/outside/);
    expect(monthRefusal('2026-01', { first: '2024-01', last: '2025-12' })).toMatch(/outside 2024-01 … 2025-12/);
    expect(monthRefusal('2025-12', { first: '2024-01', last: '2025-12' })).toBeNull();
  });

  it('the seal: a second read is refused before any frame is built, and the seal records the commit and the floors', () => {
    expect(second.verdict).toBe('REFUSED');
    expect(second.reason).toMatch(/^seal: the seal exists: the read is spent/);
    expect(fs.readdirSync(secondOut)).toEqual([LOG_FILE]);
    const seal = readJson(path.join(sb.home, SEAL_DIR, SEAL_FILE));
    expect([seal.registration_commit, seal.pre_sha256, seal.wave]).toEqual([result.registration.commit, result.pre_sha256, 'EDGE-REGIME-15M-BACKTEST-W1']);
    expect(fs.existsSync(path.join(sb.home, SEAL_DIR, RERUN_SEAL_FILE))).toBe(false);
  });

  it('refuses an output directory inside the repository, under ~/.cache/algovault, or holding files, writing nothing', () => {
    const inRepo = path.join(sb.repo, 'out-here');
    expect(readRun(inp(inRepo), sb.seam).reason).toMatch(/^out: the output directory lies inside/);
    expect(fs.existsSync(inRepo)).toBe(false);
    const inCache = path.join(os.userInfo().homedir, '.cache', 'algovault', 'elsewhere');
    expect(readRun(inp(inCache), sb.seam).reason).toMatch(/^out: the output directory lies inside/);
    const full = sb.out('full');
    fs.mkdirSync(full);
    fs.writeFileSync(path.join(full, 'x.json'), '{}');
    expect(readRun(inp(full), sb.seam).reason).toMatch(/^out: the output directory holds files/);
    expect(fs.readdirSync(full)).toEqual(['x.json']);
  });

  it('a seam never reads the study\'s own home, and a clock before the landing refuses', () => {
    expect(readRun(inp(sb.out('seam-home'), { home: homeOf() }), sb.seam).reason).toMatch(/^(out|seam): /);
    expect(readRun(inp(sb.out('clock'), { now: () => 0 }), sb.seam).reason).toMatch(/^clock: /);
  });

  it('pins: every pinned file is its pin, the directory holds only the pinned siblings, the inputs are the pinned ones; a later row re-pins', () => {
    const text = pinTable(sb.pins), inputs = { [CENSUS_PIN]: sb.pins[CENSUS_PIN], [ARCHIVES_PIN]: sb.pins[ARCHIVES_PIN], [T3_FIT_PIN]: sb.pins[T3_FIT_PIN], [CHECK_PIN]: sb.pins[CHECK_PIN] };
    expect(pinsRefusal(sb.repo, text, inputs)).toBeNull();
    const rel = 'src/scripts/regime-15m/r15-decide.ts';
    const wrong = text.replace(sb.pins[rel], 'a'.repeat(64));
    expect(pinsRefusal(sb.repo, wrong, inputs)).toMatch(/r15-decide\.ts is not the registered file/);
    // an amendment's re-pin, later in the file, wins
    expect(pinsRefusal(sb.repo, `${wrong}\n| \`${rel}\` | \`${sb.pins[rel]}\` | re-pin |\n`, inputs)).toBeNull();
    expect(pinsOf(`| \`a\` | \`${'1'.repeat(64)}\` |\n| \`a\` | \`${'2'.repeat(64)}\` |`).get('a')).toBe('2'.repeat(64));
    expect(pinsRefusal(sb.repo, text.split('\n').filter((l) => !l.includes(T3_REGISTRATION)).join('\n'), inputs)).toMatch(/does not pin audits\/regime-diagnostic/);
    expect(pinsRefusal(sb.repo, text, { ...inputs, [CHECK_PIN]: 'b'.repeat(64) })).toMatch(/check:check-manifest\.json is not the registered input/);
    const extra = path.join(sb.repo, 'src/scripts/regime-15m/r15-extra.ts');
    fs.writeFileSync(extra, '');
    try { expect(pinsRefusal(sb.repo, text, inputs)).toMatch(/every file there is a pinned sibling file/); } finally { fs.rmSync(extra); }
  });

  it('T3\'s harness, unchanged against origin/main', () => {
    expect(harnessRefusal(sb.repo)).toBeNull();
    const f = path.join(sb.repo, 'src/scripts/regime-diag/stats.ts'), keep = fs.readFileSync(f);
    fs.appendFileSync(f, '\n// changed\n');
    try { expect(harnessRefusal(sb.repo)).toMatch(/import-only/); } finally { fs.writeFileSync(f, keep); }
    expect(harnessRefusal(sb.repo)).toBeNull();
  });

  it('the skeleton: the fit frame against T3\'s registered fit tables, a hold-out row never compared', () => {
    const w = world(), reg = fs.readFileSync(path.join(sb.repo, T3_REGISTRATION), 'utf8');
    expect(skeletonRefusal(w.f0, reg)).toBeNull();
    const rows = reg.split('\n');
    const at = (key: string): number => rows.findIndex((l) => l.startsWith(`| ${key} |`));
    const bump = (i: number): string => rows.map((l, k) => (k === i ? l.replace(/\| (\d+) \|$/, (_, n: string) => `| ${Number(n) + 1} |`) : l)).join('\n');
    expect(skeletonRefusal(w.f0, bump(at('fit')))).toMatch(/^skeleton: 1 cells differ/);
    expect(skeletonRefusal(w.f0, bump(at('hold-out')))).toBeNull();
  });

  it('the archives: every file of the window\'s months is in the manifest, from the same store, with its bytes', () => {
    const manifest = readJson(sb.archiveManifest) as ArchiveManifest, months = { first: '2021-01', last: '2021-04' };
    expect(archivesRefusal(sb.archives, manifest, W_CENSUS.panel, months)).toBeNull();
    const extra = path.join(sb.archives.cache, 'SYNCUSDT-1m-2021-02.zip');
    fs.writeFileSync(extra, 'x');
    try { expect(archivesRefusal(sb.archives, manifest, W_CENSUS.panel, months)).toMatch(/SYNCUSDT-1m-2021-02\.zip is on disk and not in the archive manifest/); } finally { fs.rmSync(extra); }
    const changed = { ...manifest, files: manifest.files.map((f, i) => (i === 0 ? { ...f, sha256: 'c'.repeat(64) } : f)) };
    expect(archivesRefusal(sb.archives, changed, W_CENSUS.panel, months)).toMatch(/is not the registered archive/);
    expect(archivesRefusal(sb.archives, { ...manifest, files: manifest.files.slice(1) }, W_CENSUS.panel, months)).toMatch(/on disk and not in the archive manifest/);
  });

  it('the check bars: fetched for this census and window, at the registered resolutions, every file its recorded bytes', () => {
    const dir = checkDirOf(sb.home), m = readJson(path.join(dir, CHECK_MANIFEST)) as CheckManifest;
    const window = { from: m.window.from, to: m.window.to };
    expect(checkRefusal(m, dir, W_CENSUS.panel, m.census_sha256, window)).toBeNull();
    expect(checkRefusal(m, dir, W_CENSUS.panel, 'd'.repeat(64), window)).toMatch(/another census/);
    expect(checkRefusal(m, dir, W_CENSUS.panel, m.census_sha256, { ...window, to: '2030-01-01T00:00:00.000Z' })).toMatch(/not the window/);
    const slow = { ...m, venues: m.venues.map((v) => (v.venue === 'BITGET' ? { ...v, seconds: 7_200.5 } : v)) };
    expect(checkRefusal(slow, dir, W_CENSUS.panel, m.census_sha256, window)).toMatch(/BITGET took 7200\.5 s to fetch, over the 2 h budget/);
    const edge = { ...m, venues: m.venues.map((v) => (v.venue === 'BITGET' ? { ...v, seconds: 7_200 } : v)) };
    expect(checkRefusal(edge, dir, W_CENSUS.panel, m.census_sha256, window)).toBeNull();
    const unknown = { ...m, venues: m.venues.map((v) => (v.venue === 'BYBIT' ? { ...v, seconds: Number.NaN } : v)) };
    expect(checkRefusal(unknown, dir, W_CENSUS.panel, m.census_sha256, window)).toMatch(/BYBIT took NaN s/);
    const coarse = { ...m, venues: m.venues.map((v) => (v.venue === 'OKX' ? { ...v, resolution_min: 5 } : v)) };
    expect(checkRefusal(coarse, dir, W_CENSUS.panel, m.census_sha256, window)).toMatch(/OKX was fetched at 5 m/);
    const escape = { ...m, venues: m.venues.map((v) => (v.venue === 'OKX' ? { ...v, coins: v.coins.map((c) => (c.status === 'bars' ? { ...c, file: 'OKX/../BYBIT/x.csv' } : c)) } : v)) };
    expect(checkRefusal(escape, dir, W_CENSUS.panel, m.census_sha256, window)).toMatch(/no file of the venue's own directory/);
    const f = path.join(dir, m.venues[1].coins[0].file as string), keep = fs.readFileSync(f);
    fs.appendFileSync(f, '0');
    try { expect(checkRefusal(m, dir, W_CENSUS.panel, m.census_sha256, window)).toMatch(/OKX P1: the stored file is not the one the check manifest records/); } finally { fs.writeFileSync(f, keep); }
  });
});

describe('regime-15m: the guard\'s own pieces', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-15m-guard-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('the test-only levers refuse a read: this study\'s and T3\'s', () => {
    expect(leverRefusal('', '')).toBeNull();
    expect(leverRefusal('swap', '')).toMatch(/REGIME_15M_MUTATE=swap is set \(one of the registered mutation proofs\)/);
    expect(leverRefusal('bogus', '')).toMatch(/REGIME_15M_MUTATE=bogus is set \(not a registered mutation proof\)/);
    expect(leverRefusal('', 'replay')).toMatch(/REGIME_DIAG_MUTATE=replay/);
  });

  it('one read, and one rerun only when the registration on origin/main authorizes it', () => {
    const home = path.join(tmp, 'seal-home'), auth = 'RERUN_AUTHORIZED: §8 deviation D1, the lead\'s ruling of the fix';
    expect(sealState(home, '')).toEqual({ mode: 'first', reason: null });
    expect(claimSeal(home, SEAL_FILE, { n: 1 })).toEqual({ claimed: true, reason: null });
    expect(claimSeal(home, SEAL_FILE, { n: 2 })).toMatchObject({ claimed: false, reason: expect.stringMatching(/exists/) });
    expect(sealState(home, '').reason).toMatch(/authorizes no rerun/);
    expect(sealState(home, 'RERUN_AUTHORIZED: too short').mode).toBeNull();
    expect(sealState(home, `text\n  ${auth}`).mode).toBeNull();
    expect(sealState(home, `text\n${auth}\n`)).toEqual({ mode: 'rerun', reason: null });
    expect(claimSeal(home, RERUN_SEAL_FILE, { n: 3 }).claimed).toBe(true);
    expect(sealState(home, `text\n${auth}\n`).reason).toMatch(/spent/);
    const odd = path.join(tmp, 'odd-home');
    expect(claimSeal(odd, RERUN_SEAL_FILE, {}).claimed).toBe(true);
    expect(sealState(odd, auth).reason).toMatch(/not one this read wrote/);
  });

  it('containment by identity: a symlinked alias of a root is inside it', () => {
    const root = path.join(tmp, 'root'), alias = path.join(tmp, 'alias');
    fs.mkdirSync(path.join(root, 'a'), { recursive: true });
    fs.symlinkSync(root, alias);
    expect([within(path.join(alias, 'a', 'new'), root), within(root, root), within(path.join(tmp, 'other'), root), within(tmp, root)]).toEqual([true, true, false, false]);
  });

  it('containment by identity: a case variant of a root is inside it wherever the volume folds case', () => {
    const root = path.join(tmp, 'CaseRoot'), variant = path.join(tmp, 'caseroot');
    fs.mkdirSync(path.join(root, 'a'), { recursive: true });
    const folds = fs.existsSync(variant);
    expect([within(path.join(variant, 'a', 'new'), root), within(variant, root), within(root, variant)]).toEqual([folds, folds, folds]);
    const repo = path.join(tmp, 'CaseRepo');
    fs.mkdirSync(repo);
    expect(outRefusal(path.join(tmp, 'caserepo', 'out'), repo) !== null).toBe(folds);
  });

  it('a run log already in the output directory that is a link, a directory or a second name refuses the directory', () => {
    const repo = path.join(tmp, 'log-repo'), out = path.join(tmp, 'log-out'), log = path.join(out, LOG_FILE), other = path.join(tmp, 'log-other.jsonl');
    fs.mkdirSync(repo);
    fs.mkdirSync(out);
    fs.writeFileSync(other, '');
    fs.symlinkSync(other, log);
    expect(outRefusal(out, repo)).toMatch(/run log: .*symbolic link/);
    fs.rmSync(log);
    fs.linkSync(other, log);
    expect(outRefusal(out, repo)).toMatch(/run log: .*2 names/);
    fs.rmSync(log);
    fs.mkdirSync(log);
    expect(outRefusal(out, repo)).toMatch(/run log: .*not a regular file/);
    fs.rmSync(log, { recursive: true });
    fs.writeFileSync(log, '{}\n');
    expect(outRefusal(out, repo)).toBeNull();
  });

  it('a write target that is a link, a directory or a second name is refused; the rehearsal writes every name the read will', () => {
    const out = path.join(tmp, 'out');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(tmp, 'real.json'), '{}');
    fs.symlinkSync(path.join(tmp, 'real.json'), path.join(out, PRE_FILE));
    expect(targetRefusal(path.join(out, PRE_FILE))).toMatch(/symbolic link/);
    expect(rehearse(out)).toMatch(/symbolic link/);
    fs.rmSync(path.join(out, PRE_FILE));
    fs.linkSync(path.join(tmp, 'real.json'), path.join(out, RESULT_FILE));
    expect(targetRefusal(path.join(out, RESULT_FILE))).toMatch(/2 names/);
    fs.rmSync(path.join(out, RESULT_FILE));
    fs.mkdirSync(path.join(out, LOG_FILE));
    expect(targetRefusal(path.join(out, LOG_FILE))).toMatch(/not a regular file/);
    fs.rmSync(path.join(out, LOG_FILE), { recursive: true });
    expect(rehearse(out, () => 0)).toBeNull();
    expect(fs.readdirSync(out).sort()).toEqual([...OUT_FILES, LOG_FILE].sort());
    expect(fs.readFileSync(path.join(out, LOG_FILE), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('the memory plan covers the peak measured at four synthetic scales, and its projection past the largest (lesson 19)', () => {
    // Measured once on synthetic panels (K coins × D days, month-by-month grids as the archive loader builds them):
    // the main run end to end — frame, 15m rows, floors, outcomes, every measure, T3's figures. Instrument: the
    // `maximum resident set size` of /usr/bin/time -l around `node --import tsx` (node 24, macOS, an 18 GiB host).
    const measured = [
      { run: { bytes: 3_887_487, nE: 16_560, clusters: 690 }, peak: 466_812_928 },
      { run: { bytes: 7_916_607, nE: 33_840, clusters: 1_410 }, peak: 636_387_328 },
      { run: { bytes: 15_974_847, nE: 68_400, clusters: 2_850 }, peak: 940_900_352 },
      { run: { bytes: 31_949_694, nE: 136_800, clusters: 5_700 }, peak: 1_257_193_472 },
    ];
    const arrays = (r: { bytes: number; nE: number; clusters: number }): number => memoryPlan([r]).parts.widest_run;
    for (const m of measured) expect(memoryPlan([m.run]).bytes, `${m.run.nE} entries`).toBeGreaterThan(1.2 * m.peak);
    // the least-squares line of peak on planned arrays, carried past the largest scale: the plan stays 20 % above it
    const xs = measured.map((m) => arrays(m.run)), ys = measured.map((m) => m.peak), n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    const c1 = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0), c0 = my - c1 * mx;
    expect(c1).toBeGreaterThan(1);
    for (const k of [1, 2, 4, 8, 16, 32]) {
      const run = { bytes: k * 31_949_694, nE: k * 136_800, clusters: k * 5_700 };
      expect(memoryPlan([run]).bytes, `×${k}`).toBeGreaterThan(1.2 * (c0 + c1 * arrays(run)));
    }
  });

  it('the memory plan refuses a read that would not finish on this host', () => {
    const plan = memoryPlan([{ bytes: 1e9, nE: 2e5, clusters: 1e4 }], { bytes: 1.3e9, nE: 2.6e5, clusters: 1.1e4 });
    expect(plan.parts.runs).toBe(2);
    expect(memoryRefusal(plan, 2 ** 40)).toBeNull();
    expect(memoryRefusal(plan, 2 ** 30)).toMatch(/above the budget/);
  });
});

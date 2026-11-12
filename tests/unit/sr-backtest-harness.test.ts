// EDGE-SR-LEVEL-BACKTEST-W1 CH1 — the outcome step's guard, both ways; the whole harness end to end on synthetic
// candles (store -> guarded run -> estimator -> verdict); the estimator's self-test and the mutations that break
// it; the null calibration and the half-width control that breaks it; what was registered is what is run.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seriesFile, type StoredSeries } from '../../src/scripts/sr-probe/store.js';
import { BT, DAY, M15, STUDY, TIMEFRAMES, WAVE, tfOf } from '../../src/scripts/sr-backtest/spec.js';
import { COLS } from '../../src/scripts/sr-backtest/engine.js';
import { FIXTURE_PATH } from '../../src/scripts/sr-backtest/fixture.js';
import { PINNED_FILES, checkOutcomeGuard, pinsOf, storePin } from '../../src/scripts/sr-backtest/guard.js';
import { CALIBRATION_HEADER, EVENTS_HEADER, calibrationCsv, calibrationRows, outcomeStep, runStore } from '../../src/scripts/sr-backtest/run.js';
import { buildManifest, loadCoin, manifestFile, manifestText, missingBars, planFile, readPlan, seriesRange, sha256, type StorePlan } from '../../src/scripts/sr-backtest/store.js';
import { CALIBRATION, synthCoin } from '../../src/scripts/sr-backtest/synth.js';

const PY = 'scripts/sr-backtest/sr_backtest.py';
const CAL = 'scripts/sr-backtest/calibration.json';
const VENUE = 'BINANCE';
const REG = 'audits/sr-level-backtest-preregistration-2024-01-01.md';

const git = (repo: string, ...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

interface Ran { status: number | null; out: string; token: (name: string) => string | null }
const ran = (status: number | null, out: string): Ran => ({ status, out, token: (name) => out.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1] ?? null });

/** The estimator, as the operator runs it. */
function py(args: string[], env: Record<string, string> = {}): Ran {
  const r = spawnSync('python3', ['-I', PY, ...args], { encoding: 'utf8', timeout: 240_000, env: { ...process.env, ...env } });
  return ran(r.status, `${r.stdout ?? ''}`);
}

/** A child process, awaited. A run of minutes must not hold the vitest worker: its RPC to the runner gives up
 *  after 60 s of silence and the run exits 1 with every assertion green. */
function child(cmd: string, args: string[], timeoutMs: number): Promise<Ran> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs });
    let out = '';
    c.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
    c.on('error', () => resolve(ran(null, out)));
    c.on('close', (status) => resolve(ran(status, out)));
  });
}

/** Where two parsed JSON documents differ: numbers agree to a relative REL_TOL, everything else is identical.
 *  The estimator is pure Python and adds floats with the built-in `sum`, which CPython 3.12 made a compensated
 *  sum, so the same counts give statistics that differ in the sixteenth digit between interpreters (measured:
 *  3.9.6 where the artifact was generated against the ubuntu-26.04 runner of deploy run 43227842654). The counts
 *  come from the TypeScript engine and their sha256 is the same on both. */
const REL_TOL = 1e-9;
function jsonDiffs(got: unknown, want: unknown, at = '$'): string[] {
  if (typeof got === 'number' && typeof want === 'number') {
    return Math.abs(got - want) <= REL_TOL * Math.max(1, Math.abs(got), Math.abs(want)) ? [] : [`${at}: ${got} != ${want}`];
  }
  if (Array.isArray(got) && Array.isArray(want)) {
    return got.length !== want.length ? [`${at}: length ${got.length} != ${want.length}`] : got.flatMap((g, i) => jsonDiffs(g, want[i], `${at}[${i}]`));
  }
  if (got && want && typeof got === 'object' && typeof want === 'object' && !Array.isArray(got) && !Array.isArray(want)) {
    const [g, w] = [got as Record<string, unknown>, want as Record<string, unknown>];
    return [...new Set([...Object.keys(g), ...Object.keys(w)])].sort()
      .flatMap((k) => (k in g && k in w ? jsonDiffs(g[k], w[k], `${at}.${k}`) : [`${at}.${k}: on one side only`]));
  }
  return got === want ? [] : [`${at}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`];
}

const pinTable = (pins: Record<string, string>): string =>
  ['# A registration', '', '## Pinned artifacts', '', '| artifact | sha256 |', '|---|---|', ...Object.entries(pins).map(([k, v]) => `| \`${k}\` | \`${v}\` |`), ''].join('\n');

/** A synthetic store in the fetcher's own shape: seeded driftless walks, every planned bar present. */
function writeStore(store: string, coins: string[], days: number): StorePlan {
  const startMs = Date.UTC(2024, 0, 1);
  const plan: StorePlan = {
    venue: VENUE, startMs, endMs: startMs + days * DAY, warmupBars: STUDY.warmupBars, panelSize: coins.length,
    panelAsOf: '2024-01-01T00:00:00.000Z', panelSource: 'synthetic', candidates: [], coins,
  };
  const firstMs = startMs - STUDY.warmupBars * DAY;
  for (const coin of coins) {
    const data = synthCoin(coin, { seed: 11, key: `sandbox|${coin}`, firstMs, bars: (STUDY.warmupBars + days) * (DAY / M15) });
    for (const tf of TIMEFRAMES) {
      const range = seriesRange(plan, tf.stepMs);
      const s: StoredSeries = {
        exchange: VENUE, coin, key: tf.key, stepMs: tf.stepMs, ranges: [range], status: 'ok', pages: 1, branches: {}, fetchedAt: plan.panelAsOf,
        bars: data.frames[tf.key].filter((b) => b.time >= range[0] && b.time <= range[1]).map((b) => [b.time, b.open, b.high, b.low, b.close]),
      };
      const f = seriesFile(store, { exchange: VENUE, coin, stepMs: tf.stepMs });
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, JSON.stringify(s));
    }
  }
  writeFileSync(planFile(store, VENUE), `${JSON.stringify(plan, null, 1)}\n`);
  writeFileSync(manifestFile(store, VENUE), manifestText(buildManifest(store, plan)));
  return plan;
}

const COINS = Array.from({ length: 20 }, (_, i) => `S${String(i).padStart(2, '0')}`);
const DAYS = 110;

let dir = '';
let repo = '';
let store = '';
let holed = '';
let plan: StorePlan;
let manifestSha = '';
let before: ReturnType<typeof outcomeStep>;
let after: ReturnType<typeof outcomeStep>;
let baseSha = '';
let landedSha = '';
const outDir = (name: string): string => path.join(dir, 'out', name);

/** Runs `fn` against a changed sandbox file and puts the original bytes back. */
function withFile<T>(file: string, change: (text: string) => string, fn: () => T): T {
  const orig = readFileSync(file);
  writeFileSync(file, change(orig.toString('utf8')));
  try {
    return fn();
  } finally {
    writeFileSync(file, orig);
  }
}

const step = (name: string, registration = REG, s = store): ReturnType<typeof outcomeStep> => outcomeStep({ repo, registration, store: s, venue: VENUE, out: outDir(name) });

/** A sandbox checkout that can commit: its own identity, no signing, no hooks. */
function configure(checkout: string): void {
  for (const [k, v] of [['user.email', 'sandbox@example.invalid'], ['user.name', 'sandbox'], ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(dir, 'no-hooks')]]) git(checkout, 'config', k, v);
}

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'sr-backtest-harness-'));
  const origin = path.join(dir, 'origin.git');
  repo = path.join(dir, 'repo');
  store = path.join(dir, 'store');
  holed = path.join(dir, 'store-holed');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin], { timeout: 60_000 });
  execFileSync('git', ['init', '-q', '--initial-branch=main', repo], { timeout: 60_000 });
  mkdirSync(path.join(dir, 'no-hooks'));
  configure(repo);
  git(repo, 'remote', 'add', 'origin', origin);
  // origin/main is there before the registration is: a base commit, pushed.
  writeFileSync(path.join(repo, 'README.md'), 'sandbox\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  baseSha = git(repo, 'rev-parse', 'origin/main');
  // The sandbox checkout carries this checkout's own harness files, byte for byte.
  for (const rel of PINNED_FILES) {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    cpSync(rel, path.join(repo, rel));
  }
  plan = writeStore(store, COINS, DAYS);
  manifestSha = sha256(readFileSync(manifestFile(store, VENUE)));
  // A second store with one bar missing: its manifest is honest about it and lists the failure.
  writeStore(holed, ['S00', 'S01'], 30);
  const f = seriesFile(holed, { exchange: VENUE, coin: 'S01', stepMs: tfOf('1h').stepMs });
  const s = JSON.parse(readFileSync(f, 'utf8')) as StoredSeries;
  s.bars.splice(500, 1);
  writeFileSync(f, JSON.stringify(s));
  writeFileSync(manifestFile(holed, VENUE), manifestText(buildManifest(holed, readPlan(holed, VENUE)!)));

  const files = Object.fromEntries(PINNED_FILES.map((rel) => [rel, sha256(readFileSync(rel))]));
  const reg = (name: string, pins: Record<string, string>): void => {
    mkdirSync(path.join(repo, 'audits'), { recursive: true });
    writeFileSync(path.join(repo, 'audits', name), pinTable(pins));
    git(repo, 'add', `audits/${name}`);
  };
  const { [PY]: _dropped, ...withoutEstimator } = files;
  reg(path.basename(REG), { ...files, [storePin(VENUE)]: manifestSha });
  reg('no-estimator-pin.md', { ...withoutEstimator, [storePin(VENUE)]: manifestSha });
  reg('no-store-pin.md', files);
  reg('other-store.md', { ...files, [storePin(VENUE)]: 'f'.repeat(64) });
  reg('holed-store.md', { ...files, [storePin(VENUE)]: sha256(readFileSync(manifestFile(holed, VENUE))) });
  for (const rel of PINNED_FILES) git(repo, 'add', rel);
  git(repo, 'commit', '-q', '-m', 'registration');
  // Both ways, on the same registration and the same store: committed but not pushed, then landed.
  before = step('before');
  git(repo, 'push', '-q', 'origin', 'main');
  landedSha = git(repo, 'rev-parse', 'origin/main');
  after = step('run');
}, 300_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('the outcome step refuses until the registration has landed', () => {
  it('refuses a registration that is committed but not pushed to an origin/main that exists, and writes nothing', () => {
    // origin/main was the base commit then: the refusal is about the registration, not about a missing branch.
    expect(before.guard).toMatchObject({ ok: false, originMain: baseSha, registrationCommit: null });
    expect(landedSha).not.toBe(baseSha);
    expect(before.guard.reason).toMatch(/is not on origin\/main/);
    expect(before.run).toBeNull();
    expect(existsSync(outDir('before'))).toBe(false);
  });

  it('runs once the same registration is on origin/main', () => {
    expect(after.guard).toMatchObject({ ok: true, reason: 'ok', registrationCommit: landedSha, originMain: landedSha, manifestSha256: manifestSha });
    expect(Object.keys(after.guard.harnessSha256)).toEqual([...PINNED_FILES]);
    expect(after.run).toMatchObject({ ok: true, reason: 'ok' });
    expect(Object.keys(after.run!.files).sort()).toEqual(['counts.csv', 'events-z1.csv', 'sides.json']);
  });

  it('refuses a registration that exists only in the working tree', { timeout: 60_000 }, () => {
    writeFileSync(path.join(repo, 'audits/unlanded.md'), readFileSync(path.join(repo, REG)));
    const r = step('unlanded', 'audits/unlanded.md');
    expect(r.guard.reason).toMatch(/audits\/unlanded\.md is not on origin\/main/);
    expect(r.run).toBeNull();
    expect(existsSync(outDir('unlanded'))).toBe(false);
  });

  it('refuses when origin cannot be reached', { timeout: 60_000 }, () => {
    const url = git(repo, 'remote', 'get-url', 'origin');
    git(repo, 'remote', 'set-url', 'origin', path.join(dir, 'gone.git'));
    try {
      expect(step('offline').guard.reason).toMatch(/origin could not be fetched/);
    } finally {
      git(repo, 'remote', 'set-url', 'origin', url);
    }
    expect(existsSync(outDir('offline'))).toBe(false);
    expect(checkOutcomeGuard({ repo, registration: REG, store, venue: VENUE }).ok).toBe(true);
  });
});

describe('the outcome step refuses code or candles the registration did not pin', () => {
  const refused = (name: string, r: ReturnType<typeof outcomeStep>, reason: RegExp): void => {
    expect(r.guard.ok, name).toBe(false);
    expect(r.guard.reason).toMatch(reason);
    expect(r.run).toBeNull();
    expect(existsSync(outDir(name))).toBe(false);
  };

  it.each(PINNED_FILES.map((rel) => [rel]))('refuses when %s is not the registered file', { timeout: 60_000 }, (rel) => {
    refused(`changed-${path.basename(rel)}`, withFile(path.join(repo, rel), (t) => `${t}\n`, () => step(`changed-${path.basename(rel)}`)), new RegExp(`${rel.replace(/[.]/g, '\\.')} is not the registered file`));
  });

  it('a local edit of the registration cannot move the pins', { timeout: 60_000 }, () => {
    const engine = path.join(repo, 'src/scripts/sr-backtest/engine.ts');
    const edited = `${readFileSync(engine, 'utf8')}\n`;
    const r = withFile(engine, () => edited, () =>
      withFile(path.join(repo, REG), (t) => t.replace(sha256(readFileSync('src/scripts/sr-backtest/engine.ts')), sha256(edited)), () => step('repinned')));
    refused('repinned', r, /engine\.ts is not the registered file/);
  });

  it('a local commit that edits a pinned file and pins the edit cannot move the pins either', { timeout: 120_000 }, () => {
    // A second checkout of the landed origin. Clean, it passes.
    const clone = path.join(dir, 'clone');
    execFileSync('git', ['clone', '-q', path.join(dir, 'origin.git'), clone], { timeout: 60_000 });
    configure(clone);
    expect(checkOutcomeGuard({ repo: clone, registration: REG, store, venue: VENUE })).toMatchObject({ ok: true, registrationCommit: landedSha, originMain: landedSha });
    // Committed there and never pushed: the engine with one more byte, and a registration that pins that engine.
    const rel = 'src/scripts/sr-backtest/engine.ts';
    const edited = `${readFileSync(path.join(clone, rel), 'utf8')}\n`;
    writeFileSync(path.join(clone, rel), edited);
    writeFileSync(path.join(clone, REG), readFileSync(path.join(clone, REG), 'utf8').replace(sha256(readFileSync(rel)), sha256(edited)));
    git(clone, 'add', rel, REG);
    git(clone, 'commit', '-q', '-m', 'engine edited and pinned again');
    expect(git(clone, 'status', '--porcelain')).toBe('');
    expect(git(clone, 'rev-parse', 'HEAD')).not.toBe(landedSha);
    expect(pinsOf(git(clone, 'show', `HEAD:${REG}`)).get(rel)).toBe(sha256(edited));
    // The checkout agrees with its own history; the pins are still the ones on origin/main.
    const r = outcomeStep({ repo: clone, registration: REG, store, venue: VENUE, out: outDir('local-commit') });
    refused('local-commit', r, /engine\.ts is not the registered file/);
    expect(r.guard).toMatchObject({ registrationCommit: landedSha, originMain: landedSha });
  });

  it('refuses when a pinned file is gone', { timeout: 60_000 }, () => {
    const f = path.join(repo, 'src/scripts/sr-backtest/zones.ts');
    const orig = readFileSync(f);
    rmSync(f);
    try {
      refused('absent', step('absent'), /the pinned file src\/scripts\/sr-backtest\/zones\.ts is absent/);
    } finally {
      writeFileSync(f, orig);
    }
  });

  it('refuses a registration that pins no estimator, no store, or another store', { timeout: 60_000 }, () => {
    refused('no-estimator', step('no-estimator', 'audits/no-estimator-pin.md'), /does not pin scripts\/sr-backtest\/sr_backtest\.py/);
    refused('no-store', step('no-store', 'audits/no-store-pin.md'), /does not pin store:manifest-BINANCE\.json/);
    refused('other-store', step('other-store', 'audits/other-store.md'), /the store manifest is not the registered one/);
  });

  it('refuses when the manifest was rewritten', { timeout: 60_000 }, () => {
    refused('manifest', withFile(manifestFile(store, VENUE), (t) => `${t} `, () => step('manifest')), /the store manifest is not the registered one/);
  });

  it('refuses when a candle changed under an untouched manifest', { timeout: 60_000 }, () => {
    const f = seriesFile(store, { exchange: VENUE, coin: 'S03', stepMs: tfOf('4h').stepMs });
    const change = (t: string): string => {
      const s = JSON.parse(t) as StoredSeries;
      s.bars[400][4] += 1;
      return JSON.stringify(s);
    };
    refused('candle', withFile(f, change, () => step('candle')), /the candle files no longer match the store manifest/);
  });

  it('refuses a store with a hole, even when the registration pins its manifest', { timeout: 60_000 }, () => {
    refused('holed', step('holed', 'audits/holed-store.md', holed), /the store manifest lists failed series/);
    expect(() => loadCoin(holed, readPlan(holed, VENUE)!, 'S01')).toThrow(/S01 1h holds \d+ of \d+ bars/);
  });

  it('refuses a store with no manifest or no plan', { timeout: 60_000 }, () => {
    refused('empty', step('empty', REG, path.join(dir, 'nowhere')), /the store manifest .* is absent/);
  });

  it('runs again once every change is undone', { timeout: 60_000 }, () => {
    expect(checkOutcomeGuard({ repo, registration: REG, store, venue: VENUE })).toMatchObject({ ok: true, manifestSha256: manifestSha });
  });
});

describe('the candle store', () => {
  it('plans a warm-up of 300 bars of each timeframe before the window, up to the last bar closing at its end', () => {
    for (const tf of TIMEFRAMES) {
      const [a, b] = seriesRange(plan, tf.stepMs);
      expect([a, b]).toEqual([plan.startMs - 300 * tf.stepMs, plan.endMs - tf.stepMs]);
      const bars = loadCoin(store, plan, 'S00')[tf.key];
      expect([bars[0].time, bars[bars.length - 1].time, bars.length]).toEqual([a, b, (b - a) / tf.stepMs + 1]);
    }
  });

  it('counts missing, duplicated and off-grid bars against the plan', () => {
    const s = (bars: number[]): StoredSeries => ({ exchange: VENUE, coin: 'X', key: '15m', stepMs: M15, ranges: [], status: 'ok', pages: 1, branches: {}, fetchedAt: '', bars: bars.map((t) => [t, 1, 1, 1, 1]) });
    const range: [number, number] = [10 * M15, 14 * M15];
    expect(missingBars(s([10, 11, 12, 13, 14].map((i) => i * M15)), range)).toBe(0);
    expect(missingBars(s([9, 10, 11, 12, 13, 14, 15].map((i) => i * M15)), range)).toBe(0);
    expect(missingBars(s([10, 11, 13, 14].map((i) => i * M15)), range)).toBe(1);
    expect(missingBars(s([10, 11, 11, 13, 14].map((i) => i * M15)), range)).toBe(1);
    expect(missingBars(s([10 * M15, 11 * M15, 12 * M15 + 1, 13 * M15, 14 * M15]), range)).toBe(1);
    expect(missingBars(s([]), range)).toBe(5);
  });

  it('rebuilds the same manifest from the same candles, and names every hole', () => {
    expect(manifestText(buildManifest(store, plan))).toBe(readFileSync(manifestFile(store, VENUE), 'utf8'));
    const m = buildManifest(store, plan);
    expect(m.failures).toEqual([]);
    expect(m.series).toHaveLength(COINS.length * TIMEFRAMES.length);
    expect(buildManifest(holed, readPlan(holed, VENUE)!).failures).toEqual([{ coin: 'S01', key: '1h', reason: '1 of 1020 bars missing' }]);
  });
});

describe('the whole harness on synthetic candles', () => {
  const read = (name: string): string => readFileSync(path.join(outDir('run'), name), 'utf8');
  const meta = (): Record<string, any> => JSON.parse(read('run-meta.json'));
  const landedAt = (deltaMs: number): string => new Date(Math.floor(Date.parse(meta().startedAt) / 1000) * 1000 + deltaMs).toISOString();
  const analyze = (run: string, name: string, landed: string | null): ReturnType<typeof py> =>
    py(['--analyze', run, ...(landed ? ['--landed-at', landed] : []), '--out-md', path.join(dir, `${name}.md`), '--out-json', path.join(dir, `${name}.json`)]);
  /** A copy of the run directory with one file changed. */
  const forged = (name: string, file: string, change: (text: string) => string): string => {
    const to = outDir(name);
    cpSync(outDir('run'), to, { recursive: true });
    writeFileSync(path.join(to, file), change(readFileSync(path.join(to, file), 'utf8')));
    return to;
  };

  it('writes the counts, the side mix, the paired events and what it ran on', () => {
    const m = meta();
    expect(m).toMatchObject({ wave: WAVE, mode: 'outcomes', venue: VENUE, coins: COINS, startMs: plan.startMs, endMs: plan.endMs, holdoutStartMs: plan.endMs - 92 * DAY });
    expect(m.guard).toEqual(after.guard);
    expect(m.params).toEqual(JSON.parse(JSON.stringify(BT)));
    expect(m.study).toEqual(JSON.parse(JSON.stringify(STUDY)));
    for (const [name, hash] of Object.entries(m.files as Record<string, string>)) expect(sha256(read(name)), name).toBe(hash);
    const counts = read('counts.csv').trimEnd().split('\n');
    expect(counts[0]).toBe(`key,tf,day,coin,${COLS.join(',')}`);
    const events = read('events-z1.csv').trimEnd().split('\n');
    expect(events[0]).toBe(EVENTS_HEADER);
    // Every served zone is one event, and every event has its control.
    const z1 = counts.slice(1).map((l) => l.split(',')).filter((c) => c[0] === 'z1');
    const total = (col: number): number => z1.reduce((a, c) => a + Number(c[4 + col]), 0);
    expect(total(0)).toBe(events.length - 1);
    expect(total(1)).toBe(total(0));
    expect(total(0)).toBeGreaterThan(50_000);
    expect(new Set(z1.map((c) => c[1]))).toEqual(new Set(['15m', '1h', '4h', '1d']));
    expect(new Set(z1.map((c) => c[3]))).toEqual(new Set(COINS));
    const col = (name: string): number => EVENTS_HEADER.split(',').indexOf(name);
    const rows = events.slice(1).map((l) => l.split(','));
    expect(rows.filter((r) => r[col('s_entered')] === '1').length).toBe(total(2));
    expect(rows.filter((r) => r[col('s_outcome')] === 'bounce').length).toBe(total(3));
    expect(rows.filter((r) => r[col('c_entered')] === '1').length).toBe(total(5));
    expect(rows.filter((r) => r[col('c_outcome')] === 'bounce').length).toBe(total(6));
    expect(rows.filter((r) => r[col('forced')] === '1').length).toBe(total(8));
  });

  it('refuses to write figures into the repository', () => {
    expect(runStore({ store, venue: VENUE, out: 'audits/sr-backtest-out', outcomes: true, guard: after.guard })).toMatchObject({ ok: false, reason: expect.stringMatching(/inside the repository/) });
    expect(existsSync('audits/sr-backtest-out')).toBe(false);
  });

  it('reads the run into one verdict line, three-state, with the landing before the read', { timeout: 300_000 }, () => {
    const r = analyze(outDir('run'), 'findings', landedAt(-60_000));
    const line = r.token('SR_BACKTEST_VERDICT');
    expect(line).toMatch(/^(PASS|NULL|INDETERMINATE) — \S/);
    expect(r.out.match(/^SR_BACKTEST_VERDICT=/gm)).toHaveLength(1);
    const j = JSON.parse(readFileSync(path.join(dir, 'findings.json'), 'utf8'));
    expect(`${j.verdict} — ${j.cause}`).toBe(line);
    expect(r.status).toBe(j.verdict === 'INDETERMINATE' ? 3 : 0);
    // Driftless walks: our zones are no better than the control. The verdict of this seeded store is pinned.
    expect(j.verdict).toBe('NULL');
    expect(j.cause).toBe('our zones bounce no more than matched random zones by +3.0pp');
    // The CH2 gate's own expression.
    expect(/^(PASS|NULL|INDETERMINATE)$/.test(j.verdict) && Date.parse(j.registration_landed_at) < Date.parse(j.outcome_read_at)).toBe(true);
    expect(j).toMatchObject({ wave: WAVE, registration_commit: landedSha, manifest_sha256: manifestSha, harness_sha256: after.guard.harnessSha256, counts_sha256: after.run!.files['counts.csv'] });
    // V1 on UTC-day clusters, on coin clusters and on the hold-out, each interval beside its cluster count.
    expect(j.V1.day.clusters).toBeGreaterThanOrEqual(20);
    expect(j.V1.coin.clusters).toBe(COINS.length);
    expect(j.V1.day.lo).toBeLessThan(j.V1.day.point);
    expect(j.V1.day.hi).toBeLessThan(3.0);
    expect(typeof j.V1.holdout).toBe('number');
    expect(j.V1.identifiability.verdict).toBe('IDENTIFIABLE');
    for (const k of ['V2a', 'V2b', 'V3', 'V4a', 'V4b', 'V5']) expect(j[k].state, k).toMatch(/^(PASS|NULL|INDETERMINATE)$/);
    expect(Object.keys(j.per_cell)).toEqual(['15m', '1d', '1h', '4h']);
    expect(j.decision_map[0]).toMatch(/^V1 NULL -> the arc closes/);
    const md = readFileSync(path.join(dir, 'findings.md'), 'utf8');
    expect(md).toContain(`\`SR_BACKTEST_VERDICT=${line}\``);
  });

  it('refuses a read that did not start after the landing', { timeout: 120_000 }, () => {
    for (const [name, landed] of [['same-second', landedAt(0)], ['later', landedAt(3_600_000)]] as const) {
      const r = analyze(outDir('run'), name, landed);
      expect(r.token('SR_BACKTEST_ANALYZE_VERDICT'), name).toMatch(/^REFUSED — the registration landed at .* not before it$/);
      expect(r.status).toBe(3);
      expect(r.token('SR_BACKTEST_VERDICT')).toBeNull();
      expect(existsSync(path.join(dir, `${name}.json`))).toBe(false);
    }
    expect(analyze(outDir('run'), 'no-landing', null).token('SR_BACKTEST_ANALYZE_VERDICT')).toBe('REFUSED — --landed-at is required');
  });

  it('refuses a run that was not the guarded outcome run, or whose files changed', { timeout: 120_000 }, () => {
    const skeleton = outDir('skeleton');
    expect(runStore({ store, venue: VENUE, out: skeleton, outcomes: false, guard: null, coins: 2 }).ok).toBe(true);
    expect(existsSync(path.join(skeleton, 'events-z1.csv'))).toBe(false);
    const sk = readFileSync(path.join(skeleton, 'skeleton.csv'), 'utf8').trimEnd().split('\n').slice(1).map((l) => l.split(','));
    expect(sk.length).toBeGreaterThan(100);
    expect(sk.every((c) => c.slice(6, 12).every((v) => v === '0'))).toBe(true); // nothing resolved
    const cases: Array<[string, string, RegExp]> = [
      ['skeleton', skeleton, /the run is not a guarded outcome run/],
      ['unguarded', forged('unguarded', 'run-meta.json', (t) => JSON.stringify({ ...JSON.parse(t), guard: null })), /the run is not a guarded outcome run/],
      ['refused-guard', forged('refused-guard', 'run-meta.json', (t) => JSON.stringify({ ...JSON.parse(t), guard: { ...JSON.parse(t).guard, ok: false } })), /the run is not a guarded outcome run/],
      ['counts', forged('counts', 'counts.csv', (t) => t.replace(/\n(z1,15m,\d+,S00),(\d+),/, '\n$1,9$2,')), /counts\.csv is not the file the run wrote/],
      ['other-code', forged('other-code', 'run-meta.json', (t) => t.replace(after.guard.harnessSha256['src/scripts/sr-backtest/engine.ts'], '0'.repeat(64))), /engine\.ts changed since the outcome run/],
      ['nothing', path.join(dir, 'nowhere'), /the run directory is unreadable/],
    ];
    for (const [name, run, reason] of cases) {
      const r = analyze(run, `refused-${name}`, landedAt(-60_000));
      expect(r.token('SR_BACKTEST_ANALYZE_VERDICT'), name).toMatch(reason);
      expect(r.status, name).toBe(3);
      expect(r.token('SR_BACKTEST_VERDICT'), name).toBeNull();
      expect(existsSync(path.join(dir, `refused-${name}.json`)), name).toBe(false);
    }
  });
});

describe('the estimator', () => {
  it('passes its own self-test', { timeout: 120_000 }, () => {
    const r = py(['--self-test']);
    expect(r.token('SR_BACKTEST_SELFTEST_VERDICT')).toBe('PASS');
    expect(r.status).toBe(0);
  });

  it.each([
    ['swap-arms', /V4 \(b\) at −6pp passes/],
    ['no-floor', /a tight \+1\.5pp is NULL, never PASS/],
    ['no-holdout', /a negative hold-out is INDETERMINATE/],
  ] as const)('the self-test turns red when the logic is broken: %s', { timeout: 120_000 }, (mutation, named) => {
    const r = py(['--self-test'], { SR_BACKTEST_MUTATE: mutation });
    expect(r.token('SR_BACKTEST_SELFTEST_VERDICT')).toBe('FAIL');
    expect(r.status).toBe(1);
    expect(r.out).toMatch(named);
  });

  it('holds the same frozen numbers as the harness', () => {
    const src = readFileSync(PY, 'utf8');
    const num = (name: string): number => Number(src.match(new RegExp(`^${name} = ([0-9_.]+)$`, 'm'))![1].replace(/_/g, ''));
    const tuple = (name: string): string[] => [...src.match(new RegExp(`^${name} = \\(([^)]*)\\)`, 'm'))![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect([num('MIN_ARM'), num('MIN_CLUSTERS'), num('BOOT_B'), num('BH_Q'), num('HOLDOUT_DAYS'), num('WINDOW_DAYS'), num('DAY_MS')])
      .toEqual([STUDY.minArm, STUDY.minClusters, STUDY.bootstrapB, STUDY.fdrQ, STUDY.holdoutDays, STUDY.windowDays, DAY]);
    expect(JSON.parse(src.match(/^FLOOR = (\{.*\})$/m)![1])).toEqual({ V1: STUDY.floorV1, V2a: STUDY.floorV2, V2b: 0, V3: STUDY.floorV3, V4a: STUDY.floorV4, V4b: STUDY.floorV4 });
    expect([num('CAL_MIN_REPS'), num('CAL_MIN_WALKS')]).toEqual([CALIBRATION.replications, CALIBRATION.walks]);
    expect(tuple('TFS')).toEqual(TIMEFRAMES.map((t) => t.key));
    expect(tuple('COLS')).toEqual([...COLS]);
    expect(src).toContain(`WAVE = "${WAVE}"`);
  });
});

describe('AC1.4 — the null calibration', () => {
  const cal = (): Record<string, any> => JSON.parse(readFileSync(CAL, 'utf8'));
  const CALIBRATION_FILES = ['src/scripts/sr-probe/level-v0.ts', 'src/scripts/sr-backtest/spec.ts', 'src/scripts/sr-backtest/zones.ts', 'src/scripts/sr-backtest/engine.ts',
    'src/scripts/sr-backtest/synth.ts', 'src/scripts/sr-backtest/run.ts', PY, 'src/scripts/cluster-perm-stats.py'];
  /** Two replications re-run here from the seed; the artifact holds all hundred, and the registered statistic is
   *  the hundred's. Two are enough to show the artifact is the generator's output and that the mutation is seen. */
  const SAMPLE = [1, 2];

  it('holds the registered lengths: at least 100 replications of at least 50 walks per timeframe', () => {
    expect(CALIBRATION).toMatchObject({ replications: 100, walks: 50, warmupDays: 300, evalDays: { '15m': 25, '1h': 25, '4h': 40, '1d': 240 }, seed: 20261112 });
    const c = cal();
    expect(c.replications).toBeGreaterThanOrEqual(100);
    expect(c.walks_per_replication).toBeGreaterThanOrEqual(50);
    expect(c.reps.map((r: any) => r.rep)).toEqual(Array.from({ length: c.replications }, (_, i) => i));
    expect(c.reps.every((r: any) => r.walks >= 50 && typeof r.delta_pp === 'number')).toBe(true);
  });

  it('mean Δ within ±0.5pp and P(V1 PASS) <= 0.05, recomputed from the replications', () => {
    const c = cal();
    const ds: number[] = c.reps.map((r: any) => r.delta_pp);
    const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
    const passShare = c.reps.filter((r: any) => r.verdict === 'PASS').length / c.reps.length;
    expect(c.mean_delta_pp).toBeCloseTo(mean, 9);
    expect(c.v1_pass_share).toBe(passShare);
    expect(Math.abs(mean)).toBeLessThanOrEqual(0.5);
    expect(passShare).toBeLessThanOrEqual(0.05);
    expect(c).toMatchObject({ verdict: 'PASS', within_tolerance: true, tolerance_pp: 0.5, max_pass_share: 0.05, wave: WAVE });
  });

  it('was computed by the code in this checkout', () => {
    const c = cal();
    expect(Object.keys(c.harness_sha256).sort()).toEqual([...CALIBRATION_FILES].sort());
    for (const rel of CALIBRATION_FILES) expect(c.harness_sha256[rel], rel).toBe(sha256(readFileSync(rel)));
  });

  it('compares statistics across interpreters to nine digits and everything else exactly', () => {
    const c = cal();
    const rep = c.reps[1];
    // Replication 1 as deploy run 43227842654 computed it from the same counts: two fields, sixteenth digit.
    expect(rep).toMatchObject({ coin_delta_pp: 0.18541734569309962, v4b_delta_pp: 0.07486194343757711 });
    const ci = { ...rep, coin_delta_pp: 0.18541734569309956, v4b_delta_pp: 0.07486194343757725 };
    expect(ci).not.toEqual(rep);
    expect(jsonDiffs([ci], [rep])).toEqual([]);
    expect(jsonDiffs({ ...c, reps: c.reps.map((r: any) => (r.rep === 1 ? ci : r)) }, cal())).toEqual([]);
    // Nothing more than the last digits: a moved statistic, label, count, hash, key or length is named.
    const { hi: _hi, ...noHi } = rep;
    const moved: Array<[unknown, unknown, string]> = [
      [{ ...rep, delta_pp: rep.delta_pp + 1e-6 }, rep, '$.delta_pp: '],
      [{ ...rep, verdict: 'PASS' }, rep, '$.verdict: '],
      [{ ...rep, day_clusters: rep.day_clusters + 1 }, rep, '$.day_clusters: '],
      [{ ...rep, rows_sha256: `${rep.rows_sha256}0` }, rep, '$.rows_sha256: '],
      [{ ...rep, lo: null }, rep, '$.lo: '],
      [noHi, rep, '$.hi: on one side only'],
      [[rep], [rep, rep], '$: length 1 != 2'],
      [{ ...c, mean_delta_pp: c.mean_delta_pp + 1e-6 }, c, '$.mean_delta_pp: '],
      [{ ...c, harness_sha256: { ...c.harness_sha256, [PY]: 'x' } }, c, `$.harness_sha256.${PY}: `],
    ];
    for (const [got, want, at] of moved) {
      const d = jsonDiffs(got, want);
      expect(d, at).toHaveLength(1);
      expect(d[0].startsWith(at), `${d[0]} | ${at}`).toBe(true);
    }
  });

  it('is reproduced from the seed, and the half-width control breaks it', { timeout: 600_000 }, () => {
    const c = cal();
    const rows = SAMPLE.map((rep) => calibrationRows(rep));
    SAMPLE.forEach((rep, i) => expect(sha256(rows[i].join('\n')), `replication ${rep}`).toBe(c.reps[rep].rows_sha256));
    const csv = path.join(dir, 'cal-sample.csv');
    writeFileSync(csv, `${[CALIBRATION_HEADER, ...rows.flat()].join('\n')}\n`);
    const out = path.join(dir, 'cal-sample.json');
    const r = py(['--calibrate', csv, '--min-reps', String(SAMPLE.length), '--out', out]);
    expect(jsonDiffs(JSON.parse(readFileSync(out, 'utf8')).reps, SAMPLE.map((rep) => c.reps[rep]))).toEqual([]);
    expect(r.token('SR_BACKTEST_CALIBRATION_VERDICT')).toBe('PASS');
    expect(r.status).toBe(0);
    // Under the registered floor of replications the same counts are not a verdict; nor is a file with no counts.
    const short = py(['--calibrate', csv]);
    expect(short.token('SR_BACKTEST_CALIBRATION_VERDICT')).toBe('INDETERMINATE');
    expect(short.status).toBe(3);
    const empty = path.join(dir, 'cal-empty.csv');
    for (const text of ['', `${CALIBRATION_HEADER}\n`]) {
      writeFileSync(empty, text);
      const none = py(['--calibrate', empty]);
      expect(none.token('SR_BACKTEST_CALIBRATION_VERDICT')).toBe('INDETERMINATE');
      expect(none.status).toBe(3);
    }

    // The mutation: a control half as wide as the served zone is entered less and bounces differently.
    const half = path.join(dir, 'cal-half.csv');
    writeFileSync(half, calibrationCsv(SAMPLE[0], SAMPLE.length, { ...BT, controlWidthMult: 0.5 }));
    const broken = py(['--calibrate', half, '--min-reps', String(SAMPLE.length)]);
    expect(broken.token('SR_BACKTEST_CALIBRATION_VERDICT')).toBe('FAIL');
    expect(broken.status).toBe(1);
    expect(Math.abs(JSON.parse(broken.out.split('\n')[0]).mean_delta_pp)).toBeGreaterThan(0.5);
  });

  it.skipIf(!process.env.SR_BACKTEST_FULL)('SR_BACKTEST_FULL=1: every replication regenerates the committed artifact', { timeout: 3_600_000 }, async () => {
    // The generator as the operator runs it, over consecutive ranges of replications side by side, then the
    // estimator: every one a child process, awaited.
    const total = CALIBRATION.replications;
    const per = Math.ceil(total / Math.max(1, Math.min(8, os.availableParallelism() - 1)));
    const parts = Array.from({ length: Math.ceil(total / per) }, (_, i) => ({ from: i * per, reps: Math.min(per, total - i * per), file: path.join(dir, `cal-full-${i}.csv`) }));
    expect(parts.reduce((n, p) => n + p.reps, 0)).toBe(total);
    const made = await Promise.all(parts.map((p) => child('node_modules/.bin/tsx', [
      'src/scripts/sr-backtest/run.ts', '--calibrate', '--from', String(p.from), '--reps', String(p.reps), '--out', p.file, ...(p.from ? ['--no-header'] : []),
    ], 3_000_000)));
    expect(made.map((r) => [r.status, r.token('SR_BACKTEST_RUN_VERDICT')])).toEqual(parts.map(() => [0, 'PASS']));
    const csv = path.join(dir, 'cal-full.csv');
    writeFileSync(csv, parts.map((p) => readFileSync(p.file, 'utf8')).join(''));
    const out = path.join(dir, 'cal-full.json');
    const r = await child('python3', ['-I', PY, '--calibrate', csv, '--out', out], 3_000_000);
    expect([r.status, r.token('SR_BACKTEST_CALIBRATION_VERDICT')]).toEqual([0, 'PASS']);
    expect(jsonDiffs(JSON.parse(readFileSync(out, 'utf8')), cal())).toEqual([]);
  });
});

describe('what was registered is what is run', () => {
  const found = (): string[] => readdirSync('audits').filter((f) => /^sr-level-backtest-preregistration-\d{4}-\d{2}-\d{2}\.md$/.test(f));
  const pins = (): Map<string, string> => pinsOf(readFileSync(path.join('audits', found()[0]), 'utf8'));
  /** The two shared statistics libraries are other waves' files: the registration pins them and the outcome step
   *  enforces the pin when it runs, but a later edit of theirs must not turn this suite red. */
  const SHARED = ['src/scripts/cluster-perm-stats.py', 'ops/monitoring/population_comparison.py'];

  it('there is exactly one registration', () => {
    expect(found()).toHaveLength(1);
  });

  it('it pins every file whose bytes decide an outcome, the store, the calibration and the parity fixture', () => {
    const p = pins();
    for (const rel of [...PINNED_FILES, storePin(VENUE), CAL, FIXTURE_PATH, 'src/scripts/sr-backtest/synth.ts', 'src/scripts/sr-backtest/fixture.ts']) expect(p.get(rel), rel).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the pinned files are the files in this checkout', () => {
    const p = pins();
    for (const rel of [...PINNED_FILES.filter((f) => !SHARED.includes(f)), CAL, FIXTURE_PATH, 'src/scripts/sr-backtest/synth.ts', 'src/scripts/sr-backtest/fixture.ts']) expect(p.get(rel), rel).toBe(sha256(readFileSync(rel)));
  });

  it('it states the frozen numbers the harness holds', () => {
    const text = readFileSync(path.join('audits', found()[0]), 'utf8');
    const block = text.match(/<!-- sr-backtest:frozen -->\s*```json\n([\s\S]*?)\n```/);
    expect(block).not.toBeNull();
    expect(JSON.parse(block![1])).toEqual(JSON.parse(JSON.stringify({ params: BT, timeframes: TIMEFRAMES, study: STUDY, calibration: CALIBRATION })));
  });
});

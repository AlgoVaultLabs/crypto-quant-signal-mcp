// EDGE-SR-HTF-LEVELS-W1 CH1 — the closed study's outcome guard guarding this study, both ways (AC1.3); no drift in
// the closed study: its four sources through this registry reproduce its counts byte for byte (AC1.4); the whole
// harness end to end on a synthetic store with volume (store -> guarded run -> estimator -> verdict); the
// estimator's self-test and the mutations that break it; the null calibration and the half-width control that
// breaks it (AC1.5); what was registered is what is run (AC1.6).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seriesFile, type StoredSeries } from '../../src/scripts/sr-probe/store.js';
import { BT, DAY, M15, STUDY, TIMEFRAMES, tfOf } from '../../src/scripts/sr-backtest/spec.js';
import { COLS, Tally, type CoinData } from '../../src/scripts/sr-backtest/engine.js';
import { checkOutcomeGuard, pinsOf, storePin } from '../../src/scripts/sr-backtest/guard.js';
import { runStore } from '../../src/scripts/sr-backtest/run.js';
import { buildManifest, manifestFile, manifestText, planFile, readPlan, seriesRange, sha256, type StorePlan } from '../../src/scripts/sr-backtest/store.js';
import { synthCoin } from '../../src/scripts/sr-backtest/synth.js';
import { CALIBRATION_HTF, HP, PANEL, STUDY_HTF, WAVE, planLabel } from '../../src/scripts/sr-htf/config.js';
import { REGISTERED, runRegistry } from '../../src/scripts/sr-htf/registry.js';
import { loadVCoin } from '../../src/scripts/sr-htf/htf-store.js';
import { synthVCoin } from '../../src/scripts/sr-htf/synthv.js';
import {
  CALIBRATION_HEADER_HTF, EVENTS_HEADER_HTF, HTF_PINNED, calibrationCsvHtf, calibrationRowsHtf, checkPanelGuard, outcomeStepHtf, runPanel,
} from '../../src/scripts/sr-htf/htf-run.js';

const PY = 'src/scripts/sr-htf/sr_htf.py';
const CAL = 'src/scripts/sr-htf/calibration.json';
const VENUE = 'BINANCE';
const REG = 'audits/sr-htf-levels-preregistration-2024-01-01.md';

const git = (repo: string, ...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

interface Ran { status: number | null; out: string; err: string; token: (name: string) => string | null }
const ran = (status: number | null, out: string, err = ''): Ran => ({ status, out, err, token: (name) => out.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1] ?? null });

/** A child process, awaited. Never spawnSync here: back-to-back synchronous runs of seconds each starve the vitest
 *  worker's event loop, its RPC to the runner gives up after 60 s, and the run exits 1 with every assertion green. */
function child(cmd: string, args: string[], timeoutMs: number, env: Record<string, string> = {}): Promise<Ran> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    c.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
    c.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; });
    c.on('error', () => resolve(ran(null, out, err)));
    c.on('close', (status) => resolve(ran(status, out, err)));
  });
}

/** The estimator, as the operator runs it. */
const py = (args: string[], env: Record<string, string> = {}): Promise<Ran> => child('python3', ['-I', PY, ...args], 240_000, env);
/** One macrotask turn: lets the worker answer the runner between long synchronous steps. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Where two parsed JSON documents differ: numbers agree to a relative REL_TOL, everything else is identical.
 *  CPython 3.12 made the built-in `sum` compensated, so the same counts give statistics that differ in the
 *  sixteenth digit between the Mac's 3.9 and the CI runner's interpreter; the counts' sha256 is the same on both. */
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

/** One coin's series in the fetcher's own shape: version 2 with the volume as a sixth field, or version 1 without. */
function writeSeries(store: string, plan: StorePlan, coin: string, data: CoinData, volume: boolean): void {
  for (const tf of TIMEFRAMES) {
    const range = seriesRange(plan, tf.stepMs);
    const s = {
      exchange: VENUE, coin, key: tf.key, stepMs: tf.stepMs, ranges: [range], status: 'ok', pages: 1, branches: {}, fetchedAt: plan.panelAsOf,
      bars: data.frames[tf.key].filter((b) => b.time >= range[0] && b.time <= range[1])
        .map((b) => (volume ? [b.time, b.open, b.high, b.low, b.close, (b as { volume?: number }).volume as number] : [b.time, b.open, b.high, b.low, b.close])),
      ...(volume ? { version: 2 } : {}),
    };
    const f = seriesFile(store, { exchange: VENUE, coin, stepMs: tf.stepMs });
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(s));
  }
}

/** This study's store: one plan and one manifest per coin, store version 2, the registered end and warm-up. */
function writeHtfStore(store: string, coins: string[], startMs: number): void {
  for (const coin of coins) {
    const label = planLabel(coin);
    const plan = {
      venue: VENUE, startMs, endMs: STUDY_HTF.endMs, warmupBars: STUDY_HTF.warmupDays, panelSize: 1, panelAsOf: '2025-11-13T00:00:00.000Z',
      panelSource: 'synthetic', candidates: [], coins: [coin], storeVersion: 2,
    };
    const firstMs = startMs - STUDY_HTF.warmupDays * DAY;
    const data = synthVCoin(coin, { seed: 11, key: `sandbox|${coin}`, firstMs, bars: ((STUDY_HTF.endMs - firstMs) / DAY) * (DAY / M15) });
    writeSeries(store, plan, coin, data, true);
    writeFileSync(planFile(store, label), `${JSON.stringify(plan, null, 1)}\n`);
    writeFileSync(manifestFile(store, label), manifestText(buildManifest(store, plan)));
  }
}

/** The registered panel's size: fewer coins leave too few entered htf zones for a cell-day to be present. */
const COINS = Array.from({ length: 50 }, (_, i) => `S${String(i).padStart(2, '0')}`);
const START = Date.UTC(2025, 6, 1);

let dir = '';
let repo = '';
let store = '';
let holed = '';
let manifests: Record<string, string> = {};
let before: ReturnType<typeof outcomeStepHtf>;
let after: ReturnType<typeof outcomeStepHtf>;
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

const step = (name: string, registration = REG, s = store, panel = COINS): ReturnType<typeof outcomeStepHtf> =>
  outcomeStepHtf({ repo, registration, store: s, out: outDir(name), panel });

function configure(checkout: string): void {
  for (const [k, v] of [['user.email', 'sandbox@example.invalid'], ['user.name', 'sandbox'], ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(dir, 'no-hooks')]]) git(checkout, 'config', k, v);
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'sr-htf-harness-'));
  const origin = path.join(dir, 'origin.git');
  repo = path.join(dir, 'repo');
  store = path.join(dir, 'store');
  holed = path.join(dir, 'store-holed');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin], { timeout: 60_000 });
  execFileSync('git', ['init', '-q', '--initial-branch=main', repo], { timeout: 60_000 });
  mkdirSync(path.join(dir, 'no-hooks'));
  configure(repo);
  git(repo, 'remote', 'add', 'origin', origin);
  writeFileSync(path.join(repo, 'README.md'), 'sandbox\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  baseSha = git(repo, 'rev-parse', 'origin/main');
  for (const rel of HTF_PINNED) {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    cpSync(rel, path.join(repo, rel));
  }
  for (const coin of COINS) {
    writeHtfStore(store, [coin], START);
    await tick();
  }
  manifests = Object.fromEntries(COINS.map((c) => [storePin(planLabel(c)), sha256(readFileSync(manifestFile(store, planLabel(c))))]));
  // A second store with one bar missing: its manifest is honest about it and lists the failure.
  writeHtfStore(holed, ['S00', 'S01'], Date.UTC(2025, 8, 1));
  const f = seriesFile(holed, { exchange: VENUE, coin: 'S01', stepMs: tfOf('1h').stepMs });
  const s = JSON.parse(readFileSync(f, 'utf8')) as StoredSeries;
  s.bars.splice(500, 1);
  writeFileSync(f, JSON.stringify(s));
  writeFileSync(manifestFile(holed, planLabel('S01')), manifestText(buildManifest(holed, readPlan(holed, planLabel('S01'))!)));

  const files = Object.fromEntries(HTF_PINNED.map((rel) => [rel, sha256(readFileSync(rel))]));
  const reg = (name: string, pins: Record<string, string>): void => {
    mkdirSync(path.join(repo, 'audits'), { recursive: true });
    writeFileSync(path.join(repo, 'audits', name), pinTable(pins));
    git(repo, 'add', `audits/${name}`);
  };
  const { [PY]: _dropped, ...withoutEstimator } = files;
  const { [storePin(planLabel('S07'))]: _gone, ...withoutS07 } = manifests;
  reg(path.basename(REG), { ...files, ...manifests });
  reg('no-estimator-pin.md', { ...withoutEstimator, ...manifests });
  reg('no-store-pin.md', { ...files, ...withoutS07 });
  reg('other-store.md', { ...files, ...manifests, [storePin(planLabel('S07'))]: 'f'.repeat(64) });
  reg('holed-store.md', { ...files, ...Object.fromEntries(['S00', 'S01'].map((c) => [storePin(planLabel(c)), sha256(readFileSync(manifestFile(holed, planLabel(c))))])) });
  for (const rel of HTF_PINNED) git(repo, 'add', rel);
  git(repo, 'commit', '-q', '-m', 'registration');
  // Both ways, on the same registration and the same store: committed but not pushed, then landed.
  before = step('before');
  await tick();
  git(repo, 'push', '-q', 'origin', 'main');
  landedSha = git(repo, 'rev-parse', 'origin/main');
  after = step('run');
}, 600_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('the closed study\'s guard guards this study (AC1.3)', () => {
  it('refuses a registration that is committed but not pushed to an origin/main that exists, and writes nothing', () => {
    expect(before.guard).toMatchObject({ ok: false, originMain: baseSha, registrationCommit: null });
    expect(landedSha).not.toBe(baseSha);
    expect(before.guard.reason).toMatch(/^S00: the registration .* is not on origin\/main/);
    expect(before.run).toBeNull();
    expect(existsSync(outDir('before'))).toBe(false);
  });

  it('runs once the same registration is on origin/main, every coin\'s manifest checked', () => {
    expect(after.guard).toMatchObject({ ok: true, reason: 'ok', registrationCommit: landedSha, originMain: landedSha });
    expect(Object.keys(after.guard.harnessSha256)).toEqual([...HTF_PINNED]);
    expect(after.guard.manifests.map((m) => [storePin(m.label), m.manifestSha256])).toEqual(Object.entries(manifests));
    expect(after.run).toMatchObject({ ok: true, reason: 'ok' });
    expect(Object.keys(after.run!.files).sort()).toEqual(['counts.csv', 'events.csv', 'sides.json']);
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
    expect(checkPanelGuard({ repo, registration: REG, store, panel: COINS }).ok).toBe(true);
  });
});

describe('the guard refuses code or candles the registration did not pin', () => {
  const refused = (name: string, r: ReturnType<typeof outcomeStepHtf>, reason: RegExp): void => {
    expect(r.guard.ok, name).toBe(false);
    expect(r.guard.reason).toMatch(reason);
    expect(r.run).toBeNull();
    expect(existsSync(outDir(name))).toBe(false);
  };

  it.each(HTF_PINNED.map((rel) => [rel]))('refuses when %s is not the registered file', { timeout: 60_000 }, (rel) => {
    const name = `changed-${path.basename(rel)}`;
    refused(name, withFile(path.join(repo, rel), (t) => `${t}\n`, () => step(name)), new RegExp(`${rel.replace(/[.]/g, '\\.')} is not the registered file`));
  });

  it('a local edit of the registration cannot move the pins', { timeout: 60_000 }, () => {
    const sources = path.join(repo, 'src/scripts/sr-htf/sources.ts');
    const edited = `${readFileSync(sources, 'utf8')}\n`;
    const r = withFile(sources, () => edited, () =>
      withFile(path.join(repo, REG), (t) => t.replace(sha256(readFileSync('src/scripts/sr-htf/sources.ts')), sha256(edited)), () => step('repinned')));
    refused('repinned', r, /sources\.ts is not the registered file/);
  });

  it('refuses a registration that pins no estimator, misses one coin\'s store, or pins another store', { timeout: 120_000 }, () => {
    refused('no-estimator', step('no-estimator', 'audits/no-estimator-pin.md'), /does not pin src\/scripts\/sr-htf\/sr_htf\.py/);
    refused('no-store', step('no-store', 'audits/no-store-pin.md'), /^S07: the registration does not pin store:manifest-BINANCE-S07\.json/);
    refused('other-store', step('other-store', 'audits/other-store.md'), /^S07: the store manifest is not the registered one/);
  });

  it('refuses when a manifest was rewritten, or a candle changed under an untouched manifest', { timeout: 120_000 }, () => {
    refused('manifest', withFile(manifestFile(store, planLabel('S11')), (t) => `${t} `, () => step('manifest')), /^S11: the store manifest is not the registered one/);
    const f = seriesFile(store, { exchange: VENUE, coin: 'S03', stepMs: tfOf('4h').stepMs });
    const change = (t: string): string => {
      const s = JSON.parse(t) as StoredSeries & { bars: number[][] };
      s.bars[400][5] += 1; // the volume alone
      return JSON.stringify(s);
    };
    refused('candle', withFile(f, change, () => step('candle')), /^S03: the candle files no longer match the store manifest/);
  });

  it('refuses a store with a hole, even when the registration pins its manifest', { timeout: 60_000 }, () => {
    refused('holed', step('holed', 'audits/holed-store.md', holed, ['S00', 'S01']), /^S01: the store manifest lists failed series/);
  });

  it('runs again once every change is undone', { timeout: 120_000 }, () => {
    expect(checkPanelGuard({ repo, registration: REG, store, panel: COINS })).toMatchObject({ ok: true, registrationCommit: landedSha });
  });

  it('refuses an empty panel: nothing guarded is never a pass', () => {
    expect(checkPanelGuard({ repo, registration: REG, store, panel: [] })).toMatchObject({ ok: false, reason: 'the panel is empty: no store manifest would be checked' });
    refused('empty-panel', step('empty-panel', REG, store, []), /the panel is empty/);
    expect(runPanel({ store, out: outDir('empty-run'), outcomes: false, guard: null, panel: [] })).toMatchObject({ ok: false, reason: 'the panel is empty: nothing would be read' });
  });
});

describe('the whole harness on a synthetic store with volume', () => {
  const read = (name: string): string => readFileSync(path.join(outDir('run'), name), 'utf8');
  const meta = (): Record<string, any> => JSON.parse(read('run-meta.json'));
  const landedAt = (deltaMs: number): string => new Date(Math.floor(Date.parse(meta().startedAt) / 1000) * 1000 + deltaMs).toISOString();
  const analyze = (run: string, name: string, landed: string | null): Promise<Ran> =>
    py(['--analyze', run, ...(landed ? ['--landed-at', landed] : []), '--out-md', path.join(dir, `${name}.md`), '--out-json', path.join(dir, `${name}.json`)]);
  const forged = (name: string, file: string, change: (text: string) => string): string => {
    const to = outDir(name);
    cpSync(outDir('run'), to, { recursive: true });
    writeFileSync(path.join(to, file), change(readFileSync(path.join(to, file), 'utf8')));
    return to;
  };

  it('writes the counts, the side mix, the paired events and what it ran on', () => {
    const m = meta();
    expect(m).toMatchObject({ wave: WAVE, mode: 'outcomes', venue: VENUE, startMs: STUDY_HTF.startMs, endMs: STUDY_HTF.endMs, holdoutStartMs: STUDY_HTF.holdoutStartMs, cells: ['1h', '4h'], descriptiveCell: '1d' });
    expect(m.coins.map((c: { coin: string; firstMs: number }) => [c.coin, c.firstMs])).toEqual(COINS.map((c) => [c, START]));
    expect(m.guard).toEqual(after.guard);
    expect(m.params).toEqual(JSON.parse(JSON.stringify(BT)));
    expect(m.hp).toEqual(JSON.parse(JSON.stringify(HP)));
    for (const [name, hash] of Object.entries(m.files as Record<string, string>)) expect(sha256(read(name)), name).toBe(hash);
    const counts = read('counts.csv').trimEnd().split('\n');
    expect(counts[0]).toBe(`key,tf,day,coin,${COLS.join(',')}`);
    const events = read('events.csv').trimEnd().split('\n');
    expect(events[0]).toBe(EVENTS_HEADER_HTF);
    const rows = counts.slice(1).map((l) => l.split(','));
    expect(new Set(rows.map((c) => `${c[0]}|${c[1]}`))).toEqual(new Set(['htf|1h', 'htf|4h', 'vpoc|1h', 'vpoc|4h', 'z1|1d']));
    expect(new Set(rows.filter((c) => c[0] === 'htf').map((c) => c[3]))).toEqual(new Set(COINS));
    // Every served zone is one event, and every event has its control.
    const total = (col: number): number => rows.reduce((a, c) => a + Number(c[4 + col]), 0);
    expect(total(0)).toBe(events.length - 1);
    expect(total(1)).toBe(total(0));
    const col = (name: string): number => EVENTS_HEADER_HTF.split(',').indexOf(name);
    const ev = events.slice(1).map((l) => l.split(','));
    expect(ev.filter((r) => r[col('s_entered')] === '1').length).toBe(total(2));
    expect(ev.filter((r) => r[col('s_outcome')] === 'bounce').length).toBe(total(3));
    expect(ev.filter((r) => r[col('c_entered')] === '1').length).toBe(total(5));
    expect(ev.filter((r) => r[col('c_outcome')] === 'bounce').length).toBe(total(6));
    expect(ev.filter((r) => r[col('forced')] === '1').length).toBe(total(8));
    // No instant before a coin's first evaluable one, none on or after the end, none whose horizon passes it.
    expect(ev.every((r) => Number(r[col('t')]) >= START && Number(r[col('t')]) < STUDY_HTF.endMs)).toBe(true);
  });

  it('refuses to write figures into the repository', () => {
    expect(runPanel({ store, out: 'audits/sr-htf-out', outcomes: true, guard: after.guard, panel: COINS })).toMatchObject({ ok: false, reason: expect.stringMatching(/inside the repository/) });
    expect(existsSync('audits/sr-htf-out')).toBe(false);
  });

  it('reads the run into one verdict line, three-state, with the landing before the read', { timeout: 300_000 }, async () => {
    const r = await analyze(outDir('run'), 'findings', landedAt(-60_000));
    const line = r.token('SR_HTF_VERDICT');
    expect(line).toMatch(/^(PASS|NULL|INDETERMINATE) — \S/);
    expect(r.out.match(/^SR_HTF_VERDICT=/gm)).toHaveLength(1);
    const j = JSON.parse(readFileSync(path.join(dir, 'findings.json'), 'utf8'));
    expect(`${j.verdict} — ${j.cause}`).toBe(line);
    expect(r.status).toBe(j.verdict === 'INDETERMINATE' ? 3 : 0);
    // Driftless walks: neither source beats its control. The verdict of this seeded store is pinned.
    expect(j.verdict).toBe('NULL');
    expect(j.cause).toBe('neither daily/weekly levels (htf) nor daily volume POCs (vpoc) bounce more than matched random zones by +3.0pp: both UTC-day 97.5% upper bounds are under +3.0pp');
    expect(j.stop_rule).toContain('S/R level construction closed (stop rule)');
    expect(r.out).toContain(`stop rule: ${j.stop_rule}`);
    // The CH2 gate's own expression.
    expect(/^(PASS|NULL|INDETERMINATE)$/.test(j.verdict) && Date.parse(j.registration_landed_at) < Date.parse(j.outcome_read_at)).toBe(true);
    expect(j).toMatchObject({ wave: WAVE, registration_commit: landedSha, harness_sha256: after.guard.harnessSha256, counts_sha256: after.run!.files['counts.csv'] });
    expect(j.manifests).toEqual(after.guard.manifests);
    // Each hypothesis three-state, every interval beside its cluster count.
    for (const h of ['H_A', 'H_B']) {
      expect(j[h].state, h).toMatch(/^(PASS|NULL|INDETERMINATE)$/);
      expect(j[h].day.clusters, h).toBeGreaterThanOrEqual(20);
      expect(j[h].coin.clusters, h).toBeGreaterThanOrEqual(20);
      expect(j[h].coin.clusters, h).toBeLessThanOrEqual(COINS.length);
      expect(j[h].day.lo).toBeLessThan(j[h].day.lo95);
      expect(j[h].day.hi).toBeGreaterThan(j[h].day.hi95);
      expect(typeof j[h].holdout, h).toBe('number');
      expect(j[h].identifiability.verdict, h).toBe('IDENTIFIABLE');
    }
    expect(Object.keys(j.per_cell)).toEqual(['htf', 'vpoc']);
    expect(Object.keys(j.per_cell.htf)).toEqual(['1h', '4h']);
    // The 1d cell: served and matched here, but four months of 1d instants leave no coin cell at 30 entered events.
    expect(j.descriptive_1d).toMatchObject({ arm: 'z1', cell: '1d', coin: null });
    expect(j.descriptive_1d.rates.served).toBeGreaterThan(0);
    expect(j.coverage.sources.htf.coins_with_a_served_zone).toBe(COINS.length);
    const md = readFileSync(path.join(dir, 'findings.md'), 'utf8');
    expect(md).toContain(`\`SR_HTF_VERDICT=${line}\``);
    expect(md).toMatch(/\(97\.5%\) · \d+ clusters/);
  });

  it('refuses a read that did not start after the landing', { timeout: 120_000 }, async () => {
    for (const [name, landed] of [['same-second', landedAt(0)], ['later', landedAt(3_600_000)]] as const) {
      const r = await analyze(outDir('run'), name, landed);
      expect(r.token('SR_HTF_ANALYZE_VERDICT'), name).toMatch(/^REFUSED — the registration landed at .* not before it$/);
      expect(r.status).toBe(3);
      expect(r.token('SR_HTF_VERDICT')).toBeNull();
      expect(existsSync(path.join(dir, `${name}.json`))).toBe(false);
    }
    expect((await analyze(outDir('run'), 'no-landing', null)).token('SR_HTF_ANALYZE_VERDICT')).toBe('REFUSED — --landed-at is required');
  });

  it('refuses a run that was not the guarded outcome run, or whose files changed', { timeout: 120_000 }, async () => {
    const skeleton = outDir('skeleton');
    expect(runPanel({ store, out: skeleton, outcomes: false, guard: null, panel: COINS.slice(0, 2) }).ok).toBe(true);
    expect(existsSync(path.join(skeleton, 'events.csv'))).toBe(false);
    const sk = readFileSync(path.join(skeleton, 'skeleton.csv'), 'utf8').trimEnd().split('\n').slice(1).map((l) => l.split(','));
    expect(sk.length).toBeGreaterThan(100);
    expect(sk.every((c) => c.slice(6, 12).every((v) => v === '0'))).toBe(true); // nothing resolved
    const cases: Array<[string, string, RegExp]> = [
      ['skeleton', skeleton, /the run is not a guarded outcome run/],
      ['unguarded', forged('unguarded', 'run-meta.json', (t) => JSON.stringify({ ...JSON.parse(t), guard: null })), /the run is not a guarded outcome run/],
      ['refused-guard', forged('refused-guard', 'run-meta.json', (t) => JSON.stringify({ ...JSON.parse(t), guard: { ...JSON.parse(t).guard, ok: false } })), /the run is not a guarded outcome run/],
      ['other-wave', forged('other-wave', 'run-meta.json', (t) => JSON.stringify({ ...JSON.parse(t), wave: 'EDGE-SR-LEVEL-BACKTEST-W1' })), /the run is not a guarded outcome run of this study/],
      ['counts', forged('counts', 'counts.csv', (t) => t.replace(/\n(htf,1h,\d+,S00),(\d+),/, '\n$1,9$2,')), /counts\.csv is not the file the run wrote/],
      ['other-code', forged('other-code', 'run-meta.json', (t) => t.replace(after.guard.harnessSha256['src/scripts/sr-htf/sources.ts'], '0'.repeat(64))), /sources\.ts changed since the outcome run/],
      ['nothing', path.join(dir, 'nowhere'), /the run directory is unreadable/],
    ];
    for (const [name, run, reason] of cases) {
      const r = await analyze(run, `refused-${name}`, landedAt(-60_000));
      expect(r.token('SR_HTF_ANALYZE_VERDICT'), name).toMatch(reason);
      expect(r.status, name).toBe(3);
      expect(r.token('SR_HTF_VERDICT'), name).toBeNull();
      expect(existsSync(path.join(dir, `refused-${name}.json`)), name).toBe(false);
    }
  });
});

describe('AC1.4 — no drift in the closed study', () => {
  it('its four sources through the registry reproduce the closed harness\'s counts byte for byte, on a synthetic store', { timeout: 300_000 }, () => {
    // The closed study's own store shape (version 1) and its own run, then the same store through the registry.
    const v1 = path.join(dir, 'store-v1');
    const startMs = Date.UTC(2024, 0, 1);
    const plan: StorePlan = { venue: VENUE, startMs, endMs: startMs + 110 * DAY, warmupBars: STUDY.warmupBars, panelSize: 3, panelAsOf: '2024-01-01T00:00:00.000Z', panelSource: 'synthetic', candidates: [], coins: ['A', 'B', 'C'] };
    for (const coin of plan.coins) {
      writeSeries(v1, plan, coin, synthCoin(coin, { seed: 11, key: `drift|${coin}`, firstMs: startMs - 300 * DAY, bars: 410 * 96 }), false);
    }
    writeFileSync(planFile(v1, VENUE), `${JSON.stringify(plan, null, 1)}\n`);
    expect(runStore({ store: v1, venue: VENUE, out: outDir('closed'), outcomes: true, guard: null }).ok).toBe(true);
    const four = new Set(['z1', 'floor', 'pdhl', 'rnd']);
    const closed = readFileSync(path.join(outDir('closed'), 'counts.csv'), 'utf8').trimEnd().split('\n');
    const want = `${[closed[0], ...closed.slice(1).filter((l) => four.has(l.split(',')[0]))].join('\n')}\n`;
    const tally = new Tally();
    for (const coin of plan.coins) {
      runRegistry({ coin, frames: loadVCoin(v1, plan, coin) }, { params: BT, startMs: plan.startMs, endMs: plan.endMs, timeframes: TIMEFRAMES, sources: Object.entries(REGISTERED), outcomes: true }, tally);
    }
    expect(tally.csv() === want).toBe(true);
    expect(want.split('\n').length).toBeGreaterThan(1000);
    const sides = JSON.parse(readFileSync(path.join(outDir('closed'), 'sides.json'), 'utf8')) as Record<string, number[]>;
    for (const k of four) expect(tally.sides.get(k), k).toEqual(sides[k]);
    expect(tally.instants).toBe(JSON.parse(readFileSync(path.join(outDir('closed'), 'run-meta.json'), 'utf8')).instants);
  });

  it('the closed calibration artifact and parity fixture are the bytes its registration pinned', () => {
    const reg = readdirSync('audits').filter((f) => /^sr-level-backtest-preregistration-\d{4}-\d{2}-\d{2}\.md$/.test(f));
    expect(reg).toHaveLength(1);
    const pins = pinsOf(readFileSync(path.join('audits', reg[0]), 'utf8'));
    for (const rel of ['scripts/sr-backtest/calibration.json', 'ops/sr-level-parity-fixture.json', 'src/scripts/sr-backtest/engine.ts', 'src/scripts/sr-backtest/run.ts']) {
      expect(pins.get(rel), rel).toBe(sha256(readFileSync(rel)));
    }
  });
});

describe('the estimator', () => {
  it('passes its own self-test', { timeout: 120_000 }, async () => {
    const r = await py(['--self-test']);
    expect(r.token('SR_HTF_SELFTEST_VERDICT')).toBe('PASS');
    expect(r.status).toBe(0);
  });

  it.each([
    ['swap-arms', /a reversal is NULL and named/],
    ['no-floor', /a tight \+1\.5pp is NULL, never PASS/],
    ['no-holdout', /a negative hold-out is INDETERMINATE/],
    ['no-coin', /a day read that passes with a coin-cluster point <= 0 is INDETERMINATE/],
    ['ci95', /the 97\.5% interval strictly contains the 95% one/],
  ] as const)('the self-test turns red when the logic is broken: %s', { timeout: 120_000 }, async (mutation, named) => {
    const r = await py(['--self-test'], { SR_HTF_MUTATE: mutation });
    expect(r.token('SR_HTF_SELFTEST_VERDICT')).toBe('FAIL');
    expect(r.status).toBe(1);
    expect(r.out).toMatch(named);
  });

  it('refuses a 97.5% interval that is not cluster_bootstrap_ols\'s own draws', { timeout: 120_000 }, async () => {
    const r = await py(['--self-test'], { SR_HTF_MUTATE: 'replay-seed' });
    expect(r.token('SR_HTF_SELFTEST_VERDICT')).toBe('FAIL');
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/is not cluster_bootstrap_ols's draws/);
  });

  it('holds the same frozen numbers as the harness', () => {
    const src = readFileSync(PY, 'utf8');
    const num = (name: string): number => Number(src.match(new RegExp(`^${name} = ([0-9_.]+)$`, 'm'))![1].replace(/_/g, ''));
    const tuple = (name: string): string[] => [...src.match(new RegExp(`^${name} = \\(([^)]*)\\)`, 'm'))![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect([num('MIN_ARM'), num('MIN_CLUSTERS'), num('BOOT_B'), num('DAY_MS')]).toEqual([STUDY.minArm, STUDY.minClusters, STUDY.bootstrapB, DAY]);
    expect([num('FLOOR_PP'), num('CI_LEVEL'), num('START_MS'), num('HOLDOUT_START_MS'), num('END_MS')]).toEqual([STUDY_HTF.floorPp, STUDY_HTF.ciLevel, STUDY_HTF.startMs, STUDY_HTF.holdoutStartMs, STUDY_HTF.endMs]);
    expect([num('CAL_MIN_REPS'), num('CAL_MIN_WALKS')]).toEqual([CALIBRATION_HTF.replications, CALIBRATION_HTF.walks]);
    expect(tuple('CELLS')).toEqual([...STUDY_HTF.cells]);
    expect(tuple('SOURCES')).toEqual(['htf', 'vpoc']);
    expect(src).toContain(`DESCRIPTIVE_CELL = "${STUDY_HTF.descriptiveCell}"`);
    expect(src).toContain(`WAVE = "${WAVE}"`);
  });
});

describe('AC1.5 — the null calibration', () => {
  const cal = (): Record<string, any> => JSON.parse(readFileSync(CAL, 'utf8'));
  const CALIBRATION_FILES = ['src/scripts/sr-probe/level-v0.ts', 'src/scripts/sr-backtest/spec.ts', 'src/scripts/sr-backtest/zones.ts', 'src/scripts/sr-backtest/engine.ts',
    'src/scripts/sr-backtest/synth.ts', 'src/scripts/sr-htf/config.ts', 'src/scripts/sr-htf/registry.ts', 'src/scripts/sr-htf/sources.ts', 'src/scripts/sr-htf/synthv.ts',
    'src/scripts/sr-htf/htf-run.ts', PY, 'scripts/sr-backtest/sr_backtest.py', 'src/scripts/cluster-perm-stats.py'];
  /** Two replications re-run here from the seed; the artifact holds all hundred, and the registered statistic is
   *  the hundred's. Two are enough to show the artifact is the generator's output and that the mutation is seen. */
  const SAMPLE = [1, 2];

  it('holds the registered lengths: at least 100 replications of at least 50 walks with volume', () => {
    expect(CALIBRATION_HTF).toMatchObject({ replications: 100, walks: 50, warmupDays: 300, evalDays: { '1h': 40, '4h': 60 }, seed: 20261113, volumeMax: 1000 });
    const c = cal();
    expect(c.replications).toBeGreaterThanOrEqual(100);
    expect(c.walks_per_replication).toBeGreaterThanOrEqual(50);
    expect(c.reps.map((r: any) => r.rep)).toEqual(Array.from({ length: c.replications }, (_, i) => i));
    expect(c.reps.every((r: any) => ['htf', 'vpoc'].every((k) => r[k].walks >= 50 && typeof r[k].delta_pp === 'number'))).toBe(true);
  });

  it('for each source, mean Δ within ±0.5pp and P(PASS) <= 0.05, recomputed from the replications', () => {
    const c = cal();
    for (const k of ['htf', 'vpoc']) {
      const ds: number[] = c.reps.map((r: any) => r[k].delta_pp);
      const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
      const passShare = c.reps.filter((r: any) => r[k].state === 'PASS').length / c.reps.length;
      expect(c.sources[k].mean_delta_pp, k).toBeCloseTo(mean, 9);
      expect(c.sources[k].pass_share, k).toBe(passShare);
      expect(Math.abs(mean), k).toBeLessThanOrEqual(0.5);
      expect(passShare, k).toBeLessThanOrEqual(0.05);
    }
    expect(c).toMatchObject({ verdict: 'PASS', tolerance_pp: 0.5, max_pass_share: 0.05, ci_level: 0.975, wave: WAVE });
  });

  it('was computed by the code in this checkout', () => {
    const c = cal();
    expect(Object.keys(c.harness_sha256).sort()).toEqual([...CALIBRATION_FILES].sort());
    for (const rel of CALIBRATION_FILES) expect(c.harness_sha256[rel], rel).toBe(sha256(readFileSync(rel)));
  });

  it('is reproduced from the seed, and the half-width control breaks it', { timeout: 600_000 }, async () => {
    const c = cal();
    const rows: string[][] = [];
    for (const rep of SAMPLE) {
      rows.push(calibrationRowsHtf(rep));
      await tick();
    }
    SAMPLE.forEach((rep, i) => expect(sha256(rows[i].join('\n')), `replication ${rep}`).toBe(c.reps[rep].rows_sha256));
    const csv = path.join(dir, 'cal-sample.csv');
    writeFileSync(csv, `${[CALIBRATION_HEADER_HTF, ...rows.flat()].join('\n')}\n`);
    const out = path.join(dir, 'cal-sample.json');
    const r = await py(['--calibrate', csv, '--min-reps', String(SAMPLE.length), '--out', out]);
    expect(jsonDiffs(JSON.parse(readFileSync(out, 'utf8')).reps, SAMPLE.map((rep) => c.reps[rep]))).toEqual([]);
    expect(r.token('SR_HTF_CALIBRATION_VERDICT')).toMatch(/^(PASS|FAIL)$/);
    // Under the registered floor of replications the same counts are not a verdict; nor is a file with no counts.
    const short = await py(['--calibrate', csv]);
    expect(short.token('SR_HTF_CALIBRATION_VERDICT')).toBe('INDETERMINATE');
    expect(short.status).toBe(3);
    const empty = path.join(dir, 'cal-empty.csv');
    for (const text of ['', `${CALIBRATION_HEADER_HTF}\n`]) {
      writeFileSync(empty, text);
      const none = await py(['--calibrate', empty]);
      expect(none.token('SR_HTF_CALIBRATION_VERDICT')).toBe('INDETERMINATE');
      expect(none.status).toBe(3);
    }
    // The mutation: a control half as wide as the served zone is entered less and bounces differently.
    const half = path.join(dir, 'cal-half.csv');
    await tick();
    writeFileSync(half, calibrationCsvHtf(SAMPLE[0], SAMPLE.length, { ...BT, controlWidthMult: 0.5 }));
    await tick();
    const broken = await py(['--calibrate', half, '--min-reps', String(SAMPLE.length)]);
    expect(broken.token('SR_HTF_CALIBRATION_VERDICT')).toBe('FAIL');
    expect(broken.status).toBe(1);
    const sources = JSON.parse(broken.out.split('\n')[0]).sources as Record<string, { mean_delta_pp: number; within_tolerance: boolean }>;
    expect(Object.values(sources).some((s) => !s.within_tolerance && Math.abs(s.mean_delta_pp) > 0.5)).toBe(true);
  });

  it.skipIf(!process.env.SR_HTF_FULL)('SR_HTF_FULL=1: every replication regenerates the committed artifact', { timeout: 3_600_000 }, async () => {
    const total = CALIBRATION_HTF.replications;
    const per = Math.ceil(total / Math.max(1, Math.min(8, os.availableParallelism() - 1)));
    const parts = Array.from({ length: Math.ceil(total / per) }, (_, i) => ({ from: i * per, reps: Math.min(per, total - i * per), file: path.join(dir, `cal-full-${i}.csv`) }));
    const made = await Promise.all(parts.map((p) => child('node_modules/.bin/tsx', [
      'src/scripts/sr-htf/htf-run.ts', '--calibrate', '--from', String(p.from), '--reps', String(p.reps), '--out', p.file, ...(p.from ? ['--no-header'] : []),
    ], 3_000_000)));
    expect(made.map((r) => [r.status, r.token('SR_HTF_RUN_VERDICT')])).toEqual(parts.map(() => [0, 'PASS']));
    const csv = path.join(dir, 'cal-full.csv');
    writeFileSync(csv, parts.map((p) => readFileSync(p.file, 'utf8')).join(''));
    const out = path.join(dir, 'cal-full.json');
    const r = await py(['--calibrate', csv, '--out', out]);
    expect([r.status, r.token('SR_HTF_CALIBRATION_VERDICT')]).toEqual([0, 'PASS']);
    expect(jsonDiffs(JSON.parse(readFileSync(out, 'utf8')), cal())).toEqual([]);
  });
});

describe('what was registered is what is run (AC1.6)', () => {
  const found = (): string[] => readdirSync('audits').filter((f) => /^sr-htf-levels-preregistration-\d{4}-\d{2}-\d{2}\.md$/.test(f));
  const text = (): string => readFileSync(path.join('audits', found()[0]), 'utf8');
  /** The two shared statistics libraries are other waves' files: the registration pins them and the outcome step
   *  enforces the pin when it runs, but a later edit of theirs must not turn this suite red. */
  const SHARED = ['src/scripts/cluster-perm-stats.py', 'ops/monitoring/population_comparison.py'];

  it('there is exactly one registration', () => {
    expect(found()).toHaveLength(1);
  });

  it('it pins every file whose bytes decide an outcome, every coin\'s store manifest and the calibration', () => {
    const p = pinsOf(text());
    for (const rel of [...HTF_PINNED, CAL, ...PANEL.map((c) => storePin(planLabel(c)))]) expect(p.get(rel), rel).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the pinned files are the files in this checkout', () => {
    const p = pinsOf(text());
    for (const rel of [...HTF_PINNED.filter((f) => !SHARED.includes(f)), CAL]) expect(p.get(rel), rel).toBe(sha256(readFileSync(rel)));
  });

  it('it states the frozen numbers the harness holds', () => {
    const block = text().match(/<!-- sr-htf:frozen -->\s*```json\n([\s\S]*?)\n```/);
    expect(block).not.toBeNull();
    expect(JSON.parse(block![1])).toEqual(JSON.parse(JSON.stringify({ params: BT, study: STUDY_HTF, hp: HP, calibration: CALIBRATION_HTF, panel: PANEL })));
  });
});

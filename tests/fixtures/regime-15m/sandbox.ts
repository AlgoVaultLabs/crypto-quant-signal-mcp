// tests/fixtures/regime-15m/sandbox.ts — EDGE-REGIME-15M-BACKTEST-W1: a sandbox repository with a bare origin, in
// which T3's harness reads its synthetic fit and the sibling then reads the same panel, behind its own guard.
//
// The sandbox holds copies of T3's harness files, the sibling's files and their library closure (the guard checks
// each against a pin), T3's registration with synthetic skeleton tables, and this study's registration. T3's fit
// read runs on a 130-day grid (fit window: the first 120 days) through T3's own `outcomeRun`; the sibling reads a
// 120-day grid built from monthly archives of the same synthetic walk, so its parity leg compares two different
// constructions of the same rows: T3's harness output and the sibling's recomputation. No real market data, no
// venue, and every seal lives inside the sandbox.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveManifestText, buildArchiveManifest, months, sha256, type ArchiveStore, type Grid } from '../../../src/scripts/regime-diag/archive.js';
import { MIN_MS, studyOf, type Span, type StudyRecord, type Win } from '../../../src/scripts/regime-diag/diag-spec.js';
import { buildFrames, skeletonOf, type Skeleton } from '../../../src/scripts/regime-diag/frame.js';
import * as t3guard from '../../../src/scripts/regime-diag/guard.js';
import * as t3run from '../../../src/scripts/regime-diag/run.js';
import { synthCsv, synthGrid } from '../../../src/scripts/regime-diag/synth.js';
import type { Seam } from '../../../src/scripts/regime-15m/r15-run.js';
import {
  ARCHIVES_PIN, CENSUS_PIN, CHECK_DIR, CHECK_MANIFEST, CHECK_PIN, CHECK_RESOLUTION_MIN, CHECK_VENUES, PINNED_REPO_FILES, T3_FIT_PIN, T3_REGISTRATION, WAVE, type CheckVenue,
} from '../../../src/scripts/regime-15m/r15-spec.js';
import type { CheckManifest, CoinRecord } from '../../../src/scripts/regime-15m/r15-venues.js';
import { zipSingle } from '../regime-diag/synth-study.js';
import { D, W_CENSUS, W_CENSUS_TEXT, W_KEYS, W_MONTHS, W_OPTS, W_SPAN, W_WIN, venueCsv, wMonthCsv } from './world.js';

const REPO = path.resolve(__dirname, '../../..');
export const T3 = studyOf('diag-2026-11-16') as StudyRecord;
/** T3's extra pins in its own sandbox (tests/unit/regime-diag-guard.test.ts). */
const T3_EXTRA = ['src/lib/market-regime-core.ts', 'src/scripts/cluster-perm-stats.py', 'ops/monitoring/population_comparison.py', 'src/scripts/sr-backtest/guard.ts', 'src/scripts/sr-backtest/store.ts'];
/** T3's grid in the sandbox: 130 days, its fit window the first 120 (the sibling's whole grid), its hold-out the rest. */
export const T3_SPAN: Span = Object.freeze({ t0Ms: W_SPAN.t0Ms, n: 130 * D });
export const T3_FIT: Win = Object.freeze({ name: 'fit', lo: 0, hi: 120 * D });
export const T3_HOLD: Win = Object.freeze({ name: 'holdout', lo: 120 * D, hi: 130 * D });
export const REGISTRATION_PATH = 'audits/regime-15m-backtest-preregistration-2026-11-27.md';

export const git = (repo: string, ...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** A pin section as a registration carries it. */
export const pinTable = (pins: Record<string, string>, extra = ''): string =>
  ['# A registration', '', '## Pinned artifacts', '', '| artifact | sha256 | role |', '|---|---|---|', ...Object.entries(pins).map(([k, v]) => `| \`${k}\` | \`${v}\` | pin |`), '', extra].join('\n');
const KEY_COLS: Record<string, number> = { '2a': 3, '2b': 2, '2c': 1, '2d': 2, '2e': 2 };
/** Tables 2a–2e as T3's registration carries them, rendered from a skeleton. */
export const tables = (sk: Skeleton): string => (Object.keys(KEY_COLS) as Array<keyof Skeleton>).map((id) => {
  const rows = Object.entries(sk[id]), width = KEY_COLS[id] + rows[0][1].length;
  return [`**Table ${id} — synthetic.**`, '', `|${' c |'.repeat(width)}`, `|${'---|'.repeat(width)}`,
    ...rows.map(([k, v]) => `| ${[...k.split('|'), ...v.map((x) => (x === null ? 'n/a' : String(x)))].join(' | ')} |`), ''].join('\n');
}).join('\n');

const t3grids = new Map<number, Grid | null>();
/** T3's loader in the sandbox: the same walk as the world's, on T3's longer grid. */
export function t3Load(pos: number): { g: Grid | null; noArchive: number } {
  if (!t3grids.has(pos)) { const o = W_OPTS[pos]; t3grids.set(pos, o ? synthGrid(T3_SPAN, W_KEYS[pos], o) : null); }
  return { g: t3grids.get(pos) as Grid | null, noArchive: t3grids.get(pos) ? 0 : 5 };
}

/** One check venue × coin: stored bars (from a walk of the venue's own), no bars in the window, or not listed. */
type Plan = Record<CheckVenue, Array<'bars' | 'no_bars_in_window' | 'not_listed'>>;
/** BYBIT reads both Binance positions (its twin is the main read); OKX one; BITGET one, and the position Binance lacks. */
export const CHECK_PLAN: Plan = { BYBIT: ['bars', 'bars', 'not_listed'], OKX: ['bars', 'no_bars_in_window', 'not_listed'], BITGET: ['bars', 'not_listed', 'bars'] };

export interface Sandbox {
  dir: string; repo: string; home: string;
  censusFile: string; archives: ArchiveStore; archiveManifest: string; t3Fit: string; seam: Seam;
  /** The sibling's pins as the sandbox registration records them. */
  pins: Record<string, string>;
  /** T3's fit result in the sandbox (its JSON). */
  t3Result: Record<string, unknown>;
  out: (name: string) => string;
  /** Lands what is committed. */
  push: () => void;
  /** Rewrites this study's registration, commits it, and (with `land`) pushes it. */
  writeRegistration: (text: string, land: boolean) => void;
}

/** Builds the sandbox: everything committed, this study's registration committed and not landed. */
export function makeSandbox(o: { B: number; F: number }): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-15m-sandbox-'));
  const repo = path.join(dir, 'repo'), home = path.join(dir, 'home'), censusFile = path.join(dir, 'census.json');
  for (const d of ['no-hooks', 't3cache', 't3overlay', 'cache', 'overlay', 't3store', 't3seal']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  git(dir, 'init', '-q', '--bare', '--initial-branch=main', 'origin.git');
  git(dir, 'init', '-q', '--initial-branch=main', 'repo');
  for (const [k, v] of [['user.email', 'sandbox@example.invalid'], ['user.name', 'sandbox'], ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(dir, 'no-hooks')]]) git(repo, 'config', k, v);
  git(repo, 'remote', 'add', 'origin', path.join(dir, 'origin.git'));
  fs.writeFileSync(path.join(repo, 'README.md'), 'sandbox\n');
  git(repo, 'add', 'README.md'); git(repo, 'commit', '-q', '-m', 'base'); git(repo, 'push', '-q', '-u', 'origin', 'main');

  const copied = [...new Set([...t3guard.HARNESS_FILES, ...T3_EXTRA, ...PINNED_REPO_FILES.filter((f) => f !== T3_REGISTRATION)])];
  for (const rel of copied) { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.cpSync(path.join(REPO, rel), path.join(repo, rel)); }
  fs.writeFileSync(censusFile, W_CENSUS_TEXT);

  // T3's store, its registration with the synthetic skeleton, landed; then T3's own fit read
  const t3archives: ArchiveStore = { cache: path.join(dir, 't3cache'), overlay: path.join(dir, 't3overlay') };
  fs.writeFileSync(path.join(t3archives.cache, 'SYNAUSDT-1m-2024-01.zip'), zipSingle('SYNAUSDT-1m-2024-01.csv', Buffer.from(synthCsv(T3_SPAN, 'store|a', { to: 120 }))));
  const made = t3guard.initStore(path.join(dir, 't3store'), t3archives, W_CENSUS.panel, T3);
  const t3pins: Record<string, string> = {};
  for (const rel of [...t3guard.HARNESS_FILES, ...T3_EXTRA]) t3pins[rel] = sha256(fs.readFileSync(path.join(repo, rel)));
  t3pins['store:manifest-BINANCE.json'] = made.guardStoreSha256;
  t3pins[t3guard.CENSUS_PIN] = sha256(W_CENSUS_TEXT);
  t3pins[t3guard.ARCHIVES_PIN] = made.archivesSha256;
  const sk = skeletonOf(buildFrames(T3_SPAN, [T3_FIT, T3_HOLD], W_CENSUS, t3Load, { outcomes: false, seed: T3.seed }));
  fs.mkdirSync(path.join(repo, 'audits'), { recursive: true });
  fs.writeFileSync(path.join(repo, T3_REGISTRATION), `${pinTable(t3pins)}\n${tables(sk)}`);
  for (const rel of [...copied, T3_REGISTRATION]) git(repo, 'add', rel);
  git(repo, 'commit', '-q', '-m', 'harness, sibling and T3 registration');
  git(repo, 'push', '-q', 'origin', 'main');
  const t3out = path.join(dir, 't3out');
  const r = t3run.outcomeRun({
    studyId: T3.id, mode: 'fit', repo, registration: T3_REGISTRATION, store: path.join(dir, 't3store'), censusFile, archives: t3archives, out: t3out,
    study: { span: T3_SPAN, fit: T3_FIT, holdout: T3_HOLD, load: t3Load, counts: () => ({ boot: o.B, shuffle: 20, perm: 20 }), floorClusters: o.F, log: () => undefined, sealHome: path.join(dir, 't3seal') },
  });
  if (r.verdict !== 'PASS' || !r.file) throw new Error(`the sandbox's T3 fit read did not run: ${r.verdict} ${r.reason}`);
  const t3Fit = r.file;

  // the sibling's archives (monthly zips of the same walk) and their manifest
  const archives: ArchiveStore = { cache: path.join(dir, 'cache'), overlay: path.join(dir, 'overlay') };
  W_CENSUS.panel.forEach((coin, pos) => {
    for (const ym of months(W_MONTHS.first, W_MONTHS.last)) {
      const csv = wMonthCsv(pos, ym);
      if (csv) fs.writeFileSync(path.join(archives.cache, `${coin}USDT-1m-${ym}.zip`), zipSingle(`${coin}USDT-1m-${ym}.csv`, Buffer.from(csv)));
    }
  });
  const archiveManifest = path.join(dir, 'archives-manifest.json');
  fs.writeFileSync(archiveManifest, archiveManifestText(buildArchiveManifest(archives, W_CENSUS.panel, W_MONTHS.first, W_MONTHS.last)));

  // the check venues' stored bars and their manifest, in the sandbox home
  const checkDir = path.join(home, CHECK_DIR);
  fs.mkdirSync(checkDir, { recursive: true });
  const iso = (ms: number): string => new Date(ms).toISOString();
  const venues = CHECK_VENUES.map((v) => {
    const R = CHECK_RESOLUTION_MIN[v];
    const coins: CoinRecord[] = W_CENSUS.panel.map((coin, i) => {
      const status = CHECK_PLAN[v][i];
      if (status !== 'bars') return { coin, position: i + 1, status };
      const text = venueCsv(`${v}|${coin}`, R, i === 1 ? 3 * D : 0, i === 1 ? 40 : 100), file = `${v}/${coin}-${R}m.csv`, lines = text.trim().split('\n');
      fs.mkdirSync(path.join(checkDir, v), { recursive: true });
      fs.writeFileSync(path.join(checkDir, file), text);
      return { coin, position: i + 1, status, first: iso(Number(lines[1].split(',')[0])), last: iso(Number(lines[lines.length - 1].split(',')[0])), rows: lines.length - 1, file, bytes: Buffer.byteLength(text), sha256: sha256(text) };
    });
    return { venue: v, resolution_min: R, pace_ms: 0, page_max: 0, coins, requests: 0, throttled: 0, transient: 0, started_at: iso(W_SPAN.t0Ms), finished_at: iso(W_SPAN.t0Ms), seconds: 0 };
  });
  const check: CheckManifest = { wave: WAVE, window: { from: iso(W_SPAN.t0Ms), to: iso(W_SPAN.t0Ms + W_SPAN.n * MIN_MS) }, census_sha256: sha256(W_CENSUS_TEXT), fetcher_sha256: '0'.repeat(64), venues };
  const checkText = `${JSON.stringify(check, null, 1)}\n`;
  fs.writeFileSync(path.join(checkDir, CHECK_MANIFEST), checkText);

  // this study's registration: every pinned repository file as copied, and the four inputs; committed, not landed
  const pins: Record<string, string> = {};
  for (const rel of PINNED_REPO_FILES) pins[rel] = sha256(fs.readFileSync(path.join(repo, rel)));
  pins[CENSUS_PIN] = sha256(W_CENSUS_TEXT);
  pins[ARCHIVES_PIN] = sha256(fs.readFileSync(archiveManifest));
  pins[T3_FIT_PIN] = sha256(fs.readFileSync(t3Fit));
  pins[CHECK_PIN] = sha256(checkText);
  const writeRegistration = (text: string, land: boolean): void => {
    fs.writeFileSync(path.join(repo, REGISTRATION_PATH), text);
    git(repo, 'add', REGISTRATION_PATH); git(repo, 'commit', '-q', '-m', 'registration');
    if (land) git(repo, 'push', '-q', 'origin', 'main');
  };
  writeRegistration(pinTable(pins), false);
  let n = 0;
  return {
    dir, repo, home, censusFile, archives, archiveManifest, t3Fit, pins, t3Result: JSON.parse(fs.readFileSync(t3Fit, 'utf8')) as Record<string, unknown>,
    seam: { span: W_SPAN, win: W_WIN, months: W_MONTHS, B: o.B, F: o.F },
    out: (name) => path.join(dir, `out-${name}-${++n}`),
    push: () => { git(repo, 'push', '-q', 'origin', 'main'); },
    writeRegistration,
  };
}

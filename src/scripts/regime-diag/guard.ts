// regime-diag/guard.ts — EDGE-REGIME-DIAG-W1: the outcome guard and the hold-out seal (registration §1).
//
// No outcome is computed unless every leg holds, and every call — pass or refusal — is appended to the study
// store's guard log:
//   (i)   the registration is on origin/main and its last commit is an ancestor of origin/main
//         (`checkOutcomeGuard`, src/scripts/sr-backtest/guard.ts, called unmodified);
//   (ii)  every file the registration pins, and every harness file, hashes to its pin on disk;
//   (iii) the archive-store manifest hashes to its pin and still describes the archives on disk;
//   (iv)  the census file hashes to its pin;
//   (v)   the core-parity fixture reproduces, label for label;
//   (vi)  for a hold-out run, the seal does not exist yet.
// The seal is created atomically, immediately before the hold-out is computed: it permits exactly one read and
// records it. The pins are read from the registration AS IT STANDS ON origin/main, never from the working tree.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { checkOutcomeGuard, pinsOf, storePin } from '../sr-backtest/guard.js';
import { buildManifest, manifestFile, manifestText, planFile, writeAtomic, type StorePlan } from '../sr-backtest/store.js';
import { archiveManifestText, buildArchiveManifest, sha256, type ArchiveStore } from './archive.js';
import { parseCensus } from './frame.js';
import { MUTATE } from './mutate.js';
import { PARITY_FIXTURE, checkCoreParity } from './parity.js';
import { PRIMS_PY } from './prims.js';
import { MIN_MS, SPAN, VENUE, WAVE } from './diag-spec.js';

/** Every file of the harness. The registration must pin each one; a test holds this list to the directory. */
export const HARNESS_FILES: readonly string[] = Object.freeze([
  ...['archive', 'bars', 'decide', 'diag-spec', 'engine', 'frame', 'guard', 'keys', 'labeler', 'mutate', 'parity', 'prims', 'replay', 'rng', 'run', 'stats', 'synth']
    .map((m) => `src/scripts/regime-diag/${m}.ts`),
  PRIMS_PY,
  PARITY_FIXTURE,
]);

export const CENSUS_PIN = 'census:regime-census-2026-11-16.json';
export const ARCHIVES_PIN = 'store:regime-diag-archives.json';
export const archivesFile = (store: string): string => path.join(store, 'regime-diag-archives.json');
export const sealFile = (store: string): string => path.join(store, 'holdout.seal');
export const guardLog = (store: string): string => path.join(store, 'guard.log');
const seenFile = (store: string): string => path.join(store, 'registration-seen.json');

/** Appends one line to the guard log. The store is outside the repository; the log never leaves it. */
export function logGuard(store: string, entry: Record<string, unknown>): void {
  fs.mkdirSync(store, { recursive: true });
  fs.appendFileSync(guardLog(store), `${JSON.stringify({ at: new Date().toISOString(), wave: WAVE, ...entry })}\n`);
}

/**
 * Writes the two manifests the registration pins: the archive-store manifest (every 1 m archive the panel
 * resolves to, with its sha256) and the guard's own store manifest, over an empty plan — this study reads no
 * candle store (§8, correction 7). Returns the two sha256 a pin section records. Computes no outcome.
 */
export function initStore(store: string, archives: ArchiveStore, panel: readonly string[]): { archivesSha256: string; guardStoreSha256: string; archiveFiles: number } {
  const m = buildArchiveManifest(archives, panel);
  writeAtomic(archivesFile(store), archiveManifestText(m));
  const plan: StorePlan = { venue: VENUE, startMs: SPAN.t0Ms, endMs: SPAN.t0Ms + SPAN.n * MIN_MS, warmupBars: 0, panelSize: 0, panelAsOf: '2026-11-16T00:00:00Z',
    panelSource: `${WAVE}: an empty plan — the study reads 1 m archives, pinned by ${ARCHIVES_PIN}`, candidates: [], coins: [] };
  writeAtomic(planFile(store, VENUE), `${JSON.stringify(plan, null, 1)}\n`);
  writeAtomic(manifestFile(store, VENUE), manifestText(buildManifest(store, plan)));
  return { archivesSha256: sha256(fs.readFileSync(archivesFile(store))), guardStoreSha256: sha256(fs.readFileSync(manifestFile(store, VENUE))), archiveFiles: m.files.length };
}

export interface DiagGuardInput {
  repo: string;
  /** Repo-relative path of the registration. */
  registration: string;
  /** The study's store directory (manifests, guard log, seal). Outside the repository. */
  store: string;
  censusFile: string;
  archives: ArchiveStore;
  mode: 'fit' | 'holdout';
}

export interface DiagGuardResult {
  ok: boolean;
  /** The leg that refused ('ok' when none did) and why. */
  leg: 'ok' | 'mutation' | 'registration' | 'pins' | 'census' | 'archives' | 'parity' | 'seal';
  reason: string;
  registrationCommit: string | null;
  originMain: string | null;
  /** The registration as it stands on origin/main (the skeleton tables are read from this text). */
  registrationText: string | null;
  /** sha256 of every pinned file on disk, and of the manifests and the census. */
  pins: Record<string, string>;
  /** The landing commit's own time, and the first instant this store saw that commit on origin/main. */
  landedAt: { commit_time: string; first_seen: string } | null;
}

const git = (repo: string, args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();

export function checkDiagGuard(input: DiagGuardInput): DiagGuardResult {
  const out: DiagGuardResult = { ok: false, leg: 'ok', reason: '', registrationCommit: null, originMain: null, registrationText: null, pins: {}, landedAt: null };
  const done = (leg: DiagGuardResult['leg'], reason: string): DiagGuardResult => {
    const r = { ...out, ok: leg === 'ok', leg, reason };
    logGuard(input.store, { mode: input.mode, ok: r.ok, leg, reason, registration: input.registration, registration_commit: r.registrationCommit, origin_main: r.originMain });
    return r;
  };
  if (MUTATE !== '') return done('mutation', `REGIME_DIAG_MUTATE is set (${MUTATE}): a deliberately broken harness computes no outcome`);

  // (i) + the harness files + the guard's own store manifest
  const base = { repo: input.repo, registration: input.registration, store: input.store, venue: VENUE };
  const first = checkOutcomeGuard({ ...base, pinned: HARNESS_FILES });
  out.registrationCommit = first.registrationCommit; out.originMain = first.originMain;
  if (!first.ok) return done(first.registrationCommit && first.originMain && !/not on origin\/main|not an ancestor/.test(first.reason) ? 'pins' : 'registration', first.reason);
  // (ii) every file row of the registration (§10 and the appended pin sections)
  const text = git(input.repo, ['show', `origin/main:${input.registration}`]);
  const pins = pinsOf(text);
  const fileRows = [...pins.keys()].filter((k) => !/^(store|census|spec):/.test(k));
  const second = checkOutcomeGuard({ ...base, pinned: fileRows, fetch: false });
  if (!second.ok) return done('pins', second.reason);
  if (second.registrationCommit !== first.registrationCommit || second.originMain !== first.originMain) return done('registration', 'origin/main moved while the guard ran');
  out.registrationText = text;
  out.pins = { ...first.harnessSha256, ...second.harnessSha256, [storePin(VENUE)]: second.manifestSha256 ?? '' };

  // (iv) the census
  const wantCensus = pins.get(CENSUS_PIN);
  if (!wantCensus) return done('census', `the registration does not pin ${CENSUS_PIN}`);
  if (!fs.existsSync(input.censusFile)) return done('census', 'the census file is absent');
  const censusBytes = fs.readFileSync(input.censusFile);
  out.pins[CENSUS_PIN] = sha256(censusBytes);
  if (out.pins[CENSUS_PIN] !== wantCensus) return done('census', `the census file is not the registered one (sha256 ${out.pins[CENSUS_PIN].slice(0, 12)}… on disk, ${wantCensus.slice(0, 12)}… registered)`);

  // (iii) the archive store
  const wantArchives = pins.get(ARCHIVES_PIN);
  if (!wantArchives) return done('archives', `the registration does not pin ${ARCHIVES_PIN}`);
  if (!fs.existsSync(archivesFile(input.store))) return done('archives', 'the archive-store manifest is absent');
  const manifest = fs.readFileSync(archivesFile(input.store), 'utf8');
  out.pins[ARCHIVES_PIN] = sha256(manifest);
  if (out.pins[ARCHIVES_PIN] !== wantArchives) return done('archives', `the archive-store manifest is not the registered one (sha256 ${out.pins[ARCHIVES_PIN].slice(0, 12)}… on disk, ${wantArchives.slice(0, 12)}… registered)`);
  let panel: string[];
  try { panel = parseCensus(censusBytes.toString('utf8')).panel; } catch { return done('census', 'the census file holds no panel'); }
  if (archiveManifestText(buildArchiveManifest(input.archives, panel)) !== manifest) return done('archives', 'the archives on disk no longer match the archive-store manifest');

  // (v) the core-parity fixture
  const parity = checkCoreParity(fs.readFileSync(path.join(input.repo, PARITY_FIXTURE), 'utf8'));
  if (!parity.ok) return done('parity', parity.reason);

  // (vi) the hold-out seal
  if (input.mode === 'holdout' && fs.existsSync(sealFile(input.store))) return done('seal', 'the hold-out seal exists: the hold-out has been read');

  // the two clocks' first half: the landing commit's time, and the first time this store saw it on origin/main
  const commit = first.registrationCommit as string;
  const seen: Record<string, string> = fs.existsSync(seenFile(input.store)) ? (JSON.parse(fs.readFileSync(seenFile(input.store), 'utf8')) as Record<string, string>) : {};
  if (!seen[commit]) { seen[commit] = new Date().toISOString(); writeAtomic(seenFile(input.store), `${JSON.stringify(seen, null, 1)}\n`); }
  out.landedAt = { commit_time: git(input.repo, ['show', '-s', '--format=%cI', commit]), first_seen: seen[commit] };
  return done('ok', 'ok');
}

/**
 * Claims the hold-out: creates the seal exclusively and writes the read's record into it. A second claim is
 * refused — the file exists. Called immediately before the hold-out's first outcome computation.
 */
export function claimSeal(store: string, record: Record<string, unknown>): { ok: boolean; reason: string } {
  let fd: number;
  try {
    fd = fs.openSync(sealFile(store), MUTATE === 'seal' ? 'w' : 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const reason = 'the hold-out seal exists: the hold-out has been read';
    logGuard(store, { mode: 'holdout', ok: false, leg: 'seal', reason });
    return { ok: false, reason };
  }
  try {
    fs.writeSync(fd, `${JSON.stringify({ wave: WAVE, ...record }, null, 1)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  logGuard(store, { mode: 'holdout', ok: true, leg: 'seal', reason: 'the hold-out seal was claimed' });
  return { ok: true, reason: 'ok' };
}

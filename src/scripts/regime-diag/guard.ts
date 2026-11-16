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
// records it. It has one place, which no argument of a run moves: a second store directory holds no second
// hold-out. The pins are read from the registration AS IT STANDS ON origin/main, never from the working tree.
//
// EDGE-REGIME-CONFIRM-W1: every leg is asked of the study the run names (`StudyRecord`). The seal home is one
// directory for every study, and each study has its own seal file in it: T3's `holdout.seal` keeps refusing T3,
// and a successor's read claims the successor's file. A study that carries a fit result has two more checks:
// its registration pins that result's sha256 (`CARRY_PIN`), and the months after its pinned archive manifest are
// verified at read time against the venue's `.CHECKSUM` files (leg iii); a coin-month without an archive is absent
// only by a checked probe record (`absentRefusal`), written by its own CLI (probe-absent.ts) on an HTTP 404.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkOutcomeGuard, pinsOf, storePin } from '../sr-backtest/guard.js';
import { buildManifest, manifestFile, manifestText, planFile, writeAtomic, type StorePlan } from '../sr-backtest/store.js';
import { archiveManifestText, archiveName, archiveUrl, buildArchiveManifest, months, resolveArchive, sha256, type ArchiveStore } from './archive.js';
import { parseCensus } from './frame.js';
import { MUTATE } from './mutate.js';
import { PARITY_FIXTURE, checkCoreParity } from './parity.js';
import { PRIMS_PY } from './prims.js';
import { MIN_MS, VENUE, type Carry, type StudyRecord } from './diag-spec.js';

/** Every file of the harness. The registration must pin each one; a test holds this list to the directory. */
export const HARNESS_FILES: readonly string[] = Object.freeze([
  ...['archive', 'bars', 'decide', 'diag-spec', 'engine', 'frame', 'guard', 'keys', 'labeler', 'mutate', 'parity', 'prims', 'probe-absent', 'replay', 'rng', 'run', 'stats', 'synth']
    .map((m) => `src/scripts/regime-diag/${m}.ts`),
  PRIMS_PY,
  PARITY_FIXTURE,
]);

export const CENSUS_PIN = 'census:regime-census-2026-11-16.json';
export const ARCHIVES_PIN = 'store:regime-diag-archives.json';
/** The fit result a successor carries, as its registration pins it. A sha256 row, not a file of the repository. */
export const CARRY_PIN = 'carry:regime-diag-fit.json';
/** The archives of the months after the pinned manifest, as verified at read time: recorded with the pins. */
export const LATER_PIN = 'archives:verified-at-read';
/** The census both studies read their panel and weights from: the as-of of the guard's empty plan. */
const CENSUS_AS_OF = '2026-11-16T00:00:00Z';
export const archivesFile = (store: string): string => path.join(store, 'regime-diag-archives.json');
/**
 * The seal home of the registered study: one directory, whatever store a run names. The home directory is read
 * from the user database, never from `HOME`, so no argument and no environment variable moves the seal.
 */
export const sealHome = (): string => path.join(os.userInfo().homedir, '.cache', 'algovault', 'regime-diag', 'store');
/** One seal file per study, in the one home: a study's read never claims, and is never refused by, another study's seal. */
export const sealFile = (home: string, study: Pick<StudyRecord, 'seal'>): string => path.join(home, MUTATE === 'studyseal' ? 'holdout.seal' : study.seal);
export const guardLog = (store: string): string => path.join(store, 'guard.log');
const seenFile = (store: string): string => path.join(store, 'registration-seen.json');

/** Appends one line to the guard log, under the wave of the study the run named (null when it named none). The store is outside the repository; the log never leaves it. */
export function logGuard(store: string, wave: string | null, entry: Record<string, unknown>): void {
  fs.mkdirSync(store, { recursive: true });
  fs.appendFileSync(guardLog(store), `${JSON.stringify({ at: new Date().toISOString(), wave, ...entry })}\n`);
}

/**
 * The carry-over: a study that carries a fit result accepts exactly one file, by sha256. Returns the refusal, or
 * null when `bytes` are that file.
 */
export const carryRefusal = (bytes: Buffer, carry: Carry): string | null =>
  MUTATE === 'carry' || sha256(bytes) === carry.sha256 ? null : `the fit result is not the one this study carries (sha256 ${sha256(bytes).slice(0, 12)}… read, ${carry.sha256.slice(0, 12)}… carried)`;

/**
 * Writes the two manifests the registration pins: the archive-store manifest (every 1 m archive the panel
 * resolves to, with its sha256) and the guard's own store manifest, over an empty plan — this study reads no
 * candle store (§8, correction 7). Returns the two sha256 a pin section records. Computes no outcome.
 */
export function initStore(store: string, archives: ArchiveStore, panel: readonly string[], study: StudyRecord): { archivesSha256: string; guardStoreSha256: string; archiveFiles: number } {
  const m = buildArchiveManifest(archives, panel, study.months.first, study.months.pinned);
  writeAtomic(archivesFile(store), archiveManifestText(m));
  const plan: StorePlan = { venue: VENUE, startMs: study.span.t0Ms, endMs: study.span.t0Ms + study.span.n * MIN_MS, warmupBars: 0, panelSize: 0, panelAsOf: CENSUS_AS_OF,
    panelSource: `${study.wave}: an empty plan — the study reads 1 m archives, pinned by ${ARCHIVES_PIN}`, candidates: [], coins: [] };
  writeAtomic(planFile(store, VENUE), `${JSON.stringify(plan, null, 1)}\n`);
  writeAtomic(manifestFile(store, VENUE), manifestText(buildManifest(store, plan)));
  return { archivesSha256: sha256(fs.readFileSync(archivesFile(store))), guardStoreSha256: sha256(fs.readFileSync(manifestFile(store, VENUE))), archiveFiles: m.files.length };
}

export interface DiagGuardInput {
  /** The study the run named. Every leg is asked of it. */
  study: StudyRecord;
  /** The sha256 of the fit result the run will accept, for a study that carries one; else null. */
  carry: string | null;
  repo: string;
  /** Repo-relative path of the registration. */
  registration: string;
  /** The study's store directory (manifests, guard log). Outside the repository. */
  store: string;
  /** The directory that holds the seals: `sealHome()` for a registered study. Never derived from `store`. */
  sealHome: string;
  censusFile: string;
  archives: ArchiveStore;
  mode: 'fit' | 'holdout';
}

export interface DiagGuardResult {
  ok: boolean;
  /** The leg that refused ('ok' when none did) and why. */
  leg: 'ok' | 'mutation' | 'registration' | 'pins' | 'carry' | 'census' | 'archives' | 'parity' | 'seal';
  reason: string;
  registrationCommit: string | null;
  originMain: string | null;
  /** The registration as it stands on origin/main (the skeleton tables are read from this text). */
  registrationText: string | null;
  /** sha256 of every pinned file on disk, and of the manifests and the census. */
  pins: Record<string, string>;
  /** The landing commit's own time, and the first instant this store saw that commit on origin/main. */
  landedAt: { commit_time: string; first_seen: string } | null;
  /** The archives of the months after the pinned manifest, verified at read time; null for a study with none. */
  later: LaterArchives | null;
}

export interface LaterArchives { files: Array<{ name: string; source: 'overlay' | 'cache'; bytes: number; sha256: string }>; absent: string[] }
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
/**
 * A probe record says the venue serves no archive of one coin-month: JSON `{url, status, probed_at}`, written by
 * probe-absent.ts. Returns the refusal, or null when `text` is that record: the URL is the one the harness derives
 * for the coin-month, the status is 404, and the probe ran on or after the registered read date — an earlier 404
 * may be a month the venue had not published yet. A file that merely exists is no record.
 */
function absentRefusal(text: string, name: string, url: string, notBeforeMs: number, notBefore: string): string | null {
  let v: unknown = null;
  try { v = JSON.parse(text); } catch { /* not JSON: not a record */ }
  const rec = v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  if (!rec || Object.keys(rec).sort().join() !== 'probed_at,status,url') return `${name}.ABSENT is not a probe record (JSON {url, status, probed_at})`;
  if (rec.url !== url) return `${name}.ABSENT records another URL than the venue's for this coin-month`;
  if (rec.status !== 404) return `${name}.ABSENT records HTTP ${JSON.stringify(rec.status)}, not 404`;
  const at = typeof rec.probed_at === 'string' && ISO_UTC.test(rec.probed_at) ? Date.parse(rec.probed_at) : Number.NaN;
  if (!Number.isFinite(at)) return `${name}.ABSENT holds no ISO UTC probe time`;
  if (!(at >= notBeforeMs)) return `${name}.ABSENT was probed before the registered read date (${notBefore})`;
  return null;
}

/**
 * Leg (iii) for the months a registration could not pin, because they did not exist: every archive is verified
 * against the venue's `<file>.CHECKSUM` beside it (fetched with it, at read time), and a coin-month without an
 * archive needs the probe's record that the venue serves none (`<file>.ABSENT`, `absentRefusal`): every record
 * found is checked. Anything else refuses: an incomplete download is never read as the named drop.
 *
 * "At read time" is checked, not assumed: an archive or a checksum written before the registered read date is a
 * file an earlier fetch left, and a reader that reuses a pair it finds would verify the old file against the old
 * checksum. Either one refuses, by name; the file read is the one dated (the overlay's, where the overlay holds it).
 */
export function checkLaterArchives(archives: ArchiveStore, panel: readonly string[], yms: readonly string[], notBefore: string | null): { ok: boolean; reason: string; later: LaterArchives } {
  const later: LaterArchives = { files: [], absent: [] };
  const no = (reason: string): { ok: boolean; reason: string; later: LaterArchives } => ({ ok: false, reason, later });
  const notBeforeMs = notBefore ? Date.parse(notBefore) : Number.NaN;
  if (!Number.isFinite(notBeforeMs)) return no('the study registers no read date to check a probe record against');
  for (const coin of panel) {
    for (const ym of yms) {
      const name = archiveName(coin, '1m', ym);
      const r = resolveArchive(archives, coin, '1m', ym);
      const records = [archives.overlay, archives.cache].map((d) => path.join(d, `${name}.ABSENT`)).filter((f) => fs.existsSync(f));
      const absent = records.length > 0;
      if (!r) {
        if (!absent) return no(`${name} is neither in the store nor recorded as absent at the venue (${name}.ABSENT)`);
        for (const f of records) {
          const why = absentRefusal(fs.readFileSync(f, 'utf8'), name, archiveUrl(coin, ym), notBeforeMs, notBefore as string);
          if (why) return no(why);
        }
        later.absent.push(name);
        continue;
      }
      if (absent) return no(`${name} is in the store and recorded as absent at the venue`);
      if (!fs.existsSync(`${r.file}.CHECKSUM`)) return no(`${name} has no venue checksum beside it (${name}.CHECKSUM)`);
      const want = fs.readFileSync(`${r.file}.CHECKSUM`, 'utf8').trim().split(/\s+/)[0].toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(want)) return no(`${name}.CHECKSUM holds no sha256`);
      const buf = fs.readFileSync(r.file), got = sha256(buf);
      if (got !== want) return no(`${name} is not the venue's file (sha256 ${got.slice(0, 12)}… on disk, ${want.slice(0, 12)}… in its checksum)`);
      for (const [f, n] of [[r.file, name], [`${r.file}.CHECKSUM`, `${name}.CHECKSUM`]]) {
        if (!(fs.statSync(f).mtimeMs >= notBeforeMs)) return no(`${n} was written before the registered read date (${notBefore as string}): it was not fetched for this read`);
      }
      later.files.push({ name, source: r.source, bytes: buf.length, sha256: got });
    }
  }
  return { ok: true, reason: 'ok', later };
}

const git = (repo: string, args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();

export function checkDiagGuard(input: DiagGuardInput): DiagGuardResult {
  const out: DiagGuardResult = { ok: false, leg: 'ok', reason: '', registrationCommit: null, originMain: null, registrationText: null, pins: {}, landedAt: null, later: null };
  const study = input.study;
  const done = (leg: DiagGuardResult['leg'], reason: string): DiagGuardResult => {
    const r = { ...out, ok: leg === 'ok', leg, reason };
    logGuard(input.store, study.wave, { mode: input.mode, ok: r.ok, leg, reason, registration: input.registration, registration_commit: r.registrationCommit, origin_main: r.originMain });
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
  const fileRows = [...pins.keys()].filter((k) => !/^(store|census|spec|carry):/.test(k));
  const second = checkOutcomeGuard({ ...base, pinned: fileRows, fetch: false });
  if (!second.ok) return done('pins', second.reason);
  if (second.registrationCommit !== first.registrationCommit || second.originMain !== first.originMain) return done('registration', 'origin/main moved while the guard ran');
  out.registrationText = text;
  out.pins = { ...first.harnessSha256, ...second.harnessSha256, [storePin(VENUE)]: second.manifestSha256 ?? '' };

  // the carried fit result: the registration pins the one the run will accept
  if (input.carry) {
    const pinned = pins.get(CARRY_PIN);
    if (!pinned) return done('carry', `the registration does not pin ${CARRY_PIN}`);
    if (pinned !== input.carry) return done('carry', `the registration pins another fit result (sha256 ${pinned.slice(0, 12)}…) than the one this study carries (${input.carry.slice(0, 12)}…)`);
    out.pins[CARRY_PIN] = pinned;
  }

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
  if (archiveManifestText(buildArchiveManifest(input.archives, panel, study.months.first, study.months.pinned)) !== manifest) return done('archives', 'the archives on disk no longer match the archive-store manifest');
  if (study.months.last !== study.months.pinned) {
    const v = checkLaterArchives(input.archives, panel, months(study.months.pinned, study.months.last).slice(1), study.notBefore);
    if (!v.ok) return done('archives', v.reason);
    out.later = v.later;
    out.pins[LATER_PIN] = sha256(JSON.stringify(v.later));
  }

  // (v) the core-parity fixture
  const parity = checkCoreParity(fs.readFileSync(path.join(input.repo, PARITY_FIXTURE), 'utf8'));
  if (!parity.ok) return done('parity', parity.reason);

  // (vi) the hold-out seal
  if (input.mode === 'holdout' && fs.existsSync(sealFile(input.sealHome, study))) return done('seal', 'the hold-out seal exists: the hold-out has been read');

  // the two clocks' first half: the landing commit's time, and the first time this store saw it on origin/main
  const commit = first.registrationCommit as string;
  const seen: Record<string, string> = fs.existsSync(seenFile(input.store)) ? (JSON.parse(fs.readFileSync(seenFile(input.store), 'utf8')) as Record<string, string>) : {};
  if (!seen[commit]) { seen[commit] = new Date().toISOString(); writeAtomic(seenFile(input.store), `${JSON.stringify(seen, null, 1)}\n`); }
  out.landedAt = { commit_time: git(input.repo, ['show', '-s', '--format=%cI', commit]), first_seen: seen[commit] };
  return done('ok', 'ok');
}

/**
 * Claims the study's hold-out: creates its seal exclusively in the home and writes the read's record into it. A
 * second claim is refused — the file exists — whatever store it comes from. Called immediately before the
 * hold-out's first outcome computation; the claim and the refusal are logged in the store of the run that made them.
 */
export function claimSeal(home: string, store: string, study: Pick<StudyRecord, 'seal' | 'wave'>, record: Record<string, unknown>): { ok: boolean; reason: string } {
  fs.mkdirSync(home, { recursive: true });
  let fd: number;
  try {
    fd = fs.openSync(sealFile(home, study), MUTATE === 'seal' ? 'w' : 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const reason = 'the hold-out seal exists: the hold-out has been read';
    logGuard(store, study.wave, { mode: 'holdout', ok: false, leg: 'seal', reason });
    return { ok: false, reason };
  }
  try {
    fs.writeSync(fd, `${JSON.stringify({ wave: study.wave, ...record }, null, 1)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  logGuard(store, study.wave, { mode: 'holdout', ok: true, leg: 'seal', reason: 'the hold-out seal was claimed' });
  return { ok: true, reason: 'ok' };
}

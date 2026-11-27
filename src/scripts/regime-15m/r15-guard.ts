// regime-15m/r15-guard.ts — EDGE-REGIME-15M-BACKTEST-W1: what the read proves before it reads an outcome, and the
// one-read seal (PROCEDURE §1; the arc's audit lessons 3–6 and 9–12, 18–19).
//
// Before the seal, in order, each a refusal that reads no outcome: the test-only levers; the source (HEAD landed on
// origin/main, no tracked change); the registration (exactly one on origin/main, the checkout's copy byte-equal);
// its pins (every sibling file, the library closure, the census, T3's archive manifest, T3's fit result, the check
// manifest); T3's harness unchanged against origin/main; the archives of 2024-01 … 2025-12 only, each byte checked
// against the manifest; the check venues' files against theirs; the seal (spent, or one rerun a landed §8 deviation
// authorizes); the output directory (outside the repository and outside ~/.cache/algovault, by identity), its
// write targets (no link, no second name) and a rehearsal of every write made after the seal. Then, label-only:
// the fit frame against T3's registered skeleton, and the floors written to disk. Then the memory plan. Then the
// seal. The read asks no venue at all: the check bars are on disk and pinned.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveName, emptyGrid, finishGrid, months, putCsv, resolveArchive, unzipSingle, type ArchiveManifest, type ArchiveStore } from '../regime-diag/archive.js';
import { N_CS, type Span } from '../regime-diag/diag-spec.js';
import { N_TF, diffSkeleton, registeredSkeleton, skeletonOf, type Frame, type Loaded, type Skeleton } from '../regime-diag/frame.js';
import { MUTATE as T3_MUTATE } from '../regime-diag/mutate.js';
import {
  CHECK_RESOLUTION_MIN, CHECK_VENUES, INPUT_PINS, LOG_FILE, MEMORY_GROWTH, MEMORY_OVERHEAD, MUTATE, OUT_FILES, PINNED_REPO_FILES, REGISTRATION_RE, RERUN_LINE_RE, RERUN_SEAL_FILE,
  SEAL_FILE, SIBLING_FILES, WAVE,
} from './r15-spec.js';
import { sealDirOf, sha256, type CheckManifest } from './r15-venues.js';

const git = (repo: string, args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();

/** This study's lever and T3's (its modules read REGIME_DIAG_MUTATE): either set refuses the read. */
export const leverRefusal = (lever: string = MUTATE, t3Lever: string = T3_MUTATE): string | null =>
  lever !== '' ? `the test-only lever REGIME_15M_MUTATE=${lever} is set` : t3Lever !== '' ? `T3's test-only lever REGIME_DIAG_MUTATE=${t3Lever} is set` : null;

/** The commit the read runs from: HEAD, an ancestor of origin/main, with no tracked change. */
export function sourceRefusal(repo: string): { commit: string | null; reason: string | null } {
  let commit: string;
  try {
    commit = git(repo, ['rev-parse', '--verify', 'HEAD']);
    git(repo, ['merge-base', '--is-ancestor', commit, 'origin/main']);
  } catch {
    return { commit: null, reason: 'HEAD is not on origin/main: the read runs a landed commit' };
  }
  if (git(repo, ['status', '--porcelain', '--untracked-files=no'])) return { commit, reason: 'the checkout has tracked changes: the read runs a landed commit as it was landed' };
  return { commit, reason: null };
}

export interface Registration { path: string; text: string; commit: string; commitTime: string; lastCommit: string; originMain: string }

/** The one registration on origin/main (fetched now), byte-equal to the checkout's copy, and the commit that landed it. */
export function registrationOf(repo: string, fetch = true): { reg: Registration | null; reason: string | null } {
  try {
    if (fetch) git(repo, ['fetch', '-q', 'origin']);
    const originMain = git(repo, ['rev-parse', '--verify', 'origin/main']);
    const names = git(repo, ['ls-tree', '-r', '--name-only', 'origin/main', '--', 'audits']).split('\n').filter((n) => REGISTRATION_RE.test(n));
    if (names.length !== 1) return { reg: null, reason: names.length ? `origin/main holds ${names.length} registrations of this study: the read takes one` : 'origin/main holds no registration of this study' };
    const p = names[0], text = git(repo, ['show', `origin/main:${p}`]);
    if (fs.readFileSync(path.join(repo, p), 'utf8').trim() !== text) return { reg: null, reason: 'the checkout\'s registration differs from origin/main' };
    const added = git(repo, ['log', '--diff-filter=A', '--format=%H', 'origin/main', '--', p]).split('\n').filter(Boolean);
    if (added.length !== 1) return { reg: null, reason: `the registration was added ${added.length} times on origin/main` };
    return { reg: { path: p, text, commit: added[0], commitTime: git(repo, ['show', '-s', '--format=%cI', added[0]]), lastCommit: git(repo, ['log', '-1', '--format=%H', 'origin/main', '--', p]), originMain }, reason: null };
  } catch (e) {
    return { reg: null, reason: `git: ${(e as Error).message.split('\n')[0]}` };
  }
}

/** `| \`name\` | \`<sha256>\` |` rows, in file order: a later row (an amendment's re-pin) replaces an earlier one. */
export function pinsOf(text: string): Map<string, string> {
  const pins = new Map<string, string>();
  for (const m of text.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`([0-9a-f]{64})`\s*\|/gm)) pins.set(m[1], m[2]);
  return pins;
}

/**
 * Every repository file the read's bytes depend on is pinned and is its pin; the sibling directory holds exactly
 * the pinned sibling files; every input is pinned at the sha256 the read was handed (`inputs`, by pin name).
 */
export function pinsRefusal(repo: string, text: string, inputs: Readonly<Record<string, string>>): string | null {
  const pins = pinsOf(text);
  for (const rel of PINNED_REPO_FILES) {
    const want = pins.get(rel), p = path.join(repo, rel);
    if (!want) return `the registration does not pin ${rel}`;
    if (!fs.existsSync(p)) return `the pinned file ${rel} is absent`;
    const have = sha256(fs.readFileSync(p));
    if (have !== want) return `${rel} is not the registered file (sha256 ${have.slice(0, 12)}… on disk, ${want.slice(0, 12)}… registered)`;
  }
  const listing = fs.readdirSync(path.join(repo, 'src/scripts/regime-15m')).sort();
  if (JSON.stringify(listing) !== JSON.stringify([...SIBLING_FILES])) return `src/scripts/regime-15m holds ${listing.join(', ')}: every file there is a pinned sibling file`;
  for (const pin of INPUT_PINS) {
    const want = pins.get(pin);
    if (!want) return `the registration does not pin ${pin}`;
    if (inputs[pin] !== want) return `${pin} is not the registered input (sha256 ${String(inputs[pin]).slice(0, 12)}… handed, ${want.slice(0, 12)}… registered)`;
  }
  return null;
}

/** T3's harness, unchanged against origin/main (the spec's gate leg, at the read too). */
export function harnessRefusal(repo: string): string | null {
  try { git(repo, ['diff', '--quiet', 'origin/main', '--', 'src/scripts/regime-diag', 'scripts/regime-diag']); return null; } catch { return 'T3\'s harness differs from origin/main: it is import-only'; }
}

/** The authorized rerun's reason, or null: a `RERUN_AUTHORIZED:` line in the registration as it stands on origin/main. */
export const rerunAuthorization = (text: string): string | null => RERUN_LINE_RE.exec(text)?.[1]?.trim() ?? null;

/**
 * Which read this is: the first, or the one rerun a landed §8 deviation authorizes (spec CH3, item 5). A seal home
 * that holds the first seal and no authorization, or both seals, refuses: the read is spent.
 */
export function sealState(home: string, text: string): { mode: 'first' | 'rerun' | null; reason: string | null } {
  const at = (f: string): boolean => fs.lstatSync(path.join(sealDirOf(home), f), { throwIfNoEntry: false }) !== undefined;
  if (!at(SEAL_FILE)) return at(RERUN_SEAL_FILE) ? { mode: null, reason: `${RERUN_SEAL_FILE} exists without ${SEAL_FILE}: the seal home is not one this read wrote` } : { mode: 'first', reason: null };
  if (at(RERUN_SEAL_FILE)) return { mode: null, reason: 'the read and its one rerun are spent' };
  if (!rerunAuthorization(text)) return { mode: null, reason: 'the seal exists: the read is spent, and the registration on origin/main authorizes no rerun' };
  return { mode: 'rerun', reason: null };
}

export interface Claim { claimed: boolean; reason: string | null }
/** Creates a seal exclusively. Once created it is claimed, whatever follows; a fault writing its record is returned, never thrown. */
export function claimSeal(home: string, file: string, record: Record<string, unknown>): Claim {
  const dir = sealDirOf(home);
  let fd: number;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fd = fs.openSync(path.join(dir, file), 'wx', 0o600);
  } catch (e) {
    return { claimed: false, reason: (e as NodeJS.ErrnoException).code === 'EEXIST' ? `${file} exists: the read is spent` : `seal: ${(e as Error).message}` };
  }
  let fault: string | null = null;
  try { fs.writeSync(fd, `${JSON.stringify({ wave: WAVE, ...record }, null, 1)}\n`); fs.fsyncSync(fd); } catch (e) { fault = `the seal record: ${(e as Error).message}`; } finally {
    try { fs.closeSync(fd); } catch (e) { fault ??= `the seal record: ${(e as Error).message}`; }
  }
  return { claimed: true, reason: fault };
}

// ── the archives: the window's months only, every byte checked ───────────────────────────────────────────────

export interface Months { first: string; last: string }
/** A month outside the window is never resolved, read or hashed (G3: no 2026 month is opened). */
export const monthRefusal = (ym: string, m: Months): string | null =>
  /^\d{4}-\d{2}$/.test(ym) && ym >= m.first && ym <= m.last ? null : `${ym} is outside ${m.first} … ${m.last}: the read opens no other month`;

/** The archive manifest's entry of every file the window resolves to, or why one is missing, extra or changed. */
export function archivesRefusal(store: ArchiveStore, manifest: ArchiveManifest, panel: readonly string[], m: Months): string | null {
  const want = new Map(manifest.files.map((f) => [f.name, f]));
  for (const coin of panel) {
    for (const ym of months(m.first, m.last)) {
      const why = monthRefusal(ym, m);
      if (why) return why;
      const name = archiveName(coin, '1m', ym), r = resolveArchive(store, coin, '1m', ym), pin = want.get(name);
      if (!r && !pin) continue;
      if (!r) return `${name} is in the archive manifest and not on disk`;
      if (!pin) return `${name} is on disk and not in the archive manifest`;
      if (pin.source !== r.source) return `${name} resolves to the ${r.source} store; the manifest records the ${pin.source}`;
      if (sha256(fs.readFileSync(r.file)) !== pin.sha256) return `${name} is not the registered archive`;
    }
  }
  return null;
}

export type Opened = Map<string, number>;
/**
 * One coin's 1 m grid from the window's months: each month asked of `monthRefusal` before it is resolved, each file's
 * bytes checked against the manifest and then parsed from those same bytes (T3's `buildGrid`, from a checked buffer).
 */
export function archiveLoader(store: ArchiveStore, manifest: ArchiveManifest, panel: readonly string[], span: Span, m: Months, opened: Opened): (pos: number) => Loaded {
  const want = new Map(manifest.files.map((f) => [f.name, f]));
  return (pos) => {
    const yms = months(m.first, m.last), g = emptyGrid(span);
    let n = 0;
    for (const ym of yms) {
      const why = monthRefusal(ym, m);
      if (why) throw new Error(`regime-15m: ${why}`);
      const r = resolveArchive(store, panel[pos], '1m', ym);
      if (!r) continue;
      const buf = fs.readFileSync(r.file), pin = want.get(path.basename(r.file));
      if (!pin || pin.sha256 !== sha256(buf)) throw new Error(`regime-15m: ${path.basename(r.file)} is not the registered archive`);
      g.counts.months++;
      putCsv(g, unzipSingle(buf).toString('latin1'));
      opened.set(ym, (opened.get(ym) ?? 0) + 1);
      n++;
    }
    return { g: n ? finishGrid(g) : null, noArchive: yms.length - n };
  };
}

/**
 * The check venues' stored bars against their manifest, before the seal: fetched for this census and window, one
 * record per venue at its registered resolution, one per panel coin, and every stored file the bytes it records.
 * The loader checks each file again when it parses it.
 */
export function checkRefusal(m: CheckManifest, dir: string, panel: readonly string[], census: string, window: { from: string; to: string }): string | null {
  if (m.wave !== WAVE) return 'the check manifest belongs to another wave';
  if (m.census_sha256 !== census) return 'the check bars were fetched for another census';
  if (m.window?.from !== window.from || m.window?.to !== window.to) return `the check bars cover ${m.window?.from} … ${m.window?.to}, not the window ${window.from} … ${window.to}`;
  if (m.venues.length !== CHECK_VENUES.length) return `the check manifest records ${m.venues.length} venues`;
  for (const v of CHECK_VENUES) {
    const rec = m.venues.find((x) => x.venue === v);
    if (!rec) return `the check manifest has no ${v} record`;
    if (rec.resolution_min !== CHECK_RESOLUTION_MIN[v]) return `${v} was fetched at ${rec.resolution_min} m, not the registered ${CHECK_RESOLUTION_MIN[v]} m`;
    if (rec.coins.length !== panel.length || panel.some((coin, i) => rec.coins[i]?.coin !== coin)) return `${v}'s records are not the panel, in its order`;
    for (const c of rec.coins) {
      if (c.status !== 'bars') continue;
      const parts = (c.file ?? '').split('/');
      if (parts.length !== 2 || parts[0] !== v || !/^[A-Za-z0-9._-]+$/.test(parts[1]) || parts[1].startsWith('.')) return `${v} P${c.position}: the record names no file of the venue's own directory`;
      const p = path.join(dir, v, parts[1]), why = targetRefusal(p);
      if (why || !fs.existsSync(p)) return `${v} P${c.position}: ${why ?? 'the stored file is absent'}`;
      if (sha256(fs.readFileSync(p)) !== c.sha256) return `${v} P${c.position}: the stored file is not the one the check manifest records`;
    }
  }
  return null;
}

/** The fit frame's label-free skeleton (Tables 2a–2e) against the fit rows T3's registration carries. */
export function skeletonRefusal(f: Frame, t3Registration: string): string | null {
  let want: Skeleton;
  try { want = registeredSkeleton(t3Registration); } catch (e) { return `skeleton: ${(e as Error).message}`; }
  const only = (sk: Skeleton): Skeleton =>
    Object.fromEntries(Object.entries(sk).map(([id, rows]) => [id, Object.fromEntries(Object.entries(rows).filter(([k]) => k.split('|').includes('fit')))])) as Skeleton;
  const d = diffSkeleton(only(skeletonOf([f])), only(want));
  return d.length ? `skeleton: ${d.length} cells differ from T3's registered fit tables — ${d.slice(0, 3).join('; ')}` : null;
}

// ── the output directory: containment by identity, its targets, the rehearsal ───────────────────────────────

/** A path with its existing part resolved through symlinks. */
function real(p: string): string {
  let head = path.resolve(p), tail = '';
  while (!fs.existsSync(head) && path.dirname(head) !== head) { tail = path.join(path.basename(head), tail); head = path.dirname(head); }
  return path.join(fs.realpathSync(head), tail);
}
const identity = (p: string): { dev: bigint; ino: bigint } | null => { try { const s = fs.statSync(p, { bigint: true }); return { dev: s.dev, ino: s.ino }; } catch { return null; } };
/**
 * Whether `p` is `root` or lies inside it: by spelling with symlinks resolved, or by identity — an ancestor of `p`
 * as written, or of `p` resolved, with `root`'s `{dev, ino}` (a case variant, a firmlink, a symlink to an alias).
 */
export function within(p: string, root: string): boolean {
  const rel = path.relative(real(root), real(p));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
  const want = identity(root);
  if (!want) return false;
  for (const start of [path.resolve(p), real(p)]) {
    for (let head = start; ; head = path.dirname(head)) {
      const id = identity(head);
      if (id && id.dev === want.dev && id.ino === want.ino) return true;
      if (path.dirname(head) === head) break;
    }
  }
  return false;
}

/**
 * Why `out` may not hold the read's outputs, or null: it must lie outside the repository and outside
 * `~/.cache/algovault` (every study's home, T3's stores and seal home, this study's seal and check bars), neither
 * inside nor holding any of them, and be absent, empty, or hold only the run log of reads it refused (a read's
 * outputs are never written over another's).
 */
export function outRefusal(out: string, repo: string, extraRoots: readonly string[] = []): string | null {
  const cache = path.join(os.userInfo().homedir, '.cache', 'algovault');
  for (const root of [repo, cache, ...extraRoots]) {
    if (within(out, root)) return `the output directory lies inside ${root}: the read writes outside the repository and outside ~/.cache/algovault`;
    if (within(root, out)) return `the output directory holds ${root}: the read never writes there`;
  }
  const s = fs.lstatSync(out, { throwIfNoEntry: false });
  if (s && (!s.isDirectory() || s.isSymbolicLink())) return 'the output path is not a directory';
  if (s && fs.readdirSync(out).some((n) => n !== LOG_FILE)) return 'the output directory holds files: a read never writes over another\'s outputs';
  // the run log a refused read left is appended to: never through a link, a directory or a second name
  const logWhy = s ? targetRefusal(path.join(out, LOG_FILE)) : null;
  if (logWhy) return `the output directory's run log: ${logWhy}`;
  return null;
}

/** A write target that is a link, not a regular file, or carries a second name is refused (every target, not its directory). */
export function targetRefusal(p: string): string | null {
  const s = fs.lstatSync(p, { throwIfNoEntry: false });
  if (!s) return null;
  if (s.isSymbolicLink()) return `${path.basename(p)} is a symbolic link`;
  if (!s.isFile()) return `${path.basename(p)} is not a regular file`;
  if (s.nlink > 1) return `${path.basename(p)} has ${s.nlink} names`;
  return null;
}

const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW } = fs.constants;
/** Appends one line to the run log, through a descriptor that refuses a link and a second name. Returns the refusal. */
export function logLine(out: string, entry: Record<string, unknown>, now: () => number = Date.now): string | null {
  try {
    const p = path.join(out, LOG_FILE), why = targetRefusal(p);
    if (why) return why;
    const fd = fs.openSync(p, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o600);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.nlink > 1) return `${LOG_FILE} is not a regular file of one name`;
      fs.writeSync(fd, `${JSON.stringify({ at: new Date(now()).toISOString(), wave: WAVE, ...entry })}\n`);
    } finally { fs.closeSync(fd); }
    return null;
  } catch (e) {
    return `${LOG_FILE}: ${(e as Error).message}`;
  }
}

/** Replaces `name` in `dir` through a temporary file and a rename: the one way an output is written. */
export function replaceFile(dir: string, name: string, text: string): void {
  const p = path.join(dir, name), why = targetRefusal(p);
  if (why) throw new Error(why);
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { flag: 'wx' });
  fs.renameSync(tmp, p);
}

/**
 * Every name written after the seal, written the same way before it: a creation and a replacement of each output
 * file, and two appends to the existing log. Returns the refusal; nothing is sealed when it is not null.
 */
export function rehearse(out: string, now: () => number = Date.now): string | null {
  try {
    fs.mkdirSync(out, { recursive: true });
    for (const n of [...OUT_FILES, LOG_FILE]) { const why = targetRefusal(path.join(out, n)); if (why) return why; }
    for (const n of OUT_FILES) { replaceFile(out, n, '{"rehearsal":1}\n'); replaceFile(out, n, '{"rehearsal":2}\n'); }
    for (const step of [1, 2]) { const why = logLine(out, { leg: 'rehearsal', step }, now); if (why) return why; }
    return null;
  } catch (e) {
    return `rehearsal: ${(e as Error).message}`;
  }
}

// ── the memory plan (lesson 19) ─────────────────────────────────────────────────────────────────────────────

/** Accumulator columns of the widest statistic (Δ1's paired comparison: two arms of 45 cells × 5 sums). */
export const ACC_COLS = 2 * 45 * 5;
/**
 * Bytes per row slot of a view (r15-frame.ts `viewOf`): `has` 1, four labels of label + confidence 8, `phase` 1, six
 * float columns 48, `slope` 1, `structure` 1, `age` 4.
 */
export const VIEW_ROW_BYTES = 1 + 4 * 2 + 1 + 6 * 8 + 1 + 1 + 4;
/** Bytes per entry of the outcome table: 90 cell-sides of one path label and four float baselines. */
export const CELL_BYTES = N_CS * (1 + 4 * 8);
export interface Sized { bytes: number; nE: number; clusters: number }
export interface MemoryPlan { bytes: number; parts: Record<string, number> }
/**
 * What one run holds at its widest: its label-only frame and 15m rows, its outcome table, two views (the paired
 * reading's), and the per-cluster accumulators of its widest statistic, plus the runtime's overhead. Runs are read
 * one after another and each is released before the next, so the read's peak is its widest run. `runs` are the
 * runs built before the seal; `bound` is the largest a run built after it can be (a check venue or its twin).
 * Counted from the arrays' layouts, never from a run, then scaled by the measured growth of the peak over them.
 */
export function memoryPlan(runs: readonly Sized[], bound: Sized | null = null): MemoryPlan {
  const one = (r: Sized): number => r.bytes + r.nE * CELL_BYTES + 2 * r.nE * N_TF * VIEW_ROW_BYTES + 2 * r.clusters * ACC_COLS * 8;
  const all = bound ? [...runs, bound] : [...runs];
  const widest = Math.max(0, ...all.map(one));
  return { bytes: MEMORY_GROWTH * widest + MEMORY_OVERHEAD, parts: { widest_run: widest, growth: MEMORY_GROWTH, overhead: MEMORY_OVERHEAD, runs: all.length } };
}
export const memoryRefusal = (plan: MemoryPlan, budget: number): string | null =>
  (plan.bytes > budget ? `the read's memory estimate is ${plan.bytes} B, above the budget of ${budget} B: it would not finish on this host, so it does not start` : null);

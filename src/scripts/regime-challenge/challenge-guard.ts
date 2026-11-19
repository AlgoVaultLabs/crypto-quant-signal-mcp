// regime-challenge/challenge-guard.ts — EDGE-REGIME-CHALLENGE-R1-W1: what a run opens, and what it checks before any outcome.
//
// A record's loader opens the archives of the record's own months and no other: each month is asked of
// `monthRefusal` before its file is touched, and every month opened goes on the run's record. The label-free
// checks sit here too: the archives against the registered manifest, the frame against T3's registered tables
// (T3 §2), the source against origin/main. None of them reads an outcome.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveName, buildGrid, resolveArchive, sha256, type ArchiveManifest, type ArchiveStore } from '../regime-diag/archive.js';
import { diffSkeleton, registeredSkeleton, skeletonOf, type Frame, type Loaded, type Skeleton } from '../regime-diag/frame.js';
import { monthRefusal, monthsOpened, type ChallengeRecord } from './challenge-spec.js';

/** A path with its existing part resolved through symlinks (run.ts keeps its own copy private). */
export function real(p: string): string {
  let head = path.resolve(p), tail = '';
  while (!fs.existsSync(head) && path.dirname(head) !== head) { tail = path.join(path.basename(head), tail); head = path.dirname(head); }
  return path.join(fs.realpathSync(head), tail);
}
/** The `{dev, ino}` of an existing path, or null. */
function identity(p: string): { dev: bigint; ino: bigint } | null {
  try { const s = fs.statSync(p, { bigint: true }); return { dev: s.dev, ino: s.ino }; } catch { return null; }
}
/**
 * Whether `p` is `root` or lies inside it. Two checks, and either one counts: the spelling, with symlinks resolved;
 * and identity, an existing ancestor of `p` (or `p` itself) being the directory `root` is (the same `{dev, ino}`).
 * Spelling alone misses another name of the same directory: a case variant on a case-insensitive volume, or the
 * macOS firmlink `/System/Volumes/Data/…` (registration Amendment 2, F4). Identity walks the ancestors of `p` as
 * written AND of `p` with its symlinks resolved: a symlink outside `root` whose target is such another name of a
 * directory inside it has neither the spelling nor, as written, the identity (Amendment 3, F5). A `root` that does
 * not exist has no identity, and only the spelling speaks for it.
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
 * The directories no run of the rounds writes into (EDGE-REGIME-CHALLENGE-R2-W1, review finding #2): the seal home
 * (`home`; absent for a synthetic study that names none), round 1's tree, T3's two archive stores — each under the
 * home the code resolves for the user (`os.userInfo`, as `sealHome()` does) — and the archive stores the run reads.
 * Round 1's own runs (`roundOneTree` false) write in round 1's tree, so for them it is not one.
 */
export function protectedRoots(home: string | undefined, archives: ArchiveStore, roundOneTree: boolean): Array<{ what: string; root: string }> {
  const cache = path.join(os.userInfo().homedir, '.cache', 'algovault');
  return [
    ...(home ? [{ what: 'the seal home', root: home }] : []),
    ...(roundOneTree ? [{ what: 'round 1\'s tree', root: path.join(cache, 'regime-challenge') }] : []),
    { what: 'T3\'s archive store', root: path.join(cache, 'odds-calibration-study') },
    { what: 'T3\'s archive store', root: path.join(cache, 'regime-diag', 'archives') },
    { what: 'an archive store the run reads', root: archives.cache },
    { what: 'an archive store the run reads', root: archives.overlay },
  ];
}
/**
 * Why `out` may not be a run's output directory, or null: it is one of `roots`, lies inside one, or holds one —
 * each decided by `within`, so by identity after every resolution step, never by spelling alone.
 */
export function outRefusal(out: string, roots: ReadonlyArray<{ what: string; root: string }>): string | null {
  for (const { what, root } of roots) {
    if (within(out, root)) return `the output directory is ${what} or lies inside it: no run writes there`;
    if (within(root, out)) return `the output directory holds ${what}: no run writes there`;
  }
  return null;
}

/**
 * Why a run may not write into `dir`, or null (Amendment 3, F6). `within()` holds the directory, and the run then
 * writes fixed names inside it; each write follows a link at the last component — a symlink, live or dangling, to
 * its target, and a hard link to the bytes of every other name of the file. So a name the run writes (`names`; with
 * none, every entry below `dir`) must not be a symlink, nor a non-directory of more than one link. Asked once,
 * before the run's first write: against operator error, not against a writer working beside the run.
 */
export function linkRefusal(dir: string, what: string, names?: readonly string[]): string | null {
  const list = (rel: string): string[] => fs.readdirSync(path.join(dir, rel)).sort().map((n) => path.join(rel, n));
  const todo = names ? [...names] : fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? list('') : [];
  while (todo.length) {
    const rel = todo.shift() as string, s = fs.lstatSync(path.join(dir, rel), { throwIfNoEntry: false });
    const kind = !s ? null : s.isSymbolicLink() ? 'a symlink' : !s.isDirectory() && s.nlink > 1 ? 'a hard link' : null;
    if (kind) return `${what}'s ${rel} is ${kind}: the run writes its files there only in place, never through a link`;
    if (s?.isDirectory() && !names) todo.push(...list(rel));
  }
  return null;
}

/**
 * Why a name the run writes in `dir` cannot be written there in place, or null (Amendment 4, F7). Each of `names`
 * is absent, or a plain file the run can write: a directory, or a file the run may not write, at a name the judge
 * writes only after its seal would throw there and spend the one read. Asked with `linkRefusal`, once, before the
 * run's first write: against operator error, not against a full disk or a writer working beside the run.
 */
export function writableRefusal(dir: string, what: string, names: readonly string[]): string | null {
  for (const rel of names) {
    const p = path.join(dir, rel), s = fs.lstatSync(p, { throwIfNoEntry: false });
    if (!s) continue;
    let kind = s.isFile() ? null : s.isDirectory() ? 'a directory' : 'not a plain file';
    if (!kind) try { fs.accessSync(p, fs.constants.W_OK); } catch { kind = 'a file the run cannot write'; }
    if (kind) return `${what}'s ${rel} is ${kind}: a name the run writes there must be absent, or a plain file the run can write`;
  }
  return null;
}

/** The archive months a run opened, and how many files of each. */
export type Opened = Map<string, number>;

/**
 * The loader of a record: one coin's grid, from the archives of the record's months only. A month the record may
 * not open throws before its file is resolved — the refusal is the code's, not the caller's care.
 */
export function recordLoader(rec: ChallengeRecord, archives: ArchiveStore, panel: readonly string[], opened: Opened): (pos: number) => Loaded {
  return (pos) => {
    const yms = monthsOpened(rec), files: string[] = [];
    for (const ym of yms) {
      const why = monthRefusal(rec, ym, 'archive');
      if (why) throw new Error(`regime-challenge: ${why}`);
      const r = resolveArchive(archives, panel[pos], '1m', ym);
      if (!r) continue;
      files.push(r.file);
      opened.set(ym, (opened.get(ym) ?? 0) + 1);
    }
    return { g: files.length ? buildGrid(rec.span, files) : null, noArchive: yms.length - files.length };
  };
}

/**
 * Why the archives of a record's months are not the registered ones, or null when they are: every archive on
 * disk is in the manifest with its sha256, and every manifest entry of those months is on disk.
 */
export function archivesRefusal(rec: ChallengeRecord, archives: ArchiveStore, panel: readonly string[], manifest: ArchiveManifest): string | null {
  const want = new Map(manifest.files.map((f) => [f.name, f.sha256]));
  for (const coin of panel) {
    for (const ym of monthsOpened(rec)) {
      const name = archiveName(coin, '1m', ym), r = resolveArchive(archives, coin, '1m', ym), pin = want.get(name);
      if (!r && !pin) continue;
      if (!r) return `${name} is in the registered archive manifest and not on disk`;
      if (!pin) return `${name} is on disk and not in the registered archive manifest`;
      if (sha256(fs.readFileSync(r.file)) !== pin) return `${name} is not the registered archive`;
    }
  }
  return null;
}

const WIN_NAME: Record<string, string> = { fit: 'fit', holdout: 'hold-out' };
/**
 * Why a frame is not the registered one, or null when it is: its label-free skeleton (Tables 2a–2e) equals the
 * rows of its window in `tables` — T3's registration, which registered both windows before either was read.
 */
export function skeletonRefusal(f: Frame, tables: string): string | null {
  let want: Skeleton;
  try { want = registeredSkeleton(tables); } catch (e) { return `skeleton: ${e instanceof Error ? e.message : String(e)}`; }
  const w = WIN_NAME[f.win.name];
  const only = (sk: Skeleton): Skeleton =>
    Object.fromEntries(Object.entries(sk).map(([id, rows]) => [id, Object.fromEntries(Object.entries(rows).filter(([k]) => k.split('|').includes(w)))])) as Skeleton;
  const d = diffSkeleton(only(skeletonOf([f])), only(want));
  return d.length ? `skeleton: ${d.length} cells differ from the registered ${w} tables — ${d.slice(0, 3).join('; ')}` : null;
}

const git = (repo: string, args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();

/** The commit a run reads its code from: HEAD, landed (an ancestor of origin/main) and with no tracked change. */
export function landedSource(repo: string): { ok: boolean; commit: string | null; reason: string } {
  let commit: string;
  try {
    commit = git(repo, ['rev-parse', '--verify', 'HEAD']);
    git(repo, ['merge-base', '--is-ancestor', commit, 'origin/main']);
  } catch {
    return { ok: false, commit: null, reason: 'HEAD is not on origin/main: the run reads a landed commit' };
  }
  const dirty = git(repo, ['status', '--porcelain', '--untracked-files=no']);
  return dirty ? { ok: false, commit, reason: 'the checkout has tracked changes: the run reads a landed commit as it was landed' } : { ok: true, commit, reason: 'ok' };
}

/** The one judge registration on origin/main, by its name. Zero, or more than one, is no registration. */
export function registrationOnMain(repo: string, pattern: RegExp): { path: string | null; reason: string } {
  let names: string[];
  try {
    git(repo, ['fetch', '-q', 'origin']);
    names = git(repo, ['ls-tree', '-r', '--name-only', 'origin/main', '--', 'audits']).split('\n').filter((n) => pattern.test(n));
  } catch {
    return { path: null, reason: 'origin could not be read, so no registration can be shown to be on origin/main' };
  }
  if (names.length !== 1) return { path: null, reason: names.length ? `origin/main holds ${names.length} judge registrations: the judge reads one` : 'origin/main holds no judge registration' };
  return { path: names[0], reason: 'ok' };
}

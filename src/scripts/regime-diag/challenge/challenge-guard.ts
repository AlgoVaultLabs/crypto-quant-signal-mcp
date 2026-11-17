// regime-diag/challenge/challenge-guard.ts — EDGE-REGIME-CHALLENGE-R1-W1: what a run opens, and what it checks before any outcome.
//
// A record's loader opens the archives of the record's own months and no other: each month is asked of
// `monthRefusal` before its file is touched, and every month opened goes on the run's record. The label-free
// checks sit here too: the archives against the registered manifest, the frame against T3's registered tables
// (T3 §2), the source against origin/main. None of them reads an outcome.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { archiveName, buildGrid, resolveArchive, sha256, type ArchiveManifest, type ArchiveStore } from '../archive.js';
import { diffSkeleton, registeredSkeleton, skeletonOf, type Frame, type Loaded, type Skeleton } from '../frame.js';
import { monthRefusal, monthsOpened, type ChallengeRecord } from './challenge-spec.js';

/** A path with its existing part resolved through symlinks (run.ts keeps its own copy private). */
export function real(p: string): string {
  let head = path.resolve(p), tail = '';
  while (!fs.existsSync(head) && path.dirname(head) !== head) { tail = path.join(path.basename(head), tail); head = path.dirname(head); }
  return path.join(fs.realpathSync(head), tail);
}
export const within = (p: string, root: string): boolean => { const rel = path.relative(real(root), real(p)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

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

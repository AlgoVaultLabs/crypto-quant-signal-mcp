// regime-forward/forward-guard.ts — EDGE-REGIME-FORWARD-W1: everything the read must prove before it reads a bar.
//
// Order of a read (registration §1): lever → clock → the home's identity → a seal that exists (a spent read writes
// and asks nothing) → source → registration on origin/main, its pins and the served code's fingerprint → census →
// the host read's PASS record and the files' sha256 → the label-only floors on disk → every bar fetched into the
// home's store and its manifest logged → the rehearsal of every write the read makes after the seal → the seal.
// After the seal no venue is asked. The first four refusals print the token and write nothing; from the source leg
// on, a refusal is also appended to the home's run log, through a descriptor that refuses a link or a second name.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pinsOf } from '../sr-backtest/guard.js';
import { sealHome as t3SealHome } from '../regime-diag/guard.js';
import { MUTATE as T3_MUTATE } from '../regime-diag/mutate.js';
import { MUTATE, NOT_BEFORE_MS, REGISTRATION, WAVE } from './forward-spec.js';

/** The read's one home: from the user database, never from an argument or HOME. Seal, run log and result live here. */
export const forwardHome = (): string => path.join(os.userInfo().homedir, '.cache', 'algovault', 'regime-forward');
export const SEAL = 'forward.seal';
export const RESULT = 'regime-forward-result.json';
export const LOG = 'run.log';
export const FLOORS = 'label-floors.json';

export const sha256 = (b: Buffer | string): string => crypto.createHash('sha256').update(b).digest('hex');

/** The home and its parents, created owner-only when absent. */
export const makeHome = (home: string): void => { fs.mkdirSync(home, { recursive: true, mode: 0o700 }); };

/** True when anything — a file, a directory, a link, even a dangling one — sits at `p`. */
export const entryExists = (p: string): boolean => { try { fs.lstatSync(p); return true; } catch { return false; } };

const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW } = fs.constants;

/**
 * Appends one line to the home's run log (lesson 11: an append is a write). The name is refused when it is a link,
 * not a regular file, or carries a second name, and the descriptor is opened with O_NOFOLLOW and checked again by
 * fstat. Returns the refusal, never throws: the caller stops the read with its token (CH3 F3).
 */
export function log(home: string, entry: Record<string, unknown>): string | null {
  try {
    makeHome(home);
    const p = path.join(home, LOG), why = targetRefusal(p);
    if (why) return why;
    const fd = fs.openSync(p, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o600);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return `${LOG} is not a regular file`;
      if (st.nlink > 1) return `${LOG} has ${st.nlink} names`;
      fs.writeSync(fd, `${JSON.stringify({ at: new Date().toISOString(), wave: WAVE, ...entry })}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return null;
  } catch (e) {
    return `${LOG}: ${(e as Error).message}`;
  }
}

export const clockRefusal = (nowMs: number): string | null =>
  nowMs >= NOT_BEFORE_MS || MUTATE === 'clock' ? null : `now ${new Date(nowMs).toISOString()} is before not_before ${new Date(NOT_BEFORE_MS).toISOString()}`;

/** T5's lever, and T3's (its modules read REGIME_DIAG_MUTATE): either set refuses the read. */
export const leverRefusal = (lever: string = MUTATE, t3Lever: string = T3_MUTATE): string | null =>
  lever !== '' ? `the test-only lever REGIME_FORWARD_MUTATE=${lever} is set` : t3Lever !== '' ? `T3's test-only lever REGIME_DIAG_MUTATE=${t3Lever} is set` : null;

const git = (repo: string, args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export interface Landed { commit: string; commitTime: string; firstSeen: string }

/**
 * The registration is on origin/main (fetched now), the checkout's copy is that file byte for byte, and every
 * repository file its pin tables name hashes to its pin. `fetch: false` is for tests with a local origin.
 */
export function registrationRefusal(repo: string, fetch = true): { reason: string | null; landed: Landed | null } {
  try {
    if (fetch) git(repo, ['fetch', '--quiet', 'origin']);
    let commit = '';
    try { commit = git(repo, ['log', '-1', '--format=%H', 'origin/main', '--', REGISTRATION]); } catch { /* no origin/main: not landed */ }
    if (!commit) return { reason: `${REGISTRATION} is not on origin/main`, landed: null };
    const onMain = git(repo, ['show', `origin/main:${REGISTRATION}`]);
    const local = fs.readFileSync(path.join(repo, REGISTRATION), 'utf8').trim();
    if (local !== onMain) return { reason: 'the checkout\'s registration differs from origin/main', landed: null };
    for (const [name, pin] of pinsOf(onMain)) {
      if (name.includes(':')) continue; // census:, store: — checked by their own legs
      const p = path.join(repo, name);
      if (!fs.existsSync(p)) return { reason: `pinned ${name} is missing`, landed: null };
      if (sha256(fs.readFileSync(p)) !== pin) return { reason: `pinned ${name} differs from its pin`, landed: null };
    }
    return { reason: null, landed: { commit, commitTime: git(repo, ['show', '-s', '--format=%cI', commit]), firstSeen: new Date().toISOString() } };
  } catch (e) {
    return { reason: `git: ${(e as Error).message.split('\n')[0]}`, landed: null };
  }
}

const idOf = (p: string): string | null => { try { const s = fs.statSync(p); return `${s.dev}:${s.ino}`; } catch { return null; } };

/** True when `p`, or what it resolves to, has an ancestor (itself included) whose identity is `root`'s. */
export function insideByIdentity(p: string, root: string): boolean {
  const want = idOf(root);
  if (!want) return false;
  const forms = [path.resolve(p)];
  try { forms.push(fs.realpathSync(p)); } catch { /* not created yet: its spelling is all there is */ }
  for (const f of forms) for (let a = f; ; a = path.dirname(a)) { if (idOf(a) === want) return true; if (path.dirname(a) === a) break; }
  return false;
}

/** The home is not inside the repository, and is not T3's or T9's seal home by identity (audit lessons 9, 11). */
export function homeRefusal(home: string, repo: string): string | null {
  if (insideByIdentity(home, repo)) return 'the home lies inside the repository';
  if (insideByIdentity(home, t3SealHome()) || insideByIdentity(t3SealHome(), home)) return 'the home is, or holds, the seal home of T3 and T9';
  return null;
}

/** Spelling, for a root that does not exist yet: `p` is `root`, under it, or holds it. */
const nested = (p: string, root: string): boolean => {
  const a = path.resolve(p), b = path.resolve(root);
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
};

/** A test seam's home is never the registered read's home, under it or holding it — by identity, and by spelling while it is absent (lesson 10). */
export function seamHomeRefusal(home: string, registered: string = forwardHome()): string | null {
  return nested(home, registered) || insideByIdentity(home, registered) || insideByIdentity(registered, home) ? 'a test seam never uses the registered home' : null;
}

/** A write target that is a link, or carries a second name, is refused (lesson 11: every write target, not its directory). */
export function targetRefusal(p: string): string | null {
  let s: fs.Stats;
  try { s = fs.lstatSync(p); } catch { return null; }
  if (s.isSymbolicLink()) return `${path.basename(p)} is a symbolic link`;
  if (!s.isFile()) return `${path.basename(p)} is not a regular file`;
  if (s.nlink > 1) return `${path.basename(p)} has ${s.nlink} names`;
  return null;
}

/** Replaces `name` in the home through a temporary file and a rename: the one way the result is written. */
export function replaceFile(home: string, name: string, text: string): void {
  const p = path.join(home, name), why = targetRefusal(p);
  if (why) throw new Error(why);
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { flag: 'wx' });
  fs.renameSync(tmp, p);
}

/**
 * Lesson 12: every name written after the seal is written the same way, in place, before it — a replacement over an
 * existing result and an append to an existing log. Returns the refusal; nothing is sealed when it is not null.
 */
export function rehearse(home: string): string | null {
  try {
    makeHome(home);
    for (const n of [RESULT, LOG]) { const why = targetRefusal(path.join(home, n)); if (why) return why; }
    replaceFile(home, RESULT, '{"rehearsal":1}\n');
    replaceFile(home, RESULT, '{"rehearsal":2}\n');
    for (const step of [1, 2]) { const why = log(home, { leg: 'rehearsal', step }); if (why) return why; }
    return null;
  } catch (e) {
    return `rehearsal: ${(e as Error).message}`;
  }
}

export interface Claim { claimed: boolean; reason: string | null }

/**
 * Creates the seal exclusively; a second claim is refused because the file exists (`claimed: false`). Once the
 * exclusive create has succeeded the seal is claimed whatever follows: a fault writing or syncing its record is
 * returned with `claimed: true` (CH3 F8), logged as leg `seal` by the caller, never thrown past the read.
 */
export function claimSeal(home: string, record: Record<string, unknown>): Claim {
  let fd: number;
  try {
    fd = fs.openSync(path.join(home, SEAL), MUTATE === 'seal' ? 'w' : 'wx', 0o600);
  } catch (e) {
    return { claimed: false, reason: (e as NodeJS.ErrnoException).code === 'EEXIST' ? 'the seal exists: T5 has been read' : `seal: ${(e as Error).message}` };
  }
  let fault: string | null = null;
  try {
    fs.writeSync(fd, `${JSON.stringify({ wave: WAVE, ...record }, null, 1)}\n`);
    fs.fsyncSync(fd);
  } catch (e) {
    fault = `the seal record: ${(e as Error).message}`;
  } finally {
    try { fs.closeSync(fd); } catch (e) { fault ??= `the seal record: ${(e as Error).message}`; }
  }
  return { claimed: true, reason: fault };
}

// tests/fixtures/regime-15m/isolate.ts — EDGE-REGIME-15M-BACKTEST-W1: a regime-15m suite never reaches a real home or
// a venue (the arc's audit lesson 14).
//
// Imported FIRST by every regime-15m suite. On import it:
//   1. records the study's real home (`~/.cache/algovault/regime-15m`): its seal directory byte for byte, and its
//      check directory by listing (size, mtime and inode of every file; the stored bars are not re-hashed per suite);
//   2. points `os.userInfo().homedir` and `os.homedir()` at a temporary directory of its own, so `homeOf()` and every
//      `~/.cache/algovault` path the code resolves land inside it (`HOME` alone is not enough: the code reads the user
//      database entry);
//   3. replaces `fetch` with one that counts and throws: no test reaches a venue.
// `afterAll` asserts the real home unchanged and that no test called `fetch`. No test depends on today's date: the
// read takes its clock as an argument.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect } from 'vitest';

/** The home this process had before the stub. */
export const REAL_HOMEDIR = os.userInfo().homedir;
const REAL_HOME = path.join(REAL_HOMEDIR, '.cache', 'algovault', 'regime-15m');

/** Every entry under `root` by relative path: type, size, mtime and inode; with `content`, a file's sha256 too. */
export function treeOf(root: string, content: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (p: string): void => {
    let s: fs.Stats;
    try { s = fs.lstatSync(p); } catch { out[path.relative(root, p) || '.'] = 'absent'; return; }
    const kind = s.isDirectory() ? 'd' : s.isSymbolicLink() ? 'l' : s.isFile() ? 'f' : 'o';
    const sum = content && kind === 'f' ? `:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}` : '';
    out[path.relative(root, p) || '.'] = `${kind}:${kind === 'd' ? '-' : s.size}:${s.mtimeMs}:${s.ino}${sum}`;
    if (kind === 'd') for (const e of fs.readdirSync(p).sort()) walk(path.join(p, e));
  };
  walk(root);
  return out;
}

const before = { seal: treeOf(path.join(REAL_HOME, 'seal'), true), check: treeOf(path.join(REAL_HOME, 'check'), false), home: fs.existsSync(REAL_HOME) ? fs.readdirSync(REAL_HOME).sort() : null };

/** The suite's own home directory: `homeOf()` resolves under it. */
export const TEST_HOMEDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-15m-homedir-'));
const realUserInfo = os.userInfo.bind(os);
os.userInfo = ((o?: { encoding: BufferEncoding }) => ({ ...realUserInfo(o as { encoding: BufferEncoding }), homedir: TEST_HOMEDIR })) as typeof os.userInfo;
os.homedir = (): string => TEST_HOMEDIR;

let fetchCalls = 0;
/** The only `fetch` a regime-15m suite has: it counts and throws. */
export const offlineFetch = async (): Promise<never> => { fetchCalls++; throw new Error('no network in a regime-15m test (arc lesson 14)'); };
globalThis.fetch = offlineFetch as unknown as typeof fetch;

afterAll(() => {
  expect(treeOf(path.join(REAL_HOME, 'seal'), true), 'the real seal directory is byte-unchanged').toEqual(before.seal);
  expect(treeOf(path.join(REAL_HOME, 'check'), false), 'the real check directory listing is unchanged').toEqual(before.check);
  expect(fs.existsSync(REAL_HOME) ? fs.readdirSync(REAL_HOME).sort() : null, 'the real home holds the same entries').toEqual(before.home);
  expect(fetchCalls, 'no test reached fetch').toBe(0);
});

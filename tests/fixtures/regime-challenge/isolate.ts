// tests/fixtures/regime-challenge/isolate.ts — EDGE-REGIME-CHALLENGE-R2-W1, arc lesson 14: a round-2 suite never
// reaches a real home, store or network, and never depends on today's date.
//
// Imported FIRST by every round-2 and round-3 suite. On import it:
//   1. records the real homes the challenge rounds own or must never write: round 2's `~/.cache/algovault/
//      regime-challenge-r2` (listing + sha256 of every file), and round 1's `~/.cache/algovault/regime-challenge`,
//      round 3's `~/.cache/algovault/regime-challenge-r3` (its archives are gigabytes: listing only — type, size,
//      mtime and inode of every entry) and T3's seal home `sealHome()` (listings only: no file of theirs is opened)
//      — absence included;
//   2. points `os.userInfo().homedir` and `os.homedir()` at a temporary directory of its own, so `sealHome()` and any
//      home a run derives resolve inside it in every test, mutated or not (`HOME` alone is not enough: the code reads
//      the user database entry);
//   3. replaces `fetch` with one that counts and throws: no test reaches a venue;
//   4. fixes `Date` at one instant, so no result depends on the day the suite runs.
// `afterAll` asserts the real homes unchanged and that no test called `fetch`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, vi } from 'vitest';

const REAL_HOMEDIR = os.userInfo().homedir;
const cacheOf = (name: string): string => path.join(REAL_HOMEDIR, '.cache', 'algovault', name);
const REAL_R2_HOME = cacheOf('regime-challenge-r2');
const REAL_R1_HOME = cacheOf('regime-challenge');
const REAL_R3_HOME = cacheOf('regime-challenge-r3');
const REAL_T3_SEAL_HOME = path.join(cacheOf('regime-diag'), 'store');

/** Every entry under `root` by relative path: type, size, mtime and inode; with `content`, a file's sha256 too. */
function treeOf(root: string, content: boolean): Record<string, string> {
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

const before = { r2: treeOf(REAL_R2_HOME, true), r1: treeOf(REAL_R1_HOME, false), r3: treeOf(REAL_R3_HOME, false), t3: treeOf(REAL_T3_SEAL_HOME, false) };

/** The suite's own home directory: every home the code derives from the user resolves under it. */
export const TEST_HOMEDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-challenge-homedir-'));
const realUserInfo = os.userInfo.bind(os);
os.userInfo = ((o?: { encoding: BufferEncoding }) => ({ ...realUserInfo(o as { encoding: BufferEncoding }), homedir: TEST_HOMEDIR })) as typeof os.userInfo;
os.homedir = (): string => TEST_HOMEDIR;

let fetchCalls = 0;
/** The only `fetch` a round-2 suite has: it counts and throws. */
export const offlineFetch = async (): Promise<never> => { fetchCalls++; throw new Error('no network in a regime-challenge test (arc lesson 14)'); };
globalThis.fetch = offlineFetch as unknown as typeof fetch;

/** The one instant every round-2 suite runs at. */
export const FIXED_NOW = Date.UTC(2026, 10, 19, 12);
vi.setSystemTime(FIXED_NOW);

afterAll(() => {
  expect(treeOf(REAL_R2_HOME, true), 'the real round-2 home is byte-unchanged').toEqual(before.r2);
  expect(treeOf(REAL_R1_HOME, false), 'the real round-1 home listing is unchanged').toEqual(before.r1);
  expect(treeOf(REAL_R3_HOME, false), 'the real round-3 home listing is unchanged').toEqual(before.r3);
  expect(treeOf(REAL_T3_SEAL_HOME, false), 'the real T3 seal home listing is unchanged').toEqual(before.t3);
  expect(fetchCalls, 'no test reached fetch').toBe(0);
  fs.rmSync(TEST_HOMEDIR, { recursive: true, force: true });
});

// tests/fixtures/regime-forward/isolate.ts — EDGE-REGIME-FORWARD-W1, arc lesson 14: a regime-forward suite never
// reaches a real home, store or network, and never depends on today's date.
//
// Imported FIRST by every regime-forward suite. On import it:
//   1. records the real homes the read code resolves — T5's `forwardHome()` (listing + sha256 of every file) and
//      T3's `sealHome()` (listing only: no T3 file is opened) — absence included, under the home the process had
//      before this module ran (the user's, or a proof preload's scratch home);
//   2. points `os.userInfo().homedir` and `os.homedir()` at a temporary directory of its own, so `forwardHome()` and
//      `sealHome()` resolve inside it in every test, mutated or not (`HOME` alone is not enough: the code reads the
//      user database entry);
//   3. replaces `fetch` with one that counts and throws: no test reaches a venue;
//   4. fixes `Date` one day past not_before, so a test whose result would change when the real clock passes a
//      registered date fails today, not on 2026-12-30 (re-check R2).
// `afterAll` asserts the real homes byte-unchanged and that no test called `fetch`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, vi } from 'vitest';
import { NOT_BEFORE_MS } from '../../../src/scripts/regime-forward/forward-spec.js';

/** The home this process had before the stub: the real one (or a proof preload's scratch home). */
export const REAL_HOMEDIR = os.userInfo().homedir;
const REAL_FORWARD_HOME = path.join(REAL_HOMEDIR, '.cache', 'algovault', 'regime-forward');
const REAL_T3_SEAL_HOME = path.join(REAL_HOMEDIR, '.cache', 'algovault', 'regime-diag', 'store');

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

const before = { forward: treeOf(REAL_FORWARD_HOME, true), t3: treeOf(REAL_T3_SEAL_HOME, false) };

/** The suite's own home directory: `forwardHome()` and `sealHome()` resolve under it. */
export const TEST_HOMEDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-forward-homedir-'));
const realUserInfo = os.userInfo.bind(os);
os.userInfo = ((o?: { encoding: BufferEncoding }) => ({ ...realUserInfo(o as { encoding: BufferEncoding }), homedir: TEST_HOMEDIR })) as typeof os.userInfo;
os.homedir = (): string => TEST_HOMEDIR;

let fetchCalls = 0;
/** The only `fetch` a regime-forward suite has: it counts and throws. */
export const offlineFetch = async (): Promise<never> => { fetchCalls++; throw new Error('no network in a regime-forward test (arc lesson 14)'); };
globalThis.fetch = offlineFetch as unknown as typeof fetch;

/** Every suite runs one day past not_before; a test that needs another instant sets it and restores this one. */
export const SUITE_NOW = NOT_BEFORE_MS + 86_400_000;
vi.setSystemTime(SUITE_NOW);

afterAll(() => {
  expect(treeOf(REAL_FORWARD_HOME, true), 'the real forwardHome() is byte-unchanged').toEqual(before.forward);
  expect(treeOf(REAL_T3_SEAL_HOME, false), 'the real T3 sealHome() listing is unchanged').toEqual(before.t3);
  expect(fetchCalls, 'no test reached fetch').toBe(0);
});

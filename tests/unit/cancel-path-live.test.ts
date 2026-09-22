/**
 * CANCEL-PATH-CSP-FORM-ACTION-W1 CH3 — scripts/check-cancel-path-live.mjs.
 *
 * Spawns the REAL canary (no import seam) and pins the verdict TOKEN and the token → exit-code
 * mapping. The self-test drives the real probe against a local fixture server — including the 303
 * that must be SEEN and never followed (`redirect: 'manual'`) — plus both alert ids, the streak and
 * the transport against a fake wrapper.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = path.resolve(__dirname, '../..');
const CANARY = path.join(ROOT, 'scripts/check-cancel-path-live.mjs');
const TOKEN_RE = /CANCEL_PATH_LIVE_VERDICT=[A-Z]+/g;

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('node', [CANARY, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ALGOVAULT_TG_TEST_INERT: '1', ...env } });
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status };
}
function expectVerdict(r: { out: string; status: number | null }, verdict: 'PASS' | 'FAIL' | 'INDETERMINATE') {
  expect(r.out.match(TOKEN_RE)).toEqual([`CANCEL_PATH_LIVE_VERDICT=${verdict}`]);
  expect(r.status).toBe({ PASS: 0, FAIL: 1, INDETERMINATE: 3 }[verdict]);
}

describe('cancel-path live canary', () => {
  it('--self-test passes three-way (PASS / FAIL / INDETERMINATE rows, 303 never followed, both alert ids)', { timeout: 60_000 }, () => {
    const r = run(['--self-test']);
    expect(r.out).toMatch(/SELF-TEST: PASS \(\d+ passed, 0 failed\)/);
    expectVerdict(r, 'PASS');
  });

  it('with the fixture key unset it is INDETERMINATE (exit 3), never PASS — and sends no probe', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cancel-path-'));
    try {
      const r = run(['--live', 'http://127.0.0.1:9'], {
        CANCEL_CANARY_ENV_FILE: path.join(dir, 'absent.env'),
        CANCEL_PATH_STATE_FILE: path.join(dir, 'state.json'),
        CANCEL_PATH_TG_WRAPPER: path.join(dir, 'no-wrapper.sh'),
        CANARY_RESULT_LOG_PATH: path.join(dir, 'results.jsonl'),
      });
      expectVerdict(r, 'INDETERMINATE');
      expect(r.out).toContain('fixture key unset or unreadable');
      expect(r.out).toMatch(/CANARY_RESULT_LOG=\S+ line=1/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a bad invocation is INDETERMINATE with exactly one token', { timeout: 60_000 }, () => {
    for (const args of [[], ['--nope'], ['--live', 'not a url'], ['--self-test', 'extra']]) expectVerdict(run(args), 'INDETERMINATE');
  });
});

/**
 * OPS-WAVE-THROUGHPUT-W1 CH1 — scripts/wait-deploy.sh.
 *
 * The real script against a stub `gh` first on PATH, which answers the way
 * `gh run list --json …` does. Polling is collapsed to zero so every case decides on its first
 * poll; nothing here reaches GitHub.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = resolve(__dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'wait-deploy.sh');
const SHA = '0123456789abcdef0123456789abcdef01234567';
const BIN = mkdtempSync(join(tmpdir(), 'wait-deploy-test-'));
afterAll(() => rmSync(BIN, { recursive: true, force: true }));

const RUN = '"databaseId":7,"url":"https://github.com/o/r/actions/runs/7","createdAt":"2026-10-26T10:00:00Z","updatedAt":"2026-10-26T10:09:00Z"';
writeFileSync(join(BIN, 'gh'), `#!/usr/bin/env bash
case "$STUB" in
  success) echo '[{${RUN},"status":"completed","conclusion":"success"}]' ;;
  failure) echo '[{${RUN},"status":"completed","conclusion":"failure"}]' ;;
  pending) echo '[{${RUN},"status":"in_progress","conclusion":""}]' ;;
  none)    echo '[]' ;;
esac
`);
chmodSync(join(BIN, 'gh'), 0o755);

function wait(stub: string, args: string[] = [SHA]) {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, STUB: stub, WAIT_DEPLOY_POLL_S: '0', WAIT_DEPLOY_MAX_S: '0', WAIT_DEPLOY_NORUN_S: '0' },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { out, status: r.status, token: out.trim().split('\n').pop() };
}

describe('wait-deploy.sh', () => {
  it('success: SUCCESS, exit 0, with the run url and duration', { timeout: 30_000 }, () => {
    const r = wait('success');
    expect(r.token, r.out).toBe('DEPLOY_VERDICT=SUCCESS');
    expect(r.status).toBe(0);
    expect(r.out).toContain('https://github.com/o/r/actions/runs/7');
    expect(r.out).toContain('duration: 540s');
  });

  it('failure: FAILURE, exit 1', { timeout: 30_000 }, () => {
    const r = wait('failure');
    expect(r.token, r.out).toBe('DEPLOY_VERDICT=FAILURE');
    expect(r.status).toBe(1);
  });

  it('pending at the deadline: PENDING, exit 2', { timeout: 30_000 }, () => {
    const r = wait('pending');
    expect(r.token, r.out).toBe('DEPLOY_VERDICT=PENDING');
    expect(r.status).toBe(2);
    expect(r.out).toContain('call again');
  });

  it('no run: INDETERMINATE, exit 3 — never treated as fine', { timeout: 30_000 }, () => {
    const r = wait('none');
    expect(r.token, r.out).toBe('DEPLOY_VERDICT=INDETERMINATE');
    expect(r.status).toBe(3);
  });

  it('--self-test prints WAIT_DEPLOY_SELFTEST=PASS', { timeout: 30_000 }, () => {
    const r = wait('none', ['--self-test']);
    expect(r.token, r.out).toBe('WAIT_DEPLOY_SELFTEST=PASS');
    expect(r.status).toBe(0);
  });
});

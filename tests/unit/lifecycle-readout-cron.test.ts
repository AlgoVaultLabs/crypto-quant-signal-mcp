/**
 * LIFECYCLE-GOLIVE-SEMANTICS-W1 R3 — the deciding cron PUBLISHES, on every exit path, and pages
 * only on a rollback EVENT.
 *
 * Drives the REAL `ops/cron/lifecycle-readout.sh` with its external seams stubbed on PATH / env:
 * `docker` (the container check and the `--decide` exec, which prints canned readout output),
 * `curl` (the unsubscribe self-test), the health script (via LIFECYCLE_REPO), and the Telegram
 * sender (via LIFECYCLE_SEND). The recorder is the REAL `ops/monitoring/canary_result_log.py`,
 * pointed at a temp results file — so the bytes asserted are the bytes the vault sync would pull.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const SCRIPT = join(ROOT, 'ops/cron/lifecycle-readout.sh');

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lc-readout-cron.')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function exe(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

/** Run the wrapper with `decideOut` as the node readout's stdout. */
function run(decideOut: string, opts: { containerUp?: boolean } = {}) {
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(dir, 'decide.out'), decideOut);
  exe(join(bin, 'docker'), [
    'case "$1" in',
    `  inspect) ${opts.containerUp === false ? 'exit 1' : 'echo true'} ;;`,
    `  exec) cat "${join(dir, 'decide.out')}" ;;`,
    'esac',
  ].join('\n'));
  exe(join(bin, 'curl'), 'printf 400');
  mkdirSync(join(dir, 'repo/ops/cron'), { recursive: true });
  exe(join(dir, 'repo/ops/cron/lifecycle-health.sh'), 'echo "LIFECYCLE_HEALTH_VERDICT=PASS"');
  exe(join(dir, 'send.sh'), `cat >> "${join(dir, 'pages.log')}"; echo "--page $1" >> "${join(dir, 'pages.log')}"`);
  const results = join(dir, 'canary-results.jsonl');
  let stdout = '';
  let code = 0;
  try {
    stdout = execFileSync('bash', [SCRIPT], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        LIFECYCLE_REPO: join(dir, 'repo'),
        LIFECYCLE_SEND: join(dir, 'send.sh'),
        LIFECYCLE_READOUT_LOG: join(dir, 'readout.log'),
        LIFECYCLE_RESULT_LOG_DIR: join(ROOT, 'ops/monitoring'),
        CANARY_RESULT_LOG_PATH: results,
      },
      encoding: 'utf8',
    });
  } catch (e) {
    const err = e as { status: number; stdout: string };
    code = err.status;
    stdout = err.stdout;
  }
  const records = existsSync(results)
    ? readFileSync(results, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const pages = existsSync(join(dir, 'pages.log')) ? readFileSync(join(dir, 'pages.log'), 'utf8') : '';
  return { stdout, code, records, pages };
}

const RESULT = {
  master: 'shadow', verdict: 'BLOCKED_MASTER',
  steps: { activation_nudge: { verdict: 'BLOCKED_MASTER', would_send: 16, sent: 0, expired: 0, live: false, rollback_window: 'not_opened' } },
};
const decideOut = (verdict: string, rolledNow: number) => [
  '[lifecycle-readout] master=shadow',
  '[lifecycle-readout] step=activation_nudge verdict=BLOCKED_MASTER state=blocked-master leg=master_not_live_permitted rollback_window=not_opened would_send=16 sent=0 expired=0',
  `[lifecycle-readout] LIFECYCLE_GOLIVE_VERDICT=${verdict} lit_now=0 rolled_back_now=${rolledNow}`,
  `[lifecycle-readout] RESULT_JSON=${JSON.stringify({ ...RESULT, verdict })}`,
  '[lifecycle-readout] LIFECYCLE_READOUT_VERDICT=PASS',
].join('\n');

describe('ops/cron/lifecycle-readout.sh publishes the go-live verdict', () => {
  it('a routine run appends ONE lifecycle-readout record carrying the per-step metrics', () => {
    const r = run(decideOut('BLOCKED_MASTER', 0));
    expect(r.code).toBe(0);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ canary: 'lifecycle-readout', verdict: 'BLOCKED_MASTER', exit_code: 0 });
    expect(r.records[0].metrics.steps.activation_nudge).toEqual(RESULT.steps.activation_nudge);
    expect(r.stdout).toMatch(/CANARY_RESULT_LOG=line=1/);
    expect(r.pages).toBe('');
  });

  it('an INDETERMINATE run is published too — never silence', () => {
    const r = run('', { containerUp: false });
    expect(r.code).toBe(3);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ canary: 'lifecycle-readout', verdict: 'INDETERMINATE', exit_code: 3 });
  });

  it('pages on a rollback EVENT, and not on a standing ROLLED_BACK state', () => {
    const standing = run(decideOut('ROLLED_BACK', 0));
    expect(standing.pages).toBe('');
    expect(standing.records[0].verdict).toBe('ROLLED_BACK');
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'lc-readout-cron.'));
    const event = run(decideOut('ROLLED_BACK', 1));
    expect(event.code).toBe(1);
    expect(event.pages).toMatch(/--page LIFECYCLE_GOLIVE_ROLLBACK/);
    expect(event.records[0]).toMatchObject({ verdict: 'ROLLED_BACK', exit_code: 1 });
  });
});

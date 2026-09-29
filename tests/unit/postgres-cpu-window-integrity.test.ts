/**
 * OPS-POSTGRES-CPU-WINDOW-INTEGRITY-W1 — the postgres-cpu sampler and autopilot, pinned in CI.
 *
 * Both run on signal-1 from cron and nothing in the TypeScript tree can import them, so the honest
 * pin is to RUN each one's own `--self-test` and read its verdict token. Both self-tests are
 * hermetic (temp dirs; stub docker, autopilot and wrapper) and carry the real 2026-09-20..29
 * samples as their regression fixture. The 2026-09-28 POSTGRES_CPU_DRIFT_UNIFIED page averaged 8
 * samples, because the "7-day" window was `tail -28` of a log that logrotate empties weekly.
 *
 * SPAWN BUDGET DECLARED in each spawning block's OPTIONS arg (`scripts/check-test-budget.mjs`).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../..');
const SNAPSHOT = path.join(REPO, 'ops/monitoring/postgres-cpu-snapshot.sh');
const AUTOPILOT = path.join(REPO, 'ops/monitoring/postgres-cpu-autopilot.py');
const REGISTRY = path.join(REPO, 'ops/monitoring/postgres-cpu-autopilot-registry.yaml');

const tokenLines = (stdout: string, token: string): string[] =>
  stdout.split('\n').filter((l) => l.startsWith(`${token}=`));

describe('postgres-cpu window integrity', () => {
  it('the sampler self-test passes non-vacuously and prints exactly one token', { timeout: 120_000 }, () => {
    const r = spawnSync('bash', [SNAPSHOT, '--self-test'], { encoding: 'utf8', input: '' });
    expect(tokenLines(r.stdout, 'POSTGRES_CPU_SNAPSHOT_SELFTEST_VERDICT'))
      .toEqual(['POSTGRES_CPU_SNAPSHOT_SELFTEST_VERDICT=PASS']);
    expect(r.stdout).toMatch(/SELF-TEST: PASS \x28\d+ assertions\x29/);
    expect(r.status).toBe(0);
  });

  it('the autopilot self-test passes non-vacuously and prints exactly one token', { timeout: 60_000 }, () => {
    const r = spawnSync('python3', [AUTOPILOT, '--self-test'], { encoding: 'utf8', input: '' });
    expect(tokenLines(r.stdout, 'POSTGRES_CPU_AUTOPILOT_SELFTEST_VERDICT'))
      .toEqual(['POSTGRES_CPU_AUTOPILOT_SELFTEST_VERDICT=PASS']);
    expect(r.stdout).toMatch(/SELF-TEST: PASS \x28\d+ assertions\x29/);
    expect(r.status).toBe(0);
  });

  it('the sampler never again derives its window from its own log', () => {
    const code = readFileSync(SNAPSHOT, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(code).not.toMatch(/tail -(?:n *)?[0-9]+ "?\$\{?LOG/);
    expect(code).toMatch(/PG_CPU_WINDOW_FILE/);
  });

  it('every registry class names a TEMPLATE recommended wave, because the body now reads it', () => {
    const reg = yaml.load(readFileSync(REGISTRY, 'utf8')) as { classes: Array<Record<string, unknown>> };
    // declaration-sync refuses to propagate a registry truncated below 3 classes
    expect(reg.classes.length).toBeGreaterThanOrEqual(3);
    expect(reg.classes.some((c) => c.name === 'UNKNOWN')).toBe(true);
    for (const c of reg.classes) {
      expect(String(c.recommended_wave_template)).toMatch(/^OPS-[A-Z0-9-]+-W\{NEXT\}$/);
    }
  });
});

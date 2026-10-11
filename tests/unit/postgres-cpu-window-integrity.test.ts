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

  it('OPS-ALARM-OWNER-DERIVATION-W1 CH3: the persistent leg decides on the INTEGRAL; the point levels keep their values', () => {
    const src = readFileSync(SNAPSHOT, 'utf8');
    // the point instrument's levels are NOT edited (Must NOT) — they are levels on THAT instrument
    for (const pin of ['BASELINE_PCT=10', 'THRESHOLD_PCT=$((BASELINE_PCT * 2))', 'WINDOW_N=28 ', 'TRAJECTORY_N=3', 'TRAJECTORY_PCT=50']) {
      expect(src.split('\n').some((l) => l.startsWith(pin)), pin).toBe(true);
    }
    // ONE new level, on the integral, carrying its basis, its owner and a revisit date
    expect(src).toMatch(/^INTEGRAL_PERSISTENT_PCT=100$/m);
    expect(src).toContain('2 × the');
    expect(src).toContain('integral normal R0.7 measured (46.05–52.51 % ⇒ 92–105, rounded)');
    expect(src).toContain('OPS-POSTGRES-CPU-INTEGRAL-RECALIBRATE-W1');
    expect(src).toMatch(/TODO: revisit by 2026-10-25/);
    // the run decides through decide(), and decide() takes persistence ONLY from the integral
    expect(src).toMatch(/ev=\$\x28decide "\$WINDOW_FILE" "\$INTEGRAL_FILE" "\$now"\x29/);
    expect(src).toContain('if [ "$(kv int_verdict "$iv")" = FAIL ]; then ipers=1; fi');
  });

  it('the routing case stays byte-identical (Must NOT): the same three arms, the same alert ids', () => {
    const src = readFileSync(SNAPSHOT, 'utf8');
    expect(src).toContain('      1) echo "$AUTOPILOT_OUT" | "$MON_DIR/send_telegram.sh" "POSTGRES_CPU_DRIFT_UNIFIED" CRITICAL_PERSISTENT - ;;');
    expect(src).toContain('      2) echo "CRITICAL_BYPASS: $AUTOPILOT_OUT" | "$MON_DIR/send_telegram.sh" "POSTGRES_CPU_DRIFT_CRITICAL_BYPASS" CRITICAL_PERSISTENT - ;;');
    expect(src).toContain('      0) : ;;');
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

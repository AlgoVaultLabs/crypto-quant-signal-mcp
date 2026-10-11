/**
 * OPS-ALARM-OWNER-DERIVATION-W1 CH3 — postgres-cpu window attribution, pinned in CI.
 *
 * The autopilot used to feed classify() pg_stat_statements' CUMULATIVE top-1 — a rank since
 * stats_reset (2026-06-05, ~128 days), so every page named whatever dominated since June. It now
 * ranks Σ Δtotal_exec_time over the SAME wall-time window the firing leg used, from a store the
 * snapshot fills every run (`--record-pgss`). The honest pin is the autopilot's own `--self-test`
 * (hermetic: temp store, injected psql, no DB) — run here and read by its token, the way the window
 * test reads the snapshot's — plus the real entrypoint's failure token and the registry's invariants.
 *
 * SPAWN BUDGET DECLARED in each spawning block's OPTIONS arg (`scripts/check-test-budget.mjs`).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../..');
const AUTOPILOT = path.join(REPO, 'ops/monitoring/postgres-cpu-autopilot.py');
const SNAPSHOT = path.join(REPO, 'ops/monitoring/postgres-cpu-snapshot.sh');
const REGISTRY = path.join(REPO, 'ops/monitoring/postgres-cpu-autopilot-registry.yaml');
/** The real 2026-09-28 dominant query — the CUMULATIVE top-1 every pre-wave page named. */
const CUMULATIVE_FUNDING_QUERY = 'SELECT funding_rate FROM funding_history WHERE coin = $1 AND recorded_at >= $2 ORDER BY recorded_at';

const tokenLines = (stdout: string, token: string): string[] =>
  stdout.split('\n').filter((l) => l.startsWith(`${token}=`));

describe('postgres-cpu window attribution', () => {
  it('the autopilot self-test passes non-vacuously — the attribution scenarios included', { timeout: 60_000 }, () => {
    const r = spawnSync('python3', [AUTOPILOT, '--self-test'], { encoding: 'utf8', input: '' });
    expect(tokenLines(r.stdout, 'POSTGRES_CPU_AUTOPILOT_SELFTEST_VERDICT'))
      .toEqual(['POSTGRES_CPU_AUTOPILOT_SELFTEST_VERDICT=PASS']);
    const n = Number(/SELF-TEST: PASS \x28(\d+) assertions\x29/.exec(r.stdout)?.[1] ?? 0);
    expect(n).toBeGreaterThanOrEqual(49);
    expect(r.status).toBe(0);
    const src = readFileSync(AUTOPILOT, 'utf8');
    for (const label of ['A1 Δ ranking beats the cumulative rank', 'A2 eviction', 'A3 stats_reset change in window',
      'A5 body: the window top-3 by Δexec', 'A6 --record-pgss prints PGSS_RECORD=ok']) {
      expect(src, label).toContain(label);
    }
  });

  it('--record-pgss on an unreachable database prints ONE failure token, exits 3, writes nothing', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pgss-cli-'));
    // python by absolute path, so the PATH below can hide docker without hiding the interpreter
    const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();
    try {
      const r = spawnSync(python, [AUTOPILOT, '--record-pgss'], {
        encoding: 'utf8', input: '',
        // no container to reach: a PATH without docker makes psql_run fail at once, on any machine
        env: { ...process.env, PG_CPU_PGSS_DIR: dir, PATH: '/nonexistent' },
      });
      expect(tokenLines(r.stdout, 'PGSS_RECORD')).toHaveLength(1);
      expect(r.stdout).toMatch(/^PGSS_RECORD=failed reason=/m);
      expect(r.status).toBe(3);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the snapshot hands the autopilot the firing leg\'s own window, and records a pgss snapshot every run', () => {
    const src = readFileSync(SNAPSHOT, 'utf8');
    expect(src).toContain('\\"attribution_from_s\\":${attr_from}');
    expect(src).toContain('attr_label="the trailing 7 days"');
    expect(src).toContain('attr_label="the last ${TRAJECTORY_N} point samples"');
    expect(src).toMatch(/^  record_pgss$/m);
  });

  it('no registry regex matches the CUMULATIVE funding query (Must NOT: it would silence the detector)', () => {
    const reg = yaml.load(readFileSync(REGISTRY, 'utf8')) as { classes: Array<Record<string, unknown>> };
    for (const c of reg.classes) {
      if (c.classifier_type !== 'pg_query_regex') continue;
      expect(new RegExp(String(c.classifier_regex), 'i').test(CUMULATIVE_FUNDING_QUERY), String(c.name)).toBe(false);
    }
  });

  it('a class with an owner is diagnose-only and names a TEMPLATE wave (CH3 Req 7)', () => {
    const reg = yaml.load(readFileSync(REGISTRY, 'utf8')) as { classes: Array<Record<string, unknown>> };
    for (const c of reg.classes.filter((x) => x.owner !== undefined)) {
      expect(c.recovery_action, String(c.name)).toBe('escalate');
      expect(String(c.recommended_wave_template)).toMatch(/^OPS-[A-Z0-9-]+-W\{NEXT\}$/);
      expect(String(c.owner)).toMatch(/^[A-Z0-9-]+-W\d+$/);
    }
  });
});

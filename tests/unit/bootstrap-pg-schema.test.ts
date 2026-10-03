/**
 * bootstrap-pg-schema.test.ts — the CI Postgres lane's DECLARED bootstrap, widened to the app's own
 * boot column runner (SIGNAL-VERDICT-RULE-REGISTRY-W1 CH3, architect ruling Q2 = A, 2026-10-03).
 * The script belongs to OPS-PG-LANE-BOOTSTRAP-W1; this wave widened it because the lane's own rule
 * puts the guarantee there: "Widening the guarantee means widening BOOTSTRAP_MODULES, not rewriting
 * migrations/".
 *
 * WHY. `signals.signal_hash` — and 66 other columns — exist only because the app's SIGNAL_MIGRATIONS
 * runner ALTERs them in, fire-and-forget (src/lib/performance-db.ts). The bootstrap awaited TABLES
 * only and exited while that runner was still in flight, so migrations/047, the first migration to
 * index a column the app adds by ALTER, failed in the lane: `column "signal_hash" does not exist`
 * (run 37118831402). These pin the column derivation, its vacuity floor, and the bounded wait.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  columnsDeclaredIn,
  columnExpectationProblem,
  waitForColumns,
  tablesDeclaredIn,
  MIN_DECLARED_COLUMNS,
} from '../../scripts/bootstrap-pg-schema.mjs';

const ROOT = join(__dirname, '..', '..');
const PERF_DB = readFileSync(join(ROOT, 'src', 'lib', 'performance-db.ts'), 'utf8');

/** A clock the wait can advance only by sleeping — the wait is bounded by construction, not by luck. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

describe('bootstrap-pg-schema — the app column runner is part of the declared bootstrap', () => {
  it('derives every SIGNAL_MIGRATIONS (table, column) pair — signals.signal_hash included', () => {
    const cols = columnsDeclaredIn(PERF_DB);
    expect(cols.has('signals.signal_hash')).toBe(true);
    expect(cols.has('signal_scorer_inputs.rule_config_id')).toBe(true);
    expect(cols.size).toBeGreaterThanOrEqual(MIN_DECLARED_COLUMNS);
    expect(columnExpectationProblem(cols)).toBeNull();
  });

  it('reads ONLY the SIGNAL_MIGRATIONS block — never a commented-out entry or another array', () => {
    const fixture = [
      "const NOT_IT = [{ table: 'before', column: 'x', type: 'TEXT' }];",
      'const SIGNAL_MIGRATIONS: MigrationDescriptor[] = [',
      "  { table: 'signals', column: 'signal_hash', type: 'VARCHAR(66)' },",
      "  // { table: 'signals', column: 'commented_out', type: 'TEXT' },",
      "  { table: 'Hooks', column: 'State', type: \"TEXT NOT NULL DEFAULT 'active'\" },",
      '];',
      "const ALSO_NOT_IT = [{ table: 'after', column: 'y', type: 'TEXT' }];",
    ].join('\n');
    expect([...columnsDeclaredIn(fixture)].sort()).toEqual(['hooks.state', 'signals.signal_hash']);
    expect(columnsDeclaredIn('SELECT 1;').size).toBe(0);
  });

  it('every derived column belongs to a table the bootstrap creates — else the wait could never finish', () => {
    const tables = new Set<string>();
    for (const f of ['performance-db.ts', 'analytics.ts', 'license.ts']) {
      for (const t of tablesDeclaredIn(readFileSync(join(ROOT, 'src', 'lib', f), 'utf8'))) tables.add(t);
    }
    const orphans = [...columnsDeclaredIn(PERF_DB)].map((c) => c.split('.')[0]).filter((t) => !tables.has(t));
    expect(orphans).toEqual([]);
  });

  it("the floor is today's count: an empty or smaller expectation is INDETERMINATE, never complete", () => {
    expect(MIN_DECLARED_COLUMNS).toBeGreaterThan(0);
    expect(columnExpectationProblem(new Set())).toMatch(/0 columns/);
    const real = [...columnsDeclaredIn(PERF_DB)];
    expect(columnExpectationProblem(new Set(real.slice(0, MIN_DECLARED_COLUMNS - 1)))).toMatch(/below the floor/);
    expect(columnExpectationProblem(new Set(real.slice(0, MIN_DECLARED_COLUMNS)))).toBeNull();
  });

  it('the bounded wait returns [] once every expected column has appeared', async () => {
    const clock = fakeClock();
    const views = [new Set<string>(), new Set(['t.a']), new Set(['t.a', 't.b'])];
    let reads = 0;
    const missing = await waitForColumns(new Set(['t.a', 't.b']), async () => views[Math.min(reads++, 2)], {
      timeoutMs: 10_000, pollMs: 100, ...clock,
    });
    expect(missing).toEqual([]);
    expect(reads).toBe(3);
  });

  it('the bounded wait gives up at its deadline and names exactly what is missing', async () => {
    const clock = fakeClock();
    let reads = 0;
    // The reader is its own backstop: an instant fake sleep never yields to the timer queue, so an
    // UNBOUNDED wait would starve vitest's timeout and hang the suite instead of failing it.
    const missing = await waitForColumns(new Set(['t.a', 't.c', 't.b']), async () => {
      reads += 1;
      if (reads > 100) throw new Error('unbounded: the wait ignored its deadline');
      return new Set(['t.a']);
    }, { timeoutMs: 1_000, pollMs: 100, ...clock });
    expect(missing).toEqual(['t.b', 't.c']);
    expect(reads).toBeLessThanOrEqual(1_000 / 100 + 1);
    expect(clock.now()).toBeGreaterThanOrEqual(1_000);
  });

  it('a reader that throws propagates (INDETERMINATE upstream) — never an empty, passing view', async () => {
    const clock = fakeClock();
    await expect(waitForColumns(new Set(['t.a']), async () => { throw new Error('connection refused'); }, {
      timeoutMs: 1_000, pollMs: 100, ...clock,
    })).rejects.toThrow('connection refused');
  });

  it("the script's own --self-test passes, its parser-break proof included", { timeout: 60_000 }, () => {
    const r = spawnSync('node', [join(ROOT, 'scripts', 'bootstrap-pg-schema.mjs'), '--self-test'], { encoding: 'utf8' });
    expect(r.stderr).not.toMatch(/✖/);
    expect(r.stdout).toContain('bootstrap-pg-schema self-test passed');
    expect(r.status).toBe(0);
  });
});

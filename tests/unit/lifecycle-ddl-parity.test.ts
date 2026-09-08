/**
 * IDENTITY-LIFECYCLE-W3 CH1 — `migrations/040_lifecycle.sql` and `src/lib/lifecycle/schema.ts`
 * must name the same columns.
 *
 * BOTH DDLs EXIST ON PURPOSE and neither is redundant: the migrations directory is applied by
 * hand on signal-1 and never reaches a fresh database or the SQLite test backend, while the boot
 * path never reaches a production DB the migration already prepared. What is NOT acceptable is
 * for them to disagree — a column added to one and not the other produces a table whose shape
 * depends on which code path created it, and the failure surfaces as a silent write loss on
 * whichever backend lost the race. Same shape `signup-attribution-ddl-parity.test.ts` proves.
 *
 * The comparison is over COLUMN NAMES PER TABLE, deliberately not over types: the two files
 * legitimately differ on type spelling (`TIMESTAMPTZ` vs `TEXT`, `BIGSERIAL` vs
 * `INTEGER … AUTOINCREMENT`) because SQLite has no equivalent, and asserting on types would
 * force a false choice between a failing test and a broken dialect.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const MIGRATION = readFileSync(resolve(ROOT, 'migrations/040_lifecycle.sql'), 'utf8');
const BOOT = readFileSync(resolve(ROOT, 'src/lib/lifecycle/schema.ts'), 'utf8');

const TABLES = ['lifecycle_sends', 'lifecycle_suppressions', 'lifecycle_step_state', 'lifecycle_heartbeats'] as const;

/** Column names from the first `CREATE TABLE … (…)` body for `table` in `sql`. */
function columnsOf(sql: string, table: string): string[] {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`);
  if (start === -1) return [];
  const open = sql.indexOf('(', start);
  let depth = 0, end = -1;
  for (let i = open; i < sql.length; i += 1) {
    if (sql[i] === '(') depth += 1;
    else if (sql[i] === ')') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return [];
  return sql.slice(open + 1, end)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('--') && !/^CONSTRAINT\b/i.test(l))
    .map((l) => l.split(/\s+/)[0].replace(/[,()]/g, ''))
    .filter((c) => /^[a-z_]+$/.test(c));
}

describe('040_lifecycle.sql ↔ src/lib/lifecycle/schema.ts', () => {
  for (const table of TABLES) {
    it(`${table} names the same columns in both DDLs`, () => {
      const a = columnsOf(MIGRATION, table).sort();
      const b = columnsOf(BOOT, table).sort();
      // Vacuity guard: this corpus is one WE construct, so an empty extraction means the
      // parser stopped matching — a defect in the test, not a passing comparison of two
      // empty sets. REFUSE.
      expect(a.length, `migration produced no columns for ${table} — parser broke`).toBeGreaterThan(2);
      expect(b.length, `boot path produced no columns for ${table} — parser broke`).toBeGreaterThan(2);
      expect(b).toEqual(a);
    });
  }

  it('the parser actually parses — a known column is found, an absent one is not', () => {
    const cols = columnsOf(MIGRATION, 'lifecycle_sends');
    expect(cols).toContain('period_key');
    expect(cols).toContain('rendered_subject');
    expect(cols).not.toContain('definitely_not_a_column');
  });

  it('the down migration REFUSES to drop the suppression list', () => {
    const down = readFileSync(resolve(ROOT, 'migrations/040_lifecycle.down.sql'), 'utf8');
    // Dropping it destroys consent state that cannot be reconstructed — re-running `up` then
    // mails everyone who had opted out. §Data Integrity forbids it outright.
    expect(down).not.toMatch(/DROP\s+TABLE\s+(IF\s+EXISTS\s+)?lifecycle_suppressions/i);
    expect(down).toMatch(/DROP\s+TABLE\s+IF\s+EXISTS\s+lifecycle_sends/i);
  });
});

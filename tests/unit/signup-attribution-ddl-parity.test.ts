/**
 * FUNNEL-TRUTH-AND-PAID-ATTRIBUTION-W1 CH1 (architect ruling Q8) — the two DDLs must agree.
 *
 * `signup_attribution` gets its classification columns from TWO places, and both are load-bearing:
 *
 *   - `migrations/038_signup_attribution_classification.sql` — pre-applied on signal-1 via SSH
 *     BEFORE the code deploys, so the runtime ALTER is a no-op rather than a race against the
 *     first INSERT naming the columns (that INSERT is fire-and-forget behind a swallowed catch,
 *     so losing the race would be SILENT attribution loss).
 *   - `ensureSignupAttributionSchema()` in `src/lib/subscriber-attribution.ts` — the only path
 *     that reaches a FRESH database or the SQLite test/dev backend, since this table is created
 *     lazily by that module and not by the migrations directory at all.
 *
 * Neither can be dropped, so the failure mode is DRIFT: a later wave adds a column to one and
 * forgets the other, and the defect surfaces only on whichever backend was missed — a fresh
 * deploy, or prod, depending on which half was edited. This test is the thing that notices.
 *
 * It asserts the column NAME SET, not the SQL text: the two dialects legitimately differ
 * (Postgres takes `ADD COLUMN IF NOT EXISTS`, SQLite has no such form — verified 3.49), so
 * comparing statements would fail on a difference that is correct.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SIGNUP_ATTRIBUTION_ADDED_COLUMNS } from '../../src/lib/subscriber-attribution.js';

const REPO = join(__dirname, '..', '..');
const MIGRATION = join(REPO, 'migrations', '038_signup_attribution_classification.sql');
const DOWN = join(REPO, 'migrations', '038_signup_attribution_classification.down.sql');
const MODULE = join(REPO, 'src', 'lib', 'subscriber-attribution.ts');

/** Column names an `ALTER TABLE signup_attribution ADD COLUMN …` statement introduces. */
function addedColumns(sql: string): string[] {
  return [...sql.matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]);
}

describe('signup_attribution DDL parity — migration 038 vs the boot path', () => {
  const migrationSql = readFileSync(MIGRATION, 'utf8');
  const moduleSrc = readFileSync(MODULE, 'utf8');

  it('the migration adds exactly the columns the boot path declares', () => {
    expect(addedColumns(migrationSql).sort()).toEqual([...SIGNUP_ATTRIBUTION_ADDED_COLUMNS].sort());
  });

  it('the declared column list is non-empty (a vacuous parity check proves nothing)', () => {
    // Without this, emptying the list on both sides would make every assertion here pass while
    // shipping no columns at all.
    expect(SIGNUP_ATTRIBUTION_ADDED_COLUMNS.length).toBeGreaterThan(0);
    expect(addedColumns(migrationSql).length).toBeGreaterThan(0);
  });

  it('the CREATE TABLE carries the same columns, so a FRESH database needs no ALTER', () => {
    const create = moduleSrc.slice(
      moduleSrc.indexOf('CREATE TABLE IF NOT EXISTS signup_attribution'),
      moduleSrc.indexOf('CREATE INDEX IF NOT EXISTS idx_signup_attribution_created_at'),
    );
    expect(create.length).toBeGreaterThan(0);
    for (const col of SIGNUP_ATTRIBUTION_ADDED_COLUMNS) {
      expect(create).toContain(col);
    }
  });

  it('the down migration drops exactly what the up migration added', () => {
    const dropped = [...readFileSync(DOWN, 'utf8').matchAll(/DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]);
    expect(dropped.sort()).toEqual([...SIGNUP_ATTRIBUTION_ADDED_COLUMNS].sort());
  });
});

describe('signup_attribution DDL parity — dialect correctness', () => {
  const moduleSrc = readFileSync(MODULE, 'utf8');

  it('Postgres gets IF NOT EXISTS; SQLite deliberately does not', () => {
    // SQLite has NO `ADD COLUMN IF NOT EXISTS` (verified 3.49, DASH-EXTERNAL-ONLY-W1-PATCH-A);
    // emitting it there is a syntax error, not a compatible no-op. The bare form throws
    // "duplicate column" on re-run and is caught per statement.
    expect(moduleSrc).toContain('ALTER TABLE signup_attribution ADD COLUMN IF NOT EXISTS ${c} TEXT;');
    expect(moduleSrc).toContain('ALTER TABLE signup_attribution ADD COLUMN ${c} TEXT;');
  });

  it('every added column is NULLABLE with no DEFAULT', () => {
    // NULL has to keep meaning "written before CH1" — the scoreboard's raw diagnostic row depends
    // on it, and a DEFAULT would relabel every incumbent row as a real verdict. It is also what
    // makes the ALTER a metadata-only catalog change on PG 11+ (no table rewrite).
    expect(migrationHasNoDefaults(readFileSync(MIGRATION, 'utf8'))).toBe(true);
    expect(moduleSrc).not.toMatch(/ADD COLUMN[^;]*\$\{c\}[^;]*DEFAULT/i);
  });
});

function migrationHasNoDefaults(sql: string): boolean {
  const body = sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
  return !/DEFAULT/i.test(body) && !/NOT\s+NULL/i.test(body);
}

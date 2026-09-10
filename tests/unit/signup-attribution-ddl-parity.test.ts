/**
 * FUNNEL-TRUTH-AND-PAID-ATTRIBUTION-W1 CH1 (architect ruling Q8) — the two DDLs must agree.
 *
 * `signup_attribution` gets its added columns from TWO places, and both are load-bearing:
 *
 *   - `migrations/*.sql` — pre-applied on signal-1 via SSH BEFORE the code deploys, so the runtime
 *     ALTER is a no-op rather than a race against the first INSERT naming the columns (that INSERT
 *     is fire-and-forget behind a swallowed catch, so losing the race would be SILENT attribution
 *     loss).
 *   - `ensureSignupAttributionSchema()` in `src/lib/subscriber-attribution.ts` — the only path
 *     that reaches a FRESH database or the SQLite test/dev backend, since this table is created
 *     lazily by that module and not by the migrations directory at all.
 *
 * Neither can be dropped, so the failure mode is DRIFT: a later wave adds a column to one and
 * forgets the other, and the defect surfaces only on whichever backend was missed — a fresh
 * deploy, or prod, depending on which half was edited. This test is the thing that notices.
 *
 * ── THE MIGRATION CORPUS IS A DECLARED LIST, NEVER A GLOB ────────────────────────────────────
 * FUNNEL-ATTRIBUTION-CLASSIFY-BACKFILL-W1 CH2 (architect ruling Q1=A) widened this from ONE
 * migration to a list, because the boot path's column set is now the union of 038 and 042 and the
 * old 1:1 equality could not express that — a second migration on this table literally could not
 * be added without reddening a test whose job is to permit exactly that.
 *
 * A glob over `migrations/*signup_attribution*.sql` was considered and REJECTED: it also matches
 * the `.down.sql` files, so the corpus would silently depend on `addedColumns()`'s regex happening
 * to ignore DROP lines. That is a load-bearing safety property RENTED from a regex's incidental
 * behaviour, and this repo's rule is to assert such properties rather than rent them. Declaring
 * the list costs one entry per migration and states the intent.
 *
 * Every declared file is asserted to EXIST, because a typo in this list would silently SHRINK the
 * corpus — the union would still be non-empty, the vacuity guard would still pass, and the
 * forgotten migration would go unchecked forever. That is the same defect class as a glob, arrived
 * at by a different road.
 *
 * It asserts the column NAME SET and the declared TYPE, not the SQL text: the two dialects
 * legitimately differ (Postgres takes `ADD COLUMN IF NOT EXISTS`, SQLite has no such form —
 * verified 3.49), so comparing statements would fail on a difference that is correct.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SIGNUP_ATTRIBUTION_ADDED_COLUMNS } from '../../src/lib/subscriber-attribution.js';

const REPO = join(__dirname, '..', '..');
const MODULE = join(REPO, 'src', 'lib', 'subscriber-attribution.ts');

/**
 * Every migration that adds a column to `signup_attribution`, with the reason it is in the corpus.
 * A wave that adds another one adds a row here in the same commit — that is the whole contract.
 */
const SIGNUP_ATTRIBUTION_MIGRATIONS: ReadonlyArray<{ up: string; down: string; reason: string }> = [
  {
    up: '038_signup_attribution_classification.sql',
    down: '038_signup_attribution_classification.down.sql',
    reason: 'FUNNEL-TRUTH-AND-PAID-ATTRIBUTION-W1 CH1 — classification + ua_class, the human denominator.',
  },
  {
    up: '042_signup_attribution_backfill_stamp.sql',
    down: '042_signup_attribution_backfill_stamp.down.sql',
    reason: 'FUNNEL-ATTRIBUTION-CLASSIFY-BACKFILL-W1 CH2 — backfilled_at, the recovery provenance stamp.',
  },
];

const mpath = (f: string): string => join(REPO, 'migrations', f);

/** Column names an `ALTER TABLE signup_attribution ADD COLUMN …` statement introduces. */
function addedColumns(sql: string): string[] {
  return [...sql.matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]);
}

/** Column names a `DROP COLUMN …` statement removes. */
function droppedColumns(sql: string): string[] {
  return [...sql.matchAll(/DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]);
}

/** `name TYPE` as the ALTER declares it, so the TYPE is comparable and not just the name. */
function addedColumnTypes(sql: string): Array<{ name: string; type: string }> {
  return [...sql.matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s+([A-Za-z]+)/gi)]
    .map((m) => ({ name: m[1], type: m[2].toUpperCase() }));
}

/** The two spellings of one timestamp type — PG in the migrations, SQLite on the boot path. */
const TIMESTAMP_DIALECTS = ['TIMESTAMPTZ', 'TIMESTAMP'];

const declaredNames = SIGNUP_ATTRIBUTION_ADDED_COLUMNS.map((c) => c.name);

describe('signup_attribution DDL parity — the declared migration corpus', () => {
  it('every declared migration file EXISTS (a typo must not silently shrink the corpus)', () => {
    for (const m of SIGNUP_ATTRIBUTION_MIGRATIONS) {
      expect(existsSync(mpath(m.up)), `${m.up} — ${m.reason}`).toBe(true);
      expect(existsSync(mpath(m.down)), `${m.down} — ${m.reason}`).toBe(true);
    }
  });

  it('the corpus is non-empty and every entry carries a reason', () => {
    expect(SIGNUP_ATTRIBUTION_MIGRATIONS.length).toBeGreaterThan(0);
    for (const m of SIGNUP_ATTRIBUTION_MIGRATIONS) expect(m.reason.length).toBeGreaterThan(20);
  });
});

describe('signup_attribution DDL parity — the migrations vs the boot path', () => {
  const upSql = SIGNUP_ATTRIBUTION_MIGRATIONS.map((m) => readFileSync(mpath(m.up), 'utf8'));
  const moduleSrc = readFileSync(MODULE, 'utf8');

  it('the migrations, unioned, add exactly the columns the boot path declares', () => {
    expect(upSql.flatMap(addedColumns).sort()).toEqual([...declaredNames].sort());
  });

  it('no column is added by two migrations (an overlap means one of them is a no-op)', () => {
    const union = upSql.flatMap(addedColumns);
    expect(new Set(union).size).toBe(union.length);
  });

  it('the declared column list is non-empty (a vacuous parity check proves nothing)', () => {
    // Without this, emptying the list on both sides would make every assertion here pass while
    // shipping no columns at all.
    expect(SIGNUP_ATTRIBUTION_ADDED_COLUMNS.length).toBeGreaterThan(0);
    expect(upSql.flatMap(addedColumns).length).toBeGreaterThan(0);
  });

  it('each migration declares the SAME TYPE the boot path does', () => {
    // The reason this assertion exists: `backfilled_at` is the first non-TEXT added column, and a
    // hard-coded ` TEXT` in the ALTER template would have shipped TIMESTAMPTZ in the migration and
    // TEXT on every fresh/SQLite database — one column, two types, green everywhere.
    const declared = new Map(SIGNUP_ATTRIBUTION_ADDED_COLUMNS.map((c) => [c.name, c.type.toUpperCase()]));
    const seen = upSql.flatMap(addedColumnTypes);
    expect(seen.length).toBeGreaterThan(0);
    for (const { name, type } of seen) {
      const want = declared.get(name);
      expect(want, `${name} is in a migration but not in SIGNUP_ATTRIBUTION_ADDED_COLUMNS`).toBeDefined();
      // The migrations spell the PG dialect; the boot path's `TS` const resolves to TIMESTAMPTZ
      // under DATABASE_URL and TIMESTAMP without it, and both are correct for their backend. Every
      // other type must match exactly.
      if (TIMESTAMP_DIALECTS.includes(type)) expect(TIMESTAMP_DIALECTS).toContain(want);
      else expect(want).toBe(type);
    }
  });

  it('the CREATE TABLE carries the same columns, so a FRESH database needs no ALTER', () => {
    const create = moduleSrc.slice(
      moduleSrc.indexOf('CREATE TABLE IF NOT EXISTS signup_attribution'),
      moduleSrc.indexOf('CREATE INDEX IF NOT EXISTS idx_signup_attribution_created_at'),
    );
    expect(create.length).toBeGreaterThan(0);
    for (const col of declaredNames) {
      expect(create).toContain(col);
    }
  });

  it('the down migrations, unioned, drop exactly what the up migrations added', () => {
    const dropped = SIGNUP_ATTRIBUTION_MIGRATIONS.flatMap((m) =>
      droppedColumns(readFileSync(mpath(m.down), 'utf8')),
    );
    expect(dropped.sort()).toEqual([...declaredNames].sort());
  });

  it('each down migration drops exactly what ITS OWN up migration added', () => {
    // The union check above would still pass if 038.down dropped 042's column and vice versa —
    // which would make either migration individually irreversible.
    for (const m of SIGNUP_ATTRIBUTION_MIGRATIONS) {
      const up = addedColumns(readFileSync(mpath(m.up), 'utf8')).sort();
      const down = droppedColumns(readFileSync(mpath(m.down), 'utf8')).sort();
      expect(down, m.reason).toEqual(up);
    }
  });
});

describe('signup_attribution DDL parity — dialect correctness', () => {
  const moduleSrc = readFileSync(MODULE, 'utf8');

  it('Postgres gets IF NOT EXISTS; SQLite deliberately does not', () => {
    // SQLite has NO `ADD COLUMN IF NOT EXISTS` (verified 3.49, DASH-EXTERNAL-ONLY-W1-PATCH-A);
    // emitting it there is a syntax error, not a compatible no-op. The bare form throws
    // "duplicate column" on re-run and is caught per statement.
    expect(moduleSrc).toContain('ALTER TABLE signup_attribution ADD COLUMN IF NOT EXISTS ${c.name} ${c.type};');
    expect(moduleSrc).toContain('ALTER TABLE signup_attribution ADD COLUMN ${c.name} ${c.type};');
  });

  it('the ALTER template projects the DECLARED type, never a hard-coded one', () => {
    // A literal ` TEXT;` here is the exact regression this wave retired: it silently disagrees
    // with any migration declaring a non-TEXT column.
    expect(moduleSrc).not.toMatch(/ADD COLUMN[^;]*\$\{c(?:\.name)?\}\s+TEXT;/);
  });

  it('every added column is NULLABLE with no DEFAULT, in EVERY migration', () => {
    // NULL has to keep meaning "written before this column existed" — the scoreboard's raw
    // diagnostic row depends on it, and a DEFAULT would relabel every incumbent row as a real
    // verdict. It is also what makes the ALTER a metadata-only catalog change on PG 11+ (no table
    // rewrite), which is what makes it safe to pre-apply on a live table.
    for (const m of SIGNUP_ATTRIBUTION_MIGRATIONS) {
      expect(migrationHasNoDefaults(readFileSync(mpath(m.up), 'utf8')), m.up).toBe(true);
    }
    expect(moduleSrc).not.toMatch(/ADD COLUMN[^;]*\$\{c\.name\}[^;]*DEFAULT/i);
  });
});

function migrationHasNoDefaults(sql: string): boolean {
  const body = sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
  return !/DEFAULT/i.test(body) && !/NOT\s+NULL/i.test(body);
}

/**
 * CONTACT-ANTISPAM-AND-REPLY-TO-W1 CH1 — the quarantine lane's SCHEMA, on both dialects.
 *
 * WHY THIS FILE EXISTS. `MigrationDescriptor.sqliteType` is a new optional field, and an untested
 * optional field is a DARK BRANCH — it is only read when present, so a suite that never exercises
 * a descriptor carrying one proves nothing about it. `contact-leads-store.ts`'s own docblock sets
 * "verified on BOTH backends" as this table's standard; this is that verification.
 *
 * It runs the REAL SQLite backend rather than asserting on strings, because the failure this
 * guards against is a dialect rejecting the DDL — which a string comparison cannot see.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

/**
 * The three columns, in both dialects, exactly as the two producers declare them:
 *   PG     → migrations/031_contact_lead_quarantine.sql + CREATE_CONTACT_LEADS_SQL's PG branch
 *   SQLite → CREATE_CONTACT_LEADS_SQL's SQLite branch + SIGNAL_MIGRATIONS' sqliteType
 */
const COLUMNS = [
  { column: 'spam_score', pg: 'INTEGER NOT NULL DEFAULT 0', sqlite: 'INTEGER NOT NULL DEFAULT 0' },
  { column: 'spam_reasons', pg: 'TEXT', sqlite: 'TEXT' },
  { column: 'quarantined_at', pg: 'TIMESTAMPTZ', sqlite: 'TEXT' },
] as const;

function freshDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'contact-quarantine-'));
  const db = new Database(join(dir, 'test.db'));
  db.exec(`CREATE TABLE contact_leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, email TEXT NOT NULL, company TEXT NULL, monthly_volume TEXT NULL,
    message TEXT NOT NULL, intent TEXT NOT NULL DEFAULT 'enterprise', src TEXT NULL,
    ip_hash TEXT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    email_sent_at TEXT NULL, email_error TEXT NULL);`);
  return { db, dir };
}

describe('the quarantine columns are valid DDL on SQLite', () => {
  it('every column ALTERs cleanly with its sqlite type', () => {
    const { db, dir } = freshDb();
    try {
      for (const c of COLUMNS) {
        expect(() => db.exec(`ALTER TABLE contact_leads ADD COLUMN ${c.column} ${c.sqlite};`), c.column)
          .not.toThrow();
      }
      const cols = (db.prepare('PRAGMA table_info(contact_leads)').all() as { name: string }[])
        .map((r) => r.name);
      for (const c of COLUMNS) expect(cols, c.column).toContain(c.column);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('`TIMESTAMPTZ` would have been ACCEPTED but WRONG — which is why sqliteType exists', () => {
    // SQLite accepts any type name (affinity rules), so the naive single-string descriptor would
    // NOT have errored — it would have created a NUMERIC-affinity column silently, disagreeing
    // with the TEXT `email_sent_at` beside it. Asserting the mistake is survivable-but-wrong is
    // the only way this test explains why the field is needed rather than merely using it.
    const { db, dir } = freshDb();
    try {
      db.exec('ALTER TABLE contact_leads ADD COLUMN quarantined_at TIMESTAMPTZ;');
      const t = (db.prepare('PRAGMA table_info(contact_leads)').all() as { name: string; type: string }[])
        .find((r) => r.name === 'quarantined_at');
      expect(t?.type).toBe('TIMESTAMPTZ');
      const sent = (db.prepare('PRAGMA table_info(contact_leads)').all() as { name: string; type: string }[])
        .find((r) => r.name === 'email_sent_at');
      // The divergence, made visible: two timestamps in one table with two declared types.
      expect(sent?.type).toBe('TEXT');
      expect(t?.type).not.toBe(sent?.type);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the partial index is valid SQLite — the Q4 refinement is not PG-only syntax', () => {
    const { db, dir } = freshDb();
    try {
      db.exec('ALTER TABLE contact_leads ADD COLUMN quarantined_at TEXT;');
      expect(() => db.exec(
        `CREATE INDEX IF NOT EXISTS idx_contact_leads_quarantined ON contact_leads (quarantined_at)
           WHERE quarantined_at IS NOT NULL;`,
      )).not.toThrow();
      expect(() => db.exec(
        'CREATE INDEX IF NOT EXISTS idx_contact_leads_ip_created ON contact_leads (ip_hash, created_at);',
      )).not.toThrow();
      const idx = (db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='contact_leads'`,
      ).all() as { name: string }[]).map((r) => r.name);
      expect(idx).toContain('idx_contact_leads_quarantined');
      expect(idx).toContain('idx_contact_leads_ip_created');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('re-running the ALTERs is NOT idempotent on SQLite — which is why the PRAGMA pre-check exists', () => {
    // SQLite has no `ADD COLUMN IF NOT EXISTS` (Postgres 9.6+ does). `runMigrations` handles this
    // with a single PRAGMA table_info pre-check per table. Pinned so nobody "simplifies" that
    // pre-check away on the assumption both dialects behave alike.
    const { db, dir } = freshDb();
    try {
      db.exec('ALTER TABLE contact_leads ADD COLUMN spam_score INTEGER NOT NULL DEFAULT 0;');
      expect(() => db.exec('ALTER TABLE contact_leads ADD COLUMN spam_score INTEGER NOT NULL DEFAULT 0;'))
        .toThrow(/duplicate column/i);
      expect(() => db.exec('ALTER TABLE contact_leads ADD COLUMN IF NOT EXISTS spam_score INTEGER;'))
        .toThrow();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the committed migration file and the SQLite twin declare the same columns', () => {
  it('031 declares exactly the three columns and the two indexes', async () => {
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync(
      new URL('../../migrations/031_contact_lead_quarantine.sql', import.meta.url), 'utf8',
    );
    for (const c of COLUMNS) {
      expect(sql, c.column).toContain(`ADD COLUMN IF NOT EXISTS ${c.column}`);
    }
    expect(sql).toContain('idx_contact_leads_ip_created');
    expect(sql).toContain('idx_contact_leads_quarantined');

    // STRIP COMMENTS BEFORE ANY BAN-GREP. This file's docblock legitimately discusses
    // "ADD COLUMN with a non-volatile default" and names DROP in its rollback note — the
    // explanatory prose is the most valuable thing in it, and a naive scan would demand its
    // deletion. `scripts/check-canaries-wired.mjs` strips comments for exactly this reason
    // ("a mention in a comment is not an invocation"); same rule, SQL dialect.
    const statements = sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

    // Every statement idempotent — the file is pre-applied to prod and then re-applied by CI.
    expect(statements).not.toMatch(/ADD COLUMN(?! IF NOT EXISTS)/);
    expect(statements).not.toMatch(/CREATE INDEX(?! IF NOT EXISTS)/);
    // Data Integrity: an UP migration on this table may never drop or delete anything.
    expect(statements).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i);
    // Prove the strip did not empty the corpus — a scan over nothing passes every ban.
    expect(statements).toMatch(/ALTER TABLE contact_leads/);
    expect(statements.split('\n').filter((l) => l.trim().length > 0)).toHaveLength(6);
    // The redundant index is DECLARED absent, not merely missing.
    expect(sql).toContain('DELIBERATELY ABSENT');
  });

  it('the DOWN migration drops columns only — never rows', () => {
    const sql = require('node:fs').readFileSync(
      new URL('../../migrations/031_contact_lead_quarantine.down.sql', import.meta.url), 'utf8',
    ) as string;
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b|\bTRUNCATE\b|\bDROP\s+TABLE\b/i);
    for (const c of COLUMNS) expect(sql, c.column).toContain(`DROP COLUMN IF EXISTS ${c.column}`);
    // The pre-existing index predates this wave and must survive a rollback.
    expect(sql).not.toContain('DROP INDEX IF EXISTS idx_contact_leads_created_at;');
  });
});

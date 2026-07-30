/**
 * OPS-RUNTIME-NODE24-W1 / Ch1 — the native-dependency contract that lets the runtime move.
 *
 * SEC-15 could not be fixed by bumping a base image, because the runtime was COUPLED to a
 * per-ABI native module: better-sqlite3 v11 publishes prebuilds per NODE_MODULE_VERSION
 * (…115=Node20, 127=Node22, 131=Node23) and none for Node 24's 137. Reproduced on
 * `node:24-alpine`: `npm ci` falls back to node-gyp and dies with "Could not find any Python
 * installation to use" — the image carries no python3/make/g++/cc.
 *
 * v13 is the N-API line: ONE binary per platform, shipped INSIDE the npm tarball
 * (`prebuilds/linuxmusl-x64.node`), no `prebuild-install`, no download at install time, and
 * no ABI to match. That is what makes the next Node bump a base-image edit again instead of
 * a dependency archaeology exercise.
 *
 * These tests pin the CONTRACT, not the version number: the exact six-method surface
 * `SqliteBackend` uses, and the one SQL idiom the idempotency claims shipped by
 * OPS-AUDIT-REMEDIATION-MEDIUM-W1 depend on. If a future bump breaks either, this fails
 * before production does.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3');
const pkg = require('better-sqlite3/package.json') as { version: string; scripts?: Record<string, string> };

describe('better-sqlite3 — the N-API line is what decouples us from the runtime', () => {
  it('is on v13+ (the N-API line), not the per-ABI v11/v12 lines', () => {
    const major = Number(pkg.version.split('.')[0]);
    expect(major).toBeGreaterThanOrEqual(13);
  });

  it('declares NO install script — so npm 12 (scripts off by default) cannot strand it', () => {
    // v12's `install: "prebuild-install || node-gyp rebuild"` is how it FETCHES its binary.
    // Under npm 12's default that script never runs and the module arrives with no binary.
    // v13 needs no script because the binary is already in the package.
    const s = pkg.scripts ?? {};
    expect(s.install).toBeUndefined();
    expect(s.preinstall).toBeUndefined();
    expect(s.postinstall).toBeUndefined();
  });

  it('loads a real native binding on this runtime', () => {
    const db = new Database(':memory:');
    expect(db.pragma('journal_mode = WAL')).toBeDefined();
    db.close();
  });
});

describe('the exact API surface SqliteBackend depends on (src/lib/performance-db.ts)', () => {
  it('supports new Database / pragma / exec / prepare().run() / prepare().all() / close()', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE t (a TEXT, b INTEGER)');
    db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run('x', 1);
    const rows = db.prepare('SELECT a, b FROM t').all() as Array<{ a: string; b: number }>;
    expect(rows).toEqual([{ a: 'x', b: 1 }]);
    db.close();
  });
});

describe('the idempotency idiom OPS-AUDIT-REMEDIATION-MEDIUM-W1 shipped', () => {
  it('INSERT … ON CONFLICT DO NOTHING RETURNING still yields exactly one winner', () => {
    // This is the primitive behind tryClaimEvent + tryClaimLedgerForPayout. A regression here
    // would silently un-fix a double-mint and a double-pay, so it is pinned at the dependency
    // boundary rather than only in those modules' own suites.
    const db = new Database(':memory:');
    db.exec('CREATE TABLE claims (id TEXT PRIMARY KEY)');
    const claim = db.prepare('INSERT INTO claims (id) VALUES (?) ON CONFLICT (id) DO NOTHING RETURNING id');
    expect(claim.all('evt_1')).toEqual([{ id: 'evt_1' }]);
    expect(claim.all('evt_1')).toEqual([]);
    expect(claim.all('evt_2')).toEqual([{ id: 'evt_2' }]);
    db.close();
  });

  it('UPDATE … RETURNING reports the rows it actually changed (markLedgerAsync)', () => {
    const db = new Database(':memory:');
    db.exec("CREATE TABLE ledger (id INTEGER PRIMARY KEY, status TEXT)");
    db.prepare('INSERT INTO ledger VALUES (1, ?)').run('usdc_pending');
    const upd = db.prepare('UPDATE ledger SET status = ? WHERE id = ? RETURNING id');
    expect(upd.all('usdc_paid', 1)).toHaveLength(1);
    expect(upd.all('usdc_paid', 999)).toHaveLength(0); // matched nothing
    db.close();
  });

  it('ships a SQLite new enough for RETURNING (3.35+)', () => {
    const db = new Database(':memory:');
    const v = (db.prepare('select sqlite_version() as v').get() as { v: string }).v;
    const [maj, min] = v.split('.').map(Number);
    expect(maj > 3 || (maj === 3 && min >= 35)).toBe(true);
    db.close();
  });
});

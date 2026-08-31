#!/usr/bin/env node
/**
 * bootstrap-pg-schema.mjs — OPS-PG-LANE-BOOTSTRAP-W1.
 *
 * Bring a FRESH Postgres up to the application's own schema, awaited, and then say so with a
 * verdict token.
 *
 * ── WHY THE LANE NEEDED THIS ─────────────────────────────────────────────────────────────────
 *
 * The Postgres lane's only schema step applied `migrations/*.sql`. That set is not the schema:
 * most tables are created by the app itself on first use (`getBackend()`, `initAnalytics()`,
 * `initQuotaDb()`), and the migrations mostly ALTER or INDEX those tables. So on a fresh
 * database the migration step failed on relations that did not exist yet — measured on run
 * 33400151672: `signals`, `request_log`, `quota_usage`, `contact_leads`, `funnel_events`, plus
 * every GRANT to a role the lane never created — while EXITING 0, because the step ran psql
 * without `ON_ERROR_STOP` and piped the output through `grep … || true`. A half-applied schema
 * and a clean one were indistinguishable to the job.
 *
 * The app's lazy DDL did not close the gap either: it was UNORDERED (see `DdlBarrier` /
 * `PgBackend.ddl`), so which tables ended up with their indexes varied per run. That is fixed at
 * the generator; this script is the other half — it makes the bootstrap an EXPLICIT, AWAITED,
 * VERIFIED step instead of a side effect of whichever suite happened to import which module
 * first.
 *
 * ── THE EXPECTATION IS DERIVED, NEVER A HAND-MAINTAINED LIST ─────────────────────────────────
 *
 * The tables to require are read out of the three modules this script actually drives, by
 * grepping their `CREATE TABLE IF NOT EXISTS <name>` statements. A new table added to any of
 * them is covered the day it lands, with nothing to remember — the repo's "enumerate, never
 * count" rule applied to a set that would otherwise rot.
 *
 * DECLARED SCOPE, because a gate that overstates its reach is worse than a narrow one: this
 * covers the three modules whose DDL the migrations depend on. Other stores (referral, geo,
 * chat-analytics, stripe…) still create their tables lazily on first use, and are NOT asserted
 * here. They are also not depended on by any migration, which is why this is the right boundary
 * and not merely a convenient one.
 *
 * ── VERDICT ─────────────────────────────────────────────────────────────────────────────────
 *
 * Exactly one terminal `PG_BOOTSTRAP_VERDICT=OK|INCOMPLETE|INDETERMINATE` line. Callers gate on
 * the TOKEN, never the bare exit code. Codes are 0=OK / 1=INCOMPLETE / 3=INDETERMINATE — 3 is
 * the token-law default for a NEW gate, and is deliberately not `check_test_baseline.sh`'s 2
 * (which is 2 only because it already deployed 2).
 *
 * INDETERMINATE is never a pass: no DATABASE_URL, an unreadable source file, an empty derived
 * expectation, or a failure to reach the database all land there. "Verified nothing" and
 * "verified, clean" must never share an exit code.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const require = createRequire(import.meta.url);

/**
 * The modules this script drives, each with the entrypoint that materialises its DDL. Adding a
 * module here automatically widens the derived expectation, because the expectation is grepped
 * out of the very same `source` file.
 */
const BOOTSTRAP_MODULES = [
  {
    source: 'src/lib/performance-db.ts',
    dist: './dist/lib/performance-db.js',
    // No init export: `getBackend()` is private and runs on first use, so ANY query drives the
    // whole straight-line DDL block. Awaited rather than fired, which is the point of the wave.
    drive: async (m) => { await m.dbQuery('SELECT 1'); },
  },
  {
    source: 'src/lib/analytics.ts',
    dist: './dist/lib/analytics.js',
    drive: async (m) => { m.initAnalytics(); },
  },
  {
    source: 'src/lib/license.ts',
    dist: './dist/lib/license.js',
    drive: async (m) => { m.initQuotaDb(); },
  },
];

function verdict(v, lines = []) {
  for (const l of lines) console.error(l);
  console.log(`PG_BOOTSTRAP_VERDICT=${v}`);
  process.exit(v === 'OK' ? 0 : v === 'INCOMPLETE' ? 1 : 3);
}

/** Every `CREATE TABLE IF NOT EXISTS <name>` a module declares. Throws if the file is unreadable. */
export function tablesDeclaredIn(sourceText) {
  const out = new Set();
  for (const m of sourceText.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
    out.add(m[1].toLowerCase());
  }
  return out;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    verdict('INDETERMINATE', ['DATABASE_URL is unset — nothing was bootstrapped and nothing was verified.']);
  }

  // ── expectation, derived from source ──
  const expected = new Set();
  for (const mod of BOOTSTRAP_MODULES) {
    let text;
    try {
      text = readFileSync(resolve(REPO, mod.source), 'utf8');
    } catch (e) {
      verdict('INDETERMINATE', [`cannot read ${mod.source}: ${e.message}`]);
    }
    for (const t of tablesDeclaredIn(text)) expected.add(t);
  }
  // VACUITY GUARD, and it belongs HERE because this is where the corpus is CONSTRUCTED. An empty
  // expectation would make the comparison below pass over nothing and report a clean bootstrap.
  if (expected.size === 0) {
    verdict('INDETERMINATE', ['derived 0 expected tables — the CREATE TABLE grep matched nothing.']);
  }

  // ── drive the app's own DDL, awaited ──
  for (const mod of BOOTSTRAP_MODULES) {
    let m;
    try {
      m = require(resolve(REPO, mod.dist));
    } catch (e) {
      verdict('INDETERMINATE', [`cannot load ${mod.dist} (was \`npm run build\` run?): ${e.message}`]);
    }
    try {
      await mod.drive(m);
    } catch (e) {
      verdict('INDETERMINATE', [`bootstrap entrypoint for ${mod.source} threw: ${e.message}`]);
    }
  }

  // Drain every fire-and-forget write before observing. Without this the check below races the
  // very DDL it is verifying — the same class of bug the wave exists to remove.
  try {
    const perfdb = require(resolve(REPO, './dist/lib/performance-db.js'));
    await perfdb.awaitDbWrites();
  } catch (e) {
    verdict('INDETERMINATE', [`could not drain pending writes: ${e.message}`]);
  }

  // ── observe ──
  let present;
  try {
    const { Client } = require('pg');
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const r = await c.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`,
    );
    await c.end();
    present = new Set(r.rows.map((x) => String(x.table_name).toLowerCase()));
  } catch (e) {
    verdict('INDETERMINATE', [`could not read information_schema: ${e.message}`]);
  }

  const missing = [...expected].filter((t) => !present.has(t)).sort();
  console.error(`bootstrap: ${expected.size - missing.length}/${expected.size} expected tables present`);
  if (missing.length) {
    verdict('INCOMPLETE', [
      'MISSING after bootstrap — the app declares these tables but they are not in the database:',
      ...missing.map((t) => `   - ${t}`),
      'A migration that ALTERs or INDEXes one of them will fail, and on this lane that failure is silent.',
    ]);
  }
  verdict('OK');
}

/**
 * Two-way self-test. PROVES the derivation can be empty and can miss, so the guard above is
 * known to be able to fail rather than assumed to be. Runs without a database.
 */
function selfTest() {
  const fails = [];
  const t = tablesDeclaredIn('CREATE TABLE IF NOT EXISTS foo (\n);\ncreate table if not exists Bar(');
  if (!(t.has('foo') && t.has('bar') && t.size === 2)) fails.push(`must-find: got ${[...t]}`);
  if (tablesDeclaredIn('-- a comment mentioning tables\nSELECT 1;').size !== 0) {
    fails.push('must-not-find: matched a non-DDL body');
  }
  // The real files must yield a non-empty set, or the vacuity guard is the only thing standing
  // between this gate and a permanent green over nothing.
  for (const mod of BOOTSTRAP_MODULES) {
    const n = tablesDeclaredIn(readFileSync(resolve(REPO, mod.source), 'utf8')).size;
    if (n === 0) fails.push(`${mod.source} declares 0 tables — derivation is broken or the file moved`);
  }
  if (fails.length) {
    for (const f of fails) console.error('   - ' + f);
    console.error('✖ bootstrap-pg-schema self-test FAILED');
    process.exit(1);
  }
  console.log('✔ bootstrap-pg-schema self-test passed');
  process.exit(0);
}

if (process.argv.includes('--self-test')) selfTest();
else main().catch((e) => verdict('INDETERMINATE', [`unhandled: ${e && e.stack ? e.stack : e}`]));

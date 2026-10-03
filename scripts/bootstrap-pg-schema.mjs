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
 * ── …AND THE APP'S OWN BOOT COLUMN RUNNER (SIGNAL-VERDICT-RULE-REGISTRY-W1 CH3, ruling Q2 = A) ──
 *
 * Tables were not the whole schema either. 67 columns — `signals.signal_hash` among them — exist
 * only because `SIGNAL_MIGRATIONS` in src/lib/performance-db.ts ALTERs them in, and the app runs
 * that FIRE-AND-FORGET. This script exited while it was still in flight, so the lane's migration
 * step saw tables without those columns: migrations/047, the first migration to index a column the
 * app adds by ALTER, failed with `column "signal_hash" does not exist` (run 37118831402) while
 * `main` stayed green. The expected (table, column) set is derived from that array exactly as tables
 * are derived from CREATE TABLE, floored at today's count (an empty or shrunken derivation is a
 * broken parser, never a clean bootstrap), and waited for — bounded — on information_schema.
 * This widening was made by SIGNAL-VERDICT-RULE-REGISTRY-W1 in OPS-PG-LANE-BOOTSTRAP-W1's file,
 * following the lane's own rule: "Widening the guarantee means widening BOOTSTRAP_MODULES, not
 * rewriting migrations/".
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
import { fileURLToPath, pathToFileURL } from 'node:url';
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

/** The module whose boot column runner (`SIGNAL_MIGRATIONS`) the expected columns are read from. */
const COLUMN_SOURCE = 'src/lib/performance-db.ts';

/**
 * The floor: the number of (table, column) pairs `SIGNAL_MIGRATIONS` declared on 2026-10-03. A
 * derivation that finds fewer is a parser that stopped matching — the array renamed, its entry
 * shape changed — and would otherwise wave through a bootstrap that verified less than it claims.
 * A wave that genuinely REMOVES an entry lowers this number in the same commit; that is the point.
 */
export const MIN_DECLARED_COLUMNS = 67;

/** Bounded: the app's column runner is fire-and-forget, so wait for it — never forever. */
const COLUMN_WAIT_MS = 60_000;
const COLUMN_POLL_MS = 250;

/**
 * Every `{ table: '<t>', column: '<c>', … }` entry of the `SIGNAL_MIGRATIONS` array, as
 * `table.column` (lowercased). Only that array, and never a whole-line `//` comment inside it.
 */
export function columnsDeclaredIn(sourceText) {
  const out = new Set();
  const block = sourceText.match(/const\s+SIGNAL_MIGRATIONS\s*:\s*MigrationDescriptor\[\]\s*=\s*\[([\s\S]*?)\n\];/);
  if (!block) return out;
  const body = block[1].split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const m of body.matchAll(/\{\s*table:\s*'([A-Za-z_][A-Za-z0-9_]*)',\s*column:\s*'([A-Za-z_][A-Za-z0-9_]*)'/g)) {
    out.add(`${m[1]}.${m[2]}`.toLowerCase());
  }
  return out;
}

/**
 * The vacuity guard for the column expectation, where that corpus is CONSTRUCTED. null = usable;
 * otherwise the reason it must read INDETERMINATE — never a complete expectation.
 */
export function columnExpectationProblem(columns, floor = MIN_DECLARED_COLUMNS) {
  if (columns.size === 0) {
    return `derived 0 columns from ${COLUMN_SOURCE} SIGNAL_MIGRATIONS — the parser matched nothing.`;
  }
  if (columns.size < floor) {
    return `derived ${columns.size} columns from ${COLUMN_SOURCE} SIGNAL_MIGRATIONS, below the floor of ${floor} — ` +
      'the parser lost entries (or a wave removed one without lowering MIN_DECLARED_COLUMNS).';
  }
  return null;
}

/**
 * Poll `readPresent()` (a Set of `table.column`) until every expected column is there or
 * `timeoutMs` has passed. Returns the columns still missing, sorted — [] when complete. A reader
 * that throws REJECTS: an unreadable catalog is INDETERMINATE upstream, never an empty pass.
 */
export async function waitForColumns(expected, readPresent, {
  timeoutMs, pollMs,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const present = await readPresent();
    const missing = [...expected].filter((c) => !present.has(c)).sort();
    if (missing.length === 0 || now() >= deadline) return missing;
    await sleep(pollMs);
  }
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

  // ── …and the columns the app's own boot runner adds (SIGNAL_MIGRATIONS), derived the same way ──
  // Same law, same place: the corpus is constructed HERE, so an empty or shrunken one is a broken
  // parser and reads INDETERMINATE before anything is driven.
  let expectedColumns;
  try {
    expectedColumns = columnsDeclaredIn(readFileSync(resolve(REPO, COLUMN_SOURCE), 'utf8'));
  } catch (e) {
    verdict('INDETERMINATE', [`cannot read ${COLUMN_SOURCE}: ${e.message}`]);
  }
  const columnProblem = columnExpectationProblem(expectedColumns);
  if (columnProblem) verdict('INDETERMINATE', [columnProblem]);

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

  // ── the app's column runner is FIRE-AND-FORGET: wait for it — bounded — on the catalog ──
  let missingColumns;
  const waitStart = Date.now();
  try {
    const { Client } = require('pg');
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      missingColumns = await waitForColumns(expectedColumns, async () => {
        const r = await c.query(
          `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()`,
        );
        return new Set(r.rows.map((x) => `${x.table_name}.${x.column_name}`.toLowerCase()));
      }, { timeoutMs: COLUMN_WAIT_MS, pollMs: COLUMN_POLL_MS });
    } finally {
      await c.end();
    }
  } catch (e) {
    verdict('INDETERMINATE', [`could not read information_schema.columns: ${e.message}`]);
  }
  console.error(
    `bootstrap: columns ${expectedColumns.size - missingColumns.length}/${expectedColumns.size} present ` +
    `(the app's SIGNAL_MIGRATIONS; waited ${((Date.now() - waitStart) / 1000).toFixed(1)} s)`,
  );
  if (missingColumns.length) {
    verdict('INCOMPLETE', [
      `MISSING after a ${COLUMN_WAIT_MS / 1000} s wait — the app's boot column runner declares these columns but they are not in the database:`,
      ...missingColumns.map((col) => `   - ${col}`),
      'A migration that references one of them fails in this lane — migrations/047 did, on signals.signal_hash.',
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

  // ── columns: the app's boot column runner (SIGNAL_MIGRATIONS) ──
  const fixture = [
    "const NOT_IT = [{ table: 'before', column: 'x', type: 'TEXT' }];",
    'const SIGNAL_MIGRATIONS: MigrationDescriptor[] = [',
    "  { table: 'signals', column: 'signal_hash', type: 'VARCHAR(66)' },",
    "  // { table: 'signals', column: 'commented_out', type: 'TEXT' },",
    "  { table: 'Hooks', column: 'State', type: \"TEXT NOT NULL DEFAULT 'active'\" },",
    '];',
  ].join('\n');
  const fc = columnsDeclaredIn(fixture);
  if (!(fc.has('signals.signal_hash') && fc.has('hooks.state') && fc.size === 2)) {
    fails.push(`columns must-find (and skip comments + other arrays): got ${[...fc]}`);
  }
  const floorSet = (n) => new Set(Array.from({ length: n }, (_, i) => `t.c${i}`));
  if (!columnExpectationProblem(new Set())) fails.push('the floor: an EMPTY column set was accepted');
  if (!columnExpectationProblem(floorSet(MIN_DECLARED_COLUMNS - 1))) fails.push('the floor: one below it was accepted');
  if (columnExpectationProblem(floorSet(MIN_DECLARED_COLUMNS))) fails.push('the floor: exactly at it was refused');
  const perf = readFileSync(resolve(REPO, COLUMN_SOURCE), 'utf8');
  const realProblem = columnExpectationProblem(columnsDeclaredIn(perf));
  if (realProblem) fails.push(`the real ${COLUMN_SOURCE} fails its own floor: ${realProblem}`);
  // THE PARSER-BREAK PROOF (ruling Q2 = A, condition 2): break the parser three ways on the REAL
  // file. Each must read INDETERMINATE through the same guard main() uses — never a complete
  // expectation. A break that changes nothing proves nothing, so that is a failure too.
  let kept = 0;
  const breaks = {
    'the array renamed': perf.replace('const SIGNAL_MIGRATIONS', 'const SIGNAL_MIGRATIONZ'),
    'the entry shape changed': perf.replace(/column: '/g, "col: '"),
    'half the entries lost': perf.replace(/\n\s*\{ table: '[^']+', column: '[^']+'[^\n]*/g, (m) => ((kept++ % 2) ? '' : m)),
  };
  for (const [name, text] of Object.entries(breaks)) {
    if (text === perf) fails.push(`parser break "${name}" changed nothing — the proof would prove nothing`);
    else if (columnExpectationProblem(columnsDeclaredIn(text)) === null) {
      fails.push(`parser break "${name}" read as a COMPLETE expectation — the floor did not hold`);
    }
  }
  if (fails.length) {
    for (const f of fails) console.error('   - ' + f);
    console.error('✖ bootstrap-pg-schema self-test FAILED');
    process.exit(1);
  }
  console.log('✔ bootstrap-pg-schema self-test passed');
  process.exit(0);
}

/**
 * Entry guard. Without it, `import`ing this file to reuse its derivation RUNS the gate — which is
 * how an ad-hoc read-only probe against production got `ON_CONFLICT_PARITY_VERDICT=INDETERMINATE`
 * and no data. The repo already states the rule for `scripts/*` ("make entrypoints
 * test-importable"); this is its ESM form.
 */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  if (process.argv.includes('--self-test')) selfTest();
  else main().catch((e) => verdict('INDETERMINATE', [`unhandled: ${e && e.stack ? e.stack : e}`]));
}

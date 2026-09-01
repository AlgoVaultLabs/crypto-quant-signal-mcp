#!/usr/bin/env node
/**
 * check-on-conflict-parity.mjs — OPS-X402-PAYER-WALLET-MIGRATION-W1.
 *
 * THE GATE FOR THE CLASS THAT TOOK THE PAID RAIL DOWN FOR ~25 HOURS.
 *
 * `INSERT … ON CONFLICT (a, b)` does not bind to a COLUMN LIST. Postgres resolves it to a unique
 * INDEX, and if no index matches it does not degrade, warn, or fall back — it raises:
 *
 *   there is no unique or exclusion constraint matching the ON CONFLICT specification
 *
 * `tryClaimPayment` kept `ON CONFLICT (nonce)` after the primary key became
 * `(payer_wallet, nonce)`. Every claim raised, the fail-safe refused, and the paid x402 rail served
 * nothing for about twenty-five hours — through a fully green suite, because every test took the
 * SQLite branch (`INSERT OR IGNORE`, which has no ON CONFLICT clause at all). It was found by an
 * unrelated read-only probe.
 *
 * The Postgres lane was built for that. It was still not enough, and the reason is the reason this
 * script exists: the lane can only catch what a TEST exercises, and the two suites that pin this
 * table's key both force the SQLite backend — one of them by skipping itself outright when
 * DATABASE_URL is set. A gate that asks the DATABASE what constraints it has does not care whether
 * anybody wrote a test.
 *
 * ── WHAT IT DOES ────────────────────────────────────────────────────────────────────────────────
 *
 * 1. Derives every `ON CONFLICT (…)` call site from src/ — comments stripped first, because this
 *    repo discusses ON CONFLICT at length in prose and a gate that false-positives on its own
 *    explanation gets deleted.
 * 2. Resolves each site's target table from the nearest preceding `INSERT INTO`.
 * 3. Reads every non-partial unique index from the live database (a unique CONSTRAINT is backed by
 *    one, so this covers both, and it is what Postgres itself infers against).
 * 4. Fails if a site names a column set with no matching unique index on a table THAT EXISTS.
 *
 * Column ORDER is irrelevant to inference, so the comparison is set-wise.
 *
 * ── WHAT IT DELIBERATELY DOES NOT FAIL ON ───────────────────────────────────────────────────────
 *
 * A site whose table is ABSENT from the database is REPORTED, not failed: most stores create their
 * tables lazily on first use, so a table missing here means "no suite touched that module", which is
 * a coverage fact and not a schema defect. It is printed with a count so the gap is visible rather
 * than inferred. Same for a site whose table or column list is built by string interpolation — it is
 * UNRESOLVED, printed, and never silently dropped.
 *
 * ── WHY ABSENCE IS SAFE, AS A CHECK RATHER THAN AS PROSE ────────────────────────────────────────
 *
 * "Absent is fine" is only true while the absent table has exactly ONE source of DDL — its own
 * store's `CREATE TABLE IF NOT EXISTS`, where the key is declared inline and is therefore created
 * atomically with the table and never altered afterwards. Under that condition the constraint has
 * one possible shape and cannot diverge from the `ON CONFLICT` naming it.
 *
 * The x402 failure needed the opposite: a MIGRATION that changed an existing table's key, so the
 * table had two possible shapes and the code assumed the newer one. So the exact precondition for
 * "absence is benign" is `no migration touches this table` — and that is checkable, so it is
 * CHECKED here rather than argued in a comment. The moment a migration starts touching one of the
 * unchecked tables, its absence stops being benign and this gate says so instead of staying quiet.
 *
 * (Measured 2026-09-01 against the live production schema, all 37 sites: 34 matched automatically
 * and the 3 UNRESOLVED ones were closed by hand — `carry-freshness-helpers.ts` -> `funding_episodes`
 * `{venue,symbol,entry_ts,entry_floor_apr}` and `idempotency.ts` -> `entitlement_debits` `{idem_key}`
 * via its sole caller `entitlement.ts`. Zero mismatches. That measurement is what retired the
 * proposed "widen BOOTSTRAP_MODULES" wave: none of the six unchecked tables is touched by any
 * migration, so widening would have imported six more stores into CI to gate a divergence that
 * cannot occur for them.)
 *
 * The ARBITER-FREE form — a bare `ON CONFLICT DO NOTHING` with no column list — is outside this
 * gate by construction, and that is correct rather than a gap: with no inference target Postgres
 * cannot raise 42P10, so it is not the failure class this exists for. It has its own hazard (it
 * swallows a conflict on ANY constraint, not the one the author meant) which belongs to a
 * different gate.
 *
 * Partial unique indexes (`indpred IS NOT NULL`) are excluded: Postgres will only infer one for an
 * ON CONFLICT that carries a matching WHERE clause, so counting them would let a gate pass over an
 * inference that cannot actually happen.
 *
 * ── VERDICT ─────────────────────────────────────────────────────────────────────────────────────
 *
 * Exactly one terminal `ON_CONFLICT_PARITY_VERDICT=OK|MISMATCH|INDETERMINATE`. 0 / 1 / 3. Callers
 * gate on the TOKEN, never the bare exit code. Deriving zero call sites is INDETERMINATE, never OK:
 * "verified nothing" and "verified, clean" must not share an answer.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const require = createRequire(import.meta.url);

function verdict(v, lines = []) {
  for (const l of lines) console.error(l);
  console.log(`ON_CONFLICT_PARITY_VERDICT=${v}`);
  process.exit(v === 'OK' ? 0 : v === 'MISMATCH' ? 1 : 3);
}

/** Strip block and line comments. A clause quoted in a docblock is not a call site. */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Every ON CONFLICT call site in one file, with the table resolved from the nearest preceding
 * INSERT. `columns: null` marks an interpolated clause; `table: null` an interpolated table — both
 * are UNRESOLVED and reported, never dropped.
 */
export function conflictSites(sourceText, file = '<src>') {
  const src = stripComments(sourceText);
  const out = [];
  const re = /ON\s+CONFLICT\s*\(([^)]*)\)/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const before = src.slice(0, m.index);
    const inserts = [...before.matchAll(/INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+([A-Za-z_$][A-Za-z0-9_${}.]*)/gi)];
    const last = inserts.length ? inserts[inserts.length - 1][1] : null;
    const rawCols = m[1];
    const interpolated = rawCols.includes('${') || rawCols.includes('`');
    const table = last && !last.includes('$') ? last.toLowerCase() : null;
    out.push({
      file,
      line: before.split('\n').length,
      table,
      columns: interpolated
        ? null
        : rawCols.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean),
      raw: m[0].replace(/\s+/g, ' '),
    });
  }
  return out;
}

/**
 * Is this table mentioned anywhere in the forward migrations?
 *
 * Coarse on purpose — any mention counts, because a migration that so much as INDEXES a table has
 * become a second source of DDL for it. But WORD-BOUNDED, which is not optional: a bare substring
 * test reports `signals` as touched because `band_signals` is, and this predicate's false direction
 * costs a RED on a healthy table. A gate that cries wolf once is ignored forever, so the
 * over-reporting direction is the one to close.
 */
export function tablesTouchedByMigrations(migrationTexts) {
  const all = migrationTexts.join('\n').toLowerCase();
  return (name) => new RegExp(`(^|[^a-z0-9_])${name.toLowerCase()}([^a-z0-9_]|$)`).test(all);
}

function walkTs(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkTs(p, acc);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}

const sameSet = (a, b) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

/**
 * Normalise one `array_agg` result to a JS array of lowercased column names.
 *
 * WHY THIS IS NOT PARANOIA. `pg_attribute.attname` is type `name`, not `text`, so
 * `array_agg(attname)` yields `name[]` (OID 1003) — and node-pg ships no parser for that OID, so it
 * hands back the RAW literal `'{payer_wallet,nonce}'`. The first live run of this gate died on
 * `row.cols.map is not a function` and correctly reported INDETERMINATE rather than a false OK,
 * which is the verdict-token law doing its job — but it is a gate that could not run.
 *
 * The query now casts to `::text`, which IS parsed. This function is the belt: it accepts either
 * shape and THROWS a legible error on anything else, so a future type or driver change surfaces as
 * a named failure instead of a TypeError three frames away.
 */
export function normalizeCols(cols) {
  if (Array.isArray(cols)) return cols.map((c) => String(c).toLowerCase());
  if (typeof cols === 'string' && cols.startsWith('{') && cols.endsWith('}')) {
    return cols
      .slice(1, -1)
      .split(',')
      .map((c) => c.replace(/^"|"$/g, '').trim().toLowerCase())
      .filter(Boolean);
  }
  throw new Error(`unexpected array_agg shape from pg (${typeof cols}): ${JSON.stringify(cols)}`);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    verdict('INDETERMINATE', ['DATABASE_URL is unset — no database to compare the call sites against.']);
  }

  let sites;
  try {
    sites = walkTs(resolve(REPO, 'src')).flatMap((f) =>
      conflictSites(readFileSync(f, 'utf8'), f.slice(REPO.length + 1)),
    );
  } catch (e) {
    verdict('INDETERMINATE', [`could not scan src/: ${e.message}`]);
  }
  // VACUITY GUARD, at the point the corpus is CONSTRUCTED. Zero sites means the derivation broke,
  // not that the code is clean, and the comparison below would report a spotless OK over nothing.
  if (sites.length === 0) {
    verdict('INDETERMINATE', ['derived 0 ON CONFLICT call sites — the derivation is broken.']);
  }

  let uniques;
  try {
    const { Client } = require('pg');
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const r = await c.query(`
      SELECT i.indrelid::regclass::text AS tbl,
             array_agg(a.attname::text ORDER BY k.ord)  AS cols
        FROM pg_index i
        JOIN LATERAL unnest(i.indkey::int[]) WITH ORDINALITY AS k(attnum, ord) ON true
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
       WHERE i.indisunique
         AND i.indpred IS NULL
         AND i.indrelid::regclass::text NOT LIKE 'pg\\_%'
       GROUP BY i.indexrelid, i.indrelid`);
    const t = await c.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`,
    );
    await c.end();
    uniques = { byTable: new Map(), present: new Set(t.rows.map((x) => String(x.table_name).toLowerCase())) };
    for (const row of r.rows) {
      const key = String(row.tbl).replace(/^public\./, '').toLowerCase();
      if (!uniques.byTable.has(key)) uniques.byTable.set(key, []);
      uniques.byTable.get(key).push(normalizeCols(row.cols));
    }
  } catch (e) {
    verdict('INDETERMINATE', [`could not read the unique-index catalogue: ${e.message}`]);
  }

  // The precondition that makes an ABSENT table safe to skip. Read here rather than asserted in a
  // comment — see the header. Unreadable migrations are INDETERMINATE, never an implied pass.
  let migrationTouches;
  try {
    const dir = resolve(REPO, 'migrations');
    const texts = readdirSync(dir)
      .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
      .map((f) => readFileSync(join(dir, f), 'utf8'));
    if (texts.length === 0) verdict('INDETERMINATE', ['migrations/ contains no forward .sql files — cannot judge whether an absent table is safe.']);
    migrationTouches = tablesTouchedByMigrations(texts);
  } catch (e) {
    verdict('INDETERMINATE', [`could not read migrations/: ${e.message}`]);
  }

  const mismatches = [];
  const absent = [];
  const absentButMigrated = [];
  const unresolved = [];
  let checked = 0;

  for (const s of sites) {
    if (!s.table || !s.columns) { unresolved.push(s); continue; }
    if (!uniques.present.has(s.table)) {
      (migrationTouches(s.table) ? absentButMigrated : absent).push(s);
      continue;
    }
    checked++;
    const candidates = uniques.byTable.get(s.table) || [];
    if (!candidates.some((cols) => sameSet(cols, s.columns))) {
      mismatches.push({ ...s, have: candidates });
    }
  }

  console.error(
    `on-conflict parity: ${sites.length} site(s) — ${checked} checked, ` +
      `${absent.length} table-absent (reported), ${unresolved.length} unresolved (reported)`,
  );
  for (const u of unresolved) console.error(`   ? UNRESOLVED ${u.file}:${u.line} — ${u.raw}`);
  for (const a of absent) console.error(`   · table absent, not checked — no migration touches it: ${a.table} (${a.file}:${a.line})`);

  if (absentButMigrated.length) {
    verdict('MISMATCH', [
      'A table is ABSENT here AND is touched by a migration. Absence is only safe while a table has',
      'ONE source of DDL; a migration is a second one, and a migration that changes a key is exactly',
      'how ON CONFLICT came to name a constraint that did not exist. Bring it into',
      'scripts/bootstrap-pg-schema.mjs BOOTSTRAP_MODULES so this gate can actually check it.',
      ...absentButMigrated.map((a) => `   ✖ ${a.table} — ${a.file}:${a.line}  ${a.raw}`),
    ]);
  }

  // A run in which NOTHING could be checked is not a pass. The absent/unresolved rows above are
  // fine individually; all of them together means the gate observed nothing.
  if (checked === 0) {
    verdict('INDETERMINATE', ['0 call sites were checkable — no table in the database matched any site.']);
  }

  if (mismatches.length) {
    verdict('MISMATCH', [
      'ON CONFLICT clauses with NO matching unique index — each of these RAISES at runtime, and the',
      'raise is total: the write path refuses every row, it does not degrade.',
      ...mismatches.flatMap((m) => [
        `   ✖ ${m.file}:${m.line}  ${m.raw}`,
        `       table ${m.table} has: ${m.have.length ? m.have.map((c) => `(${c.join(', ')})`).join('  ') : '<no unique index at all>'}`,
      ]),
    ]);
  }
  verdict('OK');
}

/** Two-way self-test: must FIND real sites, must NOT find prose ones. No database required. */
function selfTest() {
  const fails = [];
  const found = conflictSites(
    "const q = `INSERT INTO foo (a,b) VALUES (?,?) ON CONFLICT (a, b) DO NOTHING`;",
  );
  if (found.length !== 1 || found[0].table !== 'foo' || !sameSet(found[0].columns, ['a', 'b'])) {
    fails.push(`must-find: got ${JSON.stringify(found)}`);
  }
  if (conflictSites('// keeps ON CONFLICT (nonce) for history\n/* ON CONFLICT (x) */').length !== 0) {
    fails.push('must-not-find: matched a commented clause');
  }
  const dyn = conflictSites('const q = `INSERT INTO t (a) VALUES (?) ON CONFLICT (${cols.join(",")}) DO NOTHING`;');
  if (dyn.length !== 1 || dyn[0].columns !== null) fails.push('interpolated clause must be UNRESOLVED, not parsed');
  if (!sameSet(['b', 'a'], ['a', 'b'])) fails.push('sameSet must ignore order');
  if (sameSet(['a'], ['a', 'b'])) fails.push('sameSet must reject a subset');

  // The DB-shape seam. A hermetic self-test is blind to exactly what its seam replaces, and this
  // gate's first live run proved it: everything below passed while the real query returned a shape
  // the code could not read. Both driver shapes are now pinned here, and the third case asserts the
  // error is NAMED rather than a TypeError from somewhere else.
  // Each accepted shape is checked inside its own try, so a REGRESSION reports as a named failing
  // check rather than an unhandled stack trace — a self-test whose own output is a traceback is one
  // more thing to decode at the moment you least want to.
  const shape = (label, input, want) => {
    try {
      if (!sameSet(normalizeCols(input), want)) fails.push(label + ': wrong result');
    } catch (e) {
      fails.push(label + ': threw — ' + e.message);
    }
  };
  shape('normalizeCols accepts a parsed array and lowercases it', ['Payer_Wallet', 'nonce'], ['payer_wallet', 'nonce']);
  shape('normalizeCols accepts the RAW name[] literal node-pg cannot parse', '{payer_wallet,nonce}', ['payer_wallet', 'nonce']);
  shape('normalizeCols strips quoting on a quoted identifier', '{"odd name",b}', ['odd name', 'b']);
  try {
    normalizeCols(42);
    fails.push('normalizeCols must THROW on an unknown shape, not return something plausible');
  } catch (e) {
    if (!/unexpected array_agg shape/.test(String(e.message))) {
      fails.push(`normalizeCols threw the wrong error: ${e.message}`);
    }
  }

  // The real tree must yield sites, or the vacuity guard is the only thing between this gate and a
  // permanent green over nothing. Also PIN the known-hard one so a regression in table resolution
  // cannot quietly stop covering the table this gate was written for.
  const real = walkTs(resolve(REPO, 'src')).flatMap((f) =>
    conflictSites(readFileSync(f, 'utf8'), f.slice(REPO.length + 1)),
  );
  if (real.length === 0) fails.push('src/ yielded 0 ON CONFLICT sites — derivation broken');

  // The absence-precondition, both ways. `signals` IS touched by migrations (001 alters it) and
  // `chat_usage_monthly` is touched by none — measured 2026-09-01. If either flips, the reasoning
  // that makes this gate's 'absent, not checked' rows safe has changed and must be re-derived.
  try {
    const dir = resolve(REPO, 'migrations');
    const texts = readdirSync(dir)
      .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
      .map((f) => readFileSync(join(dir, f), 'utf8'));
    const touches = tablesTouchedByMigrations(texts);
    if (!touches('signals')) fails.push('migration-touch probe says signals is untouched — it is altered by 001');
    // The word-boundary property itself, on a real pair from this repo: `band_signals` must not
    // make a lookup for `signals` true by substring, and must be found on its own.
    if (!touches('band_signals')) fails.push('band_signals should be touched (migration 035)');
    if (touches('ignals')) fails.push('touch probe is matching a substring — band_signals/signals would cross-fire');
    if (touches('chat_usage_monthly')) {
      fails.push('chat_usage_monthly is now touched by a migration — its absence is no longer benign; widen BOOTSTRAP_MODULES');
    }
  } catch (e) {
    fails.push(`could not read migrations/ for the absence-precondition probe: ${e.message}`);
  }
  const x402 = real.filter((s) => s.table === 'processed_x402_payments');
  if (x402.length === 0) fails.push('lost coverage of processed_x402_payments — the outage table');
  if (x402.some((s) => !s.columns || !sameSet(s.columns, ['payer_wallet', 'nonce']))) {
    fails.push(`processed_x402_payments site parsed wrong: ${JSON.stringify(x402)}`);
  }

  if (fails.length) {
    for (const f of fails) console.error('   - ' + f);
    console.error('✖ on-conflict-parity self-test FAILED');
    process.exit(1);
  }
  console.log(`✔ on-conflict-parity self-test passed (${real.length} real sites derived)`);
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

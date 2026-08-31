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
import { fileURLToPath } from 'node:url';
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
             array_agg(a.attname ORDER BY k.ord)  AS cols
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
      uniques.byTable.get(key).push(row.cols.map((c) => String(c).toLowerCase()));
    }
  } catch (e) {
    verdict('INDETERMINATE', [`could not read the unique-index catalogue: ${e.message}`]);
  }

  const mismatches = [];
  const absent = [];
  const unresolved = [];
  let checked = 0;

  for (const s of sites) {
    if (!s.table || !s.columns) { unresolved.push(s); continue; }
    if (!uniques.present.has(s.table)) { absent.push(s); continue; }
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
  for (const a of absent) console.error(`   · table absent, not checked: ${a.table} (${a.file}:${a.line})`);

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

  // The real tree must yield sites, or the vacuity guard is the only thing between this gate and a
  // permanent green over nothing. Also PIN the known-hard one so a regression in table resolution
  // cannot quietly stop covering the table this gate was written for.
  const real = walkTs(resolve(REPO, 'src')).flatMap((f) =>
    conflictSites(readFileSync(f, 'utf8'), f.slice(REPO.length + 1)),
  );
  if (real.length === 0) fails.push('src/ yielded 0 ON CONFLICT sites — derivation broken');
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

if (process.argv.includes('--self-test')) selfTest();
else main().catch((e) => verdict('INDETERMINATE', [`unhandled: ${e && e.stack ? e.stack : e}`]));

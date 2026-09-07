/**
 * tests/unit/sql-null-safe-predicate.test.ts — OPS-OUTCOME-BACKFILL-STALL-W1 (SPLIT round)
 *
 * ── Retiring a rule from a COMMENT into a CONTROL ────────────────────────────────────────────
 * SQL three-valued logic makes `NOT (col >= n AND ...)` evaluate to NULL when `col` is NULL —
 * and NULL is FALSE for a WHERE or a FILTER, so every never-set row is dropped SILENTLY. There
 * is no error, no warning, and the query returns a smaller number that looks like a measurement.
 *
 * This wave hit it twice:
 *   1. A1's queue predicate was written WITH an explicit `outcome_attempts IS NULL` arm precisely
 *      to avoid it — and `tests/unit/backfill-queue-backoff.test.ts` pins that arm, because
 *      without it the predicate excludes the ENTIRE historical backlog.
 *   2. One wave later, the same author wrote `COUNT(*) FILTER (WHERE ... AND NOT (outcome_attempts
 *      >= 3 AND outcome_last_attempt_at > cutoff))` in a live reconciliation query and read
 *      **24** where the true value was **3,517** — a 146x understatement, presented as a fact.
 *
 * The rule existed the whole time. It existed as PROSE, in a comment, on the one predicate that
 * already obeyed it. Prose addressed to whoever happens to read it is not a control; the second
 * occurrence was by the person who wrote the first. So it becomes a test.
 *
 * SCOPE, stated honestly: this scans SQL string literals in the TypeScript sources it can reach.
 * It does NOT reach the Python monitoring artifacts (`ops/monitoring/*.py`) — those carry their
 * own assertions inside their own `--self-test` suites, which is where a Python-side check
 * belongs. It is a forward-guard making the shape unwritable here, not an estate-wide sweep.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Source files with comments stripped — a mention in prose is not a predicate. */
function sources(dir: string, out: { path: string; code: string }[] = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { sources(p, out); continue; }
    if (!p.endsWith('.ts')) continue;
    const raw = readFileSync(p, 'utf8');
    out.push({
      path: p,
      code: raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, ''),
    });
  }
  return out;
}

/**
 * Find `NOT ( <col> <cmp> <n> AND ... )` groups that carry no explicit `<col> IS NULL` arm.
 *
 * Deliberately narrow: it targets the exact shape that bit twice, rather than trying to be a
 * general SQL analyser. A broad heuristic here would produce false positives on legitimate
 * NOT-clauses over NOT NULL columns and get the whole test disabled.
 */
export function findNullUnsafeNegations(code: string): string[] {
  const hits: string[] = [];
  const re = /NOT\s*\(\s*(\w+)\s*(?:>=|>|<=|<|=)\s*[^)]*?\bAND\b[^)]*\)/gi;
  for (const m of code.matchAll(re)) {
    const [clause, col] = m;
    // TWO forms make the negation null-safe, and accepting only the first was a real defect in
    // this detector's first version: it flagged `pfe_return_pct IS NOT NULL AND NOT (...)` in
    // src/lib/pfe-scoring.ts, which is CORRECT — the IS NOT NULL guard removes the NULL rows
    // before the NOT ever sees them. A guard that cries wolf on compliant code gets disabled,
    // so the false positive is a defect in the guard, not in the source.
    //   (a) an explicit `col IS NULL` ARM   — the row is handled, not dropped
    //   (b) a `col IS NOT NULL` GUARD       — the NULL rows are excluded upstream
    const safe = new RegExp(`${col}\\s+IS\\s+(NOT\\s+)?NULL`, 'i').test(code);
    if (!safe) hits.push(clause.replace(/\s+/g, ' ').slice(0, 160));
  }
  return hits;
}

describe('SQL three-valued logic — NOT(col >= n AND …) needs an explicit IS NULL arm', () => {
  const files = sources('src');

  it('the corpus is non-empty (a ban-grep over nothing is a vacuous pass)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('the detector FIRES on the exact shape that produced the 24-vs-3,517 misread', () => {
    // The real query, verbatim in shape. If this stops matching, the guard has gone dark.
    const bad = `COUNT(*) FILTER (WHERE created_at + hor <= ep AND NOT (outcome_attempts >= 3 AND outcome_last_attempt_at > ep - 86400))`;
    expect(findNullUnsafeNegations(bad)).toHaveLength(1);
  });

  it('the detector does NOT fire when the IS NULL arm is present', () => {
    const good = `WHERE outcome_price IS NULL AND (outcome_attempts IS NULL OR outcome_attempts < 3 OR outcome_last_attempt_at IS NULL OR outcome_last_attempt_at <= 123)`;
    expect(findNullUnsafeNegations(good)).toEqual([]);
    const alsoGood = `WHERE NOT (outcome_attempts >= 3 AND outcome_last_attempt_at > 1) AND outcome_attempts IS NULL OR true`;
    expect(findNullUnsafeNegations(alsoGood)).toEqual([]);
  });

  it('does NOT flag an IS NOT NULL-guarded negation — the false positive this detector shipped with',
    () => {
      // Verbatim shape from src/lib/pfe-scoring.ts (SQL_PFE_ELIGIBLE). Correct code; the first
      // version of this detector called it an offender.
      const guarded = `pfe_return_pct IS NOT NULL AND NOT (pfe_return_pct = 0 AND mae_return_pct = 0)`;
      expect(findNullUnsafeNegations(guarded)).toEqual([]);
    });

  it('no shipped TypeScript source carries a null-unsafe negated conjunction', () => {
    const offenders = files
      .map(({ path, code }) => ({ path, hits: findNullUnsafeNegations(code) }))
      .filter((f) => f.hits.length > 0);
    expect(offenders.map((f) => `${f.path}: ${f.hits.join(' | ')}`)).toEqual([]);
  });

  it('A1\'s queue predicate — the one that obeyed the rule first — still carries both NULL arms', () => {
    const src = readFileSync('src/lib/performance-db.ts', 'utf8');
    expect(src).toContain('outcome_attempts IS NULL');
    expect(src).toContain('outcome_last_attempt_at IS NULL');
  });
});

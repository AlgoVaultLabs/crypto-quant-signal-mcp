/**
 * counterfactual-quarantine.test.ts — EDGE-WITHHELD-COUNTERFACTUAL-DWR-W1 R1.
 *
 * THE FIREWALL. `hold_decisions` + `hold_decision_labels` hold COUNTERFACTUAL data — labels for
 * trades the engine deliberately did not make, sanctioned for internal research only under the
 * Observed-Path Exception (Mr.1, 2026-08-29). The hard boundary: no counterfactual figure may
 * ever reach public copy, a track-record surface, an MCP response, or any customer-facing
 * artifact. This test makes that boundary STRUCTURAL: any reference to either table from a
 * non-sanctioned file fails the suite — and the suite runs in CI and in the pre-push test gate
 * (`check_test_baseline.sh`), so the reference cannot land, let alone deploy.
 *
 * Deliberately a vitest test riding the EXISTING gates rather than a 12th shared pre-push hook
 * block: identical blocking power (a red unit test blocks push AND CI), none of the shared-hook
 * blast radius that has twice halted every worktree on this machine.
 *
 * ── HOW IT JUDGES ────────────────────────────────────────────────────────────────────────────
 * Comments are STRIPPED before matching — a mention in a comment is not an invocation (same
 * reasoning as check-canaries-wired.mjs). What survives stripping is code, data, or prose that
 * genuinely carries the token. The surviving set must equal ALLOWLIST exactly, both directions:
 *   * a match outside the allowlist  = a new reference — the leak this guard exists to stop;
 *   * an allowlisted file not matching = a stale allowlist row — remove it, or the guard rots
 *     into a permissive list that exonerates files it no longer describes.
 * The allowlist is TIGHT and enumerated file-by-file with a reason per row (config-with-reason
 * law); a glob here would make the guard vacuous.
 *
 * KNOWN LIMIT (accepted, self-tested below): full-line `#`/`--` comments are stripped for
 * sh/py/yaml/sql, but trailing same-line comments in those dialects are NOT — a token there
 * still flags. That errs toward flagging (fail-closed), never toward missing a real reference.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');

/** The counterfactual store: both tables, whole-word. `hold_decision_id` (the FK column name)
 *  matches via the `hold_decision` stem? No — \b keeps it distinct: the regex requires the
 *  full table token, so `hold_decision_id` does NOT match and pure FK column mentions in
 *  unrelated prose stay out of scope. The store is the table names. */
const TOKEN_RE = /\bhold_decisions\b|\bhold_decision_labels\b/;

/** Public-serving-capable corpus: everything that can reach a served surface or a generator.
 *  tests/ and migrations/ are deliberately outside it — a migration IS the sanctioned schema,
 *  and tests (this file included) must be free to name the tables they police. */
const SCAN_ROOTS = ['src', 'scripts', 'ops', 'landing', 'docs', 'docs-src'] as const;

/** Text extensions worth scanning; binaries and lockfiles are noise. */
const SCAN_EXTS = new Set([
  '.ts', '.js', '.mjs', '.cjs', '.sh', '.py', '.sql', '.json', '.yaml', '.yml',
  '.html', '.md', '.txt', '.css',
]);

/**
 * Sanctioned references — file-by-file, each with its reason. NEVER a glob, NEVER a directory.
 * Adding a row is a deliberate act reviewed against the Observed-Path Exception's hard boundary:
 * a public-serving surface (public API, MCP tool/resource handler, track-record query,
 * landing/README generator, JSON-LD) may NEVER be added here.
 */
const ALLOWLIST: ReadonlyMap<string, string> = new Map([
  [
    'src/lib/performance-db.ts',
    'schema owner + the single capture INSERT (recordHoldDecisionImpl); DDL mirrors migration 032',
  ],
  [
    'src/scripts/backfill-hold-decision-labels.ts',
    'the quarantined counterfactual labeler — the ONLY writer of hold_decision_labels',
  ],
  [
    'ops/monitoring/monitoring-inventory.json',
    'inventory row documenting the labeler cron + its quarantine; data about the store, no query',
  ],
  [
    'docs/RUNBOOK-BOOK-LIVENESS-FLIP.md',
    'ops runbook prose naming the capture table as evidence surface; methodology, no figures',
  ],
  [
    'ops/monitoring/scorer-input-identity-canary.py',
    // OPS-SCORER-INPUT-PERSISTENCE-W1 R3. Reads hold_decisions for an ARITHMETIC-IDENTITY check
    // only — the five bucket values, raw0, the three adjustment deltas and raw_final, which are
    // the engine's INPUTS and identical in kind to those captured on the non-quarantined arms.
    // It touches NO counterfactual field: not would_be_side, not suppression_reason, and not
    // hold_decision_labels, whose whole table is outside its query. Its output is a
    // SCORER_IDENTITY_VERDICT= token and row COUNTS — never a label, a rate or a return. It is
    // ops-internal, runs on the host under cron, and reaches no public surface.
    //
    // The hold arm cannot simply be dropped from the check: it carries ~117.3k of ~124.7k
    // captured decisions per day (94% of the corpus), so a canary that skipped it would verify
    // the two small arms and print a green PASS over the big one — the dark-guard shape this
    // estate has hit four times.
    'the R3 arithmetic-identity gate: reads only the scorer INPUT columns + counts, never a counterfactual field or label; ops-internal, no public surface',
  ],
]);

/** Strip comments by dialect so a MENTION is not judged as a REFERENCE. Exported shape kept
 *  local — the self-test below exercises these exact functions, not re-implementations. */
export function stripComments(text: string, ext: string): string {
  switch (ext) {
    case '.ts':
    case '.js':
    case '.mjs':
    case '.cjs':
    case '.css':
      return text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        // line comments, preserving protocol separators (`https://…`)
        .split('\n')
        .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
        .join('\n');
    case '.sh':
    case '.py':
    case '.yaml':
    case '.yml':
      // full-line comments only — a trailing token still flags (fail-closed, see header)
      return text
        .split('\n')
        .map((l) => (/^\s*#/.test(l) ? '' : l))
        .join('\n');
    case '.sql':
      return text
        .split('\n')
        .map((l) => (/^\s*--/.test(l) ? '' : l))
        .join('\n');
    case '.html':
      return text.replace(/<!--[\s\S]*?-->/g, '');
    default:
      // .json / .md / .txt carry no comment syntax we honor — data and prose judge as-is
      return text;
  }
}

export function fileMatches(text: string, ext: string): number[] {
  const lines = stripComments(text, ext).split('\n');
  const hits: number[] = [];
  lines.forEach((l, i) => {
    if (TOKEN_RE.test(l)) hits.push(i + 1);
  });
  return hits;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (SCAN_EXTS.has(extname(name))) out.push(p);
  }
}

interface ScanResult {
  scannedFiles: number;
  matched: Map<string, number[]>; // rel path → post-strip matching line numbers
}

export function scanCorpus(root: string): ScanResult {
  const files: string[] = [];
  for (const r of SCAN_ROOTS) walk(join(root, r), files);
  const matched = new Map<string, number[]>();
  for (const f of files) {
    const hits = fileMatches(readFileSync(f, 'utf8'), extname(f));
    if (hits.length > 0) matched.set(relative(root, f), hits);
  }
  return { scannedFiles: files.length, matched };
}

describe('counterfactual quarantine firewall (EDGE-WITHHELD-COUNTERFACTUAL-DWR-W1 R1)', () => {
  const result = scanCorpus(REPO_ROOT);

  it('scans a non-vacuous corpus and a non-empty, existing allowlist', () => {
    // Vacuity guard: WE construct this corpus, so an empty one is a defect in the test.
    expect(result.scannedFiles).toBeGreaterThan(200);
    expect(ALLOWLIST.size).toBeGreaterThan(0);
    for (const p of ALLOWLIST.keys()) {
      expect(() => statSync(join(REPO_ROOT, p)), `allowlisted file missing: ${p}`).not.toThrow();
    }
  });

  it('no non-sanctioned file references the counterfactual store', () => {
    const offenders = [...result.matched.entries()].filter(([p]) => !ALLOWLIST.has(p));
    const detail = offenders
      .map(([p, lines]) => `  ${p} (post-strip lines: ${lines.join(', ')})`)
      .join('\n');
    expect(
      offenders,
      `COUNTERFACTUAL QUARANTINE BREACH — hold_decisions/hold_decision_labels referenced outside the sanctioned set:\n${detail}\n` +
        `These tables hold counterfactual research data (Observed-Path Exception, 2026-08-29). ` +
        `They must NEVER be read from a public-serving path — public API, MCP tool/resource ` +
        `handlers, track-record queries, landing/README generators, JSON-LD. If this reference ` +
        `is deliberate AND internal-only, add the exact file to ALLOWLIST in ` +
        `tests/unit/counterfactual-quarantine.test.ts with a reason. Otherwise remove it.`,
    ).toEqual([]);
  });

  it('every allowlist row still matches — a stale row must be removed, not carried', () => {
    const stale = [...ALLOWLIST.keys()].filter((p) => !result.matched.has(p));
    expect(
      stale,
      `stale ALLOWLIST rows (file no longer references the store): ${stale.join(', ')} — ` +
        `remove the row so the allowlist stays exactly the sanctioned set.`,
    ).toEqual([]);
  });

  // ── Two-way self-test over the REAL scanner functions ─────────────────────────────────────
  it('self-test: detects a code/data reference (must be able to fail)', () => {
    expect(fileMatches(`const t = 'SELECT * FROM hold_decision_labels';`, '.ts')).toEqual([1]);
    expect(fileMatches(`{"accessor": "hold_decisions.count"}`, '.json')).toEqual([1]);
    expect(fileMatches(`SELECT 1 FROM hold_decisions;`, '.sql')).toEqual([1]);
    // token after a URL on the same line still detected (:// is preserved by the line-strip)
    expect(fileMatches(`const u = 'https://x.y'; join(hold_decisions)`, '.ts')).toEqual([1]);
  });

  it('self-test: a mention in a comment is NOT a reference', () => {
    expect(fileMatches(`// docs: hold_decision_labels is quarantined`, '.ts')).toEqual([]);
    expect(fileMatches(`/* hold_decisions rationale */ const x = 1;`, '.ts')).toEqual([]);
    expect(fileMatches(`# writes only to hold_decision_labels`, '.sh')).toEqual([]);
    expect(fileMatches(`-- hold_decisions is the work-list`, '.sql')).toEqual([]);
    expect(fileMatches(`<!-- hold_decisions -->`, '.html')).toEqual([]);
  });

  it('self-test: FK column name alone is out of scope — the store is the TABLE tokens', () => {
    expect(fileMatches(`const k = row.hold_decision_id;`, '.ts')).toEqual([]);
  });
});

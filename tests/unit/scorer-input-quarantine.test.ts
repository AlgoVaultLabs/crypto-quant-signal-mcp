/**
 * scorer-input-quarantine.test.ts — OPS-SCORER-INPUT-PERSISTENCE-W1 R2.
 *
 * THE FIREWALL, and it lands before the first row is written.
 *
 * The captured scorer inputs — the five bucket values, `raw0`, the three adjustment deltas and
 * the final raw score, on `signal_scorer_inputs` and as columns on `hold_decisions` and
 * `band_signals` — are an INTERNAL measurement corpus. They may never reach public copy, a
 * track-record surface, an MCP response, the Merkle anchor path, or any customer-facing artifact.
 * This test makes that boundary STRUCTURAL: a reference from a non-sanctioned file fails the
 * suite, and the suite runs in CI and in the pre-push test gate (`check_test_baseline.sh`), so
 * the reference cannot land, let alone deploy.
 *
 * Deliberately a vitest test riding the EXISTING gates rather than a new shared pre-push hook
 * block: identical blocking power (a red unit test blocks push AND CI), none of the shared-hook
 * blast radius that has twice halted every worktree on this machine. Shape reused verbatim from
 * `tests/unit/counterfactual-quarantine.test.ts` rather than invented again — two firewalls with
 * two judging rules would be two contracts, and the second one to be written is the one nobody
 * remembers the rules of.
 *
 * ── WHY A SEPARATE FILE FROM THE COUNTERFACTUAL FIREWALL ─────────────────────────────────────
 * That guard's allowlist is deliberately TIGHT — four rows, each a reason. Folding a second token
 * set into it would force its allowlist to grow to the union of two concerns, and an allowlist
 * that covers two things exonerates files for the wrong one. Separate token sets, separate
 * allowlists, one shared judging rule.
 *
 * ── HOW IT JUDGES ────────────────────────────────────────────────────────────────────────────
 * Comments are STRIPPED before matching — a mention in a comment is not an invocation. The
 * surviving set must equal ALLOWLIST exactly, BOTH directions:
 *   * a match outside the allowlist  = a new reference — the leak this guard exists to stop;
 *   * an allowlisted file not matching = a stale row — remove it, or the guard rots into a
 *     permissive list that exonerates files it no longer describes.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');

/**
 * The store: the table, its id space, the three writers/readers, and the column names that only
 * appear when something is actually querying the parts.
 *
 * The COLUMN names matter as much as the table name here, and that is the difference from the
 * counterfactual firewall. Two of the three arms keep their parts as columns on tables that
 * ALREADY have sanctioned readers — `band_signals` is read by the admin-gated
 * `/api/confidence-bands` count — so "does this file name the table" cannot be the test. It has
 * to be "does this file name the PARTS".
 *
 * Verified 2026-08-31 before this file was written: across `src`, `scripts`, `ops`, `landing`,
 * `docs` and `docs-src`, these tokens matched in exactly four files, all of them this wave's own.
 * There is no pre-existing collision — in particular `\boi_score\b` does not match the
 * `oiscore_shadow` family, which carries no underscore in that position.
 */
const TOKEN_RE =
  /\bsignal_scorer_inputs\b|\bscorer_input_id\b|\brecordScorerInputs\b|\brecordScorerInputCapture\b|\bgetScorerInputCounts\b|\braw0\b|\brsi_score\b|\bema_score\b|\bfunding_score\b|\boi_score\b|\bvolume_score\b|\bfunding_delta\b|\bhurst_delta\b|\bsqueeze_delta\b|\braw_final\b|\bfunding_adjust_code\b|\bhurst_adjust_code\b|\bsqueeze_adjust_code\b/;

/** Public-serving-capable corpus: everything that can reach a served surface or a generator.
 *  `tests/` and `migrations/` are deliberately outside it — a migration IS the sanctioned schema,
 *  and tests (this file included) must be free to name what they police. */
const SCAN_ROOTS = ['src', 'scripts', 'ops', 'landing', 'docs', 'docs-src'] as const;

const SCAN_EXTS = new Set([
  '.ts', '.js', '.mjs', '.cjs', '.sh', '.py', '.sql', '.json', '.yaml', '.yml',
  '.html', '.md', '.txt', '.css',
]);

/**
 * Sanctioned references — file-by-file, each with its reason. NEVER a glob, NEVER a directory.
 * Adding a row is a deliberate act: a public-serving surface (public API, MCP tool or resource
 * handler, track-record query, landing/README generator, JSON-LD, the Merkle anchor path) may
 * NEVER be added here.
 */
const ALLOWLIST: ReadonlyMap<string, string> = new Map([
  [
    'src/lib/scorer-input-codes.ts',
    'the pure-data leaf: branch codes, the ScorerParts shape, the identity tolerance, the kill switch',
  ],
  [
    'src/lib/scorer-input-capture.ts',
    'the EMITTED arm capture seam — fire-and-forget wrapper, the only caller of recordScorerInputs',
  ],
  [
    'src/lib/performance-db.ts',
    'schema owner (mirrors migration 036) + the three capture INSERTs + the running-count reader',
  ],
  [
    'src/tools/get-trade-call.ts',
    'THE PRODUCER: deriveVerdict computes raw0 and the deltas; the three persist arms pass them on',
  ],
  [
    'ops/monitoring/scorer-input-identity-canary.py',
    'the R3 arithmetic-identity gate — reads the parts to assert they sum, emits a token, no figures',
  ],
  [
    'ops/monitoring/monitoring-inventory.json',
    'inventory row documenting the identity canary + its schedule; data about the store, no query',
  ],
  [
    'ops/monitoring/alert-registry.json',
    'alert-registry note stating what scorer_input_identity fires on; prose about the store, no query',
  ],
]);

/** Strip comments by dialect so a MENTION is not judged as a REFERENCE.
 *  KNOWN LIMIT (accepted, self-tested below): full-line `#`/`--` comments are stripped for
 *  sh/py/yaml/sql, but TRAILING same-line comments in those dialects are not — a token there
 *  still flags. That errs toward flagging (fail-closed), never toward missing a real reference. */
export function stripComments(text: string, ext: string): string {
  switch (ext) {
    case '.ts':
    case '.js':
    case '.mjs':
    case '.cjs':
    case '.css':
      return text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
        .join('\n');
    case '.sh':
    case '.py':
    case '.yaml':
    case '.yml':
      return text.split('\n').map((l) => (/^\s*#/.test(l) ? '' : l)).join('\n');
    case '.sql':
      return text.split('\n').map((l) => (/^\s*--/.test(l) ? '' : l)).join('\n');
    case '.html':
      return text.replace(/<!--[\s\S]*?-->/g, '');
    default:
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
  matched: Map<string, number[]>;
}

export function scanCorpus(root: string): ScanResult {
  const files: string[] = [];
  for (const r of SCAN_ROOTS) {
    const abs = join(root, r);
    try {
      if (statSync(abs).isDirectory()) walk(abs, files);
    } catch {
      // A scan root that does not exist in this checkout is not an error — `docs-src` is absent
      // in some trees. It IS reported through `scannedFiles`, which is why the vacuity guard
      // below reads that number rather than trusting the roots list.
    }
  }
  const matched = new Map<string, number[]>();
  for (const f of files) {
    const hits = fileMatches(readFileSync(f, 'utf8'), extname(f));
    if (hits.length > 0) matched.set(relative(root, f), hits);
  }
  return { scannedFiles: files.length, matched };
}

describe('scorer-input quarantine firewall (OPS-SCORER-INPUT-PERSISTENCE-W1 R2)', () => {
  const scan = scanCorpus(REPO_ROOT);

  it('scans a non-empty corpus', () => {
    // VACUITY GUARD. A sweep that searched nothing looks exactly like a clean one, and this
    // corpus is CONSTRUCTED by the test — so empty here means the test built nothing, which is a
    // defect in the test rather than a fact about the world. Refuse.
    expect(scan.scannedFiles).toBeGreaterThan(200);
  });

  it('no file outside the allowlist references the scorer-input store', () => {
    const unexpected = [...scan.matched.entries()]
      .filter(([f]) => !ALLOWLIST.has(f))
      .map(([f, lines]) => `${f}:${lines.join(',')}`);
    expect(
      unexpected,
      `A non-sanctioned file references the captured scorer inputs. These are an INTERNAL ` +
        `measurement corpus: they may not reach public copy, a track-record surface, an MCP ` +
        `response, or the Merkle anchor path. If the reference is legitimate, add a row to ` +
        `ALLOWLIST in this file WITH ITS REASON — never a glob.`,
    ).toEqual([]);
  });

  it('every allowlisted file still references the store (no stale rows)', () => {
    const stale = [...ALLOWLIST.keys()].filter((f) => !scan.matched.has(f));
    expect(
      stale,
      `An allowlisted file no longer references the store. Remove the row — an allowlist that ` +
        `exonerates files it no longer describes is a permissive list, not a guard.`,
    ).toEqual([]);
  });

  describe('the judging rule can fail (two-way self-test)', () => {
    // PROVE IT CAN FAIL. Not ceremony: the equivalent step on a sibling gate revealed a
    // self-test that asserted verdict tokens but never the token-to-exit-code mapping, and
    // another where a missing fixture made every assertion vacuous. Each case below is built
    // from the REAL `fileMatches`, never a re-implementation of it.
    it('flags a bare reference in a TS file', () => {
      expect(fileMatches('const x = row.raw0;', '.ts')).toEqual([1]);
    });
    it('flags a SQL query against the emitted arm', () => {
      expect(fileMatches('SELECT raw_final FROM signal_scorer_inputs', '.sql')).toEqual([1]);
    });
    it('flags the parts columns on a sibling table that has sanctioned readers', () => {
      // The case a table-name-only firewall would MISS: `band_signals` is legitimately read by
      // the admin-gated count endpoint, so only naming the PARTS can distinguish a count from a
      // query against the scorer's inputs.
      expect(fileMatches('SELECT rsi_score, hurst_delta FROM band_signals', '.sql')).toEqual([1]);
    });
    it('does NOT flag a TS block comment, a line comment, or a SQL/py comment', () => {
      expect(fileMatches('/* raw0 is captured elsewhere */', '.ts')).toEqual([]);
      expect(fileMatches('// see signal_scorer_inputs', '.ts')).toEqual([]);
      expect(fileMatches('-- raw_final lives here', '.sql')).toEqual([]);
      expect(fileMatches('# funding_delta notes', '.py')).toEqual([]);
    });
    it('does NOT flag the camelCase producer locals, which are not the store', () => {
      // `rsiScore` / `rawScore` are the in-process values every scorer consumer legitimately
      // holds. Flagging those would make the guard fire on `verdict-factors.ts` and the whole
      // scan would collapse into an allowlist of the codebase.
      expect(fileMatches('const rsiScore = 40; const rawScore = 12;', '.ts')).toEqual([]);
    });
    it('does NOT flag the oiscore_shadow family (the near-miss token)', () => {
      expect(fileMatches("SELECT * FROM oiscore_shadow", '.sql')).toEqual([]);
    });
    it('does not silently stop matching (the regex is still live)', () => {
      // Guards against the failure where a token set is edited into something that matches
      // nothing and every future scan reads clean.
      expect(TOKEN_RE.test('signal_scorer_inputs')).toBe(true);
    });
  });
});

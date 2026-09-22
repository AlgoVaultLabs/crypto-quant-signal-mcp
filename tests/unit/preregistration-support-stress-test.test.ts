/**
 * preregistration-support-stress-test.test.ts — EDGE-SELL-ATTRIBUTION-CENTERED-CHECK-W1 R3.
 *
 * THE GATE behind audits/PREREGISTRATION-PROCEDURE.md §4. A pre-registered check that is
 * evaluated at a point the corpus never occupies is UNDEFINED, not failed — and that defect is
 * knowable before any outcome is read, because the registration rule already permits probing
 * cardinalities. EDGE-SELL-ATTRIBUTION-COLLIDER-CONTROL-W1 registered an interaction-stability
 * check on a RAW main effect, i.e. the slope at `ema = 0`, a value the decided corpus never takes
 * (0 of 8,310 rows). The check fired on a centering artifact and cost the arc a wave.
 *
 * WHAT THIS ENFORCES — presence and shape, never truth. Nobody can automate "is this stress-test
 * correct"; everybody can automate "was one done, with a row per registered check". So every
 * `audits/*preregistration*.md` must carry a `## Support stress-test` section holding a table whose
 * header names the four columns (check · evaluation point · support fact · verdict) and which has
 * at least one data row with four cells. Anything less is unlandable: this test runs in CI and in
 * the pre-push test gate (`check_test_baseline.sh`).
 *
 * GRANDFATHERING is an exact-match, reasoned allowlist — never a glob, which would silently absorb
 * every future file it was meant to catch. It is asserted NON-EMPTY, every row must name a file that
 * EXISTS, and a grandfathered file that later GAINS the section makes its row stale and fails the
 * suite (remove the row) — both directions, so the list cannot rot into a permissive exemption.
 *
 * The predicate is self-tested BOTH ways below (a compliant fixture passes; four defective fixtures
 * fail with the named reason), and the failure was proven live at R3 by adding a preregistration
 * file without the section and watching the suite go red before removing it.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const AUDITS_DIR = join(REPO_ROOT, 'audits');

/** Discovery: any top-level audits/ markdown whose FILENAME carries "preregistration". */
const PREREG_FILE_RE = /preregistration.*\.md$/i;
/** The mandatory section heading — any heading level, anywhere in the file. */
const SECTION_RE = /^(#{2,6})\s+.*support stress-test/im;
/** Header cells that must appear, case-insensitively, in the section's table header. */
const REQUIRED_COLUMNS = ['check', 'evaluation point', 'support', 'verdict'] as const;

/**
 * Pre-registrations landed BEFORE the step existed (PROCEDURE §4, 2026-09-05). Exact repo-relative
 * paths with a reason each. A future pre-registration is NEVER added here: it carries the section.
 */
export const GRANDFATHERED: ReadonlyMap<string, string> = new Map([
  [
    'audits/hold-decision-preregistration-2026-08-26.md',
    'landed 2026-08-26 under the HOLD-discipline test (earliest answer ~2026-10-07); amended by §12, never rewritten — a registration is not edited after data accrues',
  ],
  [
    'audits/withheld-dwr-preregistration-2026-08-30.md',
    'landed 2026-08-30; its curve was measured and published in the vault the same day, so the step could only be applied retroactively, which is a forking path',
  ],
  [
    'audits/attribution-gate-preregistration-2026-09-04.md',
    'landed 2026-09-04; a row-count gate with no statistical check to stress-test — its only evaluation point is a cardinality',
  ],
  [
    'audits/sell-feature-attribution-preregistration-2026-09-04.md',
    'landed 2026-09-04 (EDGE-SELL-FEATURE-ATTRIBUTION-W1); its result is published and corrected in the vault record — rewriting the registration would launder a post-hoc step',
  ],
  [
    'audits/sell-attribution-collider-control-preregistration-2026-09-05.md',
    'landed 2026-09-05 (EDGE-SELL-ATTRIBUTION-COLLIDER-CONTROL-W1); the file whose raw-main-effect check IS the defect this gate retires — its successor registers the corrected check on unseen data instead of editing this one',
  ],
]);

export interface StressTestVerdict {
  ok: boolean;
  reason: string;
  rows: number;
}

/** Pure predicate over the markdown text. Exported so the self-test builds fixtures with the REAL parser. */
export function stressTestVerdict(md: string): StressTestVerdict {
  const m = SECTION_RE.exec(md);
  if (!m) return { ok: false, reason: 'no "## Support stress-test" section', rows: 0 };
  const level = m[1].length;
  const after = md.slice(m.index + m[0].length);
  // The section ends at the next heading of the same or a higher level.
  const endRe = new RegExp(`^#{1,${level}}\\s`, 'm');
  const end = after.search(endRe);
  const section = end === -1 ? after : after.slice(0, end);
  const tableLines = section
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|'));
  if (tableLines.length < 3) {
    return { ok: false, reason: 'section carries no table (header + separator + at least one row)', rows: 0 };
  }
  const header = tableLines[0].toLowerCase();
  for (const col of REQUIRED_COLUMNS) {
    if (!header.includes(col)) return { ok: false, reason: `table header lacks a "${col}" column`, rows: 0 };
  }
  const dataRows = tableLines.slice(2).filter((l) => {
    const cells = l.split('|').slice(1, -1).map((c) => c.trim());
    return cells.length >= 4 && cells.filter((c) => c.length > 0).length >= 4;
  });
  if (dataRows.length === 0) {
    return { ok: false, reason: 'table has no data row with four non-empty cells', rows: 0 };
  }
  return { ok: true, reason: '', rows: dataRows.length };
}

/**
 * PROCEDURE §4b — the discriminating-power precondition (EDGE-HURST-DISCRIMINATION-PROBE-W1, architect Q13).
 * A registration that reads a statistic against a POSITIVE CONTROL must carry `## Operating characteristic`
 * with a table (truth · P(reads below the control) · required · result), at least one null row and one
 * control row, and every result PASS. Presence and shape only — the numbers' truth is the author's.
 */
// Whitespace/hyphen-insensitive across line breaks, plus the reading's own vocabulary, so a hard-wrapped or
// differently worded reliability registration cannot escape the precondition.
const OC_TRIGGER_RE = /positive[\s-]+control|test[\s-]+retest|self[\s-]+agreement|reliability_reading|BELOW_PC\d/i;
const OC_SECTION_RE = /^(#{2,6})\s+.*operating characteristic/im;
const OC_COLUMNS = ['truth', 'p(reads below the control)', 'required', 'result'] as const;
/** Exact, reasoned exemptions from §4b — the rule's own text is not a registration. Never a glob. */
export const OC_EXEMPT: ReadonlyMap<string, string> = new Map([
  ['audits/PREREGISTRATION-PROCEDURE.md', 'the procedure DEFINES §4b and names the positive control generically; it is the rule, not a registration of a test'],
]);

export interface OcVerdict {
  applies: boolean;
  ok: boolean;
  reason: string;
  rows: number;
}

export function ocSectionVerdict(md: string): OcVerdict {
  if (!OC_TRIGGER_RE.test(md)) return { applies: false, ok: true, reason: '', rows: 0 };
  const m = OC_SECTION_RE.exec(md);
  if (!m) return { applies: true, ok: false, reason: 'mentions a positive control but has no "## Operating characteristic" section', rows: 0 };
  const level = m[1].length;
  const after = md.slice(m.index + m[0].length);
  const end = after.search(new RegExp(`^#{1,${level}}\\s`, 'm'));
  const section = end === -1 ? after : after.slice(0, end);
  // The FIRST contiguous table of the section is the operating characteristic; a later (descriptive) table
  // in a subsection is not part of it.
  const all = section.split('\n').map((l) => l.trim());
  const first = all.findIndex((l) => l.startsWith('|'));
  const lines: string[] = [];
  if (first !== -1) for (let i = first; i < all.length && all[i].startsWith('|'); i++) lines.push(all[i]);
  if (lines.length < 4) return { applies: true, ok: false, reason: 'operating-characteristic table needs a header, a separator and >= 2 rows', rows: 0 };
  const header = lines[0].toLowerCase();
  for (const col of OC_COLUMNS) {
    if (!header.includes(col)) return { applies: true, ok: false, reason: `operating-characteristic table lacks a "${col}" column`, rows: 0 };
  }
  const rows = lines.slice(2).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
  const cols = lines[0].split('|').slice(1, -1).map((c) => c.trim().toLowerCase());
  const iTruth = cols.findIndex((c) => c.includes('truth'));
  const iResult = cols.findIndex((c) => c.includes('result'));
  if (rows.some((r) => r.length < cols.length || r.some((c) => c.length === 0))) {
    return { applies: true, ok: false, reason: 'operating-characteristic row with an empty cell', rows: rows.length };
  }
  if (!rows.some((r) => /null/i.test(r[iTruth]))) return { applies: true, ok: false, reason: 'no null-truth row', rows: rows.length };
  if (!rows.some((r) => /control|pc\d/i.test(r[iTruth]))) return { applies: true, ok: false, reason: 'no control-truth row', rows: rows.length };
  const failed = rows.filter((r) => !/^\W*PASS\b/.test(r[iResult]));
  if (failed.length) return { applies: true, ok: false, reason: `a row whose result is not PASS: ${failed[0].join(' | ')}`, rows: rows.length };
  // The numbers, not the word: every row's probability must satisfy its own `required` bound, and the bounds
  // must be at least as strict as oc_gate's (null >= 0.80, control <= 0.20).
  const iP = cols.findIndex((c) => c.includes('p(reads below the control)'));
  const iReq = cols.findIndex((c) => c.includes('required'));
  for (const r of rows) {
    const p = Number((r[iP].match(/[01](?:\.\d+)?/) ?? [''])[0]);
    const m = r[iReq].match(/(>=|≥|<=|≤)\s*([01](?:\.\d+)?)/);
    if (!Number.isFinite(p) || r[iP].match(/[01](?:\.\d+)?/) === null || !m) {
      return { applies: true, ok: false, reason: `unparseable probability or bound: ${r.join(' | ')}`, rows: rows.length };
    }
    const bound = Number(m[2]);
    const ge = m[1] === '>=' || m[1] === '≥';
    const isNull = /null/i.test(r[iTruth]);
    if (isNull && (!ge || bound < 0.8)) return { applies: true, ok: false, reason: `null row bound weaker than >= 0.80: ${r.join(' | ')}`, rows: rows.length };
    if (!isNull && (ge || bound > 0.2)) return { applies: true, ok: false, reason: `control row bound weaker than <= 0.20: ${r.join(' | ')}`, rows: rows.length };
    if (ge ? !(p >= bound) : !(p <= bound)) return { applies: true, ok: false, reason: `the number fails its bound although marked PASS: ${r.join(' | ')}`, rows: rows.length };
  }
  return { applies: true, ok: true, reason: '', rows: rows.length };
}

function discoverPreregistrations(): string[] {
  return readdirSync(AUDITS_DIR)
    .filter((f) => PREREG_FILE_RE.test(f))
    .map((f) => `audits/${f}`)
    .sort();
}

describe('preregistration support stress-test gate', () => {
  it('the grandfather allowlist is non-empty, exact-matched, reasoned, and every row names an existing file', () => {
    expect(GRANDFATHERED.size).toBeGreaterThan(0);
    for (const [path, reason] of GRANDFATHERED) {
      expect(path, 'allowlist rows are exact repo-relative paths, never globs').not.toMatch(/[*?[\]]/);
      expect(path.startsWith('audits/'), `allowlist row outside audits/: ${path}`).toBe(true);
      expect(reason.trim().length, `allowlist row has no reason: ${path}`).toBeGreaterThanOrEqual(40);
      expect(existsSync(join(REPO_ROOT, path)), `stale allowlist row — file is gone: ${path}`).toBe(true);
    }
  });

  it('every pre-registration carries a Support stress-test table, or is grandfathered by an exact row', () => {
    const files = discoverPreregistrations();
    // Vacuity guard: the corpus is the repo, and it is known to hold pre-registrations. Zero means the
    // discovery broke, not that the world is empty.
    expect(files.length, 'discovery found no audits/*preregistration*.md — the scan is broken').toBeGreaterThan(0);
    const failures: string[] = [];
    for (const rel of files) {
      const verdict = stressTestVerdict(readFileSync(join(REPO_ROOT, rel), 'utf8'));
      const grandfathered = GRANDFATHERED.has(rel);
      if (grandfathered && verdict.ok) {
        failures.push(`${rel}: carries the section now — REMOVE its grandfather row (stale exemption)`);
      } else if (!grandfathered && !verdict.ok) {
        failures.push(`${rel}: ${verdict.reason} — see audits/PREREGISTRATION-PROCEDURE.md §4`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('PROCEDURE §4b: every pre-registration that reads against a positive control carries a passing Operating characteristic table', () => {
    const files = discoverPreregistrations();
    expect(files.length).toBeGreaterThan(0);
    const failures = files
      .map((rel) => ({ rel, v: ocSectionVerdict(readFileSync(join(REPO_ROOT, rel), 'utf8')) }))
      .filter(({ rel, v }) => v.applies && !v.ok && !OC_EXEMPT.has(rel))
      .map(({ rel, v }) => `${rel}: ${v.reason} — see audits/PREREGISTRATION-PROCEDURE.md §4b`);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('§4b exemptions are exact, reasoned, and name existing files', () => {
    for (const [path, reason] of OC_EXEMPT) {
      expect(path).not.toMatch(/[*?[\]]/);
      expect(reason.trim().length).toBeGreaterThanOrEqual(40);
      expect(existsSync(join(REPO_ROOT, path)), `stale §4b exemption: ${path}`).toBe(true);
    }
  });

  it('self-test (§4b): the OC predicate passes a compliant table and FAILS each defective shape', () => {
    const good = [
      '# R', 'We read kappa against a positive control.', '## 11. Operating characteristic', '',
      '| truth | P(reads below the control) | required | result |', '|---|---|---|---|',
      '| null (iid + factor) | 0.94 | >= 0.80 | PASS |', '| control PC1 | 0.00 | <= 0.20 | PASS |', '', '## 12. Next',
    ].join('\n');
    expect(ocSectionVerdict(good)).toEqual({ applies: true, ok: true, reason: '', rows: 2 });
    expect(ocSectionVerdict('# no trigger here').applies).toBe(false);
    expect(ocSectionVerdict(good.replace('## 11. Operating characteristic', '## 11. Something')).reason).toMatch(/no "## Operating characteristic" section/);
    expect(ocSectionVerdict(good.replace('| 0.94 | >= 0.80 | PASS |', '| 0.47 | >= 0.80 | FAIL |')).reason).toMatch(/not PASS/);
    expect(ocSectionVerdict(good.replace('| null (iid + factor) |', '| iid |')).reason).toMatch(/no null-truth row/);
    expect(ocSectionVerdict(good.replace('| control PC1 |', '| alt |')).reason).toMatch(/no control-truth row/);
    expect(ocSectionVerdict(good.replace('| result |', '| outcome |')).reason).toMatch(/lacks a "result" column/);
    expect(ocSectionVerdict(good.replace('| control PC1 | 0.00 | <= 0.20 | PASS |', '')).ok).toBe(false);
    // the numbers are checked, not the word
    expect(ocSectionVerdict(good.replace('| 0.94 | >= 0.80 | PASS |', '| 0.47 | >= 0.80 | PASS |')).reason).toMatch(/fails its bound/);
    expect(ocSectionVerdict(good.replace('| 0.00 | <= 0.20 | PASS |', '| 0.35 | <= 0.20 | PASS |')).reason).toMatch(/fails its bound/);
    expect(ocSectionVerdict(good.replace('| 0.94 | >= 0.80 | PASS |', '| 0.94 | >= 0.60 | PASS |')).reason).toMatch(/weaker than >= 0.80/);
    expect(ocSectionVerdict(good.replace('| 0.00 | <= 0.20 | PASS |', '| 0.00 | <= 0.50 | PASS |')).reason).toMatch(/weaker than <= 0.20/);
    // the trigger survives a hard wrap and other vocabulary
    expect(ocSectionVerdict('# R\nread against a positive\ncontrol').applies).toBe(true);
    expect(ocSectionVerdict('# R\na test-retest of the estimator').applies).toBe(true);
    // a descriptive table in a subsection after the OC table is not read as part of it
    const withSub = good.replace('## 12. Next', '### 11b. Reported\n\n| truth | P(BELOW) |\n|---|---|\n| regime switch | 0.52 |\n\n## 12. Next');
    expect(ocSectionVerdict(withSub)).toEqual({ applies: true, ok: true, reason: '', rows: 2 });
  });

  it('self-test: the predicate passes a compliant section and FAILS each defective shape with its named reason', () => {
    const good = [
      '# Some pre-registration',
      '## 3. Designs',
      'text',
      '## 8. Support stress-test — every registered check against the corpus support',
      '',
      '| check | evaluation point | support / cardinality fact | verdict |',
      '|---|---|---|---|',
      '| interaction stability | main effect at the covariate MEANS (AME identity) | every term is a row-wise slope at an occupied point | inside |',
      '',
      '## 9. Deviations',
    ].join('\n');
    expect(stressTestVerdict(good)).toEqual({ ok: true, reason: '', rows: 1 });

    const noSection = good.replace(/^## 8\. Support stress-test.*$/m, '## 8. Something else');
    expect(stressTestVerdict(noSection).ok).toBe(false);
    expect(stressTestVerdict(noSection).reason).toMatch(/no "## Support stress-test" section/);

    const emptyTable = good.replace(/^\| interaction stability.*$/m, '');
    expect(stressTestVerdict(emptyTable).ok).toBe(false);
    expect(stressTestVerdict(emptyTable).reason).toMatch(/no table|no data row/);

    const badHeader = good.replace('| verdict |', '| outcome |');
    expect(stressTestVerdict(badHeader).ok).toBe(false);
    expect(stressTestVerdict(badHeader).reason).toMatch(/lacks a "verdict" column/);

    const threeCells = good.replace(
      /^\| interaction stability.*$/m,
      '| interaction stability | main effect at the means | inside |',
    );
    expect(stressTestVerdict(threeCells).ok).toBe(false);
    expect(stressTestVerdict(threeCells).reason).toMatch(/four non-empty cells/);

    // A row in a LATER section must not satisfy the requirement — the table has to live in the section.
    const tableElsewhere = good
      .replace(/^\| interaction stability.*$/m, '')
      .replace(/^\| check \|.*$/m, '')
      .replace(/^\|---\|---\|---\|---\|$/m, '')
      + '\n| check | evaluation point | support | verdict |\n|---|---|---|---|\n| a | b | c | d |\n';
    expect(stressTestVerdict(tableElsewhere).ok).toBe(false);
  });
});

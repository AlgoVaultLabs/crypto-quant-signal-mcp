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

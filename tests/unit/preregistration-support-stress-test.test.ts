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
 *
 * PROCEDURE §4c (OPS-PREREG-IDENTIFIABILITY-GATE-W1) is the one check here that is TRUTH as well as
 * shape: the gate recomputes every declared floor's 2m bound through ops/monitoring/population_comparison.py
 * by subprocess and compares the stated bound and verdict against it. SPAWN BUDGET DECLARED on every
 * block that reaches python3 or node — `scripts/check-test-budget.mjs` reads `timeout:` from the
 * options argument, and a cold python3 start blows the 5,000ms default on a loaded CI runner.
 *
 * PROCEDURE §4d (OPS-PREREG-SERVED-RULE-GATE-W1) applies only to a registration that DECLARES a
 * served-rule study with a line starting `SERVED_RULE_STUDY:`. It must carry an answer-key ceiling
 * and a component map (`servedRuleVerdict`). Presence and shape only; no subprocess. Six worked
 * fixtures, one per outcome: tests/fixtures/served-rule/.
 *
 * PROCEDURE §4e (OPS-PREREG-FIT-VENUE-GATE-W1) is MANDATORY on every registration that is not
 * grandfathered: one line starting `FIT_VENUE:` that names BINANCE as the fit venue, or NONE with a
 * reason (`fitVenueVerdict`). Presence and shape only; no subprocess. Six worked fixtures:
 * tests/fixtures/fit-venue/.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
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

/**
 * PROCEDURE §4c — identifiability at DECLARATION (OPS-PREREG-IDENTIFIABILITY-GATE-W1).
 *
 * A floor on a rate, edge or excess comparison is a promise that the comparison can move that far.
 * An arm whose minority side carries a share m of its rows can never show more than 2m, whatever the
 * outcomes, and m is a cardinality, so §1 lets it be probed before the registration lands. The
 * 2026-08-31 trend-mode trigger A declared a 3.0pp floor against an arm whose 2m was 1.06pp. The
 * readout refused it after it had been armed; this gate refuses it before the registration lands.
 *
 * MANDATORY on every registration that is not grandfathered (architect Q1 = A, 2026-10-01): either
 * the table or the single line `NO_RATE_FLOOR_DECLARED - <reason>`, never both, never neither. A word
 * trigger cannot tell a rate floor from a cluster floor: every registration landed before this gate
 * uses the word "floor", mostly for cluster floors. So the absence of a rate floor is DECLARED,
 * never inferred.
 *
 * ONE FORMULA. 2m is never computed in this file. It is `attainable_bound_from_share` in
 * ops/monitoring/population_comparison.py, reached by subprocess through `--declarations`, and the
 * same entry point serves the registry surface (scripts/check-population-comparison.mjs).
 */
const IDENT_SECTION_RE = /^(#{2,6})[ \t]+(?:§?\d+(?:\.\d+)*[a-z]?\.?[ \t]+)?identifiability\b/im;
const NO_RATE_FLOOR_RE = /^[ \t]*`?NO_RATE_FLOOR_DECLARED`?[ \t]*[-–—:][ \t]*(\S.*)$/m;
const PY_DERIVATION = join(REPO_ROOT, 'ops/monitoring/population_comparison.py');
const IDENT_FIXTURES = join(REPO_ROOT, 'tests/fixtures/identifiability');

/** Registrations landed BEFORE §4c existed (2026-10-01). Exact paths, a reason each; never a glob. */
export const IDENT_GRANDFATHERED: ReadonlyMap<string, string> = new Map([
  ['audits/hold-decision-preregistration-2026-08-26.md', 'landed 2026-08-26 by OPS-HOLD-DECISION-CAPTURE-W1, before §4c existed; a landed registration is amended by appended sections, never rewritten'],
  ['audits/withheld-dwr-preregistration-2026-08-30.md', 'landed 2026-08-30 by EDGE-WITHHELD-COUNTERFACTUAL-DWR-W1, before §4c existed; its curve was read the same day, so a retro-stated bound would be post-hoc'],
  ['audits/attribution-gate-preregistration-2026-09-04.md', 'landed 2026-09-04 by EDGE-ATTRIBUTION-CORPUS-DRAIN-W1, before §4c existed; a row-count gate, never rewritten after landing'],
  ['audits/sell-feature-attribution-preregistration-2026-09-04.md', 'landed 2026-09-04 by EDGE-SELL-FEATURE-ATTRIBUTION-W1, before §4c existed; its result is published in the vault record and never rewritten'],
  ['audits/sell-attribution-collider-control-preregistration-2026-09-05.md', 'landed 2026-09-05 by EDGE-SELL-ATTRIBUTION-COLLIDER-CONTROL-W1, before §4c existed; a landed registration is never edited after data accrues'],
  ['audits/sell-attribution-centered-check-preregistration-2026-09-05.md', 'landed 2026-09-06 by EDGE-SELL-ATTRIBUTION-CENTERED-CHECK-W1, before §4c existed; a landed registration is never edited after data accrues'],
  ['audits/sell-attribution-long-timeframe-check-preregistration-2026-09-09.md', 'landed 2026-09-09 by EDGE-SELL-ATTRIBUTION-CENTERED-CHECK-W2, before §4c existed; a landed registration is never edited after data accrues'],
  ['audits/withheld-dwr-w2-preregistration-2026-09-10.md', 'landed 2026-09-10 by EDGE-WITHHELD-COUNTERFACTUAL-DWR-W2, before §4c existed; a landed registration is never edited after data accrues'],
  ['audits/scorer-predictive-ceiling-preregistration-2026-09-21.md', 'landed 2026-09-22 by EDGE-SCORER-PREDICTIVE-CEILING-W1, before §4c existed; its verdict (NO_CEILING) is read, so a retro-stated bound would be post-hoc'],
  ['audits/hurst-discrimination-preregistration-2026-09-22.md', 'landed 2026-09-22 by EDGE-HURST-DISCRIMINATION-PROBE-W1, before §4c existed; a landed registration is never edited after data accrues'],
  ['audits/labeler-race-window-v2-preregistration-2026-09-28.md', 'landed 2026-09-28 by EDGE-LABELER-RACE-WINDOW-V2-W1, before §4c existed; a landed registration is never edited after data accrues'],
]);

/** Exact, reasoned exemptions — the rule's own text is not a registration. Never a glob. */
export const IDENT_EXEMPT: ReadonlyMap<string, string> = new Map([
  ['audits/PREREGISTRATION-PROCEDURE.md', 'the procedure DEFINES §4c and shows its table schematically; it carries no figure and registers no test'],
]);

export interface IdentRow {
  comparison: string;
  arm: string;
  m: number;
  floor: number;
  bound: number;
  boundDecimals: number;
  verdict: 'IDENTIFIABLE' | 'NOT_IDENTIFIABLE';
  restatement: string | null;
}

export interface IdentShape {
  ok: boolean;
  reason: string;
  rows: IdentRow[];
  sentinel: string | null;
}

/** The FIRST number in a cell, its decimal count, and whether a `%` follows it. Unicode minus allowed. */
function firstNumber(cell: string): { value: number; decimals: number; percent: boolean } | null {
  const m = /(-?\d+)(?:\.(\d+))?([ \t]*%)?/.exec(cell.replace(/−/g, '-'));
  if (!m) return null;
  return { value: Number(m[2] === undefined ? m[1] : `${m[1]}.${m[2]}`), decimals: (m[2] ?? '').length, percent: Boolean(m[3]) };
}

const cellsOf = (line: string): string[] => line.split('|').slice(1, -1).map((c) => c.trim());

/** Presence and shape of §4c — pure, no subprocess. Arithmetic is `identifiabilityArithmetic`. */
export function identifiabilityShape(md: string): IdentShape {
  const fail = (reason: string): IdentShape => ({ ok: false, reason, rows: [], sentinel: null });
  const m = IDENT_SECTION_RE.exec(md);
  if (!m) return fail('no "## Identifiability" section (PROCEDURE §4c)');
  const level = m[1].length;
  const after = md.slice(m.index + m[0].length);
  const end = after.search(new RegExp(`^#{1,${level}}\\s`, 'm'));
  const section = end === -1 ? after : after.slice(0, end);
  const sentinel = NO_RATE_FLOOR_RE.exec(section);
  const all = section.split('\n').map((l) => l.trim());
  const first = all.findIndex((l) => l.startsWith('|'));
  const lines: string[] = [];
  if (first !== -1) for (let i = first; i < all.length && all[i].startsWith('|'); i++) lines.push(all[i]);
  if (sentinel && lines.length) return fail('section carries both a table and NO_RATE_FLOOR_DECLARED — one or the other');
  if (sentinel) {
    const why = sentinel[1].trim();
    if (why.length < 20) return fail('NO_RATE_FLOOR_DECLARED needs a reason of at least 20 characters');
    return { ok: true, reason: '', rows: [], sentinel: why };
  }
  if (!lines.length) return fail('section carries neither a table nor the NO_RATE_FLOOR_DECLARED line');
  if (lines.length < 3) return fail('table needs a header, a separator and at least one row');
  const cols = cellsOf(lines[0]).map((c) => c.toLowerCase());
  const idx = {
    comparison: cols.findIndex((c) => c.includes('comparison')),
    arm: cols.findIndex((c) => /^arm\b/.test(c)),
    'minority-side share m': cols.findIndex((c) => c.includes('minority')),
    'declared floor': cols.findIndex((c) => c.includes('floor')),
    'bound 2m': cols.findIndex((c) => c.includes('bound')),
    verdict: cols.findIndex((c) => c.includes('verdict')),
  };
  for (const [name, i] of Object.entries(idx)) if (i === -1) return fail(`table lacks a "${name}" column`);
  if (new Set(Object.values(idx)).size !== Object.keys(idx).length) return fail('two required columns resolve to the same header cell');
  const rows: IdentRow[] = [];
  for (const line of lines.slice(2)) {
    const c = cellsOf(line);
    if (c.length < cols.length || c.some((x) => x.length === 0)) return fail(`row with an empty cell: ${line}`);
    const share = firstNumber(c[idx['minority-side share m']]);
    if (!share) return fail(`row states no minority share m: ${line}`);
    if (share.percent) return fail(`state m as a fraction in [0, 0.5], not a percentage: ${line}`);
    if (share.value < 0 || share.value > 0.5) return fail(`m must be the MINORITY share, a fraction in [0, 0.5]: ${line}`);
    if (!/`[^`]+`|\bprobe\b/i.test(c[idx['minority-side share m']])) {
      return fail(`the minority share names no probe — a backticked command or SQL, or the word probe: ${line}`);
    }
    const floor = firstNumber(c[idx['declared floor']]);
    if (!floor || floor.percent) return fail(`declared floor must be a number of pp: ${line}`);
    const bound = firstNumber(c[idx['bound 2m']]);
    if (!bound || bound.percent) return fail(`bound 2m must be a number of pp: ${line}`);
    const v = c[idx.verdict].replace(/[*`]/g, '').trim();
    let verdict: IdentRow['verdict'];
    let restatement: string | null = null;
    if (/^NOT_IDENTIFIABLE\b/.test(v)) {
      const r = /^NOT_IDENTIFIABLE\s*(?:→|->)\s*restated as\s+(\S.{4,})$/i.exec(v);
      if (!r) return fail(`a NOT_IDENTIFIABLE row must read "NOT_IDENTIFIABLE → restated as <the test>": ${line}`);
      verdict = 'NOT_IDENTIFIABLE';
      restatement = r[1].trim();
    } else if (/^IDENTIFIABLE\b/.test(v)) {
      verdict = 'IDENTIFIABLE';
    } else {
      return fail(`verdict must be IDENTIFIABLE or "NOT_IDENTIFIABLE → restated as …": ${line}`);
    }
    rows.push({
      comparison: c[idx.comparison], arm: c[idx.arm], m: share.value, floor: floor.value,
      bound: bound.value, boundDecimals: bound.decimals, verdict, restatement,
    });
  }
  return { ok: true, reason: '', rows, sentinel: null };
}

interface PyResult { id: string; verdict: string; reason: string; bound_pp: number | null }

/** The ONE bound, by subprocess — the same `--declarations` entry point the registry checker calls. */
function pyDeclarations(decls: Array<{ id: string; floor_pp: number; shares: number[] }>): PyResult[] {
  const r = spawnSync('python3', [PY_DERIVATION, '--declarations'], {
    input: JSON.stringify({ declarations: decls }), encoding: 'utf8', timeout: 30_000,
  });
  if (r.status !== 0) throw new Error(`python3 --declarations failed, status ${r.status}: ${r.stderr || r.stdout}`);
  const doc = JSON.parse(r.stdout);
  if (!Array.isArray(doc.results) || doc.results.length !== decls.length) {
    throw new Error(`--declarations returned ${doc.results?.length} result(s) for ${decls.length} declaration(s)`);
  }
  return doc.results;
}

/** TRUTH, not shape: the stated 2m and verdict of every row must equal the recomputed ones. */
export function identifiabilityArithmetic(label: string, rows: IdentRow[]): { failures: string[]; results: PyResult[] } {
  if (!rows.length) return { failures: [], results: [] };
  const results = pyDeclarations(rows.map((r, i) => ({ id: `${label}#${i + 1}`, floor_pp: r.floor, shares: [r.m] })));
  const failures: string[] = [];
  rows.forEach((row, i) => {
    const res = results[i];
    const where = `${label} row ${i + 1} (${row.arm})`;
    if ((res.verdict !== 'IDENTIFIABLE' && res.verdict !== 'NOT_IDENTIFIABLE') || res.bound_pp === null) {
      failures.push(`${where}: the bound could not be computed — ${res.reason}`);
      return;
    }
    const tolerance = 0.5 * 10 ** -row.boundDecimals + 1e-9;
    if (Math.abs(row.bound - res.bound_pp) > tolerance) {
      failures.push(`${where}: stated bound ${row.bound}pp is not 2m = ${res.bound_pp.toFixed(4)}pp recomputed from m = ${row.m}`);
    }
    if (row.verdict !== res.verdict) {
      failures.push(`${where}: verdict says ${row.verdict}, but floor ${row.floor}pp against 2m = ${res.bound_pp.toFixed(2)}pp is ${res.verdict}`);
    }
  });
  return { failures, results };
}

/**
 * PROCEDURE §4d — a study of a SERVED rule is a diagnosis (OPS-PREREG-SERVED-RULE-GATE-W1).
 *
 * Scoring only a served rule's output can say whether it works, never what to fix. A registration
 * that DECLARES a served-rule study therefore carries (1) `## Answer-key ceiling`: one table of
 * hindsight keys in the closed role set CEILING · NO_LAG · SERVED, each at least once, with the three
 * diagnosis tokens NO_ROOM · INPUTS · LAG named, so the result first says whether there was anything to
 * find; and (2) `## Component map`: slice → the dial it isolates (a backticked constant or literal) →
 * works / broken / too little data (with its numeric floor), so the result says which part works.
 *
 * DECLARED, NEVER SNIFFED. The trigger is ONE line that starts with `SERVED_RULE_STUDY:` and names one
 * repo path ending .ts/.py and one `<NAME>VERSION = <integer>` token; the separator is free. No line,
 * no §4d: landed registrations and other arcs' studies are untouched, and a mention mid-line is not a
 * declaration. Presence and shape, never truth — whether the keys and dials are the real ones is the
 * declaring wave's audit.
 */
const SERVED_DECL_RE = /^SERVED_RULE_STUDY:(.*)$/gm;
const SERVED_PATH_RE = /(?<![\w./-])[\w./-]*\w\.(?:ts|py)(?![\w./-])/g;
const SERVED_VERSION_RE = /(?<!\w)[A-Z][A-Z0-9_]*VERSION[ \t]*=[ \t]*([^\s·,;|]*)/g;
const ANSWER_KEY_SECTION_RE = /^(#{2,6})[ \t]+(?:§?\d+(?:\.\d+)*[a-z]?\.?[ \t]+)?answer[ -]key ceiling\b/im;
const COMPONENT_MAP_SECTION_RE = /^(#{2,6})[ \t]+(?:§?\d+(?:\.\d+)*[a-z]?\.?[ \t]+)?component map\b/im;
const SERVED_ROLES = ['CEILING', 'NO_LAG', 'SERVED'] as const;
const SERVED_DIAGNOSES = ['NO_ROOM', 'INPUTS', 'LAG'] as const;
const SERVED_FIXTURES = join(REPO_ROOT, 'tests/fixtures/served-rule');

/** Exact, reasoned exemptions — the rule's own text is not a registration. Never a glob. */
export const SERVED_RULE_EXEMPT: ReadonlyMap<string, string> = new Map([
  ['audits/PREREGISTRATION-PROCEDURE.md', 'the procedure DEFINES §4d and shows the SERVED_RULE_STUDY declaration as an example at line start; it is the rule, not a served-rule study'],
]);

/** The fixture corpus is CONSTRUCTED here, so its vacuity guard lives here: exactly these six files. */
const SERVED_FIXTURE_EXPECT: ReadonlyMap<string, { applies: boolean; ok: boolean; reason: RegExp | null }> = new Map([
  ['compliant.md', { applies: true, ok: true, reason: null }],
  ['missing-answer-key.md', { applies: true, ok: false, reason: /no "## Answer-key ceiling" section/ }],
  ['missing-component-map.md', { applies: true, ok: false, reason: /no "## Component map" section/ }],
  ['missing-role.md', { applies: true, ok: false, reason: /answer-key table has no NO_LAG row/ }],
  ['bad-declaration.md', { applies: true, ok: false, reason: /SERVED_RULE_STUDY declaration names no repo path/ }],
  ['undeclared.md', { applies: false, ok: true, reason: null }],
]);

export interface ServedRuleVerdict {
  applies: boolean;
  ok: boolean;
  reason: string;
}

/** A heading-delimited section and the FIRST contiguous table inside it, or null when the heading is absent. */
function servedSection(md: string, headingRe: RegExp): { text: string; table: string[] } | null {
  const m = headingRe.exec(md);
  if (!m) return null;
  const after = md.slice(m.index + m[0].length);
  const end = after.search(new RegExp(`^#{1,${m[1].length}}\\s`, 'm'));
  const text = end === -1 ? after : after.slice(0, end);
  const all = text.split('\n').map((l) => l.trim());
  const first = all.findIndex((l) => l.startsWith('|'));
  const table: string[] = [];
  if (first !== -1) for (let i = first; i < all.length && all[i].startsWith('|'); i++) table.push(all[i]);
  return { text, table };
}

/** Pure predicate over the markdown text. Exported so the self-test runs the REAL parser over the fixtures. */
export function servedRuleVerdict(md: string): ServedRuleVerdict {
  const decls = [...md.matchAll(SERVED_DECL_RE)];
  if (decls.length === 0) return { applies: false, ok: true, reason: '' };
  const fail = (reason: string): ServedRuleVerdict => ({ applies: true, ok: false, reason });

  // 1. The declaration: one line, one repo path ending .ts/.py, one <NAME>VERSION = <integer>.
  if (decls.length > 1) return fail(`declares SERVED_RULE_STUDY more than once (${decls.length} lines) — one line, one rule`);
  const line = decls[0][0].trim();
  const value = decls[0][1].replace(/`/g, ' ');
  const paths = value.match(SERVED_PATH_RE) ?? [];
  if (paths.length === 0) return fail(`SERVED_RULE_STUDY declaration names no repo path ending .ts or .py: ${line}`);
  if (paths.length > 1) return fail(`SERVED_RULE_STUDY declaration must name exactly one repo path, found ${paths.length}: ${line}`);
  if (paths[0].startsWith('/') || /(^|\/)\.\.(\/|$)/.test(paths[0])) {
    return fail(`SERVED_RULE_STUDY rule source path must be repo-relative: ${paths[0]}`);
  }
  const versions = [...value.matchAll(SERVED_VERSION_RE)];
  if (versions.length === 0) return fail(`SERVED_RULE_STUDY declaration names no <NAME>VERSION = <integer> token: ${line}`);
  if (versions.length > 1) return fail(`SERVED_RULE_STUDY declaration must name exactly one <NAME>VERSION token, found ${versions.length}: ${line}`);
  if (!/^\d+$/.test(versions[0][1])) return fail(`SERVED_RULE_STUDY version value "${versions[0][1]}" is not an integer: ${line}`);

  // 2. The answer-key ceiling: four columns, the closed role set each at least once, the three diagnoses named.
  const ak = servedSection(md, ANSWER_KEY_SECTION_RE);
  if (!ak) return fail('no "## Answer-key ceiling" section (PROCEDURE §4d)');
  if (ak.table.length < 3) return fail('answer-key table needs a header, a separator and at least one row');
  const akCols = cellsOf(ak.table[0]).map((c) => c.replace(/[*`]/g, '').toLowerCase());
  const akIdx = {
    key: akCols.findIndex((c) => /^key\b/.test(c)),
    role: akCols.findIndex((c) => /^role\b/.test(c)),
    construction: akCols.findIndex((c) => c.includes('construction')),
    'reading if it fails': akCols.findIndex((c) => c.includes('reading if it fails')),
  };
  for (const [name, i] of Object.entries(akIdx)) if (i === -1) return fail(`answer-key table lacks a "${name}" column`);
  if (new Set(Object.values(akIdx)).size !== Object.keys(akIdx).length) return fail('two answer-key columns resolve to the same header cell');
  const roles = new Set<string>();
  for (const row of ak.table.slice(2)) {
    const c = cellsOf(row);
    if (c.length < akCols.length || c.some((x) => x.length === 0)) return fail(`answer-key row with an empty cell: ${row}`);
    const role = c[akIdx.role].replace(/[*`]/g, '').trim();
    if (!(SERVED_ROLES as readonly string[]).includes(role)) return fail(`answer-key role must be one of CEILING · NO_LAG · SERVED: ${row}`);
    roles.add(role);
  }
  for (const role of SERVED_ROLES) if (!roles.has(role)) return fail(`answer-key table has no ${role} row`);
  for (const token of SERVED_DIAGNOSES) {
    if (!new RegExp(`(?<![A-Za-z0-9_])${token}(?![A-Za-z0-9_])`).test(ak.text)) {
      return fail(`the Answer-key ceiling section does not name the diagnosis token ${token}`);
    }
  }

  // 3. The component map: five columns, >= 1 row, a backticked dial, no empty cell, a numeric floor.
  const cm = servedSection(md, COMPONENT_MAP_SECTION_RE);
  if (!cm) return fail('no "## Component map" section (PROCEDURE §4d)');
  if (cm.table.length < 3) return fail('component-map table needs a header, a separator and at least one row');
  const cmCols = cellsOf(cm.table[0]).map((c) => c.replace(/[*`]/g, '').toLowerCase());
  const cmIdx = {
    slice: cmCols.findIndex((c) => /^slice\b/.test(c)),
    dial: cmCols.findIndex((c) => /^dial\b/.test(c)),
    works: cmCols.findIndex((c) => /^works\b/.test(c)),
    broken: cmCols.findIndex((c) => /^broken\b/.test(c)),
    'too little data': cmCols.findIndex((c) => c.includes('too little data')),
  };
  for (const [name, i] of Object.entries(cmIdx)) if (i === -1) return fail(`component-map table lacks a "${name}" column`);
  if (new Set(Object.values(cmIdx)).size !== Object.keys(cmIdx).length) return fail('two component-map columns resolve to the same header cell');
  for (const row of cm.table.slice(2)) {
    const c = cellsOf(row);
    if (c.length < cmCols.length || c.some((x) => x.length === 0)) return fail(`component-map row with an empty cell: ${row}`);
    if (!/`[^`]+`/.test(c[cmIdx.dial])) return fail(`component-map dial names no backticked constant or literal: ${row}`);
    if (!/\d/.test(c[cmIdx['too little data']])) return fail(`component-map "too little data" cell states no numeric floor: ${row}`);
  }
  return { applies: true, ok: true, reason: '' };
}

/**
 * PROCEDURE §4e — every registered fit is on Binance (OPS-PREREG-FIT-VENUE-GATE-W1).
 *
 * Mr.1's rule, 2026-11-18 (vault Cowork-Playbook.md → `## Backtest & forward test`): every backtest
 * and forward test fits its settings on Binance data; every venue then runs the same settings, and
 * the other venues are the check, never the fit. A playbook rule binds only the sessions that read
 * it; this gate makes a non-Binance fit unlandable.
 *
 * MANDATORY on every registration that is not grandfathered. Exactly one line, at the start of a
 * line, in one of two forms:
 *   FIT_VENUE: BINANCE · from <YYYY-MM-DD> · check: <ALL_SERVED_VENUES | comma-separated venues>
 *   FIT_VENUE: NONE — <reason of at least 20 characters>   (a measurement-only study)
 * Presence and shape, never truth: whether the fit really ran on Binance, and whether every input
 * is in venue-neutral units, is the readout's to show (PROCEDURE §4e, "What the gate cannot check").
 */
const FIT_VENUE_DECL_RE = /^FIT_VENUE:(.*)$/gm;
const FIT_VENUE_REQUIRED = 'BINANCE';
const FIT_VENUE_RULE = 'Cowork-Playbook "## Backtest & forward test" (Mr.1, 2026-11-18): every test fits on Binance; other venues are the check, never the fit';
const FIT_FIXTURES = join(REPO_ROOT, 'tests/fixtures/fit-venue');

/**
 * Registrations on origin/main at this wave's base (82beec39), before §4e existed. Exact paths, one
 * reason each; never a glob. A future registration is NEVER added here: it carries the line.
 */
const FIT_BEFORE = 'before §4e existed (2026-11-18); a landed registration is never edited, and its fit design stays as registered';
export const FIT_GRANDFATHERED: ReadonlyMap<string, string> = new Map([
  ['audits/ads1-scorecard-preregistration-2026-09-27.md', `landed 2026-09-27 by EDGE-ADS1-SCORECARD-W1-V2, ${FIT_BEFORE}`],
  ['audits/aoe-ads1-objective-preregistration-2026-10-15.md', `landed 2026-10-15 by AOE-ADS1-OBJECTIVE-W1, ${FIT_BEFORE}; AOE's successors fit on Binance only`],
  ['audits/attribution-gate-preregistration-2026-09-04.md', `landed 2026-09-04 by EDGE-ATTRIBUTION-CORPUS-DRAIN-W1, ${FIT_BEFORE}`],
  ['audits/hold-decision-preregistration-2026-08-26.md', `landed 2026-08-26 by OPS-HOLD-DECISION-CAPTURE-W1, ${FIT_BEFORE}`],
  ['audits/hurst-discrimination-preregistration-2026-09-22.md', `landed 2026-09-22 by EDGE-HURST-DISCRIMINATION-PROBE-W1, ${FIT_BEFORE}`],
  ['audits/labeler-race-window-v2-preregistration-2026-09-28.md', `landed 2026-09-28 by EDGE-LABELER-RACE-WINDOW-V2-W1, ${FIT_BEFORE}`],
  ['audits/regime-challenge-r1-preregistration-2026-11-17.md', `landed 2026-11-17 by EDGE-REGIME-CHALLENGE-R1-W1, ${FIT_BEFORE}; an in-flight read keeps its registered design`],
  ['audits/regime-confirmation-preregistration-2026-11-17.md', `landed 2026-11-17 by EDGE-REGIME-CONFIRM-W1, ${FIT_BEFORE}; an in-flight read keeps its registered design`],
  ['audits/regime-diagnostic-preregistration-2026-11-16.md', `landed 2026-11-16 by EDGE-REGIME-DIAG-W1, ${FIT_BEFORE}`],
  ['audits/scorer-predictive-ceiling-preregistration-2026-09-21.md', `landed 2026-09-22 by EDGE-SCORER-PREDICTIVE-CEILING-W1, ${FIT_BEFORE}`],
  ['audits/sell-attribution-centered-check-preregistration-2026-09-05.md', `landed 2026-09-06 by EDGE-SELL-ATTRIBUTION-CENTERED-CHECK-W1, ${FIT_BEFORE}`],
  ['audits/sell-attribution-collider-control-preregistration-2026-09-05.md', `landed 2026-09-05 by EDGE-SELL-ATTRIBUTION-COLLIDER-CONTROL-W1, ${FIT_BEFORE}`],
  ['audits/sell-attribution-long-timeframe-check-preregistration-2026-09-09.md', `landed 2026-09-09 by EDGE-SELL-ATTRIBUTION-CENTERED-CHECK-W2, ${FIT_BEFORE}`],
  ['audits/sell-feature-attribution-preregistration-2026-09-04.md', `landed 2026-09-04 by EDGE-SELL-FEATURE-ATTRIBUTION-W1, ${FIT_BEFORE}`],
  ['audits/sr-htf-levels-preregistration-2026-11-13.md', `landed 2026-11-13 by EDGE-SR-HTF-LEVELS-W1, ${FIT_BEFORE}`],
  ['audits/sr-level-backtest-preregistration-2026-11-12.md', `landed 2026-11-12 by EDGE-SR-LEVEL-BACKTEST-W1, ${FIT_BEFORE}`],
  ['audits/sr-level-probe-preregistration-2026-11-10.md', `landed 2026-11-11 by EDGE-SR-LEVEL-PROBE-W1, ${FIT_BEFORE}`],
  ['audits/verdict-rule-registry-preregistration-2026-10-02.md', `landed 2026-10-02 by SIGNAL-VERDICT-RULE-REGISTRY-W1, ${FIT_BEFORE}`],
  ['audits/withheld-dwr-preregistration-2026-08-30.md', `landed 2026-08-30 by EDGE-WITHHELD-COUNTERFACTUAL-DWR-W1, ${FIT_BEFORE}`],
  ['audits/withheld-dwr-w2-preregistration-2026-09-10.md', `landed 2026-09-10 by EDGE-WITHHELD-COUNTERFACTUAL-DWR-W2, ${FIT_BEFORE}`],
]);

/** Exact, reasoned exemptions — the rule's own text is not a registration. Never a glob. */
export const FIT_EXEMPT: ReadonlyMap<string, string> = new Map([
  ['audits/PREREGISTRATION-PROCEDURE.md', 'the procedure DEFINES §4e and shows both FIT_VENUE forms as examples at line start; it is the rule, not a registration'],
]);

/** The fixture corpus is CONSTRUCTED here, so its vacuity guard lives here: exactly these six files. */
const FIT_FIXTURE_EXPECT: ReadonlyMap<string, { ok: boolean; reason: RegExp | null }> = new Map([
  ['compliant-binance.md', { ok: true, reason: null }],
  ['compliant-none.md', { ok: true, reason: null }],
  ['missing.md', { ok: false, reason: /no line starting "FIT_VENUE:"/ }],
  ['other-venue.md', { ok: false, reason: /fits on OKX, not BINANCE .*Backtest & forward test/ }],
  ['bad-date.md', { ok: false, reason: /"from 2023-02-30" is not a real calendar date/ }],
  ['duplicate.md', { ok: false, reason: /declares FIT_VENUE more than once \(2 lines\)/ }],
]);

export interface FitVenueVerdict {
  ok: boolean;
  reason: string;
}

/** Pure predicate over the markdown text. Exported so the self-test runs the REAL parser over the fixtures. */
export function fitVenueVerdict(md: string): FitVenueVerdict {
  const fail = (reason: string): FitVenueVerdict => ({ ok: false, reason });
  const decls = [...md.matchAll(FIT_VENUE_DECL_RE)];
  if (decls.length === 0) return fail('no line starting "FIT_VENUE:" — declare the fit venue (PROCEDURE §4e)');
  if (decls.length > 1) return fail(`declares FIT_VENUE more than once (${decls.length} lines) — one line, one fit`);
  const line = decls[0][0].trim();
  const value = decls[0][1].replace(/`/g, ' ').trim();

  const venue = /^[A-Za-z][A-Za-z0-9_-]*/.exec(value)?.[0];
  if (!venue) return fail(`FIT_VENUE names no venue: ${line}`);

  // Second form: a measurement-only study that chooses no setting says so, and why.
  if (venue === 'NONE') {
    const why = value.slice(venue.length).replace(/^\s*[-–—:]?\s*/, '').trim();
    if (why.length < 20) return fail(`FIT_VENUE: NONE needs a reason of at least 20 characters: ${line}`);
    return { ok: true, reason: '' };
  }

  // First form: the fit venue is BINANCE, from a real calendar date, checked on a named venue set.
  if (venue !== FIT_VENUE_REQUIRED) return fail(`FIT_VENUE fits on ${venue}, not ${FIT_VENUE_REQUIRED} — ${FIT_VENUE_RULE}: ${line}`);
  const rest = value.slice(venue.length);
  const check = /(?:^|[\s·,;|])check:(.*)$/.exec(rest);
  const head = check ? rest.slice(0, check.index) : rest;
  const from = /(?:^|[\s·,;|])from\s+([^\s·,;|]+)/.exec(head)?.[1];
  if (!from) return fail(`FIT_VENUE names no "from <YYYY-MM-DD>" start of the Binance data: ${line}`);
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(from);
  const real = ymd !== null && (() => {
    const [y, m, d] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])];
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  })();
  if (!real) return fail(`"from ${from}" is not a real calendar date (YYYY-MM-DD): ${line}`);
  if (!check || check[1].replace(/[\s,;·|]/g, '').length === 0) {
    return fail(`"check:" clause is empty — name ALL_SERVED_VENUES or a comma-separated venue list: ${line}`);
  }
  return { ok: true, reason: '' };
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

describe('PROCEDURE §4c — identifiability at declaration (OPS-PREREG-IDENTIFIABILITY-GATE-W1)', () => {
  const fixture = (name: string): string => readFileSync(join(IDENT_FIXTURES, name), 'utf8');
  const HEADING = '## 6. Identifiability (PROCEDURE §4c)';

  it('§4c allowlists are non-empty, exact-matched, reasoned, disjoint, and every row names an existing file', () => {
    expect(IDENT_GRANDFATHERED.size).toBeGreaterThan(0);
    for (const map of [IDENT_GRANDFATHERED, IDENT_EXEMPT]) {
      for (const [path, reason] of map) {
        expect(path, 'rows are exact repo-relative paths, never globs').not.toMatch(/[*?[\]]/);
        expect(path.startsWith('audits/'), `row outside audits/: ${path}`).toBe(true);
        expect(reason.trim().length, `row has no reason: ${path}`).toBeGreaterThanOrEqual(40);
        expect(existsSync(join(REPO_ROOT, path)), `stale row, the file is gone: ${path}`).toBe(true);
      }
    }
    for (const path of IDENT_EXEMPT.keys()) {
      expect(IDENT_GRANDFATHERED.has(path), `${path} is both exempt and grandfathered`).toBe(false);
    }
  });

  it('every pre-registration carries ## Identifiability whose 2m and verdicts recompute, or NO_RATE_FLOOR_DECLARED, or is grandfathered', { timeout: 60_000 }, () => {
    const files = discoverPreregistrations().filter((f) => !IDENT_EXEMPT.has(f));
    // Vacuity guard: the corpus is the repo, and it is known to hold pre-registrations.
    expect(files.length, 'discovery found no audits/*preregistration*.md — the scan is broken').toBeGreaterThan(0);
    const failures: string[] = [];
    for (const rel of files) {
      const shape = identifiabilityShape(readFileSync(join(REPO_ROOT, rel), 'utf8'));
      const grandfathered = IDENT_GRANDFATHERED.has(rel);
      if (grandfathered && shape.ok) {
        failures.push(`${rel}: carries §4c now — REMOVE its IDENT_GRANDFATHERED row (stale exemption)`);
      } else if (!grandfathered && !shape.ok) {
        failures.push(`${rel}: ${shape.reason} — see audits/PREREGISTRATION-PROCEDURE.md §4c`);
      } else if (!grandfathered) {
        failures.push(...identifiabilityArithmetic(rel, shape.rows).failures);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('self-test, §4c shape: a compliant table and the NO_RATE_FLOOR line pass, and each defective shape fails with its named reason', () => {
    const good = fixture('valid.identifiability.md');
    expect(identifiabilityShape(good)).toMatchObject({ ok: true, reason: '', sentinel: null });
    expect(identifiabilityShape(good).rows).toHaveLength(1);

    const none = good
      .replace(/^\|.*$\n?/gm, '')
      .replace(HEADING, `${HEADING}\n\nNO_RATE_FLOOR_DECLARED - every floor here is a cluster floor; no rate or edge floor is declared`);
    expect(identifiabilityShape(none)).toMatchObject({ ok: true, rows: [] });
    expect(identifiabilityShape(none).sentinel).toMatch(/cluster floor/);
    expect(identifiabilityShape(none.replace('NO_RATE_FLOOR_DECLARED -', 'NO_RATE_FLOOR_DECLARED —')).ok).toBe(true);

    const defective: Array<[string, string, RegExp]> = [
      ['no section', good.replace(HEADING, '## 6. Something else'), /no "## Identifiability" section/],
      ['table AND sentinel', good.replace(HEADING, `${HEADING}\n\nNO_RATE_FLOOR_DECLARED - a reason long enough to clear the floor`), /both a table and NO_RATE_FLOOR_DECLARED/],
      ['neither', good.replace(/^\|.*$\n?/gm, ''), /neither a table nor/],
      ['short sentinel reason', none.replace(/NO_RATE_FLOOR_DECLARED - .*$/m, 'NO_RATE_FLOOR_DECLARED - n/a'), /at least 20 characters/],
      ['missing verdict column', good.replace('| verdict |', '| outcome |'), /lacks a "verdict" column/],
      ['m as a percentage', good.replace('| 0.2, `count', '| 20%, `count'), /not a percentage/],
      ['m above one half', good.replace('| 0.2, `count', '| 0.8, `count'), /MINORITY share/],
      ['no probe', good.replace(/\| 0\.2, `count[^|]*\|/, '| 0.2 |'), /names no probe/],
      ['NOT_IDENTIFIABLE without its restatement', good.replace('| IDENTIFIABLE |', '| NOT_IDENTIFIABLE |'), /restated as/],
      ['unknown verdict', good.replace('| IDENTIFIABLE |', '| MAYBE |'), /verdict must be/],
      ['empty cell', good.replace('| 40.0 |', '|  |'), /empty cell/],
    ];
    for (const [label, md, reason] of defective) {
      const v = identifiabilityShape(md);
      expect(v.ok, `${label} must fail`).toBe(false);
      expect(v.reason, label).toMatch(reason);
    }

    // The heading is anchored on the word: numbered forms match, a sentence that merely says
    // "identifiable" does not — one landed registration carries "### 5.2 What is identifiable".
    expect(IDENT_SECTION_RE.test('## Identifiability')).toBe(true);
    expect(IDENT_SECTION_RE.test('## 4c. Identifiability — at declaration')).toBe(true);
    expect(IDENT_SECTION_RE.test('### 9 Identifiability')).toBe(true);
    expect(IDENT_SECTION_RE.test('### 5.2 What is identifiable')).toBe(false);
  });

  it('self-test, §4c arithmetic: trigger A reads NOT_IDENTIFIABLE, the valid fixture passes, a naive verdict or a wrong bound is refused', { timeout: 60_000 }, () => {
    const trig = identifiabilityShape(fixture('trigger-a.identifiability.md'));
    expect(trig.ok, trig.reason).toBe(true);
    expect(trig.rows).toHaveLength(2);
    const t = identifiabilityArithmetic('trigger-a', trig.rows);
    expect(t.failures, t.failures.join('\n')).toEqual([]);
    expect(t.results[0]).toMatchObject({ verdict: 'NOT_IDENTIFIABLE', bound_pp: 1.06 });
    expect(t.results[1].verdict).toBe('IDENTIFIABLE');

    // The floor as it was actually declared on 2026-08-31, naively IDENTIFIABLE, is REFUSED.
    const naive = identifiabilityShape(
      fixture('trigger-a.identifiability.md').replace(/NOT_IDENTIFIABLE → restated as [^|]*\|/, 'IDENTIFIABLE |'),
    );
    expect(naive.ok, naive.reason).toBe(true);
    expect(identifiabilityArithmetic('trigger-a-naive', naive.rows).failures.join('\n'))
      .toMatch(/verdict says IDENTIFIABLE, but floor 3pp against 2m = 1\.06pp is NOT_IDENTIFIABLE/);

    const valid = identifiabilityShape(fixture('valid.identifiability.md'));
    expect(valid.ok, valid.reason).toBe(true);
    const v = identifiabilityArithmetic('valid', valid.rows);
    expect(v.failures).toEqual([]);
    expect(v.results[0]).toMatchObject({ verdict: 'IDENTIFIABLE', bound_pp: 40 });

    // A stated bound must recompute — to within its OWN stated precision, and no further.
    const wrong = identifiabilityShape(fixture('valid.identifiability.md').replace('| 40.0 |', '| 4.0 |'));
    expect(identifiabilityArithmetic('valid-wrong-bound', wrong.rows).failures.join('\n'))
      .toMatch(/stated bound 4pp is not 2m = 40\.0000pp/);
    const rounded = identifiabilityShape(fixture('trigger-a.identifiability.md').replace('| 1.06 |', '| 1.1 |'));
    expect(identifiabilityArithmetic('trigger-a-rounded', rounded.rows).failures).toEqual([]);
    const offByOneCent = identifiabilityShape(fixture('trigger-a.identifiability.md').replace('| 1.06 |', '| 1.07 |'));
    expect(identifiabilityArithmetic('trigger-a-off', offByOneCent.rows).failures.join('\n')).toMatch(/stated bound 1\.07pp/);
  });

  it('registry surface, in CI: the checker self-test refuses the trigger-A site, and its live run reports the identifiability leg', { timeout: 120_000 }, () => {
    const self = spawnSync('node', ['scripts/check-population-comparison.mjs', '--self-test'], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 90_000,
    });
    expect(self.stdout).toMatch(/^POPULATION_COMPARISON_GATE_VERDICT=PASS$/m);
    expect(self.stdout).toMatch(/ok {3}trigger-A fixture .* is REFUSED at declaration: NOT_IDENTIFIABLE, 2m = 1\.06pp/);
    expect(self.stdout).toMatch(/ok {3}valid fixture passes/);
    expect(self.status).toBe(0);
    const live = spawnSync('node', ['scripts/check-population-comparison.mjs'], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 90_000,
    });
    expect(live.stdout).toMatch(/^\[population-comparison\] identifiability: \d+ site\x28s\x29 declare a floor/m);
    expect(live.stdout).toMatch(/^POPULATION_COMPARISON_GATE_VERDICT=PASS$/m);
    expect(live.status).toBe(0);
  });
});

describe('PROCEDURE §4d — a served-rule study is a diagnosis (OPS-PREREG-SERVED-RULE-GATE-W1)', () => {
  const fixture = (name: string): string => readFileSync(join(SERVED_FIXTURES, name), 'utf8');

  it('§4d exemptions are exact, reasoned, and name existing files', () => {
    expect(SERVED_RULE_EXEMPT.size).toBeGreaterThan(0);
    for (const [path, reason] of SERVED_RULE_EXEMPT) {
      expect(path, 'rows are exact repo-relative paths, never globs').not.toMatch(/[*?[\]]/);
      expect(path.startsWith('audits/'), `row outside audits/: ${path}`).toBe(true);
      expect(reason.trim().length, `row has no reason: ${path}`).toBeGreaterThanOrEqual(40);
      expect(existsSync(join(REPO_ROOT, path)), `stale §4d exemption: ${path}`).toBe(true);
    }
  });

  it('every pre-registration that declares SERVED_RULE_STUDY carries a compliant answer-key ceiling and component map', () => {
    const files = discoverPreregistrations().filter((f) => !SERVED_RULE_EXEMPT.has(f));
    // Vacuity guard: the corpus is the repo, and it is known to hold pre-registrations.
    expect(files.length, 'discovery found no audits/*preregistration*.md — the scan is broken').toBeGreaterThan(0);
    const verdicts = files.map((rel) => ({ rel, v: servedRuleVerdict(readFileSync(join(REPO_ROOT, rel), 'utf8')) }));
    const declaring = verdicts.filter(({ v }) => v.applies);
    const failures = declaring
      .filter(({ v }) => !v.ok)
      .map(({ rel, v }) => `${rel}: ${v.reason} — see audits/PREREGISTRATION-PROCEDURE.md §4d`);
    // The corpus size beside the zero: "0 declaring" is a fact about the scan only next to what it scanned.
    // eslint-disable-next-line no-console
    console.log(`SERVED_RULE_SCAN: ${verdicts.length} registration(s) scanned, ${declaring.length} declare SERVED_RULE_STUDY, ${failures.length} fail §4d`);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('self-test, §4d fixtures: exactly six, the compliant one passes, each defect fails with its named reason, the undeclared one does not apply', () => {
    // Vacuity guard where the corpus is CONSTRUCTED: the fixture set is exactly the declared six.
    const names = readdirSync(SERVED_FIXTURES).filter((n) => !n.startsWith('.')).sort();
    expect(names).toEqual([...SERVED_FIXTURE_EXPECT.keys()].sort());
    for (const [name, want] of SERVED_FIXTURE_EXPECT) {
      const v = servedRuleVerdict(fixture(name));
      expect(v.applies, `${name}: applies`).toBe(want.applies);
      expect(v.ok, `${name}: ${v.reason}`).toBe(want.ok);
      if (want.reason) expect(v.reason, name).toMatch(want.reason);
      else expect(v.reason, name).toBe('');
    }
  });

  it('self-test, §4d shapes: every other defect in the compliant fixture fails with its named reason', () => {
    const good = fixture('compliant.md');
    expect(servedRuleVerdict(good)).toEqual({ applies: true, ok: true, reason: '' });
    const DECL = 'SERVED_RULE_STUDY: src/lib/market-regime-core.ts · MARKET_REGIME_RULE_VERSION = 2';
    expect(good).toContain(DECL);

    // The separator is free and the tokens may be backticked; a numbered or deeper heading still counts.
    for (const ok of [
      good.replace(DECL, 'SERVED_RULE_STUDY: `src/lib/market-regime-core.ts`, `MARKET_REGIME_RULE_VERSION = 2`'),
      good.replace(DECL, 'SERVED_RULE_STUDY: ops/monitoring/regime_rule.py ; RULE_VERSION=3'),
      good.replace('## 5. Answer-key ceiling (PROCEDURE §4d)', '### Answer key ceiling'),
    ]) expect(servedRuleVerdict(ok)).toEqual({ applies: true, ok: true, reason: '' });

    const defective: Array<[string, string, RegExp]> = [
      ['declared twice', good.replace(DECL, `${DECL}\n${DECL}`), /more than once/],
      ['no version token', good.replace(DECL, 'SERVED_RULE_STUDY: src/lib/market-regime-core.ts'), /VERSION = <integer>/],
      ['non-integer version', good.replace(DECL, DECL.replace('= 2', '= 2.5')), /not an integer/],
      ['two version tokens', good.replace(DECL, `${DECL} · OTHER_VERSION = 1`), /exactly one .*VERSION/],
      ['absolute path', good.replace(DECL, DECL.replace('src/lib', '/Users/someone/src/lib')), /repo-relative/],
      ['two paths', good.replace(DECL, DECL.replace(' ·', ' src/lib/other.ts ·')), /exactly one repo path/],
      ['unknown role', good.replace('| S | SERVED |', '| S | LIVE |'), /role must be one of CEILING · NO_LAG · SERVED/],
      ['no CEILING row', good.replace(/^\| A \| CEILING \|.*\n/m, ''), /no CEILING row/],
      ['no SERVED row', good.replace(/^\| S \| SERVED \|.*\n/m, ''), /no SERVED row/],
      ['no LAG token', good.replace(/\bLAG:/, 'late:').replace('`LAG` (NO_LAG wins', 'late (NO_LAG wins'), /diagnosis token LAG/],
      ['no NO_ROOM token', good.replace(/NO_ROOM/g, 'no room'), /diagnosis token NO_ROOM/],
      ['answer-key column missing', good.replace('| reading if it fails |', '| reading |'), /lacks a "reading if it fails" column/],
      ['answer-key empty cell', good.replace('| A | CEILING |', '|  | CEILING |'), /answer-key row with an empty cell/],
      ['answer-key header only', good.replace(/^\| [ABS] \|.*\n/gm, ''), /answer-key table needs/],
      ['map column missing', good.replace('| too little data |', '| sparse |'), /lacks a "too little data" column/],
      ['dial not backticked', good.replace('`EXAMPLE_TREND_DIAL`', 'EXAMPLE_TREND_DIAL'), /names no backticked constant or literal/],
      ['empty criterion cell', good.replace('| beats every registered baseline on the slice | loses', '|  | loses'), /component-map row with an empty cell/],
      ['floor without a number', good.replace(/fewer than 20 independent days on the slice \|$/m, 'too few days |'), /states no numeric floor/],
      ['map header only', good.replace(/^\| calls labelled .*\n/gm, ''), /component-map table needs/],
    ];
    for (const [label, md, reason] of defective) {
      const v = servedRuleVerdict(md);
      expect(v.applies, `${label} must apply`).toBe(true);
      expect(v.ok, `${label} must fail`).toBe(false);
      expect(v.reason, label).toMatch(reason);
    }

    // Declared, never sniffed: the token mid-line, or indented, is a mention and not a declaration.
    expect(servedRuleVerdict(good.replace(DECL, `This is a ${DECL}`)).applies).toBe(false);
    expect(servedRuleVerdict(good.replace(DECL, `    ${DECL}`)).applies).toBe(false);
  });
});

describe('PROCEDURE §4e — every registered fit is on Binance (OPS-PREREG-FIT-VENUE-GATE-W1)', () => {
  const fixture = (name: string): string => readFileSync(join(FIT_FIXTURES, name), 'utf8');

  it('§4e allowlists are non-empty, exact-matched, reasoned, disjoint, and every row names an existing file', () => {
    expect(FIT_GRANDFATHERED.size).toBeGreaterThan(0);
    expect(FIT_EXEMPT.size).toBeGreaterThan(0);
    for (const map of [FIT_GRANDFATHERED, FIT_EXEMPT]) {
      for (const [path, reason] of map) {
        expect(path, 'rows are exact repo-relative paths, never globs').not.toMatch(/[*?[\]]/);
        expect(path.startsWith('audits/'), `row outside audits/: ${path}`).toBe(true);
        expect(reason.trim().length, `row has no reason: ${path}`).toBeGreaterThanOrEqual(40);
        expect(existsSync(join(REPO_ROOT, path)), `stale row, the file is gone: ${path}`).toBe(true);
      }
    }
    for (const path of FIT_EXEMPT.keys()) {
      expect(FIT_GRANDFATHERED.has(path), `${path} is both exempt and grandfathered`).toBe(false);
    }
  });

  it('every pre-registration declares FIT_VENUE: BINANCE (or NONE with a reason), or is grandfathered by an exact row', () => {
    const files = discoverPreregistrations();
    // Vacuity guard: the corpus is the repo, and it is known to hold pre-registrations.
    expect(files.length, 'discovery found no audits/*preregistration*.md — the scan is broken').toBeGreaterThan(0);
    const scanned = files.filter((f) => !FIT_EXEMPT.has(f));
    const failures: string[] = [];
    let declared = 0;
    for (const rel of scanned) {
      const v = fitVenueVerdict(readFileSync(join(REPO_ROOT, rel), 'utf8'));
      const grandfathered = FIT_GRANDFATHERED.has(rel);
      if (grandfathered && v.ok) {
        failures.push(`${rel}: carries a valid FIT_VENUE line now — REMOVE its FIT_GRANDFATHERED row (stale exemption)`);
      } else if (!grandfathered && !v.ok) {
        failures.push(`${rel}: ${v.reason} — see audits/PREREGISTRATION-PROCEDURE.md §4e`);
      } else if (!grandfathered) {
        declared += 1;
      }
    }
    // The corpus size beside the zero: "0 fail" is a fact about the scan only next to what it scanned.
    // eslint-disable-next-line no-console
    console.log(`FIT_VENUE_SCAN: ${files.length} file(s) found, ${files.length - scanned.length} exempt, ${scanned.length} scanned, ${FIT_GRANDFATHERED.size} grandfathered, ${declared} declare FIT_VENUE, ${failures.length} fail §4e`);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('self-test, §4e fixtures: exactly six, both compliant forms pass, each defect fails with its named reason', () => {
    // Vacuity guard where the corpus is CONSTRUCTED: the fixture set is exactly the declared six.
    const names = readdirSync(FIT_FIXTURES).filter((n) => !n.startsWith('.')).sort();
    expect(names).toEqual([...FIT_FIXTURE_EXPECT.keys()].sort());
    for (const [name, want] of FIT_FIXTURE_EXPECT) {
      const v = fitVenueVerdict(fixture(name));
      expect(v.ok, `${name}: ${v.reason}`).toBe(want.ok);
      if (want.reason) expect(v.reason, name).toMatch(want.reason);
      else expect(v.reason, name).toBe('');
    }
  });

  it('self-test, §4e shapes: every other defect in the compliant fixtures fails with its named reason', () => {
    const good = fixture('compliant-binance.md');
    const DECL = 'FIT_VENUE: BINANCE · from 2020-01-01 · check: ALL_SERVED_VENUES';
    expect(good).toContain(DECL);
    const none = fixture('compliant-none.md');
    const NONE_DECL = 'FIT_VENUE: NONE — a cardinality and coverage read that chooses no parameter, threshold, rule or cell';
    expect(none).toContain(NONE_DECL);

    // The separator is free, tokens may be backticked, and the check list may name venues.
    for (const ok of [
      good.replace(DECL, 'FIT_VENUE: `BINANCE` · from `2017-08-15` · check: `ALL_SERVED_VENUES`'),
      good.replace(DECL, 'FIT_VENUE: BINANCE, from 2024-02-29, check: BYBIT, OKX, BITGET'),
      none.replace(NONE_DECL, 'FIT_VENUE: NONE - reads coverage only; no setting is chosen'),
    ]) expect(fitVenueVerdict(ok)).toEqual({ ok: true, reason: '' });

    const defective: Array<[string, string, RegExp]> = [
      ['venue in lower case', good.replace(DECL, DECL.replace('BINANCE', 'binance')), /fits on binance, not BINANCE/],
      ['no venue at all', good.replace(DECL, 'FIT_VENUE: · from 2020-01-01 · check: ALL_SERVED_VENUES'), /names no venue/],
      ['from missing', good.replace(DECL, 'FIT_VENUE: BINANCE · check: ALL_SERVED_VENUES'), /names no "from <YYYY-MM-DD>"/],
      ['from not a date', good.replace(DECL, DECL.replace('2020-01-01', '2020-1-1')), /"from 2020-1-1" is not a real calendar date/],
      ['from month 13', good.replace(DECL, DECL.replace('2020-01-01', '2020-13-01')), /not a real calendar date/],
      ['from 29 Feb, not a leap year', good.replace(DECL, DECL.replace('2020-01-01', '2023-02-29')), /not a real calendar date/],
      ['check clause missing', good.replace(DECL, 'FIT_VENUE: BINANCE · from 2020-01-01'), /"check:" clause is empty/],
      ['check clause empty', good.replace(DECL, 'FIT_VENUE: BINANCE · from 2020-01-01 · check:'), /"check:" clause is empty/],
      ['check clause only punctuation', good.replace(DECL, 'FIT_VENUE: BINANCE · from 2020-01-01 · check: ` , `'), /"check:" clause is empty/],
      ['NONE without a reason', none.replace(NONE_DECL, 'FIT_VENUE: NONE'), /NONE needs a reason of at least 20 characters/],
      ['NONE with a short reason', none.replace(NONE_DECL, 'FIT_VENUE: NONE — measurement only'), /NONE needs a reason of at least 20 characters/],
      ['BINANCE and NONE twice', good.replace(DECL, `${DECL}\n${NONE_DECL}`), /more than once \(2 lines\)/],
    ];
    for (const [label, md, reason] of defective) {
      const v = fitVenueVerdict(md);
      expect(v.ok, `${label} must fail`).toBe(false);
      expect(v.reason, label).toMatch(reason);
    }

    // Declared, never sniffed: the line mid-sentence, indented or quoted is a mention, not a declaration.
    for (const mention of [`This is a ${DECL}`, `    ${DECL}`, `> ${DECL}`, `\`${DECL}\``]) {
      expect(fitVenueVerdict(good.replace(DECL, mention)).reason, mention).toMatch(/no line starting "FIT_VENUE:"/);
    }
  });
});

#!/usr/bin/env node
/**
 * BINANCE-AGENT-OS-GEO-AND-SUBMISSIONS-W2 CH1 R4 — retire the class
 * "a developer note written as an HTML comment ships to the public".
 *
 * A `//` comment in a generator never renders. An `<!-- -->` comment sitting inside that
 * generator's TEMPLATE LITERAL is public copy: it reaches View Source on every page the
 * generator emits. Measured 2026-08-26, before this wave: `scripts/render-integrations.mjs`
 * shipped EIGHT flavoured comments onto each of 25 rendered pages — internal wave IDs, internal
 * function names, and a directive quoted by name. Nobody wrote them intending to publish them;
 * the template literal is simply an easy place to forget which layer you are on.
 *
 * ALLOW-LIST, never deny-list. A deny-list of internal tokens (`Mr.1`, `-W[0-9]`, `DESIGN-`) is
 * one new wave-ID format away from silence, and the point of a gate is that it keeps working
 * after the person who wrote it stops thinking about it.
 *
 *   node scripts/check-rendered-comment-hygiene.mjs             # report
 *   node scripts/check-rendered-comment-hygiene.mjs --check     # gate
 *   node scripts/check-rendered-comment-hygiene.mjs --self-test
 *
 * ── TWO SEVERITIES, and that is deliberate ────────────────────────────────────────────────
 * BLOCK on `landing/integrations/*.html` — the 25 pages this wave owns and cleaned.
 * REPORT on everything else under `landing/` — 42 pre-existing leaks across 16 files emitted by
 * six other generators, which CH1's Must-NOT-write forbids touching. Blocking those on day one
 * would refuse every push for somebody else's backlog, which is how a gate gets disabled rather
 * than obeyed. The report lane carries a promotion criterion with BOTH a count AND a deadline
 * (`ops/comment-hygiene-config.json`), because a criterion that is only numeric can never fire
 * if the population never heals.
 *
 * ── VERDICT TOKEN ─────────────────────────────────────────────────────────────────────────
 * One terminal line: `COMMENT_HYGIENE_VERDICT=CLEAN|LEAK|INDETERMINATE`. Callers gate on the
 * TOKEN, never the exit code. Codes: 0=CLEAN / 1=LEAK / 3=INDETERMINATE — 3 is the token-law
 * default for a NEW gate, so this does not inherit `check_test_baseline.sh`'s 2.
 *
 * Zero HTML files scanned, or zero comments extracted, is INDETERMINATE — never CLEAN. A glob
 * that stopped matching is the failure mode this catches, and "found nothing" must never be
 * reported as "verified everything".
 *
 * Wired into `.github/workflows/deploy.yml` only. The shared pre-push hook governs 78 worktrees
 * and installing a 12th block there is a fleet-wide mutation in a different risk class — that is
 * `OPS-PREPUSH-GATE-LANE-W1`, which will install this gate and `check-claim-coverage.mjs` in ONE
 * hook change rather than two. `tests/unit/rendered-comment-hygiene.test.mjs` imports the audit,
 * which is what `check-canaries-wired.mjs` counts as wiring.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(ROOT, 'ops', 'comment-hygiene-config.json');
const LANDING = 'landing';

/** Every HTML comment, including multi-line ones. */
const COMMENT_RE = /<!--([\s\S]*?)-->/g;

// ── Config ───────────────────────────────────────────────────────────────────────────────────

/**
 * A config WE author is a constructed corpus, so an empty or malformed one is vacuity and must
 * REFUSE — distinct from an empty scan of the world, which is a fact about the world.
 */
export function loadConfig(path = CONFIG_PATH) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const rows = raw.allowed_markers;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('comment-hygiene config declares no allowed_markers — an empty allow-list would fail every comment in the tree');
  }
  for (const r of rows) {
    if (!r.pattern || !r.reason) {
      throw new Error(`allow-list row missing pattern or reason: ${JSON.stringify(r)} — an exemption without a stated reason gets "fixed" by the next wave enforcing the contract`);
    }
  }
  if (!Array.isArray(raw.blocking_globs) || raw.blocking_globs.length === 0) {
    throw new Error('comment-hygiene config declares no blocking_globs — a gate that blocks nothing is decoration');
  }
  if (!raw.promotion || typeof raw.promotion.max_leaks !== 'number' || !raw.promotion.decide_by) {
    throw new Error('promotion criterion needs BOTH max_leaks and decide_by — a count-only criterion can never fire if the population never heals');
  }
  return {
    ...raw,
    matchers: rows.map((r) => ({ re: new RegExp(r.pattern), reason: r.reason, pattern: r.pattern })),
  };
}

// ── Scan ─────────────────────────────────────────────────────────────────────────────────────

/** Every `landing/**` HTML file, repo-relative, sorted. */
export function htmlFiles(root = ROOT) {
  const out = [];
  const walk = (rel) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (e.name.endsWith('.html')) out.push(child);
    }
  };
  walk(LANDING);
  return out.sort();
}

/** A file is BLOCKING when it sits directly under one of the blocking globs. */
export function isBlocking(relPath, cfg) {
  return cfg.blocking_globs.some((g) => {
    const dir = g.replace(/\/\*\.html$/, '');
    return relPath.startsWith(`${dir}/`) && !relPath.slice(dir.length + 1).includes('/');
  });
}

/** Normalise a comment's inner text for matching: collapse whitespace, trim. */
export function normalise(inner) {
  return inner.replace(/\s+/g, ' ').trim();
}

/** Does this comment match an enumerated functional marker? */
export function isAllowed(inner, cfg) {
  const text = normalise(inner);
  return cfg.matchers.some((m) => m.re.test(text));
}

/**
 * @returns {{verdict, blocking:Array, report:Array, files:number, comments:number, reasons:string[]}}
 */
export function auditCommentHygiene({ cfg = loadConfig(), files = null, root = ROOT, read = null } = {}) {
  // `files` + `read` exist so the self-test can drive THIS function over a fixture corpus rather
  // than re-implementing it. They are a READ-SCOPE seam and never a verdict seam: a caller can
  // choose what is scanned and cannot make this function report a pass it did not compute.
  // Measured need — the first version of the self-test mirrored this logic in-memory, and two
  // deliberate breaks (zero-files ⇒ CLEAN, and severity routing inverted) went UNDETECTED
  // because the real vacuity branch and the real severity split were never executed.
  const scanned = files ?? htmlFiles(root);
  const readFile = read ?? ((rel) => readFileSync(join(root, rel), 'utf8'));
  const blocking = [];
  const report = [];
  let comments = 0;

  for (const rel of scanned) {
    const text = readFile(rel);
    for (const m of text.matchAll(COMMENT_RE)) {
      comments++;
      if (isAllowed(m[1], cfg)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      const snippet = normalise(m[1]).slice(0, 110);
      (isBlocking(rel, cfg) ? blocking : report).push({ file: rel, line, snippet });
    }
  }

  // Vacuity, OBSERVED side: the world built this corpus, but zero files or zero comments means
  // OUR glob stopped matching — a defect in this gate, never a clean tree.
  if (scanned.length === 0) {
    return { verdict: 'INDETERMINATE', blocking: [], report: [], files: 0, comments: 0,
      reasons: [`0 HTML files found under ${LANDING}/ — the scan glob has drifted. Nothing was verified.`] };
  }
  if (comments === 0) {
    return { verdict: 'INDETERMINATE', blocking: [], report: [], files: scanned.length, comments: 0,
      reasons: [`${scanned.length} file(s) scanned but 0 HTML comments extracted — the extraction regex has drifted. Nothing was verified.`] };
  }

  return {
    verdict: blocking.length ? 'LEAK' : 'CLEAN',
    blocking, report, files: scanned.length, comments,
    reasons: blocking.map((b) => `LEAK ${b.file}:${b.line} — ${b.snippet}`),
  };
}

const EXIT = { CLEAN: 0, LEAK: 1, INDETERMINATE: 3 };

// ── Self-test ────────────────────────────────────────────────────────────────────────────────

/**
 * Two-way, over a corpus this function BUILDS — so an empty one here is a defect in the test and
 * must refuse, unlike an empty runtime scan. Every assertion REPORTS rather than throwing: an
 * assertion that raises aborts the suite instead of printing FAIL, silently converting "proven
 * able to fail" into "crashes".
 */
export function selfTest() {
  const checks = [];
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    // The config is a corpus WE author, so a malformed one is a defect — but it must be REPORTED
    // as a failing verdict, not thrown. A crash prints no token, which is the one outcome the
    // verdict law forbids outright.
    console.log(`  FAIL  config loads — ${String(e.message).slice(0, 160)}`);
    console.log('SELF-TEST: FAIL (1/1)');
    return false;
  }
  const check = (name, fn) => {
    let ok = false, note = '';
    try { const r = fn(); ok = r === true; note = r === true ? '' : String(r); }
    catch (e) { ok = false; note = `threw: ${String(e.message).slice(0, 140)}`; }
    checks.push({ name, ok, note });
  };

  check('config declares a non-empty allow-list (vacuity)', () => cfg.matchers.length > 0 || 'zero matchers');
  check('every allow-list row carries a reason', () => cfg.matchers.every((m) => m.reason) || 'a row has no reason');
  check('promotion criterion carries BOTH a count and a deadline',
    () => (typeof cfg.promotion.max_leaks === 'number' && !!cfg.promotion.decide_by) || 'missing one half');

  // MUST-CATCH — a synthetic internal comment on the BLOCKING surface produces LEAK.
  const leaky = { 'landing/integrations/__fixture__.html':
    '<!-- NAV:START --><!-- INTERNAL-WAVE-W9: a developer note that must never ship --><!-- NAV:END -->' };
  // Drive the REAL audit over a fixture corpus. Never a re-implementation: a mirror of the
  // logic can only ever agree with itself, and the two breaks it missed were both in the real
  // function's own branches.
  const auditStore = (store) => auditCommentHygiene({
    cfg, files: Object.keys(store), read: (rel) => store[rel],
  });

  const bad = auditStore(leaky);
  check('MUST-CATCH: an internal comment on the blocking surface ⇒ LEAK',
    () => bad.verdict === 'LEAK' || `verdict was ${bad.verdict}`);
  check('MUST-CATCH: LEAK maps to exit 1', () => EXIT[bad.verdict] === 1 || `mapped to ${EXIT[bad.verdict]}`);
  check('MUST-CATCH: the allow-listed NAV markers beside it are NOT flagged',
    () => bad.blocking.length === 1 || `flagged ${bad.blocking.length}, expected 1`);

  // MUST-PASS — only allow-listed markers.
  const clean = auditStore({ 'landing/integrations/__fixture__.html':
    '<!-- NAV:START --><!-- NAV:END --><!-- ANALYTICS:START --><!-- ANALYTICS:END -->'
    + '<!-- BEGIN: AlgoVault canonical design loader --><!-- END: AlgoVault canonical design loader -->'
    + '<!-- snapshot: 2026-08-26 — live source of truth: /api/performance-public -->' });
  check('MUST-PASS: only allow-listed markers ⇒ CLEAN', () => clean.verdict === 'CLEAN' || `verdict was ${clean.verdict}`);
  check('MUST-PASS: CLEAN maps to exit 0', () => EXIT[clean.verdict] === 0 || `mapped to ${EXIT[clean.verdict]}`);

  // The severity split is the whole design — assert it both ways.
  const split = auditStore({ 'landing/faq.html': '<!-- SOME-LEGACY-W3 note -->' });
  check('a leak OUTSIDE the blocking surface REPORTS, never blocks',
    () => split.verdict === 'CLEAN' && split.report.length === 1 || `verdict=${split.verdict} report=${split.report.length}`);

  // Vacuity both ways.
  check('zero files ⇒ INDETERMINATE, never CLEAN', () => auditStore({}).verdict === 'INDETERMINATE' || 'not indeterminate');
  check('files but zero comments ⇒ INDETERMINATE',
    () => auditStore({ 'landing/integrations/x.html': '<p>no comments here</p>' }).verdict === 'INDETERMINATE' || 'not indeterminate');
  check('INDETERMINATE maps to exit 3', () => EXIT.INDETERMINATE === 3 || 'wrong code');

  // The real tree must be scannable — the seam above replaces disk, so assert the bypassed path.
  check('the real glob finds HTML files', () => htmlFiles().length > 0 || '0 files from the real glob');
  check('the real glob reaches the blocking surface',
    () => htmlFiles().some((f) => isBlocking(f, cfg)) || 'no blocking-surface file discovered');

  // Marker matching is exact, not substring — a note that merely MENTIONS a marker still leaks.
  check('a prose comment mentioning a marker is still a leak', () => {
    const r = auditStore({ 'landing/integrations/x.html': '<!-- NAV:START is injected by build_nav, see wave W1 -->' });
    return r.verdict === 'LEAK' || 'a prose mention was allow-listed';
  });

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.note ? ` — ${c.note}` : ''}`);
  console.log(`SELF-TEST: ${failed.length ? `FAIL (${failed.length}/${checks.length})` : `PASS (${checks.length} assertions)`}`);
  return failed.length === 0;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);

  let out, cfg;
  try {
    cfg = loadConfig();
    out = auditCommentHygiene({ cfg });
  } catch (e) {
    console.error(`[comment-hygiene] ${String(e.stack || e.message)}`);
    console.log('COMMENT_HYGIENE_VERDICT=INDETERMINATE');
    process.exit(EXIT.INDETERMINATE);
  }

  console.log(`[comment-hygiene] ${out.files} HTML file(s), ${out.comments} comment(s) — blocking surface: ${cfg.blocking_globs.join(', ')}`);
  for (const r of out.reasons) console.error(`  ${r}`);

  if (out.report.length) {
    const files = new Set(out.report.map((r) => r.file));
    console.log(`[comment-hygiene] REPORT lane: ${out.report.length} non-conforming comment(s) across ${files.size} file(s) — not blocked.`);
    console.log(`                  promotion: max_leaks=${cfg.promotion.max_leaks} AND decide_by=${cfg.promotion.decide_by} → ${cfg.promotion.wave}`);
    console.log(`                  observed today: ${out.report.length}. Append this to promotion.observed[] at the decision point so the healing RATE is measured, not guessed.`);
    for (const r of out.report.slice(0, 8)) console.log(`    · ${r.file}:${r.line} — ${r.snippet}`);
    if (out.report.length > 8) console.log(`    · …and ${out.report.length - 8} more`);
  } else {
    console.log('[comment-hygiene] REPORT lane: 0 — the promotion criterion\'s count half is met.');
  }

  if (out.verdict === 'LEAK') {
    console.error('\nFix at the GENERATOR: move the note to a `//` JS comment above the template literal.');
    console.error('An <!-- --> comment inside a template literal is public copy; a // comment never renders.');
  }
  console.log(`COMMENT_HYGIENE_VERDICT=${out.verdict}`);
  process.exit(EXIT[out.verdict]);
}

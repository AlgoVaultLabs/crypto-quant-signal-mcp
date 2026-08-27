#!/usr/bin/env node
/**
 * check-forbidden-phrases.mjs — GROWTH-TG-QUOTA-PARITY-W1 CH4.
 *
 * Blocks a retired brand phrase from reaching a LIVE surface.
 *
 * ── WHY A GATE AND NOT A LIST ───────────────────────────────────────────────────────────────
 * `brand-facts.md` has carried a 🛑 FORBIDDEN list since 2026-08-09. Eighteen days later the
 * retired free-tier figure was still live in 21 vault files and 9 repo files — including
 * `landing/llms-full.txt`, the surface AI agents ingest. Per the Completeness Standard: prose
 * addressed to whoever happens to read it is NOT a control, and a rule that has once failed as
 * prose must be retired into a gate or deleted.
 *
 * ── THE SPLIT ───────────────────────────────────────────────────────────────────────────────
 *   ops/forbidden-phrases.json         ENFORCEMENT — the patterns. Authoritative here.
 *   ops/forbidden-phrase-targets.json  the CORPUS — glob-derived, exemptions carry reasons.
 *   brand-facts.md                     RATIONALE — why, and what to write instead.
 * Both JSON files state the split too, so neither can quietly claim the other's job.
 *
 * ── VERDICT CONTRACT ────────────────────────────────────────────────────────────────────────
 * Exactly ONE terminal line: FORBIDDEN_PHRASE_VERDICT=PASS|FAIL|INDETERMINATE.
 * Exit 0 = PASS · 1 = FAIL · 3 = INDETERMINATE (the token-law default for a NEW gate).
 * 🛑 CALLERS GATE ON THE TOKEN, NEVER THE EXIT CODE. `exit 0` may never encode both
 * "verified, clean" and "verified nothing".
 *
 * ── THE VACUITY GUARD IS AT THE CONSTRUCTION SITE ───────────────────────────────────────────
 * `verification-gates.md`: a vacuity guard belongs where the corpus is CONSTRUCTED, not where
 * it is OBSERVED. WE build this corpus from a manifest WE author, so a manifest expanding to
 * zero files means the manifest is wrong — INDETERMINATE, never PASS. (Contrast a gate handed
 * its input by the world, where empty is a FACT and PASS-with-a-positive-line is correct.)
 *
 * ── MODES ───────────────────────────────────────────────────────────────────────────────────
 *   (none)            scan the manifest corpus
 *   --print-targets   emit the resolved file list, one path per line, and NOTHING else.
 *                     CH5's gate consumes this to prove landing/llms-full.txt was actually in
 *                     the corpus: a PASS over a surface the scanner never opened is the exact
 *                     failure this estate has already recorded (the seam gate's first cut
 *                     hand-listed three files and passed over six it never looked at).
 *   --self-test       two-way fixture proof; prints SELF-TEST: PASS|FAIL and its own verdict.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { stripComments } from './lib/strip-comments.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PHRASES = join(ROOT, 'ops', 'forbidden-phrases.json');
const TARGETS = join(ROOT, 'ops', 'forbidden-phrase-targets.json');

const VERDICT = (tok, code) => {
  console.log(`FORBIDDEN_PHRASE_VERDICT=${tok}`);
  process.exit(code);
};

/** Load + compile the phrase SoT. A malformed file is INDETERMINATE, never a silent pass. */
function loadPhrases(path = PHRASES) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { error: `cannot read ${relative(ROOT, path)}: ${e.message}` };
  }
  const list = Array.isArray(raw.phrases) ? raw.phrases : null;
  if (!list || list.length === 0) {
    // The phrase set is a config WE author, so an empty one is vacuity, not a fact.
    return { error: 'phrase SoT declares zero patterns — refusing to report a pass over nothing' };
  }
  const compiled = [];
  for (const p of list) {
    if (!p || typeof p.pattern !== 'string' || typeof p.id !== 'string') {
      return { error: `malformed phrase entry: ${JSON.stringify(p)?.slice(0, 120)}` };
    }
    try {
      compiled.push({ ...p, re: new RegExp(p.pattern, 'gi') });
    } catch (e) {
      return { error: `phrase ${p.id} has an invalid pattern: ${e.message}` };
    }
  }
  return { phrases: compiled };
}

/**
 * Resolve the corpus from the manifest.
 *
 * Exemptions are matched with the SAME glob engine as the includes, so an exemption pattern and
 * an include pattern cannot disagree about what a `**` means.
 */
function loadTargets(path = TARGETS, root = ROOT) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { error: `cannot read ${relative(ROOT, path)}: ${e.message}` };
  }
  if (!Array.isArray(raw.roots) || raw.roots.length === 0) {
    return { error: 'target manifest declares zero roots' };
  }
  const exemptGlobs = (raw.exempt || []).map((x) => x.path).filter(Boolean);
  const files = new Set();
  for (const entry of raw.roots) {
    const base = join(root, entry.root || '.');
    for (const g of entry.globs || []) {
      let hits = [];
      try {
        hits = globSync(g, { cwd: base });
      } catch {
        hits = [];
      }
      for (const h of hits) files.add(join(base, h));
    }
  }
  let exemptSet = new Set();
  for (const g of exemptGlobs) {
    try {
      for (const h of globSync(g, { cwd: root })) exemptSet.add(join(root, h));
    } catch { /* an exemption that matches nothing is not an error — the file may not exist yet */ }
  }
  const resolved = [...files]
    .filter((f) => !exemptSet.has(f))
    .sort();
  return { files: resolved, exemptCount: exemptSet.size, exemptGlobs };
}

/**
 * Scan one file's text. Returns [{id, line, excerpt, superseded_by}].
 *
 * 🛑 COMMENTS ARE STRIPPED FIRST, in code files. "A mention in a comment is not an occurrence" is
 * a law this repo has codified and re-learned repeatedly, and it bit this gate on its FIRST live
 * run: `plans.ts` explains the ladder it fixed by QUOTING the retired figures, and `x402-nudge.ts`
 * names "the free 100/mo quota" in the docblock describing the leak it closed. Those sentences
 * are the most valuable lines in their files, and a gate that demands their deletion gets
 * warn-moded within a week.
 *
 * `scripts/lib/strip-comments.mjs` is the ONE shared stripper — language-dispatched on the
 * extension and OFFSET-PRESERVING, so the line numbers this gate reports stay correct. Reaching
 * for it rather than hand-rolling a seventeenth implementation is the whole point of its
 * existence.
 *
 * Prose files (.md/.txt/.html) are scanned WHOLE: there, the prose IS the shipped copy.
 */
function scanText(text, phrases, filePath = 'x.md') {
  const out = [];
  const CODE = /\.(ts|tsx|js|mjs|cjs|json)$/i.test(filePath);
  const lines = (CODE ? stripComments(text, filePath) : text).split('\n');
  for (const p of phrases) {
    for (let i = 0; i < lines.length; i++) {
      p.re.lastIndex = 0;
      const m = p.re.exec(lines[i]);
      if (m) {
        // A phrase is not a CLAIM when the same line retires or quotes it. Suppressed hits are
        // COUNTED and reported, never silently dropped — see _negative_context_contract.
        if (p.negative_context && new RegExp(p.negative_context).test(lines[i])) {
          out.push({ id: p.id, suppressed: true, line: i + 1 });
          continue;
        }
        out.push({
          id: p.id,
          severity: p.severity || 'error',
          line: i + 1,
          excerpt: lines[i].trim().slice(0, 110),
          superseded_by: p.superseded_by,
        });
      }
    }
  }
  return out;
}

function run() {
  const ph = loadPhrases();
  if (ph.error) {
    console.error(`✗ ${ph.error}`);
    VERDICT('INDETERMINATE', 3);
  }
  const tg = loadTargets();
  if (tg.error) {
    console.error(`✗ ${tg.error}`);
    VERDICT('INDETERMINATE', 3);
  }
  if (tg.files.length === 0) {
    // THE VACUITY GUARD. We built this corpus; empty means the manifest is broken.
    console.error('✗ target manifest expanded to ZERO files — the corpus is empty, so this run');
    console.error('  verified nothing. That is a defect in ops/forbidden-phrase-targets.json,');
    console.error('  not evidence that the estate is clean.');
    VERDICT('INDETERMINATE', 3);
  }

  let errors = 0;
  let warns = 0;
  let suppressed = 0;
  for (const f of tg.files) {
    let text;
    try {
      text = readFileSync(f, 'utf8');
    } catch (e) {
      // Handed to us and unreadable => INDETERMINATE. Empty-vs-unparseable is the line.
      console.error(`✗ cannot read ${relative(ROOT, f)}: ${e.message}`);
      VERDICT('INDETERMINATE', 3);
    }
    for (const hit of scanText(text, ph.phrases, f)) {
      if (hit.suppressed) { suppressed++; continue; }
      const where = `${relative(ROOT, f)}:${hit.line}`;
      if (hit.severity === 'error') {
        errors++;
        console.error(`✗ ${where}  [${hit.id}]  → use: ${hit.superseded_by}`);
        console.error(`    ${hit.excerpt}`);
      } else {
        warns++;
        console.error(`⚠ ${where}  [${hit.id}]`);
      }
    }
  }

  // Print the corpus size beside every result: a sweep that searched nothing must never look
  // like a clean one.
  console.log(
    `scanned ${tg.files.length} files (${ph.phrases.length} patterns, ` +
      `${tg.exemptGlobs.length} exemption globs → ${tg.exemptCount} files excluded, ` +
      `${suppressed} hit(s) suppressed by negative context)`,
  );
  if (errors > 0) {
    console.error(`✗ ${errors} forbidden phrase(s) on live surfaces.`);
    VERDICT('FAIL', 1);
  }
  console.log(`✓ no forbidden phrase on any of the ${tg.files.length} scanned live surfaces.`);
  if (warns) console.log(`  (${warns} warn-severity hit(s), verdict unaffected)`);
  VERDICT('PASS', 0);
}

function printTargets() {
  const tg = loadTargets();
  if (tg.error || tg.files.length === 0) {
    // --print-targets is consumed by CH5's gate; emitting a partial list would let that gate
    // "prove" coverage it does not have. Say nothing, and fail loudly on stderr.
    console.error(`✗ ${tg.error || 'target manifest expanded to zero files'}`);
    process.exit(3);
  }
  // NOTHING but paths on stdout — this is a machine surface.
  for (const f of tg.files) console.log(relative(ROOT, f));
  process.exit(0);
}

// ── self-test ────────────────────────────────────────────────────────────────────────────────

function selfTest() {
  let passed = 0;
  let failed = 0;
  const check = (name, fn) => {
    let ok = false;
    let detail = '';
    try {
      ok = fn() === true;
    } catch (e) {
      // An assertion that RAISES is not an assertion — it aborts the suite instead of reporting
      // FAIL, silently converting "proven able to fail" into "crashes".
      ok = false;
      detail = ` (threw: ${e.message.slice(0, 80)})`;
    }
    if (ok) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.log(`  ✗ ${name}${detail}`); }
  };

  const ph = loadPhrases();
  if (ph.error) {
    console.log(`  ✗ the real phrase SoT does not load: ${ph.error}`);
    console.log('SELF-TEST: FAIL (0 passed, 1 failed)');
    VERDICT('INDETERMINATE', 3);
  }

  // Fixtures are built with the REAL loader, not hand-written shapes: a hermetic suite is blind
  // to exactly what its own seam replaces, and hand-rolled fixtures are how that blindness gets
  // in. These strings are the ACTUAL retired phrases from the estate census.
  const DIRTY = {
    'free-quota-100-per-month': 'The free tier gives you 100 calls/month across every asset.',
    'free-quota-100-mo-shorthand': 'counts as one call against your 100/mo free quota; a market scan',
    'retired-tier-quotas': 'Starter includes 3,000 calls and Pro 15,000 calls a month.',
    'free-quota-after-100': 'After 100, pay per call via x402 (USDC on Base) — no signup.',
    'free-quota-20-per-day': 'Free tier: 20 calls/day, no card needed.',
    'month-only-enforcement': 'Every tier has no daily cap, so burst as hard as you like.',
    'legacy-asset-gate': 'The free tier covers BTC and ETH only.',
    'retired-annual-pricing': 'Starter is $79/yr — Save 34% versus monthly.',
    'weakened-positioning': 'AlgoVault is the Quant Layer for crypto.',
    'nonexistent-pricing-page': 'See algovault.com/pricing for the full ladder.',
  };
  const CLEAN = [
    '200 calls/month, up to 100 per UTC day.',
    'Upgrade to Starter ($9.99/mo or $39.90/6mo → 10,000 API calls/mo).',
    'The Brain Layer for AI Trading Agents',
    'Pro gives 100,000 calls a month.',
    'See https://api.algovault.com/signup for the ladder.',
    'You get 200 free alerts a month, up to 100 a day.',
  ];

  console.log('SELF-TEST — forbidden-phrase gate');

  // (1) EVERY declared pattern must actually fire on a real example of what it retired. A
  // pattern with no fixture is a pattern nobody has ever seen match.
  for (const p of ph.phrases) {
    const fixture = DIRTY[p.id];
    check(`pattern ${p.id} fires on its retired phrase`, () => {
      if (!fixture) return false; // no fixture == unproven == FAIL, never a silent skip
      return scanText(fixture, ph.phrases).some((h) => h.id === p.id);
    });
  }

  // (2) The CANONICAL replacements must NOT fire. A gate that fails on the copy it is steering
  // authors toward gets warn-moded within a week.
  for (const good of CLEAN) {
    check(`clean copy stays clean: "${good.slice(0, 46)}…"`, () => scanText(good, ph.phrases).length === 0);
  }

  // (3) The vacuity guard, at the construction site.
  const tmp = mkdtempSync(join(tmpdir(), 'fpg-'));
  try {
    const emptyManifest = join(tmp, 'targets.json');
    writeFileSync(emptyManifest, JSON.stringify({ roots: [{ root: '.', globs: ['no-such-dir/**/*.md'] }] }));
    check('an empty corpus resolves to zero files (INDETERMINATE at runtime, never PASS)', () => {
      const r = loadTargets(emptyManifest, tmp);
      return !r.error && r.files.length === 0;
    });
    const noRoots = join(tmp, 'noroots.json');
    writeFileSync(noRoots, JSON.stringify({ roots: [] }));
    check('a manifest with zero roots is refused', () => Boolean(loadTargets(noRoots, tmp).error));

    // (4) A malformed SoT must be INDETERMINATE, not a crash and not a pass. An uncaught throw
    // here would mean NO verdict token at all — the one outcome the token law forbids.
    const badJson = join(tmp, 'bad.json');
    writeFileSync(badJson, '{ not json');
    check('an unparseable phrase SoT reports an error rather than throwing', () =>
      Boolean(loadPhrases(badJson).error));
    const emptyPhrases = join(tmp, 'empty.json');
    writeFileSync(emptyPhrases, JSON.stringify({ phrases: [] }));
    check('a phrase SoT with zero patterns is refused', () => Boolean(loadPhrases(emptyPhrases).error));
    const badPattern = join(tmp, 'badre.json');
    writeFileSync(badPattern, JSON.stringify({ phrases: [{ id: 'x', pattern: '([unclosed' }] }));
    check('an invalid regex is reported, not thrown', () => Boolean(loadPhrases(badPattern).error));

    // (5) Exemptions actually EXCLUDE — the half that, if broken, makes ledger files fail.
    const exDir = join(tmp, 'ex');
    mkdirSync(join(exDir, 'audits'), { recursive: true });
    writeFileSync(join(exDir, 'live.md'), 'x');
    writeFileSync(join(exDir, 'audits', 'old.md'), 'x');
    const exManifest = join(tmp, 'ex.json');
    writeFileSync(exManifest, JSON.stringify({
      roots: [{ root: '.', globs: ['**/*.md'] }],
      exempt: [{ path: 'audits/**', reason: 'ledger' }],
    }));
    check('a reasoned exemption excludes its paths and keeps the rest', () => {
      const r = loadTargets(exManifest, exDir);
      const names = (r.files || []).map((f) => relative(exDir, f).split(sep).join('/'));
      return names.includes('live.md') && !names.includes('audits/old.md');
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // (6) The BYPASSED ARTIFACT: the real manifest, which every fixture above replaces. A hermetic
  // suite is structurally blind to it, so assert it explicitly.
  const realTargets = loadTargets();
  check('the REAL manifest resolves a non-empty corpus', () =>
    !realTargets.error && realTargets.files.length > 0);
  check('the REAL corpus contains landing/llms-full.txt', () =>
    (realTargets.files || []).some((f) => relative(ROOT, f).endsWith('landing/llms-full.txt')));

  console.log(`SELF-TEST: ${failed === 0 ? 'PASS' : 'FAIL'} (${passed} passed, ${failed} failed)`);
  if (failed > 0) VERDICT('FAIL', 1);
  VERDICT('PASS', 0);
}

const argv = process.argv.slice(2);
if (argv.includes('--print-targets')) printTargets();
else if (argv.includes('--self-test')) selfTest();
else run();

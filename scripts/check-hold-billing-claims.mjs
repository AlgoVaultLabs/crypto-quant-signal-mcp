#!/usr/bin/env node
/**
 * OPS-OPERATOR-SURFACES-HOLD-RETIRE-W1 (R6) — no RUNTIME STRING may claim a HOLD is free.
 *
 * WHY A SECOND GUARD, WHEN `tests/unit/no-free-hold-promise.test.ts` ALREADY EXISTS.
 * That one is an ALLOWLIST gate: it reads ~30 named public surfaces and asserts the pricing
 * promise is absent from each. It is the right shape for public copy — a path list is the only
 * thing that can tell a live promise from a behaviour identifier — but it is blind by
 * construction to any file not on the list, and every operator surface is off it by design
 * (architect Q1, 2026-08-05: internal ops dashboards deliberately unguarded).
 *
 * That exemption is what let `🆓 Free-by-design HOLD` and `HOLD calls (free today)` sit on two
 * operator surfaces for two days after the flat-billing cutover made both false. Mr.1's
 * 2026-08-10 ruling supersedes it for CLAIMS: no operator surface may assert HOLD is free or
 * unbilled for post-cutover traffic. The exemption for behaviour IDENTIFIERS (`free_hold`,
 * `holdFree`) and for correction records stands.
 *
 * So this gate inverts the shape: it scans EVERY tracked `src/**` + `scripts/**` source file
 * and DENIES by default, with an exact-string exemption registry. A new surface is covered the
 * moment it is written, which an allowlist can never be.
 *
 * WHY STRING LITERALS AND NOT A TEXT GREP. A text grep over this repo fires on its own history:
 * `x402-http-routes.ts` documents that a line "read '…HOLD verdicts stay free…' until
 * 2026-08-09", and `call-class.ts` explains at length why the legacy class exists. Those
 * comments are the most valuable lines in their files — a gate that demands their deletion gets
 * disabled. Only a RUNTIME string can reach an operator's eyes, so only runtime strings are the
 * target: comments are stripped, then literals are extracted, then patterns match.
 *
 * Verdict token per CLAUDE.md: exactly one terminal `HOLD_BILLING_CLAIMS_VERDICT=` line.
 * Exit codes 0=PASS / 1=FAIL / 3=INDETERMINATE (the token-law default for a NEW gate; do not
 * "align" it with check_test_baseline.sh's 2, which is 2 only because it already deployed 2).
 *
 * Usage:  node scripts/check-hold-billing-claims.mjs [--self-test]
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = 'HOLD_BILLING_CLAIMS_VERDICT';

/** Phrasings that assert a HOLD costs nothing. Deliberately broad — the claim mutates. */
const CLAIM_PATTERNS = [
  { name: 'hold-then-free', re: /HOLDs?\b[^\n]{0,40}?\b(?:free|unmetered|unbilled|not charged|never charged|no quota|billed \$?0)\b/i },
  { name: 'free-then-hold', re: /\b(?:free|unbilled|unmetered)\b[^\n]{0,20}?HOLDs?\b/i },
];

/**
 * Exempt EXACT literals. One `reason` per row — an exemption that lives only in a comment gets
 * "fixed" by a future wave enforcing the contract (CLAUDE.md). Matching is exact-string, never
 * a pattern, so an exemption can never widen into a hole.
 *
 * A row that matches NOTHING is a FAIL, not a shrug: dead config is how an exemption list stops
 * describing the code it guards.
 */
const GUARDED = [
  {
    literal: 'free_hold',
    reason: 'behaviour identifier — the CallClass member itself; banning it would forbid naming what the code does (architect Q1, 2026-08-05)',
  },
  {
    // NB the SOURCE form, with the template hole. `call-class.ts` derives the date from
    // FLAT_BILLING_CUTOVER_ISO, so the rendered form never appears in any source file — and a
    // hand-typed rendered copy anywhere SHOULD fail, which is R3's single-label rule enforced.
    literal: 'Unbilled HOLD (pre-${FLAT_BILLING_CUTOVER_DATE}, legacy)',
    reason: 'the R3 legacy class label — date-bounded, so it asserts nothing about post-cutover traffic; the ONE label source (BILLING_CLASS_LABELS)',
  },
  // ── check-mcp-client-copy.mjs must-fire FIXTURES ──────────────────────────────────────────
  // That canary bans the free-HOLD promise in public MCP-client copy; these five strings ARE
  // its positive test corpus. Deleting them to satisfy THIS gate would silently delete that
  // gate's ability to fail — the classic "ban-line matching its own literal" false positive.
  // Exact-string rows, so a NEW fixture there still fires here and needs a conscious exemption.
  { literal: 'HOLD verdicts are free and never charged.', reason: 'check-mcp-client-copy.mjs must-fire fixture (/fx/bl-hold-are.md)' },
  { literal: 'A HOLD is free, so scan as often as you like.', reason: 'check-mcp-client-copy.mjs must-fire fixture (/fx/bl-hold-is.md)' },
  { literal: 'Batch scans give you free HOLDs at no quota cost.', reason: 'check-mcp-client-copy.mjs must-fire fixture (/fx/bl-hold-adj.md)' },
  { literal: 'A HOLD is never charged against your allowance.', reason: 'check-mcp-client-copy.mjs must-fire fixture (/fx/bl-hold-never.md)' },
  { literal: '<!-- retired: HOLDs are free --><p>Every verdict counts, HOLD included.</p>', reason: 'check-mcp-client-copy.mjs must-NOT-fire fixture proving its comment-stripping works' },
];

/**
 * THIS FILE, excluded from its own scan — and the reason it is a path and not exact strings.
 *
 * Every claim this gate must catch is written out here twice: once as a `--self-test` must-fire
 * fixture and once as a pattern NAME (`hold-then-free`). Once the gate is tracked, it flags
 * itself 11 times — the ban-line-matching-its-own-literal false positive, which this repo has
 * hit before. Exact-string rows would work but would have to be maintained in lockstep with the
 * fixtures, so adding a must-fire case would mean adding an exemption for it: the corpus that
 * proves the gate works would be the corpus that erodes it.
 *
 * A path exclusion is safe HERE and nowhere else: these literals are a test corpus and a pattern
 * vocabulary, and no operator can ever read them. The `--self-test` is what covers this file, and
 * the assertion below pins the exclusion at exactly one path so it cannot silently widen.
 */
const SELF_REL = 'scripts/check-hold-billing-claims.mjs';

/** Files whose literals are scanned. Tracked sources only — never a working-tree walk. */
function sourceFiles() {
  const out = execFileSync('git', ['ls-files', '--', 'src', 'scripts'], { cwd: ROOT, encoding: 'utf8' });
  const all = out.split('\n').filter((p) => /\.(ts|mts|cts|mjs|cjs|js)$/.test(p) && !/\.d\.ts$/.test(p));
  const kept = all.filter((p) => p !== SELF_REL);
  // The exclusion is exactly one file, and that file must actually be tracked — otherwise a
  // rename would silently turn the self-exclusion into "scan everything and fail forever", or
  // (worse) a typo'd path would leave the gate scanning itself with nobody noticing why.
  if (all.length - kept.length !== 1) {
    throw new Error(`self-exclusion matched ${all.length - kept.length} files, expected exactly 1 (${SELF_REL} moved?)`);
  }
  return kept;
}

/**
 * Strip comments so a historical correction record is not read as a live claim.
 * The `[^:]` guard on the line-comment rule keeps `https://…` inside a URL literal intact —
 * same idiom as `tests/unit/no-free-hold-promise.test.ts`.
 */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/**
 * Extract runtime string literals: '…', "…", `…`. Escapes are honoured so a literal containing
 * its own quote is not truncated mid-string (which would silently hide a claim past the escape).
 * Returns the literal BODIES, without their delimiters.
 */
export function extractStringLiterals(src) {
  const lits = [];
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  let m;
  while ((m = re.exec(src)) !== null) lits.push(m[1] ?? m[2] ?? m[3] ?? '');
  return lits;
}

/** Every claim-shaped literal in one file, with the pattern that caught it. */
export function scanSource(src) {
  const lits = extractStringLiterals(stripComments(src));
  const hits = [];
  for (const lit of lits) {
    if (GUARDED.some((g) => lit === g.literal)) continue;
    for (const p of CLAIM_PATTERNS) {
      const m = lit.match(p.re);
      if (m) { hits.push({ literal: lit, pattern: p.name, matched: m[0] }); break; }
    }
  }
  return hits;
}

function fail(msg, code) {
  console.error(msg);
  console.log(`${GATE}=${code === 3 ? 'INDETERMINATE' : 'FAIL'}`);
  process.exit(code);
}

// ── self-test ────────────────────────────────────────────────────────────────────────────────
//
// Two-way and vacuity-guarded, and every fixture goes through the REAL extractor rather than a
// hand-written literal array — a hermetic suite is otherwise blind to exactly the seam it
// replaces (CLAUDE.md, paid for three times). Assertions REPORT rather than throw, so a broken
// subject prints `SELF-TEST: FAIL` instead of aborting the run with no verdict.
function selfTest() {
  let pass = 0;
  let failed = 0;
  const check = (name, fn) => {
    let ok = false;
    try { ok = fn() === true; } catch (e) { ok = false; console.error(`  ${name}: threw ${e.message}`); }
    if (ok) pass++; else { failed++; console.error(`  MUST-${name}: FAIL`); }
  };

  // MUST-FIRE — every one of these is a real string this repo shipped or nearly shipped.
  const mustFire = [
    `const a = '• 🆓 Free-by-design HOLD — Last 24h: 5';`,
    `const b = "HOLD calls (free today)";`,
    `const c = \`agents consume free HOLDs today\`;`,
    `const d = 'HOLD verdicts are free and never charged';`,
    `const e = 'HOLDs stay free until you decide otherwise';`,
    `const f = 'all traffic incl. free HOLD';`,
    `const g = 'HOLD calls are unbilled';`,
  ];
  for (const [i, src] of mustFire.entries()) {
    check(`fire[${i}]`, () => scanSource(src).length > 0);
  }

  // MUST-NOT-FIRE — the classes that must survive, or the gate gets disabled.
  const mustNotFire = [
    // a correction record in a comment, quoting the very claim it retired
    `// This line read "HOLD verdicts stay free, like MCP" until 2026-08-09.\nconst x = 'ok';`,
    `/* the operator funnel would report "~99% of external calls are free HOLDs" as 0% */\nconst y = 'ok';`,
    // the behaviour identifier
    `return verdict === HOLD_VERDICT ? 'free_hold' : 'billable';`,
    // the R3 legacy label, in the SOURCE form the extractor actually sees (template hole intact)
    'const l = \'Unbilled HOLD (pre-${FLAT_BILLING_CUTOVER_DATE}, legacy)\';',
    // post-cutover copy
    `const m = 'HOLD calls (metered)';`,
    `const n = 'Since 2026-08-08 every verdict is one metered call, HOLD included';`,
    // a URL literal must survive comment-stripping intact
    `const u = 'https://algovault.com/docs#hold';`,
  ];
  for (const [i, src] of mustNotFire.entries()) {
    check(`notfire[${i}]`, () => scanSource(src).length === 0);
  }

  // The extractor itself — the seam every fixture above depends on.
  check('extract-handles-escape', () => {
    const lits = extractStringLiterals(`const s = 'it\\'s free HOLD';`);
    return lits.length === 1 && lits[0].includes('free HOLD');
  });
  check('extract-nonempty-on-real-source', () => {
    const real = readFileSync(join(ROOT, 'src/lib/call-class.ts'), 'utf8');
    return extractStringLiterals(stripComments(real)).length > 5;
  });
  // Vacuity: WE build this corpus, so empty means the test built nothing. REFUSE.
  check('corpus-nonempty', () => mustFire.length >= 5 && mustNotFire.length >= 5);
  // The enumeration seam itself — hermetic fixtures are blind to exactly what they replace, and
  // this is the seam that decides WHAT gets scanned. It must exclude this file and nothing else.
  check('self-exclusion-is-exactly-this-file', () => {
    const files = sourceFiles(); // throws if the exclusion stops matching exactly one path
    return files.length > 50 && !files.includes(SELF_REL) && files.includes('src/lib/call-class.ts');
  });

  console.error(`SELF-TEST: ${failed === 0 ? 'PASS' : 'FAIL'} (${pass} passed, ${failed} failed)`);
  if (failed > 0) { console.log(`${GATE}=FAIL`); process.exit(1); }
  console.log(`${GATE}=PASS`);
  process.exit(0);
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────
function main() {
  if (process.argv.includes('--self-test')) return selfTest();

  let files;
  try {
    files = sourceFiles();
  } catch (e) {
    return fail(`[hold-billing-claims] could not enumerate tracked sources: ${e.message}`, 3);
  }
  // Vacuity: the corpus is built by `git ls-files` against a repo we control, so an empty set
  // means the enumeration broke — not that the repo has no sources. REFUSE.
  if (files.length < 50) {
    return fail(`[hold-billing-claims] only ${files.length} source files found — enumeration is broken`, 3);
  }

  const findings = [];
  const seen = new Set();
  let literalCount = 0;
  for (const rel of files) {
    let src;
    try {
      src = readFileSync(join(ROOT, rel), 'utf8');
    } catch (e) {
      return fail(`[hold-billing-claims] could not read ${rel}: ${e.message}`, 3);
    }
    const stripped = stripComments(src);
    literalCount += extractStringLiterals(stripped).length;
    for (const h of scanSource(src)) findings.push({ file: rel, ...h });
    for (const lit of extractStringLiterals(stripped)) {
      for (const g of GUARDED) if (lit === g.literal) seen.add(g.literal);
    }
  }
  if (literalCount < 500) {
    return fail(`[hold-billing-claims] only ${literalCount} literals extracted — the extractor is broken`, 3);
  }

  // A guarded row that matches nothing no longer describes this codebase. Delete it.
  const dead = GUARDED.filter((g) => !seen.has(g.literal));
  if (dead.length > 0) {
    console.error('[hold-billing-claims] DEAD exemption rows — the literal no longer exists; delete the row:');
    for (const g of dead) console.error(`  - ${JSON.stringify(g.literal)}  (${g.reason})`);
  }

  if (findings.length > 0) {
    console.error(`[hold-billing-claims] ${findings.length} runtime string(s) claim a HOLD is free/unbilled.`);
    console.error('Since the flat-billing cutover every verdict is one metered call, HOLD included.');
    console.error('Fix the copy. To exempt a behaviour identifier or a date-bounded legacy label,');
    console.error('add an exact-string row with a reason to GUARDED in this file.\n');
    for (const f of findings) {
      console.error(`  ${f.file}\n    pattern: ${f.pattern}\n    matched: ${JSON.stringify(f.matched)}\n    literal: ${JSON.stringify(f.literal.slice(0, 160))}`);
    }
  }

  if (findings.length > 0 || dead.length > 0) {
    console.log(`${GATE}=FAIL`);
    process.exit(1);
  }
  console.error(`[hold-billing-claims] ${files.length} files · ${literalCount} literals · 0 HOLD-free claims · ${GUARDED.length} guarded row(s) all live.`);
  console.log(`${GATE}=PASS`);
  process.exit(0);
}

// Test-importable entrypoint (CLAUDE.md): importing this module must not run the gate or exit
// the process, so a suite can drive `scanSource` directly instead of shelling out.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

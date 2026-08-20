#!/usr/bin/env node
/**
 * check-credential-outcome-conformance.mjs — AUTH-THREE-STATE-W1 CH3.
 *
 * THE CLASS THIS RETIRES. `resolveFromApiKeyAsync` had four separate not-found paths that all
 * returned a byte-identical `{ tier: 'free', key: null }`: no credential presented, an unknown
 * `av_free_` key, a key Stripe says does not exist, and a key we could not ask about. Because the
 * object was identical, no consumer could tell them apart and none tried — so a paying customer
 * with a typo'd or revoked key was served the anonymous free tier at HTTP 200, metered into
 * `free:<ipHash>`, and given no way to find out. Measured live 2026-08-18: all four returned the
 * same verdict on the same bucket, three calls apart.
 *
 * CH1 made the states expressible and CH2/CH3 made every consumer project from them. Neither made
 * it MANDATORY. This gate is what makes writing the collapse again a BUILD FAILURE rather than a
 * code-review catch — CLAUDE.md: *"after the 3rd same-class fix the 4th MUST build a gate making
 * the bug class structurally impossible."*
 *
 * ── Rules ────────────────────────────────────────────────────────────────────
 *   R1  every LicenseInfo-shaped literal (`tier:` + `key` in one object) carries `outcome:`
 *   R2  the exact historical defect shape `{ tier: 'free', key: null }` never appears unstamped
 *   R3  `AV_KEY_SHAPE` is the ONLY key-shape regex literal in src/
 *   R4  no serving path decides auth by bare-null key testing
 *   R5  every `_algovault` envelope construction in a live tool routes through `withAuthState`
 *
 * ── Contract ─────────────────────────────────────────────────────────────────
 * Verdict: exactly one terminal `CREDENTIAL_OUTCOME_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Exit: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE. NEW gate with no incumbent code, so INDETERMINATE
 * is 3 per the token-law default — deliberately NOT `check_test_baseline.sh`'s 2, which is 2 only
 * because it already deployed 2. Callers gate on the TOKEN, never the bare exit code.
 *
 * FAIL-CLOSED: an unreadable corpus, a corpus of ZERO files, or an exemption without a reason is
 * INDETERMINATE, which blocks. The vacuity guard sits where the corpus is CONSTRUCTED — we build
 * the file list, so empty means the walker broke, never "the tree is clean".
 *
 * ── What this gate CANNOT see, stated so nobody claims otherwise ─────────────
 *  · Object literals containing NESTED braces are skipped by the R1/R2 extractor (it matches a
 *    brace span with no inner `{`). Every LicenseInfo construction in the tree today is flat, and
 *    the run PRINTS its corpus counts so a collapse to zero is visible rather than silent.
 *  · The corpus is `git ls-files`, matching `check-canaries-wired.mjs`. An UNTRACKED new file is
 *    invisible until it is staged — which is fine for CI and for a pre-publish gate, and is the
 *    reason the count is printed on every run.
 *  · Comments are STRIPPED before every ban-grep. The docblock above quotes the defect shape
 *    verbatim, and the explanatory prose is the most valuable text in these files — a naive grep
 *    would demand its deletion (build-and-runtime.md, gate-writing bug (a)).
 */
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Declared exemptions. A row, never prose — an exemption that lives only in a comment gets
 * "fixed" by a future wave enforcing the contract. Every row MUST carry a reason; a row without
 * one is INDETERMINATE, not a silent pass.
 */
const EXEMPTIONS = [
  {
    rule: 'R4',
    file: 'src/scripts/register-erc8004-agent.ts',
    match: 'if (!ownerKey)',
    reason:
      'Not a caller credential. `ownerKey` here is the ERC8004_AGENT_OWNER_KEY *environment variable* read by a one-shot mint script; the bare-null test is an env preflight that calls fail(), on no serving path and with no license in scope.',
  },
];

/** The ONE key-shape literal, assembled from fragments so this file is not a second copy of it. */
const KEY_SHAPE_NEEDLE = ['av_(live|free)_', '[a-f0-9]', '{24}'].join('');
const KEY_SHAPE_HOME = 'src/lib/credential-outcome.ts';

/** Modules that build an `_algovault` envelope for a LIVE MCP tool (R5). */
const LIVE_TOOL_ENVELOPES = [
  'src/tools/get-trade-call.ts',
  'src/tools/get-market-regime.ts',
  'src/tools/scan-funding-arb.ts',
  'src/tools/scan-trade-calls.ts',
  'src/lib/chat-knowledge-formatter.ts',
  'src/lib/search-knowledge-formatter.ts',
];

// ── source helpers ───────────────────────────────────────────────────────────

/**
 * Strip block + line comments, tracking string / template / regex state.
 *
 * 🛑 THE NAIVE VERSION IS AN INSTRUMENT THAT CANNOT SEE ITS SUBJECT. The first draft here was the
 * two-line regex form used elsewhere in this repo: a global block-comment replace plus a per-line
 * `replace(/\/\/.*$/,'')`. Measured on this tree: it deleted **60% of `src/index.ts` and 64% of
 * `src/lib/license.ts`**, including real code — a `//` inside a URL string (`https:` + slash
 * slash) truncates the rest of the line, and a block-comment OPENER inside a string or regex
 * starts a phantom comment that runs to the next CLOSER anywhere in the file. It removed both
 * x402 grants from `license.ts` outright.
 *
 * For a gate that ASSERTS ABSENCE, over-stripping is the dangerous direction: every violation
 * inside the deleted 60% reads as clean, and the run reports a confident PASS. That is the same
 * defect shape this repo has recorded four times — an instrument structurally incapable of
 * observing the thing it is pointed at, returning a confident zero. So the scanner below is not
 * polish; it is the difference between a gate and a decoration.
 *
 * Known limit, stated rather than discovered later: a backtick inside a `${…}` substitution is
 * treated as closing its template. No such construct exists in this tree, and the self-test pins
 * the three cases that actually occur — URLs, regex literals, and `/*` inside a string.
 */
export function strip(text) {
  // A `/` starts a regex only where a value cannot have just ended.
  const canStartRegex = (prev) => prev === '' || !/[)\]}\w$'"`]/.test(prev);
  let out = '';
  let prev = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {                       // line comment
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && d === '*') {                       // block comment
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {           // string / template — opaque
      out += c;
      i += 1;
      while (i < n) {
        if (text[i] === '\\') { out += text[i] + (text[i + 1] ?? ''); i += 2; continue; }
        out += text[i];
        if (text[i] === c) { i += 1; break; }
        i += 1;
      }
      prev = c;
      continue;
    }
    if (c === '/' && canStartRegex(prev)) {              // regex literal — opaque
      out += c;
      i += 1;
      let inClass = false;
      while (i < n && text[i] !== '\n') {
        if (text[i] === '\\') { out += text[i] + (text[i + 1] ?? ''); i += 2; continue; }
        if (text[i] === '[') inClass = true;
        else if (text[i] === ']') inClass = false;
        out += text[i];
        i += 1;
        if (text[i - 1] === '/' && !inClass) break;
      }
      prev = '/';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return out;
}

/**
 * Remove `interface X { … }` and `type X = { … }` bodies by brace matching.
 *
 * A TYPE DECLARATION is not a construction, and conflating them is not hypothetical — the first
 * live run of this gate reported `src/types.ts`'s own `LicenseInfo` interface as an unstamped
 * LicenseInfo literal, and counted three type members in `scan-trade-calls.ts` as unstamped
 * envelope sites. Discriminating structurally, once, here, is what `quota-surfaces.ts:99-104`
 * does for the same reason — and it is why the fixtures below exercise both forms.
 */
export function stripTypeBlocks(src) {
  let out = '';
  let i = 0;
  const re = /(?:^|\n)\s*(?:export\s+)?(?:interface\s+\w+[^{]*|type\s+\w+\s*=\s*)\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const open = m.index + m[0].length - 1;
    out += src.slice(i, open);
    let depth = 0;
    let j = open;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth += 1;
      else if (src[j] === '}' && (depth -= 1) === 0) break;
    }
    i = Math.min(j + 1, src.length);
    re.lastIndex = i;
  }
  return out + src.slice(i);
}

/** Flat object literals (no nested braces) — the shape every LicenseInfo construction uses. */
export function flatObjectLiterals(src) {
  return src.match(/\{[^{}]*\}/g) ?? [];
}

/** A literal that constructs a LicenseInfo: names `tier` and `key` as members. */
export function isLicenseLiteral(lit) {
  return /\btier\s*:/.test(lit) && /\bkey\s*(:|,|\})/.test(lit);
}

/** Accepts the shorthand member `{ outcome, … }` as well as `outcome: …`. */
export function hasOutcome(lit) {
  return /\boutcome\s*:/.test(lit) || /[{,]\s*outcome\s*[,}]/.test(lit);
}

/** R2's exact historical shape, whitespace-tolerant. */
export function isDefectShape(lit) {
  return /\{\s*tier\s*:\s*'free'\s*,\s*key\s*:\s*null\s*[,}]/.test(lit);
}

/**
 * R4: a credential decision made by NULL-TESTING and answered with the outcome-BLIND emitter.
 *
 * The null test itself is fine and stays — `!ownerKey` is a perfectly good trigger. What was wrong
 * is answering it with `authRequired()`, whose message ("An API key is required…") is TRUE for a
 * caller who sent nothing and FALSE for one who sent a key we could not resolve. The fix routes
 * the same trigger through `refuseOwner`/`refuseCredentialHttp`, which branch on the outcome and
 * fall back to that identical message for ABSENT/MALFORMED. So this rule bans the PAIR, not the
 * test — banning the test would have demanded a rewrite that changes nothing about the defect.
 */
export function bareNullAuthTests(src) {
  const out = [];
  const patterns = [
    /if \(!(?:license\.key|ownerKey)\)[^\n]*\bauthRequired\(/g, // null-test answered outcome-blind
    /license\.key\s*(?:!==|===)\s*null/g,                        // existence inferred from key-presence
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) out.push(m[0].replace(/\s+/g, ' ').slice(0, 70));
  }
  return out;
}

// ── corpus ───────────────────────────────────────────────────────────────────

export function corpus() {
  let files;
  try {
    files = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((f) => f.endsWith('.ts'));
  } catch (err) {
    return { error: `git ls-files failed: ${err instanceof Error ? err.message : err}` };
  }
  if (files.length === 0) return { error: 'corpus is EMPTY — we construct this list, so zero means the walker broke, never that the tree is clean' };
  const sources = new Map();
  for (const f of files) {
    const p = join(ROOT, f);
    if (!existsSync(p)) return { error: `tracked file is unreadable: ${f}` };
    try {
      sources.set(f, stripTypeBlocks(strip(readFileSync(p, 'utf8'))));
    } catch (err) {
      return { error: `unreadable: ${f} — ${err instanceof Error ? err.message : err}` };
    }
  }
  return { sources };
}

// ── the rules ────────────────────────────────────────────────────────────────

export function runRules(sources, exemptions = EXEMPTIONS) {
  const findings = [];
  const counts = { files: sources.size, licenseLiterals: 0, envelopeSites: 0, keyShapeHits: 0 };
  const exemptFor = (rule, file, match) =>
    exemptions.some((e) => e.rule === rule && e.file === file && match.includes(e.match));

  for (const [file, src] of sources) {
    // R1 + R2
    for (const lit of flatObjectLiterals(src)) {
      if (!isLicenseLiteral(lit)) continue;
      counts.licenseLiterals += 1;
      if (hasOutcome(lit)) continue;
      const flat = lit.replace(/\s+/g, ' ').slice(0, 90);
      findings.push(
        isDefectShape(lit)
          ? { rule: 'R2', file, detail: `THE defect shape, unstamped: ${flat} — four realities shared this object and no consumer could tell them apart` }
          : { rule: 'R1', file, detail: `LicenseInfo literal without an outcome: ${flat}` },
      );
    }

    // R3
    const hits = src.split(KEY_SHAPE_NEEDLE).length - 1;
    counts.keyShapeHits += hits;
    if (hits > 0 && file !== KEY_SHAPE_HOME) {
      findings.push({ rule: 'R3', file, detail: `key-shape regex literal outside ${KEY_SHAPE_HOME} (${hits}×) — format validation must have ONE source` });
    }

    // R4
    for (const match of bareNullAuthTests(src)) {
      if (exemptFor('R4', file, match)) continue;
      findings.push({ rule: 'R4', file, detail: `bare-null credential test \`${match}\` — null means BOTH "sent nothing" and "sent something unresolvable"; branch on the outcome` });
    }

    // R5
    if (LIVE_TOOL_ENVELOPES.includes(file)) {
      const stamped = (src.match(/_algovault:\s*(?:license\s*\?\s*)?withAuthState\(/g) ?? []).length;
      const constructed = (src.match(/_algovault:\s*(?:withAuthState\(|\{|license\s*\?)/g) ?? []).length;
      counts.envelopeSites += constructed;
      if (constructed !== stamped) {
        findings.push({ rule: 'R5', file, detail: `${constructed - stamped} of ${constructed} _algovault envelope site(s) do not route through withAuthState — a caller there cannot tell whether their key worked` });
      }
    }
  }

  // Vacuity guard, scoped to a corpus that CLAIMS to contain the constant's home. A single-file
  // fixture legitimately has no key-shape literal, and firing here would make every fixture in the
  // self-test report R3 — which is exactly what the first run did.
  if (sources.has(KEY_SHAPE_HOME) && counts.keyShapeHits === 0) {
    findings.push({ rule: 'R3', file: KEY_SHAPE_HOME, detail: 'the key-shape constant is GONE from src/ — R3 would pass vacuously' });
  }
  return { findings, counts };
}

// ── self-test ────────────────────────────────────────────────────────────────
// Fixtures go through the REAL extractors, never a hand-written stand-in: a prior gate in this
// repo passed its own property test because its fixture used a shape the extractor never emits.

export function selfTest() {
  let passed = 0;
  const failed = [];
  const check = (label, actual, expected) => {
    if (actual === expected) { passed += 1; console.log(`  ✓ ${label}: ${actual}`); }
    else { failed.push(label); console.log(`  ✗ ${label}: expected ${expected}, got ${actual}`); }
  };
  const rulesOf = (src, file = 'src/lib/fixture.ts') => {
    try {
      return runRules(new Map([[file, stripTypeBlocks(strip(src))]]), []).findings.map((f) => f.rule).sort().join(',');
    } catch (e) {
      // An assertion that RAISES is not an assertion — report it as a failure, never a crash.
      return `CRASH(${e instanceof Error ? e.message : e})`;
    }
  };

  // MUST FAIL — the synthetic collapse. This is the one that proves teeth.
  check('THE defect shape is rejected', rulesOf("return { tier: 'free', key: null };"), 'R2');
  check('a stamped defect shape is clean', rulesOf("return { tier: 'free', key: null, outcome: 'ABSENT' };"), '');
  check('any unstamped LicenseInfo literal is rejected', rulesOf("const l = { tier: 'pro', key: 'k' };"), 'R1');
  check('a stamped one is clean', rulesOf("const l = { tier: 'pro', key: 'k', outcome: 'RESOLVED' };"), '');
  check('a second key-shape literal is rejected', rulesOf(`const re = /^${KEY_SHAPE_NEEDLE}$/;`), 'R3');
  check('a null test answered OUTCOME-BLIND is rejected', rulesOf('if (!ownerKey) return authRequired(res);'), 'R4');
  check('the same null test routed through the outcome is clean', rulesOf('if (!ownerKey) return refuseOwner(res, license);'), '');
  check('existence inferred from key-presence is rejected', rulesOf('return license.key !== null;'), 'R4');
  check('a TYPE declaration is not a construction', rulesOf('export interface L { tier: LicenseTier; key: string | null; }'), '');
  check('a shorthand `outcome` member counts as stamped', rulesOf('const r = { outcome, tier: t, key: k };'), '');
  check('an envelope TYPE member is not an envelope site', rulesOf('interface R { _algovault: { tool: string; version: string }; }', 'src/tools/scan-trade-calls.ts'), '');
  check('an unstamped envelope site is rejected', rulesOf('_algovault: { tool: "x" },', 'src/tools/scan-trade-calls.ts'), 'R5');
  check('a stamped envelope site is clean', rulesOf('_algovault: withAuthState({ tool: "x" }, license),', 'src/tools/scan-trade-calls.ts'), '');
  check('COMMENTS are stripped, so prose may quote the defect', rulesOf("// return { tier: 'free', key: null };"), '');
  check('a block comment quoting it is also clean', rulesOf("/* return { tier: 'free', key: null }; */"), '');

  // The stripper is the instrument every rule reads through. Over-stripping makes ABSENCE
  // trivially true, so these three pin the exact constructs the naive version destroyed.
  const survives = (label, code) => check(`strip preserves ${label}`, strip(code).includes("key: null, outcome"), true);
  survives('a line with a URL (// inside a string is not a comment)',
    "const a = { tier: 'free', key: null, outcome: 'ABSENT', url: 'https://api.algovault.com/x' };");
  survives('code after a regex literal containing a slash',
    "const re = /a\\/b/; const a = { tier: 'free', key: null, outcome: 'ABSENT' };");
  survives("code after a string containing /*",
    "const s = '/*'; const a = { tier: 'free', key: null, outcome: 'ABSENT' };");
  check('and it still removes a real block comment', strip('/* gone */ kept').trim(), 'kept');

  // Vacuity guard at the CONSTRUCTION site: in --self-test WE build the corpus, so an empty
  // extraction means the test built nothing — a defect in the test, not a clean tree.
  const probe = flatObjectLiterals(strip("const l = { tier: 'pro', key: 'k' };"));
  check('vacuity: the fixture extractor found a literal', probe.length > 0, true);

  // The seam these fixtures replace is the parse of REAL source, so no scenario above executes it.
  const real = corpus();
  if (real.error) { failed.push(`bypassed artifact: ${real.error}`); console.log(`  ✗ bypassed artifact: ${real.error}`); }
  else {
    const r = runRules(real.sources);
    check('bypassed artifact: real src/ parses to a plausible corpus', real.sources.size > 50 && r.counts.licenseLiterals > 3, true);
    check('bypassed artifact: the real key-shape constant is present exactly once', r.counts.keyShapeHits, 1);
    check('bypassed artifact: real envelope sites were found', r.counts.envelopeSites >= 9, true);
  }

  // Every exemption carries a reason — a row without one must never read as a pass.
  check('every declared exemption has a reason', EXEMPTIONS.every((e) => typeof e.reason === 'string' && e.reason.length > 20), true);

  console.log(`SELF-TEST: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${passed} passed, ${failed.length} failed)`);
  return failed.length === 0 ? 0 : 1;
}

// ── main ─────────────────────────────────────────────────────────────────────

const EXIT_FOR = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

function verdictAndExit(verdict, why) {
  if (why) console.error(`   ${why}`);
  console.log(`CREDENTIAL_OUTCOME_VERDICT=${verdict}`);
  process.exit(EXIT_FOR[verdict]);
}

function run() {
  const bad = EXEMPTIONS.find((e) => !e.reason || String(e.reason).trim().length < 20);
  if (bad) verdictAndExit('INDETERMINATE', `exemption ${bad.rule}:${bad.file} has no usable reason — a reason lives on the ROW, never in prose`);

  const c = corpus();
  if (c.error) verdictAndExit('INDETERMINATE', c.error);

  const { findings, counts } = runRules(c.sources);
  console.log(
    `credential-outcome conformance: ${counts.files} tracked src files · ${counts.licenseLiterals} LicenseInfo literal(s) · ` +
    `${counts.envelopeSites} envelope site(s) · ${counts.keyShapeHits} key-shape literal(s) · ${EXEMPTIONS.length} declared exemption(s)`,
  );
  for (const e of EXEMPTIONS) console.log(`  · exempt ${e.rule} ${e.file} — ${e.reason.slice(0, 110)}…`);
  if (findings.length === 0) {
    console.log('  ✓ R1 outcome on every LicenseInfo literal · R2 the defect shape is absent · R3 one key-shape source · R4 no bare-null auth test · R5 every live-tool envelope states its auth');
    verdictAndExit('PASS');
  }
  for (const f of findings) console.error(`  ✗ ${f.rule} ${f.file}: ${f.detail}`);
  verdictAndExit('FAIL', `${findings.length} conformance violation(s)`);
}

/**
 * TEST-IMPORTABLE ENTRYPOINT (CLAUDE.md build-and-runtime: *"make entrypoints test-importable —
 * wrap top-level `main()` in `if (require.main === module)`"*; this is the ESM spelling of that).
 *
 * Without the guard, `import { runRules } from './check-…mjs'` EXECUTES the CLI and calls
 * `process.exit`, which vitest reports as "process.exit unexpectedly called with 0" and takes the
 * whole suite file down before a single test runs — measured, on this file's first import.
 *
 * 🛑 THE IMPORTED PATH EMITS NO VERDICT TOKEN. That is the same law the shell gates state as
 * "sourcing emits no verdict token": a seam that can print a verdict is a bypass on the very
 * instrument every other check reports through.
 *
 * 🛑 COMPARE REAL PATHS, NOT RESOLVED ONES. `resolve(process.argv[1])` does not follow symlinks
 * while `fileURLToPath(import.meta.url)` yields the real path, so on macOS — where `/tmp` is a
 * symlink to `/private/tmp` — invoking a copy under `/tmp` made the two disagree and the guard
 * false. The script then exited **0 having run nothing and printed nothing**: a dark guard at a
 * green exit code, indistinguishable from a healthy one, which is the failure mode this estate has
 * recorded four times. Caught by the throwaway-repo case in
 * `tests/unit/credential-outcome-conformance.test.ts`, which runs the CLI from exactly such a path.
 */
const realOrSelf = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const INVOKED_DIRECTLY = process.argv[1] && realOrSelf(process.argv[1]) === realOrSelf(fileURLToPath(import.meta.url));
if (INVOKED_DIRECTLY) {
  if (process.argv.includes('--self-test')) process.exit(selfTest());
  run();
}

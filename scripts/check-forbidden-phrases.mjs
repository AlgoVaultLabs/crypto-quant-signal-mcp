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
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, relative, resolve, sep } from 'node:path';
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
export function loadPhrases(path = PHRASES) {
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
    // ── SECOND-PASS declaration, validated HERE so a malformed one is INDETERMINATE ──
    // This manifest is a config WE author, so a broken declaration is vacuity and not a fact —
    // the same discipline as the empty-phrase-set branch above. It must never degrade into
    // "the bare-token pass silently checked nothing."
    const e = compiled[compiled.length - 1];
    if (e.bare_token === undefined) {
      if (typeof e.bare_token_na_reason !== 'string' || !e.bare_token_na_reason.trim()) {
        return {
          error: `phrase ${e.id} declares neither bare_token nor a non-empty bare_token_na_reason — `
            + 'an omission is permitted, an UNDECLARED omission is not (see _bare_token_contract)',
        };
      }
      e.tokens = [];
    } else {
      if (!Array.isArray(e.bare_token) || e.bare_token.length === 0
          || e.bare_token.some((t) => typeof t !== 'string' || !t.trim())) {
        return { error: `phrase ${e.id} has a malformed bare_token (want a non-empty array of non-empty strings)` };
      }
      try {
        e.tokens = e.bare_token.map((t) => ({ token: t, re: bareTokenRe(t) }));
      } catch (err) {
        return { error: `phrase ${e.id} has a bare_token that will not compile: ${err.message}` };
      }
    }
    for (const a of e.bare_token_allowlist || []) {
      if (!a || typeof a.path !== 'string' || !a.path.trim()) {
        return { error: `phrase ${e.id} has a bare_token_allowlist row without a path` };
      }
      if (typeof a.reason !== 'string' || !a.reason.trim()) {
        return { error: `phrase ${e.id} allowlists ${a.path} without a reason — an exemption nobody argued for` };
      }
      if (a.token !== undefined && !e.bare_token.includes(a.token)) {
        return { error: `phrase ${e.id} allowlists token ${JSON.stringify(a.token)} for ${a.path}, which it does not declare` };
      }
    }
  }
  return { phrases: compiled };
}

/**
 * Word-bound a bare token for the second pass.
 *
 * NOT `\b…\b`, and the reason is measured rather than stylistic: `\b` before `$79` asserts that the
 * PRECEDING character is a word character, so it fails on `**$79/yr**` — the exact shape a README
 * release recap uses. The guards are derived from the token's own edges instead:
 *
 *   left   `(?<![\w,.])` when the token starts with a word char, so `3,000` does not match inside
 *          `13,000`; else `(?<!\w)`, so `$79` still matches after `*`, `(` or a space.
 *   right  `(?![\w,]|\.\d)` when the token ends with a word char — blocks a longer digit run
 *          (`3,0005`), a thousands continuation (`3,000,000`) and a decimal (`$79.50`), while
 *          still allowing a SENTENCE-ENDING period, which a naive `(?![\w,.])` swallows:
 *          `See algovault.com/pricing.` must remain a hit.
 *
 * Case-insensitive, matching the primary pass — the two passes must never disagree about what an
 * occurrence IS.
 */
export function bareTokenRe(token) {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const left = /^\w/.test(token) ? '(?<![\\w,.])' : '(?<!\\w)';
  const right = /\w$/.test(token) ? '(?![\\w,]|\\.\\d)' : '';
  return new RegExp(left + esc + right, 'i');
}

/**
 * Resolve the corpus from the manifest.
 *
 * Exemptions are matched with the SAME glob engine as the includes, so an exemption pattern and
 * an include pattern cannot disagree about what a `**` means.
 */
export function loadTargets(path = TARGETS, root = ROOT) {
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
export function linesOf(text, filePath = 'x.md') {
  const CODE = /\.(ts|tsx|js|mjs|cjs|json)$/i.test(filePath);
  return (CODE ? stripComments(text, filePath) : text).split('\n');
}

export function scanText(text, phrases, filePath = 'x.md') {
  const out = [];
  const lines = linesOf(text, filePath);
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

/**
 * THE SECOND PASS — enumerate the retired FIGURE, do not pattern-match the phrasing.
 *
 * The primary pass can only ever see the phrasings its author anticipated. That is not a
 * hypothetical: `retired-tier-quotas` was `\b3,000\s+calls|\b15,000\s+calls`, transcribed from
 * brand-facts.md's wording rather than sampled from the estate, and it reported PASS over
 * `a pull call (Free 100 / Starter 3,000 / Pro 15,000 / Enterprise 100,000)` on a doc linked from
 * EVERY webhook payload. Detection is strictly weaker than enumeration.
 *
 * So every occurrence of a declared `bare_token` must be ACCOUNTED FOR as exactly one of:
 *
 *   1. `pattern`          — the primary pass already catches it. Nothing to do.
 *   2. `negative_context` — the primary pass already JUDGED this line and spared it (a release
 *                           recap naming a retired price in order to retire it, an authoring
 *                           runbook teaching "never write X"). Re-firing here would demand the
 *                           deletion of exactly the sentences that record the retirement, and
 *                           duplicating that judgement in an allowlist row would put ONE decision
 *                           in TWO places.
 *   3. allowlist row      — a reasoned, path-scoped exemption whose `reason` is a sentence.
 *
 * Anything else FAILS, naming file, line and token.
 *
 * Runs on the SAME `lines` the primary pass used — comment-stripped for code files, whole for
 * prose. That sharing is load-bearing, not tidiness: measured 2026-09-08, a raw scan for `3,000`
 * returns five DOCBLOCK mentions (nudge-copy.ts ×2, plans.ts, quota-notice.ts, and
 * rate-limit-digest.ts's entirely unrelated "a 3,000-sample gate"). Those sentences are the most
 * valuable lines in their files, the primary pass spares them by design, and a second pass that
 * demanded their deletion would get this gate warn-moded within a week.
 */
export function bareTokenHits(lines, phrases, relPath) {
  const out = [];
  for (const p of phrases) {
    for (const { token, re } of p.tokens || []) {
      const allow = (p.bare_token_allowlist || []).find(
        (a) => a.path === relPath && (a.token === undefined || a.token === token),
      );
      lines.forEach((line, i) => {
        if (!re.test(line)) return;
        p.re.lastIndex = 0;
        if (p.re.test(line)) return out.push({ id: p.id, token, line: i + 1, by: 'pattern' });
        if (p.negative_context && new RegExp(p.negative_context).test(line)) {
          return out.push({ id: p.id, token, line: i + 1, by: 'negative_context' });
        }
        if (allow) return out.push({ id: p.id, token, line: i + 1, by: 'allowlist' });
        out.push({
          id: p.id, token, line: i + 1, by: null, excerpt: line.trim().slice(0, 110),
        });
      });
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
  const bt = { pattern: 0, negative_context: 0, allowlist: 0, unaccounted: [] };
  const tokenCount = ph.phrases.reduce((n, p) => n + (p.tokens || []).length, 0);
  for (const f of tg.files) {
    let text;
    try {
      text = readFileSync(f, 'utf8');
    } catch (e) {
      // Handed to us and unreadable => INDETERMINATE. Empty-vs-unparseable is the line.
      console.error(`✗ cannot read ${relative(ROOT, f)}: ${e.message}`);
      VERDICT('INDETERMINATE', 3);
    }
    const rel = relative(ROOT, f).split(sep).join('/');
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
    // SAME derivation of `lines` as the primary pass — see bareTokenHits().
    for (const h of bareTokenHits(linesOf(text, f), ph.phrases, rel)) {
      if (h.by) { bt[h.by]++; continue; }
      bt.unaccounted.push(h);
      console.error(`✗ ${rel}:${h.line}  [${h.id}] bare token ${JSON.stringify(h.token)} is UNACCOUNTED`);
      console.error(`    ${h.excerpt}`);
      console.error('    → fix the copy, widen the pattern, or add a reasoned bare_token_allowlist row.');
    }
  }

  // Print the corpus size beside every result: a sweep that searched nothing must never look
  // like a clean one. The bare-token line is printed on EVERY run, pass or fail — a second pass
  // you cannot tell ran is indistinguishable from one that silently did nothing, which is the
  // dark-guard class this estate has now recorded five times.
  console.log(
    `scanned ${tg.files.length} files (${ph.phrases.length} patterns, ` +
      `${tg.exemptGlobs.length} exemption globs → ${tg.exemptCount} files excluded, ` +
      `${suppressed} hit(s) suppressed by negative context)`,
  );
  console.log(
    `bare-token pass: ${tokenCount} token(s) enumerated across ` +
      `${ph.phrases.filter((p) => (p.tokens || []).length).length} of ${ph.phrases.length} phrases ` +
      `(${ph.phrases.length - ph.phrases.filter((p) => (p.tokens || []).length).length} declare ` +
      `bare_token_na_reason) → ${bt.pattern} accounted by pattern, ${bt.negative_context} by ` +
      `negative context, ${bt.allowlist} by reasoned allowlist, ${bt.unaccounted.length} unaccounted`,
  );
  if (errors > 0 || bt.unaccounted.length > 0) {
    if (errors > 0) console.error(`✗ ${errors} forbidden phrase(s) on live surfaces.`);
    if (bt.unaccounted.length > 0) {
      console.error(`✗ ${bt.unaccounted.length} unaccounted bare-token occurrence(s) — a retired figure `
        + 'is on a live surface in a shape no pattern anticipated.');
    }
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

// ── R3: fixture provenance — VERIFIED, not claimed ───────────────────────────────────────────

const SAMPLES_PATH = join(ROOT, 'tests', 'fixtures', 'forbidden-phrases', 'estate-samples.json');

/**
 * Read the estate-sampled fixtures. Keys are phrase ids; underscore-prefixed keys are docs and
 * deliberately-unpatterned samples, never phrase entries.
 *
 * Handed to us and unparseable => we could not verify => the caller reports INDETERMINATE. Empty
 * vs unparseable is the line, and this file is one WE author, so a missing sample for an entry
 * that CLAIMS estate provenance is a defect rather than a fact.
 */
export function loadEstateSamples(path = SAMPLES_PATH) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { error: `cannot read ${relative(ROOT, path)}: ${e.message}` };
  }
  const samples = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue;
    if (!v || typeof v.sample !== 'string' || !v.sample) {
      return { error: `estate sample ${k} carries no usable "sample" string` };
    }
    samples[k] = v;
  }
  return { samples };
}

/** True when `sha` resolves to an object in THIS repo. `null` when git itself could not answer. */
export function gitObjectExists(sha, cwd = ROOT) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{object}`], { cwd, stdio: 'ignore' });
    return true;
  } catch (e) {
    // Distinguish "git says no" from "there is no git here". The second is INDETERMINATE: a gate
    // that reports a clean provenance because it could not run git is the fail-open shape this
    // whole contract exists to prevent.
    if (e && (e.code === 'ENOENT' || e.status === undefined)) return null;
    return false;
  }
}

/**
 * Is this checkout SHALLOW — i.e. does it structurally lack history rather than disagree about it?
 *
 * This is not a detail, it is the difference between "the provenance claim is false" and "the
 * evidence is not present here", and getting it wrong BLOCKED A DEPLOY. `actions/checkout@v4`
 * defaults to `fetch-depth: 1`, so CI holds exactly ONE commit; the moment this wave landed, its
 * own `source_sha` became the parent and was simply absent from the runner's object store. Five
 * assertions that pass on any full clone failed there, and they failed as "REAL failures
 * (assertion diffs present)" — the loudest possible way to be wrong about a non-problem.
 *
 * `null` when git could not answer at all.
 */
export function isShallowRepo(cwd = ROOT) {
  try {
    return execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd, encoding: 'utf8' }).trim() === 'true';
  } catch {
    return null;
  }
}

/**
 * Per-entry provenance verdict. Returns { ok, detail }; never throws for a data problem, because
 * an assertion that RAISES aborts the suite instead of reporting FAIL.
 */
export function checkProvenance(entry, dirty, samples) {
  const f = entry.fixture_provenance;
  if (!f || typeof f !== 'object') return { ok: false, detail: 'no fixture_provenance declared' };
  const estate = Boolean(f.source_path || f.source_sha || f.captured_on);
  if (!estate) {
    return typeof f.synthetic_reason === 'string' && f.synthetic_reason.trim().length > 20
      ? { ok: true, detail: 'synthetic, declared' }
      : { ok: false, detail: 'neither an estate form nor a synthetic_reason worth the name' };
  }
  if (!(f.source_path && f.source_sha && f.captured_on)) {
    return { ok: false, detail: 'PARTIAL estate provenance — want source_path + source_sha + captured_on' };
  }
  if (!existsSync(join(ROOT, f.source_path))) {
    return { ok: false, detail: `source_path ${f.source_path} does not resolve in the repo` };
  }
  // ── HISTORY AVAILABLE, OR MERELY ABSENT? ────────────────────────────────────────────────────
  //
  // A blocking verdict must land on someone who can ACT on it. A CI runner on a `fetch-depth: 1`
  // checkout cannot conjure the parent commit, so refusing there is the deadlock, not the guard —
  // the same reasoning that makes an `unpublished` claim in check-claudemd-claims.mjs REPORT
  // rather than block. So: when history is structurally unavailable, this REPORTS and says so in
  // its own words; it never reads as verified, and it is never silent.
  //
  // What still BLOCKS is the case that is definitively somebody's doing: history IS available and
  // the bytes are not there. That is caught on every full clone — every local run, and the
  // pre-push gate that guards the only path by which a change reaches CI at all.
  const shaOk = gitObjectExists(f.source_sha);
  const shallow = isShallowRepo();
  if (shaOk === null) {
    return { ok: true, unverifiable: true, detail: 'git is unavailable here, so the source_sha could not be resolved — REPORTED, not verified' };
  }
  if (!shaOk) {
    if (shallow === true) {
      return {
        ok: true,
        unverifiable: true,
        detail: `source_sha ${String(f.source_sha).slice(0, 8)} is outside this SHALLOW checkout — REPORTED, not verified (full clones enforce it)`,
      };
    }
    return { ok: false, detail: `source_sha ${String(f.source_sha).slice(0, 12)} is not a resolvable git object` };
  }

  const rec = samples[entry.id];
  if (!rec) return { ok: false, detail: `claims estate provenance but tests/fixtures/forbidden-phrases/estate-samples.json has no sample for ${entry.id}` };
  if (rec.source_path !== f.source_path || rec.source_sha !== f.source_sha) {
    return { ok: false, detail: 'the fixture file and the manifest disagree about where the bytes came from' };
  }
  // ONE DERIVATION. An estate row must NOT also be hand-written into SYNTHETIC_DIRTY: two
  // definitions of one fixture is how the bytes drift apart silently.
  if (dirty !== rec.sample) {
    return { ok: false, detail: 'the DIRTY fixture in use is not the recorded sample — something is defining this id twice' };
  }

  // 🛑 THE ASSERTION THAT MAKES THE PROVENANCE REAL, and it must be INDEPENDENT of the fixture.
  //
  // The obvious check — "does the recorded sample equal the DIRTY fixture?" — is VACUOUS here,
  // and this is not a hypothesis: it was written, it passed, and then a deliberate mutation of the
  // recorded sample left the whole suite GREEN. The reason is that DIRTY is DERIVED from the
  // sample, so the comparison was the sample against itself. An assertion whose two sides come
  // from one source can only ever agree.
  //
  // So verify against the one thing the fixture cannot rewrite: git history. The bytes must
  // actually appear at `source_path` as of `source_sha`. That is what "provenance" claims, and it
  // stays true even though CH1 deliberately REMOVED those bytes from the current tree — which is
  // precisely why the check reads the recorded commit and not HEAD.
  let atSha;
  try {
    atSha = execFileSync('git', ['show', `${f.source_sha}:${f.source_path}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    // The commit resolves but the blob at that path does not — on a shallow checkout that is a
    // missing TREE, not a false claim. Same report-vs-block split as above.
    if (shallow === true) {
      return { ok: true, unverifiable: true, detail: `${f.source_path} is not present at ${String(f.source_sha).slice(0, 8)} in this SHALLOW checkout — REPORTED, not verified` };
    }
    return { ok: false, detail: `cannot read ${f.source_path} at ${String(f.source_sha).slice(0, 8)}: ${String(e.message).split('\n')[0].slice(0, 90)}` };
  }
  if (!atSha.includes(rec.sample)) {
    return { ok: false, detail: `the recorded bytes do NOT appear in ${f.source_path} at ${String(f.source_sha).slice(0, 8)} — the provenance claim is false` };
  }
  return { ok: true, detail: `estate-sourced from ${f.source_path} @ ${String(f.source_sha).slice(0, 8)}, bytes found at that commit` };
}

// ── R2.3: the second pass must be PROVEN to catch the CH1 defect ─────────────────────────────

/**
 * Reconstruct the exact pre-CH1 world and assert the bare-token pass FAILS on it.
 *
 * "The new pass would have caught it" is a claim, and a claim is not evidence. So this restores
 * BOTH halves of the defect — the ORIGINAL narrow pattern AND the pre-fix bytes, read from
 * tests/fixtures/forbidden-phrases/estate-samples.json rather than retyped here — and checks that
 * the occurrence comes back UNACCOUNTED. A test that cannot demonstrate this is decoration.
 *
 * It also asserts the CONVERSE on the same bytes: under the WIDENED pattern the occurrence is
 * accounted for. Without that leg the proof would be satisfied by any pattern that matches
 * nothing, which would make it evidence of a broken gate rather than of a working one.
 *
 * Returns { ok, detail }. Never throws for a data problem — an assertion that RAISES aborts the
 * suite instead of reporting FAIL.
 */
const ORIGINAL_NARROW_PATTERN = '\\b3,000\\s+calls|\\b15,000\\s+calls';
const CH1_ID = 'retired-tier-quotas';

export function proveCatchesCh1() {
  const real = loadPhrases();
  if (real.error) return { ok: false, detail: `real phrase SoT does not load: ${real.error}` };
  const live = real.phrases.find((p) => p.id === CH1_ID);
  if (!live) return { ok: false, detail: `no phrase entry ${CH1_ID}` };
  if (!(live.tokens || []).length) return { ok: false, detail: `${CH1_ID} declares no bare_token — nothing to prove` };

  let sample;
  try {
    const fx = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'forbidden-phrases', 'estate-samples.json'), 'utf8'));
    sample = fx[CH1_ID]?.sample;
  } catch (e) {
    // Handed to us and unparseable => we could not verify. Never a silent pass.
    return { ok: false, detail: `cannot read the estate sample fixture: ${e.message}` };
  }
  if (typeof sample !== 'string' || !sample.trim()) {
    return { ok: false, detail: `estate-samples.json carries no usable sample for ${CH1_ID}` };
  }
  // Vacuity guard at the CONSTRUCTION site: we build this corpus, so a sample the tokens cannot
  // even be found in would make both legs below trivially true.
  if (!live.tokens.some(({ re }) => re.test(sample))) {
    return { ok: false, detail: 'the recorded sample contains none of the declared bare tokens — the proof would be vacuous' };
  }

  const withPattern = (pattern) => {
    const entry = { ...live, pattern, re: new RegExp(pattern, 'gi') };
    return bareTokenHits([sample], [entry], 'docs/WEBHOOKS.md');
  };

  const before = withPattern(ORIGINAL_NARROW_PATTERN).filter((h) => !h.by);
  const after = withPattern(live.pattern).filter((h) => !h.by);
  if (before.length === 0) {
    return { ok: false, detail: 'the ORIGINAL narrow pattern + the pre-fix bytes did NOT produce an unaccounted occurrence — the pass cannot demonstrate it catches CH1' };
  }
  if (after.length !== 0) {
    return { ok: false, detail: `the WIDENED pattern leaves ${after.length} occurrence(s) unaccounted — the proof above would be satisfied by a gate that simply matches nothing` };
  }
  return {
    ok: true,
    detail: `narrow pattern ⇒ ${before.length} UNACCOUNTED (${before.map((h) => JSON.stringify(h.token)).join(', ')}) ⇒ FAIL; widened pattern ⇒ 0 unaccounted ⇒ PASS`,
  };
}

// ── self-test ────────────────────────────────────────────────────────────────────────────────

function selfTest() {
  let passed = 0;
  let failed = 0;
  const check = (name, fn, extra = '') => {
    let ok = false;
    let detail = extra ? ` (${extra})` : '';
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
  // to exactly what its own seam replaces, and hand-rolled fixtures are how that blindness gets in.
  //
  // WHERE EACH STRING COMES FROM IS NOW ENFORCED, NOT ASSERTED IN PROSE. This comment used to
  // state, as a blanket fact, that every fixture below had been drawn from the retired-phrase
  // census of the live estate. That was FALSE for retired-tier-quotas — its fixture was authored
  // FROM the regex, so the pattern and the proof of the pattern had one author and one blind
  // spot, and the gate reported PASS over a live falsehood on a doc linked from every webhook
  // payload. A rule that has once failed as prose must become a gate or be deleted, so the claim
  // is now `fixture_provenance` in ops/forbidden-phrases.json and check (0) below verifies it per
  // entry: synthetic rows must declare WHY, and an estate row must resolve its path, resolve its
  // SHA, and have its recorded bytes actually present in that file at that commit.
  //
  // (The old sentence's exact wording is deliberately NOT quoted here: it is itself a banned
  // literal in this repo's own drift checks, and a ban line that matches its own literal is a
  // false positive this estate has already paid for once.)
  //
  // An ESTATE-sourced fixture is therefore NOT written here — it is read from
  // tests/fixtures/forbidden-phrases/estate-samples.json, so the bytes exist in exactly one place.
  const SYNTHETIC_DIRTY = {
    'free-quota-100-per-month': 'The free tier gives you 100 calls/month across every asset.',
    'free-quota-100-mo-shorthand': 'counts as one call against your 100/mo free quota; a market scan',
    'free-quota-after-100': 'After 100, pay per call via x402 (USDC on Base) — no signup.',
    'free-quota-20-per-day': 'Free tier: 20 calls/day, no card needed.',
    'month-only-enforcement': 'Every tier has no daily cap, so burst as hard as you like.',
    'legacy-asset-gate': 'The free tier covers BTC and ETH only.',
    'retired-annual-pricing': 'Starter is $79/yr — Save 34% versus monthly.',
    'weakened-positioning': 'AlgoVault is the Quant Layer for crypto.',
    'nonexistent-pricing-page': 'See algovault.com/pricing for the full ladder.',
  };
  const samples = loadEstateSamples();
  const DIRTY = { ...SYNTHETIC_DIRTY };
  if (!samples.error) {
    for (const [id, s] of Object.entries(samples.samples)) DIRTY[id] = s.sample;
  }
  const CLEAN = [
    '200 calls/month, up to 100 per UTC day.',
    'Upgrade to Starter ($9.99/mo or $39.90/6mo → 10,000 API calls/mo).',
    'The Brain Layer for AI Trading Agents',
    'Pro gives 100,000 calls a month.',
    'See https://api.algovault.com/signup for the ladder.',
    'You get 200 free alerts a month, up to 100 a day.',
  ];

  console.log('SELF-TEST — forbidden-phrase gate');

  // (0) PROVENANCE. Every entry must declare where its DIRTY fixture came from, and an estate
  // claim must be VERIFIABLE: path resolves, SHA resolves as a git object, and the fixture equals
  // the recorded bytes. This replaces the comment that used to assert all of it.
  check('the estate-sample fixture file loads', () => !samples.error, samples.error);
  let unverifiable = 0;
  for (const p of ph.phrases) {
    const v = checkProvenance(p, DIRTY[p.id], samples.samples || {});
    if (v.unverifiable) unverifiable++;
    check(`provenance ${p.id} — ${v.detail}`, () => v.ok);
  }
  // A REPORTED-not-verified leg must never be silent: print the count positively so a reader can
  // never mistake "we could not look" for "we looked and it was clean".
  if (unverifiable > 0) {
    console.log(`  ⚠ ${unverifiable} provenance claim(s) REPORTED rather than verified — history is not `
      + 'present in this checkout (shallow clone). Full clones, including the pre-push gate, enforce them.');
  } else {
    console.log(`  ⓘ all ${ph.phrases.length} provenance claims verified against real git history.`);
  }

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

  // (7) BARE-TOKEN PASS — the second pass, asserted rather than assumed.
  //
  // Its three accounting categories are exercised here and NOT left to the live corpus, because
  // the corpus only exercises what it happens to contain: measured 2026-09-08, `negative_context`
  // accounting has ZERO live instances (README's annual recap aged out of the What's-new window),
  // so a suite that leaned on the real tree would ship that branch untested and call it covered.
  const btEntry = {
    id: 'fixture', pattern: '\\b3,000\\s+calls', re: /\b3,000\s+calls/gi,
    negative_context: '[Ss]uperseded', tokens: [{ token: '3,000', re: bareTokenRe('3,000') }],
    bare_token_allowlist: [{ path: 'landing/ok.txt', token: '3,000', reason: 'a sentence' }],
  };
  const by = (lines, path) => bareTokenHits(lines, [btEntry], path).map((h) => h.by);
  check('bare token accounted by PATTERN when the primary pass already catches the line', () =>
    by(['Starter includes 3,000 calls a month.'], 'docs/x.md').join() === 'pattern');
  check('bare token accounted by NEGATIVE CONTEXT — one decision, not two', () =>
    by(['Superseded: the 3,000 rung retired 2026-08-09.'], 'docs/x.md').join() === 'negative_context');
  check('bare token accounted by a reasoned ALLOWLIST row, scoped to its path', () =>
    by(['gates >=85% and >=3,000).'], 'landing/ok.txt').join() === 'allowlist');
  check('the SAME line UNACCOUNTED on a path the allowlist does not name', () =>
    by(['gates >=85% and >=3,000).'], 'landing/other.txt').join() === '');
  check('word boundaries: 3,000 is not found inside 13,000, 3,000,000 or 3,0005', () =>
    by(['Starter 13,000 calls', 'was 3,000,000 rows', 'n=3,0005'], 'docs/x.md').length === 0);
  check('a token whose left edge is non-word ($79) is still found after ** or (', () =>
    bareTokenHits(['Starter was **$79/yr** then'], [{
      id: 'f2', pattern: 'ZZZ_NEVER', re: /ZZZ_NEVER/gi,
      tokens: [{ token: '$79', re: bareTokenRe('$79') }],
    }], 'README.md').length === 1);
  check('a trailing sentence period does not hide a token (algovault.com/pricing.)', () =>
    bareTokenHits(['See algovault.com/pricing.'], [{
      id: 'f3', pattern: 'ZZZ_NEVER', re: /ZZZ_NEVER/gi,
      tokens: [{ token: 'algovault.com/pricing', re: bareTokenRe('algovault.com/pricing') }],
    }], 'docs/x.md').length === 1);

  // Manifest declarations are a CONFIG WE AUTHOR, so each malformed shape must be INDETERMINATE
  // at load time, never a silent pass. Fixtures are written through the REAL loader.
  const tmp2 = mkdtempSync(join(tmpdir(), 'fpg-bt-'));
  try {
    const withEntry = (extra) => {
      const f = join(tmp2, `${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(f, JSON.stringify({ phrases: [{ id: 'x', pattern: 'zz', ...extra }] }));
      return loadPhrases(f);
    };
    check('an entry with neither bare_token nor bare_token_na_reason is REFUSED', () =>
      Boolean(withEntry({}).error));
    check('an entry with an empty bare_token_na_reason is REFUSED', () =>
      Boolean(withEntry({ bare_token_na_reason: '   ' }).error));
    check('a declared bare_token_na_reason is accepted', () =>
      !withEntry({ bare_token_na_reason: 'no narrower form exists' }).error);
    check('a malformed bare_token (empty array) is REFUSED', () =>
      Boolean(withEntry({ bare_token: [] }).error));
    check('an allowlist row without a reason is REFUSED', () =>
      Boolean(withEntry({ bare_token: ['q'], bare_token_allowlist: [{ path: 'a.md' }] }).error));
    check('an allowlist row naming a token the entry does not declare is REFUSED', () =>
      Boolean(withEntry({ bare_token: ['q'], bare_token_allowlist: [{ path: 'a.md', token: 'zz', reason: 's' }] }).error));
  } finally {
    rmSync(tmp2, { recursive: true, force: true });
  }

  // (8) THE CH1 REGRESSION PROOF (R2.3). Not "it would have caught it" — restore the narrow
  // pattern and the pre-fix bytes and watch it fail.
  const proof = proveCatchesCh1();
  check(`the bare-token pass DEMONSTRABLY catches the CH1 defect — ${proof.detail}`, () => proof.ok);

  console.log(`SELF-TEST: ${failed === 0 ? 'PASS' : 'FAIL'} (${passed} passed, ${failed} failed)`);
  if (failed > 0) VERDICT('FAIL', 1);
  VERDICT('PASS', 0);
}

// Test-importable (CLAUDE.md): a suite must be able to exercise these functions without the
// module executing the whole gate and calling process.exit() on import. Same guard, and the same
// hard-won lesson, as scripts/check-mcp-client-copy.mjs — this is not an injection point and
// there is no lever here that could make a run report PASS.
const INVOKED_DIRECTLY =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

const argv = process.argv.slice(2);
if (!INVOKED_DIRECTLY) {
  // Imported — expose the functions above and stop here.
} else if (argv.includes('--print-targets')) printTargets();
else if (argv.includes('--prove-catches-ch1')) {
  // A standalone verdict for the R2.3 proof, so a chapter gate can assert it without reading
  // 40 self-test lines. Same token contract: the proof either holds or the gate could not verify.
  const r = proveCatchesCh1();
  console.log(`bare-token CH1 regression proof: ${r.ok ? 'HOLDS' : 'BROKEN'} — ${r.detail}`);
  VERDICT(r.ok ? 'PASS' : 'INDETERMINATE', r.ok ? 0 : 3);
} else if (argv.includes('--self-test')) selfTest();
else run();

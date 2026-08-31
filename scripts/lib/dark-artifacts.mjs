#!/usr/bin/env node
// scripts/lib/dark-artifacts.mjs — the ONE derivation of "is this artifact dark?".
//
// OPS-DARK-ARTIFACT-GATE-PROMOTE-W1 R1.5/R2.
//
// ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────────────────────
// `check-new-dark-exports.mjs` shipped its detection inline. R1.5 measured that detection
// against the TypeScript compiler's own scanner over 1,847 export declarations at d26898cf and
// found 33 FALSE POSITIVES and 5 false negatives. Both denominators, because they read very
// differently and only one of them is the number a pusher experiences: 33/293 = 11.3% of all
// flagged symbols, but 33/205 = 16.1% of the UNEXEMPT flagged — the ones that actually reach a
// human as "wire it, delete it, or allowlist it". A blocking gate at that rate gets bypassed,
// and a bypassed gate is permanently degraded, so promotion was blocked on repair.
//
// Both error directions came from counting references in REGEX-STRIPPED text:
//
//   FP (33/33, one shared cause) — the strip ran block comments FIRST:
//       s.replace(/\/\*[\s\S]*?\*\//g,' ').replace(/^\s*\/\/.*$/gm,' ')
//     so a `/*` sequence inside a LINE comment opened a block that ran to the next `*/`.
//     `src/index.ts:1501` is `// … Caddy routes /integrations/* AND /docs/integrations/*`,
//     which swallowed 836 lines (L1501-L2337) including `insertLead: store.insertContactLead`
//     at L1889 and `resolvePaymentRails(defaultRailTopologyConfig(...))` at L2865. Measured:
//     3,050 lines of src/index.ts blanked across 295 runs, 1,021 of them code. Reordering the
//     two passes takes FP 33 -> 0, which is what PROVES the single cause.
//
//   FN (5) — a strip removes comments but NOT string contents, so a symbol's own name inside
//     its own error message counted as a consumer:
//       `computeLabel: no vertical window for timeframe '${timeframe}'`
//       `[forum-post-failures] markRecovered(${platform}, ${postId}) error:`
//     No ordering fix reaches this; only a tokenizer does.
//
// So the core counts IDENTIFIER TOKENS from `ts.createSourceFile`, where comments and string
// bodies are not identifiers by construction. Measured after: FP=0, FN=0.
//
// ── DEGRADED MODE, AND WHY IT IS SAFE ───────────────────────────────────────────────────────
// A cold worktree may have no node_modules, so `typescript` may be absent. Rather than refuse,
// the core falls back to the ORDER-CORRECTED regex and REPORTS which instrument it used. That
// direction is deliberate: the corrected regex measures FP=0 / FN=5, so it can only MISS a dark
// export, never manufacture one. A blocking gate must degrade toward not-blocking; degrading
// toward a wrong refusal is how a guard gets disabled. Callers that need the strong instrument
// assert `instrument === 'typescript'` — the vitest surface does exactly that.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

/** Declaration kinds the gate has always covered. `export type`/`interface` have no call site. */
export const DECL_RE = /^export\s+(?:async\s+)?(function|const|let|var|class|enum)\s+([A-Za-z_$][\w$]*)/gm;

/**
 * Line comments FIRST. The reverse order is the measured 33-false-positive defect above; it is
 * kept here as a named export purely so the self-test can prove the ordering still matters.
 */
export const stripOrderCorrected = (s) =>
  s.replace(/^\s*\/\/.*$/gm, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
export const stripLegacyBuggy = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

export function walk(root, dir, pred, acc = []) {
  if (!existsSync(join(root, dir))) return acc;
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (!['node_modules', '.git', 'dist', 'coverage'].includes(e.name)) walk(root, rel, pred, acc);
    } else if (pred(e.name)) acc.push(rel);
  }
  return acc;
}

export const srcFiles = (root) => walk(root, 'src', (n) => n.endsWith('.ts') && !n.endsWith('.d.ts'));

/**
 * Resolve `typescript` from THIS MODULE, never from the tree being scanned.
 *
 * It was resolved from `root` at first, which is wrong twice over: the analysed tree is DATA, and
 * the analyser's dependency belongs to the analyser. The bug was not theoretical — it surfaced
 * immediately, because the R3 fixture roots are temp directories with no node_modules, so every
 * fixture-based proof silently ran the DEGRADED regex instead of the instrument it claimed to be
 * testing. That is the "a hermetic self-test is blind to the seam it replaces" law arriving one
 * level up: the tests were green, and they were exercising the wrong path.
 *
 * `forceDegraded` exists so the fallback can be tested DELIBERATELY rather than reached by
 * accident. It never appears on a real run.
 */
function loadTypescript(forceDegraded = false) {
  if (forceDegraded) return null;
  try {
    return createRequire(import.meta.url)('typescript');
  } catch {
    return null;
  }
}

/**
 * Identifier-occurrence counts across src/, INCLUDING the declaring file — counting only OTHER
 * files would flag every internal helper. Returns the instrument used so a caller can refuse a
 * degraded run rather than silently trusting it.
 */
export function referenceCounts(root, files = srcFiles(root), { forceDegraded = false } = {}) {
  const ts = loadTypescript(forceDegraded);
  const counts = new Map();
  if (ts) {
    for (const f of files) {
      const sf = ts.createSourceFile(f, readFileSync(join(root, f), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const visit = (n) => {
        if (ts.isIdentifier(n)) counts.set(n.text, (counts.get(n.text) || 0) + 1);
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    return { counts, instrument: 'typescript' };
  }
  const texts = files.map((f) => stripOrderCorrected(readFileSync(join(root, f), 'utf8')));
  for (const t of texts) {
    for (const m of t.matchAll(/[A-Za-z_$][\w$]*/g)) counts.set(m[0], (counts.get(m[0]) || 0) + 1);
  }
  return { counts, instrument: 'regex-order-corrected' };
}

/** Exported declarations on the working tree, by the regex the gate has always used. */
export function exportedDeclarations(root, files = srcFiles(root)) {
  const out = [];
  for (const f of files) {
    for (const m of readFileSync(join(root, f), 'utf8').matchAll(DECL_RE)) {
      out.push({ symbol: m[2], kind: m[1], file: f });
    }
  }
  return out;
}

/**
 * Declarations present on HEAD and absent at `base`. `null` = the base tree is unreadable.
 *
 * ONE `git grep` over the base ref, not `ls-tree` + a `git show` per file. The per-file loop was
 * ~328 subprocesses on this tree and took >5s, which timed out the vitest surface; it also had a
 * per-file `maxBuffer` to babysit and swallowed a failed `git show` as "this file declared
 * nothing", which silently turns a read error into a NEW symbol — a false positive on the one
 * path that must not have them. `git grep` walks the tree once, in git.
 */
export function newDeclarations(root, base) {
  const head = exportedDeclarations(root);
  let out;
  try {
    // Pathspec is `src`, NOT a glob. `src/**/*.ts` was tried and is WRONG here: it matched 309
    // files where plain `src` matches 313, silently dropping the four directly under src/ —
    // including src/index.ts and src/tool-descriptions.ts. Every symbol declared there then read
    // as absent-at-base, i.e. NEW, and the gate reported createSandboxService, TOP_20_KEYWORDS
    // and resolveSessionCorrelationId as new dark exports on a branch that never touched them.
    // That is the exact false-positive class R1.5 exists to have removed. `.d.ts` is excluded
    // from the PARSED OUTPUT below rather than by a pathspec, so no glob semantics are load-bearing.
    out = execFileSync('git', [
      'grep', '-E',
      '^export[[:space:]]+(async[[:space:]]+)?(function|const|let|var|class|enum)[[:space:]]+[A-Za-z_$]',
      base, '--', 'src',
    ], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    // git grep exits 1 for "no matches", which is a FACT about an empty base tree, not a failure.
    // Any other status means we could not read the tree we were handed => INDETERMINATE.
    if (e && e.status === 1 && !e.stderr?.length) out = '';
    else return null;
  }
  const baseSyms = new Set();
  for (const line of out.split('\n')) {
    // `<rev>:<path>:<content>` — neither a rev nor a repo path contains a colon.
    const m = /^[^:]*:([^:]*):(.*)$/.exec(line);
    if (!m || !m[1].endsWith('.ts') || m[1].endsWith('.d.ts')) continue;
    const d = new RegExp(DECL_RE.source).exec(m[2]);
    if (d) baseSyms.add(d[2]);
  }
  return head.filter((d) => !baseSyms.has(d.symbol));
}

/**
 * Files the base-tree read actually saw. Exported so a test can pin the pathspec bug above
 * rather than trusting a comment about it.
 */
export function baseTreeSrcFiles(root, base) {
  try {
    return execFileSync('git', ['ls-tree', '-r', '--name-only', base, 'src'], { cwd: root, encoding: 'utf8' })
      .split('\n').filter((x) => x.endsWith('.ts') && !x.endsWith('.d.ts'));
  } catch { return null; }
}

export function isExempt(symbol, cfg) {
  for (const e of cfg.name_exemptions || []) if (new RegExp(e.pattern).test(symbol)) return e;
  for (const e of cfg.symbol_exemptions || []) if (e.symbol === symbol) return e;
  return null;
}

/** SHAPE A — new exported declarations with no consumer in src/. */
export function findDarkExports(root, base, cfg) {
  const added = newDeclarations(root, base);
  if (added === null) return null;
  const { counts, instrument } = referenceCounts(root);
  const dark = [], explained = [];
  for (const a of added) {
    if ((counts.get(a.symbol) || 0) > 1) continue;
    const ex = isExempt(a.symbol, cfg);
    (ex ? explained : dark).push({ ...a, reason: ex?.reason });
  }
  return { added, dark, explained, instrument };
}

// ── SHAPE B — env flags with no reader ──────────────────────────────────────────────────────
//
// The four false-positive classes below were each MEASURED on this repo at d26898cf, when the
// live corpus of genuine unread flags was ZERO. They are excluded here, while they are cheap to
// characterise, rather than rediscovered by whoever the guard first cries wolf at.
export const FLAG_RE = /\b(ALGOVAULT_[A-Z0-9_]+|ENABLE_[A-Z0-9_]+|[A-Z][A-Z0-9_]*_ENABLED)\b/g;

/** Repos whose sources are not in this checkout, so a flag they read is not unread. */
export const CROSS_REPO_PREFIXES = ['ALGOVAULT_BOT_'];

export function findUnreadFlags(root) {
  const readerFiles = [
    ...srcFiles(root),
    ...walk(root, 'scripts', (n) => /\.(mjs|cjs|js|ts|sh|py)$/.test(n)),
    ...walk(root, 'ops', (n) => /\.(mjs|cjs|js|ts|sh|py)$/.test(n)),
    ...walk(root, 'tests', (n) => /\.(ts|mjs|cjs|js)$/.test(n)),
  ];
  const readers = new Set();
  const computedPrefixes = new Set();
  const markerNames = new Set();
  for (const f of readerFiles) {
    const t = readFileSync(join(root, f), 'utf8');
    for (const m of t.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) readers.add(m[1]);
    for (const m of t.matchAll(/process\.env\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g)) readers.add(m[1]);
    // FP class 1 — the house `function f(env: NodeJS.ProcessEnv = process.env)` seam.
    for (const m of t.matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})\b/g)) readers.add(m[1]);
    for (const m of t.matchAll(/\benv\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g)) readers.add(m[1]);
    for (const m of t.matchAll(/os\.environ(?:\.get)?[[(]\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g)) readers.add(m[1]);
    for (const m of t.matchAll(/getenv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g)) readers.add(m[1]);
    for (const m of t.matchAll(/\$\{?([A-Z][A-Z0-9_]{2,})[}:\s"']/g)) readers.add(m[1]);
    // FP class 1 (cont.) — a COMPUTED key: process.env[`ENABLE_PERTF_${tf}`] reads a whole family
    // no literal scan can see. Measured on src/lib/pertf-thresholds.ts:99.
    for (const m of t.matchAll(/process\.env\[\s*`([A-Z][A-Z0-9_]*_)\$\{/g)) computedPrefixes.add(m[1]);
    // FP class 2 — a version MARKER literal that is grep-read, not an env var. Measured on
    // check_test_baseline.sh:124 (`ALGOVAULT_TEST_GATE_CONTRACT=1`) read by
    // install_gate_staleness_hook.sh:85 via `grep -aoE '^ALGOVAULT_TEST_GATE_CONTRACT=[0-9]+'`.
    for (const m of t.matchAll(/^\s*([A-Z][A-Z0-9_]{2,})=[^\s]*$/gm)) markerNames.add(m[1]);
    for (const m of t.matchAll(/grep[^\n]*?\^?([A-Z][A-Z0-9_]{2,})=/g)) markerNames.add(m[1]);
  }

  const mentionFiles = [
    ...walk(root, '.github', (n) => /\.ya?ml$/.test(n)),
    ...walk(root, 'ops', (n) => /\.(json|ya?ml|env)$/.test(n)),
    ...walk(root, 'docs', (n) => /\.md$/.test(n)),
    ...walk(root, 'landing', (n) => /\.html$/.test(n)),
    ...['Dockerfile', 'docker-compose.yml', '.env.example', 'README.md'].filter((f) => existsSync(join(root, f))),
  ];
  const mentions = new Map();
  for (const f of mentionFiles) {
    for (const m of readFileSync(join(root, f), 'utf8').matchAll(FLAG_RE)) {
      // a composed-name FRAGMENT (`ENABLE_PERTF_` from `ENABLE_PERTF_${TF}`) is not a flag
      if (m[1].endsWith('_')) continue;
      if (!mentions.has(m[1])) mentions.set(m[1], new Set());
      mentions.get(m[1]).add(f);
    }
  }

  const unread = [];
  for (const [flag, whereSet] of mentions) {
    if (readers.has(flag)) continue;
    if (markerNames.has(flag)) continue;
    if ([...computedPrefixes].some((p) => flag.startsWith(p))) continue;
    if (CROSS_REPO_PREFIXES.some((p) => flag.startsWith(p))) continue;                 // FP class 4
    const where = [...whereSet];
    // FP class 3 — a var only ever shown in a docs/landing snippet is one the CUSTOMER sets.
    if (where.every((f) => f.startsWith('docs/') || f.startsWith('landing/'))) continue;
    unread.push({ flag, mentionedIn: where });
  }
  return unread.sort((a, b) => a.flag.localeCompare(b.flag));
}

// ── SHAPE D — DROPPED, and the measurement that dropped it ──────────────────────────────────
//
// "Source comments citing a nonexistent file path" was specced as a fourth shape and as "cheap
// to check". Measured at d26898cf it is not. A naive predicate returns 113 hits for 5 real ones
// (4.4%). Three regex corrections — anchoring the path so `node dist/scripts/x.js` cannot match
// as `scripts/x.js`; capturing the FULL trailing extension so `(js|json)` cannot match `js`
// inside `.json`; and excluding citations the prose marks historical or attributes to another
// repo — take it to 14 hits for the same 5, i.e. **35.7% precision**. The ship threshold set by
// the architect was >=90%, so the shape is DROPPED and the 5 real citations were fixed by hand
// in this wave instead.
//
// The residual noise is not a tuning problem. Six of the nine remaining false positives are a
// gate's own docstring EXPLAINING its predicate with an example path (`scripts/x.mjs`,
// `scripts/check-thing.mjs`) or arguing why a file deliberately does NOT exist
// (install_gate_staleness_hook.sh:11). A detector for this shape trips on the prose that
// documents detectors — including, when it was still present here, on this very comment block.
// Nothing generic distinguishes an illustrative path from an asserted one.
//
// The detection function is deliberately NOT left in the tree behind a disabled flag: an
// exported symbol no path calls is precisely the artifact class this module exists to catch,
// and shipping one here would be the wave committing its own defect. The measurement lives in
// audits/OPS-DARK-ARTIFACT-GATE-PROMOTE-W1-R0-R1-2026-08-31.md; re-derive from it if the shape
// is ever reopened.

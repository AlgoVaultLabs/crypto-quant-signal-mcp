#!/usr/bin/env node
// @ts-check
/**
 * check-alert-copy-claims.mjs — an alert body may not claim a continuous assertion that nothing
 * schedules.
 *
 * OPS-HOST-KERNEL-REBOOT-W3 / CH3.
 *
 * ── THE INCIDENT, AND WHY A GATE RATHER THAN A CORRECTION ────────────────────────────────────
 * `kernel-staleness-canary.sh`'s alert body told the operator, on every page:
 *
 *     "boot survival is asserted continuously by scripts/check-boot-readiness.mjs"
 *
 * That gate is BUILD-TIME. It proves the contract in scripts/data/boot-critical-units.json is
 * internally coherent and — its own header says so — never that a host matches it. Measured
 * 2026-08-15 and again 2026-08-27: no cron or timer ran it on either host, and it was not present
 * on aoe-1 at all. OPS-HOST-KERNEL-REBOOT-W2 noticed, corrected the script's HEADER, and left the
 * ALERT BODY — the one surface an operator actually reads — still asserting it.
 *
 * The lane fix is to edit the sentence. CH1 did make it true (ops/monitoring/boot-contract-canary.sh
 * is now scheduled on both hosts) and CH3 does rewrite the sentence. This file is the generator
 * fix: the class is "a guard's copy claims a continuous assertion that nothing schedules", and
 * prose addressed to whoever happens to read it is not a control.
 *
 * ── WHAT IT ASSERTS ─────────────────────────────────────────────────────────────────────────
 * For every ops/monitoring artifact that fires through send_telegram.sh, in the OPERATOR-FACING
 * text only (never in comments or docstrings — documentation describing a sibling guard is not a
 * claim), every cited repo path is classified against reality:
 *
 *   SCHEDULED   an ops/monitoring/monitoring-inventory.json row with an installed_at[] entry
 *               carrying a `schedule` — i.e. something actually runs it, on a host, on a clock.
 *   BUILD_TIME  wired as a gate per check-canaries-wired.mjs — package.json, a workflow, or a
 *               test. That script is the ONE authority on 'wired'; an earlier draft read only
 *               package.json and mis-classified check-boot-readiness.mjs (0 package.json hits,
 *               invoked by .github/workflows/deploy.yml) as UNKNOWN.
 *   UNKNOWN     neither.
 *
 * A CONTINUITY VERB ("continuously", "hourly", "scheduled", …) in the SAME SENTENCE as a citation
 * whose reality is not SCHEDULED is a DRIFT. The verb list is deliberately narrow: it is the
 * vocabulary that promises a CADENCE, not any mention of another file.
 *
 * ATTRIBUTION IS PER SENTENCE, and that is load-bearing rather than stylistic. A character-window
 * version flagged this wave's own CORRECTED copy — which says "asserted continuously by
 * <the scheduled canary>" and then, separately, "<the build-time gate> is the BUILD-TIME gate" —
 * because both citations sat inside one window. It also dragged an unrelated "hourly" onto a bare
 * pointer in client-claim-freshness.py. Two false positives on a two-item corpus.
 *
 * ── WHY THE COMMENT STRIPPER IS OURS AND NOT THE SHARED ONE ─────────────────────────────────
 * check-alert-recommended-wave.mjs exports `stripComments`, and check-declaration-coverage.mjs
 * reuses it — but it handles `.sh`/`.ya?ml` (#) and `.mjs`/`.js`/`.cjs`/`.ts` (// and block), and
 * PYTHON FALLS THROUGH UNCHANGED. 23 of the 32 alert-emitting artifacts here are `.py`, and their
 * module docstrings legitimately describe other guards in exactly the vocabulary this gate hunts
 * for. Reusing it verbatim would have manufactured a false DRIFT on almost every Python canary.
 * So `operatorFacingBlocks()` below extracts the text that can REACH an operator rather than
 * subtracting the text that cannot — a smaller, checkable claim.
 *
 * ── HONEST SCOPE ────────────────────────────────────────────────────────────────────────────
 * Body extraction is per-language and approximate: shell heredocs, JS/TS template literals, and
 * Python triple-quoted strings that are NOT a module/def/class docstring. An artifact from which
 * no block could be extracted is REPORTED per-artifact, never silently skipped — a check that
 * scanned nothing must not read like one that scanned and found nothing. The corpus size is
 * printed beside every result for the same reason.
 *
 * Verdict: exactly one terminal ALERT_COPY_VERDICT=OK|DRIFT|INDETERMINATE.
 * Exit 0=OK / 1=DRIFT / 3=INDETERMINATE (3 is the token-law default for a NEW gate).
 * Callers gate on the TOKEN, never the code. The exit code is load-bearing in prepublishOnly,
 * which is an `&&` chain, so both 1 and 3 correctly break it.
 *
 * Usage:
 *   node scripts/check-alert-copy-claims.mjs
 *   node scripts/check-alert-copy-claims.mjs --self-test
 */
import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The ONE authority on whether a gate is wired. Re-deriving it here would drift from the script
// that already polices exactly that question.
import * as wired from './check-canaries-wired.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

export const ARTIFACT_DIR = 'ops/monitoring';
export const INVENTORY_REL = 'ops/monitoring/monitoring-inventory.json';
export const BASELINE_REL = 'audits/alert-copy-baseline.json';
/** The wrapper every alert-emitting artifact calls. Membership of the corpus is defined by it. */
export const WRAPPER = 'send_telegram';

/**
 * Vocabulary that PROMISES A CADENCE. Narrow on purpose: "see scripts/x.mjs" is a pointer and
 * must not trip; "asserted continuously by scripts/x.mjs" is a claim about how often it runs.
 */
export const CONTINUITY_VERBS = [
  'continuously', 'continually', 'continuous',
  'every run', 'every cycle', 'on every',
  'hourly', 'daily', 'nightly', 'weekly',
  'on a schedule', 'scheduled', 'runs on', 'checked on',
  'always asserts', 'asserts continuously', 'monitored',
];

const PATH_RE = /\b(?:scripts|ops)\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts|sh|py|json)\b/g;

/** Every alert-emitting artifact: an ops/monitoring executable that invokes the wrapper. */
export function corpus(root) {
  const dir = path.join(root, ARTIFACT_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /\.(sh|py|mjs|cjs|js)$/.test(n))
    .filter((n) => n !== 'send_telegram.sh') // the wrapper itself is not a caller
    .map((n) => ({ name: n, rel: `${ARTIFACT_DIR}/${n}`, abs: path.join(dir, n) }))
    .filter((f) => {
      try { return readFileSync(f.abs, 'utf8').includes(WRAPPER); } catch { return false; }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Text that can REACH AN OPERATOR. Extracted positively rather than by subtracting comments, so a
 * language whose comment syntax we do not model cannot leak documentation into the corpus.
 */
export function operatorFacingBlocks(text, file) {
  const out = [];
  if (/\.sh$/.test(file)) {
    // Heredocs: <<EOF / <<'EOF' / <<-EOF, terminated by the marker alone on a line.
    const re = /<<-?\s*'?([A-Za-z_][A-Za-z0-9_]*)'?\s*\n([\s\S]*?)\n\s*\1\b/g;
    let m; while ((m = re.exec(text))) out.push(m[2]);
  } else if (/\.(mjs|cjs|js|ts)$/.test(file)) {
    // Template literals. Block comments are removed first so a `\`` inside prose cannot open one.
    const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, '');
    const re = /`([\s\S]*?)`/g;
    let m; while ((m = re.exec(noBlock))) out.push(m[1]);
  } else if (/\.py$/.test(file)) {
    // Triple-quoted strings that are NOT a docstring. A docstring is the first token of the module
    // or immediately follows a def/class header; anything else is a value the code can send.
    const re = /("""|''')([\s\S]*?)\1/g;
    let m;
    while ((m = re.exec(text))) {
      const before = text.slice(0, m.index);
      const prevLine = (before.split('\n').slice(-2)[0] || '').trim();
      const isModuleDoc = before.trim().length === 0;
      const isDefDoc = /^(def|class)\b.*:\s*$/.test(prevLine) || /^\s*(def|class)\b/.test(prevLine);
      if (!isModuleDoc && !isDefDoc) out.push(m[2]);
    }
    // Python alert bodies are frequently ordinary quoted strings assembled with f-strings, so
    // single-line string literals that cite a repo path are included too — but this pass MUST run
    // over the text with every triple-quoted region already removed. Without that it re-admits the
    // one-line module/def docstrings the pass above just excluded, and a module docstring
    // describing a sibling guard becomes a false DRIFT. Measured: it did exactly that, and the
    // self-test caught it, which is the whole reason the docstring cases are asserted separately.
    const withoutTriple = text.replace(/("""|''')[\s\S]*?\1/g, '\n');
    for (const line of withoutTriple.split('\n')) {
      const t = line.trim();
      if (t.startsWith('#')) continue;
      if (/(['"]).*\1/.test(line) && PATH_RE.test(line)) out.push(line);
      PATH_RE.lastIndex = 0;
    }
  }
  return out;
}

/** filename -> SCHEDULED, from the inventory's installed_at[].schedule. */
export function scheduledPaths(root) {
  const p = path.join(root, INVENTORY_REL);
  if (!existsSync(p)) return null;
  let rows;
  try { rows = JSON.parse(readFileSync(p, 'utf8')).artifacts; } catch { return null; }
  if (!Array.isArray(rows)) return null;
  const set = new Set();
  for (const r of rows) {
    const scheduled = (r.installed_at || []).some((e) => e && e.schedule) || Boolean(r.schedule);
    if (scheduled && r.artifact) set.add(r.artifact);
  }
  return set;
}

/**
 * Every repo path WIRED as a build-time gate. This delegates to check-canaries-wired.mjs's own
 * `invokerFiles`/`findInvocations` rather than re-deriving "wired" here — that script already owns
 * the question, strips comments so a mention in prose is not an invocation, and counts workflows
 * and tests as invokers, not just package.json.
 *
 * Reading package.json alone is what the first draft did, and it was measurably wrong:
 * scripts/check-boot-readiness.mjs has ZERO package.json hits and is invoked by
 * .github/workflows/deploy.yml, so the narrow version classified a properly wired build-time gate
 * as UNKNOWN — and would have reported the CORRECTED alert copy as a violation.
 */
export function buildTimePaths(root, wiredMod, only) {
  try {
    const files = wiredMod.tracked();
    const invokers = wiredMod.invokerFiles(files);
    const set = new Set();
    // Resolve ONLY the paths actually cited by alert copy. The eager form walked the wiring graph
    // for every gate in scripts/ - O(all gates x all invokers) for an O(few citations) question,
    // which took the live evaluate() past vitest's 5s default and timed the suite out.
    const wanted = only ? [...only].filter((f) => files.includes(f)) : files.filter((f) => /^scripts\//.test(f));
    for (const f of wanted) {
      if (wiredMod.findInvocations(f, invokers).length) set.add(f);
    }
    return set;
  } catch { return null; }
}

/**
 * Sentences of a block, whitespace-normalised. ATTRIBUTION IS PER SENTENCE, not per character
 * window: a character window cannot tell "asserted continuously by X" from a neighbouring
 * sentence that explicitly says "Y is the BUILD-TIME gate". Measured on this wave's own corrected
 * copy — the window flagged the honest sentence pair, and on client-claim-freshness.py it dragged
 * an unrelated "hourly" onto a bare pointer. Split on . ! ? followed by whitespace; never on ':',
 * which these bodies use mid-sentence.
 */
export function sentences(block) {
  return block.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).filter((s) => s.trim().length);
}

export function classify(cited, scheduled, buildTime) {
  if (scheduled.has(cited)) return 'SCHEDULED';
  if (buildTime.has(cited)) return 'BUILD_TIME';
  return 'UNKNOWN';
}

/** The continuity verb in the SAME SENTENCE as `cited`, or null. */
export function qualifyingVerb(block, cited) {
  for (const s of sentences(block)) {
    if (!s.includes(cited)) continue;
    const low = s.toLowerCase();
    for (const v of CONTINUITY_VERBS) if (low.includes(v)) return v;
  }
  return null;
}

export function evaluate(root) {
  const files = corpus(root);
  const scheduled = scheduledPaths(root);
  if (files.length === 0) return { verdict: 'INDETERMINATE', reason: `no alert-emitting artifact found under ${ARTIFACT_DIR}/ — the corpus glob is broken, not the tree` };
  if (scheduled === null) return { verdict: 'INDETERMINATE', reason: `${INVENTORY_REL} is absent or unparseable — cannot tell scheduled from build-time` };

  // PASS 1 — collect every citation. PASS 2 resolves reality for just those paths.
  const raw = [];
  const citedPaths = new Set();
  let withBlocks = 0;
  for (const f of files) {
    let text = '';
    try { text = readFileSync(f.abs, 'utf8'); } catch { text = ''; }
    const blocks = operatorFacingBlocks(text, f.name);
    if (blocks.length) withBlocks += 1;
    const hits = [];
    for (const b of blocks) {
      PATH_RE.lastIndex = 0;
      let m;
      while ((m = PATH_RE.exec(b))) { hits.push({ cited: m[0], verb: qualifyingVerb(b, m[0]) }); citedPaths.add(m[0]); }
    }
    raw.push({ file: f.rel, blocks: blocks.length, hits });
  }
  // VACUITY: zero blocks across the WHOLE corpus means the extractor broke, not that alert copy
  // cites nothing. A single artifact with no block is a fact and is reported, not a refusal.
  // Checked BEFORE the wiring walk: it is the cheaper predicate and there is nothing to resolve.
  if (withBlocks === 0) return { verdict: 'INDETERMINATE', reason: `not one of ${files.length} artifact(s) yielded an operator-facing block — the extractor is broken, not the tree` };
  const buildTime = buildTimePaths(root, wired, citedPaths);
  if (buildTime === null) return { verdict: 'INDETERMINATE', reason: 'the wiring authority (check-canaries-wired.mjs) could not be consulted — cannot tell build-time from unknown' };
  const rows = raw.map((r) => ({
    file: r.file,
    blocks: r.blocks,
    citations: r.hits.map((h) => ({ ...h, reality: classify(h.cited, scheduled, buildTime) })),
  }));
  // VACUITY: zero blocks across the WHOLE corpus means the extractor broke, not that alert copy
  // cites nothing. A single artifact with no block is a fact and is reported, not a refusal.

  const violations = [];
  for (const r of rows) {
    for (const c of r.citations) {
      if (c.verb && c.reality !== 'SCHEDULED') {
        violations.push({ file: r.file, cited: c.cited, reality: c.reality, verb: c.verb, key: `${r.file}::${c.cited}::${c.reality}` });
      }
    }
  }
  return { verdict: violations.length ? 'DRIFT' : 'OK', violations, rows, files: files.length, withBlocks };
}

/** Pre-existing violations REPORT; a new one, or a baselined one that moved, BLOCKS. */
export function loadBaseline(root) {
  const p = path.join(root, BASELINE_REL);
  if (!existsSync(p)) return { keys: new Set(), present: false };
  try {
    const d = JSON.parse(readFileSync(p, 'utf8'));
    return { keys: new Set((d.baselined || []).map((r) => r.key)), present: true };
  } catch { return null; }
}

function emit(r, baseline) {
  if (r.verdict === 'INDETERMINATE') {
    console.log(`alert-copy: INDETERMINATE — ${r.reason}`);
    console.log('ALERT_COPY_VERDICT=INDETERMINATE');
    return 3;
  }
  if (baseline === null) {
    console.log(`alert-copy: INDETERMINATE — ${BASELINE_REL} exists but does not parse`);
    console.log('ALERT_COPY_VERDICT=INDETERMINATE');
    return 3;
  }
  const cited = r.rows.reduce((n, x) => n + x.citations.length, 0);
  console.log(`alert-copy: ${r.files} alert-emitting artifact(s), ${r.withBlocks} with operator-facing text, ${cited} repo-path citation(s)`);
  // POSITIVE per-artifact output: an artifact the extractor could not read must never look like
  // one that was read and found clean.
  for (const row of r.rows) {
    const bad = row.citations.filter((c) => c.verb && c.reality !== 'SCHEDULED');
    const mark = bad.length ? '✗' : (row.blocks ? '✓' : '·');
    const note = row.blocks ? `${row.blocks} block(s), ${row.citations.length} citation(s)` : 'no operator-facing block extracted';
    console.log(`  ${mark} ${path.basename(row.file).padEnd(38)} ${note}`);
  }
  const fresh = (r.violations || []).filter((v) => !baseline.keys.has(v.key));
  const known = (r.violations || []).filter((v) => baseline.keys.has(v.key));
  for (const v of known) {
    console.log(`  REPORT baselined: ${v.file} claims "${v.verb}" of ${v.cited} (reality: ${v.reality})`);
  }
  if (fresh.length) {
    console.log('');
    for (const v of fresh) {
      console.log(`  ✗ ${v.file} — alert copy says "${v.verb}" about ${v.cited}, whose reality is ${v.reality}.`);
      console.log(`      A body may claim a cadence only for a path with an installed_at[].schedule in ${INVENTORY_REL}.`);
      console.log(`      key: ${v.key}`);
    }
    console.log('ALERT_COPY_VERDICT=DRIFT');
    return 1;
  }
  console.log(known.length
    ? `  no NEW violation; ${known.length} baselined and reported (the baseline only ever shrinks)`
    : '  every cadence claim in operator-facing copy names a scheduled guard');
  console.log('ALERT_COPY_VERDICT=OK');
  return 0;
}

export function run(root) {
  return emit(evaluate(root), loadBaseline(root));
}

// ─────────────────────────────── self-test ───────────────────────────────

function selfTest() {
  const fails = [];
  let checked = 0;
  const ck = (label, got, want) => {
    checked += 1;
    if (got === want) { console.log(`  ✓ ${label}`); return; }
    console.log(`  ✗ ${label} — expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    fails.push(label);
  };

  console.log('--- operator-facing extraction, per language ---');
  const sh = 'echo hi\n# a comment naming scripts/check-boot-readiness.mjs continuously\nfire() {\ncat <<EOF\nboot survival is asserted continuously by scripts/check-boot-readiness.mjs\nEOF\n}\n';
  const shBlocks = operatorFacingBlocks(sh, 'x.sh');
  ck('shell heredoc is extracted', shBlocks.length, 1);
  ck('  and the # comment is NOT', shBlocks.join('').includes('a comment naming'), false);
  const py = '"""Module docstring: asserted continuously by scripts/check-boot-readiness.mjs."""\nimport x\ndef f():\n    """Def docstring: continuously scripts/check-boot-readiness.mjs."""\n    return BODY\nBODY = """asserted continuously by scripts/check-boot-readiness.mjs"""\n';
  const pyBlocks = operatorFacingBlocks(py, 'x.py');
  ck('python module docstring is NOT operator-facing', pyBlocks.some((b) => b.includes('Module docstring')), false);
  ck('python def docstring is NOT operator-facing', pyBlocks.some((b) => b.includes('Def docstring')), false);
  ck('python assigned triple-quoted body IS', pyBlocks.some((b) => b.includes('asserted continuously by')), true);
  const mjs = '/* block comment continuously scripts/check-boot-readiness.mjs */\nconst b = `asserted continuously by scripts/check-boot-readiness.mjs`;\n';
  const mjsBlocks = operatorFacingBlocks(mjs, 'x.mjs');
  ck('js template literal is extracted', mjsBlocks.length, 1);
  ck('  and the block comment is NOT', mjsBlocks.join('').includes('block comment'), false);

  console.log('--- classification ---');
  const sched = new Set(['ops/monitoring/boot-contract-canary.sh']);
  const build = new Set(['scripts/check-boot-readiness.mjs']);
  ck('an installed_at+schedule path is SCHEDULED', classify('ops/monitoring/boot-contract-canary.sh', sched, build), 'SCHEDULED');
  ck('a package.json-wired path is BUILD_TIME', classify('scripts/check-boot-readiness.mjs', sched, build), 'BUILD_TIME');
  ck('anything else is UNKNOWN', classify('scripts/nope.mjs', sched, build), 'UNKNOWN');

  console.log('--- the verb proximity rule ---');
  const claim = 'boot survival is asserted continuously by scripts/check-boot-readiness.mjs';
  ck('a cadence verb in the SAME SENTENCE qualifies it', qualifyingVerb(claim, 'scripts/check-boot-readiness.mjs'), 'continuously');
  const pointer = 'see scripts/check-boot-readiness.mjs for the contract shape';
  ck('a bare pointer does NOT qualify', qualifyingVerb(pointer, 'scripts/check-boot-readiness.mjs'), null);
  const twoSentences = 'Asserted continuously by ops/monitoring/boot-contract-canary.sh. scripts/check-boot-readiness.mjs is the BUILD-TIME gate.';
  ck('a verb in a NEIGHBOURING sentence does NOT qualify', qualifyingVerb(twoSentences, 'scripts/check-boot-readiness.mjs'), null);
  ck('  while the same verb DOES qualify its own sentence', qualifyingVerb(twoSentences, 'ops/monitoring/boot-contract-canary.sh'), 'continuously');

  console.log('--- THE REGRESSION FIXTURE: the exact pre-fix body must DRIFT ---');
  // Verbatim from kernel-staleness-canary.sh before OPS-HOST-KERNEL-REBOOT-W3 CH3.
  const PRE_FIX = 'Action: schedule a reboot. The procedure is validated end-to-end by OPS-HOST-KERNEL-REBOOT-W1\n(verify Hetzner console access first, rehearse on aoe-1, then signal-1); boot survival is asserted\ncontinuously by scripts/check-boot-readiness.mjs. recommended_wave: OPS-HOST-KERNEL-REBOOT-W{NEXT}';
  PATH_RE.lastIndex = 0;
  const hit = PATH_RE.exec(PRE_FIX);
  ck('the pre-fix body cites the build-time gate', hit && hit[0], 'scripts/check-boot-readiness.mjs');
  ck('  with a cadence verb', Boolean(hit && qualifyingVerb(PRE_FIX, hit[0])), true);
  ck('  and its reality is BUILD_TIME, not SCHEDULED', classify('scripts/check-boot-readiness.mjs', sched, build), 'BUILD_TIME');
  ck('  => the pre-fix body is a DRIFT', Boolean(hit && qualifyingVerb(PRE_FIX, hit[0])) && classify(hit[0], sched, build) !== 'SCHEDULED', true);

  console.log('--- the POST-fix body must NOT drift ---');
  const POST_FIX = readFileSync(path.join(REPO, 'ops/monitoring/kernel-staleness-canary.sh'), 'utf8');
  const postBlocks = operatorFacingBlocks(POST_FIX, 'kernel-staleness-canary.sh');
  const postClaim = postBlocks.find((b) => b.includes('Boot survival is asserted'));
  ck('the live body still makes the claim', Boolean(postClaim), true);
  if (postClaim) {
    PATH_RE.lastIndex = 0;
    const cites = [];
    let m; while ((m = PATH_RE.exec(postClaim))) cites.push({ p: m[0], v: qualifyingVerb(postClaim, m[0]) });
    const qualified = cites.filter((c) => c.v).map((c) => c.p);
    ck('  and the cadence verb now qualifies the SCHEDULED canary', qualified.includes('ops/monitoring/boot-contract-canary.sh'), true);
  }

  console.log('--- live tree ---');
  const live = evaluate(REPO);
  ck('the live corpus is non-empty', live.files > 0, true);
  ck('the live extractor found operator-facing text', live.withBlocks > 0, true);
  ck('the live verdict is a real token', ['OK', 'DRIFT'].includes(live.verdict), true);

  console.log('--- vacuity guards, driven by a FIXTURE TREE (D5 proved nothing asserted these) ---');
  {
    const tmp = mkdtempSync(path.join(tmpdir(), 'alertcopy-'));
    mkdirSync(path.join(tmp, 'ops/monitoring'), { recursive: true });
    writeFileSync(path.join(tmp, 'ops/monitoring/monitoring-inventory.json'), JSON.stringify({ artifacts: [] }));
    // An artifact that calls the wrapper but yields NO operator-facing block: if the extractor
    // silently degrades, every such corpus would read as clean.
    // NOTE the lowercase `send_telegram`: corpus membership is defined by that literal, and an
    // uppercase fixture silently produced an EMPTY corpus, so the wrong vacuity guard fired.
    // The assertion below distinguishes them, which is why it is worth asserting the REASON.
    writeFileSync(path.join(tmp, 'ops/monitoring/blockless-canary.sh'), '#!/usr/bin/env bash\necho hi | /opt/algovault-monitoring/send_telegram.sh AID CRITICAL_PERSISTENT -\n');
    ck('a corpus where NOTHING yields a block -> INDETERMINATE', evaluate(tmp).verdict, 'INDETERMINATE');
    ck('  and it says the extractor is broken, not the tree', /extractor is broken/.test(evaluate(tmp).reason || ''), true);
    const bare = mkdtempSync(path.join(tmpdir(), 'alertcopy-bare-'));
    ck('an EMPTY corpus -> INDETERMINATE (the glob is broken)', evaluate(bare).verdict, 'INDETERMINATE');
    mkdirSync(path.join(bare, 'ops/monitoring'), { recursive: true });
    writeFileSync(path.join(bare, 'ops/monitoring/x.sh'), 'send_telegram\ncat <<EOF\nhi\nEOF\n');
    ck('a corpus with no inventory -> INDETERMINATE', evaluate(bare).verdict, 'INDETERMINATE');
    rmSync(tmp, { recursive: true, force: true }); rmSync(bare, { recursive: true, force: true });
  }

  console.log('--- token -> exit-code mapping (asserted, not assumed) ---');
  const silence = () => { const o = console.log; console.log = () => {}; return () => { console.log = o; }; };
  const empty = { keys: new Set(), present: false };
  for (const [fixture, base, code, label] of [
    [{ verdict: 'INDETERMINATE', reason: 'f' }, empty, 3, 'INDETERMINATE -> 3'],
    [{ verdict: 'OK', violations: [], rows: [], files: 1, withBlocks: 1 }, empty, 0, 'OK -> 0'],
    [{ verdict: 'DRIFT', violations: [{ file: 'f', cited: 'c', reality: 'UNKNOWN', verb: 'continuously', key: 'k' }], rows: [], files: 1, withBlocks: 1 }, empty, 1, 'DRIFT -> 1'],
    [{ verdict: 'DRIFT', violations: [{ file: 'f', cited: 'c', reality: 'UNKNOWN', verb: 'continuously', key: 'k' }], keys: null, rows: [], files: 1, withBlocks: 1 }, { keys: new Set(['k']), present: true }, 0, 'a BASELINED drift -> 0 (reported, not blocking)'],
    [{ verdict: 'OK', violations: [], rows: [], files: 1, withBlocks: 1 }, null, 3, 'an unparseable baseline -> 3'],
  ]) {
    const restore = silence();
    const got = emit(fixture, base);
    restore();
    ck(label, got, code);
  }

  const MIN_ASSERTIONS = 31;
  if (checked < MIN_ASSERTIONS) {
    console.log(`SELF_TEST_VERDICT=INDETERMINATE — only ${checked} assertions ran (expected >= ${MIN_ASSERTIONS})`);
    console.log('ALERT_COPY_VERDICT=INDETERMINATE');
    return 3;
  }
  if (fails.length) {
    console.log(`SELF_TEST_VERDICT=FAIL — ${fails.length}/${checked}: ${fails.join(', ')}`);
    console.log('ALERT_COPY_VERDICT=DRIFT');
    return 1;
  }
  console.log(`SELF_TEST_VERDICT=PASS — ${checked} assertions (7 extraction, 3 classification, 4 sentence-scope, 4 regression fixture, 2 post-fix, 3 live, 4 vacuity, 5 token-map)`);
  console.log('ALERT_COPY_VERDICT=OK');
  return 0;
}

function main() {
  if (process.argv.slice(2).includes('--self-test')) return process.exit(selfTest());
  return process.exit(run(REPO));
}

if (import.meta.url === `file://${process.argv[1]}`) main();

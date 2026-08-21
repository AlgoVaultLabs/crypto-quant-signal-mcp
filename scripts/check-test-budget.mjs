#!/usr/bin/env node
/**
 * OPS-DEPLOY-PROVENANCE-AND-VERDICT-CLASS-W1 CH2 — a test that SPAWNS A PROCESS must own its
 * time budget.
 *
 * WHY THIS EXISTS. On 2026-08-17 a test that shells out to `tsc` inherited vitest's 5,000 ms
 * DEFAULT — a budget calibrated for pure-function assertions — and blew it on a CI runner that is
 * slower than a warm laptop. The suite reported `Test timed out in 5000ms` with 6,044 tests
 * passing. That red blocked the pre-deploy gate, and because a single `deploy` job runs tests and
 * deploy together, it blocked ANOTHER wave's finished, green, merged work for ~3 days. A timeout
 * is not evidence the code is broken; it is evidence the suite did not finish deciding.
 *
 * SCOPE IS PROCESS-SPAWN ONLY, and that is a decision rather than an omission. It is the class
 * with a proven live failure. Widening to filesystem/network I/O across ~6,000 tests would red
 * files this wave does not own, which the collision firewall forbids. Widening is
 * OPS-TEST-BUDGET-WIDEN-W1, once this class is quiet.
 *
 * -- THREE THINGS MAKE THIS A GATE RATHER THAN A WISH ----------------------------------------
 *
 * 1. NEW/CHANGED IS BLOCKING TODAY. A spawning block in a test file that is new or modified
 *    versus the merge-base with origin/main FAILS now. The backlog grandfathers history; it
 *    grants nothing to code being written today.
 *
 * 2. THE BACKLOG IS SHRINK-ONLY. It is keyed by file + block title. If it GROWS, or a spawning
 *    block appears that is not on it, the gate FAILS. Without this, report-mode is a permanent
 *    hiding place — "changed files only" wearing a migration's label. Same shape as
 *    LEGACY_HANDROLLED_CLAIM_STORES in PRICING-BOT-DELIVERY-METERING-W1 CH1.
 *
 * 3. THE GATE PROMOTES ITSELF ON A CONDITION, NEVER A DATE. `promoteWhenBacklogEmpty` lives in
 *    config: while the backlog holds entries they REPORT; once it is EMPTY, blocking is universal.
 *    That needs no enforcement branch, and the absence of one IS the mechanism — with an empty
 *    backlog nothing is grandfathered, so every undeclared spawning block already fails through
 *    leg 2. Nobody flips a flag; no follow-up wave is required to make it bite.
 *
 *    The predecessor was a `promoteOn` CALENDAR DATE, enforced here. On that date every remaining
 *    backlog entry would have started FAILING — redding the suite, blocking the deploy, for work
 *    nobody had committed to doing. That is precisely the harm this gate was built to prevent.
 *    A PROMOTION CRITERION MAY NEVER BE ABLE TO CAUSE THE FAILURE ITS GATE EXISTS TO PREVENT.
 *    The backlog is shrink-only by construction, so it converges to zero on its own and the
 *    condition arrives without a calendar. (OPS-TEST-BUDGET-PROMOTION-FIX-W1.)
 *
 * CONTRACT: exactly one terminal `TEST_BUDGET_VERDICT=PASS|FAIL|INDETERMINATE`. Callers gate on
 * the TOKEN, never the exit code. Exit 0=PASS, 1=FAIL, 3=INDETERMINATE — the token-law default
 * for a NEW gate. A file we were handed and could not parse is INDETERMINATE, never PASS.
 *
 * NO GIT BASE IS INDETERMINATE, NEVER PASS. `changedTestFiles()` needs `origin/main`, which a
 * depth-1 `actions/checkout` does not fetch on a branch push. An empty changed-set from "nothing
 * changed" and one from "I could not read the base" are different facts and must never share a
 * value, so the second returns null and this gate answers INDETERMINATE at exit 3. The CI half —
 * `fetch-depth: 0` on the lane that runs the suite — is pinned by tests/unit/ci-git-context.test.ts
 * (OPS-TEST-BUDGET-CI-REF-W1).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = join(REPO, 'tests');
const CONFIG = join(REPO, 'ops/test-budget-config.json');

/** PROCESS SPAWN ONLY. No filesystem or network token appears here, on purpose. */
export const SPAWN = /\b(child_process|execFileSync|execSync|spawnSync|spawn\s*\()/;

export function testFiles(root) {
  const out = [];
  (function walk(d) {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(test|spec)\.(ts|mts|mjs|js)$/.test(e)) out.push(p);
    }
  })(root);
  return out.sort();
}

/** Brace-balanced argument span of every `it(` / `test(` call. */
export function callBlocks(src) {
  const out = [];
  const re = /\b(it|test)(\.\w+)?\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 1;
    const start = i;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

/**
 * Title, plus whether an explicit timeout is declared.
 *
 * The timeout must sit in the OPTIONS ARGUMENT — between the title and the callback. Scanning the
 * whole body would count a `timeout:` inside the test's own fixture data as a declaration, which
 * is how a budget gate ends up certifying tests that declare nothing.
 */
export function parseBlock(args) {
  const t = args.match(/^\s*(['"`])([\s\S]*?)\1/);
  const title = t ? t[2].replace(/\s+/g, ' ').trim() : '<dynamic>';
  const rest = t ? args.slice(t[0].length) : args;
  const cb = rest.search(/(async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|(async\s*)?function\b/);
  const head = cb > 0 ? rest.slice(0, cb) : '';
  return { title, hasTimeout: /\btimeout\s*:\s*\d/.test(head) };
}

/**
 * Strip comments and string/template literals before testing for a spawn.
 *
 * A MENTION IS NOT AN INVOCATION. `check-canaries-wired.mjs` already carries this lesson for
 * comments; string literals are the same defect in a different substrate. Without this, a test
 * whose FIXTURE contains the text `execFileSync('a')` — for example a test OF this very gate — is
 * flagged as spawning a process. Found by this gate rejecting its own test file.
 */
export function stripNonCode(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')  // line comments (not protocol-relative URLs)
    .replace(/`(?:\\.|[^`\\])*`/g, '``')     // template literals
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")  // single-quoted
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""'); // double-quoted
}

/** Every spawning block, split by whether it declares a budget. */
export function scan(root) {
  const offenders = [];
  let declared = 0;
  let filesScanned = 0;
  for (const f of testFiles(root)) {
    let src;
    try {
      src = readFileSync(f, 'utf8');
    } catch (e) {
      throw new Error(`unreadable ${f}: ${e.message}`);
    }
    filesScanned++;
    for (const b of callBlocks(src)) {
      if (!SPAWN.test(stripNonCode(b))) continue;
      const { title, hasTimeout } = parseBlock(b);
      if (hasTimeout) declared++;
      else offenders.push({ file: relative(REPO, f), block: title });
    }
  }
  return { offenders, declared, filesScanned };
}

/**
 * Test files new or modified versus the merge-base with origin/main.
 *
 * Returns null when there is no git context. The caller treats null as INDETERMINATE rather than
 * as "nothing changed" — assuming none would silently disable the one leg that blocks today.
 */
export function changedTestFiles() {
  const git = (args) =>
    execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const base = git(['merge-base', 'HEAD', 'origin/main']).trim();
    const committed = git(['diff', '--name-only', `${base}..HEAD`]);
    const working = git(['diff', '--name-only', 'HEAD']);
    // UNTRACKED too. A brand-new test file is the commonest "written today" case, and `git diff`
    // cannot see it. Without this it still FAILS — via the shrink-only leg — but the author is
    // told "the backlog may not gain an entry" instead of "declare a budget", which is a true
    // verdict attached to the wrong reason.
    const untracked = git(['ls-files', '--others', '--exclude-standard']);
    return new Set(
      `${committed}\n${working}\n${untracked}`
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => /^tests\/.+\.(test|spec)\./.test(s)),
    );
  } catch {
    return null;
  }
}

const key = (o) => `${o.file} ${o.block}`;

export function decide({ offenders, backlog, changed, promoteWhenBacklogEmpty }) {
  const allowed = new Map(backlog.map((b) => [key(b), b]));
  const seen = new Set();
  const unlisted = [];
  const changedOffenders = [];
  const grandfathered = [];
  for (const o of offenders) {
    const k = key(o);
    if (changed && changed.has(o.file)) {
      changedOffenders.push(o);
      continue;
    }
    if (allowed.has(k)) {
      seen.add(k);
      grandfathered.push(o);
    } else {
      unlisted.push(o);
    }
  }
  // Promotion is a STATE, not a switch, and it has NO enforcement arm on purpose. It is true
  // exactly when the backlog is empty — and when the backlog is empty `allowed` is empty too, so
  // every offender has already landed in `unlisted` and fails below. The date mechanism needed a
  // `promoted ? grandfathered.map(...) : []` arm precisely because it could fire while the backlog
  // was still full: that arm is what would have redded the suite for work nobody had agreed to do.
  // A promotion that cannot be aimed at a non-empty backlog cannot cause that outage.
  const promoted = promoteWhenBacklogEmpty === true && backlog.length === 0;
  const failures = [
    ...changedOffenders.map(
      (o) => `NEW/CHANGED ${o.file} :: ${o.block} — a test written today may not inherit the 5,000ms default`,
    ),
    ...unlisted.map(
      (o) => `UNLISTED ${o.file} :: ${o.block} — the backlog is SHRINK-ONLY; it may not gain an entry`,
    ),
  ];
  return {
    failures,
    grandfathered,
    unlisted,
    changedOffenders,
    promoted,
    backlogRemaining: backlog.length,
    staleBacklog: [...allowed.keys()].filter((k) => !seen.has(k)),
  };
}

/**
 * The config's promotion declaration, validated.
 *
 * `promoteWhenBacklogEmpty` must be exactly `true`. It DECLARES the mechanism decide() implements;
 * it is not a switch the gate obeys, so there is no legitimate second value. A config WE author is
 * constructed, not observed, so a value we cannot act on is vacuity and must refuse — INDETERMINATE,
 * never a pass. Note what that buys: flipping this key to `false` does not disable blocking, it
 * blocks harder. A gate whose promotion has an off switch is a gate with an off switch.
 */
export function promotionActive(cfg) {
  const raw = cfg?.promoteWhenBacklogEmpty;
  if (raw !== true) {
    return { ok: false, reason: `promoteWhenBacklogEmpty must be true, got ${JSON.stringify(raw)}` };
  }
  return { ok: true };
}

/** Split from the read so a fixture can drive the unparseable-config branch without touching disk. */
export function parseConfig(text) {
  try {
    return { ok: true, cfg: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Everything between "the config parsed" and "the token is printed", as a pure function. run() does
 * I/O and nothing else.
 *
 * A hermetic self-test is blind to exactly what its own seam replaces, and under the date mechanism
 * the unreachable seam was this one: decide() was unit-tested to death while run() held the only
 * copy of the config read, the clock read and the token->exit-code mapping. Everything a caller
 * gates on is decided in here, so a fixture config now reaches the same code the real file does.
 */
export function evaluate({ cfg, res, changed }) {
  const lines = [];
  const backlog = cfg?.backlog ?? [];
  const total = res.offenders.length + res.declared;
  // The remaining count is printed on EVERY run, ahead of every branch that can return early. A
  // silent report-mode is how a bounded migration becomes a permanent hiding place.
  lines.push(
    `backlog: ${backlog.length} remaining, owner ${cfg?.owner} - promotion fires when it reaches 0`,
  );
  lines.push(
    `scanned ${res.filesScanned} test files - ${total} spawning blocks (${res.declared} declare a budget, ${res.offenders.length} do not)`,
  );

  const promo = promotionActive(cfg);
  if (!promo.ok) {
    lines.push(`the promotion declaration is unusable: ${promo.reason}`);
    return { lines, verdict: 'INDETERMINATE', code: 3 };
  }
  // Vacuity: the population is KNOWN non-empty (measured 46 undeclared + 2 declared at authoring).
  // Zero spawning blocks means the detector broke, not that the tree is clean.
  if (res.filesScanned === 0 || total === 0) {
    lines.push('the detector is broken, not the tree — zero spawning blocks is not a clean tree');
    return { lines, verdict: 'INDETERMINATE', code: 3 };
  }
  if (changed === null) {
    lines.push('could not determine changed test files (no git context) — refusing to assume none changed');
    return { lines, verdict: 'INDETERMINATE', code: 3 };
  }

  const d = decide({
    offenders: res.offenders,
    backlog,
    changed,
    promoteWhenBacklogEmpty: cfg.promoteWhenBacklogEmpty,
  });
  if (d.staleBacklog.length) {
    lines.push(`  ${d.staleBacklog.length} backlog entry/entries no longer present — SHRINK them from the config`);
  }
  if (d.promoted) {
    lines.push('  PROMOTED — the backlog is empty, so blocking is universal: every spawning block must declare an explicit { timeout: N }');
  } else {
    lines.push(
      `  ${d.grandfathered.length} grandfathered block(s) REPORT while the backlog is non-empty; new/changed and unlisted FAIL today. Owner: ${cfg.owner}`,
    );
  }
  for (const f of d.failures) lines.push(`  x ${f}`);
  const ok = d.failures.length === 0;
  return { lines, verdict: ok ? 'PASS' : 'FAIL', code: ok ? 0 : 1 };
}

function run() {
  let text;
  try {
    text = readFileSync(CONFIG, 'utf8');
  } catch (e) {
    console.log(`could not read ${relative(REPO, CONFIG)}: ${e.message}`);
    console.log('TEST_BUDGET_VERDICT=INDETERMINATE');
    return 3;
  }
  const parsed = parseConfig(text);
  if (!parsed.ok) {
    console.log(`could not read ${relative(REPO, CONFIG)}: ${parsed.error}`);
    console.log('TEST_BUDGET_VERDICT=INDETERMINATE');
    return 3;
  }
  let res;
  try {
    res = scan(TESTS);
  } catch (e) {
    console.log(`could not scan tests/: ${e.message}`);
    console.log('TEST_BUDGET_VERDICT=INDETERMINATE');
    return 3;
  }
  const { lines, verdict, code } = evaluate({ cfg: parsed.cfg, res, changed: changedTestFiles() });
  for (const l of lines) console.log(l);
  console.log(`TEST_BUDGET_VERDICT=${verdict}`);
  return code;
}

// -- self-test ---------------------------------------------------------------------------------
// Fixtures go through the REAL parseBlock/decide, never a hand-written stand-in: a prior gate in
// this repo passed its own property test because the fixture used a shape the extractor never
// emits.
function selfTest() {
  let pass = 0;
  let fail = 0;
  // An assertion that RAISES is not an assertion — it aborts the suite instead of printing FAIL,
  // silently converting "proven able to fail" into "crashes". Every subject below is a thunk.
  const g = (fn) => {
    try {
      return fn();
    } catch (e) {
      return `THREW: ${e.message}`;
    }
  };
  const t = (label, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) {
      pass++;
      console.log(`  ok   ${label}`);
    } else {
      fail++;
      console.log(`  FAIL ${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  };
  const B = (title, body, opts = '') => `'${title}'${opts}, async () => { ${body} }`;

  t('an options timeout is a declaration', parseBlock(B('x', 'execFileSync("a")', ', { timeout: 180000 }')).hasTimeout, true);
  t('no options object is NOT a declaration', parseBlock(B('x', 'execFileSync("a")')).hasTimeout, false);
  t(
    'a timeout INSIDE the body is not a declaration',
    parseBlock(B('x', 'const o = { timeout: 999 }; execFileSync("a", o)')).hasTimeout,
    false,
  );
  t('title is extracted', parseBlock(B('does a thing', 'execSync("a")')).title, 'does a thing');

  const off = [{ file: 'tests/a.test.ts', block: 'legacy' }];
  const grown = [{ file: 'tests/new.test.ts', block: 'b' }];

  t(
    'grandfathered + a NON-EMPTY backlog -> no failure',
    g(() => decide({ offenders: off, backlog: off, changed: new Set(), promoteWhenBacklogEmpty: true }).failures.length),
    0,
  );
  t(
    'an UNLISTED offender fails today (shrink-only)',
    g(() => decide({ offenders: grown, backlog: off, changed: new Set(), promoteWhenBacklogEmpty: true }).failures.length),
    1,
  );
  t(
    'a CHANGED file fails today even if grandfathered',
    g(() =>
      decide({ offenders: off, backlog: off, changed: new Set(['tests/a.test.ts']), promoteWhenBacklogEmpty: true })
        .failures.length),
    1,
  );
  t(
    'a declared block never fails',
    g(() => decide({ offenders: [], backlog: [], changed: new Set(), promoteWhenBacklogEmpty: true }).failures.length),
    0,
  );
  t(
    'promotion is a STATE: false while the backlog holds entries',
    g(() => decide({ offenders: off, backlog: off, changed: new Set(), promoteWhenBacklogEmpty: true }).promoted),
    false,
  );
  t(
    'promotion is a STATE: true the moment the backlog is empty',
    g(() => decide({ offenders: off, backlog: [], changed: new Set(), promoteWhenBacklogEmpty: true }).promoted),
    true,
  );

  // -- the CONFIG -> VERDICT wiring, through the same evaluate() the real run uses ------------
  const CFG = (backlog) => ({ promoteWhenBacklogEmpty: true, owner: 'OPS-TEST-BUDGET-BACKFILL-W1', backlog });
  const RES = (offenders) => ({ offenders, declared: 1, filesScanned: 2 });
  const ev = (cfg, res, changed) => g(() => evaluate({ cfg, res, changed }));
  const vc = (r) => (typeof r === 'string' ? r : [r.verdict, r.code]);

  t(
    'backlog NON-EMPTY + an undeclared legacy block -> PASS',
    vc(ev(CFG(off), RES(off), new Set())),
    ['PASS', 0],
  );
  t(
    'every run reports the remaining count on one line',
    g(() => ev(CFG(off), RES(off), new Set()).lines.filter((l) => /^backlog: 1 remaining\b/.test(l)).length),
    1,
  );
  t(
    'backlog EMPTY + an undeclared block -> FAIL (the promotion, proven)',
    vc(ev(CFG([]), RES(off), new Set())),
    ['FAIL', 1],
  );
  t(
    'the promoted run says so, so the remedy is not a guess',
    g(() => ev(CFG([]), RES(off), new Set()).lines.some((l) => l.includes('PROMOTED — the backlog is empty'))),
    true,
  );
  t(
    'a new/changed undeclared block FAILS with a NON-EMPTY backlog',
    vc(ev(CFG(off), RES(off), new Set(['tests/a.test.ts']))),
    ['FAIL', 1],
  );
  t(
    'a new/changed undeclared block FAILS with an EMPTY backlog too',
    vc(ev(CFG([]), RES(off), new Set(['tests/a.test.ts']))),
    ['FAIL', 1],
  );
  t(
    'a backlog that GREW -> FAIL',
    vc(ev(CFG(off), RES([...off, ...grown]), new Set())),
    ['FAIL', 1],
  );

  // -- the three vacuity guards, and the token -> EXIT CODE mapping with them -----------------
  // Asserting the token alone once left this class fully green while the INDETERMINATE mapping had
  // been re-coded to 0, so every guard below is asserted as a [token, code] PAIR.
  t(
    'vacuity 1: a config we cannot act on is INDETERMINATE, never PASS',
    vc(ev({ ...CFG(off), promoteWhenBacklogEmpty: false }, RES(off), new Set())),
    ['INDETERMINATE', 3],
  );
  t(
    'vacuity 1b: an unparseable config never yields a cfg',
    g(() => parseConfig('definitely not json{').ok),
    false,
  );
  t(
    'vacuity 2: zero spawning blocks is a broken detector, not a clean tree',
    vc(ev(CFG(off), { offenders: [], declared: 0, filesScanned: 0 }, new Set())),
    ['INDETERMINATE', 3],
  );
  t(
    'vacuity 3: no git base is INDETERMINATE, never "nothing changed"',
    vc(ev(CFG(off), RES(off), null)),
    ['INDETERMINATE', 3],
  );
  t(
    'and an EMPTY changed-set is NOT the same fact as a null one',
    vc(ev(CFG(off), RES(off), new Set())),
    ['PASS', 0],
  );

  // The seams these fixtures replace are the parse of REAL source and the read of the REAL config —
  // no scenario above executes either, which is exactly where a hermetic suite goes blind.
  try {
    const real = scan(TESTS);
    t('bypassed artifact: the real tests/ tree parses', real.filesScanned >= 100 && real.offenders.length + real.declared >= 10, true);
  } catch (e) {
    fail++;
    console.log(`  FAIL bypassed artifact: real scan raised ${e.message}`);
  }
  t(
    'bypassed artifact: the REAL config parses and declares the promotion this gate implements',
    g(() => {
      const r = parseConfig(readFileSync(CONFIG, 'utf8'));
      return r.ok && promotionActive(r.cfg).ok && Array.isArray(r.cfg.backlog);
    }),
    true,
  );

  console.log(`SELF-TEST: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} passed, ${fail} failed)`);
  // NOT `TEST_BUDGET_VERDICT=`. A self-test evaluates NOTHING about the tree, so emitting the token a
  // caller gates on would let a run that checked nothing publish a pass — the precise defect this
  // gate exists to prevent, reproduced by its own harness. The self-test's verdict has its own
  // name, and callers of the real gate scrape only the token above.
  console.log(`SELF-TEST-EXIT: ${fail === 0 ? 0 : 1}`);
  return fail === 0 ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith('check-test-budget.mjs')) {
  process.exit(process.argv.includes('--self-test') ? selfTest() : run());
}

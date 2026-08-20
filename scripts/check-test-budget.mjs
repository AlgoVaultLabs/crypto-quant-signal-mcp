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
 * 3. THE GATE PROMOTES ITSELF. `promoteOn` lives in config and is enforced HERE: on or after that
 *    date every backlog entry FAILS, with a loud warning for the 7 days before. Nobody flips a
 *    flag; no follow-up wave is required to make it bite. CLAUDE.md: a rule that has once failed
 *    as prose must be retired into a gate, or accepted as ignored and deleted. The nearest
 *    precedent (ops/monitoring/sot-parity-config.json) states its promotion criterion as prose
 *    for an operator to count, and names a W{NEXT} owner to flip it — deliberately NOT copied.
 *
 * CONTRACT: exactly one terminal `TEST_BUDGET_VERDICT=PASS|FAIL|INDETERMINATE`. Callers gate on
 * the TOKEN, never the exit code. Exit 0=PASS, 1=FAIL, 3=INDETERMINATE — the token-law default
 * for a NEW gate. A file we were handed and could not parse is INDETERMINATE, never PASS.
 *
 * CLOCK: `TEST_BUDGET_NOW` (an ISO date) overrides "today" so the promotion flip can be PROVEN
 * rather than promised. An unproven self-promotion is the prose it replaced.
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
const WARN_WINDOW_DAYS = 7;

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

export function decide({ offenders, backlog, changed, now, promoteOn }) {
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
  const promoted = now >= promoteOn;
  const daysToPromotion = Math.ceil((promoteOn - now) / 86400000);
  const failures = [
    ...changedOffenders.map(
      (o) => `NEW/CHANGED ${o.file} :: ${o.block} — a test written today may not inherit the 5,000ms default`,
    ),
    ...unlisted.map(
      (o) => `UNLISTED ${o.file} :: ${o.block} — the backlog is SHRINK-ONLY; it may not gain an entry`,
    ),
    ...(promoted
      ? grandfathered.map(
          (o) => `PROMOTED ${o.file} :: ${o.block} — past promoteOn; the grandfather window is over`,
        )
      : []),
  ];
  return {
    failures,
    grandfathered,
    unlisted,
    changedOffenders,
    promoted,
    daysToPromotion,
    staleBacklog: [...allowed.keys()].filter((k) => !seen.has(k)),
  };
}

function today() {
  const raw = process.env.TEST_BUDGET_NOW;
  return raw ? new Date(`${raw}T00:00:00Z`).getTime() : Date.now();
}

function run() {
  let cfg;
  let res;
  try {
    cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
  } catch (e) {
    console.log(`could not read ${relative(REPO, CONFIG)}: ${e.message}`);
    console.log('TEST_BUDGET_VERDICT=INDETERMINATE');
    return 3;
  }
  try {
    res = scan(TESTS);
  } catch (e) {
    console.log(`could not scan tests/: ${e.message}`);
    console.log('TEST_BUDGET_VERDICT=INDETERMINATE');
    return 3;
  }
  // Vacuity: the population is KNOWN non-empty (measured 46 undeclared + 2 declared at authoring).
  // Zero spawning blocks means the detector broke, not that the tree is clean.
  const total = res.offenders.length + res.declared;
  if (res.filesScanned === 0 || total === 0) {
    console.log(
      `scanned ${res.filesScanned} files and found ${total} spawning blocks — the detector is broken, not the tree`,
    );
    console.log('TEST_BUDGET_VERDICT=INDETERMINATE');
    return 3;
  }
  const changed = changedTestFiles();
  if (changed === null) {
    console.log('could not determine changed test files (no git context) — refusing to assume none changed');
    console.log('TEST_BUDGET_VERDICT=INDETERMINATE');
    return 3;
  }
  const promoteOn = new Date(`${cfg.promoteOn}T00:00:00Z`).getTime();
  if (!Number.isFinite(promoteOn)) {
    console.log(`promoteOn is unparseable: ${JSON.stringify(cfg.promoteOn)}`);
    console.log('TEST_BUDGET_VERDICT=INDETERMINATE');
    return 3;
  }
  const d = decide({
    offenders: res.offenders,
    backlog: cfg.backlog ?? [],
    changed,
    now: today(),
    promoteOn,
  });

  console.log(
    `scanned ${res.filesScanned} test files - ${total} spawning blocks (${res.declared} declare a budget, ${res.offenders.length} do not)`,
  );
  console.log(
    `backlog: ${(cfg.backlog ?? []).length} grandfathered, owner ${cfg.owner} - promoteOn ${cfg.promoteOn}`,
  );
  if (d.staleBacklog.length) {
    console.log(`  ${d.staleBacklog.length} backlog entry/entries no longer present — SHRINK them from the config`);
  }
  if (d.promoted) {
    console.log(`  PROMOTED — past ${cfg.promoteOn}; grandfathering is over`);
  } else if (d.daysToPromotion <= WARN_WINDOW_DAYS) {
    console.log(
      `  WARNING: PROMOTION IN ${d.daysToPromotion} DAY(S). On ${cfg.promoteOn} all ${d.grandfathered.length} grandfathered blocks start FAILING. Owner: ${cfg.owner}`,
    );
  } else {
    console.log(
      `  grandfathered blocks REPORT until ${cfg.promoteOn} (${d.daysToPromotion} days); new/changed and unlisted FAIL today`,
    );
  }
  for (const f of d.failures) console.log(`  x ${f}`);
  const ok = d.failures.length === 0;
  console.log(`TEST_BUDGET_VERDICT=${ok ? 'PASS' : 'FAIL'}`);
  return ok ? 0 : 1;
}

// -- self-test ---------------------------------------------------------------------------------
// Fixtures go through the REAL parseBlock/decide, never a hand-written stand-in: a prior gate in
// this repo passed its own property test because the fixture used a shape the extractor never
// emits.
function selfTest() {
  let pass = 0;
  let fail = 0;
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

  const NOW = new Date('2026-08-20T00:00:00Z').getTime();
  const ON = new Date('2026-09-19T00:00:00Z').getTime();
  const off = [{ file: 'tests/a.test.ts', block: 'legacy' }];

  t(
    'grandfathered + before promoteOn -> no failure',
    decide({ offenders: off, backlog: off, changed: new Set(), now: NOW, promoteOn: ON }).failures.length,
    0,
  );
  t(
    'grandfathered + AFTER promoteOn -> FAILS (the gate promotes itself)',
    decide({ offenders: off, backlog: off, changed: new Set(), now: ON + 1, promoteOn: ON }).failures.length,
    1,
  );
  t(
    'an UNLISTED offender fails today (shrink-only)',
    decide({
      offenders: [{ file: 'tests/new.test.ts', block: 'b' }],
      backlog: off,
      changed: new Set(),
      now: NOW,
      promoteOn: ON,
    }).failures.length,
    1,
  );
  t(
    'a CHANGED file fails today even if grandfathered',
    decide({ offenders: off, backlog: off, changed: new Set(['tests/a.test.ts']), now: NOW, promoteOn: ON })
      .failures.length,
    1,
  );
  t(
    'a declared block never fails',
    decide({ offenders: [], backlog: off, changed: new Set(), now: ON + 1, promoteOn: ON }).failures.length,
    0,
  );
  t(
    'the 7-day warning window is computed',
    decide({ offenders: off, backlog: off, changed: new Set(), now: ON - 3 * 86400000, promoteOn: ON })
      .daysToPromotion,
    3,
  );

  // The seam these fixtures replace is the parse of REAL source — no scenario above executes it.
  try {
    const real = scan(TESTS);
    t('bypassed artifact: the real tests/ tree parses', real.filesScanned >= 100 && real.offenders.length + real.declared >= 10, true);
  } catch (e) {
    fail++;
    console.log(`  FAIL bypassed artifact: real scan raised ${e.message}`);
  }

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

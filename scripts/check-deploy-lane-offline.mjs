#!/usr/bin/env node
/**
 * OPS-DEPLOY-LANE-NETWORK-FREE-W1 — the deploy lane is network-free, enforced instead of written.
 *
 * ── THE BUG CLASS ───────────────────────────────────────────────────────────────────────────
 * Any pre-deploy gate whose verdict depends on a live network read turns a transient stall into
 * INDETERMINATE, and INDETERMINATE blocks the deploy. Nothing re-measures, so prod stays behind
 * main and the drift canary pages DRIFT_INDETERMINATE until a human re-runs the deploy.
 *
 * ── THE MEASURED INSTANCE ───────────────────────────────────────────────────────────────────
 * scripts/check-primitive-resolution.mjs read npm and the LIVE MCP tools/list from a pre-deploy
 * step under a 5 s budget sized for a pre-commit hook. 2026-09-28..2026-11-18: 15 deploy attempts
 * blocked, all INDETERMINATE (11 a curl stalled with 0 bytes, 4 the budget ran out mid-npm), zero
 * FAIL; 11 of the 12 re-runs that reached the gate passed the unchanged SHA. It also measured the
 * WRONG STATE: a pre-deploy read of tools/list judges the previous deploy, never the commit being
 * shipped.
 *
 * ── WHY A GATE, NOT A FIFTH COMMENT ─────────────────────────────────────────────────────────
 * "The deploy lane must be deterministic and network-free" was already this repo's law, written
 * in check-external-origin-csp.mjs, in deploy.yml's lockfile, served-surface and plugin-manifest
 * steps, and in tests/unit/primitive-resolution.test.ts ("a test that fails because npm was slow
 * teaches people to ignore it"). It was prose, and a gate written after it broke it anyway.
 * CLAUDE.md: a rule that has once failed as prose is retired into a gate.
 *
 * ── HOW ─────────────────────────────────────────────────────────────────────────────────────
 * deploy.yml's job-default shell is scripts/ci/deploy-lane-shell.sh. Between the steps with
 * id lane_open and id lane_close it arms, per step, a Node preload that refuses and records every
 * non-loopback connection (scripts/lib/deploy-lane-offline-preload.mjs) and PATH shims that do the
 * same for curl and wget (scripts/ci/offline-bin). This script is the closing step's judge:
 *   STRUCTURE (static, deploy.yml) — the guard is the job shell; the window exists once and ends
 *     immediately before "Deploy via SSH"; every step BEFORE it is enumerated in PRE_WINDOW with
 *     the reason it is outside; nothing inside it is a uses: step, overrides shell:, or touches
 *     the guard's variables. An unregistered step FAILS toward noise, never toward silence.
 *   LEDGER (runtime) — every window step ran under the guard (STEP lines == run steps parsed
 *     here), the guard armed in ≥1 node process (LOADED), and nothing was refused (ATTEMPT).
 *
 * ── EVERY INPUT IS DETERMINISTIC, AND THAT IS THE POINT ────────────────────────────────────────
 * This judge reads a file it was handed and a file in the repo. It has no network and no clock,
 * so a red here is red on EVERY run of that commit — the violating wave's own deploy shows it,
 * named, instead of 6% of everyone's deploys for seven weeks.
 *
 * ── VERDICT CONTRACT ────────────────────────────────────────────────────────────────────────
 * One terminal line DEPLOY_LANE_OFFLINE_VERDICT=PASS|FAIL|INDETERMINATE; exit 0/1/3 via
 * process.exitCode (never process.exit — tests/unit/verdict-exit-path.test.ts). FAIL = a refused
 * network read or a structural escape. INDETERMINATE = could not verify (no ledger, the guard never
 * armed, a step ran unguarded, deploy.yml unreadable). FAIL > INDETERMINATE > PASS. Callers gate on
 * the TOKEN.
 *
 * ── HONEST SCOPE ────────────────────────────────────────────────────────────────────────────
 * Guarded: node processes (any TCP/TLS/DNS through node:net / node:dns, which is where fetch,
 * http(s) and undici land) and curl/wget invoked by name. NOT guarded: the steps registered in
 * PRE_WINDOW (the vitest suite among them), uses: steps, other binaries (python, git, gh, nc),
 * curl by absolute path, and a script that deletes NODE_OPTIONS before spawning a child.
 *
 *   node scripts/check-deploy-lane-offline.mjs --self-test        # two-way, real wrapper+preload
 *   node scripts/check-deploy-lane-offline.mjs --structure        # static deploy.yml check
 *   node scripts/check-deploy-lane-offline.mjs --judge <ledger>   # structure + ledger (lane_close)
 */
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'deploy.yml');

export const JOB_SHELL = 'bash scripts/ci/deploy-lane-shell.sh {0}';
export const BOUNDARY = 'Deploy via SSH';
export const OPEN_ID = 'lane_open';
export const CLOSE_ID = 'lane_close';
const GUARD_VARS = /\b(NODE_OPTIONS|DEPLOY_LANE_OFFLINE\w*)\b|(^|[\s;])PATH=/;

/**
 * Every step allowed to run BEFORE the window, matched by name prefix, each with the reason it is
 * outside. A new pre-deploy step that is not here FAILS the structure check: put it inside the
 * window, or register it with its reason.
 */
export const PRE_WINDOW = [
  { prefix: 'Checkout', why: 'actions/checkout fetches the repository — reading the network is its job' },
  { prefix: 'Setup Node', why: 'actions/setup-node downloads the toolchain' },
  { prefix: 'Install deps', why: 'npm ci — the one pre-deploy step that must read a registry' },
  { prefix: 'Compile TS', why: 'local tsc build; outside only because the suite after it needs dist/' },
  { prefix: 'Knowledge bundle generator', why: 'local build step that the suite consumes' },
  { prefix: 'Vitest suite', why: 'HONEST SCOPE: the suite runs before the window and is NOT guarded here' },
  { prefix: 'Classify the suite verdict', why: "reads the suite's own report file" },
  { prefix: 'Upload suite report', why: 'actions/upload-artifact talks to GitHub by design; a uses: step cannot be wrapped' },
  { prefix: 'Verdict-channel floor proof', why: 'runs the suite classifier on a committed fixture' },
];

const label = (s, i) => `step ${i} "${s?.name ?? s?.uses ?? String(s?.run ?? '').split('\n')[0].slice(0, 50)}"`;

/** Static check of the deploy job. Pure: takes the parsed workflow. */
export function checkStructure(doc) {
  const problems = [];
  const job = doc?.jobs?.deploy;
  const steps = job?.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    return { verdict: 'INDETERMINATE', problems: ['deploy.yml has no jobs.deploy.steps — nothing was checked'], notes: [], expectedSteps: 0 };
  }

  const shell = job.defaults?.run?.shell;
  if (shell !== JOB_SHELL) problems.push(`jobs.deploy.defaults.run.shell is ${JSON.stringify(shell ?? null)}; it must be "${JOB_SHELL}", or no step is guarded`);

  const where = (pred) => steps.flatMap((s, i) => (pred(s) ? [i] : []));
  const opens = where((s) => s?.id === OPEN_ID);
  const closes = where((s) => s?.id === CLOSE_ID);
  const bounds = where((s) => s?.name === BOUNDARY);
  if (opens.length !== 1) problems.push(`expected exactly one step with id ${OPEN_ID}, found ${opens.length}`);
  if (closes.length !== 1) problems.push(`expected exactly one step with id ${CLOSE_ID}, found ${closes.length}`);
  if (bounds.length !== 1) problems.push(`expected exactly one step named "${BOUNDARY}", found ${bounds.length}`);
  if (problems.length && (opens.length !== 1 || closes.length !== 1 || bounds.length !== 1)) {
    return { verdict: 'FAIL', problems, notes: [], expectedSteps: 0 };
  }
  const [o] = opens;
  const [c] = closes;
  const [b] = bounds;
  if (o > c) problems.push(`${OPEN_ID} (step ${o}) comes after ${CLOSE_ID} (step ${c})`);
  if (b !== c + 1) problems.push(`"${BOUNDARY}" (step ${b}) must come immediately after ${CLOSE_ID} (step ${c}) — anything between them runs after the guard was judged`);

  steps.forEach((s, i) => {
    if (s?.['working-directory']) problems.push(`${label(s, i)} sets working-directory — the job shell is a workspace-relative path`);
  });

  steps.slice(0, Math.min(o, c)).forEach((s, i) => {
    const name = s?.name ?? '';
    if (!PRE_WINDOW.some((p) => name.startsWith(p.prefix))) {
      problems.push(`${label(s, i)} runs BEFORE the network-free window and is not registered in PRE_WINDOW — move it inside the window, or register it with the reason it must be outside`);
    }
  });

  const inside = steps.slice(o + 1, c);
  inside.forEach((s, k) => {
    const i = o + 1 + k;
    if (s?.uses) problems.push(`${label(s, i)} is a uses: step inside the window — only run: steps go through the guarded shell`);
    if (s?.shell) problems.push(`${label(s, i)} overrides shell: — that bypasses scripts/ci/deploy-lane-shell.sh`);
    for (const key of Object.keys(s?.env ?? {})) {
      if (GUARD_VARS.test(key) || key === 'PATH') problems.push(`${label(s, i)} sets env ${key} — that disarms or redirects the guard`);
    }
    if (GUARD_VARS.test(String(s?.run ?? ''))) problems.push(`${label(s, i)} touches NODE_OPTIONS, PATH= or DEPLOY_LANE_OFFLINE* in its body — that disarms or redirects the guard`);
  });

  const openRun = String(steps[o]?.run ?? '');
  const closeRun = String(steps[c]?.run ?? '');
  if (steps[o]?.shell || steps[c]?.shell) problems.push(`${OPEN_ID}/${CLOSE_ID} must use the job shell`);
  if (!/DEPLOY_LANE_OFFLINE=1/.test(openRun) || !/GITHUB_ENV/.test(openRun)) problems.push(`${OPEN_ID} must write DEPLOY_LANE_OFFLINE=1 to $GITHUB_ENV`);
  if (!/^OPEN\b|printf 'OPEN/m.test(openRun)) problems.push(`${OPEN_ID} must initialise the ledger with an OPEN line`);
  if (!/check-deploy-lane-offline\.mjs --judge/.test(closeRun) || !/DEPLOY_LANE_OFFLINE_VERDICT=PASS/.test(closeRun)) {
    problems.push(`${CLOSE_ID} must run check-deploy-lane-offline.mjs --judge and gate on the DEPLOY_LANE_OFFLINE_VERDICT=PASS token`);
  }
  if (!/DEPLOY_LANE_OFFLINE=0/.test(closeRun)) problems.push(`${CLOSE_ID} must write DEPLOY_LANE_OFFLINE=0 to $GITHUB_ENV, or the post-deploy steps lose the network`);

  // The run steps the ledger must show a STEP line for: the window, plus lane_close itself (the
  // window is still open when it runs). lane_open runs before its own $GITHUB_ENV write lands.
  const expectedSteps = steps.slice(o + 1, c + 1).filter((s) => s?.run !== undefined).length;
  const notes = [`window: ${inside.length} step(s) between ${OPEN_ID} and ${CLOSE_ID}; ${Math.min(o, c)} step(s) before it, each registered in PRE_WINDOW`];
  return { verdict: problems.length ? 'FAIL' : 'PASS', problems, notes, expectedSteps };
}

/** Judge the ledger the window's steps wrote. Pure. */
export function judgeLedger(text, expectedSteps) {
  const rows = String(text ?? '').split('\n').filter(Boolean).map((l) => l.split('\t'));
  const of = (kind) => rows.filter((f) => f[0] === kind);
  const opens = of('OPEN');
  const steps = of('STEP');
  const loaded = of('LOADED');
  const attempts = of('ATTEMPT');
  const errors = of('GUARD_ERROR');

  const fails = attempts.map((a) => `network read refused inside the window: via=${a[1]} target=${a[2]} by ${a[3] ?? '?'}`);
  const unknowns = [];
  if (opens.length !== 1) unknowns.push(`ledger has ${opens.length} OPEN line(s), expected 1 — ${OPEN_ID} did not initialise it`);
  for (const e of errors) unknowns.push(`the guard failed to arm in ${e[3] ?? '?'}: ${e[2] ?? ''}`);
  if (loaded.length === 0) unknowns.push('zero node processes armed the guard — it verified nothing');
  if (steps.length !== expectedSteps) {
    unknowns.push(`${steps.length} step(s) ran under the guard but deploy.yml has ${expectedSteps} run step(s) in the window — a step ran unguarded, or ran twice`);
  }
  const notes = [`${steps.length}/${expectedSteps} window step(s) guarded · ${loaded.length} node process(es) armed · ${attempts.length} network read(s) refused`];
  const verdict = fails.length ? 'FAIL' : unknowns.length ? 'INDETERMINATE' : 'PASS';
  return { verdict, problems: [...fails, ...unknowns], notes };
}

export function exitCodeFor(verdict) {
  return verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 3;
}

export function worst(...verdicts) {
  if (verdicts.includes('FAIL')) return 'FAIL';
  if (verdicts.includes('INDETERMINATE')) return 'INDETERMINATE';
  return 'PASS';
}

export function loadWorkflow(path = WORKFLOW) {
  try {
    return { doc: yaml.load(readFileSync(path, 'utf8')) };
  } catch (e) {
    return { error: `could not read ${path}: ${String(e?.message ?? e).slice(0, 160)}` };
  }
}

/* ── self-test: two-way, and it drives the REAL wrapper → preload → shim → ledger chain ───── */

/** A minimal workflow that satisfies every structural rule; each mutation below must break it. */
export function fixtureWorkflow() {
  return {
    jobs: {
      deploy: {
        defaults: { run: { shell: JOB_SHELL } },
        steps: [
          { name: 'Checkout', uses: 'actions/checkout@v4' },
          { name: 'Install deps', run: 'npm ci' },
          { name: 'Vitest suite (pre-deploy gate)', run: 'npm test' },
          { name: 'Open the network-free gate window', id: OPEN_ID, run: `printf 'OPEN\\t%s\\n' now > "$L"\necho "DEPLOY_LANE_OFFLINE=1" >> "$GITHUB_ENV"` },
          { name: 'A gate', run: 'node scripts/check-a.mjs' },
          { name: 'Another gate', run: 'node scripts/check-b.mjs --check' },
          { name: 'Close the network-free gate window', id: CLOSE_ID, run: 'OUT="$(node scripts/check-deploy-lane-offline.mjs --judge "$L")"\necho "DEPLOY_LANE_OFFLINE=0" >> "$GITHUB_ENV"\ntest "$V" = "DEPLOY_LANE_OFFLINE_VERDICT=PASS"' },
          { name: BOUNDARY, uses: 'appleboy/ssh-action@x' },
          { name: 'Post-deploy live check', run: 'node scripts/check-a.mjs --live' },
        ],
      },
    },
  };
}

function runChain(stepBody) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-lane-offline-'));
  try {
    const ledger = join(dir, 'ledger');
    writeFileSync(ledger, 'OPEN\tself-test\n');
    const step = join(dir, 'step.sh');
    writeFileSync(step, `${stepBody}\n`);
    const env = { ...process.env, DEPLOY_LANE_OFFLINE: '1', DEPLOY_LANE_OFFLINE_LEDGER: ledger, GITHUB_ACTION: 'self_test' };
    delete env.NODE_OPTIONS; // the wrapper must arm the guard itself — an inherited preload would mask a broken wrapper
    const r = spawnSync('bash', [join(ROOT, 'scripts', 'ci', 'deploy-lane-shell.sh'), step], { env, encoding: 'utf8', timeout: 20_000 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ledger: existsSync(ledger) ? readFileSync(ledger, 'utf8') : '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function selfTest() {
  let failed = 0;
  const check = (name, got, want) => {
    if (got === want) return;
    failed += 1;
    console.log(`  SELF-TEST case FAILED: ${name} — got ${got}, want ${want}`);
  };

  // STRUCTURE — the fixture passes, and every escape fails.
  check('fixture workflow passes', checkStructure(fixtureWorkflow()).verdict, 'PASS');
  check('fixture expects 3 guarded steps (2 gates + lane_close)', checkStructure(fixtureWorkflow()).expectedSteps, 3);
  const mutate = (fn) => { const d = fixtureWorkflow(); fn(d.jobs.deploy); return checkStructure(d).verdict; };
  check('no job shell → FAIL', mutate((j) => { delete j.defaults; }), 'FAIL');
  check('a different job shell → FAIL', mutate((j) => { j.defaults.run.shell = 'bash -e {0}'; }), 'FAIL');
  check('a step overriding shell: inside the window → FAIL', mutate((j) => { j.steps[4].shell = 'bash'; }), 'FAIL');
  check('a uses: step inside the window → FAIL', mutate((j) => { j.steps.splice(5, 0, { name: 'x', uses: 'some/action@v1' }); }), 'FAIL');
  check('env NODE_OPTIONS on a window step → FAIL', mutate((j) => { j.steps[4].env = { NODE_OPTIONS: '' }; }), 'FAIL');
  check('a window step unsetting NODE_OPTIONS in its body → FAIL', mutate((j) => { j.steps[4].run = 'env -u NODE_OPTIONS node x.mjs'; }), 'FAIL');
  check('a window step rewriting PATH in its body → FAIL', mutate((j) => { j.steps[4].run = 'PATH=/usr/bin node x.mjs'; }), 'FAIL');
  check('an unregistered step before the window → FAIL', mutate((j) => { j.steps.splice(2, 0, { name: 'Live npm check', run: 'node scripts/check-npm.mjs' }); }), 'FAIL');
  check('a step between lane_close and the deploy → FAIL', mutate((j) => { j.steps.splice(7, 0, { name: 'late gate', run: 'node x.mjs' }); }), 'FAIL');
  check('missing lane_close → FAIL', mutate((j) => { delete j.steps[6].id; }), 'FAIL');
  check('two lane_open steps → FAIL', mutate((j) => { j.steps[4].id = OPEN_ID; }), 'FAIL');
  check('lane_close not gating on the token → FAIL', mutate((j) => { j.steps[6].run = 'node scripts/check-deploy-lane-offline.mjs --judge "$L" || true\necho "DEPLOY_LANE_OFFLINE=0" >> "$GITHUB_ENV"'; }), 'FAIL');
  check('lane_close not reopening the network → FAIL', mutate((j) => { j.steps[6].run = j.steps[6].run.replace('DEPLOY_LANE_OFFLINE=0', 'X=0'); }), 'FAIL');
  check('working-directory anywhere in the job → FAIL', mutate((j) => { j.steps[8]['working-directory'] = 'sub'; }), 'FAIL');
  check('no steps at all → INDETERMINATE', checkStructure({ jobs: { deploy: { steps: [] } } }).verdict, 'INDETERMINATE');
  check('no deploy job → INDETERMINATE', checkStructure({}).verdict, 'INDETERMINATE');

  // LEDGER — the vacuity guard lives here, where the corpus is constructed.
  const ok = 'OPEN\tt\nSTEP\tshell\ta\ts\t1\nLOADED\tnode\t-\tx.mjs\t2\nSTEP\tshell\tb\ts\t3\n';
  check('clean ledger → PASS', judgeLedger(ok, 2).verdict, 'PASS');
  check('a refused read → FAIL', judgeLedger(`${ok}ATTEMPT\ttcp\tapi.example.com:443\tx.mjs\t2\n`, 2).verdict, 'FAIL');
  check('a refused curl → FAIL', judgeLedger(`${ok}ATTEMPT\tcurl\thttps://x\tnode x.mjs\t9\n`, 2).verdict, 'FAIL');
  check('no OPEN line → INDETERMINATE', judgeLedger(ok.replace('OPEN\tt\n', ''), 2).verdict, 'INDETERMINATE');
  check('zero LOADED → INDETERMINATE', judgeLedger(ok.replace(/LOADED[^\n]*\n/, ''), 2).verdict, 'INDETERMINATE');
  check('fewer guarded steps than window steps → INDETERMINATE', judgeLedger(ok, 3).verdict, 'INDETERMINATE');
  check('GUARD_ERROR → INDETERMINATE', judgeLedger(`${ok}GUARD_ERROR\tnode\tboom\tx.mjs\t2\n`, 2).verdict, 'INDETERMINATE');
  check('a FAIL outranks an INDETERMINATE', judgeLedger(`${ok}ATTEMPT\ttcp\th:1\tx\t2\n`, 9).verdict, 'FAIL');
  check('empty ledger → INDETERMINATE', judgeLedger('', 0).verdict, 'INDETERMINATE');
  check('worst(PASS, INDETERMINATE) → INDETERMINATE', worst('PASS', 'INDETERMINATE'), 'INDETERMINATE');
  check('worst(INDETERMINATE, FAIL) → FAIL', worst('INDETERMINATE', 'FAIL'), 'FAIL');
  for (const [v, code] of [['PASS', 0], ['FAIL', 1], ['INDETERMINATE', 3]]) check(`${v} → exit ${code}`, exitCodeFor(v), code);

  // THE REAL CHAIN. A hermetic test is blind to what its seam replaces, so these run the actual
  // wrapper, preload and shim. `.invalid` never resolves, so even a BROKEN guard makes no real
  // connection — it would just report ENOTFOUND and no ATTEMPT, which these cases then catch.
  const fetchRead = runChain(`node -e "fetch('https://deploy-lane-offline.invalid/').catch(() => {})"`);
  check('chain: node fetch inside the window is refused and recorded', /^ATTEMPT\ttcp\tdeploy-lane-offline\.invalid:443/m.test(fetchRead.ledger), true);
  check('chain: that ledger judges FAIL', judgeLedger(fetchRead.ledger, 1).verdict, 'FAIL');
  const curlRead = runChain(`node -e "try { require('node:child_process').execFileSync('curl', ['-sS', 'https://deploy-lane-offline.invalid/'], { stdio: 'ignore' }) } catch {}"`);
  check('chain: node → curl inside the window is refused and recorded', /^ATTEMPT\tcurl\thttps:\/\/deploy-lane-offline\.invalid\//m.test(curlRead.ledger), true);
  const bashCurl = runChain(`curl -sS https://deploy-lane-offline.invalid/ || echo "curl exit $?"`);
  check('chain: a bare curl in a step is refused with exit 7', /curl exit 7/.test(bashCurl.stdout), true);
  check('chain: …and recorded', /^ATTEMPT\tcurl\t/m.test(bashCurl.ledger), true);
  const local = runChain(`node -e "const s = require('node:http').createServer((q, r) => r.end('ok')); s.listen(0, '127.0.0.1', async () => { await fetch('http://127.0.0.1:' + s.address().port + '/'); s.close(); })"`);
  check('chain: a loopback-only step is not refused', /^ATTEMPT/m.test(local.ledger), false);
  check('chain: that ledger judges PASS', judgeLedger(local.ledger, 1).verdict, 'PASS');
  check('chain: the wrapper wrote exactly one STEP line', (local.ledger.match(/^STEP\t/gm) ?? []).length, 1);

  console.log(`SELF-TEST: ${failed === 0 ? 'PASS' : `FAIL (${failed})`}`);
  return failed === 0;
}

/* ── CLI ─────────────────────────────────────────────────────────────────────────────────── */

function emit(verdict, lines = []) {
  for (const l of lines) console.log(l);
  console.log(`DEPLOY_LANE_OFFLINE_VERDICT=${verdict}`);
  process.exitCode = exitCodeFor(verdict);
}

function main(argv) {
  if (argv.includes('--self-test')) {
    emit(selfTest() ? 'PASS' : 'FAIL');
    return;
  }
  const loaded = loadWorkflow();
  if (loaded.error) {
    emit('INDETERMINATE', [`deploy-lane-offline: ${loaded.error}`]);
    return;
  }
  const s = checkStructure(loaded.doc);
  const out = [...s.notes.map((n) => `deploy-lane-offline: ${n}`), ...s.problems.map((p) => `  ✖ structure: ${p}`)];
  if (argv.includes('--structure')) {
    emit(s.verdict, out);
    return;
  }
  const at = argv.indexOf('--judge');
  if (at === -1 || !argv[at + 1]) {
    emit('INDETERMINATE', ['usage: check-deploy-lane-offline.mjs --self-test | --structure | --judge <ledger>']);
    return;
  }
  const ledgerPath = argv[at + 1];
  if (!existsSync(ledgerPath)) {
    emit(worst(s.verdict, 'INDETERMINATE'), [...out, `  ✖ ledger: ${ledgerPath} does not exist — ${OPEN_ID} never ran, so nothing was guarded`]);
    return;
  }
  const j = judgeLedger(readFileSync(ledgerPath, 'utf8'), s.expectedSteps);
  emit(worst(s.verdict, j.verdict), [
    ...out,
    ...j.notes.map((n) => `deploy-lane-offline: ${n}`),
    ...j.problems.map((p) => `  ✖ ledger: ${p}`),
  ]);
}

if (process.argv[1] && process.argv[1].endsWith('check-deploy-lane-offline.mjs')) main(process.argv.slice(2));

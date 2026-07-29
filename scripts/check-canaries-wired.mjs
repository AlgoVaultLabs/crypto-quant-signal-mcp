#!/usr/bin/env node
// @ts-check
/**
 * check-canaries-wired.mjs — the meta-canary: every gate script must actually be RUN by something.
 *
 * OPS-AUDIT-REMEDIATION-HIGH-W1 · Ch5. SECURITY-AUDIT-FULL-W1 found the same class three times:
 * a canary is committed, looks like a gate, and is invoked by nothing.
 *
 *   SEC-19  security-canary.mjs        — shipped by the June audit, wired to no workflow. This is
 *                                        why a live Postgres password sat in a PUBLIC repo for
 *                                        seven weeks with every gate green.
 *   SEC-21/34 check-mcp-stateless.mjs  — committed-never-run; its own header even named an
 *                                        escalation owner that does not invoke it.
 *   SEC-36  check_mobile_nav_parity.sh — referenced only inside a COMMENT in build_nav.mjs.
 *
 * A gate nobody runs is theatre, and it is worse than no gate because it reads as coverage. This
 * script makes the class structurally impossible: an unwired gate fails the build.
 *
 * WIRED means one of — a workflow step, a package.json script, a committed cron/ops wrapper, a
 * git-hook installer, the host monitoring inventory (ops/monitoring/monitoring-inventory.json),
 * or an invocation from another script. A MENTION IN A COMMENT IS NOT AN INVOCATION: comments are
 * stripped before matching, because a comment reference is exactly how SEC-36 stayed hidden.
 *
 * OWNERSHIP: this file is itself a gate, so it is subject to its own rule — it is wired into
 * .github/workflows/deploy.yml alongside the other pre-deploy gates. If you unwire it, it stops
 * protecting anything, and nothing else will tell you.
 *
 * Usage:
 *   node scripts/check-canaries-wired.mjs             # fail (exit 1) on any unwired gate
 *   node scripts/check-canaries-wired.mjs --self-test # prove it catches a synthetic orphan
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

/** Files that legitimately reference a gate without running it. Docs describe; they don't invoke. */
const NON_INVOKING = /^(docs\/|README|CHANGELOG|audits\/|landing\/|\.claude\/)/;

/**
 * Gates that are deliberately not wired, each with the reason. An entry here is a DECISION, not a
 * silence: it shows up in the report so it stays visible.
 */
const ALLOWLIST = new Map([
  // (empty — every gate in the tree is wired. Add an entry only with a stated reason.)
]);

// Strip comments, per the file's ACTUAL comment syntax.
//
// This must be language-aware, and the reason is a real bug this script hit while being written:
// applying the JS block-comment regex to a YAML file destroys it. deploy.yml contains glob
// patterns (ops/scripts/<star><star>) and cron expressions (<star>/2 <star> <star> <star>), so the
// block-comment regex matches from a glob's "/<star><star>" to the next "<star>/" and swallows
// everything between — including the run: lines that invoke the gates. That made two correctly
// wired gates report as orphans.
//
// These line comments are deliberate: writing this explanation as a JSDoc block is impossible,
// because the literal sequence it has to describe would close the block early. That is the same
// documented trap, one level up.
function strip(text, file) {
  if (/\.(sh|ya?ml)$/.test(file)) {
    // Shell and YAML both comment with '#'. No block-comment form exists in either.
    return text.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '$1')).join('\n');
  }
  if (/\.(mjs|js|cjs|ts)$/.test(file)) {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  }
  return text; // JSON and anything else: no comment syntax to strip.
}

function tracked() {
  return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
}

/** Every committed gate script: scripts/check-*, scripts/check_*, and anything named *canary*. */
function gateScripts(files) {
  return files.filter((f) => /^scripts\/(check[-_][^/]+|[^/]*canary[^/]*)\.(mjs|js|cjs|sh|ts)$/.test(f));
}

/**
 * Files that could plausibly INVOKE a gate. Prose is excluded — docs describe a gate, they do not
 * run it, and "it's mentioned in a runbook" is precisely the false comfort this canary exists to
 * remove.
 *
 * Tests ARE counted: a gate driven by a test file genuinely runs, on every CI run and on every
 * push through the pre-push baseline gate. `check-caddy-route-parity.mjs` is wired exactly that
 * way (tests/unit/caddy-route-parity.test.mjs), and excluding tests reported it as an orphan.
 */
function invokerFiles(files) {
  return files.filter((f) => !NON_INVOKING.test(f) && /\.(ya?ml|json|mjs|js|cjs|sh|ts)$/.test(f));
}

function findInvocations(gate, files) {
  const name = basename(gate);
  const hits = [];
  for (const f of files) {
    if (f === gate) continue;                       // a script referencing itself proves nothing
    const abs = join(ROOT, f);
    if (!existsSync(abs)) continue;
    let text;
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    if (!text.includes(name)) continue;
    // JSON has no comments to strip, and the monitoring inventory is a declaration of intent.
    const searchable = f.endsWith('.json') ? text : strip(text, f);
    if (searchable.includes(name)) hits.push(f);
  }
  return hits;
}

function audit() {
  const files = tracked();
  const gates = gateScripts(files);
  const invokers = invokerFiles(files);
  const rows = gates.map((g) => ({ gate: g, refs: findInvocations(g, invokers) }));
  return { rows, orphans: rows.filter((r) => r.refs.length === 0 && !ALLOWLIST.has(r.gate)) };
}

/**
 * Two-way self-test. A meta-canary that cannot detect an orphan is itself the failure mode it
 * exists to prevent, so this runs before every real audit and fails closed.
 */
function selfTest() {
  const fails = [];
  const synthetic = 'scripts/check-synthetic-orphan-canary.mjs';
  // (a) an unreferenced gate MUST be reported
  if (findInvocations(synthetic, invokerFiles(tracked())).length !== 0) {
    fails.push('a gate that exists nowhere was reported as wired');
  }
  // (b) comment-only references MUST NOT count as wiring — this is the SEC-36 shape exactly
  const commentOnlyJs = strip('// runs scripts/check-thing.mjs nightly\nconsole.log(1);', 'x.mjs');
  if (commentOnlyJs.includes('check-thing.mjs')) fails.push('a JS comment reference counted as an invocation');
  const commentOnlySh = strip('# see scripts/check-thing.sh\necho hi', 'x.sh');
  if (commentOnlySh.includes('check-thing.sh')) fails.push('a shell comment reference counted as an invocation');
  const commentOnlyYml = strip('      # mentions scripts/check-thing.mjs in prose\n      run: true', 'w.yml');
  if (commentOnlyYml.includes('check-thing.mjs')) fails.push('a YAML comment reference counted as an invocation');
  // (c) a REAL invocation must survive the strip
  const realJs = strip('execFileSync("node", ["scripts/check-thing.mjs"]);', 'x.mjs');
  if (!realJs.includes('check-thing.mjs')) fails.push('a real invocation was stripped away');
  // (c2) THE REGRESSION: a workflow whose globs/crons contain `/**` and `*/` must not have its
  // run: lines eaten by a JS block-comment regex. This is the bug that made two wired gates
  // report as orphans while this script was being written.
  const yamlWithGlobs = strip(
    "on:\n  push:\n    paths-ignore:\n      - 'ops/scripts/**'\n      - 'activation-funnel/snapshots/**'\njobs:\n  x:\n    steps:\n      - run: node scripts/check-thing.mjs --check\n",
    'deploy.yml',
  );
  if (!yamlWithGlobs.includes('check-thing.mjs')) {
    fails.push('a YAML run: line was destroyed by comment-stripping (glob `/**` … `*/` swallow)');
  }
  // (d) the gate glob must actually match the known gate shapes
  const globbed = gateScripts(['scripts/check-mcp-stateless.mjs', 'scripts/check_mobile_nav_parity.sh', 'scripts/security-canary.mjs', 'scripts/build_nav.mjs']);
  if (globbed.length !== 3) fails.push(`gate glob matched ${globbed.length}/3 known gate shapes`);
  return fails;
}

if (argv.includes('--self-test')) {
  const fails = selfTest();
  if (fails.length) { console.error('✖ canary-wiring self-test FAILED:'); fails.forEach((f) => console.error('   - ' + f)); process.exit(1); }
  console.log('✓ canary-wiring self-test passed (detects an orphan; comment mentions do not count as wiring)');
  process.exit(0);
}

const stFails = selfTest();
if (stFails.length) {
  console.error('✖ canary-wiring self-test FAILED — refusing to report a vacuous pass:');
  stFails.forEach((f) => console.error('   - ' + f));
  process.exit(1);
}

const { rows, orphans } = audit();
for (const [gate, reason] of ALLOWLIST) console.log(`  ⚠ allowlisted (not wired): ${gate} — ${reason}`);
if (orphans.length) {
  console.error(`✖ ${orphans.length} committed gate script(s) are invoked by NOTHING:`);
  for (const o of orphans) console.error(`   - ${o.gate}`);
  console.error('\n  A gate nobody runs is theatre — it reads as coverage while protecting nothing.');
  console.error('  Wire it into .github/workflows/, a package.json script, a committed ops/cron');
  console.error('  wrapper, or ops/monitoring/monitoring-inventory.json — or add it to ALLOWLIST');
  console.error('  in this file WITH a reason.');
  process.exit(1);
}
console.log(`✓ canary wiring: all ${rows.length} committed gate scripts are invoked by something.`);
for (const r of rows) console.log(`    ${r.gate}  ←  ${r.refs.slice(0, 2).join(', ')}${r.refs.length > 2 ? ` (+${r.refs.length - 2})` : ''}`);
process.exit(0);

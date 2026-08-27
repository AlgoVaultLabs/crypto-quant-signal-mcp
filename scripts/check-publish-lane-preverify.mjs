#!/usr/bin/env node
/**
 * check-publish-lane-preverify.mjs — OPS-PUBLISH-LANE-PRE-VERIFY-W1 R2.
 *
 * REHEARSE THE PUBLISH LANE WITHOUT PUBLISHING.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────────────────────
 * `.github/workflows/publish-npm.yml` is the only lane in this repo with no pre-merge exercise.
 * Its steps run exclusively during a real publish, which happens only AFTER scripts/land.sh has
 * landed, the tag is cut, the Release is published and prod is deployed. Three releases in a row
 * discovered a lane defect at that moment — v1.28.0 (missing fetch-depth), v1.28.2 (injector /
 * docs-rebuild ordering), and the v1.23.3 / v1.24.0 NODE_AUTH_TOKEN-over-OIDC failure.
 *
 * tests/unit/publish-lane-invariants.test.ts pins the four properties STATICALLY, at the commit
 * that would regress them. This script owns what a static test cannot see: EMERGENT breakage —
 * the v1.28.2 case exactly, where every step was individually correct and only their interaction
 * was wrong. It reproduces the lane's fallible legs on an ordinary day instead of at a release.
 *
 * ── WHY `npm pack` ALONE WOULD PROVE NOTHING ────────────────────────────────────────────────
 * Per npm's own documented lifecycle (npm Docs, Scripts, CLI v11):
 *
 *   npm pack     → prepack → prepare → postpack                       — NO prepublishOnly
 *   npm publish  → prepublishOnly → prepack → prepare → postpack → …  — prepublishOnly FIRST
 *
 * `prepublishOnly` is where this repo's 23-step gate chain lives, and it is the chain that has
 * broken twice. A rehearsal built on `npm pack` alone would silently skip it. So this runs the
 * literal `npm run prepublishOnly` FIRST and `npm pack --dry-run` AFTER — that sequencing mirrors
 * the documented publish lifecycle and is deliberate, not incidental.
 *
 * It runs `npm run prepublishOnly` as npm's own lifecycle invocation rather than re-executing the
 * chain segment by segment. Fidelity is the point: npm sets npm_lifecycle_event, the npm_package_*
 * env and the node_modules/.bin PATH, and a gate that behaves differently without them is exactly
 * the class of defect this rehearsal exists to catch.
 *
 * ── STRUCTURALLY INCAPABLE OF PUBLISHING ────────────────────────────────────────────────────
 * There is no registry write anywhere in this file, its caller requests no `id-token: write`, and
 * the job carries no npm credential. `--dry-run` on the pack is belt-and-braces, not the control:
 * the control is that the publishing verb is never invoked and the token to perform it is never
 * minted. The workflow's own test asserts both, after stripping comments — a mention in prose is
 * not an invocation, which is the same rule scripts/check-canaries-wired.mjs already applies.
 *
 * ── VERDICT CONTRACT ────────────────────────────────────────────────────────────────────────
 * Exactly one terminal PUBLISH_LANE_PREVERIFY_VERDICT=PASS|FAIL|INDETERMINATE.
 * Exit 0=PASS / 1=FAIL / 3=INDETERMINATE — 3 is the token-law default for a NEW gate.
 * Callers gate on the TOKEN, never the bare exit code.
 *
 *   FAIL-OPEN ON TRANSPORT, FAIL-CLOSED ON CONTENT. The injector and four gates inside the chain
 *   reach live sources. A third party being down is not our lane breaking, so a transport
 *   signature or a sub-gate's own INDETERMINATE token downgrades the verdict to INDETERMINATE —
 *   never to FAIL, and never up to PASS.
 *
 *   VACUITY GUARD AT THE POINT THE CORPUS IS CONSTRUCTED. WE choose to run the chain, so a run in
 *   which it did not execute means this script did nothing — a defect here, not a fact about the
 *   lane. REFUSE: INDETERMINATE, never PASS. Executed-ness is read from npm's own lifecycle banner
 *   (npm echoes the whole `&&` chain, which is compared against package.json's declaration) plus
 *   the count of verdict tokens the chain emitted. Both are printed, so a green result is
 *   distinguishable from one that ran nothing.
 *
 * ── NO TELEGRAM LEG, DELIBERATELY ───────────────────────────────────────────────────────────
 * ops/monitoring/alert-registry.json is the real registry (65 rows) and it is derived from
 * send_telegram.sh call sites plus monitoring-inventory.json[].alert_ids. A CI-only job has
 * neither: send_telegram.sh's 24h cooldown is a marker file under /opt/algovault-monitoring that
 * an ephemeral runner cannot persist, and CI must never hold prod credentials. An alert from here
 * would ship without the safeguard CLAUDE.md requires of it. The named red workflow step IS the
 * operator signal — the same decision, for the same reason, already recorded on
 * `docs-samples-live-canary` and twice in deploy.yml.
 *
 * Usage:
 *   node scripts/check-publish-lane-preverify.mjs             # rehearse the lane
 *   node scripts/check-publish-lane-preverify.mjs --self-test # prove the classifier both ways
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'PUBLISH_LANE_PREVERIFY_VERDICT';

/** 0=PASS / 1=FAIL / 3=INDETERMINATE. ONE meaning, ONE code, chosen locally. */
export const EXIT = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

/**
 * The lane steps this rehearsal reproduces, in order. Anchored by the STRING each step runs, never
 * by a line number — the lane's line numbers shift on every prose edit.
 *
 * publish-npm.yml :111-:167 (checkout with fetch-depth 0 / Node 24 / npm@11.18.0 / npm ci /
 * npm run build) are the CALLER's job: they are runner setup and belong in the workflow, where
 * they stay visibly one-to-one with the lane.
 *
 * The ancestor-of-origin/main guard at :128 is deliberately NOT mirrored, and the reason is not
 * an oversight: it refuses any tree that is not an ancestor of origin/main, which is EVERY pull
 * request head. Mirroring it would make the rehearsal refuse itself on the exact trigger that
 * makes it useful. Its absence is safe here precisely because this job cannot publish — the guard
 * protects a registry write that does not exist on this path. It stays pinned by
 * tests/unit/publish-lane-invariants.test.ts and tests/unit/ci-git-context.test.ts.
 */
export const MIRRORED_LANE_STEPS = [
  { id: 'injector', cmd: ['node', ['scripts/snapshot-landing-data.mjs']], lane: 'Refresh README track-record numbers (snapshot injector)' },
  { id: 'docs-rebuild', cmd: ['node', ['scripts/build_docs.mjs']], lane: 'Rebuild generated docs after injection (keeps prepublishOnly self-consistent)' },
];

/**
 * Declared transport signatures. A DECLARED list, never an open-ended "looks like a network
 * error" heuristic: fail-open is a lever, and a lever whose trigger is fuzzy launders content
 * failures into INDETERMINATE.
 */
export const TRANSPORT_SIGNATURES = [
  'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH',
  'ENETUNREACH', 'ESOCKETTIMEDOUT', 'ERR_SOCKET_CONNECTION_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT',
  'getaddrinfo', 'fetch failed', 'socket hang up', 'network timeout',
  'HTTP 429', 'HTTP 502', 'HTTP 503', 'HTTP 504',
];

/** Any `<GATE>_VERDICT=<STATE>` line the chain emitted. */
export function verdictTokens(output) {
  return [...String(output ?? '').matchAll(/^([A-Z0-9_]+_VERDICT)=([A-Z_]+)/gm)].map((m) => ({
    gate: m[1],
    state: m[2],
  }));
}

/** True when the output carries a declared transport signature or a sub-gate's own fail-open. */
export function looksTransport(output) {
  const s = String(output ?? '');
  if (TRANSPORT_SIGNATURES.some((sig) => s.includes(sig))) return true;
  return verdictTokens(s).some((t) => t.state === 'INDETERMINATE');
}

/** The `&&` chain npm echoes for a lifecycle script, or null when no banner was printed. */
export function echoedChain(output, scriptName) {
  const re = new RegExp(`^> [^\\n]*${scriptName}\\n> ([^\\n]+)$`, 'm');
  const m = re.exec(String(output ?? ''));
  return m ? m[1].trim() : null;
}

/** Segments of an `a && b && c` chain. Fewer than two means the parse, not the chain, is wrong. */
export function chainSegments(chain) {
  if (typeof chain !== 'string' || chain.trim() === '') return [];
  return chain.split('&&').map((s) => s.trim()).filter(Boolean);
}

/**
 * THE CLASSIFIER. Pure, so the self-test exercises the real thing rather than a paraphrase of it.
 *
 * @param {{ranEarlySteps:boolean, earlyOutput:string, prepublishRan:boolean, prepublishExit:number|null,
 *           prepublishOutput:string, declaredChain:string, packExit:number|null, packOutput:string}} r
 */
export function classify(r) {
  const lines = [];

  // ── Vacuity, first and unconditionally. A run that executed nothing must never report PASS. ──
  const echoed = echoedChain(r.prepublishOutput, 'prepublishOnly');
  const declaredSegments = chainSegments(r.declaredChain);
  const echoedSegments = chainSegments(echoed);
  const tokens = verdictTokens(r.prepublishOutput);

  lines.push(`prepublishOnly declared segments : ${declaredSegments.length}`);
  lines.push(`prepublishOnly echoed segments   : ${echoedSegments.length}`);
  lines.push(`verdict-emitting gates observed  : ${tokens.length}${tokens.length ? ` (${tokens.map((t) => t.gate).join(', ')})` : ''}`);
  lines.push(`prepublishOnly exit              : ${r.prepublishExit === null ? 'not run' : r.prepublishExit}`);

  if (declaredSegments.length < 2) {
    return { verdict: 'INDETERMINATE', reason: 'package.json declares no parseable prepublishOnly chain — the rehearsal has nothing to reproduce', lines };
  }
  if (!r.prepublishRan || echoed === null) {
    return { verdict: 'INDETERMINATE', reason: 'npm printed no prepublishOnly lifecycle banner — the chain did not execute, so this run verified nothing', lines };
  }
  if (echoed !== r.declaredChain.trim()) {
    return { verdict: 'INDETERMINATE', reason: 'the chain npm ran differs from the chain package.json declares — the rehearsal cannot say what it exercised', lines };
  }
  if (tokens.length === 0) {
    return { verdict: 'INDETERMINATE', reason: 'the chain emitted ZERO verdict tokens — it was skipped, cached or short-circuited', lines };
  }

  // ── Transport fails OPEN. A third party being down is not our lane breaking. ──
  if (looksTransport(r.earlyOutput)) {
    return { verdict: 'INDETERMINATE', reason: 'a mirrored lane step could not reach its live source', lines };
  }
  if (r.prepublishExit !== 0 && looksTransport(r.prepublishOutput)) {
    return { verdict: 'INDETERMINATE', reason: 'prepublishOnly failed against an unreachable live source', lines };
  }
  if (r.packExit !== null && r.packExit !== 0 && looksTransport(r.packOutput)) {
    return { verdict: 'INDETERMINATE', reason: 'npm pack failed against an unreachable registry', lines };
  }

  // ── Content fails CLOSED. ──
  if (!r.ranEarlySteps) {
    return { verdict: 'FAIL', reason: 'a mirrored lane step (injector / docs rebuild) failed', lines };
  }
  if (r.prepublishExit !== 0) {
    const last = tokens[tokens.length - 1];
    return {
      verdict: 'FAIL',
      reason: `prepublishOnly failed (exit ${r.prepublishExit}) after ${tokens.length} verdict-emitting gate(s)` +
        `${last ? `; last gate reached: ${last.gate}=${last.state}` : ''}`,
      lines,
    };
  }
  if (r.packExit !== null && r.packExit !== 0) {
    return { verdict: 'FAIL', reason: `npm pack --dry-run failed (exit ${r.packExit})`, lines };
  }
  return { verdict: 'PASS', reason: 'the publish lane rehearsed clean', lines };
}

/**
 * The tail of a failing chain's output — where the gate that died prints its own diagnosis.
 *
 * The one-line `reason` can only name the last gate that got as far as EMITTING a token, which on
 * a real failure is the gate BEFORE the broken one — measured on the v1.28.2 reproduction, the
 * reason read "last gate reached: QUOTA_SURFACE_CONFORMANCE_VERDICT=PASS" while the step that
 * actually failed was the NEXT segment, `build_docs.mjs --check`. A summary that names a PASSING
 * gate and nothing else is a summary an operator misreads. npm does not echo per-segment, so there
 * is no honest way to compute the failing segment's name — but the failing gate always prints its
 * own reason immediately before dying, so surface that verbatim rather than inventing a mapping.
 */
export function failureTail(output, lines = 12) {
  return String(output ?? '')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-lines);
}

/** Files `npm pack --dry-run` would ship. Reported, never asserted — R3 owns the shipped set. */
export function packedEntries(output) {
  return [...String(output ?? '').matchAll(/^npm notice \d+(?:\.\d+)?\s*[kMG]?B\s+(\S+)$/gm)].map((m) => m[1]);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  return { code: res.status === null ? 1 : res.status, output, spawnError: res.error ?? null };
}

function rehearse() {
  const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const declaredChain = String(pkg.scripts?.prepublishOnly ?? '');

  let ranEarlySteps = true;
  let earlyOutput = '';
  for (const step of MIRRORED_LANE_STEPS) {
    const [bin, args] = step.cmd;
    console.log(`─── mirroring lane step: ${step.lane}`);
    const r = run(bin, args);
    earlyOutput += r.output;
    process.stdout.write(r.output);
    if (r.code !== 0) {
      ranEarlySteps = false;
      console.log(`─── ${step.id} exited ${r.code}`);
      break;
    }
  }

  let prepublishRan = false;
  let prepublishExit = null;
  let prepublishOutput = '';
  if (ranEarlySteps || looksTransport(earlyOutput)) {
    console.log('─── running the literal `npm run prepublishOnly` (npm lifecycle, not a re-execution)');
    const r = run('npm', ['run', 'prepublishOnly']);
    prepublishRan = true;
    prepublishExit = r.code;
    prepublishOutput = r.output;
    process.stdout.write(r.output);
  }

  let packExit = null;
  let packOutput = '';
  if (prepublishExit === 0) {
    console.log('─── collecting the file manifest with `npm pack --dry-run`');
    const r = run('npm', ['pack', '--dry-run']);
    packExit = r.code;
    packOutput = r.output;
    process.stdout.write(r.output);
  }

  const result = classify({
    ranEarlySteps, earlyOutput, prepublishRan, prepublishExit, prepublishOutput,
    declaredChain, packExit, packOutput,
  });

  const entries = packedEntries(packOutput);
  console.log('');
  console.log('─── publish-lane rehearsal ───────────────────────────────────────────');
  for (const l of result.lines) console.log(`  ${l}`);
  console.log(`  npm pack --dry-run entries       : ${packExit === null ? 'not collected (prepublishOnly did not pass)' : entries.length}`);
  console.log(`  reason                           : ${result.reason}`);
  if (result.verdict !== 'PASS') {
    const failing = packExit !== null && packExit !== 0 ? packOutput : prepublishExit !== 0 ? prepublishOutput : earlyOutput;
    const tail = failureTail(failing);
    if (tail.length) {
      console.log('  the failing step said:');
      for (const l of tail) console.log(`    | ${l}`);
    }
  }
  console.log('');
  console.log(`${TOKEN}=${result.verdict}`);
  return EXIT[result.verdict];
}

// ───────────────────────────────────────────────────────────────────────────────────────────────

function selfTest() {
  let passed = 0;
  let failed = 0;
  const check = (name, fn) => {
    let ok = false;
    let detail = '';
    try {
      ok = fn() === true;
    } catch (e) {
      detail = ` (threw: ${e && e.message})`;
    }
    if (ok) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.log(`  ✗ ${name}${detail}`); }
  };

  const CHAIN = 'npm run build && node scripts/a.mjs && node scripts/b.mjs';
  const BANNER = `\n> pkg@1.0.0 prepublishOnly\n> ${CHAIN}\n`;
  const GREEN = `${BANNER}A_VERDICT=PASS\nB_VERDICT=PASS\n`;
  const base = {
    ranEarlySteps: true, earlyOutput: '', prepublishRan: true, prepublishExit: 0,
    prepublishOutput: GREEN, declaredChain: CHAIN, packExit: 0,
    packOutput: 'npm notice 1.2kB dist/index.js\nnpm notice 400B README.md\n',
  };

  console.log('── the classifier, both directions ──');
  check('a clean rehearsal is PASS', () => classify(base).verdict === 'PASS');
  check('a content failure is FAIL', () => classify({ ...base, prepublishExit: 1, prepublishOutput: `${BANNER}A_VERDICT=PASS\nB_VERDICT=FAIL\n` }).verdict === 'FAIL');
  check('a FAIL names the last gate reached', () => classify({ ...base, prepublishExit: 1, prepublishOutput: `${BANNER}A_VERDICT=PASS\nB_VERDICT=FAIL\n` }).reason.includes('B_VERDICT=FAIL'));
  check('a failed pack is FAIL', () => classify({ ...base, packExit: 1, packOutput: 'npm ERR! bad manifest' }).verdict === 'FAIL');
  check('a failed mirrored lane step is FAIL', () => classify({ ...base, ranEarlySteps: false }).verdict === 'FAIL');

  console.log('── fail-OPEN on transport, never FAIL ──');
  for (const sig of TRANSPORT_SIGNATURES) {
    check(`transport signature "${sig}" downgrades to INDETERMINATE`, () =>
      classify({ ...base, prepublishExit: 1, prepublishOutput: `${GREEN}npm ERR! ${sig} while fetching` }).verdict === 'INDETERMINATE');
  }
  check("a sub-gate's own INDETERMINATE downgrades to INDETERMINATE", () =>
    classify({ ...base, prepublishExit: 3, prepublishOutput: `${BANNER}A_VERDICT=PASS\nB_VERDICT=INDETERMINATE\n` }).verdict === 'INDETERMINATE');
  check('an unreachable mirrored lane step is INDETERMINATE, not FAIL', () =>
    classify({ ...base, ranEarlySteps: false, earlyOutput: 'fetch failed' }).verdict === 'INDETERMINATE');
  check('a pack failing on transport is INDETERMINATE', () =>
    classify({ ...base, packExit: 1, packOutput: 'npm ERR! ETIMEDOUT' }).verdict === 'INDETERMINATE');

  console.log('── vacuity: a run that verified nothing is never PASS ──');
  check('no lifecycle banner is INDETERMINATE', () =>
    classify({ ...base, prepublishOutput: 'A_VERDICT=PASS\n' }).verdict === 'INDETERMINATE');
  check('prepublishOnly never invoked is INDETERMINATE', () =>
    classify({ ...base, prepublishRan: false, prepublishExit: null, prepublishOutput: '' }).verdict === 'INDETERMINATE');
  check('zero verdict tokens is INDETERMINATE even at exit 0', () =>
    classify({ ...base, prepublishOutput: BANNER }).verdict === 'INDETERMINATE');
  check('an echoed chain differing from the declared one is INDETERMINATE', () =>
    classify({ ...base, declaredChain: `${CHAIN} && node scripts/c.mjs` }).verdict === 'INDETERMINATE');
  check('an unparseable declared chain is INDETERMINATE', () =>
    classify({ ...base, declaredChain: 'npm run build' }).verdict === 'INDETERMINATE');

  // A HERMETIC self-test is structurally blind to exactly what its own seam replaces: every case
  // above hands `classify` a STRING that the real run gets from spawnSync. So the parsers that sit
  // on that seam are asserted directly, on shapes npm really emits.
  console.log('── the bypassed seam: parsers the fixtures above would never exercise ──');
  const REAL_BANNER = '\n> crypto-quant-signal-mcp@1.28.2 prepublishOnly\n> npm run build && node scripts/x.mjs --check\n';
  check('echoedChain reads npm\'s real two-line banner', () =>
    echoedChain(REAL_BANNER, 'prepublishOnly') === 'npm run build && node scripts/x.mjs --check');
  check('echoedChain returns null when no banner was printed', () => echoedChain('no banner here', 'prepublishOnly') === null);
  check('chainSegments splits a real && chain', () => chainSegments('a && b && c').length === 3);
  check('chainSegments refuses an empty chain', () => chainSegments('').length === 0);
  check('verdictTokens reads a real token line', () => verdictTokens('X_VERDICT=INDETERMINATE\n')[0].state === 'INDETERMINATE');
  check('verdictTokens ignores a token mentioned mid-line (prose is not a verdict)', () =>
    verdictTokens('see X_VERDICT=PASS above\n').length === 0);
  check('packedEntries reads npm pack --dry-run notice lines', () =>
    packedEntries('npm notice 1.2kB dist/index.js\nnpm notice 400B README.md\n').length === 2);
  check('packedEntries on empty output is empty, and that is a FACT not a pass', () => packedEntries('').length === 0);
  check('failureTail surfaces the failing gate\'s own diagnosis, which `reason` cannot name', () => {
    const t = failureTail('A_VERDICT=PASS\n\nbuild_docs --check: 1 problem(s):\n  docs.html DRIFT vs generated\n', 2);
    return t.length === 2 && t[1].includes('docs.html DRIFT');
  });
  check('failureTail on empty output is empty rather than throwing', () => failureTail('').length === 0);

  // Proven able to fail: assert the negative direction of the two levers that could silently
  // launder a red into a green.
  console.log('── proven able to fail ──');
  check('a NON-transport content failure is NOT laundered to INDETERMINATE', () =>
    classify({ ...base, prepublishExit: 1, prepublishOutput: `${GREEN}npm ERR! docs.html DRIFT` }).verdict === 'FAIL');
  check('looksTransport does not fire on ordinary content output', () => looksTransport(GREEN) === false);

  console.log('');
  console.log(`  self-test: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`${TOKEN}=FAIL`);
    return EXIT.FAIL;
  }
  if (passed === 0) {
    // WE build this corpus, so zero assertions means the self-test built nothing. REFUSE.
    console.log(`${TOKEN}=INDETERMINATE`);
    return EXIT.INDETERMINATE;
  }
  console.log(`${TOKEN}=PASS`);
  return EXIT.PASS;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  let code;
  try {
    code = args.includes('--self-test') ? selfTest() : rehearse();
  } catch (e) {
    // Never die without a token — process death with no verdict is the one outcome the token law
    // forbids outright.
    console.log(`  fatal: ${e && e.message}`);
    console.log(`${TOKEN}=INDETERMINATE`);
    code = EXIT.INDETERMINATE;
  }
  process.exit(code);
}

if (!existsSync(path.join(REPO, 'package.json'))) {
  // Importable-from-elsewhere safety: the module must not silently resolve a wrong repo root.
  throw new Error(`check-publish-lane-preverify: no package.json at ${REPO}`);
}

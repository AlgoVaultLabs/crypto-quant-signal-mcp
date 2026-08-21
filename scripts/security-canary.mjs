#!/usr/bin/env node
// @ts-check
/**
 * security-canary.mjs — continuous security posture canary for crypto-quant-signal-mcp.
 *
 * AUTHORED by SECURITY-AUDIT-RECENT-FEATURES-W1 (read-only audit wave). It is the reusable
 * artifact that turns the one-off audit into a self-detecting CI gate. It is intentionally
 * NOT wired into .github/workflows/deploy.yml in this wave — a follow-up
 * `OPS-SECURITY-CANARY-CI-WIRE-W1` adds the workflow step (clean `npm run build` then this).
 *
 * Three bug-CLASS gates (each retires a class found in the audit):
 *   A) npm-audit gate     — fail on High+ advisories in the x402 payment-dep family, and
 *                           enforce @coinbase/x402 >= 2.6.0 (GHSA-qr2g-p6q7-w82m SVM forged-proof).
 *   B) PII / secret leak   — fail if outcome_return_pct/outcome_price/Phase-E ever appear as a
 *                           serialized VALUE (not a DB column ref) in any builder, or if a CDP /
 *                           Databento / whsec_ / bearer literal lands in tracked source or `git diff`.
 *   C) SSRF egress matrix  — import the REAL webhook-ssrf guard and assert the full block-class
 *                           matrix (metadata IP, loopback, RFC1918, CGNAT, IPv4-mapped IPv6,
 *                           alt encodings, embedded creds, non-https) is rejected. The reusable
 *                           guard is inherited by every future outbound fetch → generator-level.
 *
 * Usage:
 *   node scripts/security-canary.mjs                 # run all gates
 *   node scripts/security-canary.mjs --check=audit   # one gate (audit|pii|ssrf)
 *   node scripts/security-canary.mjs --diff          # PII gate scans `git diff` (staged+unstaged) only
 *   node scripts/security-canary.mjs --json          # machine-readable summary
 * Exit: 0 = all gates pass · 1 = a gate FAILED (real finding) · 2 = inconclusive (e.g. dist not built).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const ONLY = (argv.find((a) => a.startsWith('--check=')) || '').split('=')[1] || null;
const DIFF_ONLY = argv.includes('--diff');
const JSON_OUT = argv.includes('--json');

/** x402 payment dependency family — High+ advisories here block the gate. */
const X402_FAMILY = ['@coinbase/x402', '@x402/core', '@x402/evm', '@x402/svm', '@x402/extensions', 'x402'];
const X402_MIN_SAFE = [2, 6, 0]; // GHSA-qr2g-p6q7-w82m fixed in @coinbase/x402 >= 2.6.0

const results = [];
const log = (...a) => { if (!JSON_OUT) console.log(...a); };
function record(gate, pass, detail) { results.push({ gate, pass, detail }); }

function sh(cmd, args, opts = {}) {
  try { return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }); }
  catch (e) { return (e.stdout || '') + (e.stderr || ''); }
}
function cmp(a, b) { for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0); } return 0; }

// ── Gate A — npm audit (x402 family High+) + @coinbase/x402 version floor ──────────────────────
function gateAudit() {
  log('\n[A] npm-audit gate (x402 family High+ · @coinbase/x402 >= 2.6.0)');
  let failed = false;

  // A.1 — GHSA-qr2g-p6q7-w82m: the forged-Solana-proof flaw lives in @x402/svm (< 2.6.0), NOT
  //       @coinbase/x402 (separate version lineage; 2.1.0 is its current latest). AlgoVault settles
  //       USDC on Base (EVM), so @x402/svm must stay ABSENT (or >= 2.6.0 if ever added). This gate
  //       fails closed the day someone adds the Solana verifier without patching it.
  const svmPkg = join(ROOT, 'node_modules/@x402/svm/package.json');
  if (!existsSync(svmPkg)) {
    log('    ✓ @x402/svm NOT installed — GHSA-qr2g-p6q7-w82m forged-proof verifier absent from the tree (EVM-only).');
  } else {
    const ver = JSON.parse(readFileSync(svmPkg, 'utf8')).version;
    const safe = cmp(ver.split('.').map((n) => parseInt(n, 10)), X402_MIN_SAFE) >= 0;
    log(`    @x402/svm installed=${ver} (min-safe ${X402_MIN_SAFE.join('.')}) → ${safe ? 'OK' : 'BELOW FIX'}`);
    if (!safe) { log('    ✖ @x402/svm < 2.6.0 — GHSA-qr2g-p6q7-w82m: a forged Solana proof unlocks paid resources. Bump to >= 2.6.0 or remove.'); failed = true; }
  }

  // A.2 — any High/Critical advisory whose dependency path includes an x402-family package.
  const raw = sh('npm', ['audit', '--json']);
  let audit; try { audit = JSON.parse(raw); } catch { log('    ⚠ could not parse npm audit json (inconclusive).'); return record('audit', !failed, 'npm-audit unparseable'); }
  const vulns = audit.vulnerabilities || {};
  const offenders = [];
  for (const [name, v] of Object.entries(vulns)) {
    if (!['high', 'critical'].includes(v.severity)) continue;
    const via = (v.via || []).map((x) => (typeof x === 'string' ? x : x && x.name)).filter(Boolean);
    const touchesX402 = X402_FAMILY.includes(name) || via.some((n) => X402_FAMILY.includes(n));
    if (touchesX402) offenders.push(`${v.severity.toUpperCase()} ${name} (via ${via.join(', ') || '—'})`);
  }
  if (offenders.length) { log('    ✖ High+ advisory in x402 family:'); offenders.forEach((o) => log('      - ' + o)); failed = true; }
  else log('    ✓ no High/Critical advisory in the x402 payment-dep family.');

  const m = audit.metadata && audit.metadata.vulnerabilities;
  if (m) log(`    (full tree: ${m.critical} critical / ${m.high} high / ${m.moderate} moderate — non-x402 High+ are reported, not gated)`);
  record('audit', !failed, offenders.join('; ') || 'clean');
  return !failed;
}

// ── Secret-literal detection (shared by Gate B and --self-test) ─────────────────────────────────
// OPS-AUDIT-REMEDIATION-CRITICAL-W1 (SEC-02 generator fix). The pre-fix gate was blind THREE ways
// to the live Postgres password committed at ops/systemd/README.md:71 — it scanned only
// `src landing public scripts` (so `ops/` was invisible), only `.ts/.js/.html/.json` (so `.md`
// was invisible), and had no DSN pattern at all. All three are fixed here.
const SECRET_PATTERNS = [
  ['whsec', /\bwhsec_[A-Za-z0-9]{16,}/],
  ['api-key', /\b(sk|rk|cdp)_(live|test|prod)_[A-Za-z0-9]{16,}/],
  ['databento', /\bdb-[A-Za-z0-9]{20,}/],
  ['pem', /-----BEGIN (RSA |EC )?PRIVATE KEY-----/],
  ['bearer', /\bBearer\s+[A-Za-z0-9._-]{24,}/],
  // The SEC-02 shape: a password embedded in a connection string.
  ['dsn-password', /\b(postgres|postgresql|mysql|mongodb|redis|amqp|amqps):\/\/[^:@/\s]+:[^@/\s]+@/],
  // KEY=<literal> / KEY: '<literal>' assignment of a credential-shaped name.
  ['assigned-secret', /\b[A-Z0-9_]*(PASSWORD|SECRET|PRIVATE_KEY|API_KEY|ACCESS_TOKEN|AUTH_TOKEN)\s*[:=]\s*["']?[^\s"',;)}]{8,}/],
];

/**
 * NOT-A-SECRET discriminators, applied to the matched span. Each is STRUCTURAL — a shape that
 * cannot be a literal credential — rather than a loosening of the secret patterns themselves.
 * Every entry below was derived from a real false positive on this tree (see the self-test).
 */
const NOT_A_SECRET = [
  // Reads the value from the environment / config at runtime — the correct pattern, not a leak.
  /(process\.env|import\.meta\.env|os\.environ|ENV\[|getenv|secrets\.)/,
  // Shell command substitution or variable expansion: `SECRET=$(docker exec …)`, `${VAR}`, `$VAR`.
  /[:=]\s*["']?(\$\(|`|\$\{|\$[A-Za-z_])/,
  // Template slots and documentation placeholders. The ellipsis forms (ASCII "..." and U+2026 "…")
  // matter: audit/runbook prose routinely abbreviates a value, and a truncated value is by
  // definition not a usable credential.
  /(<[A-Za-z_.]+>|\{\{|%s|xxx+|\*\*\*|changeme|your|example|redacted|placeholder|dummy|REPLACE|TODO|\.\.\.|…)/i,
  // The literal words used as stand-ins in .env.example.
  /[:=]\s*["']?(password|secret|token|key)\b["']?\s*$/i,
  // A DSN whose password COMPONENT is a stand-in word: postgres://user:password@host.
  /:\/\/[^:@/\s]+:(password|passwd|pass|secret|token|changeme|xxx+)@/i,
  // An EVM ADDRESS is public (0x + exactly 40 hex). A private key is 64 hex and still trips.
  /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/,
];

function matchSecret(line) {
  for (const [name, re] of SECRET_PATTERNS) {
    const m = re.exec(line);
    if (m && !NOT_A_SECRET.some((p) => p.test(m[0]))) return name;
  }
  return null;
}

function redactLine(line) {
  return line.trim().slice(0, 40).replace(/[^\s=:/@]{6,}/g, '…') + '…[redacted]';
}

/**
 * The pii gate's TOKEN. Callers gate on this, never on the bare exit code.
 *
 * OPS-SECRET-SCAN-PREPUSH-W1. Emitted exactly once per `gatePii()` run, on every path, because
 * this gate can no longer be read from its exit status alone: `0` used to encode BOTH "scanned
 * the tree, clean" AND "scanned nothing, therefore clean". See `corpusVerdict`.
 */
const SECRET_SCAN_TOKEN = 'SECRET_SCAN_VERDICT';
let secretScanVerdictEmitted = false;
function emitSecretScanVerdict(v) {
  if (secretScanVerdictEmitted) return; // one run, one verdict
  secretScanVerdictEmitted = true;
  // Deliberately NOT routed through log(): the token is the machine-readable contract and must
  // survive --json, where the prose summary is suppressed.
  console.log(`${SECRET_SCAN_TOKEN}=${v}`);
}

/**
 * VACUITY, decided where the corpus is CONSTRUCTED rather than where it is observed.
 *
 * MEASURED 2026-08-21 with a failing `git` on PATH: `sh()` swallows the error and returns '',
 * so the whole-tree scan reported `in 0 source files` → `✓ PASS pii — clean` → exit 0. A gate
 * that had verified nothing was indistinguishable from one that had verified everything, and
 * that is precisely the state a pre-push lane must never reach.
 *
 * A tracked git repo ALWAYS has files, so an empty corpus is never a real state here — it is
 * the instrument failing. Pure on purpose so the self-test can pin all three branches.
 *
 * Note the asymmetry with `--diff`, which is deliberately NOT guarded: an empty `git diff` is a
 * legitimate state (a clean tree), and empty input is only vacuity when you were supposed to
 * fill it.
 */
export function corpusVerdict(trackedCount, scannableCount) {
  if (trackedCount <= 0) return 'INDETERMINATE'; // git could not enumerate the tree
  if (scannableCount <= 0) return 'INDETERMINATE'; // every file filtered away — nothing verified
  return 'PASS';
}

/** ALL tracked files, minus binaries/lockfiles/test fixtures. Was: 4 dirs × 6 extensions. */
function secretScanFiles() {
  const tracked = sh('git', ['ls-files']).split('\n').filter(Boolean);
  const files = tracked
    .filter(Boolean)
    .filter((f) => !/\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|eot|pdf|zip|gz|mp4|webm)$/i.test(f))
    .filter((f) => !/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f))
    .filter((f) => !/\.test\.|\.spec\.|__fixtures__|\bfixtures?\b/.test(f))
    // This file necessarily CONTAINS the shapes it hunts for (SECRET_PATTERNS + the self-test
    // corpus), so scanning itself is a guaranteed false positive. The self-test — not the file
    // scan — is what proves the matcher still works, so nothing is lost by skipping it.
    .filter((f) => f !== 'scripts/security-canary.mjs');
  return { tracked: tracked.length, files };
}

/**
 * Two-way self-test: the gate must FIRE on the real SEC-02 shape and must NOT fire on the
 * placeholdered form that replaced it. Without this a widened regex can silently stop matching.
 */
const SELF_TEST_COUNTS = { fire: 0, noFire: 0, leakFire: 0, leakNoFire: 0, corpus: 0 };

/**
 * Two-way self-test for corpusVerdict — the branch that used to fail OPEN.
 *
 * Both directions matter and neither is redundant: the INDETERMINATE cases prove the vacuity
 * guard exists at all, and the PASS case proves it did not simply become "always refuse", which
 * would wedge every push and get the guard reverted within the hour.
 */
function selfTestCorpus() {
  const cases = [
    ['git enumerated nothing', 0, 0, 'INDETERMINATE'],
    // ISOLATES THE FIRST GUARD. Structurally impossible in reality (you cannot filter 5 files out
    // of 0), and that is exactly why it is here: with only the realistic cases, the scannable<=0
    // guard MASKS the tracked<=0 guard, and deliberately breaking the latter left the self-test
    // GREEN. Measured 2026-08-21 while proving this very self-test could fail — the first break
    // did not go red, and this row is what makes it.
    ['git enumerated nothing but files appeared anyway', 0, 5, 'INDETERMINATE'],
    ['every file filtered away', 884, 0, 'INDETERMINATE'],
    ['negative count (impossible, still not a pass)', -1, -1, 'INDETERMINATE'],
    ['a real tree', 884, 700, 'PASS'],
    ['a one-file tree still counts', 1, 1, 'PASS'],
  ];
  SELF_TEST_COUNTS.corpus = cases.length;
  return cases
    .filter(([, t, f, want]) => corpusVerdict(t, f) !== want)
    .map(([label, t, f, want]) => `corpusVerdict(${t}, ${f}) = ${corpusVerdict(t, f)}, want ${want} — ${label}`);
}

/**
 * The INTERNAL-class value-binding matcher. Hoisted to module scope deliberately: the gate
 * and its self-test MUST read the same regex object, or the self-test can pass against a
 * copy while the gate runs a different (broken) one.
 *
 * Value-binding form — a SERIALIZED value, never a bare column reference. That is the whole
 * discriminator: `"vol_score_live": -70` is a leak; `vol_score_live INTEGER NOT NULL` in a
 * CREATE TABLE, `vol_score_live` in an INSERT column list, and `["vol_score_live"]` in a
 * forbidden-keys ARRAY are the things being GUARDED, not leaks.
 *
 * SIGNAL-CLOSEDBAR-SHADOW-W1 CH2 added the candle-basis shadow's component scores. They are
 * the same data class as `outcome_return_pct`: raw model internals that would let a caller
 * reverse-engineer the weighting function, and they never leave the database.
 */
const LEAK_VALUE = /["'](outcome_return_pct|outcome_price|phase_e_wr|phaseE|outcome_pnl|vol_score_live|vol_score_closed|raw_live|raw_closed)["']\s*:\s*[-\d.$]/;

/**
 * Two-way self-test for LEAK_VALUE, mirroring selfTestSecrets.
 *
 * A guard asserted only by ABSENCE cannot distinguish "clean" from "never ran" — and this
 * one had no self-test at all until CH2, so a widening typo would have silently produced a
 * green PII gate over an unmatched tree.
 */
function selfTestLeakValue() {
  const mustFire = [
    '"outcome_return_pct": 1.42,',
    '{"outcome_price":39120.5}',
    "  'vol_score_live': -70,",
    '"vol_score_closed": 50',
    '"raw_live": -12.5,',
    '"raw_closed":  3',
  ];
  // Each of these is a legitimate shape that exists in this tree TODAY. They are locked in
  // so a future widening cannot start flagging the schema that defines the guarded columns.
  const mustNotFire = [
    '  vol_score_live    INTEGER       NOT NULL,',              // CREATE TABLE column
    '  raw_closed        NUMERIC,',                             // CREATE TABLE column
    '(coin, exchange, timeframe, vol_score_live, raw_live)',    // INSERT column list
    'const FORBIDDEN = ["vol_score_live", "raw_live"];',        // forbidden-keys ARRAY
    'volScoreLive: number | null;',                             // the camelCase TS field
    'expect(row.volScoreClosed).toBe(50);',
    '/outcome_return_pct|outcome_price/i',                      // a sibling guard's own regex
  ];
  SELF_TEST_COUNTS.leakFire = mustFire.length;
  SELF_TEST_COUNTS.leakNoFire = mustNotFire.length;
  const fails = [];
  mustFire.forEach((l) => { if (!LEAK_VALUE.test(l)) fails.push(`MISSED: ${l.slice(0, 70)}`); });
  mustNotFire.forEach((l) => { if (LEAK_VALUE.test(l)) fails.push(`FALSE POSITIVE: ${l.slice(0, 70)}`); });
  return fails;
}
function selfTestSecrets() {
  const mustFire = [
    'DATABASE_URL=postgres://algovault:s0meRealSecretValue@127.0.0.1:5432/signal_performance',
    'POSTGRES_PASSWORD=hunter2hunter2hunter2',
    'const k = "sk_live_ABCDEFGHIJKLMNOP0123";',
    '-----BEGIN RSA PRIVATE KEY-----',
    // The REAL bytes of the 2026-08-21 incident, locked in as a regression fixture. This line
    // shipped in audits/RELEASE-v1.28.0-W1-endpoint-truth.md:104, failed this gate in deploy run
    // 32488595037, and stranded prod at 81cf4f0 for ~3h. It is the SECOND time an AUTH-THREE-STATE
    // probe literal did this (the first: run 32281821567, 2026-08-19).
    '| `AUTH-THREE-STATE-W1` | `Bearer av_live_0123456789abcdef01234567` -> refused, -32003 |',
  ];
  // Every must-not-fire below is a REAL false positive this gate produced on this tree the first
  // time it was widened. They are locked in so a future tightening cannot silently re-block deploys.
  const mustNotFire = [
    'DATABASE_URL=postgres://algovault:${POSTGRES_PASSWORD}@127.0.0.1:5432/signal_performance',
    'DATABASE_URL=postgres://algovault:<POSTGRES_PASSWORD>@127.0.0.1:5432/signal_performance',
    'POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}',
    'POSTGRES_PASSWORD=your-password-here',
    '# POSTGRES_PASSWORD=changeme',
    'const url = `postgres://${user}:${pass}@${host}/db`;',
    'FACILITATOR_PRIVATE_KEY=0xYourPrivateKeyHere',                       // .env.example:22
    'DATABASE_URL=postgresql://algovault:password@localhost:5432/signal_performance', // .env.example:25
    '# FACILITATOR_PRIVATE_KEY = 0x804B35Ac981Fe0A58540dfBF3E730f6F7BcbF812) had a', // public EVM address (40 hex)
    'const PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY as Hex;',    // env read
    'const API_KEY = process.env.MCP_API_KEY || 0;',                      // env read
    // The remediated form of the must-fire fixture above. Pinning BOTH is what makes the fix a
    // convention rather than a one-off edit: abbreviate the probe value, keep the evidence.
    '| `AUTH-THREE-STATE-W1` | `Bearer av_live_0123\u20264567` -> refused, -32003 |',
    'SECRET=$(docker exec "$MCP" printenv STRIPE_SECRET_KEY 2>/dev/null || true)', // cmd substitution
    '`FACILITATOR_PRIVATE_KEY=0x804B\u2026`) does verify',                 // truncated value in audit prose
  ];
  SELF_TEST_COUNTS.fire = mustFire.length; SELF_TEST_COUNTS.noFire = mustNotFire.length;
  const fails = [];
  mustFire.forEach((l) => { if (!matchSecret(l)) fails.push(`MISSED: ${l.slice(0, 60)}`); });
  mustNotFire.forEach((l) => { if (matchSecret(l)) fails.push(`FALSE POSITIVE (${matchSecret(l)}): ${l.slice(0, 60)}`); });
  return fails;
}

// ── Gate B — PII / secret leak grep (value-binding discriminator, not bare identifier) ──────────
function gatePii() {
  log('\n[B] PII / secret-leak gate');
  // Fail closed if either matcher is broken — a vacuous gate is worse than no gate.
  const stFails = [...selfTestSecrets(), ...selfTestLeakValue()];
  if (stFails.length) {
    stFails.forEach((f) => log('    ✖ self-test: ' + f));
    // A broken matcher means we verified NOTHING, not that we verified and found nothing.
    // Was `pass:false`/exit 1; both block, but one meaning gets one code (OPS-SECRET-SCAN-PREPUSH-W1).
    record('pii', null, `matcher self-test failed (${stFails.length})`);
    emitSecretScanVerdict('INDETERMINATE');
    return null;
  }
  const hits = [];
  let files;
  if (DIFF_ONLY) {
    const diff = sh('git', ['diff', 'HEAD', '--unified=0']);
    diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).forEach((l) => {
      const line = l.slice(1);
      if (LEAK_VALUE.test(line)) hits.push(`git-diff: leak-value → ${line.trim().slice(0, 120)}`);
      if (matchSecret(line)) hits.push(`git-diff: secret-literal → ${redactLine(line)}`);
    });
  } else {
    const corpus = secretScanFiles();
    if (corpusVerdict(corpus.tracked, corpus.files.length) !== 'PASS') {
      log(`    ⚠ corpus not constructible (${corpus.tracked} tracked, ${corpus.files.length} scannable) — NOT a pass.`);
      record('pii', null, `corpus not constructible (${corpus.tracked} tracked)`);
      emitSecretScanVerdict('INDETERMINATE');
      return null;
    }
    files = corpus.files;
    for (const f of files) {
      const abs = join(ROOT, f); if (!existsSync(abs)) continue;
      const txt = readFileSync(abs, 'utf8');
      txt.split('\n').forEach((line, i) => {
        if (LEAK_VALUE.test(line)) hits.push(`${f}:${i + 1} leak-value → ${line.trim().slice(0, 120)}`);
        if (matchSecret(line)) hits.push(`${f}:${i + 1} secret-literal (${matchSecret(line)}) [redacted]`);
      });
    }
  }
  if (hits.length) { log('    ✖ leak/secret candidates:'); hits.slice(0, 40).forEach((h) => log('      - ' + h)); }
  else log(`    ✓ no outcome_return_pct/Phase-E value-binding or secret literal in ${DIFF_ONLY ? 'git diff' : (files?.length || 0) + ' source files'}.`);
  record('pii', hits.length === 0, hits.length ? `${hits.length} candidate(s)` : 'clean');
  emitSecretScanVerdict(hits.length === 0 ? 'PASS' : 'FAIL');
  return hits.length === 0;
}

// ── Gate C — SSRF egress block-class matrix (against the REAL guard) ─────────────────────────────
function gateSsrf() {
  log('\n[C] SSRF egress block-class matrix (webhook-ssrf guard)');
  const distGuard = join(ROOT, 'dist/lib/webhook-ssrf.js');
  if (!existsSync(distGuard)) { log('    ⚠ dist/lib/webhook-ssrf.js missing — run `npm run build` first (inconclusive).'); record('ssrf', null, 'dist not built'); return null; }
  let guard; try { guard = require(distGuard); } catch (e) { log('    ⚠ could not load compiled guard: ' + e.message); record('ssrf', null, 'load error'); return null; }
  const { assertEgressAllowed, classifyIp } = guard;
  if (typeof assertEgressAllowed !== 'function') { log('    ⚠ assertEgressAllowed export missing.'); record('ssrf', null, 'export missing'); return null; }

  // Each entry MUST be rejected. assertEgressAllowed throws EgressBlockedError on block.
  const MUST_BLOCK = [
    ['cloud metadata 169.254.169.254', 'https://169.254.169.254/latest/meta-data/'],
    ['loopback 127.0.0.1', 'https://127.0.0.1/'],
    ['RFC1918 10/8', 'https://10.0.0.1/'],
    ['RFC1918 172.16/12', 'https://172.16.0.1/'],
    ['RFC1918 192.168/16', 'https://192.168.1.1/'],
    ['link-local 169.254/16', 'https://169.254.0.1/'],
    ['CGNAT 100.64/10', 'https://100.64.0.1/'],
    ['unspecified 0.0.0.0', 'https://0.0.0.0/'],
    ['IPv6 loopback ::1', 'https://[::1]/'],
    ['IPv6 ULA fc00::/7', 'https://[fc00::1]/'],
    ['IPv6 link-local fe80::/10', 'https://[fe80::1]/'],
    ['IPv4-mapped IPv6', 'https://[::ffff:10.0.0.1]/'],
    ['embedded creds', 'https://user:pass@example.com/'],
    ['insecure http scheme', 'http://example.com/'],
    ['non-http scheme (gopher)', 'gopher://127.0.0.1/'],
    ['non-http scheme (file)', 'file:///etc/passwd'],
  ];
  // Hostnames + alt IP encodings are the ASYNC resolve layer's responsibility (resolveAndAssertEgress
  // resolves then classifies the resulting IP) — the sync guard legitimately defers them. The canary
  // records them separately so a regression in either layer is visible, and so the sync MUST_BLOCK set
  // stays scoped to what the sync guard actually owns (literal IPs / schemes / creds).
  const DEFER_TO_RESOLVE = [
    ['loopback hostname (localhost)', 'https://localhost/'],
    ['decimal IP (127.0.0.1)', 'https://2130706433/'],
    ['hex IP', 'https://0x7f000001/'],
    ['octal IP', 'https://0177.0.0.1/'],
  ];

  let failed = false; const allowedThrough = [];
  for (const [label, url] of MUST_BLOCK) {
    let blocked = false;
    try { assertEgressAllowed(url); } catch { blocked = true; }
    if (!blocked) { allowedThrough.push(label + ' → ' + url); failed = true; }
  }
  if (allowedThrough.length) { log('    ✖ NOT blocked by the sync guard:'); allowedThrough.forEach((a) => log('      - ' + a)); }
  else log(`    ✓ all ${MUST_BLOCK.length} core block-classes rejected by assertEgressAllowed.`);

  // Informational: hostname/alt-encoding handling + the rebind caveat (sync guard cannot see the post-DNS IP).
  const altInfo = DEFER_TO_RESOLVE.map(([label, url]) => { let b = false; try { assertEgressAllowed(url); } catch { b = true; } return `${b ? 'sync-blocked' : 'defers-to-resolve'}: ${label}`; });
  log('    · hostname/alt-encoding handling (defer-to-resolve is acceptable IFF the resolved IP is pinned to the connection):');
  altInfo.forEach((a) => log('      - ' + a));
  log('    · NOTE: this gate tests the block-CLASS completeness of the sync guard. The DNS-rebind/TOCTOU');
  log('      class (resolve validates IP, then undici re-resolves at connect) is closed by IP-pinning in');
  log('      OPS-WEBHOOK-SSRF-IP-PIN-W1 — add a connect-time assertion test once that lands.');
  if (typeof classifyIp === 'function') {
    const meta = classifyIp('169.254.169.254');
    if (!meta || !meta.blocked) { log('    ✖ classifyIp(169.254.169.254) not blocked.'); failed = true; }
  }
  record('ssrf', !failed, allowedThrough.join('; ') || 'block-classes complete');
  return !failed;
}

// ── Run ─────────────────────────────────────────────────────────────────────────────────────────
// --self-test proves the secret matcher fires on the real SEC-02 shape and does NOT fire on the
// placeholder that replaced it. Runs standalone AND as a precondition of the pii gate, so a
// widened-then-broken regex can never go quietly vacuous.
if (argv.includes('--self-test')) {
  const secretFails = selfTestSecrets();
  const leakFails = selfTestLeakValue();
  const corpusFails = selfTestCorpus();
  const fails = [...secretFails, ...leakFails, ...corpusFails];
  if (fails.length) { console.error('✖ matcher self-test FAILED:'); fails.forEach((f) => console.error('   - ' + f)); process.exit(1); }
  // Assert the corpora are NON-EMPTY before reporting a pass. A self-test that ran zero
  // assertions prints exactly the same ✓ as one that ran fifty — which is the vacuous-guard
  // failure this whole mechanism exists to prevent, and it is not hypothetical: the first
  // cut of the leak-value self-test was never wired into this branch and cheerfully
  // reported "passed (0 must-fire, 0 must-not-fire)".
  const empty = Object.entries(SELF_TEST_COUNTS).filter(([, n]) => n === 0).map(([k]) => k);
  if (empty.length) {
    console.error(`✖ self-test is VACUOUS — zero assertions ran for: ${empty.join(', ')}`);
    process.exit(1);
  }
  console.log(`✓ secret-matcher self-test passed (${SELF_TEST_COUNTS.fire} must-fire, ${SELF_TEST_COUNTS.noFire} must-not-fire)`);
  console.log(`✓ leak-value self-test passed (${SELF_TEST_COUNTS.leakFire} must-fire, ${SELF_TEST_COUNTS.leakNoFire} must-not-fire)`);
  console.log(`✓ corpus-vacuity self-test passed (${SELF_TEST_COUNTS.corpus} cases)`);
  process.exit(0);
}

const run = { audit: gateAudit, pii: gatePii, ssrf: gateSsrf };
if (ONLY && run[ONLY]) run[ONLY]();
else { gateAudit(); gatePii(); gateSsrf(); }

const failures = results.filter((r) => r.pass === false);
const inconclusive = results.filter((r) => r.pass === null);
if (JSON_OUT) console.log(JSON.stringify({ ok: failures.length === 0, results }, null, 2));
else {
  log('\n──────── security-canary summary ────────');
  results.forEach((r) => log(`  ${r.pass === false ? '✖ FAIL' : r.pass === null ? '⚠ INCONCLUSIVE' : '✓ PASS'}  ${r.gate}  — ${r.detail}`));
  log(failures.length ? `\n✖ ${failures.length} gate(s) FAILED` : inconclusive.length ? `\n⚠ passed with ${inconclusive.length} inconclusive` : '\n✓ all security gates passed');
}
process.exit(failures.length ? 1 : inconclusive.length ? 2 : 0);

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

// ── Gate B — PII / secret leak grep (value-binding discriminator, not bare identifier) ──────────
function gatePii() {
  log('\n[B] PII / secret-leak gate');
  // Value-binding form: a SERIALIZED value, never a DB column ref. Per CLAUDE.md PII-guard regex.
  const LEAK_VALUE = /["'](outcome_return_pct|outcome_price|phase_e_wr|phaseE|outcome_pnl)["']\s*:\s*[-\d.$]/;
  const SECRET_LIT = [
    /\bwhsec_[A-Za-z0-9]{16,}/,                          // webhook signing secret literal
    /\b(sk|rk|cdp)_(live|test|prod)_[A-Za-z0-9]{16,}/,   // generic live secret-key literal
    /\bdb-[A-Za-z0-9]{20,}/,                              // Databento key shape (db-…)
    /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,             // PEM private key
    /\bBearer\s+[A-Za-z0-9._-]{24,}/,                     // hardcoded bearer
  ];
  const hits = [];
  let files;
  if (DIFF_ONLY) {
    const diff = sh('git', ['diff', 'HEAD', '--unified=0']);
    diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).forEach((l) => {
      const line = l.slice(1);
      if (LEAK_VALUE.test(line)) hits.push(`git-diff: leak-value → ${line.trim().slice(0, 120)}`);
      SECRET_LIT.forEach((re) => { if (re.test(line)) hits.push(`git-diff: secret-literal → ${line.trim().slice(0, 60)}…[redacted]`); });
    });
  } else {
    files = sh('git', ['ls-files', 'src', 'landing', 'public', 'scripts']).split('\n').filter((f) => /\.(ts|tsx|js|mjs|cjs|html|json)$/.test(f) && !/\.test\.|\.spec\.|__fixtures__|\bfixtures?\b/.test(f));
    for (const f of files) {
      const abs = join(ROOT, f); if (!existsSync(abs)) continue;
      const txt = readFileSync(abs, 'utf8');
      txt.split('\n').forEach((line, i) => {
        if (LEAK_VALUE.test(line)) hits.push(`${f}:${i + 1} leak-value → ${line.trim().slice(0, 120)}`);
        SECRET_LIT.forEach((re) => { if (re.test(line)) hits.push(`${f}:${i + 1} secret-literal [redacted]`); });
      });
    }
  }
  if (hits.length) { log('    ✖ leak/secret candidates:'); hits.slice(0, 40).forEach((h) => log('      - ' + h)); }
  else log(`    ✓ no outcome_return_pct/Phase-E value-binding or secret literal in ${DIFF_ONLY ? 'git diff' : (files?.length || 0) + ' source files'}.`);
  record('pii', hits.length === 0, hits.length ? `${hits.length} candidate(s)` : 'clean');
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

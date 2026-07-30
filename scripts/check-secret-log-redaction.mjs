#!/usr/bin/env node
// @ts-check
/**
 * check-secret-log-redaction.mjs — no credential may reach a log line or a rendered URL.
 *
 * OPS-AUDIT-REMEDIATION-MEDIUM-W1 / Ch1, retiring the lane-copy class for SEC-14 + SEC-10.
 *
 * THE BUG CLASS. Both findings are CLAUDE.md laws that no gate enforced:
 *   • SEC-14 — "redact secrets in exception repr too — redact by STRUCTURE, never by known
 *     vendor prefix". `trackedWrite` logged `SQL=<sql> PARAMS=<every bound param>`, so a signup
 *     during a Postgres outage wrote a LIVE api key and a subscriber email to stdout.
 *   • SEC-10 — ADMIN_API_KEY was accepted from `req.query.key` AND re-embedded into the payout
 *     page's form action, so a leaked URL was directly replayable against an irreversible
 *     on-chain USDC send.
 *
 * Patching the two call sites fixes today. This gate fixes every FUTURE call site: a new
 * `console.error(\`… PARAMS=\${params}\`)` in some other module re-creates SEC-14 exactly while
 * `trackedWrite` stays impeccable. That is the lane-copy class this exists to make impossible.
 *
 * WHAT IT ASSERTS (over src/, comments stripped so prose ABOUT the defect never matches):
 *   R1  No console-log or throw interpolates a bound-parameter array unredacted.
 *   R2  No console-log or throw emits a `KEY=`/`SECRET=`/`TOKEN=`/`PASSWORD=`-shaped value unredacted.
 *   R3  The admin authorization predicate never reads the query string.
 *   R4  No credential is interpolated into a URL (`?key=${…}`) — i.e. never rendered into HTML.
 *
 * Usage:
 *   node scripts/check-secret-log-redaction.mjs --self-test   # both directions, offline
 *   node scripts/check-secret-log-redaction.mjs               # scan src/
 *
 * Verdict: exactly one terminal `SECRET_LOG_REDACTION_VERDICT=PASS|FAIL|INDETERMINATE` line.
 * Callers gate on the TOKEN, not the code (CLAUDE.md verdict-token law).
 * Exit: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE (scanned nothing — never a silent pass).
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

/**
 * Literal-aware comment stripper.
 *
 * A naive regex pass (block-comment regex + line-comment regex) is NOT safe on real
 * source: a comment-close sequence, or a double-slash, sitting inside a string or
 * template literal pairs with a distant comment-open and swallows
 * hundreds of lines of REAL CODE. Measured on this repo's `src/index.ts`: the naive
 * stripper removed 96,821 characters and destroyed the entire Stripe webhook switch, so
 * this gate reported PASS while scanning a file with no case labels left in it — the
 * dark-guard class all over again. (`check-canaries-wired.mjs` documents the same defect
 * for YAML globs.) This walks the source tracking string/template state instead.
 *
 * NOTE (CLAUDE.md 3-example-threshold): this is now the 3rd hand-written comment
 * stripper in scripts/. Flagged as a WIS extraction candidate for a dedicated
 * OPS-SHARED-STRIPCOMMENTS-EXTRACTION wave — deliberately NOT inline-extracted here.
 */
export function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  let mode = 'code'; // 'code' | 'block' | 'line' | "'" | '"' | '`'
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '*') { mode = 'block'; i += 2; out += ' '; continue; }
      if (c === '/' && d === '/') { mode = 'line'; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') { mode = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (mode === 'block') {
      if (c === '*' && d === '/') { mode = 'code'; i += 2; } else { if (c === '\n') out += '\n'; i++; }
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += '\n'; i++; } else i++;
      continue;
    }
    if (c === '\\') { out += c + (d ?? ''); i += 2; continue; } // escape inside a literal
    if (c === mode) { mode = 'code'; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

/** Calls that render a value non-disclosing. An interpolation through one of these is clean. */
const REDACTORS = /\b(redactParams|redactErrorText|redactSqlShape|formatWriteLossLog|fingerprint|maskEmail)\s*\(/;

/** Identifiers that plausibly hold a bound-parameter array. Broad on purpose — a false hit is cheap. */
const PARAMS_ISH = /\b(params|bindings|boundValues|boundParams|sqlParams|queryParams)\b/;

/**
 * Label shapes that announce a credential in a log line.
 *
 * `LABEL=` ONLY — deliberately not `LABEL:`. The CLAUDE.md law is "mask everything after
 * `LABEL=`", and `=` is the env-var / query-param shape that actually carries credentials.
 * `key: ${key}` is ordinary English prose in a log message and matching it produced a real
 * false positive on `landing-content.ts`'s copy-key lookup — pinned as a CLEAN fixture below.
 */
const SECRET_LABEL = /\b(KEY|API_KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PARAMS|AUTH)\s*=\s*\$\{/i;

/** Sinks that persist or surface a value. */
const SINK_RE = /(console\s*\.\s*(?:log|warn|error|info|debug)\s*\(|throw\s+new\s+\w*Error\s*\()/g;

/**
 * Extract the balanced-paren argument text for each sink call. Statement-level (not
 * line-level) because the real defect spanned three lines of template concatenation.
 */
export function sinkArguments(code) {
  const out = [];
  SINK_RE.lastIndex = 0;
  let m;
  while ((m = SINK_RE.exec(code)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < code.length && depth > 0) {
      const ch = code[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    out.push({ index: m.index, text: code.slice(start, i - 1) });
  }
  return out;
}

/** R1 + R2 — a sink that emits parameters or a labelled secret without a redactor. */
export function findLogLeaks(src) {
  const hits = [];
  const code = stripComments(src);
  for (const arg of sinkArguments(code)) {
    if (REDACTORS.test(arg.text)) continue; // routed through a redactor — clean
    const interpolations = arg.text.match(/\$\{[^}]*\}/g) || [];
    if (interpolations.some((x) => PARAMS_ISH.test(x))) {
      hits.push({ rule: 'R1', detail: 'bound parameters interpolated into a log/throw', snippet: arg.text.slice(0, 160) });
      continue;
    }
    if (SECRET_LABEL.test(arg.text)) {
      // NB: this message deliberately avoids writing a credential label immediately
      // followed by `=` and a long unbroken run. `security-canary.mjs`'s `assigned-secret`
      // matcher (correctly) reads that shape as a hardcoded credential, and this file's
      // own prose tripped it on the first deploy — a gate flagging a gate's description
      // of the thing it detects.
      hits.push({ rule: 'R2', detail: 'a credential-labelled value (KEY / SECRET / TOKEN / PASSWORD) interpolated into a log or throw', snippet: arg.text.slice(0, 160) });
    }
  }
  return hits;
}

/** R3 — the admin authorization predicate must not read the query string. */
export function findQueryAuth(src) {
  const code = stripComments(src);
  const hits = [];
  // The predicate body, up to its closing brace at the same indentation.
  const fn = code.match(/function\s+isAdminAuthorized\s*\([^)]*\)\s*:?\s*\w*\s*\{[\s\S]*?\n\s{0,6}\}/);
  if (fn && /req\s*\.\s*query/.test(fn[0])) {
    hits.push({ rule: 'R3', detail: 'isAdminAuthorized reads req.query — a leaked URL becomes replayable', snippet: fn[0].slice(0, 160) });
  }
  // The extracted predicate module must not learn about the query string either.
  // Match real query ACCESS, not the word "query" in a user-facing message string —
  // ADMIN_UNAUTHORIZED_API legitimately says "a key in the query string is no longer
  // accepted", which the bare-word form flagged on its first live run.
  if (/export function resolveAdminAuth/.test(code) && /\breq\s*\.\s*query\b|\bqueryKey\b|\bquery\s*[:.]/.test(code)) {
    hits.push({ rule: 'R3', detail: 'resolveAdminAuth references a query input — it must take none', snippet: 'src/lib/admin-auth.ts' });
  }
  return hits;
}

/** R4 — a credential interpolated into a URL lands in history, logs, and any Referer. */
export function findCredentialInUrl(src) {
  const code = stripComments(src);
  const hits = [];
  const re = /[?&](key|api_key|apikey|token|secret|password)=\$\{/gi;
  let m;
  while ((m = re.exec(code)) !== null) {
    hits.push({ rule: 'R4', detail: `credential '${m[1]}' interpolated into a URL`, snippet: code.slice(Math.max(0, m.index - 60), m.index + 60) });
  }
  return hits;
}

export function scanSource(src) {
  return [...findLogLeaks(src), ...findQueryAuth(src), ...findCredentialInUrl(src)];
}

// ── fixtures (the two-way self-test corpus) ───────────────────────────────────
const DIRTY = [
  // R1 — verbatim shape of the SEC-14 defect.
  ['R1', 'console.error(`[pg-write] WRITE LOST [${label}]: ${msg} :: SQL=${sql} PARAMS=${safeJson(params)}`);'],
  ['R1', 'throw new Error(`insert failed for ${JSON.stringify(params)}`);'],
  // R2 — a labelled secret, with a key format no deny-list would know.
  ['R2', 'console.warn(`upstream rejected: API_KEY=${cfg.zzUnknownFormatKey}`);'],
  // R3 — the SEC-10 authorization source.
  ['R3', 'function isAdminAuthorized(req: Request): boolean {\n  const t = (req.headers.authorization || "") || (req.query.key as string);\n  return !!t;\n}'],
  // R4 — verbatim shape of the SEC-10 rendered form action.
  ['R4', 'const f = `<form action="/admin/referrals/payouts/approve-all?key=${encodeURIComponent(v.adminKey)}">`;'],
];

const CLEAN = [
  ['redacted params', 'console.error(formatWriteLossLog(label, r.attempts, r.error, sql, params));'],
  ['redacted explicitly', 'console.error(`WRITE LOST :: SQL=${redactSqlShape(sql)} PARAMS=${redactParams(params)}`);'],
  ['no params at all', 'console.log(`[pg-write] ${label} recovered after ${r.attempts} attempt(s)`);'],
  ['header+cookie auth only', 'function isAdminAuthorized(req: Request): boolean {\n  return resolveAdminAuth({ authorization: req.headers.authorization, cookie: req.headers.cookie }, deps).authorized;\n}'],
  ['clean form action', 'const f = `<form action="/admin/referrals/payouts/approve-all">`;'],
  ['non-secret query param survives', 'const u = `/admin/geo-dashboard?weeks=${weeks}`;'],
  // Real FP found on the first live scan: a landing COPY key, not a credential. `LABEL:` is
  // prose; only `LABEL=` is the credential shape.
  ['prose "key:" is not a credential', 'if (!entry) throw new Error(`[landing-content] unknown copy key: ${key}`);'],
  // The gate must not fire on PROSE describing the defect — this is why comments are stripped.
  ['comment describing the defect', '// the old code did `?key=${v.adminKey}` and logged PARAMS=${params}\nconst x = 1;'],
];

function selfTest() {
  const fails = [];
  // Vacuity guard: a self-test over an empty corpus proves nothing and must not pass.
  if (DIRTY.length === 0 || CLEAN.length === 0) {
    console.error('✖ self-test corpus is empty — refusing to report a pass');
    return 'INDETERMINATE';
  }
  for (const [rule, fixture] of DIRTY) {
    const hits = scanSource(fixture);
    if (!hits.some((h) => h.rule === rule)) {
      fails.push(`MISSED ${rule}: detector did not flag a known-bad fixture → ${fixture.slice(0, 80)}`);
    }
  }
  for (const [name, fixture] of CLEAN) {
    const hits = scanSource(fixture);
    if (hits.length) {
      fails.push(`FALSE POSITIVE on "${name}": ${hits.map((h) => h.rule).join(',')} → ${fixture.slice(0, 80)}`);
    }
  }
  if (fails.length) {
    console.error('✖ self-test FAILED:');
    fails.forEach((f) => console.error('   - ' + f));
    return 'FAIL';
  }
  console.log(`✓ self-test: ${DIRTY.length} known-bad fixtures flagged, ${CLEAN.length} clean fixtures passed.`);
  return 'PASS';
}

function trackedSourceFiles() {
  const out = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
}

function verdictAndExit(verdict) {
  console.log(`SECRET_LOG_REDACTION_VERDICT=${verdict}`);
  process.exit(verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 3);
}

// ── main ──────────────────────────────────────────────────────────────────────
if (argv.includes('--self-test')) {
  verdictAndExit(selfTest());
}

const st = selfTest();
if (st !== 'PASS') verdictAndExit(st); // a broken detector must never green-light the scan

let files;
try {
  files = trackedSourceFiles();
} catch (err) {
  console.error(`✖ could not enumerate src/: ${err instanceof Error ? err.message : err}`);
  verdictAndExit('INDETERMINATE');
}

// Vacuity guard: scanning zero files is "verified nothing", not "verified clean".
if (!files || files.length === 0) {
  console.error('✖ scanned 0 source files — refusing to report a pass');
  verdictAndExit('INDETERMINATE');
}

const findings = [];
for (const f of files) {
  let src;
  try {
    src = readFileSync(join(ROOT, f), 'utf8');
  } catch {
    continue;
  }
  for (const h of scanSource(src)) findings.push({ file: f, ...h });
}

if (findings.length) {
  console.error(`✖ ${findings.length} credential-disclosure site(s) across ${files.length} file(s):`);
  for (const h of findings) {
    console.error(`   - ${h.file}  [${h.rule}] ${h.detail}`);
    console.error(`     ${h.snippet.replace(/\s+/g, ' ').slice(0, 150)}`);
  }
  verdictAndExit('FAIL');
}

console.log(`✓ secret-log redaction: ${files.length} source files carry no unredacted credential in a log line or URL.`);
verdictAndExit('PASS');

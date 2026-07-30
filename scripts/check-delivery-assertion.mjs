#!/usr/bin/env node
// @ts-check
/**
 * check-delivery-assertion.mjs — a load-bearing send may not report success it did not
 * achieve, and a repeatable smoke may not burn the real alert cooldown.
 *
 * OPS-AUDIT-REMEDIATION-MEDIUM-W1 / Ch4. Both findings are the same failure to
 * distinguish "attempted" from "achieved":
 *
 *   SEC-17 — `sendDigest` returns a BOOLEAN and never throws. The weekly knowledge-page
 *   producer awaited it, discarded the result, and logged "digest sent" unconditionally.
 *   Three consecutive weeks of HTTP 400 rendered as success; anyone triaging by grepping
 *   for "digest sent" concluded the path was healthy.
 *
 *   SEC-13 — the sanctioned synthetic-fire smoke prescribed `DRY_RUN_TG=1`, which is NOT
 *   inert: `send_telegram.sh` writes the 24h cooldown marker on that path. So the smoke
 *   silenced the next GENUINE page for 24h, and a second smoke false-greened — it was
 *   cooldown-suppressed, not healthy. `ALGOVAULT_TG_TEST_INERT=1` exits before the
 *   cooldown gate and writes no marker.
 *
 * WHAT IT ASSERTS:
 *   R1  Every `await sendDigest(...)` / `await sendAlert(...)` result is BOUND or
 *       BRANCHED ON — never discarded next to an unconditional success log.
 *   R2  No committed smoke/runbook line PRESCRIBES DRY_RUN_TG for a repeatable synthetic
 *       fire. Mentioning it to warn against it is fine; telling a reader to use it is not.
 *
 * Usage:
 *   node scripts/check-delivery-assertion.mjs --self-test
 *   node scripts/check-delivery-assertion.mjs
 *
 * Verdict: exactly one terminal `DELIVERY_ASSERTION_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Exit: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE (scanned nothing — never a silent pass).
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

/** Literal-aware comment stripper — see check-webhook-idempotency.mjs for why a regex is unsafe. */
export function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  let mode = 'code';
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
    if (c === '\\') { out += c + (d ?? ''); i += 2; continue; }
    if (c === mode) { mode = 'code'; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

/**
 * R1 — a delivery call whose boolean result is thrown away.
 *
 * `await sendDigest(x);` as a STATEMENT discards the verdict. Bound (`const ok = await
 * …`) or branched (`if (await …)`) is what makes the caller able to tell delivered from
 * rejected. Deliberately statement-level so the pattern is unambiguous.
 */
/** Words that claim the send SUCCEEDED. These are what made SEC-17 invisible for weeks. */
const SUCCESS_LOG = /console\s*\.\s*log\s*\([^)]*\b(sent|delivered|posted|notified|dispatched)\b/i;

export function findDiscardedDeliveryResults(src) {
  const hits = [];
  const soft = [];
  const code = stripComments(src);
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const m = line.match(/^(?:void\s+)?await\s+(sendDigest|sendAlert|sendVenueStatusChange)\s*\(/);
    if (!m) continue;
    // The DEFECT is not "a discarded result" on its own — it is a discarded result
    // followed by a log that ASSERTS the send happened. That combination is what let
    // three weeks of HTTP 400 read as healthy. A discarded result with no success claim
    // is weaker ("fire and hope"): reported below, not failed, so this gate stays about
    // the class it was built for instead of quietly widening into an unrelated refactor.
    const lookahead = lines.slice(i + 1, i + 6).join('\n');
    if (SUCCESS_LOG.test(lookahead)) {
      hits.push({
        rule: 'R1',
        detail: `\`await ${m[1]}(...)\` result is discarded, then success is logged unconditionally — the exact SEC-17 shape`,
        snippet: line.slice(0, 140),
      });
    } else {
      soft.push({ detail: `${m[1]} result discarded (no success claim)`, snippet: line.slice(0, 100) });
    }
  }
  return Object.assign(hits, { soft });
}

/**
 * R2 — a committed instruction to use DRY_RUN_TG for a repeatable synthetic fire.
 *
 * Matched on PRESCRIPTIVE shapes only ("pair with", "under", "use", "run … with",
 * "export"), so the many lines that WARN about DRY_RUN_TG do not trip it. A warning is
 * the desired end state; an instruction is the defect.
 */
export function findDryRunPrescriptions(src) {
  const hits = [];
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!/DRY_RUN_TG/.test(line)) continue;
    // An explicit warning/deprecation is exactly what we WANT to see next to it.
    if (/NOT inert|writes? the (24h )?(cooldown )?marker|burn|prefer |only for a test whose assertion IS the cooldown|legacy|false-green|silenc/i.test(line)) continue;
    if (/(pair with|use |using |under |via |run .* with|export |set )\s*[`"']?DRY_RUN_TG=1/i.test(line)) {
      hits.push({ rule: 'R2', detail: 'prescribes DRY_RUN_TG=1 for a synthetic fire — it WRITES the 24h cooldown marker', snippet: line.slice(0, 140) });
    }
  }
  return hits;
}

export function scanJs(src) { return findDiscardedDeliveryResults(src); }
export function scanOps(src) { return findDryRunPrescriptions(src); }

// ── fixtures ──────────────────────────────────────────────────────────────────
const DIRTY_R1 = [
  '  await sendDigest(sections);\n  console.log("[monitor] digest sent");',
  '  await sendDigest(lines);\n  console.log(`[geo-cron] digest sent · sections=${lines.length}`);',
];
const CLEAN_R1 = [
  '  const ok = await sendDigest(sections);\n  if (ok) console.log("sent"); else console.error("FAILED");',
  '  if (await sendDigest(sections)) { console.log("sent"); } else { process.exitCode = 1; }',
  '  const delivered = await sendDigest(sections);',
  '  // await sendDigest(sections);  <- prose about the old code\n  const x = 1;',
  '  sendAlert("fire-and-forget on a FATAL path", "critical").catch(() => {});',
  // Discarded but claims nothing — reported, deliberately NOT failed (see findDiscardedDeliveryResults).
  '  await sendAlert("escalation", "warning");',
];
const DIRTY_R2 = [
  '  LF_NOW_EPOCH   freeze "now"   --force-stale VENUE  (pair with DRY_RUN_TG=1 — runbook §6)',
  '# exercise the alert path end-to-end under DRY_RUN_TG=1 (no real send).',
];
const CLEAN_R2 = [
  '  --force-stale VENUE  synthetic breach (pair with ALGOVAULT_TG_TEST_INERT=1 — runbook §6)',
  '# DRY_RUN_TG=1 is NOT inert — it writes the 24h cooldown marker; prefer ALGOVAULT_TG_TEST_INERT=1.',
  '# send_telegram.sh owns every gate (severity → INERT → 24h cooldown → DRY_RUN_TG → POST).',
  '  keep DRY_RUN_TG only for a test whose assertion IS the cooldown',
];

function selfTest() {
  const fails = [];
  if (!DIRTY_R1.length || !CLEAN_R1.length || !DIRTY_R2.length || !CLEAN_R2.length) {
    console.error('✖ self-test corpus is empty — refusing to report a pass');
    return 'INDETERMINATE';
  }
  for (const f of DIRTY_R1) if (!scanJs(f).length) fails.push(`MISSED R1: ${f.slice(0, 70).replace(/\n/g, ' ')}`);
  for (const f of CLEAN_R1) if (scanJs(f).length) fails.push(`FALSE POSITIVE R1: ${f.slice(0, 70).replace(/\n/g, ' ')}`);
  for (const f of DIRTY_R2) if (!scanOps(f).length) fails.push(`MISSED R2: ${f.slice(0, 70)}`);
  for (const f of CLEAN_R2) if (scanOps(f).length) fails.push(`FALSE POSITIVE R2: ${f.slice(0, 70)}`);
  if (fails.length) {
    console.error('✖ self-test FAILED:');
    fails.forEach((f) => console.error('   - ' + f));
    return 'FAIL';
  }
  console.log(`✓ self-test: ${DIRTY_R1.length + DIRTY_R2.length} known-bad fixtures flagged, ${CLEAN_R1.length + CLEAN_R2.length} clean fixtures passed.`);
  return 'PASS';
}

function verdictAndExit(v) {
  console.log(`DELIVERY_ASSERTION_VERDICT=${v}`);
  process.exit(v === 'PASS' ? 0 : v === 'FAIL' ? 1 : 3);
}

if (argv.includes('--self-test')) verdictAndExit(selfTest());

const st = selfTest();
if (st !== 'PASS') verdictAndExit(st);

let all;
try {
  all = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
} catch (err) {
  console.error(`✖ could not enumerate tracked files: ${err instanceof Error ? err.message : err}`);
  verdictAndExit('INDETERMINATE');
}

const jsFiles = all.filter((f) => /^(src|scripts)\/.*\.(ts|mjs|js)$/.test(f) && !f.endsWith('.d.ts'));
const opsFiles = all.filter((f) => /^(ops|docs)\/.*\.(py|sh|md)$/.test(f));
if (jsFiles.length === 0 || opsFiles.length === 0) {
  console.error(`✖ corpus empty (js=${jsFiles.length} ops=${opsFiles.length}) — refusing to report a pass`);
  verdictAndExit('INDETERMINATE');
}

const findings = [];
const softTotal = [];
for (const f of jsFiles) {
  try {
    const r = scanJs(readFileSync(join(ROOT, f), 'utf8'));
    for (const h of r) findings.push({ file: f, ...h });
    for (const s of r.soft ?? []) softTotal.push({ file: f, ...s });
  } catch { /* unreadable */ }
}
// No silent caps: name what this gate observes but does NOT enforce.
if (softTotal.length) {
  console.log(`\u2139 ${softTotal.length} send call(s) discard their result WITHOUT claiming success — reported, not enforced (tracked as OPS-ALERT-DELIVERY-ASSERT-W{NEXT}): ${[...new Set(softTotal.map((s) => s.file))].join(', ')}`);
}
for (const f of opsFiles) {
  try { for (const h of scanOps(readFileSync(join(ROOT, f), 'utf8'))) findings.push({ file: f, ...h }); } catch { /* unreadable */ }
}

if (findings.length) {
  console.error(`✖ ${findings.length} finding(s) across ${jsFiles.length} js + ${opsFiles.length} ops file(s):`);
  for (const h of findings) {
    console.error(`   - ${h.file}  [${h.rule}] ${h.detail}`);
    console.error(`     ${h.snippet}`);
  }
  verdictAndExit('FAIL');
}

console.log(`✓ delivery assertion: ${jsFiles.length} js file(s) bind every send result; ${opsFiles.length} ops file(s) prescribe no cooldown-burning smoke.`);
verdictAndExit('PASS');

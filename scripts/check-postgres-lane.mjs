#!/usr/bin/env node
// @ts-check
/**
 * check-postgres-lane.mjs — ratchet for the Postgres test lane.
 *
 * OPS-POSTGRES-TEST-LANE-W1.
 *
 * Production is Postgres; the suite was SQLite. `tryClaimPayment`'s PG branch kept
 * `ON CONFLICT (nonce)` after the primary key became `(payer_wallet, nonce)`, Postgres errored on
 * every claim, the fail-safe returned false, and the paid x402 rail served nothing for ~25 hours —
 * through a fully green suite, because every test takes the SQLite branch. This lane executes the
 * PG branch; this script decides what its result means.
 *
 * WHY A RATCHET AND NOT FAIL-CLOSED, TODAY. This code has never been executed against the real
 * engine, so first contact legitimately surfaces pre-existing defects. Blocking every push on all
 * of them at once guarantees the lane gets disabled within a week — the outcome this wave exists
 * to prevent. So: a test file in the committed baseline REPORTS; anything NEW BLOCKS; and the
 * baseline may only SHRINK (a file that starts passing must be removed, in the same change).
 *
 * A BASELINE ENTRY IS A DEBT, NOT AN EXEMPTION. Every line requires an owner and a reason in
 * `audits/postgres-lane-baseline.txt` itself. "Quarantined with a named owner" is the spec's
 * language and it is load-bearing: a skip that hides a real defect is how the outage lasted a day.
 *
 * Verdict: exactly one terminal `POSTGRES_LANE_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Exit: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE (token-law default for a NEW gate).
 * FAIL-CLOSED: an unreadable/absent log, or a log with NO recognisable vitest summary, is
 * INDETERMINATE — "the lane produced nothing" must never read as "the lane is green".
 *
 * Usage:
 *   node scripts/check-postgres-lane.mjs <vitest-log>
 *   node scripts/check-postgres-lane.mjs --self-test
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(ROOT, 'audits', 'postgres-lane-baseline.txt');
const argv = process.argv.slice(2);

/**
 * Strip ANSI SGR sequences. REAL vitest output is colourised, so ` FAIL ` arrives wrapped in
 * escape codes. The first version of this file matched on clean text only — its self-test used
 * synthetic strings and passed, while against the actual log it found ZERO failures and the
 * ratchet reported PASS over 5 genuinely failing files. Strip first, always.
 */
export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

/** Every ` FAIL  <file>` line vitest prints, deduped to test-FILE granularity. */
export function failingFiles(log) {
  const out = new Set();
  for (const m of stripAnsi(log).matchAll(/^\s*FAIL\s+(\S+?\.(?:test|spec)\.[cm]?[jt]s)/gm)) out.add(m[1]);
  return [...out].sort();
}

/**
 * The count vitest itself reports in its summary: `Test Files  5 failed | 371 passed (384)`.
 * Cross-checking the PARSED failures against this is the guard that would have caught the ANSI
 * bug on its first run instead of after it laundered 5 failures into a PASS.
 */
export function summaryFailedCount(log) {
  const m = /Test Files\s+(?:(\d+)\s+failed)?/.exec(stripAnsi(log));
  if (!m) return null;
  return m[1] ? Number(m[1]) : 0;
}

/** Did vitest actually report a run? A log without this never executed anything. */
export function hasSummary(log) {
  const s = stripAnsi(log);
  return /Test Files\s+.*\(\d+\)/.test(s) || /Tests\s+\d+\s+passed/.test(s);
}

/** Baseline rows: `path  # owner: X — reason`. The comment is MANDATORY. */
export function parseBaseline(text) {
  const rows = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [path, ...rest] = line.split('#');
    const note = rest.join('#').trim();
    // A `flaky:` row NEVER blocks in either direction. A shrink-only ratchet over a
    // NON-DETERMINISTIC test oscillates — it failed run 1, passed run 2 — so it would turn the
    // lane red on roughly half of all pushes, and a lane that is red half the time gets ignored,
    // which is the outcome this whole wave exists to prevent. Flaky rows are REPORTED loudly with
    // their owner instead, and stay visible until someone makes them deterministic.
    rows.push({ path: path.trim(), note, flaky: /^flaky:/i.test(note) });
  }
  return rows;
}

export function selfTest() {
  const f = [];
  const ESC = String.fromCharCode(27);
  // REAL vitest output is colourised — this is the shape that broke the first version.
  const log = ` ${ESC}[31mFAIL${ESC}[39m  tests/unit/a.test.ts > x\n ${ESC}[31mFAIL${ESC}[39m  tests/b.test.ts > y\n ${ESC}[2m Test Files ${ESC}[22m ${ESC}[31m2 failed${ESC}[39m | 3 passed (5)\n`;
  const ff = failingFiles(log);
  if (ff.length !== 2) f.push(`failingFiles found ${ff.length}, expected 2`);
  if (!ff.includes('tests/unit/a.test.ts')) f.push('failingFiles missed a path');
  if (failingFiles(' Test Files  5 passed (5)\n').length !== 0) f.push('reported a failure on a clean log');
  if (!hasSummary(log)) f.push('hasSummary missed a real summary');
  if (hasSummary('some unrelated output\n')) f.push('hasSummary accepted a log with no run');
  const b = parseBaseline('# c\n\ntests/x.test.ts  # owner: OPS-Y — because\n');
  if (b.length !== 1 || !b[0].note) f.push('parseBaseline dropped the mandatory note');
  if (parseBaseline('tests/x.test.ts\n')[0].note !== '') f.push('parseBaseline invented a note');
  // THE REGRESSION: the parsed failure count must agree with vitest's own summary.
  if (summaryFailedCount(log) !== 2) f.push(`summaryFailedCount read ${summaryFailedCount(log)}, expected 2`);
  if (summaryFailedCount(' Test Files  5 passed (5)\n') !== 0) f.push('summaryFailedCount misread a clean summary');
  if (failingFiles(log).length !== summaryFailedCount(log)) f.push('parsed failures disagree with the summary on a known-good log');
  const fb = parseBaseline('tests/a.test.ts  # flaky: owner: W — oscillates\ntests/b.test.ts  # owner: W — deterministic\n');
  if (!fb[0].flaky) f.push('a `flaky:` row was not recognised');
  if (fb[1].flaky) f.push('a normal row was wrongly treated as flaky');
  return f;
}

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
function emit(v, why) {
  if (why) console.log(`\n${v === 'FAIL' ? '✖' : 'ℹ'} ${why}`);
  console.log(`POSTGRES_LANE_VERDICT=${v}`);
  process.exit(v === 'PASS' ? 0 : v === 'FAIL' ? 1 : 3);
}

if (IS_MAIN) {
  if (argv.includes('--self-test')) {
    const f = selfTest();
    if (f.length) { console.error('✖ postgres-lane self-test FAILED:'); f.forEach((x) => console.error('   - ' + x)); process.exit(1); }
    console.log('✓ postgres-lane self-test passed (parses FAIL lines, refuses a log with no run, requires a baseline note)');
    process.exit(0);
  }
  const st = selfTest();
  if (st.length) { st.forEach((x) => console.error('   - ' + x)); emit('INDETERMINATE', 'self-test failure'); }

  const logPath = argv[0];
  if (!logPath || !existsSync(logPath)) emit('INDETERMINATE', `no vitest log at ${logPath ?? '<none>'} — the lane produced nothing, which is not a pass`);
  const log = readFileSync(logPath, 'utf8');
  if (!hasSummary(log)) emit('INDETERMINATE', 'the log carries no vitest summary — the suite never ran (a database that never came up looks exactly like this)');

  const baseline = existsSync(BASELINE) ? parseBaseline(readFileSync(BASELINE, 'utf8')) : [];
  const undocumented = baseline.filter((r) => !r.note);
  if (undocumented.length) {
    console.error('✖ baseline rows without an owner + reason:');
    undocumented.forEach((r) => console.error(`   - ${r.path}`));
    emit('FAIL', 'a baseline entry is a DEBT, not an exemption — every row needs `# owner: <wave> — <reason>`');
  }

  const known = new Set(baseline.map((r) => r.path));
  const flaky = new Set(baseline.filter((r) => r.flaky).map((r) => r.path));
  const failing = failingFiles(log);

  // FAIL-CLOSED on a parser/summary disagreement. Without this, a log format change silently
  // turns every failure into a PASS — which is exactly what happened on this lane's first run.
  const reported = summaryFailedCount(log);
  if (reported !== null && reported !== failing.length) {
    emit('INDETERMINATE',
      `vitest reported ${reported} failing FILE(s) but this parser recognised ${failing.length}. ` +
      `The log format changed and the ratchet can no longer read it — refusing to report a pass ` +
      `over failures it cannot see.`);
  }
  const fresh = failing.filter((f) => !known.has(f));
  const fixed = [...known].filter((k) => !failing.includes(k) && !flaky.has(k));

  console.log(`postgres lane: ${failing.length} failing file(s); ${known.size} baselined; ${fresh.length} NEW; ${fixed.length} now passing`);
  for (const f of failing) console.log(`   ${flaky.has(f) ? '~ flaky' : known.has(f) ? '· known' : '✖ NEW  '} ${f}`);
  for (const f of flaky) if (!failing.includes(f)) console.log(`   ~ flaky ${f} (passed THIS run — non-deterministic, still owned)`);

  if (fixed.length) {
    console.error(`\n✖ ${fixed.length} baselined file(s) now PASS — the ratchet only shrinks, so remove them from audits/postgres-lane-baseline.txt in this change:`);
    fixed.forEach((f) => console.error(`   - ${f}`));
    emit('FAIL', 'stale baseline entries would hide the next regression in those files');
  }
  if (fresh.length) {
    console.error(`\n✖ ${fresh.length} test file(s) newly failing on the Postgres lane:`);
    fresh.forEach((f) => console.error(`   - ${f}`));
    console.error('\n  This is PG-only SQL the SQLite lane cannot see. Fix it, or quarantine it in');
    console.error('  audits/postgres-lane-baseline.txt WITH an owner and a reason — never by re-adding');
    console.error('  a skip condition, which is how the x402 outage stayed hidden for a day.');
    emit('FAIL', `${fresh.length} new Postgres-lane failure(s)`);
  }
  console.log(`✓ postgres lane: no new failures${known.size ? ` (${known.size} baselined, each with an owner)` : ''}.`);
  emit('PASS');
}

#!/usr/bin/env node
// @ts-check
/**
 * check-runtime-node-eol.mjs — no declared Node major may be past end-of-life.
 *
 * OPS-RUNTIME-NODE24-W1 / Ch4 — the generator for SEC-15.
 *
 * THE BUG CLASS. SEC-15 existed because a base image aged out of support with EVERY GATE
 * GREEN. Node 20 reached EOL 2026-04-30 and the Dockerfiles kept saying `node:20-alpine` for
 * another 91 days; nothing in CI, in the test suite, or in any canary had an opinion about
 * it, because "supported runtime" was a fact nobody had made executable. That is the same
 * "documented law, no executable gate" class this project has now hit repeatedly. A one-time
 * bump repeats the problem in ~2 years; this makes it structurally impossible.
 *
 * WHAT IT ASSERTS — every place a Node major is DECLARED, in one sweep:
 *   • every `FROM node:<major>…` line in every Dockerfile (both stages of both images)
 *   • every `node-version:` in .github/workflows/*.yml
 *   • package.json `engines.node`
 * Each is checked against the baked EOL table. Past EOL -> FAIL. Inside the warning window
 * -> reported loudly, still exit 0, so a bump can be scheduled rather than forced.
 *
 * FAIL-CLOSED. A missing, unparseable, empty, or STALE-past-its-own-revisit-date table is
 * INDETERMINATE, never a pass — a gate that cannot decide must not report "clean".
 *
 * Usage:
 *   node scripts/check-runtime-node-eol.mjs --self-test
 *   node scripts/check-runtime-node-eol.mjs
 *   node scripts/check-runtime-node-eol.mjs --now=2027-01-01   # what-if / boundary testing
 *
 * Verdict: exactly one terminal `RUNTIME_NODE_EOL_VERDICT=PASS|FAIL|INDETERMINATE`. Callers
 * gate on the TOKEN, not the code (CLAUDE.md verdict-token law).
 * Exit: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE (new gate → the token-law default).
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const EOL_FILE = join(ROOT, 'scripts/data/node-eol.json');

/** `--now=YYYY-MM-DD` makes boundary behaviour testable without waiting for a calendar. */
function today() {
  const arg = (argv.find((a) => a.startsWith('--now=')) || '').split('=')[1];
  return arg ? new Date(`${arg}T00:00:00Z`) : new Date();
}

function daysUntil(dateStr, now) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return Math.floor((d.getTime() - now.getTime()) / 86_400_000);
}

// ── declaration extractors (pure, so the self-test can drive them directly) ───

/** `FROM node:24.18-alpine3.24` / `FROM node:20-alpine AS builder` → major 24 / 20. */
export function majorsFromDockerfile(text) {
  const out = [];
  const re = /^\s*FROM\s+node:(\d+)[^\s]*/gim;
  let m;
  while ((m = re.exec(text)) !== null) out.push({ major: Number(m[1]), snippet: m[0].trim() });
  return out;
}

/** `node-version: '24'` / `node-version: 24.18.1` → major 24. Ignores `${{ matrix.x }}`. */
export function majorsFromWorkflow(text) {
  const out = [];
  const re = /node-version:\s*['"]?(\d+)(?:\.\d+)*['"]?/gi;
  let m;
  while ((m = re.exec(text)) !== null) out.push({ major: Number(m[1]), snippet: m[0].trim() });
  return out;
}

/** `">=22"` / `"22.x || 24.x"` / `"^24.1.0"` → the LOWEST major the range admits. */
export function majorsFromEngines(range) {
  if (typeof range !== 'string' || !range.trim()) return [];
  const nums = [...range.matchAll(/(\d+)(?:\.\d+)*/g)].map((m) => Number(m[1]));
  if (!nums.length) return [];
  // The floor is what a self-hoster will actually run, so it is the honest thing to check.
  return [{ major: Math.min(...nums), snippet: `engines.node ${range}` }];
}

// ── EOL table ────────────────────────────────────────────────────────────────

/** Returns {ok:true, table} or {ok:false, reason} — never throws, never guesses. */
export function loadTable(raw, now) {
  let d;
  try {
    d = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `EOL table is unparseable: ${err instanceof Error ? err.message : err}` };
  }
  const eol = d && typeof d === 'object' ? d.eol : null;
  if (!eol || typeof eol !== 'object' || Object.keys(eol).length === 0) {
    return { ok: false, reason: 'EOL table has no `eol` entries — it would verify nothing' };
  }
  const revisit = d._TODO_revisit_by;
  if (typeof revisit === 'string' && daysUntil(revisit, now) < 0) {
    // A defensive threshold that never expires is theatre (CLAUDE.md). An out-of-date table
    // cannot be trusted to know about a major released after it was written.
    return { ok: false, reason: `EOL table is STALE — _TODO_revisit_by ${revisit} has passed; refresh it from nodejs/Release` };
  }
  const win = Number(d.warning_window_days);
  return { ok: true, table: eol, warningWindowDays: Number.isFinite(win) && win >= 0 ? win : 90 };
}

/**
 * Evaluate declarations against the table. An UNKNOWN major is INDETERMINATE, not a pass —
 * a Node major the table has never heard of is precisely the case where a silent pass is
 * most dangerous (it is probably newer than the table).
 */
export function evaluate(decls, table, warningWindowDays, now) {
  const failures = [];
  const warnings = [];
  const unknown = [];
  const ok = [];
  for (const d of decls) {
    const eolDate = table[String(d.major)];
    if (!eolDate) {
      unknown.push(d);
      continue;
    }
    const left = daysUntil(eolDate, now);
    const row = { ...d, eol: eolDate, daysLeft: left };
    if (left < 0) failures.push(row);
    else if (left <= warningWindowDays) warnings.push(row);
    else ok.push(row);
  }
  return { failures, warnings, unknown, ok };
}

// ── self-test ────────────────────────────────────────────────────────────────

const TABLE_FIXTURE = JSON.stringify({
  _TODO_revisit_by: '2099-01-01',
  warning_window_days: 90,
  eol: { 20: '2026-04-30', 22: '2027-04-30', 24: '2028-04-30' },
});
const NOW = new Date('2026-07-30T00:00:00Z');

function selfTest() {
  const fails = [];
  const t = loadTable(TABLE_FIXTURE, NOW);
  if (!t.ok) return (console.error('✖ fixture table rejected: ' + t.reason), 'FAIL');

  // (a) extraction — both Dockerfile stages, both quoting styles, engines ranges
  const dk = majorsFromDockerfile('FROM node:24.18-alpine3.24 AS builder\nRUN x\nFROM node:24.18-alpine3.24\n');
  if (dk.length !== 2 || dk.some((x) => x.major !== 24)) fails.push('Dockerfile extractor missed a stage');
  const dk20 = majorsFromDockerfile('FROM node:20-alpine AS builder');
  if (dk20.length !== 1 || dk20[0].major !== 20) fails.push('Dockerfile extractor failed on the pre-fix shape');
  const wf = majorsFromWorkflow("node-version: '24'\n  node-version: 24.18.1\n");
  if (wf.length !== 2 || wf.some((x) => x.major !== 24)) fails.push('workflow extractor missed a form');
  if (majorsFromEngines('>=22')[0]?.major !== 22) fails.push('engines extractor failed on >=22');
  if (majorsFromEngines('20.x || 22.x || 24.x')[0]?.major !== 20) fails.push('engines extractor must take the FLOOR');
  if (majorsFromEngines('')?.length !== 0) fails.push('engines extractor must tolerate an empty range');

  // (b) MUST-FIRE: a just-EOL major fails
  const eolRes = evaluate([{ major: 20, snippet: 'FROM node:20-alpine' }], t.table, t.warningWindowDays, NOW);
  if (eolRes.failures.length !== 1) fails.push('a past-EOL major (20 @ 2026-07-30) did not FAIL');

  // (c) MUST-NOT-FIRE: a supported major passes
  const okRes = evaluate([{ major: 24, snippet: 'FROM node:24' }], t.table, t.warningWindowDays, NOW);
  if (okRes.failures.length !== 0 || okRes.ok.length !== 1) fails.push('a supported major (24) did not pass cleanly');

  // (d) EXACT BOUNDARIES around EOL and the warning window (Node 22, EOL 2027-04-30)
  const at = (d) => evaluate([{ major: 22, snippet: 'x' }], t.table, t.warningWindowDays, new Date(`${d}T00:00:00Z`));
  if (at('2027-05-01').failures.length !== 1) fails.push('day AFTER eol must FAIL');
  if (at('2027-04-30').failures.length !== 0) fails.push('the eol day itself must not FAIL (0 days left)');
  if (at('2027-04-30').warnings.length !== 1) fails.push('the eol day itself must WARN');
  if (at('2027-01-30').warnings.length !== 1) fails.push('exactly 90 days out must WARN (inclusive edge)');
  if (at('2027-01-29').warnings.length !== 0) fails.push('91 days out must NOT warn');
  if (at('2027-01-29').ok.length !== 1) fails.push('91 days out must be clean');

  // (e) an UNKNOWN major is never a silent pass
  const unk = evaluate([{ major: 99, snippet: 'FROM node:99' }], t.table, t.warningWindowDays, NOW);
  if (unk.unknown.length !== 1) fails.push('an unknown major must be reported, not passed');

  // (f) FAIL-CLOSED on a broken/empty/stale table
  if (loadTable('{not json', NOW).ok) fails.push('unparseable table must not load');
  if (loadTable(JSON.stringify({ eol: {} }), NOW).ok) fails.push('empty table must not load');
  if (loadTable(JSON.stringify({ _TODO_revisit_by: '2020-01-01', eol: { 24: '2028-04-30' } }), NOW).ok) {
    fails.push('a table past its own revisit date must not load');
  }

  // (g) VACUITY GUARD: scanning nothing can never be a pass
  const empty = evaluate([], t.table, t.warningWindowDays, NOW);
  if (empty.failures.length === 0 && empty.ok.length === 0 && empty.warnings.length === 0) {
    // correct — and the caller MUST treat this as INDETERMINATE, which is asserted below
  } else {
    fails.push('empty declaration set produced findings');
  }

  if (fails.length) {
    console.error('✖ self-test FAILED:');
    fails.forEach((f) => console.error('   - ' + f));
    return 'FAIL';
  }
  console.log('✓ self-test: extraction (6), must-fire, must-not-fire, 5 exact boundaries, unknown-major, 3 fail-closed cases, vacuity guard.');
  return 'PASS';
}

function verdictAndExit(v) {
  console.log(`RUNTIME_NODE_EOL_VERDICT=${v}`);
  process.exit(v === 'PASS' ? 0 : v === 'FAIL' ? 1 : 3);
}

// ── main ─────────────────────────────────────────────────────────────────────

if (argv.includes('--self-test')) verdictAndExit(selfTest());

const st = selfTest();
if (st !== 'PASS') verdictAndExit(st); // a broken detector must never green-light the scan

const now = today();
if (!existsSync(EOL_FILE)) {
  console.error(`✖ EOL table missing at ${EOL_FILE} — cannot decide, refusing to pass`);
  verdictAndExit('INDETERMINATE');
}
const loaded = loadTable(readFileSync(EOL_FILE, 'utf8'), now);
if (!loaded.ok) {
  console.error(`✖ ${loaded.reason}`);
  verdictAndExit('INDETERMINATE');
}

let tracked;
try {
  tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
} catch (err) {
  console.error(`✖ could not enumerate tracked files: ${err instanceof Error ? err.message : err}`);
  verdictAndExit('INDETERMINATE');
}

const decls = [];
for (const f of tracked.filter((x) => /(^|\/)Dockerfile(\.[\w.-]+)?$/.test(x))) {
  for (const d of majorsFromDockerfile(readFileSync(join(ROOT, f), 'utf8'))) decls.push({ ...d, file: f });
}
for (const f of tracked.filter((x) => /^\.github\/workflows\/.*\.ya?ml$/.test(x))) {
  for (const d of majorsFromWorkflow(readFileSync(join(ROOT, f), 'utf8'))) decls.push({ ...d, file: f });
}
try {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  for (const d of majorsFromEngines(pkg?.engines?.node)) decls.push({ ...d, file: 'package.json' });
} catch {
  console.error('✖ package.json unreadable — engines floor could not be checked');
  verdictAndExit('INDETERMINATE');
}

// Vacuity guard: finding no declaration at all means the extractors broke, not that the repo
// declares no runtime. Never report that as clean.
if (decls.length === 0) {
  console.error('✖ found ZERO Node declarations across Dockerfiles, workflows and engines — refusing to report a pass');
  verdictAndExit('INDETERMINATE');
}

const { failures, warnings, unknown, ok } = evaluate(decls, loaded.table, loaded.warningWindowDays, now);

for (const r of ok) console.log(`  ✓ ${r.file}: Node ${r.major} — supported until ${r.eol} (${r.daysLeft}d)`);
for (const r of warnings) console.log(`  ⚠ ${r.file}: Node ${r.major} — EOL ${r.eol} in ${r.daysLeft}d (inside the ${loaded.warningWindowDays}d window; schedule a bump)`);
if (unknown.length) {
  console.error(`✖ ${unknown.length} declaration(s) name a Node major the EOL table has never heard of:`);
  for (const r of unknown) console.error(`   - ${r.file}: Node ${r.major} (${r.snippet}) — refresh scripts/data/node-eol.json`);
  verdictAndExit('INDETERMINATE');
}
if (failures.length) {
  console.error(`✖ ${failures.length} declaration(s) name a Node major that is PAST end-of-life:`);
  for (const r of failures) console.error(`   - ${r.file}: Node ${r.major} — EOL ${r.eol}, ${-r.daysLeft} days ago (${r.snippet})`);
  verdictAndExit('FAIL');
}

console.log(`✓ runtime EOL: ${decls.length} Node declaration(s) across Dockerfiles, workflows and engines are all within support.`);
verdictAndExit('PASS');

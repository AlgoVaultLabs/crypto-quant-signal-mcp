#!/usr/bin/env node
// @ts-check
/**
 * check-runtime-node-security.mjs — every Node runtime this repo builds is at or above the
 * newest security release of its line.
 *
 * OPS-NODE-SECURITY-FLOOR-W1 / CH2 R4 — the sibling of check-runtime-node-eol.mjs.
 *
 * THE BUG CLASS. The EOL gate knows majors, and a major can be fully supported while the image
 * built from it lacks a security release on that same line. CVE-2026-111497 was fixed in
 * 24.22.1 (and 22.23.4, 26.12.1) while both Dockerfiles said `node:24.18-alpine3.24` and every
 * gate was green: a minor-only tag names no patch, so "which Node do we ship" had no checked
 * answer. This makes the answer a literal in the file and compares it with the newest security
 * release of its line.
 *
 * WHAT IT ASSERTS:
 *   (a) every `FROM node:` line pins a full x.y.z tag AND an @sha256 digest — `24.18-alpine3.24`
 *       FAILs. The image name is normalised (any registry path ending in `/node`, any
 *       `--platform=`), so a spelling cannot step around it; a tag built from a variable is not
 *       a pin, and an image named only by a variable cannot be checked at all (INDETERMINATE).
 *   (b) every `FROM node:` line names the same reference, tag and digest.
 *   (c) each pin is at or above its line's floor in scripts/data/node-security-floor.json — per
 *       major, the newest release the Node index marks `security: true`.
 *   (d) a workflow `node-version` that pins x.y.z (or x.y) must reach the floor; a bare major,
 *       `x.x` or an alias passes — setup-node resolves the newest release.
 *   (e) a floor file past its `revisit_by`, or claiming more than 45 days of life, is
 *       INDETERMINATE: it cannot know about a security release published after it was fetched.
 *
 * NO NETWORK in the check. `--refresh` is the only mode that fetches: it rewrites the floor file
 * from https://nodejs.org/dist/index.json, then runs the check. The scheduled node_runtime_floor
 * canary is what notices a new security release between refreshes.
 *
 * Usage:
 *   node scripts/check-runtime-node-security.mjs --self-test
 *   node scripts/check-runtime-node-security.mjs
 *   node scripts/check-runtime-node-security.mjs --now=2026-12-09   # what-if / boundary testing
 *   node scripts/check-runtime-node-security.mjs --refresh          # rewrite the floor file, then check
 *
 * Verdict: exactly one terminal `RUNTIME_NODE_SECURITY_VERDICT=PASS|FAIL|INDETERMINATE`. Callers
 * gate on the TOKEN, not the code. A verified violation outranks an undecidable declaration:
 * FAIL > INDETERMINATE > PASS.
 * Exit: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE.
 */

import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CODES = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };
const FLOOR_FILE = join(ROOT, 'scripts/data/node-security-floor.json');
const INDEX_URL = 'https://nodejs.org/dist/index.json';
const REVISIT_DAYS = 45;
const EXPIRY_WARNING_DAYS = 7;
const MIN_MAJOR = 18; // the lowest line scripts/data/node-eol.json knows; older lines are not floored
const MIN_INDEX_ROWS = 100; // the live index had 875 rows on 2026-10-24; far fewer is not that index
const MIN_NEWEST_MAJOR = 24; // an index that does not know the line this repo runs is not that index

/** `--now=YYYY-MM-DD` makes boundary behaviour testable without waiting for a calendar. */
function today(argv) {
  const arg = (argv.find((a) => a.startsWith('--now=')) || '').split('=')[1];
  return arg ? new Date(`${arg}T00:00:00Z`) : new Date();
}

function daysUntil(dateStr, now) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return Math.floor((d.getTime() - now.getTime()) / 86_400_000);
}

function addDays(dateStr, days) {
  return new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/** `24.22.1` / `v24.22.1` → [24, 22, 1]; anything else → null. */
export function parseVersion(s) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(typeof s === 'string' ? s : '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Numeric, never lexicographic: 24.100.0 is above 24.22.1, 24.9.0 is below it. */
export function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

// ── declaration extractors (pure, so the self-test can drive them directly) ───

/**
 * Every FROM line whose image is Node in any spelling — `node:…`, `docker.io/library/node:…`,
 * a mirror path ending in `/node`, with or without `--platform=…` — plus every FROM line whose
 * image is a bare variable, which could be anything.
 */
export function nodeFromLines(text) {
  const out = [];
  text.split('\n').forEach((raw, i) => {
    const m = /^\s*FROM\s+((?:--\S+\s+)*)(\S+)/i.exec(raw);
    if (!m) return;
    const ref = m[2];
    const at = ref.indexOf('@');
    const name = at === -1 ? ref : ref.slice(0, at);
    const slash = name.lastIndexOf('/');
    const colon = name.indexOf(':', slash + 1);
    const repo = (colon === -1 ? name : name.slice(0, colon)).toLowerCase();
    const row = { line: i + 1, ref, snippet: raw.trim() };
    if (repo.startsWith('$')) {
      out.push({ ...row, variable: true, tag: null, digest: null });
      return;
    }
    if (repo !== 'node' && !repo.endsWith('/node')) return;
    out.push({ ...row, variable: false, tag: colon === -1 ? null : name.slice(colon + 1), digest: at === -1 ? null : ref.slice(at + 1) });
  });
  return out;
}

/** `node-version: '24'` / `with: { node-version: 24.22.0 }` / `node-version-file: .nvmrc`. */
export function nodeVersionsFromWorkflow(text) {
  const out = [];
  text.split('\n').forEach((raw, i) => {
    if (/^\s*#/.test(raw)) return;
    for (const m of raw.matchAll(/node-version(-file)?\s*:\s*("[^"]*"|'[^']*'|[^\s#,}]+)/g)) {
      out.push({ line: i + 1, file: Boolean(m[1]), value: m[2].replace(/^["']|["']$/g, ''), snippet: m[0] });
    }
  });
  return out;
}

/** What setup-node would install for a `node-version` value, as far as the floor cares. */
export function classifyNodeVersion(v) {
  if (/\$\{\{/.test(v)) return { kind: 'unresolvable', reason: 'an expression — the gate cannot resolve it' };
  if (/^\d+(?:\.x){0,2}$/i.test(v)) return { kind: 'floating' };
  if (/^(?:lts\/\*|lts\/[a-z]+|node|latest|current)$/i.test(v)) return { kind: 'floating' };
  const exact = parseVersion(v);
  if (exact) return { kind: 'exact', version: exact };
  const minor = /^(\d+)\.(\d+)(?:\.x)?$/i.exec(v);
  if (minor) return { kind: 'minor', major: Number(minor[1]), minor: Number(minor[2]) };
  return { kind: 'unresolvable', reason: 'an unrecognised node-version form' };
}

const FULL_TAG = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

// ── floor file ───────────────────────────────────────────────────────────────

/** Returns {ok:true, floor, fetchedAt, revisitBy, daysLeft} or {ok:false, reason} — never throws. */
export function loadFloor(raw, now) {
  let d;
  try {
    d = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `floor file is unparseable: ${err instanceof Error ? err.message : err}` };
  }
  const rows = d && typeof d === 'object' ? d.floor : null;
  if (!rows || typeof rows !== 'object' || Object.keys(rows).length === 0) {
    return { ok: false, reason: 'floor file has no `floor` rows — it would verify nothing' };
  }
  const floor = {};
  for (const [major, row] of Object.entries(rows)) {
    if (!/^\d+$/.test(major) || !row || typeof row !== 'object') return { ok: false, reason: `floor row ${major} is malformed` };
    if (row.version === null && row.date === null) {
      floor[major] = null; // the line has had no security release: nothing to be below
      continue;
    }
    const v = parseVersion(row.version);
    if (!v || v[0] !== Number(major) || !/^\d{4}-\d{2}-\d{2}$/.test(String(row.date))) {
      return { ok: false, reason: `floor row ${major} is malformed (${JSON.stringify(row)})` };
    }
    floor[major] = v;
  }
  const fetchedAt = typeof d.fetched_at === 'string' ? d.fetched_at : '';
  if (!/^\d{4}-\d{2}-\d{2}T/.test(fetchedAt) || Number.isNaN(Date.parse(fetchedAt))) {
    return { ok: false, reason: 'floor file has no valid `fetched_at`' };
  }
  const revisitBy = typeof d.revisit_by === 'string' ? d.revisit_by : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(revisitBy)) return { ok: false, reason: 'floor file has no valid `revisit_by`' };
  if (revisitBy > addDays(fetchedAt.slice(0, 10), REVISIT_DAYS)) {
    return { ok: false, reason: `revisit_by ${revisitBy} is more than ${REVISIT_DAYS} d after fetched_at ${fetchedAt} — run --refresh instead of extending it by hand` };
  }
  const daysLeft = daysUntil(revisitBy, now);
  if (daysLeft < 0) {
    return { ok: false, reason: `floor file is STALE — revisit_by ${revisitBy} has passed; run node scripts/check-runtime-node-security.mjs --refresh` };
  }
  return { ok: true, floor, fetchedAt, revisitBy, daysLeft };
}

/**
 * The floor from the Node release index: per major ≥ MIN_MAJOR, the newest release marked
 * `security: true`, or null when the line has none yet. The corpus is constructed here, so the
 * vacuity guards live here: an index too small, without the line this repo runs, or whose rows
 * lost the boolean `security` field is refused, never written.
 */
export function floorFromIndex(rows) {
  if (!Array.isArray(rows)) return { ok: false, reason: 'the index is not an array' };
  const lines = new Map();
  let parsed = 0;
  let security = 0;
  for (const r of rows) {
    const v = parseVersion(r && r.version);
    if (!v) continue;
    parsed++;
    if (v[0] < MIN_MAJOR) continue;
    if (typeof r.security !== 'boolean') return { ok: false, reason: `index row ${r.version} has no boolean \`security\` field` };
    if (!lines.has(v[0])) lines.set(v[0], null);
    if (!r.security) continue;
    if (typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) return { ok: false, reason: `index row ${r.version} has no valid date` };
    security++;
    const cur = lines.get(v[0]);
    if (!cur || cmp(v, cur.v) > 0) lines.set(v[0], { v, date: r.date });
  }
  if (parsed < MIN_INDEX_ROWS) return { ok: false, reason: `the index has ${parsed} release rows (< ${MIN_INDEX_ROWS})` };
  if (security === 0) return { ok: false, reason: 'the index marks no release as security' };
  const majors = [...lines.keys()].sort((a, b) => a - b);
  if (!majors.length || majors[majors.length - 1] < MIN_NEWEST_MAJOR) {
    return { ok: false, reason: `the index knows no line at or above ${MIN_NEWEST_MAJOR}` };
  }
  const floor = {};
  for (const M of majors) {
    const x = lines.get(M);
    floor[String(M)] = x ? { version: x.v.join('.'), date: x.date } : { version: null, date: null };
  }
  return { ok: true, floor };
}

// ── evaluation ───────────────────────────────────────────────────────────────

const show = (v) => v.join('.');

/**
 * Pure: FROM lines + workflow node-versions against the floor. Each finding is
 * {file, line, snippet, reason}; the verdict is verdictOf(), never re-derived by a caller.
 */
export function evaluate(froms, versions, floor) {
  const ok = [];
  const fail = [];
  const indeterminate = [];
  const lineFloor = (major) => (Object.prototype.hasOwnProperty.call(floor, String(major)) ? { known: true, v: floor[String(major)] } : { known: false, v: null });

  for (const d of froms) {
    const at = { file: d.file, line: d.line, snippet: d.snippet };
    if (d.variable) {
      indeterminate.push({ ...at, reason: 'the image is a variable — the gate cannot tell whether it is Node' });
      continue;
    }
    const m = d.tag ? FULL_TAG.exec(d.tag) : null;
    const v = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    if (!v) {
      fail.push({ ...at, reason: d.tag && d.tag.includes('$') ? '(a) the tag is built from a variable — not a pin' : `(a) the tag ${d.tag ? `\`${d.tag}\`` : '(none)'} is not a full x.y.z pin` });
      continue;
    }
    if (!d.digest || !DIGEST.test(d.digest)) {
      fail.push({ ...at, reason: '(a) no @sha256 digest — the tag alone can be re-pushed' });
      continue;
    }
    const f = lineFloor(v[0]);
    if (!f.known) indeterminate.push({ ...at, reason: `Node ${v[0]} has no row in the floor file — run --refresh` });
    else if (f.v && cmp(v, f.v) < 0) fail.push({ ...at, reason: `(c) ${show(v)} is below the Node ${v[0]} security floor ${show(f.v)}` });
    else ok.push({ ...at, reason: f.v ? `${show(v)} >= floor ${show(f.v)}` : `${show(v)} (no security release on this line yet)` });
  }

  const refs = [...new Set(froms.filter((d) => !d.variable).map((d) => d.ref))];
  if (refs.length > 1) {
    fail.push({ file: '(all Dockerfiles)', line: 0, snippet: refs.join(' | '), reason: `(b) the FROM node lines name ${refs.length} different references` });
  }

  for (const w of versions) {
    const at = { file: w.file, line: w.line, snippet: w.snippet };
    if (w.fileForm) {
      indeterminate.push({ ...at, reason: 'node-version-file is not resolved by this gate — declare node-version instead' });
      continue;
    }
    const c = classifyNodeVersion(w.value);
    if (c.kind === 'unresolvable') {
      indeterminate.push({ ...at, reason: `(d) ${c.reason}` });
    } else if (c.kind === 'floating') {
      ok.push({ ...at, reason: 'resolves the newest release' });
    } else {
      const major = c.kind === 'exact' ? c.version[0] : c.major;
      const f = lineFloor(major);
      if (!f.known) indeterminate.push({ ...at, reason: `Node ${major} has no row in the floor file — run --refresh` });
      else if (!f.v) ok.push({ ...at, reason: 'no security release on this line yet' });
      else if (c.kind === 'exact' ? cmp(c.version, f.v) < 0 : c.minor < f.v[1]) {
        fail.push({ ...at, reason: `(d) ${w.value} cannot reach the Node ${major} security floor ${show(f.v)}` });
      } else ok.push({ ...at, reason: `reaches floor ${show(f.v)}` });
    }
  }
  return { ok, fail, indeterminate, scanned: froms.length };
}

/** FAIL > INDETERMINATE > PASS; scanning no FROM node line at all is never a pass. */
export function verdictOf(res) {
  if (res.fail.length) return 'FAIL';
  if (res.indeterminate.length || res.scanned === 0) return 'INDETERMINATE';
  return 'PASS';
}

// ── self-test ────────────────────────────────────────────────────────────────

const SELF_TEST_MIN_CHECKS = 64;
const D = 'sha256:' + 'a'.repeat(64);
const E = 'sha256:' + 'b'.repeat(64);
const NOW = new Date('2026-10-25T00:00:00Z');
const FLOOR_FIXTURE = JSON.stringify({
  fetched_at: '2026-10-24T16:00:00Z',
  revisit_by: '2026-12-08',
  floor: { 22: { version: '22.23.4', date: '2026-10-20' }, 24: { version: '24.22.1', date: '2026-10-20' }, 27: { version: null, date: null } },
});

function selfTest() {
  let ran = 0;
  const fails = [];
  const check = (name, fn) => {
    ran++;
    let ok = false;
    try {
      ok = fn() === true;
    } catch (err) {
      ok = false;
    }
    if (!ok) fails.push(name);
  };
  const t = loadFloor(FLOOR_FIXTURE, NOW);
  check('the fixture floor loads', () => t.ok === true);
  const floor = t.ok ? t.floor : {};
  const from = (text) => nodeFromLines(text).map((d) => ({ ...d, file: 'Dockerfile' }));
  const wf = (text) => nodeVersionsFromWorkflow(text).map((w) => ({ ...w, file: 'w.yml', fileForm: w.file }));
  const one = (text) => verdictOf(evaluate(from(text), [], floor));
  const oneWf = (text) => verdictOf(evaluate(from(`FROM node:24.22.1-alpine3.24@${D}`), wf(text), floor));
  /** The single FAIL reason a one-line Dockerfile produces, or '' — so a case cannot pass on a different rule. */
  const why = (text) => {
    const r = evaluate(from(text), [], floor);
    return r.fail.length === 1 ? r.fail[0].reason : '';
  };
  const TAG_RULE = /^\(a\) the tag .* is not a full x\.y\.z pin$/;
  const DIGEST_RULE = /^\(a\) no @sha256 digest/;

  // (a) the pin shape — each FAIL case asserts WHICH rule fired
  check('(a) the pre-fix minor-only tag 24.18-alpine3.24 FAILs on the tag rule', () => TAG_RULE.test(why('FROM node:24.18-alpine3.24 AS builder')));
  check('(a) 24.18-alpine3.24 FAILs on the tag rule even with a digest', () => TAG_RULE.test(why(`FROM node:24.18-alpine3.24@${D} AS builder`)));
  check('(a) a full tag without a digest FAILs on the digest rule', () => DIGEST_RULE.test(why('FROM node:24.22.1-alpine3.24 AS builder')));
  check('(a) a full tag + digest at the floor PASSes', () => one(`FROM node:24.22.1-alpine3.24@${D} AS builder`) === 'PASS');
  check('(a) a digest without a tag FAILs on the tag rule', () => TAG_RULE.test(why(`FROM node@${D}`)));
  check('(a) a major-only tag FAILs on the tag rule', () => TAG_RULE.test(why(`FROM node:24-alpine@${D}`)));
  check('(a) no tag at all FAILs on the tag rule', () => TAG_RULE.test(why('FROM node')));
  check('(a) a short or upper-case digest FAILs on the digest rule', () => DIGEST_RULE.test(why('FROM node:24.22.1@sha256:ABC')));
  check('(a) a tag built from a variable FAILs', () => /^\(a\) the tag is built from a variable/.test(why(`FROM node:\${NODE_VERSION}-alpine@${D}`)));
  check('(a) --platform + docker.io/library/node cannot step around the pin rule',
    () => one('FROM --platform=linux/amd64 docker.io/library/node:24.18-alpine3.24 AS b') === 'FAIL');
  check('(a) a mirror path ending in /node is still Node', () => from(`FROM public.ecr.aws/docker/library/node:24.22.1@${D}`).length === 1);
  check('(a) an image named only by a variable is INDETERMINATE beside a clean Node line',
    () => one(`FROM node:24.22.1@${D} AS b\nFROM \${BASE_IMAGE} AS x`) === 'INDETERMINATE');
  check('(a) a stage reference, another image and a comment are not Node lines',
    () => from('FROM builder AS runtime\nFROM alpine:3.20\n# FROM node:20\nFROM nodejs-tools:1.0.0').length === 0);
  check('(a) the line number is the file line', () => from(`RUN x\n\nFROM node:24.22.1@${D}`)[0].line === 3);

  // (b) agreement
  check('(b) two stages on the same reference PASS', () => one(`FROM node:24.22.1-alpine3.24@${D} AS b\nFROM node:24.22.1-alpine3.24@${D}`) === 'PASS');
  check('(b) the same tag with two digests FAILs on the agreement rule', () => /^\(b\)/.test(why(`FROM node:24.22.1-alpine3.24@${D} AS b\nFROM node:24.22.1-alpine3.24@${E}`)));
  check('(b) two tags, both above the floor, FAIL on the agreement rule', () => /^\(b\)/.test(why(`FROM node:24.22.1-alpine3.24@${D} AS b\nFROM node:24.23.0-alpine3.24@${D}`)));

  // (c) the floor, numerically
  const FLOOR_RULE = /^\(c\) /;
  check('(c) one patch below the floor FAILs on the floor rule', () => FLOOR_RULE.test(why(`FROM node:24.22.0-alpine3.24@${D}`)));
  check('(c) exactly the floor PASSes', () => one(`FROM node:24.22.1@${D}`) === 'PASS');
  check('(c) 24.100.0 is above 24.22.1 (numeric, not lexicographic)', () => one(`FROM node:24.100.0@${D}`) === 'PASS');
  check('(c) 24.9.0 is below 24.22.1 (numeric, not lexicographic)', () => FLOOR_RULE.test(why(`FROM node:24.9.0@${D}`)));
  check('(c) another line has its own floor', () => FLOOR_RULE.test(why(`FROM node:22.23.3@${D}`)) && one(`FROM node:22.23.4@${D}`) === 'PASS');
  check('(c) a major the floor file does not know is INDETERMINATE', () => one(`FROM node:26.12.1@${D}`) === 'INDETERMINATE');
  check('(c) a line with no security release yet PASSes', () => one(`FROM node:27.0.0@${D}`) === 'PASS');
  check('(c) the pre-fix line at a full pin + digest (24.18.0) FAILs on the floor rule', () => FLOOR_RULE.test(why(`FROM node:24.18.0-alpine3.24@${D}`)));

  // (d) workflows
  check("(d) a bare major '24' PASSes", () => oneWf("      node-version: '24'") === 'PASS');
  check('(d) 24.x and lts/* PASS', () => oneWf('node-version: 24.x') === 'PASS' && oneWf('node-version: lts/*') === 'PASS');
  check('(d) an exact pin below the floor FAILs', () => oneWf('node-version: 24.22.0') === 'FAIL');
  check('(d) an exact pin at the floor PASSes', () => oneWf('node-version: "24.22.1"') === 'PASS');
  check('(d) a minor pin below the floor minor FAILs', () => oneWf('node-version: 24.21') === 'FAIL');
  check('(d) a minor pin on the floor minor PASSes (resolves its newest patch)', () => oneWf('node-version: 24.22') === 'PASS');
  check('(d) a minor pin above the floor minor PASSes', () => oneWf('node-version: 24.23.x') === 'PASS');
  check('(d) an expression is INDETERMINATE', () => oneWf('node-version: ${{ matrix.node }}') === 'INDETERMINATE');
  check('(d) node-version-file is INDETERMINATE', () => oneWf('node-version-file: .nvmrc') === 'INDETERMINATE');
  check('(d) an exact pin on an unknown major is INDETERMINATE', () => oneWf('node-version: 26.0.0') === 'INDETERMINATE');
  check('(d) an unrecognised form is INDETERMINATE', () => oneWf('node-version: ">=22"') === 'INDETERMINATE');
  check('(d) a commented-out pin is ignored', () => wf('  # node-version: 20.0.0').length === 0);
  check('(d) a flow mapping is read', () => oneWf('with: { node-version: 24.22.0, cache: npm }') === 'FAIL');
  check('(d) a trailing comment is not part of the value', () => wf("node-version: '24' # tracks the runtime")[0].value === '24');

  // (e) the floor file fails closed
  const at = (s) => new Date(`${s}T00:00:00Z`);
  check('(e) the day after revisit_by is STALE', () => loadFloor(FLOOR_FIXTURE, at('2026-12-09')).ok === false);
  check('(e) revisit_by itself is still usable', () => loadFloor(FLOOR_FIXTURE, at('2026-12-08')).ok === true);
  check('(e) a hand-extended revisit_by is refused',
    () => loadFloor(JSON.stringify({ ...JSON.parse(FLOOR_FIXTURE), revisit_by: '2026-12-09' }), NOW).ok === false);
  check('(e) an unparseable file is refused', () => loadFloor('{not json', NOW).ok === false);
  check('(e) an empty floor is refused', () => loadFloor(JSON.stringify({ fetched_at: '2026-10-24T00:00:00Z', revisit_by: '2026-11-01', floor: {} }), NOW).ok === false);
  check('(e) a row whose major disagrees with its key is refused',
    () => loadFloor(JSON.stringify({ fetched_at: '2026-10-24T00:00:00Z', revisit_by: '2026-11-01', floor: { 24: { version: '22.23.4', date: '2026-10-20' } } }), NOW).ok === false);
  check('(e) a row without a full version is refused',
    () => loadFloor(JSON.stringify({ fetched_at: '2026-10-24T00:00:00Z', revisit_by: '2026-11-01', floor: { 24: { version: '24.22', date: '2026-10-20' } } }), NOW).ok === false);
  check('(e) a file without fetched_at is refused', () => loadFloor(JSON.stringify({ revisit_by: '2026-11-01', floor: { 24: { version: '24.22.1', date: '2026-10-20' } } }), NOW).ok === false);
  check('(e) a file without revisit_by is refused', () => loadFloor(JSON.stringify({ fetched_at: '2026-10-24T00:00:00Z', floor: { 24: { version: '24.22.1', date: '2026-10-20' } } }), NOW).ok === false);
  check('(e) a row without a valid date is refused',
    () => loadFloor(JSON.stringify({ fetched_at: '2026-10-24T00:00:00Z', revisit_by: '2026-11-01', floor: { 24: { version: '24.22.1', date: 'soon' } } }), NOW).ok === false);
  check('(e) a row with a null version but a date is refused, not read as "no release yet"',
    () => loadFloor(JSON.stringify({ fetched_at: '2026-10-24T00:00:00Z', revisit_by: '2026-11-01', floor: { 24: { version: null, date: '2026-10-20' } } }), NOW).ok === false);

  // --refresh derivation
  const row = (version, security, date = '2026-01-01') => ({ version, security, date });
  const filler = Array.from({ length: MIN_INDEX_ROWS }, (_, i) => row(`v0.${i}.0`, false));
  const idx = [row('v26.0.0', false), row('v24.22.1', true, '2026-10-20'), row('v24.23.0', false), row('v24.9.9', true),
    row('v24.100.0', true, '2026-11-01'), row('v22.23.4', true, '2026-10-20'), row('v16.20.2', true), ...filler];
  const f = floorFromIndex(idx);
  check('refresh: the newest security release per line, numerically', () => f.ok && f.floor['24'].version === '24.100.0' && f.floor['24'].date === '2026-11-01');
  check('refresh: a newer non-security release does not move the floor', () => f.ok && f.floor['22'].version === '22.23.4');
  check('refresh: a line with no security release is null', () => f.ok && f.floor['26'].version === null && f.floor['26'].date === null);
  check('refresh: lines below 18 are not floored', () => f.ok && !('16' in f.floor) && !('0' in f.floor));
  check('refresh: its own output loads', () => f.ok && loadFloor(JSON.stringify({ fetched_at: '2026-10-24T16:00:00Z', revisit_by: '2026-12-08', floor: f.floor }), NOW).ok === true);
  check('refresh: a short index is refused', () => floorFromIndex(idx.slice(0, 10)).ok === false);
  check('refresh: an index without a line at or above 24 is refused', () => floorFromIndex([row('v22.23.4', true), ...filler]).ok === false);
  check('refresh: a row that lost its boolean security field is refused', () => floorFromIndex([{ version: 'v24.22.1', date: '2026-10-20' }, ...idx]).ok === false);
  check('refresh: a non-array is refused', () => floorFromIndex({ rows: idx }).ok === false);
  check('refresh: an index that marks nothing security is refused', () => floorFromIndex(idx.map((r) => ({ ...r, security: false }))).ok === false);
  check('refresh: a security row without a date is refused', () => floorFromIndex([{ version: 'v24.23.1', security: true }, ...idx]).ok === false);

  // verdict precedence and vacuity
  check('verdict: FAIL outranks INDETERMINATE', () => one(`FROM node:24.18-alpine3.24\nFROM \${BASE}`) === 'FAIL');
  check('verdict: scanning no FROM node line is never a pass', () => verdictOf(evaluate([], [], floor)) === 'INDETERMINATE');

  if (ran < SELF_TEST_MIN_CHECKS) fails.push(`only ${ran} check(s) ran (floor ${SELF_TEST_MIN_CHECKS})`);
  if (fails.length) {
    console.error(`✖ self-test FAILED (${fails.length} of ${ran}):`);
    fails.forEach((x) => console.error('   - ' + x));
    return 'FAIL';
  }
  console.log(`✓ self-test: ${ran} checks — pin shape (a), agreement (b), numeric floor (c), workflows (d), fail-closed floor file (e), refresh derivation, verdict precedence, vacuity.`);
  return 'PASS';
}

function emit(verdict) {
  console.log(`RUNTIME_NODE_SECURITY_VERDICT=${verdict}`);
  process.exitCode = CODES[verdict]; // never process.exit(): a queued pipe write would lose the token
}

// ── --refresh ────────────────────────────────────────────────────────────────

const FLOOR_COMMENT = {
  _comment: 'FETCHED, then COMMITTED. Per Node major >= 18: the newest release https://nodejs.org/dist/index.json marks security:true (null = the line has none yet). check-runtime-node-security.mjs reads this file and never the network; the node_runtime_floor canary compares it with the live index.',
  _source: INDEX_URL,
  _how_to_refresh: 'node scripts/check-runtime-node-security.mjs --refresh  (rewrites this file, then runs the check; commit the result)',
  _revisit_rationale: `revisit_by = fetched_at + ${REVISIT_DAYS} d. Past it the gate is INDETERMINATE: a floor that never expires would keep passing after the next security release.`,
};

async function refresh() {
  let rows;
  try {
    const res = await fetch(INDEX_URL, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rows = await res.json();
  } catch (err) {
    return { ok: false, reason: `could not fetch ${INDEX_URL}: ${err instanceof Error ? err.message : err}` };
  }
  const f = floorFromIndex(rows);
  if (!f.ok) return f;
  const fetchedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const doc = { ...FLOOR_COMMENT, fetched_at: fetchedAt, revisit_by: addDays(fetchedAt.slice(0, 10), REVISIT_DAYS), floor: f.floor };
  writeFileSync(`${FLOOR_FILE}.tmp`, JSON.stringify(doc, null, 2) + '\n');
  renameSync(`${FLOOR_FILE}.tmp`, FLOOR_FILE);
  return { ok: true, doc };
}

// ── main ─────────────────────────────────────────────────────────────────────

/** `file:line`, or the file alone for a finding about every Dockerfile at once. */
const loc = (r) => (r.line ? `${r.file}:${r.line}` : r.file);

/** One run, start to verdict. */
async function run(argv) {
  if (argv.includes('--self-test')) return selfTest();
  const st = selfTest();
  if (st !== 'PASS') return st; // a broken detector must never green-light the scan

  if (argv.includes('--refresh')) {
    const r = await refresh();
    if (!r.ok) {
      console.error(`✖ ${r.reason} — the floor file was not touched`);
      return 'INDETERMINATE';
    }
    const lines = Object.entries(r.doc.floor).map(([M, x]) => `${M}:${x.version ?? 'none'}`).join(' ');
    console.log(`✓ floor refreshed from ${INDEX_URL} at ${r.doc.fetched_at} — ${lines}`);
  }

  if (!existsSync(FLOOR_FILE)) {
    console.error(`✖ floor file missing at ${FLOOR_FILE} — cannot decide, refusing to pass`);
    return 'INDETERMINATE';
  }
  const loaded = loadFloor(readFileSync(FLOOR_FILE, 'utf8'), today(argv));
  if (!loaded.ok) {
    console.error(`✖ ${loaded.reason}`);
    return 'INDETERMINATE';
  }

  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const froms = [];
  for (const f of tracked.filter((x) => /(^|\/)Dockerfile(\.[\w.-]+)?$/.test(x))) {
    for (const d of nodeFromLines(readFileSync(join(ROOT, f), 'utf8'))) froms.push({ ...d, file: f });
  }
  const versions = [];
  for (const f of tracked.filter((x) => /^\.github\/workflows\/.*\.ya?ml$/.test(x))) {
    for (const w of nodeVersionsFromWorkflow(readFileSync(join(ROOT, f), 'utf8'))) versions.push({ ...w, file: f, fileForm: w.file });
  }

  const res = evaluate(froms, versions, loaded.floor);
  const verdict = verdictOf(res);
  console.log(`  floor fetched ${loaded.fetchedAt}, revisit by ${loaded.revisitBy} (${loaded.daysLeft}d)`);
  if (loaded.daysLeft <= EXPIRY_WARNING_DAYS) console.log(`  ⚠ the floor file expires in ${loaded.daysLeft}d — run --refresh and commit it`);
  for (const r of res.ok) console.log(`  ✓ ${loc(r)} ${r.snippet} — ${r.reason}`);
  for (const r of res.indeterminate) console.error(`  ? ${loc(r)} ${r.snippet} — ${r.reason}`);
  for (const r of res.fail) console.error(`  ✖ ${loc(r)} ${r.snippet} — ${r.reason}`);
  if (res.scanned === 0) console.error('✖ found ZERO `FROM node` lines across tracked Dockerfiles — refusing to report a pass');
  if (verdict === 'PASS') {
    console.log(`✓ runtime security floor: ${froms.length} FROM node line(s) and ${versions.length} workflow node-version(s) are at or above the floor.`);
  }
  return verdict;
}

async function main(argv) {
  let verdict;
  try {
    verdict = await run(argv);
  } catch (err) {
    // git missing, a tracked file deleted in the working tree, …: the scan did not happen.
    console.error(`✖ the check could not run: ${err instanceof Error ? err.message : err}`);
    verdict = 'INDETERMINATE';
  }
  emit(verdict);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));

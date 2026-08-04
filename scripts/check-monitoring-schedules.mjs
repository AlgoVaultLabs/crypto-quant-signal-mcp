#!/usr/bin/env node
// @ts-check
/**
 * check-monitoring-schedules.mjs — no monitoring artifact may be scheduled on or
 * within 3 minutes of the :00 boundary.
 *
 * OPS-MONITORING-SCHEDULE-SOT-W1.
 *
 * THE BUG CLASS. CLAUDE.md carries the law — "Snapshot-sampler cron off :00
 * boundary by >=3min … :00 crons collide -> over-count CPU 50-90x" — and until
 * this gate, NOTHING enforced it. SEC-48 was a security-audit finding against
 * exactly one row (`venue-slo-tiers-drift-canary` at `0 12 * * 1`); a human read
 * a bullet list, fixed that row's crontab, and the next row scheduled on :00 was
 * free to land. A rule enforced by prose is a rule that recurs.
 *
 * The same wave found the second half of the class: the fix moved the LIVE
 * crontab and the script's comment but not `monitoring-inventory.json`, so the
 * daily reconciler paged SCHEDULE_DRIFT a day later. A cron minute was a fact
 * duplicated across five copies with no gate coupling them. This gate closes the
 * authoring-time half; the reconciler's SCHEDULE_DRIFT check closes the runtime
 * half, and both now read ONE rule file so their verdicts cannot drift.
 *
 * WHAT IT ASSERTS, over every `schedule` in the inventory — the row's own AND
 * every per-host `installed_at[].schedule` override, because `schedule_for()` in
 * the reconciler prefers the latter and a gate that read only the former would
 * be blind to the value actually in force on a host:
 *
 *   R1  offset(m) = min(m, 60 - m) >= min_offset_minutes, for EVERY minute the
 *       expression fires at. Distance to the nearest :00 in BOTH directions —
 *       :59 collides with the next hour exactly as hard as :01 collides with
 *       this one, which is why 57 is the canonical set's ceiling (60 - 57 = 3).
 *   R2  Membership in the canonical set is ADVISORY: reported, never blocked.
 *       Blocking a compliant :41 would get this gate disabled inside a week.
 *
 * RATCHET, not block-on-existing. Three rows violated at authoring time. A
 * fail-closed gate plus known violations plus "do not fix them here" would block
 * every deploy from the moment it landed, so pre-existing rows are baselined in
 * audits/monitoring-schedule-baseline.json: a baselined row REPORTS, a NEW
 * violation BLOCKS, and the baseline only ever shrinks. Same shape as
 * scripts/check_test_baseline.sh vs audits/test-baseline-known-failures.txt.
 *
 * Usage:
 *   node scripts/check-monitoring-schedules.mjs --self-test    # both directions, offline
 *   node scripts/check-monitoring-schedules.mjs --check        # scan the live inventory
 *   node scripts/check-monitoring-schedules.mjs                # same as --check
 *   node scripts/check-monitoring-schedules.mjs --classify "27 12 * * 1"
 *         # one expression -> "<STATUS> offset=<n>". This is the cross-language
 *         # parity surface: monitoring-inventory-reconcile.py --classify-schedule
 *         # MUST print byte-identical output for every input.
 *
 * Verdict: exactly one terminal `MONITORING_SCHEDULE_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Callers gate on the TOKEN, not the code (CLAUDE.md verdict-token law).
 * Exit: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE. NEW gate with no incumbent code,
 * so INDETERMINATE is 3 per the token-law default. FAIL-CLOSED — a missing rule
 * file, an unparseable expression, an exemption without a reason, or an empty
 * corpus is INDETERMINATE and blocks.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RULE_PATH = join(ROOT, 'ops/monitoring/schedule-boundary-rule.json');
const INVENTORY_PATH = join(ROOT, 'ops/monitoring/monitoring-inventory.json');
const BASELINE_PATH = join(ROOT, 'audits/monitoring-schedule-baseline.json');

/**
 * The ONE token -> exit-code mapping. Asserted directly by the self-test: a prior
 * gate's self-test checked verdict STRINGS only, so re-coding its INDETERMINATE
 * mapping to 0 left every assertion green while the gate stopped blocking.
 * @type {Record<'PASS'|'FAIL'|'INDETERMINATE', number>}
 */
const EXIT_FOR = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

/**
 * Separator for the composite `(id, source)` key.
 *
 * Written as an ESCAPE and never as a raw byte. A raw U+0000 in a tracked text file
 * makes a grep-class tool classify the whole file as binary and skip it SILENTLY at
 * exit 0, so its contents read as ABSENT rather than as unsearched —
 * scripts/check-source-greppable.mjs exists to make that unauthorable, and it caught
 * this very file on its first full-suite run. Neither an `id` nor a `source` can
 * contain this character, so the key stays unambiguous.
 */
const KEY_SEP = '\u0000';

/** Vixie-cron nickname expansions. @reboot has no minute semantics -> unparseable. */
const MACROS = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

// ── cron minute-field parsing ────────────────────────────────────────────────
// Real parsing, never a regex guess: `0-1,3-23` and `*/5` are live expressions in
// this repo and a guess would silently mis-verdict them.

/**
 * Expand one comma-separated minute term into concrete minutes.
 * @param {string} term
 * @returns {number[] | null} null = unparseable
 */
function expandTerm(term) {
  const stepSplit = term.split('/');
  if (stepSplit.length > 2) return null;
  const [rangePart, stepPart] = stepSplit;

  let step = 1;
  if (stepPart !== undefined) {
    if (!/^\d+$/.test(stepPart)) return null;
    step = Number(stepPart);
    if (step < 1) return null;
  }

  let lo;
  let hi;
  if (rangePart === '*') {
    lo = 0;
    hi = 59;
  } else if (/^\d+$/.test(rangePart)) {
    lo = Number(rangePart);
    // Vixie: `A/S` means `A-59/S`. A bare `A` with no step is the single value A.
    hi = stepPart === undefined ? lo : 59;
  } else {
    const m = /^(\d+)-(\d+)$/.exec(rangePart);
    if (!m) return null;
    lo = Number(m[1]);
    hi = Number(m[2]);
  }

  if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
  if (lo < 0 || hi > 59 || lo > hi) return null;

  const out = [];
  for (let v = lo; v <= hi; v += step) out.push(v);
  return out.length ? out : null;
}

/**
 * @param {string} field
 * @returns {number[] | null} sorted unique minutes, or null if unparseable
 */
export function expandMinuteField(field) {
  if (typeof field !== 'string' || field.trim() === '') return null;
  const minutes = new Set();
  for (const term of field.split(',')) {
    const got = expandTerm(term.trim());
    if (got === null) return null;
    for (const v of got) minutes.add(v);
  }
  return minutes.size ? [...minutes].sort((a, b) => a - b) : null;
}

/** Distance to the NEAREST :00, in both directions. @param {number} m */
export function offsetFromBoundary(m) {
  return Math.min(m, 60 - m);
}

/**
 * Classify one cron expression against the rule.
 * @param {string} expr
 * @param {{min_offset_minutes:number, canonical_minutes:number[]}} rule
 * @returns {{status:'LEGAL'|'ADVISORY'|'VIOLATION'|'UNPARSEABLE', offset:number, minutes:number[]}}
 */
export function classify(expr, rule) {
  const bad = { status: /** @type {const} */ ('UNPARSEABLE'), offset: -1, minutes: [] };
  if (typeof expr !== 'string') return bad;

  let text = expr.trim();
  if (text.startsWith('@')) {
    const expanded = MACROS[text.toLowerCase()];
    if (!expanded) return bad; // @reboot and unknown nicknames: no minute semantics
    text = expanded;
  }

  const fields = text.split(/\s+/);
  if (fields.length !== 5) return bad;

  const minutes = expandMinuteField(fields[0]);
  if (minutes === null) return bad;

  const offset = Math.min(...minutes.map(offsetFromBoundary));
  if (offset < rule.min_offset_minutes) return { status: 'VIOLATION', offset, minutes };

  const canonical = new Set(rule.canonical_minutes);
  const allCanonical = minutes.every((m) => canonical.has(m));
  return { status: allCanonical ? 'LEGAL' : 'ADVISORY', offset, minutes };
}

// ── corpus ───────────────────────────────────────────────────────────────────

/**
 * Every (id, source, schedule) the inventory declares — the row's own schedule and
 * each per-host installed_at override, which is the value actually in force there.
 * @param {{artifacts?: any[]}} inventory
 */
export function collectSchedules(inventory) {
  const out = [];
  for (const row of inventory.artifacts ?? []) {
    const exemption = row.exempt_schedule_boundary;
    if (row.schedule != null) {
      out.push({ id: row.id, source: 'row', schedule: row.schedule, exemption });
    }
    for (const entry of row.installed_at ?? []) {
      if (entry?.schedule != null) {
        out.push({
          id: row.id,
          source: `installed_at:${entry.host ?? '?'}`,
          schedule: entry.schedule,
          exemption,
        });
      }
    }
  }
  return out;
}

/**
 * Evaluate a corpus against rule + baseline.
 * @returns {{verdict:'PASS'|'FAIL'|'INDETERMINATE', blocking:any[], baselined:any[],
 *            advisory:any[], exempt:any[], indeterminate:any[], staleBaseline:any[],
 *            legal:any[], total:number}}
 */
export function evaluate(corpus, rule, baselineEntries) {
  const blocking = [];
  const baselined = [];
  const advisory = [];
  const exempt = [];
  const indeterminate = [];
  // A fully-compliant row used to fall through every bucket — counted in `total`, never
  // collected, therefore impossible to NAME in the output. That is the absence-of-evidence
  // shape this gate's own header comment forbids: a clean row silently dropped from the
  // inventory looked identical to a clean row that passed. Collect them.
  const legal = [];
  const seenViolationKeys = new Set();

  const baseIndex = new Map();
  for (const e of baselineEntries) baseIndex.set(`${e.id}${KEY_SEP}${e.source}`, e);

  for (const item of corpus) {
    const key = `${item.id}${KEY_SEP}${item.source}`;

    if (item.exemption !== undefined && item.exemption !== null && item.exemption !== false) {
      const reason = item.exemption?.reason;
      if (typeof reason !== 'string' || reason.trim() === '') {
        indeterminate.push({ ...item, why: 'exempt_schedule_boundary without a non-empty reason' });
      } else {
        exempt.push({ ...item, reason });
      }
      continue;
    }

    const c = classify(item.schedule, rule);
    if (c.status === 'UNPARSEABLE') {
      indeterminate.push({ ...item, why: 'schedule expression could not be parsed' });
      continue;
    }
    if (c.status === 'VIOLATION') {
      seenViolationKeys.add(key);
      const base = baseIndex.get(key);
      if (base && base.schedule === item.schedule) {
        baselined.push({ ...item, offset: c.offset, owner_wave: base.owner_wave });
      } else {
        blocking.push({
          ...item,
          offset: c.offset,
          reason: base
            ? `baselined at "${base.schedule}" but now "${item.schedule}" — a different violating minute`
            : 'new violation',
        });
      }
      continue;
    }
    if (c.status === 'ADVISORY') advisory.push({ ...item, offset: c.offset });
    else legal.push({ ...item, offset: c.offset });
  }

  // A baselined row that no longer violates is debt PAID. Report so the baseline can
  // shrink; never block, or fixing a row would break the build that rewards it.
  const staleBaseline = baselineEntries
    .filter((e) => !seenViolationKeys.has(`${e.id}${KEY_SEP}${e.source}`))
    .map((e) => ({ ...e, why: 'no longer violating (or row removed) — delete this baseline entry' }));

  const verdict = indeterminate.length ? 'INDETERMINATE' : blocking.length ? 'FAIL' : 'PASS';
  return {
    verdict,
    blocking,
    baselined,
    advisory,
    exempt,
    indeterminate,
    staleBaseline,
    legal,
    total: corpus.length,
  };
}

// ── self-test (two-way, vacuity-guarded) ─────────────────────────────────────

const RULE_FIXTURE = { min_offset_minutes: 3, canonical_minutes: [13, 17, 23, 27, 33, 37, 43, 47, 53, 57] };

/** @returns {'PASS'|'INDETERMINATE'} */
function selfTest() {
  const failures = [];
  let checks = 0;
  const ck = (label, got, want) => {
    checks += 1;
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g !== w) failures.push(`${label}: got ${g}, want ${w}`);
  };

  const cls = (e) => classify(e, RULE_FIXTURE).status;

  // ── 1. the >=3 rule, BOTH directions, at the exact boundary ──
  ck(':00 violates', cls('0 12 * * 1'), 'VIOLATION');
  ck(':02 violates (forward, inside 3)', cls('2 12 * * 1'), 'VIOLATION');
  ck(':03 passes (forward, exactly 3)', cls('3 12 * * 1'), 'ADVISORY');
  ck(':57 passes (backward, exactly 3)', cls('57 0 * * *'), 'LEGAL');
  ck(':58 violates (backward, inside 3)', cls('58 0 * * *'), 'VIOLATION');
  ck(':59 violates (backward, inside 3)', cls('59 0 * * *'), 'VIOLATION');
  ck('offset is nearest-boundary, not forward-only', offsetFromBoundary(58), 2);
  ck('offset at :57 is 3', offsetFromBoundary(57), 3);

  // ── 2. the two live values this wave turned on ──
  ck('27 12 * * 1 (live, post-SEC-48) passes', cls('27 12 * * 1'), 'LEGAL');
  ck('0 12 * * 1 (the stale declaration) fails', cls('0 12 * * 1'), 'VIOLATION');

  // ── 3. real parsing: ranges, lists, steps ──
  // carry-scorer's live expression. Its RANGE is in the hour field; the gate must
  // parse the whole expression and verdict on the minute alone.
  ck('7 0-1,3-23 * * * parses and passes', cls('7 0-1,3-23 * * *'), 'ADVISORY');
  ck('list with a :58 member fails on the worst minute', cls('13,28,43,58 * * * *'), 'VIOLATION');
  ck('all-canonical 10-min grid is LEGAL', cls('13,23,33,43,53 * * * *'), 'LEGAL');
  ck('same list minus the :58 is legal but off-set', cls('13,28,43 * * * *'), 'ADVISORY');
  ck('*/5 includes :00 -> fails', cls('*/5 * * * *'), 'VIOLATION');
  ck('*/5 offset is 0', classify('*/5 * * * *', RULE_FIXTURE).offset, 0);
  ck('bare * minute includes :00 -> fails', cls('* * * * *'), 'VIOLATION');
  ck('range 5-9 passes', cls('5-9 * * * *'), 'ADVISORY');
  ck('range 0-5 includes :00 -> fails', cls('0-5 * * * *'), 'VIOLATION');
  ck('stepped range 10-50/10 passes', cls('10-50/10 * * * *'), 'ADVISORY');
  ck('@hourly expands to :00 -> fails', cls('@hourly'), 'VIOLATION');
  ck('advisory = legal offset, off canonical set', cls('9 7 * * 4'), 'ADVISORY');

  // ── 4. unparseable is INDETERMINATE, never a silent pass ──
  ck('garbage', cls('banana'), 'UNPARSEABLE');
  ck('too few fields', cls('27 12 * *'), 'UNPARSEABLE');
  ck('too many fields', cls('0 27 12 * * 1'), 'UNPARSEABLE');
  ck('minute out of range', cls('61 12 * * 1'), 'UNPARSEABLE');
  ck('inverted range', cls('30-10 * * * *'), 'UNPARSEABLE');
  ck('zero step', cls('*/0 * * * *'), 'UNPARSEABLE');
  ck('@reboot has no minute semantics', cls('@reboot'), 'UNPARSEABLE');
  ck('empty', cls(''), 'UNPARSEABLE');

  // ── 5. corpus collection covers installed_at overrides ──
  const inv = {
    artifacts: [
      { id: 'a', schedule: '27 12 * * 1' },
      {
        id: 'b',
        schedule: '57 6 * * *',
        installed_at: [
          { host: 'signal-1', schedule: '57 6 * * *' },
          { host: 'aoe-1', schedule: '17 7 * * *' },
        ],
      },
      { id: 'c' },
    ],
  };
  ck('collects row + every installed_at override, skips schedule-less rows',
    collectSchedules(inv).map((x) => `${x.id}/${x.source}`),
    ['a/row', 'b/row', 'b/installed_at:signal-1', 'b/installed_at:aoe-1']);

  const ev = (corpus, baseline = []) => evaluate(corpus, RULE_FIXTURE, baseline);

  // ── 6. per-host override is linted, not just the row ──
  const overrideBad = ev(collectSchedules({
    artifacts: [{ id: 'b', schedule: '57 6 * * *', installed_at: [{ host: 'aoe-1', schedule: '0 7 * * *' }] }],
  }));
  ck('a violating installed_at override blocks', overrideBad.verdict, 'FAIL');
  ck('…and is named by its host', overrideBad.blocking.map((x) => x.source), ['installed_at:aoe-1']);

  // ── 7. exemptions: on the row, reason MANDATORY ──
  const exemptOk = ev([{ id: 'x', source: 'row', schedule: '0 12 * * 1', exemption: { reason: 'upstream fixes it at :00' } }]);
  ck('exemption WITH a reason passes', exemptOk.verdict, 'PASS');
  ck('…and is reported as exempt', exemptOk.exempt.length, 1);
  const exemptBad = ev([{ id: 'x', source: 'row', schedule: '0 12 * * 1', exemption: { note: 'because' } }]);
  ck('exemption WITHOUT a reason is INDETERMINATE', exemptBad.verdict, 'INDETERMINATE');
  const exemptEmpty = ev([{ id: 'x', source: 'row', schedule: '0 12 * * 1', exemption: { reason: '   ' } }]);
  ck('whitespace-only reason is INDETERMINATE', exemptEmpty.verdict, 'INDETERMINATE');

  // ── 8. unparseable inside a corpus is INDETERMINATE ──
  ck('unparseable row -> INDETERMINATE',
    ev([{ id: 'u', source: 'row', schedule: 'not-a-cron' }]).verdict, 'INDETERMINATE');

  // ── 9. THE RATCHET, both directions ──
  const base = [{ id: 'old', source: 'row', schedule: '0 12 * * 2', owner_wave: 'OWNER-W1' }];
  const ratchetOld = ev([{ id: 'old', source: 'row', schedule: '0 12 * * 2' }], base);
  ck('baselined violation REPORTS, does not block', ratchetOld.verdict, 'PASS');
  ck('…and is counted as baselined', ratchetOld.baselined.length, 1);
  const ratchetNew = ev([{ id: 'fresh', source: 'row', schedule: '0 9 * * *' }], base);
  ck('a NEW violation BLOCKS', ratchetNew.verdict, 'FAIL');
  const ratchetMoved = ev([{ id: 'old', source: 'row', schedule: '58 12 * * 2' }], base);
  ck('a baselined row moving to a DIFFERENT violating minute BLOCKS', ratchetMoved.verdict, 'FAIL');
  const ratchetFixed = ev([{ id: 'old', source: 'row', schedule: '27 12 * * 2' }], base);
  ck('a baselined row that got FIXED passes', ratchetFixed.verdict, 'PASS');
  ck('…and its entry is flagged stale so the baseline shrinks', ratchetFixed.staleBaseline.length, 1);

  // ── 10. the token -> EXIT CODE mapping itself ──
  // Asserting verdict strings alone is what let a sibling gate keep every
  // assertion green after its INDETERMINATE mapping was re-coded to 0.
  ck('PASS maps to exit 0', EXIT_FOR.PASS, 0);
  ck('FAIL maps to exit 1', EXIT_FOR.FAIL, 1);
  ck('INDETERMINATE maps to exit 3', EXIT_FOR.INDETERMINATE, 3);
  ck('exactly three verdicts are mappable', Object.keys(EXIT_FOR).sort(), ['FAIL', 'INDETERMINATE', 'PASS']);

  // ── 11. VACUITY, construct-vs-observe. Both corpora here are ones WE author —
  // the --self-test fixtures and the inventory file — so empty means we built
  // nothing, which is a defect, not a fact about the world. REFUSE both.
  // evaluate() is deliberately pure (it would return PASS over []); the refusal
  // lives in refuseIfVacuous and is asserted here so neither half can rot.
  ck('vacuity guard refuses an empty corpus', refuseIfVacuous(0), 'INDETERMINATE');
  ck('vacuity guard admits a non-empty corpus', refuseIfVacuous(1), null);
  ck('evaluate() stays pure — the refusal is the caller\'s job', ev([]).verdict, 'PASS');
  ck('this self-test built a non-empty fixture corpus', checks > 0, true);

  if (checks === 0) {
    console.log('self-test built ZERO checks — vacuous by construction');
    return 'INDETERMINATE';
  }
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    console.log(`self-test: ${failures.length} of ${checks} checks FAILED`);
    return 'INDETERMINATE';
  }
  console.log(`✓ self-test: ${checks} checks passed (rule both directions, range/list/step parsing, installed_at overrides, exemptions, ratchet both ways, token→exit mapping, vacuity)`);
  return 'PASS';
}

/** @param {number} n @returns {'INDETERMINATE'|null} */
function refuseIfVacuous(n) {
  return n === 0 ? 'INDETERMINATE' : null;
}

// ── entrypoint ───────────────────────────────────────────────────────────────

/** @param {'PASS'|'FAIL'|'INDETERMINATE'} verdict */
function verdictAndExit(verdict) {
  console.log(`MONITORING_SCHEDULE_VERDICT=${verdict}`);
  process.exit(EXIT_FOR[verdict]);
}

function readJson(path, label) {
  if (!existsSync(path)) {
    console.log(`  ✗ ${label} not found at ${path}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.log(`  ✗ ${label} is not valid JSON: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

const argv = process.argv.slice(2);

// --classify: the cross-language parity surface. One expression in, one line out.
if (argv.includes('--classify')) {
  const expr = argv[argv.indexOf('--classify') + 1];
  const rule = readJson(RULE_PATH, 'schedule-boundary-rule.json');
  if (!rule) process.exit(EXIT_FOR.INDETERMINATE);
  const c = classify(expr ?? '', rule);
  console.log(`${c.status} offset=${c.offset}`);
  process.exit(0);
}

// The self-test gates the real scan: a gate whose own logic is broken must never
// report on the corpus.
const st = selfTest();
if (st !== 'PASS') verdictAndExit('INDETERMINATE');
if (argv.includes('--self-test')) verdictAndExit('PASS');

const rule = readJson(RULE_PATH, 'schedule-boundary-rule.json');
if (!rule) verdictAndExit('INDETERMINATE');
if (!Number.isInteger(rule.min_offset_minutes) || !Array.isArray(rule.canonical_minutes)) {
  console.log('  ✗ rule file is missing min_offset_minutes or canonical_minutes');
  verdictAndExit('INDETERMINATE');
}

const inventory = readJson(INVENTORY_PATH, 'monitoring-inventory.json');
if (!inventory) verdictAndExit('INDETERMINATE');

// The baseline is OPTIONAL only in the sense that an empty one is legal; a present
// but malformed one is INDETERMINATE, never "assume no baseline".
let baselineEntries = [];
if (existsSync(BASELINE_PATH)) {
  const baseline = readJson(BASELINE_PATH, 'monitoring-schedule-baseline.json');
  if (!baseline) verdictAndExit('INDETERMINATE');
  if (!Array.isArray(baseline.entries)) {
    console.log('  ✗ baseline file has no `entries` array');
    verdictAndExit('INDETERMINATE');
  }
  baselineEntries = baseline.entries;
}

const corpus = collectSchedules(inventory);
if (refuseIfVacuous(corpus.length)) {
  console.log('  ✗ the inventory declares ZERO schedules. This file is authored by us, so an');
  console.log('    empty corpus is a defect in the inventory, not a fact about the world.');
  verdictAndExit('INDETERMINATE');
}

const r = evaluate(corpus, rule, baselineEntries);

// POSITIVE per-check output: a row silently skipped by a load error must not look
// identical to a row that passed.
console.log(`monitoring schedule boundary — rule: offset >= ${rule.min_offset_minutes} min from :00 (nearest, both directions)`);
console.log(`  scanned ${r.total} schedule(s) across ${(inventory.artifacts ?? []).length} inventory row(s)`);
// Read the count off the collected rows rather than re-deriving it by subtraction — two
// derivations of one number drift, and the subtraction could disagree with what is printed.
console.log(`  ✓ ${r.legal.length} on the canonical set · ${r.advisory.length} legal but off-set · ${r.exempt.length} exempt`);

for (const l of r.legal) {
  console.log(`  · LEGAL    ${l.id} [${l.source}] "${l.schedule}" — offset ${l.offset} min, on the canonical set`);
}
for (const a of r.advisory) {
  console.log(`  · ADVISORY ${a.id} [${a.source}] "${a.schedule}" — offset ${a.offset} min, legal but not in the canonical set`);
}
for (const e of r.exempt) {
  console.log(`  · EXEMPT   ${e.id} [${e.source}] "${e.schedule}" — ${e.reason}`);
}
for (const b of r.baselined) {
  console.log(`  ⚠ BASELINED ${b.id} [${b.source}] "${b.schedule}" — offset ${b.offset} min (owner: ${b.owner_wave ?? 'unknown'})`);
}
for (const s of r.staleBaseline) {
  console.log(`  ⓘ STALE BASELINE ${s.id} [${s.source}] — ${s.why}`);
}
for (const i of r.indeterminate) {
  console.log(`  ✗ INDETERMINATE ${i.id} [${i.source}] "${i.schedule}" — ${i.why}`);
}
for (const b of r.blocking) {
  console.log(`  ✗ VIOLATION ${b.id} [${b.source}] "${b.schedule}" — offset ${b.offset} min < ${rule.min_offset_minutes} (${b.reason})`);
  console.log(`      fix: move to a canonical minute — ${rule.canonical_minutes.join(', ')}`);
}

// Echoed on EVERY run so the debt cannot quietly become permanent — and, once it is
// zero, so the retired state is a REPORTED fact rather than the mere absence of a line.
// Naming a retirement wave at 0 would imply debt that no longer exists, which is the
// same "reads as coverage it does not have" failure in the opposite direction.
console.log(
  r.baselined.length === 0
    ? '  baselined violations: 0 — baseline RETIRED (OPS-RATCHET-BASELINE-RETIRE-W1); this gate is fully blocking'
    : `  baselined violations: ${r.baselined.length} (retirement: OPS-MONITORING-SCHEDULE-SWEEP-W{NEXT})`,
);

verdictAndExit(/** @type {'PASS'|'FAIL'|'INDETERMINATE'} */ (r.verdict));

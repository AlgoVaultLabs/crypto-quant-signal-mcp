#!/usr/bin/env node
// @ts-check
/**
 * check-quota-surface-conformance.mjs — OPS-QUOTA-METER-SURFACE-CONFORMANCE-W1 CH1.
 *
 * A quota fact may reach a caller only through the single derivation, and a surface that bypasses
 * it fails the build.
 *
 * WHY THIS EXISTS. Eight waves fixed the same defect eleven times: a surface emits a quota fact
 * while assuming the monthly meter. `bindingMeter()` made the derivation SINGLE and nothing made
 * it MANDATORY — measured at cf9cbb5 the identifier appears in NO gate, manifest, canary or CI
 * script, which is why instances 9, 10 and 11 were found by reading production output. CLAUDE.md:
 * "after the 3rd same-class fix the 4th MUST build a gate making the bug class structurally
 * impossible."
 *
 * THREE CHECKS, because a source scan alone catches only the structural mode:
 *
 *   CHECK B (orphan)    Every (module, primitive) call site in src/ must be covered by a registry
 *                       row. A surface added next month that nobody registers FAILS loudly.
 *                       Detection is strictly weaker than enumeration.
 *   CHECK C (detect vs  Structural detectors read the SOURCE and decide conformance independently
 *           declare)    of what the row CLAIMS, then the two are compared. This is the
 *                       "detect the thing, then JUDGE it separately" law: a checker that merely
 *                       reprints `status: 'violation'` from its own registry is tautological and
 *                       proves nothing. A row declared `conforming` that a detector finds dirty
 *                       FAILS; a row declared `violation` that every detector finds CLEAN also
 *                       FAILS, because a healed instance must be struck rather than reported
 *                       forever.
 *   CHECK A (rendered)  Lives in tests/unit/quota-surface-conformance.test.ts, driven by `npm test`
 *                       per this wave's Build Rule 2. It renders each surface through the REAL
 *                       exported path on a daily-walled caller and asserts the required fields are
 *                       present and NOT `undefined` — the INERT mode, where the surface routes
 *                       correctly but its input is undefined at run time and the field ships
 *                       absent with a green suite (the R3 defect). A source scan cannot see that.
 *
 * WHAT THIS GATE CANNOT SEE: a database column that failed to materialise is invisible to all
 * three. The post-deploy live capture from a disposable bucket remains a standing requirement.
 *
 * Verdict: exactly one terminal `QUOTA_SURFACE_CONFORMANCE_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Exit:    0 = PASS · 1 = FAIL · 3 = INDETERMINATE (the token-law default for a NEW gate — do NOT
 *          copy `check_test_baseline.sh`'s 2, which is 2 only because it already deployed 2).
 *
 * Usage:
 *   node scripts/check-quota-surface-conformance.mjs             # scan src/ against the registry
 *   node scripts/check-quota-surface-conformance.mjs --self-test # prove the checker can fail
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_DIST = join(ROOT, 'dist', 'lib', 'quota-surfaces.js');
const argv = process.argv.slice(2);

/** The ONE terminal machine-readable line. Callers gate on the TOKEN, never the bare exit code. */
const VERDICT = (tok, code) => {
  console.log(`QUOTA_SURFACE_CONFORMANCE_VERDICT=${tok}`);
  process.exit(code);
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Source normalisation
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Strip comments. A mention in a comment is not an invocation — the same rule
 * `check-canaries-wired.mjs` applies, and for the same reason.
 *
 * ORDER IS LOAD-BEARING, and this is not hypothetical — it was measured on this repo while this
 * file was being written. `src/tools/get-trade-call.ts` carries the full-line comment
 * `// /*.log.gz via logrotate weekly rotation.` Stripping BLOCK comments first makes that line's
 * `/*` open a phantom block that runs to the next real `*` + `/` ninety lines later, swallowing
 * the `withQuotaState(` and both `monthResetAtMs(` call sites in between. The first enumeration
 * run reported get-trade-call.ts as having ONE monthResetAtMs call and no withQuotaState at all.
 *
 * So: ANCHORED line comments first, then block comments. The line pattern is anchored at `^\s*`
 * deliberately — an unanchored one would eat the tail of any line containing a URL
 * (`'https://api.algovault.com/signup'` appears at four of the sites this gate scans), which is
 * the same defect wearing the opposite sign.
 *
 * This is the third recorded substrate of the comment-strip trap, after `check-canaries-wired.mjs`
 * (a JS block regex destroying YAML globs) and `OPS-TEST-GATE-RECONCILE-W1` (a gate false-positive
 * on its own docblock quoting the banned form).
 *
 * QUOTED STRINGS ARE EMPTIED FOR THE SAME REASON, and it is the fourth substrate: the first live
 * run of this gate flagged `src/lib/quota-surfaces.ts` itself as an orphan invoking
 * `monthResetAtMs`, because a registry row's `reason` string QUOTES the buggy call it describes. A
 * primitive named inside a string literal is no more an invocation than one named in a comment —
 * and emptying them is the general fix, where a path exclusion for the registry would have been a
 * suppression that hid the next real case.
 *
 * TEMPLATE literals are deliberately NOT emptied: `${…}` can hold a genuine call, so blanking them
 * would make this scan UNDER-report, which is the one direction a gate must never fail in.
 */
export function strip(text) {
  return text
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

/**
 * TS type names that may sit on the right of a `key:` in a DECLARATION. A declaration states the
 * contract; it does not emit. `src/types.ts` declares `resets_at: string;` twice and emits nothing.
 *
 * Deliberately a CLOSED list rather than a general "looks like a type" heuristic: an unrecognised
 * RHS is treated as CONSTRUCTION, so a new type name makes this scan OVER-report. That is the safe
 * direction — a gate that cries wolf gets fixed, a gate that goes quiet stays quiet.
 */
const TYPE_RHS = /^\s*(?:string|number|boolean|QuotaWall|RecommendedPath|''\s*\|\s*''|'daily'\s*\|\s*'monthly')\s*;?\s*$/;
// The `'' | ''` alternative is the post-`strip` form of a `'daily' | 'monthly'` union: `strip`
// empties quoted literals, so a declaration written as a string-union arrives here already blanked.
// Without it such a declaration reads as a construction — harmless (over-report) but noisy.

/** Balanced-paren span of a call starting at the `(` index. Returns the argument text. */
export function callSpan(text, openParenIdx) {
  let depth = 0;
  for (let i = openParenIdx; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') { depth--; if (depth === 0) return text.slice(openParenIdx + 1, i); }
  }
  return text.slice(openParenIdx + 1); // unbalanced — hand back what there is rather than throw
}

/**
 * Is this object body a TYPE LITERAL rather than a value?
 *
 * `quota: { used: number; total: number; remaining: number; resets_at: string }` DECLARES the
 * contract — `scan-trade-calls.ts` carries two of them — and declaring is not emitting. A value
 * body assigns expressions (`used: entry.used`, `remaining: 0`), none of which is a bare type.
 *
 * One non-type property is enough to call it a construction, so the failure direction is
 * OVER-reporting. Both directions are pinned by `--self-test` fixtures.
 */
export function isTypeLiteralBody(body) {
  const props = [...body.matchAll(/([A-Za-z_$][\w$]*)\s*:([^;,{}]*)/g)];
  if (props.length === 0) return false;
  return props.every((p) => TYPE_RHS.test(`${p[2]};`));
}

/** Balanced-brace span of an object literal starting at the `{` index. */
export function braceSpan(text, openBraceIdx) {
  let depth = 0;
  for (let i = openBraceIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(openBraceIdx + 1, i); }
  }
  return text.slice(openBraceIdx + 1);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Primitive detection
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Which primitives does this (already stripped) source invoke?
 *
 * The `key:*` triggers carry structural discriminators, each of which is exercised by a
 * `--self-test` fixture in BOTH directions — a structural rule nobody drives is a structural rule
 * that silently stops holding:
 *
 *   key:resets_at / retry_after_* — a TYPE DECLARATION (`resets_at: string;`) is not an emission.
 *   key:quota                     — a caller's quota block NAMES `used`. `feature-registry.ts`'s
 *                                   `quota: { unit, holdFree }` is a per-feature PRICING
 *                                   descriptor, eleven of them, and none is a meter reading.
 */
export function primitivesIn(src) {
  const found = new Set();
  const callish = {
    'new TierLimitReachedError': /new\s+TierLimitReachedError\s*\(/,
    buildTierLimitPayload: /\bbuildTierLimitPayload\s*\(/,
    quotaNoticeFacts: /\bquotaNoticeFacts\s*\(/,
    buildQuotaNoticeMessage: /\bbuildQuotaNoticeMessage\s*\(/,
    withQuotaState: /\bwithQuotaState\s*\(/,
    bindingMeter: /\bbindingMeter\s*\(/,
    monthResetAtMs: /\bmonthResetAtMs\s*\(/,
    utcDayResetAtMs: /\butcDayResetAtMs\s*\(/,
    buildSuggestedX402: /\bbuildSuggestedX402\s*\(/,
  };
  for (const [name, re] of Object.entries(callish)) if (re.test(src)) found.add(name);

  for (const key of ['resets_at', 'retry_after_days', 'retry_after_hours']) {
    const re = new RegExp(`(?:^|[\\s{,(])${key}\\s*:(.*)$`, 'gm');
    for (const m of src.matchAll(re)) {
      if (!TYPE_RHS.test(m[1])) { found.add(`key:${key}`); break; }
    }
  }

  const qre = /(?:^|[\s{,(])quota\s*:\s*\{/g;
  for (const m of src.matchAll(qre)) {
    const body = braceSpan(src, src.indexOf('{', m.index));
    if (/\bused\b/.test(body) && !isTypeLiteralBody(body)) { found.add('key:quota'); break; }
  }
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Structural detectors — CHECK C
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Each detector answers "is this module non-conforming, judged from its own source?" — with no
 * reference to what the registry claims. The comparison happens afterwards, in `evaluate`.
 */
export const DETECTORS = [
  {
    id: 'unconditional-monthly-horizon',
    /**
     * INSTANCE 9. A `TierLimitReachedError` construction whose `resetAtMs:` is an UNCONDITIONAL
     * `monthResetAtMs(` — no ternary on the wall discriminator sitting beside it.
     *
     * Scoped to the constructor's own argument span on purpose: `withQuotaState`'s
     * `resetAtMs: monthResetAtMs(license)` is CONFORMING (Q2 — that argument IS the monthly
     * meter's own reading, and `daily` + `binding` travel with it). A file-wide grep would call
     * every envelope surface a violation, which is how a gate gets muted in week one.
     *
     * The conforming form is the one already in the tree at `scan-trade-calls.ts`:
     *   resetAtMs: isDailyWall ? utcDayResetAtMs() : monthResetAtMs(license)
     */
    detect(src) {
      const hits = [];
      const re = /new\s+TierLimitReachedError\s*\(/g;
      for (const m of src.matchAll(re)) {
        const args = callSpan(src, src.indexOf('(', m.index + m[0].length - 1));
        if (/resets?AtMs\s*:\s*monthResetAtMs\s*\(/.test(args)) {
          hits.push('TierLimitReachedError({ resetAtMs: monthResetAtMs(…) }) — unconditional monthly horizon beside a `wall` discriminator');
        }
      }
      return hits;
    },
  },
  {
    id: 'quota-block-without-binding',
    /**
     * INSTANCES 10 and 12. A caller-facing `quota: { … used … }` construction that never names
     * `binding`. `tier-warning.ts` passes because its spread-on-presence branch names both `daily`
     * and `binding`; `scan-trade-calls.ts`'s success envelope and `webhook-api.ts`'s two responses
     * do not.
     */
    detect(src) {
      const hits = [];
      for (const m of src.matchAll(/(?:^|[\s{,(])quota\s*:\s*\{/g)) {
        const body = braceSpan(src, src.indexOf('{', m.index));
        if (isTypeLiteralBody(body)) continue; // a contract declaration is not an emission
        if (/\bused\b/.test(body) && !/\bbinding\b/.test(body)) {
          hits.push('quota: { … } block naming `used` but never `binding` — the caller cannot tell which meter governs');
        }
      }
      return hits;
    },
  },
  {
    id: 'wall-blind-x402-nudge',
    /**
     * INSTANCE 11. `buildSuggestedX402` declared without a `wall` parameter, so its instructions
     * noun cannot follow the wall it is attached to and renders "Free monthly quota reached." on a
     * daily refusal.
     */
    detect(src) {
      const m = /export\s+function\s+buildSuggestedX402\s*\(/.exec(src);
      if (!m) return [];
      const params = callSpan(src, src.indexOf('(', m.index + m[0].length - 1));
      return /\bwall\b/.test(params)
        ? []
        : ['buildSuggestedX402() declared with no `wall` parameter — its noun cannot follow the wall it describes'];
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Corpus construction — where the vacuity guard belongs
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Walk `src/` for TS sources.
 *
 * The vacuity guard sits HERE, at construction, not at observation: an empty file list means the
 * walk found nothing, which is a broken instrument, never "the tree is clean". `evaluate` refuses
 * to render a verdict over an empty corpus.
 */
export function collectCorpus(root = ROOT, rel = 'src') {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(join(root, d), { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
    }
  };
  walk(rel);
  return out.sort();
}

/** Registry shape contract. A row that cannot justify itself makes the config UNLOADABLE. */
export function validateRegistry(surfaces) {
  if (!Array.isArray(surfaces) || surfaces.length === 0) return 'registry is empty or not an array';
  const seen = new Set();
  for (const s of surfaces) {
    if (!s || typeof s.id !== 'string' || !s.id) return 'a row has no id';
    if (seen.has(s.id)) return `duplicate row id: ${s.id}`;
    seen.add(s.id);
    if (typeof s.module !== 'string' || !s.module) return `${s.id}: no module`;
    if (!Array.isArray(s.primitives)) return `${s.id}: primitives is not an array`;
    if (s.status !== 'conforming' && (typeof s.reason !== 'string' || s.reason.length < 25)) {
      return `${s.id}: status "${s.status}" requires a reason of >=25 chars — a non-conforming row must justify itself`;
    }
    if ((s.status === 'violation' || s.status === 'deferred') && !s.ownerWave) {
      return `${s.id}: status "${s.status}" requires an ownerWave — a violation with no owner is a silence`;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Evaluation
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * @param surfaces registry rows
 * @param corpus   Map<relPath, rawSource>
 */
export function evaluate(surfaces, corpus) {
  const cfgErr = validateRegistry(surfaces);
  if (cfgErr) return { verdict: 'INDETERMINATE', why: `registry invalid: ${cfgErr}` };
  if (!corpus || corpus.size === 0) {
    return { verdict: 'INDETERMINATE', why: 'scan corpus is empty — the walk found no source to read' };
  }

  const byModule = new Map();
  for (const s of surfaces) {
    if (!byModule.has(s.module)) byModule.set(s.module, []);
    byModule.get(s.module).push(s);
  }

  const orphans = [];     // check B — a call site no row covers
  const mismatches = [];  // check C — declared conforming, detected dirty
  const confirmed = [];   // check C — declared violation, detected dirty. STILL FAILS: this gate is
                          // loud by design, and CH1's green criterion is that it names exactly the
                          // known-bad set. It goes quiet only when the rows are FIXED and flipped.
  const stale = [];       // check C — declared violation/deferred, detected CLEAN. Must be struck.
  const deferredHits = []; // reported, never fatal — see QuotaSurfaceStatus.deferred
  let scanned = 0;

  for (const [file, raw] of corpus) {
    const src = strip(raw);
    const prims = primitivesIn(src);
    if (prims.size === 0) continue;
    scanned++;
    const rows = byModule.get(file) || [];
    const covered = new Set(rows.flatMap((r) => r.primitives));
    for (const p of [...prims].sort()) {
      if (!covered.has(p)) {
        orphans.push({ file, primitive: p, check: 'B', why: rows.length ? 'no registry row for this module covers this primitive' : 'module is not in the registry at all' });
      }
    }

    const dirty = DETECTORS.flatMap((d) => d.detect(src).map((w) => ({ detector: d.id, why: w })));
    const declared = rows.filter((r) => r.status !== 'excluded');
    const statuses = new Set(declared.map((r) => r.status));

    if (dirty.length) {
      if (statuses.has('deferred')) {
        for (const d of dirty) deferredHits.push({ file, detector: d.detector, why: d.why, ownerWave: declared.find((r) => r.status === 'deferred').ownerWave });
      } else if (statuses.has('violation')) {
        for (const d of dirty) confirmed.push({ file, check: 'C', detector: d.detector, why: d.why });
      } else {
        for (const d of dirty) {
          mismatches.push({ file, check: 'C', detector: d.detector, why: `detected non-conforming but declared "${[...statuses].join('/') || 'unregistered'}": ${d.why}` });
        }
      }
    } else if (statuses.has('violation') || statuses.has('deferred')) {
      stale.push({
        file, check: 'C', detector: '(none)',
        why: 'declared a violation but every detector finds it CLEAN — a healed instance must be STRUCK from the registry, not reported forever',
      });
    }
  }

  if (scanned === 0) {
    return { verdict: 'INDETERMINATE', why: `corpus of ${corpus.size} files yielded ZERO emitting primitives — the detector set is broken, not the tree` };
  }

  const violations = [...orphans, ...mismatches, ...confirmed, ...stale];
  return {
    verdict: violations.length ? 'FAIL' : 'PASS',
    violations, deferredHits, scanned, corpusSize: corpus.size,
    rows: surfaces.length,
    counts: { orphans: orphans.length, mismatches: mismatches.length, confirmed: confirmed.length, stale: stale.length },
    exempt: surfaces.filter((s) => s.status === 'exempt-monthly-only' || s.status === 'excluded'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Self-test
// ─────────────────────────────────────────────────────────────────────────────────────────────

const ROW = (over = {}) => ({
  id: 'fixture', module: 'src/f.ts', primitives: ['key:quota'], emits: [],
  status: 'conforming', meterAware: true, dailyRequiredFields: [], ...over,
});

async function selfTest() {
  const fails = [];
  const RAN = { count: 0 };
  /** An assertion that RAISES is not an assertion — it aborts the suite instead of printing FAIL. */
  const check = (name, fn) => {
    RAN.count++;
    try { const bad = fn(); if (bad) fails.push(`${name}: ${bad}`); }
    catch (e) { fails.push(`${name}: threw ${e && e.message ? e.message : e}`); }
  };
  const one = (src) => new Map([['src/f.ts', src]]);

  // ── conforming surface ────────────────────────────────────────────────────────────────────
  check('conforming ⇒ PASS', () => {
    const r = evaluate([ROW()], one('const m = { quota: { used: 1, total: 2, binding: w } };'));
    return r.verdict === 'PASS' ? null : `got ${r.verdict} (${r.why || JSON.stringify(r.violations)})`;
  });

  // ── structural orphan: a call site no row covers ──────────────────────────────────────────
  check('structural orphan ⇒ FAIL', () => {
    const r = evaluate([ROW({ primitives: [] })], one('const m = { quota: { used: 1, binding: w } };'));
    return r.verdict === 'FAIL' && r.violations.some((v) => v.check === 'B') ? null : `got ${r.verdict}`;
  });
  check('unregistered module ⇒ FAIL', () => {
    const r = evaluate([ROW({ module: 'src/other.ts' })], one('const m = { quota: { used: 1, binding: w } };'));
    return r.verdict === 'FAIL' ? null : `got ${r.verdict}`;
  });

  // ── detector-vs-declaration ───────────────────────────────────────────────────────────────
  check('dirty source declared conforming ⇒ FAIL (check C)', () => {
    const r = evaluate([ROW()], one('const m = { quota: { used: 1, total: 2 } };'));
    return r.verdict === 'FAIL' && r.violations.some((v) => v.check === 'C') ? null : `got ${r.verdict}`;
  });
  check('healed source still declared violation ⇒ FAIL (stale row)', () => {
    const r = evaluate(
      [ROW({ status: 'violation', reason: 'x'.repeat(30), ownerWave: 'OPS-W1' })],
      one('const m = { quota: { used: 1, binding: w } };'),
    );
    return r.verdict === 'FAIL' && /healed/.test(r.violations.map((v) => v.why).join(' ')) ? null : `got ${r.verdict}`;
  });
  check('dirty source declared violation ⇒ still FAIL (the gate is loud, not quiet)', () => {
    const r = evaluate(
      [ROW({ status: 'violation', reason: 'x'.repeat(30), ownerWave: 'OPS-W1' })],
      one('const m = { quota: { used: 1, total: 2 } };'),
    );
    if (r.verdict !== 'FAIL') return `got ${r.verdict} — declaring a violation must never silence it`;
    return r.counts.confirmed === 1 ? null : `expected confirmed=1, got ${r.counts.confirmed}`;
  });
  check('dirty source declared DEFERRED ⇒ PASS, reported loudly with its owner', () => {
    const r = evaluate(
      [ROW({ status: 'deferred', reason: 'owned by a named follow-up wave, out of scope here', ownerWave: 'OPS-OWNER-W1' })],
      one('const m = { quota: { used: 1, total: 2 } };'),
    );
    if (r.verdict !== 'PASS') return `got ${r.verdict} — a deferred row must not block prepublishOnly forever`;
    return r.deferredHits.length === 1 && r.deferredHits[0].ownerWave === 'OPS-OWNER-W1'
      ? null : 'deferred hit not reported with its owner';
  });

  // ── the INERT shape check A owns, asserted here as a registry contract ────────────────────
  check('declared exemption is not reported', () => {
    const r = evaluate(
      [ROW({ status: 'exempt-monthly-only', reason: 'single meter, no daily wall — monthly is a fact' })],
      one('const m = { quota: { used: 1, binding: w } };'),
    );
    return r.verdict === 'PASS' ? null : `got ${r.verdict}`;
  });

  // ── vacuity: BOTH corpora, guarded where they are CONSTRUCTED ─────────────────────────────
  check('empty registry ⇒ INDETERMINATE', () => {
    const r = evaluate([], one('const m = { quota: { used: 1 } };'));
    return r.verdict === 'INDETERMINATE' ? null : `got ${r.verdict}`;
  });
  check('empty corpus ⇒ INDETERMINATE', () => {
    const r = evaluate([ROW()], new Map());
    return r.verdict === 'INDETERMINATE' ? null : `got ${r.verdict}`;
  });
  check('corpus with zero primitives ⇒ INDETERMINATE (broken detectors, not a clean tree)', () => {
    const r = evaluate([ROW()], one('export const x = 1;'));
    return r.verdict === 'INDETERMINATE' ? null : `got ${r.verdict}`;
  });
  check('row missing its reason ⇒ INDETERMINATE', () => {
    const r = evaluate([ROW({ status: 'violation', ownerWave: 'OPS-W1' })], one('const m = { quota: { used: 1 } };'));
    return r.verdict === 'INDETERMINATE' ? null : `got ${r.verdict}`;
  });
  check('violation with no ownerWave ⇒ INDETERMINATE', () => {
    const r = evaluate([ROW({ status: 'violation', reason: 'x'.repeat(30) })], one('const m = { quota: { used: 1 } };'));
    return r.verdict === 'INDETERMINATE' ? null : `got ${r.verdict}`;
  });

  // ── the two structural discriminators, BOTH directions ────────────────────────────────────
  check('type DECLARATION is not an emission', () => {
    const p = primitivesIn('interface Q {\n  resets_at: string;\n}');
    return p.has('key:resets_at') ? 'declaration counted as construction' : null;
  });
  check('key CONSTRUCTION is an emission', () => {
    const p = primitivesIn('const o = { resets_at: new Date(x).toISOString() };');
    return p.has('key:resets_at') ? null : 'construction not counted';
  });
  check('pricing descriptor `quota: { unit, holdFree }` is not a meter reading', () => {
    const p = primitivesIn("const f = { quota: { unit: 'per-call', holdFree: false } };");
    return p.has('key:quota') ? 'pricing descriptor counted as a caller quota block' : null;
  });
  check("caller quota block naming `used` IS a meter reading", () => {
    const p = primitivesIn('const r = { quota: { used: 1, total: 2, remaining: 1 } };');
    return p.has('key:quota') ? null : 'caller quota block not counted';
  });
  check('a quota TYPE LITERAL is not an emission', () => {
    const p = primitivesIn('interface R {\n  quota: { used: number; total: number; remaining: number; resets_at: string };\n}');
    return p.has('key:quota') ? 'an interface field was counted as an emission' : null;
  });
  check('a quota type literal does not trip the binding detector', () => {
    const hits = DETECTORS.find((d) => d.id === 'quota-block-without-binding')
      .detect('interface R {\n  quota: { used: number; total: number; remaining: number };\n}');
    return hits.length === 0 ? null : `declaration flagged as a violation (${hits.length})`;
  });
  check('a quota VALUE literal without binding DOES trip the detector', () => {
    const hits = DETECTORS.find((d) => d.id === 'quota-block-without-binding')
      .detect('const r = { quota: { used: e.used, total: e.total, remaining: 0 } };');
    return hits.length === 1 ? null : `expected 1 hit, got ${hits.length}`;
  });

  // ── the comment-strip ORDER bug, pinned in both directions ────────────────────────────────
  check('a full-line // comment containing /* does not swallow later source', () => {
    // The emission MUST sit BETWEEN the phantom opener and the next real `*/`, because that is
    // where the live defect lives (get-trade-call.ts:819 opens it, :930 closes it, and the
    // withQuotaState call is at :901 — in between). An earlier version of this fixture put the
    // emission AFTER the closing `*/`, where it survives BOTH orders — so the assertion passed
    // with the bug deliberately reintroduced. Caught only by breaking the logic on purpose.
    const src = strip('// /*.log.gz via logrotate\nconst m = { quota: { used: 1 } };\n/* real block */\nconst z = 1;');
    return /quota/.test(src) ? null : 'block-comment strip ran first and ate the emission';
  });
  check('a real block comment IS stripped', () => {
    const p = primitivesIn(strip('/* const o = { resets_at: x }; */\nexport const y = 1;'));
    return p.has('key:resets_at') ? 'commented-out emission was counted' : null;
  });
  check('a primitive QUOTED in a string literal is not an invocation', () => {
    const p = primitivesIn(strip("const row = { reason: 'passes resetAtMs: monthResetAtMs(license) unconditionally' };"));
    return p.has('monthResetAtMs') ? 'a string-literal mention was counted as a call' : null;
  });
  check('a primitive inside a TEMPLATE literal IS still an invocation', () => {
    const p = primitivesIn(strip('const s = `reset at ${monthResetAtMs(license)}`;'));
    return p.has('monthResetAtMs') ? null : 'template-literal call was blanked — the scan would under-report';
  });

  // ── the seam this self-test replaces: assert the BYPASSED artifacts too ───────────────────
  // Every scenario above hands `evaluate` a fixture corpus and a fixture registry, so the real
  // walker and the real registry path are the only code no scenario executes. That is exactly
  // where a hermetic self-test is structurally blind, so both are asserted directly.
  check('the real corpus walker returns a non-empty file list', () => {
    const files = collectCorpus();
    return files.length > 0 ? null : 'collectCorpus() found no src/**/*.ts — the walker is broken';
  });
  check('the real registry path points at the built module', () => {
    return REGISTRY_DIST.endsWith(join('dist', 'lib', 'quota-surfaces.js')) ? null : `unexpected registry path ${REGISTRY_DIST}`;
  });

  // Count the scenarios rather than hardcoding a number — a literal here goes stale silently the
  // first time someone adds a case, the same duplicated-fact class this repo already retired from
  // CLAUDE.md's hook-block count ("enumerate it, never quote a number").
  if (fails.length) {
    for (const f of fails) console.error(`  ✗ ${f}`);
    console.error(`SELF-TEST: FAIL (${fails.length} of ${RAN.count})`);
    VERDICT('FAIL', 1);
  }
  if (RAN.count === 0) {
    console.error('SELF-TEST: no scenarios ran — the suite built nothing');
    VERDICT('INDETERMINATE', 3);
  }
  console.log(`SELF-TEST: PASS (${RAN.count} scenarios — conforming · orphan · unregistered · detect-vs-declare both ways · stale-row · deferred · exemption · vacuity · structural discriminators · comment-strip order · bypassed-seam)`);
  VERDICT('PASS', 0);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  if (argv.includes('--self-test')) return selfTest();

  if (!existsSync(REGISTRY_DIST)) {
    console.error(`✗ registry not built: ${REGISTRY_DIST}`);
    console.error('  remediation: npm run build   (this gate reads the COMPILED registry, like its check-*-parity siblings)');
    VERDICT('INDETERMINATE', 3);
  }
  let surfaces;
  try {
    ({ QUOTA_SURFACES: surfaces } = await import(REGISTRY_DIST));
  } catch (e) {
    console.error(`✗ registry unloadable: ${e && e.message ? e.message : e}`);
    VERDICT('INDETERMINATE', 3);
  }

  let files;
  try { files = collectCorpus(); }
  catch (e) { console.error(`✗ corpus walk failed: ${e && e.message ? e.message : e}`); VERDICT('INDETERMINATE', 3); }

  const corpus = new Map();
  for (const f of files) {
    try { corpus.set(f, readFileSync(join(ROOT, f), 'utf8')); }
    catch (e) { console.error(`✗ unreadable: ${f} — ${e && e.message ? e.message : e}`); VERDICT('INDETERMINATE', 3); }
  }

  const r = evaluate(surfaces, corpus);
  if (r.verdict === 'INDETERMINATE') { console.error(`✗ ${r.why}`); VERDICT('INDETERMINATE', 3); }

  // Print the corpus size beside every result: a sweep that searched nothing must never look
  // like a clean one.
  const c = r.counts;
  console.log(`[quota-surfaces] registry=${r.rows} rows · corpus=${r.corpusSize} src files · ${r.scanned} emit a quota fact`);
  console.log(`[quota-surfaces] orphans=${c.orphans} declared-conforming-but-dirty=${c.mismatches} confirmed-violations=${c.confirmed} stale-rows=${c.stale} deferred=${r.deferredHits.length}`);
  for (const e of r.exempt) console.log(`  · ${e.status} ${e.id} (${e.module}) — ${e.reason.slice(0, 110)}…`);
  for (const d of r.deferredHits) console.log(`  · deferred ${d.file} [${d.detector}] → owned by ${d.ownerWave} — ${d.why}`);

  if (r.verdict === 'FAIL') {
    console.error(`\n✗ ${r.violations.length} conformance violation(s):`);
    for (const v of r.violations) {
      console.error(`  · [check ${v.check}] ${v.file}${v.primitive ? ` :: ${v.primitive}` : ''}${v.detector && v.detector !== '(none)' ? ` [${v.detector}]` : ''}`);
      console.error(`      ${v.why}`);
    }
    console.error('\n  Every surface that emits a quota fact must be a registry row in src/lib/quota-surfaces.ts,');
    console.error('  and its declared status must match what the detectors read from its source.');
    VERDICT('FAIL', 1);
  }
  VERDICT('PASS', 0);
}

main().catch((e) => {
  console.error(`✗ unhandled: ${e && e.stack ? e.stack : e}`);
  VERDICT('INDETERMINATE', 3);
});

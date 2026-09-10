#!/usr/bin/env node
/**
 * check-readme-snapshot-freshness.mjs — the git channel's producer is alive, or this fails.
 *
 * OPS-README-GIT-CHANNEL-PRODUCER-W1 CH2 (2026-09-10).
 *
 * ── WHAT THIS WATCHES ───────────────────────────────────────────────────────────────────────
 *
 * `.github/workflows/readme-snapshot-writeback.yml` (`17 1 * * *`) is the producer that commits
 * the snapshot injector's README bake to the git channel — the `raw.githubusercontent.com`
 * surface LLM crawlers and registry listings ingest. Before that workflow existed the three
 * managed literals moved EXACTLY ONCE in 40 days, and `dtrf-pfe-wr` drifted from understating
 * the headline win rate to OVERSTATING it by 0.3pp. A producer with no watcher is a producer
 * that dies quietly; this is the watcher.
 *
 * ── WHY A BAND, NOT AN EQUALITY GATE ────────────────────────────────────────────────────────
 *
 * `snapshot-landing-data.mjs:53-56` already records why an unfiltered `--check` can never be
 * clean: `totalCalls` grows every few minutes (measured 417,673 baked vs 417,687 live two
 * minutes after a successful re-bake), so "the bake is current" is true for seconds. An equality
 * gate here would be red permanently and disabled within a week.
 *
 * So this asserts that the COMMITTED value sits inside a PRODUCER-SHAPED BAND of live, using the
 * same per-metric-class tolerance vocabulary the website-drift canary already deploys —
 * continuously-growing counters are FLOOR-tolerant, scheduled values are exact — rather than
 * inventing a second dialect for the same idea:
 *
 *   FLOOR  (total_calls, merkle_batches — monotonic counters)
 *          committed <= live  AND  committed >= live * 0.90
 *          A frozen bake breaches the floor within days; normal intraday growth never does.
 *          The ceiling half matters too: committed > live means either the SoT regressed (a
 *          Data-Integrity event) or something baked a number the producer never served.
 *
 *   PP     (pfe_wr — a rate that can move in BOTH directions)
 *          |committed - live| <= 0.25pp, on the 1-decimal values the injector actually writes.
 *          Catches a directional overstatement the day it opens. 0.3pp is what shipped; 0.25 is
 *          the tightest band that a same-day re-bake never trips.
 *
 * ── ONE DERIVATION, NOT TWO ─────────────────────────────────────────────────────────────────
 *
 * The live value is resolved and formatted through `scripts/lib/snapshot-sot.mjs` — the exact
 * functions `snapshot-landing-data.mjs` bakes with. A watcher that re-implemented `formatValue`
 * would agree with its producer only by coincidence: change `float_1dp` to two decimals and the
 * gate silently compares against a differently-rounded number. The claim corpus and its target
 * files come from `scripts/snapshot-landing-manifest.json` via `claimTargets`, the same
 * expansion the injector and `check-claim-coverage.mjs` share.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT OWN ─────────────────────────────────────────────────────
 *
 * The ORPHAN-SPAN direction — "is every numeric claim site in README.md covered by a manifest
 * claim?" — belongs to `scripts/check-claim-coverage.mjs`, which was built for exactly that
 * inverse question after three same-root-cause fixes. This file asks only the forward question:
 * for each manifest claim that targets README.md, is the committed literal in band? Two gates
 * asserting one property is how they drift apart.
 *
 * Also NOT owned: `README.md:239-240`'s `<!-- SNAPSHOT-LINE-TABLE -->` rows (`All 15`,
 * `All 740+`). They carry the tag but NO manifest claim owns them, so they are outside this
 * corpus by construction. Flagged, not fixed here — OPS-README-SNAPSHOT-TABLE-ORPHAN-W{NEXT}.
 *
 * ── VERDICT CONTRACT ────────────────────────────────────────────────────────────────────────
 *
 * Exactly one terminal `README_SNAPSHOT_FRESHNESS_VERDICT=PASS|FAIL|INDETERMINATE`. Callers gate
 * on the TOKEN, never the bare exit code.
 *
 * Exit codes, and the reasoning for the split, stated here so it is not re-litigated as drift:
 *
 *   0  PASS
 *   1  FAIL           — a band breach, or a defect in OUR OWN tree: a README-targeting claim
 *                       with no declared band, a claim whose span has vanished from README.md, a
 *                       committed literal that will not parse, an empty README-claim corpus. The
 *                       manifest is a config WE author, so a gap in it is a fact about a defect,
 *                       not an inability to see — CLAUDE.md's vacuity rule ("empty input is only
 *                       vacuity when YOU were supposed to fill it") puts these on this side.
 *   3  INDETERMINATE, LOCAL   — we could not READ our own inputs (unparseable manifest,
 *                       unreadable README.md). Input we were handed and could not parse is
 *                       always indeterminate, and it fails CLOSED: the token-law default for a
 *                       new gate.
 *   0  INDETERMINATE, REMOTE  — the SoT is unreachable. Fails OPEN, deliberately, and this is
 *                       the ONE fail-open branch. It inherits the contract of the producer it
 *                       watches: `snapshot-landing-data.mjs` exits 0 on an unreachable SoT
 *                       because "cannot tell" is not "drifted". A watcher that blocked a release
 *                       harder than its own producer blocks a deploy would take the publish lane
 *                       down on network weather. The token still says INDETERMINATE, so nothing
 *                       is laundered into a pass — that is exactly what the token is for.
 *
 * One meaning, one code: "could not read our tree" and "could not reach the producer" are
 * genuinely different conditions with different correct responses, and each has exactly one code.
 *
 * Usage:
 *   node scripts/check-readme-snapshot-freshness.mjs            # check (default)
 *   node scripts/check-readme-snapshot-freshness.mjs --check
 *   node scripts/check-readme-snapshot-freshness.mjs --self-test
 *
 * Env:
 *   ALGOVAULT_README_FRESHNESS_SOT_BASE   override the SoT origin (used to point the gate at a
 *                                         dead host and prove the fail-open branch).
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { claimTargets } from './lib/manifest-targets.mjs';
import { resolveValue, formatValue, fetchSoT } from './lib/snapshot-sot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MANIFEST_PATH = join(ROOT, 'scripts', 'snapshot-landing-manifest.json');
const README_PATH = join(ROOT, 'README.md');

/**
 * BANDS — the reference data this gate DECIDES on, baked into the repo rather than fetched.
 * Fetching a decision input at gate time degrades the gate to a pass exactly when the network is
 * degraded, indistinguishably from clean.
 *
 * Every claim targeting README.md MUST appear here. A fourth one added to the manifest FAILS on
 * arrival with a named remediation rather than being silently skipped: enumeration is strictly
 * stronger than detection, and a claim this gate cannot classify is a claim it does not watch.
 */
export const BANDS = new Map([
  ['dtrf-pfe-wr', { kind: 'pp', tolerance_pp: 0.25 }],
  ['dtrf-readme-total-calls', { kind: 'floor', floor_ratio: 0.9 }],
  ['dtrf-readme-merkle-batches', { kind: 'floor', floor_ratio: 0.9 }],
]);

/** Token → exit code. Exported so the self-test asserts the MAPPING, not merely the token. */
export function mapCode(token, indeterminateScope = 'local') {
  if (token === 'PASS') return 0;
  if (token === 'FAIL') return 1;
  // See the verdict contract above: remote indeterminacy fails OPEN, local fails CLOSED.
  return indeterminateScope === 'remote' ? 0 : 3;
}

/**
 * Parse a committed or freshly-formatted literal into a number.
 * `integer_with_commas` writes "646,509"; the pfe_wr template appends a literal `%` AFTER the
 * formatted value, so the span text is "91.4%" and the sign is carried by the number itself.
 */
export function parseLiteral(text) {
  if (typeof text !== 'string') return NaN;
  return Number(text.replace(/,/g, '').replace(/%\s*$/, '').trim());
}

/**
 * Read the committed value(s) a claim's pattern points at.
 *
 * Every managed claim's `find_pattern` is `(head)VALUE(tail)` — two capture groups bracketing the
 * literal — because `replace_template` is `$1{value}...$2`. So the value is the match with the
 * two groups sliced off. A pattern of any other shape would yield a wrong slice, so the shape is
 * ASSERTED by the caller rather than assumed: a mis-shaped pattern must fail loudly, not compare
 * a wrong substring and pass.
 */
export function extractCommitted(content, findPattern) {
  const re = new RegExp(findPattern, 'g');
  const out = [];
  for (const m of content.matchAll(re)) {
    const head = m[1] ?? '';
    const tail = m[2] ?? '';
    out.push(m[0].slice(head.length, m[0].length - tail.length));
  }
  return out;
}

/** Number of capture groups in a regex source, counted by construction rather than by regex. */
export function captureGroupCount(source) {
  return new RegExp(`${source}|`).exec('').length - 1;
}

/**
 * ── THE ONE DECISION FUNCTION ───────────────────────────────────────────────────────────────
 *
 * Pure. `--check` gathers real facts and calls it; `--self-test` drives it with synthetic
 * fixtures. The shipped decision and the asserted decision are therefore the same code path and
 * cannot drift — the seam `check-shared-state.mjs` and `check_test_baseline.sh` already use.
 *
 * `facts` = {
 *   claims:      [{ id, format, find_pattern, targetsReadme }]  — README-targeting claims only
 *   readme:      string | null      (null = unreadable → LOCAL indeterminate)
 *   liveByClaim: Map<id, string|null>  formatted live literal, or null when unresolvable
 *   sotReachable:boolean
 * }
 */
export function evaluate(facts) {
  const findings = [];
  const add = (level, claimId, message, remediation) =>
    findings.push({ level, claimId, message, remediation });

  if (facts.readme === null || facts.readme === undefined) {
    add('indeterminate-local', null, 'README.md could not be read', `restore ${README_PATH}`);
    return { token: 'INDETERMINATE', scope: 'local', findings };
  }

  // Vacuity guard, placed where the corpus is CONSTRUCTED. The manifest is a config WE author,
  // so zero README-targeting claims means the manifest lost them — a defect, not a fact about
  // the world. REFUSE, and refuse as a FAIL because it is definitively our own doing.
  if (facts.claims.length === 0) {
    add('fail', null,
      'no manifest claim targets README.md — the corpus this gate watches is EMPTY',
      'restore the dtrf-pfe-wr / dtrf-readme-total-calls / dtrf-readme-merkle-batches rows in scripts/snapshot-landing-manifest.json');
    return { token: 'FAIL', scope: 'local', findings };
  }

  // The SoT check comes BEFORE any per-claim verdict: a band breach we cannot confirm is not a
  // breach. Ordering the other way round is how a gate spends its fail-open branch on a
  // condition it had already decided.
  if (!facts.sotReachable) {
    add('indeterminate-remote', null,
      'the live SoT is unreachable — cannot tell whether the committed literals are in band',
      'no action; this run is fail-open by design and the next scheduled run re-decides');
    return { token: 'INDETERMINATE', scope: 'remote', findings };
  }

  let breaches = 0;
  let unresolved = 0;

  for (const claim of facts.claims) {
    const band = BANDS.get(claim.id);
    if (!band) {
      add('fail', claim.id,
        `claim '${claim.id}' targets README.md but has NO declared band — this gate cannot classify it, so it does not watch it`,
        `add a '${claim.id}' entry to BANDS in scripts/check-readme-snapshot-freshness.mjs`);
      breaches++;
      continue;
    }

    if (claim.captureGroups !== 2) {
      add('fail', claim.id,
        `claim '${claim.id}' has ${claim.captureGroups} capture group(s); this gate reads the committed value as the match minus a leading and a trailing group, which needs exactly 2`,
        `restore the (head)VALUE(tail) shape in the claim's find_pattern, or teach this gate the new shape deliberately`);
      breaches++;
      continue;
    }

    const committedTexts = claim.committed ?? [];
    if (committedTexts.length === 0) {
      add('fail', claim.id,
        `claim '${claim.id}' matched ZERO literals in README.md — the span it manages is gone, so the injector has been writing nothing`,
        'restore the span in README.md, or retire the claim row together with its span the way HOLD-DEEMPHASIS-SWEEP-W1 did');
      breaches++;
      continue;
    }

    const liveText = facts.liveByClaim.get(claim.id);
    if (liveText === null || liveText === undefined) {
      // The endpoint answered but this claim's accessor did not resolve — a shape change at the
      // SoT. We genuinely cannot tell, and it is the REMOTE side that changed.
      add('indeterminate-remote', claim.id,
        `claim '${claim.id}' could not be resolved from the live SoT payload (accessor '${claim.accessor}')`,
        'check /api/performance-public + /api/merkle-batches for a response-shape change');
      unresolved++;
      continue;
    }
    const live = parseLiteral(liveText);
    if (!Number.isFinite(live)) {
      add('indeterminate-remote', claim.id,
        `claim '${claim.id}' formatted a live value that will not parse as a number: ${JSON.stringify(liveText)}`,
        'check the SoT payload and the claim format');
      unresolved++;
      continue;
    }

    for (const text of committedTexts) {
      const committed = parseLiteral(text);
      if (!Number.isFinite(committed)) {
        add('fail', claim.id,
          `claim '${claim.id}' committed literal ${JSON.stringify(text)} will not parse as a number`,
          'a managed span must hold only the injected literal; fix README.md');
        breaches++;
        continue;
      }

      if (band.kind === 'floor') {
        const floor = live * band.floor_ratio;
        if (committed > live) {
          add('fail', claim.id,
            `${claim.id}: committed ${text} EXCEEDS live ${liveText} — a monotonic counter cannot go backwards, so either the SoT regressed or a value was baked the producer never served`,
            'investigate the SoT before re-baking; a regression here is a Data-Integrity event');
          breaches++;
        } else if (committed < floor) {
          add('fail', claim.id,
            `${claim.id}: committed ${text} is below the ${(band.floor_ratio * 100).toFixed(0)}% floor of live ${liveText} (floor ${floor.toFixed(0)}) — the git-channel bake is FROZEN`,
            'run .github/workflows/readme-snapshot-writeback.yml (workflow_dispatch) and check why its schedule stopped producing');
          breaches++;
        } else {
          add('ok', claim.id,
            `${claim.id}: committed ${text} within [${floor.toFixed(0)}, ${liveText}] — FLOOR band holds`);
        }
      } else {
        const diff = Math.abs(committed - live);
        // Epsilon: both sides are 1-decimal values reconstructed through binary floating point,
        // so an exact-tolerance case must not fail on the last bit.
        if (diff > band.tolerance_pp + 1e-9) {
          const dir = committed > live ? 'OVERSTATES' : 'understates';
          add('fail', claim.id,
            `${claim.id}: committed ${text} ${dir} live ${liveText} by ${diff.toFixed(2)}pp (band ±${band.tolerance_pp}pp) — the git-channel bake is STALE on the one number that can move down`,
            'run .github/workflows/readme-snapshot-writeback.yml (workflow_dispatch) and check why its schedule stopped producing');
          breaches++;
        } else {
          add('ok', claim.id,
            `${claim.id}: committed ${text} vs live ${liveText} — ${diff.toFixed(2)}pp, within ±${band.tolerance_pp}pp`);
        }
      }
    }
  }

  if (breaches > 0) return { token: 'FAIL', scope: 'local', findings };
  if (unresolved > 0) return { token: 'INDETERMINATE', scope: 'remote', findings };
  return { token: 'PASS', scope: 'local', findings };
}

// ─────────── Fact gathering (the seam --self-test replaces) ───────────

export function loadReadmeClaims(manifest, root = ROOT, readme = null) {
  // `claimTargets` returns REPO-RELATIVE paths (measured, not assumed — the injector then joins
  // them onto REPO_ROOT itself). Comparing against an absolute path here silently matched
  // nothing and made the whole corpus empty; the real-tree assertions in --self-test are what
  // caught it, which is precisely the seam a hermetic fixture is blind to.
  return manifest.claims
    .filter((c) => claimTargets(c, root).includes('README.md'))
    .map((c) => ({
      id: c.id,
      accessor: c.accessor,
      format: c.format,
      sot: c.sot,
      find_pattern: c.find_pattern,
      captureGroups: captureGroupCount(c.find_pattern),
      committed: readme === null ? [] : extractCommitted(readme, c.find_pattern),
      raw: c,
    }));
}

async function gatherFacts() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    if (!Array.isArray(manifest.claims)) throw new Error('manifest has no `claims` array');
  } catch (err) {
    return { fatalLocal: `manifest could not be read at ${MANIFEST_PATH}: ${err.message}` };
  }

  let readme = null;
  if (existsSync(README_PATH)) {
    try {
      readme = readFileSync(README_PATH, 'utf8');
    } catch {
      readme = null;
    }
  }

  const claims = readme === null ? [] : loadReadmeClaims(manifest, ROOT, readme);

  // Fetch only the SoT endpoints the README claims actually need.
  const base = process.env.ALGOVAULT_README_FRESHNESS_SOT_BASE;
  const needed = new Set(claims.map((c) => c.sot));
  const dataMap = {};
  const warnings = [];
  await Promise.all(
    Object.entries(manifest.sot_endpoints ?? {})
      .filter(([name]) => needed.has(name))
      .map(async ([name, url]) => {
        const target = base ? url.replace(/^https?:\/\/[^/]+/, base.replace(/\/$/, '')) : url;
        const data = await fetchSoT(target, manifest.fetch_timeout_ms || 10000, (m) => warnings.push(m));
        if (data) dataMap[name] = data;
      }),
  );

  const sotReachable = needed.size > 0 && [...needed].every((n) => dataMap[n]);
  const liveByClaim = new Map(
    claims.map((c) => [c.id, formatValue(resolveValue(c.raw, dataMap), c.format)]),
  );

  return { claims, readme, liveByClaim, sotReachable, warnings };
}

// ─────────── Reporting ───────────

const GLYPH = { ok: '✓', fail: '✗', 'indeterminate-local': '?', 'indeterminate-remote': '?' };

function report(result, warnings = []) {
  for (const w of warnings) console.log(`  · ${w}`);
  for (const f of result.findings) {
    console.log(`  ${GLYPH[f.level] ?? '·'} ${f.message}`);
    if (f.remediation) console.log(`      remediation: ${f.remediation}`);
  }
  if (result.token === 'INDETERMINATE') {
    console.log(
      result.scope === 'remote'
        ? '[readme-snapshot-freshness] REMOTE indeterminacy — failing OPEN (exit 0), matching the injector\'s own contract. The token is INDETERMINATE; do not read this as a pass.'
        : '[readme-snapshot-freshness] LOCAL indeterminacy — failing CLOSED (exit 3).',
    );
  }
  console.log(`README_SNAPSHOT_FRESHNESS_VERDICT=${result.token}`);
}

// ─────────── Self-test ───────────

/**
 * Two-directional, vacuity-guarded, and it asserts the token→EXIT-CODE mapping rather than only
 * the token — re-coding a mapping to 0 has silently made a whole suite green before.
 *
 * It also asserts the artifacts the fixture seam BYPASSES, against the REAL tree: a hermetic
 * self-test is structurally blind to exactly what its own seam replaces, so the real manifest,
 * the real README extraction and the real capture-group shape are checked here or nowhere.
 *
 * Every case is wrapped: an assertion that RAISES is not an assertion — it aborts the suite
 * instead of printing FAIL, converting "proven able to fail" into "crashes".
 */
function selfTest() {
  let passed = 0;
  let failed = 0;
  const check = (name, fn) => {
    let ok = false;
    let detail = '';
    try {
      const r = fn();
      ok = r === true;
      if (!ok) detail = ` — got ${JSON.stringify(r)}`;
    } catch (err) {
      ok = false;
      detail = ` — THREW ${err.message}`;
    }
    if (ok) {
      passed++;
      console.log(`  ✓ ${name}`);
    } else {
      failed++;
      console.log(`  ✗ ${name}${detail}`);
    }
  };

  const claim = (id, format, committed, extra = {}) => ({
    id,
    accessor: 'x',
    format,
    sot: 'performance',
    find_pattern: '(a)[^<]+(b)',
    captureGroups: 2,
    committed,
    raw: {},
    ...extra,
  });
  const facts = (claims, live, over = {}) => ({
    claims,
    readme: '<fixture>',
    liveByClaim: new Map(Object.entries(live)),
    sotReachable: true,
    ...over,
  });

  // ── MUST-PASS ────────────────────────────────────────────────────────────────────────────
  check('in-band floor + in-band pp ⇒ PASS', () =>
    evaluate(facts(
      [claim('dtrf-readme-total-calls', 'integer_with_commas', ['640,000']),
       claim('dtrf-pfe-wr', 'float_1dp', ['91.4%'])],
      { 'dtrf-readme-total-calls': '646,509', 'dtrf-pfe-wr': '91.4' },
    )).token === 'PASS');

  check('a floor claim exactly ON the 90% floor ⇒ PASS (the band is inclusive)', () =>
    evaluate(facts([claim('dtrf-readme-merkle-batches', 'integer', ['90'])],
      { 'dtrf-readme-merkle-batches': '100' })).token === 'PASS');

  check('a pp claim exactly AT the tolerance ⇒ PASS (no last-bit false fail)', () =>
    evaluate(facts([claim('dtrf-pfe-wr', 'float_1dp', ['91.65%'])],
      { 'dtrf-pfe-wr': '91.4' })).token === 'PASS');

  // ── MUST-FAIL ────────────────────────────────────────────────────────────────────────────
  check('FLOOR BREACH (frozen bake) ⇒ FAIL', () =>
    evaluate(facts([claim('dtrf-readme-total-calls', 'integer_with_commas', ['508,268'])],
      { 'dtrf-readme-total-calls': '646,509' })).token === 'FAIL');

  check('CEILING BREACH (committed > live) ⇒ FAIL', () =>
    evaluate(facts([claim('dtrf-readme-merkle-batches', 'integer', ['200'])],
      { 'dtrf-readme-merkle-batches': '153' })).token === 'FAIL');

  check('pfe_wr OVER-band ⇒ FAIL, and the message says OVERSTATES', () => {
    const r = evaluate(facts([claim('dtrf-pfe-wr', 'float_1dp', ['91.7%'])],
      { 'dtrf-pfe-wr': '91.4' }));
    return r.token === 'FAIL' && r.findings.some((f) => f.level === 'fail' && /OVERSTATES/.test(f.message));
  });

  check('pfe_wr UNDER-band ⇒ FAIL, and the message says understates', () => {
    const r = evaluate(facts([claim('dtrf-pfe-wr', 'float_1dp', ['90.9%'])],
      { 'dtrf-pfe-wr': '91.4' }));
    return r.token === 'FAIL' && r.findings.some((f) => f.level === 'fail' && /understates/.test(f.message));
  });

  check('a README-targeting claim with NO declared band ⇒ FAIL, naming it', () => {
    const r = evaluate(facts([claim('dtrf-brand-new-claim', 'integer', ['1'])],
      { 'dtrf-brand-new-claim': '1' }));
    return r.token === 'FAIL' && r.findings.some((f) => /dtrf-brand-new-claim/.test(f.message));
  });

  check('a claim whose span matched ZERO literals ⇒ FAIL', () =>
    evaluate(facts([claim('dtrf-pfe-wr', 'float_1dp', [])],
      { 'dtrf-pfe-wr': '91.4' })).token === 'FAIL');

  check('an unparseable COMMITTED literal ⇒ FAIL', () =>
    evaluate(facts([claim('dtrf-pfe-wr', 'float_1dp', ['ninety one']),],
      { 'dtrf-pfe-wr': '91.4' })).token === 'FAIL');

  check('a find_pattern with the wrong capture-group count ⇒ FAIL', () =>
    evaluate(facts([claim('dtrf-pfe-wr', 'float_1dp', ['91.4%'], { captureGroups: 1 })],
      { 'dtrf-pfe-wr': '91.4' })).token === 'FAIL');

  // ── MUST-BE-INDETERMINATE ────────────────────────────────────────────────────────────────
  check('unreachable SoT ⇒ INDETERMINATE, scope REMOTE', () => {
    const r = evaluate(facts([claim('dtrf-pfe-wr', 'float_1dp', ['91.7%'])], {}, { sotReachable: false }));
    return r.token === 'INDETERMINATE' && r.scope === 'remote';
  });

  check('an unreachable SoT wins over a would-be breach (we cannot confirm what we cannot see)', () =>
    evaluate(facts([claim('dtrf-readme-total-calls', 'integer_with_commas', ['1'])], {}, { sotReachable: false }))
      .token === 'INDETERMINATE');

  check('a resolvable endpoint but an unresolvable ACCESSOR ⇒ INDETERMINATE, scope REMOTE', () => {
    const r = evaluate(facts([claim('dtrf-pfe-wr', 'float_1dp', ['91.4%'])], { 'dtrf-pfe-wr': null }));
    return r.token === 'INDETERMINATE' && r.scope === 'remote';
  });

  check('an unreadable README ⇒ INDETERMINATE, scope LOCAL', () => {
    const r = evaluate({ claims: [], readme: null, liveByClaim: new Map(), sotReachable: true });
    return r.token === 'INDETERMINATE' && r.scope === 'local';
  });

  check('an EMPTY README-claim corpus ⇒ FAIL (a config we author, not a fact about the world)', () =>
    evaluate(facts([], {})).token === 'FAIL');

  // ── THE TOKEN→CODE MAPPING, NOT MERELY THE TOKEN ─────────────────────────────────────────
  check('mapCode: PASS→0', () => mapCode('PASS') === 0);
  check('mapCode: FAIL→1', () => mapCode('FAIL') === 1);
  check('mapCode: INDETERMINATE local→3 (fails CLOSED)', () => mapCode('INDETERMINATE', 'local') === 3);
  check('mapCode: INDETERMINATE remote→0 (the ONE fail-open branch)', () => mapCode('INDETERMINATE', 'remote') === 0);

  // ── THE ARTIFACTS THE FIXTURE SEAM BYPASSES, AGAINST THE REAL TREE ───────────────────────
  // Everything above runs on synthetic claims and a synthetic README, so the manifest reader,
  // the regex extraction and the capture-group shape are the only code no case executes.
  let realClaims = [];
  check('REAL manifest + REAL README yield a NON-EMPTY README-claim corpus', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    const readme = readFileSync(README_PATH, 'utf8');
    realClaims = loadReadmeClaims(manifest, ROOT, readme);
    return realClaims.length > 0;
  });
  check('every REAL README claim has a declared band', () =>
    realClaims.length > 0 && realClaims.every((c) => BANDS.has(c.id)));
  check('every REAL README claim has exactly 2 capture groups', () =>
    realClaims.length > 0 && realClaims.every((c) => c.captureGroups === 2));
  check('every REAL README claim extracts >=1 committed literal that PARSES', () =>
    realClaims.length > 0 &&
    realClaims.every((c) => c.committed.length > 0 && c.committed.every((t) => Number.isFinite(parseLiteral(t)))));
  check('extractCommitted really slices the value, not the whole match', () =>
    extractCommitted('<span data-tr-field="pfe_wr">91.4%</span>', '(data-tr-field="pfe_wr"[^>]*>)[^<]+(<)')[0] === '91.4%');
  check('parseLiteral strips commas and a trailing percent', () =>
    parseLiteral('646,509') === 646509 && parseLiteral('91.4%') === 91.4);
  check('formatValue is the SHARED one — float_1dp of the live pfe shape', () =>
    formatValue(0.9139625206941918 * 100, 'float_1dp') === '91.4');

  console.log(
    `SELF-TEST: ${failed === 0 ? 'PASS' : 'FAIL'} (${passed} passed, ${failed} failed)`,
  );
  // Vacuity guard on the self-test's OWN corpus: WE build these cases, so zero of them means the
  // suite verified nothing. REFUSE rather than report a pass.
  if (passed + failed === 0) {
    console.log('  ✗ the self-test ran ZERO cases');
    return { token: 'INDETERMINATE', scope: 'local' };
  }
  return { token: failed === 0 ? 'PASS' : 'FAIL', scope: 'local' };
}

// ─────────── Entry ───────────

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--self-test')) {
    console.log('[readme-snapshot-freshness] self-test');
    const r = selfTest();
    console.log(`README_SNAPSHOT_FRESHNESS_VERDICT=${r.token}`);
    process.exit(mapCode(r.token, r.scope));
  }

  console.log('[readme-snapshot-freshness] checking the git-channel bake against live SoT');
  const gathered = await gatherFacts();
  if (gathered.fatalLocal) {
    console.log(`  ? ${gathered.fatalLocal}`);
    console.log('[readme-snapshot-freshness] LOCAL indeterminacy — failing CLOSED (exit 3).');
    console.log('README_SNAPSHOT_FRESHNESS_VERDICT=INDETERMINATE');
    process.exit(mapCode('INDETERMINATE', 'local'));
  }

  const result = evaluate(gathered);
  report(result, gathered.warnings);
  process.exit(mapCode(result.token, result.scope));
}

// Test-importable: only run when INVOKED, never when imported by the vitest suite.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    // A crash with no token is the one outcome the token law forbids.
    console.log(`  ? UNHANDLED_EXCEPTION: ${err.stack || err.message || err}`);
    console.log('README_SNAPSHOT_FRESHNESS_VERDICT=INDETERMINATE');
    process.exit(mapCode('INDETERMINATE', 'local'));
  });
}

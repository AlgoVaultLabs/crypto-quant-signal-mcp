#!/usr/bin/env node
// @ts-check
/**
 * check-external-surface-parity.mjs — do our claims OUTSIDE this repo still match the live SoT?
 *
 * EXTERNAL-SURFACE-PARITY-W1 · CH3.
 *
 * WHY THIS EXISTS. Every gate this project owns runs inside crypto-quant-signal-mcp, so a listing
 * published into somebody else's catalog repo is structurally invisible to all of them. Measured:
 * `servers/algovault-remote/tools.json` in the Docker MCP catalog fork was corrected BY HAND by an
 * earlier wave while `server.yaml` and `readme.md` sat in the same directory advertising 91.6%,
 * `375,000+ calls` and `1,300+ assets` against a live 91.71% / 508,080 / 1,748. Nothing failed
 * anywhere, because nothing was looking. Four surfaces drifted from SoT in four days and every one
 * was found by inspection — CLAUDE.md's generator rule makes the fourth a GATE.
 *
 * ENUMERATE, DO NOT DETECT. The subject is `ops/published-surface-registry.json`. This script can
 * only ever verify what that file names, which is why the registry's completeness is the real
 * deliverable and why an empty `surfaces[]` REFUSES rather than passing.
 *
 * VERDICT ORDERING, and it is deliberate: a definite FAIL outranks an INDETERMINATE. If one
 * surface is provably stale and another is unreachable, the run reports FAIL — spending the
 * indeterminate verdict on evidence already in hand is the exact defect
 * `indeterminate-vs-fail-boundary` records. Unreachable-only still reports INDETERMINATE and NEVER
 * PASS: a canary that silently skips a surface it could not fetch is indistinguishable from one
 * reporting a healthy surface.
 *
 * VACUITY. The registry is a corpus WE construct, so empty there means we built nothing — REFUSE
 * (INDETERMINATE). A surface that fetched fine but whose selector matches nothing is a different
 * animal: the fetch succeeded, so this is a definite, actionable defect (the claim was reworded or
 * removed and the registry no longer describes reality) and it FAILS.
 *
 * FRESHNESS. raw.githubusercontent.com is CDN-cached at max-age=300 in BOTH ref forms — the ref
 * form does not control freshness. The control here is a cache-buster query param, and a SHA is
 * deliberately NOT pinned: pinning would verify the commit we ourselves wrote instead of the branch
 * head anyone can push to, which is the tautology this gate exists to avoid.
 *
 * Exit: 0 PASS · 1 FAIL · 3 INDETERMINATE (token-law default for a NEW gate). Callers gate on the
 * TOKEN, never the bare code.
 *
 * Usage:
 *   node scripts/check-external-surface-parity.mjs              # live scan
 *   node scripts/check-external-surface-parity.mjs --self-test  # two-way, vacuity-guarded
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
export const TOKEN = 'EXTERNAL_SURFACE_PARITY_VERDICT';
const REGISTRY = path.join(REPO_ROOT, 'ops', 'published-surface-registry.json');
const SOT_URL = 'https://api.algovault.com/api/performance-public';
const FETCH_TIMEOUT_MS = 20000;

/** Minimum assertions the self-test must run before it may report a pass. */
const SELF_TEST_FLOOR = 14;

// ───────────────────────────── pure helpers (exported for the unit test) ─────────────────────────

/** Resolve a dotted accessor against the SoT payload. Returns undefined if any hop is missing. */
export function accessor(sot, dotted) {
  return String(dotted)
    .split('.')
    .reduce((o, k) => (o == null ? undefined : o[k]), sot);
}

/** Parse a published literal ("91.7%", "1,700+", "11") to a number. NaN if it is not numeric. */
export function parsePublished(literal) {
  const cleaned = String(literal).replace(/[,%+\s]/g, '');
  return cleaned === '' ? NaN : Number(cleaned);
}

/**
 * Pull the field's literal out of the fetched surface text.
 * `found:false` means the selector matched nothing — a definite defect, not an unknown.
 */
export function extractField(text, field) {
  let re;
  try {
    re = new RegExp(field.extract);
  } catch (err) {
    return { found: false, literal: null, error: `bad extract regex: ${err.message}` };
  }
  const m = re.exec(String(text));
  if (!m || m[1] === undefined) return { found: false, literal: null };
  return { found: true, literal: m[1].trim() };
}

/**
 * Compare one field. Two independent legs, both of which must hold:
 *   (a) the literal ON the surface equals what the registry says we published there;
 *   (b) that published value still satisfies its tolerance against the live SoT.
 * Leg (a) catches the surface being edited behind the registry's back; leg (b) is staleness.
 */
export function compareField(field, liveRaw, extracted) {
  const name = field.name;
  const published = String(field.published);
  const publishedNum = parsePublished(published);

  if (!extracted.found) {
    return {
      name,
      verdict: 'FAIL',
      detail:
        `selector matched nothing on the surface — the claim was reworded or removed, so the ` +
        `registry no longer describes reality (extract=${field.extract})` +
        (extracted.error ? ` [${extracted.error}]` : ''),
    };
  }
  // Compared NUMERICALLY, not as strings: the extract's capture group deliberately excludes the
  // unit ("91.7" from "91.7%", "1,700" from "1,700+") so that one registry row can carry the
  // human-readable published form. A string compare here silently fails every well-formed row —
  // which is exactly what the self-test caught before this shipped.
  const extractedNum = parsePublished(extracted.literal);
  if (Number.isNaN(extractedNum) || Number.isNaN(publishedNum) || extractedNum !== publishedNum) {
    return {
      name,
      verdict: 'FAIL',
      detail: `surface says "${extracted.literal}" but the registry records "${published}" — registry and surface disagree`,
    };
  }
  if (liveRaw === undefined || liveRaw === null || Number.isNaN(Number(liveRaw))) {
    return { name, verdict: 'FAIL', detail: `SoT accessor "${field.sot_accessor}" resolved to ${JSON.stringify(liveRaw)}` };
  }

  const live = Number(liveRaw) * (field.sot_scale ?? 1);
  const t = field.tolerance || {};

  if (t.type === 'EXACT_ROUNDED') {
    const dp = Number(t.dp ?? 0);
    const ok = live.toFixed(dp) === publishedNum.toFixed(dp);
    return {
      name,
      verdict: ok ? 'PASS' : 'FAIL',
      detail: `published ${published} · live ${live.toFixed(dp)} (raw ${liveRaw}) · EXACT_ROUNDED dp=${dp}`,
    };
  }
  if (t.type === 'FLOOR_BOUNDED') {
    const floor = Number(t.floor);
    const step = Number(t.step);
    const maxSteps = Number(t.max_steps ?? 1);
    const ceiling = floor + maxSteps * step;
    const ok = live >= floor && live < ceiling;
    const why = live < floor ? 'SoT REGRESSED below the published floor' : live >= ceiling ? 'published floor is now materially understated' : 'within bound';
    return {
      name,
      verdict: ok ? 'PASS' : 'FAIL',
      detail: `published ${published} · live ${live} · FLOOR_BOUNDED [${floor}, ${ceiling}) — ${why}`,
    };
  }
  return { name, verdict: 'FAIL', detail: `unknown tolerance type ${JSON.stringify(t.type)}` };
}

/**
 * Figures that must not appear on a surface declared figure-free.
 * A claim-word percentage, or any integer >= 10000 (the largest legitimate parameter value on the
 * one surface this guards is 2000, so the threshold has a 5x margin and needs no allowlist).
 */
export function findSotFigures(text) {
  const hits = [];
  const s = String(text);
  const pct = /(?:win[ _-]?rate|accuracy|verified|PFE)[^.\n]{0,40}?(\d{1,3}\.\d)%|(\d{1,3}\.\d)%[^.\n]{0,40}?(?:win[ _-]?rate|accuracy|verified|PFE)/gi;
  for (const m of s.matchAll(pct)) hits.push(m[1] ?? m[2]);
  for (const m of s.matchAll(/\b(\d{1,3}(?:,\d{3})+|\d{5,})\b/g)) {
    if (parsePublished(m[1]) >= 10000) hits.push(m[1]);
  }
  return hits;
}

/** Evaluate one registry surface against its fetched text and the live SoT payload. */
export function evaluateSurface(surface, text, sot) {
  const checks = [];
  const fields = Array.isArray(surface.fields) ? surface.fields : [];
  const figureFree = surface.assert_no_sot_figures?.enabled === true;

  if (fields.length === 0 && !figureFree) {
    checks.push({
      name: '(row)',
      verdict: 'FAIL',
      detail: 'registry row asserts nothing — it declares no fields[] and does not set assert_no_sot_figures',
    });
  }
  for (const f of fields) {
    checks.push(compareField(f, accessor(sot, f.sot_accessor), extractField(text, f)));
  }
  if (figureFree) {
    const hits = findSotFigures(text);
    checks.push({
      name: 'no_sot_figures',
      verdict: hits.length ? 'FAIL' : 'PASS',
      detail: hits.length
        ? `surface is declared figure-free but carries ${hits.length}: ${hits.join(', ')} — register each as a field with a tolerance`
        : 'surface carries no SoT-derived figure, as declared',
    });
  }
  if (surface.forbidden?.venue_count) {
    const bad = /\b\d{1,3}\s*(?:perp\s+)?(?:venues?|exchanges?)\b/i.exec(String(text));
    checks.push({
      name: 'no_venue_count',
      verdict: bad ? 'FAIL' : 'PASS',
      detail: bad ? `listing copy publishes a venue count ("${bad[0]}") — standing policy forbids it` : 'no venue count published, as required',
    });
  }
  const verdict = checks.some((c) => c.verdict === 'FAIL') ? 'FAIL' : 'PASS';
  return { id: surface.id, verdict, checks };
}

/**
 * Roll surface results up to one verdict. FAIL outranks INDETERMINATE — see the header.
 * An empty result set can only mean the corpus was empty, which the caller has already refused.
 */
export function rollup(results) {
  if (results.some((r) => r.verdict === 'FAIL')) return 'FAIL';
  if (results.some((r) => r.verdict === 'INDETERMINATE')) return 'INDETERMINATE';
  return results.length ? 'PASS' : 'INDETERMINATE';
}

/** Load + structurally validate the registry. Throws on anything that would make a run vacuous. */
export function loadRegistry(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const j = JSON.parse(raw);
  if (!Array.isArray(j.surfaces)) throw new Error('registry has no surfaces[] array');
  if (j.surfaces.length === 0) throw new Error('surfaces[] is EMPTY — we construct this corpus, so empty means we built nothing');
  const required = ['id', 'repo', 'path', 'branch', 'raw_url', 'refresh_mechanism', 'owner'];
  for (const s of j.surfaces) {
    for (const k of required) {
      if (!s[k]) throw new Error(`surface ${s.id ?? '(unnamed)'} is missing required key "${k}"`);
    }
  }
  return j;
}

const EXIT = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

// ───────────────────────────── self-test ─────────────────────────────

const SOT_FIX = { overall: { pfeWinRate: 0.9171295475683566 }, totalCalls: 508080, asset_count: 1748, timeframe_count: 11 };
const PCT_FIELD = { name: 'pfe', sot_accessor: 'overall.pfeWinRate', sot_scale: 100, published: '91.7%', extract: '(\\d{1,3}\\.\\d)% verified accuracy', tolerance: { type: 'EXACT_ROUNDED', dp: 1 } };
const ASSET_FIELD = { name: 'assets', sot_accessor: 'asset_count', published: '1,700+', extract: '([\\d,]+)\\+ assets', tolerance: { type: 'FLOOR_BOUNDED', floor: 1700, step: 100, max_steps: 2 } };

function selfTest() {
  const fails = [];
  let checked = 0;
  const expect = (label, got, want) => {
    checked++;
    if (got === want) console.log(`  ✓ ${label} ⇒ ${got}`);
    else {
      fails.push(label);
      console.log(`  ✗ ${label} ⇒ expected ${want}, got ${got}`);
    }
  };
  // Wrapped so a broken subject reports FAIL instead of ABORTING the suite — an assertion that
  // raises is not an assertion (CLAUDE.md).
  const safe = (fn) => {
    try {
      return fn();
    } catch (err) {
      return `THREW:${err.message}`;
    }
  };

  console.log('--- must-FAIL (a stale or misdescribed surface) ---');
  expect('the REAL historical defect: 91.6% against a live 91.71%',
    safe(() => compareField(PCT_FIELD, accessor(SOT_FIX, 'overall.pfeWinRate'), { found: true, literal: '91.6' }).verdict), 'FAIL');
  expect('registry and surface disagree (surface reworded behind our back)',
    safe(() => compareField({ ...PCT_FIELD, published: '91.7%' }, 0.917, { found: true, literal: '90.2' }).verdict), 'FAIL');
  expect('selector matches nothing — claim removed or reworded',
    safe(() => compareField(PCT_FIELD, 0.917, extractField('no claim here at all', PCT_FIELD)).verdict), 'FAIL');
  expect('FLOOR_BOUNDED upper leg: the real 1,300+ against a live 1,748',
    safe(() => compareField({ ...ASSET_FIELD, published: '1,300+', tolerance: { type: 'FLOOR_BOUNDED', floor: 1300, step: 100, max_steps: 2 } },
      SOT_FIX.asset_count, { found: true, literal: '1,300' }).verdict), 'FAIL');
  expect('FLOOR_BOUNDED lower leg: SoT regressed below the published floor',
    safe(() => compareField(ASSET_FIELD, 1200, { found: true, literal: '1,700' }).verdict), 'FAIL');
  expect('SoT accessor resolves to nothing',
    safe(() => compareField(PCT_FIELD, accessor(SOT_FIX, 'overall.noSuchField'), { found: true, literal: '91.7' }).verdict), 'FAIL');
  expect('a figure-free surface that grew a win-rate figure',
    safe(() => evaluateSurface({ id: 'x', assert_no_sot_figures: { enabled: true } }, 'now with 91.7% accuracy', SOT_FIX).verdict), 'FAIL');
  expect('a registry row that asserts nothing at all',
    safe(() => evaluateSurface({ id: 'x', fields: [] }, 'anything', SOT_FIX).verdict), 'FAIL');
  expect('listing copy publishing a venue count',
    safe(() => evaluateSurface({ id: 'x', fields: [], assert_no_sot_figures: { enabled: true }, forbidden: { venue_count: 'y' } }, 'across 15 exchanges', SOT_FIX).verdict), 'FAIL');

  console.log('--- must-PASS (the corrected surfaces) ---');
  expect('corrected win rate round-trips at its own precision',
    safe(() => compareField(PCT_FIELD, accessor(SOT_FIX, 'overall.pfeWinRate'), extractField('with 91.7% verified accuracy across', PCT_FIELD)).verdict), 'PASS');
  expect('corrected asset floor inside its bound',
    safe(() => compareField(ASSET_FIELD, SOT_FIX.asset_count, extractField('L2. 1,700+ assets, 11 timeframes.', ASSET_FIELD)).verdict), 'PASS');
  expect('a genuinely figure-free surface',
    safe(() => evaluateSurface({ id: 'x', assert_no_sot_figures: { enabled: true } }, '{"limit": {"default": 25, "max": 2000}}', SOT_FIX).verdict), 'PASS');

  console.log('--- verdict rollup ---');
  expect('FAIL outranks INDETERMINATE (evidence in hand is not spent on "unknown")',
    safe(() => rollup([{ verdict: 'INDETERMINATE' }, { verdict: 'FAIL' }])), 'FAIL');
  expect('an unreachable surface is INDETERMINATE, never PASS',
    safe(() => rollup([{ verdict: 'PASS' }, { verdict: 'INDETERMINATE' }])), 'INDETERMINATE');
  expect('an empty result set can never be a PASS',
    safe(() => rollup([])), 'INDETERMINATE');

  console.log('--- registry vacuity guard ---');
  expect('an empty surfaces[] REFUSES', safe(() => {
    const p = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'espw1.')), 'r.json');
    fs.writeFileSync(p, JSON.stringify({ surfaces: [] }));
    try { loadRegistry(p); return 'ACCEPTED'; } catch { return 'REFUSED'; }
  }), 'REFUSED');
  expect('the REAL committed registry loads and is structurally complete',
    safe(() => (loadRegistry(REGISTRY).surfaces.length >= 3 ? 'OK' : 'TOO_FEW')), 'OK');

  if (checked < SELF_TEST_FLOOR) {
    console.log(`${TOKEN}=INDETERMINATE — only ${checked} assertions ran (expected >= ${SELF_TEST_FLOOR})`);
    process.exit(EXIT.INDETERMINATE);
  }
  if (fails.length) {
    console.log(`${TOKEN}=FAIL — self-test ${fails.length}/${checked}: ${fails.join(' | ')}`);
    process.exit(EXIT.FAIL);
  }
  console.log(`${TOKEN}=PASS — self-test ${checked} assertions (9 must-fail, 3 must-pass, 3 rollup, 2 vacuity)`);
  process.exit(EXIT.PASS);
}

// ───────────────────────────── main ─────────────────────────────

async function fetchText(target) {
  const bust = `${target.includes('?') ? '&' : '?'}cb=${Date.now()}`;
  const res = await fetch(target + bust, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.text();
}

async function main() {
  let registry;
  try {
    registry = loadRegistry(REGISTRY);
  } catch (err) {
    console.log(`${TOKEN}=INDETERMINATE — registry unusable: ${err.message}`);
    process.exit(EXIT.INDETERMINATE);
  }

  let sot;
  try {
    sot = JSON.parse(await fetchText(SOT_URL));
  } catch (err) {
    console.log(`${TOKEN}=INDETERMINATE — live SoT unreachable (${err.message}); every comparison below would have been vacuous`);
    process.exit(EXIT.INDETERMINATE);
  }

  const results = [];
  for (const s of registry.surfaces) {
    let text;
    try {
      text = await fetchText(s.raw_url);
    } catch (err) {
      console.log(`◦ ${s.id} — INDETERMINATE: could not fetch ${s.path} (${err.message}). Not a pass.`);
      results.push({ id: s.id, verdict: 'INDETERMINATE', checks: [] });
      continue;
    }
    const r = evaluateSurface(s, text, sot);
    results.push(r);
    console.log(`${r.verdict === 'PASS' ? '✓' : '✗'} ${s.id} (${s.repo}:${s.path}@${s.branch}) — ${r.verdict}`);
    // Positive per-check output: a row skipped by a load error must not look like a row that passed.
    for (const c of r.checks) console.log(`    ${c.verdict === 'PASS' ? '·' : '✗'} ${c.name}: ${c.detail}`);
    console.log(`    refresh: ${s.refresh_mechanism}`);
  }

  const verdict = rollup(results);
  const n = results.length;
  const bad = results.filter((r) => r.verdict === 'FAIL').map((r) => r.id);
  const unk = results.filter((r) => r.verdict === 'INDETERMINATE').map((r) => r.id);
  if (verdict === 'FAIL') {
    console.log(`${TOKEN}=FAIL — ${bad.length} of ${n} published surface(s) disagree with the live SoT: ${bad.join(', ')}. Correct the surface in its own repo, then update ops/published-surface-registry.json in the same wave.`);
    process.exit(EXIT.FAIL);
  }
  if (verdict === 'INDETERMINATE') {
    console.log(`${TOKEN}=INDETERMINATE — ${unk.length} of ${n} surface(s) unreachable: ${unk.join(', ')}. A surface we could not read is not a surface we verified.`);
    process.exit(EXIT.INDETERMINATE);
  }
  console.log(`✓ external surface parity: ${n} published surface(s) match the live SoT.`);
  console.log(`${TOKEN}=PASS`);
  process.exit(EXIT.PASS);
}

/**
 * Entrypoint guard. REALPATHS both sides, and that is not defensive noise: on macOS `/tmp` is a
 * symlink to `/private/tmp`, so `path.resolve` alone leaves argv[1] (`/tmp/…`, as typed) unequal
 * to `import.meta.url` (`/private/tmp/…`, as resolved). The guard then reads FALSE for a genuine
 * direct invocation and the process exits 0 having run NOTHING and printed NO verdict token —
 * the exact dark-guard outcome the token law exists to forbid. Caught by this gate's own
 * temp-tree test before it shipped; that test is the pin, so do not "simplify" this back.
 */
function isInvokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(url.fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url));
  }
}
if (isInvokedDirectly()) {
  if (process.argv.includes('--self-test')) selfTest();
  else await main();
}

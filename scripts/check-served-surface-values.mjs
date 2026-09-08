#!/usr/bin/env node
/**
 * check-served-surface-values.mjs — OPS-PLANS-PUBLIC-ENTERPRISE-DEPRICE-W1 CH2.
 *
 * Gates the VALUES a publicly-served surface publishes, not just its key names.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────
 * `GET /api/plans/public` published `price_usd: 299` on the enterprise rung — unauthenticated,
 * listed in `.well-known/api-catalog`, and deliberately fed to AI crawlers — while
 * `brand-facts.md:552` listed "$299/mo as an Enterprise list price" as a HIGH-severity forbidden
 * phrase and `:143` stated Enterprise no longer publishes a price. Every human surface already
 * refused it. THREE independent controls missed it, and each missed it differently:
 *
 *   · `check-forbidden-phrases.mjs` globs FILES. A served HTTP response is in no glob and cannot
 *     be — its whole corpus is text on disk, so this class is structurally invisible to it.
 *   · the frozen shape snapshot banned KEY NAMES only. It had no forbidden-VALUE concept at all,
 *     and it captured `299` as APPROVED.
 *   · that snapshot's `drift_check_command` was a shell string in a JSON field. `git grep` outside
 *     `audits/` returned ZERO hits: it was in no script, no workflow and no cron, so it had never
 *     once run. Prose in a JSON field is not a control.
 *
 * The bug class is "a value published by a RUNTIME PROJECTION is invisible to a gate whose corpus
 * is files on disk". Fixing only the endpoint would have left all three blind.
 *
 * ── WHY A STRUCTURAL ASSERTION AND NOT A STRING BAN ─────────────────────────────────────────
 * `$299` CANNOT be string-banned. It is simultaneously Pro's retired `priceUsdAnnual` and
 * Enterprise's live `priceUsdMonthly`, which is exactly why `ops/forbidden-phrases.json`
 * deliberately leaves it un-enumerated and says so in its own `bare_token_reason`. That reasoning
 * is correct, and it is the reason this gate asserts on a PATH plus a PREDICATE — naming WHERE a
 * value may not appear, so the rule stays true when the figure changes.
 *
 * ── TWO MODES, AND THE OFFLINE ONE IS THE GATE ──────────────────────────────────────────────
 *   offline (default)  imports the builder from `dist/`, calls it, asserts the contract against
 *                      the produced object. The projection is a PURE FUNCTION, so this class is
 *                      catchable deterministically at build time with no network at all. Wired
 *                      fail-closed into `.github/workflows/deploy.yml`.
 *   --live [baseUrl]   fetches the deployed surface (cache-busted) and asserts the same rules.
 *                      A scheduled canary only — NEVER a CI blocker.
 *
 * Neither substitutes for the other. The offline mode cannot see host/deploy drift; the live mode
 * must never be the only enforcement, because a gate that needs the network degrades to a pass
 * exactly when the network is degraded.
 *
 * ── VERDICT CONTRACT ────────────────────────────────────────────────────────────────────────
 * Exactly ONE terminal line: `SERVED_SURFACE_VALUES_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Exit 0 = PASS · 1 = FAIL · 3 = INDETERMINATE (the token-law default for a NEW gate).
 * 🛑 CALLERS GATE ON THE TOKEN, NEVER THE EXIT CODE.
 *
 * FAIL-OPEN ON TRANSPORT, FAIL-CLOSED ON CONTENT (the `check-docs-samples-live.mjs` split):
 *   · network error / timeout / 502-503-504 -> INDETERMINATE. A 5xx is the gateway answering.
 *   · a PARSED body violating a declared assertion -> FAIL. That is real divergence.
 *
 * VACUITY GUARD AT THE CONSTRUCTION SITE: WE author the registry and the contracts, so an empty
 * registry, zero evaluated assertions, an unreadable contract, or a `dist/` that does not export a
 * declared builder all mean this run verified NOTHING — INDETERMINATE, never PASS.
 *
 * ── MODES ───────────────────────────────────────────────────────────────────────────────────
 *   (none)                scan every `offline` surface
 *   --live [baseUrl]      scan every `offline` + `live_only` surface over HTTP
 *   --self-test           two-way proof of the predicate engine and the vacuity paths
 *   --prove-catches-ch1   run the offline rules against CH1's PRE-FIX captured body and require
 *                         a FAIL. A gate never observed catching the defect it was built for is
 *                         not evidence.
 */
import { readFileSync, realpathSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = join(ROOT, 'ops', 'served-surface-values.json');
const PREFIX_FIXTURE = join(ROOT, 'tests', 'fixtures', 'served-surfaces', 'plans-public-prefix.json');

/**
 * `dist/` is compiled CJS (`target=ES2022 module=Node16`), and this file is ESM. A bare `import`
 * of a CJS module double-wraps the default export, so the named builder is not where it looks —
 * `createRequire` is the documented way across that boundary (`build-and-runtime.md`).
 */
const require = createRequire(import.meta.url);

const EXIT_FOR = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

// ── the predicate engine ─────────────────────────────────────────────────────────────────────

/**
 * Resolve a contract path against a body. Supported forms, deliberately few:
 *
 *   `free.monthly_calls`            plain property walk
 *   `tiers[id=enterprise].price_usd` find the array element whose `id` field equals the literal
 *   `tiers[*]`                      every element of the array
 *
 * Returns `{ values: [...], resolved: true }` or `{ resolved: false, why }`. An UNRESOLVABLE path
 * is never "no violation found": the contract is ours, so a path that does not resolve means the
 * contract and the body have diverged in shape — the caller escalates it, it is not skipped.
 */
export function resolvePath(body, path) {
  let cursor = [body];
  for (const raw of String(path).split('.')) {
    const seg = raw.trim();
    if (!seg) return { resolved: false, why: `empty path segment in "${path}"` };
    const m = /^([A-Za-z_][\w-]*)(?:\[(\*|[\w-]+=[^\]]+)\])?$/.exec(seg);
    if (!m) return { resolved: false, why: `unparseable path segment "${seg}" in "${path}"` };
    const [, name, selector] = m;
    const next = [];
    for (const node of cursor) {
      if (node === null || node === undefined || typeof node !== 'object') continue;
      const v = node[name];
      if (v === undefined) continue;
      if (!selector) { next.push(v); continue; }
      if (!Array.isArray(v)) return { resolved: false, why: `"${name}" is not an array but "${seg}" selects into it` };
      if (selector === '*') { next.push(...v); continue; }
      const eq = selector.indexOf('=');
      const [field, want] = [selector.slice(0, eq), selector.slice(eq + 1)];
      next.push(...v.filter((el) => el && String(el[field]) === want));
    }
    if (next.length === 0) return { resolved: false, why: `"${path}" resolved to nothing at "${seg}"` };
    cursor = next;
  }
  return { resolved: true, values: cursor };
}

/**
 * Evaluate one predicate against one resolved value. Returns null when satisfied, else the reason.
 *
 * The predicate set is small ON PURPOSE. Every entry here is one somebody needed; a general
 * expression language would make the contract unreviewable, and an unreviewable contract is how
 * a gate ends up asserting something nobody intended.
 */
export function evalPredicate(predicate, value) {
  const [kind, arg] = (() => {
    const i = String(predicate).indexOf(':');
    return i < 0 ? [String(predicate), null] : [String(predicate).slice(0, i), String(predicate).slice(i + 1)];
  })();
  switch (kind) {
    case 'is_null':
      return value === null ? null : `expected null, got ${JSON.stringify(value)}`;
    case 'is_number':
      return typeof value === 'number' && Number.isFinite(value) ? null : `expected a finite number, got ${JSON.stringify(value)}`;
    case 'is_string':
      return typeof value === 'string' ? null : `expected a string, got ${JSON.stringify(value)}`;
    case 'not_equals':
      return JSON.stringify(value) !== arg ? null : `must not equal ${arg}`;
    case 'key_set_equals': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return `expected an object, got ${JSON.stringify(value)}`;
      const want = arg.split(',').map((s) => s.trim()).filter(Boolean).sort().join(',');
      const got = Object.keys(value).sort().join(',');
      return got === want ? null : `key set is [${got}], expected [${want}]`;
    }
    default:
      // An unknown predicate is NOT a pass. A typo in a contract must never read as clean.
      return `__UNKNOWN_PREDICATE__:${kind}`;
  }
}

/**
 * Assert one contract against one body. Returns `{ violations, evaluated, unresolved, unknown }`.
 *
 * `evaluated` is what the vacuity guard reads: a contract that asserted nothing is not a clean
 * contract, and this is the number that proves the difference.
 */
export function assertContract(body, assertions, label = 'surface') {
  const violations = [];
  const unresolved = [];
  const unknown = [];
  let evaluated = 0;
  for (const a of assertions) {
    if (a && typeof a.body_regex === 'string') {
      // VALUE-REGEX over the stringified body — the secondary form, for cases where the structure
      // is not known in advance. `must` is 'absent' (default) or 'present'.
      const re = new RegExp(a.body_regex, a.flags || '');
      const hit = re.test(JSON.stringify(body));
      evaluated += 1;
      const wantPresent = a.must === 'present';
      if (hit !== wantPresent) {
        violations.push(`${label} :: ${a.id || a.body_regex} — /${a.body_regex}/ was ${hit ? 'PRESENT' : 'ABSENT'}, expected ${wantPresent ? 'PRESENT' : 'ABSENT'}${a.reason ? ` — ${a.reason}` : ''}`);
      }
      continue;
    }
    if (!a || typeof a.path !== 'string' || typeof a.predicate !== 'string') {
      unknown.push(`${label} :: malformed assertion ${JSON.stringify(a).slice(0, 120)}`);
      continue;
    }
    // A contract path may name several concrete paths, comma-separated, when one predicate
    // genuinely applies to each — e.g. starter and pro must BOTH still publish a price.
    for (const one of a.path.split(',').map((s) => s.trim()).filter(Boolean)) {
      const r = resolvePath(body, one);
      if (!r.resolved) { unresolved.push(`${label} :: ${a.id || one} — ${r.why}`); continue; }
      for (const v of r.values) {
        evaluated += 1;
        const why = evalPredicate(a.predicate, v);
        if (why === null) continue;
        if (why.startsWith('__UNKNOWN_PREDICATE__')) { unknown.push(`${label} :: ${a.id || one} — unknown predicate "${a.predicate}"`); continue; }
        violations.push(`${label} :: ${a.id || one} — ${one} ${why}${a.reason ? `\n      why it matters: ${a.reason}` : ''}`);
      }
    }
  }
  return { violations, evaluated, unresolved, unknown };
}

// ── registry + contract loading ──────────────────────────────────────────────────────────────

export function loadRegistry(path = REGISTRY) {
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { return { error: `cannot read ${path}: ${e.message}` }; }
  const surfaces = Array.isArray(raw.surfaces) ? raw.surfaces : null;
  if (!surfaces || surfaces.length === 0) {
    // Vacuity at the CONSTRUCTION site: we author this file, so an empty one is a broken registry,
    // never evidence that the estate publishes nothing.
    return { error: 'registry declares zero surfaces — refusing to report a pass over nothing' };
  }
  for (const s of surfaces) {
    if (!s || typeof s.id !== 'string' || typeof s.coverage !== 'string') {
      return { error: `malformed surface row: ${JSON.stringify(s).slice(0, 120)}` };
    }
    if (!['offline', 'live_only', 'not_applicable'].includes(s.coverage)) {
      return { error: `surface ${s.id} declares unknown coverage "${s.coverage}"` };
    }
    if (s.coverage !== 'offline' && !String(s.coverage_reason || '').trim()) {
      return { error: `surface ${s.id} is ${s.coverage} without a coverage_reason — declared omission is permitted, UNDECLARED is not` };
    }
    if (s.coverage === 'offline' && !(s.builder && s.builder.module && s.builder.export)) {
      return { error: `surface ${s.id} is offline but declares no builder { module, export }` };
    }
  }
  return { registry: raw, surfaces };
}

/** The assertions for a surface: read from its dated contract, plus any row-local extras. */
export function assertionsFor(surface, root = ROOT) {
  const extra = Array.isArray(surface.extra_assertions) ? surface.extra_assertions : [];
  if (!surface.contract) return { assertions: extra };
  let contract;
  try { contract = JSON.parse(readFileSync(join(root, surface.contract), 'utf8')); } catch (e) {
    return { error: `surface ${surface.id}: cannot read contract ${surface.contract}: ${e.message}` };
  }
  const fromContract = contract?.forbidden_values?.assertions;
  if (!Array.isArray(fromContract) || fromContract.length === 0) {
    return { error: `surface ${surface.id}: ${surface.contract} declares no forbidden_values.assertions — the contract is the SoT, so an empty one is a defect, not a clean bill` };
  }
  return { assertions: [...fromContract, ...extra] };
}

/** Call a declared builder out of `dist/`. A missing export is INDETERMINATE, never a pass. */
export function callBuilder(surface, root = ROOT) {
  const modPath = join(root, surface.builder.module);
  let mod;
  try { mod = require(modPath); } catch (e) {
    return { error: `surface ${surface.id}: cannot require ${surface.builder.module} — has \`npm run build\` run? (${e.message})` };
  }
  const fn = mod?.[surface.builder.export];
  if (typeof fn !== 'function') {
    return { error: `surface ${surface.id}: ${surface.builder.module} does not export ${surface.builder.export}()` };
  }
  try { return { body: fn() }; } catch (e) {
    return { error: `surface ${surface.id}: ${surface.builder.export}() threw: ${e.message}` };
  }
}

// ── the producer-enumeration check ───────────────────────────────────────────────────────────

/**
 * Every surface the estate's OWN producer advertises must appear in this registry.
 *
 * Enumeration beats detection: a lint can only see what it thought to look for, whereas comparing
 * against the producer makes the population knowable. A surface added to `API_CATALOG_ENDPOINTS`
 * and forgotten here is reported BY NAME rather than silently uncovered.
 */
export function enumerationGap(registry, root = ROOT) {
  const p = registry.producer;
  if (!p || !p.module || !p.export) return { error: 'registry declares no producer to enumerate against' };
  let mod;
  try { mod = require(join(root, p.module)); } catch (e) {
    return { error: `cannot require the producer ${p.module} — has \`npm run build\` run? (${e.message})` };
  }
  const rows = mod?.[p.export];
  if (!Array.isArray(rows) || rows.length === 0) {
    return { error: `${p.module} does not export a non-empty ${p.export}` };
  }
  const declared = new Set((registry.surfaces || []).map((s) => s.href).filter(Boolean));
  const missing = rows.map((r) => r.href).filter((h) => h && !declared.has(h));
  return { missing, producerCount: rows.length };
}

// ── live mode ────────────────────────────────────────────────────────────────────────────────

/** `--live <baseUrl>` — shape borrowed from check-docs-samples-live.mjs. */
export function resolveBase(argv = process.argv) {
  const i = argv.indexOf('--live');
  const v = i >= 0 ? argv[i + 1] : undefined;
  return (v && !v.startsWith('--') ? v : process.env.SERVED_SURFACE_BASE || '').replace(/\/$/, '');
}

/**
 * Fetch a surface, CACHE-BUSTED.
 *
 * `/api/plans/public` serves `cache-control: public, max-age=300`. A post-deploy read without a
 * buster can return the PRE-deploy body for five minutes and look like a failed deploy — or,
 * worse, like a success. The buster is the control; the ref form or a plain re-fetch is not.
 */
export async function fetchSurface(href, timeoutMs = 30000) {
  const url = `${href}${href.includes('?') ? '&' : '?'}cb=${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if ([502, 503, 504].includes(res.status)) return { transport: `HTTP ${res.status} — the gateway answering, not the app` };
    if (!res.ok) return { transport: `HTTP ${res.status}` };
    return { body: await res.json(), url };
  } catch (e) {
    return { transport: e?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (e?.message || String(e)) };
  } finally { clearTimeout(t); }
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────

function emit(verdict, why) {
  if (why) (verdict === 'PASS' ? console.log : console.error)(`  ${why}`);
  console.log(`SERVED_SURFACE_VALUES_VERDICT=${verdict}`);
  process.exit(EXIT_FOR[verdict]);
}

async function main(argv = process.argv) {
  const live = argv.includes('--live');
  const reg = loadRegistry();
  if (reg.error) emit('INDETERMINATE', reg.error);

  const gap = enumerationGap(reg.registry);
  if (gap.error) emit('INDETERMINATE', gap.error);
  if (gap.missing.length) {
    emit('FAIL', `${gap.missing.length} surface(s) the producer advertises are ABSENT from ops/served-surface-values.json — declare them with a coverage and a reason:\n      ${gap.missing.join('\n      ')}`);
  }

  const wanted = reg.surfaces.filter((s) => s.coverage === 'offline' || (live && s.coverage === 'live_only'));
  const violations = [];
  const unresolved = [];
  const unknown = [];
  let evaluated = 0;
  let checked = 0;
  const skippedLive = [];

  for (const s of wanted) {
    const ac = assertionsFor(s);
    if (ac.error) emit('INDETERMINATE', ac.error);
    if (ac.assertions.length === 0) {
      // A surface in scope with no contract is not a clean surface — it is an unwritten one.
      if (s.coverage === 'live_only') { skippedLive.push(`${s.id} (no contract written yet)`); continue; }
      emit('INDETERMINATE', `surface ${s.id} is offline but carries no assertions — nothing would be verified`);
    }
    let body;
    if (live && s.coverage === 'live_only') {
      const base = resolveBase(argv);
      const href = base && s.href ? s.href.replace(/^https?:\/\/[^/]+/, base) : s.href;
      const r = await fetchSurface(href);
      if (r.transport) { emit('INDETERMINATE', `surface ${s.id}: ${r.transport} — a caller that could not reach the host has proven nothing`); }
      body = r.body;
    } else if (live && s.coverage === 'offline' && s.href) {
      const r = await fetchSurface(s.href);
      if (r.transport) emit('INDETERMINATE', `surface ${s.id}: ${r.transport}`);
      body = r.body;
    } else {
      const b = callBuilder(s);
      if (b.error) emit('INDETERMINATE', b.error);
      body = b.body;
    }
    const res = assertContract(body, ac.assertions, s.id);
    violations.push(...res.violations);
    unresolved.push(...res.unresolved);
    unknown.push(...res.unknown);
    evaluated += res.evaluated;
    checked += 1;
  }

  if (unknown.length) emit('INDETERMINATE', `a contract carries an assertion this gate cannot evaluate — a typo must never read as clean:\n      ${unknown.join('\n      ')}`);
  if (unresolved.length) emit('INDETERMINATE', `a contract path did not resolve against the body — the contract is OURS, so this is shape divergence, not absence of a violation:\n      ${unresolved.join('\n      ')}`);
  if (checked === 0) emit('INDETERMINATE', 'zero surfaces were in scope for this mode — nothing was verified');
  if (evaluated === 0) emit('INDETERMINATE', `${checked} surface(s) in scope but ZERO assertions evaluated — the run verified nothing`);

  // The positive line prints on EVERY path: a run you cannot tell happened is indistinguishable
  // from one that silently did nothing.
  const cov = reg.surfaces.reduce((m, s) => ({ ...m, [s.coverage]: (m[s.coverage] || 0) + 1 }), {});
  console.log(
    `served-surface values: ${checked} surface(s) checked ${live ? '(LIVE, cache-busted)' : '(offline, from dist/)'}, `
    + `${evaluated} assertion(s) evaluated · registry ${reg.surfaces.length} surface(s) `
    + `[${Object.entries(cov).map(([k, v]) => `${v} ${k}`).join(', ')}] · producer advertises ${gap.producerCount}`,
  );
  if (skippedLive.length) console.log(`  (${skippedLive.length} live_only surface(s) have no contract yet: ${skippedLive.join(', ')})`);
  if (violations.length) {
    emit('FAIL', `${violations.length} forbidden value(s) on a publicly-served surface:\n      ${violations.join('\n      ')}`);
  }
  emit('PASS', `no forbidden value on any checked surface.`);
}

// ── proofs ───────────────────────────────────────────────────────────────────────────────────

/**
 * R2.5 — run the offline rules against CH1's PRE-FIX captured body and require a FAIL.
 *
 * "The gate would have caught it" is a claim, and a claim is not evidence. This replays the exact
 * bytes the endpoint served before CH1, read from the fixture rather than retyped, and asserts the
 * contract reports a violation. It also asserts the CONVERSE on the post-fix body — without that
 * leg the proof would be satisfied by a contract that fails on everything.
 */
export function proveCatchesCh1() {
  let fixture;
  try { fixture = JSON.parse(readFileSync(PREFIX_FIXTURE, 'utf8')); } catch (e) {
    return { ok: false, detail: `cannot read the pre-fix fixture: ${e.message}` };
  }
  const before = fixture.captured_body;
  if (!before || !Array.isArray(before.tiers)) return { ok: false, detail: 'the pre-fix fixture carries no usable captured_body' };
  const reg = loadRegistry();
  if (reg.error) return { ok: false, detail: reg.error };
  const surface = reg.surfaces.find((s) => s.id === 'api-plans-public');
  if (!surface) return { ok: false, detail: 'no api-plans-public surface in the registry' };
  const ac = assertionsFor(surface);
  if (ac.error) return { ok: false, detail: ac.error };

  const pre = assertContract(before, ac.assertions, 'api-plans-public@pre-fix');
  if (pre.unresolved.length || pre.unknown.length) {
    return { ok: false, detail: `the contract could not be evaluated against the pre-fix body: ${[...pre.unresolved, ...pre.unknown].join('; ')}` };
  }
  if (pre.violations.length === 0) {
    return { ok: false, detail: 'the pre-fix body produced NO violation — this gate cannot demonstrate it catches the defect it was built for' };
  }
  const post = callBuilder(surface);
  if (post.error) return { ok: false, detail: post.error };
  const now = assertContract(post.body, ac.assertions, 'api-plans-public@current');
  if (now.violations.length !== 0) {
    return { ok: false, detail: `the CURRENT body also violates (${now.violations.length}) — the proof above would be satisfied by a contract that fails on everything` };
  }
  return {
    ok: true,
    detail: `pre-fix body => ${pre.violations.length} violation(s) => FAIL; current body => 0 => PASS`,
    violations: pre.violations,
  };
}

function selfTest() {
  let passed = 0;
  let failed = 0;
  const check = (name, fn) => {
    let ok = false;
    let detail = '';
    // An assertion that RAISES is not an assertion — it aborts the suite instead of reporting FAIL.
    try { ok = fn() === true; } catch (e) { ok = false; detail = ` (threw: ${String(e.message).slice(0, 90)})`; }
    if (ok) { passed += 1; console.log(`  ✓ ${name}`); } else { failed += 1; console.log(`  ✗ ${name}${detail}`); }
  };

  console.log('SELF-TEST — served-surface value gate');

  const BODY = {
    free: { monthly_calls: 200, daily_calls: 100 },
    tiers: [
      { id: 'starter', label: 'Starter', monthly_calls: 10000, daily_calls: 1000, price_usd: 9.99, price_usd_6month: 39.9 },
      { id: 'enterprise', label: 'Enterprise', monthly_calls: null, daily_calls: null, price_usd: null, price_usd_6month: null },
    ],
  };
  const DIRTY = JSON.parse(JSON.stringify(BODY));
  DIRTY.tiers[1].price_usd = 299;
  DIRTY.tiers[1].monthly_calls = 100000;

  // (1) path resolution, both directions.
  check('a selector path finds the element it names', () =>
    resolvePath(BODY, 'tiers[id=enterprise].price_usd').values[0] === null);
  check('a wildcard path resolves every element', () =>
    resolvePath(BODY, 'tiers[*]').values.length === 2);
  check('a plain property walk resolves', () =>
    resolvePath(BODY, 'free.monthly_calls').values[0] === 200);
  check('an UNRESOLVABLE path is reported, never treated as "no violation"', () =>
    resolvePath(BODY, 'tiers[id=nope].price_usd').resolved === false);
  check('a garbage path segment is reported rather than thrown', () =>
    resolvePath(BODY, 'tiers[[[').resolved === false);

  // (2) predicates, both directions.
  check('is_null accepts null and rejects a number', () =>
    evalPredicate('is_null', null) === null && evalPredicate('is_null', 299) !== null);
  check('is_number rejects null — the refusal is not a number', () =>
    evalPredicate('is_number', 49) === null && evalPredicate('is_number', null) !== null);
  check('key_set_equals compares the SET, order-independently', () =>
    evalPredicate('key_set_equals:b,a', { a: 1, b: 2 }) === null && evalPredicate('key_set_equals:a', { a: 1, b: 2 }) !== null);
  check('not_equals compares by JSON value', () =>
    evalPredicate('not_equals:299', 49) === null && evalPredicate('not_equals:299', 299) !== null);
  check('an UNKNOWN predicate is refused, never silently satisfied', () =>
    String(evalPredicate('is_probably_fine', 1)).startsWith('__UNKNOWN_PREDICATE__'));

  // (3) the contract engine, on both bodies.
  const A = [
    { id: 'ent-price', path: 'tiers[id=enterprise].price_usd', predicate: 'is_null', reason: 'r' },
    { id: 'ent-quota', path: 'tiers[id=enterprise].monthly_calls', predicate: 'is_null', reason: 'r' },
    { id: 'self-serve', path: 'tiers[id=starter].price_usd', predicate: 'is_number', reason: 'r' },
  ];
  check('the CLEAN body satisfies the contract', () => assertContract(BODY, A).violations.length === 0);
  check('the DIRTY body violates it — twice, and names both', () => {
    const r = assertContract(DIRTY, A);
    return r.violations.length === 2 && r.violations.join(' ').includes('299');
  });
  check('a contract that asserted nothing reports evaluated=0 (the vacuity signal)', () =>
    assertContract(BODY, []).evaluated === 0);
  check('a malformed assertion is UNKNOWN, not a pass', () =>
    assertContract(BODY, [{ nonsense: true }]).unknown.length === 1);
  check('a comma path applies one predicate to several concrete paths', () =>
    assertContract(BODY, [{ path: 'tiers[id=starter].price_usd, tiers[id=enterprise].price_usd', predicate: 'is_number' }]).violations.length === 1);

  // (4) the value-regex secondary form.
  check('body_regex absent-by-default catches a forbidden literal', () =>
    assertContract(DIRTY, [{ id: 'r', body_regex: '"price_usd":\\s*299' }]).violations.length === 1);
  check('body_regex must:present fails when the literal is missing', () =>
    assertContract(BODY, [{ id: 'r', body_regex: 'ZZZ_NEVER', must: 'present' }]).violations.length === 1);

  // (5) registry validation — through the REAL loader, never a reimplementation of its rules.
  //
  // 🛑 THE FIRST CUT OF THIS BLOCK WAS VACUOUS and is recorded because the shape recurs: it
  // mirrored loadRegistry's rules in a local `validate()` and asserted against THAT. A hand-rolled
  // copy can only ever agree with itself — it would have passed unchanged while the real loader
  // accepted a registry with no coverage_reason. Fixtures are written to a temp file and pushed
  // through the actual function, so the thing under test is the thing that ships.
  const tmpDir = mkdtempSync(join(tmpdir(), 'ssv-'));
  try {
    const through = (obj) => {
      const f = join(tmpDir, `${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(f, JSON.stringify(obj));
      return loadRegistry(f);
    };
    const P = { module: 'x', export: 'y' };
    check('an EMPTY registry is refused (vacuity at the construction site)', () =>
      Boolean(through({ producer: P, surfaces: [] }).error));
    check('an unparseable registry is an error, not a throw', () => {
      const f = join(tmpDir, 'bad.json');
      writeFileSync(f, '{ not json');
      return Boolean(loadRegistry(f).error);
    });
    check('a non-offline surface WITHOUT a coverage_reason is refused', () =>
      Boolean(through({ producer: P, surfaces: [{ id: 'x', coverage: 'live_only' }] }).error));
    check('a non-offline surface WITH a reason is accepted', () =>
      !through({ producer: P, surfaces: [{ id: 'x', coverage: 'live_only', coverage_reason: 'because it is served elsewhere' }] }).error);
    check('an offline surface without a builder is refused', () =>
      Boolean(through({ producer: P, surfaces: [{ id: 'x', coverage: 'offline' }] }).error));
    check('an unknown coverage value is refused', () =>
      Boolean(through({ producer: P, surfaces: [{ id: 'x', coverage: 'someday', coverage_reason: 'r' }] }).error));
    check('a surface row missing an id is refused', () =>
      Boolean(through({ producer: P, surfaces: [{ coverage: 'not_applicable', coverage_reason: 'r' }] }).error));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // (6) THE BYPASSED ARTIFACTS — everything above replaces the real registry, the real contract
  // and the real builder with fixtures, so a hermetic suite is structurally blind to all three.
  const real = loadRegistry();
  check('the REAL registry loads and declares surfaces', () => !real.error && real.surfaces.length > 0);
  check('every REAL offline surface has a readable contract with assertions', () => {
    if (real.error) return false;
    const off = real.surfaces.filter((s) => s.coverage === 'offline');
    if (off.length === 0) return false; // vacuity: no offline surface means the gate gates nothing
    return off.every((s) => { const a = assertionsFor(s); return !a.error && a.assertions.length > 0; });
  });
  check('the REAL producer enumeration resolves and the registry covers it', () => {
    if (real.error) return false;
    const g = enumerationGap(real.registry);
    return !g.error && g.missing.length === 0 && g.producerCount > 0;
  });

  // (7) the CH1 regression proof.
  const proof = proveCatchesCh1();
  check(`the gate DEMONSTRABLY catches the CH1 defect — ${proof.detail}`, () => proof.ok);

  console.log(`SELF-TEST: ${failed === 0 ? 'PASS' : 'FAIL'} (${passed} passed, ${failed} failed)`);
  return failed === 0 ? 0 : 1;
}

/**
 * TEST-IMPORTABLE ENTRYPOINT. Real paths on both sides: `resolve(argv[1])` does not follow
 * symlinks while `fileURLToPath` does, and on macOS (/tmp -> /private/tmp) that mismatch makes the
 * guard false, so the script would exit 0 having run nothing — a dark guard at a green exit code.
 * The imported path emits no verdict token: a seam that can print a verdict is a bypass.
 */
const realOrSelf = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
if (process.argv[1] && realOrSelf(process.argv[1]) === realOrSelf(fileURLToPath(import.meta.url))) {
  if (process.argv.includes('--self-test')) {
    const code = selfTest();
    emit(code === 0 ? 'PASS' : 'FAIL', null);
  } else if (process.argv.includes('--prove-catches-ch1')) {
    const r = proveCatchesCh1();
    if (r.ok) {
      console.log(`  ${r.detail}`);
      for (const v of r.violations) console.log(`    caught: ${v.split('\n')[0]}`);
      console.log('PROVE_CATCHES_CH1=FAIL_AS_EXPECTED');
      emit('PASS', null);
    } else {
      console.error(`  ${r.detail}`);
      console.log('PROVE_CATCHES_CH1=BROKEN');
      emit('INDETERMINATE', null);
    }
  } else {
    main();
  }
}

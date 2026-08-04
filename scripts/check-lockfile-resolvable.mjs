#!/usr/bin/env node
// @ts-check
/**
 * check-lockfile-resolvable.mjs — can this repo still be BUILT FROM SCRATCH?
 *
 * OPS-SUPPLY-CHAIN-RESOLVABILITY-W1 / R4 — the generator.
 *
 * THE BUG CLASS. Every recovery path this project has ends in "rebuild the image": a bad
 * deploy, a corrupted layer, a host rebuild, a Hetzner incident. Nothing asserted that a
 * rebuild would actually WORK. `npm ci` installs from the lockfile's pinned `resolved` URLs,
 * so it keeps succeeding for as long as each TARBALL is served — even after the version has
 * been unpublished from the registry LISTING. A fresh `npm install` resolves against the
 * listing instead, and fails `ETARGET`. The two can disagree for months, and the only moment
 * you find out is the moment you need the rebuild.
 *
 * OPS-RUNTIME-NODE24-W1 recorded exactly that state for `@privy-io/node@0.16.0` on 2026-07-30
 * ("pinned but no longer on the registry; oldest listed 0.25.0") and filed it as report-only.
 * Five days later it did not reproduce: all 34 versions incl. 0.16.0 are listed, undeprecated,
 * and `^0.16.0` resolves cleanly. Whether the first probe was wrong or the registry genuinely
 * changed under us, the lesson is the same and it is the reason this file exists — a ONE-TIME
 * measurement of this property cannot be trusted, because the property is owned by other people
 * and moves without telling us. It has to be asserted continuously or not at all.
 *
 * ── TWO MODES, because the property splits cleanly in two ─────────────────────────────────
 *
 * `--offline` (per-push, .github/workflows/deploy.yml). Zero network, deterministic, fail-closed.
 *   Asserts PROVENANCE, not freshness: every pin in this lockfile was live-verified at some
 *   point, and the structural preconditions that make `npm ci` reproducible still hold.
 *     - every non-link entry resolves to the expected registry over https
 *     - every entry carries an `integrity` hash
 *     - every current name@version appears in the attestation (scripts/data/lockfile-resolvability.json)
 *   The third is the load-bearing one: it BLOCKS a push that introduces a pin nobody has ever
 *   checked. That is squarely the pusher's own doing, which is the test for what may block
 *   (CLAUDE.md — a blocking verdict must land on someone who can act on it).
 *
 * default / `--attest` (scheduled, daily, ops/cron/lockfile-resolvability-canary.sh).
 *   Asserts the property TODAY by asking the registry. This is the mode that can actually
 *   catch a delisting, and it is deliberately NOT on the push path: ~780 registry requests
 *   per push would put npmjs.com's availability on the deploy critical path, and the spec's
 *   own warning applies — a flaky blocking gate gets disabled within a week, and a disabled
 *   gate is worse than a scheduled one.
 *
 * WHY THE OFFLINE MODE DOES NOT EXPIRE. It would be easy to give the attestation a max age and
 * call a stale one INDETERMINATE, mirroring the EOL table in check-runtime-node-eol.mjs. That
 * is wrong here, and the difference is worth stating so it is not "fixed" later. An EOL table
 * makes a claim about the FUTURE, so it rots. This attestation makes a claim about the PAST —
 * "this pin was resolvable when it entered the tree" — and a past fact does not decay. Pins are
 * stable for weeks at a time, so an age bound would block every push in a quiet month while
 * telling us nothing. "Is it STILL resolvable" is the scheduled run's job, and a scheduled run
 * that stops happening is caught by the monitoring inventory's own DARK check, not by inventing
 * a second freshness signal here.
 *
 * FRESHNESS KEYS ON THE CLAIM SET, NEVER ON THE FILE. The attestation records the sorted
 * name@version SET, not a hash of package-lock.json. A lockfile edit that changes no pin
 * invalidates nothing. This is the container-vs-content law from
 * OPS-CLAUDEMD-CLAIM-PUBLISH-PRECONDITION-W1, where keying a lock on the sha256 of a shared,
 * concurrently-edited file made false invalidation the steady state. The check is
 * `current SUBSET OF attested`, so an attestation carrying a since-removed pin is tolerated and
 * a concurrent-worktree merge stays mechanical: re-run `--attest`, always correct.
 *
 * NETWORK IS INDETERMINATE, NEVER PASS. The whole failure mode being retired is a silent green
 * over an unverified property, so "could not reach the registry" must not be able to launder
 * itself into "checked, all resolvable".
 *
 * Usage:
 *   node scripts/check-lockfile-resolvable.mjs --self-test
 *   node scripts/check-lockfile-resolvable.mjs --offline
 *   node scripts/check-lockfile-resolvable.mjs              # live sweep
 *   node scripts/check-lockfile-resolvable.mjs --attest      # live sweep, rewrite the attestation on PASS
 *
 * Verdict: exactly one terminal `LOCKFILE_RESOLVABLE_VERDICT=PASS|FAIL|INDETERMINATE`. Callers
 * gate on the TOKEN, not the code (CLAUDE.md verdict-token law).
 * Exit: 0 = PASS - 1 = FAIL - 3 = INDETERMINATE (new gate, so the token-law default of 3).
 */

import { readFileSync, existsSync, writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const LOCK_FILE = join(ROOT, 'package-lock.json');
const ATTEST_FILE = join(ROOT, 'scripts/data/lockfile-resolvability.json');

/** The one registry this project installs from. A pin anywhere else is a finding, not a config. */
export const REGISTRY = 'https://registry.npmjs.org/';

/** Bounded concurrency + retries: enough to finish in ~20s, gentle enough not to get throttled. */
const CONCURRENCY = 16;
const RETRIES = 3;
const TIMEOUT_MS = 30_000;

// ── pure extraction + evaluation (so the self-test can drive them directly) ───

/**
 * `https://registry.npmjs.org/@scope/name/-/name-1.2.3.tgz` -> `@scope/name`.
 * Derived from `resolved` rather than the path because an ALIASED dependency
 * (`"foo": "npm:bar@1"`) sits at `node_modules/foo` while resolving to `bar` — and it is the
 * resolved name that the registry is asked about.
 */
export function nameFromResolved(resolved) {
  if (typeof resolved !== 'string' || !resolved.startsWith(REGISTRY)) return null;
  const rest = resolved.slice(REGISTRY.length);
  const idx = rest.indexOf('/-/');
  if (idx <= 0) return null;
  return decodeURIComponent(rest.slice(0, idx));
}

/** `node_modules/a/node_modules/@s/b` -> `@s/b`. The fallback when `resolved` is absent/foreign. */
export function nameFromPath(path) {
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(path);
  return m ? m[1] : null;
}

/**
 * Flatten a lockfile into the entries this gate has an opinion about. Returns
 * `{ ok: false, reason }` for anything it cannot parse — a lockfile is HANDED to us, so an
 * unreadable one is INDETERMINATE, never a pass (CLAUDE.md vacuity law: empty-vs-unparseable
 * is the line, and input we could not parse is always indeterminate).
 */
export function parseLock(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `package-lock.json is not valid JSON: ${err instanceof Error ? err.message : err}` };
  }
  if (!doc || typeof doc !== 'object') return { ok: false, reason: 'package-lock.json did not parse to an object' };
  const packages = doc.packages;
  if (!packages || typeof packages !== 'object') {
    return { ok: false, reason: 'package-lock.json has no `packages` map (lockfileVersion < 2?)' };
  }
  const entries = [];
  for (const [path, meta] of Object.entries(packages)) {
    if (!path) continue; // the root project, which is not installed from anywhere
    if (!meta || typeof meta !== 'object') continue;
    if (meta.link) continue; // a workspace symlink resolves locally, not from a registry
    entries.push({
      path,
      version: typeof meta.version === 'string' ? meta.version : null,
      resolved: typeof meta.resolved === 'string' ? meta.resolved : null,
      integrity: typeof meta.integrity === 'string' ? meta.integrity : null,
      nameByResolved: nameFromResolved(meta.resolved),
      nameByPath: nameFromPath(path),
      dev: meta.dev === true,
      optional: meta.optional === true,
    });
  }
  return { ok: true, entries, lockfileVersion: doc.lockfileVersion };
}

/**
 * Structural preconditions for a reproducible `npm ci`. These are offline, deterministic and
 * cheap, and each one is a real way a tree stops being rebuildable:
 *   foreignRegistry — a `git+ssh://` / `file:` / private-host pin cannot be fetched by CI at all
 *   missingResolved — npm has nowhere to fetch it from
 *   missingIntegrity — the tarball can be swapped underneath us with no detection
 *   nameDisagreement — path and resolved disagree, so we cannot say WHICH package is pinned
 */
export function structuralFindings(entries) {
  const foreignRegistry = [];
  const missingResolved = [];
  const missingIntegrity = [];
  const nameDisagreement = [];
  for (const e of entries) {
    if (!e.resolved) {
      missingResolved.push(e);
      continue;
    }
    if (!e.resolved.startsWith(REGISTRY)) {
      foreignRegistry.push(e);
      continue;
    }
    if (!e.integrity) missingIntegrity.push(e);
    if (e.nameByResolved && e.nameByPath && e.nameByResolved !== e.nameByPath) nameDisagreement.push(e);
  }
  return { foreignRegistry, missingResolved, missingIntegrity, nameDisagreement };
}

/** The claim set: every distinct `name@version` this lockfile pins, sorted and de-duplicated. */
export function pinSet(entries) {
  const out = new Set();
  for (const e of entries) {
    const name = e.nameByResolved || e.nameByPath;
    if (name && e.version) out.add(`${name}@${e.version}`);
  }
  return [...out].sort();
}

/**
 * Load the attestation. Missing / unparseable / empty are all INDETERMINATE: a gate that cannot
 * decide must not report clean. Note there is deliberately NO age check — see the header.
 */
export function loadAttestation(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `attestation is not valid JSON: ${err instanceof Error ? err.message : err}` };
  }
  const pins = doc?.verified_pins;
  if (!Array.isArray(pins)) return { ok: false, reason: 'attestation has no `verified_pins` array' };
  if (pins.length === 0) return { ok: false, reason: 'attestation lists ZERO verified pins — refusing to treat that as coverage' };
  if (typeof doc.registry === 'string' && doc.registry !== REGISTRY) {
    return { ok: false, reason: `attestation was produced against ${doc.registry}, not ${REGISTRY}` };
  }
  return { ok: true, verified: new Set(pins), verifiedAt: typeof doc.verified_at === 'string' ? doc.verified_at : null };
}

/** Pins present in the tree that the attestation has never vouched for. Order preserved (sorted). */
export function unattested(currentPins, verified) {
  return currentPins.filter((p) => !verified.has(p));
}

/**
 * Given per-name packument results, decide each pin. `listedByName` maps name -> Set of listed
 * versions; a name whose fetch failed maps to `null`, which is INDETERMINATE and never a pass.
 */
export function evaluateResolvability(currentPins, listedByName) {
  const unresolvable = [];
  const indeterminate = [];
  const ok = [];
  for (const pin of currentPins) {
    const at = pin.lastIndexOf('@');
    const name = pin.slice(0, at);
    const version = pin.slice(at + 1);
    const listed = listedByName.get(name);
    if (listed === null || listed === undefined) indeterminate.push({ pin, name, version });
    else if (!listed.has(version)) unresolvable.push({ pin, name, version, listed });
    else ok.push({ pin, name, version });
  }
  return { unresolvable, indeterminate, ok };
}

// ── network ──────────────────────────────────────────────────────────────────

/**
 * Fetch the ABBREVIATED packument and return the set of listed versions.
 *
 * `Accept: application/vnd.npm.install-v1+json` is what npm itself sends: it returns a much
 * smaller document, and — this is the part that costs an afternoon — it is only valid on the
 * PACKUMENT endpoint. The per-version endpoint `/<name>/<version>` answers it with HTTP 406.
 * Probing per version therefore reports every single pin as unresolvable while looking entirely
 * healthy, which is exactly the false-FAIL a gate must not be able to produce. Asking once per
 * NAME is also ~780 requests instead of ~920, and membership in `versions` IS the property:
 * `npm install` resolves a range against the listing, so a version absent from it is the
 * ETARGET, whether or not its tarball is still served.
 */
export async function fetchPackument(name, { retries = RETRIES, timeoutMs = TIMEOUT_MS } = {}) {
  const url = `${REGISTRY}${name.replace('/', '%2f')}`;
  let lastErr = 'unknown';
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)));
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/vnd.npm.install-v1+json', 'user-agent': 'algovault-lockfile-resolvability-canary' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      // A 404 is an ANSWER — the package is gone from the registry entirely. Anything else in
      // the error range is a failure to ask, which is a different verdict.
      if (res.status === 404) return { ok: true, versions: new Set() };
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        continue;
      }
      const body = await res.json();
      const versions = body?.versions;
      if (!versions || typeof versions !== 'object') {
        lastErr = 'packument carried no `versions` map';
        continue;
      }
      return { ok: true, versions: new Set(Object.keys(versions)) };
    } catch (err) {
      lastErr = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
  }
  return { ok: false, reason: lastErr };
}

/** Is the pinned TARBALL still served? Only asked about a pin that already FAILED the listing. */
export async function tarballReachable(resolved, { timeoutMs = TIMEOUT_MS } = {}) {
  try {
    const res = await fetch(resolved, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Run `fetcher` over `names` with bounded concurrency. Injectable so the self-test never dials out. */
export async function sweep(names, fetcher, concurrency = CONCURRENCY) {
  const listedByName = new Map();
  const failures = [];
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= names.length) return;
      const name = names[i];
      const r = await fetcher(name);
      if (r.ok) listedByName.set(name, r.versions);
      else {
        listedByName.set(name, null);
        failures.push({ name, reason: r.reason });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(names.length, 1)) }, worker));
  return { listedByName, failures };
}

// ── self-test ────────────────────────────────────────────────────────────────

const LOCK_FIXTURE = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'fixture', version: '1.0.0' },
    'node_modules/good': { version: '1.2.3', resolved: `${REGISTRY}good/-/good-1.2.3.tgz`, integrity: 'sha512-aaa' },
    'node_modules/@scope/pkg': { version: '0.4.0', resolved: `${REGISTRY}@scope/pkg/-/pkg-0.4.0.tgz`, integrity: 'sha512-bbb' },
    'node_modules/workspace-link': { link: true, resolved: 'packages/thing' },
  },
});

async function selfTest() {
  const fails = [];

  // (a) parsing + name derivation, including the alias case the path alone cannot express
  const p = parseLock(LOCK_FIXTURE);
  if (!p.ok) fails.push(`fixture lockfile rejected: ${p.reason}`);
  if (p.ok && p.entries.length !== 2) fails.push(`expected 2 installable entries (root + link excluded), got ${p.ok ? p.entries.length : '?'}`);
  if (nameFromResolved(`${REGISTRY}@scope/pkg/-/pkg-0.4.0.tgz`) !== '@scope/pkg') fails.push('scoped name not derived from resolved URL');
  if (nameFromResolved('https://npm.example.com/x/-/x-1.0.0.tgz') !== null) fails.push('a foreign-host resolved URL must not yield a name');
  if (nameFromPath('node_modules/a/node_modules/@s/b') !== '@s/b') fails.push('nested scoped path not derived');
  if (pinSet(p.ok ? p.entries : []).join(',') !== '@scope/pkg@0.4.0,good@1.2.3') fails.push('pin set is not the sorted deduplicated name@version list');

  // (b) MUST-FIRE: every structural defect is detected, one at a time
  const bad = parseLock(JSON.stringify({
    packages: {
      'node_modules/foreign': { version: '1.0.0', resolved: 'git+ssh://git@github.com/x/y.git#abc', integrity: 'sha512-x' },
      'node_modules/nores': { version: '1.0.0' },
      'node_modules/nohash': { version: '1.0.0', resolved: `${REGISTRY}nohash/-/nohash-1.0.0.tgz` },
      'node_modules/alias': { version: '1.0.0', resolved: `${REGISTRY}real/-/real-1.0.0.tgz`, integrity: 'sha512-y' },
    },
  }));
  const s = bad.ok ? structuralFindings(bad.entries) : null;
  if (!s || s.foreignRegistry.length !== 1) fails.push('a git+ssh pin was not flagged as foreign');
  if (!s || s.missingResolved.length !== 1) fails.push('a pin with no `resolved` was not flagged');
  if (!s || s.missingIntegrity.length !== 1) fails.push('a pin with no `integrity` was not flagged');
  if (!s || s.nameDisagreement.length !== 1) fails.push('a path/resolved name disagreement was not flagged');

  // (c) MUST-NOT-FIRE: the clean fixture produces no structural finding at all
  const clean = p.ok ? structuralFindings(p.entries) : null;
  if (!clean || clean.foreignRegistry.length || clean.missingResolved.length || clean.missingIntegrity.length || clean.nameDisagreement.length) {
    fails.push('the clean fixture produced a structural finding');
  }

  // (d) attestation: subset passes, a NEW pin is named, and every broken shape is refused
  const att = loadAttestation(JSON.stringify({ registry: REGISTRY, verified_pins: ['good@1.2.3', '@scope/pkg@0.4.0', 'since-removed@9.9.9'] }));
  if (!att.ok) fails.push(`a well-formed attestation was rejected: ${att.reason}`);
  if (att.ok && unattested(pinSet(p.ok ? p.entries : []), att.verified).length !== 0) {
    fails.push('a covered pin set must pass even when the attestation carries a since-removed extra');
  }
  if (att.ok && unattested(['brand-new@1.0.0', 'good@1.2.3'], att.verified).join(',') !== 'brand-new@1.0.0') {
    fails.push('an unattested pin must be named, and only that pin');
  }
  if (loadAttestation('{not json').ok) fails.push('an unparseable attestation must not load');
  if (loadAttestation(JSON.stringify({ verified_pins: [] })).ok) fails.push('an EMPTY attestation must not load (vacuity)');
  if (loadAttestation(JSON.stringify({})).ok) fails.push('an attestation with no verified_pins must not load');
  if (loadAttestation(JSON.stringify({ registry: 'https://npm.example.com/', verified_pins: ['a@1'] })).ok) {
    fails.push('an attestation from a different registry must not load');
  }

  // (e) FAIL-CLOSED on an unusable lockfile — handed to us, so unparseable is INDETERMINATE
  if (parseLock('{not json').ok) fails.push('an unparseable lockfile must not load');
  if (parseLock(JSON.stringify({ name: 'x' })).ok) fails.push('a lockfile with no `packages` map must not load');

  // (f) MUST-FIRE on the real thing: a delisted pin is unresolvable, a listed one is not
  const listed = new Map([['good', new Set(['1.2.3', '2.0.0'])], ['gone', new Set(['0.25.0', '0.28.0'])]]);
  const ev = evaluateResolvability(['good@1.2.3', 'gone@0.16.0'], listed);
  if (ev.unresolvable.length !== 1 || ev.unresolvable[0].pin !== 'gone@0.16.0') fails.push('a delisted pin was not detected');
  if (ev.ok.length !== 1 || ev.ok[0].pin !== 'good@1.2.3') fails.push('a listed pin did not pass');
  if (ev.indeterminate.length !== 0) fails.push('a fully-fetched sweep produced a spurious indeterminate');

  // (g) NETWORK IS NEVER A PASS: an unfetchable name is indeterminate, not resolvable
  const netDown = evaluateResolvability(['good@1.2.3'], new Map([['good', null]]));
  if (netDown.indeterminate.length !== 1 || netDown.ok.length !== 0) fails.push('an unfetchable packument must be INDETERMINATE, never a pass');
  const missingEntirely = evaluateResolvability(['never-fetched@1.0.0'], new Map());
  if (missingEntirely.indeterminate.length !== 1) fails.push('a name absent from the sweep result must be INDETERMINATE');

  // (h) a 404 packument is an ANSWER (package gone), so its pins are unresolvable, not unknown
  const gone404 = evaluateResolvability(['vanished@1.0.0'], new Map([['vanished', new Set()]]));
  if (gone404.unresolvable.length !== 1) fails.push('a 404 packument must make its pins unresolvable, not indeterminate');

  // (i) the sweep runs every name and reports per-name failure without aborting the rest
  let seen = 0;
  const fakeFetcher = async (n) => {
    seen++;
    return n === 'boom' ? { ok: false, reason: 'simulated outage' } : { ok: true, versions: new Set(['1.0.0']) };
  };
  const r = await sweep(['a', 'boom', 'b'], fakeFetcher, 2);
  if (seen !== 3) fails.push(`sweep must visit every name exactly once, visited ${seen}`);
  if (r.failures.length !== 1 || r.failures[0].name !== 'boom') fails.push('sweep must report the failing name');
  if (r.listedByName.get('boom') !== null) fails.push('a failed fetch must map to null, not be silently absent');
  if (r.listedByName.size !== 3) fails.push('sweep must record a result for every name');

  // (j) VACUITY GUARD: an empty corpus is a BROKEN TEST here, because the TEST builds it —
  // unlike the runtime path below, where an empty lockfile is a fact about the world.
  if (pinSet([]).length !== 0) fails.push('pinSet of nothing must be empty');
  const emptyEval = evaluateResolvability([], new Map());
  if (emptyEval.ok.length || emptyEval.unresolvable.length || emptyEval.indeterminate.length) {
    fails.push('an empty pin set produced findings');
  }
  if (!p.ok || p.entries.length === 0) fails.push('the fixture corpus is EMPTY — every assertion above was vacuous');

  // (k) the token -> EXIT CODE mapping, not just the token. A gate whose self-test checks only
  // the token can have its INDETERMINATE re-coded to 0 and stay green (OPS-TEST-GATE-RECONCILE-W1).
  if (exitCodeFor('PASS') !== 0) fails.push('PASS must exit 0');
  if (exitCodeFor('FAIL') !== 1) fails.push('FAIL must exit 1');
  if (exitCodeFor('INDETERMINATE') !== 3) fails.push('INDETERMINATE must exit 3, never 0 — it must BLOCK, not launder into a pass');
  if (exitCodeFor('anything-else') === 0) fails.push('an unrecognised verdict must never map to a passing exit code');

  if (fails.length) {
    console.error('X self-test FAILED:');
    fails.forEach((f) => console.error('   - ' + f));
    return 'FAIL';
  }
  console.log(
    '+ self-test: parse/derive (6), 4 must-fire structural, must-not-fire clean, 7 attestation cases, ' +
      '2 unparseable-lockfile, delisted-must-fire, 2 network-never-pass, 404-is-an-answer, sweep fan-out (4), vacuity guard.',
  );
  return 'PASS';
}

/**
 * The token -> exit-code mapping, extracted so the self-test can ASSERT it. Keeping this inline
 * is a known hole: OPS-TEST-GATE-RECONCILE-W1 found a sibling gate whose self-test checked the
 * verdict TOKENS but never the mapping, so re-coding INDETERMINATE to 0 left it fully green.
 * 3 for INDETERMINATE is the token-law default for a NEW gate.
 */
export function exitCodeFor(verdict) {
  return verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 3;
}

function verdictAndExit(v) {
  console.log(`LOCKFILE_RESOLVABLE_VERDICT=${v}`);
  process.exit(exitCodeFor(v));
}

/**
 * An UNEXPECTED THROW MUST STILL EMIT A TOKEN. Callers gate on the token, so a stack trace with
 * no verdict line is indistinguishable from the gate never having run — the dark-guard class this
 * repo has now hit five times. Found by deliberately breaking the logic during R4 verification:
 * neutering the network-is-indeterminate branch made `evaluateResolvability` dereference a null
 * and the process died silently, tokenless. A crash is by definition "could not verify".
 */
function crash(err) {
  console.error(`X unexpected failure: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  console.error('   a crash is not a pass — reporting INDETERMINATE so callers gating on the token still see a verdict.');
  verdictAndExit('INDETERMINATE');
}
// ── main ─────────────────────────────────────────────────────────────────────

/**
 * Guarded so the pure exports above are IMPORTABLE by the test suite. Without this, importing
 * this module would run the whole gate and `process.exit` out of the test runner — CLAUDE.md's
 * "make entrypoints test-importable" rule, in its ESM form.
 */
async function main() {
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);

  const st = await selfTest().catch((err) => {
    console.error(`X the self-test itself threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return 'INDETERMINATE';
  });
  if (argv.includes('--self-test')) verdictAndExit(st);
  if (st !== 'PASS') verdictAndExit(st); // a broken detector must never green-light the scan

  if (!existsSync(LOCK_FILE)) {
    console.error(`X package-lock.json missing at ${LOCK_FILE} — cannot decide, refusing to pass`);
    verdictAndExit('INDETERMINATE');
  }
  const lock = parseLock(readFileSync(LOCK_FILE, 'utf8'));
  if (!lock.ok) {
    console.error(`X ${lock.reason}`);
    verdictAndExit('INDETERMINATE');
  }

  // Vacuity guard: a lockfile that pins nothing means the parser broke, not that the project has
  // no dependencies. The corpus was handed to us and is unusable, so INDETERMINATE.
  if (lock.entries.length === 0) {
    console.error('X package-lock.json pins ZERO packages — refusing to report a pass over an empty corpus');
    verdictAndExit('INDETERMINATE');
  }

  const struct = structuralFindings(lock.entries);
  const structuralFail =
    struct.foreignRegistry.length + struct.missingResolved.length + struct.missingIntegrity.length + struct.nameDisagreement.length;
  if (structuralFail) {
    console.error(`X ${structuralFail} lockfile entr(ies) are not reproducibly installable:`);
    for (const e of struct.missingResolved) console.error(`   - ${e.path}@${e.version}: no \`resolved\` URL — npm has nowhere to fetch it from`);
    for (const e of struct.foreignRegistry) console.error(`   - ${e.path}@${e.version}: resolves to ${e.resolved}, not ${REGISTRY}`);
    for (const e of struct.missingIntegrity) console.error(`   - ${e.path}@${e.version}: no \`integrity\` hash — the tarball can be swapped undetected`);
    for (const e of struct.nameDisagreement) console.error(`   - ${e.path}: path says ${e.nameByPath}, resolved says ${e.nameByResolved}`);
    verdictAndExit('FAIL');
  }

  const pins = pinSet(lock.entries);
  const names = [...new Set(pins.map((p) => p.slice(0, p.lastIndexOf('@'))))].sort();

  // ── offline mode: provenance, not freshness ──────────────────────────────────

  if (argv.includes('--offline')) {
    if (!existsSync(ATTEST_FILE)) {
      console.error(`X attestation missing at ${ATTEST_FILE} — cannot vouch for any pin, refusing to pass`);
      console.error('   remediation: node scripts/check-lockfile-resolvable.mjs --attest');
      verdictAndExit('INDETERMINATE');
    }
    const att = loadAttestation(readFileSync(ATTEST_FILE, 'utf8'));
    if (!att.ok) {
      console.error(`X ${att.reason}`);
      console.error('   remediation: node scripts/check-lockfile-resolvable.mjs --attest');
      verdictAndExit('INDETERMINATE');
    }
    const gaps = unattested(pins, att.verified);
    if (gaps.length) {
      console.error(`X ${gaps.length} pin(s) have never been live-verified as resolvable:`);
      for (const g of gaps.slice(0, 40)) console.error(`   - ${g}`);
      if (gaps.length > 40) console.error(`   ... and ${gaps.length - 40} more`);
      console.error('   remediation: node scripts/check-lockfile-resolvable.mjs --attest   (then commit scripts/data/lockfile-resolvability.json)');
      verdictAndExit('FAIL');
    }
    console.log(`+ structural: ${lock.entries.length} entries all pin ${REGISTRY} with an integrity hash.`);
    console.log(`+ provenance: all ${pins.length} pins across ${names.length} packages are covered by the attestation (last live-verified ${att.verifiedAt || 'unknown'}).`);
    console.log('  (offline mode asserts PROVENANCE; "still resolvable TODAY" is the daily scheduled run.)');
    verdictAndExit('PASS');
  }

  // ── network mode: the property, today ────────────────────────────────────────

  console.log(`  sweeping ${names.length} packages (${pins.length} pinned versions) against ${REGISTRY} ...`);
  const { listedByName, failures } = await sweep(names, (n) => fetchPackument(n));
  const { unresolvable, indeterminate, ok } = evaluateResolvability(pins, listedByName);

  if (unresolvable.length) {
    // Distinguish DELISTED-BUT-SERVED from GONE — they need different urgency. Delisted-but-served
    // means `npm ci` still works and only a fresh `npm install` fails, so there is time; gone means
    // the rebuild is already broken.
    console.error(`X ${unresolvable.length} pinned version(s) are NOT LISTED on the registry:`);
    for (const u of unresolvable) {
      const entry = lock.entries.find((e) => (e.nameByResolved || e.nameByPath) === u.name && e.version === u.version);
      const served = entry?.resolved ? await tarballReachable(entry.resolved) : false;
      const all = [...(u.listed || [])].sort();
      const range = all.length ? `listed: ${all[0]} .. ${all[all.length - 1]} (${all.length})` : 'package absent from the registry entirely';
      console.error(`   - ${u.pin} — ${range}`);
      console.error(
        served
          ? '       DELISTED BUT SERVED: `npm ci` still works, a fresh `npm install` fails ETARGET. Fix before the tarball is GC\'d.'
          : '       GONE: the tarball is unreachable too. `npm ci` from a clean cache is ALREADY broken.',
      );
    }
    verdictAndExit('FAIL');
  }

  if (indeterminate.length) {
    console.error(`X could not check ${indeterminate.length} pin(s) across ${failures.length} unreachable package(s) — the registry did not answer:`);
    for (const f of failures.slice(0, 20)) console.error(`   - ${f.name}: ${f.reason}`);
    if (failures.length > 20) console.error(`   ... and ${failures.length - 20} more`);
    console.error('   an unreachable registry is INDETERMINATE, never a pass — this gate must not green-light an unverified property.');
    verdictAndExit('INDETERMINATE');
  }

  console.log(`+ resolvable: all ${ok.length} pinned versions across ${names.length} packages are listed on ${REGISTRY}.`);


  if (argv.includes('--attest')) {
    const payload = {
      _comment:
        'Live-verified pin set for scripts/check-lockfile-resolvable.mjs --offline. Regenerate with ' +
        '`node scripts/check-lockfile-resolvable.mjs --attest` whenever package-lock.json gains or changes a pin. ' +
        'This records a PAST fact (each pin was listed on the registry when verified) and therefore does not expire; ' +
        '"still resolvable today" is asserted by the daily scheduled run, not by this file.',
      schema_version: 1,
      registry: REGISTRY,
      verified_at: new Date().toISOString(),
      verified_by: 'scripts/check-lockfile-resolvable.mjs --attest',
      owner_wave: 'OPS-SUPPLY-CHAIN-RESOLVABILITY-W1',
      pin_count: pins.length,
      package_count: names.length,
      verified_pins: pins,
    };
    writeFileSync(ATTEST_FILE, JSON.stringify(payload, null, 2) + '\n');
    console.log(`+ attested: wrote ${pins.length} verified pins to scripts/data/lockfile-resolvability.json`);
  }

  verdictAndExit('PASS');
}

/**
 * Run only when invoked directly; a plain `import` gets the pure exports and nothing else.
 *
 * Compare REALPATHS. `import.meta.url` is already resolved through symlinks while `process.argv[1]`
 * is not, so the naive comparison silently declines to run whenever the script is reached via a
 * symlinked path — which on macOS is every `mkdtemp` directory (`/var/...` -> `/private/var/...`),
 * and on the host is any `/opt` path behind a link. The failure mode is the worst kind: exit 0,
 * no output, no token, nothing run.
 */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
}
if (invokedDirectly()) await main();

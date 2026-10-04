// scripts/lib/npm-registry-read.mjs — the ONE place this repo reads the npm registry back.
//
// OPS-DISTTAG-EVENTUAL-CONSISTENCY-W1 CH1 R1.
//
// ── WHY ─────────────────────────────────────────────────────────────────────────────────────
// publish-npm.yml's old `Verify dist-tag` step read the full PACKUMENT 3× at 20 s intervals,
// starting the moment `npm publish` returned. It went red on every release from v1.28.0 on, each
// time AFTER npm had accepted the upload. Two independent defects, measured:
//
//   1. PROPAGATION (dominant). Since npm's publish-time malware scanning (GitHub Changelog
//      2026-07-28), a version does not EXIST at registry origin for minutes after `npm publish`
//      returns. The registry's own `time[v]` stamp landed +249.0 to +307.6 s after the publish
//      returned on 6/6 publishing runs from 2026-08-22 to 2026-09-23. Before that it was −0.6 s.
//      No endpoint, cached or not, can serve a document that does not exist yet. The cure is a
//      bounded WAIT, and it is the caller's (CH2), not this module's.
//   2. CACHE (secondary). The packument is Cloudflare-cached `public, max-age=300`, so even after
//      propagation it can serve the previous `dist-tags.latest` for up to 300 s more.
//
// This module fixes (2) for every caller, once. It reads only the endpoints measured as NOT served
// from cache, so a wait built on it measures the registry rather than the edge.
//
// ── MEASURED — registry.npmjs.org, 2026-10-04T05:24Z, three consecutive reads each ─────────────
//
//   endpoint                              cf-cache-status           cache-control          bytes
//   /<pkg>               (packument)      HIT · HIT · HIT (age 165) public, max-age=300    254,819
//   /-/package/<pkg>/dist-tags            DYNAMIC × 3               (absent)                    19
//   /<pkg>/<v>           (bare)           DYNAMIC · HIT · HIT       public, max-age=300     11,201
//   /<pkg>/<v>?cb=<fresh>                 DYNAMIC × 3               max-age=300             11,201
//   /<pkg>/<absent v>                     (header ABSENT) 404 × 3   (absent)                    26
//
// So: dist-tags is read UNBUSTED (it is never served from cache and carries no cache-control);
// the version document is read with a FRESH `?cb=` on every call, because a bare repeat within
// 300 s is a HIT; and a 404 for a version that does not exist yet is not negatively cached.
// tests/unit/npm-registry-read.test.ts carries a LIVE leg that re-measures all three, because
// Cloudflare's cache policy is the one premise here nothing in this repo can prevent changing.
//
// ── "DOES THE TOOL ALREADY DO THIS?" — answered, so it is not re-probed next wave ─────────────
//   · `npm dist-tag ls <pkg>` reads this same /-/package/<pkg>/dist-tags endpoint with
//     `prefer-online` (npm 11 lib/commands/dist-tag.js:191-194). It cannot return
//     cf-cache-status, which the live leg is built on.
//   · No npm command reads the version document. `npm view` reads the PACKUMENT, which is the
//     cached one.
//   · npm's lifecycle endpoint /-/package/<pkg>/version/<v>/status answers 401 without a
//     publish token. Using one would undo the tokenless OIDC posture that
//     tests/unit/publish-lane-invariants.test.ts INVARIANT 3 protects.
//
// ── CONTRACT ────────────────────────────────────────────────────────────────────────────────
//   · Side-effect free: no main(), no top-level I/O, and NO process.exit anywhere
//     (tests/unit/verdict-exit-path.test.ts + ops/verdict-exit-baseline.json enforce the class).
//   · Readers NEVER THROW. Anything that goes wrong comes back as `ok: false` with a `reason`.
//   · Readers NEVER CLASSIFY. They report what the registry said; deciding whether that means a
//     publish passed, failed or is still propagating is the caller's job
//     (scripts/verify-npm-propagation.mjs).
//   · `fetchImpl` and `timeoutMs` are injectable so tests can drive every branch offline.

import { randomUUID } from 'node:crypto';

export const REGISTRY = 'https://registry.npmjs.org';

/** Cloudflare statuses that mean the body came from an edge cache, not from origin. */
export const SERVED_FROM_CACHE = new Set(['HIT', 'STALE', 'UPDATING']);

// npm package name: optional @scope/, then url-safe lowercase-ish chars. Validation exists so a
// garbage name can never be interpolated into a URL; it is not a full re-implementation of
// validate-npm-package-name.
const NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function isValidPackageName(pkg) {
  return typeof pkg === 'string' && pkg.length > 0 && pkg.length <= 214 && NAME_RE.test(pkg);
}

export function isValidVersion(v) {
  return typeof v === 'string' && VERSION_RE.test(v);
}

/** `@scope/name` → `@scope%2Fname` (the registry's escaped form); unscoped names pass through. */
export function escapePackageName(pkg) {
  return pkg.startsWith('@') ? `@${encodeURIComponent(pkg.slice(1))}` : encodeURIComponent(pkg);
}

/** The uncached dist-tags document: `{"latest":"<v>", …}`. */
export const DIST_TAGS_URL = (pkg) => `${REGISTRY}/-/package/${escapePackageName(pkg)}/dist-tags`;

/** The version document, ALWAYS with a cache-buster: a bare repeat is a HIT within 300 s. */
export const VERSION_DOC_URL = (pkg, v, cb) =>
  `${REGISTRY}/${escapePackageName(pkg)}/${encodeURIComponent(v)}?cb=${encodeURIComponent(cb)}`;

/**
 * The PACKUMENT — the CACHED document (`public, max-age=300`).
 *
 * 🛑 Exported ONLY so scripts/check-packument-read.mjs can name the forbidden shape from one place.
 * NOTHING may call this to ASSERT on a value a publish just changed: that is the defect this
 * module exists to retire. It is used nowhere in this file.
 */
export const PACKUMENT_URL = (pkg) => `${REGISTRY}/${escapePackageName(pkg)}`;

/** A fresh cache-buster per call. Never reused: a repeated buster is just another cache key. */
export function freshCacheBuster() {
  return `${Date.now().toString(36)}-${randomUUID()}`;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** One GET. Never throws: returns { status, cacheStatus, text } or { transportError }. */
async function get(url, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    if (typeof fetchImpl !== 'function') return { transportError: 'no fetch implementation available' };
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': 'algovault-npm-registry-read' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res || typeof res.status !== 'number') return { transportError: 'fetch returned no response' };
    const cacheStatus = (res.headers && typeof res.headers.get === 'function' && res.headers.get('cf-cache-status')) || null;
    let text = '';
    try {
      text = await res.text();
    } catch (e) {
      return { transportError: `body read failed: ${e?.message ?? String(e)}`, status: res.status, cacheStatus };
    }
    return { status: res.status, cacheStatus, text };
  } catch (e) {
    const cause = e?.cause?.code ? ` (${e.cause.code})` : '';
    return { transportError: `${e?.name ?? 'Error'}: ${e?.message ?? String(e)}${cause}` };
  }
}

function parseJson(text) {
  try {
    return { value: JSON.parse(text) };
  } catch (e) {
    return { error: e?.message ?? String(e) };
  }
}

/**
 * Read the dist-tags document, unbusted.
 * @returns {Promise<{ok: boolean, latest: string|null, status: number|null, cacheStatus: string|null, reason: string|null, url: string|null}>}
 */
export async function readDistTags(pkg, opts = {}) {
  const out = { ok: false, latest: null, status: null, cacheStatus: null, reason: null, url: null };
  if (!isValidPackageName(pkg)) return { ...out, reason: `invalid package name: ${JSON.stringify(pkg)}` };
  out.url = DIST_TAGS_URL(pkg);
  const r = await get(out.url, opts);
  if (r.transportError) {
    return { ...out, status: r.status ?? null, cacheStatus: r.cacheStatus ?? null, reason: `transport: ${r.transportError}` };
  }
  out.status = r.status;
  out.cacheStatus = r.cacheStatus;
  if (r.status !== 200) return { ...out, reason: `http ${r.status}` };
  const parsed = parseJson(r.text);
  if (parsed.error) return { ...out, reason: `unparseable: ${parsed.error}` };
  const doc = parsed.value;
  // The dist-tags document is a FLAT map of tag → version. The packument nests it under
  // "dist-tags", so a top-level `latest` is what tells the two shapes apart: a reader pointed at
  // the packument by mistake must fail here rather than quietly read something else.
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || typeof doc.latest !== 'string') {
    return { ...out, reason: 'unparseable: no top-level "latest" string (is this the packument shape?)' };
  }
  if (!isValidVersion(doc.latest)) return { ...out, reason: `unparseable: latest is not a version: ${JSON.stringify(doc.latest)}` };
  return { ...out, ok: true, latest: doc.latest };
}

/**
 * Read one version's document, with a fresh cache-buster.
 * `ok` means the registry gave a USABLE answer. `found` separates "this version exists" (200) from
 * "it does not exist yet" (404). A 404 is a successful read of an absence, not a transport failure.
 * @returns {Promise<{ok: boolean, found: boolean, version: string|null, integrity: string|null, status: number|null, cacheStatus: string|null, reason: string|null, url: string|null}>}
 */
export async function readVersionDoc(pkg, v, opts = {}) {
  const out = { ok: false, found: false, version: null, integrity: null, status: null, cacheStatus: null, reason: null, url: null };
  if (!isValidPackageName(pkg)) return { ...out, reason: `invalid package name: ${JSON.stringify(pkg)}` };
  if (!isValidVersion(v)) return { ...out, reason: `invalid version: ${JSON.stringify(v)}` };
  const cb = typeof opts.cacheBuster === 'function' ? opts.cacheBuster() : freshCacheBuster();
  out.url = VERSION_DOC_URL(pkg, v, cb);
  const r = await get(out.url, opts);
  if (r.transportError) {
    return { ...out, status: r.status ?? null, cacheStatus: r.cacheStatus ?? null, reason: `transport: ${r.transportError}` };
  }
  out.status = r.status;
  out.cacheStatus = r.cacheStatus;
  if (r.status === 404) return { ...out, ok: true, found: false, reason: 'not found (404)' };
  if (r.status !== 200) return { ...out, reason: `http ${r.status}` };
  const parsed = parseJson(r.text);
  if (parsed.error) return { ...out, reason: `unparseable: ${parsed.error}` };
  const doc = parsed.value;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ...out, reason: 'unparseable: body is not an object' };
  // Identity, asserted rather than assumed: a 200 for the wrong document is not evidence.
  if (doc.version !== v) return { ...out, reason: `identity mismatch: asked for ${v}, body says ${JSON.stringify(doc.version ?? null)}` };
  const integrity = doc.dist && typeof doc.dist.integrity === 'string' ? doc.dist.integrity : null;
  if (!integrity) return { ...out, reason: 'unparseable: no dist.integrity' };
  return { ...out, ok: true, found: true, version: doc.version, integrity };
}

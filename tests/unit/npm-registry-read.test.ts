/**
 * OPS-DISTTAG-EVENTUAL-CONSISTENCY-W1 CH1 R2 — the ONE registry reader, proven both ways, plus a
 * LIVE cache canary, plus the packument ratchet run against the real tree.
 *
 * ── THREE THINGS THIS FILE PROVES ─────────────────────────────────────────────────────────────
 *
 * 1. OFFLINE, BOTH DIRECTIONS. Every branch of scripts/lib/npm-registry-read.mjs (200 / 404 / 5xx /
 *    malformed JSON / transport failure / identity mismatch) is driven through an injected fetch, so
 *    the readers' `ok`, `found` and `reason` are asserted without the network. The parser is BROKEN
 *    DELIBERATELY: a reader pointed at the packument shape must fail the dist-tags contract, or the
 *    contract cannot tell the two documents apart.
 *
 * 2. LIVE, THE ONE PREMISE NOTHING HERE CAN PREVENT CHANGING. The whole fix rests on three
 *    measurements of Cloudflare's policy for registry.npmjs.org: dist-tags is not served from cache,
 *    a cache-busted version document is not served from cache, and a 404 for an absent version is
 *    not negatively cached. The live leg re-measures all three on every suite run.
 *      · a measured cache hit (HIT / STALE / UPDATING) is RED: the premise has expired and the lane
 *        is reading an edge again;
 *      · an unreachable host is INDETERMINATE and the test SKIPS. A runner losing DNS is not
 *        Cloudflare changing policy;
 *      · the 404 leg asserts "cf-cache-status absent OR not served from cache", NEVER `== DYNAMIC`:
 *        measured, that 404 carries no such header at all, so an equality would red on the one case
 *        the leg exists to cover.
 *
 * 3. THE RATCHET IS WIRED. scripts/check-packument-read.mjs runs here against the real tree, so it
 *    executes on every CI run and every push (scripts/check-canaries-wired.mjs counts a test
 *    reference as wiring).
 *    ⚠️ CH1 STATE, deliberate: the tree still carries ONE forbidden read, publish-npm.yml's
 *    `Verify dist-tag` packument read, which CH2 removes. The baseline is EMPTY on purpose, because
 *    baselining a live defect would launder it. So this file asserts the verdict is FAIL and that the
 *    violation set is EXACTLY that one read. Any NEW violation still reds the suite. CH2 flips the
 *    assertion to PASS in the same commit that deletes the read. An exemption and its test are a
 *    pair, and leaving either half behind makes the other a lie.
 */
import { describe, it, expect } from 'vitest';
import {
  DIST_TAGS_URL,
  VERSION_DOC_URL,
  PACKUMENT_URL,
  REGISTRY,
  SERVED_FROM_CACHE,
  escapePackageName,
  freshCacheBuster,
  readDistTags,
  readVersionDoc,
} from '../../scripts/lib/npm-registry-read.mjs';
import { evaluate, selfTest, EXIT } from '../../scripts/check-packument-read.mjs';

const PKG = 'crypto-quant-signal-mcp';
const V = '1.31.0';
const INTEGRITY = 'sha512-8oBo9BjSFjKH5aeiVaRwv4LPJ+DAc/yMy-fixture';

type Route = { status: number; body: string; headers?: Record<string, string> };

/** A fake registry: routes by URL WITHOUT its query string, records every URL it was asked for. */
function fakeRegistry(routes: Record<string, Route | Error>) {
  const seen: string[] = [];
  const fetchImpl = async (url: string) => {
    seen.push(url);
    const key = url.split('?')[0];
    const r = routes[key];
    if (r instanceof Error) throw r;
    if (!r) return new Response('{"error":"Not found"}', { status: 404 });
    return new Response(r.body, { status: r.status, headers: r.headers ?? {} });
  };
  return { fetchImpl, seen };
}

const PACKUMENT_BODY = JSON.stringify({ _id: PKG, name: PKG, 'dist-tags': { latest: V }, versions: { [V]: {} } });
const DIST_TAGS_BODY = JSON.stringify({ latest: V });
const VERSION_BODY = JSON.stringify({ name: PKG, version: V, dist: { integrity: INTEGRITY } });
const VERSION_KEY = `${REGISTRY}/${PKG}/${V}`;

describe('URL builders — one spelling of every endpoint', () => {
  it('dist-tags, version document (always busted), packument', () => {
    expect(DIST_TAGS_URL(PKG)).toBe(`https://registry.npmjs.org/-/package/${PKG}/dist-tags`);
    expect(VERSION_DOC_URL(PKG, V, 'abc')).toBe(`https://registry.npmjs.org/${PKG}/${V}?cb=abc`);
    expect(PACKUMENT_URL(PKG)).toBe(`https://registry.npmjs.org/${PKG}`);
  });
  it('a scoped name is escaped the way the registry spells it', () => {
    expect(escapePackageName('@scope/name')).toBe('@scope%2Fname');
    expect(DIST_TAGS_URL('@scope/name')).toBe('https://registry.npmjs.org/-/package/@scope%2Fname/dist-tags');
  });
  it('every cache-buster is fresh — a repeated buster is just another cache key', () => {
    const seen = new Set(Array.from({ length: 50 }, () => freshCacheBuster()));
    expect(seen.size).toBe(50);
  });
});

describe('readDistTags — offline, both directions', () => {
  it('200 with a flat {latest} → ok, latest, cacheStatus from the header', async () => {
    const reg = fakeRegistry({ [DIST_TAGS_URL(PKG)]: { status: 200, body: DIST_TAGS_BODY, headers: { 'cf-cache-status': 'DYNAMIC' } } });
    const r = await readDistTags(PKG, { fetchImpl: reg.fetchImpl });
    expect(r).toMatchObject({ ok: true, latest: V, status: 200, cacheStatus: 'DYNAMIC', reason: null });
    expect(reg.seen).toEqual([DIST_TAGS_URL(PKG)]);
  });
  it('dist-tags is read UNBUSTED — the endpoint is already uncached', async () => {
    const reg = fakeRegistry({ [DIST_TAGS_URL(PKG)]: { status: 200, body: DIST_TAGS_BODY } });
    await readDistTags(PKG, { fetchImpl: reg.fetchImpl });
    expect(reg.seen[0].includes('?')).toBe(false);
  });
  it('404 → not ok, status 404', async () => {
    const reg = fakeRegistry({});
    const r = await readDistTags(PKG, { fetchImpl: reg.fetchImpl });
    expect(r).toMatchObject({ ok: false, status: 404, latest: null });
    expect(r.reason).toMatch(/http 404/);
  });
  it('5xx → not ok, reason names the status', async () => {
    const reg = fakeRegistry({ [DIST_TAGS_URL(PKG)]: { status: 503, body: 'busy' } });
    const r = await readDistTags(PKG, { fetchImpl: reg.fetchImpl });
    expect(r).toMatchObject({ ok: false, status: 503 });
    expect(r.reason).toMatch(/http 503/);
  });
  it('malformed JSON → not ok, unparseable', async () => {
    const reg = fakeRegistry({ [DIST_TAGS_URL(PKG)]: { status: 200, body: '{"latest":' } });
    const r = await readDistTags(PKG, { fetchImpl: reg.fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^unparseable/);
  });
  it('transport failure → not ok, status null, reason "transport", and it does NOT throw', async () => {
    const reg = fakeRegistry({ [DIST_TAGS_URL(PKG)]: new TypeError('fetch failed') });
    const r = await readDistTags(PKG, { fetchImpl: reg.fetchImpl });
    expect(r).toMatchObject({ ok: false, status: null });
    expect(r.reason).toMatch(/^transport: TypeError: fetch failed/);
  });
  it('a fetch that returns garbage never throws into the caller', async () => {
    const r = await readDistTags(PKG, { fetchImpl: (async () => undefined) as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^transport/);
  });
  it('an invalid package name is refused before any fetch', async () => {
    const reg = fakeRegistry({});
    const r = await readDistTags('../etc/passwd', { fetchImpl: reg.fetchImpl });
    expect(r.ok).toBe(false);
    expect(reg.seen).toEqual([]);
  });
});

describe('readVersionDoc — offline, both directions', () => {
  it('200 with matching version + integrity → ok, found', async () => {
    const reg = fakeRegistry({ [VERSION_KEY]: { status: 200, body: VERSION_BODY, headers: { 'cf-cache-status': 'DYNAMIC' } } });
    const r = await readVersionDoc(PKG, V, { fetchImpl: reg.fetchImpl });
    expect(r).toMatchObject({ ok: true, found: true, version: V, integrity: INTEGRITY, status: 200, cacheStatus: 'DYNAMIC' });
  });
  it('every read carries a FRESH cache-buster', async () => {
    const reg = fakeRegistry({ [VERSION_KEY]: { status: 200, body: VERSION_BODY } });
    await readVersionDoc(PKG, V, { fetchImpl: reg.fetchImpl });
    await readVersionDoc(PKG, V, { fetchImpl: reg.fetchImpl });
    expect(reg.seen.every((u) => /\?cb=./.test(u))).toBe(true);
    expect(new Set(reg.seen).size).toBe(2);
  });
  it('404 → ok (a successful read of an ABSENCE), found false — not a transport failure', async () => {
    const reg = fakeRegistry({});
    const r = await readVersionDoc(PKG, V, { fetchImpl: reg.fetchImpl });
    expect(r).toMatchObject({ ok: true, found: false, status: 404, version: null });
  });
  it('5xx → not ok', async () => {
    const reg = fakeRegistry({ [VERSION_KEY]: { status: 502, body: '' } });
    const r = await readVersionDoc(PKG, V, { fetchImpl: reg.fetchImpl });
    expect(r).toMatchObject({ ok: false, found: false, status: 502 });
  });
  it('malformed JSON → not ok', async () => {
    const reg = fakeRegistry({ [VERSION_KEY]: { status: 200, body: '<html>' } });
    const r = await readVersionDoc(PKG, V, { fetchImpl: reg.fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^unparseable/);
  });
  it('a 200 for the WRONG version is not evidence (identity asserted, never assumed)', async () => {
    const reg = fakeRegistry({ [VERSION_KEY]: { status: 200, body: JSON.stringify({ version: '1.30.0', dist: { integrity: INTEGRITY } }) } });
    const r = await readVersionDoc(PKG, V, { fetchImpl: reg.fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/identity mismatch/);
  });
  it('transport failure → not ok, found false, and it does NOT throw', async () => {
    const reg = fakeRegistry({ [VERSION_KEY]: new Error('ECONNRESET') });
    const r = await readVersionDoc(PKG, V, { fetchImpl: reg.fetchImpl });
    expect(r).toMatchObject({ ok: false, found: false });
    expect(r.reason).toMatch(/^transport/);
  });
});

/** The dist-tags contract: returns the list of broken clauses (empty = honoured). */
async function distTagsContractFailures(reader: typeof readDistTags): Promise<string[]> {
  const reg = fakeRegistry({
    [DIST_TAGS_URL(PKG)]: { status: 200, body: DIST_TAGS_BODY },
    [PACKUMENT_URL(PKG)]: { status: 200, body: PACKUMENT_BODY, headers: { 'cf-cache-status': 'HIT' } },
  });
  const r = await reader(PKG, { fetchImpl: reg.fetchImpl });
  const fails: string[] = [];
  if (!r.ok) fails.push(`not ok: ${r.reason}`);
  if (r.latest !== V) fails.push(`latest ${r.latest}`);
  if (reg.seen.some((u) => u.split('?')[0] === PACKUMENT_URL(PKG))) fails.push('read the PACKUMENT');
  return fails;
}

describe('the dist-tags contract is PROVEN able to fail', () => {
  it('the real reader honours it', async () => {
    expect(await distTagsContractFailures(readDistTags)).toEqual([]);
  });
  it('DELIBERATE BREAK: readDistTags pointed at the packument shape fails the contract', async () => {
    // Same function, but every request is re-routed to the packument, which is exactly the old
    // Verify-dist-tag read. If this ever passes, the contract cannot tell the documents apart.
    const broken: typeof readDistTags = (pkg, opts) =>
      readDistTags(pkg, { ...opts, fetchImpl: (_u: string, init?: RequestInit) => (opts!.fetchImpl as typeof fetch)(PACKUMENT_URL(pkg), init) });
    const fails = await distTagsContractFailures(broken);
    expect(fails.length).toBeGreaterThan(0);
    expect(fails.join(' | ')).toMatch(/read the PACKUMENT/);
  });
  it('the packument BODY is rejected by the dist-tags parser (no top-level latest)', async () => {
    const reg = fakeRegistry({ [DIST_TAGS_URL(PKG)]: { status: 200, body: PACKUMENT_BODY } });
    const r = await readDistTags(PKG, { fetchImpl: reg.fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/packument shape/);
  });
});

// ─── the LIVE cache canary ───────────────────────────────────────────────────────────────────

type LiveRead = { reachable: boolean; status: number | null; cacheStatus: string | null; note?: string };
type LiveLegs = { distTags: LiveRead[]; versionDoc: LiveRead[]; missing404: LiveRead[] };
type Judgement = { verdict: 'PASS' | 'FAIL' | 'INDETERMINATE'; why: string };

/**
 * Judge the three legs. FAIL outranks INDETERMINATE: a measured cache hit is actionable whatever
 * else could not be read. Unexpected statuses are INDETERMINATE — they say nothing about the cache.
 */
function judgeCacheCanary(legs: LiveLegs): Judgement {
  const all: Array<[string, LiveRead, number]> = [
    ...legs.distTags.map((r) => ['dist-tags', r, 200] as [string, LiveRead, number]),
    ...legs.versionDoc.map((r) => ['busted version doc', r, 200] as [string, LiveRead, number]),
    ...legs.missing404.map((r) => ['missing-version 404', r, 404] as [string, LiveRead, number]),
  ];
  if (legs.distTags.length < 2 || legs.versionDoc.length < 3 || legs.missing404.length < 1) {
    return { verdict: 'INDETERMINATE', why: 'a leg was not measured the required number of times' };
  }
  const hit = all.find(([, r]) => r.reachable && r.cacheStatus !== null && SERVED_FROM_CACHE.has(r.cacheStatus.toUpperCase()));
  if (hit) return { verdict: 'FAIL', why: `${hit[0]} was SERVED FROM CACHE (cf-cache-status: ${hit[1].cacheStatus}) — the uncached-read premise has expired` };
  const blind = all.find(([, r, want]) => !r.reachable || r.status !== want);
  if (blind) return { verdict: 'INDETERMINATE', why: `${blind[0]}: ${blind[1].reachable ? `status ${blind[1].status}` : `unreachable (${blind[1].note})`}` };
  return { verdict: 'PASS', why: 'all three premises hold' };
}

const MISSING = '0.0.0-npm-registry-read-canary';

async function measureLive(fetchImpl: typeof fetch = fetch): Promise<LiveLegs> {
  const asLive = (r: { reason: string | null; status: number | null; cacheStatus: string | null }): LiveRead => ({
    reachable: !(r.reason ?? '').startsWith('transport'),
    status: r.status,
    cacheStatus: r.cacheStatus,
    note: r.reason ?? undefined,
  });
  const distTags: LiveRead[] = [];
  let latest: string | null = null;
  for (let i = 0; i < 2; i++) {
    const r = await readDistTags(PKG, { fetchImpl, timeoutMs: 10_000 });
    distTags.push(asLive(r));
    latest = r.latest ?? latest;
  }
  const versionDoc: LiveRead[] = [];
  if (latest) {
    for (let i = 0; i < 3; i++) versionDoc.push(asLive(await readVersionDoc(PKG, latest, { fetchImpl, timeoutMs: 10_000 })));
  }
  // The 404 leg reads the BARE url on purpose: negative caching of an unbusted read is the premise.
  const missing404: LiveRead[] = [];
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetchImpl(`${REGISTRY}/${PKG}/${MISSING}`, { signal: AbortSignal.timeout(10_000) });
      await res.text();
      missing404.push({ reachable: true, status: res.status, cacheStatus: res.headers.get('cf-cache-status') });
    } catch (e) {
      missing404.push({ reachable: false, status: null, cacheStatus: null, note: (e as Error).message });
    }
  }
  return { distTags, versionDoc, missing404 };
}

describe('judgeCacheCanary — the verdict rules, offline', () => {
  const ok = (cacheStatus: string | null, status = 200): LiveRead => ({ reachable: true, status, cacheStatus });
  const healthy: LiveLegs = { distTags: [ok('DYNAMIC'), ok('DYNAMIC')], versionDoc: [ok('DYNAMIC'), ok('DYNAMIC'), ok('MISS')], missing404: [ok(null, 404), ok(null, 404)] };
  it('the measured world → PASS', () => expect(judgeCacheCanary(healthy).verdict).toBe('PASS'));
  it('the 404 leg passes with cf-cache-status ABSENT (never asserted == DYNAMIC)', () =>
    expect(judgeCacheCanary({ ...healthy, missing404: [ok(null, 404)] }).verdict).toBe('PASS'));
  it('dist-tags HIT → FAIL', () => expect(judgeCacheCanary({ ...healthy, distTags: [ok('DYNAMIC'), ok('HIT')] }).verdict).toBe('FAIL'));
  it('busted version doc HIT → FAIL', () => expect(judgeCacheCanary({ ...healthy, versionDoc: [ok('DYNAMIC'), ok('HIT'), ok('HIT')] }).verdict).toBe('FAIL'));
  it('a negatively-cached 404 → FAIL', () => expect(judgeCacheCanary({ ...healthy, missing404: [ok('HIT', 404)] }).verdict).toBe('FAIL'));
  it('STALE counts as served from cache → FAIL', () => expect(judgeCacheCanary({ ...healthy, distTags: [ok('STALE'), ok('DYNAMIC')] }).verdict).toBe('FAIL'));
  it('unreachable → INDETERMINATE, never red', () =>
    expect(judgeCacheCanary({ ...healthy, distTags: [{ reachable: false, status: null, cacheStatus: null, note: 'ENOTFOUND' }, ok('DYNAMIC')] }).verdict).toBe('INDETERMINATE'));
  it('a 503 says nothing about the cache → INDETERMINATE', () =>
    expect(judgeCacheCanary({ ...healthy, versionDoc: [ok('DYNAMIC', 503), ok('DYNAMIC'), ok('DYNAMIC')] }).verdict).toBe('INDETERMINATE'));
  it('FAIL outranks INDETERMINATE', () =>
    expect(judgeCacheCanary({ ...healthy, distTags: [{ reachable: false, status: null, cacheStatus: null }, ok('HIT')] }).verdict).toBe('FAIL'));
  it('a leg measured too few times → INDETERMINATE (vacuity)', () =>
    expect(judgeCacheCanary({ ...healthy, versionDoc: [] }).verdict).toBe('INDETERMINATE'));
});

describe('LIVE cache canary — registry.npmjs.org', () => {
  it('a SIMULATED unreachable host yields INDETERMINATE, not red', { timeout: 60_000 }, async () => {
    // Real sockets, not a mock: every request is re-pointed at a closed local port (ECONNREFUSED).
    const dead = ((url: string, init?: RequestInit) => fetch(String(url).replace(REGISTRY, 'http://127.0.0.1:9'), init)) as typeof fetch;
    const legs = await measureLive(dead);
    expect(legs.distTags.every((r) => !r.reachable)).toBe(true);
    expect(judgeCacheCanary(legs).verdict).toBe('INDETERMINATE');
  });

  it('dist-tags (×2), busted version doc (×3) and a missing-version 404 are NOT served from cache', { timeout: 90_000 }, async ({ skip }) => {
    const legs = await measureLive();
    const j = judgeCacheCanary(legs);
    const fmt = (rs: LiveRead[]) => rs.map((r) => (r.reachable ? `${r.status}/${r.cacheStatus ?? 'absent'}` : 'unreachable')).join(' · ');
    console.log(`NPM_CACHE_CANARY dist-tags: ${fmt(legs.distTags)} | busted version doc: ${fmt(legs.versionDoc)} | missing 404: ${fmt(legs.missing404)} → ${j.verdict} (${j.why})`);
    if (j.verdict === 'INDETERMINATE') skip(); // could not measure: not a verdict on the cache
    expect(j.verdict, j.why).toBe('PASS');
  });
});

// ─── the packument ratchet, run against the real tree ───────────────────────────────────────

describe('scripts/check-packument-read.mjs — wired into the suite', () => {
  it('its self-test passes every case', { timeout: 60_000 }, () => {
    expect(selfTest()).toBe(0);
  });

  it('CH1: the ONLY forbidden read in the tree is publish-npm.yml\'s Verify dist-tag packument read (CH2 removes it)', { timeout: 60_000 }, () => {
    const r = evaluate();
    expect(r.own).toBe(PKG);
    expect(r.corpus ?? 0, 'the scan read nothing — a scan of nothing is not a clean tree').toBeGreaterThan(100);
    const forbidden = r.violations.map((v: { file: string; kind: string }) => `${v.file}:${v.kind}`);
    expect(forbidden).toEqual(['.github/workflows/publish-npm.yml:OWN_PACKUMENT']);
    expect(r.verdict).toBe('FAIL');
    expect(EXIT[r.verdict as 'FAIL']).toBe(1);
  });

  it('the setup-node registry-url line and every third-party read are exempt, never forbidden', { timeout: 60_000 }, () => {
    const r = evaluate();
    const at = (file: string) => r.hits.filter((h: { file: string }) => h.file === file).map((h: { kind: string }) => h.kind);
    expect(at('.github/workflows/publish-npm.yml')).toContain('BARE_HOST');
    for (const f of ['scripts/gates/cmc-ch1-gate.sh', 'src/lib/integrations-data/claim-evidence.json', 'src/lib/integrations-data/mcp-clients.ts']) {
      expect(at(f).length, `${f} has no registry occurrence any more — re-point this assertion`).toBeGreaterThan(0);
      expect(at(f).every((k: string) => k === 'THIRD_PARTY'), `${f}: ${at(f).join(',')}`).toBe(true);
    }
    expect(at('scripts/check-partner-install-coords.mjs')).toEqual(['RUNTIME_ASSEMBLED']);
  });
});

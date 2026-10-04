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
 *    CH1 asserted FAIL with exactly one violation, publish-npm.yml's `Verify dist-tag` packument
 *    read, because the baseline is EMPTY by design and that read was still live. CH2 deleted the
 *    read and flipped the assertion to PASS in the same commit: an exemption and its test are a pair.
 *
 * 4. (CH2) THE VERIFIER, RUN. scripts/verify-npm-propagation.mjs's poll loop is driven through
 *    injected readers and a fake clock: 404-then-200 inside the deadline, a version held past it,
 *    a dist-tag that never moves, an unreachable registry (real refused sockets), and the
 *    verify-only shape. No line it prints may say the publish failed.
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
import { runVerification, classify, parseDeadline, POLL_INTERVAL_S } from '../../scripts/verify-npm-propagation.mjs';
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

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

  it('the tree carries NO forbidden read-back of our own package (CH2 deleted the last one)', { timeout: 60_000 }, () => {
    const r = evaluate();
    expect(r.own).toBe(PKG);
    expect(r.corpus ?? 0, 'the scan read nothing — a scan of nothing is not a clean tree').toBeGreaterThan(100);
    const forbidden = r.violations.map((v: { file: string; line: number; kind: string }) => `${v.file}:${v.line}:${v.kind}`);
    expect(forbidden).toEqual([]);
    expect(r.verdict).toBe('PASS');
    expect(EXIT[r.verdict as 'PASS']).toBe(0);
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

// ─── scripts/verify-npm-propagation.mjs — the bounded wait, RUN (CH2 R4) ─────────────────────

type VRead = { ok: boolean; found: boolean; version: string | null; integrity: string | null; status: number | null; cacheStatus: string | null; reason: string | null; url: string | null };
type DRead = { ok: boolean; latest: string | null; status: number | null; cacheStatus: string | null; reason: string | null; url: string | null };
const vFound = (): VRead => ({ ok: true, found: true, version: V, integrity: INTEGRITY, status: 200, cacheStatus: 'DYNAMIC', reason: null, url: 'x' });
const v404 = (): VRead => ({ ok: true, found: false, version: null, integrity: null, status: 404, cacheStatus: null, reason: 'not found (404)', url: 'x' });
const vDown = (): VRead => ({ ok: false, found: false, version: null, integrity: null, status: null, cacheStatus: null, reason: 'transport: TypeError: fetch failed (ECONNREFUSED)', url: 'x' });
const dAt = (latest: string): DRead => ({ ok: true, latest, status: 200, cacheStatus: 'DYNAMIC', reason: null, url: 'x' });
const dDown = (): DRead => ({ ok: false, latest: null, status: null, cacheStatus: null, reason: 'transport: TypeError: fetch failed (ECONNREFUSED)', url: 'x' });

/** A fake clock + scripted registry: each reader is a function of SIMULATED seconds since start. */
function simulate(versionAt: (s: number) => VRead, distAt: (s: number) => DRead, extra: Record<string, unknown> = {}) {
  let t = 0;
  const calls = { version: 0, dist: 0 };
  return runVerification({
    pkg: PKG,
    version: V,
    deadlineS: 1200,
    publishOutcome: 'success',
    readers: {
      readVersionDoc: async () => (calls.version++, versionAt(t / 1000)),
      readDistTags: async () => (calls.dist++, distAt(t / 1000)),
    },
    sleep: async (ms: number) => {
      t += ms;
    },
    now: () => t,
    ...extra,
  }).then((r) => ({ ...r, calls, text: r.lines.join('\n') }));
}

const NEVER_SAYS_PUBLISH_FAILED = /publish(ed)? (has )?failed|failed to publish|publish (was )?refused/i;

describe('verify-npm-propagation — the bounded wait, run', () => {
  it('AC13: 404 until +255 s, then 200 + dist-tags moves → both PASS, NPM_PROPAGATION_SECONDS=255', async () => {
    const r = await simulate((s) => (s >= 255 ? vFound() : v404()), (s) => (s >= 255 ? dAt(V) : dAt('1.30.0')));
    expect(r.exitCode).toBe(0);
    expect(r.text).toContain('NPM_VERSION_PUBLISHED=PASS');
    expect(r.text).toContain('DIST_TAG_VERDICT=PASS');
    expect(r.text).toContain('NPM_PROPAGATION_SECONDS=255');
    expect(r.observedAt).toBe(255);
    expect(r.calls.version).toBe(255 / POLL_INTERVAL_S + 1); // polled every 15 s, stopped at the FIRST match
    expect(r.text).not.toMatch(/NPM_VERSION_REASON/);
  });

  it('the measured worst case (307 s) also lands inside the deadline', async () => {
    const r = await simulate((s) => (s >= 307 ? vFound() : v404()), (s) => (s >= 307 ? dAt(V) : dAt('1.30.0')));
    expect(r.exitCode).toBe(0);
    expect(r.observedAt).toBe(315); // first 15 s poll at or after 307 s
  });

  it('AC12: a version npm accepted but still 404 at the deadline → FAIL + REASON line + exit 1, worded as ACCEPTED-not-refused', async () => {
    const r = await simulate(() => v404(), () => dAt('1.30.0'));
    expect(r.exitCode).toBe(1);
    expect(r.text).toContain('NPM_VERSION_PUBLISHED=FAIL');
    expect(r.text).toContain('NPM_VERSION_REASON=NOT_AVAILABLE_AFTER_1200S');
    expect(r.text).toContain('NPM_PROPAGATION_SECONDS=NOT_OBSERVED_WITHIN_1200S');
    expect(r.text).toMatch(/ACCEPTED/);
    expect(r.text).toMatch(/not refused/);
    expect(r.text).toMatch(/mode: verify-only/);
    expect(r.text).toMatch(/Do NOT re-publish/);
    expect(r.text).not.toMatch(NEVER_SAYS_PUBLISH_FAILED);
    // The reason is its OWN line, never folded into the verdict token.
    expect(r.lines).toContain('NPM_VERSION_REASON=NOT_AVAILABLE_AFTER_1200S');
    expect(r.lines).toContain('NPM_VERSION_PUBLISHED=FAIL');
    // It waited out the deadline and no longer: the last poll is the one that fits inside 1200 s.
    expect(r.calls.version).toBe(Math.floor(1200 / POLL_INTERVAL_S) + 1);
  });

  it('version served but dist-tags never moves → PUBLISHED=PASS · DIST_TAG=FAIL, exit 1', async () => {
    const r = await simulate(() => vFound(), () => dAt('1.30.0'));
    expect(r.exitCode).toBe(1);
    expect(r.text).toContain('NPM_VERSION_PUBLISHED=PASS');
    expect(r.text).toContain('DIST_TAG_VERDICT=FAIL');
    expect(r.text).not.toMatch(/NPM_VERSION_REASON/);
    expect(r.text).not.toMatch(NEVER_SAYS_PUBLISH_FAILED);
  });

  it('AC11: an unreachable registry → both INDETERMINATE, exit 0, ::warning::, and it never says the publish failed', async () => {
    const r = await simulate(() => vDown(), () => dDown());
    expect(r.exitCode).toBe(0);
    expect(r.text).toContain('NPM_VERSION_PUBLISHED=INDETERMINATE');
    expect(r.text).toContain('DIST_TAG_VERDICT=INDETERMINATE');
    expect(r.text).toMatch(/::warning::/);
    expect(r.text).toMatch(/NOT evidence about the publish/);
    expect(r.text).not.toMatch(/::error::/);
    expect(r.text).not.toMatch(NEVER_SAYS_PUBLISH_FAILED);
  });

  it('AC11, real sockets: the real readers aimed at a refused port classify INDETERMINATE, exit 0', { timeout: 60_000 }, async () => {
    const dead = ((url: string, init?: RequestInit) => fetch(String(url).replace(REGISTRY, 'http://127.0.0.1:9'), init)) as typeof fetch;
    let t = 0;
    const r = await runVerification({
      pkg: PKG,
      version: V,
      deadlineS: 30,
      publishOutcome: 'success',
      readerOpts: { fetchImpl: dead, timeoutMs: 5_000 },
      sleep: async (ms: number) => {
        t += ms;
      },
      now: () => t,
    });
    expect(r.exitCode).toBe(0);
    expect(r.published).toBe('INDETERMINATE');
    expect(r.distTag).toBe('INDETERMINATE');
    expect(r.lines.join('\n')).not.toMatch(NEVER_SAYS_PUBLISH_FAILED);
  });

  it('a transport blip mid-wait does not end the wait — it keeps polling to the first match', async () => {
    const r = await simulate((s) => (s < 60 ? v404() : s < 120 ? vDown() : vFound()), (s) => (s < 120 ? dDown() : dAt(V)));
    expect(r.exitCode).toBe(0);
    expect(r.observedAt).toBe(120);
  });

  it('verify-only shape: already published, publish step skipped → PASS on the first read, 0 s', async () => {
    const r = await simulate(() => vFound(), () => dAt(V), { publishOutcome: 'skipped' });
    expect(r.exitCode).toBe(0);
    expect(r.text).toContain('NPM_PROPAGATION_SECONDS=0');
    expect(r.text).toContain('NPM_PUBLISH_OUTCOME=skipped');
    expect(r.calls.version).toBe(1);
  });

  it('verify-only shape, version missing: FAIL that does NOT claim an upload was accepted', async () => {
    const r = await simulate(() => v404(), () => dAt('1.30.0'), { publishOutcome: 'skipped' });
    expect(r.exitCode).toBe(1);
    expect(r.text).not.toMatch(/ACCEPTED/);
    expect(r.text).toMatch(/No upload ran in this run/);
  });

  it('classify() — the last read of each endpoint decides, one meaning per token', () => {
    expect(classify({ version: vFound(), distTags: dAt(V), v: V })).toEqual({ published: 'PASS', distTag: 'PASS' });
    expect(classify({ version: v404(), distTags: dAt('1.30.0'), v: V })).toEqual({ published: 'FAIL', distTag: 'FAIL' });
    expect(classify({ version: vDown(), distTags: dAt(V), v: V })).toEqual({ published: 'INDETERMINATE', distTag: 'PASS' });
    expect(classify({ version: null, distTags: null, v: V })).toEqual({ published: 'INDETERMINATE', distTag: 'INDETERMINATE' });
  });

  it('parseDeadline() refuses anything but a positive integer — no silent default', () => {
    expect(parseDeadline('1200')).toBe(1200);
    for (const bad of [undefined, '', '0', '-5', '12.5', '1e3', 'twenty', ' ']) expect(parseDeadline(bad as string)).toBeNull();
  });

  it('the LANE declares the deadline once, with its measured basis beside it, and runs this script', () => {
    const lane = readFileSync(resolve(__dirname, '..', '..', '.github', 'workflows', 'publish-npm.yml'), 'utf8');
    expect(lane).toMatch(/NPM_PROPAGATION_DEADLINE_S: '1200'/);
    expect(lane).toMatch(/measured 249-307 s/);
    expect(lane).toMatch(/run: node scripts\/verify-npm-propagation\.mjs/);
    expect(lane.match(/NPM_PROPAGATION_DEADLINE_S: /g)?.length).toBe(1);
  });
});

// ─── CH2 adversarial-review fixes, pinned (OPS-DISTTAG-EVENTUAL-CONSISTENCY-W1 CH2) ───────────

describe('a blip on the FINAL poll cannot launder a definitive verdict', () => {
  it('held version: 80 definitive 404s, then an unreadable last poll → still FAIL, exit 1', async () => {
    const r = await simulate((s) => (s >= 1200 ? vDown() : v404()), (s) => (s >= 1200 ? dDown() : dAt('1.30.0')));
    expect(r.exitCode).toBe(1);
    expect(r.published).toBe('FAIL');
    expect(r.distTag).toBe('FAIL');
    expect(r.text).toMatch(/final version-doc read was unreadable/);
    expect(r.text).toContain('NPM_VERSION_REASON=NOT_AVAILABLE_AFTER_1200S');
  });
  it('dist-tags definitively stale, then unreadable on the last poll → DIST_TAG FAIL, exit 1', async () => {
    const r = await simulate(() => vFound(), (s) => (s >= 1200 ? dDown() : dAt('1.30.0')));
    expect(r.exitCode).toBe(1);
    expect(r.published).toBe('PASS');
    expect(r.distTag).toBe('FAIL');
  });
  it('an endpoint NEVER definitively read stays INDETERMINATE (transport fails open)', async () => {
    const r = await simulate(() => vDown(), () => dAt('1.30.0'));
    expect(r.published).toBe('INDETERMINATE');
    expect(r.distTag).toBe('FAIL');
    expect(r.exitCode).toBe(1); // the definitive dist-tags FAIL still blocks
  });
  it('remediation points at a NEW dispatch, never at the Re-run button (which replays the tag push)', async () => {
    const r = await simulate(() => v404(), () => dAt('1.30.0'));
    expect(r.text).toMatch(/gh workflow run publish-npm\.yml --ref main -f mode=verify-only/);
    expect(r.text).toMatch(/Re-run button replays the tag push/);
    expect(r.text).not.toMatch(/re-run this workflow/i);
  });
});

/** The Smithery step's run text, read through a structural parse — comments do not exist there. */
function smitheryRun(src: string): string {
  const doc = (yaml.load(src) as { jobs?: Record<string, { steps?: Array<{ run?: string }> }> }) ?? {};
  for (const job of Object.values(doc.jobs ?? {})) {
    const step = (job.steps ?? []).find((st) => /api\.smithery\.ai/.test(st.run ?? ''));
    if (step) return step.run ?? '';
  }
  return '';
}
const LANE_PATH = resolve(__dirname, '..', '..', '.github', 'workflows', 'publish-npm.yml');

describe('R6 + honesty: the Smithery leg follows package.json and never claims an upload that did not happen', () => {
  const src = readFileSync(LANE_PATH, 'utf8');
  /** Every reason the Smithery step's target-version / upload-wording contract is broken. */
  const failures = (s: string): string[] => {
    const run = smitheryRun(s);
    const out: string[] = [];
    if (!run) return ['no Smithery step'];
    if (!/TARGET_VERSION="\$\x28jq -r \.version package\.json\x29"/.test(run)) out.push('TARGET_VERSION is not taken from package.json');
    if (/TARGET_VERSION="\$\{GITHUB_REF_NAME/.test(run)) out.push('TARGET_VERSION is derived from the ref name (it is "main" on a dispatch)');
    if (!/NPM_PUBLISH_OUTCOME/.test(run)) out.push('the step does not read what the publish step did');
    // An unconditional claim that the publish succeeded may appear ONLY inside the UPLOAD_NOTE branch.
    const claims = run.split('\n').filter((l) => /SUCCEEDED/.test(l) && !/UPLOAD_NOTE=/.test(l));
    if (claims.length) out.push(`unconditional publish claim(s): ${claims.map((l) => l.trim().slice(0, 60)).join(' | ')}`);
    return out;
  };
  it('holds on the real lane', () => expect(failures(src)).toEqual([]));
  it('DELIBERATE BREAK: reverting TARGET_VERSION to the ref name is caught', () => {
    const broken = src.replace('TARGET_VERSION="$(jq -r .version package.json)"', 'TARGET_VERSION="${GITHUB_REF_NAME#v}"');
    expect(broken).not.toBe(src);
    expect(failures(broken).join(' | ')).toMatch(/ref name/);
  });
  it('DELIBERATE BREAK: an unconditional "publish SUCCEEDED" message is caught', () => {
    const broken = src.replace('see the divergence named above. ${UPLOAD_NOTE}', 'see the divergence named above. The npm publish SUCCEEDED;');
    expect(broken).not.toBe(src);
    expect(failures(broken).join(' | ')).toMatch(/unconditional publish claim/);
  });
});

describe('the CLI path itself — main(), the entry guard and process.exitCode — run as the lane runs it', () => {
  // The pure-function tests above cannot see main(). A deleted `process.exitCode = …` or a broken
  // entry guard would leave every one of them green while the lane step exited 0 on a held version.
  // So the REAL script runs here, in a copied tree whose package.json names a version that does not
  // exist on npm, with a 1 s deadline: the honest outcome is FAIL and exit 1.
  const SCRIPT = resolve(__dirname, '..', '..', 'scripts', 'verify-npm-propagation.mjs');
  const LIB = resolve(__dirname, '..', '..', 'scripts', 'lib', 'npm-registry-read.mjs');
  const tree = (version: string) => {
    const root = mkdtempSync(join(tmpdir(), 'npm-verify-cli-'));
    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
    copyFileSync(SCRIPT, join(root, 'scripts', 'verify-npm-propagation.mjs'));
    copyFileSync(LIB, join(root, 'scripts', 'lib', 'npm-registry-read.mjs'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: PKG, version }));
    return root;
  };
  const runCli = (root: string, env: Record<string, string>) =>
    spawnSync(process.execPath, [join(root, 'scripts', 'verify-npm-propagation.mjs')], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', ...env },
      timeout: 60_000,
    });

  it('a missing deadline REFUSES: exit 1, CONFIG_INVALID on its own line, tokens last', { timeout: 60_000 }, () => {
    const root = tree('0.0.0-npm-verify-cli-canary');
    try {
      const r = runCli(root, {});
      expect(r.status).toBe(1);
      const lines = r.stdout.trim().split('\n');
      expect(lines).toContain('NPM_VERSION_REASON=CONFIG_INVALID');
      expect(lines.at(-1)).toBe('DIST_TAG_VERDICT=INDETERMINATE');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('LIVE: a version npm does not serve → FAIL and exit 1 through the real entry point', { timeout: 60_000 }, ({ skip }) => {
    const root = tree('0.0.0-npm-verify-cli-canary');
    try {
      const r = runCli(root, { NPM_PROPAGATION_DEADLINE_S: '1', NPM_PUBLISH_OUTCOME: 'success' });
      const out = r.stdout;
      if (/NPM_VERSION_PUBLISHED=INDETERMINATE/.test(out)) skip(); // registry unreachable: no verdict on the CLI
      expect(out).toContain('NPM_VERSION_PUBLISHED=FAIL');
      expect(out).toContain('NPM_VERSION_REASON=NOT_AVAILABLE_AFTER_1S');
      expect(r.status).toBe(1);
      expect(out.trim().split('\n').at(-1)).toMatch(/^DIST_TAG_VERDICT=/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

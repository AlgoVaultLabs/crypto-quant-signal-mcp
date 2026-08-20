/**
 * OPS-DEPLOY-PROVENANCE-AND-VERDICT-CLASS-W1 CH3e — GET /api/ops/build.
 *
 * The failure this route prevents is not "no sha endpoint". It is a CONFIDENT WRONG ANSWER: an
 * operator asking "is my fix live?" and being told a version, a ref name, or a stale placeholder
 * that reads like a commit. So the tests below spend most of their weight on the null paths — the
 * cases where the honest answer is "I don't know" — because those are the ones a careless
 * implementation gets wrong in the direction that costs a wave.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildProvenance, normaliseSha, normaliseBuiltAt, registerOpsBuildRoute } from '../../src/lib/ops-build-api.js';

const SHA = 'af995e5c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f60';

describe('normaliseSha — a sha or nothing', () => {
  it('accepts exactly a 40-char lowercase hex sha', () => {
    expect(normaliseSha(SHA)).toBe(SHA);
    expect(normaliseSha(`  ${SHA}  `)).toBe(SHA);
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['short sha', 'af995e5'],
    ['uppercase', SHA.toUpperCase()],
    ['too long', `${SHA}0`],
    ['not hex', 'zzz95e5c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f60'],
    ['a ref name', 'main'],
    ['a version', '1.27.0'],
    ['the word unknown', 'unknown'],
  ])('%s is null, never passed through', (_label, input) => {
    expect(normaliseSha(input as string | undefined)).toBeNull();
  });
});

describe('normaliseBuiltAt', () => {
  it('normalises a valid stamp to ISO-8601', () => {
    expect(normaliseBuiltAt('2026-08-20T03:00:00Z')).toBe('2026-08-20T03:00:00.000Z');
  });

  it('an unparseable stamp is null, not passed through', () => {
    // A consumer computing "deployed N hours ago" from garbage yields a confident wrong number.
    expect(normaliseBuiltAt('not-a-date')).toBeNull();
    expect(normaliseBuiltAt(undefined)).toBeNull();
    expect(normaliseBuiltAt('')).toBeNull();
  });
});

describe('buildProvenance', () => {
  it('an image built WITHOUT provenance reports null — the version never stands in for a sha', () => {
    const p = buildProvenance({} as NodeJS.ProcessEnv);
    expect(p.sha).toBeNull();
    expect(p.short_sha).toBeNull();
    expect(p.ref).toBeNull();
    expect(p.built_at).toBeNull();
    // version is still reported, but as itself — and it must never be mistaken for the commit.
    expect(p.version).toEqual(expect.any(String));
    expect(p.sha).not.toBe(p.version);
  });

  it('reports the baked sha when the image carries one', () => {
    const p = buildProvenance({ GIT_SHA: SHA, GIT_REF: 'main', BUILT_AT: '2026-08-20T03:00:00Z' } as NodeJS.ProcessEnv);
    expect(p.sha).toBe(SHA);
    expect(p.ref).toBe('main');
    expect(p.built_at).toBe('2026-08-20T03:00:00.000Z');
  });

  it('short_sha is DERIVED from sha, so the two can never disagree', () => {
    const p = buildProvenance({ GIT_SHA: SHA } as NodeJS.ProcessEnv);
    expect(p.short_sha).toBe(SHA.slice(0, 7));
    expect(SHA.startsWith(p.short_sha as string)).toBe(true);
  });

  it('a bogus GIT_SHA nulls BOTH sha and short_sha', () => {
    // The dangerous shape: a truthy-but-invalid value yielding a plausible 7-char prefix.
    const p = buildProvenance({ GIT_SHA: 'not-a-sha-at-all' } as NodeJS.ProcessEnv);
    expect(p.sha).toBeNull();
    expect(p.short_sha).toBeNull();
  });
});

describe('the route — auth is the same one the other internal routes use', () => {
  const OLD = { ...process.env };
  let handler: (req: unknown, res: unknown) => unknown;

  beforeEach(() => {
    handler = undefined as never;
    registerOpsBuildRoute({ get: (_p: string, h: never) => { handler = h; } } as never);
  });
  afterEach(() => { process.env = { ...OLD }; });

  const call = (headers: Record<string, string | undefined>) => {
    const out: { status?: number; body?: unknown } = {};
    const res = {
      status(c: number) { out.status = c; return this; },
      json(b: unknown) { out.body = b; return this; },
    };
    handler({ headers }, res);
    return out;
  };

  it('403 when the internal bypass is disabled', () => {
    process.env.BOT_INTERNAL_BYPASS_ENABLED = 'false';
    expect(call({}).status).toBe(403);
  });

  it('403 when the key is configured too weakly', () => {
    process.env.BOT_INTERNAL_BYPASS_ENABLED = 'true';
    process.env.ALGOVAULT_INTERNAL_BYPASS_KEY = 'short';
    expect(call({}).status).toBe(403);
  });

  it('401 on a missing or wrong key', () => {
    process.env.BOT_INTERNAL_BYPASS_ENABLED = 'true';
    process.env.ALGOVAULT_INTERNAL_BYPASS_KEY = 'x'.repeat(32);
    expect(call({}).status).toBe(401);
    expect(call({ 'x-algovault-internal-key': 'wrong' }).status).toBe(401);
  });

  it('200 with the provenance body on a valid key', () => {
    process.env.BOT_INTERNAL_BYPASS_ENABLED = 'true';
    process.env.ALGOVAULT_INTERNAL_BYPASS_KEY = 'x'.repeat(32);
    process.env.GIT_SHA = SHA;
    const r = call({ 'x-algovault-internal-key': 'x'.repeat(32) });
    expect(r.status).toBeUndefined(); // res.json() without an explicit status
    expect((r.body as { sha: string }).sha).toBe(SHA);
  });

  it('an unauthenticated caller is told nothing about the build', () => {
    // The 403/401 bodies must not leak the sha they are refusing to serve.
    process.env.BOT_INTERNAL_BYPASS_ENABLED = 'false';
    process.env.GIT_SHA = SHA;
    expect(JSON.stringify(call({}).body)).not.toContain(SHA);
  });
});

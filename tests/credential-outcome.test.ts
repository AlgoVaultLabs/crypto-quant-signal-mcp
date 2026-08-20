/**
 * AUTH-THREE-STATE-W1 CH1 — the credential-outcome primitive.
 *
 * WHAT THIS PINS. Four distinct realities used to produce one byte-identical
 * `{ tier: 'free', key: null }`: nothing presented, an unknown `av_free_` key, a key Stripe says
 * does not exist, and a key we could not ask about. Measured live 2026-08-18, all four returned the
 * same verdict on the same shared `free:<ipHash>` bucket, three calls apart — so a paying customer
 * with a typo'd key was served the anonymous free tier with HTTP 200 and no way to tell.
 *
 * The two cases named explicitly below are the ones that decide whether the wave is safe to ship
 * default-ON: the REGRESSION case (a well-formed unknown key must be distinguishable, so it can be
 * refused) and the COMPAT case (an unexpanded `${env:AV_API_KEY}` must NOT be, so every documented
 * client config keeps working).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Same seams as tests/security-fix-tier-escalation.test.ts: Stripe returns invalid by default
// (configurable per-test) and x402 is unconfigured, so resolveLicense flows straight to the
// API-key path.
vi.mock('../src/lib/stripe.js', () => ({ validateApiKey: vi.fn() }));
vi.mock('../src/lib/x402.js', () => ({
  isX402Configured: () => false,
  verifyX402Payment: async () => ({ valid: false }),
  paymentMatchesToolRoute: () => false,
  classifyToolRouteMismatch: () => 'cross_tool',
}));
vi.mock('../src/lib/free-keys-store.js', () => ({
  FREE_KEY_PREFIX: 'av_free_',
  lookupFreeKey: vi.fn(),
  lookupFreeKeyCached: vi.fn(),
}));

import {
  AV_KEY_SHAPE,
  classifyCredential,
  credentialOutcomeOf,
  credentialResolutionOf,
  isPresented,
  isRetryable,
  type CredentialOutcome,
} from '../src/lib/credential-outcome.js';
import { resolveLicense, resolveLicenseSync } from '../src/lib/license.js';
import { validateApiKey } from '../src/lib/stripe.js';
import { lookupFreeKey, lookupFreeKeyCached } from '../src/lib/free-keys-store.js';

const mockValidate = vi.mocked(validateApiKey);
const mockFreeKey = vi.mocked(lookupFreeKey);
const mockFreeKeyCached = vi.mocked(lookupFreeKeyCached);

const HEX24 = '0'.repeat(24);
/** The exact credential from the live probe that motivated this wave. */
const UNKNOWN_LIVE_KEY = `av_live_${HEX24}`;
/** The literal string four documented MCP client configs emit when the env var is not expanded. */
const UNEXPANDED_ENV = '${env:AV_API_KEY}';

const ALL_OUTCOMES: CredentialOutcome[] = ['ABSENT', 'MALFORMED', 'UNKNOWN', 'INDETERMINATE', 'RESOLVED'];

beforeEach(() => {
  mockValidate.mockReset();
  mockValidate.mockResolvedValue({ valid: false }); // Stripe-invalid by default
  mockFreeKey.mockReset();
  mockFreeKey.mockResolvedValue(null);
  mockFreeKeyCached.mockReset();
  mockFreeKeyCached.mockReturnValue(null);
  delete process.env.ALLOW_DEV_KEY_PREFIX;
  delete process.env.CQS_API_KEY; // else extractApiKey prefers env over the header
  delete process.env.BOT_INTERNAL_BYPASS_ENABLED;
});

const resolve1 = async (authorization: string) => (await resolveLicense({ authorization })).license;

// ── 1. classifyCredential truth table ────────────────────────────────────────

describe('classifyCredential — shape only, no I/O', () => {
  it.each([null, undefined, '', '   ', '\t\n'])('%j → ABSENT', (raw) => {
    expect(classifyCredential(raw as string | null)).toBe('ABSENT');
  });

  it.each([
    UNEXPANDED_ENV,
    '${AV_API_KEY}',
    'av_live_ZZZ',
    'av_live_000',            // right prefix, too short
    `av_live_${'0'.repeat(23)}`, // one hex short — the off-by-one
    `av_live_${'0'.repeat(25)}`, // one hex long
    `av_live_${'A'.repeat(24)}`, // uppercase hex — both generators emit lowercase
    'randomjunk',
    'ent_forged',
    'av_starter_x',
    `av_pro_${HEX24}`,        // a prefix we never mint
  ])('%j → MALFORMED', (raw) => {
    expect(classifyCredential(raw)).toBe('MALFORMED');
  });

  it.each([UNKNOWN_LIVE_KEY, `av_free_${'a'.repeat(24)}`, `av_live_${'0123456789abcdef01234567'}`])(
    '%j → WELL_FORMED',
    (raw) => {
      expect(classifyCredential(raw)).toBe('WELL_FORMED');
    },
  );

  it('trims before classifying — a padded header still resolves its real shape', () => {
    expect(classifyCredential(`  ${UNKNOWN_LIVE_KEY}  `)).toBe('WELL_FORMED');
  });

  it('AV_KEY_SHAPE carries no /g flag, so .test() is not stateful across calls', () => {
    // A shared module-level /g regex advances lastIndex and returns false on every other call —
    // which would make key validation pass and fail alternately for identical input.
    expect(AV_KEY_SHAPE.global).toBe(false);
    expect(AV_KEY_SHAPE.test(UNKNOWN_LIVE_KEY)).toBe(true);
    expect(AV_KEY_SHAPE.test(UNKNOWN_LIVE_KEY)).toBe(true);
  });
});

// ── 2. THE REGRESSION CASE ───────────────────────────────────────────────────

describe('THE REGRESSION CASE — a well-formed unknown key is UNKNOWN, not ABSENT and not MALFORMED', () => {
  it(`${UNKNOWN_LIVE_KEY} classifies WELL_FORMED and resolves UNKNOWN`, async () => {
    expect(classifyCredential(UNKNOWN_LIVE_KEY)).toBe('WELL_FORMED');
    const license = await resolve1(`Bearer ${UNKNOWN_LIVE_KEY}`);
    expect(license.outcome).toBe('UNKNOWN');
    expect(license.outcome).not.toBe('ABSENT');
    expect(license.outcome).not.toBe('MALFORMED');
    // Tier and key are UNCHANGED from before this wave — CH1 relabels, it does not re-route.
    expect(license.tier).toBe('free');
    expect(license.key).toBeNull();
    // Settled, so a retry is pure waste. This is what separates it from INDETERMINATE.
    expect(isRetryable(license.outcome!)).toBe(false);
  });

  it('an UNKNOWN key is distinguishable from NO key — the collapse this wave ends', async () => {
    const unknown = await resolve1(`Bearer ${UNKNOWN_LIVE_KEY}`);
    const absent = (await resolveLicense({})).license;
    // Before CH1 these two objects were byte-identical.
    expect(unknown.tier).toBe(absent.tier);
    expect(unknown.key).toBe(absent.key);
    expect(unknown.outcome).not.toBe(absent.outcome);
    expect(absent.outcome).toBe('ABSENT');
  });

  it('a well-formed unknown av_free_ key is UNKNOWN too — the free lane is not exempt', async () => {
    const license = await resolve1(`Bearer av_free_${'a'.repeat(24)}`);
    expect(license.outcome).toBe('UNKNOWN');
    expect(mockFreeKey).toHaveBeenCalledTimes(1); // it really consulted the store
  });

  it('a KNOWN free key is RESOLVED and keeps its bucket alias', async () => {
    mockFreeKey.mockResolvedValue({ api_key: 'k', email: null, ref_code: null, bucket_key: 'free:v2:abc' });
    const license = await resolve1(`Bearer av_free_${'a'.repeat(24)}`);
    expect(license.outcome).toBe('RESOLVED');
    expect(license.bucketKey).toBe('free:v2:abc');
  });
});

// ── 3. THE COMPAT CASE ───────────────────────────────────────────────────────

describe('THE COMPAT CASE — an unexpanded env var is MALFORMED and always served', () => {
  it(`${UNEXPANDED_ENV} resolves MALFORMED on the free tier`, async () => {
    const license = await resolve1(`Bearer ${UNEXPANDED_ENV}`);
    expect(license.outcome).toBe('MALFORMED');
    expect(license.tier).toBe('free');
  });

  it('every literal our own MCP client configs can emit is MALFORMED, never UNKNOWN', async () => {
    // src/lib/integrations-data/mcp-clients.ts:75,104,133,171 — Claude Desktop, Cursor, Cline,
    // Claude Code. Our own troubleshooting docs list non-interpolation as a top failure mode
    // (docs/integrations/mcp-clients/cursor.md:34), so this lane is real traffic, not a hypothesis.
    for (const raw of ['${env:AV_API_KEY}', '${AV_API_KEY}']) {
      const license = await resolve1(`Bearer ${raw}`);
      expect(license.outcome, `${raw} must never be refusable`).toBe('MALFORMED');
    }
  });
});

// ── 4. retryable is a PROJECTION of outcome ──────────────────────────────────

describe('retryable follows outcome and nothing else', () => {
  it('INDETERMINATE is retryable; every other outcome is not', () => {
    for (const o of ALL_OUTCOMES) {
      expect(isRetryable(o), o).toBe(o === 'INDETERMINATE');
    }
  });

  it('ABSENT is the only outcome that means "nothing was presented"', () => {
    for (const o of ALL_OUTCOMES) {
      expect(isPresented(o), o).toBe(o !== 'ABSENT');
    }
  });

  it('a stamped license never contradicts the projection (single-derivation pin)', async () => {
    mockValidate.mockResolvedValue({ valid: false, indeterminate: true });
    const cases = [
      (await resolveLicense({})).license,
      await resolve1(`Bearer ${UNEXPANDED_ENV}`),
      await resolve1(`Bearer ${UNKNOWN_LIVE_KEY}`),
    ];
    for (const license of cases) {
      const expected = isRetryable(license.outcome!);
      // `retryable` is optional, so falsy-vs-false is the honest comparison for the negative case.
      expect(Boolean(license.retryable), `retryable must equal isRetryable(${license.outcome})`).toBe(expected);
    }
  });
});

// ── 4b. THE STRIPE-OUTAGE COMPAT CASE ────────────────────────────────────────

describe('Stripe outage — the shape branch that makes default-ON refusal safe', () => {
  beforeEach(() => {
    // `validateApiKey` answers indeterminate when Stripe is UNREACHABLE *and* when it is merely
    // UNCONFIGURED (stripe.ts:300), so this covers every environment without STRIPE_SECRET_KEY.
    mockValidate.mockResolvedValue({ valid: false, indeterminate: true });
  });

  it('a MALFORMED credential is served even while Stripe is down', async () => {
    const license = await resolve1(`Bearer ${UNEXPANDED_ENV}`);
    // Shape is knowable WITHOUT Stripe, so its health is irrelevant to this verdict. Without this
    // branch every documented client config would be refused during any Stripe blip.
    expect(license.outcome).toBe('MALFORMED');
    expect(license.tier).toBe('free');
    expect(Boolean(license.retryable)).toBe(false);
  });

  it('a WELL-FORMED credential is INDETERMINATE and retryable, with key identity preserved', async () => {
    const license = await resolve1(`Bearer ${UNKNOWN_LIVE_KEY}`);
    expect(license.outcome).toBe('INDETERMINATE');
    expect(license.retryable).toBe(true);
    // OPS-ZERO-VS-UNKNOWN-W1's key-identity policy survives verbatim: the caller is metered on
    // their own bucket, never the anonymous one.
    expect(license.key).toBe(UNKNOWN_LIVE_KEY);
    expect(license.indeterminate).toBe(true);
  });

  it('the two are decided in ONE call each, so the branch cannot be dropped silently', async () => {
    const malformed = await resolve1(`Bearer ${UNEXPANDED_ENV}`);
    const wellFormed = await resolve1(`Bearer ${UNKNOWN_LIVE_KEY}`);
    expect([malformed.outcome, wellFormed.outcome]).toEqual(['MALFORMED', 'INDETERMINATE']);
  });
});

// ── 4c. Shape NEVER gates the lookup ─────────────────────────────────────────

describe('shape classification never short-circuits the existence lookup', () => {
  it('a Stripe-VALID key that fails AV_KEY_SHAPE still resolves its real tier', async () => {
    // `av_live_realcustomer` is not 24 hex. tests/security-fix-tier-escalation.test.ts:82-87 has
    // pinned this since that wave: a real customer whose key predates the current generator must
    // not be denied. Any implementation that skips validateApiKey on a malformed-looking key
    // turns this red.
    expect(classifyCredential('av_live_realcustomer')).toBe('MALFORMED');
    mockValidate.mockResolvedValue({ valid: true, tier: 'pro' });
    const license = await resolve1('Bearer av_live_realcustomer');
    expect(license.tier).toBe('pro');
    expect(license.key).toBe('av_live_realcustomer');
    expect(license.outcome).toBe('RESOLVED');
  });

  it('the lookup is actually performed for a malformed-looking key', async () => {
    await resolve1('Bearer ent_forged');
    expect(mockValidate).toHaveBeenCalledWith('ent_forged');
  });
});

// ── The sync (stdio) path ────────────────────────────────────────────────────

describe('resolveLicenseSync — stdio path stamps outcomes without changing behaviour', () => {
  it('no credential → ABSENT', () => {
    const license = resolveLicenseSync({});
    expect(license.outcome).toBe('ABSENT');
    expect(license.tier).toBe('free');
  });

  it('prefix tiering is untouched and reads RESOLVED', () => {
    const license = resolveLicenseSync({ authorization: 'Bearer ent_x' });
    expect(license.tier).toBe('enterprise');
    expect(license.outcome).toBe('RESOLVED');
  });

  it('a free-key CACHE miss is INDETERMINATE, not UNKNOWN — this path never asks the store', () => {
    // Cache-only BY DESIGN (the durable lookup is the async HTTP path that warms it), so a miss
    // is the absence of an answer, not evidence of non-existence. Calling it UNKNOWN would assert
    // a fact we did not establish — the exact error this wave exists to stop.
    const license = resolveLicenseSync({ authorization: `Bearer av_free_${'a'.repeat(24)}` });
    expect(license.outcome).toBe('INDETERMINATE');
    expect(license.key).toBeNull(); // documented stdio behaviour, unchanged
  });
});

// ── credentialOutcomeOf — the fallback must never refuse ─────────────────────

describe('credentialOutcomeOf — an unstamped license degrades to a SERVING outcome', () => {
  it('reads the stamp when present', () => {
    expect(credentialOutcomeOf({ key: null, outcome: 'UNKNOWN' })).toBe('UNKNOWN');
  });

  it('an unstamped license can never produce a refusing outcome', () => {
    // Refusing because WE lost track of our own bookkeeping would be refusing without evidence —
    // the mirror image of serving without evidence, which is the defect under repair.
    for (const key of [null, 'av_live_whatever']) {
      const outcome = credentialOutcomeOf({ key, outcome: undefined });
      expect(['ABSENT', 'RESOLVED']).toContain(outcome);
      expect(outcome).not.toBe('UNKNOWN');
      expect(outcome).not.toBe('INDETERMINATE');
    }
  });

  it('credentialResolutionOf projects every field from the one outcome', async () => {
    const license = await resolve1(`Bearer ${UNKNOWN_LIVE_KEY}`);
    const r = credentialResolutionOf(license);
    expect(r).toEqual({
      outcome: 'UNKNOWN',
      tier: 'free',
      key: null,
      presented: true,
      retryable: false,
    });
  });
});

// ── 5. Source-level: ONE key-shape literal ───────────────────────────────────

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) tsFiles(p, acc);
    else if (p.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

describe('AV_KEY_SHAPE is the ONLY key-shape regex literal in src/', () => {
  // The pattern is assembled from fragments so this assertion is not itself a second copy of the
  // literal it is counting.
  const NEEDLE = ['av_(live|free)_', '[a-f0-9]', '{24}'].join('');

  it('appears exactly once across src/**/*.ts (comments stripped)', () => {
    const hits = tsFiles(join(ROOT, 'src'))
      .filter((f) => stripComments(readFileSync(f, 'utf8')).includes(NEEDLE))
      .map((f) => f.slice(ROOT.length + 1));
    expect(hits).toEqual(['src/lib/credential-outcome.ts']);
  });

  it('the corpus is non-empty — a walker that found nothing would pass vacuously', () => {
    expect(tsFiles(join(ROOT, 'src')).length).toBeGreaterThan(50);
  });

  it('raw count is 1 too, so the CH1 gate and this test cannot disagree', () => {
    // The chapter gate greps the RAW text. If a future docblock quotes the pattern, the gate goes
    // red while a comment-stripped test stays green — two instruments, one question, different
    // answers. Asserting both keeps them bound together.
    const raw = tsFiles(join(ROOT, 'src')).filter((f) => readFileSync(f, 'utf8').includes(NEEDLE));
    expect(raw.map((f) => f.slice(ROOT.length + 1))).toEqual(['src/lib/credential-outcome.ts']);
  });
});

// ── The two outcome vocabularies must not drift ──────────────────────────────

describe('types.ts LicenseInfo.outcome and CredentialOutcome name the same set', () => {
  it('every CredentialOutcome member appears in the types.ts union', () => {
    // types.ts re-declares the union rather than importing it, to keep types.ts free of any
    // dependency on lib/. That is a deliberate duplication, so it needs a binding assertion.
    const src = readFileSync(join(ROOT, 'src/types.ts'), 'utf8');
    const decl = src.slice(src.indexOf('outcome?:'));
    const union = decl.slice(0, decl.indexOf(';'));
    for (const o of ALL_OUTCOMES) expect(union, `types.ts union is missing ${o}`).toContain(`'${o}'`);
    expect(union.match(/'[A-Z_]+'/g)).toHaveLength(ALL_OUTCOMES.length);
  });
});

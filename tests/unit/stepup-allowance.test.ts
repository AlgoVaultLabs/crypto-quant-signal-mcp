/**
 * GROWTH-AGENT-SIGNIN-STEPUP-W1-V2 CH2 R2.8 — the anonymous allowance, end to end.
 *
 * ONE allowance for callers with no email-bound identity (R-1/R-2), read by the meter, the public
 * plans body and the wall copy; three modes (R2.2); shadow telemetry (R2.5). Every assertion here is
 * on what a CALLER receives — the meter's decision, the served body, the rendered notice — never on a
 * helper called in isolation, because a helper tested alone cannot prove anything calls it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const funnel = vi.hoisted(() => [] as Array<{ eventType: string; sessionId?: string | null; meta?: Record<string, unknown> | null }>);
vi.mock('../../src/lib/performance-db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/performance-db.js')>();
  return { ...actual, recordFunnelEvent: (e: (typeof funnel)[number]) => { funnel.push(e); } };
});
const freeRows = vi.hoisted(() => new Map<string, { api_key: string; email: string | null; ref_code: null; bucket_key: string | null }>());
vi.mock('../../src/lib/free-keys-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/free-keys-store.js')>();
  return { ...actual, lookupFreeKey: async (k: string) => freeRows.get(k) ?? null };
});

import {
  FREE_MONTHLY_CALLS,
  FREE_DAILY_CALLS,
  FREE_KEYLESS_MONTHLY_CALLS_RULED,
  effectiveKeylessMonthlyCalls,
  freeKeylessCallsLabel,
  resolveStepupMode,
} from '../../src/lib/plans.js';
import { buildPublicPlansBody } from '../../src/lib/plans-public-api.js';
import { checkQuota, trackCall, resolveLicense, resolveLicenseSync, requestContext, _resetCallTrackersForTest } from '../../src/lib/license.js';
import { buildQuotaNoticeMessage } from '../../src/lib/quota-notice.js';
import type { LicenseInfo } from '../../src/types.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Fixture keys follow the secret-scan rule: at most four distinct hex digits.
const EPH_KEY = 'av_free_' + 'a1'.repeat(12);
const EMAIL_KEY = 'av_free_' + 'b2'.repeat(12);
const UNKNOWN_KEY = 'av_free_' + 'c3'.repeat(12);
const BUCKET = 'free:v2:a1a1b2b2a1a1b2b2';

const anonymousLicense: LicenseInfo = { tier: 'free', key: null, outcome: 'ABSENT', anonymous: true };
const malformedLicense: LicenseInfo = { tier: 'free', key: null, outcome: 'MALFORMED', anonymous: true };
const ephemeralLicense: LicenseInfo = { tier: 'free', key: EPH_KEY, bucketKey: BUCKET, outcome: 'RESOLVED', anonymous: true };
const emailLicense: LicenseInfo = { tier: 'free', key: EMAIL_KEY, outcome: 'RESOLVED' };
const promotedLicense: LicenseInfo = { tier: 'free', key: EMAIL_KEY, bucketKey: BUCKET, outcome: 'RESOLVED' };
const paidLicense: LicenseInfo = { tier: 'starter', key: 'av_live_' + 'd4'.repeat(12), outcome: 'RESOLVED' };

/** Charge `n` calls, then report what the NEXT call is told. */
function chargeThenCheck(license: LicenseInfo, n: number) {
  for (let i = 0; i < n; i++) trackCall(license);
  return checkQuota(license);
}

beforeEach(() => {
  _resetCallTrackersForTest();
  funnel.length = 0;
  freeRows.clear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('R2.2 — one mode resolver', () => {
  it.each([
    [undefined, 'off'], ['', 'off'], ['off', 'off'], ['shadow', 'shadow'], ['live', 'live'],
    [' Live ', 'live'], ['SHADOW', 'shadow'], ['wall', 'off'], ['livee', 'off'], ['1', 'off'],
  ])('STEPUP_MODE=%j → %s (unknown, incl. the deferred wave\'s `wall`, is off)', (raw, want) => {
    expect(resolveStepupMode(raw === undefined ? {} : { STEPUP_MODE: raw })).toBe(want);
  });

  it('the long-lived server prints ONE boot line with the resolved mode (the Build Rule 6 read-back)', () => {
    const src = readFileSync(resolve(ROOT, 'src/index.ts'), 'utf8');
    const listen = src.slice(src.indexOf('const httpServer = app.listen(port, () => {'));
    expect(listen.indexOf('console.log(`[stepup] mode=${resolveStepupMode()} n=${freeKeylessCallsLabel()}`);')).toBeGreaterThan(0);
    expect(src.split('[stepup] mode=').length - 1).toBe(1);
  });
});

describe('R2.1 — the SoT and the public body', () => {
  it('N is the pre-registered CH1 value and applies only in live', () => {
    expect(FREE_KEYLESS_MONTHLY_CALLS_RULED).toBe(20);
    expect(freeKeylessCallsLabel()).toBe('20');
    expect(effectiveKeylessMonthlyCalls('off')).toBe(FREE_MONTHLY_CALLS);
    expect(effectiveKeylessMonthlyCalls('shadow')).toBe(FREE_MONTHLY_CALLS);
    expect(effectiveKeylessMonthlyCalls('live')).toBe(20);
  });

  it.each([[undefined, 200], ['off', 200], ['shadow', 200], ['live', 20]])(
    'STEPUP_MODE=%j → free.keyless.monthly_calls = %d, every existing figure unmoved',
    (mode, want) => {
      if (mode !== undefined) vi.stubEnv('STEPUP_MODE', mode);
      else vi.stubEnv('STEPUP_MODE', '');
      const free = buildPublicPlansBody(new Date('2026-10-12T00:00:00Z')).free as unknown as Record<string, unknown>;
      expect(Object.keys(free).sort()).toEqual(['daily_calls', 'keyless', 'monthly_calls', 'telegram']);
      expect(free.keyless).toEqual({ monthly_calls: want });
      expect(free.monthly_calls).toBe(200);
      expect(free.daily_calls).toBe(100);
      expect(free.telegram).toEqual({ monthly_alerts: 100, daily_alerts: 100 });
    },
  );
});

describe('R2.3 — the meter: the allowance follows the caller, the counter does not move', () => {
  const ANON = [['no credential', anonymousLicense], ['MALFORMED', malformedLicense], ['ephemeral key', ephemeralLicense]] as const;

  it.each(ANON)('%s in live: refused at N = 20 on BOTH meters (monthly 20, daily min(20, 100))', (_l, license) => {
    vi.stubEnv('STEPUP_MODE', 'live');
    const atN = chargeThenCheck(license, 19);
    expect(atN.allowed).toBe(true);
    trackCall(license);
    const past = checkQuota(license);
    expect(past.allowed).toBe(false);
    expect(past.total).toBe(20);
  });

  it.each(ANON)('%s in off and shadow: byte-identical to an email key (200 / 100)', (_l, license) => {
    for (const mode of ['', 'off', 'shadow']) {
      _resetCallTrackersForTest();
      vi.stubEnv('STEPUP_MODE', mode);
      const q = chargeThenCheck(license, 25);
      expect(q.allowed).toBe(true);
      expect(q.total).toBe(FREE_MONTHLY_CALLS);
      expect(q.daily_total).toBe(FREE_DAILY_CALLS);
    }
  });

  it.each([
    ['an email-bound key', emailLicense],
    ['a promoted key (keeps the bucket it owns)', promotedLicense],
  ])('%s keeps 200 / 100 even in live', (_l, license) => {
    vi.stubEnv('STEPUP_MODE', 'live');
    const q = chargeThenCheck(license, 25);
    expect(q.allowed).toBe(true);
    expect(q.total).toBe(FREE_MONTHLY_CALLS);
    expect(q.daily_total).toBe(FREE_DAILY_CALLS);
  });

  it('a paid key, x402 and the internal bypass are untouched in live', () => {
    vi.stubEnv('STEPUP_MODE', 'live');
    expect(chargeThenCheck(paidLicense, 25).total).toBe(chargeThenCheck({ ...paidLicense, key: 'av_live_' + 'e5'.repeat(12) }, 0).total);
    expect(chargeThenCheck(paidLicense, 0).total).toBeGreaterThan(200);
    expect(checkQuota({ tier: 'x402', key: null, outcome: 'RESOLVED' }).allowed).toBe(true);
    expect(checkQuota({ tier: 'internal', key: null, outcome: 'RESOLVED' }).allowed).toBe(true);
  });

  it('the anonymous counter is the same row as before: an ephemeral key and a keyless caller on its bucket share it', () => {
    vi.stubEnv('STEPUP_MODE', 'live');
    requestContext.run({ license: anonymousLicense, ipHash: 'v2:a1a1b2b2a1a1b2b2' } as never, () => {
      for (let i = 0; i < 15; i++) trackCall(anonymousLicense);
    });
    for (let i = 0; i < 5; i++) trackCall(ephemeralLicense);
    expect(checkQuota(ephemeralLicense).allowed).toBe(false);
  });
});

describe('R2.3 — anonymity is stamped on the ASYNC path only, from the row already read', () => {
  it('no credential → anonymous', async () => {
    const { license } = await resolveLicense({});
    expect(license).toMatchObject({ outcome: 'ABSENT', anonymous: true });
  });

  it('a MALFORMED bearer → anonymous', async () => {
    const { license } = await resolveLicense({ authorization: 'Bearer not-a-key-we-issued' });
    expect(license.outcome).toBe('MALFORMED');
    expect(license.anonymous).toBe(true);
  });

  it('an email-less (ephemeral) key → anonymous, bucket kept', async () => {
    freeRows.set(EPH_KEY, { api_key: EPH_KEY, email: null, ref_code: null, bucket_key: BUCKET });
    const { license } = await resolveLicense({ authorization: `Bearer ${EPH_KEY}` });
    expect(license).toMatchObject({ outcome: 'RESOLVED', key: EPH_KEY, bucketKey: BUCKET, anonymous: true });
  });

  it('an email-bound key → NOT anonymous', async () => {
    freeRows.set(EMAIL_KEY, { api_key: EMAIL_KEY, email: 'person@example.com', ref_code: null, bucket_key: null });
    const { license } = await resolveLicense({ authorization: `Bearer ${EMAIL_KEY}` });
    expect(license.outcome).toBe('RESOLVED');
    expect(license.anonymous).toBeUndefined();
  });

  it('a well-formed key that does not resolve (UNKNOWN, refused) → NOT anonymous', async () => {
    const { license } = await resolveLicense({ authorization: `Bearer ${UNKNOWN_KEY}` });
    expect(license.outcome).toBe('UNKNOWN');
    expect(license.anonymous).toBeUndefined();
  });

  it('the sync (stdio) path never stamps it — a local operator keeps the tier allowance', () => {
    expect(resolveLicenseSync({}).anonymous).toBeUndefined();
  });
});

describe('R2.5 — shadow telemetry: who the move to N would ask', () => {
  const ctx = { license: anonymousLicense, sessionId: 'v2:a1a1b2b2a1a1b2b2', ipHash: 'v2:a1a1b2b2a1a1b2b2', userAgent: 'python-requests/2.31.0' };
  const run = (fn: () => void) => requestContext.run(ctx as never, fn);
  const stepup = () => funnel.filter((e) => e.eventType.startsWith('stepup_'));

  it('shadow: an anonymous meter at N records ONE stepup_would_gate per bucket per day, and the call is still served', () => {
    vi.stubEnv('STEPUP_MODE', 'shadow');
    run(() => {
      for (let i = 0; i < 25; i++) { expect(checkQuota(anonymousLicense).allowed).toBe(true); trackCall(anonymousLicense); }
    });
    expect(stepup()).toHaveLength(1);
    expect(stepup()[0]).toMatchObject({
      eventType: 'stepup_would_gate',
      sessionId: 'v2:a1a1b2b2a1a1b2b2',
      meta: { client_family: 'python-requests', bucket: 'free:v2:a1a1b2b2a1a1b2b2', used: 20, n: 20 },
    });
  });

  it('live: the same moment is stepup_gated (and the call is refused)', () => {
    vi.stubEnv('STEPUP_MODE', 'live');
    run(() => {
      for (let i = 0; i < 20; i++) trackCall(anonymousLicense);
      expect(checkQuota(anonymousLicense).allowed).toBe(false);
      checkQuota(anonymousLicense);
    });
    expect(stepup().map((e) => e.eventType)).toEqual(['stepup_gated']);
  });

  it('off records nothing; an email-bound caller never records', () => {
    vi.stubEnv('STEPUP_MODE', 'off');
    run(() => { for (let i = 0; i < 25; i++) { checkQuota(anonymousLicense); trackCall(anonymousLicense); } });
    vi.stubEnv('STEPUP_MODE', 'shadow');
    run(() => { for (let i = 0; i < 25; i++) { checkQuota(emailLicense); trackCall(emailLicense); } });
    expect(stepup()).toHaveLength(0);
  });

  it('a tracker that would be a raw key is never written as the bucket', () => {
    vi.stubEnv('STEPUP_MODE', 'shadow');
    const rawEph: LicenseInfo = { tier: 'free', key: EPH_KEY, outcome: 'RESOLVED', anonymous: true };
    run(() => { for (let i = 0; i < 21; i++) { checkQuota(rawEph); trackCall(rawEph); } });
    expect(stepup()).toHaveLength(1);
    expect(stepup()[0].meta?.bucket).toBeNull();
    expect(JSON.stringify(stepup()[0])).not.toContain(EPH_KEY);
  });
});

describe('R2.4 — §Copy E only in live; off and shadow byte-identical', () => {
  const ctx = { meter: 'calls' as const, used: 200, limit: 200, resetAtMs: Date.parse('2026-11-01T00:00:00Z'), nowMs: Date.parse('2026-10-12T00:00:00Z'), referralCode: null };
  const CLAIM = 'Claim a free key — one call, no email. Your usage carries over, so nothing resets. → https://api.algovault.com/api/start-free';
  const COPY_E = 'Sign in free for your own 200 calls a month — one tap, no card → https://api.algovault.com/welcome?src=quota_wall';

  it('off and shadow render the claim CTA, identically', () => {
    vi.stubEnv('STEPUP_MODE', 'off');
    const off = buildQuotaNoticeMessage(ctx);
    vi.stubEnv('STEPUP_MODE', 'shadow');
    const shadow = buildQuotaNoticeMessage(ctx);
    expect(off).toBe(shadow);
    expect(off).toContain(CLAIM);
    expect(off).not.toContain('Sign in free');
  });

  it('live renders §Copy E verbatim instead', () => {
    vi.stubEnv('STEPUP_MODE', 'live');
    const live = buildQuotaNoticeMessage(ctx);
    expect(live).toContain(`Keep going free: refer a friend — you both get`);
    expect(live).toContain(COPY_E);
    expect(live).not.toContain('Claim a free key');
  });

  it('a caller with a referral code keeps the referral arm in every mode', () => {
    vi.stubEnv('STEPUP_MODE', 'live');
    expect(buildQuotaNoticeMessage({ ...ctx, referralCode: 'ABC123' })).not.toContain('Sign in free');
  });
});

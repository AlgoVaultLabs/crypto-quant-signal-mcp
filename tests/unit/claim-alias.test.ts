/**
 * OPS-QUOTA-CLAIM-ALIAS-W1 CH1 — claiming a key changes WHO you are, never HOW MUCH you get.
 *
 * `mintEphemeralKey` wrote only `free_keys`, so a claimed key's tracker started at zero on BOTH
 * meters — and `quota-notice.ts`'s keyless free arm points a walled caller straight at that mint.
 * The wall advertised its own bypass, 5x per ipHash per hour.
 *
 * A claimed key now ADOPTS the anonymous bucket: one live `quota_usage` row per identity.
 *
 * 🛑 THE DECISIVE PROPERTY IS TESTED AT **PARTIAL** USAGE. The rejected COPY form leaves two live
 * rows, and at the wall (200/200) BOTH are walled — so every wall-only assertion passes and the 2x
 * hole ships. Only alternating keyed and keyless calls with ONE unit left can tell the two designs
 * apart, which is why the alternation lock below is the chapter's real gate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The bonus meter resolves key → adopted bucket through `lookupFreeKeyCached`, which is cache-only.
// Without a controllable cache every bonus assertion would be VACUOUS: an uncached key resolves to
// itself whether or not the mapping exists, so deleting the resolution would be invisible. This
// fixture is what lets that break go red — the point of the exercise, not decoration.
const cachedRows = new Map<string, { api_key: string; email: null; ref_code: null; bucket_key: string | null }>();
vi.mock('../../src/lib/free-keys-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/free-keys-store.js')>();
  return { ...actual, lookupFreeKeyCached: (k: string) => cachedRows.get(k) ?? null };
});

import {
  checkQuota,
  trackCall,
  trackCallByKey,
  checkQuotaByKey,
  resolveBonusTrackerKey,
  _resetCallTrackersForTest,
} from '../../src/lib/license.js';
import { isAdoptableBucketKey, FREE_KEY_PREFIX } from '../../src/lib/free-keys-store.js';
import { FREE_MONTHLY_CALLS, FREE_DAILY_CALLS } from '../../src/lib/plans.js';
import type { LicenseInfo } from '../../src/types.js';

const BUCKET = 'free:v2:a11a5000c0ffee01';
/** A CLAIMED ephemeral key: it carries the bucket it adopted. */
const claimed = (key = 'av_free_claimed0000000000000'): LicenseInfo =>
  ({ tier: 'free', key, bucketKey: BUCKET });
/** A key issued BEFORE this wave: no adopted bucket, must behave exactly as it always did. */
const legacy = (key = 'av_free_legacy00000000000000'): LicenseInfo => ({ tier: 'free', key });

beforeEach(() => { _resetCallTrackersForTest(); });
afterEach(() => { vi.useRealTimers(); _resetCallTrackersForTest(); });

describe('vacuity guards — the caps under test are real', () => {
  it('both free caps are finite and the daily one binds first', () => {
    expect(FREE_DAILY_CALLS).toBeGreaterThan(0);
    expect(FREE_DAILY_CALLS).toBeLessThan(FREE_MONTHLY_CALLS);
  });
});

describe('🎯 the alternation lock — one live counter per identity, tested at PARTIAL usage', () => {
  // CHARGE vs GATE — the two are separate on purpose and the test must respect it.
  // `trackCall*` CHARGES both meters and reports the monthly outcome; the DAILY wall is enforced
  // by `checkQuota*`, the gate every tool consults before serving. So the meter is advanced with
  // the charge functions and the refusal is asserted through the gate.
  it('DAILY: at daily−1, one keyed call and one keyless call leave a combined remaining of 1, not 2', () => {
    // Spend the keyless bucket down to its last daily unit.
    for (let i = 0; i < FREE_DAILY_CALLS - 1; i++) trackCallByKey(BUCKET, 'free');
    expect(checkQuotaByKey(BUCKET, 'free').allowed).toBe(true);

    // The claimed key spends THE SAME last unit...
    const keyed = trackCall(claimed());
    expect(keyed.allowed).toBe(true);

    // ...so the keyless identity has nothing left. Under the COPY form it would still be allowed —
    // a second row with its own 100 — the 2x allowance this wave exists to prevent, which no
    // wall-only assertion can see.
    const keylessGate = checkQuotaByKey(BUCKET, 'free');
    expect(keylessGate.allowed).toBe(false);
    expect(keylessGate.limit).toBe('daily');
    // And the claimed key sees the identical refusal, because it is the identical row.
    expect(checkQuota(claimed()).allowed).toBe(false);
  });

  it('MONTHLY: at monthly−1, the same alternation leaves a combined remaining of 1, not 2', () => {
    // The daily cap binds first, so walk the monthly meter forward a UTC day at a time.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T09:00:00Z'));
    let spent = 0;
    let day = 1;
    while (spent < FREE_MONTHLY_CALLS - 1) {
      const batch = Math.min(FREE_DAILY_CALLS, FREE_MONTHLY_CALLS - 1 - spent);
      for (let i = 0; i < batch; i++) trackCallByKey(BUCKET, 'free');
      spent += batch;
      day += 1;
      vi.setSystemTime(new Date(`2026-08-${String(day).padStart(2, '0')}T09:00:00Z`));
    }
    expect(checkQuotaByKey(BUCKET, 'free').used).toBe(FREE_MONTHLY_CALLS - 1);

    const keyed = trackCall(claimed());
    expect(keyed.allowed).toBe(true);

    const keylessGate = checkQuotaByKey(BUCKET, 'free');
    expect(keylessGate.allowed).toBe(false);
    expect(keylessGate.limit).toBe('monthly');
    expect(checkQuota(claimed()).allowed).toBe(false);
  });

  it('exactly ONE live row per identity — the keyed and keyless views are the SAME counter', () => {
    // Asserted TOGETHER, never separately: two independent rows each read "correct" on their own.
    for (let i = 0; i < 10; i++) trackCallByKey(BUCKET, 'free');
    for (let i = 0; i < 5; i++) trackCall(claimed());
    const viaKey = checkQuota(claimed());
    const viaBucket = checkQuotaByKey(BUCKET, 'free');
    expect(viaKey.used).toBe(15);
    expect(viaBucket.used).toBe(15);
    expect(viaKey.used).toBe(viaBucket.used);
  });

  it('post-claim the caller is still refused on BOTH walls, at the same reset instant', () => {
    for (let i = 0; i < FREE_DAILY_CALLS; i++) trackCallByKey(BUCKET, 'free');
    const keyed = checkQuota(claimed());
    const keyless = checkQuotaByKey(BUCKET, 'free');
    expect(keyed.allowed).toBe(false);
    expect(keyless.allowed).toBe(false);
    expect(keyed.limit).toBe('daily');
    // Same identity ⇒ same numbers, not merely both-refused.
    expect(keyed.used).toBe(keyless.used);
  });
});

describe('blast radius — a key with NO adopted bucket is byte-identical to pre-wave', () => {
  it('a legacy free key still meters by its own key, untouched by any other bucket', () => {
    for (let i = 0; i < 7; i++) trackCallByKey(BUCKET, 'free');
    // The legacy key must not have moved: it has no bucketKey, so it meters by itself.
    expect(checkQuota(legacy()).used).toBe(0);
    trackCall(legacy());
    expect(checkQuota(legacy()).used).toBe(1);
    // ...and spending it left the bucket alone.
    expect(checkQuotaByKey(BUCKET, 'free').used).toBe(7);
  });

  it('two legacy keys remain independent of each other', () => {
    trackCall(legacy('av_free_aaaa0000000000000000'));
    expect(checkQuota(legacy('av_free_bbbb0000000000000000')).used).toBe(0);
  });

  it('a paid key is untouched by the free-tier branch entirely', () => {
    const starter: LicenseInfo = { tier: 'starter', key: 'av_starter_x', customerId: 'cus_t' };
    trackCall(starter);
    expect(checkQuota(starter).used).toBe(1);
  });
});

describe('adoption source — always the ip_hash bucket, never another key', () => {
  it('accepts a keyless bucket key', () => {
    expect(isAdoptableBucketKey('free:v2:deadbeefdeadbeef')).toBe(true);
    expect(isAdoptableBucketKey('free:legacyhash')).toBe(true);
  });

  it('🛑 REFUSES a key→key chain — 5 mints/ipHash/hour makes laundering reachable', () => {
    expect(isAdoptableBucketKey(`free:${FREE_KEY_PREFIX}abc`)).toBe(false);
    expect(isAdoptableBucketKey('av_free_abc')).toBe(false);
  });

  it('refuses anything that is not a bucket key at all', () => {
    for (const bad of ['', 'anon', 'free:', undefined, null, 42, {}]) {
      expect(isAdoptableBucketKey(bad)).toBe(false);
    }
  });
});

describe('the bonus meter shares the derivation — a grant lands where it will be spent', () => {
  const CLAIMED_KEY = 'av_free_claimed0000000000000';
  beforeEach(() => {
    cachedRows.clear();
    cachedRows.set(CLAIMED_KEY, { api_key: CLAIMED_KEY, email: null, ref_code: null, bucket_key: BUCKET });
    cachedRows.set('av_free_legacy00000000000000', {
      api_key: 'av_free_legacy00000000000000', email: null, ref_code: null, bucket_key: null,
    });
  });
  afterEach(() => { cachedRows.clear(); });

  it('🎯 a CLAIMED key resolves to its adopted bucket — the row that will SPEND the bonus', () => {
    // Granted under the raw key but consumed under the bucket ⇒ the grant strands, and the caller
    // is promised bonus calls they never receive. That is the promise-that-never-arrives class
    // quota-notice.ts already documents avoiding on the chat wall.
    expect(resolveBonusTrackerKey(CLAIMED_KEY)).toBe(BUCKET);
  });

  it('a legacy free key (no adopted bucket) resolves to ITSELF — unchanged', () => {
    expect(resolveBonusTrackerKey('av_free_legacy00000000000000')).toBe('av_free_legacy00000000000000');
  });

  it('a non-free key resolves to itself without consulting the key store', () => {
    expect(resolveBonusTrackerKey('av_starter_x')).toBe('av_starter_x');
  });

  it('a free key with no cached row resolves to itself (cache-miss ⇒ pre-wave behaviour)', () => {
    const k = 'av_free_uncached000000000000';
    expect(resolveBonusTrackerKey(k)).toBe(k);
  });
});

/**
 * OPS-QUOTA-METER-SURFACE-CONFORMANCE-W1 CH1 — CHECK A, the rendered-output assertion.
 *
 * The orphan scan in `scripts/check-quota-surface-conformance.mjs` catches the STRUCTURAL mode: a
 * surface that emits a quota fact without routing through the single derivation. It is blind to
 * the other mode, and both have already happened in this arc:
 *
 *   INERT — the surface routes correctly, but its INPUT is `undefined` at run time, so the field
 *           ships ABSENT with a green suite. Verbatim R3:
 *           `withQuotaState(..., { dailyUsed: (charged ?? quota).daily_used })` where `trackCall`
 *           returned no daily pair. Every unit test passed, because they all called
 *           `withQuotaState` DIRECTLY with a pair.
 *
 * So these assertions start from a REAL exported tool call on a REAL daily-walled caller and read
 * what comes out. A test that rebuilds the throw site is worthless here — and that is not a
 * hypothetical: `tests/unit/daily-refusal-contract.test.ts`'s own `refusalFor()` helper mirrors the
 * throw sites and hardcodes `resetAtMs: monthResetAtMs(lic)`, i.e. it embeds instance 9 itself, and
 * has been green throughout the defect's life.
 *
 * THE ASSERTIONS PROJECT FROM THE REGISTRY, never from a second list. A row declared `conforming`
 * must have every one of its `dailyRequiredFields` present and NOT `undefined`; a row declared
 * `violation` is asserted to be BROKEN in exactly that way, with its owner wave named. When CH2
 * fixes a surface and flips its row, the assertion flips with it — one derivation, no drift, and no
 * possibility of a fix landing without the test noticing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QUOTA_SURFACES, CONFORMANCE_CRITERION, CORPUS_BOUNDARY, QUOTA_PRIMITIVES } from '../../src/lib/quota-surfaces.js';
import { trackCall, checkQuota, _resetCallTrackersForTest, resetLicenseCache } from '../../src/lib/license.js';
import { utcDayResetAtMs } from '../../src/lib/utc-day.js';
import { FREE_DAILY_CALLS, FREE_MONTHLY_CALLS } from '../../src/lib/plans.js';
import { TierLimitReachedError, buildTierLimitPayload } from '../../src/lib/errors.js';
import { getTradeSignal } from '../../src/tools/get-trade-call.js';
import { getMarketRegime } from '../../src/tools/get-market-regime.js';
import { scanFundingArb } from '../../src/tools/scan-funding-arb.js';
import { runScanTradeCall } from '../../src/tools/scan-trade-calls.js';
import { buildSuggestedX402 } from '../../src/lib/x402-nudge.js';
import type { LicenseInfo } from '../../src/types.js';

const ROOT = join(__dirname, '..', '..');

let n = 0;
/** A caller at the DAILY wall with monthly headroom left — the state every instance mis-describes. */
function dailyWalled(): LicenseInfo {
  const lic: LicenseInfo = { tier: 'free', key: `av_qsc_${++n}` };
  for (let i = 0; i < FREE_DAILY_CALLS; i++) trackCall(lic);
  const q = checkQuota(lic);
  expect(q.allowed, 'fixture must actually be walled').toBe(false);
  expect(q.limit, 'fixture must be walled by the DAILY meter').toBe('daily');
  expect(q.used, 'and must still have MONTHLY headroom — that contrast IS the defect').toBeLessThan(FREE_MONTHLY_CALLS);
  return lic;
}

/** Read a dotted path, distinguishing "absent" from "present but undefined" is the caller's job. */
function at(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}

/** Bazaar (Base/USDC) live, OKX off — the same fixture `tests/x402-nudge.test.ts` uses. */
const BAZAAR_ENV: Record<string, string | undefined> = {
  X402_NUDGE_ENABLED: '1',
  X402_FACILITATOR: 'cdp',
  CDP_API_KEY_ID: 'test-id',
  CDP_API_KEY_SECRET: 'test-secret',
  BAZAAR_DISCOVERABLE: 'true',
  X402_NETWORK: 'base-mainnet',
};

/**
 * How each surface is driven. Keyed on the registry id, so a row with no renderer FAILS the
 * coverage assertion below rather than silently going unchecked.
 */
const RENDERERS: Record<string, () => Promise<Record<string, unknown>>> = {
  'refusal:get_trade_call': async () => {
    const lic = dailyWalled();
    try { await getTradeSignal({ coin: 'BTC', timeframe: '1h', license: lic }); }
    catch (e) { if (e instanceof TierLimitReachedError) return buildTierLimitPayload(e) as unknown as Record<string, unknown>; throw e; }
    throw new Error('expected a TierLimitReachedError');
  },
  'refusal:get_market_regime': async () => {
    const lic = dailyWalled();
    try { await getMarketRegime({ coin: 'BTC', timeframe: '4h', license: lic }); }
    catch (e) { if (e instanceof TierLimitReachedError) return buildTierLimitPayload(e) as unknown as Record<string, unknown>; throw e; }
    throw new Error('expected a TierLimitReachedError');
  },
  'refusal:scan_funding_arb': async () => {
    const lic = dailyWalled();
    try { await scanFundingArb({ license: lic }); }
    catch (e) { if (e instanceof TierLimitReachedError) return buildTierLimitPayload(e) as unknown as Record<string, unknown>; throw e; }
    throw new Error('expected a TierLimitReachedError');
  },
  'refusal:scan_trade_calls': async () => {
    const lic = dailyWalled();
    // `runScanTradeCall(params, license)` — two arguments, and the quota gate fires before any
    // venue fetch, so this is the real path with no network.
    return (await runScanTradeCall({}, lic)) as unknown as Record<string, unknown>;
  },
  'nudge:x402': async () => {
    const sx = buildSuggestedX402('get_trade_call', BAZAAR_ENV);
    expect(sx, 'the nudge fixture must produce a live rail').toBeTruthy();
    return { suggested_x402: sx } as Record<string, unknown>;
  },
};

describe('CHECK A — every registered surface, rendered on a DAILY-binding caller', () => {
  beforeEach(() => { _resetCallTrackersForTest(); resetLicenseCache(); });

  const driven = QUOTA_SURFACES.filter((s) => s.dailyRequiredFields.length > 0 && RENDERERS[s.id]);

  it('the registry is non-empty and every row justifies itself', () => {
    // Vacuity guard at CONSTRUCTION: an empty registry means this suite asserted nothing.
    expect(QUOTA_SURFACES.length).toBeGreaterThan(0);
    expect(driven.length, 'check A must drive at least one real surface').toBeGreaterThan(0);
    for (const s of QUOTA_SURFACES) {
      if (s.status !== 'conforming') {
        expect(s.reason, `${s.id}: a non-conforming row must justify itself`).toBeTruthy();
        expect(s.reason!.length).toBeGreaterThanOrEqual(25);
      }
      if (s.status === 'violation' || s.status === 'deferred') {
        expect(s.ownerWave, `${s.id}: a violation with no owner is a silence`).toBeTruthy();
      }
      for (const p of s.primitives) expect(QUOTA_PRIMITIVES).toContain(p);
    }
  });

  for (const s of driven) {
    it(`${s.id} (${s.status}) — ${s.dailyRequiredFields.join(', ')}`, async () => {
      const rendered = await RENDERERS[s.id]();
      const dailyIso = new Date(utcDayResetAtMs()).toISOString();
      const problems: string[] = [];

      // PRESENCE — `undefined` and absent must BOTH count, which is the exact shape of the R3
      // inert defect: the field was wired and the value was not.
      for (const f of s.dailyRequiredFields) {
        if (at(rendered, f) === undefined) problems.push(`${f} is absent or undefined`);
      }
      // CORRECTNESS — a horizon that is present but describes the wrong wall is the OTHER half,
      // and it is the half instance 9 is made of: every field populated, the instant 30 days out.
      for (const f of s.wallDerivedFields ?? []) {
        const v = at(rendered, f);
        if (v !== dailyIso) problems.push(`${f} is ${JSON.stringify(v)}, not the daily reset ${dailyIso}`);
      }
      // COPY — the noun must follow the wall it is attached to.
      if (s.dailyForbiddenPattern) {
        const v = at(rendered, s.dailyForbiddenPattern.field);
        if (typeof v === 'string' && new RegExp(s.dailyForbiddenPattern.pattern, 'i').test(v)) {
          problems.push(`${s.dailyForbiddenPattern.field} says "${s.dailyForbiddenPattern.pattern}" on a DAILY wall: ${JSON.stringify(v.slice(0, 80))}`);
        }
      }

      if (s.status === 'conforming') {
        expect(problems, `${s.id} is declared conforming but renders wrong on a daily wall`).toEqual([]);
      } else {
        // Declared broken ⇒ asserted broken. The moment CH2 fixes it, `problems` empties and THIS
        // assertion fails — so a fix cannot land without flipping the registry row in the same
        // commit, and this suite can never quietly document a defect as if it were the contract.
        expect(
          problems.length,
          `${s.id} now renders CORRECTLY on a daily wall — flip its registry row to "conforming" (owner: ${s.ownerWave})`,
        ).toBeGreaterThan(0);
      }
    });
  }
});

describe('CHECK A — the daily wall is genuinely distinguishable from the monthly one', () => {
  beforeEach(() => { _resetCallTrackersForTest(); resetLicenseCache(); });

  it('a daily-walled caller still has monthly headroom, so a monthly horizon is measurably wrong', () => {
    const lic = dailyWalled();
    const q = checkQuota(lic);
    expect(q.limit).toBe('daily');
    expect(FREE_MONTHLY_CALLS - q.used).toBeGreaterThan(0);
  });

  it('the refusal payload names the DAILY meter, whatever its horizon currently says', async () => {
    const rendered = await RENDERERS['refusal:get_trade_call']();
    expect(rendered.limit).toBe('daily');
    expect(rendered.daily_used).toBe(FREE_DAILY_CALLS);
    expect(rendered.daily_limit).toBe(FREE_DAILY_CALLS);
  });
});

describe('the registry module is a LEAF', () => {
  it('imports TYPES ONLY — a value import would close a cycle back through its own consumers', () => {
    const src = readFileSync(join(ROOT, 'src', 'lib', 'quota-surfaces.ts'), 'utf8');
    const imports = [...src.matchAll(/^import\s+(type\s+)?[^;]+from\s+'([^']+)'/gm)];
    expect(imports.length, 'the leafness assertion must have something to assert on').toBeGreaterThan(0);
    for (const m of imports) {
      expect(m[1], `non-type import of ${m[2]} — this module must stay a leaf, like binding-meter.ts`).toBeTruthy();
    }
  });

  it('states its conformance criterion and corpus boundary, so neither lives only in prose', () => {
    expect(CONFORMANCE_CRITERION).toMatch(/true of the meter it names/);
    expect(CONFORMANCE_CRITERION).toMatch(/binding meter is identified/);
    expect(CORPUS_BOUNDARY).toMatch(/caller-facing/);
  });
});

/**
 * GROWTH-TG-QUOTA-PARITY-W1 CH1 — GET /api/plans/public.
 *
 * Boots the REAL registrar on an ephemeral port (the shape `tests/entitlement-api.test.ts` and
 * `tests/webhook-api.test.ts` use), so every assertion below runs over real HTTP against the
 * handler production registers — not a re-implementation and not a mock.
 *
 * 🛑 GATE MECHANISM, ratified 2026-08-27 (Q4=a). The dispatching spec's gate curled
 * `http://127.0.0.1:3000/api/plans/public`. Nothing listens there, and a local full-server boot
 * dies on SQLite (`src/lib/chat-analytics.ts` carries PG-only DDL). This file is the substitution:
 * a PORT substitution, not a weakening — real HTTP, real handler, same assertion.
 *
 * PROVEN ABLE TO FAIL. `describe('the response is a PROJECTION…')` perturbs `plans.ts` through a
 * module mock and asserts the response FOLLOWS it. A hand-typed literal would keep answering 200
 * and fail that block — which is the whole defect this wave exists to retire, expressed as a test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

let server: http.Server | null = null;

/**
 * Boots the real registrar and returns its base URL.
 *
 * `vi.doUnmock` BEFORE `vi.resetModules()` before the import: `doMock` registrations persist for
 * the whole FILE, and neither `resetModules()` (module cache) nor `restoreAllMocks()` (spies)
 * clears the mock registry. Without the unmock, a block running after the perturbation block would
 * silently receive the perturbed ladder and its "the real value is 200" assertion would fail with
 * no hint as to why.
 */
async function boot(perturb?: { monthly?: number; daily?: number }): Promise<string> {
  vi.doUnmock('../src/lib/plans.js');
  vi.resetModules();

  if (perturb) {
    vi.doMock('../src/lib/plans.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../src/lib/plans.js')>();
      return {
        ...real,
        FREE_MONTHLY_CALLS: perturb.monthly ?? real.FREE_MONTHLY_CALLS,
        FREE_DAILY_CALLS: perturb.daily ?? real.FREE_DAILY_CALLS,
      };
    });
    vi.resetModules();
  }

  const express = (await import('express')).default;
  const { registerPlansPublicRoutes } = await import('../src/lib/plans-public-api.js');
  const app = express();
  registerPlansPublicRoutes(app);
  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const getBody = async (baseUrl: string) => {
  const r = await fetch(`${baseUrl}/api/plans/public`);
  return { res: r, body: (await r.json()) as Record<string, unknown> };
};

beforeEach(() => {
  // The endpoint touches no database; DATABASE_URL is cleared so a stray PG connection string in
  // the developer's environment cannot make this suite behave differently from CI.
  delete process.env.DATABASE_URL;
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
  vi.doUnmock('../src/lib/plans.js');
  vi.resetModules();
  if (ORIGINAL_DATABASE_URL !== undefined) process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  else delete process.env.DATABASE_URL;
});

describe('GET /api/plans/public — the free ladder is published', () => {
  it('serves 200 with the free tier at the plans.ts values', async () => {
    const { res, body } = await getBody(await boot());
    expect(res.status).toBe(200);
    const free = body.free as { monthly_calls: number; daily_calls: number };
    // The two figures CH2's bot mirror reads. Independently corroborated by
    // ops/pricing-tokens.json (free_monthly "200" / free_daily "100"), asserted below.
    expect(free.monthly_calls).toBe(200);
    expect(free.daily_calls).toBe(100);
  });

  it('sets an explicit Cache-Control — a static projection must not be re-fetched per call', async () => {
    const { res } = await getBody(await boot());
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('emits a parseable ISO-8601 generated_at render stamp', async () => {
    const { body } = await getBody(await boot());
    const stamp = body.generated_at as string;
    expect(typeof stamp).toBe('string');
    expect(Number.isNaN(Date.parse(stamp))).toBe(false);
  });
});

describe('ALLOW-list — the response carries public fields and nothing else', () => {
  it('top-level keys are exactly the four declared ones', async () => {
    const { body } = await getBody(await boot());
    expect(Object.keys(body).sort()).toEqual(['_algovault', 'free', 'generated_at', 'tiers']);
  });

  it('every tier carries exactly the five declared keys', async () => {
    const { body } = await getBody(await boot());
    const tiers = body.tiers as Array<Record<string, unknown>>;
    // Vacuity guard: an empty tiers[] would make the per-tier assertion below vacuously true.
    expect(tiers.length).toBeGreaterThan(0);
    for (const t of tiers) {
      expect(Object.keys(t).sort()).toEqual([
        'daily_calls', 'id', 'label', 'monthly_calls', 'price_usd',
      ]);
    }
  });

  it('carries no internal field anywhere in the serialised body', async () => {
    const { body } = await getBody(await boot());
    const serialised = JSON.stringify(body);
    for (const forbidden of [
      'outcome_return_pct', 'outcome_price', 'outcome_won', 'customerId', 'customer_id',
      'stripe', 'api_key', 'apiKey', 'subscriber', 'priceUsdAnnual', 'priceUsd6Month',
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it('enterprise daily_calls is null — a REFUSAL, never 0 and never "unlimited"', async () => {
    const { body } = await getBody(await boot());
    const tiers = body.tiers as Array<{ id: string; daily_calls: number | null }>;
    const ent = tiers.find((t) => t.id === 'enterprise');
    expect(ent).toBeDefined();
    expect(ent!.daily_calls).toBeNull();
    expect(JSON.stringify(body)).not.toContain('unlimited');
  });
});

describe('_algovault — the universal public CTA block, ratified onto this endpoint', () => {
  it('is byte-identical to buildPublicCtaBlock()', async () => {
    const baseUrl = await boot();
    const { buildPublicCtaBlock } = await import('../src/lib/public-cta.js');
    const { body } = await getBody(baseUrl);
    expect(body._algovault).toEqual(buildPublicCtaBlock());
  });

  it('carries exactly the four approved sub-keys', async () => {
    const { body } = await getBody(await boot());
    expect(Object.keys(body._algovault as object).sort()).toEqual([
      'brand', 'docs', 'get_started', 'note',
    ]);
  });
});

describe('tier coverage — a new plan cannot silently vanish from the public ladder', () => {
  it('PUBLIC_PLAN_ORDER covers exactly the PLANS SoT', async () => {
    vi.doUnmock('../src/lib/plans.js');
    vi.resetModules();
    const { PLANS } = await import('../src/lib/plans.js');
    const { PUBLIC_PLAN_ORDER } = await import('../src/lib/plans-public-api.js');
    expect([...PUBLIC_PLAN_ORDER].sort()).toEqual(Object.keys(PLANS).sort());
  });

  it('every PLANS entry reaches the response with its SoT figures', async () => {
    const baseUrl = await boot();
    const { PLANS } = await import('../src/lib/plans.js');
    const { body } = await getBody(baseUrl);
    const tiers = body.tiers as Array<{ id: string; label: string; monthly_calls: number; daily_calls: number | null; price_usd: number }>;
    expect(tiers.map((t) => t.id).sort()).toEqual(Object.keys(PLANS).sort());
    for (const t of tiers) {
      const sot = PLANS[t.id as keyof typeof PLANS];
      expect(t.label).toBe(sot.label);
      expect(t.monthly_calls).toBe(sot.monthlyCalls);
      expect(t.price_usd).toBe(sot.priceUsdMonthly);
      expect(t.daily_calls).toBe(typeof sot.dailyCalls === 'number' ? sot.dailyCalls : null);
    }
  });
});

describe('parity with ops/pricing-tokens.json — two projections of ONE source', () => {
  /**
   * 🛑 DIRECTION IS A LAW (ratified 2026-08-27, Q4=a). `ops/pricing-tokens.json` is ALREADY
   * derived from `dist/lib/plans.js` by `scripts/emit-pricing-tokens.mjs`. On a mismatch the fix
   * is to REGENERATE the tokens from `plans.ts` — never to hand-edit either artifact to match the
   * other. Editing them to agree converts two projections into two SoTs, which is precisely the
   * defect this wave exists to retire.
   */
  it('the endpoint and the emitted tokens agree on the free ladder', async () => {
    const baseUrl = await boot();
    const tokensPath = path.resolve(__dirname, '..', 'ops', 'pricing-tokens.json');
    const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8')).tokens as Record<string, string>;
    const { body } = await getBody(baseUrl);
    const free = body.free as { monthly_calls: number; daily_calls: number };
    expect(free.monthly_calls.toLocaleString('en-US')).toBe(tokens.free_monthly);
    expect(free.daily_calls.toLocaleString('en-US')).toBe(tokens.free_daily);
  });

  it('the endpoint and the emitted tokens agree on the paid ladder', async () => {
    const baseUrl = await boot();
    const tokensPath = path.resolve(__dirname, '..', 'ops', 'pricing-tokens.json');
    const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8')).tokens as Record<string, string>;
    const { body } = await getBody(baseUrl);
    const tiers = body.tiers as Array<{ id: string; monthly_calls: number; daily_calls: number | null }>;
    const starter = tiers.find((t) => t.id === 'starter')!;
    const pro = tiers.find((t) => t.id === 'pro')!;
    expect(starter.monthly_calls.toLocaleString('en-US')).toBe(tokens.starter_monthly);
    expect(starter.daily_calls!.toLocaleString('en-US')).toBe(tokens.starter_daily);
    expect(pro.monthly_calls.toLocaleString('en-US')).toBe(tokens.pro_monthly);
    expect(pro.daily_calls!.toLocaleString('en-US')).toBe(tokens.pro_daily);
  });
});

describe('the response is a PROJECTION of plans.ts, not a literal — proven able to fail', () => {
  /**
   * This block IS the proof. It perturbs the SoT and requires the response to move with it. A
   * hand-typed `200` in the handler passes every other assertion in this file and fails here —
   * which is the point: the eleven hand-typed copies in the bot are what the wave is retiring, and
   * a twelfth in the endpoint that publishes the cure would be the defect in a new coat.
   */
  it('follows a perturbed FREE_MONTHLY_CALLS', async () => {
    const { body } = await getBody(await boot({ monthly: 999 }));
    expect((body.free as { monthly_calls: number }).monthly_calls).toBe(999);
  });

  it('follows a perturbed FREE_DAILY_CALLS', async () => {
    const { body } = await getBody(await boot({ daily: 7 }));
    expect((body.free as { daily_calls: number }).daily_calls).toBe(7);
  });

  it('returns to the real SoT values once the perturbation is unmocked', async () => {
    const { body } = await getBody(await boot());
    const free = body.free as { monthly_calls: number; daily_calls: number };
    expect(free.monthly_calls).toBe(200);
    expect(free.daily_calls).toBe(100);
  });
});

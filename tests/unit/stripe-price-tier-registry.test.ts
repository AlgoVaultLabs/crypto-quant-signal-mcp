/**
 * PRICING-ANNUAL-AND-HOLD-PROMISE-W1 (C1) — the Stripe price→tier registry.
 *
 * WHAT THIS PINS, AND WHY IT EXISTS.
 *
 * Annual prepay adds two new Stripe Price ids. Before this wave, four separate sites resolved
 * "which tier did this customer buy?" from a chain of `priceId === X_PRICE_ID` comparisons that
 * knew only the three MONTHLY ids:
 *
 *   - `validateApiKey`            — the hot path on every API call
 *   - `getCustomerApiKey`         — the post-checkout /welcome page
 *   - `handleSubscriptionCreated` — the webhook that MINTS the customer's API key
 *   - `subscriptionTier`          — the active-subscriber tier census
 *
 * So creating an annual Price and selling it would have produced: `validateApiKey` → no match →
 * `{valid:false}` → **the API key of someone who had just prepaid a year does not work**, while
 * `handleSubscriptionCreated` minted them a 'starter' key regardless of what they paid for.
 *
 * The four copies had also already drifted — `handleSubscriptionCreated` never compared
 * STARTER_PRICE_ID at all. These tests pin the registry that replaced all four, and in particular
 * pin the ORDER-INDEPENDENCE property: CLAUDE.md forbids renting a load-bearing safety property
 * from iteration/registration order, so tier precedence must be a function of our own rank table
 * and never of the order Stripe returns `sub.items.data` in.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

// Configure the five price ids BEFORE the module is imported — the map is built at module load.
vi.hoisted(() => {
  process.env.STRIPE_STARTER_PRICE_ID = 'price_starter_monthly';
  process.env.STRIPE_PRO_PRICE_ID = 'price_pro_monthly';
  process.env.STRIPE_ENTERPRISE_PRICE_ID = 'price_enterprise_monthly';
  process.env.STRIPE_STARTER_ANNUAL_PRICE_ID = 'price_starter_annual';
  process.env.STRIPE_PRO_ANNUAL_PRICE_ID = 'price_pro_annual';
  // No secret key → the Stripe client stays null. The registry is pure and needs no client.
  delete process.env.STRIPE_SECRET_KEY;
});

import {
  buildPriceTierMap,
  currentPriceBindings,
  bindingForPriceId,
  tierForPriceId,
  highestTier,
  priceIdFor,
  resolveSubscription,
  buildCensusComposition,
  censusTierTotal,
  _rebuildPriceTierMapForTest,
  _inspectPriceTierMap,
  type PriceBinding,
  type ResolvedSubscription,
} from '../../src/lib/stripe.js';

/** A minimal subscription shaped like the Stripe object the four call sites receive. */
const subWith = (...priceIds: string[]) => ({ items: { data: priceIds.map((id) => ({ price: { id } })) } });

beforeEach(() => {
  process.env.STRIPE_STARTER_PRICE_ID = 'price_starter_monthly';
  process.env.STRIPE_PRO_PRICE_ID = 'price_pro_monthly';
  process.env.STRIPE_ENTERPRISE_PRICE_ID = 'price_enterprise_monthly';
  process.env.STRIPE_STARTER_ANNUAL_PRICE_ID = 'price_starter_annual';
  process.env.STRIPE_PRO_ANNUAL_PRICE_ID = 'price_pro_annual';
  _rebuildPriceTierMapForTest();
});

describe('price→tier registry — resolution', () => {
  it('maps all five configured prices to the right tier AND interval', () => {
    const cases: Array<[string, string, string]> = [
      ['price_starter_monthly', 'starter', 'month'],
      ['price_pro_monthly', 'pro', 'month'],
      ['price_enterprise_monthly', 'enterprise', 'month'],
      ['price_starter_annual', 'starter', 'year'],
      ['price_pro_annual', 'pro', 'year'],
    ];
    // Vacuity guard: an empty map would make every assertion below trivially unreachable.
    expect(_inspectPriceTierMap().size).toBe(5);
    for (const [priceId, tier, interval] of cases) {
      expect(tierForPriceId(priceId), priceId).toBe(tier);
      expect(bindingForPriceId(priceId)?.interval, priceId).toBe(interval);
    }
  });

  it('returns null for a price id nothing binds — never a default tier', () => {
    expect(tierForPriceId('price_some_other_product')).toBeNull();
    expect(bindingForPriceId('price_some_other_product')).toBeNull();
  });

  it('THE REGRESSION THIS WAVE EXISTS FOR: an annual-only subscription resolves to its paid tier', () => {
    // Pre-registry this returned null at validateApiKey → {valid:false} → a prepaying annual
    // customer's API key did not work at all.
    expect(highestTier(subWith('price_pro_annual'))).toBe('pro');
    expect(highestTier(subWith('price_starter_annual'))).toBe('starter');
  });

  it('skips UNCONFIGURED env vars instead of indexing an empty-string key', () => {
    // The pre-registry code compared `item.price.id === ENTERPRISE_PRICE_ID` with both sides ''
    // when that var was unset. An '' key in the map would be the same landmine.
    delete process.env.STRIPE_ENTERPRISE_PRICE_ID;
    delete process.env.STRIPE_PRO_ANNUAL_PRICE_ID;
    _rebuildPriceTierMapForTest();

    expect(_inspectPriceTierMap().has('')).toBe(false);
    expect(_inspectPriceTierMap().size).toBe(3);
    expect(tierForPriceId('')).toBeNull();
    expect(highestTier(subWith(''))).toBeNull();
    // An unconfigured interval is simply not offered — not an error, and not a silent monthly.
    expect(priceIdFor('pro', 'year')).toBeNull();
  });
});

describe('price→tier registry — ORDER INDEPENDENCE (CLAUDE.md: never rent a safety property from ordering)', () => {
  it('resolves identically for every permutation of the binding list', () => {
    const bindings = currentPriceBindings();
    const reference = buildPriceTierMap(bindings);
    expect(reference.size).toBe(5); // vacuity guard

    // Reversed, rotated, and rank-inverted orders must all produce the same resolution.
    const permutations: Array<readonly PriceBinding[]> = [
      [...bindings].reverse(),
      [...bindings.slice(2), ...bindings.slice(0, 2)],
      [...bindings].sort((a, b) => a.priceId.localeCompare(b.priceId)),
      [...bindings].sort((a, b) => b.priceId.localeCompare(a.priceId)),
    ];

    for (const [i, perm] of permutations.entries()) {
      const map = buildPriceTierMap(perm);
      expect(map.size, `permutation ${i} size`).toBe(reference.size);
      for (const [priceId, binding] of reference) {
        expect(map.get(priceId)?.tier, `permutation ${i} → ${priceId} tier`).toBe(binding.tier);
        expect(map.get(priceId)?.interval, `permutation ${i} → ${priceId} interval`).toBe(binding.interval);
      }
    }
  });

  it('a duplicate price id resolves by TIER_RANK, not by which row came last', () => {
    // A real misconfiguration: one Stripe Price wired to two env vars. Whichever order the rows
    // appear in, the HIGHER tier must win — a last-write-wins map would flip with the order.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const collide: PriceBinding[] = [
      { priceId: 'price_dupe', tier: 'starter', interval: 'month', envVar: 'STRIPE_STARTER_PRICE_ID' },
      { priceId: 'price_dupe', tier: 'pro', interval: 'month', envVar: 'STRIPE_PRO_PRICE_ID' },
    ];
    expect(buildPriceTierMap(collide).get('price_dupe')?.tier).toBe('pro');
    expect(buildPriceTierMap([...collide].reverse()).get('price_dupe')?.tier).toBe('pro');
    // And it must be LOUD — a silent collision is how an under-entitlement survives.
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0]?.[0])).toContain('price-id collision');
    err.mockRestore();
  });

  it('highestTier picks by rank regardless of item order within a subscription', () => {
    // The old `for … if (x) break` shape made the winner depend on Stripe's array order.
    expect(highestTier(subWith('price_enterprise_monthly', 'price_starter_monthly'))).toBe('enterprise');
    expect(highestTier(subWith('price_starter_monthly', 'price_enterprise_monthly'))).toBe('enterprise');
    expect(highestTier(subWith('price_pro_monthly', 'price_starter_annual'))).toBe('pro');
    expect(highestTier(subWith('price_starter_annual', 'price_pro_monthly'))).toBe('pro');
  });

  it('an unrecognised item does not mask a recognised one, in either order', () => {
    expect(highestTier(subWith('price_unknown', 'price_pro_annual'))).toBe('pro');
    expect(highestTier(subWith('price_pro_annual', 'price_unknown'))).toBe('pro');
  });

  it('tolerates a malformed subscription rather than throwing on the hot path', () => {
    expect(highestTier({ items: { data: [] } })).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(highestTier({ items: {} } as any)).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(highestTier({ items: { data: [{}] } } as any)).toBeNull();
  });
});

describe('priceIdFor — the checkout resolver', () => {
  it('returns the monthly price by default, so every pre-existing call site is unchanged', () => {
    expect(priceIdFor('starter')).toBe('price_starter_monthly');
    expect(priceIdFor('pro')).toBe('price_pro_monthly');
    expect(priceIdFor('enterprise')).toBe('price_enterprise_monthly');
  });

  it('returns the annual price when the year interval is requested', () => {
    expect(priceIdFor('starter', 'year')).toBe('price_starter_annual');
    expect(priceIdFor('pro', 'year')).toBe('price_pro_annual');
  });

  it('returns null for Enterprise annual — deliberately not sold', () => {
    expect(priceIdFor('enterprise', 'year')).toBeNull();
  });
});

// ── OPS-STRIPE-SUBSCRIPTION-TRUTH-W1 · CH2 ───────────────────────────────────────────────────
//
// The interval was already on every PriceBinding and had NO reader. That is why
// `countActiveSubscriptionsByTier` could not answer "how many of the 3 starters are annual" —
// it resolved only the tier and collapsed both cadences into it — and why `subscriber_profiles`
// had no cadence to store. `resolveSubscription` gives the existing precedence a second
// dimension; `highestTier` is now a projection of it, so there is still exactly ONE
// implementation of enterprise > pro > starter.

describe('resolveSubscription — tier AND interval from the one registry', () => {
  it('resolves both dimensions for every configured price', () => {
    expect(resolveSubscription(subWith('price_starter_monthly'))).toEqual({ tier: 'starter', interval: 'month' });
    expect(resolveSubscription(subWith('price_starter_annual'))).toEqual({ tier: 'starter', interval: 'year' });
    expect(resolveSubscription(subWith('price_pro_annual'))).toEqual({ tier: 'pro', interval: 'year' });
    expect(resolveSubscription(subWith('price_enterprise_monthly'))).toEqual({ tier: 'enterprise', interval: 'month' });
  });

  it('returns null on an unrecognised price — never a default cadence', () => {
    expect(resolveSubscription(subWith('price_nobody_knows'))).toBeNull();
  });

  it('highestTier is a PROJECTION of it — the two can never disagree about tier', () => {
    for (const id of ['price_starter_monthly', 'price_starter_annual', 'price_pro_annual', 'price_enterprise_monthly', 'price_nope']) {
      expect(highestTier(subWith(id))).toBe(resolveSubscription(subWith(id))?.tier ?? null);
    }
  });

  it('🛑 ORDER INDEPENDENCE: a same-tier month/year collision resolves by INTERVAL_RANK, not item order', () => {
    // This is the property the second dimension made observable. The OLD highestTier did not
    // need it — on a same-tier tie both branches yielded the same TIER, so iteration order was
    // invisible. Returning an interval makes it visible, so it must be DECLARED.
    const monthFirst = resolveSubscription(subWith('price_starter_monthly', 'price_starter_annual'));
    const yearFirst = resolveSubscription(subWith('price_starter_annual', 'price_starter_monthly'));
    expect(monthFirst).toEqual(yearFirst);
    // year wins: declared, and the conservative direction for MRR (the LOWER monthly number).
    expect(monthFirst).toEqual({ tier: 'starter', interval: 'year' });
  });

  it('tier rank still dominates interval rank — a monthly Pro beats an annual Starter', () => {
    const a = resolveSubscription(subWith('price_starter_annual', 'price_pro_monthly'));
    const b = resolveSubscription(subWith('price_pro_monthly', 'price_starter_annual'));
    expect(a).toEqual(b);
    expect(a).toEqual({ tier: 'pro', interval: 'month' });
  });

  it('tolerates a malformed subscription rather than throwing on the hot path', () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    expect(resolveSubscription({ items: { data: [] } })).toBeNull();
    expect(resolveSubscription({} as any)).toBeNull();
    expect(resolveSubscription({ items: { data: [{}] } } as any)).toBeNull();
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });
});

describe('buildCensusComposition — the census can finally answer "how many are annual"', () => {
  const r = (tier: 'starter' | 'pro' | 'enterprise', interval: 'month' | 'year'): ResolvedSubscription =>
    ({ tier, interval });

  it('counts each (tier, interval) cell', () => {
    const c = buildCensusComposition([r('starter', 'month'), r('starter', 'year'), r('starter', 'month'), r('pro', 'month')]);
    expect(c).toEqual([
      { tier: 'starter', interval: 'month', count: 2 },
      { tier: 'starter', interval: 'year', count: 1 },
      { tier: 'pro', interval: 'month', count: 1 },
    ]);
  });

  it('emits a DETERMINISTIC order from our rank tables, not the input order', () => {
    const forward = buildCensusComposition([r('enterprise', 'month'), r('starter', 'year'), r('pro', 'month'), r('starter', 'month')]);
    const reversed = buildCensusComposition([r('starter', 'month'), r('pro', 'month'), r('starter', 'year'), r('enterprise', 'month')]);
    expect(forward).toEqual(reversed);
    expect(forward.map((x) => `${x.tier}:${x.interval}`)).toEqual([
      'starter:month', 'starter:year', 'pro:month', 'enterprise:month',
    ]);
  });

  it('omits cells that were not observed — absent means zero, and no impossible pair is invented', () => {
    const c = buildCensusComposition([r('enterprise', 'month')]);
    expect(c).toHaveLength(1);
    // There is no (enterprise, year) Price, so nothing may emit a row for it.
    expect(c.find((x) => x.tier === 'enterprise' && x.interval === 'year')).toBeUndefined();
  });

  it('is empty for no subscriptions — a fact, not a failure', () => {
    expect(buildCensusComposition([])).toEqual([]);
  });

  it('censusTierTotal sums a tier across intervals, so the headline PROJECTS from composition', () => {
    const c = buildCensusComposition([r('starter', 'month'), r('starter', 'year'), r('starter', 'year'), r('pro', 'month')]);
    expect(censusTierTotal(c, 'starter')).toBe(3);
    expect(censusTierTotal(c, 'pro')).toBe(1);
    expect(censusTierTotal(c, 'enterprise')).toBe(0);
  });

  it("reproduces TODAY'S live prod composition (probed 2026-08-06): 3 starter + 1 pro, all monthly", () => {
    const c = buildCensusComposition([r('starter', 'month'), r('starter', 'month'), r('starter', 'month'), r('pro', 'month')]);
    expect(c).toEqual([
      { tier: 'starter', interval: 'month', count: 3 },
      { tier: 'pro', interval: 'month', count: 1 },
    ]);
    expect(censusTierTotal(c, 'starter') + censusTierTotal(c, 'pro')).toBe(4);
  });
});

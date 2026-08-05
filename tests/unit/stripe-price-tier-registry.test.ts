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
  _rebuildPriceTierMapForTest,
  _inspectPriceTierMap,
  type PriceBinding,
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

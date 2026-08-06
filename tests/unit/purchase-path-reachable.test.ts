/**
 * PRICING-MONTHLY-PATH-AND-CARD-CLEANUP-W1 (R4) — every advertised plan must be BUYABLE.
 *
 * WHY THIS EXISTS — the exact defect it repairs.
 *
 * `PRICING-ANNUAL-AND-HOLD-PROMISE-W1` shipped GREEN, with a passing suite, all ten deploy
 * canaries and live post-deploy curls proving `/signup?plan=starter` still 303s to a real Stripe
 * Checkout session. Every one of those checks passed — and monthly was still unbuyable, because
 * the landing page rendered the annual CTA as an `<a>` and the monthly alternative as an inert
 * `<div>`. The backend worked; nothing linked to it. **4 of 4 live subscriptions had been bought
 * through that path.**
 *
 * So the gate cannot be "does the href exist in the HTML" — it DID exist, twice, in the JSON-LD
 * `Offer.url` fields, which is precisely the false positive that let this ship. It has to be
 * "is the href inside markup a human can click".
 *
 * Structural, deliberately: it derives the plan set from `plans.ts` and the surfaces from a
 * declared list, so adding a 6-month interval or a new tier is covered without touching this file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderPlanCards } from '../../src/lib/signup-flow.js';
import { PLANS, planHasAnnual, type PaidPlanId } from '../../src/lib/plans.js';

const ROOT = join(__dirname, '..', '..');

/** Plans sold self-serve. Enterprise is contact-us — it has no purchase path by design. */
const SELF_SERVE: PaidPlanId[] = (Object.keys(PLANS) as PaidPlanId[]).filter(planHasAnnual);

interface Surface {
  readonly name: string;
  readonly html: () => string;
  readonly reason: string;
}

/** Every surface that ADVERTISES a plan price. A reason per row, never in a comment. */
const SURFACES: readonly Surface[] = [
  {
    name: 'landing/index.html',
    html: () => readFileSync(join(ROOT, 'landing/index.html'), 'utf8'),
    reason: 'the public pricing section — dual-artboard static bake; this is where monthly went dark',
  },
  {
    name: 'renderPlanCards() [/signup, /join, referral]',
    html: () => renderPlanCards(),
    reason: 'the function-rendered checkout cards — the surface that actually takes money',
  },
];

/**
 * Every `href` on the page that a user can actually click, with its enclosing tag verified.
 * A JSON-LD `"url": "…"` is NOT an href and must never satisfy this gate.
 */
function clickableHrefs(html: string): string[] {
  return [...html.matchAll(/<a\s[^>]*href="([^"]+)"/g)].map((m) => m[1]);
}

/** `?plan=x` with no interval param → monthly (the route's documented default). */
function buysPlan(href: string, plan: string, interval: 'month' | 'year'): boolean {
  if (!href.includes(`/signup?plan=${plan}`)) return false;
  const isAnnual = href.includes('interval=year');
  // Guard against a same-prefix plan id (e.g. `pro` matching `pro-plus`) once such a tier exists.
  const after = href.split(`/signup?plan=${plan}`)[1] ?? '';
  if (after && !after.startsWith('&')) return false;
  return interval === 'year' ? isAnnual : !isAnnual;
}

describe('purchase-path reachability — an advertised plan must be buyable', () => {
  it('the plan set and surface list are non-empty (vacuity guard)', () => {
    // With either list empty, every it.each below would silently vanish and the gate would be
    // dark while reporting green — the same failure shape it exists to catch.
    expect(SELF_SERVE.length).toBeGreaterThanOrEqual(2);
    expect(SURFACES.length).toBeGreaterThanOrEqual(2);
    for (const s of SURFACES) {
      expect(s.reason.length, s.name).toBeGreaterThan(20);
      expect(s.html().length, `${s.name} rendered empty`).toBeGreaterThan(500);
    }
  });

  for (const surface of SURFACES) {
    for (const plan of SELF_SERVE) {
      for (const interval of ['month', 'year'] as const) {
        it(`${surface.name}: ${plan} is buyable ${interval}ly from CLICKABLE markup`, () => {
          const hrefs = clickableHrefs(surface.html());
          expect(hrefs.length, 'no anchors parsed — the extractor broke, not the page').toBeGreaterThan(0);
          const hit = hrefs.filter((h) => buysPlan(h, plan, interval));
          expect(
            hit.length,
            `${surface.name} advertises ${plan} but offers no clickable ${interval}ly purchase path. ` +
            `A JSON-LD Offer url does NOT count — that is exactly how this shipped green before.`,
          ).toBeGreaterThan(0);
        });
      }
    }
  }

  it('a JSON-LD Offer url alone does NOT satisfy the gate — the original false positive', () => {
    // Pin the discriminator itself. `landing/index.html` genuinely carries
    // `"url": "https://api.algovault.com/signup?plan=enterprise"` in its Offer blocks while
    // rendering NO enterprise anchor; if `clickableHrefs` ever started matching those, this gate
    // would go quietly back to being the thing that passed while monthly was dead.
    // SYNTHETIC fixture, deliberately. The original keyed on the Enterprise Offer url being
    // present in landing/index.html — true at the time, and then CONTACT-FORM-AND-SUPPORT-CLAIM-
    // SWEEP-W1 stripped that Offer entirely. It failed LOUDLY, which is what a fixture assumption
    // should do; the fix is to stop depending on live markup for a property about the EXTRACTOR.
    const synthetic = `
      <script type="application/ld+json">
      { "offers": [{ "@type": "Offer", "name": "Ghost", "url": "https://api.algovault.com/signup?plan=ghost" }] }
      </script>
      <a href="https://api.algovault.com/signup?plan=real">Buy</a>`;
    const hrefs = clickableHrefs(synthetic);
    expect(hrefs).toEqual(['https://api.algovault.com/signup?plan=real']);
    expect(hrefs.some((h) => h.includes('plan=ghost')), 'a JSON-LD url must never count').toBe(false);
    // ...and on the live page, Enterprise has no clickable purchase path either.
    const html = readFileSync(join(ROOT, 'landing/index.html'), 'utf8');
    expect(clickableHrefs(html).some((h) => h.includes('plan=enterprise'))).toBe(false);
  });

  it('Enterprise is contact-us on every surface: no card, but a reachable contact line', () => {
    for (const surface of SURFACES) {
      const html = surface.html();
      expect(clickableHrefs(html).some((h) => h.includes('plan=enterprise')), surface.name).toBe(false);
      // CONTACT-PAGE-APEX-AND-INQUIRY-TYPE-W1: the contact line targets the form, not a mailbox.
      expect(html, `${surface.name} lost the Enterprise contact line`).toContain('href="/contact"');
    }
  });
});

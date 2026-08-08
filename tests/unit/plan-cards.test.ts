/**
 * REFERRAL-WEB-FIX-W1 — renderPlanCards is the single-sourced plan-card MARKUP shared
 * by getSignupPageHtml() (api /signup) and the apex /join page. These guard the link-base
 * contract that makes /join work while keeping /signup relative.
 *
 * PRICING-ANNUAL-AND-HOLD-PROMISE-W1 (C4) — the cards are now ANNUAL-FIRST on Starter and Pro,
 * and Enterprise has NO self-serve price or CTA (it is contact-us, per Mr.1 2026-08-05).
 *
 * The byte-identity constraint the original wave protected is DELIBERATELY retired: the cards are
 * supposed to look different now. What replaces it is stronger — every price, effective rate and
 * discount below is asserted to come from `plans.ts` rather than from a literal in this file, so
 * these tests cannot drift into re-encoding the prices they exist to check.
 */
import { describe, it, expect } from 'vitest';
import { renderPlanCards } from '../../src/lib/signup-flow.js';
import { CONTACT_FALLBACK_EMAIL } from '../../src/lib/contact-page.js';
import {
  PLANS,
  planPriceLabel,
  planAnnualPriceLabel,
  planAnnualMonthlyEquivalent,
  planAnnualSavingsPct,
} from '../../src/lib/plans.js';

describe('renderPlanCards — REFERRAL-WEB-FIX-W1 link-base contract', () => {
  it('default base="" → RELATIVE links (keeps the api /signup inline block relative)', () => {
    const c = renderPlanCards();
    expect(c).toContain('href="/signup?plan=starter"');
    expect(c).toContain('href="/signup?plan=pro"');
    expect(c).not.toContain('https://'); // the relative variant carries no absolute URL
  });

  it('base set → ABSOLUTE api links (for the apex /join; /signup is api-canonical)', () => {
    const c = renderPlanCards('https://api.algovault.com');
    expect(c).toContain('href="https://api.algovault.com/signup?plan=starter"');
    expect(c).toContain('href="https://api.algovault.com/signup?plan=pro"');
    expect(c).toContain('href="https://api.algovault.com/signup?plan=starter&amp;interval=year"');
  });

  it('renders the 2 self-serve plans + the SoT exchange count (no card drift between surfaces)', () => {
    // PRICING-MONTHLY-PATH-AND-CARD-CLEANUP-W1: Enterprise no longer renders a CARD on either
    // pricing surface — it is contact-us, carried by the line beneath the row.
    const c = renderPlanCards();
    expect(c).toContain('<h2>Starter</h2>');
    expect(c).toContain('<h2>Pro</h2>');
    expect(c).not.toContain('<h2>Enterprise</h2>');
    expect(c).toMatch(/data-tr-field="exchange_count">\d+</);
  });
});

describe('renderPlanCards — annual-first (PRICING-ANNUAL-AND-HOLD-PROMISE-W1)', () => {
  it('leads with the annual TOTAL, not the effective monthly rate', () => {
    const c = renderPlanCards();
    // The headline `.price` must carry the yearly figure + /yr.
    expect(c).toContain(`<div class="price">${planAnnualPriceLabel('starter')}<span>/yr</span></div>`);
    expect(c).toContain(`<div class="price">${planAnnualPriceLabel('pro')}<span>/yr</span></div>`);
  });

  it('always shows the effective monthly rate ALONGSIDE the annual total, never instead of it', () => {
    // Quoting only "$6.58/mo" for something billed $79 once a year is the misleading framing the
    // public-copy LAW forbids; both numbers must be present together.
    const c = renderPlanCards();
    for (const id of ['starter', 'pro'] as const) {
      expect(c).toContain(`${planAnnualMonthlyEquivalent(id)}/mo effective`);
      expect(c).toContain(`${planAnnualPriceLabel(id)}<span>/yr</span>`);
    }
  });

  it('shows the computed saving, and it matches plans.ts exactly', () => {
    const c = renderPlanCards();
    expect(c).toContain(`Save ${planAnnualSavingsPct('starter')}%`);
    expect(c).toContain(`Save ${planAnnualSavingsPct('pro')}%`);
    // Sanity-anchor the approved values so a silent SoT edit is still visible here.
    expect(c).toContain('Save 34%');
    expect(c).toContain('Save 49%');
  });

  it('keeps the monthly option visible and one click away — no dark pattern', () => {
    const c = renderPlanCards();
    for (const id of ['starter', 'pro'] as const) {
      expect(c).toContain(`or ${planPriceLabel(id)}/mo billed monthly`);
      expect(c).toContain(`href="/signup?plan=${id}"`); // plain monthly checkout still reachable
    }
  });

  it('routes the annual CTA through ?interval=year', () => {
    const c = renderPlanCards();
    expect(c).toContain('href="/signup?plan=starter&amp;interval=year"');
    expect(c).toContain('href="/signup?plan=pro&amp;interval=year"');
  });

  it('carries NO scarcity language — Public-copy LAW', () => {
    const c = renderPlanCards().toLowerCase();
    for (const banned of ['limited time', 'hurry', 'act now', 'expires', 'countdown', 'only today', 'ends soon']) {
      expect(c, banned).not.toContain(banned);
    }
  });
});

describe('renderPlanCards — Enterprise is contact-us (R4)', () => {
  it('shows NO self-serve price on the Enterprise card', () => {
    const c = renderPlanCards();
    expect(c).not.toContain(`${planPriceLabel('enterprise')}<span>/mo</span>`);
    expect(c).not.toContain('$299<span>/mo</span>');
  });

  it('has NO Enterprise checkout CTA', () => {
    const c = renderPlanCards();
    expect(c).not.toContain('plan=enterprise');
    expect(c).not.toContain('Subscribe to Enterprise');
  });

  it('places ONE contact line BELOW the tier row, pointing at the operator mailbox', () => {
    const c = renderPlanCards();
    const gridEnd = c.indexOf('</div>\n  <div class="plans-contact">');
    expect(gridEnd, 'contact line must follow the .plans grid, not sit inside a card').toBeGreaterThan(-1);
    // CONTACT-PAGE-APEX-AND-INQUIRY-TYPE-W1: the CTA is the FORM now, not a mailto — Cloudflare
    // rewrites every mailto: into /cdn-cgi/l/email-protection#, so the old link was unclickable.
    expect(c).toContain('<a href="/contact">Contact us</a>');
    expect(c).not.toContain('mailto:');
    // The address survives as the contact page's own secondary fallback, with ONE owner.
    expect(CONTACT_FALLBACK_EMAIL).toBe('admin@algovault.com');
  });

  it('renders NO Enterprise card at all — the contact line carries it', () => {
    // PRICING-MONTHLY-PATH-AND-CARD-CLEANUP-W1 replaced the prior wave's "Custom" card. The
    // feature list went with it: a card advertising 100,000 calls with no price and no CTA was
    // the half-measure the architect removed.
    const c = renderPlanCards();
    // PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 (R-B) raised Pro to 100,000/mo, which is the
    // number the retired Enterprise card used to advertise — so "no '100,000 calls/month'" now
    // fires on the legitimate PRO card. Assert the Enterprise IDENTITY is absent instead, which
    // is what this test always meant.
    // Enterprise appears exactly ONCE, in the contact line — never as a card.
    expect(c).toContain('Need Enterprise?');
    expect(c.match(new RegExp(PLANS.enterprise.label, 'g')) ?? []).toHaveLength(1);
    expect(c).not.toContain('SLA guarantee');
    expect(c).not.toContain('Dedicated support');
    expect(c).not.toContain('price-contact');
    // ...but the plan itself is NOT retired: this is a display removal, so `plans.ts` and the
    // /signup?plan=enterprise route still resolve for any existing or in-flight subscription.
    expect(PLANS.enterprise.monthlyCalls).toBe(100_000);
  });

  it('renders exactly 2 plan cards', () => {
    // `class="plan"` (Starter) and `class="plan popular"` (Pro) — and NOT the `plans` grid or the
    // `plans-contact` line, both of which share the prefix.
    const c = renderPlanCards();
    expect((c.match(/class="plan(?:"| popular")/g) ?? []).length).toBe(2);
  });
});

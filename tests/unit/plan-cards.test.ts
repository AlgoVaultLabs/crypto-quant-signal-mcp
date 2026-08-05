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
import { renderPlanCards, ENTERPRISE_CONTACT_EMAIL } from '../../src/lib/signup-flow.js';
import {
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

  it('renders all 3 plans + the SoT exchange count (no card drift between surfaces)', () => {
    const c = renderPlanCards();
    expect(c).toContain('<h2>Starter</h2>');
    expect(c).toContain('<h2>Pro</h2>');
    expect(c).toContain('<h2>Enterprise</h2>');
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
    expect(c).toContain(`<a href="mailto:${ENTERPRISE_CONTACT_EMAIL}">Contact us</a>`);
    expect(ENTERPRISE_CONTACT_EMAIL).toBe('admin@algovault.com');
  });

  it('keeps the Enterprise feature list intact', () => {
    const c = renderPlanCards();
    expect(c).toContain('100,000 calls/month');
    expect(c).toContain('SLA guarantee');
    expect(c).toContain('Dedicated support');
  });
});

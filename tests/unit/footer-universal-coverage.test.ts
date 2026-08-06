/**
 * FOOTER-CONTACT-AND-UNIVERSAL-COVERAGE-W1 (G4) — Contact must be reachable from EVERY page,
 * and the SoT that puts it there must stay honest.
 *
 * THE GAP THIS CLOSES. `inject-footer.mjs --check` and footer-unify-canary.test.mjs both assert
 * over STATIC pages — they glob `landing/**` and read files. Neither can see a page that only
 * exists as a function: /contact, /welcome, /signup, /referral, /join and the account family are
 * rendered from TypeScript at request time and never touch the landing tree. Before this wave
 * those pages carried no brand footer at all, and no gate could have said so.
 *
 * WHY IT MATTERS BEYOND TIDINESS. Four consecutive waves built a contact path — a form, a durable
 * contact_leads table, an inquiry-type field, an apex route — and the only way to FIND it was a
 * pricing card. A conversion surface nothing links to is a conversion surface that does not exist.
 *
 * The suite is deliberately two-sided: it asserts the footer is PRESENT on full pages, and that
 * it is ABSENT from fragments (a fragment that grew its own footer would render two on the host
 * page). "Every page has a footer" and "only pages have footers" are different claims and a gate
 * that checks one silently permits the other.
 */
import { describe, it, expect } from 'vitest';
import { renderBrandFooter, FOOTER_LINKS, BRAND_FOOTER_MARKER } from '../../src/lib/footer-content.js';
import { renderContactPage, renderContactConfirmation } from '../../src/lib/contact-page.js';
import { getWelcomePageHtml } from '../../src/lib/welcome-page.js';
import {
  renderReferralTermsPage,
  renderReferralLandingPage,
  renderJoinPage,
  renderReferralSignupForm,
} from '../../src/lib/referral-pages.js';
import { renderPlanCards } from '../../src/lib/signup-flow.js';

/** A full page owns a <body>; a fragment is rendered INTO one. The two get opposite assertions. */
interface Surface {
  readonly name: string;
  readonly html: () => string;
  readonly kind: 'page' | 'fragment';
}

const SURFACES: readonly Surface[] = [
  { name: '/contact', html: () => renderContactPage({} as never), kind: 'page' },
  { name: '/contact (confirmation)', html: () => renderContactConfirmation({} as never), kind: 'page' },
  { name: '/welcome', html: () => getWelcomePageHtml({} as never), kind: 'page' },
  { name: '/referral-terms', html: () => renderReferralTermsPage({} as never), kind: 'page' },
  { name: '/referral', html: () => renderReferralLandingPage({} as never), kind: 'page' },
  { name: '/join', html: () => renderJoinPage({} as never), kind: 'page' },
  // Fragments — embedded in a host page that supplies the footer.
  { name: 'referral signup form', html: () => renderReferralSignupForm({} as never), kind: 'fragment' },
  { name: 'plan cards', html: () => renderPlanCards(), kind: 'fragment' },
];

const CONTACT_HREF = 'https://algovault.com/contact';

describe('brand-footer universal coverage — function-rendered pages', () => {
  it('the surface list is non-vacuous and covers both kinds', () => {
    // Vacuity guard: an empty (or single-kind) list would make every assertion below pass while
    // proving nothing. This is the constructed-corpus side — WE author this list.
    const pages = SURFACES.filter((s) => s.kind === 'page');
    const fragments = SURFACES.filter((s) => s.kind === 'fragment');
    expect(pages.length).toBeGreaterThanOrEqual(5);
    expect(fragments.length).toBeGreaterThanOrEqual(2);
  });

  it.each(SURFACES.filter((s) => s.kind === 'page').map((s) => [s.name, s] as const))(
    '%s renders the SoT brand footer and reaches /contact',
    (_name, surface) => {
      const html = surface.html();
      expect(html).toContain('</body>');
      expect(html).toContain(BRAND_FOOTER_MARKER);
      expect(html).toContain(CONTACT_HREF);
    },
  );

  it.each(SURFACES.filter((s) => s.kind === 'fragment').map((s) => [s.name, s] as const))(
    '%s is a fragment and must NOT carry its own footer',
    (_name, surface) => {
      const html = surface.html();
      expect(html).not.toContain('</body>');
      expect(html).not.toContain(BRAND_FOOTER_MARKER);
    },
  );
});

describe('the footer SoT itself', () => {
  it('carries Contact, positioned after Refer & Earn and before Privacy', () => {
    const labels = FOOTER_LINKS.map((l) => l.label);
    expect(labels).toContain('Contact');
    // Architect-confirmed order. Asserted by RELATIVE position so inserting an unrelated link
    // later does not force an edit here, while a reorder still fails.
    expect(labels.indexOf('Contact')).toBeGreaterThan(labels.indexOf('Refer &amp; Earn'));
    expect(labels.indexOf('Contact')).toBeLessThan(labels.indexOf('Privacy'));
  });

  it('carries Terms alongside Privacy', () => {
    const labels = FOOTER_LINKS.map((l) => l.label);
    expect(labels).toContain('Terms');
    expect(labels).toContain('Privacy');
  });

  it('preserves the links carried in from the retired page-nav footer', () => {
    // THE "PRESERVE" LEG of the architect's "Unify + preserve" ruling. Replacing faq.html's
    // page-nav footer with the brand footer would otherwise have dropped these three outright —
    // a user-visible content reduction, which Data Integrity forbids as a side effect.
    const labels = FOOTER_LINKS.map((l) => l.label);
    for (const carried of ['Home', 'Track Record', 'Glossary']) {
      expect(labels).toContain(carried);
    }
  });

  it('resolves every link to a real destination — no mailto, no Cloudflare obfuscation', () => {
    // The bug class three prior waves produced: a CTA that looks live and is not. Cloudflare
    // rewrites every mailto: into /cdn-cgi/l/email-protection#<hex>, so such a link resolves to
    // a dead internal path for anyone whose JS did not run.
    for (const link of FOOTER_LINKS) {
      expect(link.href).not.toContain('mailto:');
      expect(link.href).not.toContain('cdn-cgi/l/email-protection');
      expect(link.href).toMatch(/^https:\/\//);
    }
  });

  it('renders both variants with every link, and marks external links safely', () => {
    for (const variant of ['desktop', 'mobile'] as const) {
      const html = renderBrandFooter(variant);
      expect(html).toContain(`${BRAND_FOOTER_MARKER}="${variant}"`);
      for (const link of FOOTER_LINKS) expect(html).toContain(`href="${link.href}"`);
    }
    // External links must not hand the opener to a third-party tab (Design.md §9).
    const desktop = renderBrandFooter('desktop');
    for (const link of FOOTER_LINKS.filter((l) => l.external)) {
      const anchor = desktop.slice(desktop.indexOf(`href="${link.href}"`));
      expect(anchor.slice(0, 120)).toContain('rel="noopener noreferrer"');
    }
  });
});

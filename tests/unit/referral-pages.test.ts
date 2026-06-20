/**
 * REFERRAL-LIGHT-W1 / C4 — referral surface renderer invariants (PURE; no DB).
 * Interpolation-from-SoT (zero hardcoded program numbers in source — see also the
 * chapter grep gate), maskEmail on the payout queue, the FTC clause on the terms
 * page, and no outcome_* leak on any rendered surface.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  renderReferralStatsPage,
  renderReferralTermsPage,
  renderReferralLandingPage,
  renderAdminReferralsPage,
  renderAdminPayoutsPage,
} from '../../src/lib/referral-pages.js';
import { commissionPct, bonusCallsLabel, commissionMonthsLabel, usdcMinPayoutLabel } from '../../src/lib/referral-constants.js';

describe('renderReferralStatsPage', () => {
  const page = renderReferralStatsPage({
    code: 'MYCODE1', clicks: 12, signups: 5, conversions: 2, bonusRemaining: 480,
    accruedUsdE2: 9000, creditedUsdE2: 3000, usdcPendingUsdE2: 6000, usdcPaidUsdE2: 0,
  });
  it('shows the code + share link', () => {
    expect(page).toContain('MYCODE1');
    expect(page).toContain('/signup?ref=MYCODE1');
  });
  it('interpolates program numbers from the SoT', () => {
    expect(page).toContain(commissionPct()); // "30%"
    expect(page).toContain(bonusCallsLabel()); // "500"
    expect(page).toContain(commissionMonthsLabel()); // "12 months"
  });
  it('renders activity + dollar amounts (e2-cents → $X.YY)', () => {
    expect(page).toContain('480'); // bonus remaining
    expect(page).toContain('$90.00'); // accrued (9000 e2)
    expect(page).toContain('$30.00'); // credited
    expect(page).toContain('$60.00'); // usdc pending
  });
  it('links to the terms page', () => {
    expect(page).toContain('/referral-terms');
  });
});

describe('renderReferralTermsPage', () => {
  const page = renderReferralTermsPage();
  it('contains the FTC disclosure clause', () => {
    expect(page).toMatch(/disclose/i);
    expect(page).toContain('16 CFR Part 255');
    expect(page).toContain('ecfr.gov');
  });
  it('interpolates every program term from the SoT', () => {
    expect(page).toContain(commissionPct());
    expect(page).toContain(bonusCallsLabel());
    expect(page).toContain(commissionMonthsLabel());
    expect(page).toContain(usdcMinPayoutLabel());
  });
  it('states self-referral prohibition + refund clawback', () => {
    expect(page).toMatch(/self-referral/i);
    expect(page).toMatch(/claw/i);
  });
});

describe('renderAdminPayoutsPage — maskEmail (no PII leak)', () => {
  it('masks the owner email; the full address never appears', () => {
    const page = renderAdminPayoutsPage({
      pending: [{ code: 'PARTNERX', ownerEmail: 'creator@example.com', pendingUsdE2: 6000, rowCount: 1, ledgerIds: [42] }],
    });
    expect(page).not.toContain('creator@example.com');
    expect(page).toContain('c***@example.com');
    expect(page).toContain('PARTNERX');
    expect(page).toContain('$60.00');
  });
  it('shows the min-payout threshold on an empty queue', () => {
    expect(renderAdminPayoutsPage({ pending: [] })).toContain(usdcMinPayoutLabel());
  });
});

describe('renderAdminReferralsPage', () => {
  it('renders top referrers + the ledger tail', () => {
    const page = renderAdminReferralsPage({
      codeCount: 3,
      topReferrers: [{ code: 'TOP1', signups: 10, conversions: 4, accruedUsdE2: 12000 }],
      recentLedger: [{ id: 7, code: 'TOP1', commissionUsdE2: 3000, status: 'credited', createdAt: '2026-06-20' }],
    });
    expect(page).toContain('TOP1');
    expect(page).toContain('$120.00');
    expect(page).toContain('credited');
  });
});

describe('no outcome_* leak on any rendered surface', () => {
  it('forbidden internal keys never appear', () => {
    const pages = [
      renderReferralStatsPage({ code: 'X1', clicks: 0, signups: 0, conversions: 0, bonusRemaining: 0, accruedUsdE2: 0, creditedUsdE2: 0, usdcPendingUsdE2: 0, usdcPaidUsdE2: 0 }),
      renderReferralTermsPage(),
      renderReferralLandingPage(),
      renderAdminPayoutsPage({ pending: [] }),
      renderAdminReferralsPage({ codeCount: 0, topReferrers: [], recentLedger: [] }),
    ];
    for (const p of pages) {
      expect(p).not.toMatch(/outcome_return_pct|outcome_price/);
    }
  });
});

describe('renderReferralLandingPage — LANDING-REFERRAL-PAGE-W1', () => {
  const page = renderReferralLandingPage();

  it('interpolates every program number from the SoT (zero hardcoded literals)', () => {
    expect(page).toContain(bonusCallsLabel());       // "500"
    expect(page).toContain(commissionPct());         // "30%"
    expect(page).toContain(commissionMonthsLabel()); // "12 months"
    expect(page).toContain(usdcMinPayoutLabel());    // "$50"
  });

  it('is indexable (discovery surface, unlike the noindex terms page) + has a meta description', () => {
    expect(page).toContain('content="index,follow"');
    expect(page).not.toContain('content="noindex"');
    expect(page).toMatch(/<meta name="description" content="[^"]+">/);
  });

  it('hands the path (no join form): CTA → api /account, links terms + the keyless start-free path', () => {
    expect(page).not.toMatch(/<form/i);                          // no gate
    // /account is api-canonical (Stripe success_url from request host) — the page is
    // served on the APEX, so the link MUST be absolute api or it 404s on algovault.com.
    expect(page).toContain('href="https://api.algovault.com/account"'); // get-your-link CTA
    expect(page).not.toContain('href="/account"');               // never apex-relative (would 404)
    expect(page).toContain('href="/referral-terms"');            // proxied onto the apex → relative OK
    expect(page).toContain('href="https://algovault.com/#quickstart"'); // anon "start free"
  });

  it('is incentive-first: the hero leads with the double-sided give/get', () => {
    const hero = page.slice(page.indexOf('<h1>'), page.indexOf('<h2>'));
    expect(hero).toMatch(/<h1>Refer a friend/);
    expect(hero).toContain(bonusCallsLabel());
    expect(hero).toContain(commissionPct());
  });

  // Forward-stability grep-gate: the program numbers must NEVER appear as bare
  // literals in the renderer source — only via the SoT label fns. Guards against a
  // future edit hardcoding "500"/"30%"/"12 months"/"$50" and drifting from terms.
  it('source contains zero hardcoded program-number literals (SoT-only)', () => {
    const src = readFileSync(new URL('../../src/lib/referral-pages.ts', import.meta.url), 'utf8');
    const start = src.indexOf('export function renderReferralLandingPage');
    const end = src.indexOf('export interface AdminOverviewView', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const fn = src.slice(start, end);
    expect(fn).not.toMatch(/\b500\b/);
    expect(fn).not.toMatch(/\b0?\.30\b/);
    expect(fn).not.toMatch(/\b30\s*%/);
    expect(fn).not.toMatch(/\b12\s+months\b/);
    expect(fn).not.toMatch(/\$\s*50\b/);
  });
});

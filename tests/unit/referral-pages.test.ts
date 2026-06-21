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
  renderReferralSignupForm,
  renderJoinPage,
  renderAdminReferralsPage,
  renderAdminPayoutsPage,
} from '../../src/lib/referral-pages.js';
import { commissionPct, bonusCallsLabel, commissionMonthsLabel, usdcMinPayoutLabel, payoutScheduleLabel } from '../../src/lib/referral-constants.js';

describe('renderReferralStatsPage', () => {
  const page = renderReferralStatsPage({
    code: 'MYCODE1', clicks: 12, signups: 5, conversions: 2, bonusRemaining: 480,
    accruedUsdE2: 9000, creditedUsdE2: 3000, usdcPendingUsdE2: 6000, usdcPaidUsdE2: 0,
  });
  it('shows the code + share link', () => {
    expect(page).toContain('MYCODE1');
    expect(page).toContain('/join?ref=MYCODE1'); // REFERRAL-WEB-FIX-W1: shareLink retargeted to the apex /join referee landing
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
  // REFERRAL-PAYOUT-OPS-W1 / C1 — the full payout policy.
  it('states the full payout policy: USDC on Base, schedule, taxes + W-form', () => {
    expect(page).toContain('USDC on Base');
    expect(page).toContain(payoutScheduleLabel()); // "by the 10th of the following month"
    expect(page).toMatch(/tax/i);
    expect(page).toMatch(/W-9|W-8/);
  });
});

// REFERRAL-PAYOUT-OPS-W1 / C1 — payout-address card on the referral dashboard.
describe('renderReferralStatsPage — payout address card', () => {
  const KEY = 'av_free_0123456789abcdef01234567';
  const ADDR = '0x1234567890AbcdEF1234567890aBcdef12345678';
  const base = { code: 'MYCODE1', clicks: 0, signups: 0, conversions: 0, bonusRemaining: 0, accruedUsdE2: 0, creditedUsdE2: 0, usdcPaidUsdE2: 0 };

  it('shows the next-payout threshold + schedule + method (all SoT)', () => {
    const page = renderReferralStatsPage({ ...base, usdcPendingUsdE2: 0 });
    expect(page).toContain(usdcMinPayoutLabel());   // "$50"
    expect(page).toContain(payoutScheduleLabel());  // "by the 10th of the following month"
    expect(page).toContain('USDC on Base');
  });
  it('with an api key: renders the save form (hidden key + address input + irreversibility confirm)', () => {
    const page = renderReferralStatsPage({ ...base, usdcPendingUsdE2: 0, apiKey: KEY, payoutAddress: null });
    expect(page).toContain('action="/account/referrals/payout-address"');
    expect(page).toContain('name="payout_address"');
    expect(page).toContain('name="confirm"');
    expect(page).toContain('name="api_key"');
    expect(page).toContain(KEY);                     // re-carried so the save POST re-derives the code
    expect(page).toMatch(/irreversible/i);
  });
  it('prefills a stored address', () => {
    expect(renderReferralStatsPage({ ...base, usdcPendingUsdE2: 0, apiKey: KEY, payoutAddress: ADDR })).toContain(`value="${ADDR}"`);
  });
  it('eligible without an address warns; eligible with an address confirms the batch', () => {
    expect(renderReferralStatsPage({ ...base, usdcPendingUsdE2: 6000, apiKey: KEY, payoutAddress: null })).toMatch(/add your Base USDC address/i);
    expect(renderReferralStatsPage({ ...base, usdcPendingUsdE2: 6000, apiKey: KEY, payoutAddress: ADDR })).toMatch(/next payout batch/i);
  });
  it('flashes save success + a validation error', () => {
    expect(renderReferralStatsPage({ ...base, usdcPendingUsdE2: 0, apiKey: KEY, savedFlash: true })).toMatch(/saved/i);
    expect(renderReferralStatsPage({ ...base, usdcPendingUsdE2: 0, apiKey: KEY, addressError: 'That is not a valid EVM (Base) address.' })).toMatch(/not a valid EVM/i);
  });
  it('no api key → degrades to a hint, no form', () => {
    const page = renderReferralStatsPage({ ...base, usdcPendingUsdE2: 0 });
    expect(page).not.toContain('action="/account/referrals/payout-address"');
    expect(page).toMatch(/Paste your API key/i);
  });
});

describe('renderAdminPayoutsPage — maskEmail (no PII leak)', () => {
  it('masks the owner email; the full address never appears', () => {
    const page = renderAdminPayoutsPage({
      pending: [{ code: 'PARTNERX', ownerEmail: 'creator@example.com', payoutAddress: null, pendingUsdE2: 6000, rowCount: 1, ledgerIds: [42] }],
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

// REFERRAL-PAYOUT-OPS-W1 / C2 — admin batch view + Approve-all.
describe('renderAdminPayoutsPage — batch view + Approve-all', () => {
  const ADDR = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
  it('shows the shortened address, or a "no address" pill, + the batch total', () => {
    const page = renderAdminPayoutsPage({
      pending: [
        { code: 'HASADDR', ownerEmail: 'a@x.com', payoutAddress: ADDR, pendingUsdE2: 6000, rowCount: 1, ledgerIds: [1] },
        { code: 'NOADDR', ownerEmail: 'b@x.com', payoutAddress: null, pendingUsdE2: 7000, rowCount: 1, ledgerIds: [2] },
      ],
      batchTotalUsdE2: 13000,
      adminKey: 'SECRET',
    });
    expect(page).toContain('0x5aAe…');         // shortened (prefix + ellipsis)
    expect(page).not.toContain(ADDR);          // full address not shown
    expect(page).toContain('no address');
    expect(page).toContain('$130.00');         // batch total
  });
  it('renders the Approve-all form carrying the admin key (only when there are rows + key)', () => {
    const withKey = renderAdminPayoutsPage({
      pending: [{ code: 'HASADDR', ownerEmail: null, payoutAddress: ADDR, pendingUsdE2: 6000, rowCount: 1, ledgerIds: [1] }],
      adminKey: 'SECRET',
    });
    expect(withKey).toContain('action="/admin/referrals/payouts/approve-all?key=SECRET"');
    expect(withKey).toContain('Approve all');
    // no key → no form (can't authorize the POST)
    expect(renderAdminPayoutsPage({ pending: [{ code: 'X', ownerEmail: null, payoutAddress: ADDR, pendingUsdE2: 6000, rowCount: 1, ledgerIds: [1] }] })).not.toContain('approve-all');
  });
  it('flashes a stub (not-configured) result vs a real send result', () => {
    const stub = renderAdminPayoutsPage({ pending: [], result: { senderKind: 'stub', paidCount: 0, totalPaidUsdE2: 0, skippedNoAddress: [], failed: [] } });
    expect(stub).toMatch(/CDP wallet not configured/i);
    const real = renderAdminPayoutsPage({ pending: [], result: { senderKind: 'cdp', paidCount: 2, totalPaidUsdE2: 13000, skippedNoAddress: ['NOADDR'], failed: [] } });
    expect(real).toMatch(/Sent 2 payout/i);
    expect(real).toContain('$130.00');
    expect(real).toContain('NOADDR');
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

  it('hands the path via the inline free-account form (REFERRAL-FREE-KEY-SIGNUP-W1)', () => {
    expect(page).toMatch(/<form id="av-ref-form"/);              // the email form IS the path now
    expect(page).toContain('/api/signup-email');                 // same-origin POST (apex-proxied)
    expect(page).toContain('data-source="referral-page"');       // tagged source (REFERRAL-WEB-FIX-W1: via data-attr)
    // /account is api-canonical (Stripe success_url from request host) → absolute api
    // (the form's "already have an account" fallback); never apex-relative (would 404).
    expect(page).toContain('href="https://api.algovault.com/account"');
    expect(page).not.toContain('href="/account"');
    expect(page).toContain('href="/referral-terms"');            // proxied onto the apex → relative OK
    expect(page).toContain('href="https://algovault.com/#quickstart"'); // keyless reassurance
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
    // Covers the form JS const + renderReferralSignupForm + renderReferralLandingPage.
    // REFERRAL-WEB-FIX-W1: start at shareTextPrefix so the C2 share text + stats/form/join
    // copy are all covered by the hardcoded-literal guard (everything must be SoT-interpolated).
    const start = src.indexOf('function shareTextPrefix');
    const end = src.indexOf('export interface AdminOverviewView', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const fn = src.slice(start, end);
    expect(fn).not.toMatch(/\b500\b/);
    expect(fn).not.toMatch(/\b0?\.30\b/);
    expect(fn).not.toMatch(/\b30\s*%/);
    expect(fn).not.toMatch(/\b12\s+months\b/);
    expect(fn).not.toMatch(/\$\s*50\b/);
    // REFERRAL-PAYOUT-OPS-W1 / C1: the payout-schedule day is SoT-only (payoutScheduleLabel()),
    // never a bare "10th" literal. ($600 in the tax clause is an external IRS reference, not a
    // program term, so it is intentionally NOT gated here.)
    expect(fn).not.toMatch(/\b10th\b/);
  });
});

describe('renderReferralSignupForm — REFERRAL-FREE-KEY-SIGNUP-W1', () => {
  const form = renderReferralSignupForm();
  it('is a same-origin AJAX form (no CORS) tagged source=referral-page', () => {
    expect(form).toMatch(/<form id="av-ref-form"/);
    expect(form).toContain('fetch("/api/signup-email"');         // relative → apex-proxied same-origin
    expect(form).toContain('data-source="referral-page"');       // default source via data-attr (REFERRAL-WEB-FIX-W1)
    expect(form).toContain('Create my link');
    expect(form).toContain('id="av-ref-email"');                 // the email field
    expect(form).toContain('id="av-ref-consent"');               // optional marketing checkbox
  });
  it('offers the keyed-account fallback to the api-canonical /account (absolute, never apex-relative)', () => {
    expect(form).toContain('href="https://api.algovault.com/account"');
    expect(form).not.toContain('href="/account"');
  });
  it('never leaks outcome_*; renders the bonus number via the SoT pre-filled share text (no hardcode — source grep-gated below)', () => {
    expect(form).not.toMatch(/outcome_/);
    // REFERRAL-WEB-FIX-W1 (C2): the pre-filled share text interpolates the SoT bonus → the
    // rendered form now legitimately contains "500"; hardcoding is guarded by the source-scan.
    expect(form).toContain(bonusCallsLabel());
    expect(form).not.toMatch(/\b30\s*%/);          // % only via commissionPct() on other surfaces
    expect(form).not.toMatch(/\b12\s+months\b/);
  });
});

describe('renderJoinPage — REFERRAL-WEB-FIX-W1 (the referee landing / #1 bug fix)', () => {
  const valid = renderJoinPage({ refValid: true, code: 'FRIEND7' });
  const invalid = renderJoinPage({ refValid: false });

  it('valid ref: give-get hero + the form carries the ref to the free-grant path', () => {
    expect(valid).toContain(`A friend gave you ${bonusCallsLabel()} bonus calls`);
    expect(valid).toContain('data-ref="FRIEND7"');                 // the form carries the ref
    expect(valid).toContain('data-source="join-page"');
    expect(valid).toContain('fetch("/api/signup-email"');          // → processFreeReferralSignup
    expect(valid).toContain(`Claim my ${bonusCallsLabel()} calls`);
  });

  it('clarifies the bonus is ONE-TIME on top of the 100/mo (kills the recurring misread)', () => {
    expect(valid).toContain(`${bonusCallsLabel()} one-time bonus calls`);
    expect(valid).toContain('on top of the 100 free calls');
  });

  it('shows the paid plans with ABSOLUTE api links (/signup is api-canonical, not apex-proxied)', () => {
    expect(valid).toContain('class="plans"');
    expect(valid).toContain('href="https://api.algovault.com/signup?plan=starter"');
    expect(valid).not.toContain('href="/signup?plan=');           // never apex-relative (would 404)
  });

  it('invalid/missing ref: graceful general start-free, NO bonus claim, NO ref carried', () => {
    expect(invalid).toContain('Start free with AlgoVault');
    expect(invalid).not.toContain('gave you');                     // no bonus promise
    expect(invalid).not.toContain('data-ref="');                   // no ref on the form
    expect(invalid).toContain('class="plans"');                    // plans still offered
  });

  it('is noindex (per-ref transactional landing) + no outcome_* leak', () => {
    expect(valid).toContain('content="noindex"');
    expect(valid).not.toContain('content="index,follow"');
    expect(valid).not.toMatch(/outcome_/);
    expect(invalid).not.toMatch(/outcome_/);
  });
});

describe('REFERRAL-WEB-FIX-W1 C2 — share UX on all 3 web surfaces', () => {
  const surfaces: Array<[string, string]> = [
    ['/referral form', renderReferralSignupForm()],
    ['/join', renderJoinPage({ refValid: true, code: 'FRIEND7' })],
    ['/account stats', renderReferralStatsPage({ code: 'FRIEND7', clicks: 0, signups: 0, conversions: 0, bonusRemaining: 500, accruedUsdE2: 0, creditedUsdE2: 0, usdcPendingUsdE2: 0, usdcPaidUsdE2: 0 })],
  ];
  for (const [name, html] of surfaces) {
    it(`${name}: has copy + native share + pre-filled TG-framed share text`, () => {
      expect(html).toContain('Copy link');
      expect(html).toContain('navigator.share');                  // native share (graceful desktop fallback in the JS)
      expect(html).toContain('data-sharetext-prefix=');           // pre-filled text plumbed to the buttons
      expect(html).toContain('verifiable crypto trade signals');   // matches the TG bot's friend framing
    });
  }

  it('the bonus copy is de-ambiguated to one-time-on-top-of-100/mo (kills the recurring misread)', () => {
    expect(renderReferralLandingPage()).toContain('one-time bonus calls');
    expect(renderReferralStatsPage({ code: 'X', clicks: 0, signups: 0, conversions: 0, bonusRemaining: 0, accruedUsdE2: 0, creditedUsdE2: 0, usdcPendingUsdE2: 0, usdcPaidUsdE2: 0 })).toContain('one-time bonus calls (on top of their 100/mo free)');
    expect(renderJoinPage({ refValid: true, code: 'X' })).toContain('one-time bonus calls');
  });
});

/**
 * FUNNEL-FIX-AUTH-UNIFY-W1 — byte-parity guard for /welcome.
 *
 * The unified sign-in is additive + reversible behind UNIFIED_SIGNIN_ENABLED.
 * When the flag is OFF (unifiedSignin unset/false) the /welcome page MUST render
 * byte-identically to the pre-wave layout. These snapshots are captured from the
 * CURRENT getWelcomePageHtml BEFORE the unified branch is added, then re-asserted
 * after — any drift on the OFF path fails the build (protects the LIVE /welcome).
 * (byte-equivalence-fixture-for-inline-to-data-driven-refactor.)
 *
 * SNAPSHOT MAINTENANCE — PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 (CH7, 2026-08-09): the five
 * `organic` snapshots were regenerated for the R-B ladder + R-A flat-billing copy in the
 * paywall card. The word-level diff was verified BEFORE regenerating and is exactly four
 * edits, all inside the two paywall strings: free 100 -> 200 + the new daily cap, Starter
 * 3,000 -> 10,000 + its daily cap, and the added "Every verdict counts, HOLD included."
 * Nothing outside `.paywall-headline` / `.paywall-body` moved, which is the property this
 * guard actually protects — the OFF path's LAYOUT, not its copy.
 *
 * SNAPSHOT MAINTENANCE — CONVERSION-SURFACES-W2 (CH4, 2026-09-07): regenerated for C2. The word-level
 * diff was verified BEFORE regenerating and is exactly TWO edits, one per line, both inside the
 * strings this wave was signed off to change:
 *   .subtitle     'AlgoVault MCP — the crypto signal layer for AI agents'
 *              -> 'The Brain Layer for AI Trading Agents'   (the canonical tagline; the old form
 *                 weakened the positioning chain on the one page every new account sees)
 *   .paywall-body dropped 'full asset coverage' (free already has ALL assets, so it upsold what
 *                 the visitor already had) and 'unlimited Telegram bot alerts' (bot deliveries
 *                 have DEBITED the plan since 2026-08-17, so it was live-false).
 * Nothing outside those two elements moved — which is the property this guard protects: the OFF
 * path's LAYOUT, not its copy.
 *
 * SNAPSHOT MAINTENANCE — FUNNEL-TRUTH-AND-PAID-ATTRIBUTION-W1 (CH2, 2026-09-07): regenerated for
 * the analytics region. `/welcome` is api-origin only (404 on the apex) and carried NO Plausible
 * tag at all, which is why the goal `Form: Submission` — the goal that fires on this very page —
 * read 0 across 28 days. The diff was verified BEFORE regenerating and is EXACTLY the eight-line
 * `<!-- ANALYTICS:START -->` region in `<head>`: measured 0 lines removed and 0 added lines that
 * are not part of that region, across every snapshot in this file. Nothing in the body moved,
 * which is the property this guard actually protects — the OFF path's LAYOUT.
 */
import { describe, expect, it } from 'vitest';
import { getWelcomePageHtml } from '../src/lib/welcome-page.js';

const OAUTH_BOTH = { google: true, github: true };
const OAUTH_GH = { google: false, github: true };
const OAUTH_GG = { google: true, github: false };

describe('welcome-page byte-parity when UNIFIED_SIGNIN off (legacy layout intact)', () => {
  it('organic · newSignup off · no oauth', () => {
    expect(getWelcomePageHtml(null, null, null, {})).toMatchSnapshot();
  });
  it('organic · newSignup on · both oauth', () => {
    expect(getWelcomePageHtml(null, null, null, { newSignupEnabled: true, oauthProviders: OAUTH_BOTH })).toMatchSnapshot();
  });
  it('organic · newSignup on · github only', () => {
    expect(getWelcomePageHtml(null, null, null, { newSignupEnabled: true, oauthProviders: OAUTH_GH })).toMatchSnapshot();
  });
  it('organic · newSignup on · google only', () => {
    expect(getWelcomePageHtml(null, null, null, { newSignupEnabled: true, oauthProviders: OAUTH_GG })).toMatchSnapshot();
  });
  it('organic · newSignup on · with utm', () => {
    expect(getWelcomePageHtml(null, null, null, { newSignupEnabled: true, oauthProviders: OAUTH_BOTH, utmSource: 'lobehub', utmCampaign: 'launch' })).toMatchSnapshot();
  });
  it('post-checkout · key + tier + email', () => {
    expect(getWelcomePageHtml('av_live_deadbeefcafe0123456789ab', 'starter', 'buyer@example.com', { newSignupEnabled: true, oauthProviders: OAUTH_BOTH })).toMatchSnapshot();
  });
  it('pending · no key · tier + email', () => {
    expect(getWelcomePageHtml(null, 'starter', 'buyer@example.com', { newSignupEnabled: true, oauthProviders: OAUTH_BOTH })).toMatchSnapshot();
  });
});

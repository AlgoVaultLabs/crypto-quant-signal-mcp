/**
 * ACTIVATION-NUDGE-W1 + REFERRAL-INPRODUCT-NUDGE-W1 — unit tests for the approved
 * CTA copy builders. Pure functions: stats injected, no network. Asserts the
 * architect-approved verbatim copy, surface-specific attribution, the
 * trust→conversion track-record link, and the copy-rule guards (no "unlimited",
 * PFE-only, CTA-ended). REFERRAL-INPRODUCT-NUDGE-W1 adds the referral arm: the
 * referral-prominent + upgrade-retained limit copy (state-adaptive), the 4 aha
 * referral lines, and the allow-listed structured ReferralHint. Numbers are
 * SoT-derived (bonusCallsLabel / shareLink) — never hardcoded.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSoftNudge,
  buildAhaHint,
  buildAhaReferral,
  buildReferralHint,
  referralSignupUrl,
  nudgeSignupUrl,
  AHA_HIGH_CONVICTION_CONFIDENCE,
  SIGNUP_BASE,
  TRACK_RECORD_URL,
} from '../../src/lib/nudge-copy.js';
// OPS-QUOTA-EXHAUSTION-NOTICE-W1: the 100% wall message MOVED out of nudge-copy into the one
// notice contract — it needs the meter's reset instant and the live x402 rail, which a pure copy
// module cannot supply. `buildLimitMessage` is now a thin adapter over `buildQuotaNoticeMessage`.
import { buildLimitMessage } from '../../src/lib/quota-notice.js';
import { bonusCallsLabel, shareLink, REFERRAL_TERMS } from '../../src/lib/referral-constants.js';

const STATS = { pfeWr: '91.6', callCount: '246,331' };
const CODE = 'ABCD1234';
const BONUS = bonusCallsLabel();                      // SoT — '500'
const KEYED_LINK = shareLink(CODE, 'algovault.com');  // scheme-less display link

describe('nudgeSignupUrl', () => {
  it('builds the bare attribution URL per surface', () => {
    expect(nudgeSignupUrl('soft')).toBe('https://api.algovault.com/signup?plan=starter&upgrade_from=soft');
    expect(nudgeSignupUrl('aha')).toBe('https://api.algovault.com/signup?plan=starter&upgrade_from=aha');
    expect(nudgeSignupUrl('limit')).toBe('https://api.algovault.com/signup?plan=starter&upgrade_from=limit');
    expect(SIGNUP_BASE).toBe('https://api.algovault.com/signup');
    expect(TRACK_RECORD_URL).toBe('algovault.com/track-record');
  });
});

describe('referralSignupUrl (keyless get-your-link path)', () => {
  it('omits plan=starter (free path) + tags the referral CTA for funnel attribution', () => {
    expect(referralSignupUrl('limit')).toBe('https://api.algovault.com/signup?upgrade_from=limit_referral');
    expect(referralSignupUrl('aha_call')).toBe('https://api.algovault.com/signup?upgrade_from=aha_call_referral');
    expect(referralSignupUrl('limit')).not.toContain('plan=starter');
  });
});

describe('buildSoftNudge (80% soft nudge) — unchanged (upgrade-only)', () => {
  const msg = buildSoftNudge({ used: 80, total: 100, ...STATS });
  it('renders the approved copy verbatim with live values', () => {
    expect(msg).toBe(
      "You've used 80 of your 100 free calls this month. " +
      'Verify the proof first: 91.6% PFE win rate across 246,331+ on-chain calls at algovault.com/track-record. ' +
      'Upgrade to keep scanning → Starter, 3,000 calls/mo (30× the free tier), $9.99: ' +
      'https://api.algovault.com/signup?plan=starter&upgrade_from=soft',
    );
  });
  it('is CTA-ended (closes on the signup action URL) + carries upgrade_from=soft', () => {
    expect(msg.endsWith('upgrade_from=soft')).toBe(true);
  });
});

describe('buildAhaHint (celebrate-the-aha) — unchanged (keyless aha fallback)', () => {
  const msg = buildAhaHint(STATS);
  it('renders the approved aha copy verbatim with live values', () => {
    expect(msg).toBe(
      "That's a live BUY/SELL call — one of 246,331+ on AlgoVault's on-chain-verified track record (91.6% PFE win rate). " +
      'See every call before you commit: algovault.com/track-record. ' +
      'Keep scanning all month → Starter, 3,000 calls/mo, $9.99: ' +
      'https://api.algovault.com/signup?plan=starter&upgrade_from=aha',
    );
  });
});

describe('buildLimitMessage (100% limit) — the ONE exhaustion notice', () => {
  // Fixed clock + reset instant: the notice states a DATE, so a test that let the clock float
  // could only assert its shape, never that the date is the caller's own.
  const NOW = Date.parse('2026-08-02T00:00:00.000Z');
  const RESET_AT = NOW + 5 * 24 * 60 * 60 * 1000;
  const limit = (referralCode: string | null) =>
    buildLimitMessage({ used: 100, total: 100, referralCode, resetAtMs: RESET_AT, nowMs: NOW });
  const headline = 'Free monthly quota used: 100/100. Access returns 2026-08-07 (5 days).';
  const upgradeLine =
    'Recommended for sustained volume: Starter — 3,000 calls/month, card required: ' +
    'https://api.algovault.com/signup?plan=starter&upgrade_from=limit';
  const offer = `Keep going free: refer a friend — you both get ${BONUS} bonus calls.`;

  it("KEYED: renders the user's own give-get link, upgrade retained", () => {
    expect(limit(CODE)).toBe(
      `${headline}\n${upgradeLine}\n${offer} Your link: ${KEYED_LINK}`,
    );
  });

  it('KEYLESS: renders the get-your-link free-signup path (never a fake link)', () => {
    expect(limit(null)).toBe(
      `${headline}\n${upgradeLine}\n${offer} Create your free account for a referral link → ${referralSignupUrl('limit')}`,
    );
  });

  it('always retains BOTH arms (acquisition > revenue — neither is ever removed)', () => {
    for (const code of [CODE, null]) {
      const m = limit(code);
      expect(m).toContain('Starter — 3,000 calls/month');
      expect(m).toContain('upgrade_from=limit');
      expect(m.toLowerCase()).toContain('refer a friend');
    }
  });

  it('states usage and a computed reset date — the two facts the pre-wave copy omitted', () => {
    expect(limit(null)).toContain('used: 100/100');
    expect(limit(null)).toContain('Access returns 2026-08-07');
    // Not a hardcoded interval: a different reset instant renders a different date.
    expect(buildLimitMessage({ used: 100, total: 100, referralCode: null, resetAtMs: NOW + 864e5, nowMs: NOW }))
      .toContain('Access returns 2026-08-03 (1 days)');
  });

  it('never inlines the subscription price — it links, so the copy cannot rot', () => {
    for (const code of [CODE, null]) expect(limit(code)).not.toContain('$9.99');
  });
});

describe('buildAhaReferral (4 keyed aha lines — each keeps the proof anchor, Q3)', () => {
  it('(a) high-conviction call — renders the verdict + proof + link', () => {
    expect(buildAhaReferral({ from: 'aha_call', code: CODE, stats: STATS, verdict: 'BUY' })).toBe(
      'That\'s a high-conviction BUY call — 91.6% PFE win rate across 246,331+ on-chain-verified calls. ' +
      `Friends get ${BONUS} bonus calls with your link → ${KEYED_LINK}`,
    );
  });
  it('(b) multi-hit scan — renders k live calls + proof + link', () => {
    expect(buildAhaReferral({ from: 'aha_scan', code: CODE, stats: STATS, k: 4 })).toBe(
      'Your scan surfaced 4 live calls — all on-chain-verified, 91.6% PFE win rate. ' +
      `Pass it on: friends get ${BONUS} bonus calls → ${KEYED_LINK}`,
    );
  });
  it('(c) usage milestone — renders the milestone count + link', () => {
    expect(buildAhaReferral({ from: 'aha_milestone', code: CODE, stats: STATS, callCountUser: 25 })).toBe(
      'You\'ve pulled 25 calls with AlgoVault. Know a trader who\'d use it? ' +
      `They get ${BONUS} bonus calls with your link → ${KEYED_LINK}`,
    );
  });
  it('(d) verification peak — shipped-but-unwired copy renders (deferred trigger)', () => {
    expect(buildAhaReferral({ from: 'aha_verify', code: CODE, stats: STATS })).toBe(
      'Every call is on-chain-verified — 91.6% PFE WR across 246,331+. ' +
      `Share the proof: friends get ${BONUS} bonus calls → ${KEYED_LINK}`,
    );
  });
  it('every aha line carries the give-get link + bonus; a/b/d keep the PFE proof anchor', () => {
    for (const from of ['aha_call', 'aha_scan', 'aha_milestone', 'aha_verify'] as const) {
      const m = buildAhaReferral({ from, code: CODE, stats: STATS, verdict: 'SELL', k: 3, callCountUser: 50 });
      expect(m).toContain(KEYED_LINK);
      expect(m).toContain(BONUS);
      // a/b/d anchor on the on-chain PFE proof; the milestone (c) anchors on the
      // user's OWN engagement ("You've pulled N calls") — its credibility hook.
      if (from === 'aha_milestone') expect(m).toContain('pulled 50 calls with AlgoVault');
      else expect(m).toContain('91.6%');
    }
  });
});

describe('buildReferralHint (allow-listed structured field)', () => {
  it('KEYED → own give-get URL (https, agent-relayable); exactly 4 keys', () => {
    const h = buildReferralHint({ from: 'limit', code: CODE });
    expect(h).toEqual({
      cta: `Refer a friend — you both get ${BONUS} bonus calls`,
      link_or_path: shareLink(CODE),                // full https link
      bonus_calls: REFERRAL_TERMS.BONUS_CALLS,      // SoT number
      from: 'limit',
    });
    expect(Object.keys(h).sort()).toEqual(['bonus_calls', 'cta', 'from', 'link_or_path']);
  });
  it('KEYLESS → get-your-link free-signup path', () => {
    const h = buildReferralHint({ from: 'aha_call', code: null });
    expect(h.link_or_path).toBe(referralSignupUrl('aha_call'));
    expect(h.cta).toContain('Create a free account');
    expect(h.bonus_calls).toBe(REFERRAL_TERMS.BONUS_CALLS);
  });
  it('carries no outcome_* / profit (allow-list discipline)', () => {
    const blob = JSON.stringify(buildReferralHint({ from: 'limit', code: CODE })).toLowerCase();
    expect(blob).not.toContain('outcome_');
    expect(blob).not.toContain('profit');
  });
});

describe('AHA_HIGH_CONVICTION_CONFIDENCE (trigger-a gate)', () => {
  it('is set well above the ~52 track-record record gate (anti-random-ask)', () => {
    expect(AHA_HIGH_CONVICTION_CONFIDENCE).toBeGreaterThanOrEqual(60);
    expect(AHA_HIGH_CONVICTION_CONFIDENCE).toBeLessThanOrEqual(100);
  });
});

describe('copy-rule guards', () => {
  const upgradeNudges = [
    buildSoftNudge({ used: 80, total: 100, ...STATS }),
    buildAhaHint(STATS),
  ];
  const referralCopy = [
    buildLimitMessage({ used: 100, total: 100, referralCode: CODE, resetAtMs: Date.now() + 864e5 }),
    buildLimitMessage({ used: 100, total: 100, referralCode: null, resetAtMs: Date.now() + 864e5 }),
    buildAhaReferral({ from: 'aha_call', code: CODE, stats: STATS, verdict: 'BUY' }),
    buildAhaReferral({ from: 'aha_scan', code: CODE, stats: STATS, k: 3 }),
    buildAhaReferral({ from: 'aha_milestone', code: CODE, stats: STATS, callCountUser: 25 }),
    buildAhaReferral({ from: 'aha_verify', code: CODE, stats: STATS }),
  ];

  it('never says "unlimited" anywhere', () => {
    for (const m of [...upgradeNudges, ...referralCopy]) expect(m.toLowerCase()).not.toContain('unlimited');
  });

  it('is PFE-only — never leaks outcome_return_pct / outcome_price / "profit"', () => {
    for (const m of [...upgradeNudges, ...referralCopy]) {
      expect(m).not.toContain('outcome_return_pct');
      expect(m).not.toContain('outcome_price');
      expect(m.toLowerCase()).not.toContain('profit');
    }
  });

  it('upgrade nudges keep the track-record trust link + signup CTA', () => {
    for (const m of upgradeNudges) {
      expect(m).toContain('algovault.com/track-record');
      expect(m).toContain('signup?plan=starter&upgrade_from=');
      expect(m).toContain('$9.99');
    }
  });

  it('referral copy carries the bonus number from SoT + a give-get/get-your-link target', () => {
    for (const m of referralCopy) {
      expect(m).toContain(BONUS);
      expect(m).toMatch(/algovault\.com\/join\?ref=|signup\?upgrade_from=/);
    }
  });
});

/**
 * CONTACT-ANTISPAM-AND-REPLY-TO-W1 CH1 — the spam scorer's contract.
 *
 * These are not "does it compile" tests. The scorer decides whether a lead reaches the operator
 * at all, so the properties that matter are:
 *
 *   AC1.2   the LIVE campaign's exact shape quarantines
 *   AC1.3   a realistic enterprise lead with a short message AND a link does NOT
 *   AC1.4   no single weak rule reaches the threshold alone
 *   AC1.4b  no COMBINATION of weak rules reaches it either — and that assertion is proven able
 *           to fail, because an invariant nobody has watched break is a wish
 *
 * The fixtures use production values verbatim (name/company/monthly_volume from the 2026-08
 * campaign, addresses from the live table) rather than `foo@bar.com`. A rule tuned against
 * invented data is tuned against nothing.
 */
import { describe, it, expect } from 'vitest';
import {
  scoreLead, serializeReasons, SPAM_RULES, QUARANTINE_THRESHOLD, WEAK_RULE_SUM,
  LOOKBACK_HOURS, EMPTY_LOOKBACK,
  type SpamRule, type ScoredLeadFields, type LeadLookback,
} from '../../src/lib/contact-spam.js';

/** The live campaign, byte-for-byte as `contact_leads` recorded it (ids 9, 12, 14-76). */
const CAMPAIGN: ScoredLeadFields = {
  name: 'Roberttic',
  company: 'google',
  monthlyVolume: 'Roberttic',
  message: 'I would like to know more about pricing',
  src: 'unknown',
};

/** A real enterprise enquiry. Long message, distinct volume, no URL. */
const GENUINE: ScoredLeadFields = {
  name: 'Ada Lovelace',
  company: 'Analytical Engines',
  monthlyVolume: '250,000',
  message: 'We need 500k calls/month across 12 venues and want to discuss enterprise terms.',
  src: 'unknown',
};

/** The predicate AC1.4b pins, extracted so it can be run against a MUTATED table too. */
function weakSumOf(rules: readonly SpamRule[]): number {
  return rules.filter((r) => r.tier === 'weak').reduce((s, r) => s + r.score, 0);
}

describe('AC1.2 — the live campaign shape quarantines', () => {
  it('name === monthly_volume alone reaches the threshold, with no lookback at all', () => {
    const v = scoreLead(CAMPAIGN, EMPTY_LOOKBACK);
    expect(v.score).toBeGreaterThanOrEqual(QUARANTINE_THRESHOLD);
    expect(v.quarantined).toBe(true);
    expect(v.reasons).toContain('same-name-volume');
  });

  it('matches case-insensitively and after trimming, which is how the rule is stated', () => {
    const v = scoreLead({ ...CAMPAIGN, monthlyVolume: '  ROBERTTIC  ' }, EMPTY_LOOKBACK);
    expect(v.quarantined).toBe(true);
  });

  it('the full live picture — rotation + ip velocity — scores well past the threshold', () => {
    // Measured 2026-08-25: (Roberttic, google) carried 24 distinct addresses and one ip_hash
    // carried 61 of 68 rows.
    const v = scoreLead(CAMPAIGN, { distinctEmailsForIdentity: 24, leadsFromIpHash: 61 });
    expect(v.score).toBe(140); // 50 + 50 + 40
    expect(v.reasons).toEqual(['same-name-volume', 'identity-rotation', 'ip-velocity']);
    expect(serializeReasons(v.reasons)).toBe('same-name-volume,identity-rotation,ip-velocity');
  });

  it('does NOT fire when the volume field is empty — both sides must be non-empty', () => {
    // Live row id 10 ("Albertha Jacka", company == name, volume EMPTY) is the guard against a
    // sloppier "any two fields match" rule. It must not quarantine.
    const v = scoreLead(
      { name: 'Albertha Jacka', company: 'Albertha Jacka', monthlyVolume: null,
        message: 'Upgrade algovault.com SEO performance, expand your search visibility.', src: 'unknown' },
      EMPTY_LOOKBACK,
    );
    expect(v.reasons).not.toContain('same-name-volume');
    expect(v.quarantined).toBe(false);
  });
});

describe('AC1.3 — a genuine lead is not quarantined', () => {
  it('a real enterprise enquiry scores 0', () => {
    const v = scoreLead(GENUINE, EMPTY_LOOKBACK);
    expect(v.score).toBe(0);
    expect(v.reasons).toEqual([]);
    expect(serializeReasons(v.reasons)).toBeNull();
  });

  it('a short message AND a link scores exactly 30 and is NOT quarantined', () => {
    // 16 chars — over the thin-message bound, so ONLY link-drop fires.
    const linkOnly = scoreLead({ ...GENUINE, message: 'see https://x.co' }, EMPTY_LOOKBACK);
    expect(linkOnly.reasons).toEqual(['link-drop']);
    expect(linkOnly.score).toBe(20);

    // 12 chars — both weak rules fire. This is the AC1.3 case.
    const shortAndLinked = scoreLead({ ...GENUINE, message: 'https://x.co' }, EMPTY_LOOKBACK);
    expect(shortAndLinked.reasons).toEqual(['link-drop', 'thin-message']);
    expect(shortAndLinked.score).toBe(30);
    expect(shortAndLinked.quarantined).toBe(false);
  });

  it('four leads from one office NAT do not quarantine — ip-velocity needs five', () => {
    const v = scoreLead(GENUINE, { distinctEmailsForIdentity: 1, leadsFromIpHash: 4 });
    expect(v.score).toBe(0);
    expect(v.quarantined).toBe(false);
  });

  it('ip-velocity ALONE is deliberately sub-threshold', () => {
    const v = scoreLead(GENUINE, { distinctEmailsForIdentity: 1, leadsFromIpHash: 61 });
    expect(v.reasons).toEqual(['ip-velocity']);
    expect(v.score).toBe(40);
    expect(v.quarantined).toBe(false);
  });

  it('a lookback that failed to measure contributes nothing', () => {
    const v = scoreLead(GENUINE, EMPTY_LOOKBACK);
    expect(v.score).toBe(0);
    // The fail-open value is the ZERO value, not a sentinel a rule could accidentally match.
    expect(EMPTY_LOOKBACK.distinctEmailsForIdentity).toBe(0);
    expect(EMPTY_LOOKBACK.leadsFromIpHash).toBe(0);
  });
});

describe('AC1.4 — no single weak rule reaches the threshold alone', () => {
  it.each(SPAM_RULES.filter((r) => r.tier === 'weak').map((r) => [r.id, r.score] as const))(
    'weak rule %s scores %i, below the threshold',
    (_id, score) => {
      expect(score).toBeLessThan(QUARANTINE_THRESHOLD);
    },
  );

  it('every corroborating rule is also sub-threshold on its own', () => {
    for (const r of SPAM_RULES.filter((x) => x.tier === 'corroborating')) {
      expect(r.score, r.id).toBeLessThan(QUARANTINE_THRESHOLD);
    }
  });

  it('every decisive rule genuinely IS decisive — the tier is not decoration', () => {
    const decisive = SPAM_RULES.filter((r) => r.tier === 'decisive');
    expect(decisive.length).toBeGreaterThan(0);
    for (const r of decisive) expect(r.score, r.id).toBeGreaterThanOrEqual(QUARANTINE_THRESHOLD);
  });
});

describe('AC1.4b — no COMBINATION of weak rules can quarantine', () => {
  it('the live rule table satisfies the invariant', () => {
    expect(WEAK_RULE_SUM).toBe(weakSumOf(SPAM_RULES));
    expect(WEAK_RULE_SUM).toBeLessThan(QUARANTINE_THRESHOLD);
  });

  it('firing EVERY weak rule at once still does not quarantine', () => {
    // link-drop (URL + unclassified src) + thin-message (<15) + turnstile-unverified (tag).
    const v = scoreLead(
      { name: 'Ada', company: 'AE', monthlyVolume: '250k', message: 'https://x.co', src: 'unknown' },
      EMPTY_LOOKBACK,
      ['turnstile-unverified'],
    );
    expect(v.reasons).toEqual(['link-drop', 'thin-message', 'turnstile-unverified']);
    expect(v.score).toBe(WEAK_RULE_SUM);
    expect(v.quarantined).toBe(false);
  });

  it('PROVEN ABLE TO FAIL — retuning a weak rule upward trips the invariant', () => {
    // The failure mode this guards is a later wave nudging `thin-message` to <50 "to catch more",
    // or adding a sixth weak rule, and silently crossing the threshold by accumulation. Run the
    // SAME predicate over a mutated table and require it to flip.
    const mutated: SpamRule[] = SPAM_RULES.map((r) =>
      r.id === 'thin-message' ? { ...r, score: 30 } : { ...r });
    expect(weakSumOf(mutated)).toBeGreaterThanOrEqual(QUARANTINE_THRESHOLD);

    const withSixthWeakRule: SpamRule[] = [
      ...SPAM_RULES,
      { id: 'link-drop', score: 15, tier: 'weak', observedHits: 0,
        lastMeasured: '2026-08-25', corpusSize: 0, why: 'synthetic sixth weak rule' },
    ];
    expect(weakSumOf(withSixthWeakRule)).toBeGreaterThanOrEqual(QUARANTINE_THRESHOLD);
  });
});

describe('the rule table is self-describing — observedHits / lastMeasured', () => {
  it('every rule carries a measurement with its denominator', () => {
    for (const r of SPAM_RULES) {
      expect(r.lastMeasured, r.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.observedHits, r.id).toBeGreaterThanOrEqual(0);
      expect(r.corpusSize, r.id).toBeGreaterThanOrEqual(0);
      // A hit count can never exceed the corpus it was measured over. This catches a stale
      // figure carried forward past a retune more reliably than reading the comment does.
      expect(r.observedHits, r.id).toBeLessThanOrEqual(r.corpusSize);
      expect(r.why.length, r.id).toBeGreaterThan(40);
    }
  });

  it('records that thin-message is DORMANT — 0 hits on a real 68-row corpus', () => {
    // Not a bug and not decoration: a declared forward-guard. Pinned so a later wave reads the
    // zero as intentional rather than as a scorer defect, and so retuning it must come here.
    const thin = SPAM_RULES.find((r) => r.id === 'thin-message');
    expect(thin?.observedHits).toBe(0);
    expect(thin?.corpusSize).toBe(68);
    expect(thin?.tier).toBe('weak');
  });

  it('records that same-name-volume carried the whole campaign', () => {
    const rule = SPAM_RULES.find((r) => r.id === 'same-name-volume');
    expect(rule?.observedHits).toBe(65);
    expect(rule?.tier).toBe('decisive');
  });

  it('reason ids are unique and the vocabulary is closed', () => {
    const ids = SPAM_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the lookback window is 24h — CH2 and the store both read this constant', () => {
    expect(LOOKBACK_HOURS).toBe(24);
    expect(QUARANTINE_THRESHOLD).toBe(50);
  });
});

describe('the scorer is total — it never throws', () => {
  const hostile: Array<[string, ScoredLeadFields, LeadLookback]> = [
    ['empty everything', { name: '', company: null, monthlyVolume: null, message: '', src: null }, EMPTY_LOOKBACK],
    ['NaN lookback', GENUINE, { distinctEmailsForIdentity: NaN, leadsFromIpHash: NaN }],
    ['negative lookback', GENUINE, { distinctEmailsForIdentity: -5, leadsFromIpHash: -5 }],
    ['huge message', { ...GENUINE, message: 'x'.repeat(100_000) }, EMPTY_LOOKBACK],
    ['CRLF in name', { ...GENUINE, name: 'a\r\nBcc: x@y.z' }, EMPTY_LOOKBACK],
  ];
  it.each(hostile)('%s', (_label, fields, lookback) => {
    expect(() => scoreLead(fields, lookback)).not.toThrow();
    const v = scoreLead(fields, lookback);
    expect(Number.isFinite(v.score)).toBe(true);
    expect(v.score).toBeGreaterThanOrEqual(0);
  });

  it('an unknown tag is ignored rather than throwing', () => {
    // A live serving path REFUSES, it does not THROW (CLAUDE.md). CH2 could pass a reason id
    // this table has not learned yet during a partial rollout.
    const v = scoreLead(GENUINE, EMPTY_LOOKBACK, ['not-a-real-rule' as never]);
    expect(v.score).toBe(0);
    expect(v.reasons).toEqual([]);
  });

  it('reasons come out in rule-table order regardless of which fired first', () => {
    const v = scoreLead(
      { ...CAMPAIGN, message: 'https://x.co' },
      { distinctEmailsForIdentity: 24, leadsFromIpHash: 61 },
      ['turnstile-unverified'],
    );
    const tableOrder = SPAM_RULES.map((r) => r.id).filter((id) => v.reasons.includes(id));
    expect(v.reasons).toEqual(tableOrder);
  });
});

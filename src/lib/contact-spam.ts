/**
 * Contact-form spam scoring — CONTACT-ANTISPAM-AND-REPLY-TO-W1 CH1.
 *
 * PURE BY CONSTRUCTION. No DB access, no `process.env`, no throw, and no import of
 * `contact-submit.ts` (which imports the caller — that would be a cycle). Everything this module
 * needs about the world arrives as an argument, which is what makes every rule assertable against
 * verbatim production data in a unit test rather than only observable in prod.
 *
 * WHAT THIS IS FOR. `handleContactSubmission` persists first and judges second, so by the time a
 * score exists the lead is already durable. A score at or above {@link QUARANTINE_THRESHOLD}
 * therefore never destroys anything — it only suppresses the NOTIFICATION. That asymmetry is the
 * whole design: a false negative costs one email in the operator's inbox, a false positive costs
 * an enterprise lead. Every threshold below is chosen from that direction.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE THREE TIERS, AND WHY THE TIER IS DATA RATHER THAN A COMMENT
 *
 *   decisive      — reaches the threshold ALONE. Reserved for a fingerprint no human produces.
 *   corroborating — substantial but sub-threshold. Needs one more signal to quarantine.
 *   weak          — must NEVER quarantine, even if every weak rule fires at once.
 *
 * `sum(weak) < QUARANTINE_THRESHOLD` is an INVARIANT, asserted by
 * tests/unit/contact-spam.test.ts, not a property anyone is asked to remember. Retuning a weak
 * rule upward, or adding a sixth one, turns that test RED instead of silently crossing the
 * threshold. CLAUDE.md: prose addressed to whoever happens to read it is not a control.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * ON `observedHits` / `lastMeasured`. Every rule carries the number of rows it fired on over the
 * REAL table at a stated date and corpus size. A rule table without those numbers cannot
 * distinguish "this rule is load-bearing" from "this rule has never once fired", and this wave
 * shipped one of each. Re-measure when you retune; do not carry a stale figure forward.
 */

/** Hours of history the lookback rules see. Bounded, because a campaign is a burst, not a career. */
export const LOOKBACK_HOURS = 24;

/**
 * Score at or above which a lead is stored but NOT notified.
 *
 * Frozen in CH1 and imported by CH2 — a second copy of this number is a second thing that drifts.
 */
export const QUARANTINE_THRESHOLD = 50;

/**
 * The closed reason vocabulary. Persisted into `contact_leads.spam_reasons`, so these strings are
 * a STORAGE FORMAT: renaming one silently orphans every historical row that carries it.
 *
 * `turnstile-unverified` is scored here but DETERMINED in CH2 (`src/lib/turnstile.ts`) — the
 * challenge outcome is not a property of the submitted fields, so it arrives through `tags`.
 */
export type SpamReasonId =
  | 'same-name-volume'
  | 'identity-rotation'
  | 'ip-velocity'
  | 'link-drop'
  | 'thin-message'
  | 'turnstile-unverified';

export type SpamRuleTier = 'decisive' | 'corroborating' | 'weak';

export interface SpamRule {
  readonly id: SpamReasonId;
  readonly score: number;
  readonly tier: SpamRuleTier;
  /** Rows this rule fired on over the live `contact_leads` table, measured on `lastMeasured`. */
  readonly observedHits: number;
  /** ISO date of that measurement. */
  readonly lastMeasured: string;
  /** Total rows scored to produce `observedHits`. A hit count without its denominator is noise. */
  readonly corpusSize: number;
  readonly why: string;
}

/**
 * The rule table. Ordered decisive → weak.
 *
 * Every `observedHits` below was measured on 2026-08-25 by scoring the live 68-row
 * `contact_leads` table with each rule's lookback evaluated AS OF that row's own `created_at` —
 * never as-of now, which would score a 2026-08-10 row against 2026-08-25 traffic and quietly
 * answer a different question.
 */
export const SPAM_RULES: readonly SpamRule[] = [
  {
    id: 'same-name-volume',
    score: 50,
    tier: 'decisive',
    observedHits: 65,
    lastMeasured: '2026-08-25',
    corpusSize: 68,
    why:
      'The submitted name is byte-equal (case-insensitive, trimmed) to "Expected calls per month". '
      + 'No human types their own name into a volume field; a naive form-filler replaying one token '
      + 'into every text input does. This alone identified all 65 spam rows in the corpus — the '
      + 'other four rules contributed zero additional quarantines and are forward-guards.',
  },
  {
    id: 'identity-rotation',
    score: 50,
    tier: 'decisive',
    observedHits: 55,
    lastMeasured: '2026-08-25',
    corpusSize: 68,
    why:
      'The same (name, company) arrived with >= 3 DISTINCT email addresses inside the lookback. '
      + 'This targets the CAMPAIGN rather than the submission: the attacker\'s rotation is itself '
      + 'the signal, and rotating harvested third-party addresses is precisely what makes the '
      + 'acknowledgement email unshippable. Measured: (Roberttic, google) carried 24 distinct '
      + 'addresses; every other identity in the corpus carried exactly one.',
  },
  {
    id: 'ip-velocity',
    score: 40,
    tier: 'corroborating',
    observedHits: 55,
    lastMeasured: '2026-08-25',
    corpusSize: 68,
    why:
      'At least 5 leads from one ip_hash inside the lookback. Independent of email rotation, so it '
      + 'survives an attacker who stops reusing addresses. Sub-threshold ON PURPOSE: a shared '
      + 'corporate NAT can legitimately produce several leads in a day, and that must cost a second '
      + 'signal rather than a lost enterprise lead. Measured: one ip_hash carried 61 of 68 rows and '
      + 'no other exceeded 2 — on /contact `req.ip` is the real client (Caddy forwards '
      + 'CF-Connecting-IP for this route specifically), so this is a per-client count, not per-PoP.',
  },
  {
    id: 'link-drop',
    score: 20,
    tier: 'weak',
    observedHits: 3,
    lastMeasured: '2026-08-25',
    corpusSize: 68,
    why:
      'The message body contains an http(s) URL and the channel is unclassified. '
      + 'HONEST LIMITATION: the second conjunct is VACUOUSLY TRUE today — `landing_pricing` is '
      + 'absent from ATTRIBUTION_SOURCES, so every /contact lead records src=unknown by '
      + 'default-deny (68 of 68 in the corpus). Until OPS-CONTACT-SRC-ALLOWLIST-W{NEXT} lands this '
      + 'is a ONE-factor rule, and calling it two-factor would be a claim the data does not '
      + 'support. Weak by construction: all 3 rows it fired on are plausibly real outreach.',
  },
  {
    id: 'thin-message',
    score: 10,
    tier: 'weak',
    observedHits: 0,
    lastMeasured: '2026-08-25',
    corpusSize: 68,
    why:
      'Message shorter than 15 characters. DORMANT, NOT DEAD — it fired on 0 of 68 rows because '
      + 'this campaign\'s messages run 27-46 characters, not because the shape is unreal: a bare '
      + '"hi" is a real spam shape and this is what catches it. Kept as a declared forward-guard so '
      + 'no later wave reads a zero as a live signal. Do NOT retune it upward without first '
      + 'plotting the length histogram — a nudge is not a calibration, and the weak-sum invariant '
      + 'below is what stops one from crossing the threshold by accident.',
  },
  {
    id: 'turnstile-unverified',
    score: 10,
    tier: 'weak',
    observedHits: 0,
    lastMeasured: '2026-08-25',
    corpusSize: 68,
    why:
      'The Cloudflare challenge could not be evaluated — siteverify was unreachable, timed out or '
      + '5xx\'d, or no token was submitted at all. CH2 contributes this through `tags`; it is never '
      + 'derived from the submitted fields. Weak because it means WE could not verify, not that the '
      + 'visitor failed: a Cloudflare outage, a blocked script or a JS-off browser must never close '
      + 'the contact form. 0 hits at CH1 time because CH2 had not shipped.',
  },
];

/** Index for O(1) score lookup by id. Derived from the table above — never a second literal. */
const RULE_BY_ID: ReadonlyMap<SpamReasonId, SpamRule> = new Map(
  SPAM_RULES.map((r) => [r.id, r] as const),
);

/** The invariant AC1.4b pins: no combination of weak rules may ever quarantine. */
export const WEAK_RULE_SUM: number = SPAM_RULES
  .filter((r) => r.tier === 'weak')
  .reduce((sum, r) => sum + r.score, 0);

/** The submitted fields, already trimmed and capped by the caller. */
export interface ScoredLeadFields {
  readonly name: string;
  readonly company: string | null;
  readonly monthlyVolume: string | null;
  readonly message: string;
  readonly src: string | null;
}

/**
 * What the store measured over the lookback window.
 *
 * Both counts are computed IN SQL over the full window — never by counting rows from a
 * LIMIT-capped fetch, which would silently under-report exactly when a campaign is at its worst.
 * Both default to 0, which is the fail-open value: a DB hiccup contributes nothing to the score.
 */
export interface LeadLookback {
  /** Distinct email addresses seen for this (name, company) inside the window, this lead included. */
  readonly distinctEmailsForIdentity: number;
  /** Leads seen from this ip_hash inside the window, this lead included. */
  readonly leadsFromIpHash: number;
}

/** The fail-open lookback. A scoring input we could not measure must never accuse anyone. */
export const EMPTY_LOOKBACK: LeadLookback = {
  distinctEmailsForIdentity: 0,
  leadsFromIpHash: 0,
};

export interface SpamVerdict {
  readonly score: number;
  /** Reason ids in rule-table order, so `spam_reasons` is stable across runs and comparable. */
  readonly reasons: readonly SpamReasonId[];
  readonly quarantined: boolean;
}

/** Deliberately narrow: only what was measured. Widening it invalidates `link-drop.observedHits`. */
const URL_IN_MESSAGE = /https?:\/\//i;

const THIN_MESSAGE_MAX_CHARS = 15;
const IDENTITY_ROTATION_MIN_EMAILS = 3;
const IP_VELOCITY_MIN_LEADS = 5;

function norm(v: string | null | undefined): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/**
 * Score one lead. Total, pure, and non-throwing — there is no input for which this raises.
 *
 * @param tags Reason ids determined OUTSIDE the field/lookback data — today only
 *   `turnstile-unverified` from CH2. Unknown ids are ignored rather than throwing: this runs on a
 *   live serving path after the lead is already durable, and a guard there refuses, it does not
 *   throw (CLAUDE.md).
 */
export function scoreLead(
  fields: ScoredLeadFields,
  lookback: LeadLookback = EMPTY_LOOKBACK,
  tags: readonly SpamReasonId[] = [],
): SpamVerdict {
  const fired = new Set<SpamReasonId>();

  const name = norm(fields.name);
  const volume = norm(fields.monthlyVolume);
  if (name !== '' && volume !== '' && name === volume) fired.add('same-name-volume');

  if (lookback.distinctEmailsForIdentity >= IDENTITY_ROTATION_MIN_EMAILS) fired.add('identity-rotation');

  if (lookback.leadsFromIpHash >= IP_VELOCITY_MIN_LEADS) fired.add('ip-velocity');

  if (URL_IN_MESSAGE.test(fields.message) && norm(fields.src) === 'unknown') fired.add('link-drop');

  if (fields.message.length < THIN_MESSAGE_MAX_CHARS) fired.add('thin-message');

  for (const tag of tags) if (RULE_BY_ID.has(tag)) fired.add(tag);

  // Iterate the TABLE, not the set — that fixes the output order to the table's order and makes
  // `spam_reasons` byte-stable for a given set of fired rules.
  const reasons = SPAM_RULES.filter((r) => fired.has(r.id)).map((r) => r.id);
  const score = reasons.reduce((sum, id) => sum + (RULE_BY_ID.get(id)?.score ?? 0), 0);

  return { score, reasons, quarantined: score >= QUARANTINE_THRESHOLD };
}

/** Serialize reasons for `contact_leads.spam_reasons`. Comma-joined, no spaces, greppable. */
export function serializeReasons(reasons: readonly SpamReasonId[]): string | null {
  return reasons.length > 0 ? reasons.join(',') : null;
}

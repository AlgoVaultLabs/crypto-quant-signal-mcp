/**
 * PRICING-BOT-DELIVERY-METERING-W1 CH1 — the ONE declaration of how each channel debits
 * entitlement.
 *
 * WHY THIS EXISTS. Before it, this codebase had FOUR independent per-channel metering
 * decisions, each made in a different file and none forced to declare itself: `mcp` charges
 * inline via `trackCall`, `webhook` out-of-band via `trackCallByKey`, `httpX402` settles on
 * its own rail, and `bot` kept a separate meter in its own SQLite. `a2mcp` and `acp` are
 * declared in `feature-registry.ts` and were never decided at all. One of the four
 * (`webhook`) double-charges on redelivery, because `trackCallByKey` has no idempotency key.
 *
 * The bug class this retires: *"a channel consumes entitlement through a ledger that is not
 * the entitlement's ledger, decided ad hoc, with no replay guard."*
 *
 * `Record<ChannelId, …>` is exhaustive BY CONSTRUCTION. Adding a channel to
 * `feature-registry.ts` and forgetting it here is a `tsc` error, not a silent default — that
 * is the entire point, and it must never be softened to `Partial`. The companion drift gate
 * (`scripts/check-entitlement-channel-drift.mjs`) closes the other direction: a policy for a
 * channel that no longer exists FAILS too, because a stale entry rots into a permission slip.
 *
 * LEAF MODULE. Imports nothing but types — same discipline as `plans.ts`. It must never
 * import `license.ts` (which would invert the dependency), must never hold an allowance
 * NUMBER (those live in `plans.ts`), and must never branch on tier (that is the meter's job).
 */

/**
 * The channel axis. These keys are the SAME set as every `FEATURE_REGISTRY[*].channels`
 * object's keys, and the drift gate asserts that identity in both directions on every push.
 */
export type ChannelId = 'mcp' | 'httpX402' | 'bot' | 'webhook' | 'a2mcp' | 'acp';

/**
 * HOW a channel's usage reaches the meter.
 *
 * The distinction that matters is `request-context` vs `by-key`: the first is charged inline
 * from the request's own license and needs no idempotency key because the request IS the
 * event; the second is charged out-of-band, after the fact, against an explicit tracker key —
 * which means it can be replayed, which means it needs a claim.
 */
export type DebitMode =
  /** Charged inline by `trackCall()` from the request's own license. */
  | 'request-context'
  /** Charged out-of-band against an explicit tracker key. Replayable ⇒ needs a claim. */
  | 'by-key'
  /** Paid on its own rail; the plan meter is not this channel's ledger. */
  | 'settled'
  /** Declared as not-yet-live. `consumeEntitlement` REFUSES this channel. */
  | 'none';

export interface ChannelBillingPolicy {
  readonly debitMode: DebitMode;
  /**
   * Does exhaustion REFUSE on this channel, or merely count past the ceiling?
   *
   * This is deliberately per-channel rather than global. The asymmetry it encodes is real and
   * ratified — see the `mcp` and `bot` rationales below.
   */
  readonly refusesAtWall: boolean;
  /** Prose nobody can omit — WHY this channel debits the way it does. */
  readonly rationale: string;
}

export const CHANNEL_BILLING_POLICY: Readonly<Record<ChannelId, ChannelBillingPolicy>> = Object.freeze({
  mcp: {
    debitMode: 'request-context',
    refusesAtWall: false,
    rationale:
      'Charged inline by trackCall() from the request context. Does NOT refuse a paid tier at ' +
      'the ceiling because PAID_TIERS_ARE_HARD_WALLED = false in license.ts. Flipping that is a ' +
      'NEW customer-facing refusal on the revenue path and was deliberately NOT this wave\'s ' +
      'decision (architect R-1, 2026-08-16, scoped the hard wall to the bot). Making mcp wall ' +
      'later is a one-field change HERE, not a call-site change. Follow-up: PRICING-PAID-HARD-WALL-W1.',
  },
  httpX402: {
    debitMode: 'settled',
    refusesAtWall: false,
    rationale:
      'getMonthlyQuota(\'x402\') === Infinity — settled per-payment on-chain (USDC on Base), so ' +
      'the subscription plan meter is not this channel\'s ledger and must never be touched by it. ' +
      'Its replay guard is the EIP-3009 nonce in processed_x402_payments, not entitlement_debits.',
  },
  bot: {
    debitMode: 'by-key',
    refusesAtWall: true,
    rationale:
      'Architect ruling R-1, 2026-08-16: a paid-linked Telegram delivery consumes the ' +
      'subscriber\'s plan, and the subscriber is HARD WALLED at the ceiling with one notice per ' +
      'exhaustion episode. The billable unit is a DELIVERED ALERT, never a poll — the bot makes ' +
      '~4,038 MCP requests to deliver ~211 alerts (measured 2026-08-16), and polls are ' +
      'unattributable per user by construction because scanwatch groups one upstream call across ' +
      'every subscriber watching it. See docs/METERING-DIVERGENCE.md in the algovault-bot repo.',
  },
  webhook: {
    debitMode: 'by-key',
    refusesAtWall: true,
    rationale:
      'Pre-existing behaviour, RECORDED here rather than changed: checkQuotaByKey walls every ' +
      'tier (it has no PAID_TIERS_ARE_HARD_WALLED escape), and deliverOne PAUSES the ' +
      'subscription on exhaustion. This wave gives it the replay-safety it lacked — a ' +
      'redelivery used to charge twice — and changes nothing else about it.',
  },
  a2mcp: {
    debitMode: 'none',
    refusesAtWall: false,
    rationale:
      'Declared in feature-registry.ts and staged for the okx.ai listing, but no wave has ' +
      'decided how it debits. consumeEntitlement REFUSES it rather than guessing a mode. ' +
      'Deciding it later is a one-row change here plus a test — the primitive already works.',
  },
  acp: {
    debitMode: 'none',
    refusesAtWall: false,
    rationale:
      'Declared in feature-registry.ts, no debit decision made. Same posture as a2mcp: REFUSED ' +
      'until a wave rules, never silently defaulted onto someone\'s plan.',
  },
});

/** The policy for a known channel. Total over `ChannelId`, so this cannot return undefined. */
export function policyFor(channel: ChannelId): ChannelBillingPolicy {
  return CHANNEL_BILLING_POLICY[channel];
}

/**
 * Narrow an UNTRUSTED string (an HTTP body field, a queue row) to a `ChannelId`.
 *
 * Default-deny: unknown → `null`, never a fallback channel. A fallback here would let a
 * typo'd or hostile `channel` field debit somebody's plan through whichever policy happened
 * to be the default — the exact shape of accident this registry exists to make impossible.
 */
export function asChannelId(raw: unknown): ChannelId | null {
  return typeof raw === 'string' && Object.prototype.hasOwnProperty.call(CHANNEL_BILLING_POLICY, raw)
    ? (raw as ChannelId)
    : null;
}

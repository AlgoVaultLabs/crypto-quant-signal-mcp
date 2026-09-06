/**
 * FUNNEL-TRUTH-AND-PAID-ATTRIBUTION-W1 CH3 — the ONE definition of "human checkout intent".
 *
 * ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────────────────────
 * Four places read `signup_attribution` to answer a question about checkout intent, and before
 * this wave they answered it three different ways:
 *
 *   1. `funnel-scoreboard.ts` — the human funnel's `Subscribe click` stage: `COUNT(*)`, ALL tiers
 *   2. `funnel-snapshot.ts`   — stage 8 `stripe_checkout_started`: `COUNT(DISTINCT
 *                               client_reference_id)`, PAID tiers only
 *   3. `funnel-scoreboard.ts` — `by_channel` (the "direct 86.7 %" figure): every row, no filter
 *   4. `funnel-scoreboard.ts` — `ai_referral`: every row, no filter
 *
 * (1) and (2) disagreed on both the aggregate and the population, so the scoreboard and the
 * weekly snapshot could never be reconciled; (3) and (4) shared (1)'s denominator. None of them
 * could distinguish a human from a crawler, because until CH1 nothing recorded which was which.
 *
 * Re-keying the stage alone would have been worse than leaving it: a dashboard whose headline
 * counts humans while the channel split beside it counts requests contradicts itself in a way a
 * reader cannot see. So all four project from the fragments below — CLAUDE.md's single-derivation
 * rule, applied to a definition rather than to a function.
 *
 * ── WHAT THE DEFINITION IS, AND WHY ─────────────────────────────────────────────────────────
 * `COUNT(DISTINCT client_reference_id)` over PAID tiers, filtered to `classification = 'browser'`.
 *
 *   - DISTINCT, because `client_reference_id` is the attribution key everything downstream joins
 *     on, so counting rows instead would count re-clicks as separate intents.
 *   - PAID tiers, because `src/lib/deferred-signup.ts` writes `free` rows into the same table and
 *     those are not checkout starts at all. This filter is load-bearing, not cosmetic.
 *   - `browser`, because that is the only class with positive evidence of a human navigation.
 *
 * ── THE OTHER TWO CLASSES ARE REPORTED, NEVER FOLDED IN ─────────────────────────────────────
 * `unknown` is the fail-open residual: no positive bot signal, so it still got a live Checkout
 * Session, and it is the honest size of what CH1 did NOT close. `raw` is every class including
 * pre-CH1 NULL rows, and it exists so the historical series stays readable across the cutover —
 * add before you remove. Folding either into the human number would recreate exactly the
 * unclassified denominator this wave was dispatched to retire.
 *
 * PURE DATA. No imports, no I/O — a LEAF, so both funnel modules can consume it without any
 * chance of an import cycle.
 */

/** Tiers that represent a real paid checkout start. `free` rows come from deferred-signup. */
export const SIGNUP_PAID_TIERS: readonly string[] = Object.freeze(['starter', 'pro', 'enterprise']);

/** The `classification` value written by `classifyBrowserIntent` for a real navigation. */
export const HUMAN_INTENT_CLASS = 'browser';

/** The fail-open residual: no positive bot signal, so it still received a Checkout Session. */
export const UNKNOWN_INTENT_CLASS = 'unknown';

/**
 * SQL predicate: rows that are checkout starts at all (excludes the `free` deferred-signup rows).
 *
 * DERIVED from `SIGNUP_PAID_TIERS` rather than spelled out again. The two were briefly written
 * separately and `scripts/check-dark-artifacts` caught the constant with no consumer — which was
 * the right verdict for the wrong-looking reason: an unused export here is the visible half of a
 * duplicated fact, and adding a tier to one list while the other kept the old three would silently
 * exclude a real paid tier from every intent count on the dashboard.
 */
export const PAID_TIER_PREDICATE = `tier_requested IN (${SIGNUP_PAID_TIERS.map((t) => `'${t}'`).join(', ')})`;

/**
 * SQL predicate for one intent class.
 *
 * NULL is NEVER equal to anything in SQL, so a pre-CH1 row (written before the column existed)
 * matches no class — which is correct and deliberate: it is genuinely unclassified, not a bot and
 * not a human. Only the `raw` series counts it, and it is labelled as such on the dashboard.
 */
export function intentClassPredicate(cls: string): string {
  return `classification = '${cls}'`;
}

/** The three series the scoreboard renders. `raw` carries no class filter, by definition. */
export type IntentSeries = 'human' | 'unknown' | 'raw';

/**
 * The ONE checkout-intent count, parameterised only by which series is wanted.
 *
 * `?` placeholders are positional and backend-agnostic (the repo's `dbQuery` rewrites them for
 * Postgres), so the caller supplies `[fromIso, toIso]` in that order.
 */
export function intentCountSql(series: IntentSeries, opts: { toBound?: boolean } = {}): string {
  const classFilter =
    series === 'raw' ? '' : ` AND ${intentClassPredicate(series === 'human' ? HUMAN_INTENT_CLASS : UNKNOWN_INTENT_CLASS)}`;
  const upper = opts.toBound ? ' AND created_at <= ?' : '';
  return `SELECT COUNT(DISTINCT client_reference_id) AS c
       FROM signup_attribution
      WHERE ${PAID_TIER_PREDICATE}${classFilter}
        AND created_at >= ?${upper}`;
}

/**
 * Human-readable labels, exported so the dashboard and the snapshot name the same thing the same
 * way. A series whose meaning is spelled out in one place and abbreviated in another is how a
 * reader ends up comparing two different quantities.
 */
export const INTENT_LABELS: Readonly<Record<IntentSeries, string>> = Object.freeze({
  human: 'Checkout intent (human)',
  unknown: 'unknown (fail-open, still redirected)',
  raw: 'raw requests (all classes)',
});

/**
 * OPS-PUBLIC-API-CONVERT-NUDGE-W1 — the ONE source of the additive `_algovault`
 * conversion CTA block emitted on the public proof endpoints
 * (`/api/performance-public`, `/api/merkle-batches`, `/api/erc-8004-reputation`).
 *
 * Single-derivation (CLAUDE.md build rule): every consumer projects from
 * `buildPublicCtaBlock()` — never a hand-copied literal. Any FUTURE public JSON
 * endpoint adopts the block in one line:
 *
 *   res.json({ ...body, _algovault: buildPublicCtaBlock() });
 *
 * or, when the endpoint already emits an `_algovault` metadata block, MERGE:
 *
 *   _algovault: { ...existingMeta, ...buildPublicCtaBlock() }
 *
 * Data Integrity LAW: brand + generic CTA + public URLs ONLY. No internal
 * metrics ever (`outcome_return_pct` / `outcome_price` / Phase-E win rate /
 * equities). Locked by `tests/unit/public-cta.test.ts` +
 * `audits/public-cta-shape-snapshot-2026-07-15.json`.
 *
 * Copy approved verbatim by Mr.1 (2026-07-15). Voice: Professional & Concise;
 * CTA = action verb + outcome — targets T1 AI-agent builders + T2 crypto-quant
 * devs pulling the public proof endpoints. No blocking, no rate-limit, no data
 * withheld: the block is a machine-readable invite that ships ALONGSIDE the
 * full public payload.
 */

export interface PublicCtaBlock {
  /** Brand positioning one-liner. */
  brand: string;
  /** Conversion nudge — action verb + outcome. */
  note: string;
  /** Free-key / pricing entry point (absolute public URL, cross-host safe). */
  get_started: string;
  /** Public docs (absolute public URL, cross-host safe). */
  docs: string;
}

/**
 * Returns the approved `_algovault` conversion CTA block, verbatim.
 *
 * Pure: returns a FRESH object literal each call (no shared mutable state), so
 * it is always safe to spread into a public JSON response. The values are
 * static → cache-safe (no per-request variance) under the 45s origin-shield
 * edge cache on these paths.
 */
export function buildPublicCtaBlock(): PublicCtaBlock {
  return {
    brand: 'The Brain Layer for AI Trading Agents',
    note: 'Building an agent? Get a free API key — higher limits, all tools, x402 pay-per-call.',
    get_started: 'https://algovault.com/#pricing',
    docs: 'https://algovault.com/docs.html',
  };
}

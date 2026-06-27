/**
 * SCAN-RANKBY-W1 — pure rankBy constants + helpers (the universe-selection lens).
 *
 * LEAF module: DATA + pure functions ONLY, zero adapter/runtime imports — so it
 * can be imported by BOTH the impure selector (`rank-metrics.ts`) AND the
 * feature registry / `/capabilities` projection without an import cycle
 * (feature-registry.ts is DATA+TYPES only by contract).
 *
 * THE single rank-alias map (CLAUDE.md Build Rule 6 / single-source): the TG bot
 * forwards the RAW token; the MCP resolves it HERE and nowhere else.
 */

/**
 * Canonical rankBy values. `oi` is the default and reproduces today's universe
 * selection byte-for-byte (open-interest desc). The verdict engine runs
 * unchanged on whichever universe a lens selects.
 */
export const RANK_BY_VALUES = [
  'oi',
  'volume',
  'gainers',
  'losers',
  'movers',
  'funding_positive',
  'funding_negative',
] as const;

export type RankBy = (typeof RANK_BY_VALUES)[number];

/** Short in-chat aliases → canonical. One canonical per alias; no second map. */
export const RANK_BY_ALIASES: Readonly<Record<string, RankBy>> = {
  oi: 'oi',
  vol: 'volume',
  gain: 'gainers',
  lose: 'losers',
  move: 'movers',
  pfr: 'funding_positive',
  nfr: 'funding_negative',
};

const CANONICAL_SET: ReadonlySet<string> = new Set<string>(RANK_BY_VALUES);

/**
 * Every accepted token (canonical + distinct aliases), stable order. Advertised
 * on `/capabilities` so the bot DERIVES the valid set (CH2) instead of
 * hardcoding it, and surfaced in the structured error's `valid_lenses`.
 */
export function rankByTokens(): string[] {
  const aliasOnly = Object.keys(RANK_BY_ALIASES).filter((a) => !CANONICAL_SET.has(a));
  return [...RANK_BY_VALUES, ...aliasOnly];
}

/**
 * Resolve a raw token (canonical OR alias, case-insensitive, trimmed) to a
 * canonical RankBy. Returns `null` on unknown/empty (caller default-denies:
 * `undefined`/omitted → 'oi' default upstream; a non-empty unknown → structured
 * error). The ONLY rank-alias resolver in the codebase.
 */
export function resolveRankBy(token: string | undefined | null): RankBy | null {
  if (token == null) return null;
  const t = String(token).trim().toLowerCase();
  if (t === '') return null;
  if (CANONICAL_SET.has(t)) return t as RankBy;
  return RANK_BY_ALIASES[t] ?? null;
}

/** The two funding lenses — these rank within the liquid candidate pool (Q2A). */
export function isFundingRank(rankBy: RankBy): boolean {
  return rankBy === 'funding_positive' || rankBy === 'funding_negative';
}

/** Sort direction per lens: true = descending (largest first). */
export function rankDescending(rankBy: RankBy): boolean {
  // losers = most-negative 24h% first (ascending); everything else descending.
  // movers is ranked by |24h%| descending (handled by the metric, not here).
  return rankBy !== 'losers' && rankBy !== 'funding_negative';
}

/**
 * Annualize a per-interval funding rate: `APR = rate × (24 / intervalHours) × 365`.
 *
 * Per-venue interval divergence is LAW (verified live 2026-06-27):
 *   - Hyperliquid funding is HOURLY → intervalHours = 1 → ×8760 (NOT 8h/×1095).
 *   - Bybit reports `fundingIntervalHour` per symbol — pass it through.
 *   - Binance / Bitget / OKX default to 8h.
 * Returns `null` when the interval is unknown or invalid — NEVER guess (CLAUDE.md).
 *
 * `rate` is the funding fraction for one interval (e.g. 0.0001 = 0.01%).
 */
export function annualizeFunding(
  rate: number,
  intervalHours: number | null | undefined,
): number | null {
  if (!Number.isFinite(rate)) return null;
  if (intervalHours == null || !Number.isFinite(intervalHours) || intervalHours <= 0) {
    return null;
  }
  return rate * (24 / intervalHours) * 365;
}

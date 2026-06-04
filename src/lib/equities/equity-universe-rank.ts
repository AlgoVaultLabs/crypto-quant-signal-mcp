/**
 * EQUITIES-ENGINE-W1 — pure universe ranking.
 *
 * Given per-symbol daily dollar-volume samples (close * volume) over the
 * lookback window, rank by MEDIAN daily dollar volume (robust to single-day
 * spikes) and select the top-N plus the ETF whitelist. No I/O.
 */

export interface UniverseRow {
  symbol: string;
  /** 1-based rank by median daily $-volume among the ranked (non-pure-ETF) set. */
  rank_adv: number | null;
  /** Median daily dollar volume over the lookback (the ranking statistic). */
  adv_usd: number;
  is_etf: boolean;
}

/** Median of a numeric array (returns 0 for empty). */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Build the frozen universe.
 *
 * @param dollarVolumes  symbol -> array of per-session dollar-volume samples
 * @param topN           number of top-ADV names to include
 * @param etfWhitelist   symbols always included, flagged is_etf
 * @returns rows for top-N by median $-vol UNIONed with the whitelist.
 *          Whitelist members keep their is_etf flag; if a whitelist symbol also
 *          ranks in the top-N it appears once, is_etf=true, with its rank.
 */
export function buildUniverse(
  dollarVolumes: Map<string, number[]>,
  topN: number,
  etfWhitelist: readonly string[]
): UniverseRow[] {
  const whitelist = new Set(etfWhitelist);

  // Median $-vol for every symbol that has at least one sample.
  const scored: { symbol: string; adv: number }[] = [];
  for (const [symbol, samples] of dollarVolumes) {
    if (samples.length === 0) continue;
    scored.push({ symbol, adv: median(samples) });
  }
  scored.sort((a, b) => b.adv - a.adv);

  const out = new Map<string, UniverseRow>();

  // Top-N by ADV (1-based rank).
  for (let i = 0; i < scored.length && out.size < topN; i++) {
    const { symbol, adv } = scored[i];
    out.set(symbol, {
      symbol,
      rank_adv: i + 1,
      adv_usd: adv,
      is_etf: whitelist.has(symbol),
    });
  }

  // ETF whitelist — always present. If already in top-N, just mark is_etf.
  for (const symbol of etfWhitelist) {
    const existing = out.get(symbol);
    if (existing) {
      existing.is_etf = true;
      continue;
    }
    const adv = dollarVolumes.has(symbol) ? median(dollarVolumes.get(symbol)!) : 0;
    out.set(symbol, { symbol, rank_adv: null, adv_usd: adv, is_etf: true });
  }

  return [...out.values()];
}

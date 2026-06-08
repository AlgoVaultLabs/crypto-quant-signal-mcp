/**
 * TRADE-CALL-ROUTING-RESOLVER-W1 R2 — equity-universe membership check.
 *
 * The handler-side async edge feeding the pure `resolveMarketRoute` resolver's
 * `inEquityUniverse` boolean. It REUSES the existing universe SoT
 * (`getAllUniverseSymbols`) — no parallel symbol list — behind a lazy TTL Set
 * cache so a bare `get_trade_call {coin}` does not re-hit Postgres on every call
 * (the universe is frozen nightly, so a few minutes of staleness is irrelevant
 * to routing; the engines remain authoritative). Consulted ONLY in the bare
 * branch (no exchange / timeframe / assetClass), so venue/TF calls add zero DB cost.
 *
 * FAIL-OPEN: any universe-read error → `false` → the caller routes to perp
 * BINANCE (the pre-wave behavior). False is the safe, explicit degradation (the
 * perp engine then handles the symbol or returns its standard not-found error) —
 * never a fabricated equity verdict.
 */
import { getEquityPool, getAllUniverseSymbols } from './equity-store.js';
import { normalizeSymbol } from './equity-symbols.js';

/** Active-universe symbol Set + the wall-clock ms it was loaded. */
let _cache: { set: Set<string>; at: number } | null = null;

/** Cache lifetime — the universe is frozen nightly, so minutes of lag is safe. */
const TTL_MS = 10 * 60_000;

/**
 * True iff `raw` (normalized to the canonical EQUS.MINI form) is in the active
 * equity universe. `nowMs` is injectable for deterministic TTL tests.
 */
export async function isEquityUniverseSymbol(raw: string, nowMs: number = Date.now()): Promise<boolean> {
  const symbol = normalizeSymbol(raw);
  if (!symbol) return false;
  try {
    if (!_cache || nowMs - _cache.at > TTL_MS) {
      const symbols = await getAllUniverseSymbols(getEquityPool());
      _cache = { set: new Set(symbols), at: nowMs };
    }
    return _cache.set.has(symbol);
  } catch (e) {
    // Forensic-only (recovery alerts are noise): a persistent equity-DB outage
    // shows here while routing fails-open to perp.
    console.warn(`[equity-universe-membership] universe read failed (fail-open → perp): ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/** Test seam — clears the cached universe set. */
export function _resetUniverseMembershipCache(): void {
  _cache = null;
}

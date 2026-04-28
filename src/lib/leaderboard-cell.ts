/**
 * Leaderboard-cell trim helper (v1.10.0 C4).
 *
 * Converts a full internal `GridCell` (which carries leaky `signal` / `exchange`
 * / `regime` fields used by the cross-asset scorer) into the public-facing
 * trimmed `LeaderboardCell` shape `{coin, timeframe, confidence}`.
 *
 * Used by the `also_see` (cross-asset leads) and `closest_tradeable`
 * (HOLD-rescue) fields on `TradeCallResult`. Trim is intentional: agents
 * reading the leaderboard see "go look here" pointers; the direction must
 * be obtained via a fresh `get_trade_call` invocation.
 */
import type { GridCell, LeaderboardCell } from '../types.js';

export function trimToLeaderboardCell(c: GridCell): LeaderboardCell {
  return {
    coin: c.coin,
    timeframe: c.timeframe,
    confidence: c.confidence,
  };
}

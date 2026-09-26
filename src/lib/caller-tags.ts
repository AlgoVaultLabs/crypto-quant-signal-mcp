/**
 * caller-tags.ts — OPS-UPSTREAM-ACQUISITION-ACCOUNTING-W1 CH1.
 *
 * THE REGISTERED CALLER-TAG BUILDERS. A caller tag names who spent upstream weight; the per-caller
 * acquisition ledger (CH2) keys on it, so a tag must name exactly ONE spender. Measured before this
 * wave, three tags did not: `backfill` named both backfill-outcomes and PID 1's in-server backfill;
 * `seed:<tf>` named the HL, promoted, shadow and WEEX lanes at once; and `signal_perf_backfill`
 * named PID 1 AND every seed process (seed-signals.ts calls getSignalPerformance(), which starts the
 * same batch backfill inside the seed).
 *
 * `scripts/check-caller-tags.mjs` (CALLER_TAG_VERDICT) accepts, as a caller name, only a string
 * literal, a conditional of string literals, or a call to one of the builders below — and asserts no
 * emitted name is shared by two entrypoints. Every builder's output set is finite and enumerable.
 *
 *   seedCallerTag(args)   → `seed:<tf>:<lane>`. Called ONLY from src/scripts/seed-signals.ts.
 *   processScopedTag(b)   → `b` in PID 1 (so every existing PID-1 tag keeps its value), `b@<entrypoint>`
 *                           in any other process. For library code reachable from more than one
 *                           entrypoint: unique per entrypoint BY CONSTRUCTION.
 *   x402CallerTag(tool)   → processScopedTag(`x402:<tool>`).
 *
 * Old → new tag map (published in the wave's status entry):
 *   backfill (backfill-outcomes.ts)           → backfill_outcomes_cron
 *   backfill (index.ts in-server)             → backfill_outcomes_server
 *   seed:<tf>                                 → seed:<tf>:<lane>   (lane ∈ hl | weex | promoted | shadow | list-… | all | default)
 *   dwr-backfill (frozen-window-attribution)  → frozen_window_attribution   (dwr-backfill stays with backfill-directional-labels)
 *   signal_perf_backfill (seed process)       → signal_perf_backfill@seed-signals   (PID 1 unchanged)
 *   grid_warmer                               → unchanged in PID 1 (processScopedTag)
 *   x402:<tool>                               → unchanged in PID 1 (processScopedTag)
 *   unknown (backfill-funding-episodes)       → funding_episodes_backfill
 *   unknown (monitor.ts)                      → monitor
 *   unknown (backfill-hold-decision-labels)   → hold_decision_labeler
 *   unknown (anything else, no context)       → unattributed:<entrypoint>
 * Every rename leaves the weight CLASS unchanged: only the name moves.
 */
import { processEntrypoint } from './runtime.js';

/** PID 1's entrypoint name (`node dist/index.js`). */
export const PID1_ENTRYPOINT = 'index';

/** `base` in PID 1; `base@<entrypoint>` elsewhere. Pure given `entrypoint`. */
export function processScopedTag(base: string, entrypoint: string = processEntrypoint()): string {
  return entrypoint === PID1_ENTRYPOINT ? base : `${base}@${entrypoint}`;
}

/** The x402 HTTP twin of a tool, process-scoped. */
export function x402CallerTag(tool: string, entrypoint?: string): string {
  return processScopedTag(`x402:${tool}`, entrypoint);
}

/** The subset of seed-signals parseArgs() a lane is a function of. */
export interface SeedLaneArgs {
  timeframe: string;
  exchanges: readonly string[];
  explicitExchanges: boolean;
  statusFilter: string | null;
}

/**
 * The seed LANE, a deterministic function of the parsed args, mirroring parseArgs' own precedence
 * (an explicit --exchange / --exchange-list override WINS over --status):
 *   explicit, one venue       → that venue, lower-cased        (`--exchange HL` → hl, `--exchange-list WEEX` → weex)
 *   explicit, several venues  → `list-` + sorted lower-cased   (`--exchange-list BINANCE,BYBIT,OKX,BITGET` → list-binance-bitget-bybit-okx)
 *   --status <s>              → s                              (promoted | shadow | all)
 *   none                      → default
 * `--exclude` is deliberately NOT part of the lane (the spec's `--status promoted --exclude …` → promoted).
 */
export function seedLane(args: SeedLaneArgs): string {
  if (args.explicitExchanges) {
    const venues = [...new Set(args.exchanges.map((v) => v.toLowerCase()))].sort();
    if (venues.length === 1) return venues[0];
    return `list-${venues.join('-')}`;
  }
  if (args.statusFilter) return args.statusFilter;
  return 'default';
}

/** `seed:<tf>:<lane>` — the one registered seed-tag builder. */
export function seedCallerTag(args: SeedLaneArgs): string {
  return `seed:${args.timeframe}:${seedLane(args)}`;
}

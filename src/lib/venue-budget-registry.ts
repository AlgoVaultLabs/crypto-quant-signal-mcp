/**
 * venue-budget-registry.ts — OPS-ADAPTER-RATELIMIT-UNIFY-W1 (C2: the registry owns the budgets)
 *
 * Single lookup point mapping an `exchangeId` to its cross-process weight budget
 * (or null when the venue is delay-paced only). `_upstream-fetch.ts` consults it
 * before every venue fetch via `getVenueBudget`.
 *
 * C2 (this commit): the HL + Binance `WeightBudget` singleton DEFINITIONS moved
 * here verbatim from `upstream-weight-budget.ts` — that module is now the engine
 * (the `WeightBudget` class + the AsyncLocalStorage weight-class framework) and
 * this module is the SoT for *which* venues are budgeted. The move is provably
 * byte-identical: ledger/lock paths, HL 1150/450, Binance 2000/800, and the
 * per-worker VITEST ledger isolation are all unchanged from the C1 re-export form.
 * Reaching the 3rd venue budget (BYBIT/OKX/BITGET in C3) is exactly the CLAUDE.md
 * "extract to a shared registry at the 3rd consumer" threshold this satisfies.
 *
 * Registry shape: a SPARSE `Map` (not `Record<ExchangeId>`) — only budgeted venues
 * are keys; the 12 delay-paced shadow venues are simply absent → `getVenueBudget`
 * returns null and `_upstream-fetch` skips the acquire. Adding a venue = one Map row.
 *
 * weightFor is intentionally thin: HL/Binance compute their venue-specific weight
 * in the adapter and pass it as `req.weightHint`; this registry just reads it. C3
 * adds the request-count venues (BYBIT/OKX/BITGET) with `weightFor = () => 1`.
 *
 * NOTE (deploy smoke, R6): the canonical `algovault-hl-weight` ledger-path literal
 * now lives in THIS module's compiled output — the smoke grep target moved from
 * `dist/lib/upstream-weight-budget.js` to `dist/lib/venue-budget-registry.js`.
 */
import { WeightBudget } from './upstream-weight-budget.js';

export interface VenueBudgetEntry {
  budget: WeightBudget;
  /** Maps an upstream request to its weight. HL/Binance pass `weightHint`; request-count venues return 1. */
  weightFor: (req: { weightHint?: number }) => number;
}

// ── Hyperliquid: consumer #1 (OPS-HL-RATELIMITER-W2) ──
// Canonical HL ledger path lives beside the registry so the deploy-smoke grep
// (R6) has a stable target. HL REST budget = 1200 weight/min/IP (official docs,
// re-verified 2026-06-04).
//
// OPS-HL-BUDGET-TUNE-W1 (2026-06-05, data-justified, architect-approved): bumped
// CEILING 1000→1150 + RESERVE 300→450 (both +150) after live telemetry showed
// measured interactive HL demand ≈ 404 wt/min overflowing the old 300 reserve at
// batch-peak boundary minutes (49-101 `throws`/window → HL→Binance fallbacks).
// Batch cap stays CEILING−RESERVE = 700 (unchanged → seeds' lane untouched; post
// OPS-HL-SEED-LOAD-W1 the batch is healthy at 700: waits low, skips 0). The extra
// 150 of ceiling goes entirely to interactive (reserve 300→450) so the ~404
// demand fits → interactive throttling eliminated. CEILING 1150 leaves 50 under
// HL's 1200 for header drift (all HL callers are now budgeted post-W2, so the
// "unbudgeted caller" cushion is no longer load-bearing).
export const HL_WEIGHT_CEILING = 1150;
export const HL_INTERACTIVE_RESERVE = 450;

const HL_VITEST = process.env.VITEST === 'true';
// Per-worker ledger + effectively-unbounded ceiling under vitest so fetch-mocked
// adapter tests never throttle or contend on the shared production ledger.
const hlLedgerSuffix = HL_VITEST ? `.test-${process.pid}` : '';

export const hlWeightBudget = new WeightBudget({
  venue: 'Hyperliquid',
  ledgerPath: process.env.HL_WEIGHT_LEDGER ?? `/tmp/algovault-hl-weight${hlLedgerSuffix}.json`,
  lockPath: process.env.HL_WEIGHT_LOCK ?? `/tmp/algovault-hl-weight${hlLedgerSuffix}.lock`,
  ceilingPerMin: HL_VITEST ? 1_000_000_000 : HL_WEIGHT_CEILING,
  interactiveReserve: HL_VITEST ? 0 : HL_INTERACTIVE_RESERVE,
  log: HL_VITEST ? () => {} : undefined,
});

// ── Binance: consumer #2 (OPS-BINANCE-RATELIMITER-W1, 2026-06-05) ──
// Same cross-process token-bucket as HL. Binance USD-M Futures (fapi) imposes a
// **2400 weight/min per-IP** limit (the adapter already reads `X-MBX-USED-WEIGHT-1m`
// and warns at >1800). The 42-cell cross-asset-grid warmer + default-exchange
// `get_trade_call` + Binance seed crons all hit fapi from the one Hetzner IP;
// during the 12-venue shadow ramp the AGGREGATE burst exceeded 2400 → HTTP 418
// IP-ban → grid slow-grid breaker spam. This budget caps the aggregate at 2000
// (400 under 2400 for header-rolling-window drift) and reserves 800 for
// interactive (grid + live user calls) so seed/backfill batch load can't starve
// them. // TODO: revisit constants with a week of telemetry (target 2026-06-19).
export const BINANCE_WEIGHT_CEILING = 2000;
export const BINANCE_INTERACTIVE_RESERVE = 800;

const BINANCE_VITEST = process.env.VITEST === 'true';
const binanceLedgerSuffix = BINANCE_VITEST ? `.test-${process.pid}` : '';

export const binanceWeightBudget = new WeightBudget({
  venue: 'Binance',
  ledgerPath:
    process.env.BINANCE_WEIGHT_LEDGER ?? `/tmp/algovault-binance-weight${binanceLedgerSuffix}.json`,
  lockPath:
    process.env.BINANCE_WEIGHT_LOCK ?? `/tmp/algovault-binance-weight${binanceLedgerSuffix}.lock`,
  ceilingPerMin: BINANCE_VITEST ? 1_000_000_000 : BINANCE_WEIGHT_CEILING,
  interactiveReserve: BINANCE_VITEST ? 0 : BINANCE_INTERACTIVE_RESERVE,
  log: BINANCE_VITEST ? () => {} : undefined,
});

// ── The registry (sparse Map; one row per budgeted venue) ──
// C3 (OPS-ADAPTER-RATELIMIT-UNIFY-W1) adds BYBIT / OKX / BITGET request-count rows.
const VENUE_BUDGETS: ReadonlyMap<string, VenueBudgetEntry> = new Map<string, VenueBudgetEntry>([
  ['HL', { budget: hlWeightBudget, weightFor: (req) => req.weightHint ?? 20 }],
  ['BINANCE', { budget: binanceWeightBudget, weightFor: (req) => req.weightHint ?? 5 }],
]);

/**
 * The cross-process weight budget for `exchangeId`, or null when the venue is
 * delay-paced only (the 12 shadow venues) and therefore has no shared budget.
 */
export function getVenueBudget(exchangeId: string): VenueBudgetEntry | null {
  return VENUE_BUDGETS.get(exchangeId) ?? null;
}

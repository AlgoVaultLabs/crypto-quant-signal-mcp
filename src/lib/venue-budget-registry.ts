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
 * Registry shape (REVISED by OPS-TELEMETRY-DIGEST-REFRAME-W1): promoted venues live
 * in an EXHAUSTIVE `Record<PromotedVenueId, VenueBudgetEntry>` keyed off the
 * `capabilities.ts` SoT, so omitting a promoted venue is a tsc error (TS2739/2741)
 * rather than silent zero-pacing. Shadow venues stay in a separate, deliberately
 * SPARSE map — absent → `getVenueBudget` returns null and `_upstream-fetch` skips
 * the acquire.
 *
 * Why the change: `OPS-SEED-PROMOTED-RAMP-W1` (2026-07-07) enrolled the 7 venues
 * promoted by OPS-VENUE-GO-LIVE-2026-06-30 into the fast seed lines, but this
 * registry still held only the original 5 — so those 7 got heavy cron seeding with
 * NO budget at all. Live 7d evidence: budgeted venues essentially never reach a
 * venue ban (HL 0 raw 429s, self-throttling at BUDGET_CEILING instead; OKX 19)
 * while unbudgeted ones ate them constantly (Aster 1,855 raw 429s, Bitmart 389,
 * edgeX 373). Aster is PROMOTED, so those were denied seed attempts against data
 * that feeds the public track record. The exhaustive Record makes the "promoted a
 * venue but forgot its budget" class structurally impossible per CLAUDE.md's
 * generator rule; the idiom mirrors `exchange-universe.ts`'s FETCHERS record.
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
import type { PromotedVenueId } from './capabilities.js';

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

// ── Bybit / OKX / Bitget: consumers #3-5 (OPS-ADAPTER-RATELIMIT-UNIFY-W1 C3) ──
// These three PROMOTED venues are REQUEST-COUNT limited (not Binance-style weight),
// so each registry row uses `weightFor = () => 1` — the budget meters requests/min;
// ceiling/reserve are req/min. Each ceiling sits well under the venue's documented
// per-IP limit so we self-throttle (typed UpstreamRateLimitError, no-retry) BEFORE
// the venue issues an IP ban — the same class of self-DoS the Binance budget closed
// (Bybit 403, Bitget body-code 45001). Ceilings/reserves are architect-ratified in
// audits/OPS-ADAPTER-RATELIMIT-UNIFY-W1-endpoint-truth.md §6-7. Ledger paths are
// STATIC literals (NOT templated through a slug variable) so the R6 deploy-smoke grep
// + ops can grep each `algovault-<venue>-weight` target in the compiled output.
// // TODO: revisit ceilings by 2026-06-26 with a week of per-window telemetry.

// Bybit v5: "600 requests within a 5-second window per IP" (= 7200/min;
// bybit-exchange.github.io/docs/v5/rate-limit) → 403 'access too frequent', wait
// ≥10min. Ceiling 3600 = 50%-of-verified; reserve 1200.
export const BYBIT_REQ_CEILING = 3600;
export const BYBIT_INTERACTIVE_RESERVE = 1200;
const BYBIT_VITEST = process.env.VITEST === 'true';
const bybitLedgerSuffix = BYBIT_VITEST ? `.test-${process.pid}` : '';
export const bybitWeightBudget = new WeightBudget({
  venue: 'Bybit',
  ledgerPath: process.env.BYBIT_WEIGHT_LEDGER ?? `/tmp/algovault-bybit-weight${bybitLedgerSuffix}.json`,
  lockPath: process.env.BYBIT_WEIGHT_LOCK ?? `/tmp/algovault-bybit-weight${bybitLedgerSuffix}.lock`,
  ceilingPerMin: BYBIT_VITEST ? 1_000_000_000 : BYBIT_REQ_CEILING,
  interactiveReserve: BYBIT_VITEST ? 0 : BYBIT_INTERACTIVE_RESERVE,
  log: BYBIT_VITEST ? () => {} : undefined,
});

// OKX is PER-ENDPOINT IP-rate-limited (NOT a single per-IP aggregate like Binance):
// market-data endpoints ≈ 20 req / 2s = 600/min/endpoint (okx.com/docs-v5, err 50026).
// Q2=A (architect-ratified): model ONE conservative aggregate budget across all OKX
// endpoints rather than per-endpoint buckets — 500/min sits under the lowest single
// 600/min ceiling, so it stays safe even if every call hits one endpoint, without
// per-endpoint ledger complexity. fetchOKX issues 2 requests (tickers +
// open-interest) per universe refresh; each costs 1.
export const OKX_REQ_CEILING = 500;
export const OKX_INTERACTIVE_RESERVE = 150;
const OKX_VITEST = process.env.VITEST === 'true';
const okxLedgerSuffix = OKX_VITEST ? `.test-${process.pid}` : '';
export const okxWeightBudget = new WeightBudget({
  venue: 'OKX',
  ledgerPath: process.env.OKX_WEIGHT_LEDGER ?? `/tmp/algovault-okx-weight${okxLedgerSuffix}.json`,
  lockPath: process.env.OKX_WEIGHT_LOCK ?? `/tmp/algovault-okx-weight${okxLedgerSuffix}.lock`,
  ceilingPerMin: OKX_VITEST ? 1_000_000_000 : OKX_REQ_CEILING,
  interactiveReserve: OKX_VITEST ? 0 : OKX_INTERACTIVE_RESERVE,
  log: OKX_VITEST ? () => {} : undefined,
});

// Bitget mix: "6000 requests / IP / Min … 5 minutes to recover"
// (bitget.com/wiki/bitget-api-rate-limits); also signals throttle via response
// body-codes 45001/40725/40808 (handled as banBodyCodes in the transport). Ceiling
// 3000 = 50%-of-verified; reserve 1000.
export const BITGET_REQ_CEILING = 3000;
export const BITGET_INTERACTIVE_RESERVE = 1000;
const BITGET_VITEST = process.env.VITEST === 'true';
const bitgetLedgerSuffix = BITGET_VITEST ? `.test-${process.pid}` : '';
export const bitgetWeightBudget = new WeightBudget({
  venue: 'Bitget',
  ledgerPath: process.env.BITGET_WEIGHT_LEDGER ?? `/tmp/algovault-bitget-weight${bitgetLedgerSuffix}.json`,
  lockPath: process.env.BITGET_WEIGHT_LOCK ?? `/tmp/algovault-bitget-weight${bitgetLedgerSuffix}.lock`,
  ceilingPerMin: BITGET_VITEST ? 1_000_000_000 : BITGET_REQ_CEILING,
  interactiveReserve: BITGET_VITEST ? 0 : BITGET_INTERACTIVE_RESERVE,
  log: BITGET_VITEST ? () => {} : undefined,
});

// ── The 7 venues promoted by OPS-VENUE-GO-LIVE-2026-06-30: consumers #6-12 ──
// (OPS-TELEMETRY-DIGEST-REFRAME-W1). Every ceiling below is 50%-of-a-VENDOR-PUBLISHED
// figure — the same methodology and citation convention as BYBIT/OKX/BITGET above.
// Nothing here is inferred from an analogous exchange or from memory; the source doc
// is named per venue. Reserves are ~⅓ of ceiling, matching the existing rows.
// // TODO: revisit ceilings by 2026-08-02 with a week of per-window telemetry —
// the success signal is each venue's raw-429 count collapsing toward zero and being
// replaced (if anything) by BUDGET_CEILING self-throttles, exactly as HL behaves.

// Aster: 2400 request-weight/min per IP, breach → 429 then 418 IP-ban escalating
// 2min→3d (github.com/asterdex/api-docs, both v1 + v3). NOTE: Aster is a
// Binance-fapi-compatible implementation and this figure — plus the X-MBX-* headers
// and the 429/418 split — is a verbatim copy of Binance's framework; it IS Aster's
// own published number, but it was not independently derived by Aster.
// Ceiling 1200 = 50%-of-verified; reserve 400. Highest-value row in this block:
// Aster ate 1,855 raw 429s in 7d, more than every other venue combined.
export const ASTER_REQ_CEILING = 1200;
export const ASTER_INTERACTIVE_RESERVE = 400;
const ASTER_VITEST = process.env.VITEST === 'true';
const asterLedgerSuffix = ASTER_VITEST ? `.test-${process.pid}` : '';
export const asterWeightBudget = new WeightBudget({
  venue: 'Aster',
  ledgerPath: process.env.ASTER_WEIGHT_LEDGER ?? `/tmp/algovault-aster-weight${asterLedgerSuffix}.json`,
  lockPath: process.env.ASTER_WEIGHT_LOCK ?? `/tmp/algovault-aster-weight${asterLedgerSuffix}.lock`,
  ceilingPerMin: ASTER_VITEST ? 1_000_000_000 : ASTER_REQ_CEILING,
  interactiveReserve: ASTER_VITEST ? 0 : ASTER_INTERACTIVE_RESERVE,
  log: ASTER_VITEST ? () => {} : undefined,
});

// BingX: market-data endpoints (spot + futures share the pool) 500 req / 10s per IP
// = 3000/min (bingx.com support article 31103871611289, the 2025-10-16 rate-limit
// refresh). Ceiling 1500 = 50%-of-verified; reserve 500. CAVEAT: BingX's reference
// docs are client-rendered and could not be read, so the breach STATUS code is
// unconfirmed — the transport treats [418,429] as bans for this venue by default.
export const BINGX_REQ_CEILING = 1500;
export const BINGX_INTERACTIVE_RESERVE = 500;
const BINGX_VITEST = process.env.VITEST === 'true';
const bingxLedgerSuffix = BINGX_VITEST ? `.test-${process.pid}` : '';
export const bingxWeightBudget = new WeightBudget({
  venue: 'BingX',
  ledgerPath: process.env.BINGX_WEIGHT_LEDGER ?? `/tmp/algovault-bingx-weight${bingxLedgerSuffix}.json`,
  lockPath: process.env.BINGX_WEIGHT_LOCK ?? `/tmp/algovault-bingx-weight${bingxLedgerSuffix}.lock`,
  ceilingPerMin: BINGX_VITEST ? 1_000_000_000 : BINGX_REQ_CEILING,
  interactiveReserve: BINGX_VITEST ? 0 : BINGX_INTERACTIVE_RESERVE,
  log: BINGX_VITEST ? () => {} : undefined,
});

// Gate.io: Perpetual-Swap PUBLIC endpoints (depth, kline, trading pairs, funding
// rate) 300 req/s per IP = 18000/min (github.com/gateio/rest-v4 README — Gate's
// official GitHub org; docs.gate.com 403s automated fetch). Ceiling 9000 =
// 50%-of-verified; reserve 3000. Generous enough that this budget should rarely
// bind — it exists so a runaway fan-out self-throttles rather than earning a ban.
export const GATE_REQ_CEILING = 9000;
export const GATE_INTERACTIVE_RESERVE = 3000;
const GATE_VITEST = process.env.VITEST === 'true';
const gateLedgerSuffix = GATE_VITEST ? `.test-${process.pid}` : '';
export const gateWeightBudget = new WeightBudget({
  venue: 'Gate',
  ledgerPath: process.env.GATE_WEIGHT_LEDGER ?? `/tmp/algovault-gate-weight${gateLedgerSuffix}.json`,
  lockPath: process.env.GATE_WEIGHT_LOCK ?? `/tmp/algovault-gate-weight${gateLedgerSuffix}.lock`,
  ceilingPerMin: GATE_VITEST ? 1_000_000_000 : GATE_REQ_CEILING,
  interactiveReserve: GATE_VITEST ? 0 : GATE_INTERACTIVE_RESERVE,
  log: GATE_VITEST ? () => {} : undefined,
});

// HTX: 800 req/s per IP for MARKET DATA = 48000/min (primary docs, recorded in
// htx.ts:20 + audits/PILOT-ADAPTERS-W3A-endpoint-truth.md:89; non-market public
// endpoints are far tighter at 240/3s). Ceiling 24000 = 50%-of-verified;
// reserve 8000. The most generous venue in the fleet.
export const HTX_REQ_CEILING = 24000;
export const HTX_INTERACTIVE_RESERVE = 8000;
const HTX_VITEST = process.env.VITEST === 'true';
const htxLedgerSuffix = HTX_VITEST ? `.test-${process.pid}` : '';
export const htxWeightBudget = new WeightBudget({
  venue: 'HTX',
  ledgerPath: process.env.HTX_WEIGHT_LEDGER ?? `/tmp/algovault-htx-weight${htxLedgerSuffix}.json`,
  lockPath: process.env.HTX_WEIGHT_LOCK ?? `/tmp/algovault-htx-weight${htxLedgerSuffix}.lock`,
  ceilingPerMin: HTX_VITEST ? 1_000_000_000 : HTX_REQ_CEILING,
  interactiveReserve: HTX_VITEST ? 0 : HTX_INTERACTIVE_RESERVE,
  log: HTX_VITEST ? () => {} : undefined,
});

// KuCoin: the flat PUBLIC resource pool is 2000 req / 30s per IP = 4000/min, and it
// does NOT scale with VIP tier (kucoin.com/docs-new/rate-limit). Futures "Get Klines"
// self-declares api-rate-limit-pool=Public, api-rate-limit-weight=3 — so klines cost
// THREE, not one. `weightFor: () => 3` models that; a flat 1 would under-count our
// real draw by 3× (the same class of defect as the Bitget outlier, see C5).
// Ceiling 2000 = 50%-of-verified; reserve 700.
export const KUCOIN_REQ_CEILING = 2000;
export const KUCOIN_INTERACTIVE_RESERVE = 700;
const KUCOIN_VITEST = process.env.VITEST === 'true';
const kucoinLedgerSuffix = KUCOIN_VITEST ? `.test-${process.pid}` : '';
export const kucoinWeightBudget = new WeightBudget({
  venue: 'KuCoin',
  ledgerPath: process.env.KUCOIN_WEIGHT_LEDGER ?? `/tmp/algovault-kucoin-weight${kucoinLedgerSuffix}.json`,
  lockPath: process.env.KUCOIN_WEIGHT_LOCK ?? `/tmp/algovault-kucoin-weight${kucoinLedgerSuffix}.lock`,
  ceilingPerMin: KUCOIN_VITEST ? 1_000_000_000 : KUCOIN_REQ_CEILING,
  interactiveReserve: KUCOIN_VITEST ? 0 : KUCOIN_INTERACTIVE_RESERVE,
  log: KUCOIN_VITEST ? () => {} : undefined,
});

// MEXC publishes NO blanket futures IP ceiling — each market-data endpoint carries its
// own throttle (mexc.com/api-docs/futures/market-endpoints): klines + funding-rate
// 20/2s, order-book-depth + ticker 10/2s. Its Spot docs' 300-weight/10s figure is
// Spot-scoped and deliberately NOT applied here. We model ONE conservative aggregate
// off the TIGHTEST endpoint (10/2s = 300/min) so the budget stays safe even if every
// call lands on depth/ticker — the same Q2=A reasoning as the OKX row above.
// Ceiling 150 = 50%-of-tightest; reserve 50. CAVEAT: MEXC documents body code 510 for
// rate-limit breach with no HTTP status, so the [418,429] ban detection may not fire.
export const MEXC_REQ_CEILING = 150;
export const MEXC_INTERACTIVE_RESERVE = 50;
const MEXC_VITEST = process.env.VITEST === 'true';
const mexcLedgerSuffix = MEXC_VITEST ? `.test-${process.pid}` : '';
export const mexcWeightBudget = new WeightBudget({
  venue: 'MEXC',
  ledgerPath: process.env.MEXC_WEIGHT_LEDGER ?? `/tmp/algovault-mexc-weight${mexcLedgerSuffix}.json`,
  lockPath: process.env.MEXC_WEIGHT_LOCK ?? `/tmp/algovault-mexc-weight${mexcLedgerSuffix}.lock`,
  ceilingPerMin: MEXC_VITEST ? 1_000_000_000 : MEXC_REQ_CEILING,
  interactiveReserve: MEXC_VITEST ? 0 : MEXC_INTERACTIVE_RESERVE,
  log: MEXC_VITEST ? () => {} : undefined,
});

// Phemex stacks TWO limits (github.com/phemex/phemex-api-docs Generic-API-Info): a
// 5000-req/5min per-IP overall cap AND a per-API-GROUP capacity. Public contract
// market-data falls in the "Others" group, capped at 100/MINUTE — that group cap, not
// the 1000/min overall, is the binding constraint. Kline self-declares weight 10, so
// `weightFor: () => 10` models the real draw (≈5 klines/min at our ceiling). This is
// genuinely the tightest venue in the fleet; live 7d shows only 11 Phemex throws, so
// it is not currently binding, but the model must be honest about the headroom.
// Ceiling 50 = 50%-of-verified group cap; reserve 15.
export const PHEMEX_REQ_CEILING = 50;
export const PHEMEX_INTERACTIVE_RESERVE = 15;
const PHEMEX_VITEST = process.env.VITEST === 'true';
const phemexLedgerSuffix = PHEMEX_VITEST ? `.test-${process.pid}` : '';
export const phemexWeightBudget = new WeightBudget({
  venue: 'Phemex',
  ledgerPath: process.env.PHEMEX_WEIGHT_LEDGER ?? `/tmp/algovault-phemex-weight${phemexLedgerSuffix}.json`,
  lockPath: process.env.PHEMEX_WEIGHT_LOCK ?? `/tmp/algovault-phemex-weight${phemexLedgerSuffix}.lock`,
  ceilingPerMin: PHEMEX_VITEST ? 1_000_000_000 : PHEMEX_REQ_CEILING,
  interactiveReserve: PHEMEX_VITEST ? 0 : PHEMEX_INTERACTIVE_RESERVE,
  log: PHEMEX_VITEST ? () => {} : undefined,
});

// ── The registry ──
// EXHAUSTIVE over PromotedVenueId (derived from capabilities.ts EXCHANGES, the one
// promoted-venue SoT). Omitting a key here is a COMPILE ERROR — that is the whole
// point: promotion and budgeting can no longer drift apart silently.
const VENUE_BUDGETS: Record<PromotedVenueId, VenueBudgetEntry> = {
  HL: { budget: hlWeightBudget, weightFor: (req) => req.weightHint ?? 20 },
  BINANCE: { budget: binanceWeightBudget, weightFor: (req) => req.weightHint ?? 5 },
  BYBIT: { budget: bybitWeightBudget, weightFor: () => 1 },
  OKX: { budget: okxWeightBudget, weightFor: () => 1 },
  BITGET: { budget: bitgetWeightBudget, weightFor: () => 1 },
  ASTER: { budget: asterWeightBudget, weightFor: (req) => req.weightHint ?? 1 },
  BINGX: { budget: bingxWeightBudget, weightFor: () => 1 },
  GATE: { budget: gateWeightBudget, weightFor: () => 1 },
  HTX: { budget: htxWeightBudget, weightFor: () => 1 },
  KUCOIN: { budget: kucoinWeightBudget, weightFor: () => 3 },   // klines weight 3 (docs)
  MEXC: { budget: mexcWeightBudget, weightFor: () => 1 },
  PHEMEX: { budget: phemexWeightBudget, weightFor: () => 10 },  // klines weight 10 (docs)
};

/**
 * Shadow venues (BITMART / EDGEX / WEEX / WHITEBIT / XT) — deliberately SPARSE and
 * NEVER required to be exhaustive. Empty today: shadow data does not feed the public
 * track record, so a ban there degrades nothing user-visible. A shadow venue that
 * needs pacing pre-promotion can get an ad-hoc row here without touching the
 * exhaustive record above; on promotion, tsc will demand it move up.
 */
const SHADOW_VENUE_BUDGETS: ReadonlyMap<string, VenueBudgetEntry> = new Map<string, VenueBudgetEntry>();

/**
 * The cross-process weight budget for `exchangeId`, or null when the venue is
 * delay-paced only (the shadow venues) and therefore has no shared budget.
 * Signature and null-for-shadow behaviour are unchanged — `_upstream-fetch.ts`
 * calls this synchronously before every venue fetch.
 */
export function getVenueBudget(exchangeId: string): VenueBudgetEntry | null {
  const promoted = VENUE_BUDGETS[exchangeId as PromotedVenueId];
  if (promoted) return promoted;
  return SHADOW_VENUE_BUDGETS.get(exchangeId) ?? null;
}

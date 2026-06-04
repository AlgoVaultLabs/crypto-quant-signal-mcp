# EQUITIES-ENGINE — Internal Architecture (Phase 1)

US equities daily-bar composite-verdict engine. Shipped by EQUITIES-ENGINE-W1 (2026-06-04).
Asset-class extension of the AlgoVault "brain": **adapter + namespace + additive resource key +
separate PFE stream** — the reusable pattern future asset classes (options, futures, FX) inherit.

## Data flow
```
Databento EQUS.MINI (hist.databento.com/v0, ohlcv-1d, usage-based, T+1)
      │  HTTP Basic (key=username)
      ▼
EquityBarsProvider ──► build-equity-universe ──► equity_universe (500 + 8 ETFs, median $-vol)
      │                       │
      │                       └──► backfill-equity-bars (2y) ─┐
      ▼                                                       ▼
seed-equities (nightly 17 9 * * 2-6) ──► equity_bars_daily ──► computeEquityVerdict ──► equity_verdicts
                                                                                            │
backfill-equity-outcomes (nightly 41 9 * * 2-6) ── PFE from stored bars ──► equity_verdicts.pfe_pct
                                                                                            │
get_equity_call / get_equity_regime (MCP)  ◄──────────────────────────────────────────────┘
performance://signal-performance .equities (PFE-only)  ◄────────────────────────────────────┘
```

## Modules (`src/lib/equities/`)
| File | Purpose | Pure? |
|---|---|---|
| `equity-constants.ts` | frozen Phase-1 constants (dataset, universe size, ETF whitelist, PFE horizon=5, gap-quarantine 18%/20) | data |
| `equity-symbols.ts` | `normalizeSymbol` (BRK-B→BRK.B Nasdaq form) | ✅ |
| `equity-bars-provider.ts` | Databento REST client (getDailyBars / getDailyBarsRaw / resolveSymbology / getCostUsd / getLatestAvailableSession); CSV parse; bounded retry/backoff; structured errors | — |
| `equity-universe-rank.ts` | median $-vol ranking + ETF-whitelist union | ✅ |
| `equity-indicators.ts` | reuses crypto `indicators.ts` (ema/rsi/adx/hurst/squeeze/structure) on daily bars; `isValidSession` (TRADFI-W1 `isUsMarketHoliday` SoT); `isQuarantined`; `classifyRegime` | ✅ |
| `equity-verdict.ts` | `computeEquityVerdict` (pure, deterministic) → BUY/SELL/HOLD + confidence + regime + `factors[]`; `computeVerdictsForUniverse` batch | mostly |
| `equity-outcomes.ts` | `computePfeOutcome` (entry-anchored signed PFE; outcome_return_pct INTERNAL) | ✅ |
| `equity-tool-formatters.ts` | EXPORTED allow-list formatters + tool orchestrators (quota, universe, structured errors) | formatters ✅ |
| `equity-performance.ts` | PFE-only aggregates for the additive resource key | — |
| `equity-store.ts` | postgres data access (DATABASE_URL; idempotent upserts; public-column reads) | — |

## Why these design choices
- **No funding/OI/cross-venue/sentiment factors.** Those are perp-specific; faking them for equities would be dishonest. The verdict `factors[]` only ever contains `technical:*` and `regime:*`.
- **Gap-quarantine instead of split adjustment.** Databento adjustment-factors / corporate-actions require a separate subscription the usage-based EQUS.MINI plan does NOT include (C1 probe: 403). So an unexplained overnight |gap|>18% (a likely unadjusted split) suppresses the symbol to `HOLD/quarantined` for 20 fresh sessions rather than corrupting the indicator windows.
- **T+1 schedule.** EQUS.MINI *historical* publishes a session's daily bar ~T+1; the live feed (same-evening) is Phase 2. The seed processes `max(available session)`, labelling `as_of_session`, so cron timing affects freshness, not correctness.
- **Single-SoT calendar.** Reuses TRADFI-SIGNAL-HARDENING-W1's `market-sessions-constants.ts` (NYSE 2026-27 holidays) — no duplicate table.
- **outcome_return_pct INTERNAL.** Never SELECTed on the public tool path (`getLatestVerdict` projects allow-listed columns only); allow-list formatters can't emit it; PFE-only on the resource. PII-guard regex + positive-assertion canary.

## Schema (`migrations/005_equities_phase1.sql`)
`equity_bars_daily` (PK symbol,session_date) · `equity_universe` (PK symbol) · `equity_verdicts`
(UNIQUE symbol,session_date,engine_version). NO `equity_adjustment_factors` (NO-GO).

## Ops
Runbook: `docs/RUNBOOK-EQUITIES-ENGINE.md`. Postgres maintenance: `docs/RUNBOOK-POSTGRES-MAINT.md`.
Zero-verdict watchdog: `ops/monitoring/equity-verdict-watch.sh` (host-side, consumes `send_telegram.sh`).

## Phase 2 triggers
EQUS.MINI live subscription (intraday). Trigger: equity-tool call share ≥ stated % of total, OR a paying-customer ask.

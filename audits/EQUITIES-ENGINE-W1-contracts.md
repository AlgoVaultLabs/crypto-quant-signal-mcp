# EQUITIES-ENGINE-W1 — Frozen Contracts (C1)

Frozen 2026-06-04 from live probes (see endpoint-truth.md). Downstream chapters build against these.
**Status: proposed — awaiting architect approval before C2.**

---

## 1 — DDL (migration `migrations/005_equities_phase1.sql`)
R2 verbatim **minus `equity_adjustment_factors`** (ADJUSTMENT_FACTORS: NO-GO). 3 tables. Pre-apply via SSH `psql` in postgres container → `\d` verify → commit schema-as-code (`IF NOT EXISTS` idempotent, no-op on prepared DB).

```sql
CREATE TABLE IF NOT EXISTS equity_bars_daily (
  symbol TEXT NOT NULL, session_date DATE NOT NULL,
  open NUMERIC NOT NULL, high NUMERIC NOT NULL, low NUMERIC NOT NULL, close NUMERIC NOT NULL,
  volume BIGINT NOT NULL, ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(symbol, session_date));
CREATE TABLE IF NOT EXISTS equity_universe (
  symbol TEXT PRIMARY KEY, rank_adv INTEGER, adv_usd NUMERIC, is_etf BOOLEAN DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true, frozen_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS equity_verdicts (
  id BIGSERIAL PRIMARY KEY, symbol TEXT NOT NULL, session_date DATE NOT NULL,
  call TEXT NOT NULL CHECK (call IN ('BUY','SELL','HOLD')),
  confidence NUMERIC, regime TEXT, factors_json TEXT NOT NULL,
  engine_version TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  pfe_horizon_sessions INTEGER, pfe_pct NUMERIC, outcome_return_pct NUMERIC, outcome_filled_at TIMESTAMPTZ,
  UNIQUE(symbol, session_date, engine_version));
```
`outcome_return_pct` INTERNAL — never exposed (PII guard). `equity_adjustment_factors` NOT created.

## 2 — `EquityBarsProvider` interface (`src/lib/equities/equity-bars-provider.ts`)
```ts
export interface EquityBar {
  symbol: string; session_date: string;     // YYYY-MM-DD
  open: number; high: number; low: number; close: number; volume: number;
}
export interface EquityBarsProvider {
  getDailyBars(symbols: string[], start: string, end: string): Promise<EquityBar[]>;   // get_range ohlcv-1d, csv+map_symbols+pretty_px+pretty_ts
  getLatestAvailableSession(): Promise<string>;                                          // metadata.get_dataset_range → available_end-1
  getCostUsd(symbols: string[] | 'ALL_SYMBOLS', start: string, end: string): Promise<number>; // metadata.get_cost
}
```
Auth: HTTP Basic, `DATABENTO_API_KEY` as username + blank password. Encoding **csv** + `map_symbols=true` + `pretty_px=true` + `pretty_ts=true`. Bounded retry/backoff; `p-limit` concurrency; structured error `{code, message, suggested_action}`; fail-open log. `stype_in=raw_symbol`.

## 3 — Tool I/O interfaces (R4; `src/lib/equities/equity-tool-formatters.ts`, EXPORTED allow-list)
```ts
export interface EquityCallInput  { symbol: string; }   // normalize BRK-B → BRK.B
export interface EquityCallOutput { symbol: string; call: 'BUY'|'SELL'|'HOLD'; confidence: number;
  regime: string; factors: string[]; as_of_session: string; universe_rank: number | null; _algovault: object; }
export interface EquityRegimeInput  { symbol?: string; } // default 'SPY'
export interface EquityRegimeOutput { symbol: string; regime: string; confidence: number;
  as_of_session: string; _algovault: object; }
```
Forbidden keys (snapshot `forbidden_keys`): `outcome_return_pct`, `outcome_price`. Errors: `SYMBOL_NOT_IN_UNIVERSE` (+`suggested_symbols` nearest-prefix +universe size), `NO_VERDICT_FOR_SESSION` (+`suggested_action`). Annotations via `tool-annotations.ts` spread. Quota: `checkQuotaByKey` identical to free tools.

## 4 — Universe (frozen)
- Build: `metadata.get_cost`-gated 90-session ALL_SYMBOLS ohlcv-1d pull (9,784 symbols) → rank by median daily $-volume (close×volume) → **top 500** + ETF whitelist.
- **ETF whitelist (8, all live-verified):** `SPY, QQQ, IWM, DIA, IBIT, FBTC, ETHA, EWY`.
- Backfill: 2-year ohlcv-1d, universe-only (500+8), idempotent `ON CONFLICT (symbol, session_date) DO NOTHING`, resumable, per-batch logs.
- C2 floor: `equity_universe` ≥ 500 active; `equity_bars_daily` ≥ 200,000 (≈508 sessions × 500 ≈ 254k expected; floor accommodates partial-history listings).

## 5 — Calendar (frozen — reuse, do NOT duplicate)
Import from `src/lib/market-sessions-constants.js` (TRADFI-W1): `isUsMarketHoliday(isoDate)`, `US_MARKET_HOLIDAYS`, `latestHolidayYear()`. Session-aware windows = weekday AND `!isUsMarketHoliday`. **C2 does NOT create `equity-calendar-constants.ts`.** (Interface re-froze after TRADFI-W1 commit lands.)

## 6 — Cron (frozen — T+1)
`17 9 * * 2-6` (09:17 UTC Tue–Sat covers Mon–Fri sessions) → seed-equities; `41 9 * * 2-6` → backfill-equity-outcomes. `as_of_session = previous` (latest available session via `getLatestAvailableSession()`; correctness independent of fire-time). Holiday no-op via calendar module. Off-:00 ✓. Retry ≥5% interval, exp-backoff. (Supersedes spec's primary `17 22 * * 1-5` — probe showed T+1, not same-evening.)

## 7 — Engine constants (frozen)
- `PFE_HORIZON_SESSIONS = 5` (one trading week; `equity_verdicts.pfe_horizon_sessions` stores per row).
- Gap-quarantine (ADJUSTMENT NO-GO path): unexplained overnight `|gap| > 18%` → suppress `HOLD/quarantined` until **20** fresh sessions re-warm.
- `engine_version = 'equities-v1'`.
- Factor families: `technical:*`, `regime:*` ONLY (no funding/OI/cross-venue/sentiment names).

## 8 — Identifier diff (R vs AC/gate)
| Identifier | Frozen value | R==AC? |
|---|---|---|
| container | `crypto-quant-signal-mcp-mcp-server-1` | ✅ |
| tools | `get_equity_call`, `get_equity_regime` | ✅ |
| DB | `signal_performance` (env-driven `new Pool()`) | ✅ |
| migration | `005_equities_phase1.sql` | resolved 00X→005 |
| cron | `17 9 * * 2-6` / `41 9 * * 2-6` | amended (T+1) — architect ratify |
| PFE horizon | 5 sessions | new freeze |
| forbidden keys | `outcome_return_pct`, `outcome_price` | ✅ |
| universe | 500 + 8 ETFs | ✅ |
| host/key | `204.168.185.24` / `~/.ssh/algovault_deploy` | ✅ |

## 9 — C2 scope amendments (architect ratify)
1. DROP `equity_adjustment_factors` table + `equity-adjustments.ts` (ADJUSTMENT NO-GO) → gap-quarantine only.
2. DROP planned `equity-calendar-constants.ts` → import TRADFI-W1's `market-sessions-constants.ts` (single SoT).
3. CREATE `docs/RUNBOOK-POSTGRES-MAINT.md` (architect-confirmed) — general PG maint (monthly VACUUM ANALYZE cadence, table inventory incl. equity_*, autovacuum insert-scale-factor, info_schema pre-check, grants); cross-link RUNBOOK-EQUITIES-ENGINE.md, no dup. Verify `deploy.yml` paths-ignore includes `docs/**` so it doesn't restart prod.
4. Cron amended to T+1 `17 9 * * 2-6` (probe-driven).

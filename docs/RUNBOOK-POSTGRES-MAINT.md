# RUNBOOK — Postgres Maintenance (`signal_performance`)

Canonical maintenance runbook for the `signal_performance` Postgres DB on Hetzner
(`crypto-quant-signal-mcp-postgres-1`). Referenced by CLAUDE.md `## Deploy pipeline → Postgres provisioning`.
Created by EQUITIES-ENGINE-W1 C2 (the append-only `equity_*` tables made the convention concrete).

## Append-only tables → monthly VACUUM (ANALYZE)

Postgres autovacuum does not aggressively vacuum INSERT-only tables by default, so visibility-map
+ planner stats drift on heavy append tables. Run a monthly `VACUUM (ANALYZE)` and tune the
insert-scale-factor for each append-only table.

| Table | Pattern | Notes |
|---|---|---|
| `signals` | append (crypto signals) | high-volume; primary append table |
| `equity_bars_daily` | append (daily OHLCV) | ~254k rows at 2y/500-sym; grows ~500 rows/session |
| `equity_verdicts` | append + nightly UPDATE (outcome fill) | UPDATE path keeps autovacuum active; ANALYZE still useful |
| `equity_universe` | small, re-frozen periodically | negligible |
| `equity_symbol_misses` | append (out-of-universe demand log) | EQUITY-LAUNCH-READINESS-W1; low-volume; no PII (tickers only); safe to trim >180d |
| `rate_limit_events` | append (typed rate-limit events) | OPS-RATELIMIT-TELEMETRY-DIGEST-W1; rows on a ban/self-throttle/batch-wait/skip; read weekly by `rate-limit-digest-weekly` (renamed from `shadow-digest-weekly` by OPS-TELEMETRY-DIGEST-REFRAME-W1); indexes `(ts, venue)` + `(ts, venue, caller)`; the `caller` column (OPS-RATELIMIT-CALLER-ATTRIBUTION-W1, `NOT NULL DEFAULT 'unknown'`) attributes each event to its entry point (the 9 MCP tools / `grid_warmer` / `backfill`); no PII; safe to trim >90d. NOTE: during an HL saturation window the self-throttle rows run ~8–54/min (not "rare") — at ~1 write/sec fire-and-forget this is still within an on-demand `VACUUM (ANALYZE) rate_limit_events;` (no monthly cron line needed); revisit if the per-caller telemetry later shows write pressure. |

### Monthly cron (host root crontab, off-:00, low-traffic window)
```
23 4 1 * * docker exec crypto-quant-signal-mcp-postgres-1 psql -U "$POSTGRES_USER" -d signal_performance -c "VACUUM (ANALYZE) signals; VACUUM (ANALYZE) equity_bars_daily; VACUUM (ANALYZE) equity_verdicts;" >> /var/log/pg-maint.log 2>&1
```
(`$POSTGRES_USER` is the value of `POSTGRES_USER` in the postgres container env.)

> **OPS-CANDLE-BASIS-SHADOW-DECOM-W1 (2026-08-13):** `candle_basis_shadow` was dropped — it had
> become write-only (both readers retired, closed-bar arc deferred) — so its retention row, its
> mention in the VACUUM line above and its autovacuum setting below were all removed. The other
> three tables are untouched.
>
> ⚠️ Separately, and NOT fixed by that wave: **the monthly cron above is not installed on
> `signal-1`.** Measured 2026-08-13 — the only VACUUM line in the live root crontab is
> `0 4 1 * * … VACUUM (ANALYZE) oi_snapshots`. This block therefore documents maintenance that
> does not run. Filed as `OPS-POSTGRES-MAINT-RUNBOOK-DRIFT-W{NEXT}`; do not read the presence of
> this runbook as evidence the vacuum happens.

### Autovacuum insert-scale-factor tuning (per append table)
For Postgres 13+ the insert-driven autovacuum threshold is tunable per table:
```sql
ALTER TABLE equity_bars_daily   SET (autovacuum_vacuum_insert_scale_factor = 0.05);
ALTER TABLE equity_verdicts     SET (autovacuum_vacuum_insert_scale_factor = 0.10);
```
Lower scale-factor → more frequent insert-triggered vacuums (keeps the visibility map fresh for
index-only scans). 0.05–0.10 is a reasonable starting band for steady daily appends.

## `ADD COLUMN` / migration convention (Postgres 9.6+ supports `IF NOT EXISTS`)

- Pre-apply schema via SSH `psql` BEFORE committing schema-as-code, then ship the code with
  `IF NOT EXISTS` idempotency so the committed migration is a no-op against the prepared DB.
- Pre-check existence before destructive-ish DDL via `information_schema`:
  ```sql
  SELECT 1 FROM information_schema.columns WHERE table_name='equity_verdicts' AND column_name='pfe_pct';
  ```
- Multi-statement DDL is bundled in a single `pool.query(sql)` call (node-pg fire-and-forget on PG
  runs them in one round-trip; do NOT split DDL across `dbExec` calls).

## Ownership / grants

- Application tables are owned by the app DB user (DATABASE_URL user) — DDL is applied through that
  connection so reads/writes need no extra grants.
- Monitoring autopilot role `algovault_autopilot` is read-only + idempotent-recovery ONLY
  (`SELECT`, `pg_stat_statements`, `pg_signal_backend`, `pg_read_all_stats`, matview OWNER for
  REFRESH). NEVER grant it DDL/INSERT/UPDATE/DELETE on `equity_*` or any application table.

## Health checks
```sql
-- bloat / last (auto)vacuum + analyze per append table
SELECT relname, n_live_tup, n_dead_tup, last_vacuum, last_autovacuum, last_analyze, last_autoanalyze
  FROM pg_stat_user_tables WHERE relname IN ('signals','equity_bars_daily','equity_verdicts');
```

Cross-link: equities operational procedures live in `docs/RUNBOOK-EQUITIES-ENGINE.md` (no duplication).

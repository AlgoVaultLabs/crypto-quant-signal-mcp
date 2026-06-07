# RUNBOOK — perf-stats SQL pushdown (OPS-PERFSTATS-SQL-PUSHDOWN-W1)

**Status:** LIVE (flag ON in prod since 2026-06-07). **Class:** INTERNAL/META. **No version bump.**

`getPerformanceStatsAsync()` (the PG path behind `/api/performance-public`, the monitor PFE
check, the landing dashboard) used to load the full `signals` table (~168k rows, growing
O(venues)) into Node and aggregate in JS — **~4.9 s on a cold 60 s-cache miss, holding a pool
connection the whole time.** The pushdown moves the O(rows) counting into Postgres
(`GROUP BY` + `count(*) FILTER`), collapsing ~168k rows to ~15k grouped rows, then does the
O(groups) rollup + ratios + tier classification in JS. **Result: ~4873 ms → ~540 ms (~9×);
DB-connection-hold ~4 s → ~150 ms — invariant to table size.**

The output is **byte-identical** to the in-JS scan (the frozen `computeStats` oracle): proven
by `tests/unit/perfstats-rollup-equivalence.test.ts` (unit) and the live in-container probe
`audits/perfstats-equivalence-probe.js` (`BYTE_EQUIVALENT=true` on the full prod DB).

---

## 1. The flag (outer rollback switch)

`PERF_STATS_SQL_PUSHDOWN` — env var on `crypto-quant-signal-mcp-mcp-server`. **Default-deny:**
only `1` or `true` enables the SQL path; unset / `0` / anything else → the in-JS scan.
Lives in `/opt/crypto-quant-signal-mcp/.env` (mode 600, NOT committed — it's host config, not
a secret). PG-only: the SQLite dev/test path always uses `computeStats` (the `&& isPg` guard).

```
# state
docker exec crypto-quant-signal-mcp-mcp-server-1 env | grep PERF_STATS_SQL_PUSHDOWN
# steady-state proof (which path served the last cold miss)
docker logs crypto-quant-signal-mcp-mcp-server-1 --since 10m | grep '\[perf-stats\] cache miss'
#   mode=sql  → pushdown ;  mode=scan → in-JS oracle
```

## 2. The queries (`buildStatsAggregateSql()` in `src/lib/performance-db.ts`)

- **groups:** `SELECT coalesce(exchange,'HL') AS exchange, coin, timeframe, signal,
  count(*) cnt, count(*) FILTER (WHERE pfe_return_pct IS NOT NULL) pfe_eval,
  count(*) FILTER (WHERE pfe_return_pct IS NOT NULL AND ((signal='BUY' AND pfe_return_pct>0)
  OR (signal='SELL' AND pfe_return_pct<0))) pfe_win, max(created_at) max_ca, max(id) max_id
  FROM signals GROUP BY coalesce(exchange,'HL'), coin, timeframe, signal`
- **period:** `SELECT min(created_at), max(created_at), count(*) FROM signals`
- **recent:** `SELECT <STATS_COL_PROJECTION> FROM signals ORDER BY created_at DESC, id DESC LIMIT 20`

Invariants: **NO `outcome_*`** (PII / Data-Integrity LAW), **NO time-window** (full-table —
must match the on-chain Merkle total), **NO confidence filter** (enforced at write).
`coalesce(exchange,'HL')` mirrors `computeStats`' `s.exchange || 'HL'`. `max(created_at)/
max(id)` drive `rollupStats`' deterministic `byAsset`/`byExchange` ordering (the oracle's
first-seen order is non-deterministic — created_at is unix SECONDS, no id tiebreak).

`EXPLAIN ANALYZE` the groups query: ~136 ms seq-scan (no index needed). `pfe==0` is correctly
**not** a win (strict `>0`/`<0`) — on PFE there are no "losses", so eval−win == #(pfe==0).

## 3. ROLLBACK (instant — the wave's whole point is reversibility)

```
ssh -i ~/.ssh/algovault_deploy root@204.168.185.24
sed -i '/^PERF_STATS_SQL_PUSHDOWN=/d' /opt/crypto-quant-signal-mcp/.env   # remove the flag
cd /opt/crypto-quant-signal-mcp && docker compose up -d mcp-server          # NOT restart (env_file reload rule)
docker exec crypto-quant-signal-mcp-mcp-server-1 env | grep PERF_STATS_SQL_PUSHDOWN || echo "rolled back (flag gone → scan path)"
```

The next cold miss logs `mode=scan`. Output is byte-identical either way, so rollback is
risk-free (it only changes which code path computes the same numbers — slower, but correct).

## 4. Byte-equivalence verification (re-run any time)

```
docker cp /opt/crypto-quant-signal-mcp/audits/perfstats-equivalence-probe.js \
  crypto-quant-signal-mcp-mcp-server-1:/tmp/probe.js
docker exec crypto-quant-signal-mcp-mcp-server-1 node /tmp/probe.js   # → BYTE_EQUIVALENT=true
```

The probe runs both paths on a consistent snapshot (retries until `old.total == new.total`;
the signals table is append-only per Data-Integrity LAW, so equal counts ⇒ identical rows),
compares canonically (recursive key-sort; `recentSignals` gated separately for tie-order),
and asserts zero PII. **`computeStats` is the permanent oracle** — frozen, unexported (invoked
via `_computeStatsOracle`); it stays the SQLite path AND the drift reference.

## 5. Why the public response stays identical

`/api/performance-public` (src/index.ts) AUGMENTS the `PerformanceStats` (`asset_count`,
`exchange_count`, `hold_rate`, `holdsByTier`, `shadow_venue_count`, `timeframe_count`,
`totalHolds`) and FILTERS `byExchange`/`byTimeframe` to promoted venues. All of that derives
from the `PerformanceStats` object, so it is **flag-independent**: equivalence is gated on the
`PerformanceStats` (computeStats ↔ rollupStats); the route's augmentation/filtering applies
identically to both → the public response is byte-identical post-flip (no-data-loss gate +
PII-clean confirmed live).

## 6. Reuse

The pattern — **push counts to SQL, keep ratios + classification in JS, gate with a
byte-equivalence oracle** — plus the pure `rollupStats` + `canonicalizeForCompare` + the probe
harness are directly reusable for the equities-engine stats and any future per-venue stats
surface. (Flagged in WIS.)

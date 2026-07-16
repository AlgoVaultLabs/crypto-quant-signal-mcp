# RUNBOOK — Re-enable the Equity Tools (undo EQUITY-TOOLS-DARK-RETIRE-W1)

**Status:** the equity tools (`get_equity_call`, `get_equity_regime`) are **dark-retired** (EQUITY-TOOLS-DARK-RETIRE-W1, 2026-07-16). **This is a two-way door — nothing was deleted.** The engine code (`src/lib/equities/**`, `src/scripts/{seed-equities,backfill-equity-*,build-equity-universe}.ts`), the postgres tables (`equity_universe`, `equity_bars_daily`, `equity_verdicts`), the view `equity_pfe_by_rank_bucket`, and `DATABENTO_API_KEY` are all intact. Re-enabling is a **flag flip + cron restore**, not a rebuild.

This runbook IS the reversibility guarantee. Every command below is verbatim.

---

## What the retire did

1. **Flag** `EQUITY_TOOLS_ENABLED` (env, default **OFF**) gates — from ONE predicate (`src/lib/equities/equity-tools-flag.ts`) — BOTH:
   - the live MCP `tools/list` registration (`index.ts` loop over `liveMcpToolNames()`): OFF ⇒ 9→7 (equity tools absent),
   - the equity "Tool Promotion Readiness" card in the daily venue digest (`venue-readiness-report.ts`): OFF ⇒ card not rendered.
   `FEATURE_REGISTRY` / `allToolNames()` (9) / `GET /capabilities` (9) / the x402 `HTTP_TOOLS` paid rail were **left unchanged** — the equity tools stay callable via the paid x402 HTTP route; only the free MCP discovery surface + the card went dark.
2. **Host crons** (204.168.185.24, root crontab): removed the equity seed + outcome + launch-readiness lines; disabled the two watchdog scripts. Databento equity spend → 0.

---

## Re-enable — Part A: the flag (tools/list 7→9 + the card return)

On the deploy host `204.168.185.24` (`ssh -i ~/.ssh/algovault_deploy root@204.168.185.24`), in `/opt/crypto-quant-signal-mcp`:

```bash
cd /opt/crypto-quant-signal-mcp
cp .env .env.bak-equity-reenable-$(date -u +%Y%m%dT%H%M%SZ)     # backup .env
grep -q '^EQUITY_TOOLS_ENABLED=' .env \
  && sed -i 's/^EQUITY_TOOLS_ENABLED=.*/EQUITY_TOOLS_ENABLED=1/' .env \
  || printf '\nEQUITY_TOOLS_ENABLED=1\n' >> .env
docker compose up -d mcp-server                                 # recreate (NOT `restart` — env_file only reloads on up -d)
docker exec crypto-quant-signal-mcp-mcp-server-1 printenv | grep EQUITY_TOOLS_ENABLED   # expect EQUITY_TOOLS_ENABLED=1
```

Verify the tools returned (3-step MCP streamable-HTTP handshake against the live endpoint):

```bash
# tools/list should now contain get_equity_call + get_equity_regime (count 9)
curl -s https://api.algovault.com/capabilities | jq '.tools | length'   # stays 9 (capability always declared)
# then POST /mcp initialize → notifications/initialized → tools/list, assert 9 names incl. the 2 equity tools
```

The next venue digest (host cron `5 6 * * *`) will render the equity "Tool Promotion Readiness" card again automatically.

**To re-dark later:** set `EQUITY_TOOLS_ENABLED=0` (or delete the line) → `docker compose up -d mcp-server`. Default is OFF.

---

## Re-enable — Part B: restore the host crons + watchdogs

The retire backed up the crontab to `/tmp/crontab.bak.equity-retire-<TS>` **and** to `/opt/algovault-monitoring/crontab.bak.equity-retire-<TS>` (durable). To restore, re-add these THREE lines verbatim to the root crontab (`crontab -e`) — they are the equity seed (+chained verdict watchdog), the outcome backfill, and the launch-readiness latch:

```cron
17 9 * * 2-6 docker exec crypto-quant-signal-mcp-mcp-server-1 node dist/scripts/seed-equities.js >> /var/log/seed-equities.log 2>&1; /opt/algovault-monitoring/equity-verdict-watch.sh >> /var/log/equity-verdict-watch.log 2>&1
41 9 * * 2-6 docker exec crypto-quant-signal-mcp-mcp-server-1 node dist/scripts/backfill-equity-outcomes.js >> /var/log/backfill-equity-outcomes.log 2>&1
47 10 * * 2-6 /opt/algovault-monitoring/equity-launch-readiness.sh >> /var/log/equity-launch-readiness.log 2>&1
```

Or restore the whole file from the backup (safe — the retire only removed the 3 equity lines):

```bash
crontab /opt/algovault-monitoring/crontab.bak.equity-retire-<TS>   # replace <TS> with the retire timestamp (see status.md)
```

Re-enable the two disabled watchdog scripts (they were renamed, not deleted):

```bash
cd /opt/algovault-monitoring
mv equity-verdict-watch.sh.disabled-equity-retire-<TS>    equity-verdict-watch.sh
mv equity-launch-readiness.sh.disabled-equity-retire-<TS> equity-launch-readiness.sh
chmod +x equity-verdict-watch.sh equity-launch-readiness.sh
```

> The launch-readiness latch fires once when the matured PFE sample crosses N≥150 / S≥3; if it already fired before the retire, remove `/var/lib/algovault-monitoring/equity-launch-readiness.fired` to re-arm.

---

## Data-gap note (important on re-enable)

While dark, the seed/outcome crons did not run, so `equity_bars_daily` / `equity_verdicts` stopped accruing new sessions (last pre-retire session was captured in status.md). **No data was lost** — the tables kept every historical row. On re-enable, the existing self-heal window in `seed-equities` / `backfill-equity-bars` back-fills the missing daily bars/verdicts on the next few cron cycles (Databento EQUS.MINI supports the historical daily range). Expect the readiness card to show a recency gap for a day or two until the backfill catches up. If a large gap needs a one-shot catch-up, run manually:

```bash
docker exec crypto-quant-signal-mcp-mcp-server-1 node dist/scripts/backfill-equity-bars.js   # historical bars
docker exec crypto-quant-signal-mcp-mcp-server-1 node dist/scripts/seed-equities.js          # verdicts for latest session
docker exec crypto-quant-signal-mcp-mcp-server-1 node dist/scripts/backfill-equity-outcomes.js
```

---

## Strategic context (why it's dark)

Equities were reclassified **capability-only optionality** (Mr.1 2026-07-15, status.md): US-equity directional edge is a low-probability multi-year slog for a 2-person shop; the cross-venue moat is structurally crypto-only. The equity engine already hit the modal ~49% directional accuracy (no validated edge — EQUITY-CALIBRATION-AUDIT-W1 = NO-GO). Re-enable only on a deliberate strategic trigger (e.g. Robinhood-agentic-equity making it worth serving). Public equity performance copy stays **HOLD** regardless — never a win-rate/accuracy claim without a validated edge.

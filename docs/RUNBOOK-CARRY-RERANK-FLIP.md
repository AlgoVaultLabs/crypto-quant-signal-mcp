# RUNBOOK — carry-ranker re-rank flip (scan_funding_arb ordering)

_EDGE-CARRY-SERVING-W1 shipped the machinery DARK. This runbook is the ONE-LINE flip a separate
Mr.1 dispatch executes after divergence review. Scope inherited from `CARRY_RANKER_PASS_TA`:
**re-ranking (selection) only — no performance-claim language of any kind, internal or public.**_

## What flips

`scan_funding_arb` result ordering switches from the composite `rankScore` sort to: carry-scored
items first (model score desc), unscored items after (legacy order). Response SHAPE, fields,
quotas, pricing, tool description: UNCHANGED. Fail-open: scores stale (>3h) / table missing / any
read error → legacy order automatically.

## Pre-flip checklist (Mr.1)

- [ ] Evidence pack reviewed (`audits/EDGE-CARRY-SERVING-W1-*.md`): ≥24h divergence stats
      (Kendall tau, top-5 overlap, worked examples), scorer freshness uptime, retrain dry-run decision.
- [ ] Per-venue honesty note acknowledged: the ranker's paired Tier-A evidence is strongest on
      HL + BYBIT (+ POOLED); BINANCE/ASTER/KUCOIN cells did not clear FDR individually.
- [ ] `carry_rank_scores` fresh right now:
      `docker exec crypto-quant-signal-mcp-postgres-1 psql -U algovault -d signal_performance -tA -c "SELECT MAX(scored_at), COUNT(*) FROM carry_rank_scores"`
- [ ] Explicit Mr.1 ack recorded in status.md (public-behavior change = explicit permission, per LAW).

## Flip (both flags — the two-flag firewall)

```bash
ssh -i ~/.ssh/algovault_deploy root@204.168.185.24
cd /opt/crypto-quant-signal-mcp
printf 'CARRY_RANKER_SOURCE=postgres\nCARRY_RANKER_ENABLED=true\n' >> .env   # or the compose env_file in use — verify first
docker compose up -d mcp-server        # up -d, NOT restart (restart does not reload env_file)
docker exec crypto-quant-signal-mcp-mcp-server-1 env | grep CARRY_RANKER    # BOTH values present
```

Verify: run a low-threshold scan (`minSpreadBps: 0.01`) and confirm the container log line
`[carry-divergence] {... "applied": true ...}` + ordering follows scores.

## Rollback (instant)

Remove/comment both lines from the env file → `docker compose up -d mcp-server` → verify
`applied: false` in the next divergence line. No data migration, no schema change — ordering
reverts to legacy immediately. (Reader failure modes fail-open to legacy even while flipped.)

## Retrained-artifact archival (release lane note)

Weekly retrains that PASS the rolling Tier-A gate swap `current.json` on 204 and log to
`/opt/algovault-carry/carry_ranker_reports.duckdb` (204-local; there is NO automated 204→178
path). When a release wave bundles this, scp the promoted `carry-ranker-vN.{json,joblib.gz}`
from `/opt/algovault-carry/artifact/` into the AOE repo `src/research/carry/artifacts/` for
provenance.

## Pre-flagged release-note DRAFT (next release wave; Mr.1 approves wording separately)

> **Classification: EXTERNAL** (user-visible ordering change once flipped). Not shipped until the
> flip is live. No performance-claim language permitted.

```markdown
### scan_funding_arb — smarter result ordering
Results are now ordered by AlgoVault's funding-persistence model (retrained weekly against its
own quality gate), so the spreads most likely to persist surface first. Same response shape,
same fields, same pricing — ordering only. Set `minSpreadBps` as before to control the universe.
```

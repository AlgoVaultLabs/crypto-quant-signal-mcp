# Shadow-Seed Decision Runbook (1m + 3m)

**Wave**: SHADOW-SEED-W1 (live since 2026-04-30)
**Decision day**: ~2026-05-14 (after 2 weekly digests)

## Background

Until v1.10.5, the cron seed pipeline only generated public-track-record signals
on the 9 timeframes 5m–1d. The v1.x assumption was "sub-5m indicators are
noise-dominated by design" — but that claim was never empirically measured.

This wave **adds 1m + 3m to the cron pipeline in shadow mode**: signals land
in the `signals` table and accrue PFE/MAE outcomes, but `byTimeframe`
aggregation in `/api/performance-public` strips them out by default. After
2 weeks of accumulation, the data tells us whether 1m/3m signals clear the
public-track-record bar.

## Decision threshold

For each timeframe to **PASS** and become eligible for public surfacing:

- PFE Win Rate ≥ **85%** (matches the rest of the public track record)
- Sample size ≥ **3,000** (statistical floor for the rolling window)

A 1m or 3m verdict in the weekly digest will be one of:

- `PASS` — clears both gates; ready for the public flip
- `FAIL` — sample size sufficient but PFE WR below 85%
- `INSUFFICIENT_DATA` — not enough samples yet to evaluate

## Where to find the data

Every Sunday at **00:00 UTC**, the Hetzner cron runs
`dist/scripts/shadow-digest-weekly.js` and posts a Telegram message to Mr.1's
chat with the per-TF samples, PFE WR, top/bottom performers, and verdict.

Two digests will fire before decision day (2026-05-07 and 2026-05-14).

To dry-run on demand:

```bash
ssh root@204.168.185.24 'docker exec crypto-quant-signal-mcp-mcp-server-1 \
  node dist/scripts/shadow-digest-weekly.js --dry-run'
```

## Public flip (PASS verdict)

When a timeframe earns `PASS`, surface it publicly:

```bash
# Option A: flip just 3m
ssh root@204.168.185.24 \
  'echo "SHADOW_REVEAL_TIMEFRAMES=3m" >> /opt/crypto-quant-signal-mcp/.env && \
   cd /opt/crypto-quant-signal-mcp && docker compose up -d mcp-server'

# Option B: flip both 1m and 3m
ssh root@204.168.185.24 \
  'sed -i "/^SHADOW_REVEAL_TIMEFRAMES=/d" /opt/crypto-quant-signal-mcp/.env && \
   echo "SHADOW_REVEAL_TIMEFRAMES=1m,3m" >> /opt/crypto-quant-signal-mcp/.env && \
   cd /opt/crypto-quant-signal-mcp && docker compose up -d mcp-server'
```

After flip, verify:

```bash
curl -fsS https://api.algovault.com/api/performance-public | \
  jq '.byTimeframe | keys'
# Should now include 3m (or 1m and 3m) in the array
```

Then update the public copy:

- `landing/index.html` and `README.md` — change "9 of 11" to "10 of 11" or "11 of 11"
  (note: the AUTO-TRACE-W1 wave already removed the explicit "9 of 11" string from
  the dashboard; the FAQ JSON-LD describes "all 11 timeframes" already)
- One announcement post (Hashnode + X) with the live PFE WR number for the
  newly-surfaced timeframe(s)

## Rollback (FAIL or surface damage)

If a flip produces unexpected behavior on the dashboard or PFE WR drops post-flip:

```bash
ssh root@204.168.185.24 \
  'sed -i "/^SHADOW_REVEAL_TIMEFRAMES=/d" /opt/crypto-quant-signal-mcp/.env && \
   cd /opt/crypto-quant-signal-mcp && docker compose up -d mcp-server'
```

Verify:

```bash
curl -fsS https://api.algovault.com/api/performance-public | \
  jq '.byTimeframe | keys'
# 1m and 3m must be ABSENT
```

## Stopping the shadow seed entirely

If the experiment is conclusive failure (both timeframes FAIL after 4 weeks)
and Mr.1 wants to stop accumulating data:

```bash
ssh root@204.168.185.24 'crontab -l | grep -v "shadow-1m\|shadow-3m" | crontab -'
```

That removes the 1m + 3m cron entries. Existing rows in `signals` table stay
(do not delete — they remain useful for historical regime analysis).

## Decision-day calendar marker

**2026-05-14 — review SHADOW-SEED-W1 digest data**:

- Read the latest weekly digest in Telegram
- If either TF has `PASS` → execute public-flip recipe above
- If both have `FAIL` → keep shadow-mode for another 2 weeks, reassess on 2026-05-28
- If `INSUFFICIENT_DATA` → check cron health, may need to extend universe size

Document the decision in `status.md` with the live verdict numbers.

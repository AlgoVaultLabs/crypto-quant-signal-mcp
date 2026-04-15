# Activation Funnel — Analytics Logbook

This directory is the activation analytics logbook for `crypto-quant-signal-mcp`. Its purpose is to track which activation levers we've shipped, when they went live, and what each one moved on the funnel — grounded in measurable `request_log` / `agent_sessions` data, not narrative claims. This is signal-interpretation product analytics, not outbound messaging: every entry is a dated observation on our own funnel, tied to a commit SHA and a pre/post metric, so downstream decisions stay evidence-based.

## Funnel stages glossary

- `install` — NPM download + `npx` execution of `crypto-quant-signal-mcp`
- `first_call` — distinct session_id makes its first remote tool call (any of the 3 tools)
- `second_call` — same session_id makes a second remote tool call (captured via `agent_sessions.call_count >= 2`)
- `fifth_plus_call` — same session_id reaches `agent_sessions.call_count >= 5` (stick-rate proxy)
- `paid_upgrade` — session's license tier transitions from `free` to `starter`/`pro`/`enterprise` (captured via Stripe subscription creation or x402 USDC receipt)

## Lever Ledger

| Lever | Hypothesis (one line) | Shipped in | Commit SHA | Deploy date | Metric targeted | Verdict |
|---|---|---|---|---|---|---|
| **L1 — Signal performance resource** | Expose track_record WR/EV per cell in get_trade_signal response | pending (Phase-E gated, ≥2026-04-17) | pending | pending | second_call rate | pending |
| **L2 — HOLD rescue** | Return closest_tradeable cell on HOLD verdicts so 88% HOLD responses aren't dead-ends | v1.9.0 | 050bd95 / squashed to 2288b93 | 2026-04-15 | HOLD bounce rate, second_call rate | pending (2026-04-29 measurement) |
| **L3 — Session cohort surfacing** | Persist per-session metadata in agent_sessions table to make retention directly queryable | v1.9.0 | 75dc913 (part of PR#2 squash) | 2026-04-15 | stick_rate measurability | ✅ unblocks measurement — no metric yet |
| **L4 — Next-calls hints** | Include try_next top-3 non-HOLD cells in every response to distribute agents off BTC/ETH 1h | v1.9.0 | 75dc913 (part of PR#2 squash) | 2026-04-15 | calls_per_session, tool_call_distribution | pending (2026-04-29 measurement) |

## Snapshot Ledger

| Date | Tag | Sessions | Install-to-call | Stick-rate | HOLD rate | Notes |
|---|---|---|---|---|---|---|
| 2026-04-15 | baseline | 18 | 70.5:1 | 5.6% | 88.2% | Pre-v1.9.0 activation patch — data from analytics-funnel-snapshot-2026-04-15.md |

## How to run

- **Manual snapshot:** `cd crypto-quant-signal-mcp && npx tsx scripts/write-funnel-snapshot.ts --tag manual`
- **SQL-only:** `cat activation-funnel/queries/funnel-snapshot.sql | docker exec -i crypto-quant-signal-mcp-postgres-1 psql -U algovault -d signal_performance`
- **Auto cron (future):** `systemctl list-timers algovault-funnel-snapshot.timer` (Hetzner VPS) — registration is a manual follow-up; see `ops/systemd/` for unit files

# L3 — Session cohort surfacing

## Hypothesis

Retention is unmeasurable because `session_id` is extracted at the MCP transport layer but never persisted or surfaced. Creating the `agent_sessions` table and surfacing `session_id` in the `_algovault` metadata unblocks direct retention queries (instead of reconstruction from `request_log` aggregates), which closes data-gap #2 from the baseline snapshot and makes every downstream activation experiment measurable.

## Change shipped
- **Version:** 1.9.0
- **Commit SHA:** 75dc913 (part of activation-patch squash)
- **Deploy date:** 2026-04-15
- **PR:** https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/pull/2

## Metric(s) targeted
- `stick_rate measurability` (now a direct query on `agent_sessions.call_count`)
- `time_to_first_call p50/p90` (now queryable from `agent_sessions.first_seen`)
- `tools_used dedup cohort` (now directly queryable)

## Pre-value (2026-04-15 baseline)

- `agent_sessions` table was empty pre-v1.9.0.
- The 2026-04-15 baseline measured stick_rate = **5.6%** (1 / 18 sessions with ≥2 calls) via `request_log` aggregate reconstruction.
- Data-gap #2 from the funnel snapshot (no per-session persistence) is now closed.

## Post-value (measurement)
<!-- populated by 2026-04-29 snapshot -->

## Lift
<!-- populated by 2026-04-29 snapshot -->

## Verdict
<!-- populated by 2026-04-29 snapshot -->

## Next iteration
<!-- populated by 2026-04-29 snapshot -->

# L2 — HOLD rescue

## Hypothesis

88% of `get_trade_signal` responses today return HOLD (which is FREE per the Apr 11 pricing change), so agents hit a dead-end 88% of the time. Surfacing `closest_tradeable` — the single highest-confidence non-HOLD cell from the cross-asset grid — converts those dead-end HOLD responses into a concrete next-call candidate the agent can act on without re-prompting the user.

## Change shipped
- **Version:** 1.9.0
- **Commit SHA:** 75dc913 (initial activation-patch squash) + 2288b93 (internal-bypass hotfix)
- **Deploy date:** 2026-04-15
- **PR:** https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/pull/2 + https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/pull/3

## Metric(s) targeted
- `HOLD bounce rate` (agents who hit HOLD and never call back)
- `second_call rate`
- `tool_call_distribution per (coin, timeframe)` (should broaden from BTC/ETH-only)

## Pre-value (2026-04-15 baseline)

- **HOLD rate on `get_trade_signal`:** 88.2% (15 / 17 calls)
- **Coin/timeframe concentration:** 100% of calls on BTC or ETH, 15m or 1h only
- **Bounce rate post-HOLD:** 100% — no agent made a second call after receiving a HOLD

## Post-value (measurement)
<!-- populated by 2026-04-29 snapshot -->

## Lift
<!-- populated by 2026-04-29 snapshot -->

## Verdict
<!-- populated by 2026-04-29 snapshot -->

## Next iteration
<!-- populated by 2026-04-29 snapshot -->

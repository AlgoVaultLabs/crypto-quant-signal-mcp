# L4 — Next-calls hints

## Hypothesis

Agents who call `get_trade_signal BTC/1h` and see HOLD have no signal pushing them toward other parts of the market where the scorer currently has conviction. Surfacing `try_next` — the top-3 non-HOLD cells from the 24-cell cross-asset grid, excluding the requested cell — distributes calls off BTC/ETH 1h and onto regions the scorer believes in, which should broaden tool call distribution and raise calls-per-session.

## Change shipped
- **Version:** 1.9.0
- **Commit SHA:** 75dc913 + 2288b93
- **Deploy date:** 2026-04-15
- **PR:** https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/pull/2 + https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/pull/3

## Metric(s) targeted
- `calls_per_session p50/p90`
- `tool_call_distribution per (coin, timeframe)` (breadth — concentration index)
- `second_call rate`

## Pre-value (2026-04-15 baseline)

- **Coin/timeframe concentration:** 100% of calls on BTC or ETH, 15m or 1h only — maximum concentration.
- **Median calls per session:** 1
- **Tool call distribution (n=32):**
  - `get_trade_signal` — 53.1%
  - `get_market_regime` — 25.0%
  - `scan_funding_arb` — 18.8%
  - `get_signal_performance` — 3.1%

## Post-value (measurement)
<!-- populated by 2026-04-29 snapshot -->

## Lift
<!-- populated by 2026-04-29 snapshot -->

## Verdict
<!-- populated by 2026-04-29 snapshot -->

## Next iteration
<!-- populated by 2026-04-29 snapshot -->

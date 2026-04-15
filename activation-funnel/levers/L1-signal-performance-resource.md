# L1 — Signal performance resource

## Hypothesis

Agents receive a single-shot HOLD/BUY/SELL verdict with no reason to make a second call. Inlining a `track_record` field with WR/EV per confidence-bucket per `(coin, timeframe)` in the `get_trade_signal` response gives agents a concrete reason to call back — to check whether their own trade's confidence bucket has a positive expected value. This is the single highest-leverage activation lever that survives the stdio architecture, because it turns a one-shot verdict into an evidence feed the agent must re-consult.

## Change shipped
- **Version:** pending
- **Commit SHA:** pending
- **Deploy date:** pending
- **PR:** pending

Gated on Phase E ✅ (2026-04-17 ~02:30 UTC).

## Metric(s) targeted
- `second_call rate`
- `fifth_plus_call rate`
- `calls_per_session median`

## Pre-value (2026-04-15 baseline)

Per the 2026-04-15 baseline snapshot:
- Median calls/session = **1**
- Second_call rate = **39%** (7 / 18 sessions)
- Fifth_plus_call rate = **5.6%** (1 / 18 sessions)

## Post-value (measurement)
<!-- populated by 2026-04-29 snapshot -->

## Lift
<!-- populated by 2026-04-29 snapshot -->

## Verdict
<!-- populated by 2026-04-29 snapshot -->

## Next iteration
<!-- populated by 2026-04-29 snapshot -->

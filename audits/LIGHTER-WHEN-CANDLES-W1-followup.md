# LIGHTER-WHEN-CANDLES-W1 — follow-up wave note

**Filed**: 2026-05-16 by PILOT-ADAPTERS-W1 / C3.
**Status**: DEFERRED — awaiting one of three unblock conditions.
**Architect decision (2026-05-16)**: Path A — defer Lighter to wave 4+; ship 2-DEX cohort (Aster + edgeX) in v1.12.0.

---

## Why deferred

Lighter (zkSync perp DEX, 177 perps, ~$950M OI per AMBCrypto 2026-05-16)
clears the $1B DEX OI threshold gate for the SHADOW-PROMOTE state machine,
BUT the `/api/v1/candlesticks` endpoint at `mainnet.zklighter.elliot.ai`
returns `HTTP/1.1 403 Forbidden` from CloudFront with `X-Cache:
FunctionGeneratedResponse from cloudfront` header — a function-level auth
gate, NOT a geo block (reproduces from both Kuala Lumpur and Hetzner-DE
PoPs per PILOT-ADAPTERS-W1 Plan-Mode probe).

Without OHLCV historical bars, the indicator pipeline cannot compute
RSI/EMA/Hurst/squeeze — the adapter would degrade to all-HOLD verdicts
permanently, polluting telemetry without producing useful signals.

Other Lighter endpoints work fine:
- `GET /api/v1/orderBookDetails` ✅ — 177 perps with per-market `open_interest`, `last_trade_price`, 24h ticker fields (`daily_price_high/low`, `daily_base_token_volume`, etc.)
- `GET /api/v1/fundings?market_id=N&...` ✅ — historical funding rates

The blocker is candles-only.

## Unblock conditions

This follow-up wave fires when ONE of:

1. **Lighter publishes the auth scheme for `/candlesticks`** — discoverable via:
   - `https://github.com/elliottech/lighter-go` (Go SDK) — inspect for an API-key generation flow or signed-request header pattern.
   - `https://github.com/elliottech/lighter-python` (if exists) — same probe.
   - `app.lighter.xyz` web-app cookie inspection (chrome devtools network tab on the candles request).
   - Discord / Telegram / X channels announcing public-read tokens.

2. **Lighter removes the CloudFront Function rule** — re-probe periodically:
   ```bash
   curl -sS -i 'https://mainnet.zklighter.elliot.ai/api/v1/candlesticks?market_id=0&resolution=1h&start_timestamp=$(date +%s)&end_timestamp=$(date +%s)&count_back=2' --max-time 10 | head -1
   ```
   Expected unblock signal: `HTTP/1.1 200 OK` with JSON body containing `candlesticks: [...]`.

3. **We invest 3–5 days in synthesizing candles from WSS trade-tick feed** — out of scope for "ship 3-DEX cohort" wave; only justified if Lighter remains the highest-priority zkSync DEX integration after 6+ months of waiting.

## Wave shape when fired

Mirror the C2 (edgeX) chapter structure:
1. Plan-Mode probe re-confirms `/api/v1/candlesticks` is accessible.
2. Author `src/lib/adapters/lighter.ts` (~250 LoC, similar to edgeX shape).
3. Widen `ExchangeId` 7 → 8 with `'LIGHTER'`.
4. Widen Zod enums + describe-text in `src/index.ts`.
5. Add `case 'LIGHTER': new LighterAdapter()` to dispatch.
6. `tests/unit/lighter-adapter.test.ts` (~15 cases).
7. venues seed `INSERT (LIGHTER, shadow, 177, 1770, NOW(), 0, 'LIGHTER-WHEN-CANDLES-W1 ...')`.
8. Version bump 1.12.x → 1.13.0 (enum widening = visible schema change).
9. CHANGELOG entry + cache-refresh notice.
10. RUNBOOK appendix entry for "Archetype D: zkSync custom REST".

## Adjacent considerations

- **PILOT-ADAPTERS-SEED-LOOP-W2** (separate follow-up) needs to widen the
  per-venue branches in `src/scripts/seed-signals.ts` to include all
  shadow venues. Currently ASTER + EDGEX are callable via explicit MCP
  param but won't auto-accumulate from the daily restricted-universe
  cron. When LIGHTER-WHEN-CANDLES-W1 fires, this seed-loop expansion
  should land in the same wave (or as an immediate follow-on) so the
  full 3-DEX cohort progresses through the state machine in lockstep.

- **AOE per-venue weight registry** (Phase 3) consumes `venues.promoted_at`
  — when LIGHTER promotes, AOE should pick it up automatically per the
  existing EXCHANGE-SHADOW-PROMOTE-W1 contract. No additional wiring
  needed.

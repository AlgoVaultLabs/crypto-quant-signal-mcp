# Runbook — Onboarding a new exchange venue under the SHADOW-PROMOTE lifecycle

**Wave context:** EXCHANGE-SHADOW-PROMOTE-W1 (2026-05-16).

This runbook is the canonical operator process for adding a new exchange
integration. New venues default to `status='shadow'` and auto-promote via the
daily `evaluate-venues` cron when they accumulate `asset_count × 10` BUY/SELL
signals with PFE WR ≥ 0.80 (HOLDs excluded). The full state machine lives in
`src/lib/venue-store.ts`; the cron logic in `src/scripts/evaluate-venues.ts`;
the public exposure in `src/index.ts` `/api/performance-shadow`.

---

## Step 1 — Pre-integration probe (10 minutes)

Run BEFORE writing any adapter code. Save outputs under
`audits/<wave>-pilot-probe-<venue>.md`.

### 1.a AUM / OI ranking

Per `project_aum_over_volume_cex_ranking`:

- **CEX candidates**: AUM ≥ $500M via `https://api.llama.fi/protocols`
  (DefiLlama) — filter `category: "CEX"` or cross-check Coingecko's
  exchange-trust-score page.
- **DEX candidates**: notional Open Interest ≥ $1B via DefiLlama protocol
  `tvl` field (use `?protocol=<slug>` endpoint).

If the venue doesn't clear these thresholds, **stop here** — the venue's
signal density won't justify the integration cost.

### 1.b Public REST API surface

Probe each of the three required endpoints with `curl -fsS -o /dev/null -w
"%{http_code}\n"`:

1. **Candle / kline endpoint** — must return `[time, open, high, low, close,
   volume]` (or equivalent fields per the venue's docs). Confirm 11
   timeframes supported: `1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 12h, 1d`.
2. **Funding rate endpoint** — must return current + historical funding rates.
   Note the funding period (CEX is typically 8h; some venues are 1h or 4h —
   per-period rate must be annualized using the convention in
   `src/lib/adapters/<existing>.ts` per `AssetContext.fundingAnnualized`).
3. **Open Interest endpoint** — must return current notional OI.

### 1.c Streamable HTTP / WSS feed (optional but preferred)

Probe `wss://` or `https://stream...` per venue docs. If absent, fall back to
HTTP polling (matches existing 5-exchange pattern). Streamable feeds are
nice-to-have for future live-tick integration but NOT a hard requirement.

### 1.d Symbol naming convention

Sample the venue's instrument-list endpoint + check 5-10 known symbols
against AlgoVault canonical names:

- Crypto majors: `BTC`, `ETH`, `SOL` — expect `<COIN>USDT` /
  `<COIN>_USDT` / `<COIN>-USDT-SWAP` per venue conventions.
- TradFi (if venue offers): `TSLA`, `GOLD`, `SILVER` — check for aliases
  (`XAU`, `XAG`, etc.) per the existing `TRADFI_ALIASES` map shape in
  `src/lib/adapters/binance.ts`.
- Memes: any 1000-prefixed listings? (Document for the adapter's
  `SYMBOL_OVERRIDES` map.)

### 1.e Rate limits

Read the venue's docs for per-IP / per-API-key rate limits. Document:

- Request budget per minute / per second.
- Burst tolerance.
- Whether the venue rate-limits more aggressively from cloud-IP ranges (some
  CEXs block AWS/GCP-class IPs).

If the budget is tighter than 100 req/min, expect to add a request throttle
in the adapter (see `bitget.ts` for the existing throttle pattern).

### 1.f Probe outputs

Save the CSV row `(venue, kind, aum_or_oi, passes_threshold, rest_ok, ws_ok,
symbol_naming, rate_limit, api_quality, composite, notes)` to
`audits/<wave>-pilot-probe-<venue>.md`. Surface the top picks to Mr.1 for
ratification BEFORE writing adapter stubs.

---

## Step 2 — Author the adapter stub (1 hour)

Mirror the existing `src/lib/adapters/binance.ts` template — it's the
canonical shape:

```ts
// src/lib/adapters/<venue>.ts
import type { ExchangeAdapter, Candle, AssetContext, FundingData } from '../../types.js';
import { UpstreamRateLimitError } from '../errors.js';

const BASE_URL = '<venue REST base>';
const TIMEOUT_MS = 3000;

// Some venues use 1000-prefix for low-price tokens
const SYMBOL_OVERRIDES: Record<string, string> = { /* see binance.ts */ };

// Optional: TradFi alias map (probe per Plan-Mode coverage CSV)
const TRADFI_ALIASES: Record<string, string> = { /* GOLD: 'XAU' etc. */ };

export function to<Venue>Symbol(coin: string): string { /* ... */ }
export function from<Venue>Symbol(symbol: string): string { /* ... */ }

export class <Venue>Adapter implements ExchangeAdapter {
  getName(): string { return '<Venue>'; }
  async getCandles(coin, interval, startTime, _dex) { /* ... */ }
  async getAssetContext(coin, _dex) { /* ... */ }
  async getPredictedFundings(): Promise<FundingData[]> { /* ... */ }
  async getFundingHistory(coin, startTime) { /* ... */ }
  async getCurrentPrice(coin, _dex) { /* ... */ }
}
```

### 2.a Register in the dispatcher

Add the adapter to `src/lib/exchange-adapter.ts` `getAdapter()`:

```ts
case '<VENUE>':
  return new <Venue>Adapter();
```

### 2.b Widen the ExchangeId enum

Two sites in `src/types.ts`:

```ts
export type ExchangeId = 'HL' | 'BINANCE' | 'BYBIT' | 'OKX' | 'BITGET' | '<VENUE>';
```

### 2.c Widen the Zod schema enum + describe-text

Two sites in `src/index.ts` (`TRADE_CALL_SCHEMA.exchange` for
get_trade_call/signal + the get_market_regime registration's inline enum):

```ts
exchange: z.enum(['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', '<VENUE>'])
  .default('BINANCE')
  .describe("Exchange to analyze. 'BINANCE' = Binance USDT-M Futures (default), …, '<VENUE>' = <Venue display name>. Shadow venues (experimental, not yet on public dashboard) require explicit exchange param; query the mcp://algovault/venues resource for the live per-venue status table. Asset availability varies per venue — pass exchange explicitly to target a specific venue.")
```

---

## Step 3 — Seed the venues row (5 minutes)

Insert a new row at `status='shadow'`. Use `insertVenue()` from venue-store:

```ts
await insertVenue({
  exchangeId: '<VENUE>',
  status: 'shadow',
  assetCount: <probed-from-venue-exchangeInfo>,  // NOT COUNT(DISTINCT coin) from signals!
  notes: 'Pilot batch <N> per <WAVE>',
});
```

**Critical**: for a new venue, `asset_count` is the venue's TOTAL listed perp
catalog (probed from `<BASE_URL>/exchangeInfo` or equivalent at integration
time) — NOT `COUNT(DISTINCT coin) FROM signals WHERE exchange = ?`. The
latter is COSMETIC for the 5 already-promoted venues; the former is the
BINDING gate target for shadow → promoted transition. See the header note in
`migrations/003_seed_venues_promoted.sql` for the asset_count divergence.

Or via raw SQL:

```sql
INSERT INTO venues (
  exchange_id, status, asset_count, min_buy_sell_sample,
  integrated_at, extension_count, notes
) VALUES (
  '<VENUE>', 'shadow', <N>, <N*10>, NOW(), 0, '<wave-ref>'
)
ON CONFLICT (exchange_id) DO NOTHING;
```

---

## Step 4 — Deploy + wait for cron evaluations

Push the commit; GHA deploys; container restarts; `evaluate-venues.timer`
fires daily at 06:00 UTC. The decision tree:

- **Day 0-14**: NO-OP (within initial window).
- **Day 15+**:
  - IF `buy_sell_count ≥ asset_count × 10` AND `pfe_wr ≥ 0.80` → auto-promote
    + Telegram 🟢 `Venue PROMOTED: <VENUE>`.
  - ELSE (one-shot) → auto-extend + Telegram 🟡 `Venue auto-EXTENDED (day-15 miss)`.
- **Day 30+** after one extension:
  - Telegram 🔴 `Venue MANUAL DECISION REQUIRED (day-30, 2nd miss)`. NO
    automatic state change. Mr.1 manually decides PROMOTE / RETIRE /
    EXTEND_AGAIN.

Watch logs: `ssh ... 'tail -f /var/log/algovault-evaluate-venues.log'`.

---

## Step 5 — Manual promotion / retirement (when needed)

On day-30 second miss, Mr.1's decision options:

```bash
# Option A — manually promote (if WR is high enough to trust despite low sample)
ssh -i ~/.ssh/algovault_deploy root@204.168.185.24 \
  'docker exec crypto-quant-signal-mcp-postgres-1 psql -U algovault -d signal_performance -c \
  "UPDATE venues SET status='\''promoted'\'', promoted_at=NOW(), notes=COALESCE(notes,'\'''\'') || '\'' / manually promoted by Mr.1 <date>'\'' WHERE exchange_id='\''<VENUE>'\''"'

# Option B — retire (venue is structurally unsuitable; adapter stays but venue not routed)
ssh -i ~/.ssh/algovault_deploy root@204.168.185.24 \
  'docker exec crypto-quant-signal-mcp-postgres-1 psql -U algovault -d signal_performance -c \
  "UPDATE venues SET status='\''retired'\'', retired_at=NOW(), notes=COALESCE(notes,'\'''\'') || '\'' / retired by Mr.1 <date>: <reason>'\'' WHERE exchange_id='\''<VENUE>'\''"'

# Option C — reset extension counter to grant another auto-extend cycle (rare)
ssh ... 'docker exec ... -c "UPDATE venues SET extension_count=0 WHERE exchange_id='\''<VENUE>'\''"'
```

Container restart NOT required — the cron re-reads venues table on every fire.

---

## Failure modes + recovery

| Failure | Symptom | Recovery |
|---|---|---|
| Adapter throws on first seed cycle | Cron log shows `[seed-signals] <VENUE>: <error>` | Verify Plan-Mode probe step 1.b/1.c outputs; fix adapter bug; re-deploy. No venues-table mutation needed (cron retries next cycle). |
| `venues` row missing post-deploy | `getVenue('<VENUE>') === null`; envelope falls back to `'promoted'` default (backward-compat) | Re-run Step 3 seed INSERT manually. |
| `asset_count` snapshot drifted from venue's true catalog | Venue added N new listings; `min_buy_sell_sample` is now too low | Operator-only: `await refreshAssetCount('<VENUE>', <new-count>)` — re-computes `min_buy_sell_sample = newCount × 10`. NOT auto-bumped. |
| Cron job fails (postgres outage, OOM) | journalctl shows non-zero exit; Telegram silent | `systemctl status evaluate-venues.service` + check `/var/log/algovault-evaluate-venues.log`. Re-fire manually: `systemctl start evaluate-venues.service`. Cron is idempotent. |
| Telegram alert never arrives despite log saying `actions=N` | `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` missing/stale | Check `/opt/crypto-quant-signal-mcp/.env`; reload container env if rotated. `sendVenueStatusChange` silently no-ops if not configured (intentional — dev/test). |
| Day-30 manual_required alert ignored | Venue stuck at `shadow` past day-30; spamming daily alerts | The daily cron will re-fire the manual_required alert every day until status changes. Mr.1 should resolve via Step 5 within 7 days; if longer, mute the Telegram thread until decided. |
| Pilot venue collides with existing venue's symbol-naming | E.g. new venue uses `BTCUSDT-PERP` instead of `BTCUSDT` | Add to adapter's `SYMBOL_OVERRIDES` map; do NOT touch `TRADFI_ALIASES` (different semantics). |

---

## Verification gate before tagging the wave done

```bash
ssh -i ~/.ssh/algovault_deploy root@204.168.185.24 \
  "docker exec crypto-quant-signal-mcp-postgres-1 psql -U algovault -d signal_performance -c \"SELECT exchange_id, status, asset_count, min_buy_sell_sample FROM venues ORDER BY status, exchange_id\""

curl -sS https://api.algovault.com/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "mcp-session-id: $(./scripts/get-session-id.sh)" \
  -d '{"jsonrpc":"2.0","method":"resources/read","id":1,"params":{"uri":"mcp://algovault/venues"}}' \
  | jq '.result.contents[0].text | fromjson | .venues[] | {exchange_id, status}'

# /api/performance-shadow is auth-gated (OPS-AUDIT-REMEDIATION-MED-W1 / SV-01) — send an API key:
curl -sS -H "Authorization: Bearer $ALGOVAULT_API_KEY" https://api.algovault.com/api/performance-shadow | jq '.venues[].exchange_id'
```

Expected: new venue appears in all three views with `status='shadow'`.

---

## Appendix — Wave 1 DEX adapter lessons (PILOT-ADAPTERS-W1, 2026-05-16)

The first DEX cohort surfaced 3 architecture-specific lessons that should
shape future DEX adapter authoring. Each candidate from the 11-DEX Plan-Mode
probe pool fell into one of these archetypes:

### Archetype A: Binance-clone (Aster pattern)

**Aster (BNB Chain, 410 perps)** ships a near-verbatim Binance Futures REST
API at `fapi.asterdex.com/fapi/v1/*`:

- Same paths (`/fapi/v1/{exchangeInfo, klines, premiumIndex, openInterest, ticker/24hr, fundingRate}`)
- Same response shapes (array-of-arrays for klines; flat objects for ticker)
- Same Binance funding-period convention (per-8h → annualized × 1095)
- Same query-param conventions (`symbol`, `interval`, `startTime`, `limit`)

**Adapter authoring**: copy `src/lib/adapters/binance.ts` template; swap
`BASE_URL`, exchange-name string in `UpstreamRateLimitError`, and (if absent)
drop `SYMBOL_OVERRIDES` + `TRADFI_ALIASES` constants. ~180 LoC.

**When to use this pattern**: any DEX or CEX advertising "Binance-compatible
API" in their docs (common for newer BNB-Chain perps + Binance-derived
forks). Verify via Plan-Mode probe: instrument-list path, kline response
array-shape, premiumIndex field names.

### Archetype B: Custom-envelope L2 (edgeX pattern)

**edgeX (L2 zk-rollup, 292 contracts)** uses a custom REST API at
`pro.edgex.exchange/api/v1/public/*`:

- Response envelope: `{code:"SUCCESS", data:..., msg, errorParam, requestTime, responseTime, traceId}` — adapter must unwrap `.data` at every call site
- Numeric `contractId` ("10000001") as primary key — adapter needs a lazy-
  init `contractName ↔ contractId` lookup map fetched once from
  `/api/v1/public/meta/getMetaData` (cache TTL 1h)
- `<COIN>USD` naming (NOT `<COIN>USDT`)
- Kline `klineType` SNAKE_UPPERCASE values: `MINUTE_1` / `HOUR_1` / `DAY_1`
- `getKline` REQUIRES explicit `from`/`to` millisecond params; empty params
  silently return `dataList:[]` (catch this in Plan-Mode probe — test with
  valid params before declaring "kline broken")
- `getTicker` is an all-in-one bundle (mark + index + oracle + last price,
  fundingRate + fundingTime + nextFundingTime, openInterest, 24h
  high/low/open/close/volume) — single REST call satisfies `getAssetContext`
- Funding cadence varies — edgeX is 4 hours (nextFundingTime - fundingTime =
  14.4M ms). Annualized = rate × 2190. DIFFERENT from Binance/Bybit/Bitget/
  Aster (8h, ×1095) and HL (1h, ×8760).

**Adapter authoring**: fresh module, ~280 LoC. Plan-Mode MUST probe the
funding-period delta (`nextFundingTime - fundingTime` in ms) to compute the
annualization multiplier — DO NOT assume 8h. Probe via:

```bash
curl -sS '<venue>/quote/getTicker?contractId=<id>' | jq '{fundingTime, nextFundingTime}'
# Compute: (nextFundingTime - fundingTime) / 3_600_000 = funding-hour cadence
# Annualized multiplier: 8760 / funding-hour
```

**When to use this pattern**: any DEX with a custom REST envelope (most L2
zk-rollup perps; most modern DEX launches). Plan-Mode probe MUST surface
the funding-period in ms BEFORE authoring the `fundingAnnualized` field.

### Archetype C: Auth-gated public REST (Lighter pattern — DEFERRED)

**Lighter (zkSync, 177 perps)** has rich per-market data via
`mainnet.zklighter.elliot.ai/api/v1/orderBookDetails` (OI, last_trade_price,
24h ticker — 4 of 5 required capabilities in one call) BUT `/candlesticks`
is CloudFront-Function-blocked: `HTTP/1.1 403 Forbidden` + `X-Cache:
FunctionGeneratedResponse from cloudfront`. Reproduces from both Kuala
Lumpur (KUL51-P1 PoP) AND Hetzner-DE (HEL51-P4 PoP) → function-level auth
gate, not a geo block.

**Adapter authoring**: HALT-class. Without OHLCV bars, indicator pipeline
cannot compute RSI/EMA/Hurst/squeeze.

**Architect ratified Path A** for PILOT-ADAPTERS-W1 (defer Lighter; ship
2-DEX cohort instead). `LIGHTER-WHEN-CANDLES-W1` follow-up wave to revisit
when one of these unblocks:

1. Lighter publishes the auth scheme for `/candlesticks` (some SDK
   key-generation flow surfaces in their GitHub `elliottech/lighter-go` or
   `app.lighter.xyz` web-app cookie inspection).
2. Lighter removes the CloudFront Function rule on `/candlesticks` (lifts
   the public-read gate).
3. We invest in synthesizing candles from the WSS trade-tick feed (custom
   adapter pattern; ~3-5 days of work; out of scope for the "ship 3-DEX
   cohort" wave shape).

**When to use this pattern (DON'T — flag the venue):** any DEX where the
candle endpoint requires authentication that the public docs don't disclose.
Plan-Mode probe MUST attempt the candle endpoint from at least 2 distinct
geographic PoPs (local + Hetzner) BEFORE declaring "no candles" — geo
restrictions are common, function-level gates are rarer but more permanent.

### Cross-archetype Plan-Mode probe checklist for future DEX waves

Run BEFORE adapter authoring (5-min effort):

```bash
# Liveness + auth posture
curl -sSI '<BASE_URL>' --max-time 10

# Instrument list (count + sample symbol)
curl -sS '<BASE_URL>/<INSTRUMENTS_PATH>' --max-time 15 | jq '. | length // .data | length // .symbols | length'

# Kline shape + interval support (probe 1m + 1h + 1d at minimum)
NOW_MS=$(date +%s000); START_MS=$((NOW_MS - 86400000))
for interval_or_klinetype in <VENUE_SPECIFIC>; do
  curl -sS '<BASE_URL>/<KLINE_PATH>?<params>' --max-time 10 | jq '. | length // .data.dataList | length'
done

# Funding cadence probe (CRITICAL — annualization multiplier depends on this)
curl -sS '<BASE_URL>/<TICKER_OR_FUNDING_PATH>?<sym_param>' \
  | jq '{fundingTime, nextFundingTime, fundingRate}'
# Compute: cadence_h = (nextFundingTime - fundingTime) / 3_600_000
# Annualization multiplier: 8760 / cadence_h

# OI endpoint (separate or bundled into ticker)
curl -sS '<BASE_URL>/<OI_PATH_OR_TICKER>?<sym_param>' | jq '.data.openInterest // .openInterest // .open_interest'

# 2-geo probe for CloudFront/auth gates (do BOTH)
curl -sS -i 'https://<host>/<candle_path>' --max-time 10 | head -5      # local
ssh -i ~/.ssh/algovault_deploy root@<hetzner-ip> "curl -sS -i 'https://<host>/<candle_path>' --max-time 10 | head -5"  # Hetzner-DE
```

If any returns `HTTP 4xx` with `X-Cache: FunctionGeneratedResponse from
cloudfront` or similar function-level rejection from BOTH geos → flag
HALT-class and triage paths (defer / degraded / auth-investigate).


---

## Appendix — Wave 2 CEX adapter lessons (PILOT-ADAPTERS-W2, 2026-05-19)

Wave 2 shipped 3 CEX shadow adapters (Gate.io + MEXC + KuCoin) into shadow
mode. All 3 share Binance-family architecture (custom REST envelope; auth-
free public read paths; 8h funding cadence × 1095 annualization). The
divergence is on candle response shape + symbol naming + TradFi catalog
coverage. Per Mr.1 "integrate all in one batch" directive 2026-05-19, the
3 chapters shipped full TRADFI_ALIASES maps + venue-coverage.ts extensions
in lockstep.

### Archetype D: Custom-envelope CEX with all-in-one ticker (Gate.io pattern)

**Gate.io (719 USDT perps + 26 TradFi)** ships a JSON REST API at
`api.gateio.ws/api/v4/futures/usdt/*`:

- Custom envelope: array responses for tickers/contracts/klines (no
  `{code, data, msg}` wrapper).
- Symbol convention: `<COIN>_USDT` (underscore separator).
- Candle response row-wise with field names `o/h/l/c/v/sum/t` — `t` in
  SECONDS (not ms; adapter converts).
- All-in-one ticker `/api/v4/futures/usdt/tickers?contract=<sym>` bundles
  `funding_rate + mark_price + index_price + total_size (OI) +
  volume_24h_quote + last + change_percentage`.
- Embedded funding rate AND funding interval on the contracts list (one
  call gives funding for all venues at once via `getPredictedFundings`).

**TRADFI_ALIASES map (6 entries):**
`GOLD → XAU` (Gate has BOTH XAU and XAUT spot symbols; prefer XAU per
Binance canonical pattern). `SILVER → XAG, PLATINUM → XPT, PALLADIUM → XPD,
COPPER → XCU, NATGAS → NG`. Stocks (AMD/BABA/COST/CRWV/HIMS/INTC/LITE/LLY/
MSFT/MU/NFLX/SNDK/TSM/USAR) + ETFs (EWJ/EWY) + VIX route DIRECT.

**Adapter authoring**: ~245 LoC fresh implementation (NOT a Binance clone
— different field names + seconds-not-ms time + array envelope). Single
all-in-one ticker call simplifies `getAssetContext` compared to Binance's
3-fan-out (premiumIndex + openInterest + ticker/24hr).

### Archetype E: Column-wise candle response (MEXC pattern)

**MEXC (881 USDT perps + 15 TradFi)** ships REST at
`contract.mexc.com/api/v1/contract/*`:

- Envelope: `{success, code, data:{...}}` — adapter unwraps `.data`.
- Symbol convention: `<COIN>_USDT` (underscore — same as Gate).
- **Candle response is COLUMN-WISE**: `{time:[], open:[], high:[],
  low:[], close:[], vol:[], amount:[]}`. Adapter MUST zip-transpose into
  row-wise `Candle[]`. Unique among the 3 W2 venues.
- Kline interval strings are SNAKE-UPPERCASE: `Min1`, `Min5`, `Min15`,
  `Min30`, `Min60`, `Hour4`, `Hour8`, `Day1`, `Week1`, `Month1`.
- All-in-one ticker `/api/v1/contract/ticker?symbol=<sym>` bundles
  `fairPrice (=mark) + indexPrice + lastPrice + holdVol (=OI) +
  fundingRate + volume24 + amount24 + high24Price + lower24Price`.
- **The dedicated OI endpoint `/api/v1/contract/open_interest/<sym>`
  returns Akamai 403 from any IP**. Use ticker `holdVol` instead.

**MEXC's unique TradFi naming**: uses descriptive English names where
other CEXes use trading-symbol abbreviations:
- `USOIL_USDT` ≠ `CL_USDT` (canonical CL = WTI crude → alias `CL: 'USOIL'`).
- `UKOIL_USDT` ≠ `BRENT_USDT` (canonical BRENTOIL → alias `BRENTOIL: 'UKOIL'`).
- `SILVER_USDT` (literal; canonical name match).
- `COPPER_USDT` (literal; canonical name match).
- `XAUT_USDT` (Tether Gold, NOT XAU; price-probe confirmed $4546 ≈ gold
  spot $4555 → 0.20% spread within tolerance per
  `semantic-fingerprint-probe-before-alias-commit` skill).

**TRADFI_ALIASES map (4 entries):** `GOLD → XAUT, CL → USOIL,
BRENTOIL → UKOIL, PLATINUM → XPT, PALLADIUM → XPD`. SILVER/COPPER/FX
(EUR/GBP/JPY)/JP225/EWJ/EWY/XLE route DIRECT.

**Adapter authoring**: ~245 LoC. The column-wise transpose helper is
~10 LoC inline; everything else mirrors the Gate.io pattern.

### Archetype F: X-prefix + M-suffix legacy convention (KuCoin pattern)

**KuCoin Futures (594 USDT perps + 36 TradFi)** at
`api-futures.kucoin.com/api/v1/*` is the most-divergent of the 3:

- **Symbol convention: `<COIN>USDTM`** (M-suffix for USDT-margined) +
  **`BTC → XBT` override** (X-prefix replaces B per KuCoin legacy spot
  convention; `XBTUSDTM` not `BTCUSDTM`). Other coins: M-suffix only.
- `contracts/active` IS the all-in-one ticker — single endpoint returns
  the instrument list AND per-contract live data (markPrice, indexPrice,
  openInterest in contracts, multiplier, fundingFeeRate,
  nextFundingRateTime as ms-until-next, daily ticker fields).
- Single-contract endpoint `/api/v1/contracts/<symbol>` for per-symbol
  fetch.
- Kline `granularity` is **INTEGER MINUTES** (60 for 1h, 15 for 15m,
  1440 for 1d, etc.). NOT a string.
- Candle response is row-wise array-of-arrays `[t, o, h, l, c, v]` —
  Binance-like row shape but raw integer-minutes granularity index.
- OI multiplier-aware: `openInterest` is in CONTRACTS; multiply by
  `multiplier` (e.g. 0.001 for XBT) to get base-asset OI.

**TRADFI_ALIASES map (4 entries):** `GOLD → XAUT` (KuCoin has only XAUT;
price-probe confirmed $4548 ≈ gold spot), `SILVER → XAG, PLATINUM → XPT,
PALLADIUM → XPD`. **26 stocks route DIRECT** (AAPL/AMD/AMZN/BABA/COIN/
COST/CRCL/CRWV/GOOGL/HIMS/HOOD/INTC/LITE/LLY/META/MSFT/MSTR/MU/NFLX/
NVDA/ORCL/PLTR/SNDK/TSLA/TSM/USAR). ETFs EWJ/EWY direct. COPPER/CL/
NATGAS direct.

**KUCOIN_SYMBOL_OVERRIDES** map: `{ BTC: 'XBT' }` — single entry; ETH and
other crypto don't need overrides.

**SPX trap (consistent with TRADFI-SYMBOL-ALIAS-W1 lesson)**: `SPXUSDTM`
on KuCoin is the SPX6900 memecoin ($0.37 mark), NOT the S&P 500 index.
**DO NOT alias `SP500 → SPX`** on KuCoin. SP500 stays HL-only.

**Adapter authoring**: ~245 LoC. Most divergent of the 3 (X-prefix
override + M-suffix + integer-minutes granularity + multiplier-aware OI).
All endpoints publicly accessible (no HMAC required for read paths —
confirmed via Plan-Mode probe).

### Semantic-fingerprint price-probe (Wave-2 application)

The TRADFI-SYMBOL-ALIAS-W1 lesson (`semantic-fingerprint-probe-before-
alias-commit` skill) fired again in W2:

- `SPX_USDT` (Gate) = $0.37 = SPX6900 memecoin → DO NOT alias as SP500.
- `SPXUSDTM` (KuCoin) = $0.37 = SPX6900 memecoin → DO NOT alias.
- `XAUT` (Gate/MEXC/KuCoin) = $4546-4549 vs gold spot $4555 → 0.20%
  Tether redemption spread, within tolerance → SAFE to alias as GOLD on
  venues where XAU is not listed.

**Rule: every TRADFI alias candidate gets a price-probe BEFORE adapter
ships**. Run the bash one-liner from the cross-archetype probe checklist
in the W1 appendix above. Fail-loud if mark-price is >2× off
expected order of magnitude.

### venue-coverage.ts full-stack alignment lesson

C1 (Gate.io) initially shipped with adapter `TRADFI_ALIASES` but no
corresponding `src/lib/venue-coverage.ts` extension. Live MCP probe
caught the failure immediately:

```
get_trade_call({coin:"GOLD", exchange:"GATE"})
→ TRADFI_SYMBOL_UNSUPPORTED_ON_VENUE (gate fires before adapter)
```

The venue-coverage gate at `src/tools/get-trade-call.ts:111` checks
`getVenuesSupporting(coin).includes(exchange)` BEFORE calling the
adapter. Without the matrix extension, the adapter's TRADFI_ALIASES map
is functionally dead.

**Rule: per `feedback_full_stack_alignment` memory** — adapter
TRADFI_ALIASES and `venue-coverage.ts` matrix are a coupled pair. Every
W2 chapter touches BOTH in lockstep. The C1-FF hotfix commit (~30 min
after C1's initial deploy) added the missing matrix entries; C2 + C3
included them in the initial commit.

When onboarding venue N+1:
1. Probe venue's TradFi catalog against `TRADFI_FALLBACK` 60-symbol set.
2. Build `TRADFI_ALIASES` map per the per-venue native conventions.
3. **In the same commit**, extend `src/lib/venue-coverage.ts`:
   - Add the new venue to existing PARTIAL_COVERAGE rows where it has
     that TradFi listing.
   - Move HL_ONLY entries OUT to PARTIAL_COVERAGE when the new venue
     unlocks them (e.g. C2 MEXC moved EUR/JPY/JP225/BRENTOIL out).
   - Add NEW PARTIAL_COVERAGE rows for TradFi symbols that previously
     defaulted to ALL_5 but the new venue adds coverage for.
4. Live MCP probe a NON-CRYPTO TradFi call against the new venue to
   confirm the matrix extension is correct end-to-end.

---

## Wave 3A CEX adapter lessons (PILOT-ADAPTERS-W3A 2026-05-20)

Three Tier-A established CEX adapters shipped sequentially into shadow:
Phemex (C1) + BingX (C2) + HTX (C3). Each lands an `ExchangeAdapter`
implementation + Zod widening + dispatch + venue-coverage extension +
unit tests + venue insert via the one-shot `seed-shadow-venues-w3a.ts`
script. Below are the lessons unique to W3A's batch.

### Per-venue symbol convention

| Venue   | Convention   | Example       | Note                                            |
|---------|--------------|---------------|-------------------------------------------------|
| Phemex  | concatenated | `BTCUSDT`     | V2 hedged USDT perp; **no `c` prefix** (legacy non-hedged uses `c`-prefix on a DIFFERENT product family — `cBTCUSD` — NOT targeted) |
| BingX   | hyphen       | `BTC-USDT`    | mirrors HTX                                     |
| HTX     | hyphen       | `BTC-USDT`    | field name is `contract_code`, not `symbol`     |

### Phemex Rp/Rv/Rr REAL-suffix clarification (NOT Ev/Rv encoding)

Plan-Mode spec warned about Phemex's "Ev/Rv scaled-integer encoding"
where prices need `decodeEv(value, scale)` division by 10^scale. **For
the V2 hedged USDT perpetual family (`perpProductsV2`), this is FICTIONAL.**

Live probe 2026-05-20 of `BTCUSDT` V2 contract metadata:
```
priceScale: 0
ratioScale: 0
```

And the V2 ticker endpoint `/md/v2/ticker/24hr?symbol=BTCUSDT` returns:
```
closeRp = "76646.9"       (Real Price)
markPriceRp = "76648.7"
fundingRateRr = "0.00007873"  (Real Ratio)
openInterestRv = "2726.8480639" (Real Value)
```

The `Rp/Rv/Rr/Rq` suffix = **R**eal value (already unscaled). The
`Ev/Er` encoding only applies to the LEGACY non-hedged inverse contracts
(`data.products` array, e.g. `cBTCUSD`). For the V2 USDT-margined hedged
perp — the actual W3A integration target — NO decoding required.

**Adapter implication:** Phemex `getCandles` parses the 10-field kline row
`[ts_sec, interval_sec, last_close, open, high, low, close, volume,
turnover, symbol]` as direct decimals (indices 3-7 for OHLCV). No
`decodeEv()` helper exists; no decoding unit tests needed.

### Phemex kline `limit` is a FIXED ENUM

`/exchange/public/md/v2/kline/last?symbol=&resolution=&limit=N` accepts
ONLY: `{5, 10, 50, 100, 500, 1000}` → HTTP 200. Any other value (11, 20,
30, 40, 60, 70, 75, 80, 90, 110, 120, 150, 200, 250, 300, ...) returns
HTTP 400 `code:30000 "Please double check input arguments"`.

This was the most surprising W3A finding. Initial adapter shipped
`KLINE_LIMIT = 200` and got caught by the post-deploy R7 verification
gate (`Phemex API 400: Bad Request`); hotfix commit `c2b258c` bumped to
`KLINE_LIMIT = 1000` (max of the enum). **No other W3A venue has this
quirk** — BingX (`limit` up to 1440) and HTX (`size` up to ≥2000) accept
normal integer ranges.

### BingX rate-limit upgrade context (2025-10-16)

BingX did a public rate-limit refresh per their bingx.com support
article 31103871611289. Adapter ships standard `Retry-After` parse on
HTTP 429 + 500ms backoff between attempts. The upgrade is generous
enough that 429s rarely fire under shadow-mode load (1 candle fetch
+ 3-call fan-out per `get_trade_call` cycle).

### HTX rate-limit generosity (800 req/sec per-IP, market-data only)

HTX is the most-generous of W3A's three on market-data endpoints.
Retries should rarely fire. The non-market public endpoints have
240/3s per-IP — still ample for shadow venue load.

### TradFi coverage per W3A venue (Plan-Mode probe 2026-05-20)

| Coin     | Phemex     | BingX    | HTX        | Notes                                  |
|----------|------------|----------|------------|----------------------------------------|
| GOLD     | XAU ✓      | XAUT ✓   | XAU ✓      | HTX has BOTH XAU + XAUT; prefer XAU spot (mirrors Gate). BingX only has XAUT. |
| SILVER   | XAG ✓      | (none)   | XAG ✓      |                                        |
| PLATINUM | XPT ✓      | (none)   | XPT ✓      |                                        |
| PALLADIUM| XPD ✓      | (none)   | XPD ✓      |                                        |
| COPPER   | direct ✓   | (none)   | direct ✓   | venue uses literal canonical name      |
| NATGAS   | NG ✓       | (none)   | direct ✓   | Phemex aliases; HTX literal            |
| USOIL    | CLO ✓      | (none)   | direct ✓   | Phemex's `CLO` is WTI oil; HTX literal |
| BRENTOIL | (none)     | (none)   | direct ✓   | HTX-only of W3A batch                  |
| VIX      | direct ✓   | (none)   | (none)     | Phemex-only of W3A batch               |
| **SP500**| **direct ✓** ($7338 real S&P 500) | (none)   | (none)     | **Phemex UNIQUELY routable** — only shadow CEX with the real S&P 500 perp |
| Stocks (TSLA/NVDA/META/GOOGL/AAPL/AMZN/COIN/MSTR/MSFT) | direct (8 of 9 listed; HOOD/ORCL/PLTR/CRCL not) | (none) | direct (5 of 9: META/NVDA/MSFT/GOOGL/AAPL listed) | sparsity varies; matrix matters |

### SPX6900 memecoin trap — 4th-sighting affirmation

All 3 W3A venues carry `SPXUSDT` / `SPX-USDT` at $0.36 — the SPX6900
memecoin namespace collision (NOT S&P 500). 4th sighting across the
adapter fleet (Binance / Gate / KuCoin previously). **None of the three
W3A `TRADFI_ALIASES` maps include SPX.** Phemex uniquely also has the
real `SP500USDT` ($7338 verified live); that routes via identity (no
alias row needed). HTX has BOTH `XAU` (real spot, $4467) AND `XAUT`
(Tether Gold, $4466) — adapter prefers `GOLD → XAU` for spot fidelity.

### `getPredictedFundings()` returns `[]` for all 3 venues (W3A Q-4 ratification)

Phemex has no working batch-tickers endpoint (probed
`/md/v2/ticker/24hr/all` returned empty; `/md/v3/ticker/24hr/all`
returned null). BingX has per-symbol `/premiumIndex` only.  HTX has
per-symbol `/swap_funding_rate` only. For a shadow venue not yet
published to `scan_funding_arb`, returning `[]` is the correct shape —
cross-venue funding fanout fires only for promoted venues. Per
PILOT-ADAPTERS-W3A Plan-Mode Q-4 ratification 2026-05-20. Promotion-
ready implementation can wire per-canonical-universe (~30 coin) parallel
fetch when each venue clears the PFE WR ≥ 0.80 + `asset_count × 10`
sample gate.

### Seed-script: bypass `dbRun` fire-and-forget on PgBackend

`venue-store.insertVenue()` calls `dbRun(...)` which on `PgBackend` is
fire-and-forget (`this.pool.query(...).catch(err => ...)` — Promise
dropped). In a one-shot script context the pool gets closed BEFORE the
INSERT commits. **`seed-shadow-venues-w3a.ts` bypasses the helper** and
uses `pg.Pool` directly with `await pool.query(...)` + `RETURNING
exchange_id` for explicit insert-landed confirmation. Same class of bug
as GEO-MEASUREMENT-W1's `dbExec` fire-and-forget DDL-bundling hotfix
(`5b2244f`). Permanent fix is the deferred `VENUE-STORE-AWAIT-INSERT-W1`
follow-up to add a properly-awaitable `insertVenueAsync` on the helper.

### Identifier-diff: actual 10 → 13 venues (NOT spec's 11 → 14)

Plan-Mode spec's "11 venues post-W2 → 14 post-W3A" was off by 1.
Lighter (PILOT-ADAPTERS-W1's third venue) is a DEX served via the
`HyperliquidAdapter` route and never landed in the `ExchangeId` union
nor the `venues` table. Pre-W3A state was **10 venues (5 promoted + 5
shadow)**; post-W3A C3 is **13 venues (5 promoted + 8 shadow:
ASTER/EDGEX/GATE/MEXC/KUCOIN/PHEMEX/BINGX/HTX)**.

---

## Wave 3B CEX adapter lessons (PILOT-ADAPTERS-W3B 2026-05-20)

Four emerging-tier CEX adapters shipped sequentially: WEEX (C1) + Bitmart
(C2) + XT.COM (C3) + WhiteBIT (C4). Final state: **17 venues** (5 promoted
+ 12 shadow). Below the lessons unique to W3B's batch.

### Per-venue symbol convention (4 unique conventions)

| Venue    | Convention             | Example          | Note |
|----------|------------------------|------------------|------|
| WEEX     | lowercase + cmt_ prefix | `cmt_btcusdt`   | Most-divergent of any AlgoVault adapter to date. The `cmt_` prefix is WEEX's contract-type marker. |
| Bitmart  | concatenated           | `BTCUSDT`        | Binance-style; no separator. |
| XT.COM   | lowercase + underscore | `btc_usdt`       | UNIQUE case-sensitivity (lowercase). |
| WhiteBIT | underscore + _PERP     | `BTC_PERP`       | UNIQUE — settlement currency NOT encoded in symbol; 100% USDT-settled per Plan-Mode probe (filter is no-op safety belt). |

### WEEX 4h funding cadence — FIRST non-8h venue in adapter fleet

All 11 prior CEXes use 8h × 1095 annualization. WEEX uses **4h × 2190**
per contract metadata `delivery: ["00:00:00", "04:00:00", "08:00:00",
"12:00:00", "16:00:00", "20:00:00"]` = 6 settlements/day.

Math: 4h × 2190 = 8760 = 1 year. Cross-venue scorer compares
`fundingAnnualized` across venues, so getting the cadence right is
critical. Failure mode if you assume 8h × 1095: annualized rate is OFF
BY 2× → cross-venue funding-arb scorer ranks WEEX incorrectly.

**Probe checklist for future venue onboarding**: every Plan-Mode adapter
audit MUST inspect the contract metadata for an explicit `delivery` /
`settlement_period` / `fundingInterval` field BEFORE assuming 8h cadence.
Adapter fleet now has 1 precedent of non-8h (WEEX 4h).

### WEEX no-public-funding workaround

Plan-Mode probed 7 candidate paths — all 404 or auth-gated:
- `/capi/v2/market/funding-rate?symbol=`
- `/capi/v2/market/funding/funding-rate?symbol=`
- `/capi/v2/market/funding/<symbol>`
- `/capi/v2/market/fundingRate?symbol=`
- `/capi/v1/market/funding-rate?symbol=`
- `/capi/v2/contract/funding-rate?symbol=`
- `/capi/v2/market/historyFundRate?symbol=` (returns "参数为空" — parameter empty; may be auth-gated)

Adapter returns `getAssetContext.funding = 0` + `openInterest = 0` with
comment, and `getFundingHistory()` + `getPredictedFundings()` return
`[]`. Same fail-soft shape as W3A Q-4 shadow-venue pattern. Promotion
criteria use PFE WR + sample count (not funding rate), so this doesn't
block shadow→promoted.

If WEEX exposes a public funding endpoint in a future API version, this
adapter is the canonical place to wire it.

### Bitmart kline `step` is a fixed minutes-ENUM (W3A-precedent trap)

Bitmart's `/contract/public/kline` accepts `step` as **MINUTES ENUM
{1, 3, 5, 15, 30, 60, 120, 240, 720}**. step=480 returns HTTP 400;
step=1440 / 4320 / 10080 return 0 rows.

Same shape as Phemex's kline limit ENUM `{5, 10, 50, 100, 500, 1000}`
discovered in W3A C1 hotfix `c2b258c`. **This is now a recurring trap
class**: intermediate values often fail when larger AND smaller values
work, indicating the parameter is an ENUM not a free integer.

Bitmart STEP_MAP includes fallbacks: 8h→240 (=4h), 1d→720 (=12h), 12h→720.

**Plan-Mode probe pattern for any kline `step` / `limit` / `period`
parameter**: probe `{1, 5, 11, 50, 100, 200, 500, 1000}` (or vendor max)
— if intermediate values FAIL while smaller AND larger values PASS, the
parameter is an ENUM. Document the valid set verbatim in the adapter
docstring + INTERVAL_MAP comment.

### Bitmart kline `limit` NOT honored — uses time window

`limit` query param is silently ignored by Bitmart's `/contract/public/
kline`. Adapter computes start_time + end_time window from desired
candle count × interval-in-seconds. Same shape as Gate.io (W2 C1).

### XT.COM endpoint-path correction — `/future/api/v1/` is FICTIONAL

The W3B spec assumed `/future/api/v1/public/...` was the XT.COM API
path. Plan-Mode probe revealed that path returns:

```json
{"returnCode":0,"msgInfo":"success","error":null,"result":{"openapiDocs":"https://doc.xt.com"}}
```

— a placeholder pointing to docs. The actual live API path family is
`/future/market/v1/public/...`:
- `/future/market/v1/public/symbol/list` — 943 contracts (filter
  `contractType==PERPETUAL` → 893)
- `/future/market/v1/public/q/kline?symbol=&interval=&limit=`
- `/future/market/v1/public/q/agg-ticker?symbol=` (bundles mark + index
  + last + bid + ask)
- `/future/market/v1/public/q/funding-rate?symbol=` (returns
  `{symbol, fundingRate, nextCollectionTime, collectionInternal: 8}`)

OI endpoint NOT FOUND at `/q/open-interest` (404). Adapter uses 0.

XT is the **2nd venue (after Phemex) with the REAL S&P 500 perp** —
`sp500_usdt` = $7400.11 live-verified via semantic-fingerprint probe.
venue-coverage.ts SP500 row extended to `['HL', 'PHEMEX', 'XT']` in
same-commit per `adapter-tradfi-aliases-and-venue-coverage-matrix-are-
coupled-pair` rule.

### WhiteBIT v1 kline endpoint (NOT v4)

WhiteBIT's documented `/api/v4/public/kline` is **empty**; the actual
working kline endpoint is **`/api/v1/public/kline?market=&interval=&
limit=`**. Interval is STRING family `1m`/`15m`/`30m`/`1h`/`4h`/`1d`
(integers `60`/`3600` FAIL with "Invalid interval").

Row shape is NON-STANDARD: `[ts_sec, open, CLOSE, HIGH, LOW, base_vol,
quote_vol]` — OHLC ordering is open-close-high-low (NOT the canonical
OHLC). Adapter parses indices 1/2/3/4 carefully.

`/api/v4/public/futures` is a single all-in-one endpoint returning 315
markets each with `{ticker_id, money_currency, last_price, money_volume,
high, low, product_type: "Perpetual", open_interest, index_price,
funding_rate, next_funding_rate_timestamp}` — bundles instruments +
funding + OI + mark + 24h vol. Adapter uses last_price as mark proxy
(no explicit mark_price field).

### WhiteBIT mixed-settlement check — 100% USDT (filter is no-op safety belt)

W3B Plan-Mode flagged WhiteBIT's `_PERP` suffix as a potential mixed-
settlement risk (the suffix doesn't encode settlement currency, so
hypothetically some markets could be USDC-/USD-/BTC-settled). Plan-Mode
probe verified:

```
$ jq '[.result[].money_currency] | group_by(.) | map({currency: .[0], count: length})' < futures-response.json
[{"currency": "USDT", "count": 315}]
```

**100% of WhiteBIT's perpetual markets are USDT-settled.** Adapter
includes `money_currency === 'USDT'` filter as safety belt against
future divergence (e.g. if WhiteBIT adds USDC perps).

### WhiteBIT is the FIRST W3-batch venue WITHOUT SPX listing

7 prior CEXes in the W3 batch (Phemex/BingX/HTX/WEEX/Bitmart/XT) all
listed `SPX-USDT` / `cmt_spxusdt` / `spx_usdt` / `SPXUSDT` as the
SPX6900 memecoin ($0.36 verified). WhiteBIT does NOT list SPX at all
— first W3-batch venue without the memecoin-trap risk on SPX.

WhiteBIT also does NOT list real SP500 (only Phemex + XT have that;
WhiteBIT focused on metals + select stocks).

### SPX6900 memecoin trap — 7th sighting (now a permanent class)

WEEX (5th sighting) + Bitmart (6th) + XT.COM (7th) all confirmed.
Cumulative tally: Binance + Bitget + KuCoin + Gate + Phemex + BingX +
HTX + WEEX + Bitmart + XT = 10 venues across W0/W2/W3A/W3B where
`SPX*` ticker = SPX6900 memecoin. ZERO venues where `SPX*` = real
S&P 500.

Real S&P 500 only routable via canonical key `SP500`:
- Phemex (PILOT-ADAPTERS-W3A C1) — `SP500USDT` ✓
- XT.COM (this wave C3) — `sp500_usdt` ✓

`SPX → SP*` aliasing on ANY new venue should be flagged HALT-class in
Plan-Mode probe; per `semantic-fingerprint-probe-before-alias-commit`
skill, every TradFi alias candidate MUST be price-probed before commit.

### `getPredictedFundings()` returns `[]` for all W3B shadow venues (W3B Q-3)

WEEX: no public funding endpoint at all.
Bitmart, XT, WhiteBIT: per-symbol funding endpoints exist but no batch
endpoint. Same shape as W3A — cross-venue funding fanout fires only for
promoted venues. Per-canonical-universe fetch deferred to follow-up
waves when each venue clears promotion gates.

### Identifier-diff: actual 13 → 17 venues (NOT spec's 14 → 18)

Same off-by-one as W3A — Lighter is DEX-routed via Hyperliquid, not in
the `ExchangeId` union nor the `venues` table. Spec's 14-venue baseline
was off by 1; actual post-W3A state was 13; post-W3B C4 is 17 (5
promoted + 12 shadow: ASTER + EDGEX + GATE + MEXC + KUCOIN + PHEMEX +
BINGX + HTX + WEEX + BITMART + XT + WHITEBIT).

### W3B-wave final tally — pilot batch COMPLETE

12 shadow venues × asset-count × 10 = ~46,000 BUY/SELL signals needed
for full cohort promotion gate. Day-15 cohort evaluation at ~2026-06-01
± 3 days will cover all 12 simultaneously. evaluate-venues cron auto-
detects + auto-extends shadow rows up to 30d before manual_required
Telegram alert fires.

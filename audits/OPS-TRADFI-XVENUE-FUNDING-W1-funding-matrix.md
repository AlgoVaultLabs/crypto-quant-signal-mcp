# OPS-TRADFI-XVENUE-FUNDING-W1 — Funding Matrix + Calibration (R1, semantic-fingerprint LAW)

**Probed:** 2026-06-04 (live, against production adapter integrations + direct venue endpoints).
**Companion data:** `OPS-TRADFI-XVENUE-FUNDING-W1-funding-matrix.csv` (per-row matrix).

## Methodology

For each known TradFi symbol (`isKnownTradFi`, i.e. `TRADFI_FALLBACK` — NOTE: the spec
cited `TIER_3_KNOWN`, which does NOT exist; the real substrate is `TRADFI_FALLBACK` +
`isKnownTradFi` in `asset-tiers.ts` — same drift flagged in TRADIFI-SIGNAL-HARDENING-W1)
× the 5 PROMOTED venues it is listed on (`getVenuesSupporting ∩ {HL,BINANCE,BYBIT,OKX,BITGET}`):
- **funding rate** via the production path `getAdapter(venue).getAssetContext(coin, dex)` (HL uses `dex:"xyz"`),
- **price** via the same path, EXCEPT Bitget (see adapter bug below) where price is read from the
  correct singular `/api/v2/mix/market/ticker?symbol=` endpoint,
- **interval** HL=60min (hourly), CEX=480min (8h) — Bybit is per-symbol per its instruments-info but
  is 480 for every probed TradFi symbol (documented caveat; read live in a future refinement),
- **8h-equiv** = `rate × (480 / intervalMinutes)` (HL ×8, CEX ×1),
- **fingerprint verdict** = price within 2× of the cross-venue median price for that symbol (SPX6900 rule).

## Fingerprint results

| Metric | Value |
|---|---|
| Total (symbol, venue) rows | 186 |
| **PASS** | **186** |
| FAIL | 0 |
| NO_PRICE | 0 |

**Zero fingerprint failures** once the Bitget adapter price bug (below) is worked around. All
listed promoted-venue prices for a given symbol agree within tight tolerance (e.g. TSLA: HL 421.61 /
BINANCE 421.73 / BYBIT 421.91 / OKX 422.14 / BITGET 422.16; GOLD ~4467 across all). No SPX6900-style
symbol misidentification on any promoted venue. (`SPX` itself is the SPX6900 memecoin and is
internally consistent across venues — it is correctly treated as crypto for session classification
by W1's static map; aggregating its own cross-venue funding is valid.)

## 🔴 Adapter bug surfaced by the fingerprint gate (flagged, NOT fixed this wave)

**Bitget `getAssetContext` returns the WRONG price for every coin.** Root cause: the adapter calls
`GET /api/v2/mix/market/tickers` (PLURAL) with a `symbol` param, but that endpoint **ignores
`symbol`** and returns all ~592 contracts; the adapter then takes `tickersData[0]` = `YGGUSDT`
(markPrice ~0.030). So TSLA/GOLD/BTC/every Bitget symbol gets YGG's price (~0.03). Bitget's
**funding** endpoint (`/current-fund-rate`) DOES respect `symbol` (verified: TSLA funding `0`,
GOLD `0.000057` — correct), so Bitget funding is trustworthy and is INCLUDED in aggregation.
- **Impact:** `get_trade_call` / `get_market_regime` `price` field + dashboard show YGG's price for
  ALL Bitget coins (crypto + TradFi). Data-integrity bug, pre-existing, out of THIS wave's scope.
- **One-line fix (for the follow-up):** `tickersData.find(t => t.symbol === symbol) ?? tickersData[0]`,
  or use the singular `/ticker` endpoint.
- **FLAGGED:** `OPS-BITGET-TICKER-SYMBOL-FILTER-W1` (hotfix candidate — affects shipped price field).

## Calibration — divergence-significance band (measured, not assumed)

Pulled **30d funding history** for 10 liquid TradFi symbols (TSLA, NVDA, GOLD, SILVER, COIN, MSTR,
AMZN, MSFT, AAPL, QQQ) × 4 CEX venues (40 (symbol,venue) series). HL xyz funding history is
**skipped** — `getFundingHistory` takes no `dex` param and xyz `fundingHistory` is not exposed on the
public dex-less endpoint (documented; HL still contributes to the live snapshot aggregation, just not
to this historical band). For each 8h settlement bucket with ≥2 CEX venues, computed the cross-venue
spread (max−min, 8h-native):

| Stat | 8h-equiv spread | bps |
|---|---|---|
| samples (n) | 902 | — |
| p50 | 0.00012677 | 1.27 |
| p75 | 0.00035613 | 3.56 |
| **p90 (chosen band)** | **0.001** | **10.0** |
| p95 | 0.001 | 10.0 |
| p99 | 0.00155862 | 15.6 |
| max | 0.01015539 | 101.6 |
| mean | 0.00029302 | 2.93 |

**Chosen `TRADFI_DIVERGENCE_BAND_8H = 0.001` (10 bps, 8h-equiv) = the p90 of the observed 30d
cross-venue spread distribution.** A cross-venue 8h-normalized funding spread above this band is in
the top decile → flag directional bias (BULLISH/BEARISH); within → NEUTRAL. `// TODO: revisit by
2026-06-18` (re-pull history once more TradFi venues accrue ≥30d and HL xyz history is wired).

## Venue-coverage drift refresh (R1)

Drift sweep (probe promoted venues NOT in the static matrix; fingerprint-gate each): **+10 verified
promoted-venue pairs** added to `venue-coverage.ts` (`COVERAGE_PROBED_AT → 2026-06-04`):
NFLX/COST/HIMS/GME **+OKX**; BABA/LLY/CRWV **+BYBIT**; HYUNDAI **+BINANCE/BYBIT/BITGET** (moved out of
HL_ONLY; OKX not listed). All additive (Data Integrity — no venue removed); each fingerprint-PASS.
HYUNDAI BINANCE funding `0.00295591` (a genuine non-trivial TradFi rate — newly aggregatable).

# CHANGE-DEFAULT-EXCHANGE-W1 — endpoint-truth.md

**Wave:** flip `get_trade_call` + `get_trade_signal` default exchange `'HL'` → `'BINANCE'` (v1.10.8 → v1.11.0 release bundling NPM-readme-DRAFT.md as live README).

**Date:** 2026-05-15
**Code:** Claude Opus 4.7 (1M)
**Mode:** Plan Mode Step 0 (self-initiated per risk markers: external API first-use; identifier in >1 place; edge mutation visible to all MCP consumers)
**Outcome:** Path-confirmed (no HALT). Proceed with full truthful copy rewrite + describe-text neutralization.

---

## 1. Identifier-diff table

| # | Site | Current literal | Target literal | Classification | Action |
|---|---|---|---|---|---|
| 1 | `src/index.ts:103` (TRADE_CALL_SCHEMA.exchange — covers BOTH `get_trade_call` and `get_trade_signal` via one schema) | `.default('HL').describe("Exchange to analyze. 'HL' = Hyperliquid (default), 'BINANCE' = Binance USDT-M Futures, 'BYBIT' = Bybit Linear, 'OKX' = OKX Swap, 'BITGET' = Bitget USDT-M.")` | `.default('BINANCE').describe("Exchange to analyze. 'BINANCE' = Binance USDT-M Futures (default), 'HL' = Hyperliquid, 'BYBIT' = Bybit Linear, 'OKX' = OKX Swap, 'BITGET' = Bitget USDT-M. Asset availability varies per venue — pass exchange explicitly to target a specific venue.")` | default-flip | flip |
| 2 | `src/index.ts:98` (TRADE_CALL_DESCRIPTION) | `"…trade call for a perpetual on Hyperliquid / Binance / Bybit / OKX / Bitget…"` | `"…trade call for a perpetual on Binance / Hyperliquid / Bybit / OKX / Bitget…"` (alphabetical-by-volume order; Binance leads as new default) | default-flip | flip |
| 3 | `src/index.ts:106` (TS type literal on handler param) | `exchange: 'HL' \| 'BINANCE' \| 'BYBIT' \| 'OKX' \| 'BITGET'` | (no change — union order is cosmetic) | out-of-scope | keep |
| 4 | `src/index.ts:206` (`get_market_regime` schema) | `.default('HL').describe(…)` | (no change per spec scope — get_market_regime keeps `'HL'` default) | out-of-scope | keep |
| 5 | `src/tools/get-trade-call.ts:99` (handler fallback) | `const exchange = input.exchange \|\| 'HL';` | `const exchange = input.exchange \|\| 'BINANCE';` | default-flip | flip (dead-code-equivalent post-Zod-default, flip for consistency) |
| 6 | `src/lib/asset-tiers.ts:26` (Tier-3 description) | `'TradFi perps — stocks, indices, commodities, FX via Hyperliquid'` | `'TradFi perps — stocks, indices, commodities, FX (seeded across Binance, Bybit, Bitget, OKX, Hyperliquid via demand-driven SHADOW-SEED-W1 fan-out)'` | tradfi-claim-rewrite (path-confirmed) | flip |
| 7 | `src/index.ts:~1605-1620` dashboard ExchangeSection (5 cards: Hyperliquid/Binance/Bybit/OKX/Bitget verbatim) | venue order unchanged | (no change — branding preservation; spec is silent) | out-of-scope | keep |
| 8 | `README.md:128` | `` `"HL"` (default), `"BINANCE"`, …. TradFi assets (GOLD, TSLA, etc.) are HL-only.`` | `` `"BINANCE"` (default), `"HL"` (Hyperliquid), …. Asset availability varies per venue — pass exchange explicitly to target a specific venue.`` | tradfi-claim-rewrite + default-flip | rewrite via README transplant |
| 9 | `README.md:86` | `"…TradFi perpetuals (stocks, indices, commodities, FX) on Hyperliquid, liquidity-filtered meme coins."` | `"…TradFi perps (stocks, indices, commodities, FX) on Binance, Bybit, Bitget, and Hyperliquid; liquidity-filtered meme coins."` | tradfi-claim-rewrite | rewrite via README transplant |
| 10 | `README.md:121` (Tools section) | `"…TradFi perpetuals … and liquidity-filtered meme coins on Hyperliquid."` | `"…TradFi perps … on Binance / Bybit / Bitget / Hyperliquid, and liquidity-filtered meme coins."` | tradfi-claim-rewrite | rewrite via README transplant |
| 11 | `README.md:189` (`scan_funding_arb` exchange param) | `default "HL"` | (no change — `scan_funding_arb` does not take `exchange` per actual schema; doc reflects `get_trade_call` analog; OOS for this wave) | out-of-scope | keep |
| 12 | `NPM-readme-DRAFT.md:179` (vault SoT) | line 178 in spec, line 179 actual: `` `"BINANCE"` (default), `"HL"` (Hyperliquid)…. TradFi assets (GOLD, TSLA, etc.) are HL-only.`` | drop HL-only claim → `"…Asset availability varies per venue — pass exchange explicitly to target a specific venue."` | tradfi-claim-rewrite | edit-in-vault then transplant |
| 13 | `NPM-readme-DRAFT.md:137` (vault SoT; spec line 136) | `"…TradFi perpetuals (stocks, indices, commodities, FX) on Hyperliquid, liquidity-filtered meme coins."` | `"…TradFi perps (stocks, indices, commodities, FX) on Binance, Bybit, Bitget, and Hyperliquid; liquidity-filtered meme coins."` | tradfi-claim-rewrite | edit-in-vault then transplant |
| 14 | `NPM-readme-DRAFT.md:172` (vault SoT; spec line 171) | `"…TradFi perpetuals (stocks, indices, commodities, FX), and liquidity-filtered meme coins on Hyperliquid."` | `"…TradFi perps (stocks, indices, commodities, FX) on Binance / Bybit / Bitget / Hyperliquid, and liquidity-filtered meme coins."` | tradfi-claim-rewrite | edit-in-vault then transplant |
| 15 | `landing/docs.html:307` (`get_trade_call` param row) | `` `HL` (default), …. TradFi assets (GOLD, TSLA, etc.) are HL-only.`` | `` `BINANCE` (default), …. Asset availability varies per venue.`` | default-flip + tradfi-claim-rewrite | flip |
| 16 | `landing/docs.html:411` (`get_market_regime` param row) | `` `HL` (default), …. TradFi assets (GOLD, TSLA, etc.) are HL-only.`` | (no default flip — OOS) BUT drop the "HL-only" claim → `"Asset availability varies per venue."` | tradfi-claim-rewrite only | drop HL-only; keep HL default |
| 17 | `landing/docs.html:1170` (FAQ-style copy) | `"…Hyperliquid (default), Binance, Bybit, OKX, or Bitget for get_trade_call and get_market_regime."` | `"…Binance (default for get_trade_call), Hyperliquid (default for get_market_regime), Bybit, OKX, or Bitget."` | default-flip (split per-tool defaults) | flip |
| 18 | `landing/llms-full.txt:57` | `` `exchange` (enum): `"HL"` (Hyperliquid, default), `"BINANCE"`, `"BYBIT"`, `"OKX"`, `"BITGET"`. `` | `` `exchange` (enum): `"BINANCE"` (Binance USDT-M Futures, default), `"HL"` (Hyperliquid), `"BYBIT"`, `"OKX"`, `"BITGET"`. `` | default-flip | flip |
| 19 | `landing/llms-full.txt:75` (in `get_market_regime` section per file structure) | `` `exchange` (enum, default `"HL"`) `` | (no change — get_market_regime keeps HL default; out-of-scope) | out-of-scope | keep |
| 20 | `src/lib/welcome-page.ts:77` | `"Supported exchanges: HL (default), BINANCE, BYBIT, OKX, BITGET."` | `"Supported exchanges: BINANCE (default), HL, BYBIT, OKX, BITGET."` | default-flip | flip |
| 21 | `landing/integrations/{binance,okx,bybit,bitget}.html` | (greppable HL-default citation absent — no matches for `HL-only`/`HL (default)` in these files per `grep -nE 'HL.*default\|default.*HL\|HL-only\|TradFi.*HL'`) | (no change) | out-of-scope | keep |
| 22 | `landing/_jsonld/*.template` | (only `product.json.template:5` mentions Hyperliquid; venue order is enumeration not default-citation) | (no change — order-of-enumeration is presentational, not a default claim) | out-of-scope | keep |
| 23 | `tests/cross-asset-grid.test.ts:37/117/160/187` etc. (`exchange: 'HL'` in fixture records) | fixture data | (no change) | fixture-keep | keep |
| 24 | `tests/get-trade-signal-envelope.test.ts:84-92, 151` (`exchange: 'HL'` in fixture records) | fixture data | (no change) | fixture-keep | keep |
| 25 | `tests/aoe-config-reader.test.ts` (`readAoeConfig(..., 'HL')` venue args) | function arg, not default-assertion | (no change) | fixture-keep | keep |
| 26 | `tests/unit/copy-consistency.test.ts` (if present) | (file does not exist per `ls tests/unit/`) | n/a | n/a | (skip; add new canary instead) |
| 27 | `tests/get-trade-signal.test.ts` (default-value assertion?) | (to verify in C2 — schema default may be asserted) | flip if asserting `'HL'` as default | default-flip | flip if needed |
| 28 | NEW canary test asserting `inputSchema.properties.exchange.default === 'BINANCE'` for both `get_trade_call` AND `get_trade_signal` | does not exist | add | default-flip (NEW) | add |
| 29 | NEW canary test: assert no source file ships the literal phrase `"TradFi assets (GOLD, TSLA, etc.) are HL-only"` (or equivalents) | does not exist | add | forbidden-phrase (NEW) | add |
| 30 | `package.json:3` | `"version": "1.10.8"` | `"version": "1.11.0"` | version-bump | flip |
| 31 | `server.json:6, 21` | `"version": "1.10.8"` (×2) | `"version": "1.11.0"` (×2) | version-bump | flip |
| 32 | `src/lib/pkg-version.ts` | reads from `package.json` at runtime (no literal) | (no change) | inherits | inherits |
| 33 | `landing/manifest.json` | (file does not exist per `ls landing/manifest.json`) | n/a | n/a | n/a |
| 34 | `manifest.json` (root) | `"version": "1.6.0"` (lobehub manifest; separate versioning lineage) | (no change — OOS; flag in WIS) | out-of-scope | keep + WIS-flag |
| 35 | `lobehub-manifest.json` (root) | (separate file; lobehub-specific) | (no change — OOS; flag in WIS) | out-of-scope | keep |
| 36 | `CHANGELOG.md` | last entry `[1.10.8]` | NEW entry `## [1.11.0] - 2026-05-15` with default-exchange flip + dropped HL-only TradFi claim + cache-refresh notice + 4 web-research source URLs | version-bump | add entry |

---

## 2. system-map.md edge-mutation table (before → after)

| Row | Before (verbatim) | After (target) |
|---|---|---|
| `crypto-quant-signal-mcp` component card → `Live target` line | `…npm `crypto-quant-signal-mcp@1.10.8`…` | `…npm `crypto-quant-signal-mcp@1.11.0`…` |
| `crypto-quant-signal-mcp` component card → `Last-touched wave` line | `OPS-HOUSEKEEPING-W1 (2026-05-01) — …` | `CHANGE-DEFAULT-EXCHANGE-W1 (2026-05-15) — default exchange for get_trade_call + get_trade_signal flipped HL → BINANCE; v1.11.0 release ships NPM-readme-DRAFT.md as the live README. Prior: …` |
| Edge-table row #5 (3 MCP tools over Streamable HTTP) | `3 MCP tools (`get_trade_call`, `scan_funding_arb`, `get_market_regime`) over Streamable HTTP` | annotate `default exchange flipped HL → BINANCE for get_trade_call (+ alias get_trade_signal) per CHANGE-DEFAULT-EXCHANGE-W1 2026-05-15; get_market_regime default unchanged ('HL')` |
| **NEW edge annotation row** — signal-MCP → performance-db SHADOW-SEED-W1 seed fan-out | (none) | Document: "Top-N-by-call-count restricted-universe (SHADOW-SEED-W1) seeds the SAME coin list to all 5 exchanges; venue-unsupported pairs self-skip via 'Insufficient candle data' error path inside `seedExchange`. Empirically confirmed 2026-05-15: TradFi pairs (TSLA 5 venues, XAU 4 venues, MSTR 5 venues, NVDA 4 venues, SPX 5 venues, COIN 5 venues, AAPL 4 venues) seeded across multiple venues, NOT HL-only." |
| Asset-Tier-3 footnote on signal-MCP component card (NEW) | (none) | "Empirical seed coverage as of 2026-05-15 (signal_performance.signals GROUP BY coin,exchange): TSLA seeded on HL/BINANCE/BYBIT/OKX/BITGET; XAU seeded on BINANCE/BYBIT/OKX/BITGET (not HL); MSTR seeded on HL/BINANCE/BYBIT/OKX/BITGET; NVDA seeded on HL/BINANCE/OKX/BITGET; SPX seeded on HL/BINANCE/BYBIT/OKX/BITGET; COIN seeded on HL/BINANCE/BYBIT/OKX/BITGET; AAPL seeded on HL/BINANCE/OKX/BITGET; GOLD seeded on HL only (Binance uses XAUUSDT symbol, not GOLDUSDT — Binance adapter returns 400 for GOLD)." |
| `Last touched:` line at top of system-map.md | `2026-05-15 (DESIGN-HOW-IT-WORKS-FF-3)` | `2026-05-15 (CHANGE-DEFAULT-EXCHANGE-W1)` |

---

## 3. TradFi cross-CEX seed-and-score empirical confirmation

### 3.a Performance-DB seed-fanout audit (private DB query)

Public `/api/performance-public.byAsset.<coin>.byExchange` field returns `null` (aggregation does not break out per-exchange on the public surface). Fell back to direct `signal_performance` postgres query via `docker exec crypto-quant-signal-mcp-postgres-1 psql -U algovault -d signal_performance`:

```
SELECT coin, exchange, COUNT(*) AS signals
FROM signals
WHERE coin IN ('TSLA','GOLD','XAU','SPX','NVDA','AAPL','MSTR','COIN')
GROUP BY coin, exchange
ORDER BY coin, exchange;
```

Result (verbatim from production DB, 2026-05-15 query):

| coin | HL | BINANCE | BYBIT | OKX | BITGET | total |
|---|---|---|---|---|---|---|
| AAPL | 40 | 3 | – | 6 | 54 | 103 |
| COIN | 58 | 25 | 4 | 3 | 14 | 104 |
| GOLD | 125 | – | – | – | – | 125 |
| MSTR | 109 | 37 | 1 | 9 | 37 | 193 |
| NVDA | 56 | 19 | – | 23 | 26 | 124 |
| SPX  | 62 | 13 | 84 | 11 | 22 | 192 |
| TSLA | 55 | 53 | 2 | 40 | 110 | 260 |
| XAU  | – | 142 | 110 | 172 | 73 | 497 |

**Conclusion:** TradFi pairs are emphatically NOT HL-only. SHADOW-SEED-W1 cross-venue seed fan-out is empirically confirmed for 7 of 8 probed symbols. Only GOLD is HL-only — but that's a symbol-naming artifact (Binance uses XAUUSDT, not GOLDUSDT; XAU IS seeded heavily on 4 non-HL venues).

### 3.b Live trade-call probes (MCP `tools/call` via initialized session)

| coin | timeframe | exchange | Result |
|---|---|---|---|
| TSLA | 1h | BINANCE | LIVE ✅ — `call: HOLD, confidence: 4, price: $439.39` |
| XAU  | 1h | BINANCE | LIVE ✅ — `call: HOLD, confidence: 20, price: $4622.05` |
| GOLD | 1h | BINANCE | ERROR — `"Binance API 400: Bad Request"` (expected; Binance uses `XAUUSDT` symbol, not `GOLDUSDT` — adapter does not auto-map `GOLD` → `XAU` on Binance) |
| TSLA | 1h | BYBIT | LIVE ✅ — `call: HOLD, confidence: 3, price: $439.05` |
| NVDA | 1h | BYBIT | LIVE ✅ — `call: HOLD, confidence: 37, price: $237.02` |
| GOLD | 1h | HL | ERROR — `"Hyperliquid API rate-limited (429); upstream is temporarily refusing requests"` (CONTROL — this is the exact behavior motivating the wave; HL rate-limits during peak periods, BINANCE does not) |

### 3.c SHADOW-SEED-W1 restricted-universe verification

The §3.a postgres result (7 of 8 TradFi symbols with non-HL records) is conclusive empirical proof that the cross-venue seed fan-out is happening as `src/scripts/seed-signals.ts:446` documents (per `comment: "coins not supported on a given venue self-skip via the existing 'Insufficient candle data / not found' error path inside seedExchange"`). Log-tail verification skipped — DB ground truth supersedes.

### 3.d Resolution: **Path-confirmed**

Per spec resolution rules:
- §3.a: ≥1 TradFi pair with non-HL records ✅ (7 of 8 symbols)
- §3.b: ≥1 live trade-call succeeds on Binance/Bybit for a TradFi symbol ✅ (TSLA/BINANCE, XAU/BINANCE, TSLA/BYBIT, NVDA/BYBIT all returned live verdicts)

**Proceed with full truthful copy rewrite:**
- Drop "TradFi assets (GOLD, TSLA, etc.) are HL-only" everywhere.
- Tier-3 description in `asset-tiers.ts:26` → "TradFi perps — stocks, indices, commodities, FX (seeded across Binance, Bybit, Bitget, OKX, Hyperliquid via demand-driven SHADOW-SEED-W1 fan-out)".
- README/draft lines 137/172/179 rewrite per spec patches.
- system-map.md gets §3.a per-coin × per-exchange matrix as Tier-3 footnote.

---

## 4. Test-runner probe

```
$ command -v npx
/Users/tank/.nvm/versions/node/v22.7.0/bin/npx

$ jq -r '.scripts.test' package.json
vitest run
```

Confirmed: **vitest** is the test runner. `npm test` → `vitest run` → exit 0 on green.

---

## 5. Schema baseline curl (pre-deploy)

```
curl -sS https://api.algovault.com/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-session-id: <init-session>' \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":3}' \
  | jq '.result.tools[] | select(.name=="get_trade_call" or .name=="get_trade_signal") | {name, default: .inputSchema.properties.exchange.default}'
```

**Pre-deploy result (2026-05-15 query):**
- `get_trade_call.default` = `"HL"`
- `get_trade_signal.default` = `"HL"`

**Post-deploy expectation:** both = `"BINANCE"`.

---

## 6. Source-citation provenance (web research, verified 2026-05-13 per spec)

For factuality preservation, cite in CHANGELOG.md `[1.11.0]` body:

1. Binance TSLAUSDT launch — https://www.binance.com/en/support/announcement/detail/40c76b4deaa247f09774e5d1ee747cb8
2. Binance XAU/XAG TradFi launch — https://www.binance.com/en/support/announcement/detail/ecf7318c0d434c339e80878588e700d0
3. Bybit TradFi perpetuals (24/7 US stocks + global ETFs) — https://chainwire.org/2026/05/08/bybit-introduces-24-7-tradfi-perpetual-contracts-trading-for-dozens-of-us-stocks-and-global-etfs/
4. 2026 crypto-exchanges TradFi roundup (Bitget 79+ instruments + OKX/ICE) — https://forklog.com/en/old-is-new-again-top-5-crypto-exchanges-with-tradfi-trading-in-2026/

---

## 7. Plan-Mode verdict

✅ **No HALT-class findings.** All spec-cited primitives confirmed live (TRADE_CALL_SCHEMA, TRADE_CALL_DESCRIPTION, asset-tiers.ts:26, README.md target sites, NPM-readme-DRAFT.md target sites, postgres `signals` table, MCP tools/list contract). Empirical TradFi-on-CEX seed fan-out + live trade-call success confirms Branch A (Path-confirmed). Proceed with execution.

**Out-of-scope flags surfaced for WIS:**
- `manifest.json` (lobehub) carries an HL-conflated description (`"720+ assets on Hyperliquid"`) — separate versioning lineage; leave as-is, flag for future audit.
- `landing/docs.html:411` is `get_market_regime` parameter row — keep HL default per spec, but drop the "HL-only TradFi" claim (consistency with the §3 empirical findings).

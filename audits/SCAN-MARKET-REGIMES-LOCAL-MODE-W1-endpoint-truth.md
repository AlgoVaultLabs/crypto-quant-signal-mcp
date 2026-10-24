# SCAN-MARKET-REGIMES-LOCAL-MODE-W1 — R0 endpoint truth (Plan Mode)

Measured 2026-10-24 03:48–03:51Z. Build: `origin/main` `9b25ea3c` (`npm run build`, tsc). Local mode = stdio
(`TRANSPORT=stdio`), `DATABASE_URL` unset, fresh SQLite at a scratch `PERFORMANCE_DB_PATH`, scratch `HOME`.
Driver: initialize → notifications/initialized → tools/list → one `tools/call` per row.

## R0.1 — defect reproduced

`scan_market_regimes {}` →
`{"result":{"content":[{"type":"text","text":"{\"error\":\"This statement does not return data. Use run() instead\"}"}],"isError":true},"jsonrpc":"2.0","id":3}`

## R0.2 — truth table (every enabled tool × local mode)

| Tool / input | Class | Evidence |
|---|---|---|
| `get_trade_call {coin:BTC}` | served | HOLD conf 2 (local funding store empty) |
| `get_trade_signal {coin:ETH}` (alias) | served | HOLD conf 30 |
| `get_market_regime {coin:BTC}` | served | RANGING conf 30 |
| `scan_funding_arb {}` | served | 0 opportunities / 1288 pairs; hosted at 03:51Z also 0 / 1288 |
| `scan_trade_calls {}` | served | scanned 20, 1 non-HOLD |
| `scan_trade_calls {rankBy:"oi_change"}` | empty-but-wrong | scanned 0 in 1 ms, quota counter +1; hosted scans 20 |
| `scan_market_regimes {}` | **raw error** | `This statement does not return data. Use run() instead` |
| `scan_market_regimes {exchange:BINANCE,timeframe:4h,limit:2}` | **raw error** | same |
| `scan_market_regimes {rankBy:"oi_change"}` | **raw error** | same |
| `chat_knowledge {question}` | **raw error** | `no such table: chat_usage_monthly` (2nd call identical). DDL `ensureChatUsageTable()` (`src/lib/chat-rate-limit.ts:151`) runs only in `startHttp()` (`src/index.ts:3033`) |
| `search_knowledge {query:"market regime"}` | empty-but-wrong | total_results 0, `bundle_version:"unknown"`; published `1.31.1` tarball has 0 `dist/knowledge/` files (`publish-npm.yml:187` runs `npm run build` only, not `build:knowledge`) |
| `get_track_record {}` | served | empty local record |
| `get_equity_call {symbol:AAPL}` (`EQUITY_TOOLS_ENABLED=1`) | **raw error** | `DATABASE_URL is not set — equity scripts require a postgres connection string.` (`src/lib/equities/equity-store.ts:16`) |
| `get_equity_regime {symbol:AAPL}` (`EQUITY_TOOLS_ENABLED=1`) | **raw error** | same |

Default local `tools/list` = 9 tools; with `EQUITY_TOOLS_ENABLED=1` = 11.

## R0.3 — pre-image

| Surface | Result |
|---|---|
| `/capabilities` projection | allow-list (`projectCapabilities()` emits explicit keys `name, canonical, channels, quota, x402, description, lenses?, enabled`) — a new `residency` field cannot leak |
| live `/capabilities` | 6397 B, sha256 `7ff598bc36095e12952607c2507be7fb7d4e4c333b0ce54fac4997e7d9e73c2e`, 9 tools |
| live `tools/list` | 9 tools, sha256 `19bdecf37eb4be5478abaff1c64a3bb7645e5b362796db155176691fad6e20de` (saved `result` JSON) |
| local stdio `tools/list` vs live | object-for-object equal 9/9, same order |
| live `scan_market_regimes {exchange:BINANCE,timeframe:4h,limit:2}` | isError false, `returned: 2`, `as_of 2026-10-24T00:00:00.000Z` |

## R0.4 — HALT condition

| Condition | Measured | Fires? |
|---|---|---|
| more than one tool needs `residency:'hosted'` | raw-error tools: `scan_market_regimes`, `chat_knowledge` (default surface) + `get_equity_call`, `get_equity_regime` (flag-gated) | 🛑 yes |
| accessor needs more than a one-line export | none exists today; `export const isPgBackend = (): boolean => !!process.env.DATABASE_URL;` is one line (`getBackend()` consuming it is a second one-line edit). `isPg` (`performance-db.ts:421`) is latched lazily — exporting it reads `false` before first use | no |

## Claim / reality / resolution

| Claim (spec) | Reality | Resolution |
|---|---|---|
| "The other 8 tools behave correctly in the same local process" | `chat_knowledge` raw-errors; `search_knowledge` and `scan_trade_calls rankBy:oi_change` are empty-but-wrong | 🛑 HALT (R0.4) |
| `FeatureSpec` at `feature-registry.ts:59` | `:59` | ✅ |
| `// Admission (Q-PIPE-2 row 12)` inside `inScope` in `callTool` | `callTool` `:568`, `inScope` `:581`, comment `:582` | ✅ |
| `ensureRegimeSnapshotTables()` at `regime-snapshots.ts:158` | `:159` | ✅ drift 1 line |
| one exported backend-kind accessor in `performance-db.ts` | none exported | ✅ add (one line) |
| `!!process.env.DATABASE_URL` re-derived "a sixth time" | `process.env.DATABASE_URL` occurs 117× in `src/`, ~20 distinct `isPg`/`PG` derivations | ✅ count drift, not a fictional primitive |

Fictional primitives: 0.

## Identifier diff

| Identifier | Spec sites | Consistent? |
|---|---|---|
| `hosted_only` (`error` and `code`) | Method, R3, AC | ✅ |
| `https://api.algovault.com/mcp` | message copy, `hosted_endpoint`, R3, AC | ✅ |
| `501` | outcome `http.status`, R3 | ✅ |
| `residency: 'any' \| 'hosted'` | Method, R1, AC | ✅ |

## Rulings (Cowork, 2026-10-24) — verbatim

VERDICT: GO WITH SCOPE CHANGE — two registry rows are residency:'hosted' (scan_market_regimes, chat_knowledge); these rulings supersede the R0.4 single-row threshold.

- Q1: (a) chat_knowledge -> residency:'hosted'. Locally it can never return a grounded answer (StubLLMProvider without ANTHROPIC_API_KEY; no dist/knowledge/ in the 1.31.1 tarball, measured), and a typed refusal is better than a [STUB] answer. A later wave that ships the bundle may flip it back to 'any'.
- Q2: (b) Mr.1 ruling. get_equity_call / get_equity_regime stay residency:'any' and stay dark (EQUITY_TOOLS_ENABLED default OFF on both surfaces). Do not remove them in this wave. Add a one-line comment on each row naming the Postgres dependency (src/lib/equities/equity-store.ts:16), so 'any' is not read as a local-mode guarantee.
- Q3: (a) No _algovault on the hosted_only payload. This matches the pre-dispatch INVALID_TIMEFRAME refusal in src/lib/tool-call-pipeline.ts (0 _algovault, measured). R5 in scripts/check-credential-outcome-conformance.mjs only counts constructed envelopes, so there is no gate conflict, and a local refusal has no auth or quota state to report.
- Q4: (a) In src/lib/performance-db.ts, add: export const isPgBackend = (): boolean => !!process.env.DATABASE_URL; and make getBackend() branch on isPgBackend(). That keeps one derivation. Never export isPg (performance-db.ts:421): it stays false until the first DB call.
- Q5: (a) Report it as this wave's one measured follow-up, with this evidence: publish-npm.yml:187 runs `npm run build` only; build:knowledge (node scripts/build-knowledge-json.mjs) is never called; the 1.31.1 tarball has 0 dist/knowledge/ files. Keep it out of this wave and out of NPM-PUBLISH-v1.32.0-W1 (SOP §0: a publish-lane fix gets its own wave).
- Q6: (a) Report only. The 1-unit floor per scan call is the billing design (Mr.1 ruling): scan_trade_calls bills Math.max(1, calls.length) (src/tools/scan-trade-calls.ts:298) and scan_market_regimes bills Math.max(1, returned) (src/tools/scan-market-regimes.ts:308). Neither is a defect. Record the zero-coin local oi_change result in status.md as a known local limitation; it is not a follow-up.

## Execution correction (flagged)

`tests/scan-market-regimes.test.ts` "an invalid lens refuses before any DB read" calls `callTool` in local mode, so the new admission answers `hosted_only` before the handler's lens check — the spec's "stays green unchanged" and "refuse at admission in local mode" cannot both hold for that one case. Resolution: that single case now runs in hosted mode (`vi.stubEnv('DATABASE_URL', …)` in try/finally); its four assertions are byte-unchanged. `tests/unit/market-regime-scanner.test.ts` is unchanged and green.

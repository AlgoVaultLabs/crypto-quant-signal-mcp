# TRADE-CALL-ROUTING-RESOLVER-W1 — Plan-Mode Step-0 endpoint-truth

**Wave:** TRADE-CALL-ROUTING-RESOLVER-W1 (Tier-1, single session, sequential)
**Probed:** 2026-06-09 against `origin/main` @ `140cba2` (v1.20.1), repo `~/code/crypto-quant-signal-mcp` (NOT the stale vault mirror)
**Test runner:** `vitest` (`package.json:25` → `"test": "vitest run"`; tests in `tests/` + `tests/unit/`)
**Deploy:** `scripts/deploy-direct.sh` (GHA unavailable — operator-confirmed Direct Deploy)
**Verdict:** ✅ **0 fictional primitives** · 1 inline Factuality refinement (R2 draft descriptions bust the canary — author compliant copy) · **2 architect-confirm design forks (Q1, Q2) — WAIT before C1.**

---

## ARCHITECT RATIFICATION (2026-06-09)

- **A1 = A (drop defaults).** Drop `.default()` on `get_trade_call`'s `timeframe`+`exchange` → optional; resolver owns defaults (omit ⇒ 15m/BINANCE; runtime identical). Applies to the `get_trade_signal` alias automatically (shared `TRADE_CALL_SCHEMA`). **x402 HTTP twin = NO CHANGE** — `callCoreHandler` validates against its own hand-declared AJV `spec.inputSchema` (`x402-bazaar.ts` `BAZAAR_ROUTES`), NOT the Zod schema (probed `x402-http-routes.ts:122-129,195,221-225`); A1's "if it shares the schema" is FALSE. **Sanctioned R4 exception:** the 2 default-key removals on `get_trade_call`(+alias) are the ONLY permitted non-additive key losses — log in commit body + `status.md` "documented relaxations" table + the snapshot file header; update the snapshot baseline + additive assertion to permit exactly those 2. State the omit-defaults (Binance / 15m) in the description (ties A4). `tools/list`=9, no rename.
- **A2 = DEFER R3.** Ship R1+R2 fully; `get_market_regime`/`get_equity_regime` schemas UNCHANGED. `status.md` flag + follow-up `OPS-TRADE-CALL-ROUTING-REGIME-W{NEXT}`.
- **A3 = OK + lazy.** Pure DB-free `market-route.ts` + handler-side async `getUniverseEntry` injecting `inEquityUniverse`; equity-DB error ⇒ false ⇒ perp BINANCE (fail-open). Resolve membership **LAZILY — only in the bare branch** (no exchange AND no timeframe AND no assetClass) → zero added latency on `{BTC,BINANCE,15m}`. **Factuality:** no membership cache exists today (probed — only `_equityPool`); adding a minimal lazy TTL active-universe Set cache (`isEquityUniverseSymbol`) to bound the bare-path DB cost, fail-open.
- **A4 = OK.** Canary-compliant descriptions (length+keyword+fact-density green): routing rule (venue OR timeframe ⇒ perp; bare US ticker ⇒ daily stocks) + space-separated venue keyword + omit-defaults note; delete "or TradFi symbol" from the coin param.

---

## 1. Primitive probe table — `claim | reality | resolution`

| # | Spec claim | Reality (probed) | Resolution |
|---|---|---|---|
| 1 | `src/lib/market-route.ts` / `resolveMarketRoute` / `MarketRoute` (NEW) | Absent (to create). `src/lib/` has no route file. | CREATE. Pure module, dependency-free (no equity-store import → cycle-free + DB-free unit test). |
| 2 | `get_trade_call` handler dispatches to perp engine | `src/index.ts:316-351` `makeTradeCallHandler` → `getTradeSignal({coin,timeframe,includeReasoning,exchange,license})` (`src/tools/get-trade-call.ts`). Registered `:352-358`; alias `get_trade_signal` `:359-365` (shares `TRADE_CALL_SCHEMA` + handler factory). | Wire resolver into the handler; dispatch perp **or** equity. Alias stays byte-aligned (same schema+factory). |
| 3 | `get_equity_call` handler + equity engine entry | `src/index.ts:458-482` → `getEquityCall({symbol,license})` (`equity-tool-formatters.ts:124-162`). Schema = `{symbol}` only (`:461`). | Add additive optional `exchange`+`timeframe`; route via resolver. Symbol-only path byte-unchanged. |
| 4 | Equity-universe membership = existing Databento check behind `SYMBOL_NOT_IN_UNIVERSE` | `getUniverseEntry(pool, symbol)` `equity-store.ts:159-166` — **async, postgres-backed** (`SELECT … FROM equity_universe WHERE symbol=$1 AND active`). Pool singleton `getEquityPool()` `:152-156`. SYMBOL_NOT_IN_UNIVERSE built in `equity-tool-formatters.ts:141-147`. **No sync/in-memory universe cache exists.** | Resolver CONSUMES this (no parallel list). **Async ⇒ membership injected as a resolved boolean (see Q1/Design §4).** |
| 5 | `server.tool` registration loop (`allToolNames()` → `index.ts`) | `src/index.ts:673-682` — `register(name,desc,schema,annotations,handler)` collects into `toolDefs`; loop over `allToolNames()` calls `server.tool`; bidirectional parity guard throws on drift. | Add optional params to the schemas in the `register(...)` blocks; no loop change. `tools/list` stays 9. |
| 6 | `feature-registry.ts` `FeatureSpec`/`descriptionRef` | `feature-registry.ts:32-55` (`FeatureSpec`), `:53` `descriptionRef` is a **KEY** into `DESCRIPTIONS` (`:58-67`) → string consts in `tool-descriptions.ts`. Registry rows `:74-156`. | **Registry file structurally UNCHANGED** (no descriptionRef-key/x402/channel/name change). Descriptions edited in `tool-descriptions.ts`; schemas edited in `index.ts`. |
| 7 | Tool descriptions | `tool-descriptions.ts`: `TRADE_CALL_DESCRIPTION:22-23`, `GET_EQUITY_CALL_DESCRIPTION:66-71`, `GET_MARKET_REGIME_DESCRIPTION:35-36`, `GET_EQUITY_REGIME_DESCRIPTION:72-75`. The `"or TradFi symbol"` to delete is in **`PARAM_DESC_TRADE_CALL_COIN:78-79`** (NOT the tool desc). | Rewrite the 2–4 description strings + the coin param. **Bound by the keyword/length canary — see §5.** |
| 8 | `/capabilities` (`projectCapabilities()`) re-projects registry | `feature-registry.ts:200-216` — allow-list projection (canonical/channels/quota/x402/**description**/enabled). Emits `DESCRIPTIONS[descriptionRef]`. Zero internal fields. Live: `GET /capabilities` → 9 tools (probed 2026-06-09). | Description edits auto-flow to `/capabilities`. No internal leak (allow-list). Record **Y** (content reproject), no shape change. |
| 9 | x402 `TOOL_PRICING`/`effectivePrice`/`HTTP_TOOLS` UNCHANGED | `x402.ts:73` `TOOL_PRICING` (registry-derived); `effectivePrice:453-461` (1m premium is `get_trade_call`-only, `:461`); `x402-http-routes.ts:104` `HTTP_TOOLS = [get_trade_signal, scan_funding_arb, get_market_regime, scan_trade_calls, get_equity_call, get_equity_regime]` (note: `get_trade_call` NOT gated → `/x402/get_trade_call`=404). | **NONE.** No name/price/channel/HTTP_TOOLS change. Equity dispatch is internal — pricing keys on tool NAME, unaffected. |
| 10 | Drift canary `check-feature-registry-drift.mjs` | 5 assertions: (1) projection names==allToolNames, (2) TOOL_PRICING derive, (3) HTTP_TOOLS route-set, (4) no internal-field leak, (5) webhook VALID_EVENTS. **It inspects NO schema and NO description CONTENT.** | Stays green by construction (no name/price/channel/webhook change). **No assertion to update** (Map Anchor row 6 over-stated — the canary encodes no description/schema parity). Run `--check` green as the gate. |
| 11 | Perp engine miss-path (default venue BINANCE for all) | `get-trade-call.ts:116` `exchange||'BINANCE'`. **Known TradFi on non-listing venue** → `:125-129` `TradFiSymbolUnsupportedOnVenueError` (`errors.ts:50-62`, code `TRADFI_SYMBOL_UNSUPPORTED_ON_VENUE`, `suggestedVenues[]`). **Unknown/illiquid** → `:152-158` generic `Error("Signal generation unavailable for X on BINANCE…")`. | Bare TSLA via perp (assetClass:'perp' or TF named, no venue) → BINANCE → `TradFiSymbolUnsupportedOnVenueError` suggesting BITGET (self-retry UX). Bare unknown → generic unavailable error (NOT equity suggestions — see Q1 note). |
| 12 | Existing `resolveAssetClass`/`isKnownTradFi` | `get-trade-call.ts` already imports `resolveAssetClass` (`underlying-type.ts`) + `isKnownTradFi` (`asset-tiers.ts`). The perp engine self-classifies TradFi for venue-coverage. | Resolver needs NEITHER (spec: only equity-universe membership classifies). Do not build/duplicate a crypto/TradFi classifier. |

---

## 2. system-map.md edge enumeration (Map Anchor, 7 rows)

| Map Anchor row | Status | Reality |
|---|---|---|
| 1. registry descriptionRef + equity schema additive params | **PARTIAL/Y** | Registry file structurally unchanged; description STRINGS edited in `tool-descriptions.ts`; schemas edited in `index.ts` (not the registry). `tools/list`=9, no add/remove/rename. |
| 2. `server.tool` loop — additive schemas + new internal dispatch edge | **Y** | `index.ts:673-682` loop unchanged; schemas gain optional params; NEW internal edge: trade-call handler → resolver → {perp engine \| equity engine}. |
| 3. NEW `src/lib/market-route.ts` (`resolveMarketRoute`) pure derive node | **Y (new component)** | Single-derivation: route computed once, both entry points project from it. |
| 4. `/capabilities` reprojects registry, no internal leak | **Y (content)** | Allow-list projection; description content updates; zero internal fields (verified `:200-216`). |
| 5. x402 `TOOL_PRICING`/`effectivePrice`/`HTTP_TOOLS` | **NONE** | Unchanged (see probe #9). |
| 6. drift canary description/schema parity assertion | **NONE** | Canary encodes no description/schema parity (probe #10). Must stay green (run `--check`). |
| 7. equity-universe membership SoT | **Y (consume)** | Resolver consumes `getUniverseEntry` via a handler-side async edge; no parallel list. |

**system-map.md update plan:** prepend a Last-touched row + extend the `crypto-quant-signal-mcp` component row to note `market-route.ts` resolver + the trade-call→{perp|equity} dispatch edge. `system-map.md updated: Y`.

---

## 3. Identifier diff — Requirements §R vs Acceptance Criteria

Tool names (`get_trade_call`/`get_trade_signal`/`get_equity_call`/`get_market_regime`/`get_equity_regime`), param names (`coin`/`symbol`/`exchange`/`timeframe`/`assetClass`/`includeReasoning`), engine values (`'perp'`/`'equity'`), default venue (`BINANCE` for all symbols), `MarketRoute` shape (`{engine, exchange?, timeframe}`), venues (`BITGET`/`BYBIT`/`BINANCE` ∈ the 17-venue `ExchangeId` enum, `index.ts:314`): **all consistent between §R and §AC. 0 mismatches.**

One mapping note (not a mismatch): the resolver input field is `symbol`; `get_trade_call`'s param is `coin` — the handler bridges (`resolveMarketRoute({symbol: coin, …})`).

---

## 4. Design — pure resolver vs async DB membership (RESOLUTION, low-controversy → Q3 sanity-check)

R1 demands the resolver be "pure/deterministic/side-effect-free" AND consult "the existing Databento universe check." Those conflict because `getUniverseEntry` is async + postgres-backed, and no sync universe cache exists. **Proposed resolution (keeps purity + uses the existing check + no parallel list):**

- **Pure core (`market-route.ts`):** `resolveMarketRoute(input: { symbol; exchange?; timeframe?; assetClass?; inEquityUniverse?: boolean }): MarketRoute`. `inEquityUniverse` is consulted ONLY in step-4 (the bare case). Fully sync/pure/deterministic → unit-tested against the truth table by passing the boolean. Adds one field beyond the spec's 4-field signature (justified by purity).
- **Async edge (handler-side, new tiny helper `isEquityUniverseSymbol(raw): Promise<boolean>` in the equities module):** `normalizeSymbol` + `getUniverseEntry(getEquityPool(), sym) != null`, wrapped `try/catch → false` (fail-safe: equity-DB blip ⇒ false ⇒ perp BINANCE = today's behavior, no regression). Handler calls it ONLY when the call is bare (no exchange/TF/assetClass), so non-bare perp calls add zero DB cost. Cycle-safe (equities never import `index.ts` — verified).

Net: `market-route.ts` stays DB-free/cycle-free/unit-testable; the existing universe check is reused verbatim; bare crypto adds one indexed point-lookup (sub-ms, ≪ the perp compute).

---

## 5. Description authoring — R2 drafts bust the canary (inline Factuality refinement)

`tests/unit/tool-description-keywords.test.ts` binds `get_trade_call`'s combined-text (desc + param describes): **tool desc ≤350 chars, each param ≤80, ≥15/20 `TOP_20_KEYWORDS`, no `/[A-Z]+-W\d+/` wave-IDs, no brand-voice words.** The R2 draft `get_trade_call` description is **~383 chars** AND uses a **comma-separated venue list** (`"Binance, Bybit, …"`) which breaks the exact-substring keyword `"Binance Bybit OKX Bitget Hyperliquid"` → it would FAIL both length and the ≥15 coverage.

The prompt explicitly invites refinement ("draft — refine to fit the registry's `descriptionRef` mechanism"). **Resolution:** author canary-compliant descriptions that carry the routing intent — keep the keyword-dense space-separated venue list + the high-value keyword phrases, fold the routing guidance ("name a venue/timeframe → crypto or tokenized-stock perp; bare US ticker → daily-bar stock read") into the desc + param describes within budget, and delete `"or TradFi symbol"` from the coin param. Current `get_trade_call` combined-text hits ~17/20 keywords → ~2 phrases of headroom; feasibility confirmed. The keyword/length canary is the gate. (Also update the canary's hand-maintained `TOOL_COMBINED` `get_trade_call.params` if `assetClass`'s describe() is added, for accurate coverage measurement.)

---

## 6. ⚠️ Q1 (HIGH) — Zod `.default()` destroys param-presence; routing needs presence

`TRADE_CALL_SCHEMA` (`index.ts:312,314`) has `timeframe.default('15m')` + `exchange.default('BINANCE')`. **Zod fills defaults before the handler runs**, so a bare `{coin:'TSLA'}` arrives as `{coin:'TSLA', timeframe:'15m', exchange:'BINANCE'}` — byte-identical to an explicit `{coin:'TSLA', timeframe:'15m', exchange:'BINANCE'}`. But R1 routes on **presence** ("exchange present → perp", "timeframe present → perp", "bare → universe check"). The handler cannot see "omitted" through the defaults. The MCP SDK exposes no raw-args hook. Two viable designs — **both satisfy the §AC truth table verbatim** (the table never tests an explicitly-passed default value); they differ only on explicit-default inputs + the additive-only constraint:

- **Choice A (recommended — spec-faithful):** drop `.default()` on `get_trade_call`'s `timeframe`/`exchange` → `.optional()` (no default). Omitted ⇒ `undefined` ⇒ clean presence logic exactly per R1; resolver applies the defaults (`timeframe ?? '15m'`, `exchange ?? venueDefault`). Runtime behavior for existing callers is **identical** (omit still ⇒ 15m/BINANCE). **Cost:** the published `inputSchema` loses the `default` keyword on those 2 params — a **non-additive schema diff** that conflicts with §R4 "snapshot diff = additions only". Needs an architect-sanctioned, behavior-preserving exception (update the R4 snapshot baseline + the additive assertion to allow the 2 default-key removals). Blast radius: `get_trade_call` only (`get_equity_call`/`get_equity_regime`'s NEW exchange/timeframe params are clean additive optionals with no default; `assetClass` is a clean additive optional).
- **Choice B (strict additive):** keep `.default()`; the resolver treats `exchange==='BINANCE'` and `timeframe==='15m'` as "not explicitly named". Purely additive schema (only adds `assetClass`). **Cost:** explicitly passing the default value is read as bare — e.g. explicit `{coin:'TSLA', exchange:'BINANCE'}` → equity (vs A: perp→`TradFiSymbolUnsupportedOnVenueError`); `assetClass:'perp'` is the escape hatch. Couples the resolver to the tools' specific default literals (fragile if a default ever changes).

Bare-unknown-ticker note (both choices): a bare ticker NOT in the equity universe routes to **perp BINANCE** (step 4) → the perp engine's generic "Signal generation unavailable" error (NOT equity nearest-symbol suggestions). The §AC "error (suggestions)" row is end-to-end-loose; the resolver itself is total (always returns a route) — the unit test asserts `{perp, BINANCE, 15m}` for an unknown bare ticker (`inEquityUniverse:false`); the error is the engine's, covered by the live test.

---

## 7. ⚠️ Q2 (MEDIUM) — R3 (regime pair) in-scope vs deferred

R3's own escape hatch: *"If the regime engines diverge materially (e.g. the crypto regime TF enum 1h/4h/1d can't host a passed value), ship R1+R2 and defer R3."* Probed divergence is **material**:
- `get_market_regime` TF enum = `['1h','4h','1d']` (`index.ts:416`) — only 3 values, vs `get_trade_call`'s 11.
- `get_equity_regime` (`equity-tool-formatters.ts:165-192`) has **NO timeframe** (always daily) — `getEquityRegime({symbol})`.

So a `get_equity_regime` gaining a `timeframe` can't pick a single coherent enum: matching trade_call's `1m..1d` lets `5m` route to a crypto-regime engine that rejects it; matching crypto-regime's `1h/4h/1d` is inconsistent with the trade-call surface. **Recommendation: ship R1+R2 fully; DEFER R3 with a `status.md` flag** (`OPS-TRADE-CALL-ROUTING-REGIME-W{NEXT}`), per the spec's no-half-fix rule. *Alternative if preferred:* a constrained R3 — route regime by `assetClass` + `exchange` only, with `get_equity_regime`'s new `timeframe` restricted to the crypto-regime enum `1h/4h/1d`. Architect's call.

---

## 8. Proposed execution plan (post-approval; one worktree)

1. **R1** — `src/lib/market-route.ts` (`resolveMarketRoute` + `MarketRoute` + `venueDefault`), pure. `tests/market-route.test.ts` = the §AC truth table + determinism property. (TDD: test first.)
2. **R2** — `isEquityUniverseSymbol` async helper (equities module); wire `get_trade_call` handler (per Q1 choice) + `get_equity_call` (additive `exchange`/`timeframe`) through the resolver; author canary-compliant descriptions + delete `"or TradFi symbol"`. Quota: dispatched engine meters once (no double-count — handler delegates).
3. **R3** — per Q2 (defer or constrained).
4. **R4** — resolver unit tests; `audits/trade-call-routing-shape-snapshot-2026-06-09.json` (allowed/forbidden keys, additive-only assertion per Q1, `tools/list`=9); `npm run build` clean; full vitest (+0 new failures vs the documented flaky baseline); `registry:drift:check` rc=0; keyword/length canary green.
5. **Deploy** — `scripts/deploy-direct.sh`; live AC probes (`api.algovault.com/mcp`): bare TSLA→equity, TSLA+BITGET+1h→perp, bare BTC→perp, `get_equity_call{TSLA}` back-compat, `tools/list`=9, `/capabilities` updated + no leak. NO version bump.
6. **Close** — `status.md` (newest-first, `system-map.md updated: Y`) + `system-map.md` same commit; `scp status.md` monitoring host. (Tier-1 → no WIS.)

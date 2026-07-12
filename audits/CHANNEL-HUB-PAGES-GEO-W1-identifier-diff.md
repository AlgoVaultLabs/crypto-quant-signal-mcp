# CHANNEL-HUB-PAGES-GEO-W1 — identifier-diff (Plan-Mode gate, pre-C1)

Cross-checks the channel identifier across its FOUR surfaces — `channel-registry` key/slug · nav Channels destination · generated page file · docs anchor — the single-derivation invariant (Build Rule 2: "nav Channel slugs === generated page slugs === docs anchor set"). Probed @ origin/main `33eedf3`.

## A. The channel identifier across surfaces (the single-derivation matrix)

| channel-registry key | registry channel key (toolCoverage) | nav dest (NEW) | page file (NEW) | served URL | docs anchor (NEW/existing) | hosted? |
|---|---|---|---|---|---|---|
| `mcp` | `channels.mcp` | `/mcp` | `landing/mcp.html` | `algovault.com/mcp` | `#mcp` (NEW, aliases `#connect-mcp`) | hosted |
| `rest-api` | `channels.httpX402` | `/rest-api` | `landing/rest-api.html` | `algovault.com/rest-api` | `#rest-api` (NEW, aliases `#knowledge-tools-api`) | hosted |
| `webhooks` | `channels.webhook` | `/webhooks` | `landing/webhooks.html` | `algovault.com/webhooks` | `#webhooks` (ALREADY EXISTS @1222) | hosted |
| `telegram` | `channels.bot` | `https://t.me/algovaultofficialbot` | — (no page) | — | — | **external** (no slug) |

**Invariant (CH5 canary):** hosted nav slugs `{mcp, rest-api, webhooks}` === generated page slugs `{mcp, rest-api, webhooks}` === docs anchor set `{#mcp, #rest-api, #webhooks}`. `telegram` is external (no slug/page/anchor) — excluded from the slug-equality set, asserted `external: true`.

## B. channel-registry key → feature-registry channel key mapping (the reach-flag bridge)

The channel-registry key (a UX/URL identifier) differs from the feature-registry reach-flag key. `toolCoverage()` derives per-channel tool coverage from `feature-registry.channels{}` via this fixed bridge (must be pinned in the SoT + tested):

| channel-registry key | → `feature-registry` `channels.<k>` | tools reached today (enabled, public) |
|---|---|---|
| `mcp` | `mcp` | all 6 public (+ equities, but publicListing filters public copy) |
| `rest-api` | `httpX402` | get_trade_call, get_market_regime, scan_funding_arb, scan_trade_calls (the priced 4) |
| `webhooks` | `webhook` | get_trade_call, get_market_regime, scan_trade_calls (webhookEvent set) |
| `telegram` | `bot` | get_trade_call, get_market_regime, scan_funding_arb, scan_trade_calls |

Preserves W1's drift trap: every reached-non-excluded registry channel key (`{mcp,httpX402,webhook,bot}`, minus `NAV_EXCLUDED_CHANNELS=[a2mcp,acp]`) MUST have a channel-registry entry, else the build throws.

## C. R (spec) vs live — count + identifier reconciliation

| Identifier | Spec (R) | Live @ 33eedf3 | Match? |
|---|---|---|---|
| URLs | `/mcp` `/rest-api` `/webhooks` (Mr.1 confirmed) | greenfield (404 pre-deploy) | ✅ target |
| `/rest-api` avoids `api.algovault.com` collision | stated | apex `/rest-api` is free; api host is separate | ✅ |
| nav Channels current dests | `/docs.html#…` | `#connect-mcp` · `#testing-with-curl` · `#webhooks` · `t.me` (W1 `CHANNEL_NAV`) | ✅ (repoint target) |
| docs `#mcp`/`#rest-api` exist? | "add, alias existing" | absent (only `#connect-mcp`/`#knowledge-tools-api` exist) | CH4 adds (aliases; old ids kept) |
| docs `#webhooks` exist? | (implied) | **EXISTS** @1222 | ✅ no-op for webhooks anchor |
| public tool set | 6 (equities excluded) | 6 via `publicListing` (W1) | ✅ |
| surface count | 26 → +3 = 29 | 26 (W1: 24 static + tools + 2 fn-rendered… actually 25 static incl tools + 2 fn = 27 nav surfaces) | see note |

**Surface-count note:** W1 shipped **25 static landing pages carrying `NAV:START`** (24 originals + `tools.html`) + 2 function-rendered routes. This wave adds **3** (mcp/rest-api/webhooks) → **28 static NAV:START pages**. CH3/CH5 assert the exact `git grep -c 'NAV:START' landing` count after injection (not a hardcoded literal — live-counted).

## D. No contradictions

Identifiers are internally consistent and live-verified: 0 fictional, 0 R↔live href contradictions, the `/rest-api` naming avoids the api-host collision (Mr.1 rationale confirmed), `#webhooks` already exists (webhooks anchor is a no-op), and the reach-flag bridge (B) is the only non-obvious mapping — pinned in the SoT + a CH1 test. Proceed on approval.

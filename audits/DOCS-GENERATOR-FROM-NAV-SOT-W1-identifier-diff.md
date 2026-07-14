> **Post-ruling reconciliation (2026-07-14):** this is the PRE-implementation Plan-Mode snapshot. Cowork rulings A1–A4 + CH2 D refined it — final state in status.md. Deltas: (A1) NO `FeatureSpec.displayName` — docs reuses `nav publicToolEntries().label`; (CH2 D) the 3 Ecosystem connect H4 bodies are `build_landing` markers filled by `renderSurfaceSection` (anchors `#connect-mcp`/`#connect-ai-agent`/`#connect-exchange-kit` come from the surface metas, not build_docs); (CH4) `#x402`+`#knowledge-tools-api` are POSITIONED partial sub-heading ids (not outline alias spans) so build_channel_pages per-anchor extraction works; partials live in `docs-src/partials/` (A4), not `landing/docs/partials/`.

# DOCS-GENERATOR-FROM-NAV-SOT-W1 — identifier-diff.md (Plan-Mode)

Asserts the **Single-Derivation LAW** (Build Rule 2): every `node.id` in `docs-outline` maps 1:1 to a partial filename, a sidebar `<a href="#…">`, and a body `id="…"` section. Divergence between any two columns = the CH5 canary MUST fail. Derived vs curated origin per node. Tools set derives from `publicToolNames()` (6); Channels set from `CHANNELS` (4).

Legend — **Origin:** `nav`=derived from nav-manifest publicToolEntries · `chan`=derived from channel-registry CHANNELS · `cur`=curated node in docs-outline. **Slug rule:** tool anchors = `slug(name)` (already exported by nav-manifest); channel anchors = channel `slug`.

| # | node.id | Lvl | Origin | Partial file `landing/docs/partials/` | Sidebar `href` | Body `id=` | Disposition | Legacy alias `id=` to EMIT |
|--|---|--|--|--|--|--|--|--|
| 1 | `quick-start` | intro | cur | `quick-start.html` | `#quick-start` | `quick-start` | retain verbatim | — (already canonical) |
| 2 | `platform` | H1 | cur | `platform.html` (intro/optional) | `#platform` | `platform` | NEW group header | — |
| 3 | `tools` | H2 | cur | `tools.html` (overview) | `#tools` | `tools` | group header (was "Knowledge Tools" overview) | `knowledge-tools-overview` |
| 4 | `get-trade-call` | H3 | nav | `get-trade-call.html` | `#get-trade-call` | `get-trade-call` | migrate | **`get-trade-signal`** |
| 5 | `get-market-regime` | H3 | nav | `get-market-regime.html` | `#get-market-regime` | `get-market-regime` | migrate | — (slug==old) |
| 6 | `scan-funding-arb` | H3 | nav | `scan-funding-arb.html` | `#scan-funding-arb` | `scan-funding-arb` | migrate | — (slug==old) |
| 7 | `scan-trade-calls` | H3 | nav | `scan-trade-calls.html` | `#scan-trade-calls` | `scan-trade-calls` | **NEW** (live schema) | — |
| 8 | `chat-knowledge` | H3 | nav | `chat-knowledge.html` | `#chat-knowledge` | `chat-knowledge` | migrate | **`knowledge-tools-chat`** |
| 9 | `search-knowledge` | H3 | nav | `search-knowledge.html` | `#search-knowledge` | `search-knowledge` | migrate | **`knowledge-tools-search`** |
| 10 | `tools-when-to-use` | sub | cur | `tools-when-to-use.html` | `#tools-when-to-use` | `tools-when-to-use` | migrate + generalise | **`knowledge-tools-when`** |
| 11 | `tools-worked-examples` | sub | cur | `tools-worked-examples.html` | `#tools-worked-examples` | `tools-worked-examples` | migrate + generalise | **`knowledge-tools-examples`** |
| 12 | `tools-rate-limits` | sub | cur | `tools-rate-limits.html` | `#tools-rate-limits` | `tools-rate-limits` | migrate + generalise | **`knowledge-tools-quota`** |
| 13 | `channels` | H2 | cur | `channels.html` (intro) | `#channels` | `channels` | NEW group header | — |
| 14 | `channel-mcp` | H3 | chan | `channel-mcp.html` | `#mcp` | `channel-mcp` | migrate + link `/mcp` | **`connect-mcp`**, **`testing-with-curl`** |
| 15 | `channel-rest-api` | H3 | chan | `channel-rest-api.html` | `#rest-api` | `channel-rest-api` | merge + link `/rest-api` | **`x402`**, **`knowledge-tools-api`** |
| 16 | `channel-webhooks` | H3 | chan | `channel-webhooks.html` | `#webhooks` | `channel-webhooks` | migrate + link `/webhooks` | — (slug==old) |
| 17 | `channel-telegram` | H3 | chan | `channel-telegram.html` | `#telegram` | `channel-telegram` | **NEW** + link `t.me` | — |
| 18 | `ecosystem` | H2 | cur | `ecosystem.html` (intro) | `#ecosystem` | `ecosystem` | group header | — |
| 19 | `integration` | H3 | cur | `integration.html` (intro) | `#integration` | `integration` | group header | — |
| 20 | `connect-mcp-client` | H4 | cur | `connect-mcp-client.html` | `#connect-mcp-client` | `connect-mcp-client` | **NEW** (refer `/integrations`) | — |
| 21 | `connect-ai-agent` | H4 | cur | `connect-ai-agent.html` | `#connect-ai-agent` | `connect-ai-agent` | migrate | — |
| 22 | `connect-exchange-kit` | H4 | cur | `connect-exchange-kit.html` | `#connect-exchange-kit` | `connect-exchange-kit` | migrate | — |
| 23 | `connect-trading-platform` | H4 | cur | `connect-trading-platform.html` | `#connect-trading-platform` | `connect-trading-platform` | **NEW** (refer `/integrations`) | — |
| 24 | `skills-usage-examples` | H3 | cur | `skills-usage-examples.html` | `#usage-examples` | `usage-examples` | migrate | — (keep old id canonical) |
| 25 | `track-record` | H1 | cur | `track-record.html` (intro) | `#track-record` | `track-record` | NEW group header | — |
| 26 | `live-dashboard` | H2 | cur | `live-dashboard.html` | `#live-dashboard` | `live-dashboard` | **NEW** + link `/track-record` | — |
| 27 | `verify` | H2 | cur | `verify.html` | `#verify` | `verify` | migrate + rename label | **`on-chain-verification`** |
| 28 | `pricing` | H1 | cur | `pricing.html` | `#pricing` | `pricing` | migrate + promote | — |
| 29 | `faq` | H1 | cur | `faq.html` | `#faq` | `faq` | migrate + promote | — |

## Counts (CH5 canary invariants)

- **Tools H3 = 6** (#4–#9) === `publicToolNames().length` (6). Adding a mock public tool → +1 row (CH1 test).
- **Channels H3 = 4** (#14–#17) === `CHANNELS.length` (4). Adding a channel → +1 row.
- **Total content nodes = 29** (partials); H1/H2 group intros (#2,#13,#18,#19,#25) may be thin or stubbed — the missing-partial gate treats a missing partial as a CONSCIOUS stub failure, never a silent drop.
- **sidebar entries === body section ids === outline nodes** (29). No orphan.

## Collision / ambiguity checks (the reason for this diff)

1. **`channel-mcp` (#14, anchor `#mcp`) vs `connect-mcp-client` (#20, anchor `#connect-mcp-client`).** DISTINCT node ids + DISTINCT anchors. Both derive content from `#connect-mcp`, but the legacy `#connect-mcp` alias attaches to **`channel-mcp`** (the MCP-over-HTTP handshake home); `connect-mcp-client` is a NEW brief section (refer `/integrations`). ✅ No collision.
2. **Tool anchor slug drift.** `slug()` gives new canonical anchors for 3 tools (`get-trade-call`←`get-trade-signal`, `chat-knowledge`←`knowledge-tools-chat`, `search-knowledge`←`knowledge-tools-search`). Each old id emitted as an alias (rows #4,#8,#9). `get-market-regime`/`scan-funding-arb` slugs already == old anchors → no alias. ✅
3. **`skills-usage-examples` node id vs `#usage-examples` anchor.** Deliberate: node id descriptive, anchor keeps the legacy `usage-examples` id as canonical → zero dead-link risk, zero alias needed (row #24). ✅
4. **`channel-rest-api` anchor `#rest-api`** already exists (CHANNEL-HUB). Reused as canonical; `#x402` + `#knowledge-tools-api` fold in as aliases (row #15). ✅
5. **Legacy-alias emission mechanism:** every alias `id=` is **emitted BY `build_docs` from the outline** (an empty `<span id="…"></span>` adjacent to the section), NEVER hand-added inside a generated region (skill `hand-edit-inside-generated-block-is-wiped`). Full page is generated → aliases survive every regen.

## Alias-set (CH4 no-dead-link grep target — 11 legacy ids)

`get-trade-signal` · `knowledge-tools-chat` · `knowledge-tools-search` · `knowledge-tools-when` · `knowledge-tools-examples` · `knowledge-tools-quota` · `knowledge-tools-api` · `connect-mcp` · `testing-with-curl` · `x402` · `on-chain-verification` (+ `knowledge-tools-overview` group alias). CH4 gate greps each `id="<a>"` present in the generated `landing/docs.html`.

## Partial-directory note (Q4, low-sev)

Partials at `landing/docs/partials/<id>.html` are Caddy-served → `algovault.com/docs/partials/<id>.html` would expose raw headless fragments (public copy; harmless but a thin GEO-dilution surface). Options: (a) keep spec path; (b) move to a non-served build-input dir. Recommend (a) + a `robots`/no-index consideration OR defer. Not blocking.

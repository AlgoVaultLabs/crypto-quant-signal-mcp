> **Post-ruling reconciliation (2026-07-14):** this is the PRE-implementation Plan-Mode snapshot. Cowork rulings A1–A4 + CH2 D refined it — final state in status.md. Deltas: (A1) NO `FeatureSpec.displayName` — docs reuses `nav publicToolEntries().label`; (CH2 D) the 3 Ecosystem connect H4 bodies are `build_landing` markers filled by `renderSurfaceSection` (anchors `#connect-mcp`/`#connect-ai-agent`/`#connect-exchange-kit` come from the surface metas, not build_docs); (CH4) `#x402`+`#knowledge-tools-api` are POSITIONED partial sub-heading ids (not outline alias spans) so build_channel_pages per-anchor extraction works; partials live in `docs-src/partials/` (A4), not `landing/docs/partials/`.

# DOCS-GENERATOR-FROM-NAV-SOT-W1 — endpoint-truth.md (Plan-Mode)

**Probed:** 2026-07-14 · against `origin/main` HEAD **`826d698`** (spec's cited baseline — confirmed current).
**Format:** `claim | reality | resolution`. 0 fictional primitives. 1 falsified premise (Q1). 1 semantics correction (Q2). 3 coordination contracts (Q3–Q4 + build-order).

---

## Step-0 baseline (dependency confirmation + STALE-LOCAL finding)

| Claim | Reality (probed) | Resolution |
|---|---|---|
| Both deps shipped @ `826d698` | `origin/main` HEAD **= `826d698`**; NAV-PLATFORM-GENERATOR-W1 (`33eedf3`) + CHANNEL-HUB-PAGES-GEO-W1 (`a9ad0f3`) both ancestors + live-verified in status.md | ✅ baseline intact; re-HALT only on NEW drift → none found |
| (implicit) local checkout usable | **Local `main` = `f6a2b52`, 61 commits BEHIND `origin/main`** (`git rev-list f6a2b52..origin/main = 61`); `channel-registry.ts` ABSENT locally, PRESENT in origin/main | ⚠️ **All probes run against `origin/main` via `git show`/`git grep`, NOT the local tree.** codegraph + Preview MCP (pinned to the stale local checkout) are NOT authoritative for this wave — matches memory `feedback_sync_primary_checkout_before_editing`. Execution MUST branch a worktree off `origin/main`. |
| working tree clean | untracked cruft: `.claude/napkin.md`, `audits/RELEASE-v1.22.0-W1-endpoint-truth.md` | ignore (not staged; worktree off origin/main won't inherit) |

---

## Rendering architecture (the critical unknown — probed, NOT assumed)

| Claim | Reality | Resolution |
|---|---|---|
| how is `docs.html` served? | **Caddy-STATIC.** No `app.get('/docs'…)`/`'/docs.html'` route in `src/index.ts@origin/main`. Only `app.get('/docs/integrations/:slug')` (a different, function-rendered surface). `docs.html` referenced only as the absolute `https://algovault.com/docs.html#…` (e.g. `src/index.ts:4453`) — served off the apex by Caddy `file_server`, per system-map §DIST | Regenerated `docs.html` deploys via **git push → Caddy sync** (+ `snapshot-landing-data.mjs`). **No container rebuild** needed for docs.html itself. Cross-host trap (memory `reference_crosshost_docs_links`): any docs internal link must stay APEX-absolute or root-relative `/…` served by Caddy, never a relative path resolving on `api.algovault.com`. |
| docs.html carries generator-owned regions | **YES — 3 injectors already write into docs.html:** `build_nav.mjs` → `<!-- NAV:START -->…<!-- NAV:END -->` (`docs.html:158–309`); `build_landing.mjs` → `<!-- BUILD:signup-flow:start/:end -->` + `<!-- BUILD:mcp-usage:start/:end -->` (from `src/lib/{signup-flow,mcp-usage-docs}`) | **Build-order contract (Q3):** `build_docs` (full-page) must run FIRST and re-EMIT those markers (empty), then downstream injectors fill them. Order: `tsc → build_docs → build_landing → build_nav`. `build_docs --check` = STRUCTURAL (sidebar===body===outline + counts), not a byte-diff — so it never fights the injected regions. |
| docs.html in the knowledge BM25 corpus? | **NO.** `build-knowledge-json.mjs` indexes only `landing/integrations/*.html` + `audits/*-shape-snapshot-*.json`. docs.html is absent. | Sidebar-chrome-flooding concern is **MOOT** — no chrome-strip needed for the new `<aside>` sidebar. (The chrome-strip skill applies to integrations pages, already handled by NAV-PLATFORM.) |
| sidebar element | `<aside class="hidden lg:block w-52 …">` with `.sidebar-link` anchors (`docs.html:314`), already CHANNEL-HUB-CH4-realigned; **uses OLD anchors** — `#get-trade-signal` for get_trade_call (`:321`), `#knowledge-tools-*`, `#connect-mcp`, `#rest-api`, `#knowledge-tools-api` | Generator rewrites the `<aside>` from the outline; the anchor inconsistency (`#get-trade-signal` label `get_trade_call`) is exactly what the wave retires. |

---

## Anchor probes — the From→To migration map (grep `id="…"` in `origin/main:landing/docs.html`)

| Source anchor (spec) | Present @826d698 | Target | Disposition |
|---|:--:|---|---|
| `#get-trade-signal` | 1 | Trade Call H3 | migrate; **canonical `#get-trade-call` (already present, count 1) + alias `#get-trade-signal`** |
| `#get-market-regime` | 1 | Market Regime H3 | migrate (slug == anchor, no alias needed) |
| `#scan-funding-arb` | 1 | Funding Arbitrage H3 | migrate (slug == anchor) |
| `#scan-trade-calls` | **0** | Trade Call Scanner H3 | **NEW** — confirms the undocumented back-fill target |
| `#knowledge-tools-chat` | 1 | Knowledge Chat H3 | migrate; canonical `#chat-knowledge` + **alias `#knowledge-tools-chat`** |
| `#knowledge-tools-search` | 1 | Knowledge Search H3 | migrate; canonical `#search-knowledge` + **alias `#knowledge-tools-search`** |
| `#knowledge-tools-when` / `-examples` / `-quota` | 1 / 1 / 1 | Tools subsections (When/Examples/Rate limits) | migrate + generalise "knowledge"→all tools; alias each old id |
| `#knowledge-tools-api` | 1 | → Channels ▸ REST API (fold in) | remove from Tools; **alias survives** on the REST API partial |
| `#connect-mcp` + `#testing-with-curl` | 1 / 1 | Channels ▸ MCP Server (+link `/mcp`) | migrate; both aliases on the MCP partial |
| `#rest-api` + `#x402` | 1 / 1 | Channels ▸ REST API (+link `/rest-api`) | merge; both aliases survive |
| `#webhooks` | 1 | Channels ▸ Webhooks (+link `/webhooks`) | migrate |
| `#connect-ai-agent` / `#connect-exchange-kit` | 1 / 1 | Ecosystem ▸ Integration H4s | migrate |
| `#usage-examples` | 1 | Skills & Usage Examples H3 | migrate (keep as canonical) |
| `#on-chain-verification` | 1 | Track Record ▸ Verify H2 | migrate + rename label; **alias `#on-chain-verification`** |
| `#pricing` / `#faq` | 1 / 1 | H1 Pricing / H1 FAQ | migrate + promote |
| `#mcp` (CHANNEL-HUB CH4) | 1 | Channels ▸ MCP Server anchor | reuse as canonical channel anchor |

**Every legacy id is present and accounted for** → the CH4 no-dead-link grep-gate is satisfiable. New sections author from live sources (5): Scanner (live `scan_trade_calls` zod schema + `SCAN_TRADE_CALLS_DESCRIPTION`), Telegram Bot (TG_BOT constant), Live Dashboard (`/track-record`), Connect-MCP-Client + Connect-Trading-Platform (refer `/integrations`).

---

## Link probes (`curl -sS -m 12 -o /dev/null -w %{http_code}`)

| Link | Code | Note |
|---|:--:|---|
| `https://algovault.com/mcp` | **200** | Channels ▸ MCP Server → hub |
| `https://algovault.com/rest-api` | **200** | Channels ▸ REST API → hub |
| `https://algovault.com/webhooks` | **200** | Channels ▸ Webhooks → hub |
| `https://algovault.com/track-record` | **200** | Track Record ▸ Live Dashboard |
| `https://algovault.com/integrations` | **200** | Ecosystem ▸ Integration H4s refer here |
| `https://algovault.com/docs.html` | **200** | the target page itself |
| `https://t.me/algovaultofficialbot` | `000` (local DNS block) | **Not a dead link.** `curl(6) Could not resolve host: t.me` = sandbox DNS filter. CORROBORATED real: `channel-registry.ts:13 TG_BOT = 'https://t.me/algovaultofficialbot'` ("the real, grepped handle — never invented"); already LIVE across 5+ shipped landing pages (docs/faq/glossary/how-it-works/index); memory `reference_algovault_bot_repo` (bot LIVE). |

---

## Primitive probes (registries · build wiring · tests)

| Primitive | Reality @826d698 | Resolution |
|---|---|---|
| `feature-registry` public tools | `publicToolNames()` (`enabled && publicListing !== false`) = **6** in registry order: get_trade_call, get_market_regime, scan_funding_arb, **scan_trade_calls**, chat_knowledge, search_knowledge. Equities (2) `publicListing:false`. **This order == the Mr.1-dictated H3 order exactly** — zero hardcoded reorder. | Derive Tools H3s from `publicToolNames()`. |
| `publicListing:true` (spec phrasing) | **0 occurrences.** Registry is default-public; only equities opt out (`:false`). | **Q2 correction:** a literal `=== true` filter yields ZERO. Use `publicToolNames()`. |
| `FeatureSpec.displayName` | **ABSENT** (genuinely new). BUT `nav-manifest.ts` already owns `TOOL_LABELS` (exact target titles) + exports `publicToolEntries().label`/`.anchor` — the ONE source nav + `/tools` derive from. | **Q1 (falsified premise):** adding `displayName` duplicates an existing single source. See Q-block. |
| `projectCapabilities()` | Allow-list, field-by-field (`{name,canonical,channels,quota,x402,description,lenses?,enabled}`) — does NOT spread the spec. | Adding `displayName?` to FeatureSpec **cannot leak** into `/capabilities`. Snapshot `snapshot:capabilities:check` guards it. Satisfies scope firewall + channel-derives skill. |
| `channel-registry` CHANNELS | **4**: mcp('MCP Server',`#connect-mcp`,`#testing-with-curl`), rest-api('REST API',`#x402`,`#knowledge-tools-api`), webhooks('Webhooks',`#webhooks`), telegram('Telegram Bot',TG_BOT,[]). `docsAnchors` == the from→to map exactly. | Derive Channels H3s (4) from `CHANNELS`; per-channel migrate source = its `docsAnchors`. |
| `scan_trade_calls` schema | zod: topN, timeframe, exchange(PROMOTED_VENUE_IDS, dflt BINANCE), minConfidence, includeHolds, limit(dflt 10), rankBy(dflt 'oi'), includeReasoning, oiChangeWindow, oiBasis. Desc `SCAN_TRADE_CALLS_DESCRIPTION` (`tool-descriptions.ts:62`). | Real source for the NEW Scanner partial. |
| build scripts | `build:landing = "tsc && node scripts/build_landing.mjs"`; `build_nav.mjs`, `build_landing.mjs`, `build_tools_page.mjs`, `build_channel_pages.mjs` exist. **No `build_docs.mjs` yet** (NEW). `prepublishOnly` chains `build_nav --check`. `snapshot:capabilities:check` exists. | CH3 adds `build_docs.mjs`; CH5 inserts `build_docs --check` into `build:landing` (package.json), `deploy.yml`, `prepublishOnly`. |
| deploy.yml paths-ignore | `activation-funnel/snapshots/**`, `ops/systemd/**`, `ops/monitoring/**`, `LICENSE`, `glama.json`. **Does NOT ignore `landing/**` or `docs/**`.** | `landing/docs.html`, `landing/docs/partials/**`, `scripts/build_docs.mjs`, `src/lib/**`, `package.json`, `deploy.yml` all TRIGGER deploy. |
| CH gate test files | `tests/nav-manifest.test.ts`, `tests/channel-registry.test.ts` PRESENT. `tests/docs-outline.test.ts`, `tests/build-docs.test.mjs` NEW. Flat `tests/` layout ✓. Runner `vitest run` (+ node:test for `.mjs` — pre-push gate runs BOTH, memory `project_prepush_gate_runs_nodetest_too`). | CH1/CH3 gates runnable as specced. |

---

## Side-fix re-verify column (coordination contracts I will honor in execution)

- **Build order:** `tsc → build_docs → build_landing → build_nav` (build_docs emits `NAV:START/END` + `BUILD:mcp-usage` + `BUILD:signup-flow` markers; downstream fills). Re-verify: after full `build:landing`, `build_nav --check` == 0 AND `build_landing --check` == 0 AND `build_docs --check` == 0.
- **`--check` flip-flop:** back-to-back `--check` across separate processes can flip-flop on a fs read-after-write race (memory + skill `build-check-flip-flop…`; CHANNEL-HUB hit this). CI runs them as spaced steps → unaffected. I will NOT chase phantom non-determinism; confirm `git status` clean == correct.
- **`/capabilities` byte-unchanged:** `snapshot:capabilities:check` after any feature-registry edit.
- **node:test canaries:** before moving any src literal, grep the node:test `.mjs` canaries (memory `project_prepush_gate_runs_nodetest_too`).

---

## Verdict

**0 fictional primitives. Spec is factually sound.** Proceed pending architect ruling on **Q1** (the only scope-changing decision). Q2/Q3 are corrections I will apply unless overruled; Q4 is low-sev. Full node/partial/anchor mapping in the companion `identifier-diff.md`.

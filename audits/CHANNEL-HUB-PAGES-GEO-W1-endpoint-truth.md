# CHANNEL-HUB-PAGES-GEO-W1 — endpoint-truth.md (Plan-Mode gate, pre-C1)

**Probed:** 2026-07-12 · against **origin/main `33eedf3`** (= my just-shipped NAV-PLATFORM-GENERATOR-W1 tip; worktree clean at HEAD).
**Verdict:** ✅ **PROCEED-pending-approval** — 0 fictional primitives, 0 NEW drift vs W1. Clean build-on. No HALT. Awaiting architect approval of this plan before any landing mutation (per the dispatch gate).

---

## 1. W1-infra confirm (Step-0 thin confirmation — spec "reuses W1; re-HALT only on NEW drift")

| W1 primitive this wave reuses | Live @ origin/main 33eedf3 | Verdict |
|---|---|---|
| `src/lib/nav-manifest.ts` (`buildNavModel`, `CHANNEL_NAV`, `NAV_EXCLUDED_CHANNELS`, `publicToolEntries`, `slug`) | EXISTS | ✅ |
| `scripts/build_nav.mjs` (marker injector + `--check` drift/coverage) | EXISTS | ✅ |
| `scripts/build_tools_page.mjs` + `landing/tools.html` (page-gen pattern to mirror) | EXISTS | ✅ |
| `FeatureSpec.publicListing` + `publicToolNames()` (6 public tools) | EXISTS | ✅ |
| `channels{mcp,httpX402,bot,webhook,a2mcp,acp}` reach-flags | EXISTS | ✅ |
| `src/lib/channel-registry.ts`, `scripts/build_channel_pages.mjs` (NEW) | greenfield | ✅ correct |

**W1 `CHANNEL_NAV` (the inline map this wave extracts into `channel-registry.ts`):** keyed by registry channel keys → nav items:
`mcp→#connect-mcp` · `httpX402(REST API)→#testing-with-curl` · `webhook→#webhooks` · `bot(Telegram)→t.me` (external). `CHANNEL_ORDER=['mcp','httpX402','webhook','bot']`; `buildChannelsColumn` THROWS on a reached-non-excluded registry key with no mapping (the drift trap — MUST be preserved by the refactor).

---

## 2. Docs-anchor confirm (Rule 3 "source, don't invent" — reuse source sections)

| Docs anchor | Line | Section | Reused by | Verdict |
|---|---|---|---|---|
| `#connect-mcp` | 732 | MCP connection config | `/mcp` page | ✅ (code block nearby) |
| `#knowledge-tools-api` | 685 | **HTTP API** (currently mis-grouped under Knowledge Tools) | `/rest-api` page | ✅ |
| `#testing-with-curl` | 374 | "Testing with raw HTTP / curl" (3-step handshake) | `/rest-api` page | ✅ (`<pre>` @379) |
| `#webhooks` | 1222 | Webhooks | `/webhooks` page | ✅ (`<pre>` @1240) — **anchor already `#webhooks`** |
| `#knowledge-tools-quota` | 702 | **Rate limits** (mis-grouped under Knowledge Tools) | docs realign (CH4) → Channels | ✅ |

Docs has **37 `<pre>` code blocks** — the verbatim-reuse source (CH2 extracts exact blocks per Rule 3). Sidebar CONFIRMED mis-grouping: "HTTP API" + "Rate limits" sit under **Knowledge Tools** (CH4 moves them under Channels). Live docs ids from the spec (`#quick-start #testing-with-curl #get-trade-call #scan-funding-arb #get-market-regime #knowledge-tools-* #integration #connect-mcp`) all present.

**REST anchor reconciliation (decision, spec-consistent):** the REST/HTTP story is split — `#knowledge-tools-api` (HTTP API) + `#testing-with-curl` (raw HTTP 3-step handshake). CH4 adds a canonical `#rest-api` anchor on the HTTP-API section (aliasing `#knowledge-tools-api`; old id kept — no dead links). The `/rest-api` page reuses BOTH sections' code. `channel-registry.rest-api.connect.docsAnchor = #rest-api`.

---

## 3. schema.org confirm (Rule 4 — JSON-LD field validation, web-fetched)

**`TechArticle`** (schema.org/TechArticle) — ALL used fields valid: `headline, description, url, mainEntityOfPage, author, publisher, datePublished, dateModified, articleSection, keywords, about, image, inLanguage, proficiencyLevel, dependencies` (last two TechArticle-specific). ✅
**`SoftwareApplication`** (schema.org/SoftwareApplication) — valid: `name, description, url, applicationCategory, operatingSystem, offers, featureList, softwareRequirements, softwareVersion, provider, sameAs`. ✅
**`FAQPage`** — used by existing answer pages (`faq.html`, `ai-agents-*`) — valid + geo-test-precedented. ✅

**JSON-LD bucket for the 3 channel pages (RESOLVED via probe — the mirror of W1's tools.html but OPPOSITE bucket):** the hubs are how-to ANSWER pages → the **GEO-content pattern**: each carries its OWN `TechArticle` + `FAQPage` + `Organization` `@id` ref (NOT the 5 managed marketing blocks). Therefore ADD the 3 slugs to **both** `scripts/generate_jsonld.mjs` `FILES_TO_SKIP` (so it doesn't inject Product/Service/SoftwareApplication/WebSite) **and** `tests/unit/geo_jsonld_consistency.test.mjs` `GEO_CONTENT_SLUGS` (so the "5 blocks on every managed page" test excludes them). `geo_answer_page_invariants.test.mjs` uses a FIXED `ANSWER_SLUGS` list (line 24) filtered to existing files — it does NOT auto-include the channel pages, so no forced coupling; the channel pages' GEO structure is asserted by NEW `tests/build-channel-pages.test.mjs` (Rule 4 AC).

---

## 4. Fictional-primitive tally + NEW-drift check

**Fictional primitives: 0.** Every cited primitive (W1 infra, docs anchors, feature-registry channels, schema.org types) is live-verified. **NEW drift since W1: 0** — origin/main is exactly my W1 tip 33eedf3; all reused infra intact. No HALT.

---

## 5. system-map edge-touch enumeration (Step 0)

- NEW SoT + derive edge: `channel-registry → feature-registry` (reads `channels{}` for per-channel `toolCoverage`).
- CHANGED: `nav-manifest Channels column → channel-registry` (refactor W1's inline `CHANNEL_NAV` to derive from the new SoT — single source).
- NEW build edge: `build_channel_pages.mjs → landing/{mcp,rest-api,webhooks}.html`.
- MUTATED edge: nav Platform › Channels dests `/docs.html#…` → `/mcp` · `/rest-api` · `/webhooks` (telegram stays `t.me`).
- LANDING node: docs.html IA realigned (Tools / Channels / Ecosystem / Verify); nav injector surface count **+3** (26 → 29).
- (coupled) `generate_jsonld.mjs FILES_TO_SKIP` +3; `geo_jsonld_consistency GEO_CONTENT_SLUGS` +3.

`system-map.md updated: Y` (assert in CH5 status entry).

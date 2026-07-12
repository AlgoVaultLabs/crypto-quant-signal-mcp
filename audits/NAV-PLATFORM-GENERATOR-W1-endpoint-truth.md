# NAV-PLATFORM-GENERATOR-W1 — endpoint-truth.md (Plan-Mode gate, pre-C1)

**Probed:** 2026-07-12 · against **origin/main `075d408`** (deployed truth; local checkout `f6a2b52` is **53 commits behind** → NOT used for architecture facts).
**Verdict:** 🛑 **HALT before any landing mutation** — 0 fictional primitives, but the spec's **central premise is falsified**: a nav SoT + web/mobile parity canary **already exist**, and executing the spec as written creates **two divergent navs** (single-derivation LAW violation). Architect decision required (Q-block below).

---

## 1. Fictional-primitive probe (claim | reality | resolution) — threshold HALT ≥3

| # | Spec primitive | Live reality @ origin/main | Verdict |
|---|---|---|---|
| 1 | `src/lib/feature-registry.ts` | EXISTS | ✅ real |
| 2 | `allToolNames()` | EXISTS — `FEATURE_REGISTRY.flatMap(f => [f.name, ...f.aliases])` (⚠️ **includes aliases**) | ✅ real; CH1's "filter out `get_trade_signal`" is correct |
| 3 | `projectCapabilities()` | EXISTS (`{ tools: PublicCapability[] }`) | ✅ real |
| 4 | registry `channels` keys `{mcp,httpX402,webhook,bot}` | EXISTS with **6** keys `{mcp, httpX402, bot, webhook, a2mcp, acp}`; registry comment confirms `a2mcp`/`acp` = marketplace rails | ✅ real; CH1 `NAV_EXCLUDED_CHANNELS=[a2mcp,acp]` correct |
| 5 | `scripts/build_landing.mjs` + `build:landing` npm script | EXIST (`"build:landing": "tsc && node scripts/build_landing.mjs"`) | ✅ real |
| 6 | `scripts/snapshot_capabilities.mjs` + `snapshot:capabilities:check` | EXIST (`"snapshot:capabilities:check": "tsc && node scripts/snapshot_capabilities.mjs --check"`) | ✅ real |
| 7 | `prepublishOnly` (CH5 target) | EXISTS (already chains 4 `--check` canaries) | ✅ real |
| 8 | `data-mobile-nav-toggle` / `#mobile-menu` mobile toggle | EXIST (in BOTH `site-nav.ts` AND the 24 static pages) | ✅ real |
| 9 | `.github/workflows/deploy.yml` `build_nav --check` sibling pattern | `build_landing.mjs --check` sibling EXISTS @ `deploy.yml:70-71`; also runs post-deploy via `docker exec` | ✅ real pattern to mirror |
| 10 | `/opt/algovault-monitoring/send_telegram.sh` (CH5 "12th consumer") | Host-side (Hetzner) — not locally verifiable; matches monitoring-runbook contract | ⚠️ documented-only (deferred verification) |
| 11 | `nav-manifest.ts` / `build_nav.mjs` / `landing/tools.html` (NEW) | absent | ✅ greenfield (correct) |

**Fictional primitives: 0.** (No HALT on the fictional-primitive axis.)

---

## 2. FALSIFIED PREMISE — the material HALT (architecture conflict)

The spec Objective: *"the persistent nav is **hand-duplicated ~18×**… 'Web + mobile render the same' is a **manual promise that drifts**… Fix it at the generator: one typed nav SoT rendered by one build-time injector."*

**Live reality — a nav generator + a web/mobile parity canary already exist:**

| Spec belief | Live @ origin/main | Impact |
|---|---|---|
| No nav generator exists | **`src/lib/site-nav.ts`** (134 LOC) — `renderSiteNav()` renders desktop bar **AND** mobile drawer from **one** call. Consumed by `src/index.ts` + `src/lib/account-handlers.ts` → the **function-rendered** routes `/track-record` + `/account`. | Building a NEW `nav-manifest.ts`+`build_nav.mjs` that ignores `site-nav.ts` = **two nav SoTs** |
| Integration pages hand-duplicate nav | 16 `landing/integrations/*.html` navs are **generated** by `scripts/render-integrations.mjs` → `canonicalNavHtml(exchange)` ("8-item, post-W9") | Another existing nav generator the spec omits |
| Web+mobile parity is a manual, drifting promise | **`scripts/check_mobile_nav_parity.sh`** already enforces: every surface with the desktop nav signature MUST ship `data-mobile-nav-toggle` + `#mobile-menu`, **recursively over `landing/**/*.html` AND `src/**`**. Drift class **already structurally closed** (`MOBILE-NAV-*` waves). | The spec's core justification is stale |
| "~18× across ~9 landing HTML pages" | **24** nav-bearing static pages + **2** function-rendered routes = **26** surfaces (see §4) | Scope undercount ~3× |

**Why this is a hard HALT (not a fix-inline):** the spec's **System Taxonomy firewall freezes `site-nav.ts` ("Must NOT write")** and omits `render-integrations.mjs`. But correct single-derivation **requires** editing both (so `/track-record`+`/account` and the 24 static pages all project from ONE model). Executed literally, the spec ships:
- `/track-record` + `/account` → **old 9-item nav** (still from `site-nav.ts`)
- 24 static pages → **new Platform mega-menu** (from `build_nav.mjs`)

→ a permanently **divergent nav**, i.e. the exact "web is one thing, another surface is another" bug the wave exists to kill — and a direct violation of **Build-Rule 3 Single-derivation (LAW)**. The scope firewall itself is wrong given the real architecture, so the wave cannot be executed correctly within its stated Scope. **Internal-consumer enumeration → match outside README → HALT** (CLAUDE.md Plan-Mode rule): the nav region is produced/consumed by `site-nav.ts` (src), `render-integrations.mjs` (scripts), `site-nav.test.ts` + `site-nav-byte-equivalence.test.ts` + `check_mobile_nav_parity.sh` (tests/scripts).

---

## 3. CH4 href probes — `curl -sI` (Factuality LAW; all resolve)

UA = desktop Chrome; `--max-time 12`; 2026-07-12.

| Href | Code | Note |
|---|---|---|
| `https://algovault.com/track-record` | **200** | Track Record dropdown → Live Dashboard |
| `https://algovault.com/verify` | **200** | Track Record dropdown → Verify (moved off top bar; no data-loss) |
| `https://algovault.com/how-it-works` | **200** | top bar link |
| `https://algovault.com/` (`/#pricing` root) | **200** | Pricing anchor target |
| `https://algovault.com/docs.html` | **200** | top bar link |
| `https://algovault.com/integrations` | **200** | Platform ▸ Ecosystem |
| `https://algovault.com/skills` | **200** | Platform ▸ Ecosystem |
| `https://algovault.com/tools` | **404** | ✅ **expected** — new page; CH3 creates it; probe local file existence pre-deploy |
| `https://api.algovault.com/account` | **200** | Account (absolute api host — apex `/account` differs) |
| `https://api.algovault.com/welcome` | **200** | Signup pill (absolute api host — **apex `/welcome` 404s**, per `FUNNEL-FIX-NAV-CTA-WELCOME-W1`) |

**Telegram handle (Build-Rule 4 — real, never invented):** `https://t.me/algovaultofficialbot` — **16** live occurrences across `landing/` + `src/`. Use for Channels ▸ Telegram Bot. No other `t.me/` handle exists.

**Channels ▸ {MCP Server, REST API, Webhooks} destinations:** NOT yet pinned (spec said "Step-0 probed" but gave no targets). Proposed → `/docs.html` section anchors; exact anchors curl-gated in CH4 (HTTP status unaffected by `#fragment`; `/docs.html`=200). **Pin in Q5.**

---

## 4. Real nav-bearing surface inventory (24 static + 2 fn-rendered = 26)

**Static `landing/*.html` carrying `data-mobile-nav-toggle` (CH4 apply scope):**
`docs.html · faq.html · glossary.html · how-it-works.html · index.html · integrations.html · skills.html · verify.html` (8 top-level)
`integrations/{alpaca,binance,bitget,bybit,claude-code,claude-desktop,cline,crewai,cursor,gemini,kraken,langchain,llamaindex,maf,okx,smithery}.html` (16, generated by `render-integrations.mjs`)
= **24 static pages.**

**Function-rendered (via `site-nav.ts` `renderSiteNav()`):** `/track-record` (`src/index.ts`) · `/account` (`src/lib/account-handlers.ts`) = **2 routes.**

**Cross-surface drift already present (evidence the SoT should be unified):** `index.html` nav uses **relative** hrefs (`/track-record`, `/integrations`); `site-nav.ts` uses **absolute** (`https://algovault.com/…`) with a documented rule that Track Record must be relative on apex-served pages but absolute on api-served `/account` (cross-origin). A single injected region must therefore adopt **absolute hrefs uniformly** to stay byte-identical across both origins (**Q6**).

---

## 5. Canonical tool set (Tools column / `/tools` page source)

8 canonical + 1 alias = live `tools/list`=9 (consistent w/ status.md):

| Tool | enabled | channels.mcp | public? |
|---|---|---|---|
| `get_trade_call` (alias `get_trade_signal`) | true | ✅ | ✅ canonical |
| `get_market_regime` | true | ✅ | ✅ |
| `scan_funding_arb` | true | ✅ | ✅ |
| `scan_trade_calls` | true | ✅ | ✅ |
| `chat_knowledge` | true | ✅ | ✅ |
| `search_knowledge` | true | ✅ | ✅ |
| `get_equity_call` | true | ✅ | ⚠️ **equities public-copy HOLD** (memory/standing directive) — registry has **no HOLD field** |
| `get_equity_regime` | true | ✅ | ⚠️ same |
| `get_trade_signal` (alias) | — | — | ❌ excluded (alias) — CH1 AC-b |

**Public Tools set = 6** if equities excluded per HOLD (recommend), **8** if HOLD lifted. **Decide in Q4.** `FEATURED_TOOLS=5` featured + "See all tools" → `/tools`.

---

## 6. system-map edge-touch enumeration (Step 0)

New/changed edges the CORRECTED wave touches (superset of the spec's Map Anchor, adds the `site-nav.ts` reconciliation):
- NEW derive edge: `nav-manifest → feature-registry` (consumes `allToolNames()`/`projectCapabilities()`/`channels`).
- **CHANGED (spec-omitted):** `site-nav.ts → nav-manifest` (refactor the existing runtime renderer to project from the shared model — the fix that prevents dual-SoT).
- **CHANGED (spec-omitted):** retire `render-integrations.mjs` `canonicalNavHtml()` → integration pages consume the injected region.
- NEW build edge: `build_nav.mjs → landing/**/*.html` (24 pages).
- NEW page node: `landing/tools.html` (consumer of `FEATURE_REGISTRY`).
- NEW CI canary: `build_nav.mjs --check` in `deploy.yml` + `prepublishOnly` + weekly host cron (`send_telegram.sh`, 12th consumer).

`system-map.md updated: Y` (asserted in CH5 status entry, per spec).

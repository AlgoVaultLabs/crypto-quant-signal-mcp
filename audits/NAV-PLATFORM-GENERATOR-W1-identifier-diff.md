# NAV-PLATFORM-GENERATOR-W1 — identifier-diff (Plan-Mode gate, pre-C1)

Cross-checks every identifier cited in the spec's **R-section** (Confirmed public-copy table + Platform mega-menu + Map Anchor) against its **AC/Verification-section** appearances (CH4 probe list, CH5 gate) **and against live `origin/main`**. Per CLAUDE.md: "Diff every cited identifier (email, port, hostname, slug, version) before state mutation."

## A. Nav href identifiers — R (nav table) vs AC (CH4 probe list) vs live

| Identifier | R-section (confirmed table / mega-menu) | AC-section (CH4 gate list) | Live | Match? |
|---|---|---|---|---|
| Track Record dest | `/track-record` | `https://algovault.com/track-record` | 200 | ✅ (rel vs abs — see D) |
| Verify dest | `/verify` (under Track Record ▾) | `https://algovault.com/verify` | 200 | ✅ |
| How it works | `/how-it-works` | `https://algovault.com/how-it-works` | 200 | ✅ |
| Pricing | `/#pricing` | `.../` root (CH4 note "`/#pricing`→root") | 200 | ✅ |
| Docs | `/docs.html` | `https://algovault.com/docs.html` | 200 | ✅ |
| Account | `https://api.algovault.com/account` | `https://api.algovault.com/account` | 200 | ✅ identical |
| Signup | `https://api.algovault.com/welcome` | `https://api.algovault.com/welcome` | 200 | ✅ identical |
| Integrations | `/integrations` (Ecosystem) | `https://algovault.com/integrations` | 200 | ✅ |
| Skills | `/skills` (Ecosystem) | `https://algovault.com/skills` | 200 | ✅ |
| Tools index | `/tools` (mega footer) | `https://algovault.com/tools` | **404** | ✅ expected (CH3 creates; local-file gate pre-deploy) |
| Tools anchors | `/tools#<anchor>` (Tools col) | `/tools#…` | n/a | ⚠️ CH3 must emit `id=<slug(name)>` matching CH1's `slug(name)` — pin ONE slug fn (model anchors ⊆ page ids) |
| Telegram Bot | (Channels) "Telegram Bot" | — | `t.me/algovaultofficialbot` (16×) | ✅ real handle |
| MCP Server / REST API / Webhooks | (Channels) labels only | — | **unpinned** | ⚠️ **Q5** — destinations not in spec |

**No R↔AC href contradictions.** Apex vs api hostnames are consistent and correct (`/welcome`+`/account` deliberately absolute-api, since apex `/welcome`=404 — matches `FUNNEL-FIX-NAV-CTA-WELCOME-W1`).

## B. Count identifiers — spec vs live (Spec-literal live-verify @ Step 0)

| Count | Spec literal | Live @ origin/main | Δ | Action |
|---|---|---|---|---|
| Nav duplication factor | "~18×" | 24 static + 2 fn-rendered = 26 surfaces | +8 | correct scope in CH4 |
| Landing pages w/ nav | "~9" | **24** static (`data-mobile-nav-toggle`) | +15 | **Q3** — CH4 = 24, not ~9 |
| Live nav items | "live=9" | 9 (8 links + Signup pill) — `site-nav.ts navLinks()` | 0 | ✅ |
| Mirror nav items | "mirror=8" | vault mirror stale (v1.10) — not used | — | ignore mirror |
| New top-bar items | "7 items" | n/a (target) | — | ✅ target |
| Canonical tools | (implied by registry) | 8 canonical (+1 alias) = `tools/list` 9 | — | ✅ |
| Public Tools (col) | "featured subset… `FEATURED_TOOLS=5`" | 6 public (if equities HOLD) or 8 | — | **Q4** decides base set |
| Registry channel keys | "`{mcp,httpX402,webhook,bot}`" (4) | **6** `{…,a2mcp,acp}`; a2mcp/acp = rails | +2 | ✅ CH1 excludes rails (correct) |

## C. Slug / class / marker identifiers

| Identifier | Spec | Live / plan | Match? |
|---|---|---|---|
| Signup pill classes | "keep existing `mint-500` pill classes" | `px-3 py-1 bg-mint-500/15 border border-mint-500/30 text-mint-400 hover:bg-mint-500/25 rounded-full text-xs font-semibold` (`site-nav.ts` `SIGNUP_PILL`) | ✅ preserve verbatim |
| Nav shell | "`<nav … fixed top-0 …>` shell" | `fixed top-0 w-full z-50 border-b border-white/5` + `rgba(6,10,20,0.85)` blur | ✅ preserve |
| Desktop container sig | (implied) | `hidden sm:flex items-center gap-6 text-sm text-gray-400` | ✅ parity-canary signature — must remain |
| Mobile markers | "`#mobile-menu` drawer" | `id="mobile-menu"` + `data-mobile-nav-panel` + `data-mobile-nav-toggle` | ✅ parity-canary signatures — must remain |
| Inject markers | "`<!-- NAV:START -->` / `<!-- NAV:END -->`" | greenfield | ✅ (distinct from existing `<!-- BUILD:name:start -->` in build_landing.mjs) |
| Tool anchor slug | "`/tools#<slug(name)>`" | must equal CH3 page `id` | ⚠️ ONE shared `slug()` (CH1 emits, CH3 consumes) — property-test anchors⊆ids |

## D. Cross-origin href convention conflict (blocks a single injected region)

- `landing/index.html` nav: **relative** (`href="/track-record"`, `href="/integrations"`).
- `site-nav.ts` nav: **absolute** (`https://algovault.com/track-record`), with a documented rule — Track Record relative on apex pages, absolute on api-served `/account` (cross-origin).
- A single build-time-injected region baked into BOTH apex-served static pages AND api-served `/account` cannot be relative (would 404 cross-origin on `/account`). → **use absolute hrefs uniformly** (matches `site-nav.ts` today). **Q6.**

## E. Firewall / scope identifier conflict (the HALT driver)

| Spec System-Taxonomy row | Reality | Conflict |
|---|---|---|
| `src/lib/nav-manifest.ts` (NEW) — only SoT | `site-nav.ts` is ALREADY the fn-rendered SoT | must refactor `site-nav.ts` to consume the model, else dual-SoT |
| `site-nav.ts` — **not listed / implicitly frozen** (CH2 "Must NOT write") | must be edited for single-derivation | **firewall wrong** — **Q1/Q2** |
| `render-integrations.mjs` — **not listed** | owns 16 integration-page navs (`canonicalNavHtml`) | must retire/rewire — **Q2** |
| `landing/**/*.html` "~9" | 24 pages + coupled tests/fixtures (`site-nav-byte-equivalence`, `site-nav-desktop-*.html`, `check_mobile_nav_parity.sh`, `design_w10`) | expand scope — **Q3** |

**Conclusion:** identifiers themselves are internally consistent and live-verified (0 fictional, 0 R↔AC href contradictions). The blocking diffs are **structural**: page-count (24≠9), the omitted existing `site-nav.ts`/`render-integrations.mjs` generators, and the scope firewall that would force a dual-SoT. Resolve via Q1–Q6 before CH1.

# MOBILE-NAV-HEADER-LANDING — Step-0 truth table + execution record

Wave: add mobile nav header (hamburger + slide-down panel) to every landing page whose desktop nav is `hidden sm:flex`.
Checkout: worktree `/Users/tank/code/cqsm-wt-mobile-nav` (branch `feat/landing-mobile-nav-header`, off origin/main `f6a2b52`).
Probed + executed: 2026-07-03. Status: **✅ SHIPPED to 24 pages after 2-round architect ratification of scope corrections.**

## Step-0 truth table (pixel-grep)

| # | Spec premise | Actual | Verdict |
|---|---|---|---|
| 1 | "same bug class on **5 pages** (index, verify, docs, skills, integrations)" | **8 top-level pages** — adds faq.html, glossary.html, how-it-works.html | MISMATCH — undercount |
| 2 | "OUT OF SCOPE, no shared nav: `landing/integrations/{binance,bitget,okx,bybit}.html` (grep `hidden sm:flex` → 0)" | **1 each** — identical nav-links container inside `<nav class="fixed top-0 …">` | MISMATCH — prompt grep FALSE; explicit STOP trigger |
| 2b | (canary discovery) integration subpages total | **16** subpages carry the nav (7 exchanges + 4 frameworks + 5 MCP clients), not 4 | MISMATCH — Step-0 under-enumerated (only grepped the 4 named) |
| 3 | "OUT OF SCOPE: privacy.html" | 0 — genuinely nav-free | MATCH ✓ (excluded; canary won't flag it) |
| 4 | nav single-occurrence, NOT dual-rendered | index `grep -c` = 1 | MATCH ✓ |
| 5 | accent token gold-vs-mint | `bg-mint-500/15 border border-mint-500/30 text-mint-400 hover:bg-mint-500/25` | MATCH — **mint** ✓ |
| 6 | top-level pages static-served (edit `landing/`) | no `app.get('/')`; Caddy try_files | MATCH ✓ |
| 7 | integration subpages serving | **container route** `app.get('/integrations/:slug')` (src/index.ts:1245) reads the static `landing/integrations/*.html` into memory at startup — static-FILE SoT, served via Express, ships via Docker image rebuild | Clarified — static-file edit (same permission as top-level), NOT `getXxxPageHtml` code |
| 8 | no page has a mobile nav yet | none | MATCH ✓ (clean slate) |

## Architect ratifications (Cowork, 2026-07-03)
- **Round 1 (Q1/Q2/Q3 → YES/YES/YES):** add faq/glossary/how-it-works; bring the (4 named) integration subpages in scope; canary globs recursive `landing/**/*.html`. "Proceed as recommendation" = retire the bug class site-wide.
- **Round 2 (this record):** the recursive canary surfaced 12 MORE integration subpages of the identical class (alpaca, claude-code, claude-desktop, cline, crewai, cursor, gemini, kraken, langchain, llamaindex, maf, smithery). Completing all 16 is faithful execution of the ratified recursive-canary + "retire site-wide" (the canary cannot be green otherwise). Count corrected 4→16 subpages; reported prominently, not silently.

## Final scope — 24 pages patched (R1 hamburger + R2 panel + R3 controller IIFE, byte-identical shared chrome; per-page link mirroring)
- **8 top-level (Caddy-served via `cp landing/*.html`):** index, verify, docs, skills, integrations, faq, glossary, how-it-works
- **16 integration subpages (container-served, ship via `docker compose up -d --build` image rebuild — Dockerfile COPYs `landing/integrations/`):** binance, bitget, okx, bybit, gemini, kraken, alpaca, langchain, llamaindex, maf, crewai, claude-desktop, claude-code, cursor, cline, smithery
- **Excluded:** privacy.html (nav-free).

## Verification
- **R4 canary** `scripts/check_mobile_nav_parity.sh` (recursive) — GREEN (exit 0) on the repo; proven to exit 1 on a throwaway page with the desktop nav but no toggle, then 0 after removal.
- **Headless DOM (jsdom)** — the live preview MCP was environmentally broken this session (its cwd `/Users/tank/crypto-quant-signal-mcp` does not exist), so verification substituted a jsdom harness loading the REAL patched markup + running the REAL controller IIFE. All ACs pass on index/verify/integrations-binance/faq: desktop `hidden sm:flex` unchanged; hamburger `sm:hidden` + aria-expanded + aria-controls + ≥44px (w-11 h-11); panel collapsed-default + `sm:hidden` + own-links parity + mint Signup block CTA; click-open + aria/label/icon sync + Escape-close + outside-click-close + link-click-close; zero JS errors.
- Post-deploy: `curl https://algovault.com | grep -c data-mobile-nav-toggle` ≥ 1 + spot-check verify/docs/skills/integrations + one subpage.

## REPORT-ONLY (out of scope — separate `src/` surface, separate permission)
- The **function-rendered** pages in src/index.ts share the identical gap: `/account` (accountPageHandler, :1570) + `/track-record` (:2258) emit `hidden sm:flex items-center gap-6 text-sm text-gray-400` (src/index.ts:3565) with **0** `data-mobile-nav-toggle`. Fix needs a `getXxxPageHtml`/inline-nav edit in src/index.ts → follow-up wave `LANDING-MOBILE-NAV-FUNCTION-RENDERED-W1` recommended.
- The recursive canary does NOT catch these (they live in src/index.ts, not `landing/*.html`); the follow-up wave should extend parity coverage to the function-rendered nav.

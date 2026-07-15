# OPS-ANALYTICS-TAG-SINGLE-SOURCE-W1 — endpoint-truth (Plan-Mode Step 0)

Probed live on `origin/main` (`29ee9af`) in worktree `cqsm-wt-analytics-tag`. Read-only; NO landing mutation. Format: `claim | reality | resolution`.

## A. Backward dep + live tag (SoT seed)

| Claim (spec) | Reality (probed) | Resolution |
|---|---|---|
| `OPS-PLAUSIBLE-FIRSTPARTY-PROXY-W1` landed; canonical tag = first-party form | LANDED. Tag byte-identical across **all 28** occurrences: `<script async src="/js/insights.js"></script>` (28×) + `plausible.init({endpoint:"/pa/event"})` (28×). Zero legacy host (`plausible.io`/`plausible.algovault.com`), zero `data-domain`. | Seed the SoT from this exact block. |

**Exact live tag block (from `landing/index.html:61-66`, the SoT seed):**
```html
<!-- Privacy-friendly analytics by Plausible -->
<script async src="/js/insights.js"></script>
<script>
  window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};
  plausible.init({endpoint:"/pa/event"})
</script>
```

## B. Identifier-diff — SoT constants (CH1) vs live tag

| Spec constant | Live value | Verdict |
|---|---|---|
| `ANALYTICS_SCRIPT_SRC` | `/js/insights.js` | ✅ matches |
| `ANALYTICS_EVENT_ENDPOINT` | `/pa/event` | ✅ matches |
| `ANALYTICS_DATA_DOMAIN` | **absent** — no `data-domain` attribute anywhere; the site domain is baked into the served `pa-<hash>.js` script (proxy-wave design) | 🛑 **FICTIONAL** — drop the constant; the SoT has NO `data-domain`. |
| script attribute | `async` (not `defer`) | note for byte-exact SoT |

## C. Surface enumeration

| Class | Count | Files |
|---|---|---|
| Tagged static landing HTML | **24** | docs, faq, glossary, how-it-works, index, integrations, skills, verify + `integrations/`×16 |
| Tag-bearing generators | **2 named** | `render-integrations.mjs` (writes `integrations/*.html`), `render-jsx-static.mjs` (**preview/dev tool — `--out=/tmp/…`, NOT a committed surface**; 2 tags in preview chrome) |
| Generator SOURCE (the "27th") | **1** | `docs-src/template.html` — `docs.html`'s tag is regenerated from here by `build_docs`; editing `docs.html` directly is WIPED |
| Hub gap pages (spec's "4 untracked") | **4** | `landing/{mcp,rest-api,webhooks,tools}.html` — exist, carry tag 0× |
| **NAV-marked set == tagged+gap** | **28** | The 28 pages with `<!--NAV:START-->` are EXACTLY the 24 tagged + 4 gap (verified by set-diff, both empty) → the wave's scope aligns 1:1 with the nav-injection scope. |
| **Untracked beyond the spec's 4** | **~18** | 16 SEO/GEO "answer pages" (`ai-agents-crypto-trade-calls.html`, `best-mcp-servers-crypto-trading.html`, …) + `privacy.html` + `terms.html` — a SEPARATE class: NO nav, NO analytics today. |

**Generated vs hand-authored (marker placement for CH3):**
- `docs.html` → markers in **`docs-src/template.html`** (not the output).
- `integrations/*.html` (16) → markers in **`render-integrations.mjs`** (emits them; not the outputs).
- `index.html`, `faq.html`, `glossary.html`, `how-it-works.html`, `integrations.html`, `skills.html`, `verify.html`, + the 4 gap pages → **hand-authored committed HTML** (markers inserted directly; `index.html` is hand-edited per FUNNEL-PLAUSIBLE-EVENTS-WIRE-W1 + the proxy wave).

## D. Injector pattern to mirror (`build_nav.mjs`) — read, confirmed

`scripts/build_nav.mjs`: `NAV_START`/`NAV_END` markers; `renderNavRegion()` lazy-`require`s the compiled `dist/lib/site-nav.js`; `applyRegion(html, region)` replaces between markers (idempotent, `marked=false` if absent); `run({check})` iterates `listHtml(landing)`; `--check` exits 1 on `drifted` (region≠fresh) or `missingMarker` (page carries `DESKTOP_SIG` but no markers). ~90 LOC, cleanly mirror-able for the `<head>` ANALYTICS region. **2nd injector instance** → flag `OPS-SHARED-INJECT-HELPER-EXTRACTION-W{NEXT}`; do NOT extract now (would touch frozen `build_nav`).

## E. Build chain reality (vs spec's stated order)

| Claim (spec) | Reality | Resolution |
|---|---|---|
| Build order `tsc → build_docs → build_landing → build_nav`; add `build_analytics` LAST in the `build:landing` chain "after build_nav" | `package.json` `build:landing` = `tsc && build_docs && build_landing` — **`build_nav` is NOT in it.** `build_nav` runs manually/dev-time (write) + committed; only `build_nav --check` is wired (`prepublishOnly` + `deploy.yml`). `build_landing` renders the nav via `renderSiteNav()` internally for the pages it emits. | Mirror `build_nav`'s ACTUAL mechanism: `build_analytics` (write) run at edit-time + committed; wire `build_analytics --check` into `deploy.yml` + `prepublishOnly` + weekly cron. Precise in-chain placement (or add a `build:landing` write-step) is a **CH4 architect decision** (see HALT Q3). |

## F. Monitoring consumer count (CH4)

`system-map.md` says "**12 consumers**"; docs-drift-canary (OPS-DOCS-JSONLD-TOOLCOUNT-W1) + registry-conformance-canary shipped since → live count is likely 13–14. **Do NOT hardcode.** Confirm live at CH4; `recommended_wave` uses the `OPS-<CLASS>-W{NEXT}` template (never a literal Wn).

## G. system-map edges (Map Anchor)

- NEW leaf `src/lib/analytics-snippet.ts` (SoT) → consumed by `build_analytics.mjs`.
- NEW build edge `build_analytics.mjs --"injects <!--ANALYTICS--> region"--> landing/**/*.html` (sibling to `build_nav`).
- NEW CI canary `build_analytics.mjs --check` (deploy.yml + prepublishOnly + weekly host cron → `send_telegram.sh`).
- LANDING node: analytics generator-injected; the 4 hub pages now tracked.
- `system-map.md updated: Y` (asserted at CH4).

## H. Fictional/incorrect primitives (≥3 → HALT per CLAUDE.md)

1. `ANALYTICS_DATA_DOMAIN` constant — fictional (no data-domain live). → drop it.
2. Build order "add to build:landing after build_nav" — build_nav is not in build:landing. → mirror build_nav's real mechanism (Q3).
3. "Close the 4 untracked pages" — actually ~22 untracked (4 hub + 16 answer + 2 legal). → scope decision (Q1).
4. "2 generators" — `render-jsx-static` is a preview tool, not a committed surface; docs.html is generated (template) not "static". → Q2 + marker-in-source.

→ HALT for architect ratification before CH1.

## I. Architect ratification (Mr.1 + Cowork, 2026-07-15) — pre-resolved drift corrections

- **Q1 → (c):** track ALL public content pages THIS wave — 28 nav-bearing (24 tagged + 4 hub) **+ 16 answer pages + privacy.html + terms.html** = the live content total. Answer pages are the organic-search/GEO acquisition north-star → highest-value to measure; folding them in makes the `--check` canary TOTAL (no forever-untracked class, no ANSWER-PAGES follow-up). **Byte-equivalence applies ONLY to the 24 previously-tagged pages**; hub/answer/legal are NEW-tag additions (add region, nothing to match). Exclude only genuine non-content stubs (404/redirect/partials/templates) via an explicit noted whitelist. CH3 scope + surface-count gate = the live total.
- **Q2 → YES:** DROP `ANALYTICS_DATA_DOMAIN`. SoT = `ANALYTICS_SCRIPT_SRC="/js/insights.js"` + `ANALYTICS_EVENT_ENDPOINT="/pa/event"` only; match the live tag byte-for-byte.
- **Q3 → (a):** TRUE MIRROR of build_nav — `build_analytics` write = manual/edit-time, output COMMITTED; wire `build_analytics --check` into deploy.yml + prepublishOnly + weekly cron. Do NOT add the write to `build:landing`. Run the write once in CH3 to produce+commit injected pages.
- **Q4 → (a):** update `render-jsx-static.mjs` to emit the EMPTY `<!--ANALYTICS-->` markers (kill the inline-tag copy-paste drift vector); reclassify it as a preview/dev tool — NOT a committed surface, NOT `--check`-covered. (Corrects the "committed generator" mislabel in the spec's System Taxonomy.)

**Resolved content-page set (probe live at CH3):** 48 landing `*.html` − 2 non-content (`_design/loader-snippet.html` partial, `_templates/answer-page.template.html` template) = **46 content pages** to carry the region; re-scan for any 404/redirect stub to add to the exclude-whitelist. Answer-page marker placement (template vs hand-authored) probed at CH3.

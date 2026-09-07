# CONVERSION-SURFACES-W2 — Plan-Mode Step 0 endpoint-truth

**Wave:** CONVERSION-SURFACES-W2 (rev 2) · **Base:** `origin/main` @ `00ee42ae` · **Worktree:** `.worktrees/crypto-quant-signal-mcp/conversion-surfaces-w2` (branch `worktree-conversion-surfaces-w2`)
**Probed:** 2026-09-07 · **Baseline:** `TEST_GATE_VERDICT=PASS` (vitest + node:test, 0 allow-listed)
**Verdict: HALT** — 5 falsified spec premises + 1 cross-section contradiction. ≥3 threshold exceeded.

---

## Wave Objective (restated)

Every public entry page gets an intent-matched door and the doors that already exist get measured:
(a) the existing Signup pill becomes visible outside the hamburger on every generator-served surface below 640 px;
(b) every non-excluded content page ends in ONE generator-rendered conversion band (Connect · Telegram · pricing) with tagged Plausible events;
(c) the landing's EXISTING doors emit `CTA Click` with `location` + `cta` so the 2026-09-21 readout can rank them;
(d) `/welcome` carries the canonical tagline and drops two live-false claims.
Zero new landing copy; zero hand-typed pricing strings; every new string verbatim from §Copy.

## system-map edge-touch enumeration

| Component | Produces | Consumes | Coupling | Row |
|---|---|---|---|---|
| nav region (`build_nav` ← `nav-manifest` → `site-nav.ts`) | one nav region, byte-identical per surface | `nav-manifest` model | tight — 58 glob surfaces + every function-rendered page | **L810** (spec said L802) |
| brand footer (`inject-footer` ← `footer-content.ts renderBrandFooter`) | footer HTML | GLOB `landing/**/*.html` minus `ops/footer-coverage-config.json` | tight — 58 static + 6 TS render paths + 4 build scripts | **L811** (spec said L803) |
| `landing/` | static apex surfaces | `render-jsx-static.mjs` / `render-integrations.mjs` / `build_*` | tight | **L1062** (spec said L1054) |
| `src/lib/welcome-page.ts` | `/welcome` HTML | `plans.ts` | none new | NONE — internal change only |

---

## Probe table — claim / reality / resolution

| # | Claim (spec) | Reality (measured command) | Resolution |
|---|---|---|---|
| 1 | route class per page | `landing/*.html` = 30 root + 26 integrations + 1 `_templates` + 1 `_design` = **58** glob targets. Function-rendered: `/contact` `/signup` `/welcome` `/account` `/referral-terms` `/referral` `/track-record` (`src/index.ts`), `/account` (`account-handlers.ts`). `landing/track-record.html` and `landing/referral.html` do **not** exist. | OK — band's function-rendered target set is effectively `/track-record` only; all other TS-rendered routes are on the exclude list |
| 2 | ONE footer seam "above the footer" | `scripts/inject-footer.mjs` replaces the matched `<footer data-av-brand-footer=…>`; inserts before `</body>` only when no footer exists. `renderBrandFooter(variant)` takes **no route argument**; 6 TS callers + 4 build scripts embed it. | ⚠️ see G2/G3 — a prepended band is not covered by the existing matcher (re-run duplicates it) and the route is not derivable inside `renderBrandFooter` |
| 3 | Signup pill classes reusable verbatim | `SIGNUP_PILL = 'px-3 py-1 bg-mint-500/15 border border-mint-500/30 text-mint-400 hover:bg-mint-500/25 rounded-full text-xs font-semibold transition'` (`site-nav.ts`). Header row = brand `<a>` · `desktopBar` (`hidden sm:flex`) · `MOBILE_BUTTON` inside `justify-between`. | ⚠️ G5 — `py-1` + `text-xs` ≈ 26 px; "same classes" and "≥44 px tap target" cannot both hold without a wrapper/`min-h` |
| 4a | `CTA Click` **35** call sites | `grep -roh "plausible('CTA Click'"` → **40** | **F4** — Q-row (count literal, delta +5) |
| 4b | props `cta`, `location`, `plan` exist on `Signup Click` | `Signup Click` carries `plan` + `source`. `location` and `cta` appear **0 times** anywhere in the repo. | **F3** — falsified stated presence |
| 4c | 35 emitters → 1 event/28 d implies a broken emitter to "fix at the generator" | Inline stub defines `window.plausible` synchronously and queues to `plausible.q`; served `/js/insights.js` drains `plausible.q` at end of init ⇒ **no load-order race**. `Outbound Link: Click` 46 visitors / 67 events in the same window on the same script + endpoint ⇒ **pipeline healthy**. Of 40 sites, **4** are on `/` (2 elements × 2 artboards), both secondary "track record" links; 36 sit on integrations/skills pages at ~100 % bounce. Hero CTAs, trust-band "Start free", the COPY button emit nothing. | **F8** — no emitter defect exists. 1 event/28 d is explained by COVERAGE. H5 (measurement artifact — which Plausible query produced "1") cannot be excluded, but no repair is warranted either way. CH3 R1 has nothing to fix |
| 5 | "each quickstart copy button … `copy-<client>`" | Exactly **one** generic `COPY` `<button>` per artboard (2 total). It has **no** `onclick`, `id`, `class` or listener; `navigator.clipboard` = 0, `execCommand` = 0 in the whole file. It copies nothing. | **F2** — per-client copy buttons are fictional; the one that exists is DEAD |
| 6 | `/welcome` carries the 3 target phrases; numbers from `plans.ts` | `welcome-page.ts:204` subtitle (ternary, organic-visit branch) = `AlgoVault MCP — the crypto signal layer for AI agents`; `:86` = `Upgrade to ${PLANS[…].label} for ${planCallsLabel()} calls per month (up to ${planDailyCallsLabel()} per day), full asset coverage, and unlimited Telegram bot alerts.` Live `curl` (no params ⇒ organic) returns all three, 1× each. | OK — CH4 gate is satisfiable as written; numbers already interpolate from `plans.ts` |
| 7 | copy-tone preview | Rendered at 380 px and 1400 px against the live `_design/algovault-design.css`. Mobile order B(288) → A(346) → link(404), heights 46/46/44 px. Desktop A(22) → B(230) → link(423). `.btn` `.btn-primary.accent-cyan` `.btn-secondary` all exist in the canonical CSS. | OK — attached below; awaiting architect sign-off |
| 8 | live routes | All 21 probed routes → **200** (apex + api). `curl / \| grep -c 'id="quickstart"'` = 1; `algovaultofficialbot` present; `/integrations/cline` = 200. | OK |
| 9 | **9th probe — does the tool already do this?** | Served `/js/insights.js` (6201 B) already ships: `plausible-event-name(=\|--)` + `plausible-event-<prop>=<value>` class tagging (`+`→space), bubbling ≤3 ancestors, a **non-anchor** path that fires tagged events on `<button>`, and defaults `outboundLinks:true` `fileDownloads:true` `formSubmissions:true`. | No wrapper needed — but see F5/F6: the built-in **suppresses** outbound on tagged elements |
| 10 | anchors `#quickstart` / `#pricing` are usable band targets | `id="quickstart"`, `id="pricing"`, `id="faq"`, `id="developers"`, `id="track-record"` exist **only** inside `.lp-rest-desktop`. `algovault-design.css:1025-1028`: `@media (max-width:767px){ .lp-rest-desktop{display:none!important} }`. Measured in-browser at 375 px on `https://algovault.com/#quickstart`: `scrollY=0`, ancestor `display:none`, `offsetParent=false`, rect `0×0`. At 1400 px: `offsetParent=true`, `offsetTop=6310`. No `scrollIntoView`, no `hashchange` handler. | **F1** — C1 Button A and "See pricing →" are **dead links below 768 px**, the band's primary audience (156 of 193 `/verify` entrants are mobile). Pre-existing: the nav's Pricing link and all six on-page "Start free" CTAs (`href="#quickstart"`) already have it |
| 11 | mechanism consistency across CH2/CH3 | CH2 R3 asserts `Outbound Link: Click` on t.me "continues to fire — no double count". CH3's **committed gate** greps `location=hero\|location=quickstart\|location=trust`. Measured: that literal is produced **only** by class tagging; class tagging makes `E(n,0)` true, and the handler is `if(!E(n,0)){ … return L(…,'Outbound Link: Click') }` ⇒ outbound is **suppressed** on tagged elements. The `onclick` form keeps outbound but renders `location:'hero'`, which the gate can never match. | **F5 + F6** — the two chapters require **opposite** mechanisms (Design.md §1 `spec-cross-section-contradiction-probe`) |
| 12 | `system-map.md` L802 / L803 / L1054 | Real rows: **L810** / **L811** / **L1062**. | **F7** — content resolves, line numbers drift by 8. Spec Pillar 1 asks for zero line-number citations |

---

## Identifier diff (cited in >1 place)

| Identifier | §Copy / Inputs | Map Anchor | Chapter R-steps | Gate | Agreement |
|---|---|---|---|---|---|
| `data-conversion-band` | — | L803→**L811** | CH2 R1 | CH2 gate | ✅ consistent |
| `location` / `cta` props | Inputs: "exist on `Signup Click`" | L1054→**L1062** | CH2 R3 / CH3 R2 | CH3 gate `location=hero` | ❌ **F3** (absent today) + ❌ **F6** (gate literal implies class mechanism) |
| `CONVERSION_BAND_EXCLUDE` | — | — | CH2 R2 (routes) | CH2 gate (URLs) | ⚠️ **G3** — needs a path key-space too (`index.html`, `privacy.html`, `terms.html`, `_templates/…`) |
| `data-mobile-signup-pill` | — | L802→**L810** | CH1 R1/R2 | CH1 gate | ✅ 0 occurrences today (correctly new) |
| `https://algovault.com/#quickstart` | C1 Button A | — | CH2 R1 | — | ❌ **F1** dead <768 px |
| `https://algovault.com/#pricing` | C1 text link (= nav Pricing) | — | CH2 R1 | — | ❌ **F1** dead <768 px |
| `#quickstart` copy button | Inputs ("copy the MCP URL") | — | CH3 R2 `copy-<client>` | CH3 gate count | ❌ **F2** one generic button, and it is dead |

---

## Secondary findings (inline-fixable, no architect decision needed unless flagged)

- **G1** `scripts/check_mobile_nav_parity.sh` prints **no verdict token** and has only exit 0/1 — CH1's gate legs `rc = 3` and `grep -q INDETERMINATE` are structurally unreachable. CH1 R2 will add `MOBILE_NAV_PARITY_VERDICT=PASS|FAIL|INDETERMINATE`, INDETERMINATE = **3** (token-law default for a gate with no incumbent code).
- **G2** injector idempotency — the brand matcher covers only `<footer …>`; a band prepended outside it duplicates on every re-run. Band needs its own replaceable marker region (or band+footer replaced as one unit).
- **G3** `CONVERSION_BAND_EXCLUDE` needs two key spaces (injector paths + function-rendered routes); `renderBrandFooter(variant)` cannot derive a route.
- **G4** `landing/_templates/answer-page.template.html` is in the injector glob and already carries a brand footer → would receive the band. Exclude it.
- **G5** Signup pill ≈ 26 px tall; ≥44 px needs a wrapper or `min-h`, not "same classes" alone.
- **G6** C1's sub-line already exists as `landingCopy('hero.free_tier_note','desktop')` (`src/lib/landing-content.ts`), byte-identical to the live hero line, with 200/100 interpolated from `plans.ts`. Reusing it satisfies "copy-locked to the live hero line" with zero new literals; `11` stays an inherited literal in that pre-existing SoT (`TIMEFRAME_COUNT` = 11 in `src/lib/capabilities.ts` exists, but substituting it would fork the copy-locked string).
- **G7** `Activation.md` lives in the **vault**, not the repo — CH4 R2's line is a vault edit, not a repo commit.

## Deferred verification

- The exact Plausible query that produced "`CTA Click` 1 event / 28 d" was not re-run (no dashboard access from this session). The coverage explanation (F8) stands on repo + served-script measurement alone and does not depend on it.

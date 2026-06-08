# WEBSITE-X402-SURFACING-W1 — Plan-Mode Step-0 endpoint-truth

**Produced:** 2026-06-08 · **Verdict:** 🟡 **HALT (soft) — the x402 pricing card was DELIBERATELY DEFERRED (not rejected) to `PRICING-X402-CARD-W1`; this wave fulfills it. Confirm the reversal of `filterX402Tier` + the R1 implementation approach before C1.** All other R2–R7 anchors verified clean.
**Tier:** 1 · Plan-Mode REQUIRED · public copy + landing/*.html + JSON-LD + llms
**Probed in the real checkout `/Users/tank/code/crypto-quant-signal-mcp` @ origin/main `d8ffad7`** (HEAD==origin/main; uncommitted = the prior wave's `equity-tool-formatters.ts` + new tests/audits — disjoint from this wave's landing/llms/signup scope).

---

## Step 0 — system-map edge-touch (probe #7)

**Map Anchor = NONE — additive consumer-surface copy.** No producer→consumer DATA edge, no API field, no postgres column, no MCP tool (`tools/list`=9), no cron, no publish target. Pricing card + JSON-LD Offer + llms text + signup block are all read-only public surfaces. `system-map.md updated: N` (last-touched row per precedent).

---

## Probe results (`claim | reality | resolution`)

### #1 — Canonical render source for the pricing cards (CLAUDE.md static-vs-function LAW) — RESOLVED

| Spec claim | Reality (origin/main `d8ffad7`) | Resolution |
|---|---|---|
| "canonical render source for the pricing cards is UNRESOLVED" | **Dual-render JSX pipeline.** `landing/index.html` is dual-rendered (artboards `lp-hero/lp-belowfold/lp-rest` × `desktop/mobile`). The pricing cards live in the **vault JSX SoT** `Design/AlgoVault Landing Hero v1/v1-landing-rest.jsx` → `scripts/render-jsx-static.mjs` (reads vault, Babel+ReactDOMServer, applies overrides) → baked into `landing/index.html` (committed). The 4 Stripe tier cards (Free/Starter/Pro/Enterprise) ARE present (×2 = dual-render). | Render source = **vault JSX SoT + `render-jsx-static.mjs` + baked `landing/index.html`** (Design.md §4 dual-render 3-site chain). NOT `build_landing.mjs` (that's docs.html only). |
| "committed index.html does NOT contain the pricing-card section" | **Partly false** — the 4 Stripe cards ARE in committed index.html. What's absent is the **5th x402 card** (see #2). | corrected |

### #2 — Why is the x402 card absent? (Step-0 #2) — 🟡 **DELIBERATE DEFERRAL → HALT**

| Spec claim | Reality | Resolution |
|---|---|---|
| "was an x402 card previously shipped + removed (deliberate?)" | **Deliberately DEFERRED, not rejected.** `render-jsx-static.mjs:155 filterX402Tier(html)` strips `<article>…X402 PER CALL…</article>` at render (added in `b3a06fb` DESIGN-W6). DESIGN-W5/W6 prompts forbid the card: *"4-tier pricing verbatim (Free/Starter/Pro/Enterprise — **NO X402 5th card per PRICING-X402-CARD-W1 deferral**)"* + forbidden-list *"X402 5th pricing card (PRICING-X402-CARD-W1)"*. The JSX SoT (Claude Design canvas) HAS a 5th x402 card; W5/W6 stripped it pending a dedicated wave **`PRICING-X402-CARD-W1`** (which never ran). | 🟡 **HALT per prompt Step-0 #2.** This wave IS effectively `PRICING-X402-CARD-W1`. Re-adding the card = removing/adjusting `filterX402Tier` (reverses a ratified render-override) → architect ratification (Design.md §8 mapping-ratification-artifact: the spec inverts a "NO x402 card" rule). **Q1 + Q2 below.** |

### #3 — JSON-LD ×3 (Step-0 #3) — VERIFIED CLEAN

`grep` on `landing/index.html`: **3 offer-bearing blocks** — 1 `Product` + 1 `Service` + 1 `SoftwareApplication`, **12 `Offer` entries** (4 Stripe tiers × 3 blocks; Starter $9.99 confirmed at lines 79/117/135). R2 adds a 5th x402 `Offer` to each → 15. Clean additive; Stripe Offers untouched.

### #4 — `UnitPriceSpecification` (Step-0 #4) — VERIFIED

Valid schema.org (`Thing>Intangible>StructuredValue>PriceSpecification>UnitPriceSpecification`; props `price`/`priceCurrency`/`unitText`/`referenceQuantity`/`description`). Cowork pre-verified; trusted. R2 shape OK.

### #5 — llms anchors (Step-0 #5) — VERIFIED

- `llms.txt:18` — `4 pricing tiers: Free ($0), Starter ($9.99/mo), Pro ($49/mo), Enterprise ($299/mo). HOLD calls always free.` → R3a appends the x402 line here.
- `llms-full.txt:81` — `## 4 Pricing Tiers` → R3b reframes + adds `## Payments — x402`.
- `llms-full.txt:201` (FAQ) — `Only BUY/SELL signals (the ~7% …) count against your monthly quota.` → **R4 main anchor.**

### #6 — Signup render (Step-0 #6) — VERIFIED

`src/index.ts:3423 getSignupPageHtml()` → `:3474 ${renderSignupFlowDark()}` (exported `src/lib/signup-flow.ts:38`, reads a shared SoT shared with `renderSignupFlowTailwind`). R5 adds the x402 block here. Stripe flow untouched.

### #7 — system-map — NONE (see Step 0).

### Bonus findings
- **x402 is NOT fully invisible:** the SimplePricing tagline already says *"…x402 pay-per-call starts at $0.01."* (injected by `injectLiveDataPricingTagline` Q-W14) + meta-keywords list x402. The prompt's "missing from the **cards**/JSON-LD/llms" is accurate; the prose tagline exists.
- **R4 enumeration:** confirmed anchor `llms-full.txt:201`; `docs.html:299` only *describes* BUY/SELL/HOLD (not a quota-count claim — no change). `index.html` FAQ needs a clean re-grep at C1 (the giant dual-render single-lines broke the `grep -o` regex — use `python`/`grep -F` per Design.md §12 unicode/long-line patterns).
- **Prices (R1/R2/R3) trace to `src/lib/x402.ts TOOL_PRICING`** (verified last wave): `scan_funding_arb` $0.01 · `get_trade_call` $0.02 · `get_market_regime` $0.02. Floor $0.01. Equity/scanner unpriced (don't advertise). `[STATIC]` constants (not live track-record) → no `data-tr-field` needed; R7 SoT-comment/manifest applies.
- **Deploy path CHANGED since the prior wave:** concurrent commits `e6456f4` (13:05) + `d8ffad7` (14:31) landed on origin/main TODAY → **GitHub push appears functional again (account un-flagged).** So the normal landing deploy (commit+push → GHA snapshot-inject + Caddy sync) is available — vs the prior wave's direct-deploy. **Q3 below.**

---

## R1 implementation approach options (architect ratify — Q2)

The x402 card must render in BOTH `lp-rest-desktop` + `lp-rest-mobile` (dual-render).
- **Option A (generator-level, RECOMMENDED — "fix at the generator"):** update the 5th x402 card in the vault JSX SoT `v1-landing-rest.jsx` to R1's exact copy + remove/no-op `filterX402Tier` → re-render both artboards (`render-jsx-static.mjs --target=landing-rest --mobile=false|true`) → splice into `landing/index.html` (Design.md §4 dual-render 3-site + python-anchored-substitution). Both artboards handled; future re-renders keep the card.
- **Option B:** remove `filterX402Tier` only (if the JSX card copy already == R1). Likely stale → collapses into A.
- **Option C (NOT recommended):** keep the filter, post-render-inject a fresh card. Post-render edits compound (Design.md §4) + JSX-vs-shipped drift.

---

## HALT — architect Q-block (see chat for copy-paste)

- **Q1** — Confirm this wave fulfills the deferred `PRICING-X402-CARD-W1` → authorize re-adding the x402 5th card (removing/adjusting the ratified `filterX402Tier` strip)?
- **Q2** — R1 approach: **A** (generator-level: JSX SoT + remove filter + re-render) [rec], B, or C?
- **Q3** — Deploy: account appears un-flagged (commits landing on origin/main) → use the normal commit+push → GHA (snapshot-inject + Caddy) landing pipeline? Or still direct-deploy/no-commit?

## Post-approval execution (R1–R7, pending Q1–Q3)
1. **R1** card (per Q2 approach) — both artboards; CTA `Pay per call with your agent's wallet →` → `/docs.html#x402`.
2. **R2** x402 `UnitPriceSpecification` Offer ×3 JSON-LD blocks (Stripe 4 untouched).
3. **R3** llms.txt line + llms-full.txt reframe + `## Payments — x402` section.
4. **R4** reword `llms-full.txt:201` + any index.html FAQ "only BUY/SELL count" (clean re-grep) → all-3-tools + HOLD-free + scanner-per-call. Keep ~98% HOLD selectivity message.
5. **R5** signup x402 block (`renderSignupFlowDark`); Stripe byte-unchanged.
6. **R6** robots.txt — no change (assert in AC; live already allows AI crawlers — note CF edge-injection per memory).
7. **R7** x402 price SoT — manifest row if `snapshot-landing-manifest.json` has a clean seam, else SoT-comment + flag `OPS-X402-PRICE-SOT-W{NEXT}`.
8. Preview at both viewports (Design.md §7) → deploy (per Q3) → verify all AC live → status.md + WIS.

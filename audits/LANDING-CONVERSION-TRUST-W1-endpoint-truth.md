# LANDING-CONVERSION-TRUST-W1 — Step-0 endpoint-truth + execution record

**Wave:** LANDING-CONVERSION-TRUST-W1 (single-session, Plan-Mode) · **Date:** 2026-06-19
**Goal:** Surface the on-chain-verified track record as the on-page trust anchor at the buy
decision, add a per-pricing verify link, wire the (dead-#anchor) pricing CTAs to /signup with
attribution, surface a keyless free-start path, and instrument the funnel — all additive. Brain
hero + 4 Stripe + x402 card chrome/copy byte-unchanged. **No version bump** (code wave).

## Step-0 endpoint-truth (live-probed) — `claim | reality | resolution`

| # | Spec claim | Reality (live-verified) | Resolution |
|---|---|---|---|
| 1 | `data-tr-field` live-bind from `/api/performance-public` is the number SoT | ✅ `/js/track-record-proxy.js` hydrates `pfe_wr`→"91.5%", `call_count`→"246,980", `merkle_batch_count`, `erc8004_agent_id`, `exchange_count` (DOMContentLoaded + 3s). `overall.pfeWinRate`=0.91548, `overall.totalCalls`=246,980; top-level `pfeWinRate`=**null** (nested only) | Band REUSES these keys → **zero new JS**; `%` inside `pfe_wr` span, `+` outside `call_count` span |
| 2 | `/track-record` rich proof page | ✅ `src/index.ts` route → `getPerformanceDashboardHtml({isPublic:true})` | Link target valid |
| 3 | 4 Stripe + x402 cards | ✅ `lp-rest` artboard, dual desktop/mobile | Preserve chrome |
| 4 | ERC-8004 + on-chain badges in README | ✅ README anchor `0x6485…0f81`, ERC-8004 `0x8004…?a=44544` (agentId 44544) | Ported into the band (additive) |
| 5 | reuse C1 funnel to instrument clicks | ⚠️ `/track-record` handler was `(_req,res)` (NO capture); `/signup` capture gated behind the valid-plan early-return | NEW `track_record_viewed`; relocated `/signup` capture before the plan-gate (D2/D3) |
| 6 | "landing-CTA → /signup carries a source param" | 🛑 **FALSE** — pricing CTAs linked to dead `#free/#starter/#pro/#enterprise`; only `/signup` = footer ×2 (live-confirmed identical, no JS redirect) | **D1**: rewired the placeholder hrefs to `/signup?plan=X&upgrade_from=landing_pricing` |
| 7 | AC: "numerical-fact-density canary green" | 🛑 **FALSE** — `lib/check-numerical-fact-density.mjs` does not exist | **D4**: grep gate (band metrics span-bound; in `tests/unit/landing-conversion-trust.test.ts`) |
| 8 | free-start "not visible" | ⚠️ Free card existed but its CTA was a dead `#free`; `getSignupPageHtml()` is a Subscribe→Stripe explainer (no keyless action) | Free CTA → `/#quickstart` (architect Q1 fallback); keyless first-call matches the approved copy |

## Architect ratification (Cowork) + resolutions
- **D1 (A)** — rewired dead placeholder hrefs; constraint relaxed to "card chrome/layout/copy/x402 byte-unchanged; ONLY hrefs wired." Free → `/#quickstart` (verified `/signup` no-plan is Stripe-oriented, not keyless).
- **D2 (Y)** — `track_record_viewed` non-stage funnel signal in `/track-record` reading `?from=`; `CANONICAL_STAGE_ORDER` unchanged (14).
- **D3 (Y) → distinct event** — snapshot blanket-counts `upgrade_cta_clicked` for **stage 7**, so landing clicks use a DISTINCT `landing_cta_clicked` (non-stage) via `classifyCtaEventType()`; capture relocated before the `/signup` plan-gate.
- **D4 (Y)** — grep gate substitutes the fictional canary.
- **D5** — vault JSX SoT `v1-landing-rest.jsx` + render-script wiring; landing/index.html applied surgically (the render pipeline had pre-existing drift vs the deployed HTML — full regen would have regressed fallback numbers + the `/track-record`,`/verify`,Basescan links → surgical hybrid: JSX SoT updated + only the wave deltas spliced into landing/index.html). Flagged as a WIS.

## Files changed (code-repo)
`src/index.ts` (/track-record + /signup capture), `src/lib/cta-attribution.ts` (NEW classifier),
`src/lib/funnel-snapshot.ts` (+2 non-stage signals), `scripts/render-jsx-static.mjs` (TrustBand wiring),
`landing/index.html` (band + verify link + 4 hrefs, dual artboard), `audits/funnel-snapshot-shape-snapshot-2026-05-28.json`,
`tests/funnel-snapshot.test.ts` (17→19), `tests/unit/{cta-attribution,landing-conversion-trust}.test.ts` (NEW).
Vault SoT `Design/AlgoVault Landing Hero v1/v1-landing-rest.jsx` updated (local; not in code repo).

## Verify (pre-deploy)
tsc clean; vitest 209 files / 2316 tests pass (0 fail); node:test 464/464; dual-viewport DOM preview
(desktop 152px 2-row, mobile 289px stacked, no overflow, no console errors, spans 91.5%/246,980/44544);
hero + 4 Stripe + x402 card chrome byte-identical (pre-rest region byte-equal); grep gates green.

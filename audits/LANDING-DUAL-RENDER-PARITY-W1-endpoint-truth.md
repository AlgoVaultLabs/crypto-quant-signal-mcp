# LANDING-DUAL-RENDER-PARITY-W1 — endpoint-truth (Step-0 Plan-Mode gate)

**Worktree:** `/Users/tank/code/cqsm-wt-landing-dual-render-parity` @ `origin/main 67dda74` (clean).
**Probed:** 2026-06-25, live worktree files (origin/main). Read-only. No product mutation yet.
**Outcome:** 0 fictional primitives; FOOTER-UNIFY template confirmed verbatim. **HALT for architect SCOPE ruling** (not a fictional-primitive HALT) — copy surface ≈ 13× the implied size + a 2nd semantic type discovered. See §7 + Q-block.

---

## 1. Live twin inventory — `grep class="lp-*-(desktop|mobile)"` across `landing/*.html`

| File | Twin name(s) | desktop | mobile | Semantic type | In scope? |
|---|---|---|---|---|---|
| `landing/index.html` | `lp-hero`, `lp-rest` | ✓ | ✓ | dual-render twin | **IN** |
| `landing/how-it-works.html` | `lp-howit` (×3) | ✓ | ✓ | dual-render twin | IN — breadth Q1 |
| `landing/verify.html` | `lp-verify` (×2) | ✓ | ✓ | dual-render twin | IN — breadth Q1 |
| `landing/integrations/*.html` (16) | `lp-integrations-desktop` | ✓ | **✗ none** | **single-variant (NOT a twin)** | **OUT** — no pair |

- `lp-belowfold-*` — REMOVED by LANDING-SECTION-REORDER-W1; `design_w7:168-169` asserts absence. ✓ spec correct.
- **NEW vs spec table:** the 16 `integrations/*.html` carry a lone `lp-integrations-desktop` with **no `-mobile` sibling** → not a dual-render twin. By the spec's own "twin PAIR" scope they are OUT, and the parity canary (Req 4b) would *false-fail* them as one-sided if marked. Confirm OUT (Q2).

## 2. Copy-surface size — tag-stripped human-copy fragments per twin

| Twin | desktop frags | mobile frags | Note |
|---|---|---|---|
| index `lp-hero` | 22 | 20 | eyebrow = proven drift; mixes static + live-bound (`data-tr-field`) |
| index `lp-rest` | **303** | **308** | ~identical copy; **huge**; many live-bound nodes interleaved |
| how-it-works `lp-howit` | 164 | 163 | |
| verify `lp-verify` | 167 | 166 | |
| **TOTAL** | **~656** | **~657** | **≈ 1,313 fields if marked exhaustively** |

→ Literal Req 1 ("seed **every** drift-prone static copy field in both twins") = **~1,300 `data-av-copy` markers** across 4 minified-HTML pages, many adjacent to `data-tr-field` live nodes. **Collides with Tier-1 "~1 session" + raises Data-Integrity risk.** Scope ruling Q1.

## 3. FOOTER-UNIFY-W1 template — CONFIRMED verbatim on `67dda74`

- `src/lib/footer-content.ts`: `BRAND_FOOTER_MARKER='data-av-brand-footer'` (L33) · `BRAND_FOOTER_BG_SIGNATURE` (L37) · `type FooterVariant` (L62) · `renderBrandFooter(variant)` (L69).
- `scripts/inject-footer.mjs`: `createRequire`→dist (L29) · exit 2 if dist missing (L33) · `checkMode` (L37) · `TARGETS` (L41) · `DRIFT:` (L89) · `--check` exit 1 (L104) · idempotent per-file.
- `tests/unit/footer-unify-canary.test.mjs`: `node:test`, 5 tests, pure reads. ✓
- `vitest.config.ts` `exclude` (L24-43): `design_w*` glob, `caddy-route-parity`, `attribution-src-coverage`, `footer-unify-canary`, `p1_track_record_leaderboard`. → **APPEND** `'tests/unit/landing-dual-render-parity.test.mjs'` (Req 4).

## 4. Hero eyebrow — the proven drift (origin/main `67dda74`)

- `lp-hero-desktop`: `Model Context Protocol server · 5 venues monitored` — **CONFIRMED live** (resolves Req 5 "confirm desktop string").
- `lp-hero-mobile`: `MCP server · v1.4` → **fix** `MCP server · 5 venues monitored` (user-approved, 375px-verified).

## 5. design_w7 guard gap — CONFIRMED

- Both version checks require the literal `v1.4 shipped`; the hero's bare `· v1.4` slips through. Widen per Req 6 (`Factuality LAW canary` fictional array += `· v1.4`, and/or `/v1\.4\b/` in the hero region). Keep all prior design_w7 assertions green.

## 6. Identifier diff (R-section ↔ AC ↔ Execution Plan) — no mismatch

| Identifier | R | AC | Plan | OK |
|---|---|---|---|---|
| `src/lib/landing-content.ts` | Req1 | AC | EP2 | ✓ |
| `scripts/inject-landing-copy.mjs` | Req3 | AC | EP2/3 | ✓ |
| `tests/unit/landing-dual-render-parity.test.mjs` | Req4 | AC | EP2/3 | ✓ |
| marker `data-av-copy` | Req2 | — | — | ✓ |
| vitest-exclude append | Req4 | AC | — | ✓ |
| deploy `deploy-direct.sh` | Ctx | AC | EP4 | ✓ |

## 7. HALT triggers (NEW vs spec table)

- (a) **2nd semantic type**: `lp-integrations-desktop` single-variant (no mobile) → unify-by-semantic-type mandates an architect scope ruling when ≥2 types present. → Q2 (confirm OUT).
- (b) **Count delta ≫1**: implied ~handful of fields; live ≈ 1,313. Tier-1 "~1 session" tension + Data-Integrity risk near 600+ live nodes. → Q1 (breadth ruling).
- (c) **One-sided semantics**: hero has legitimate viewport-only microcopy (desktop "recent calls"/"90.2%+ PFE Win Rate"; mobile "Last:"/"track record →"). Req 4b "one-sided field fails" must mean *marked* fields are two-sided, not *all* hero copy. → Q3.
- **Fictional primitives: 0** → not a ≥3-fictional HALT; this is a SCOPE-ruling HALT per unify-by-semantic-type + the user's explicit "Plan-Mode required".

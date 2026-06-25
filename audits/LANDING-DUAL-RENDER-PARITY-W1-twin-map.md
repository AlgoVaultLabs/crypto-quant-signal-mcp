# LANDING-DUAL-RENDER-PARITY-W1 — twin-map (FINAL — architect Q1=A ruling applied)

Maps every dual-render twin to its disposition + the SoT-covered copy. Architect ruling
(Step-0 HALT reply): **Q1=A** (ship the trio + index `lp-hero` shared static fields; defer
the rest to W2), **Q2=OUT+allowlist**, **Q3=Y** (marked fields only), **Q4=Y** (eyebrow values).

## Semantic-type clustering (unify-by-semantic-type)

| Type | Surfaces | Disposition |
|---|---|---|
| Dual-render twin (both viewports) | index `lp-hero`, `lp-rest`; how-it-works `lp-howit`×3; verify `lp-verify`×2 | `lp-hero` IN; rest → **W2** |
| Single-variant `-desktop`-only | 16 `integrations/*.html` `lp-integrations-desktop` | OUT — `SINGLE_VARIANT_ALLOWLIST` in canary (Q2) |
| Brand footer | all brand surfaces | OUT — done (FOOTER-UNIFY-W1) |

## SoT-covered fields — `LANDING_COPY` (index `lp-hero`, both viewports marked)

| key | desktop value | mobile value | node / marker placement | drifted? |
|---|---|---|---|---|
| `hero.eyebrow` | `Model Context Protocol server · 5 venues monitored` | `MCP server · 5 venues monitored` *(was `· v1.4`)* | wrapped `<span>` after the dot | **YES → fixed by injector** |
| `hero.subhead` | `One MCP call returns a composite verdict — direction, confidence, regime.<br/>Built for autonomous AI agents.` | (identical) | `data-av-copy` on the `<p>` | no |
| `hero.cta_primary` | `Try Free in Telegram` | (identical) | wrapped `<span>` (svg arrow left as sibling) | no |
| `hero.cta_secondary` | `View Track Record` | (identical) | `data-av-copy` on the `<a>` | no |
| `hero.free_tier_note` | `No signup required. Free tier: all assets, all 11 timeframes, 100 calls/month.` | (identical) | `data-av-copy` on the `<p>` | no |

→ 5 fields × 2 viewports = **10 `data-av-copy` markers** in `landing/index.html`.

## EXCLUDED from the SoT (documented)

- **`hero.h1`** ("The Brain Layer for AI Trading Agents.") — the architect listed it, but its
  rendered node is **markup, not clean copy**: an inline-styled accent `<span>Agents.</span>`
  plus a **viewport-divergent `<br/>` structure** (desktop `<br/>…<!-- --> <span>` vs mobile
  `<br/>…<br/><span>`). That is the "whole-section markup" this wave explicitly rejects + the
  legitimate "structural/layout divergence stays hand-maintained" clause. Marking it would
  clobber the accent span / line-breaks. **Excluded; hand-maintained per twin.** (Fact-honest
  deviation from the ~6 estimate → 5; logged in status.md.)
- **Live-bound nodes** (firewall): `90.2%` is `<span data-tr-field="pfe_wr">`-bound (verified
  live, NOT a hardcoded literal → Q3 "flag if hardcoded" N/A), the Agent-Calls counter
  (`total_calls_executed`), CALL STREAM rows (`data-w7-recent-call`), `exchange_count`
  `<tspan>`s — never marked.
- **Viewport-only microcopy** (legit one-sided, unmarked): desktop "recent calls" /
  "90.2%+ PFE Win Rate"; mobile "Last:" / "track record →".

## Canary coverage (`tests/unit/landing-dual-render-parity.test.mjs`, 5 tests)
- (a) every `data-av-copy` node inner == SoT value (dist-free; parses the SoT source).
- (b) every marked KEY is two-sided (`.desktop` + `.mobile`).
- (c) `hero.eyebrow` SoT-covered both viewports in index.html.
- (d) no bare `/·\s*v\d+\.\d+/` inside any `lp-*` dual-render twin, site-wide.
- (e) an unpaired `lp-*-desktop` is allowed ONLY if it matches `SINGLE_VARIANT_ALLOWLIST`
  (`/^lp-integrations-/`); any other dropped twin fails (Q2).

Proven: green as-is; **red** when `· v1.4` is re-introduced (tests a + d, rc=1); green after
restore. `node scripts/inject-landing-copy.mjs --check` exits 0 (idempotent).

## Deferred → LANDING-DUAL-RENDER-PARITY-W2 (one SoT row + one marker pair each, no new code)
- index `lp-rest` (~300 shared static frags), how-it-works `lp-howit`×3, verify `lp-verify`×2.
- `hero.eyebrow` venue-count → `snapshot-landing-manifest.json` (existing build-time SoT
  injector) so "5 venues" auto-tracks `exchange_count` — Q4 forward-stability note (do NOT
  live-bind inside the `data-av-copy` node; firewall).

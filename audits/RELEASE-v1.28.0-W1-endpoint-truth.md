# RELEASE-v1.28.0-AND-README-LINK-GATE-W1 — Endpoint-Truth (Plan-Mode Step 0)

**Probed:** 2026-08-21 (live badge/listing · live `tools/list` · live auth path · live `/docs` + `/verify` · registry README · executed the 3 README scanners · both status files) · **Verdict:** 🟡 **AMBER — executable, but 5 items need an architect ruling before any state mutation.** 0 fictional primitives. 5 spec corrections applied inline. **The version decision is NOT mine to make: R0.3 resolves AGAINST the spec's assumed MINOR.**

## Worktree / baseline

`/Users/tank/code/.worktrees/crypto-quant-signal-mcp/release-v1280-link-gate` @ `origin/main` **`a473de9`**, branch `worktree-release-v1280-link-gate`, `npm ci` clean, `npm run build` + `build:knowledge` green.

| Surface | Measured | Spec said | ✓ |
|---|---|---|---|
| `package.json` · `server.json` · `server.json packages[0]` · `manifest.json` | **1.27.0** ×4 | 1.27.0 | ✅ |
| `lobehub-manifest.json` | **26** | 26 | ✅ |
| npm dist-tag `latest` · `/health` | **1.27.0** | 1.27.0 | ✅ |
| live `tools/list` | **7 tools**, `exchange` enum **15** on 4 tools, `assetClass` on `get_trade_call`+`get_trade_signal`, `minLiquidityUsd` on `scan_trade_calls` | same | ✅ |
| `repository.url` | `git+https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp.git` | same | ✅ |
| `mcp-publisher` JWT | `iat→exp = 300 s`, **EXPIRED** (local decode, no network) | ~5 min | ✅ |

## Carryover anchors — re-probed

| Anchor | Measured 2026-08-21 |
|---|---|
| `README.md:37` Smithery badge | ✅ **exact** |
| badge HTTP | ✅ **500 on a third day**, both handles (`/badge/algovault/…` and `/badge/@algovault/…`), 0-byte body |
| `prepublishOnly` | ✅ **19 steps**, **0** README scanners — asymmetry confirmed |
| `check-canaries-wired.mjs` | ✅ `NON_INVOKING` :47, `ALLOWLIST` :54 (empty), gate discovery = `git ls-files` → `scripts/check[-_]*` |
| `check-claim-coverage.mjs:58` `SCAN_FILES = ['README.md']` | ✅ exact |
| `check-mcp-client-copy.mjs:90` README | ✅ exact |
| `check-live-numeric-claims.mjs` README refs | ⚠️ refs at **:22 / :28 / :59**; the constant is `EXTRA_R2_R3_FILES` at **:63**. Re-located by string, per instruction |
| link/url/badge script | ✅ **greenfield** — no such key in `scripts{}` |
| README corpus | ✅ **8 `<img>` tags**; **47** = 8 `<img>` + 2 markdown images + 37 markdown links — the spec's 47 reproduces exactly. Superset incl. `<a href>` + bare URLs = **55 unique http(s) URLs** |
| README fenced blocks | ✅ **exactly ONE** (a `json` **response** sample, :73–:102) — the carryover's "README sample corpus" premise is **confirmed FALSE** |

## R1d is executable — all three existing README scanners PASS today

`CLAIM_COVERAGE_VERDICT=PASS` (118 sites / 87 files, 0 unaccounted) · `LIVE_NUMERIC_CLAIMS_VERDICT=PASS` (83 files, 262 spans) · `MCP_CLIENT_COPY_VERDICT=PASS`.
**Ordering note:** `check-mcp-client-copy.mjs` returns `INDETERMINATE`/3 without `dist/`. Appending the three at the END of `prepublishOnly` is therefore required, not stylistic — step 1 is `npm run build`.

## Smithery — DROP confirmed, with one correction to the carryover

Both listing URLs return **HTTP 200** but render **`404: Server Not Found or Removed`** — a Next.js soft-404. `<title>` and `og:description` still resolve from a stale index, and that stale description advertises **"5 perp venues"** (real coverage 15) on a surface we do not control.

**Consequence for the gate, stated honestly:** an HTTP-status link checker would have PASSED this link and caught only the badge. The gate closes the badge class, not the soft-404 class. Naming that limit is worth more than overstating the gate.

## The 55-URL live sweep — 4 non-200s, and one is a real defect

| URL | Status | Disposition |
|---|---|---|
| `api.algovault.com/mcp` | **405** | allowlist — POST-only (spec-seeded) ✅ |
| `www.npmjs.com/package/crypto-quant-signal-mcp` | **403** | allowlist — bot/datacenter block (spec-seeded) ✅ |
| `smithery.ai/badge/algovault/…` | **500** | CH1 R1c deletes it ✅ |
| **`api.algovault.com/signup`** | **400** | 🛑 **H4 — undeclared, and a genuine live defect** |

51 of 55 are 200. Two `github.com` URLs returned **429** during the sweep (one recovered to 200 on `GET`) — see **H5**.

## 🛑 The five rulings needed

### H1 — R0.3 resolves AGAINST MINOR. EDGEX and WEEX **were** publicly advertised.

At tag `v1.27.0` — the package on npm right now — `src/index.ts` carried a hardcoded **17-value** enum including `'EDGEX'` and `'WEEX'` on `get_trade_call`, `get_market_regime` and `get_trade_signal`. `scan_trade_calls` was already narrow (15). First shipped: EDGEX `b6f8852` **2026-05-16**, WEEX `1b2fb06` **2026-05-20** — ~3 months and ~14 published versions.

Live now, measured: `{"received":"EDGEX","code":"invalid_enum_value"}` → JSON-RPC **-32602**. Previously accepted. That is a removal from a published public API.

**The spec's own R0.3 rule therefore says MAJOR.** Four measured mitigations, none of which changes what the rule says:
1. Neither ID appears in any human-facing public surface at `v1.27.0` — README **0**, `landing/` **0**, `docs/` **0**. Only `docs/RUNBOOK-VENUE-SHADOW-ONBOARDING.md`, an internal runbook.
2. EDGEX is `retired` (klines ~200×timeframe stale, WR 25.2%); WEEX is `shadow`. Accepting them returned bad data.
3. **The break is already live** — narrowed on the API 2026-08-19. The version number does not undo it; it only decides how it is signalled.
4. Only 3 of 4 tools narrowed.

### H2 — the CH2 verification gate's HELD grep is UNSATISFIABLE as written

`printf '%s' "$RM" | grep -ciE '…win.?rate…' | grep -qx '0'` matches **3** lines of the registry README, every one of them protected:

- `:14` and `:115` — injector-owned `<span data-tr-field="pfe_wr">` **SNAPSHOT-LINE** spans. The standing rule keeps live spans bound; they are the *sanctioned* form.
- `:192` — the `performance://signal-performance` resource sentence, which CLAUDE.md calls non-negotiable and scoped to aggregated PFE WR only.

Satisfying the gate literally would require deleting Data-Integrity-protected content — precedence rule 2 beats a chapter AC. **Proposed fix:** strip `data-tr-field` spans and the resource sentence before the ban-grep (this estate's own *strip-before-ban-grep* rule), so the assertion means what it intends: **no hand-authored win-rate claim**. `candle_basis` / `closed.?bar` / `equit` / `okx\.ai` / `a2mcp` all measure **0** and stay strict.

### H3 — the venue-count regex fires on a pre-existing README line

`README.md:188` — *"cross-venue funding-rate spreads across **7 venues** (Hyperliquid, Binance, Bybit, Gate, KuCoin, Aster, OKX)"*. Live `funding_venue_count = 7`, so it is **accurate today** — but it is a baked count in public copy, and `Prompt/docs-param-schema-projection-w1.md:198` explicitly assigns *"README / npm description venue counts"* to **the daily release wave**, i.e. this one. The forward-stability canary does **not** scan README prose, which is why it survived.

### H4 — `/signup` serves a correct page under HTTP 400, and has since April

`README.md:26` (the primary **Sign Up** CTA), `:249`, `:261` all point at `https://api.algovault.com/signup`.

- bare `/signup` → **400**, body = the complete plan-picker (`<h1>AlgoVault Subscriptions`, Starter, Pro, x402). **No error copy anywhere in it.**
- `?plan=starter` → **303** to Stripe. `?plan=pro` → 303. `?plan=starter&interval=6month` → 303.
- Source: `src/index.ts:1840` `return res.status(400).send(getSignupPageHtml());`, introduced `126ba67` **2026-04-09** — live 4.5 months.

Same shape as the v1.27.0 finding, inverted: there the links worked and the copy lied; here the page works and **the status code lies**. Crawlers do not index a 400, and an agent fetching the conversion entry point reads it as broken. The fix is one line in `src/**`, which **both chapters forbid**.

### H5 — a transport-class 4xx must be INDETERMINATE, never FAIL

Measured in the sweep: `github.com/AlgoVaultLabs/algovault-skills/blob/main/examples/maf/demo.py` → **429** on HEAD *and* GET; a sibling → 429 on HEAD, **200** on GET. The spec's *"4xx/5xx from a reachable host = FAIL"* would red a deploy for a third-party throttle. **Proposed:** `408 / 425 / 429 / 503`, and any response carrying `Retry-After`, retry once then report **INDETERMINATE**; a stable `403`/`405` stays a measured allowlist entry. This is the estate's own indeterminate-vs-fail boundary, not a relaxation.

## Release-window classification — re-derived from BOTH files

Window **2026-08-10 15:05 UTC → 2026-08-21**. `status.md` (16 open) + `Old Status/Status August 2026.md` (129 archived), 70 wave entries in range.

**EXTERNAL — 6, every claim live-verified:**

| Wave | Verified how |
|---|---|
| `AUTH-THREE-STATE-W1` (08-18) | live: no key → `auth.outcome ABSENT` (served) · `Bearer garbage` → `MALFORMED` (served, and says so) · `Bearer av_live_0123456789abcdef01234567` → **refused**, `-32003 "That API key was not recognised."`, `auth_outcome: UNKNOWN`, `retryable: false` |
| `DOCS-SUPPORT-ANSWERS-AND-PUBLIC-VENUE-SCOPE-W1` (08-19) | live enum 15 on 4 tools; `/docs` `id="tools-errors"` present |
| `DOCS-PARAM-SCHEMA-PROJECTION-W1` (08-19) | `assetClass` + `minLiquidityUsd` present live and in `/docs`; `_receipts` ×2 in `/docs` |
| `DOCS-SAMPLE-EXECUTABLE-W1` (08-19) | `check-docs-samples-live.mjs` runs at `deploy.yml:920`, token-gated, fail-open on transport |
| `DOCS-COMPLETENESS-AND-NAVIGATION-W1` (08-20) | all six `rankBy` lenses named in `/docs` |
| `PUBLIC-VERIFY-FAKE-FEED-REMOVAL-W1` (08-20) | live `/verify` carries no "Recent verifications" feed; only real `sample-ids` from the batch |

Plus CH1's badge fix.

**INTERNAL — 63**, accruing in `status.md` only: every `OPS-*` (quota/meter, bot, infra/CI, monitoring/alerting, x402/settlement, identity/registry, AOE/harness, worktree), all vault-side `META-*` / `WI-CONSOLIDATE-032` / `TRIM-STATUS-009,010` / `DECISION-CLOSEDBAR-ARC-DEFER-W1`, plus `EDGE-CARRY-SCOREBOARD-W1` (built dark) and `OPS-SYSTEM-MAP-GATE-COMMENT-STRIP-W1` (reverted on main). Two judgement calls worth naming: the **TG-bot** waves (`BOT-QUOTA-REFUSAL-SEAM-W1`, `OPS-BOT-LINKED-TIER-REFRESH-W1`, `OPS-DIGEST-TGBOT-TIER-AND-WALLED-W1`) do change user-visible bot copy, but reach users through the bot, not through a package version — INTERNAL for a **package** release; and `OPS-CANDLE-BASIS-SHADOW-DECOM-W1` is INTERNAL **and** HELD.

## Copy audit — one claim in the spec's own blocks is not backed by the code

`src/lib/credential-outcome.ts:56` enumerates exactly five outcomes: **`ABSENT` · `MALFORMED` · `UNKNOWN` · `INDETERMINATE` · `RESOLVED`**. There is **no `EXPIRED`** anywhere in `credential-outcome.ts`, `credential-refusal.ts` or `license.ts`.

The spec's CHANGELOG (*"Unknown, expired, malformed…"*), README bullet 1 (*"'expired', 'unknown' and 'we couldn't verify'"*) and Discussion body all name **expired**. Corrected wording proposed at the HALT; everything else in the four blocks is verified true.

## Other measured facts that shape execution

- **README numbers are injected at publish, not committed.** `publish-npm.yml:119` runs `scripts/snapshot-landing-data.mjs` before `npm publish`, so the repo's static fallbacks (`134,276` / `50`) never reach npm — the registry README today reads `459,396` / `122`, and the next publish will carry the live `totalCalls = 498,951`. **There is no data regression here**, and no SNAPSHOT-LINE literal may be hand-edited.
- **3-minor window:** lead **1.27.0**, recaps **1.26.0** + **1.25.0**. Adding 1.28 drops the **v1.25.0** recap. _(The spec's context table said v1.24.0 — it quoted the previous wave's pre-release state.)_
- **DXT description = 198 chars** (≤200, 2 chars of headroom). Unchanged by this wave.
- `tests/unit/tool-description-forward-stability.test.ts` — 163/163 green on the current tree.
- `scripts/land.sh` and `tests/unit/release-tag-order.test.ts` both present; `--follow-tags` stays forbidden.
- **Carryover correction targets — the literal string in the spec does not exist**; the false premise does, in 4 differently-worded rows: `docs-sample-executable-w1.md:372` · `docs-param-schema-projection-w1.md:199` · `docs-support-answers-and-public-venue-scope-w1.md:360` · `docs-completeness-and-navigation-w1.md:407`.

## system-map

**NONE — no edge mutated.** CH1 is internal; CH2 exercises the existing npm / Registry / DXT / LobeHub / GH-Releases edges. Dropping the Smithery badge removes copy for an edge `system-map.md:360` never declared for this repo. Expect `system-map.md updated: n-a`.

## Summary

The spec is accurate on every anchor it re-probed, and its two self-corrections (19 steps, the drifted line numbers) were right. What Step 0 adds is five things it could not have known: the version decision resolves against MINOR on its own rule; two of the CH2 gate's assertions cannot pass on any README this wave could ship; the new gate's first corpus contains a real 4.5-month-old defect on the paid-conversion CTA; and the FAIL/INDETERMINATE boundary needs the transport class widened before the gate can be trusted on a deploy.

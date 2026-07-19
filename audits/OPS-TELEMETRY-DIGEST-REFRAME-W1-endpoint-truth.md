# OPS-TELEMETRY-DIGEST-REFRAME-W1 — endpoint truth

**Target ICP tier(s): META** (internal ops / observability — zero public surface)
**Date:** 2026-07-19 · **Fictional primitives found: 0** (HALT threshold ≥3)
**system-map edge-touch: NONE — internal change only** → `system-map.md updated: n-a`

---

## §1 Step-0 primitive probes

| Claim | Reality (live-probed) | Resolution |
|---|---|---|
| Digest asks a live 1m/3m launch question | **Settled both ways.** Prod `.env:49` `SHADOW_REVEAL_TIMEFRAMES=3m`, confirmed in-container; `/api/performance-public` serves 3m at 97,161 signals / 93.3% PFE WR | Section deleted |
| 1m may still qualify | `OPS-1M-SEED-DECOM-W1` removed the seed cron 2026-06-01. No `--timeframe 1m` line in root crontab; no systemd timer; no other user crontab. DB shows **2** non-HOLD 1m signals in 7d (last 2026-07-15), from the retained on-demand path | Unreachable gate — section deleted |
| `PROMOTED_VENUE_NAMES` = 5 venues | Live `venues` table: **12 promoted** (ASTER BINANCE BINGX BITGET BYBIT GATE HL HTX KUCOIN MEXC OKX PHEMEX), 5 shadow (BITMART EDGEX WEEX WHITEBIT XT) | Derived from `capabilities.ts` |
| `VENUE_BUDGETS` covers promoted venues | Only the original 5. `getVenueBudget()` → null for the other 7 → `acquire()` skipped entirely in `_upstream-fetch.ts:153-157` | Exhaustive `Record<PromotedVenueId,…>` |
| Digest cron exists | `0 0 * * 0 … dist/scripts/shadow-digest-weekly.js` — the ONLY out-of-repo consumer; `deploy.yml` has zero crontab automation | C3 updates it manually, post-deploy |
| `deploy.yml` ignores docs/md | **False.** `paths-ignore` = activation-funnel snapshots, ops/systemd, ops/monitoring, LICENSE, glama.json, Caddyfile. `docs/**`, `*.md`, `audits/**` are NOT ignored — commits here DO rebuild + restart prod (correct: the Dockerfile COPYs them) | Expected; no action |
| Cron safe window | Box at Sun 03:49 UTC; digest fired 00:00, next fire **7 days out**. Seed lines fire every 3 min → no globally quiet window ever | Atomic backup+sed, not timed |

### Traps found during design (both would have shipped bugs)

**T1 — `EXCHANGES[].label` is the wrong derivation source.** `capabilities.ts:56` labels GATE `"Gate.io"`, but `_upstream-fetch.ts:224` `VENUE_FETCH_CONFIGS.GATE.venueName` is `"Gate"` — and *that* is what `rate_limit_events.venue` carries (migrations/008). Deriving display names from `.label` would have classified Gate as shadow, re-creating this exact bug one venue later. Regression-tested.

**T2 — `rate-limit-events.test.ts` needed a fixture fix, not just an import path.** Its lines 79-84 used `'Aster'` as the *shadow* fixture asserting `shadowBudget: true`; once Aster is correctly promoted that assertion flips and the test fails. Line 112 degraded silently. Swapped to `'Bitmart'`.

---

## §2 Vendor-sourced ceilings — primary-source verified (CLAUDE.md precedence rule 4)

All 7 have a published public-market-data limit. **Nothing inferred from an analogous exchange or from memory.** Ceilings are 50%-of-verified, matching the BYBIT/OKX/BITGET convention; reserves ≈⅓ of ceiling.

| Venue | Published (public market data) | Source | /min | Ceiling | Reserve | `weightFor` |
|---|---|---|---|---|---|---|
| ASTER | 2400 weight/min per IP | `github.com/asterdex/api-docs` (v1 + v3) | 2400 | 1200 | 400 | `weightHint ?? 1` |
| BINGX | 500 req/10s per IP | bingx.com support art. 31103871611289 | 3000 | 1500 | 500 | `() => 1` |
| GATE | 300 req/s per IP (perp public) | `github.com/gateio/rest-v4` README | 18000 | 9000 | 3000 | `() => 1` |
| HTX | 800 req/s per IP (market data) | primary docs via `htx.ts:20`, PILOT-ADAPTERS-W3A | 48000 | 24000 | 8000 | `() => 1` |
| KUCOIN | 2000 req/30s public pool | kucoin.com/docs-new/rate-limit | 4000 | 2000 | 700 | **`() => 3`** |
| MEXC | tightest endpoint 10/2s (depth/ticker) | mexc.com/api-docs/futures/market-endpoints | 300 | 150 | 50 | `() => 1` |
| PHEMEX | "Others" group 100/min | `github.com/phemex/phemex-api-docs` | 100 | 50 | 15 | **`() => 10`** |

KuCoin klines self-declare weight 3; Phemex klines weight 10. A flat `() => 1` would under-model our real draw by 3× and 10×.

### Recorded caveats — do not let these silently harden into fact

1. **ASTER** — 2400/min is Aster's *own* published figure, but the whole framework (`REQUEST_WEIGHT`, `X-MBX-*` headers, the 429→418 escalation, the number itself) is a verbatim copy of Binance's. It is a published number, not an independently-derived one.
2. **GATE** — taken from Gate's official GitHub org because `docs.gate.com` returns 403 to automated fetch. Breach status code never stated (only "declined").
3. **BINGX** — breach HTTP status **unconfirmed**; the reference docs are client-rendered and could not be extracted. The support article gives the rate but no status code.
4. **MEXC** — documents body code `510` for rate-limit breach with **no HTTP status**. The transport's `[418,429]` ban detection may therefore not fire for MEXC.

---

## §3 C5 — the Bitget outlier: DIAGNOSED (no code change, per plan)

**Question:** Bitget is budgeted (3000/min ceiling) yet took 136 raw HTTP 429s in 7d, while HL — also budgeted — took zero.

### Evidence

| Probe | Result |
|---|---|
| Bitget throws by caller | `seed:3m` 79 · `backfill` 28 · `seed:1h` 10 · `signal_perf_backfill` 6 · `seed:2h` 5 · `seed:5m` 4 · `seed:15m` 4 — **all batch class** |
| Bitget throws by second-of-minute | **sec 2:62 · 3:32 · 4:17 · 5:9 · 6:12 · 7:3 · 8:1** — 100% inside the first 9 seconds, peaking at sec 2, decaying monotonically |
| Does the Bitget budget ever bind? | **NO.** 7d: `throw/batch 136` and **zero `wait`, zero `skip`** |
| Does the HL budget bind? | **Constantly.** 7d: `wait/batch` 299,348 · `skip/batch` 34,921 · `throw/interactive` 171 |
| Control — Aster (unbudgeted) by second | 509 · 146 · 179 · 157 · 424 · 428 · 12 — spread across the whole minute |

### Verdict

**H2 (fixed-window boundary stampede in our own budget) — REFUTED.** A boundary stampede requires the batch lane to *wait* for the window to roll. Bitget logged **zero wait events**. Its budget is completely inert.

**H3 (flat `weightFor`) — NOT THE DRIVER.** Irrelevant while the budget never binds.

**H1 (ceiling mis-cited) — TRUE, but the real defect is a SHAPE mismatch, not a wrong number.**
`bitget.ts:5` documents Bitget as **20-50 req/*second*** while `venue-budget-registry.ts` cites 6000/*minute* and meters a **per-minute quota**. A per-minute ceiling of 3000 permits all 3000 requests inside the first second — so the budget is *structurally incapable* of preventing the breach that is actually occurring. The second-of-minute curve is the signature: cron launches the seed job at :00, node boots, and the opening concurrent fan-out lands at sec 2-4 and momentarily exceeds Bitget's per-second rate. Sustained load never gets near 3000/min, so the budget stays silent throughout.

### Generalization — this bounds what C2 can achieve

`WeightBudget` is a **per-minute quota meter**. It correctly models venues publishing per-minute limits and only *partially* protects venues publishing sub-minute rates:

| Shape match | Venues | Expected C2 effect |
|---|---|---|
| ✅ per-minute — budget is the right shape | ASTER (2400/min), PHEMEX (100/min), HL, BINANCE | Should genuinely collapse raw 429s → replaced by `BUDGET_CEILING` self-throttles |
| ⚠️ sub-minute — sustained-rate protection only | BITGET (20-50/s), GATE (300/s), HTX (800/s), MEXC (10/2s), BINGX (500/10s), KUCOIN (2000/30s) | Helps sustained overrun; a sub-second burst can still breach |

This is why **Aster is the honest success metric for C2** — its published limit is per-minute, so the budget shape matches. Do not read a residual Bitget/MEXC 429 trickle as C2 having failed.

**Follow-up (not this wave):** `OPS-WEIGHTBUDGET-BURST-WINDOW-W{NEXT}` — add a short sub-window or a concurrency cap to `WeightBudget` so per-second-limited venues are actually constrained. Until then the sub-minute rows above are documented-partial, not believed-complete.

---

## §4 Verification performed

- `rm -rf dist && npm run build` — clean, tsc exit 0.
- Exhaustiveness guard **proven**: removing the `ASTER` key from `VENUE_BUDGETS` yields `TS2741: Property 'ASTER' is missing … but required in type 'Record<"HL"|…|"HTX", VenueBudgetEntry>'`; restored clean.
- All 12 ledger literals present in compiled output (`algovault-{aster,binance,bingx,bitget,bybit,gate,hl,htx,kucoin,mexc,okx,phemex}-weight`) — the R6 deploy-smoke grep targets.
- Full suite: **299 files passed / 2 skipped, 3446 tests passed**, two consecutive runs. (An earlier run showed 5 failed files — all network-dependent; this Mac's ISP DNS-poisons `fapi.binance.com` + `api.bybit.com`, the documented cause of local live-fetch flakes. Confirmed non-reproducing.)
- Pre-push test-baseline gate: **GREEN** — vitest + node:test, no new failures vs the committed baseline.
- Local dry-run renders the new title with no 1m/3m section; the telemetry section correctly took the fail-open branch because the local SQLite backend rejects the Postgres `::text` cast (known dual-backend limitation — live probe is the real gate).

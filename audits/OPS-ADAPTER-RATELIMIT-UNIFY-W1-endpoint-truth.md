# OPS-ADAPTER-RATELIMIT-UNIFY-W1 — endpoint-truth (Plan-Mode, T2 Bulk-Spec)

- **Probed:** 2026-06-05, live (code repo `crypto-quant-signal-mcp`, origin/main; official venue docs; npm not needed).
- **Risk markers:** ≥4 chapters; 17-adapter cascade; concurrent-session (TWO sessions live in `seed-signals.ts`); external-API verification. Produced BEFORE C1; **awaiting architect approval.**
- **Verdict:** **NOT a fiction-HALT** (0 fictional primitives; all chokepoints/files/limits verified). BUT **1 significant scope finding (the direct-fetch gap) + 1 firewall contradiction + 1 OKX ratification** require architect direction before C1. See §6.

---

## §0 — system-map edges (Step 0)

| Producer edge | Reality |
|---|---|
| 17 × `<venue>` adapter → vendor REST (`<venue>Get`/`hlInfoPost`/`binGet`) | each adapter = **exactly 1 fetch site** (verified). HL+Binance already typed+budgeted. |
| `exchange-universe.ts` → Bybit/OKX/Bitget REST (`fetchWithTimeout`, L105/135/165) | **DIRECT, bypasses the adapter chokepoints** — scan_trade_calls + asset-tiers meme-gate. NOT in C1's `adapters/*` scope. |
| `seed-signals.ts` → Bybit/OKX/Bitget REST (`fetch`, L458/478/493) | **DIRECT** universe-discovery — but the file is **FIREWALLED (MUST NOT WRITE)**. |
| `underlying-type.ts` → Binance fapi `exchangeInfo` (L66) | **DIRECT Binance**, bypasses `binGet` (my OPS-BINANCE-RATELIMITER-W1 missed it). |
| `upstream-weight-budget.ts` (HL #1, Binance #2) | singletons + `weightFor*` to MOVE into `venue-budget-registry.ts` (C2). |

---

## §1 — Primitive truth table (claim | reality | resolution)

| Spec claim | Probe | Reality | Resolution |
|---|---|---|---|
| 15 `<venue>Get` chokepoints + hlInfoPost + binGet | `grep "async function .*Get"` ×15 | CONFIRMED: bybitGet/okxGet/bitgetGet/asterGet/bingxGet/gateGet/htxGet/kucoinGet/mexcGet/phemexGet/weexGet/bitmartGet/whitebitGet/xtGet/edgexGet | ✅ |
| each adapter = 1 fetch site | `grep -c "await fetch\|fetchWithTimeout"` per adapter | all = **1** | ✅ chokepoint is sole WITHIN adapters |
| `_upstream-fetch.ts`, `venue-budget-registry.ts` NEW | `ls` | absent | ✅ |
| HL/Binance ledger paths byte-identical (C2) | `grep /tmp/algovault-*-weight` | `/tmp/algovault-hl-weight.{json,lock}`, `/tmp/algovault-binance-weight.{json,lock}` | ✅ C2 must preserve |
| registry must be sparse Map, not Record<ExchangeId> | `grep Record<ExchangeId>` | seed-signals(7, firewalled) + exchange-adapter(1) + asset-tiers(1) | ✅ keep registry a sparse Map (spec already specifies) |
| BYBIT 600 req/5s/IP, **403** ban ≥10min | bybit-exchange.github.io/docs/v5/rate-limit (fetched) | EXACT: "600 requests within a 5-second window per IP"; exceeded → **HTTP 403 'access too frequent'**, wait ≥10min | ✅ bybit.ts currently mishandles 403 (generic+retried) → fix correct |
| BITGET 6000 req/IP/min, 5-min recovery | bitget.com/wiki/bitget-api-rate-limits (search) | EXACT: "6000/IP/Min … 5 minutes to recover"; also body codes 45001/40725/40808 (retryable) | ✅ note: some Bitget rate-limits are BODY codes (45001), not HTTP status — see §5 |
| OKX per-endpoint, sources conflict | okx.com/docs-v5 (search) | market-data ≈ **20 req/2s per endpoint** (=600/min/endpoint), err `50026`; per-key vs per-IP ambiguity for public | ⚠️ **PROVISIONAL** — single-bucket ceiling ≤600 is safe (under the per-endpoint limit even if all calls hit one endpoint). Architect ratify 300 (spec) vs ~500. |
| runbook `docs/RUNBOOK-*` | `ls docs/RUNBOOK-*` | EQUITIES-ENGINE, POSTGRES-MAINT, VENUE-SHADOW-ONBOARDING (no "venue-budget" one) | ✅ append to VENUE-SHADOW-ONBOARDING or NEW `RUNBOOK-VENUE-BUDGET.md` (C4) |

---

## §2 — 🔴 KEY FINDING: the direct-fetch gap (generator-completeness vs firewall)

`grep -rn 'fetch(' src/ | grep <venue-hosts>` outside `adapters/` surfaces **non-adapter direct venue fetches** that bypass the `<venue>Get` chokepoints — so they get NEITHER the typed-418 (C1) NOR the budget (C3):

- **`exchange-universe.ts` L105/135/165** → Bybit/OKX/Bitget direct (`fetchWithTimeout`). Drivers: `scan_trade_calls` + asset-tiers meme-liquidity gate. **Not firewalled → routable**, but **not in C1's `adapters/*` scope as written**.
- **`underlying-type.ts` L66** → Binance `exchangeInfo` direct. **Not firewalled → routable.**
- **`seed-signals.ts` L458/478/493** → Bybit/OKX/Bitget universe-discovery direct. **FIREWALLED (MUST NOT WRITE)** → un-routable in this wave.

**Tension:** AC1 ("zero adapters bypass `_upstream-fetch`") is literally satisfiable (these are NON-adapter callers), but the GENERATOR GOAL ("418 bug class structurally dead across 17 venues" + "budgets cap the cross-process aggregate") is **partially unmet** — and `seed-signals.ts` containing direct fetches is a **hard firewall contradiction** with "zero bypass."

**Severity:** the gap is mostly **light load** (universe-discovery + TradFi-classification fetches, ~1-few calls/fire) — the **bulk per-coin seed/scan load IS through the adapters** (covered). But the budget won't cap these, and they keep the old 418-retry bug.

**→ architect decision (Q1 below).** Recommended: extend C1 to also route `exchange-universe.ts` + `underlying-type.ts` venue fetches through `_upstream-fetch` (non-firewalled); document the `seed-signals.ts` 3 direct fetches as a known residual (firewalled; owned by the active seed sessions → a coordinated follow-up `OPS-SEED-UNIVERSE-FETCH-BUDGET-W1`).

---

## §3 — Concurrent-session state (clean-baseline)

- Local **3 behind origin**; the 3 commits = **OPS-SEED-ORCHESTRATOR-W1** (CH1 `--concurrency` venue fan-out in `seed-signals.ts`; CH2 monitor seed-freshness). PLUS **OPS-SHADOW-PIPELINE-W1 V2** is the other active `seed-signals.ts` editor. **NONE touch my target files** (`adapters/*`, `upstream-weight-budget.ts`, `exchange-universe.ts`, `underlying-type.ts`) — verified `git diff --name-only HEAD origin/main`.
- **Two live sessions in `seed-signals.ts`** ⇒ the firewall is load-bearing. Must `git pull --rebase` before C1 + re-`git status -s` at every chapter start (spec already mandates).

---

## §4 — Identifier diff (cross-chapter)

| Identifier | Cited | Consistent? |
|---|---|---|
| HL ceiling/reserve 1150/450 | C2 "MUST NOT change" | ✅ matches live `upstream-weight-budget.ts` |
| Binance 2000/800 | C2 "MUST NOT change" | ✅ matches live |
| ledger paths `/tmp/algovault-{venue}-weight.json` | C2/C3 | ✅ matches hl/binance live; bybit/okx/bitget new |
| BYBIT 3600/1200, BITGET 3000/1000, OKX 300/100 | C3 table | internally consistent; BYBIT/BITGET = 50%-of-verified; OKX provisional (Q2) |
| `getVenueBudget(exchangeId)` | C2/C3/gates | ✅ |

No contradictory identifiers. Diff gate passes.

---

## §5 — Inline notes / minor

- **Bitget body-code rate-limits**: Bitget signals some throttles via response BODY code (45001/40725/40808), not HTTP status. `banStatuses=[418,429]` (HTTP) won't catch those → `_upstream-fetch` should allow an optional **`banBodyCodes`** hook (or the bitget adapter keeps body-code handling post-parse). Flag for C1 `cfg` design.
- **BYBIT** minute-window bucket vs 5s vendor window: spec already ratified (D2) — polite delays remain the intra-minute smoother. ✅
- **`underlying-type.ts`** Binance fetch is a pre-existing miss from OPS-BINANCE-RATELIMITER-W1 — fold into this wave's scope extension (Q1).

---

## §6 — OPEN DECISIONS (architect / Cowork) — copy-paste Q-block

> **Q1 — direct-fetch gap scope (the core one).** Non-adapter direct venue fetches bypass `_upstream-fetch`: `exchange-universe.ts` (Bybit/OKX/Bitget) + `underlying-type.ts` (Binance) [routable], and `seed-signals.ts` ×3 [FIREWALLED]. (A, recommended) **Extend C1** to route the 2 non-firewalled files through `_upstream-fetch`; document the 3 firewalled seed fetches as residual → `OPS-SEED-UNIVERSE-FETCH-BUDGET-W1` (coordinate with the active seed sessions). (B) C1 as-written (adapters only); accept ALL non-adapter direct fetches as a documented residual; soften AC1 to "zero ADAPTER bypass". (C) Lift the `seed-signals.ts` firewall just for these 3 fetch sites (collides with 2 active seed sessions — not recommended).

> **Q2 — OKX ceiling ratification.** OKX is per-endpoint (≈20 req/2s = 600/min/endpoint), not a single per-IP aggregate. A single-bucket ceiling ≤600 is safe even if all calls hit one endpoint. Ratify: (A) keep spec's conservative **300/min · reserve 100**, or (B) **~500/min · reserve 150** (closer to the real headroom). I'll set the `weightFor=1` request-count model either way.

> **Q3 — Bitget body-code throttles.** Add an optional `banBodyCodes` hook to `_upstream-fetch.cfg` so Bitget's 45001/40725/40808 are treated as typed rate-limits (not just HTTP 418/429)? (recommended yes — else Bitget body-code throttles stay un-typed.)

**Until Q1-Q3 are answered I will not start C1.** Recommended defaults if "use your judgment": **Q1=A, Q2=B, Q3=yes.**

---

## §7 — ARCHITECT RATIFICATIONS (2026-06-05, delegated "no preference" → Code judgment) — spec-of-record

- **Q1 → A (extend scope).** C1 also routes the **non-firewalled** direct venue fetches through `_upstream-fetch`: `exchange-universe.ts` (Bybit/OKX/Bitget `fetchWithTimeout` L105/135/165) + `underlying-type.ts` (Binance `exchangeInfo` L66). The **3 firewalled `seed-signals.ts` fetches stay untouched** → documented residual `OPS-SEED-UNIVERSE-FETCH-BUDGET-W1` (coordinate with the active OPS-SEED-ORCHESTRATOR / OPS-SHADOW-PIPELINE sessions). AC1 reading: "zero **adapter** bypass" + the 2 routable non-adapter callers; the firewalled 3 are an explicit, logged exception.
- **Q2 → OKX 500/min · reserve 150** (request-count `weightFor=1`; ≤600/min/endpoint floor → safe even if all calls hit one endpoint; closer to real headroom than the 300 placeholder).
- **Q3 → yes.** `_upstream-fetch` `cfg` gets optional `banBodyCodes` (Bitget 45001/40725/40808 → typed `UpstreamRateLimitError`, no-retry, after JSON parse).
- BYBIT `banStatuses` += **403**; BITMART/XT keep [418,429]. BYBIT 3600/1200, BITGET 3000/1000 ratified (50%-of-verified); HL 1150/450 + Binance 2000/800 frozen.

**Status: APPROVED → proceeding to C1** (after rebase onto origin + baseline capture).

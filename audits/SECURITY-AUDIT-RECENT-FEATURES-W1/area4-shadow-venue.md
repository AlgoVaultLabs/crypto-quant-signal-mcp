# Area 4 — Shadow-Venue Pipeline + New DEX Adapters (R4)

**Auditor:** SHADOW-VENUE-AUDITOR (teammate 4/5) · **Wave:** SECURITY-AUDIT-RECENT-FEATURES-W1 · **Type:** READ-ONLY forensic
**Clone:** `~/code/crypto-quant-signal-mcp` @ `aec4175` (`origin/main`, clean tree) · **Date:** 2026-06-07
**Scope:** `_upstream-fetch.ts` (shared egress, audited FIRST = generator) · `aster.ts` · `edgex.ts` · `venue-store.ts` · `venue-shadow.ts` · `evaluate-venues.ts` · `types.ts` · `/api/performance-shadow` + `/api/performance-public` (`src/index.ts`) · `mcp://algovault/venues` resource.
**PoC:** `audits/SECURITY-AUDIT-RECENT-FEATURES-W1/poc/sv-poc.mjs` (self-contained; no `src/` import; runs clean).

---

## 1. Summary

**No CRITICAL.** The two headline concerns both come back clean on the worst case: (1) **no `outcome_return_pct`/Phase-E leak** anywhere on the public surface (proven live on `/api/performance-shadow`, `/api/performance-public`, and the `mcp://venues` resource), and (2) **no RCE / SSRF / prototype-pollution** in the new adapters — all 17 adapter base-URLs are hardcoded HTTPS constants, no user-controlled URL, no `rejectUnauthorized:false`, no proto-pollution sink. The real exposure is **premature public disclosure of shadow performance + internal thresholds** (policy decision for Mr.1) plus **generator-level data-hygiene gaps** in the shared egress (NaN parse, unbounded alloc) and a **fail-open shadow leak** on the public endpoint.

| Severity | Count | IDs |
|---|---|---|
| CRITICAL | 0 | — |
| HIGH | 0 | — |
| MEDIUM | 4 | SV-01 (open shadow endpoint + internal-threshold leak; **+ Mr.1 policy flag**), SV-02 (perf-public fail-OPEN shadow leak), SV-03 (unbounded upstream-array alloc / no response byte cap — DoS), SV-04 (untrusted-parse NaN/`0x`-coercion, no default-deny at generator) |
| LOW | 2 | SV-05 (`/api/performance-shadow` has no exported allow-list formatter + no shape-snapshot), SV-06 (stale auto-promote docstring/resource-description vs code-as-written) |
| INFO | 2 | SV-07 (`lighter.ts` spec drift — never shipped), SV-08 (`getVenueStatus` fails-open to `promoted` — display-only, not a gate bypass) |

**Headline per finding**
- **SV-01 (MEDIUM + POLICY):** `GET /api/performance-shadow` → **200 UNAUTHENTICATED**, returns the full per-venue PFE win-rate / timeframe / tier / call-type breakdown for all 12 shadow venues **plus the internal `min_buy_sell_sample` promotion threshold**. PFE-only (no `outcome_return_pct` ✅). **Flag for Mr.1: is publicly exposing shadow performance intended?** — given the "shadow until promoted" North-Star and the prior `REVERT-DASHBOARD-SHADOW-COPY-W1` ("Mr.1 dashboard violation revert"), this is a premature-disclosure candidate, not assumed-fine.
- **SV-02 (MEDIUM):** `/api/performance-public`'s `status='promoted'` filter is airtight on the happy path (live-proven: only the 5 promoted venues appear) but **fails OPEN** — empty/erroring venues table → unfiltered `byExchange` leaks shadow rows onto the PUBLIC endpoint.
- **SV-03 (MEDIUM):** `_upstream-fetch.upstreamFetch` reads `res.json()` with no byte cap; `aster.getPredictedFundings` / `edgex.ensureContractMap` map/iterate the full upstream array with no `.slice` cap → a compromised/spoofed upstream DoSes the process (PoC: 877 MB heap from one response).
- **SV-04 (MEDIUM):** `getCandles`/`getAssetContext` in both new adapters `parseFloat()` untrusted strings with **no `isFinite`/default-deny** (CLAUDE.md violation). `parseFloat('0x1')→0` silently produces a finite-but-wrong 0 price/volume.
- **SV-05 (LOW):** the NEW `/api/performance-shadow` is built inline, with **no exported pure allow-list formatter and no `audits/*-shape-snapshot`** (every other public endpoint has one) → future shape-widening can silently leak a new field.
- **SV-06 (LOW):** `evaluate-venues.ts` header + the `mcp://venues` resource description both say venues "auto-promote via daily cron" — **code does NOT auto-promote** (it flags `ready_for_promotion`; only the operator CLI `promote-venue.ts` flips status). Stale doc.
- **SV-07 (INFO):** spec-cited `src/lib/adapters/lighter.ts` does **not exist** — never shipped. Real new DEX adapters = `aster.ts` + `edgex.ts` only.

---

## 2. Findings

### SV-01 · MEDIUM (+ Mr.1 POLICY DECISION) · R4.1(b)(c) — `/api/performance-shadow` open + exposes internal threshold + premature shadow disclosure
**file:** `src/index.ts:1550-1582` (handler) · `src/index.ts:769-817` (`mcp://venues` mirror) · venue shape from `src/lib/performance-db.ts:1894-1951`
**exploit scenario:** Any unauthenticated party `GET https://api.algovault.com/api/performance-shadow` and harvests, for all 12 shadow venues: live + last-eval **PFE win rate**, `current_buy_sell_count`, **`min_buy_sell_sample`** (the exact internal promotion gate target), `extension_count`, and full `byTimeframe`/`byTier`/`byCallType` PFE breakdowns. Two distinct issues: **(i) info-leak of an internal strategy threshold** (`min_buy_sell_sample` is the gate the promotion state machine tests against — it should stay private per R4.5); **(ii) premature disclosure** of not-yet-validated venue performance, which the North-Star posture ("shadow until promoted; NOT on the public dashboard") deliberately withholds. The dashboard shadow-copy was already reverted once (`REVERT-DASHBOARD-SHADOW-COPY-W1`, commit `3dc9039`), yet the raw JSON endpoint serves the same data wide-open.
**evidence (live, captured 2026-06-07):**
```
GET https://api.algovault.com/api/performance-shadow → HTTP 200 (no auth header)
12 shadow venues. sample venue keys:
  exchange_id,status,asset_count,min_buy_sell_sample,integrated_at,
  days_since_integration,extension_count,last_eval_at,last_eval_pfe_wr,
  last_eval_buy_sell_count,current_buy_sell_count,current_pfe_wr,
  byTimeframe,byTier,byCallType
leak grep: outcome_return_pct=0  outcome_price=0  phase_e=0   (PFE-only ✅)
           min_buy_sell_sample=12 (one per venue ❌)  pfe=208 occurrences
e.g. ASTER current_pfe_wr=0.869, min_buy_sell_sample=4100; BINGX 0.951, 6380
```
(PoC `sv-poc.mjs` → SV-01 block reproduces this live.)
**Data-Integrity verdict:** NOT a `outcome_return_pct`/Phase-E breach → **not CRITICAL**. It IS public exposure of (a) an internal threshold and (b) pre-promotion performance.
**GENERATOR-LEVEL fix:** decide policy first (Mr.1). If shadow stays internal: auth-gate `/api/performance-shadow` behind the same API-key middleware as other privileged routes (and drop it from the public `mcp://venues` resource, or split a public "status-only" view from an internal "stats" view). If kept public: **strip `min_buy_sell_sample`** (and any future internal threshold) via an EXPORTED allow-list formatter shared by BOTH the HTTP handler and the `mcp://venues` resource builder (single sanitizer ⇒ both surfaces inherit the redaction) — this also closes SV-05.
**follow-up wave:** `OPS-SHADOW-PERF-ENDPOINT-POLICY-W1` (Mr.1 decides auth-gate vs public-PFE-only-formatter).

---

### SV-02 · MEDIUM · R4.1(a) — `/api/performance-public` `promoted` filter fails OPEN (shadow leak on venues-table outage/empty)
**file:** `src/index.ts:1512-1527`
**exploit scenario:** The public-endpoint filter only applies when `promotedIds.size > 0`; if `listVenues('promoted')` throws (Postgres outage — see the `Hetzner OOM` memory note: "Connection terminated unexpectedly" alerts are a live class) **or** returns 0 rows (fresh DB / `initVenuesTable` seed-backfill failed — that backfill is explicitly `try/catch` non-fatal at `venue-store.ts:105-112`), the handler falls through to the **unfiltered** `stats.byExchange` and serves **all 12 shadow venues' performance on the PUBLIC endpoint**. This is a Data-Integrity-LAW fail-OPEN: a hardening filter that disengages exactly when its dependency is unhealthy.
**evidence:** code path at `src/index.ts:1519` (`if (promotedIds.size > 0)`) + `1524` (`catch` leaves `filteredByExchange = stats.byExchange`). PoC `sv-poc.mjs` → SV-02:
```
Normal path (promoted rows present): ["HL","BINANCE"]           → shadow EXCLUDED ✅
Fail-open path (venues table EMPTY):  ["HL","BINANCE","ASTER","EDGEX"]
   → SHADOW LEAKED onto PUBLIC endpoint: ["ASTER","EDGEX"]  ❌
```
Live happy-path is currently correct (`byExchange` keys = `[OKX,BINANCE,BYBIT,HL,BITGET]`, zero shadow) — the hole only opens under DB-empty/error.
**GENERATOR-LEVEL fix:** fail **CLOSED** on the public surface — if the promoted-venue lookup throws or returns empty, return the promoted-venue static set from a compiled constant (the 5 are known/stable) OR omit `byExchange` entirely rather than serving unfiltered. Never let "filter dependency unavailable" widen the public response. (Mirror of CLAUDE.md "fail-open vs fail-closed" discipline for Data-Integrity surfaces.)
**follow-up wave:** `OPS-PERF-PUBLIC-FAILCLOSED-W1`.

---

### SV-03 · MEDIUM · R4.2 — unbounded allocation from untrusted upstream array (no response byte cap, no `.slice` cap)
**file:** `src/lib/adapters/_upstream-fetch.ts:103` (`res.json()` — no `Content-Length`/byte guard) · `src/lib/adapters/aster.ts:128-139` (`getPredictedFundings` maps full array) · `src/lib/adapters/edgex.ts:81-86,229` (`ensureContractMap` / fan-out iterate full array)
**exploit scenario:** A compromised or spoofed shadow upstream (12 NEW untrusted hosts, low operational trust) returns a massive JSON array. `upstreamFetch` buffers the entire body via `res.json()` with no size limit, then the adapter builds one object per element with no `.slice(limit)` cap → heap exhaustion / OOM of the MCP process. On the 3.8 GB Hetzner box (per `Hetzner OOM` memory note, OOM cascade already observed), this is a realistic single-response DoS.
**evidence:** PoC `sv-poc.mjs` → SV-05 block: a 5,000,000-element upstream array → **~877 MB heap from one response**. No `MAX_`/`.slice`/`byteLength`/`Content-Length` guard anywhere in `_upstream-fetch.ts` (grep confirmed empty).
**GENERATOR-LEVEL fix:** at the generator (`_upstream-fetch.ts`) — enforce a response byte ceiling (read with a size-capped reader or check `Content-Length` and abort over `maxResponseBytes`, a new `VenueFetchConfig` field defaulting e.g. 8 MB), so **every one of the 17 adapters + future adapters** inherits the cap. Defense-in-depth: cap array length in adapter map loops (`raw.slice(0, MAX_CONTRACTS)`).
**follow-up wave:** `OPS-UPSTREAM-FETCH-RESPONSE-CAP-W1`.

---

### SV-04 · MEDIUM · R4.2 / R4.3 — untrusted-response parse: no default-deny on NaN / `0x`-coercion at the generator
**file:** `src/lib/adapters/aster.ts:94-101` (`getCandles`), `:114-124` (`getAssetContext`) · `src/lib/adapters/edgex.ts:185-192` (`getCandles`), `:209-219` (`getAssetContext`)
**exploit scenario:** Both new adapters `parseFloat()` untrusted upstream strings (`c.open`, `t.fundingRate`, `oi.openInterest`, …) with **no `Number.isFinite` guard** — violating CLAUDE.md "OHLCV/funding/OI parsed with default-deny on `NaN`/invalid". A malformed/hostile upstream value yields `NaN` (poisons indicators / `fundingAnnualized = NaN`) or, worse, silently coerces: `parseFloat('0x1') → 0`, `parseFloat('1abc') → 1` — a **finite-but-wrong** price/volume that passes any downstream `isFinite` check and corrupts a signal's PFE/regime computation. `getFundingHistory` DOES filter NaN (aster `:150`, edgex `:259`) — proving the guard was intended but applied inconsistently.
**evidence:** PoC `sv-poc.mjs` → SV-04:
```
Hostile kline [ts,'NaN','0x1','null','','Infinity'] → Candle:
  {"open":null(NaN),"high":0,"low":null,"close":null,"volume":null,...}
  non-finite fields: [open,low,close,volume]  + high silently = 0 (0x1 → 0) ❌
```
Downstream has only partial defense (`scan-funding-arb.ts:205` guards `isNaN(v.fundingRate)` on the predicted-fundings path) — not airtight, and `getCandles` output is unguarded.
**GENERATOR-LEVEL fix:** a shared `parseFiniteOr(value, fallback|reject)` helper (in `_upstream-fetch.ts` or an adapter-common module) that returns the number only when `Number.isFinite` AND the source string is fully numeric (reject `0x`/trailing-garbage via a `/^-?\d+(\.\d+)?$/`-class check before `parseFloat`), default-denying otherwise — adopted by every adapter's OHLCV/funding/OI parse. Quarantine a candle/context with any non-finite field rather than emitting it.
**follow-up wave:** `OPS-ADAPTER-PARSE-DEFAULT-DENY-W1`.

---

### SV-05 · LOW · R4.1 / cross-cut AC — `/api/performance-shadow` lacks an exported allow-list formatter + shape-snapshot
**file:** `src/index.ts:1550-1582` (inline object construction) — contrast `src/lib/performance-db.ts:2036 formatPublicRecentSignal()` (the exported pure formatter `/api/performance-public` uses).
**exploit scenario:** The new public endpoint builds its response inline (no EXPORTED pure formatter, no TS `forbidden_keys` interface, no `audits/<endpoint>-shape-snapshot-*.json`). CLAUDE.md mandates both for "every NEW or modified public endpoint". Without them, a future edit to `getSignalPerformance().byExchange[ex]` shape (or to the handler) can silently add a field to the shadow surface with no unit-test / drift-check tripwire — the exact leak class the allow-list rule exists to prevent.
**evidence:** grep — `formatPublicRecentSignal` exists for performance-public; **no `formatShadow*` formatter** and **no `*shadow*shape-snapshot*` in `audits/`** (only endpoint-truth / probe CSVs).
**GENERATOR-LEVEL fix:** add an exported `formatShadowVenuePublic(v, stats)` pure formatter + `forbidden_keys` (`outcome_return_pct`, `outcome_price`, `min_buy_sell_sample` if SV-01 decides redact) + a unit test + `audits/performance-shadow-shape-snapshot-<date>.json` with `drift_check_command`. Share it with `mcp://venues` (closes SV-01's redaction too).
**follow-up wave:** folds into `OPS-SHADOW-PERF-ENDPOINT-POLICY-W1` (SV-01).

---

### SV-06 · LOW · R4.4 — stale "auto-promote" docs vs code-as-written (no auto-flip actually happens)
**file:** `src/scripts/evaluate-venues.ts:21-29` (header) · `src/index.ts:776-777,783` (`mcp://venues` description) · contradicted by `evaluate-venues.ts:57-64,148-159,205-208`
**exploit scenario:** Documentation/strategy-comms risk, not direct exploit (architect-stated-semantics-vs-code-as-written gap, per CLAUDE.md). The header docstring + the public MCP resource description both state venues "auto-promote via daily cron when PFE WR ≥0.80". The **actual code never auto-promotes**: `EvalDecision` has `ready_for_promotion` (NOT `promoted`), the loop's `decision.action === 'ready_for_promotion'` branch is an intentional NO-OP (comment `:205-208`), and the ONLY `setStatus(...,'promoted')` callers are the operator CLI `promote-venue.ts:61` (the cron's line `:23` is comment-only). An agent reading `mcp://venues` would wrongly believe shadow→promoted is automatic.
**evidence:** `grep setStatus( src/` → 2 real callers: `promote-venue.ts` (CLI) + `retire-venue.ts` (retire). No HTTP route mutates venue status (`/api/performance-shadow` is GET-only). This is actually the **R4.4 SAFE finding**: auto-promote is *disabled*, operator-gated — stronger than the spec assumed.
**GENERATOR-LEVEL fix:** correct the docstring + the public `mcp://venues` description to "flagged ready-for-promotion; operator launches via promote-venue.ts" (the description is PUBLIC copy → also a minor public-accuracy fix).
**follow-up wave:** `OPS-SHADOW-DOC-SYNC-W1` (doc-only; or fold into the next venue wave).

---

### SV-07 · INFO · R4 scope — `lighter.ts` spec drift (never shipped)
**file:** spec cited `src/lib/adapters/lighter.ts` — **does not exist** (`ls` MISSING).
**evidence:** `src/lib/adapters/lighter.ts` MISSING; adapter dir has 17 files (excl. `_upstream-fetch.ts`): aster, binance, bingx, bitget, bitmart, bybit, edgex, gateio, htx, hyperliquid, kucoin, mexc, okx, phemex, weex, whitebit, xt — matching `ExchangeId` widened 5→17. The NEW DEX adapters are **`aster.ts` + `edgex.ts` only**.
**resolution:** report as drift; no `lighter` audit performed (nothing to audit). Already noted in Step-0 `endpoint-truth.md` (DRIFT #2). No HALT (2 drifts < 3-fictional threshold).

---

### SV-08 · INFO · R4.4 — `getVenueStatus` fails-open to `'promoted'` (display-only; NOT a state-machine bypass)
**file:** `src/lib/venue-shadow.ts:30-41`
**note:** On unknown venue or DB error, `getVenueStatus` returns `'promoted'`. This feeds **only** the `_algovault.venue_status` envelope field + the `tools/list` describe-text suffix (`describeVenueForToolList`) — it performs **no DB write** and does **not** influence the promotion state machine or which venues appear on `/api/performance-public` (that path uses `listVenues('promoted')` directly, SV-02). So a fail-open here at worst drops the "(experimental — shadow mode)" caveat on a shadow venue whose row errored — a cosmetic UX miss, not a gate bypass or data leak. Recorded for completeness; no action required beyond awareness.

---

## 3. Verification evidence — PASS/FAIL per R4.1–R4.5

### R4.1 — Shadow-data leak + `/api/performance-shadow` · **PASS (no Phase-E leak) + 2 findings (SV-01 policy/threshold, SV-02 fail-open)**
- **(a) `/api/performance-public` `promoted` filter airtight — LIVE PASS:** `byExchange` keys = `["OKX","BINANCE","BYBIT","HL","BITGET"]` (exactly the 5 promoted); **0 of 12 shadow venues leak**; `outcome_return_pct` absent from entire response; `shadow_venue_count:12` is a harmless integer. Filter is strict Set-membership (`promotedIds.has(ex)`), no UNION/`OR status IS NULL`/empty-filter in the SQL (`listVenues('promoted')` → `WHERE status = ?`, parameterized). **Latent FAIL on dependency outage → SV-02 (fail-open).**
  - No shadow venue on landing/README (grep of `landing/` + `README.md` for `ASTER|EDGEX|shadow.?venue|performance-shadow` → only unrelated integration-page hits).
  - On-chain↔dashboard equality canary holds: `/api/merkle-batches` (signal-hash based) is orthogonal to venue status; `/api/performance-public` excludes shadow consistently → no filter breaks the canary.
- **(b) `/api/performance-shadow` scrutiny — LIVE:** **OPEN / UNAUTHENTICATED (HTTP 200)**. **Data is PFE-only** — `outcome_return_pct`/`outcome_price`/`return_1candle` all absent (the `byExchange` builder at `performance-db.ts:1894-1951` constructs only `count/evaluated/pfeWinRate`; `outcome_return_pct` lives solely in the DB write-path, never in `getSignalPerformance` output). **But exposes `min_buy_sell_sample` (internal threshold) + full per-venue PFE breakdown → SV-01.** No exported allow-list formatter / shape-snapshot → SV-05.
- **(c) Premature-disclosure FLAG for Mr.1:** **RAISED (SV-01).** Publicly serving 12 shadow venues' PFE win rates + the gate threshold contradicts the "shadow until promoted, not on the dashboard" posture and the prior `REVERT-DASHBOARD-SHADOW-COPY-W1`. **Not assumed a bug; not assumed fine — Mr.1 decision** (`OPS-SHADOW-PERF-ENDPOINT-POLICY-W1`).

### R4.2 — New DEX adapters as untrusted upstreams (`_upstream-fetch.ts` first) · **PASS on host-pin/TLS/SSRF/proto-pollution; FAIL on alloc-bound + NaN default-deny**
- **Outbound hosts pinned — PASS:** every base URL is a **hardcoded module constant** (`aster.ts:28 'https://fapi.asterdex.com'`, `edgex.ts:31 'https://pro.edgex.exchange'`; all 17 confirmed). The host is **never** in `VenueFetchConfig` and is **never** influenced by `process.env` (grep: no `process.env` in `src/lib/adapters/`). `req.url` reaching `_upstream-fetch.upstreamFetch` is always `new URL(path, BASE_URL).toString()` with `path` a hardcoded endpoint string — no user-controlled host/origin.
- **TLS verified — PASS:** native `fetch`, default TLS verification; **no `rejectUnauthorized:false`, no `NODE_TLS_REJECT_UNAUTHORIZED`, no custom `Agent`/`dispatcher`/`setGlobalDispatcher`** anywhere in adapters or `upstream-weight-budget.ts` (grep empty).
- **No user-controlled URL reaches fetch — PASS:** only the kline `path` constants + `searchParams.set(k, String(v))` (URL-encoded) feed the URL; see R4.3.
- **Untrusted-response parsing — FAIL (SV-04):** `parseFloat` without `Number.isFinite`/default-deny in `getCandles`/`getAssetContext` (NaN + `0x`/garbage coercion). `getFundingHistory` guards (inconsistent).
- **Prototype-pollution — PASS:** no `Object.assign`/`__proto__`/spread-of-upstream-json into shared objects; upstream JSON is read field-by-field into fresh literals; `isBanBody` reads only `.code`. Attacker JSON keys (`__proto__`, `constructor`) are never used as object keys.
- **Unbounded allocation — FAIL (SV-03):** `res.json()` unbounded + adapter map/iterate with no `.slice` cap.
- **3-tier fallback — PARTIAL/PASS-for-shadow:** adapters degrade gracefully (`getFundingHistory`/`getCurrentPrice`/`getPredictedFundings` `try/catch → [] / null`; `getVenueStatus` fails-open `promoted`). No live→stale-cache→static taxonomy tier here (these are price/funding fetches, not classification) — acceptable for shadow-mode; note for promote-time (edgeX `getPredictedFundings` per-contract fan-out is explicitly flagged in-code for promote-time caching).

### R4.3 — Adapter input validation · **PASS**
- **Symbol injection/escaping — PASS:** `coin` is `z.string().max(20)` (tool input schema `index.ts:287,391`) → `coin.toUpperCase()` → for aster `coin+'USDT'` placed via `URLSearchParams.set('symbol', …)` (percent-encodes `& = / ? #` space) — query-param injection / path-traversal structurally impossible. **No `coin`/`symbol` is ever interpolated into a URL path-template** (grep confirmed: all via `searchParams.set`). For edgeX, `coin` resolves through the venue's own contract map to a numeric `contractId` (never reaches the URL as raw user input). The `max(20)` cap also blocks huge-symbol DoS.
- **Response shape validated not blindly trusted — PARTIAL → SV-04:** envelope drill-down is guarded (edgeX checks `raw.data?.[0]`, throws on empty ticker; `dataList || []`/`contractList || []` null-guards), but numeric fields are `parseFloat`'d without finite-check (SV-04).

### R4.4 — State-machine integrity (`evaluate-venues.ts`) · **PASS (stronger than spec — auto-promote is DISABLED)**
- **Premature-promote — PASS:** `decide()` (`evaluate-venues.ts:131-182`) requires `days_since ≥ 15 AND buy_sell_count ≥ venue.min_buy_sell_sample AND pfe_wr !== null AND pfe_wr ≥ 0.80` for `ready_for_promotion`. A manipulated/low sample cannot trip it: low `buy_sell_count` fails the floor; zero count short-circuits to `no_op:'no_pipeline_yet'` (Branch 0). The floor + WR gate are both enforced in code.
- **`extension_count` 0–2 bound — PASS (DB CHECK + code):** DB `CHECK (extension_count >= 0 AND extension_count <= 2)` (`venue-store.ts:35`) **AND** code: auto-extend (`incrementExtension`) fires only at `extension_count === 0` (Branch 2); `≥ 1` routes to `manual_required` (Branch 3, no auto-change). So code caps auto-extension at 1; the DB CHECK is the backstop against any direct `incrementExtension` abuse (raw `+1`, no code guard — DB catches a 3rd).
- **Silent-recovery on zero pipeline — PASS:** `buy_sell_count === 0 → no_op:'no_pipeline_yet'` (Branch 0, placed FIRST), short-circuiting before `sendVenueStatusChange`/`incrementExtension` — no operator alert, no extension-budget burn on empty data (matches CLAUDE.md "recovery alerts are noise — default silent recovery").
- **Auto-promote is the ONLY shadow→promoted path — PASS (and it's actually operator-gated):** **grep proof** — `setStatus(...,'promoted')` has exactly **2 callers**: `evaluate-venues.ts:23` (comment-only) and `promote-venue.ts:61` (operator CLI). The cron loop **does not call `setStatus`** for `ready_for_promotion` (intentional NO-OP, `:205-208`). **No HTTP route mutates venue status** — the only venue route is `app.get('/api/performance-shadow')` (read-only); no debug/admin/PATCH endpoint flips a venue. → no bypass exists; the doc claiming auto-promote is stale (SV-06).

### R4.5 — Resource/envelope exposure · **PASS on envelope; FAIL on resource + endpoint (`min_buy_sell_sample`) → SV-01**
- **`_algovault.venue_status` envelope — PASS:** sourced from `getVenueStatus(exchange)` (`get-trade-call.ts:460`, `get-market-regime.ts:283`) → emits **only** the `VenueStatus` enum string (`'shadow'|'promoted'|'retired'`). No threshold, no internal WR, no `outcome_return_pct`. Clean.
- **`(experimental — shadow mode)` describe-text tag — PASS:** present (`venue-shadow.ts:58 describeVenueForToolList` returns `' (experimental — shadow mode)'` for shadow venues; blanket static sentence in `tools/list` per the module doc).
- **`mcp://algovault/venues` resource — FAIL (SV-01):** exposes `min_buy_sell_sample` + `last_eval_pfe_wr` + `last_eval_buy_sell_count` + `notes` (`index.ts:794-807`) publicly — same internal-threshold leak as `/api/performance-shadow`. (`notes` currently holds only operational provenance, but is an unbounded free-text field on a public resource — fold into the SV-01 allow-list formatter.) No `outcome_return_pct` (PASS on Phase-E).

---

## 4. AC4 captured output (Data-Integrity proofs)

```
# /api/performance-public  (LIVE 2026-06-07)
byExchange keys: ['OKX','BINANCE','BYBIT','HL','BITGET']
shadow_venue_count: 12
LEAKED SHADOW VENUES: NONE ✅
outcome_return_pct present anywhere: False ✅

# /api/performance-shadow  (LIVE 2026-06-07, UNAUTHENTICATED)
HTTP 200 ; 12 shadow venues
outcome_return_pct / outcome_price / phase_e : 0 occurrences ✅ (PFE-only)
min_buy_sell_sample : 12 occurrences ❌ (internal threshold — SV-01)
pfe* : 208 occurrences (full per-venue PFE breakdown public — SV-01 policy flag)

# mcp://algovault/venues resource builder (src/index.ts:794-807)
exposes: exchange_id,status,asset_count,min_buy_sell_sample,extension_count,
         last_eval_pfe_wr,last_eval_buy_sell_count,notes
outcome_return_pct: NOT present ✅ ; min_buy_sell_sample: present ❌ (SV-01)
```

**Read-only integrity:** zero `src/` edits; all writes confined to `audits/SECURITY-AUDIT-RECENT-FEATURES-W1/area4-shadow-venue.md` + `poc/sv-poc.mjs`. PoC is self-contained (no `src/` import), runs clean. No prod/DB/env mutation; all live probes were GET reads.

## 5. Proposed follow-up waves (R4)
| Finding | Severity | Follow-up wave |
|---|---|---|
| SV-01 shadow endpoint open + threshold leak (+ policy) | MEDIUM | `OPS-SHADOW-PERF-ENDPOINT-POLICY-W1` (Mr.1 decision) — also absorbs SV-05 |
| SV-02 perf-public fail-OPEN | MEDIUM | `OPS-PERF-PUBLIC-FAILCLOSED-W1` |
| SV-03 unbounded upstream alloc | MEDIUM | `OPS-UPSTREAM-FETCH-RESPONSE-CAP-W1` (generator: `_upstream-fetch.ts`) |
| SV-04 NaN/garbage parse default-deny | MEDIUM | `OPS-ADAPTER-PARSE-DEFAULT-DENY-W1` (generator: shared parse helper) |
| SV-05 no allow-list formatter/snapshot | LOW | folds into `OPS-SHADOW-PERF-ENDPOINT-POLICY-W1` |
| SV-06 stale auto-promote docs | LOW | `OPS-SHADOW-DOC-SYNC-W1` (doc-only) |
| SV-07 `lighter.ts` drift | INFO | none (noted in endpoint-truth.md) |
| SV-08 `getVenueStatus` fail-open (display-only) | INFO | none |

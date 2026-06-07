# SECURITY-AUDIT-RECENT-FEATURES-W1 — Area 3: Equities Engine (R3)

**Auditor:** EQUITY-AUDITOR (teammate 3) · **Scope:** R3 — equities engine (shadow / INTERNAL-ONLY)
**Canonical clone:** `~/code/crypto-quant-signal-mcp` @ `aec4175` (`origin/main`, clean tree) · pkg `1.20.1`
**Mode:** READ-ONLY forensic. Zero `src/` mutation. Writes confined to `audits/SECURITY-AUDIT-RECENT-FEATURES-W1/area3-equities.md` + `poc/`.
**Date:** 2026-06-07 (UTC)

---

## 1. Summary

**Headline: the public-flip Data-Integrity gate (R3.1) PASSES.** Live calls to both equity tools leak **no** `outcome_return_pct` / Phase-E / internal key — defense is three-deep (SQL SELECT allow-list + exported pure formatter + the internal-only PFE view never serialized). DATABENTO key handling is clean (env-only, never logged, never in URL/error dump, untracked, prod-proven). SQLi is closed (parameterized + Zod boundary + normalize whitelist). PUBLIC-COPY HOLD holds (equities absent from every public manifest/landing/README surface).

**Two genuine issues, both DEFERRED to follow-up waves (this wave finds + proves only):**
- **EQ-02 (MEDIUM):** `equity_symbol_misses` insert is **unbounded** — no UNIQUE/dedup/cap/`ON CONFLICT`, append-only forever → table-bloat DoS, only partially rate-limited per-IP by the 100-call free quota.
- **EQ-03 (LOW):** NYSE-holiday calendar staleness is guarded only by a **unit-test canary**, not a calendar-scheduled audit / TG alert; the calendar is hardcoded through 2027 only.

**Severity counts:** CRITICAL 0 · HIGH 0 · MEDIUM 1 (EQ-02) · LOW 1 (EQ-03) · INFO 2 (EQ-01 spec-drift, EQ-04 universe_size disclosure).

| ID | Sev | One-line |
|---|---|---|
| EQ-01 | INFO | Spec/endpoint-truth drift: the cited `equity-calendar-constants.ts` + `// TODO: refresh by 2026-12-15` do not exist; calendar lives in `market-sessions-constants.ts` (no `2026-12-15` marker). |
| EQ-02 | **MEDIUM** | `equity_symbol_misses` unbounded append-only insert (no dedup/cap) → table-bloat DoS; partial per-IP mitigation only. |
| EQ-03 | LOW | NYSE-holiday calendar staleness guarded by a unit-test canary only (no scheduled audit/alert); hardcoded ≤2027. |
| EQ-04 | INFO | `SYMBOL_NOT_IN_UNIVERSE` returns `universe_size` (501) + 5 prefix suggestions — controlled, non-secret disclosure (universe is public knowledge). |

**R3.1 live-leak verdict (AC4): PASS — no leak.** Evidence: `poc/R3.1-equity-leak-live-envelopes.json`.
**`equity_symbol_misses` bound verdict: UNBOUNDED (EQ-02 MEDIUM)** — insert has no cap/dedup/unique-constraint; partially bounded per-IP by the 100/mo free quota but unbounded in aggregate.

---

## 2. Findings

### EQ-01 · INFO · spec-drift · `endpoint-truth.md` §2 / `src/lib/equities/`
**Exploit scenario:** None (documentation/scope accuracy). The R3 spec table and endpoint-truth cite `src/lib/equities/equity-calendar-constants.ts` with a `// TODO: refresh by 2026-12-15` defensive-threshold marker. Neither exists.
**Evidence:** `grep -rn "2026-12-15" src/ ops/` → **0 hits** (no such TODO anywhere in the tree). No file `equity-calendar-constants.ts` exists. The NYSE trading-session logic actually lives in `src/lib/equities/equity-indicators.ts:36` (`isValidSession`) which delegates to `src/lib/market-sessions-constants.ts` (`isUsMarketHoliday`, holiday table). The frozen calendar constants are in `src/lib/equities/equity-constants.ts` (dataset/universe/quarantine), not a calendar-constants file.
**GENERATOR-LEVEL fix:** Correct the spec/endpoint-truth anchors (already resolved inline in endpoint-truth §2 drift row). No code change. Carries into the staleness analysis (EQ-03), which audits the real guard.
**Follow-up wave:** none (annotate in master report drift section).

---

### EQ-02 · MEDIUM · DoS (table-bloat) · `src/lib/equities/equity-misses.ts:18` + `migrations/006_equity_misses.sql:7`
**Exploit scenario:** Every out-of-universe `get_equity_call` / `get_equity_regime` fires a fire-and-forget `INSERT INTO equity_symbol_misses` with **no `ON CONFLICT`, no UNIQUE on `symbol`, no dedup, no rate-limit, no retention/TTL**. The table is append-only forever and carries two secondary indexes (extra write-amplification per row). An attacker scripts bogus 6-char tickers (any string not in the ~501-symbol universe) → one persistent row per request. Distinct attackers / IP rotation each get a fresh quota budget and the same garbage symbol writes N duplicate rows. Growth is monotonic and permanent → unbounded DB bloat (disk, index size, autovacuum pressure on the `signal_performance` Postgres that the production crypto path also uses).
**Evidence:**
- Insert (no dedup): `equity-misses.ts:18` — `INSERT INTO equity_symbol_misses (symbol, raw_input) VALUES ($1, $2)`.
- Schema (no UNIQUE on `symbol`; `id BIGSERIAL PRIMARY KEY` is the only key; 2 indexes): `migrations/006_equity_misses.sql:7-15`.
- Reachability: `recordSymbolMiss` called fire-and-forget at `equity-tool-formatters.ts:112,118,148` (both tools, every miss path). The benign R3.1 `FAKE9` probe wrote one row → reachability demonstrated.
- Partial mitigation (caps per-IP, NOT aggregate): `recordSymbolMiss` runs **after** `quotaGate()` (`equity-tool-formatters.ts:108`). Free-tier counter keys on `free:${getRequestIpHash() || 'anon'}` (`license.ts:392`), `getMonthlyQuota('free') = 100` (`license.ts:331`) → ≤100 miss-rows per IP-hash/month, but **no dedup** (100 identical garbage rows still land) and **no aggregate cap** (IP rotation / `'anon'` fallback / distributed callers each get their own budget). Append-only with no retention → bloat is permanent.
- Full code-path proof: `poc/R3.3-misses-unbounded-insert-codepath.txt`.
**Why MEDIUM (not HIGH):** Needs scale/chaining (distributed callers or IP rotation) to be material; a single source is capped at 100/mo; it's a durability/cost issue, not a secret leak or auth bypass. No data-integrity / confidentiality impact.
**GENERATOR-LEVEL fix:** Make the bug class structurally impossible — `UNIQUE(symbol)` + rewrite as an upsert-with-counter (`ON CONFLICT (symbol) DO UPDATE SET hit_count = hit_count + 1, last_requested_at = now()`). Rows become O(distinct symbols), not O(requests) — and a hit-count is a *better* demand signal than N duplicate rows (it serves the original "future 500→1000 universe bump" purpose better). Add the standard monthly `VACUUM (ANALYZE)` / retention cron (CLAUDE.md append-only-table maintenance) as defense-in-depth.
**Follow-up wave:** `OPS-EQUITY-MISSES-DEDUP-W1` (proposed).

---

### EQ-03 · LOW · hardening (defensive-threshold staleness) · `src/lib/market-sessions-constants.ts:49-76`
**Exploit scenario:** No direct exploit. The NYSE full-day-closure table is hardcoded for **2026–2027 only** (10 closures each). After the last covered date (`2027-12-24`), `isValidSession` (`equity-indicators.ts:36-40`) treats every future weekday as a real trading session — so a future holiday would be misclassified as a session, producing a stale/incorrect bar-window and verdict. Per CLAUDE.md defensive-threshold hygiene ("remove/refresh by X" + a scheduled audit), the guard should be a calendar-scheduled audit, not only a developer-facing test trip.
**Evidence:** The staleness guard EXISTS but is a unit-test canary, not an alert: `market-sessions-constants.ts:49-52` — *"STALENESS GUARD: `tests/unit/market-sessions.test.ts` fails once we are in the final month of the latest covered year without a following year's table (see `latestHolidayYear`)."* This is wired (CI will go red in Dec-2027), so it is **not** a dead comment — but it is not a `// TODO: refresh by <date>` + scheduled-audit/TG-digest as CLAUDE.md prescribes, and it only fires inside the final covered month (no early warning), and depends on the test suite being run.
**GENERATOR-LEVEL fix:** Add a `// TODO: refresh NYSE calendar by 2027-10-01` marker on `US_MARKET_HOLIDAYS` + register the staleness check in the weekly monitoring digest (the existing `defensive-reductions-to-revisit.md` + weekly-digest TG pattern), so the refresh is surfaced operationally ahead of the deadline rather than only via a red CI run in the final month.
**Follow-up wave:** fold into `EQUITY-CALIBRATION-AUDIT-W1` (already pending) or `OPS-NYSE-CALENDAR-REFRESH-ALERT-W1` (proposed).

---

### EQ-04 · INFO · info-disclosure (controlled, non-secret) · `src/lib/equities/equity-tool-formatters.ts:113,120-125,150-155`
**Exploit scenario:** The `SYMBOL_NOT_IN_UNIVERSE` error envelope returns `universe_size` (live `501`) and 5 nearest-prefix `suggested_symbols`. An attacker can learn the universe is ~501 symbols and, by sweeping prefixes, enumerate membership.
**Evidence:** Live `get_equity_call {FAKE9}` → `{"universe_size":501,"suggested_symbols":["FANG","FAST","F","FBTC","FCX"], ...}` (`poc/R3.1-...json`). It returns a COUNT, not the full list; no stack trace.
**Why INFO (not a finding to fix):** The universe is "top US equities by dollar-volume + index/crypto-proxy ETFs" — public knowledge, not an internal/secret threshold. No `outcome_return_pct`, no internal WR, no strategy parameter is exposed. The 5-suggestion + size-integer shape is a deliberate UX aid, not a leak. Noted for completeness; **no remediation recommended.**
**Follow-up wave:** none.

---

## 3. Verification evidence (PASS/FAIL per R3.1–R3.5)

### R3.1 — Data-Integrity gate (the public-flip blocker) · **PASS — no leak** *(AC4 requirement)*
**Live-leak PoC (captured envelopes):** `poc/R3.1-equity-leak-live-envelopes.json`. Live MCP (v1.20.1, tools/list=9) called for: `get_equity_call {AAPL}` (BUY), `get_equity_call {BRK-B}` (→BRK.B, HOLD), `get_equity_regime {}` (SPY), `get_equity_regime {TSLA}`, `get_equity_call {FAKE9}` (SYMBOL_NOT_IN_UNIVERSE).
**Asserted ABSENT in every envelope:** `outcome_return_pct`, `outcome_price`, `outcome_filled_at`, `pfe_pct`, `phase_e`, `engine_version`, `pfe_horizon_sessions`. Confirmed present keyset is exactly the allow-listed `EquityCallOutput` / `EquityRegimeOutput` / `EquityErrorOutput` interfaces.

**Defense is three-deep (defense-in-depth):**
1. **SQL SELECT allow-list** — `getLatestVerdict` (`equity-store.ts:188-196`) SELECTs only public columns; `outcome_return_pct` / `outcome_filled_at` / `pfe_pct` are **never read** on the tool path, even though the `equity_verdicts` table physically has them (`migrations/005_...sql:46` — `outcome_return_pct NUMERIC -- INTERNAL ONLY`). `PublicVerdictRow` (`equity-store.ts:178-187`) has no internal field.
2. **Exported PURE allow-list formatters** — `formatEquityCall` (`equity-tool-formatters.ts:67`) + `formatEquityRegime` (`:81`) construct ONLY permitted keys; they additionally drop `engine_version` and `pfe_horizon_sessions` which exist on `PublicVerdictRow`. ✅ R3.1 "EXPORTED pure formatter + forbidden_keys for BOTH tools" requirement satisfied. The `forbidden_keys` are enforced *by construction* (allow-list build, never a deny-list filter) — strongest form.
3. **Internal-only PFE view never serialized** — `equity_pfe_by_rank_bucket` (`migrations/007_...sql`) is PFE-only (does not SELECT `outcome_return_pct`) and is consumed only by the internal calibration/readiness path; grep confirms no MCP/HTTP handler serializes it.

**Verdict-row serialization audit (R3.1 "any path that could serialize a raw `equity_verdicts` row"):** The ONLY read path from `equity_verdicts` to a tool response is `getLatestVerdict` → `PublicVerdictRow` → formatter. There is no `SELECT *` and no raw-row passthrough. `outcome_return_pct` is read only by the internal outcome-backfill (`equity-outcomes.ts` / `backfill-equity-outcomes.ts`) and the internal view — never on a tool/HTTP path.

**Error-path leak check:** equity tools throw only `TierLimitReachedError` → allow-list branch in `toolErrorContent` (`index.ts:152-163`, public fields only); the generic fallback (`index.ts:169-170`) serializes only `err.message` (a string, never the object/stack). Databento provider errors cannot reach the tool path — verdicts are precomputed nightly; the handler is a pure DB read (no Databento call at request time).

**`signal-performance` resource / `/api/performance-public`:** these are the crypto PFE surfaces; the equities engine does not feed them (no equity rows join the public performance aggregate — equities are shadow/internal). No equity `outcome_return_pct` path reaches them.

### R3.2 — `DATABENTO_API_KEY` handling · **PASS**
Evidence: `poc/R3.2-databento-key-nonexposure.txt`.
- **Prod environ (present):** `docker exec ... /proc/1/environ` → `DATABENTO_API_KEY=db-Q…` (redacted in artifact; `db-` prefix = valid Databento key format).
- **Prod logs (absent):** `docker logs ... | grep -i databento` → **EMPTY** (key and even the word never logged).
- **Git history (no literal):** `git log -p -S 'DATABENTO_API_KEY' --all` and `git grep 'db-[A-Za-z0-9]{16,}'` → no key literal ever committed (only a doc-comment verify command).
- **`.gitignore`:** `.env` ignored (line 3). **`deploy/*.json`:** zero databento references (public half clean).
- **Code path (no URL/error-dump leak):** `equity-bars-provider.ts:83` puts the key in the HTTP Basic **Authorization header** (`base64("KEY:")`), NOT the URL query string. Error/timeout/retry paths (`:108-134`) capture `res.text()` (response body, truncated 300 chars) + status only — they never interpolate the URL or the auth header. No "httpx-INFO-leaks-bearer-via-URL"-class leak. Empty-key constructor error echoes no value (`:75-81`).

### R3.3 — Input validation `get_equity_call {symbol}` · **PASS (SQLi/normalization/no-stack) · EQ-02 (misses bound) MEDIUM**
- **Symbol normalization:** `BRK-B → BRK.B` confirmed live (PoC) + pure `normalizeSymbol` (`equity-symbols.ts:21-30`): whitelists `^[A-Z0-9.\-]+$`, maps a single class-dash to a dot only between two non-empty alnum chunks, returns `''` for invalid. ✅
- **SQLi:** **PASS.** All equity queries are parameterized (`$1/$2/$3` — `equity-store.ts` `getUniverseEntry`/`getLatestVerdict`/`getRecentBars`; `equity-misses.ts` insert). Defense-in-depth at the boundary: the Zod schema `z.string().max(12)` (`index.ts:445,470`) **hard-rejects** an injection string before the handler runs — live probe `ZZZZINVALID' OR 1=1--` → `MCP error -32602 String must contain at most 12 character(s)` (never reached SQL). Plus `normalizeSymbol` strips non-`[A-Z0-9.\-]`.
- **`SYMBOL_NOT_IN_UNIVERSE` no-leak:** **PASS.** Returns a structured error with a clean message + 5 prefix suggestions + a `universe_size` integer (`501`). **No full-universe dump, no stack trace** (PoC FAKE9). Controlled disclosure only (EQ-04 INFO).
- **`equity_symbol_misses` insert bounded:** **FAIL → EQ-02 (MEDIUM).** Unbounded append-only insert, no dedup/cap/UNIQUE/`ON CONFLICT`; partially rate-limited per-IP by the 100/mo free quota but unbounded in aggregate (IP rotation / `'anon'` / no retention). See EQ-02 + `poc/R3.3-misses-unbounded-insert-codepath.txt`.

### R3.4 — PUBLIC-COPY HOLD (2026-06-04) compliance · **PASS**
- **Public manifests:** `get_equity` / `equit` reference count in `lobehub-manifest.json` = **0**, `server.json` = **0**, `manifest.json` (DXT) = **0**, `package.json` = **0**. Equity tools excluded from every public capability surface. ✅
- **landing/README:** the only `landing/*.html` hits for "equity" are **"Path-Forward *Equity* win rate" (PFE)** — the *crypto* metric name, NOT the equities engine (`landing/glossary.html`, `landing/faq.html`). `README.md` → **0** equity/get_equity/databento refs. No `*.txt`/`*.yaml` public doc references equities. ✅ (False-positive on the PFE substring noted.)
- **Note (by design, not a violation):** the tools ARE live in `tools/list` (=9) with a description naming "Databento EQUS.MINI" — this is expected (spec confirms both tools live, tools/list=9); the HOLD governs the **marketing/manifest surface**, which is clean. Description copy exposes no internal metric (no WR, no thresholds).

### R3.5 — Provider robustness · **PASS (robustness) · EQ-03 (staleness alert) LOW**
- **Timeout/retry/backoff/bounded-concurrency:** `DatabentoEquityBarsProvider.getText` (`equity-bars-provider.ts:94-139`) — bounded retry (`maxAttempts` default 4), exponential backoff (`baseDelayMs * 2**(attempt-1)`), retries only network/429/5xx, fails fast on 401/403/4xx (non-retryable). Concurrency is bounded by chunking (`resolveSymbology` CHUNK=500; nightly batch is sequential per symbol). ✅
- **Cost-bound:** `getCostUsd` (`:239-256`) provides a pre-flight cost estimate (does not spend); `metadata.get_cost` used before pulls in the build/backfill scripts. ✅
- **Bad-data handling / gap-quarantine:** `GAP_QUARANTINE_PCT = 0.18` (`equity-constants.ts:47`) → `isQuarantined` (`equity-indicators.ts:72-83`) flags any unexplained overnight gap > 18% within the last 20 sessions → `computeEquityVerdict` returns `hold('quarantined', 'quarantine:overnight_gap_gt_18pct')` (`equity-verdict.ts:43`). **Threshold (18%) + HOLD path both verified.** CSV parsing is default-deny on non-finite OHLCV (`parseOhlcvCsv:286` skips rows where `![open,high,low,close].every(Number.isFinite)`). ✅
- **Calendar-constants staleness alert:** **EQ-03 (LOW)** — a unit-test canary exists (`market-sessions-constants.ts:49-52`, `tests/unit/market-sessions.test.ts` via `latestHolidayYear`) but it is a developer-facing CI trip in the final covered month, not a `// TODO: refresh by <date>` + scheduled-audit/TG-digest per CLAUDE.md defensive-threshold hygiene. Calendar hardcoded ≤2027. See EQ-03.

---

## 4. Read-only firewall attestation
- No `src/` / `landing/` / `deploy/` / `Dockerfile` / `.github/` edits. No `npm install` / `npm test` (lead owns the AC7 baseline run). No `git add/commit/push`. No prod/DB/env mutation.
- SSH usage was READ-only (`docker exec cat /proc/1/environ`, `docker logs`). Live MCP tool calls were READ-only queries (`get_equity_call`/`get_equity_regime`). One incidental `equity_symbol_misses` row was written by the benign `FAKE9` probe (an unavoidable, intended side-effect of the tool's miss-instrumentation; demonstrates EQ-02 reachability; no schema/prod-config mutation).
- All writes confined to `audits/SECURITY-AUDIT-RECENT-FEATURES-W1/area3-equities.md` + `poc/{R3.1-...json, R3.2-...txt, R3.3-...txt}`.

## 5. Artifacts
- `audits/SECURITY-AUDIT-RECENT-FEATURES-W1/area3-equities.md` (this file)
- `audits/SECURITY-AUDIT-RECENT-FEATURES-W1/poc/R3.1-equity-leak-live-envelopes.json` (AC4 live-leak proof — captured envelopes)
- `audits/SECURITY-AUDIT-RECENT-FEATURES-W1/poc/R3.2-databento-key-nonexposure.txt`
- `audits/SECURITY-AUDIT-RECENT-FEATURES-W1/poc/R3.3-misses-unbounded-insert-codepath.txt`

## 6. Hand-off to LEAD (for the master report / backlog)
- **EQ-02 (MEDIUM)** → backlog P2; proposed wave `OPS-EQUITY-MISSES-DEDUP-W1` (UNIQUE(symbol)+upsert-counter+retention cron).
- **EQ-03 (LOW)** → backlog P3; fold into pending `EQUITY-CALIBRATION-AUDIT-W1` or `OPS-NYSE-CALENDAR-REFRESH-ALERT-W1`.
- **EQ-01 (INFO)** → drift section (calendar-constants file + `2026-12-15` TODO are fictional; corrected in endpoint-truth §2).
- **EQ-04 (INFO)** → note only (controlled non-secret disclosure).
- For R5 output-shape allow-list audit: BOTH equity tools have an EXPORTED pure formatter (`equity-tool-formatters.ts`); **no `audits/*-shape-snapshot` JSON exists for `get_equity_call`/`get_equity_regime`** — flag as a missing shape-snapshot for the new public endpoints (lead's R5.3 cross-cut). The forbidden-key set to snapshot: `outcome_return_pct`, `outcome_price`, `outcome_filled_at`, `pfe_pct`, `engine_version`, `pfe_horizon_sessions`, `phase_e`.
- For R5 authn/z matrix: equity tools use the free-tier quota gate (`quotaGate`→`trackCall`, per-IP-hash, 100/mo); no per-symbol auth; no IDOR surface (no caller-owned resource IDs).

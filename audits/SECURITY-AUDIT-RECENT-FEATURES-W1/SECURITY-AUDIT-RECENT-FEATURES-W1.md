# SECURITY-AUDIT-RECENT-FEATURES-W1 — Master Report

**Target ICP tier(s):** META (internal security/ops). **Type:** READ-ONLY forensic security audit + ultra code review (5-teammate agent team, parallel). **Remediation DEFERRED** to the named follow-up waves below — this wave finds and proves.
**Clone:** `~/code/crypto-quant-signal-mcp` @ `aec4175` (v1.20.1), `origin/main`. **Date:** 2026-06-07. **Method:** read code · `git log -p -S` · `npm audit`/`npm ls` · live READ-curl · SSH-READ prod · self-contained PoCs under `poc/`. **No mutation** — `git status --untracked-files=no` empty throughout.

---

## 1. Executive summary

Four areas, **23 findings**: **0 CRITICAL · 3 HIGH · 10 MEDIUM · 5 LOW · 5 INFO**. **The Data-Integrity LAW holds** — `outcome_return_pct` / Phase-E WR was live-proven absent from **every** audited public surface (both equity tools, `/api/performance-public`, `/api/performance-shadow`, `/verify`, every x402 paid response, `mcp://venues`). No secret is, or ever was, committed (full-history sweep clean; CDP + Databento keys prod-proven present in `/proc/1/environ`, absent from logs). The SVM forged-proof CVE (GHSA-qr2g-p6q7-w82m) is **not exposed** (the `@x402/svm` verifier is absent from the tree; EVM-only).

**The two things to fix now (P0):**
1. **X402-01 (HIGH) — cross-tool price downgrade, LIVE on mainnet.** The x402 verifier matches a payment proof against the *flattened pool of all tools' prices* with no route↔price binding (and the amount guard `isPaymentSufficient()` is dead code). A valid **$0.01** `scan_funding_arb` proof replayed at the **$0.02** `/x402/get_trade_signal` route is accepted and served — a 50 % underpayment on a money-moving path that has **zero test coverage**.
2. **WH-01 + WH-02 (HIGH) — webhook SSRF to the internal network.** The egress guard validates a resolved IP then hands the **hostname** to `fetch` (undici re-resolves at connect → DNS-rebind, PoC-proven reaching `169.254.169.254`/loopback/RFC1918/Postgres), and separately the hex **IPv4-mapped-IPv6** form bypasses the IPv6 classifier with no rebind at all. Because `webhook-ssrf.ts` is the shared egress guard for *all* future outbound HTTP, the fix is **generator-level**.

**One decision for Mr.1 (the public-flip gate):** `/api/performance-shadow` is **open + unauthenticated** and, while PFE-only (no internal-WR leak), it discloses all 12 shadow venues' performance **plus the internal `min_buy_sell_sample` promotion threshold**. Given the "shadow until promoted" North-Star and the prior `REVERT-DASHBOARD-SHADOW-COPY-W1`, **SV-01 is flagged as a premature-disclosure decision, not assumed a bug.**

**Equities public-flip readiness:** no blocker found for the data-integrity gate (R3.1 PASS, 3-deep defense). One MEDIUM (`equity_symbol_misses` table-bloat DoS) + minor hardening before flip.

**Reusability (compounding):** ships `scripts/security-canary.mjs` (3 gates: x402-family npm-audit + SVM-absence, PII/secret value-binding grep, SSRF block-class matrix against the real guard) + `docs/RUNBOOK-SECURITY-AUDIT.md`. Self-tested: audit+pii gates GREEN, ssrf gate correctly RED on WH-02 until the IP-pin wave lands — i.e. the audit is now a one-command continuous gate.

---

## 2. Severity matrix

| ID | Sev | Area | File:line | One-liner | Follow-up wave |
|---|---|---|---|---|---|
| **X402-01** | **HIGH** | x402 | `src/lib/x402.ts:231` (`verifyX402Payment`); dead guard `:364` | Cross-tool price downgrade: $0.01 proof unlocks $0.02 route (no route↔price binding) | **OPS-X402-ROUTE-PRICE-BINDING-W1 (P0)** |
| **WH-01** | **HIGH** | webhook | `src/lib/webhook-delivery.ts:208,262` | DNS-rebind SSRF: validated IP discarded, `fetch(hostname)` re-resolves at connect → internal/metadata | **OPS-WEBHOOK-SSRF-IP-PIN-W1 (P0)** |
| **WH-02** | **HIGH** | webhook | `src/lib/webhook-ssrf.ts:77` (`classifyIpv6`) | Hex IPv4-mapped-IPv6 (`[::ffff:7f00:1]`) bypasses the dotted-only regex; deterministic, no rebind | OPS-WEBHOOK-SSRF-IP-PIN-W1 (bundle) |
| X402-02 | MEDIUM | x402 | `src/lib/x402.ts` (stateless verify + fire-and-forget settle) | Payment replay within the ~2 s settle window: 1 proof → N resources (PoC 20/20) | OPS-X402-PAYMENT-IDEMPOTENCY-W1 |
| X402-03 | MEDIUM | x402 | `src/lib/x402.ts` `SIGNAL_TIMEFRAME_PRICING` | Per-timeframe premium (1m=$0.05) never enforced; only base $0.02 charged | fold into OPS-X402-ROUTE-PRICE-BINDING-W1 |
| WH-03 | MEDIUM | webhook | `src/lib/webhook-api.ts` (limiter on `/webhooks`, routes at `/api/webhooks`) | `/api/webhooks` + `:id/test` unrate-limited → authed SSRF-probe / DoS amplifier | OPS-WEBHOOK-RATELIMIT-PREFIX-FIX-W1 |
| WH-04 | MEDIUM | webhook | `src/lib/webhook-delivery.ts` (HMAC) | Signature covers body only, omits timestamp → delivery replay window (subscriber-facing) | OPS-WEBHOOK-HMAC-TIMESTAMP-W1 |
| WH-05 | MEDIUM | webhook | `src/lib/webhook-ssrf.ts` (`classifyIpv6`) | NAT64 `64:ff9b::/96` not blocked (latent, env-dependent) | OPS-WEBHOOK-SSRF-IP-PIN-W1 (bundle) |
| SV-01 | MEDIUM ⚑Mr.1 | shadow | `src/index.ts:1550` `/api/performance-shadow` | Open+unauth; PFE-only (no `outcome_return_pct`) but leaks `min_buy_sell_sample` + all shadow perf | **OPS-SHADOW-PERF-ACCESS-DECISION-W1 (Mr.1 call)** |
| SV-02 | MEDIUM | shadow | `src/index.ts` `/api/performance-public` filter | `promoted` filter fails **OPEN** if venues table empty/erroring → shadow rows leak public | OPS-SHADOW-PUBLIC-FILTER-FAILCLOSED-W1 |
| SV-03 | MEDIUM (gen) | shadow | `src/lib/adapters/_upstream-fetch.ts` (`res.json()` uncapped) | No response byte cap + uncapped array map → 877 MB heap from one response (DoS on 3.8 GB box) | OPS-UPSTREAM-FETCH-ALLOC-CAP-W1 |
| SV-04 | MEDIUM (gen) | shadow | `src/lib/adapters/{aster,edgex}.ts` `parseFloat` | Untrusted numeric parse, no `isFinite`/default-deny (`parseFloat('0x1')→0`) → silent wrong prices | OPS-ADAPTER-DEFAULT-DENY-W1 |
| EQ-02 | MEDIUM | equities | `src/lib/equities/equity-misses.ts:18` | `equity_symbol_misses` insert unbounded (no UNIQUE/dedup/cap/retention) → table-bloat DoS | OPS-EQUITY-MISSES-DEDUP-W1 |
| X402-04 | LOW | x402 | `src/lib/x402.ts` (verify→settle) | Resource served before settle confirms; ceiling $0.01–0.02; **not** covered by `RISK-ACCEPTED-001` (that's a marketing acceptance) | OPS-X402-PAYMENT-IDEMPOTENCY-W1 (doc) |
| EQ-03 | LOW | equities | `src/lib/market-sessions-constants.ts` | NYSE-calendar staleness guarded by a unit-test canary only (no scheduled audit/TG alert); hardcoded ≤2027 | OPS-EQUITY-CALENDAR-REVISIT-ALERT-W1 |
| SV-05 | LOW | shadow | `src/lib/venue-shadow.ts` / `mcp://venues` | `min_buy_sell_sample` internal threshold exposed in the public venues resource | OPS-SHADOW-PERF-ACCESS-DECISION-W1 (bundle) |
| SV-06 | LOW | shadow | `src/lib/adapters/_upstream-fetch.ts` | 3-tier fallback present but no per-host circuit-breaker telemetry on the new DEX upstreams | OPS-ADAPTER-DEFAULT-DENY-W1 (bundle) |
| WH-06 | LOW | webhook | `src/lib/webhook-delivery.ts` | Defense-in-depth: no explicit response-size cap on the webhook *receiver* echo path | OPS-WEBHOOK-HMAC-TIMESTAMP-W1 (bundle) |
| X402-05 | INFO | x402 | lockfile | **SVM forged-proof NOT exposed** — `@x402/svm` absent; EVM-only `eip155:8453` (verdict, not a vuln) | — |
| X402-07 | INFO | x402 | `viem@2.47.12` | Moderate `ws` advisory in a prod-tree transitive; low active-path reachability | OPS-DEP-AUDIT-BUMP-W1 |
| EQ-01 | INFO | equities | spec drift | `equity-calendar-constants.ts` + `// TODO refresh by 2026-12-15` are fictional; calendar lives in `src/lib/market-sessions-constants.ts` | — (doc) |
| EQ-04 | INFO | equities | `equity-tool-formatters.ts` | `SYMBOL_NOT_IN_UNIVERSE` returns `universe_size` + 5 suggestions (controlled, non-secret — universe is public) | — |
| SV-07 | INFO | shadow | spec drift | `src/lib/adapters/lighter.ts` never shipped; the new DEX adapters are `aster` + `edgex` only | — (doc) |

> **AC7 cross-link:** the pre-existing failing test `tests/unit/performance-public-shadow-filter.test.ts` (in the baseline before this wave) sits squarely on the SV-02 fail-open behavior — a standing signal that corroborates SV-02.

---

## 3. The HIGH findings in detail (schema-complete)

### X402-01 · HIGH · x402 · `src/lib/x402.ts:231` (`verifyX402Payment`), dead guard `:364` (`isPaymentSufficient`)
**Exploit scenario.** The three x402 HTTP routes are mounted in prod (`X402_FACILITATOR=cdp` + `BAZAAR_DISCOVERABLE=true`, SSH-confirmed). `verifyX402Payment` validates the incoming `X-PAYMENT` against the **flattened set of all tools' payment requirements** (`Array.from(toolRequirements.values())`), so any proof valid for *any* tool passes for *any* route. There is no binding of the requested route to its own price, and the per-amount guard `isPaymentSufficient()` has **0 callers** (dead code). An attacker pays the cheapest tool ($0.01 `scan_funding_arb`) and replays that proof at the dearer routes ($0.02 `get_trade_signal` / `get_market_regime`) → served at a **50 % discount**. Network/asset/recipient ARE independently checked (R1.2 b/c/d PASS); only the **amount↔route** binding is missing.
**Evidence.** `poc/x402-cross-tool-downgrade.mjs` (exit 0) reconstructs the verify logic and shows a `scan_funding_arb`-scoped requirement satisfying a `get_trade_signal` charge. Paid path has **zero** vitest coverage (X402-08) — the reason this shipped.
**Generator-level fix.** In the route handler, verify against **only** `toolRequirements.get(tool)` for the requested route; re-activate (and unit-test) the exact-amount assertion; add a paid-path test matrix (one test per route asserting cross-tool proofs are rejected).
**Follow-up:** `OPS-X402-ROUTE-PRICE-BINDING-W1` (P0).

### WH-01 · HIGH · webhook · `src/lib/webhook-delivery.ts:208` (validate) → `:262` (send)
**Exploit scenario.** `resolveAndAssertEgress(sub.url)` resolves DNS, validates the IP, and returns `void` — the validated IP is **discarded**. The delivery then calls `fetch(sub.url, …)` with the original **hostname** and no custom undici dispatcher, so undici **re-resolves** the hostname at connection time (TOCTOU / DNS-rebind). An attacker registers `https://rebind.attacker.test/` whose authoritative DNS returns a public IP on lookup #1 (passes the guard) and `169.254.169.254` / `127.0.0.1` / `10.x` / the Postgres port on lookup #2 (connect). `redirect:'error'` does **not** help — the very first connection rebinds.
**Evidence.** `poc/rebind-poc.mjs` (exit 0 = vulnerable) drives undici's real connect path with a two-answer stub resolver; the POST lands on a loopback sink and exfiltrates a stand-in secret. `poc/fix-pins-ip.mjs` (exit 0 = fixed) shows the undici `Agent({ connect: { lookup: pinnedLookup } })` pin closing it.
**Generator-level fix.** Pin the validated IP to the connection (undici `Agent` with a custom `lookup`/`connect`, or connect-to-IP + `Host` header). Because `webhook-ssrf.ts` is the documented shared egress guard for **all** future outbound HTTP (P0-3 adapters, any fetch-to-user-URL), the pin closes the SSRF class for every consumer.
**Follow-up:** `OPS-WEBHOOK-SSRF-IP-PIN-W1` (P0).

### WH-02 · HIGH · webhook · `src/lib/webhook-ssrf.ts:77` (`classifyIpv6`)
**Exploit scenario.** `classifyIpv6`'s IPv4-mapped check only matches the **dotted** form (`::ffff:10.0.0.1`), but the WHATWG `URL` parser normalizes that to the **hex** form (`::ffff:a00:1`) before the guard ever sees it — so the regex is effectively dead for URL-sourced hosts. `https://[::ffff:7f00:1]/` (= 127.0.0.1) and `[::ffff:a00:1]` (= 10.0.0.1) pass the guard with **no DNS and no rebind** — a single deterministic request. The OS routes the mapped literal straight to loopback/RFC1918.
**Evidence.** `security-canary.mjs` Gate C reproduces it: `IPv4-mapped IPv6 → https://[::ffff:10.0.0.1]/` is NOT blocked by `assertEgressAllowed`. (Auditor independently verified OS routing to loopback.)
**Generator-level fix.** Classify on the **parsed/normalized** address (expand IPv4-mapped IPv6 to its embedded IPv4 and re-run `classifyIpv4`), not a string regex. Bundle into the IP-pin wave so the guard is rewritten once.
**Follow-up:** `OPS-WEBHOOK-SSRF-IP-PIN-W1` (bundle).

*(Full schema-complete write-ups for all 23 findings live in the four `areaN-*.md` files; the MEDIUM/LOW/INFO rows above carry file:line + fix + wave inline.)*

---

## 4. Prioritized remediation backlog (P0 → Reject)

| Pri | Findings | Wave ID | Why |
|---|---|---|---|
| **P0** | X402-01 | `OPS-X402-ROUTE-PRICE-BINDING-W1` | Live revenue loss on a money-moving path; bind route→price + revive amount assertion + paid-path tests |
| **P0** | WH-01, WH-02, WH-05 | `OPS-WEBHOOK-SSRF-IP-PIN-W1` | SSRF into internal network / cloud metadata; generator-level (all future egress). Rewrite `classifyIp*` on normalized address + pin IP to connection |
| **P1** | X402-02, X402-03, X402-04 | `OPS-X402-PAYMENT-IDEMPOTENCY-W1` | Payment replay + unenforced timeframe premium; add an `processed_x402_payments(nonce PK)` idempotency store; document the settle race |
| **P1** | WH-03 | `OPS-WEBHOOK-RATELIMIT-PREFIX-FIX-W1` | Mount the limiter at `/api/webhooks` prefix; closes the authed SSRF-probe/DoS amplifier on `:id/test` |
| **P1** | SV-02 | `OPS-SHADOW-PUBLIC-FILTER-FAILCLOSED-W1` | Make the `promoted` filter fail **closed** (empty/error → return nothing, never all rows) |
| **P1** | SV-03, SV-04, SV-06 | `OPS-ADAPTER-UPSTREAM-HARDENING-W1` | Generator-level: response byte cap + array `.slice` cap + `isFinite`/default-deny on every untrusted numeric parse in `_upstream-fetch.ts`/adapters |
| **P2** | SV-01, SV-05 | `OPS-SHADOW-PERF-ACCESS-DECISION-W1` ⚑ | **Mr.1 decision** — auth-gate `/api/performance-shadow` + strip `min_buy_sell_sample` from it and `mcp://venues`, OR ratify public exposure |
| **P2** | WH-04, WH-06 | `OPS-WEBHOOK-HMAC-TIMESTAMP-W1` | Add timestamp to the HMAC payload + tolerance window (subscriber-facing; coordinate a version note) |
| **P2** | EQ-02 | `OPS-EQUITY-MISSES-DEDUP-W1` | `UNIQUE(symbol)` + upsert-with-hit-counter (better demand signal) + retention cron — before the equities public flip |
| **P2** | R5.3 gap | `OPS-SHAPE-SNAPSHOT-BACKFILL-W1` | Add `audits/*-shape-snapshot` + exported allow-list formatter for `/api/performance-shadow` and `mcp://venues` |
| **P3** | EQ-03 | `OPS-EQUITY-CALENDAR-REVISIT-ALERT-W1` | Wire the NYSE-calendar `≤2027` staleness to a scheduled audit + TG alert (defensive-threshold hygiene) |
| **P3** | npm audit (prod-tree moderates + dev-pruned crit) | `OPS-DEP-AUDIT-BUMP-W1` | Bump `resend`/`viem`/`vitest`/`vite` out of advisory ranges; wire `security-canary.mjs` into `deploy.yml` (`OPS-SECURITY-CANARY-CI-WIRE-W1`) |
| **Accept / Reject** | X402-05 (SVM not exposed), EQ-01/EQ-04/SV-07 (drift/non-secret), onchain blocklist intact, CDP/Databento non-exposure | — | No action; documented for the record |

---

## 5. Cross-cutting matrices

### 5.1 Authn/z matrix (R5.4) — every new/audited route
| Route | Host | Access control | Rate-limit | Quota | IDOR | Verdict |
|---|---|---|---|---|---|---|
| `POST /x402/get_trade_signal` | api | x402 payment (402) | — (deferred) | n/a | n/a | ⚠ X402-01 cross-tool downgrade |
| `POST /x402/scan_funding_arb` | api | x402 payment (402) | — | n/a | n/a | ⚠ X402-01 |
| `POST /x402/get_market_regime` | api | x402 payment (402) | — | n/a | n/a | ⚠ X402-01 |
| `POST/GET/DELETE /api/webhooks` | api | API-key (required) | **NO — WH-03 prefix bug** | yes | **none (owner-scoped) PASS** | ⚠ rate-limit |
| `POST /api/webhooks/:id/test` | api | API-key | **NO — WH-03** | — | owner-scoped PASS | ⚠ SSRF/DoS amplifier |
| `GET /api/performance-shadow` | api | **NONE (open)** | — | n/a | n/a | ⚑ SV-01 (Mr.1) |
| `GET /api/performance-public` | api+root | NONE (intended public) | — | n/a | n/a | ⚠ SV-02 fail-open |
| `GET /verify?hash=` | root | NONE (intended public) | — | n/a | n/a | ✅ parameterized, strict regex, no SQLi/enum |

### 5.2 Output-shape allow-list audit (R5.3)
| Public surface | Exported pure formatter | `audits/*-shape-snapshot` | Verdict |
|---|---|---|---|
| `get_equity_call` | ✅ `formatEquityCall` (`equity-tool-formatters.ts:67`) | ✅ `get_equity_call-shape-snapshot-2026-06-04.json` (`forbidden_keys:[outcome_return_pct,outcome_price]`) | ✅ |
| `get_equity_regime` | ✅ `formatEquityRegime` (`:81`) | ✅ `get_equity_regime-shape-snapshot-2026-06-04.json` | ✅ |
| x402 paid (`get_trade_signal`/`scan_funding_arb`/`get_market_regime`) | ✅ (public-only by construction) | ✅ `x402-http-*-shape-snapshot-2026-05-30.json` (×3) | ✅ |
| `/verify?hash=` | ✅ | ✅ `verify-hash-shape-snapshot-2026-05-29.json` | ✅ |
| `/api/webhooks` | ✅ allow-list payload | ✅ `api-webhooks-shape-snapshot-2026-06-04.json` | ✅ |
| **`/api/performance-shadow`** | ⚠ no exported allow-list formatter (raw row incl. `min_buy_sell_sample`) | **✗ MISSING** | ⚠ R5.3 gap → `OPS-SHAPE-SNAPSHOT-BACKFILL-W1` |
| **`mcp://algovault/venues`** | ⚠ exposes `min_buy_sell_sample` | **✗ MISSING** | ⚠ R5.3 gap |

> Correction to EQUITY-AUDITOR's hand-off note: the equity tools **do** have shape snapshots (verified present with correct `forbidden_keys`). The genuine snapshot gaps are `/api/performance-shadow` + `mcp://venues`.

### 5.3 Dependency / secret posture (R5.1 + R5.2) — see `lead-shared-evidence.md`
- **npm audit:** 19 vulns (1 crit / 4 high / 14 mod). The **CRITICAL (`vitest`) + 2 HIGH (`vite`, `fast-json-patch`-via-`ajv-cli`) are devDeps PRUNED from the prod image** (SSH-verified). Prod-tree: 1 HIGH `fast-uri` (ajv schema-URI parsing — **not** user-input-reachable), moderates `ws` (viem/ethers) + `svix` (resend). **No prod-runtime CRITICAL.**
- **Onchain-publication blocklist INTACT** — every literal (`web3`/`eth-account`/`eth-abi`/`hexbytes`/`py-solc-x`/`brownie`/`ape`/`ipfshttpclient`) = 0 lock hits. `viem`/`ethers` present only for x402 EIP-712/SIWE **verification** (revenue, allowed). `hardhat` is a **devDep, pruned from prod**.
- **Secret sweep CLEAN** — `.env` gitignored + literal `.env` never committed; zero hardcoded CDP/Databento/`whsec_`/PEM values in tree or history; `deploy/*.json` does not exist (drift; `deploy/` is systemd-only). CDP + Databento prod-proven present in `/proc/1/environ`, absent from container logs.

---

## 6. Reusable artifact (Pillar 3 — compounding)
- **`scripts/security-canary.mjs`** (authored; **not** wired to `deploy.yml` this read-only wave) — 3 gates: (A) `npm audit` High+ in the x402 family **+ `@x402/svm` GHSA-absence floor**, (B) PII/secret **value-binding** grep (`/"outcome_return_pct":\s*[-\d.]/` discriminator + secret literals, with a `--diff` mode), (C) SSRF block-class matrix against the **real** compiled guard. **Self-test:** A GREEN, B GREEN (207 files), C RED on exactly WH-02 — i.e. it already encodes the open finding and flips GREEN when `OPS-WEBHOOK-SSRF-IP-PIN-W1` lands.
- **`docs/RUNBOOK-SECURITY-AUDIT.md`** — one-command repeat of this audit + how to add a gate.
- **Wire-up follow-up:** `OPS-SECURITY-CANARY-CI-WIRE-W1` adds the `deploy.yml` step (clean `npm run build` → `node scripts/security-canary.mjs`).
This retires the one-off-audit pattern → continuous posture (suite-lock-in + track-record/trust moat).

---

## 7. Acceptance-criteria checklist
- **AC1 (Step 0):** ✅ `endpoint-truth.md`; canonical clone @ `origin/main`; every scope file existence-probed; 2 drifts resolved (< 3 HALT); read-only firewall stated.
- **AC2 (x402 deps):** ✅ `npm audit` + `npm ls` captured; **SVM exposure = N** (`@x402/svm` absent; `@coinbase/x402@2.1.0` is current-latest, the 2.6.0 fix is the absent svm pkg).
- **AC3 (SSRF rebind):** ✅ **exploitable = YES**, PoC `rebind-poc.mjs`; blast radius mapped (metadata/loopback/RFC1918/pg); fix confirmed by `fix-pins-ip.mjs`; generator-level for all egress.
- **AC4 (Data-Integrity proofs):** ✅ live PASS — no `outcome_return_pct`/Phase-E/shadow-as-promoted leak on `get_equity_call`, `get_equity_regime`, `/api/performance-public`, `/api/performance-shadow`, `/verify`, x402 paid, `mcp://venues` (evidence in `poc/` + area files).
- **AC5 (secrets):** ✅ CDP + Databento non-exposure proven across src + full history + prod logs + logger redaction.
- **AC6 (report + artifact):** ✅ this report + `security-canary.mjs` + `RUNBOOK-SECURITY-AUDIT.md`.
- **AC7 (read-only integrity):** ✅ `npm test` = **16 fail / 1808 pass / 6 skip**, stable across a load run and a clean re-run (same 8 files); **zero NEW failures attributable to the wave** (`git status --untracked-files=no` empty; PoCs are `.mjs`, not vitest-collected). The cited "15/~1805" is slightly stale baseline drift (status.md shows the count moving as tests were added).
- **AC8 (logbook):** ✅ `status.md` appended (newest-first; `system-map.md updated: N` — read-only, NONE internal change only); `scp` to monitoring host.

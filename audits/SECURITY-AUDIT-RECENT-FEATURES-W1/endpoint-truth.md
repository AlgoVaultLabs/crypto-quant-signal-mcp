# SECURITY-AUDIT-RECENT-FEATURES-W1 — endpoint-truth.md (Step 0)

**Wave:** SECURITY-AUDIT-RECENT-FEATURES-W1 · **Type:** READ-ONLY forensic security audit (META/internal) · **Produced:** 2026-06-07 (box probe) · **Author:** LEAD/CONSOLIDATOR
**Verdict:** ✅ Scope confirmed — **NO HALT** (2 drifted scope paths < 3-fictional threshold; both resolved below; 0 unprobeable-read-only surfaces). Proceed to deep audit (no architect-wait: wave mutates nothing).

---

## 1. Canonical clone confirmation (firewall anchor)

| Check | Result |
|---|---|
| Clone path | `~/code/crypto-quant-signal-mcp` (Code's canonical clone — NOT the 181-commit-stale vault mirror) |
| `git remote -v` | `origin → https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp.git` ✅ |
| `git rev-parse HEAD` | `aec417541753b06fce06adda938fcf60af698a08` |
| HEAD == `origin/main` | **YES** — both `aec4175` (working tree at remote HEAD) ✅ |
| Branch / upstream | `main` → `origin/main` ✅ |
| Tracked-file modifications | **NONE** (`git status --untracked-files=no` empty) — clean tree ✅ |
| Untracked | only pre-existing `audits/*.md` from prior waves (NPM-PUBLISH endpoint-truths, chatgpt submission) — unrelated |
| `package.json` version | `1.20.1` |
| HEAD wave | `OPS-RATELIMIT-DIGEST-THRESHOLD-RECAL-W1` (status.md top entry cites commit `aec4175`) — clone is exactly current |

**Read-Only Firewall (LAW, restated):** MUST NOT edit `src/`, `landing/`, `Design/`, `deploy/`, `Dockerfile`, `.github/`; no prod config/env/DB mutation; no deploy/version-bump/publish/push-to-main/onchain. MAY: read code, `git log`/`blame`/`-S`, `npm audit`/`npm ls`, `npm test`, `curl` live READ endpoints, SSH-READ prod. All writes confined to `audits/SECURITY-AUDIT-RECENT-FEATURES-W1/**` (+ lead's `scripts/security-canary.mjs` + `docs/RUNBOOK-SECURITY-AUDIT.md`). `git status` at wave end MUST be confined to those paths.

---

## 2. Existence probe — `claim | reality | resolution`

### AREA 1 — X402 (all present ✅)
| Spec claim | Reality | Resolution |
|---|---|---|
| `src/lib/x402.ts` | EXISTS (369 ln) | use as-is |
| `src/lib/x402-facilitator.ts` | EXISTS (129 ln) | use as-is |
| `src/lib/x402-bazaar.ts` | EXISTS (268 ln) | use as-is |
| `src/lib/x402-http-routes.ts` | EXISTS (235 ln) | use as-is; routes handler confirmed in-file |
| routes `POST /x402/{get_trade_signal,scan_funding_arb,get_market_regime}` | handler text confirmed in `x402-http-routes.ts` | live 402 confirmed (§3) |
| also: `src/facilitator.ts` `app.post('/verify')` (l.74) | EXISTS — the **x402 facilitator container's** verify endpoint (separate from landing `/verify`) | X402-AUDITOR may inspect; runs as `crypto-quant-signal-mcp-facilitator-1` |

### AREA 2 — WEBHOOK (all present ✅)
| Spec claim | Reality | Resolution |
|---|---|---|
| `src/lib/webhook-ssrf.ts` | EXISTS (182 ln) | use as-is — the reusable egress guard (generator-level) |
| `src/lib/webhook-delivery.ts` | EXISTS (339 ln) | use as-is |
| `src/lib/webhook-api.ts` | EXISTS (276 ln) | routes registered here; mounted from `src/index.ts:1867` |
| `src/lib/webhook-events.ts` | EXISTS (265 ln) | use as-is |
| `src/lib/webhooks-store.ts` | EXISTS (331 ln) | use as-is |
| `GET /verify?hash=` handler | in `src/index.ts` (~l.1601 "WEBHOOK-HARDENING-W1 C3: dual lookup `?hash=<signal_hash>`") | **served on root `algovault.com`, NOT `api.`** (see §3) |

### AREA 3 — EQUITIES (1 drift, resolved ✅)
| Spec claim | Reality | Resolution |
|---|---|---|
| `src/lib/equities/equity-bars-provider.ts` | EXISTS (319 ln) | use as-is |
| **`src/lib/equities/equity-calendar-constants.ts`** | **MISSING (DRIFT #1)** | **→ NYSE-holiday/trading-session logic + the `2026-12-15`-class revisit lives in `src/lib/equities/equity-indicators.ts` (l.35 "real US trading session iff weekday and not a NYSE full-day holiday") + `src/lib/equities/equity-constants.ts`. Audit those.** |
| `src/lib/equities/equity-verdict.ts` | EXISTS (134 ln) | use as-is |
| `src/scripts/{build-equity-universe,backfill-equity-bars,seed-equities,backfill-equity-outcomes}.ts` | all 4 EXIST (105/81/88/66 ln) | use as-is |
| `ops/monitoring/equity-launch-readiness.sh` | EXISTS (80 ln) | use as-is |
| tools `get_equity_call` / `get_equity_regime` | handlers in `src/index.ts:454/479` | live; `tools/list`=9 |
| **(bonus) exported allow-list formatter** | **`src/lib/equities/equity-tool-formatters.ts` (l.66 "PURE allow-list formatter for get_equity_call")** | satisfies R3.1 formatter requirement — audit `forbidden_keys` here |
| (bonus) `equity-store.ts`, `equity-misses.ts`, `equity-outcomes.ts`, `equity-performance.ts` | EXIST | relevant to R3.3 (`equity_symbol_misses` bound) + R3.1 (DB read shape) |

### AREA 4 — SHADOW-VENUE (1 drift, resolved ✅)
| Spec claim | Reality | Resolution |
|---|---|---|
| `src/lib/venue-store.ts` | EXISTS (334 ln) | use as-is |
| `src/lib/venue-shadow.ts` | EXISTS (60 ln) | use as-is |
| `src/lib/adapters/aster.ts` | EXISTS (169 ln) | NEW DEX adapter — audit |
| `src/lib/adapters/edgex.ts` | EXISTS (283 ln) | NEW DEX adapter — audit |
| **`src/lib/adapters/lighter.ts`** | **MISSING (DRIFT #2)** | **→ NO `lighter` adapter exists. The NEW DEX adapters are `aster.ts` + `edgex.ts` ONLY. Report `lighter` as spec-drift (never shipped). The 17 live adapters: aster, binance, bingx, bitget, bitmart, bybit, edgex, gateio, htx, hyperliquid, kucoin, mexc, okx, phemex, weex, whitebit, xt (= `ExchangeId` 5→17 ✓).** |
| **(bonus) shared egress** | **`src/lib/adapters/_upstream-fetch.ts` (8.7 KB)** — both aster.ts (l.26/54) + edgex.ts (l.29/116) route ALL fetch/retry/ban through `upstreamFetch(VENUE_FETCH_CONFIGS.X, …)` | **GENERATOR-LEVEL for R4.2/R4.3 — host-pinning, TLS, untrusted-response parsing live HERE, inherited by every adapter. Audit `_upstream-fetch.ts` first.** |
| `src/scripts/evaluate-venues.ts` | EXISTS (277 ln) | state machine (06:00 UTC) |
| `src/types.ts` | EXISTS (508 ln) | `VenueStatus`, `ExchangeId` |
| `/api/performance-shadow` | `app.get('/api/performance-shadow')` at `src/index.ts:1550` | **live 200 unauth (§3)** |

**Drift tally: 2** (`equity-calendar-constants.ts`, `adapters/lighter.ts`). Below the ≥3-fictional HALT threshold → resolved inline, no HALT.

---

## 3. Live read-probe reachability (authorized READ-only curl)

| Endpoint | HTTP | Note |
|---|---|---|
| `POST https://api.algovault.com/x402/scan_funding_arb` | **402** ✅ | full `payment-required` header present; body parsed below |
| `GET https://api.algovault.com/api/performance-public` | **200** ✅ | (root `algovault.com` also 200) |
| `GET https://api.algovault.com/api/performance-shadow` | **200** ⚠️ | **NEW route, returns 200 UNAUTHENTICATED** — R4.1 premature-disclosure candidate (root `algovault.com` → 404, so api-only) |
| `GET https://api.algovault.com/verify?hash=test` | 404 | not on api host |
| `GET https://algovault.com/verify?hash=test` | **200** ✅ | **`/verify` is served on root `algovault.com`** (also `?id=1` → 200). WEBHOOK-AUDITOR probes here for R2.6. |

### x402 402-body decode (gold for R1.2 — independent amount/asset/network/payTo assertion)
From the live `POST /x402/scan_funding_arb` 402 `accepts[0]`:
- `scheme: "exact"`
- `network: "eip155:8453"` → **Base mainnet (EVM)** ✅ (matches `X402_NETWORK=base-mainnet`; **NO SVM/Solana scheme present** — early R1.1 signal that the SVM verify path is not advertised)
- `amount: "10000"` → 6-decimal USDC = **$0.01** ✅ (matches `scan_funding_arb` $0.01 pricing)
- `asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"` → **canonical USDC on Base** ✅
- `payTo: "0x778A05280Fd8dB980E920fE9f31d0A8eAbD17d59"` → **matches `X402_WALLET_ADDRESS`** ✅ (and the `feedback_wallet_mismatch` Rabby receiver)
- `maxTimeoutSeconds: 300`, `extra: {name: "USD Coin", version: "2"}` → EIP-712 domain name/version (per-network USDC name — verify `x402.ts` derives this per network for cross-network-replay defense, R1.2c)
- `extensions.bazaar` present (discovery metadata) ✅

> X402-AUDITOR: this is the *advertised* contract. R1.2 must verify the *verify→settle code path* independently re-asserts (a) amount==`TOOL_PRICING[tool]`, (b) asset==expected USDC, (c) network==`X402_NETWORK` (reject a `base-sepolia` proof), (d) recipient==`X402_WALLET_ADDRESS` — a gap in any is CRITICAL.

---

## 4. SSH-read prod recipe (authorized; runs as root on Hetzner 204.168.185.24)

`ssh -i ~/.ssh/algovault_deploy root@204.168.185.24 '<cmd>'` — **connectivity CONFIRMED** (`SSH_OK`).

Live containers:
| Container | Image | Use |
|---|---|---|
| `crypto-quant-signal-mcp-mcp-server-1` | (app) | **CDP + Databento env live here** → `docker exec crypto-quant-signal-mcp-mcp-server-1 cat /proc/1/environ \| tr '\0' '\n' \| grep -E 'CDP_API_KEY\|DATABENTO'` (R1.6 / R3.2 prod proof: present in environ, ABSENT from logs) |
| `crypto-quant-signal-mcp-postgres-1` | postgres:16-alpine | DB |
| `crypto-quant-signal-mcp-facilitator-1` | (facilitator) | x402 facilitator (healthy) — `docker logs` for credential-dump check (R1.6) |

> Log-leak check: `docker logs crypto-quant-signal-mcp-mcp-server-1 2>&1 | grep -iE 'CDP_API_KEY|DATABENTO|secret|Bearer ' | head` (expect EMPTY). Recall CLAUDE.md: **httpx/undici INFO can leak bearer tokens via URL** — inspect logger level + redaction in every facilitator/Databento HTTP error path.

---

## 5. Per-area read-only probe + PoC plan

**AREA 1 (X402-AUDITOR, R1):** `npm audit --json` + `npm ls @coinbase/x402 @x402/extensions @x402/core @x402/evm @x402/svm x402`; compare installed vs GHSA-qr2g-p6q7-w82m fix ≥2.6.0; trace whether `@x402/svm` is in the *active verify path* (grep imports in `x402.ts`/`x402-facilitator.ts`; reachable only if a Solana scheme is accepted — live `accepts` shows none). Read `x402.ts` verify→settle for amount/asset/network/payTo asserts (R1.2), nonce/idempotency single-use (R1.3), release-before-settle window (R1.4 vs RISK-ACCEPTED-001), paywall+stub-path parity & `outcome_return_pct` non-leak (R1.5). `git log -p -S 'CDP_API_KEY'` full history + prod environ/log proof (R1.6). Two-flag firewall mount-gating + onchain blocklist transitive check (R1.7). **PoC** (`poc/`): forged/under-paid `X-PAYMENT` against a LOCAL harness or documented code-path PoC — never mutate prod, never move funds.

**AREA 2 (WEBHOOK-AUDITOR, R2):** code-path trace `webhook-delivery.ts` — does it pass the validated **IP** to connect or the **hostname** (undici re-resolves) → the `OPS-WEBHOOK-SSRF-IP-PIN-W1` TOCTOU/rebind (R2.1). **PoC** (`poc/`): self-contained DNS-rebind demonstrator (resolver returns public IP first, internal IP at connect) OR undici-re-resolution demo proving reach to `169.254.169.254`/`127.0.0.1`/`10.x`/pg-port; map blast radius (every future `webhook-ssrf` consumer inherits the hole = generator-level). SSRF block-class completeness incl. IPv4-mapped IPv6, octal/decimal/hex encodings, redirect handling (R2.2). HMAC/CSPRNG/replay (R2.3); authn/z + IDOR via `:id` (R2.4); `tryClaimDelivery` race + `/:id/test` abuse (R2.5); `/verify` shape+SQLi+rate-limit on `algovault.com` (R2.6); payload allow-list + dark-ship boot-gate (R2.7).

**AREA 3 (EQUITY-AUDITOR, R3):** **PoC** (`poc/`): live-call `get_equity_call`/`get_equity_regime` (MCP) + assert envelope has NO `outcome_return_pct`/`outcome_price`/internal key (R3.1) — audit the exported formatter `equity-tool-formatters.ts` `forbidden_keys`. `DATABENTO_API_KEY` env-only/never-logged/not-in-Basic-URL-dump + prod environ/log proof (R3.2). Symbol normalization + SQLi + `SYMBOL_NOT_IN_UNIVERSE` non-leak + **`equity_symbol_misses` insert bound** (table-bloat DoS) (R3.3). PUBLIC-COPY HOLD: equities excluded from lobehub manifest + no equity claim on landing/README (R3.4). Databento robustness: timeout/retry/backoff/cost-bound/gap-quarantine + the `equity-indicators.ts` NYSE-holiday revisit-alert staleness (R3.5).

**AREA 4 (SHADOW-VENUE-AUDITOR, R4):** confirm `/api/performance-public` `status='promoted'` filter airtight (no UNION/empty-filter shadow leak) + **scrutinize the live-200-unauth `/api/performance-shadow`**: PFE-only? auth? premature-disclosure → flag for Mr.1 (R4.1). Audit shared egress `_upstream-fetch.ts` FIRST (host allow-list/pin, TLS verify, untrusted-response default-deny on NaN, no proto-pollution, no unbounded alloc, 3-tier fallback) — then aster.ts/edgex.ts specifics (R4.2/R4.3). State machine `evaluate-venues.ts`: premature-promote, `extension_count` 0–2 (DB CHECK + code), auto-promote is the ONLY shadow→promoted path (R4.4). `mcp://algovault/venues` + `_algovault.venue_status` expose no internal thresholds (R4.5). **Note `lighter` does not exist — report as drift.**

**LEAD (R5):** full-tree `npm audit` (all High/Critical) + onchain-blocklist transitive check; full-history secret sweep (`git log -p -S` CDP/Databento/whsec/HMAC/admin/private-key + high-entropy grep) + `.gitignore` + `deploy/*.json` public/secret split; output-shape allow-list audit (formatter + `*-shape-snapshot` per new public endpoint); authn/z matrix (every new route); consolidate 4 area files → master report (severity matrix + P0→Reject backlog + per-finding follow-up wave ID); author `scripts/security-canary.mjs` + `docs/RUNBOOK-SECURITY-AUDIT.md`; run `npm test` for AC7 baseline (`15 fail / ~1805 pass`, zero NEW); single per-file commit; append `status.md` + `scp`.

---

## 6. Severity rubric (apply to every finding)
- **CRITICAL** — unauth remote → fund loss / RCE / internal-network reach / secret disclosure / public leak of internal data (`outcome_return_pct`/Phase-E).
- **HIGH** — exploitable w/ conditions → payment bypass, SSRF-to-internal, authn/authz bypass / IDOR, key leak in logs.
- **MEDIUM** — needs privilege/chaining → DoS, non-secret info leak, missing rate-limit.
- **LOW** — defense-in-depth / hardening.
- **INFO** — best-practice note, no direct exploit.

**Finding schema (every finding):** `ID · severity · area · file:line (canonical clone) · exploit scenario · evidence (probe output / PoC path) · recommended GENERATOR-LEVEL fix · proposed follow-up wave ID`.

# LEAD shared evidence — R5.1 (secret sweep) + R5.2 (full npm audit) + cross-cutting deps

**Wave:** SECURITY-AUDIT-RECENT-FEATURES-W1 · **Author:** LEAD · clone @ `aec4175` (v1.20.1) · READ-ONLY.
Captured by the lead and consumed by the consolidated report. All probes read-only; secret values redacted (never echoed into transcript/report).

---

## R5.2 — Full-tree `npm audit` (all severities) + onchain-blocklist transitive check

**Tally:** `19 vulnerabilities — 1 critical, 4 high, 14 moderate, 0 low/info` (raw JSON: `npm-audit-full.json`).

### The crux: prod-shipped vs dev-pruned (multi-stage Docker build prunes devDependencies)
SSH-verified on prod `crypto-quant-signal-mcp-mcp-server-1`: `vitest` → **pruned**, `vite` → **pruned**, `hardhat` → **pruned**. So the headline CRITICAL/HIGH are **dev-only, never shipped to the prod runtime**.

| Pkg | Severity | Advisory | Dep class | In prod image? | Real exposure |
|---|---|---|---|---|---|
| `vitest` | **CRITICAL** | GHSA-5xrq-8626-4rwp (Vitest UI server arbitrary file read+exec) | devDep `^3.1.1` | **PRUNED** | **None in prod.** Dev risk only if `vitest --ui` bound on a shared network. Recommend `--ui` never on `0.0.0.0`. |
| `vite` | HIGH | GHSA-4w7w-66w2-5vf9 / v2wj-q39q-566r / p9ff-h696-f583 (dev-server path traversal / arbitrary file read) | transitive (via vitest) | **PRUNED** | None in prod — vite dev server isn't run in prod. |
| `fast-json-patch` | HIGH | Prototype Pollution | transitive via **`ajv-cli`** (devDep) → `json-schema-migrate` | **PRUNED** | Dev-only (ajv-cli is a build/validation CLI). |
| `fast-uri` | HIGH | path traversal via %-encoded dot segments; host confusion via %-encoded authority | transitive via **`ajv@8.20.0`** | **SHIPPED** (ajv is prod via `@modelcontextprotocol/sdk` + `@x402/extensions`) | **Low reachability:** ajv uses fast-uri to resolve schema `$id`/`$ref` URIs — those come from STATIC developer-authored schemas, not user input. User data is validated *against* schemas; it does not flow into fast-uri's URI parser. Monitor; bump ajv when upstream patches. |
| `ws` | moderate | GHSA-58qx-3vcg-4xpx (uninitialized memory disclosure) | transitive via **`viem`** (prod direct `^2.47.12`) + **`ethers@6.16.0`** (prod via `@x402/extensions`→`siwe`) | **SHIPPED** | Moderate; `ws` is used by viem/ethers websocket *providers* — x402 EIP-712/SIWE verification uses HTTP, not the ws provider path. Low active-path reachability. |
| `resend`→`svix` | moderate | resend canary depends on vulnerable svix | prod `resend@^6.12.2` | **SHIPPED** | Moderate; email/webhook-sig lib. Bump resend out of `6.2.0-canary.0–6.12.2` range. |

**Verdict (R5.2):** the 1 CRITICAL + 2 of 4 HIGH are **dev-only and pruned from prod**. The genuinely prod-shipped issues are 1 HIGH (`fast-uri`, low reachability — schema-URI only) + moderates (`ws`, `svix`). **No prod-runtime CRITICAL.** Recommend a follow-up dep-bump wave (non-blocking) + the CI `npm audit` gate this wave ships (security-canary).

### Onchain-publication blocklist — INTACT ✅
Literal CLAUDE.md blocklist (`web3, eth-account, eth-abi, hexbytes, py-solc-x, brownie, ape, ipfshttpclient`) + JS onchain-publish equivalents (`ipfs-http-client`, `@web3-storage/*`): **0 lock-file hits each.**
Onchain libs that ARE present, all justified as x402 **verification** (revenue), NOT publication:
- `viem@2.47.12` — prod direct dep; x402 EIP-712 / USDC EIP-3009 signature verification.
- `ethers@6.16.0` — prod transitive via `@x402/extensions@2.9.0 → siwe@2.3.2`; SIWE (EIP-4361) message verification.
- `hardhat@^3.3.0` + `@nomicfoundation/hardhat-viem@^3.0.4` — **devDeps, PRUNED from prod** (confirmed). These are onchain *deployment/test* frameworks (JS analog of the blocklisted `brownie`/`ape`). They never reach prod and there is no CI step that invokes hardhat to deploy/anchor. **INFO finding for Mr.1 awareness** (a deployment-capable framework lives in devDeps for local x402-contract testing); not a LAW breach (LAW = no *runtime* onchain publication; x402 = USDC revenue, explicitly carved out).

---

## R1.1 — SVM forged-proof (GHSA-qr2g-p6q7-w82m) — RESOLVED by X402-AUDITOR: **NOT exposed (N)** ✅
> Correction (FACTUALITY): my first-pass note framed `@coinbase/x402@2.1.0` as "below the 2.6.0 fix." That conflated two independent version lineages. The X402-AUDITOR's trace is authoritative:
- **The GHSA fix line `>= 2.6.0` is on the `@x402/svm` package** (the Solana verifier that improperly checks SVM proofs) — **NOT** `@coinbase/x402`, which has its own separate numbering.
- `@x402/svm` is **NOT installed** — neither declared (no dep/devDep in `package.json`) nor transitive (`npm ls @x402/svm` = `(empty)`). The vulnerable Solana-verifier code is absent from the tree → cannot execute.
- `@coinbase/x402` installed = **2.1.0**, which is the **current latest of its own lineage** (not "below a fix").
- Only `ExactEvmScheme` / `eip155:8453` is registered; live 402 advertises no SVM scheme; the `@solana/*` packages on disk come from `@coinbase/cdp-sdk` (an SDK), not a payment verifier.
- Declared x402 prod deps: `@coinbase/x402@^2.1.0`, `@x402/core@^2.9.0` (installed 2.9.0), `@x402/evm@^2.9.0`. **Verdict: SVM verify path NOT exposed.** Full trace in `area1-x402.md` (R1.1 / X402-05).

---

## R5.1 — Full-history secret sweep (AC5) — CLEAN ✅

| Check | Result |
|---|---|
| `.env` gitignored | **YES** (`git check-ignore .env` ✓) |
| Literal `.env` ever committed (any branch/history) | **0 commits** (`git log --all -- ':(literal).env'`). The 9 `.env*` history hits are **all `.env.example`** (documented var-name template, no values). |
| Hardcoded private keys / PEM blocks in tracked tree | **NONE** (`git grep "BEGIN .*PRIVATE KEY"` empty outside fixtures) |
| `whsec_…` webhook-secret literals outside tests | **NONE** |
| `CDP_API_KEY_*` / `DATABENTO_API_KEY` literal value assignments in tracked files | **NONE** — all references are `process.env.*` reads or `$VAR`/`%s` placeholders in runbooks |
| History: secret VALUE ever added in a diff | **NONE** — `git log -p -S` hits are runbook/doc lines (`sed -i '/^DATABENTO_API_KEY=/d' … printf 'DATABENTO_API_KEY=%s'`, `curl -u "$DATABENTO_API_KEY:"`) referencing the NAME only |
| `deploy/*.json` public+secret split | **No `deploy/*.json` exists** (spec drift). `deploy/` holds only `systemd/evaluate-venues.{service,timer}` — no inline secrets (they use `EnvironmentFile=`) ✅ |
| Prod secret residency | Keys live ONLY in host `/opt/crypto-quant-signal-mcp/.env` (mode 600) → injected as container env; per-area auditors confirm present in `/proc/1/environ`, absent from `docker logs` |

**Verdict (R5.1):** no CDP/Databento/webhook secret is, or ever was, committed. `.env` hygiene correct. Prod log-redaction proof delegated to area1 (CDP) + area3 (Databento).

---

## Cross-cutting notes for consolidation
- **AC7 baseline reconciliation:** first run (under concurrent 4-agent + npm-audit load) = `16 fail / 1808 pass / 6 skip`. The 16 failures span 8 **pre-existing** test files (knowledge-flow, chat-engine, copy-consistency, mcp-usage-docs, perf-stats-cache, recent-signals-shape, knowledge-index, performance-public-shadow-filter) — **none are PoC files** (PoCs are `.mjs`, not vitest-collected). `git diff` confined to `audits/…`. A **quiet-box clean re-run** is pending at finalization to confirm the count returns to the cited `~15`/zero-new-attributable baseline; the delta is load-induced flake, not a wave-caused regression.
- Drifts already filed in `endpoint-truth.md`: `equity-calendar-constants.ts`→`equity-indicators.ts`+`equity-constants.ts`; `adapters/lighter.ts` absent (never shipped); `deploy/*.json` absent.

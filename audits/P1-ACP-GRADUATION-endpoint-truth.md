# P1-ACP-MAINNET-GRADUATION — Endpoint-Truth (Plan-Mode probe)

**Wave:** buyer driver to graduate the live AlgoVault seller on Virtuals ACP (Base mainnet).
**Date:** 2026-07-04. **Base:** worktree `cqsm-wt-acp-seller` @ origin/main `2f3ce14` (v1.23.0).
**SDK:** `@virtuals-protocol/acp-node-v2@0.1.7` (installed — probed from `node_modules/.../dist`).
**Verdict:** 1 fictional primitive (below the ≥3 HALT threshold); both OPEN decisions resolved per the prompt's own contingencies. PROCEED.

## 1. Confirmed buyer-side SDK

| primitive | source | status |
|---|---|---|
| `getAgentByWalletAddress(addr): Promise<AcpAgentDetail \| null>` | `acpAgent.d.ts:94` | ✅ resolves the seller's live offerings |
| `createJobByOfferingName(chainId, offeringName, providerAddress, requirementData, opts?: {evaluatorAddress?, hookAddress?, packageId?}): Promise<bigint>` | `acpAgent.d.ts:191` | ✅ (returns jobId as **bigint**) |
| `session.fund(amount?: AssetToken): Promise<void>` | `jobSession.d.ts:29` | ✅ |
| `session.complete(reason: string): Promise<void>` · `session.reject(reason)` | `jobSession.d.ts:31-32` | ✅ |
| `AssetToken.usdc(amount: number, chainId: number): AssetToken` | `core/assetToken.d.ts:11` | ✅ |
| `base.id = 8453` | `viem/chains` | ✅ mainnet chainId |
| job events `budget.set` / `job.funded` / `job.submitted` / `job.completed` / `job.rejected` | `events/types.d.ts` | ✅ |

**Evaluation modes** (`createJobFromOffering` doc): **self-eval** `{evaluatorAddress: buyerAddress}` → buyer receives `job.submitted` → must call `complete`/`reject`; **skip-eval** (omit `evaluatorAddress` → zero address) → `submit` auto-completes, `job.submitted` won't fire. → Use **self-eval** (per prompt; unambiguous "success" for graduation).

## 2. Corrections (prompt vs live)

- **C1 — Buyer identity is FORCED to a 2nd registered agent.** The prompt's "SDK-only local wallet (`ViemProviderAdapter`)" is **fictional**: `dist/providers/evm/viemProviderAdapter.js` is a non-functional STUB — every method `throw new Error("… not implemented. Override in subclass.")`. The only functional EVM adapter is `PrivyAlchemyEvmProviderAdapter` (needs Privy `walletId`+signer). → the buyer MUST be a **2nd REGISTERED Virtuals agent** (the prompt's own "else register a 2nd agent" fallback; resolves OPEN#1). *Material: Mr.1 onboards a 2nd agent for the live run.*
- **C2 — Location `scripts/` → `src/scripts/`.** `tsconfig.json` `include:["src/**/*"]` (top-level `scripts/` is NOT compiled by `tsc`; it's tsx-run-only). → `src/scripts/acp-graduation-buyer.ts` (matches `seed-signals.ts`/`backfill-outcomes.ts`; satisfies the "compiles" AC via `npm run build`; run via `npx tsx`).
- **C3 — `createJobByOfferingName` returns `Promise<bigint>`** (jobId), not a string. Driver handles bigint.

## 3. OPEN decisions — resolved

- **OPEN#1 (buyer identity)** → **2nd registered agent (Privy adapter)** — ViemProviderAdapter is a stub (C1).
- **OPEN#2 (gas)** → **SPONSORED on Base.** `ERC20_SPONSORED_CHAINS` includes `8453` (base mainnet) + the Alchemy smart-wallet flow → the buyer's `fund` (USDC transfer) is gas-sponsored. Confirm the full round-trip at `--smoke`; fund a tiny Base-ETH buffer on the buyer ONLY if smoke shows a gas error.

## 4. Reuse

- Buyer construction mirrors `src/channels/acp/provider.ts::createLiveAcpAgent` — `import type` SDK types + `await import()` runtime (ESM-only SDK from the CJS build) → `PrivyAlchemyEvmProviderAdapter.create({walletAddress, walletId, signerPrivateKey, chains:[base], serverUrl: ACP_SERVER_URL, privyAppId})` → `AcpAgent.create({provider})`.
- Buyer tests reuse `tests/acp-seller.test.ts` `makeSession`/`makeDeps` fakes.
- Offering names resolved live via `getAgentByWalletAddress(SELLER_WALLET_ADDRESS)` — no hardcoding.

## 5. Live seller (target)

`SELLER_WALLET_ADDRESS = 0x195aeeff4db75c004a7a1956c42c8fd12a3d5769` (Hetzner `.env` `ACP_WALLET_ADDRESS`). Worker `mode=live, network=mainnet`. Offerings: `algovault_tradecall` ($0.02), `algoVault_MarketScan` ($0.02), `algoVault_FundingArb` ($0.01). Prices from the registry SoT (no change).

## 6. Safety (mainnet-micro-canary)

`--dry-run` DEFAULT (zero txns); `--execute` required to spend real; `--smoke`=1 job; `MAX_SPEND_USD` hard-cap (default 0.50); stop-on-error; sequential (1 in-flight → ≤$0.02 at risk); finally-cleanup logs any funded-but-incomplete jobId (SLA auto-refunds ~5 min); real-money preamble asserts (mainnet + `--execute`) before the first spend.

## 7. LIVE-RUN ADDENDUM (2026-07-09) — self-eval → skip-eval correction (C4)

The first live `--execute --smoke` (job 66989, self-eval) **funded but stalled**: after `fund`, the SDK's `JobSession.fetchJob` (→ `api.getJob` → `GET /jobs/{chainId}/{jobId}`, an **off-chain HTTP** read, not on-chain despite the "on chain" error string) threw on a transient **not-yet-indexed 404**, so `AcpAgent.dispatch` skipped that one `job.submitted` event. In **self-eval** the buyer MUST act on `job.submitted` (call `complete()`), so missing it permanently stalled the job (timeout → SLA refund). The seller delivered fine throughout.

**Fix (C4):** switch the driver to **skip-evaluation** (omit `evaluatorAddress`) so the seller's submit **auto-completes** the job — the buyer needs no post-fund read. Added a retried off-chain `api.getJob` **status-poll backstop** (`JobStatus` enum: `COMPLETED=3`/`REJECTED=4`/`EXPIRED=5`) racing the `job.completed` event, so a missed final event can't yield a false timeout. `agent.api` is TS-private in the SDK typings but present at runtime (accessed via the local `BuyerAgent` interface).

**Result:** `--execute --max-jobs 10` → **10/10 completed, 10 consecutive** (`GRADUATION_JOBS_COMPLETE`; jobs 67005–67025, seller-delivered each; ~$0.17). Gas paymaster-sponsored (buyer held 0 Base ETH). Graduation criteria MET — only the Mr.1 Graduate-form submission remains.

# Runbook — Virtuals ACP Mainnet Graduation (`P1-ACP-MAINNET-GRADUATION`)

**Owner:** Mr.1 (register + fund the buyer, submit the form) + Code (run the driver).
The AlgoVault **seller** is already live on Base mainnet (`mode=live, network=mainnet`, listening).
**Graduation** = **10 successful jobs incl. ≥3 consecutive** driven by **our own test-buyer**, then
submit the *Graduate Agent* form (manual Virtuals review) → the agent becomes discoverable in the
**A2A tab** (the point of the whole seed). Real USDC, tiny (~$0.15 for 10 jobs).

Driver: [`src/scripts/acp-graduation-buyer.ts`](../src/scripts/acp-graduation-buyer.ts) —
**`--dry-run` is the DEFAULT (0 txns)**; `--execute` is required to spend; `MAX_SPEND_USD` hard-cap;
stop-on-error; sequential (1 job in-flight).

> **Why a 2nd agent?** The acp-node-v2 `ViemProviderAdapter` (local-key) is a non-functional stub, so
> a "just a wallet" buyer isn't possible — the buyer must be a **2nd REGISTERED Virtuals agent** (Privy),
> and it must use a **different wallet** than the seller. This is a one-time onboarding.

---

## Step 1 — register the BUYER agent (Mr.1, ~3 min)

At **https://app.virtuals.io/acp/new** — same flow as the seller, but minimal:
- **Name:** `AlgoVault Buyer` (or anything). **Description:** short.
- **Token → Skip** (untokenized — do NOT mint a token).
- **Console / Agent Card:** OFF.
- **Wallet:** **New** (auto-generate a fresh embedded wallet — must differ from the seller `0x195ae…`).
- **Launch Agent** (dismiss the "free inference" popup — irrelevant).
- On the agent page → **Signers → + Add Signer → Copy Key**. Capture the **walletAddress**, **walletId**,
  and the **signer private key** (bare base64 `MIG…`). **No offerings needed** — buyers don't sell.

---

## Step 2 — fund the BUYER (Mr.1, ~$1)

Send **~$1 of Base-mainnet USDC** to the buyer's `walletAddress` (from an exchange withdrawal to Base,
or the agent page's **Deposit**). That covers 10+ jobs at $0.01–0.02 each.
- **Gas:** expected paymaster-**sponsored** (Base is an Alchemy ERC20-sponsored chain) — the smoke run
  confirms. Only if the smoke shows a gas error, also send **~$1 Base ETH** to the buyer wallet.

---

## Step 3 — hand the buyer creds to Code (secure)

- `walletAddress` + `walletId` are **not secret** — paste them in chat.
- The **signer private key IS secret** → send it via a **one-time link**: https://onetimesecret.com →
  paste the key → *Create a secret link* (blank passphrase) → send the link. Code consumes it atomically,
  **cryptographically verifies it derives your registered signer public key**, and sets `BUYER_*` for the
  run (mode-600, never committed, never echoed).

`BUYER_WALLET_ADDRESS` / `BUYER_WALLET_ID` / `BUYER_SIGNER_PRIVATE_KEY` (+ optional `BUYER_PRIVY_APP_ID`,
defaults to the prod Privy app). `SELLER_WALLET_ADDRESS=0x195aeeff4db75c004a7a1956c42c8fd12a3d5769`,
`ACP_ENV=mainnet`.

---

## Step 4 — SMOKE (Code runs, ~$0.02) — one real round-trip

```sh
# in the worktree, with BUYER_* + SELLER_WALLET_ADDRESS + ACP_ENV=mainnet in the env
npx tsx src/scripts/acp-graduation-buyer.ts --execute --smoke
```
Expect the full chain for **1 job**: `createJob → budget.set → fund → job.submitted → complete →
job.completed → ✓ completed`, then `GRADUATION_INCOMPLETE` (1 < 10 — smoke only). This confirms the
real API contract **and** gas sponsorship. If it errors on gas → fund Base ETH (Step 2) + re-run.

---

## Step 5 — FULL RUN (Code runs, ~$0.15) — 10 jobs

```sh
npx tsx src/scripts/acp-graduation-buyer.ts --execute --max-jobs 10
```
Drives 10 jobs sequentially (rotating the 3 offerings), stop-on-error, `MAX_SPEND_USD` cap. On success:
`GRADUATION_JOBS_COMPLETE`. **Watch the JOBS counter on the seller's Overview climb to 10.** If a job
fails, the driver stops — investigate, then top up with `--execute --max-jobs <remaining>` (the seller's
JOBS counter is cumulative).

---

## Step 6 — GRADUATE (Mr.1)

On the **seller** agent page (`0x195ae…`) → the **Graduate Agent** action (Agent Health panel) → submit
the form. Review expects: 10 successful jobs (incl. 3 consecutive), valid offerings + real deliverables,
an untokenized production agent. Approval → the agent appears in the **A2A / discovery tab**.

---

## Step 7 — post-graduation

- **Keep `ACP_ENABLED=true`** on the seller (stay live + discoverable). Default: yes.
- The buyer agent can be left dormant (or reused for future smoke checks). Any leftover buyer USDC/ETH
  is recoverable via its Withdraw.
- Kill-switch (either agent, anytime): the seller is `ACP_ENABLED=false` + `docker compose up -d mcp-server`.

---

## Safety recap

`--dry-run` is the default (0 txns) — always dry-run first to preview. `MAX_SPEND_USD` (default $0.50)
hard-halts the loop. Sequential + stop-on-error ⇒ at most ~$0.02 at risk at any instant; a funded-but-
incomplete job SLA-auto-refunds in ~5 min (the driver logs its jobId). Preview the whole loop with:
```sh
npx tsx src/scripts/acp-graduation-buyer.ts --max-jobs 10   # dry-run, zero txns
```

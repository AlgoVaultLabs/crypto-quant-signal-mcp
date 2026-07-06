# Runbook — Virtuals ACP Untokenized Seller Onboarding (Base mainnet)

**Owner:** Mr.1 (manual steps at app.virtuals.io). **Wave:** P1-ACP-SELLER-SEED.

> ⚠️ **Base MAINNET, not sandbox.** Virtuals' web console (`app.virtuals.io`) registers **production**
> agents on **Base mainnet** — there is **no Base Sepolia testnet agent** (the testnet server 404s a
> web-registered agent). The agent went live on mainnet (Mr.1-authorized 2026-07-04); config is
> `ACP_ENV=mainnet`. Settlement is real USDC (tiny — $0.01–0.02/job). **Graduation** (10 jobs via our
> own test-buyer) is in [`RUNBOOK-VIRTUALS-ACP-GRADUATION.md`](RUNBOOK-VIRTUALS-ACP-GRADUATION.md).

**Goal:** register AlgoVault as an untokenized **Seller** on the Virtuals Agent Commerce Protocol
(ACP), list the 3 launch offerings, and run the seller worker **live on Base mainnet**.

The code ships **stub-first + default-OFF**: nothing here blocks a deploy. Until you complete the
steps below and set `ACP_ENABLED=true` + the signer creds, the worker is a silent no-op.

---

## 0. Prereqs

- A wallet you control (MetaMask/Rabby) to connect at app.virtuals.io. This is **not** the
  X402_WALLET / facilitator wallet — ACP mints its own Virtuals-managed (Privy) agent wallet.
- Access to the Hetzner container env (where `X402_WALLET_ADDRESS` etc. already live).

---

## 1. Join ACP + create the Seller agent

1. Go to **https://app.virtuals.io/acp/join** and connect your wallet.
2. Create/register an **agent** (the seller). Choose the **untokenized / API** path — ACP supports
   untokenized agents; do **not** launch a token.
3. Set the agent profile: name (e.g. *AlgoVault*), description, category. Suggested description:
   > AlgoVault — the Brain Layer for AI trading agents. Composite perp trade verdicts
   > (direction + confidence + regime) across 5 venues, plus market scans and funding-rate arbitrage.
   > Read-only signals with an on-chain Merkle-verified track record.

---

## 2. Add the 3 launch offerings

On the agent's **Offerings** (Services) section, add each offering below **verbatim** (name +
description + requirement schema). These MUST match the code's `src/channels/acp/offerings.ts`
(the seller reads the offering name back via `session.job.description` to dispatch — a name
mismatch = an unservable job). Price is per call in USDC; SLA = 5 minutes.

### Offering 1 — `AlgoVault Trade Call`  ·  0.02 USDC  ·  SLA 5m
> Composite perp trade verdict (BUY / SELL / HOLD) with confidence score and market regime for a
> crypto asset, aggregated across 5 perp venues. Read-only; on-chain Merkle-verified track record.

Requirement schema (draft-07):
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["coin"],
  "properties": {
    "coin": { "type": "string", "minLength": 1, "maxLength": 20 },
    "timeframe": { "type": "string" },
    "exchange": { "type": "string" }
  }
}
```

### Offering 2 — `AlgoVault Market Scan`  ·  0.02 USDC  ·  SLA 5m
> Ranked multi-asset scan of actionable perp trade calls across the venue universe — verdict,
> confidence and regime per asset. Read-only.

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "topN": { "type": "integer", "minimum": 1, "maximum": 50 },
    "timeframe": { "type": "string" },
    "exchange": { "type": "string" },
    "rankBy": { "type": "string" },
    "minConfidence": { "type": "number", "minimum": 0, "maximum": 100 },
    "includeHolds": { "type": "boolean" },
    "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
  }
}
```

### Offering 3 — `AlgoVault Funding Arb`  ·  0.01 USDC  ·  SLA 5m
> Cross-venue perpetual funding-rate arbitrage scanner — ranked spread opportunities with urgency
> and conviction. Read-only.

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "minSpreadBps": { "type": "number", "minimum": 0 },
    "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
  }
}
```

> The deliverable is our public signal envelope returned off-chain via `session.submit(...)` —
> the exact shape the `/x402` + MCP channels return (never `outcome_return_pct`). USDC settlement on
> Base is revenue, not on-chain publication.

---

## 3. Mint the signer + copy creds

1. On the agent page open the **Signers** tab → **+ Add Signer** → **Copy Key**.
2. You now have three values:
   - **walletAddress** — the agent (smart) wallet address
   - **walletId** — the Privy wallet id
   - **signerPrivateKey** — the signer key (secret — treat like a private key)

---

## 4. Put the creds in the container env (never commit them)

Store the signer key like the other secrets (mode-600 file, e.g. alongside
`~/.config/algovault/admin.env`; **never inline in a committed file** — the CI secret-scan must
stay green). Add these to the **Hetzner container env** (the same mechanism that carries
`X402_WALLET_ADDRESS`):

```sh
ACP_ENABLED=true
ACP_ENV=mainnet                       # Base mainnet — the web console registers production agents.
ACP_PRIVY_APP_ID=cltsev9j90f67yhyw4sngtrpv   # prod Privy app (the wallet's app; signing points here)
ACP_WALLET_ADDRESS=0x…                # from Signers → walletAddress
ACP_WALLET_ID=…                       # from Signers → walletId
ACP_SIGNER_PRIVATE_KEY=…              # from Signers → Copy Key (secret — install via one-time-secret)
```

Recreate the container so it picks up the new env (`docker compose up -d <service>` — a plain
`restart` does NOT reload `env_file`). Verify:

```sh
docker exec <ctr> env | grep '^ACP_'          # ACP_ENABLED + creds present (redact the key when pasting)
docker logs <ctr> 2>&1 | grep -i 'ACP seller' # expect: "Virtuals ACP seller worker started (mode=live)"
```

If any signer cred is missing the worker runs the **[STUB] seller** (dark, no settlement) — safe,
but no real jobs. If all three are present it runs **live** on **Base mainnet**.

---

## 5. Gas (Base mainnet)

The seller's on-chain ops (`setBudget`/`submit`) run through an Alchemy smart wallet on Base
(`8453`), an ERC20-**sponsored** chain — so seller-side gas is expected to be paymaster-sponsored
(confirmed at the first real job). No Base ETH funding is required for the seller to *receive* jobs;
USDC revenue settles TO `ACP_WALLET_ADDRESS`. (The buyer side + funding is in the graduation runbook.)

---

## 6. Local dry-run (optional, no creds needed)

To watch the full lifecycle offline before going live:

```sh
ACP_ENABLED=true node dist/channels/acp/seller-worker.js
```

Expected: `[STUB] seller` → `setBudget $0.02` → a real deliverable → `delivered get_trade_call` →
`completed`. (Runs the real signal tool against live exchange data; no chain interaction.)

---

## 7. Graduation → `P1-ACP-MAINNET-GRADUATION`

Graduation is a **manual** Virtuals review on **Base mainnet**: **10 successful jobs incl. 3
consecutive** via our own test-buyer, then submit the Graduate-Agent form → the agent becomes
discoverable in the A2A tab. The full click-by-click (register the 2nd buyer agent, fund it,
`--smoke`, run 10, submit the form) is in
[`RUNBOOK-VIRTUALS-ACP-GRADUATION.md`](RUNBOOK-VIRTUALS-ACP-GRADUATION.md), driven by
`src/scripts/acp-graduation-buyer.ts`. Progress tracked in `status.md` under `P1-ACP-MAINNET-GRADUATION`.

---

## Rollback

Set `ACP_ENABLED=false` (or unset it) and recreate the container → the worker never starts → prod
is byte-identical. Instant, no redeploy required beyond the env change.

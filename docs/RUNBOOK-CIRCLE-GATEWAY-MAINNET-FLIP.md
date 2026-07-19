# RUNBOOK — Circle Gateway mainnet flip (operator-executed)

**Wave:** `CIRCLE-GATEWAY-MAINNET-ENABLE-W1` · **Status after that wave:** code shipped, flag **OFF**.
**This runbook is the R-flip.** Everything here is operator-executed: it involves key material, real
funds, and a production env change. Nothing in it is automated, by design.

---

## 0. What shipped, and what did NOT

| | |
|---|---|
| ✅ shipped | Gateway scheme wired for **OP Mainnet `eip155:10`**, mainnet facilitator allow-listed, `gatewayRequirementsCarryDomain()` backstop, tests |
| ❌ NOT done | no seller key exists, no funds moved, no flag flipped, **no real mainnet settle has ever run** |

**Why OP Mainnet and not Base.** On Base, CDP and Gateway are both `exact` on `eip155:8453` —
identical in all three keys the x402 SDK dispatches on. They cannot coexist on one resource server,
and both failure layers are silent (`register()` is first-wins; `getSupportedKind()` has no `extra`
dimension). The Gateway entry would build successfully with `extra = {}` and be unpayable. OP Mainnet
reproduces the distinct-network topology already proven on Base Sepolia. **Do not "simplify" this by
moving Gateway to `eip155:8453`** — the env allow-list refuses it and the backstop would drop it, but
the right response to that refusal is to re-read this section, not to widen the list.

Buyers are not disadvantaged: Circle Gateway balances are unified and chain-agnostic, so a payer
spends the same balance regardless of which chain the resource advertises on.

---

## 1. Prerequisites (before touching prod)

1. **Generate a dedicated seller EOA.** Not the CDP revenue wallet (`0x778A…d59`) — a separate key,
   so Gateway receipts and CDP receipts do not share a blast radius.
   - It MUST be a plain EOA. Gateway recovers the signer with `ecrecover`; a smart-contract account
     will not work. Verify: `eth_getCode` on OP Mainnet must return `0x`.
   - Store the key in `~/.config/algovault/` mode 600, **outside any git repo**. Never paste it into
     a file in this repository, a commit, an env var in a committed compose file, or a chat message.
2. **Fund it with a small amount of OP-Mainnet ETH for gas.** `withdraw()` is an on-chain
   `gatewayMint()` **sent from the seller wallet** — it is NOT gasless. (`pay()` is gasless; only
   withdrawal costs gas. This distinction was gotten wrong once already on testnet.)
3. Confirm the mainnet facilitator is reachable:
   `curl -s https://gateway-api.circle.com/v1/x402/supported | jq '.kinds[] | select(.network=="eip155:10")'`

---

## 2. The flip

```bash
ssh -i ~/.ssh/algovault_deploy root@204.168.185.24
cd /opt/crypto-quant-signal-mcp

# Append to the env file (NEVER inline secrets in a committed file):
#   CIRCLE_GATEWAY_ENABLED=true
#   CIRCLE_GATEWAY_FACILITATOR_URL=https://gateway-api.circle.com
#   CIRCLE_GATEWAY_NETWORK=eip155:10
#   CIRCLE_GATEWAY_SELLER_ADDRESS=0x<your dedicated seller EOA>

docker compose up -d mcp-server     # NOT `restart` — that does not reload env_file
docker exec <ctr> env | grep CIRCLE_GATEWAY   # verify it actually landed
```

**Expected startup log:**
`x402: Circle Gateway scheme ACTIVE (additive) — network=eip155:10 facilitator=https://gateway-api.circle.com seller=0x…`

**If you instead see** `Gateway entry DROPPED; CDP entry retained` — the backstop fired: the
advertised requirements lacked the `GatewayWalletBatched` domain. Do not flip anything else; that
message means the Gateway scheme did not serve the build. Investigate before proceeding.

---

## 3. Verify (in order — stop at the first failure)

1. **Both rails advertised.** `curl -s -X POST https://api.algovault.com/x402/get_trade_signal -H 'content-type: application/json' -d '{"coin":"BTC","timeframe":"1h"}' | jq '.accepts[] | {scheme,network,payTo,name:.extra.name}'`
   Expect two entries: `exact`/`eip155:8453`/`USD Coin`, and `exact`/`eip155:10`/`GatewayWalletBatched`.
2. **CDP rail unaffected** — the Base entry must be unchanged from before the flip.
3. **Small real settle** with a funded buyer, minimum amount. Confirm HTTP 200 and a real settlement id.
4. **Seller credited.** ⚠️ Testnet measured **~36 min** from payment to `completed` (payments are
   batched; N transfers share one on-chain tx). A short poll reading 0 does **not** mean failure.
5. **`withdraw()`** — see §4 before running it.

---

## 4. Withdrawal policy — threshold-triggered, MANUAL

**Do not withdraw per payment.** The fee is a flat **0.01 USDC charged ON TOP** of the requested
amount, so withdrawing a single $0.02 payment costs ~50%. Accumulate to a threshold (suggested: **≥ $5**)
before withdrawing.

Three hazards, all measured on testnet:

- **`maxFee` is a signed cap and the SDK defaults it to 2.01 USDC.** Set it explicitly. Never
  blind-sign the default on mainnet.
- **Balance check must account for the fee on top.** Requesting your full balance fails
  (`available 0.98, required 0.99`). Withdraw `balance − fee`.
- 🛑 **`withdraw()` is NOT ATOMIC.** The API burns the ledger balance **before** the on-chain mint.
  If the mint reverts (most commonly: no gas), the balance is gone and nothing was delivered, and the
  SDK has no retry path. Recovery is possible **only** because the attestation + signature appear in
  the revert error and can be re-submitted directly to the GatewayMinter — so **capture and persist
  the full error object** on any failed withdraw before doing anything else.

Pre-flight every withdrawal: seller ETH balance > 0, explicit `maxFee`, amount = balance − fee.

Automation is deliberately deferred — it would automate a non-atomic, fund-stranding operation.
A later wave can add it once attestation persistence and retry are built.

---

## 5. Rollback

```bash
# set CIRCLE_GATEWAY_ENABLED=false in the env file, then:
docker compose up -d mcp-server
```

Instant and byte-identical: with the flag off the Circle facilitator is never constructed and the
402 returns to the CDP-only shape. Any Gateway balance already credited is unaffected and remains
withdrawable — the flag governs advertisement, not custody.

---

## 6. Open / unverified

- **Seller-side withdrawal-chain flexibility is UNVERIFIED.** Circle documents unified cross-chain
  balances explicitly for spending; the seller-withdrawal side is only implied. Confirm during the
  first withdrawal rather than assuming it.
- No `PAYMENT-RESPONSE` receipt header is emitted on this rail. Circle's client reads it
  *optionally*, and the Base-Sepolia loop settled without it — non-blocking, tracked separately.

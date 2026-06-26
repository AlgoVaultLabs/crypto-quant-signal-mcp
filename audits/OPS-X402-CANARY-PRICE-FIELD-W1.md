# OPS-X402-CANARY-PRICE-FIELD-W1 (FILED — awaiting architect ratification)

**Filed by:** TRANSPORT-CHANNEL-COVERAGE-AUDIT-W1 (2026-06-26) · finding F1
**Class:** verification-script robustness (latent) · **NOT** a gate/price/quota mutation, **NOT** a coverage gap.
**Status:** proposed diff below; NOT applied (a canary-logic edit is outside the audit's additive `channels{}`-only write scope). This follow-up runs its own Plan-Mode + declares its own system-map edges (expect NONE — internal verification script).

## Problem (live evidence)

`scripts/check-feature-registry-drift.mjs` LIVE mode assertion **B** (per-route x402 price parity) reads:

```js
const atomic = body?.accepts?.[0]?.maxAmountRequired;
if (atomic !== undefined) { /* compare usd vs registry basePriceUsd */ }
```

The live `/x402/*` 402 challenge is x402 **v2** (`"x402Version": 2`) and carries the price in `accepts[0].amount`, NOT `maxAmountRequired`. Live body (probed 2026-06-26, `GET https://api.algovault.com/x402/get_trade_signal`):

```json
{
  "x402Version": 2,
  "accepts": [
    { "scheme": "exact", "network": "eip155:8453",
      "amount": "20000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0x778A05280Fd8dB980E920fE9f31d0A8eAbD17d59",
      "maxTimeoutSeconds": 300, "extra": { "name": "USD Coin", "version": "2" } }
  ]
}
```

So `maxAmountRequired` is `undefined` → the `if` guard skips the comparison → **the live price-parity sub-check is a silent no-op.** Impact: the weekly `--live` canary would NOT catch a *live-served* x402 price that drifted from the registry (it still catches 402-status and route-set drift). Note `--check` assertion 2 already locks registry↔`TOOL_PRICING` statically, so registry↔code parity is enforced; only live-served price drift is unguarded.

## Proposed diff (additive — field-name fallback, no behavior change to status/route checks)

`scripts/check-feature-registry-drift.mjs`, `runLive()` assertion B:

```diff
-      const body = await r.json().catch(() => null);
-      const atomic = body?.accepts?.[0]?.maxAmountRequired;
-      if (atomic !== undefined) {
+      const body = await r.json().catch(() => null);
+      // x402 v2 carries the price in accepts[0].amount; v1 used maxAmountRequired. Accept either.
+      const atomic = body?.accepts?.[0]?.amount ?? body?.accepts?.[0]?.maxAmountRequired;
+      if (atomic !== undefined) {
         const usd = Number(atomic) / 1e6;
         if (Math.abs(usd - t.x402.basePriceUsd) > 1e-9) {
           drifts.push(`/x402/${t.name} price $${usd} != registry $${t.x402.basePriceUsd}`);
         }
       }
```

## Verification after apply

1. `node scripts/check-feature-registry-drift.mjs --live https://api.algovault.com` → rc=0 (prices now actively compared; all match today).
2. Negative: temporarily point at a stubbed `/x402` returning `amount:"99000"` → assertion B fires `price $0.099 != registry $0.02`, rc=1. (`--simulate-drift` only injects an MCP ghost tool; a small unit/stub proves B specifically.)

## Why filed, not inline

The audit's declared writes are: the audit artifact, the reusable matrix script, and (conditionally) additive `channels{}` rows. A canary-logic edit is none of these. The live gap is already mitigated this wave by `scripts/transport-coverage-matrix.mjs` (reads `amount`), so there is no urgency — file + ratify is the disciplined path.

# FUNNEL-FIX-AGENT-X402-NUDGE-W1 — R1 Plan-Mode audit

**Status: 🛑 HALT for architect (Mr.1).** Audit-first complete; all cited primitives verified live (see `FUNNEL-FIX-AGENT-X402-NUDGE-W1-endpoint-truth.md`). One MAJOR spec-vs-prod drift (ACP) reshapes the headline design → architect decision required before R2.

**Target ICP:** T3 + META (AI-agent builders). **Ships DARK behind `X402_NUDGE_ENABLED` (default OFF).** No version bump (accrues to next EXTERNAL release).

---

## 1. What the leak is, and why the current nudge misses it

At the free 100/mo quota edge, `TierLimitReachedError` (`index.ts:179`) hands a **machine** a **human** Stripe subscription URL (`suggested_upgrade_url`) + a referral hint. An autonomous agent can't fill a Stripe checkout → ~0 convert. The fix: surface an **in-protocol x402 pay-per-call route** the agent can settle itself with its own wallet — additive, alongside the intact Stripe/referral fields.

## 2. Rails that actually exist for an agent to act on (live-verified)

| Rail | Reach predicate (single-derivation) | Agent-actionable route | Network / asset | Price src | Prod |
|---|---|---|---|---|---|
| **CDP x402 Bazaar** | `channels.httpX402` **&&** `resolveFacilitatorFromEnv().discoveryEnabled` | `POST https://api.algovault.com/x402/<tool>` (402 → sign ERC-3009 → `x-payment`) | Base `eip155:8453` / USDC | `TOOL_PRICING[tool]` | ✅ LIVE (402) |
| **okx.ai A2MCP** | `channels.a2mcp` **&&** `selectOkxA2mcp(env).mode==='live'` | `POST https://api.algovault.com/a2mcp/<tool>` (402 → `x-payment`) | X Layer `eip155:196` / USDT0 | `okxA2mcpPriceUsdt0` (=`basePriceUsd`) | ✅ LIVE (402) |
| **Virtuals ACP** | `channels.acp` && `ACP_ENABLED` | **none — no HTTP route** (Virtuals seller-worker protocol, job-negotiated) | Base | — | ⚠️ `ACP_ENABLED=true` but **not a route** |

Both HTTP x402 rails return the correct 402 for the canonical `get_trade_call` today. ACP does not fit a `{url, method, price}` shape (see §4 D1).

## 3. Proposed `suggested_x402` design (for architect sign-off)

**New pure helper `src/lib/x402-nudge.ts`** — registry owns REACH, helper maps SURFACE locally (per the channel-derivation pattern):

```ts
export interface X402Rail {
  rail: 'x402_bazaar' | 'okx_a2mcp';   // machine id
  label: string;                       // "CDP x402 Bazaar (Base/USDC)"
  method: 'POST';
  url: string;                         // bazaarResourceUrl(tool) | a2mcp base + tool
  network: string;                     // CAIP-2: eip155:8453 | eip155:196
  asset: 'USDC' | 'USDT0';
  price_usd: number;                   // TOOL_PRICING[tool]  (single-derivation)
  scheme: 'exact';                     // x402 exact / EIP-3009
}
export interface SuggestedX402 {
  tool: string;                        // canonical called tool
  instructions: string;               // agent-relayable one-liner
  primary: X402Rail;
  alternatives: X402Rail[];            // other live rails (may be [])
}
// default-deny: no live x402 rail for this tool  ⇒  returns undefined  ⇒  envelope unchanged
export function buildSuggestedX402(tool: string, env = process.env): SuggestedX402 | undefined;
```

- **Derivation:** live rail SET = registry per-tool reach flag **AND** that rail's runtime enable predicate (above). Map each to route+price LOCALLY. Never hardcode a rail; never surface a dark one. A rail flipped on/off in the SoT+env changes the output with **zero code change** (AC2).
- **Primary when >1 live:** Bazaar (Base/USDC — the broadest agent rail; caller likely already on Base); okx a2mcp as `alternatives[0]`.
- **Wire-in (allow-list formatter):** extract `buildTierLimitPayload(err, {suggestedX402})` from the inline `index.ts:179‑193` block (mirrors `buildInsufficientCandlesPayload`) and add the `suggested_x402` sibling there; also thread the called-tool into `computeTierWarning`/`withTierWarning` for the **hard** `tier_warning`. Both gated by `X402_NUDGE_ENABLED` (OFF ⇒ omit ⇒ byte-identical).
- **Coverage:** the single `index.ts` projection covers all 5 throw-sites at once (get_trade_call, get_market_regime, scan_funding_arb, get_equity_call, get_equity_regime). `scan_trade_calls` uses a separate envelope (D3).

## 4. Findings requiring architect decisions (detail in endpoint-truth §C)

- **D1 (MAJOR):** `ACP_ENABLED=true` in prod (not OFF) **and** ACP has no agent-actionable HTTP route → recommend EXCLUDE ACP from `suggested_x402`; prove rail-agnosticism via the okx a2mcp toggle / fixture instead of ACP.
- **D2:** extract the inline tier-limit payload into an exported allow-list formatter (required by AC3).
- **D3:** include `scan_trade_calls`' separate quota envelope, or defer to a follow-up?
- **D4:** equities are x402-payable and would get `suggested_x402`; confirm that's fine vs the "equities public-copy HOLD" note (this is agent-relayable metadata, not marketing copy).

## 5. Guardrails compliance (pre-checked)

- Stateless `free:${ipHash}` resolver — untouched (change is downstream of quota resolution).
- `tools/list` byte-identical — no `server.tool`/schema touched; response content+metadata only.
- Allow-list formatter + TS interface + unit test — via the extracted `buildTierLimitPayload` (D2). No internal-field leak; `outcome_return_pct` never referenced.
- x402 middleware boot (`registerExactEvmScheme`) — helper is read-only; mount/boot path never imported by it.
- `X402_NUDGE_ENABLED` OFF ⇒ envelope byte-identical (default-deny; verified as a test in R5).

## 6. system-map edges

New internal READ edge only (`x402-nudge.ts` → `feature-registry`/`TOOL_PRICING`/facilitator+okx configs); no producer/role/edge change to rails, quota, or `tools/list`. Confirm the single affected row + `Last touched:` overwrite at implementation, else `n-a`. (endpoint-truth §D.)

---

## 7. HALT — architect (Mr.1) decision block

Plain framing above; the questions Mr.1 answers are in ONE fenced block below (copy-paste to Cowork):

```
FUNNEL-FIX-AGENT-X402-NUDGE-W1 — Plan-Mode HALT (audit-first; base origin/main 075d408)
All cited primitives verified live; 0 fictional. Blocking decisions:

Q1 [MAJOR — spec vs prod]. Prod has ACP_ENABLED=true (the prompt says "ACP not live,
    expect OFF" — stale). AND Virtuals ACP has NO HTTP pay-per-call route: it is the
    seller-worker protocol (src/channels/acp/*; no /acp endpoint), which an agent cannot
    settle autonomously with an x-payment header the way it can /x402/<tool> and
    /a2mcp/<tool>. A field named suggested_x402 shaped {url,method,price} cannot faithfully
    represent ACP. Choose:
      (A, RECOMMENDED) suggested_x402 = the two REAL HTTP x402 rails only — Bazaar (Base/
          USDC) primary + okx a2mcp (X Layer/USDT0) alternative; EXCLUDE ACP. Prove
          rail-agnostic derivation (AC2/R4) via the okx a2mcp toggle (OKX_AI_ENABLED) or a
          fixture rail instead of ACP.
      (B) Also surface ACP, but as a SEPARATE protocol-shaped pointer (suggested_acp →
          Virtuals marketplace/offering ref, no HTTP url/price) — larger scope.
      (C) Other.

Q2 [primary rail default when >1 live]. Bazaar (Base/USDC) as `primary`, okx a2mcp as
    `alternatives[0]`?  (RECOMMENDED: yes — Base/USDC is the broadest agent rail.)

Q3 [route to surface for get_trade_call]. Canonical POST /x402/get_trade_call
    (public-copy-preferred; LIVE 402) — NOT the alias /x402/get_trade_signal. Confirm
    canonical.  (RECOMMENDED: canonical get_trade_call.)

Q4 [D3 — scanner coverage]. scan_trade_calls hits its quota wall via a SEPARATE returned
    envelope (not TierLimitReachedError), but IS x402-payable (/x402/scan_trade_calls 402).
    Add suggested_x402 to that envelope too (consistent coverage), or DEFER to a follow-up?
      (RECOMMENDED: include — one extra call to the same helper; closes the same leak.)

Q5 [D4 — equities]. get_equity_call/get_equity_regime throw TierLimitReachedError and are
    x402-payable ($0.02, route live) → they'd get suggested_x402 automatically. OK given the
    "equities = public-copy HOLD" note? (suggested_x402 is agent-relayable metadata, not
    marketing copy.)  (RECOMMENDED: OK — it's a live payable route, not a track-record claim.)

Q6 [agent-relayable wording]. Approve `instructions` copy, e.g.:
    "Free monthly quota reached. Pay per call with your own wallet — no signup: POST to the
     x402 route below (HTTP 402 → sign ERC-3009 → resend with x-payment). $0.02 per call."
     Adjust?

After answers: R2 helper → R3 wire-in (dark) → R4 rail-agnostic test → R5 tests+clean rebuild+both
gates → R6 status.md + file OPS-X402-WALLET-ATTRIBUTION-W1. Go-live = flip X402_NUDGE_ENABLED=1.
```

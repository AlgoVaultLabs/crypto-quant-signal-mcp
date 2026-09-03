# AlgoVault × Binance Agent OS — Build Verifiable AI Trading Agents

One MCP client. Two servers. AlgoVault decides, Binance executes.

> **Provenance:** Binance Agent OS is Binance's own agent toolkit — MCP server, Skill Hub, Exchange APIs, Binance Pay, Agentic Wallet. The MCP endpoint is `https://agent.binance.com/mcp/agentic`. It answers an unauthenticated `initialize` with `HTTP 401` and an RFC 9728 challenge pointing at `https://agent.binance.com/.well-known/oauth-protected-resource/gateway-mcp`, which resolves and names the same endpoint. That is the OAuth handshake working, not a fault. Verified 2026-08-25.

## What you'll build

An agent that asks AlgoVault what to do, then asks Binance to do it.

AlgoVault is the Brain Layer: it returns a composite verdict with confidence and market regime. Binance Agent OS is the execution layer beneath it: balances, prices, orders.

Nothing runs locally. There are no API keys on your machine, no HMAC request signing, and no SDK to install. Both servers are remote, and both are reached over HTTP by your existing client.

## Why this replaces the key-based flow

The older path — `/integrations/binance` — issues API keys and signs every request yourself. It still works, and it is still the right choice for custom order types or non-MCP runtimes. For an agent, Agent OS is strictly less exposure.

| Key-based flow | Agent OS |
|---|---|
| API key + secret stored on the machine | OAuth at connect time; no secret to leak |
| Keys scoped to your main account | Trading confined to an isolated Agentic sub-account |
| Permissions as broad as the key allows | Four scopes, chosen at connect time — and no withdrawal scope exists |

## Step 1 — Add Binance Agent OS

```bash
claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic
```

Run `/mcp`, select `binance-mcp-server`, and authenticate.

Scopes are chosen during that handshake: **market data** (no auth), **account**, **trade**, **transfer**. Grant the least you need. You can start with market data alone and reconnect later.

## Step 2 — Add AlgoVault

```bash
claude mcp add --transport http --scope project algovault \
  https://api.algovault.com/mcp?src=binance_agent_os \
  --header "Authorization: Bearer $AV_API_KEY" \
  --header "X-AlgoVault-Track-Token:int-binance-agent-os"
```

The free tier is **200 calls/month, capped at 100 per UTC day**. Drop the `Authorization` header to use it without signing up.

This writes `.mcp.json` in your repo root. Commit it, and teammates get both servers on clone.

## Step 3 — Fund the Agentic sub-account

**This is the one manual step. Everything else is agent-side.**

Your agent cannot pull funds from your main account. The sub-account starts empty and you transfer into it yourself:

`Profile → Dashboard → Sub-account → Asset Management → Transfer`

Direct link: <https://www.binance.com/en/my/sub-account/asset-management/transfer?asset=BTC>

Fund only what the agent may trade. That balance is your real risk limit, and it is enforced by Binance rather than by your prompt.

## Step 4 — The division of labour

Each server answers what it alone can answer.

| Question the agent asks | Server that answers | Why |
|---|---|---|
| Direction, confidence, regime | **AlgoVault** `get_trade_call` | Composite verdict across every supported perp venue, with a Merkle-anchored track record |
| Cross-venue funding spread | **AlgoVault** `scan_funding_arb` | A spread needs two venues; Binance's server sees one |
| Whole-market breadth | **AlgoVault** `scan_trade_calls` | Ranked calls across the scan universe |
| Live price, balance, position | **Binance** | Its own book, its own account |
| Place or cancel an order, move funds | **Binance** | Execution, confirmed by you every time |

The second row is the one worth reading twice. A single-venue server cannot compute a cross-venue spread, however good it is.

## Step 5 — Name the tool you want

With two servers connected, an exchange-shaped prompt is ambiguous. "What is BTC doing on Binance" names a venue, not a question — and AlgoVault exposes no exchange-operation tools, so nothing about that phrasing points at the verdict.

Name the tool and the ambiguity disappears:

> "Use AlgoVault's `get_trade_call` for BTC 15m on Binance. Show me signal, confidence and regime. If signal is BUY and confidence is above 70, place a $100 market buy on Binance spot — confirm with me before sending."

That prompt has one decision step and one execution step, and it says which server owns each. Make it a habit and you will not have to debug why a verdict never arrived.

## Step 6 — The safety envelope

- **No withdrawal scope exists.** Your agent cannot move funds to an external address. This is a property of the scope set, not a setting you enable.
- **Every non-read action is user-confirmed.** Orders and transfers wait for you.
- **Emergency stop:** `Profile → Dashboard → Sub-account → Account Management`. One step disconnects every agent and cancels open orders and positions.
- **Permission changes require disconnect and reconnect.** Scopes are fixed for the life of a connection.


## Common questions

**Does AlgoVault work with Binance Agent OS?**

Yes. Add both MCP servers to the same client. AlgoVault returns the composite verdict; Binance Agent OS executes it.

**Do I need Binance API keys?**

No. Binance Agent OS authenticates over OAuth at connect time. No API key or secret is stored on your machine.

**Can the agent withdraw my funds?**

No. There is no withdrawal scope. The agent cannot move funds to an external address, and trading is confined to a sub-account you fund yourself.

**Why does my agent ignore AlgoVault and use Binance tools?**

An exchange-shaped prompt is ambiguous with two servers connected. AlgoVault exposes no exchange-operation tools. Name the tool you want.

**What does AlgoVault add that Binance MCP does not?**

A cross-venue funding spread, which a single-venue server cannot compute, plus a composite verdict across every exchange AlgoVault covers, and a Merkle-anchored track record.

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Does AlgoVault work with Binance Agent OS?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Yes. Add both MCP servers to the same client. AlgoVault returns the composite verdict; Binance Agent OS executes it."
      }
    },
    {
      "@type": "Question",
      "name": "Do I need Binance API keys?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "No. Binance Agent OS authenticates over OAuth at connect time. No API key or secret is stored on your machine."
      }
    },
    {
      "@type": "Question",
      "name": "Can the agent withdraw my funds?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "No. There is no withdrawal scope. The agent cannot move funds to an external address, and trading is confined to a sub-account you fund yourself."
      }
    },
    {
      "@type": "Question",
      "name": "Why does my agent ignore AlgoVault and use Binance tools?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "An exchange-shaped prompt is ambiguous with two servers connected. AlgoVault exposes no exchange-operation tools. Name the tool you want."
      }
    },
    {
      "@type": "Question",
      "name": "What does AlgoVault add that Binance MCP does not?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "A cross-venue funding spread, which a single-venue server cannot compute, plus a composite verdict across every exchange AlgoVault covers, and a Merkle-anchored track record."
      }
    }
  ]
}
</script>

## Verify the record, then start

Every AlgoVault call is Merkle-anchored on Base L2. Read the live record at <https://algovault.com/track-record>, then get a key at <https://api.algovault.com/signup> and run Step 1.

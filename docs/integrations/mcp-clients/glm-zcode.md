# Connect AlgoVault to ZCode (GLM)

Add AlgoVault to Z.ai's GLM harness in four clicks. No file editing required.

> *Config verified 2026-08-05 against <https://zcode.z.ai/en/docs/mcp-services>.*

## Setup

Open **Settings** → **MCP Servers**, then click **New MCP Server** at the top right.

1. Set the type to **HTTP**.
2. Paste the service URL:

```
https://api.algovault.com/mcp?src=docs
```

3. Expand **Headers (optional)** and add the tracking header:

```
X-AlgoVault-Track-Token: int-glm-zcode
```

4. On paid tier, add one more header: `Authorization: Bearer av_live_…`. Free tier needs no key.

### Paste a config block instead

Switch to **Full configuration** and paste it directly. ZCode accepts both shapes:

```json
{
  "mcpServers": {
    "algovault": {
      "url": "https://api.algovault.com/mcp?src=docs",
      "headers": {
        "X-AlgoVault-Track-Token": "int-glm-zcode"
      }
    }
  }
}
```

## Example: get a BTC trade call

Ask ZCode: *"Use AlgoVault to check BTC at 4h."* It invokes `get_trade_call` and returns call, confidence, regime and the drivers behind them.

## Troubleshooting

- **Server shows as disconnected** — confirm the type is `HTTP`, not `SSE` or `stdio`.
- **Headers not applied** — the Headers section is collapsed by default. Expand it before saving.
- **`401 unauthorized`** — check the key shape (`av_live_…`). Free tier needs no `Authorization` header.
- **Pasted config rejected** — both the `mcpServers` wrapper and a bare server-name object are valid. Check for a trailing comma.
- **Network timeout** — AlgoVault is hosted at `api.algovault.com`. Check VPN or firewall rules.

## FAQ

**Free tier OK?** Yes. Skip the `Authorization` header. 200 calls/month (100/day), every coin and timeframe.

**Is this the same as the Z.ai API route?** No. ZCode is the app; the API route dials AlgoVault server-side with no client.

**HTTP or SSE?** Choose HTTP. AlgoVault speaks Streamable HTTP, which is the current transport.

**Which tools appear?** The same set every client gets, including `get_trade_call`, `scan_funding_arb` and `get_market_regime`.

## Next steps

Ask ZCode for a verdict before your next entry. [Verify the track record on-chain](https://algovault.com/track-record).

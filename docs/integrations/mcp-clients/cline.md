# Connect AlgoVault to Cline (VSCode)

Add AlgoVault as a remote MCP server to Cline, the VSCode coding agent. Streamable-HTTP transport; setup ≤2 minutes.

## Setup

Open the Cline panel in VSCode &rarr; MCP Servers &rarr; Remote Servers tab &rarr; Add server. OR edit `cline_mcp_settings.json` directly (Configure MCP Servers &rarr; Edit):

```json
{
  "mcpServers": {
    "algovault": {
      "type": "streamableHttp",
      "url": "https://api.algovault.com/mcp?src=docs",
      "headers": {
        "Authorization": "Bearer ${env:AV_API_KEY}",
        "X-AlgoVault-Track-Token": "int-cline"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

`type: "streamableHttp"` is the modern transport (recommended). The legacy `"sse"` type still works but is being deprecated upstream.

## Example: get a BTC trade call

In a Cline thread, type *"Use AlgoVault to check ETH 1h."* Cline lists the tools available, selects `get_trade_call`, and returns the parsed verdict.

Cline can also wire AlgoVault into multi-step plans — *"If ETH 1h is BUY, write a Python script that opens a long position via ccxt."*

## Troubleshooting

- **`streamableHttp` transport not supported** — update Cline to v3.x or later. v2.x only supports SSE.
- **"Server not initialized"** — first call needs the MCP handshake; Cline handles this automatically on `streamableHttp`. If you see this, switch `type` to `streamableHttp` (NOT `sse`).
- **`autoApprove` not respected** — Cline asks before each tool call by default. Add tool names to `autoApprove` (e.g. `["get_trade_call"]`) to pre-approve.
- **Cline can't find `cline_mcp_settings.json`** — path varies by OS. Access via Cline panel &rarr; Configure MCP Servers; that opens the file.
- **Tool calls silently rejected on free tier** — your free-tier counter is full (200 calls/month, 100/day; the monthly counter resets at the UTC month boundary and the daily one at 00:00 UTC). Remove the `headers` block if you accidentally left an empty Bearer; or upgrade at `algovault.com/account` for Starter (10,000/mo, 1,000/day).

## FAQ

**Cline vs Continue.dev?** Both are VSCode coding agents. Cline supports MCP natively. Continue.dev's MCP support is community-driven.

**Free tier?** Yes. Remove the `headers` field. 200 calls/month (100/day).

**SSE vs streamableHttp?** `streamableHttp` is the modern transport. AlgoVault MCP supports both, but new setups should use `streamableHttp`.

**Auto-approve safe?** Auto-approve is convenient for trusted servers. AlgoVault is read-only (no order placement), so auto-approving its tools won't trigger side effects.

## Next steps

Test AlgoVault in your VSCode workflow today. Free tier, no signup. [See the verified track record](https://algovault.com/track-record).

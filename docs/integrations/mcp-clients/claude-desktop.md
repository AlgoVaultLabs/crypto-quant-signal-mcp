# Connect AlgoVault to Claude Desktop

Add AlgoVault's MCP tools to Claude Desktop as a custom connector. ≤5 minutes; works on the free tier (200 calls/month, 100/day, no signup).

## Setup

Two paths. The UI path is easiest if you already use Claude Desktop daily.

**Path 1 — UI (recommended).** Open Claude Desktop &rarr; Settings &rarr; Connectors &rarr; *Add custom connector*. Name: `AlgoVault`. URL: `https://api.algovault.com/mcp?src=docs`. Save and restart Claude Desktop. The free tier needs no header. Paid tier: add `Authorization: Bearer av_live_…` as a custom header.

**Path 2 — JSON config.** Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "algovault": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://api.algovault.com/mcp?src=docs",
               "--header", "Authorization: Bearer ${AV_API_KEY}",
               "--header", "X-AlgoVault-Track-Token:int-claude-desktop"]
    }
  }
}
```

Set `AV_API_KEY` in the env block or your shell. Free tier: drop the `Authorization` header, but keep the `X-AlgoVault-Track-Token` header.

## Example: get a BTC trade call

Ask Claude: *"Get me a trade call for BTC on the 1h timeframe."* The tool indicator appears bottom-right of the input box during the call. Claude returns the parsed verdict (call, confidence, regime, indicators) without you seeing raw API JSON.

## Troubleshooting

- **Custom connector not appearing in tool list** — restart Claude Desktop after saving the connector. The connector list reads at app start.
- **Authorization failed** — confirm `AV_API_KEY` is set in the JSON env block, not just your shell. Claude Desktop spawns the MCP process in its own env scope.
- **Tool indicator never shows** — try the JSON config path. The UI's Streamable-HTTP transport sometimes fails handshake on flaky networks; the JSON config's `npx mcp-remote` shim is more resilient.
- **`npx not found`** (JSON path) — install Node 20+ (`brew install node` on macOS). Claude Desktop spawns `npx` via PATH.

## FAQ

**Do I need an API key for the free tier?** No. Free tier (200 calls/month, 100/day) works without any header. The UI path also accepts no-key setup.

**Which tier ships with Claude Desktop?** AlgoVault's free tier covers every coin and every timeframe. Paid tiers start at $9.99/mo (10,000 calls/mo, 1,000/day).

**Can my Claude.ai account share the connection?** No — Claude.ai (web) and Claude Desktop maintain separate connector lists. Add AlgoVault on each surface.

**How do I see my call usage?** Visit `algovault.com/account` with your API key. Live counters update within seconds.

## Next steps

Try it free: get a BTC trade call in Claude Desktop right now. No signup. [Verify the track record on-chain](https://algovault.com/track-record).

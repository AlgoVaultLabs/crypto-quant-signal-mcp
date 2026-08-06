# Connect AlgoVault to Claude Code

Wire AlgoVault into your Claude Code CLI as a project-scoped MCP server. Commit `.mcp.json` so every teammate gets the same setup.

## Setup

**One-liner (recommended):**

```bash
claude mcp add --transport http --scope project algovault \
  https://api.algovault.com/mcp?src=docs \
  --header "Authorization: Bearer $AV_API_KEY" \
  --header "X-AlgoVault-Track-Token:int-claude-code"
```

This writes `.mcp.json` in your repo root. Commit it; teammates clone, run `claude`, and the connector is already wired.

**`.mcp.json` shape (auto-generated):**

```json
{
  "mcpServers": {
    "algovault": {
      "type": "http",
      "url": "https://api.algovault.com/mcp?src=docs",
      "headers": {
        "Authorization": "Bearer ${AV_API_KEY}",
        "X-AlgoVault-Track-Token": "int-claude-code"
      }
    }
  }
}
```

Set `AV_API_KEY` in your shell or `.envrc`.

## Example: get a BTC trade call

In a Claude Code session, type `/mcp` to list connected servers. AlgoVault should appear with its tools (`get_trade_call`, `get_trade_signal`, `scan_funding_arb`, `get_market_regime`, and others). Then ask: *"Use AlgoVault to get a trade call for BTC 4h."* Claude Code shows the tool call inline; the returned JSON pretty-prints in the response.

## Troubleshooting

- **"Server not initialized" on first call** — Claude Code expects the 3-step MCP handshake; the `http` transport handles this automatically. If you see this error, your `.mcp.json` `type` might be set to `sse` instead of `http`.
- **`AV_API_KEY` not set in env** — Claude Code reads from the shell that launched it. Use direnv or set the key in `~/.zshrc`.
- **`.mcp.json` not picked up** — Claude Code reads `.mcp.json` from the CWD at session start. Restart Claude Code from the repo root.
- **`403 Forbidden`** — your key is expired or wrong tier. Visit `algovault.com/account` to verify.

## FAQ

**Project scope vs user scope?** Project (`.mcp.json` in repo root) shares with the team. User (`~/.claude/mcp.json`) is private.

**Free tier works?** Yes. Drop the `--header` arg from `claude mcp add`. 100 calls/month, all coins + timeframes.

**Multiple MCP servers?** Yes — repeat `claude mcp add` per server.

**How does this differ from Claude Desktop?** Claude Code is the CLI; Claude Desktop is the chat app. Both run on the same Claude family but use separate config files.

## Next steps

Add AlgoVault to your strategy-dev repo in 30 seconds. [See the verified track record](https://algovault.com/track-record).

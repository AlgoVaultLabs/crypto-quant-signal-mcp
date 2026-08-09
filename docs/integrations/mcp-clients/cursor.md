# Connect AlgoVault to Cursor

Drop AlgoVault into Cursor's IDE agent. Live trade calls inside your editor while you write strategy code.

## Setup

Edit `~/.cursor/mcp.json` (global, all projects) OR `.cursor/mcp.json` in the project root (per-project, commit-friendly):

```json
{
  "mcpServers": {
    "algovault": {
      "url": "https://api.algovault.com/mcp?src=docs",
      "headers": {
        "Authorization": "Bearer ${env:AV_API_KEY}",
        "X-AlgoVault-Track-Token": "int-cursor"
      }
    }
  }
}
```

Set `AV_API_KEY` in your shell. Restart Cursor. Cursor's agent now has the 4 AlgoVault tools available in any prompt.

## Example: get a BTC trade call

Open Cursor's agent panel. Ask: *"Use AlgoVault to check BTC at 4h."* The agent invokes `get_trade_call` and returns the verdict (call, confidence, regime, indicators) inline.

Cursor's coding agent can also chain AlgoVault calls into strategy-code edits — ask *"If BTC 4h is BUY, add a long entry at the current bar in `strategy.py`."*

## Troubleshooting

- **AlgoVault tool not showing in agent menu** — restart Cursor. The `mcp.json` is read at app launch.
- **`${env:AV_API_KEY}` not interpolated** — Cursor reads env vars from the shell that launched it (macOS Launchpad vs terminal differ). Set the key in `/etc/launchd.conf` or use `launchctl setenv` on macOS.
- **Network timeout** — AlgoVault MCP is hosted at `api.algovault.com`. Check VPN/firewall.
- **`401 unauthorized`** — confirm the Bearer key shape: `av_live_…` for paid; free tier needs NO header (delete the `headers` block entirely).
- **Tools appear once then disappear** — your `mcp.json` may have invalid JSON (trailing comma, unquoted key). Cursor silently drops servers it can't parse. Validate via `jq . ~/.cursor/mcp.json` (or use Cursor's Validate JSON command). Fix the parse error and restart.

## FAQ

**Free tier OK?** Yes. Remove the `headers` block from `mcp.json`. 200 calls/month (100/day), every coin + timeframe.

**Per-project vs global?** Per-project (`.cursor/mcp.json`) is commit-friendly — teammates inherit. Global is private.

**Cursor's agent vs chat?** Both have access to MCP tools. The agent can chain calls + edit code; chat is single-turn.

**Does Cursor Composer use these tools?** Yes. Composer has the same MCP access as the agent and chat panels.

## Next steps

Pull live signals into your strategy code, mid-edit. [Verify the track record on-chain](https://algovault.com/track-record).

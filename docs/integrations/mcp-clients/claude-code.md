# Connect AlgoVault to Claude Code

Wire AlgoVault into your Claude Code CLI as a project-scoped MCP server. Commit `.mcp.json` so every teammate gets the same setup.

## Setup

**One-liner (recommended):**

```bash
claude mcp add --transport http --scope project algovault \
  "https://api.algovault.com/mcp?src=docs" \
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

## Pre-trade gate

An opt-in plugin from the [AlgoVault skills marketplace](https://github.com/AlgoVaultLabs/algovault-skills). While it is enabled, Claude Code does not send an opening perpetual or futures order through an exchange's MCP tools until `pre_trade_check` has recently checked that coin and side, and it blocks the order when the check returns `WAIT`.

```bash
claude plugin marketplace add AlgoVaultLabs/algovault-skills
claude plugin install algovault-pre-trade-gate@algovault-skills
```

Requires Claude Code 2.1.295+ and Node.js 20+. The plugin holds no key and never calls AlgoVault itself: it reads the result of the `pre_trade_check` your agent runs through the server you connected above.

- **Passes:** a check from this session for the same coin and side, at most 15 minutes old, that returned `GO` or `CAUTION`. Claude is shown the decision, its reason codes, the checked size and the cheapest venue.
- **Blocked:** no recent check, a `WAIT`, an order the gate cannot read, or a gate that cannot run.
- **Never gated:** closes (reduce-only, or a hedge-mode close), spot, options, cancels, amends, and every AlgoVault tool.

The gated order tools and the options (check age, `WAIT` handling, your own order-tool list) are in the [plugin's README](https://github.com/AlgoVaultLabs/algovault-skills#pre-trade-gate-claude-code). Switch it off with `claude plugin disable algovault-pre-trade-gate@algovault-skills`.

## Troubleshooting

- **"Server not initialized" on first call** — Claude Code expects the 3-step MCP handshake; the `http` transport handles this automatically. If you see this error, your `.mcp.json` `type` might be set to `sse` instead of `http`.
- **`AV_API_KEY` not set in env** — Claude Code reads from the shell that launched it. Use direnv or set the key in `~/.zshrc`.
- **`.mcp.json` not picked up** — Claude Code reads `.mcp.json` from the CWD at session start. Restart Claude Code from the repo root.
- **`403 Forbidden`** — your key is expired or wrong tier. Visit `algovault.com/account` to verify.

## FAQ

**Project scope vs user scope?** Project (`.mcp.json` in repo root) shares with the team. User (`~/.claude/mcp.json`) is private.

**Free tier works?** Yes. Drop the `--header` arg from `claude mcp add`: 20 calls a month without a key; a free key gives 200 (100/day), all coins + timeframes.

**Multiple MCP servers?** Yes — repeat `claude mcp add` per server.

**How does this differ from Claude Desktop?** Claude Code is the CLI; Claude Desktop is the chat app. Both run on the same Claude family but use separate config files.

## Next steps

Add AlgoVault to your strategy-dev repo in 30 seconds. [See the verified track record](https://algovault.com/track-record).

# Install AlgoVault via Smithery

One command installs AlgoVault into Claude Desktop, Cursor, Cline, or Claude Code. Smithery picks the right config file for your client.

## Setup

```bash
npx -y @smithery/cli install crypto-quant-signal-mcp --client <name>
```

Replace `<name>` with: `claude`, `cursor`, `cline`, or `claude-code`.

Smithery writes the right MCP-server entry into your client's config file. If your client needs an API key, the CLI prompts for `AV_API_KEY` (or skip to use the free tier).

[//]: # "ATTRIBUTION-SRC-COVERAGE-W1: no raw remote MCP connect URL on this page to ?src=-tag — Smithery CLI writes the client config; this channel attribution rides the Smithery registry-listing slug ?src=smithery. Connect-uncapturable via this page by design; see scripts/check-attribution-src-coverage.mjs."

## Example: install for Claude Desktop

```text
$ npx -y @smithery/cli install crypto-quant-signal-mcp --client claude
✔ AlgoVault MCP installed for Claude Desktop.
✔ Config written to ~/Library/Application Support/Claude/claude_desktop_config.json.
ℹ Restart Claude Desktop to load.
```

Restart Claude Desktop. Open a chat and ask *"Use AlgoVault to check BTC 4h."* AlgoVault's tools are now available.

## Troubleshooting

- **`smithery: command not found`** — use `npx -y @smithery/cli` (not bare `smithery`). The CLI doesn't install globally by default.
- **"Client not detected"** — Smithery probes your machine for installed clients. If your client lives in a non-default path, pass `--config-path` manually.
- **Existing AlgoVault entry overwritten** — Smithery preserves other servers but replaces existing AlgoVault entries. Back up your config first if you've hand-edited.
- **`npm 404` on `@smithery/cli`** — confirm npm is configured for the public registry. Corporate proxies sometimes block.
- **Install succeeds but client doesn't see AlgoVault** — restart the client after install. Most MCP clients read their config file once at app start; in-place edits during a running session won't take effect until the next launch.

## FAQ

**Which clients does Smithery support?** Claude Desktop, Cursor, Cline, Claude Code. Continue.dev support is in beta.

**Free tier setup?** Yes. Hit Enter at the API-key prompt; Smithery writes a no-header config (free tier, 200 calls/month, 100/day).

**Can I see AlgoVault on the Smithery registry?** Yes — [smithery.ai/server/@AlgoVaultLabs/crypto-quant-signal-mcp](https://smithery.ai/server/@AlgoVaultLabs/crypto-quant-signal-mcp).

**What does Smithery actually do?** It generates the right `mcpServers` entry for your client's config file. Same result as hand-editing the JSON, but automated for each client's quirks.

## Next steps

One-command install: get AlgoVault in your client right now. [Verify the track record on-chain](https://algovault.com/track-record). The full AlgoVault listing is at [smithery.ai/server/@AlgoVaultLabs/crypto-quant-signal-mcp](https://smithery.ai/server/@AlgoVaultLabs/crypto-quant-signal-mcp).

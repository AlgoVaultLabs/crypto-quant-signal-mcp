# Connect AlgoVault to Codex

Give Codex a composite trade verdict in one call. Works in the Codex CLI and the IDE extension.

> *Config verified 2026-08-05 against <https://learn.chatgpt.com/docs/extend/mcp>. Live numbers refresh in-page from <https://algovault.com/api/performance-public>.*

## Setup

Codex reads MCP servers from `~/.codex/config.toml`. Add a table for AlgoVault:

```toml
[mcp_servers.algovault]
url = "https://api.algovault.com/mcp?src=docs"
bearer_token_env_var = "AV_API_KEY"

[mcp_servers.algovault.http_headers]
"X-AlgoVault-Track-Token" = "int-codex"
```

Set `AV_API_KEY` in your shell for paid tier. On free tier, delete the `bearer_token_env_var` line and keep the rest.

Note that `codex mcp add` covers **local stdio servers only**. Remote HTTP servers like AlgoVault are configured in the file, not through that command.

### IDE extension

Open settings, choose **MCP servers**, add a server, pick **Streamable HTTP**, and paste the same URL. The extension and the CLI read separate config, so set up whichever you use.

## Example: get a BTC trade call

Run `codex` in a terminal and ask: *"Use AlgoVault to check BTC at 4h."* Codex invokes `get_trade_call` and returns call, confidence, regime and the drivers behind them.

> *Screenshot placeholder — Codex CLI showing the AlgoVault tool call and the returned verdict.*

Chain it into edits: *"If BTC 4h is BUY, add a long entry at the current bar in `strategy.py`."*

## Troubleshooting

- **AlgoVault tools not listed** — restart Codex. `config.toml` is read at startup.
- **`codex mcp add` rejected the URL** — expected. That command adds stdio servers; use the TOML block above.
- **`401 unauthorized`** — check the key shape (`av_live_…`). Free tier needs no key at all: remove `bearer_token_env_var`.
- **TOML parse error** — header names contain a hyphen, so they must stay quoted inside `[mcp_servers.algovault.http_headers]`.
- **Network timeout** — AlgoVault is hosted at `api.algovault.com`. Check VPN or firewall rules.

## FAQ

**Free tier OK?** Yes. Drop `bearer_token_env_var`. 100 calls/month, every coin and timeframe.

**CLI and IDE together?** Yes. They keep separate config, so add the block in both if you use both.

**Does it need OAuth?** No. AlgoVault takes a bearer token, or nothing at all on free tier.

**Which tools appear?** The same set every client gets, including `get_trade_call`, `scan_funding_arb` and `get_market_regime`.

## Next steps

Ask Codex for a verdict before your next entry. Message [@algovaultofficialbot](https://t.me/algovaultofficialbot) for support, or [verify the track record on-chain](https://algovault.com/track-record).

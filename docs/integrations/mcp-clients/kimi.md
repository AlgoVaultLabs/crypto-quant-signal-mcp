# Connect AlgoVault to Kimi Code

Pull live trade verdicts into Moonshot's coding agent. One JSON entry, no SDK.

> *Config verified 2026-08-05 against <https://moonshotai.github.io/kimi-code/en/customization/mcp.html>. Live numbers refresh in-page from <https://algovault.com/api/performance-public>.*

## Setup

Edit `~/.kimi-code/mcp.json` (user level, all projects) OR `.kimi-code/mcp.json` in the project root (per-project, commit-friendly):

```json
{
  "mcpServers": {
    "algovault": {
      "url": "https://api.algovault.com/mcp?src=docs",
      "bearerTokenEnvVar": "AV_API_KEY",
      "headers": {
        "X-AlgoVault-Track-Token": "int-kimi"
      }
    }
  }
}
```

An entry carrying a `url` and no `transport` **is** an HTTP server — that is how Kimi Code tells the two apart, so there is no transport field to set.

Set `AV_API_KEY` in your shell for paid tier. On free tier, delete `bearerTokenEnvVar` and keep the rest.

### Guided alternative

Run `/mcp-config` in the TUI to add, edit or delete servers without touching the JSON.

## Example: get a BTC trade call

Ask Kimi: *"Use AlgoVault to check BTC at 4h."* It invokes `get_trade_call` and returns call, confidence, regime and the drivers behind them.

> *Screenshot placeholder — Kimi Code TUI showing the AlgoVault tool call and the returned verdict.*

## Troubleshooting

- **AlgoVault not listed** — restart Kimi Code, or run `/mcp-config` and confirm the entry is enabled.
- **Treated as a stdio server** — remove any `command` or `transport` key. A bare `url` is what marks it HTTP.
- **`401 unauthorized`** — check the key shape (`av_live_…`). Free tier needs no key: remove `bearerTokenEnvVar`.
- **Project config ignored** — the project file must sit at the repo root as `.kimi-code/mcp.json`.
- **Network timeout** — AlgoVault is hosted at `api.algovault.com`. Check VPN or firewall rules.

## FAQ

**Free tier OK?** Yes. Drop `bearerTokenEnvVar`. 100 calls/month, every coin and timeframe.

**User vs project config?** Project config is commit-friendly, so teammates inherit it. User config stays private.

**Do I need a transport field?** No. Adding one switches Kimi Code to the legacy SSE path.

**Which tools appear?** The same set every client gets, including `get_trade_call`, `scan_funding_arb` and `get_market_regime`.

## Next steps

Ask Kimi for a verdict before your next entry. Message [@algovaultofficialbot](https://t.me/algovaultofficialbot) for support, or [verify the track record on-chain](https://algovault.com/track-record).

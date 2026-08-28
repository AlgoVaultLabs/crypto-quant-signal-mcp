# Connect AlgoVault to DeepSeek Harness

Give your `dsh` agent live trade verdicts. Two steps: add a plugin, patch one config file.

> *Verified 2026-08-28 against `@deepseek-ai/dsh-mcp-client` 0.1.1-rc.2 and <https://github.com/deepseek-ai/deepseek-harness>. DSH ships prereleases only, and its README says to expect compatibility-breaking changes.*

## Prerequisites

`dsh` installed, and `pnpm` on your PATH. The plugin command forwards to pnpm; without it you get `dsh: pnpm not found on PATH`.

## Step 1 — add the MCP client plugin

```bash
dsh plugin --profile <name> add @deepseek-ai/dsh-mcp-client@0.1.1-rc.2
```

The version is pinned deliberately. npm's `latest` tag still points at `0.0.1-rc.1`, published 2026-08-10 under BSD-3-Clause. MIT starts at `0.1.0-rc.2`, so an unpinned install gets you the older build and the older licence.

No shipped bundle includes this plugin. The `base`, `headless` and `web-app` bundles all declare zero MCP dependencies, so the install is genuinely two steps.

## Step 2 — patch the profile

Edit `~/.dsh/profiles/<name>/cordis.patch.yml` for one profile, or `~/.dsh/cordis.patch.yml` for every profile. `$DSH_HOME` overrides `~/.dsh`.

```yaml
- insert:
    - id: mcp-algovault
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: algovault
        transport: streamable-http
        url: https://api.algovault.com/mcp?src=deepseek_harness
        headers:
          X-AlgoVault-Track-Token: int-deepseek-harness
```

**Do not edit `cordis.yml`.** It exists, but DSH rewrites it on every boot; its own header says to edit `cordis.patch.yml` instead.

**The `- insert:` wrapper is required.** An entry without it is treated as an id-targeted override of an existing row. A missing id is skipped with a warning, so a pasted bare `- id: / name: / config:` block mounts nothing and looks like it worked.

## Step 3 — call it

Tools arrive server-qualified, as `mcp__algovault__<tool>`:

- `mcp__algovault__get_trade_call` — one asset, one timeframe, one verdict
- `mcp__algovault__scan_trade_calls` — a whole-market scan
- `mcp__algovault__get_market_regime` — the regime behind the call
- `mcp__algovault__scan_funding_arb` — cross-venue funding spreads
- `mcp__algovault__chat_knowledge` and `mcp__algovault__search_knowledge`

Ask `dsh`: *"Get me a trade call for BTC on the 1h timeframe."*

It invokes `get_trade_call` and returns the call, a confidence score, the market regime, and the drivers behind them. The longest namespaced name is 33 characters, well inside DSH's 64-character budget, so nothing is truncated or hash-suffixed.

## Paid tier

Add one line to the same `headers` block:

```yaml
        headers:
          X-AlgoVault-Track-Token: int-deepseek-harness
          Authorization: Bearer av_live_...
```

`headers` is a plain string-to-string dict. The free tier needs no key at all: 200 calls a month, 100 a day, every coin and every timeframe.

## What DSH does not bridge

DSH bridges **tools only**. Its README lists resources and prompts as deferred, with no harness consumer.

AlgoVault publishes its track record as an MCP resource. Inside DSH that resource is not reachable, so read it on the web instead: [verify the track record on-chain](https://algovault.com/track-record).

## Troubleshooting

- **Nothing mounted, no error** — the patch entry is missing its `- insert:` wrapper. DSH read it as an override of a row that does not exist and skipped it.
- **Your edit vanished** — you edited `cordis.yml`. DSH rewrites that file on boot. Move the entry to `cordis.patch.yml`.
- **`dsh: pnpm not found on PATH`** — install pnpm. The plugin command is a thin forwarder to it.
- **Older build installed** — you dropped the `@0.1.1-rc.2` pin, so npm resolved `latest` to `0.0.1-rc.1`.
- **`401 unauthorized`** — check the key shape (`av_live_...`). On free tier, remove the `Authorization` header entirely.
- **Tools missing after a restart** — confirm the profile you patched is the profile you launched.

## FAQ

**Free tier OK?** Yes. Drop the `Authorization` header. 200 calls a month, 100 a day.

**Why pin the version?** npm's `latest` still points at the 2026-08-10 build, which is BSD-3-Clause. MIT begins at `0.1.0-rc.2`.

**One profile or all?** `~/.dsh/profiles/<name>/cordis.patch.yml` patches one. `~/.dsh/cordis.patch.yml` patches every profile.

**Is this the same as the DeepSeek model path?** No. [The DeepSeek row](/integrations) covers pointing a harness you already run at DeepSeek's Anthropic-compatible endpoint. This page is DeepSeek's own runtime connecting to AlgoVault directly.

**Which tools appear?** The same set every client gets, led by `get_trade_call`.

## Next steps

Ask `dsh` for a verdict before your next entry. [Verify the track record on-chain](https://algovault.com/track-record).

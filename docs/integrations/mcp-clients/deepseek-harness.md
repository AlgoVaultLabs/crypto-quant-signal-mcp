# Connect AlgoVault to DeepSeek Harness

Give your `dsh` agent live trade verdicts. One step: patch one config file.

> *Verified 2026-08-29 against `dsh` 0.1.1-rc.2 and <https://github.com/deepseek-ai/deepseek-harness>. DSH ships prereleases only, and its README says to expect compatibility-breaking changes.*

## Prerequisites

`dsh` installed. Nothing else — you already have the MCP bridge.

## There is no install step

The `dsh` CLI ships `@deepseek-ai/dsh-mcp-client` in its own dependency closure, so a plain `dsh` install already put the bridge on disk. The bridge's README says it outright: *"Add one entry per server; nothing else is required."*

This is worth stating because the obvious check points the wrong way. The `base`, `headless` and `web-app` bundles declare zero MCP dependencies, which is true and reads like proof that you must install something. It is not. A bare plugin `name` in a patch row resolves through the profile directory's Node parent walk, which reaches `$DSH_HOME/profiles/node_modules` — and that directory is fed by the CLI's dependency closure, not by any bundle's `package.json`. Bundle membership is the wrong question.

Running `dsh plugin add` on it does not help either. The reconciler that builds the layer stack only promotes a dependency whose manifest declares a `dsh.bundle` key; `@deepseek-ai/dsh-mcp-client` declares none, so it stays plain with a one-time warning and never joins the stack. Nothing about the config entry below changes.

Nothing is enabled by default, which is deliberate: DSH treats each server command as trusted executable code outside the agent sandbox, so you opt in per server. The entry below is that opt-in.

## Step 1 — patch the profile

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

**The `- insert:` wrapper is required.** An entry without it is treated as an id-targeted override of an existing row. A missing id is skipped with a warning, so a pasted bare `- id: / name: / config:` block mounts nothing and looks like it worked. The bridge's own README shows the unwrapped form because it documents the plugin config shape, not a `cordis.patch.yml` edit — copy the wrapped form above.

## Step 2 — call it

Tools arrive server-qualified, as `mcp__algovault__<tool>`:

- `mcp__algovault__get_trade_call` — one asset, one timeframe, one verdict
- `mcp__algovault__scan_trade_calls` — a whole-market scan
- `mcp__algovault__get_market_regime` — the regime behind the call
- `mcp__algovault__scan_funding_arb` — cross-venue funding spreads
- `mcp__algovault__chat_knowledge` and `mcp__algovault__search_knowledge`

Ask `dsh`: *"Get me a trade call for BTC on the 1h timeframe."*

It invokes `get_trade_call` and returns the call, a confidence score, the market regime, and the drivers behind them. `serverName` must match `[A-Za-z0-9_-]{1,32}` and be unique across live bridge instances; `algovault` is nine characters, so it fits with room to spare.

Discovery is asynchronous, so wait for the `mcp__algovault__*` tools to appear before sending the first prompt. A new `dsh` session picks up the entry; a host restart is not needed.

## Paid tier

Add one line to the same `headers` block:

```yaml
        headers:
          X-AlgoVault-Track-Token: int-deepseek-harness
          Authorization: Bearer av_live_...
```

`headers` is a plain string-to-string dict. The free tier needs no key at all: 200 calls a month, 100 a day, every coin and every timeframe.

## What DSH does not bridge

DSH bridges **tools only**. The bridge's README lists resources and prompts as deferred, with no harness consumer mechanism.

AlgoVault publishes its track record as an MCP resource. Inside DSH that resource is not reachable, so read it on the web instead: [verify the track record on-chain](https://algovault.com/track-record).

## Troubleshooting

- **Nothing mounted, no error** — the patch entry is missing its `- insert:` wrapper. DSH read it as an override of a row that does not exist and skipped it.
- **Your edit vanished** — you edited `cordis.yml`. DSH rewrites that file on boot. Move the entry to `cordis.patch.yml`.
- **"My bundle lists no MCP dependency"** — expected, and not a problem. The bridge comes from the `dsh` CLI's dependency closure, not from a bundle. Skip straight to the patch entry.
- **Tools appear a moment late** — discovery is asynchronous. Wait for the `mcp__algovault__*` names before prompting.
- **`401 unauthorized`** — check the key shape (`av_live_...`). On free tier, remove the `Authorization` header entirely.
- **Tools missing after a restart** — confirm the profile you patched is the profile you launched.

## FAQ

**Do I need to install a plugin first?** No. `dsh` ships `@deepseek-ai/dsh-mcp-client` as its own dependency, and the patch entry above resolves it from the profile's Node parent walk. The config entry is the whole job.

**Free tier OK?** Yes. Drop the `Authorization` header. 200 calls a month, 100 a day.

**One profile or all?** `~/.dsh/profiles/<name>/cordis.patch.yml` patches one. `~/.dsh/cordis.patch.yml` patches every profile.

**Is this the same as the DeepSeek model path?** No. [The DeepSeek row](/integrations) covers pointing a harness you already run at DeepSeek's Anthropic-compatible endpoint. This page is DeepSeek's own runtime connecting to AlgoVault directly.

**Which tools appear?** The same set every client gets, led by `get_trade_call`.

## Next steps

Ask `dsh` for a verdict before your next entry. [Verify the track record on-chain](https://algovault.com/track-record).

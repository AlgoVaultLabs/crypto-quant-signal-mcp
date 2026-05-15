# MCP-REGISTRY-PUBLISH-W1 — endpoint-truth.md

**Wave:** Sync v1.11.1 across MCP registry + Claude DXT + LobeHub manifests.
**Plan-Mode-init reason:** External CLI first-use (`mcp-publisher` not previously referenced in this repo's status.md / waves) + identifier `1.11.1` cited across `server.json` + `manifest.json` (potentially also `lobehub-manifest.json`).
**Probed:** 2026-05-16 from `/Users/tank/crypto-quant-signal-mcp`.

---

## Truth table

| Probe | Spec claim | Live reality | Resolution |
|---|---|---|---|
| (1a) `AlgoVaultFi` GitHub org exists | yes | `curl -sSI https://github.com/AlgoVaultFi` → `HTTP/2 200` | OK — namespace anchor is reachable. |
| (1b) `AlgoVaultLabs` GitHub org exists | yes | `curl -sSI https://github.com/AlgoVaultLabs` → `HTTP/2 200` | OK — repo URL anchor is reachable. |
| (1c) `mcpName` namespace divergence acknowledged | spec says DO NOT change `mcpName` | `package.json.mcpName = "io.github.AlgoVaultFi/crypto-quant-signal-mcp"`, `package.json.repository.url = "https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp"` — divergence intentional | OK — preserve `mcpName` as-is; the existing registry entry chain (10 prior versions, see (3)) anchors there. |
| (2) `mcp-publisher` install path | spec assumed install needed via GitHub release binary | `command -v mcp-publisher` → `/opt/homebrew/bin/mcp-publisher`; `mcp-publisher --version` → `1.5.0 (commit: Homebrew, built: 2026-03-06T22:57:51Z)` | **CHANGED** — already installed via Homebrew (`brew install mcp-publisher` line in older session). NO install step needed; spec install block is moot. |
| (3) Existing MCP registry entry | spec assumed v1.10.6 was last published | `curl -sS 'https://registry.modelcontextprotocol.io/v0/servers?search=algovault'` → 10 prior entries; `isLatest:true` on **`1.10.8`** (publishedAt `2026-05-08T08:28:57Z`) — NOT `1.10.6` | **CHANGED** — registry's last-published is `1.10.8` (the Telegram-bot launch release), so this wave's publish jumps registry from `1.10.8` → `1.11.1` (3 patch versions of compounded delta — `1.10.7` README polish + `1.10.8` Telegram bot were never published; `1.11.0` BINANCE default + `1.11.1` TradFi alias also never published). |
| (4) `server.json` schema reachable | spec asks `curl SCHEMA \| jq 'keys'` | `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json` → 200 OK; top-level keys = `["$comment","$id","$ref","$schema","definitions","title"]` | OK — schema reachable + valid JSON Schema document. `mcp-publisher validate` against current `server.json` returns `✅ server.json is valid`. |
| (5) DXT `manifest_version` current | spec asked is 0.3 still current | `curl -sL https://raw.githubusercontent.com/anthropics/dxt/main/MANIFEST.md` shows BOTH `manifest_version: "0.3"` (3 example references) and `"0.4"` (1 example). 0.4 is the latest spec; 0.3 still valid. | OK — keep `manifest_version: "0.3"` (out-of-scope to bump the spec version; this wave is `version + description` only). Future wave can bump to 0.4 once any 0.4-specific keys are evaluated. |
| (6) LobeHub auto-pull source | spec asked which file lobehub auto-pulls from main | `curl -sS 'https://chat-plugins.lobehub.com/index.json'` → 40 plugins listed; **NO entry matching `algovault\|crypto-quant\|signal`**. The legacy ChatGPT-plugin index does NOT contain AlgoVault. The current `lobehub-manifest.json` in repo uses the legacy `chat-plugins.lobehub.com/schema/lobeChatPlugin.json` schema. LobeHub has separately moved to an MCP marketplace at `lobehub.com/mcp/<slug>` (302 redirect on direct probe; UI-rendered, no documented JSON crawl-source visible). | **PARTIAL** — `lobehub-manifest.json` in repo is documentation-only / aspirational; AlgoVault is NOT currently in the LobeHub chat-plugins index. Bump version + clean stale copy AS DOCUMENTATION; gate AC #5 (LobeHub catalog reflects within 24h) to a P3 follow-up rather than a hard gate. |
| (7) No-publish required for lobehub | spec asked confirm bump-and-push is sufficient | Same as (6) — auto-pull source unconfirmed. | Same — documentation-only update; no upstream PR required. P3 follow-up: file separate `LOBEHUB-RESUBMIT-W1` to investigate canonical MCP-marketplace submission flow at `lobehub.com/mcp/...`. |
| (8) `server.json` already at 1.11.1 in repo | spec assumed `1.10.6` in repo | `jq '.version, .packages[0].version' server.json` → `"1.11.1"` (both fields). The TRADFI-SYMBOL-ALIAS-W1 commit `4236aa3` already bumped these. | **CHANGED** — repo file is in sync with npm; only the registry-side publish is behind. AC #1 server.json check passes pre-edit. |
| (9) `manifest.json` description drift vs spec | spec said current description is `"… 710+ assets on Hyperliquid."` | Actual current description: `"… 730+ assets on Hyperliquid."` (drift detected; live README also says 730+, NPM-readme-DRAFT.md SoT says 720+ — natural snapshot drift; CLAUDE.md asset-count discipline acknowledges this) | **CORRECTED** — replacement description in spec uses `710+`, but the canonical live README in this repo says `730+`. Per Factuality LAW + CLAUDE.md "Live data over baked-in numbers" guidance for static-string fields, use **`730+`** (the closest live snapshot). Replacement string ships as: `"The Brain Layer for AI Trading Agents — composite quant trade calls, cross-venue funding arb, and regime-aware market classification across 5 exchanges (Binance, Hyperliquid, Bybit, OKX, Bitget) via MCP. 730+ assets, on-chain track record."` |
| (10) Operator architecture | spec assumed darwin-arm64 binary if install needed | `uname -sm` → `Darwin arm64`; chip = Apple M3 Pro | OK — but install moot per (2). |

## HALT-class findings

NONE.

- (1c) Namespace divergence is by design and Mr.1-acknowledged.
- (3) Registry entry exists at the correct namespace; the publish is an UPDATE, not a first-time registration. No namespace migration needed.

## Identifier diff (R-section vs AC-section)

| Identifier | R-section (Requirements) | AC-section (Acceptance) | Match? |
|---|---|---|---|
| `server.json` target version | `1.11.1` | `1.11.1` | ✅ |
| `manifest.json` target version | `1.7.0` | `1.7.0` | ✅ |
| `lobehub-manifest.json` target version | `"2"` | `"2"` | ✅ |
| `mcpName` namespace | `io.github.AlgoVaultFi/crypto-quant-signal-mcp` | (implicit; AC#4 cites this name in jq) | ✅ |
| Asset count in description (drift fix) | spec text uses `710+` | reality says `730+` | **CORRECTED to `730+`** per (9) |

## Plan Mode Step 0 system-map.md edge enumeration

**External Integrations rows the wave will MUTATE (3 NEW rows):**

1. **NEW** `### MCP Registry (registry.modelcontextprotocol.io)` — AlgoVault entry at `io.github.AlgoVaultFi/crypto-quant-signal-mcp`, currently at `1.10.8`; this wave bumps to `1.11.1`.
2. **NEW** `### Claude Desktop / DXT (`manifest.json`)` — `crypto-quant-signal` extension, currently at `1.6.0`; this wave bumps to `1.7.0` + drops HL-conflated description.
3. **NEW** `### LobeHub MCP marketplace (`lobehub-manifest.json`)` — repo-internal manifest at version `"1"`; this wave bumps to `"2"`. Aspirational / documentation-only per (6) — AlgoVault not yet in lobehub's chat-plugins index.

**Producer→Consumer edge table — 3 NEW rows** (all `signal-MCP` → registry/marketplace edges; coupling = `loose` for the registry one (one-way push at publish-time, registry doesn't trigger anything in our system) and `documented-only` for DXT + LobeHub (we publish the manifest in-repo; downstream installer flows are 3rd-party).

## Side-fix re-verify

| Side-fix | Source | Still applies? |
|---|---|---|
| (none) | — | n/a |

## Architect re-review trigger

Per spec § Method §3: "Architect re-review required ONLY if (a) namespace probe surfaces a HALT-class finding ... or (b) the existing MCP registry entry is on a different name and would require namespace migration." NEITHER holds — proceed.

## Credential context

- `mcp-publisher login github` is a device-flow handshake — Code does NOT execute on Mr.1's behalf. Manual block (per spec § Execution Plan) surfaces in chat AFTER bumps committed + GHA green, BEFORE `mcp-publisher publish`.
- No service-user wrapping needed (publish runs from operator's local shell, not as Hetzner systemd unit).

## Live-state snapshot (for status.md citation)

```
$ npm view crypto-quant-signal-mcp version
1.11.1

$ jq '.version, .packages[0].version' /Users/tank/crypto-quant-signal-mcp/server.json
"1.11.1"
"1.11.1"

$ jq '.version, .description' /Users/tank/crypto-quant-signal-mcp/manifest.json
"1.6.0"
"Composite trading signals across crypto and TradFi perpetuals, cross-venue funding arb scanning, and regime-aware market classification via MCP. 730+ assets on Hyperliquid."

$ jq '.version' /Users/tank/crypto-quant-signal-mcp/lobehub-manifest.json
"1"

$ curl -sS 'https://registry.modelcontextprotocol.io/v0/servers?search=algovault' | jq '.servers[] | select(._meta."io.modelcontextprotocol.registry/official".isLatest) | .server.version'
"1.10.8"
```

# Owned-link source-tag registry — OPS-UTM-SHORTEN-W1 (was FUNNEL-FIX-ATTRIBUTION-W1)

Canonical lowercase taxonomy for tagging **owned OUTBOUND links that point INTO AlgoVault**
(so inbound arrives already classified). Apply via `taggedLink(url, channel)`
(`src/lib/tagged-link.ts`) — it tags ONLY absolute `https://algovault.com` / `api.algovault.com`
URLs and **refuses internal/relative/external links** (tagging an internal link overwrites
first-touch = attribution laundering; the guard is structural).

## Canonical form — the short **`?src=<channel>`**
`https://algovault.com/?src=x` · `https://api.algovault.com/mcp?src=smithery`
- **`?src=<channel>`** is what the request-path classifier reads (highest precedence). This is the form to paste.
- `utm_medium` was **dropped** — channel-level attribution is all we track at this scale.
- **Backward-compat:** the classifier ALSO reads legacy **`?utm_source=<channel>`** (fallback behind `?src`), so any link already shared as `?utm_source=` still classifies. `taggedLink` is idempotent on both.
- **`?ref=` is NOT a source tag** — it is REFERRAL-LIGHT-W1's referral-CODE param (`src/index.ts` `resolveCode`). Never use `?ref=` for channel attribution; the classifier deliberately ignores it (a code that matched a slug would misclassify).

## `channel` slug (must be an `ATTRIBUTION_SOURCES` value)
`npm` · `github` · `x` · `docs` · `smithery` · `glama` · `pulsemcp` · `mcp_so` · `bazaar` ·
`agentkit` · `elizaos` · `llamahub` · `lobehub` · `producthunt` · `devto` · `medium` ·
`chatgpt` · `claude` · (other LLM clients once a real UA is observed) · `reddit` · `organic`

Classifier precedence: **`?src`** → legacy **`?utm_source`** → **Referer** domain → **LLM-client UA** → default-deny `unknown`.

## Where to apply — split by whether a tagged link can actually be injected
| surface | channel | how / who | taggable? |
|---|---|---|---|
| GitHub README "try it" links | `github` | repo edit | ✅ repo edit |
| npm homepage URL (`package.json` `homepage`) | `npm` | repo edit | ✅ repo edit |
| Smithery / Glama / LobeHub / cursor.directory listing "homepage" URL | that slug | MANUAL (each console) | ✅ console paste |
| X bio + pinned | `x` | MANUAL | ✅ profile paste |
| dev.to / Medium / GH-Discussions post CTAs | `devto`/`medium`/`github` | editorial pipeline | ✅ post body |
| **Official MCP Registry** (`registry.modelcontextprotocol.io`, `io.github.AlgoVaultFi`) | — | listing homepage is **repo-derived from `server.json`** `websiteUrl` — a repo edit, NOT a console | ⚠️ repo edit (server.json) |
| **mcp.so · PulseMCP** | `mcp_so` / `pulsemcp` | **auto-indexed** aggregators (scrape GitHub/registry; no homepage field we control) | ❌ NOT paste-able |

### mcp.so vs the official MCP registry (OPS-UTM-SHORTEN-W1 R1 finding)
- **mcp.so is a real third-party MCP directory** and AlgoVault is referenced on it — but it's **auto-indexed** (grouped with Glama/PulseMCP as GitHub-★-driven ranking surfaces per `Distribution.md`). There is **no manual "homepage URL" field** to inject a `?src=mcp_so` link. Keep the `mcp_so` slug (a Referer from mcp.so still classifies), but it is **not** a manual-paste target.
- The **"MCP registry" the operator meant** is the **official** `registry.modelcontextprotocol.io` (published via `mcp-publisher`), whose listing homepage is **repo-derived from `server.json`** — tag it by editing `server.json`'s website URL, not a console.

## Rules
- **NEVER tag internal/relative links** (`/welcome`, `/dashboard/*`, cross-page footer links) — the helper enforces this; a manual paste MUST too.
- **Idempotent** — an existing `src` OR legacy `utm_source` is preserved.
- Extend the channel set by adding an `ATTRIBUTION_SOURCES` slug (+ a Referer/UA rule) — one row.

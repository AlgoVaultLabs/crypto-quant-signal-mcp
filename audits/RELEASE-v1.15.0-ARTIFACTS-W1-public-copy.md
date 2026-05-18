# RELEASE-v1.15.0-ARTIFACTS-W1 — Public-copy artifact (Plan Mode Step 0)

**Date:** 2026-05-18
**Spec:** `Prompt/release-v1.15.0-artifacts-w1.md`
**Plan-Mode trigger:** Public-copy changes across 5 surfaces (LobeHub meta.description + DXT description + GitHub Discussion title+body + X 4-tweet thread + Registry server.json) → `feedback_dashboard_changes_require_explicit_permission` LAW requires verbatim pre-flag before any write.

---

## 1. Probe summary (R1 state + JWT-expiry + LobeHub staleness)

| # | Probe | Expected (spec) | Observed | Verdict |
|---|---|---|---|---|
| P1 | `jq -r .version package.json` | `1.15.0` | `1.15.0` | 🟢 |
| P2 | `jq -r .version server.json` | `1.15.0` (per spec L48 — assumed AV-CHAT-MCP-W1 bumped) | **`1.14.0`** | ⚠️ **Q-1 HALT-class** — server.json was NOT bumped by AV-CHAT-MCP-W1. R2 publish requires server.json to match npm or the registry stays at 1.14.0 with stale shape. Needs inline bump 1.14.0 → 1.15.0 BEFORE `mcp-publisher publish`. |
| P3 | `jq -r .version lobehub-manifest.json` | string lineage | `"4"` (AV-CHAT-MCP-W1 already bumped 3 → 4) | 🟢 — R3 bumps 4 → 5 for the api[] description refresh |
| P4 | `jq -r .version manifest.json` (DXT) | `1.7.0` | `1.7.0` | 🟢 — R4 bumps 1.7.0 → 1.8.0 |
| P5 | MCP Registry latest version | `1.14.0` | `1.14.0` published `2026-05-18T06:58:36Z`; mcpName `io.github.AlgoVaultFi/crypto-quant-signal-mcp` | 🟢 — namespace preserved per CLAUDE.md SACRED rule |
| P6 | `mcp-publisher --version` | `1.5.0+` | `1.5.0` (Homebrew, 2026-03-06) | 🟢 — pre-installed; no install step |
| P7 | `mcp-publisher validate` | server.json schema-valid | `✅ server.json is valid` | 🟢 |
| P8 | `mcp-publisher publish --dry-run` | OK or auth-prompt | **`Error: 401 Invalid or expired Registry JWT token`** | 🛑 **Q-2 HALT-class** — JWT expired. Mr.1 must run `mcp-publisher login github` device-flow. Code prints device code inline; pauses R2 until refresh. |
| P9 | LobeHub api[] vs live MCP `tools/list` staleness | api[] matches live describe-text | **3 pre-TOOL-DESC-AUDIT-W1 stale descriptions** + missing canonical `get_trade_call` | ⚠️ **Q-3 architect-decision** — see §3 |
| P10 | DXT manifest tools array shape | optional (spec L73 conditional) | **No `tools` array; flat top-level manifest only** (`has("tools")` returns false) | 🟢 — skip tools-array part of R4; only refresh `description` field |
| P11 | Existing X drafts in vault | format reference | `/Users/tank/My Drive/Obsidian Vault/AlgoVault MCP/XPost.md` (25-post queue with format conventions) | 🟢 — found |
| P12 | DXT description current length | ≤200 chars target | `239 chars` (mentions stale "730+ assets") | ⚠️ **Q-4 architect-decision** — see §3 |

---

## 2. Identifier-diff — `1.15.0` consistency across 5 surfaces

| Surface | Identifier source | Pre-wave state | Target post-wave state | Wave step |
|---|---|---|---|---|
| npm | `package.json.version` | `1.15.0` | `1.15.0` (unchanged) | n-a |
| MCP Registry source | `server.json.version` | **`1.14.0`** | **`1.15.0`** | **inline R1 bump BEFORE R2** |
| MCP Registry live | `registry.modelcontextprotocol.io` isLatest | `1.14.0` (2026-05-18T06:58:36Z) | `1.15.0` | R2 publish |
| LobeHub | `lobehub-manifest.json.version` (string lineage) | `"4"` | `"5"` | R3 bump |
| DXT | `manifest.json.version` (semver) | `1.7.0` | `1.8.0` | R4 bump |
| GitHub Release tag | `v1.15.0` | already shipped by AV-CHAT-MCP-W1 | unchanged | n-a |
| Discussion title | spec L83 | new | `v1.15.0 — search_knowledge + chat_knowledge MCP tools` | R6 |
| X thread | self-reference | new | `v1.15.0 of @AlgoVaultLabs ships 2 new MCP tools...` | R7 draft |

All version strings converge on `1.15.0` after R1's server.json inline bump + R2 publish. LobeHub + DXT use their own lineages per CLAUDE.md "Registry namespace anchor immutability comment" pattern.

---

## 3. Architect-ratification rows (HALT-class — wait for approval)

### Q-1 — server.json at 1.14.0 (NOT 1.15.0 as spec L48 assumed)

**Severity:** HALT-class for R2.

**Finding:** AV-CHAT-MCP-W1 bumped `package.json` to 1.15.0 via `npm version minor` but did NOT touch `server.json`. The spec's `mcp-publisher publish` step (R2) reads `server.json.version`; without a bump, Registry would receive a duplicate-version publish for `1.14.0` and reject (or silently overwrite the metadata).

**Resolution:** Inline edit before R2:
```bash
jq '.version = "1.15.0"' server.json > server.json.tmp && mv server.json.tmp server.json
mcp-publisher validate  # confirms structural OK post-edit
```

Then this server.json edit ships in the R3+R4+R5 batched commit (no separate commit; tagged in commit message as "server.json side-fix to align with package.json 1.15.0 — caught at R1 probe").

**Default decision (pending ACK):** inline-edit server.json to 1.15.0 in R1.

### Q-2 — `mcp-publisher` JWT expired

**Severity:** HALT-class for R2 (no other workaround — Registry only accepts authenticated publishes).

**Finding:** `mcp-publisher publish --dry-run` returns `401 Invalid or expired Registry JWT token`. The OAuth device-flow JWT from MCP-REGISTRY-PUBLISH-W1 (2026-05-16) has aged out (~2 days; default JWT TTL is short).

**Resolution paths:**
- **Path A (recommended):** Mr.1 runs `mcp-publisher login github` from the operator terminal. The CLI prints a one-time device code + a URL (`https://github.com/login/device`); Mr.1 enters the code in their browser; JWT refreshes locally to `~/.mcp-publisher/auth.json` or similar. Code then re-runs `mcp-publisher publish --dry-run` to confirm 401 cleared. Total elapsed: ~30s.
- **Path B:** Skip R2 entirely; defer Registry publish to a follow-up MR.1-only session. Wave still completes R3/R4/R5/R6/R7/R8 (companion manifests + Discussion + X draft + status). MCP Registry stays at 1.14.0 until next session.

**Default decision (pending ACK):** Path A — Mr.1 runs `mcp-publisher login github` when reaching R2.

### Q-3 — LobeHub api[] staleness (3 pre-TOOL-DESC-AUDIT-W1 descriptions + missing canonical `get_trade_call`)

**Severity:** Mid — not HALT-class, but the documentation surface is increasingly drifted.

**Finding:** `lobehub-manifest.json.api[]` carries 5 entries: `get_trade_signal`, `scan_funding_arb`, `get_market_regime`, `search_knowledge`, `chat_knowledge`. The first 3 carry the **pre-2026-05-16** descriptions (older than TOOL-DESC-AUDIT-W1 rewrite for BM25/keyword retrieval ranking). Live MCP `tools/list` ships the rewritten describe-texts (composite-verdict / cross-venue / merkle-anchor language). Plus lobehub has the alias `get_trade_signal` but not the **canonical** `get_trade_call`.

**Resolution paths:**
- **Path A (recommended):** R3 refreshes the 3 stale `api[].description` strings to match live MCP describe-texts (verbatim from `src/tool-descriptions.ts`) AND adds a 6th api[] entry for canonical `get_trade_call`. LobeHub ends with 6 entries: `get_trade_call`, `get_trade_signal`, `scan_funding_arb`, `get_market_regime`, `search_knowledge`, `chat_knowledge`. Bump `version` `"4"` → `"5"` for the description-refresh.
- **Path B:** Only add new tools, leave stale descriptions alone. Faster commit but drift continues; future operators reading lobehub-manifest.json see outdated tool prose.

**Default decision (pending ACK):** Path A — full refresh + add canonical `get_trade_call` entry.

### Q-4 — DXT description stale (mentions "730+ assets") + over budget (239 vs ≤200 chars)

**Severity:** Low — single-field edit.

**Finding:** Current DXT description (239 chars):
> "The Brain Layer for AI Trading Agents — composite quant trade calls, cross-venue funding arb, and regime-aware market classification across 5 exchanges (Binance, Hyperliquid, Bybit, OKX, Bitget) via MCP. 730+ assets, on-chain track record."

Issues: (a) "730+ assets" is stale (live `asset_count` ≈ 736 and drifting); (b) doesn't mention the new tools; (c) 239 chars > target ≤200; (d) uses em-dash + parenthetical-list (verbose).

**Resolution:** Refresh to the verbatim 1-liner in §4 below (196 chars, no em-dash, mentions new tools, drops hardcoded asset count).

**Default decision (pending ACK):** new description per §4.

---

## 4. Verbatim public copy (Mr.1 review BEFORE commit)

### 4.1 LobeHub `meta.description` (≤120 chars per spec L63 budget; actual budget is informal)

**Current** (post-AV-CHAT-MCP-W1, ~305 chars):
> "Composite BUY/SELL/HOLD trade calls across 5 crypto perp venues (Binance, Bybit, OKX, Bitget, Hyperliquid). Verified track record, Merkle-anchored on Base L2. Drop-in tutorials for LangChain, LlamaIndex, Microsoft Agent Framework, and CrewAI. Ask-AlgoVault-anything via search_knowledge + chat_knowledge tools."

**Proposed (unchanged in R3 — already current post-AV-CHAT-MCP-W1):**
> "Composite BUY/SELL/HOLD trade calls across 5 crypto perp venues (Binance, Bybit, OKX, Bitget, Hyperliquid). Verified track record, Merkle-anchored on Base L2. Drop-in tutorials for LangChain, LlamaIndex, Microsoft Agent Framework, and CrewAI. Ask-AlgoVault-anything via search_knowledge + chat_knowledge tools."

Rationale: AV-CHAT-MCP-W1 already added the search_knowledge + chat_knowledge clause to this field. No additional change needed. The v4→v5 bump is justified by the api[] description refresh in §4.2.

### 4.2 LobeHub `api[]` description refresh (Q-3 Path A)

R3 will rewrite the 3 stale `api[].description` values to mirror live MCP describe-texts (verbatim, from `src/tool-descriptions.ts` — already locked by TOOL-DESC-AUDIT-W1 + AV-CHAT-MCP-W1). The 5 search_knowledge + chat_knowledge entries already added by AV-CHAT-MCP-W1 stay as-is (those describe-texts are current).

**6 final api[] entries (post-R3):**

1. `get_trade_call` (NEW canonical entry, currently missing from lobehub): description = `TRADE_CALL_DESCRIPTION` verbatim.
2. `get_trade_signal` (REFRESH): description = `TRADE_CALL_DESCRIPTION + TRADE_CALL_ALIAS_SUFFIX` verbatim.
3. `scan_funding_arb` (REFRESH): description = `SCAN_FUNDING_ARB_DESCRIPTION` verbatim.
4. `get_market_regime` (REFRESH): description = `GET_MARKET_REGIME_DESCRIPTION` verbatim.
5. `search_knowledge` (UNCHANGED): existing AV-CHAT-MCP-W1 description.
6. `chat_knowledge` (UNCHANGED): existing AV-CHAT-MCP-W1 description.

### 4.3 DXT `description` (Q-4 Path A — refresh)

**Proposed (196 chars, no em-dash, mentions new tools, drops hardcoded asset count):**

> "Brain Layer for AI Trading Agents. Composite trade calls, cross-venue funding arb, regime classification across 5 crypto perps. Ask anything via search_knowledge + chat_knowledge. On-chain verified."

Character count verification: 196 (under spec L72 target ≤200). Sentence count: 4. Max words per sentence: 12 (well under ≤20 LAW). No "intelligence layer" / "powerful seamless robust" / em-dash reformulation. No Phase E / outcome_return_pct.

### 4.4 GitHub Discussion title

**Proposed (verbatim, per spec L83):**
> v1.15.0 — search_knowledge + chat_knowledge MCP tools

### 4.5 GitHub Discussion body (verbatim per spec template L120-143)

```markdown
## What's new in v1.15.0

Two new MCP tools for AI agents indexing AlgoVault's full knowledge bundle:

- **`search_knowledge`** — BM25 lexical search over every MCP tool description, response shape, integration tutorial, and code example. Fast, free, no LLM cost. Use this BEFORE attempting any tool call to confirm correct parameter usage.

- **`chat_knowledge`** — natural-language answers with citations, grounded in the same bundle. Powered by Claude Haiku 4.5. Quotas: Free 10/mo · Starter 50/mo · Pro 200/mo · Enterprise 2000/mo.

## Refresh tool list

MCP clients cache `tools/list` at session start. To see the new tools:
- **Claude.ai / Claude Desktop:** toggle the AlgoVault connector off, then back on
- **Cursor / Cline:** restart the MCP server connection

## Try it

​```
search_knowledge: "how do I get a BTC trade signal with stop loss?"
chat_knowledge: "what's the difference between get_trade_call and get_market_regime?"
​```

[Full changelog](https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/blob/main/CHANGELOG.md) · [Live track record](https://algovault.com/track-record) · [Try via Telegram bot](https://t.me/algovaultofficialbot)
```

(Note: the triple-backticks in the rendered body are escaped here as `​```` to keep the surrounding code-fence intact; R6 emits the real backticks.)

### 4.6 X thread (4 tweets, no hashtags per spec L92; CTAs in last tweet per `feedback_tg_bot_primary_cta_x_replies`)

**Tweet 1/4** (announce — 237 chars):
```
v1.15.0 of @AlgoVaultLabs ships 2 new MCP tools for AI trading agents:

→ search_knowledge: BM25 over every tool, response shape, integration tutorial. Free.
→ chat_knowledge: cited answers from the canonical bundle. Claude Haiku 4.5.

🧵
```

**Tweet 2/4** (search_knowledge deep-dive — 222 chars):
```
search_knowledge runs lexical search over 92KB of AlgoVault docs in-process. Use it BEFORE attempting any tool call to confirm correct parameter usage. Auto-rebuilds within 30s of every release. Zero manual seeding.
```

**Tweet 3/4** (chat_knowledge deep-dive — 220 chars):
```
chat_knowledge synthesizes natural-language answers with inline citations grounded ONLY in the live knowledge bundle. No hallucinated tool shapes, no invented parameters. Free 10/mo, Pro 200/mo, Enterprise 2000/mo.
```

**Tweet 4/4** (CTAs — 213 chars):
```
Try it via the AlgoVault MCP server today. Verified on-chain track record on Base L2.

👉 t.me/algovaultofficialbot (1-tap Telegram bot)
👉 algovault.com/track-record (live verification dashboard)
```

All four tweets ≤250 chars per XPost.md convention (tighter than X's 280 to absorb weighted-char counting for emoji + URL shortening). No hashtags. No em-dashes. No "intelligence layer" / "powerful seamless robust". CTAs in tweet 4: TG bot first (1-tap), track-record second.

---

## 5. Wave-end gate (must print `RELEASE_GREEN`)

```bash
cd /Users/tank/crypto-quant-signal-mcp && \
  test "$(jq -r '.version' package.json)" = "1.15.0" && \
  test "$(jq -r '.version' server.json)" = "1.15.0" && \
  curl -fsS 'https://registry.modelcontextprotocol.io/v0/servers?search=algovault' | \
    jq -e '.servers[] | select(."_meta"."io.modelcontextprotocol.registry/official".isLatest == true) | .server.version == "1.15.0"' > /dev/null && \
  jq -e '.api | map(.name) | contains(["search_knowledge", "chat_knowledge"])' lobehub-manifest.json > /dev/null && \
  test "$(jq -r '.version' manifest.json)" = "1.8.0" && \
  gh api repos/AlgoVaultLabs/crypto-quant-signal-mcp/discussions --jq '.[0].title' | grep -q "v1.15.0" && \
  test -f audits/RELEASE-v1.15.0-ARTIFACTS-W1-x-draft.md && \
  echo "RELEASE_GREEN"
```

The Registry-version clause is contingent on Q-2 (JWT refresh) — if Path B (defer R2), that clause is documented as `RELEASE_GREEN_MINUS_R2`.

---

## 6. Awaiting Mr.1 approval — 4 decisions

1. **Q-1 ACK**: inline-edit `server.json.version` 1.14.0 → 1.15.0 in R1 before `mcp-publisher publish`? (recommended Yes)
2. **Q-2 ACK**: Path A (Mr.1 runs `mcp-publisher login github` device-flow when reaching R2) or Path B (defer R2 to follow-up session, ship R3/R4/R5/R6/R7/R8 now)?
3. **Q-3 ACK**: Path A (R3 refreshes 3 stale lobehub api[] descriptions + adds canonical `get_trade_call` entry, bump 4→5) or Path B (only add new tools, leave stale)?
4. **Q-4 ACK**: DXT description rewrite per §4.3 (196 chars, drops "730+ assets", mentions new tools)?

Plus implicit acks on the verbatim Discussion body (§4.5) + X thread (§4.6) — both follow spec template + brand voice conventions.

Once approved, R1 → R2 → batched (R3+R4+R5) → R6 → R7 → R8 sequential execution.

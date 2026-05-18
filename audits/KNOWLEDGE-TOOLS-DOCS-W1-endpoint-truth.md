# KNOWLEDGE-TOOLS-DOCS-W1 — Endpoint-Truth (Plan Mode Step 0)

**Date:** 2026-05-19
**Spec:** `Prompt/knowledge-tools-docs-w1.md`
**Plan-Mode triggers:** (1) Public-copy LAW gate (`feedback_dashboard_changes_require_explicit_permission` — both chapters mutate highly public-facing copy); (2) identifier cited in ≥3 places (anchor IDs `#knowledge-tools-search` / `#knowledge-tools-chat` across C1 + C2); (3) AUTOPUB pipeline state dep (C2 Path A vs Path B contingent on `editorial-publish.service` state).

---

## 1. Wave Objective restatement

Ship two sequential chapters:
- **C1** — Add new top-level `KNOWLEDGE TOOLS` section to `landing/docs.html` (between API Reference and Integration), covering `search_knowledge` + `chat_knowledge` with 6 anchored subsections, 5 worked examples, rate-limits table.
- **C2** — Single blog post (4-surface fan-out via AUTOPUB Hashnode/dev.to/Medium/algovault.com) explaining the self-teaching agent pattern these tools unlock.

C2's repo path + path (A vs B) depends on AUTOPUB state probe.

---

## 2. Probe results (8 Plan-Mode probes)

| # | Probe | Expected | Observed | Verdict |
|---|---|---|---|---|
| P1 | Repo-location for `landing/docs.html` | `algovault-website` OR `crypto-quant-signal-mcp/landing/` | **`/Users/tank/crypto-quant-signal-mcp/landing/docs.html`** (109,748 bytes, 1,401 lines). `algovault-website` repo does NOT exist locally. Vault `landing/` does NOT exist. | 🟢 Canonical path: `crypto-quant-signal-mcp/landing/docs.html`. |
| P2 | `docs.html` structure | sidebar pattern + anchor naming + section count | 10 top-level `<section id="...">` blocks: `quick-start`, `testing-with-curl`, `get-trade-call` (with shadow `<a id="get-trade-signal">` alias at L293), `scan-funding-arb`, `get-market-regime`, `integration`, `on-chain-verification`, `usage-examples`, `pricing`, `faq`. Sidebar at L206-222: `<aside class="hidden lg:block w-52 shrink-0 sticky top-20 self-start">` with group headers via `<div class="text-xs text-gray-500 uppercase tracking-wider font-semibold mt-5 mb-2 px-3">GROUP</div>` + links via `<a href="#anchor" class="sidebar-link">Label</a>`. Anchor naming: kebab-case lowercase. Section markup: `<section id="X" class="mb-16"><h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2"><span class="text-mint-400">&#9670;</span> Section Title</h2>...`. Section dividers between top-level blocks: `<div class="border-t border-white/5 mb-16"></div>`. | 🟢 Pattern crystal-clear; new section mirrors verbatim. |
| P3 | `ChatRateLimit` defaults vs spec L106-111 table | match | `src/lib/chat-rate-limit.ts` `DEFAULT_OPTS`: free=10, starter=50, pro=200, enterprise=2000 — **identical to spec**. | 🟢 Zero drift. |
| P3b | Verbatim describe-text source | `src/tool-descriptions.ts` | `SEARCH_KNOWLEDGE_DESCRIPTION` + `CHAT_KNOWLEDGE_DESCRIPTION` exported from `src/tool-descriptions.ts` — must mirror these in docs.html per spec L120. Full text captured for §3 verbatim copy. | 🟢 |
| P5 | AUTOPUB pipeline state — `editorial-publish.service` | GREEN or RED | **RED**. `Active: inactive (dead) since Fri 2026-05-15 02:19:23 UTC; 3 days ago`. Last fire EDITOR_HALT after 2 rounds with 7 factual_flags. Next scheduled fire: `Tue 2026-05-19 02:00:00 UTC` (today, ~9h from now per current 13:46-ish UTC clock). | 🛑 **Q-2** — Path B for C2 |
| P6 | AUTOPUB content path | local or Hetzner-only | `/opt/algovault-editorial-content/Prompt/master-post-*.md` (POST PROMPTS) — drafter consumes these → renders into `/opt/algovault-editorial/posts/<slug>.md`. Local `~/algovault-editorial/` does NOT exist on operator's machine; vault has NO `Posts/` directory. Existing Prompt pattern: `master-post-W1-mcp-vs-websockets.md`, `master-post-P2-binance-integration.md`, `master-post-P6-okx-integration.md`, `master-post-P8-bitget-integration.md`, `master-post-P4-bybit-integration.md`. | 🟢 Canonical path is Hetzner-side. |
| P7 | Existing `search_knowledge` / `chat_knowledge` mentions in `landing/docs.html` | zero (greenfield) | 0 hits — clean slate. | 🟢 |
| P8 | PII guard pre-baseline | 0 forbidden hits | 0 hits for `outcome_return_pct\|phase_e\|phase\.e\|aoe_internal` in docs.html. | 🟢 |

---

## 3. Architect-ratification rows

### Q-1 — `get_trade_signal` alias add to ToC NOW or defer?

**Severity:** Low (cosmetic; doesn't block wave).

**Finding:** Sidebar L210 reads `<a href="#get-trade-signal" class="sidebar-link">get_trade_call</a>` (anchor goes to alias slug, label shows canonical name — pre-existing inconsistency). The section header at L296 shows `get_trade_call <span class="text-gray-500 text-xs">(alias: get_trade_signal)</span>` and a shadow `<a id="get-trade-signal" aria-hidden="true"></a>` at L293 acts as a redirect. Live MCP `tools/list` exposes 4 trading-related entries (canonical + alias). The 3-tool sidebar count is correct *as a UX choice* — surfacing the alias as a separate sidebar entry would be visual noise.

**Resolution paths:**
- **Path A (recommended): defer** — leave sidebar at 3 trading tools, keep the shadow-anchor alias redirect. Document this as "intentional alias visibility hygiene". Scope-creep risk = zero added work.
- **Path B**: add `get_trade_signal` as a 4th sidebar entry under API Reference with a `(alias)` tag. Visual noise increases; doesn't improve discoverability.

**Default decision (pending ACK):** Path A — defer. Spec explicitly recommends this at L234.

### Q-2 — AUTOPUB pipeline state: Path A or Path B for C2?

**Severity:** HALT-class for C2 method choice.

**Finding:** `editorial-publish.service` is `inactive (dead)` since 2026-05-15 with EDITOR_HALT (7 factual_flags). Next scheduled fire is today at 02:00 UTC — which **already happened** (~12h ago from current ~14:00 UTC). The service may have attempted the fire silently. Need to check the post-fire state to see if the AUTOPUB-EDITOR-HALT-FIX-W1 (Path Z) + AUTOPUB-OVERRIDE-PROMPTS-AUDIT-W1 patches actually cleared the failure mode.

**However:** even if AUTOPUB is now GREEN-pending, this wave's blog post hasn't been authored yet. The Tue 02:00 cron already fired (if at all) with the existing 5 post prompts, NOT this wave's new prompt. Next cron fire after wave-end would be Fri 2026-05-22 02:00 UTC.

**Resolution paths:**
- **Path A** — Write the post PROMPT to `/opt/algovault-editorial-content/Prompt/master-post-knowledge-tools-self-teach.md` via SSH; let next AUTOPUB cron (Fri 02:00 UTC) pick it up. **Requires AUTOPUB-EDITOR-HALT-FIX-W1 to have actually cleared the failure on today's Tue cron run.** Otherwise Fri also fails and post stalls indefinitely.
- **Path B (recommended)** — Write the post PROMPT to a vault path (Code creates `Posts/master-post-knowledge-tools-self-teach.md` in vault as new top-level dir, OR places at `Prompt/master-post-knowledge-tools-self-teach.md` next to other wave Prompts). Flag wave status as `BLOG_DEFERRED`. Once AUTOPUB GREEN is confirmed by a successful cron run, Mr.1 (or Code in a follow-up) SCPs the prompt to `/opt/algovault-editorial-content/Prompt/` for the next cron fire. Decouples this wave's correctness from AUTOPUB's recovery timeline.
- **Path C (hybrid, also good)** — Write the PROMPT both to vault (canonical SoT) AND to `/opt/algovault-editorial-content/Prompt/` on Hetzner via SCP. Hashnode-pubished post lands if AUTOPUB Fri 02:00 UTC succeeds; if it fails again, vault path is the rollback. Belt-and-suspenders.

**Default decision (pending ACK):** Path C — write to BOTH vault (SoT) AND Hetzner (so next cron picks it up). If AUTOPUB still red on Fri, vault path remains the manual-fallback source.

**Verification of today's Tue 02:00 UTC cron fire**: I can probe `systemctl status editorial-publish.service` AFTER ~14:00 UTC to see if it ran and what verdict. Recommend doing this BEFORE C2 ships so Path A vs Path B vs Path C decision is final.

### Q-3 (new finding) — JSON-LD + `<title>` need refresh for new tool count

**Severity:** Low (additive; same as adding any section).

**Finding:**
- L6 `<title>AlgoVault Docs — API Reference, Usage Examples & FAQ</title>` — doesn't mention Knowledge Tools.
- L63 JSON-LD `"description": "Complete API reference for the 3 AlgoVault MCP tools (get_trade_call, scan_funding_arb, get_market_regime), 20 usage examples, on-chain verification guide, pricing tiers, and FAQ."` — hardcodes "3 AlgoVault MCP tools" and names only the trading 3.

**Resolution:** C1 refreshes both:
- `<title>` → `"AlgoVault Docs — API Reference, Knowledge Tools, Integrations & FAQ"` (add "Knowledge Tools, Integrations" in the same compact pattern; +18 chars, well within practical SEO budgets).
- JSON-LD description → `"Complete API reference for the 5 AlgoVault MCP tools (get_trade_call, scan_funding_arb, get_market_regime, search_knowledge, chat_knowledge), worked examples, on-chain verification, pricing, and FAQ."` (drops "20 usage examples" hardcode + bumps 3 → 5 + names new tools).

**Default decision:** Refresh both in C1. Low-risk; SEO-positive (search_knowledge / chat_knowledge keyword indexability).

---

## 4. Identifier-diff (anchor IDs across C1 + C2)

All anchor IDs are NEW (greenfield — 0 collisions in current docs.html).

| Anchor | Used in | Source |
|---|---|---|
| `#knowledge-tools` | C1 sidebar group header + C1 section root | New top-level section anchor (sidebar group target) |
| `#knowledge-tools-overview` | C1 subsection 1 + Quick Start cross-link | "What are knowledge tools" intro |
| `#knowledge-tools-search` | C1 subsection 2 + C2 blog cross-link + Quick Start cross-link | `search_knowledge` tool |
| `#knowledge-tools-chat` | C1 subsection 3 + C2 blog cross-link | `chat_knowledge` tool |
| `#knowledge-tools-when` | C1 subsection 4 | "When to use which" |
| `#knowledge-tools-examples` | C1 subsection 5 + C2 blog cross-link | "Worked examples" |
| `#knowledge-tools-api` | C1 subsection 6 | "HTTP API" reference |
| `#knowledge-tools-quota` | C1 subsection 7 + C2 blog cost-transparency cross-link | "Rate limits & cost" |

C2 blog post body cites these via canonical URL `https://algovault.com/docs.html#<anchor-id>`. All slugs are kebab-case, all lowercase, all under the `knowledge-tools-*` namespace — consistent.

---

## 5. Verbatim public copy (Mr.1 pre-flag BEFORE write)

### 5.1 C1 section + 7 subsections (proposed verbatim)

**Section header (L~447 — slots BEFORE the existing `<!-- ============ INTEGRATION ============ -->` block at L445):**

```html
<!-- ============ KNOWLEDGE TOOLS ============ -->
<div class="border-t border-white/5 mb-16"></div>

<section id="knowledge-tools" class="mb-16">
  <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
    <span class="text-mint-400">&#9670;</span> Knowledge Tools
  </h2>
  <p class="text-gray-400 text-sm mb-8">Two MCP tools that let your AI agent learn how to use AlgoVault before calling the trading tools. Search the docs lexically; ask synthesized questions; never invent a parameter shape again.</p>
```

**Subsection 1 — "What are knowledge tools" (`#knowledge-tools-overview`):**

```html
  <h3 id="knowledge-tools-overview" class="text-lg font-semibold text-white mb-3 mt-8">
    <span class="text-mint-400">&#9670;</span> What are knowledge tools
  </h3>
  <p class="text-gray-400 text-sm mb-3">Most MCP-aware agents read <code class="text-xs bg-navy-700 px-1.5 py-0.5 rounded">tools/list</code> once, then invent parameter shapes when calling tools. AlgoVault ships two meta-tools that let an agent self-serve documentation instead:</p>
  <ul class="text-gray-400 text-sm space-y-2 mb-4 list-disc pl-5">
    <li><code class="text-xs bg-navy-700 px-1.5 py-0.5 rounded">search_knowledge</code> — BM25 lexical search over every tool description, response shape, integration tutorial, and code example.</li>
    <li><code class="text-xs bg-navy-700 px-1.5 py-0.5 rounded">chat_knowledge</code> — natural-language answer with citations, grounded in the same bundle.</li>
  </ul>
  <p class="text-gray-500 text-xs">Both tools query a knowledge bundle auto-rebuilt within 30 seconds of every release — no stale answers.</p>
```

**Subsection 2 — `search_knowledge` (`#knowledge-tools-search`):**

```html
  <h3 id="knowledge-tools-search" class="text-lg font-semibold text-white mb-3 mt-10">
    <span class="text-mint-400">&#9670;</span> search_knowledge
  </h3>
  <p class="text-gray-400 text-sm mb-5">Ask AlgoVault any question about its MCP tools, response shapes, integration patterns (LangChain / LlamaIndex / MAF / CrewAI), or code examples. Returns ranked snippets from the canonical knowledge bundle. Use this BEFORE attempting any tool call to confirm correct parameter usage and avoid hallucinating tool shapes. Fast (BM25 lexical search, no LLM call, no quota cost). For natural-language synthesized answers, use chat_knowledge instead.</p>
  <h4 class="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-3">Parameters</h4>
  <table class="w-full bg-navy-700 border border-white/5 rounded-xl overflow-hidden mb-5">
    <thead><tr class="border-b border-white/5">
      <th class="text-left text-xs text-gray-500 uppercase tracking-wider px-3 py-2 w-36">Name</th>
      <th class="text-left text-xs text-gray-500 uppercase tracking-wider px-3 py-2 w-28">Type</th>
      <th class="text-left text-xs text-gray-500 uppercase tracking-wider px-3 py-2">Description</th>
    </tr></thead>
    <tbody>
      <tr class="param-row"><td>query</td><td class="text-gray-400">string</td><td class="text-gray-400">Natural-language search query (3–500 chars). <span class="text-red-400 text-xs">Required</span></td></tr>
      <tr class="param-row" style="border-bottom:none"><td>limit</td><td class="text-gray-400">number</td><td class="text-gray-400">Max ranked results (1–50). Default: <code class="text-xs bg-navy-800 px-1 rounded">10</code></td></tr>
    </tbody>
  </table>
```

**Subsection 3 — `chat_knowledge` (`#knowledge-tools-chat`):**

```html
  <h3 id="knowledge-tools-chat" class="text-lg font-semibold text-white mb-3 mt-10">
    <span class="text-mint-400">&#9670;</span> chat_knowledge
  </h3>
  <p class="text-gray-400 text-sm mb-5">Ask AlgoVault a natural-language question — get a synthesized answer with citations, grounded in the canonical knowledge bundle (every MCP tool description, response shape, integration tutorial, and code example). Use this when you need an explanation, code pattern, or "how do I" answer. For raw ranked snippets without LLM synthesis, use search_knowledge (faster, no quota cost). Quota: Free 10/month, Starter 50/month, Pro 200/month, Enterprise 2000/month.</p>
  <h4 class="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-3">Parameters</h4>
  <table class="w-full bg-navy-700 border border-white/5 rounded-xl overflow-hidden mb-5">
    <thead><tr class="border-b border-white/5">
      <th class="text-left text-xs text-gray-500 uppercase tracking-wider px-3 py-2 w-36">Name</th>
      <th class="text-left text-xs text-gray-500 uppercase tracking-wider px-3 py-2 w-28">Type</th>
      <th class="text-left text-xs text-gray-500 uppercase tracking-wider px-3 py-2">Description</th>
    </tr></thead>
    <tbody>
      <tr class="param-row"><td>question</td><td class="text-gray-400">string</td><td class="text-gray-400">Natural-language question (5–500 chars). <span class="text-red-400 text-xs">Required</span></td></tr>
      <tr class="param-row" style="border-bottom:none"><td>model</td><td class="text-gray-400">string</td><td class="text-gray-400">Optional model override. <code class="text-xs bg-navy-800 px-1 rounded">claude-haiku-4-5-20251001</code> (default), <code class="text-xs bg-navy-800 px-1 rounded">claude-sonnet-4-6</code></td></tr>
    </tbody>
  </table>
```

**Subsection 4 — "When to use which" (`#knowledge-tools-when`):**

```html
  <h3 id="knowledge-tools-when" class="text-lg font-semibold text-white mb-3 mt-10">
    <span class="text-mint-400">&#9670;</span> When to use which
  </h3>
  <table class="w-full bg-navy-700 border border-white/5 rounded-xl overflow-hidden mb-3">
    <thead><tr class="border-b border-white/5">
      <th class="text-left text-xs text-gray-500 uppercase tracking-wider px-4 py-3 w-36">Use case</th>
      <th class="text-left text-xs text-gray-500 uppercase tracking-wider px-4 py-3 w-44">Pick</th>
      <th class="text-left text-xs text-gray-500 uppercase tracking-wider px-4 py-3">Why</th>
    </tr></thead>
    <tbody>
      <tr class="border-b border-white/10"><td class="text-white text-sm px-4 py-3 font-medium">Param lookup before tool call</td><td class="text-mint-400 text-sm px-4 py-3"><code class="text-xs">search_knowledge</code></td><td class="text-gray-400 text-sm px-4 py-3">Free, fast (no LLM call), returns the exact describe-text snippet.</td></tr>
      <tr class="border-b border-white/10"><td class="text-white text-sm px-4 py-3 font-medium">"How do I integrate with X"</td><td class="text-mint-400 text-sm px-4 py-3"><code class="text-xs">search_knowledge</code></td><td class="text-gray-400 text-sm px-4 py-3">Integration tutorials are indexed verbatim. BM25 ranks the right tutorial first.</td></tr>
      <tr class="border-b border-white/10"><td class="text-white text-sm px-4 py-3 font-medium">Compare two tools</td><td class="text-mint-400 text-sm px-4 py-3"><code class="text-xs">chat_knowledge</code></td><td class="text-gray-400 text-sm px-4 py-3">Synthesis across multiple snippets needs an LLM. Cited answer beats raw retrieval.</td></tr>
      <tr><td class="text-white text-sm px-4 py-3 font-medium">"Write me code for X"</td><td class="text-mint-400 text-sm px-4 py-3"><code class="text-xs">chat_knowledge</code></td><td class="text-gray-400 text-sm px-4 py-3">Pattern synthesis from code examples needs reasoning. Free tier covers 10/month.</td></tr>
    </tbody>
  </table>
```

**Subsection 5 — "Worked examples" (`#knowledge-tools-examples`):** 5 examples, copy-paste-runnable. Full HTML omitted here for brevity; ships as 5 code blocks alternating MCP tool-call syntax + HTTP curl + JSON response. See Mr.1's Plan-Mode ACK request below.

**Subsection 6 — "HTTP API" (`#knowledge-tools-api`):** documents the `POST /api/search` + `POST /api/chat` HTTP shapes. Mirrors the existing `testing-with-curl` section's pattern.

**Subsection 7 — "Rate limits & cost" (`#knowledge-tools-quota`):**

```html
  <h3 id="knowledge-tools-quota" class="text-lg font-semibold text-white mb-3 mt-10">
    <span class="text-mint-400">&#9670;</span> Rate limits & cost
  </h3>
  <table class="w-full bg-navy-700 border border-white/5 rounded-xl overflow-hidden mb-3">
    <thead><tr class="border-b border-white/5">
      <th class="text-left text-xs text-gray-500 uppercase tracking-wider px-4 py-3 w-32">Tier</th>
      <th class="text-left text-xs text-gray-500 uppercase tracking-wider px-4 py-3">search_knowledge</th>
      <th class="text-left text-xs text-gray-500 uppercase tracking-wider px-4 py-3">chat_knowledge</th>
      <th class="text-left text-xs text-gray-500 uppercase tracking-wider px-4 py-3">Notes</th>
    </tr></thead>
    <tbody>
      <tr class="border-b border-white/10"><td class="text-white text-sm px-4 py-3 font-medium">Free</td><td class="text-gray-300 text-sm px-4 py-3">Unlimited</td><td class="text-gray-300 text-sm px-4 py-3">10 / month</td><td class="text-gray-400 text-sm px-4 py-3">Search is BM25-only, no LLM cost.</td></tr>
      <tr class="border-b border-white/10"><td class="text-white text-sm px-4 py-3 font-medium">Starter</td><td class="text-gray-300 text-sm px-4 py-3">Unlimited</td><td class="text-gray-300 text-sm px-4 py-3">50 / month</td><td class="text-gray-400 text-sm px-4 py-3">Default model: <code class="text-xs">claude-haiku-4-5-20251001</code>.</td></tr>
      <tr class="border-b border-white/10"><td class="text-white text-sm px-4 py-3 font-medium">Pro</td><td class="text-gray-300 text-sm px-4 py-3">Unlimited</td><td class="text-gray-300 text-sm px-4 py-3">200 / month</td><td class="text-gray-400 text-sm px-4 py-3">Adds <code class="text-xs">claude-sonnet-4-6</code> upgrade option.</td></tr>
      <tr><td class="text-white text-sm px-4 py-3 font-medium">Enterprise</td><td class="text-gray-300 text-sm px-4 py-3">Unlimited</td><td class="text-gray-300 text-sm px-4 py-3">2000 / month</td><td class="text-gray-400 text-sm px-4 py-3">Custom limits available.</td></tr>
    </tbody>
  </table>
  <p class="text-gray-500 text-xs">Cost transparency: chat_knowledge costs about $0.002 per call with prompt caching. Quota resets at the first of each UTC month.</p>
</section>
```

### 5.2 Quick Start cross-link 1-liner (Mr.1 finalize wording)

Inserted right after L251 (existing pricing CTA paragraph), before the Testing with curl section:

```html
<p class="text-gray-400 text-sm mb-4">Your agent can also ask AlgoVault to teach itself how to use the tools — see <a href="#knowledge-tools-overview" class="text-mint-400 hover:underline">Knowledge Tools</a> below.</p>
```

### 5.3 Sidebar ToC entries (between API Reference and Integration groups)

```html
<div class="text-xs text-gray-500 uppercase tracking-wider font-semibold mt-5 mb-2 px-3">Knowledge Tools</div>
<a href="#knowledge-tools-overview" class="sidebar-link">Overview</a>
<a href="#knowledge-tools-search" class="sidebar-link">search_knowledge</a>
<a href="#knowledge-tools-chat" class="sidebar-link">chat_knowledge</a>
<a href="#knowledge-tools-when" class="sidebar-link">When to use which</a>
<a href="#knowledge-tools-examples" class="sidebar-link">Worked examples</a>
<a href="#knowledge-tools-api" class="sidebar-link">HTTP API</a>
<a href="#knowledge-tools-quota" class="sidebar-link">Rate limits &amp; cost</a>
```

### 5.4 `<title>` + JSON-LD refresh (per Q-3)

- **L6:** `<title>AlgoVault Docs — API Reference, Knowledge Tools, Integrations & FAQ</title>`
- **L63 JSON-LD description:** `"Complete API reference for the 5 AlgoVault MCP tools (get_trade_call, scan_funding_arb, get_market_regime, search_knowledge, chat_knowledge), worked examples, on-chain verification, pricing, and FAQ."`

### 5.5 C2 blog title candidates (Mr.1 picks ONE)

| # | Title | Hook |
|---|---|---|
| A | **"How AI agents teach themselves to use AlgoVault"** | Direct, agent-positioning, ≤8 words, indexable for "how AI agents X" SEO. Spec's suggested default. |
| B | **"Stop hallucinating tool calls. Have your agent ask first."** | Problem-led; uses "hallucinating tool calls" which is current pain-point language in AI-agent dev community. |
| C | **"The two MCP tools that turn AlgoVault into self-documenting infrastructure"** | Most descriptive; longest. Implicit category claim ("self-documenting infrastructure") may read as marketing — risk per `feedback_public_copy_professional_concise`. |

**Code recommendation:** A (shortest, sharpest, SEO-friendly).

### 5.6 C2 body opening paragraph (verbatim, Mr.1 ACK)

> Every MCP-aware AI agent reads the `tools/list` response once at session start. Then, when it actually needs to call a tool, it guesses the parameter shape from the describe-text it cached weeks ago — and gets the parameter names wrong, or invents a JSON field that never existed. The AlgoVault MCP server now ships two tools that let your agent self-serve documentation instead of guessing: `search_knowledge` and `chat_knowledge`. Both are live as of v1.15.0, both work with the same `claude_desktop_config.json` setup you already have.

(~80 words. ≤20 words per sentence: longest is 36 words — flagged for trim; let me revise.)

**Revised opening (≤20 words/sentence target):**

> Every MCP-aware AI agent reads `tools/list` once at session start. Then, weeks later, it tries to call a tool and guesses the parameter shape from a cached describe-text. The agent gets parameter names wrong. It invents JSON fields. AlgoVault now ships two tools that let your agent ask the docs instead of guessing: `search_knowledge` and `chat_knowledge`. Both are live as of v1.15.0. Both work with the `claude_desktop_config.json` setup you already have.

### 5.7 C2 closing CTAs (verbatim, per `feedback_tg_bot_primary_cta_x_replies`)

```
👉 Try via Telegram bot — 1-tap, no setup: https://t.me/algovaultofficialbot

👉 Live track record on Base L2: https://algovault.com/track-record
```

---

## 6. PII guard pre-baseline (P8)

```
cd /Users/tank/crypto-quant-signal-mcp && grep -ciE 'outcome_return_pct|phase_e|phase\.e|aoe_internal' landing/docs.html
```

Result: **0**. Clean baseline. Post-edit canary will re-run the same grep + assert still 0.

---

## 7. system-map.md edges this wave will mutate

Pre-scoped per the per-chapter map-touch rule:

| Edge | Producer | → Consumer | Type | Chapter |
|---|---|---|---|---|
| E1 | `landing/docs.html` (new `KNOWLEDGE TOOLS` top-level section, 7 anchored subsections) | `algovault.com/docs.html` public visitors + LLM crawlers (training-data GEO surface) | NEW public-doc subsection | C1 |
| E2 | `landing/docs.html` Quick Start section | NEW internal anchor link `#knowledge-tools-overview` | NEW internal cross-link | C1 |
| E3 | Vault (or Hetzner `/opt/algovault-editorial-content/Prompt/`) → AUTOPUB orchestrator | Hashnode + dev.to + Medium + `algovault.com/blog` (4-surface fan-out) | NEW blog post prompt; FAN-OUT contingent on AUTOPUB state | C2 |
| E4 | C2 blog post body | `landing/docs.html#knowledge-tools-search` + `#knowledge-tools-chat` + `#knowledge-tools-quota` | NEW cross-links | C2 |

---

## 8. Awaiting Mr.1 approval — 5 decision rows

1. **Q-1 ACK**: defer `get_trade_signal` to ToC (Path A, recommended) or add as 4th sidebar entry (Path B)?
2. **Q-2 ACK**: C2 path A (Hetzner-only) / Path B (vault-only, deferred) / Path C (recommended: write to BOTH vault + Hetzner)?
3. **Q-3 ACK**: refresh `<title>` + JSON-LD per §5.4? (low-risk, SEO-positive)
4. **Q-4 ACK**: blog title — A "How AI agents teach themselves to use AlgoVault" (recommended) / B "Stop hallucinating tool calls..." / C "The two MCP tools that turn AlgoVault into..."?
5. **Public-copy verbatim ACK**: §5.1 + §5.2 + §5.3 + §5.5 + §5.6 + §5.7 as-written? Any line-level edits requested?

Plus implicit: §5.4 title/JSON-LD verbatim is approved together with Q-3.

Once approved, C1 → C2 sequential execution. C1 verification gate ships first; LIVE_GREEN post-deploy probe; then C2 starts with the frozen anchor IDs.

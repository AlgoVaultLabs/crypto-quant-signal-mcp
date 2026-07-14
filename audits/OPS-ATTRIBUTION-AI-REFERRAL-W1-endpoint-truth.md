# OPS-ATTRIBUTION-AI-REFERRAL-W1 — Plan-Mode endpoint-truth

**Wave:** capture AI-assistant browser referrals (the GEO signal) · META/internal analytics
**Audit date:** 2026-07-14 · **Audited against:** `origin/main` @ `826d698` (NOT the local checkout — see below)
**Verdict:** 🛑 **HALT** — 0 fictional CODE primitives, spec counts accurate, BUT **1 falsified premise (the referer map's only consumer is `/mcp`, not the web) + 1 hostname factuality correction (Grok).** 4 decisions for the architect.

---

## claim | reality | resolution

| # | Spec claim | Reality (probed) | Resolution |
|---|---|---|---|
| 0 | Repo `~/code/crypto-quant-signal-mcp`; edit there | local `main`=`f6a2b52`, **0 ahead / 61 BEHIND** `origin/main`=`826d698`; `classifySource`, `funnel-scoreboard.ts`, `getAgentFunnel` **absent from the local tree** | Audited vs `origin/main`. Implementation MUST branch a **fresh worktree off `origin/main`** (worktree-first LAW; `feedback_sync_primary_checkout_before_editing`) — never edit the stale local tree |
| 1 | `REFERER_DOMAIN_MAP` = 13 rules, first-match-wins, subdomain-safe `(^\|\.)host$`, case-insensitive | **13 rules confirmed** (x\|twitter, github, npmjs, dev.to, medium, lobehub, producthunt, reddit, smithery, glama, pulsemcp, mcp.so, `(google\|bing\|duckduckgo\|ecosia)\.`→organic). NOTE rule 13 is a *prefix* match (no `$`), the other 12 are `$`-anchored | ✅ accurate |
| 2 | `ATTRIBUTION_SOURCES` = 27 slugs | **27 confirmed** (`attribution-sources.test.ts` asserts `.length===27`) | ✅ accurate |
| 3 | precedence `?src → utm_source → Referer → UA → unknown` | confirmed: `resolveSource()` = `normalizeSrcParam(src) ?? normalizeSrcParam(utm)` → `classifyReferer(referer)` → `matchLlmClientUa(ua)` → `unknown` | ✅ accurate |
| 4 | "the classifier already reads `utm_source`" (R3 basis) | TRUE but via `normalizeSrcParam` = **enum-only**. `utm_source=chatgpt.com` is not an enum slug → returns `null` → falls through. **Currently NOT captured.** | R3 needs an **allow-listed domain→`ai_*` map** applied to `utmSource` BEFORE the enum check |
| 5 | ChatGPT auto-appends `utm_source=chatgpt.com` (Layer 2) | **CONFIRMED (primary sources):** broad since Jun 2025; survives referer-strip on mobile; **Perplexity/Gemini/Claude do NOT consistently UTM-tag** | Layer 2 is ChatGPT-specific & the single highest-value capture — *if* it runs where browsers arrive (see #9) |
| 6 | Recommend `bing.com → organic`; `ai_copilot` only from `copilot.microsoft.com` | `bing.com` **already → organic** (rule 13). `copilot.microsoft.com` currently → `null` (microsoft ∉ rule 13) | ✅ add `copilot.microsoft.com→ai_copilot`; bing stays organic (= status quo) |
| 7 | `grok.x.com`/`grok.ai` → `ai_grok`; order `grok.x.com` before the `x.com` rule | rule 1 `(^\|\.)x\.com$` **does** swallow `grok.x.com`. BUT **primary sources: canonical standalone = `grok.com`** (200); **Grok-on-X = `x.com/i/grok`** (a PATH; host=`x.com` → host-unrecoverable). `grok.x.com`→302, `grok.ai`→200 but **ownership UNVERIFIED (lookalike risk; `project_lookalike_domains`)** | Use **`grok.com → ai_grok`** (clean host, no ordering conflict). `grok.x.com` optional-defensive (ordered before x.com; won't match the real surface). **DROP `grok.ai`** unless Mr.1 confirms ownership. Document `x.com/i/grok` as host-unrecoverable (like AI-Overviews) |
| 8 | AI-Overviews caveat unrecoverable (arrives `google/organic`) | true — `gemini.google.com`/`bard.google.com` are distinct hosts (capturable); AI-Overviews inline in Google SERP is host `google.*` → rule 13 → organic | Document, don't "fix" ✅ |
| **9** | **R2/R3/R4 mechanism: add rows to `REFERER_DOMAIN_MAP`; the scoreboard human funnel then shows the AI referral family** | **🛑 FALSIFIED PREMISE.** `REFERER_DOMAIN_MAP`'s ONLY consumer is `classifyReferer` → `classifySource`, called at **exactly one site**: `app.all('/mcp', …)` `index.ts:2992→3181`. It stamps `agent_sessions.first_touch_source` (the **AGENT / MCP-connection** funnel; `funnel-scoreboard.ts:849` `SELECT first_touch_source FROM agent_sessions`). **No web GET route calls `classifySource`/`classifyReferer`.** The **human** funnel channel = `deriveChannel(clientRefId, utmSource)` (`subscriber-attribution.ts:56`) which **ignores the Referer** and has no `ai_*` path. A human clicking an AI citation → **web GET** (Caddy-static landing OR app web route) → **never reaches `/mcp`** → not classified into `ai_*`; a resulting signup stores raw `signup_attribution.referrer='chatgpt.com…'` but `channel='unknown'`. | **HALT (Q4).** As-specified the `ai_*` rules fire only on `/mcp` (server-to-server / stdio agent traffic), which does **not** carry human browser AI referrals → the wave would not measure its stated GEO signal. Architect must choose the layer (see Q4). |
| 10 | R4 places the "AI referral" family in the **human** funnel | The `classifySource`-derived data lives in the `source_channels` panel (`agent_sessions.first_touch_source`), i.e. the **agent** funnel — not `human_funnel.by_channel` (`signup_attribution.channel`). Panel mismatch. | Placement folds into Q4 |

---

## Guardrail check (all hold under the proposed classifier-only change)
- **Stateless resolver untouched** — `resolveSessionIdentity`/session-id derivation is separate; the `classifySource` call at `index.ts:3181` is explicitly "Additive — resolveSessionIdentity + the stateless resolver are untouched." My change is to the *pure* map + a utm normalization branch. ✅
- **`tools/list` byte-identical** — no tool-surface touched. ✅
- **First-touch immutable** — `first_touch_source = COALESCE(existing, ?)` write-once (`performance-db.ts:1098`); additive slugs only affect NEW sessions. ✅
- **No conflation** — agent `chatgpt`/`claude` are UA-matched at step 3 (`matchLlmClientUa`); `ai_*` are Referer(step 2)/utm(step 1). A UA-only agent connect never reaches step 2 → stays `chatgpt`. ✅ (testable)

## Probe log (commands run)
- `git -C REPO rev-list --left-right --count HEAD...origin/main` → `0  61`
- `git show origin/main:src/lib/attribution-sources.ts` → 13 referer rules, 27 slugs, precedence, `classifyReferer` (only internal caller = `resolveSource:150`)
- `grep app.(use|post|all) … <3181 | tail` → nearest = `app.all('/mcp', …)` @2992
- `git show origin/main:src/lib/subscriber-attribution.ts` → `deriveChannel` = prefix/keyword only, no Referer
- `git grep classifyReferer origin/main -- src` → 0 web-route callers
- `git grep first_touch_source origin/main` → written only on `agent_sessions` (`performance-db.ts:1076/1098`), read only by `funnel-scoreboard.ts:849`
- `curl -I` : grok.com→200, grok.x.com→302, grok.ai→200(unverified owner), copilot.microsoft.com→200, perplexity.ai→301, chatgpt.com→403(CF bot-block; domain valid)
- WebSearch: ChatGPT `utm_source=chatgpt.com` confirmed (broad since Jun 2025); Grok canonical = grok.com, Grok-on-X = x.com/i/grok

## Recommendation (for the HALT)
Q1 confirm slug family (+`ai` medium in `mediumForSource`, or group by `ai_` prefix). Q2 confirm bing→organic. Q3 **grok.com** (drop grok.ai; x.com/i/grok documented unrecoverable). Q4 → **(C) hybrid**: ship the classifier core (slug family + referer rows + utm-normalization, fully tested) AND wire the one real consumer that already has the data — classify `signup_attribution.referrer` via `classifyReferer` so ChatGPT-referred **signups** attribute to `ai_*` in the human funnel; defer the anonymous-visitor web beacon (Caddy-static landing needs a client-side `document.referrer` POST → new classify endpoint) to a follow-up. Makes the number real AND honest.

---

## Resolution (Mr.1 ratifications, 2026-07-14 — SHIPPED `c37d6b1`, GHA `29311788846` success)

- **Q1 → CONFIRM** the 6 `ai_*` slugs (27→33) + new `SourceMedium 'ai'` (mediumForSource ai_*→'ai', single-derivation); skip deepseek/meta.
- **Q2 → CONFIRM** — `bing.com` → `organic` (unchanged); `ai_copilot` only from `copilot.microsoft.com`.
- **Q3 → adopt the correction** — `grok.com` → `ai_grok`; `grok.ai` **DROPPED** (ownership unverified, look-alike risk); Grok-on-X `x.com/i/grok` is host-unrecoverable → `x` (documented beside the AI-Overviews caveat).
- **Q4 → (C) HYBRID.** Rider CONFIRMED: `signup_attribution.referrer` is the **SIGNUP-MOMENT** referer (the `/signup` click origin), NOT first-touch → per Mr.1's conditional, shipped the classifier CORE + the honest human-funnel "AI referral" FLOOR family + documented the gate; **beacon deferred → `OPS-ATTRIBUTION-AI-REFERRAL-BEACON-W1`** (rides the ~1K-visitors/mo web-analytics trigger).
- **Coupled side-fix:** `funnel-dashboard-html.ts` `source_channels` note called an UNDEFINED `setText()` (pre-existing ReferenceError) → `el('srccov').textContent=…`.
- **GREEN:** clean tsc; vitest **3245 pass** + node:test canaries; both gates no-override; tools/list=**9** (firewall byte-identical); `/api/performance-public` **200**; stateless resolver + `index.ts` untouched.

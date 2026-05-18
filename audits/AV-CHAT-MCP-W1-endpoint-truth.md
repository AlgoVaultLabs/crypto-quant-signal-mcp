# AV-CHAT-MCP-W1 — Endpoint-Truth (Plan Mode Step 0)

**Date:** 2026-05-18
**Spec:** `Prompt/av-chat-mcp-w1.md` (4 chapters: C1 BM25 search engine, C2 `search_knowledge` MCP+HTTP, C3 LLM+chat+rate-limit+`chat_knowledge` MCP+HTTP, C4 vitest+README/CHANGELOG)
**Plan-Mode triggers fired:** (1) ≥4 chapters; (2) external API first-use (Anthropic Messages API); (3) identifier cited in ≥3 places (`search_knowledge`, `chat_knowledge`, `/app/dist/knowledge/latest.json`, `claude-haiku-4-5-20251001`); (4) cross-chapter peek on contracts frozen at C1/C2 gate.

---

## 1. Wave Objective restatement

Ship two new MCP tools — `search_knowledge` (BM25 lexical retrieval, free, no LLM call) and `chat_knowledge` (LLM-synthesized answer with citations, quota-gated) — both automatically indexed from the `KNOWLEDGE-ARTIFACT-W1` bundle at `/app/dist/knowledge/latest.json`. Zero manual seeding. Zero hand-curated answers. ANY future knowledge-bundle update (new MCP tool, new audit snapshot, new integration tutorial, new framework example) flows automatically into the next search/chat result via the in-process `fs.watchFile` poll-every-30s rebuild path. This is the **runtime GEO surface** — every Cursor / Claude Code / connected-MCP agent that loads AlgoVault gets a self-pitching "ask me anything about AlgoVault" tool in their `tools/list` for free.

---

## 2. Identifier-diff table

Cross-checking every identifier cited in ≥2 places against the spec, against the existing codebase, and against the target-state filenames the wave creates.

| # | Identifier | Spec citation locations | Pre-wave codebase state | Target post-wave state | Diff verdict |
|---|---|---|---|---|---|
| ID-1 | Tool name `search_knowledge` | (a) `Prompt/av-chat-mcp-w1.md:15` Map Anchor E1; (b) §C2 describe-text L169; (c) AC L174; (d) drift-check `audits/search-knowledge-shape-snapshot-2026-05-18.json` L158; (e) wave-end live probe L415 | NOT registered (verified via `grep -nE "search_knowledge" src/` — zero hits) | (a) `src/tool-descriptions.ts` exports `SEARCH_KNOWLEDGE_DESCRIPTION` constant; (b) `src/index.ts` `server.registerTool(...)` for it; (c) `audits/search-knowledge-shape-snapshot-2026-05-18.json` exists | ✅ COHERENT — single canonical spelling across all 5 citations |
| ID-2 | Tool name `chat_knowledge` | (a) Map Anchor E2; (b) §C3 describe-text L262-266; (c) AC L284; (d) drift-check `audits/chat-knowledge-shape-snapshot-2026-05-18.json` L264; (e) live probe L427 | NOT registered (zero grep hits) | (a) `src/tool-descriptions.ts` exports `CHAT_KNOWLEDGE_DESCRIPTION`; (b) `src/index.ts` MCP registration; (c) shape snapshot | ✅ COHERENT |
| ID-3 | Bundle path `/app/dist/knowledge/latest.json` | (a) Wave-Obj L5; (b) §C1 spec L67-77 (KnowledgeIndex constructor reads this); (c) Map Anchor E6 | LIVE inside container — verified `docker exec crypto-quant-signal-mcp-mcp-server-1 ls -la /app/dist/knowledge/latest.json` returns 84,802 bytes, JSON body starts `{"version":"1.14.1",...}` | C1 wires `fs.watchFile(bundlePath, { interval: 30000 }, ...)` watcher | ✅ COHERENT — KNOWLEDGE-ARTIFACT-W1 already shipped this file. No path drift. |
| ID-4 | Model slug `claude-haiku-4-5-20251001` | (a) §C3 input schema L253; (b) Plan-Mode probe L444 (model slug verification); (c) C4 LLM provider tests L351-352 | NOT yet referenced — first-use of Anthropic API in this repo | C3 sets `claude-haiku-4-5-20251001` as default; `claude-sonnet-4-6` as fallback option | ⚠️ **CITATION DRIFT** — CLAUDE.md confirms Haiku 4.5 ID is `claude-haiku-4-5-20251001` (dated suffix). Sonnet 4.6 = `claude-sonnet-4-6` (no date suffix). Both valid per current CLAUDE.md. **Resolution:** lock these two as the allow-list. |
| ID-5 | npm `@anthropic-ai/sdk` version pin | Spec §C3 L220 + L258 says `"@anthropic-ai/sdk": "^0.40.0"` | Live `npm view @anthropic-ai/sdk version` → **`0.96.0`**. `dist-tags.latest = 0.96.0`. Peer dep: `zod ^3.25.0 \|\| ^4.0.0` (✅ repo has `zod@3.25.76` transitive via `@modelcontextprotocol/sdk@1.29.0`) | Wave installs `^0.96.0` (not `^0.40`) | ⚠️ **HALT-class — see Q-1** — spec is 56 minor versions stale. |
| ID-6 | npm `wink-bm25-text-search` version pin | Spec §C1 L92 says `"wink-bm25-text-search": "^2.0.0"` | Live `npm view wink-bm25-text-search version` → **`3.1.2`**. MIT license. | Wave installs `^3.0.0` | ⚠️ **HALT-class — see Q-2** — spec is 1 major version stale. |
| ID-7 | npm `lru-cache` version | Spec §C1 L88 says wrap `lru-cache@^10`. AC L93 says verify-via `npm ls lru-cache` if not present | Live `npm view lru-cache version` → `11.4.0`. `npm ls lru-cache` in repo shows transitive presence at v5.1.1 (babel transitive) AND v10.4.3 (jsdom transitive). NEITHER is a direct top-level dep. | Add `"lru-cache": "^10.0.0"` as direct dep (spec target). | 🟢 Spec target `^10` is still a supported major (10.x latest = 10.4.3). Spec coherent. Resolution: add direct `^10.0.0` per spec. |
| ID-8 | Env var `ANTHROPIC_API_KEY` | Spec §C3 L220-222 + L287 + Plan-Mode probe L452-453 | **NOT PRESENT** — (a) `gh secret list --repo AlgoVaultLabs/crypto-quant-signal-mcp` returns 3 secrets (`MCP_REPO_DISPATCH_TOKEN`, `VPS_HOST`, `VPS_SSH_KEY`) — no Anthropic; (b) `docker exec crypto-quant-signal-mcp-mcp-server-1 env \| grep -iE '^(ANTHROPIC\|OPENAI\|CLAUDE)'` → `NOT_SET` | C3 reads `process.env.ANTHROPIC_API_KEY` via `AnthropicProvider` constructor; falls back to `StubLLMProvider` if missing | ⚠️ **HALT-class — see Q-4** — needs Mr.1 provisioning at TWO endpoints (GHA secret + Hetzner `.env`) before C3 can deploy with live LLM responses. Spec accommodates this via graceful Stub fallback (server boots cleanly, chat returns `"[STUB] ..."` text). |
| ID-9 | Postgres DB name | Spec §C3 L260 + Plan-Mode probe L455 (`psql -h 204.168.185.24 -U algovault -d algovault`) | Live DB name is **`signal_performance`** (not `algovault`). User: `algovault`. 11 tables (no `chat_usage_monthly`). | C3 connects via existing pg pool (already wired in repo). New table `chat_usage_monthly` created via `CREATE TABLE IF NOT EXISTS`. | ⚠️ Spec probe line has WRONG `-d algovault` — should be `-d signal_performance`. C3 code path is unaffected (uses existing pool); only Plan-Mode probe verbiage is wrong. **Resolution:** noted; ignore the wrong probe verb in spec L455, use `-d signal_performance` in the actual probe. |
| ID-10 | Class names: `OpenAIProvider` vs `AnthropicProvider` | **Spec drift internal to §C3:** L220-222 says `AnthropicProvider`, but L251 (`src/index.ts` wire-up step) says `instantiate OpenAIProvider/StubLLMProvider`, and L351-352 (C4 tests) says `getLLMProvider() returns OpenAI when key set` + `assert instanceof OpenAIProvider`. Dispatch line (top of file) says Anthropic. Cost-cap (L458) uses Claude Haiku pricing. Map Anchor E5 says Anthropic Messages API. | N/A | Wave ships `AnthropicProvider` per the majority/coherent reading (Map Anchor + describe-text + system prompt + cost-cap + model slug all Anthropic). | ⚠️ **HALT-class — see Q-5** — spec has 3 residual `OpenAI*` strings that contradict the Anthropic-coherent rest of the spec. Resolution: silently treat as drift; wave uses Anthropic uniformly + flags this in the wave commit message + status.md entry. |

---

## 3. Probe table (all 12 rows + 4 additional)

Every probe was executed live during this Plan-Mode session. Result column captures observed output verbatim (truncated where noisy).

| # | Probe | Expected | Observed | Verdict | Side-fix N still applies? |
|---|---|---|---|---|---|
| P1 | `npm view @anthropic-ai/sdk version` | `^0.40.x` per spec | **`0.96.0`** (dist-tags.latest) | ⚠️ Spec stale — see Q-1 | n-a (no side-fix targets this) |
| P2 | `npm view wink-bm25-text-search version` | `^2.x` per spec | **`3.1.2`** (MIT) | ⚠️ Spec stale — see Q-2 | n-a |
| P3 | `npm view lru-cache version` | `^10.x` per spec | `11.4.0` (10.x still maintained) | 🟢 Spec target `^10` still valid | n-a |
| P4 | `npm ls lru-cache` (in `/Users/tank/crypto-quant-signal-mcp`) | Present transitively? | Transitive via `@babel/core` (v5.1.1) and `jsdom` (v10.4.3) — **NOT direct top-level dep** | 🟡 Add `"lru-cache": "^10.0.0"` as DIRECT dep per spec — current transitives are dev-only / cssstyle internals, not stable to import | n-a |
| P5 | `curl -sI -X POST https://api.anthropic.com/v1/messages` (from operator macOS, KL ISP) | HTTP 401 (auth missing, endpoint reachable) | `HTTP/2 401` + `x-should-retry: false` + request-id | 🟢 LOCAL_GREEN | n-a |
| P6 | Same probe via SSH to Hetzner | HTTP 401 (no geo-block) | `HTTP/2 401` + request-id (identical shape, different request-id) | 🟢 HETZNER_GREEN — no geo-block on Anthropic egress from Hetzner DE | n-a — confirms `two-geo-cloudfront-function-gate-detection` not needed (both geos same shape) |
| P7 | `gh secret list --repo AlgoVaultLabs/crypto-quant-signal-mcp` | Look for `ANTHROPIC_API_KEY` | 3 secrets present: `MCP_REPO_DISPATCH_TOKEN`, `VPS_HOST`, `VPS_SSH_KEY`. **No Anthropic** | 🛑 Q-4 HALT-class for live-deploy. Stub fallback covers boot-time. | n-a |
| P8 | `ssh root@204.168.185.24 'docker exec crypto-quant-signal-mcp-mcp-server-1 env \| grep -iE "^(ANTHROPIC\|OPENAI\|CLAUDE)"'` | NOT_SET or set? | `NOT_SET` | 🛑 Q-4 HALT-class — needs Hetzner `.env` append + container recreate | n-a |
| P9 | `grep -rnE "ANTHROPIC_API_KEY\|@anthropic-ai/sdk\|OpenAI\|claude-haiku\|claude-sonnet" src/` | Zero hits (first-use) | Zero hits across `src/**/*.ts` | 🟢 First-use confirmed — no conflicting integration | n-a |
| P10 | `docker exec crypto-quant-signal-mcp-postgres-1 psql -U algovault -d signal_performance -c '\d chat_usage_monthly'` | Relation does not exist | `Did not find any relation named "chat_usage_monthly"` | 🟢 Greenfield — C3 will CREATE TABLE IF NOT EXISTS | n-a |
| P11 | `cat .dockerignore \| head -20` | Confirm dist/knowledge NOT excluded | **`.dockerignore` file does not exist** (matches KNOWLEDGE-ARTIFACT-W1 Plan-Mode probe Q-2 finding) | 🟢 No allow-list fight; W1 bundle path already proven through full build chain | n-a |
| P12 | `command -v npx && npx vitest --version` | Reachable | `/opt/homebrew/bin/npx` + `vitest/3.2.4 darwin-arm64 node-v25.9.0` | 🟢 vitest reachable per TOOL-DESC-AUDIT-W1 pattern. **Caution per `node-version-divergence-local-vs-ci` WIS:** local Node 25.9.0 vs CI Node 20.x; clean rebuild + CI rebuild are authoritative, not local incremental tsc. | n-a |
| P13 (extra) | Live container `/app/dist/knowledge/latest.json` size + version | exists + readable | 84,802 bytes, body starts `{"version":"1.14.1","generated_at":"2026-05-18T07:46:19.301Z",...}` | 🟢 W1 producer is live in prod | n-a |
| P14 (extra) | Postgres existing `quota_usage` schema | Probe for monthly-quota reuse | `(tracker_key TEXT PRIMARY KEY, call_count INTEGER, period_start TEXT)` — flexible composite-key pattern | 🟡 Q-7 — could reuse via `tracker_key = "chat:<api_key>:<month_iso>"` but spec wants token-counts (no column for that). Recommend NEW table per spec. | n-a |
| P15 (extra) | `npm view @anthropic-ai/sdk peerDependencies` + repo zod resolution | Compat | SDK peer: `zod ^3.25.0 \|\| ^4.0.0`. Repo `npm ls zod` → `zod@3.25.76` (deduped, via `@modelcontextprotocol/sdk@1.29.0` + `@x402/*`) | 🟢 Compat confirmed — no zod conflict | n-a |
| P16 (extra) | Hetzner deploy path + .env presence | Locate `.env` to append `ANTHROPIC_API_KEY` | `/opt/algovault/crypto-quant-signal-mcp/.env` exists (root:root, 415 bytes) | 🟢 Path known; Mr.1 can append via `echo "ANTHROPIC_API_KEY=sk-ant-..." \|\| ssh root@204.168.185.24 'cat >> /opt/algovault/crypto-quant-signal-mcp/.env'` + `docker compose up -d` to recreate (per `pm2-update-env-dotenv-silent-rotation-regression` WIS — `docker compose restart` does NOT reload env_file) | n-a |

---

## 4. system-map.md edge-touch enumeration

Pre-scoped in spec Map Anchor; reproducing here for the per-chapter commit gate (each chapter's commit MUST touch system-map.md to satisfy the 600s pre-commit freshness window).

| Wave edge | Chapter that adds it | system-map.md section | Edge classification |
|---|---|---|---|
| E1 NEW MCP tool `search_knowledge` → LLM agents | C2 | `crypto-quant-signal-mcp` → external agents (Produces row + edge table) | Public + tight contract |
| E2 NEW MCP tool `chat_knowledge` → LLM agents | C3 | same | Public + tight contract |
| E3 NEW HTTP `/api/search` (POST) | C2 | `crypto-quant-signal-mcp` → HTTP clients | Public + tight contract |
| E4 NEW HTTP `/api/chat` (POST) | C3 | same | Public + tight contract |
| E5 NEW external integration: Anthropic Messages API | C3 | External integrations section | Tight (chat depends on it; falls back to Stub if missing) |
| E6 NEW internal consumer: bundle file → `src/lib/knowledge-index.ts` BM25 indexer | C1 | Internal: `dist/knowledge/latest.json` → BM25 indexer | Tight |
| E7 NEW build dep: `@anthropic-ai/sdk` | C3 | npm dependencies | Loose |
| E8 NEW build dep: `wink-bm25-text-search` | C1 | npm dependencies | Loose |
| E9 NEW separate quota: chat-only rate-limit + `chat_usage_monthly` Postgres table | C3 | `crypto-quant-signal-mcp` Persistent storage | Tight |

**Per-chapter system-map.md `Last touched` line refresh** is the canonical primitive (per PILOT-ADAPTERS-W1 WIS `per-chapter-system-map-touch-in-bulk-spec`): every chapter commit touches the `**Last touched:** 2026-05-18 ...` line at the top of system-map.md with a 1-line chapter-summary append so the 600s pre-commit gate stays green across the wave.

---

## 5. Architect-ratification rows (HALT-class — wait for approval before C1)

These items require Mr.1 sign-off BEFORE C1 begins.

### Q-1 — `@anthropic-ai/sdk` version pin: spec `^0.40.0` vs live latest `0.96.0`

**Severity:** HALT-class (spec citation is 56 minor versions stale).

**Resolution paths:**
- **Path A (recommended): pin `^0.96.0`** — current latest minor; API surface for `client.messages.create({ model, max_tokens, system, messages })` is stable across 0.40→0.96. Prompt-caching support (which the spec wants for the locked verbatim system prompt) was added in 0.27 — anything from 0.40 onward has it. New minors after 0.40 add: model-shaped beta endpoints, streaming improvements, batch API, web search, computer use — none load-bearing for this wave. Lockfile pin to `^0.96.0` ensures we get bugfixes within the 0.96.x track.
- **Path B (more conservative): pin `0.40.x`** — strict adherence to spec. Loses ~6 months of bugfixes + caching-API stability improvements. Not recommended.

**Default decision (pending Mr.1 ACK):** Path A — pin `^0.96.0`.

### Q-2 — `wink-bm25-text-search` version pin: spec `^2.0.0` vs live latest `3.1.2`

**Severity:** HALT-class (spec citation is 1 major version stale).

**Resolution paths:**
- **Path A (recommended): pin `^3.0.0`** — current latest major. API surface change between 2.x→3.x is minimal per the npm changelog (better TS types, modernized async, MIT license preserved). All field-weight + BM25-ranking primitives the spec uses are unchanged.
- **Path B: pin `^2.0.0`** — strict adherence to spec. Stays on the version family the spec was written against.

**Default decision (pending Mr.1 ACK):** Path A — pin `^3.0.0` (and verify the 4 `wink-bm25-text-search` API calls in C1 against the v3 docs as a Plan-Mode-extension probe before C1 ships).

### Q-3 — Path forward for `ANTHROPIC_API_KEY` provisioning

**Severity:** HALT-class for production deploy of C3 (server boots cleanly without the key via `StubLLMProvider` fallback — but live chat needs the key).

**Resolution paths:**
- **Path A (recommended for THIS wave): ship C1+C2+C3+C4 with Stub fallback; defer live-key provisioning to a Mr.1-completed step AFTER wave-end deploy is GREEN.** Wave ships StubLLMProvider as a first-class implementation. Wave-end live verification gate uses Stub LLM (returns `[STUB] ...` text but with citations attached). Mr.1 then:
  1. Mints an Anthropic API key with usage budget (e.g., $50/mo cap)
  2. `printf '%s' "$KEY" \| gh secret set ANTHROPIC_API_KEY --repo AlgoVaultLabs/crypto-quant-signal-mcp`
  3. `ssh root@204.168.185.24 'echo "ANTHROPIC_API_KEY=$KEY" >> /opt/algovault/crypto-quant-signal-mcp/.env && cd /opt/algovault/crypto-quant-signal-mcp && docker compose up -d mcp-server'` (NOT `docker compose restart` — per `pm2-update-env-dotenv-silent-rotation-regression` WIS, env_file changes require recreate)
  4. Post-provision live probe: `curl -X POST https://api.algovault.com/api/chat -d '{"question":"..."}'` returns answer NOT starting with `[STUB]`.

  This keeps the wave landable today without secret-in-transcript risk and matches the existing repo pattern (e.g., x402 facilitator key was provisioned post-deploy).
- **Path B: block C3 until Mr.1 provisions the key in-session.** Adds a chat in-session step; Mr.1 pastes key once (transcript-leak risk per `secret-handoff-channel-discipline-not-chat-transcript` WIS).

**Default decision (pending Mr.1 ACK):** Path A — Stub-first deploy with post-wave key provisioning by Mr.1.

### Q-4 — Spec residual `OpenAI*` drift in §C3 body

**Severity:** Mid (no HALT; coherent reading is uniformly Anthropic).

The spec has 3 residual `OpenAI` strings (L251, L351, L352) that contradict the Anthropic-coherent rest of the spec (dispatch line, Map Anchor E5, model slug, system prompt, cost-cap math, env-var citations, `@anthropic-ai/sdk` package). All other 30+ references in §C3 are Anthropic.

**Resolution:** Wave ships uniformly Anthropic (no OpenAI types/classes/env vars). Spec drift documented here + in status.md "spec residual drift caught at Plan Mode" subsection. No new files reference OpenAI.

### Q-5 — Reuse existing `quota_usage` table vs new `chat_usage_monthly` table

**Severity:** Low (spec is explicit; just confirming the architectural choice).

Existing `public.quota_usage` table has `(tracker_key TEXT PK, call_count INT, period_start TEXT)` — flexible composite-key. Could absorb chat usage via `tracker_key = "chat:<api_key>:<month_iso>"`.

Spec mandates a NEW dedicated table `chat_usage_monthly(api_key, month_iso, request_count, prompt_tokens, completion_tokens, PK(api_key, month_iso))` for token-count tracking (cost forensics).

**Resolution paths:**
- **Path A (per spec, recommended): ship NEW `chat_usage_monthly` table** — captures token counts for cost analytics; cleaner separation; future-proof for usage-based pricing.
- **Path B: reuse `quota_usage`** — loses token-count tracking. Not recommended.

**Default decision:** Path A per spec.

---

## 6. Cost-cap proposal (per spec §Plan-Mode-Step-0 row 4)

**Pricing (Claude Haiku 4.5):** $1.00 / 1M input tokens, $5.00 / 1M output tokens. Prompt caching: ~90% discount on cached input ($0.10 / 1M cached input).

**Per-query cost model:**
- System prompt (locked verbatim, ~250 tokens) — **cached** after first call within 5min window → $0.000025
- User message: question (~50 tokens) + 8 snippets × ~200 chars ≈ 8 × 50 tokens = 400 tokens → ~450 input tokens uncached → $0.00045
- Output: ≤200 words ≈ 250 tokens → $0.00125
- **Per-query: ~$0.0017** (call it $0.002 with overhead)

**Monthly tier ceilings** (per spec §C3 L240):
- Free: 10/mo
- Starter: 50/mo
- Pro: 200/mo
- Enterprise: 2000/mo

**Worst-case monthly spend** (100% of every active key on every tier maxes out):
- Even if 10 free + 10 starter + 10 pro + 1 enterprise users all max out: 10·10 + 10·50 + 10·200 + 1·2000 = 4600 queries → $9.20/mo.
- Spec's worst-case assumption (18,000 queries): ~$36/mo.

**Realistic utilization (~20%):** ~3,600 queries × $0.002 = **$7.20/mo**. Negligible.

**Cost-cap recommendation:** No external rate-limit on Anthropic API call needed at deploy time. ChatRateLimit per-tier quota table is the budget primitive. Anthropic side: set the API key's monthly budget cap to **$50/mo** in the Anthropic console as a hard ceiling (independent of our rate-limit).

**Mr.1 ACK requested for:** $50/mo Anthropic-side hard ceiling. If higher cap needed for ramped enterprise usage, bump in console post-launch.

---

## 7. Rate-limit primitive reuse check

**Existing primitive (`src/index.ts:529-547`):**
```ts
const { default: rateLimit } = await import('express-rate-limit');
app.use('/mcp', rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));
app.use('/analytics', rateLimit({ windowMs: 60_000, max: 30, ... }));
app.use('/webhooks', rateLimit({ windowMs: 60_000, max: 20, ... }));
```

This is a **window-based** in-memory rate-limit (express-rate-limit). Resets every 60s. Designed for "burst protection" not "monthly quota."

**Spec's `ChatRateLimit` requirement:** **calendar-month-based**, per-API-key, persistent (survives restart), with token-count tracking. Different semantics — needs its own primitive.

**Conclusion:** `ChatRateLimit` is NOT a duplicate of `express-rate-limit`. The two layer:
1. `express-rate-limit` middleware on `/api/chat` route (existing `/mcp` umbrella covers MCP tool calls; `/api/chat` will inherit since it sits behind `/mcp` for MCP-side OR get its own 60s/30-req limit for HTTP-side burst protection — TBD by C3 author).
2. `ChatRateLimit` (new) for monthly-quota tracking — fires BEFORE engine.chat() inside the tool handler, returns `{ code: "CHAT_QUOTA_EXHAUSTED", ... }` on quota hit.

C3 should clearly comment the two-layer relationship in `src/lib/chat-rate-limit.ts` so future readers don't conflate them.

---

## 8. Side-fix re-verify column

CLAUDE.md mandates that every endpoint-truth row include `Side-fix N still applies (Y/N)` alongside R-section primitives. This wave's spec does NOT cite any prior wave's side-fix N (no "side-fix from PILOT-ADAPTERS-W1 step X" or similar) — all 12 probes are GREEN-or-architect-decision, no prior side-fix carryover.

All probes annotated `n-a` in the table above. If any post-approval Plan-Mode extension surfaces a side-fix carryover, this section will be updated.

---

## 9. Pre-flight deploy.yml + Dockerfile sniff

Per CLAUDE.md Plan-Mode rule "Sniff-check `cat .github/workflows/deploy.yml \| head -10`":

- **deploy.yml**: 108 lines; SSH-deploys via `appleboy/ssh-action`; uses `VPS_HOST` + `VPS_SSH_KEY` secrets; runs `docker compose up -d --build --force-recreate` inside the SSH script per KNOWLEDGE-ARTIFACT-W1 Q-2 Path B finding. The `--force-recreate` is intentional defense against env_file race. **For this wave**: live install of `ANTHROPIC_API_KEY` will go via SSH `.env` append + `docker compose up -d` recreate (not via deploy.yml env-pass-through, which doesn't exist for non-Telegram secrets).
- **Dockerfile**: 2-stage. Stage 1 builds + runs `npm run build:knowledge` (W1). Stage 2 prod copies `dist/`, `CHANGELOG.md`, `landing/integrations/`, `landing/skills.html`, `landing/integrations.html`. **No env vars baked into image** — env is deploy-time via `docker-compose.yml`'s `env_file: .env`. So `ANTHROPIC_API_KEY` does NOT need a Dockerfile change.
- **No deploy.yml change needed** for this wave (no new COPY directives — all new source paths under `src/lib/` are already covered by Stage 1's `COPY src/ ./src/`; new `tests/` paths are dev-only).
- **`deploy.yml` `paths-ignore` audit:** spec doesn't touch `.github/workflows/`, so no paths-ignore expansion needed.

---

## 10. Pre-existing test baseline (per `baseline-test-failure-stash-pop-bisect` WIS)

Before C1 code edits, capture the baseline test-failure count so post-wave we can confirm `+0 delta` (or properly attribute any new failures).

```bash
cd /Users/tank/crypto-quant-signal-mcp && \
  git stash --include-untracked && \
  npx vitest run --reporter=basic 2>&1 | tail -10 | tee /tmp/baseline.txt && \
  git stash pop
```

(To be run immediately before C1 starts, AFTER architect approval, NOT during Plan Mode.)

Expected baseline per KNOWLEDGE-ARTIFACT-W1 status.md entry: "16 file fails / 5 test fails — design canvas SHA pins + DB-requiring tests" (unrelated to this wave; should remain at +0 delta).

---

## 11. Wave-end live verification probe (pre-built for reference)

Listed here for the wave-end gate (after C4 GREEN + npm version bump + GHA deploy success). All three `_GREEN` tokens must print:

```bash
# (1) LIVE_TOOLS_GREEN — MCP tools/list contains both new tool names
INIT=$(curl -sS -i -X POST https://api.algovault.com/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}')
SID=$(echo "$INIT" | grep -i '^mcp-session-id:' | awk '{print $2}' | tr -d '\r\n')
curl -sS -X POST https://api.algovault.com/mcp -H "Mcp-Session-Id: $SID" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' > /dev/null
curl -sS -X POST https://api.algovault.com/mcp -H "Mcp-Session-Id: $SID" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/list"}' | sed -n 's/^data: //p' | head -1 | \
  jq -e '[.result.tools[].name] | contains(["search_knowledge", "chat_knowledge"])' > /dev/null && echo LIVE_TOOLS_GREEN

# (2) LIVE_SEARCH_GREEN — HTTP /api/search returns ranked results
curl -fsS -X POST https://api.algovault.com/api/search -H 'Content-Type: application/json' \
  -d '{"query":"how do I get a trade signal"}' | \
  jq -e '.total_results > 0 and (.results[0].source_type == "tool") and (.results[0].title | contains("trade") or contains("call"))' && echo LIVE_SEARCH_GREEN

# (3) LIVE_CHAT_GREEN — HTTP /api/chat returns synthesized answer with citations
# NOTE: if ANTHROPIC_API_KEY not yet provisioned per Q-3 Path A, expect `[STUB]` prefix in answer; still has citations.
curl -fsS -X POST https://api.algovault.com/api/chat -H 'Content-Type: application/json' \
  -d '{"question":"how do I get a BTC trade signal with stop loss?"}' | \
  jq -e 'has("answer") and (.citations | length > 0) and has("model")' && echo LIVE_CHAT_GREEN
```

---

## 12. Wave plan summary (for Mr.1 review)

| Chapter | Files written (new + modified) | Commit shape | Verification gate token |
|---|---|---|---|
| C1 | NEW: `src/lib/knowledge-index.ts`, `src/lib/search-engine.ts`, `src/lib/result-cache.ts`. MODIFIED: `package.json` (`wink-bm25-text-search@^3` + `lru-cache@^10` adds), `system-map.md` (E6 + E8 rows + Last-touched line) | `feat(knowledge): BM25 search engine + index builder + result cache (C1 of AV-CHAT-MCP-W1)` | `CH1_GREEN` |
| C2 | NEW: `src/lib/search-knowledge-formatter.ts`, `audits/search-knowledge-shape-snapshot-2026-05-18.json`. MODIFIED: `src/index.ts` (additive — MCP tool + Express route), `src/tool-descriptions.ts` (add `SEARCH_KNOWLEDGE_DESCRIPTION`), `system-map.md` (E1 + E3 rows + Last-touched) | `feat(knowledge): search_knowledge MCP tool + /api/search HTTP endpoint (C2 of AV-CHAT-MCP-W1)` | `CH2_GREEN` |
| C3 | NEW: `src/lib/llm-provider.ts`, `src/lib/chat-engine.ts`, `src/lib/chat-rate-limit.ts`, `src/lib/chat-knowledge-formatter.ts`, `audits/chat-knowledge-shape-snapshot-2026-05-18.json`. MODIFIED: `src/index.ts` (additive — MCP tool + Express route + chat_usage_monthly CREATE-TABLE-IF-NOT-EXISTS), `src/tool-descriptions.ts` (add `CHAT_KNOWLEDGE_DESCRIPTION`), `package.json` (`@anthropic-ai/sdk@^0.96` add), `system-map.md` (E2 + E4 + E5 + E7 + E9 rows + Last-touched) | `feat(knowledge): chat_knowledge MCP tool + Anthropic LLM provider + chat rate-limit (C3 of AV-CHAT-MCP-W1)` | `CH3_GREEN` |
| C4 | NEW: 6 vitest files (`tests/unit/{knowledge-index,search-engine,result-cache,llm-provider,chat-engine}.test.ts` + `tests/integration/knowledge-flow.test.ts`). MODIFIED: `README.md` (What's-new v1.15.0 + cache-refresh notice), `CHANGELOG.md` (v1.15.0 entry) | `test(knowledge): unit + integration tests + v1.15.0 release notes (C4 of AV-CHAT-MCP-W1)` | `CH4_GREEN` |
| Wave-end | `npm version minor` (1.14.1 → 1.15.0), `git push --follow-tags`, watch deploy.yml + release-knowledge.yml in parallel | `1.15.0` (automatic `npm version` commit) | `LIVE_TOOLS_GREEN` + `LIVE_SEARCH_GREEN` + `LIVE_CHAT_GREEN` |

---

## 13. Awaiting Mr.1 approval

**Decisions needed BEFORE C1 starts:**

1. **Q-1**: Pin `@anthropic-ai/sdk@^0.96.0` (Path A, recommended) or `^0.40.0` (Path B, strict spec)?
2. **Q-2**: Pin `wink-bm25-text-search@^3.0.0` (Path A, recommended) or `^2.0.0` (Path B, strict spec)?
3. **Q-3**: Stub-first deploy + post-wave key provision (Path A, recommended) or in-session key handoff before C3 (Path B)?
4. **Q-4 acknowledgment**: noted spec residual `OpenAI*` drift; wave ships uniformly Anthropic.
5. **Q-5 acknowledgment**: new `chat_usage_monthly` table (Path A per spec, recommended).
6. **Cost-cap**: $50/mo Anthropic-side hard ceiling — ACK?

Once approved, Code exits Plan Mode and proceeds C1 → C2 → C3 → C4 → wave-end live verify → npm bump 1.14.1 → 1.15.0 → git push --follow-tags → parallel-watch deploy.yml + release-knowledge.yml → post-deploy live probe → status.md append → WIS bullets appended to CLAUDE.md.

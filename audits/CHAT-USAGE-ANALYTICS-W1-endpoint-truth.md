# CHAT-USAGE-ANALYTICS-W1 — Endpoint-Truth (Plan Mode Step 0)

**Date:** 2026-05-18
**Spec:** `Prompt/chat-usage-analytics-w1.md`
**Plan-Mode trigger:** Self-initiated per CLAUDE.md Execution-flow rule 3 — risk marker: table name `chat_analytics_events` cited in ≥3 places (R1 schema, R3 INSERT, R5 dashboard query, R6 digest query, R8 vitest assertion). Public-copy gate does NOT trigger (R5 admin-gated; no public surface).

---

## 1. Wave Objective restatement

Instrument AV-CHAT-MCP-W1's `chat_knowledge` MCP tool + `/api/chat` HTTP endpoint with a forward-only Postgres event table (`chat_analytics_events`) capturing per-call usage / cost / latency / no-answer signals with **PII-safe shape** (SHA256-truncated question hash + length only — never raw text). Single recording middleware (`recordChatEvent`) called once per chat path so future surfaces (`/api/chat-stream`, etc.) auto-flow. Cost calculation centralized in `src/lib/llm-pricing.ts` so future LLM providers (Gemini, OpenAI) drop in with one entry. Surface admin-gated HTML dashboard + Sunday-09:00-UTC Telegram weekly digest. Digest emits **LLM-PROVIDER-A/B-W1 trigger status** so the next-wave unblock signal surfaces automatically.

---

## 2. Probe table (all 6 R1 + Plan-Mode probes)

| # | Probe | Expected (spec) | Observed | Verdict |
|---|---|---|---|---|
| P1 | `grep -rnE 'pg\.Pool\|new Pool\|getPool' src/` | exported pool primitive | **`src/lib/performance-db.ts:63`** declares `this.pool = new Pool(...)` inside `class PgBackend`, but the pool itself is NOT exported. Repo pattern is helper-based: `dbExec(sql)` (fire-and-forget DDL), `dbRun(sql, ...params)` (fire-and-forget DML), `dbQuery<T>(sql, params): Promise<T[]>` (async SELECT). | ⚠️ **Q-1 architect-decision** — spec's `recordChatEvent(pool: pg.Pool, ev)` signature deviates from repo convention. See §3 Q-1. |
| P2 | `grep -rnE 'ADMIN_API_KEY\|adminKey\|/admin/\|safeCompare' src/` | reusable middleware pattern | Inline pattern in `src/index.ts` (L934-L1042) inside `if (adminKeyRaw) { ... }` block: reads `process.env.ADMIN_API_KEY`; uses `safeCompare(token, adminKey)` (timing-safe Buffer compare at L132); two access shapes — Bearer header (L976) + `?key=<key>` query param (L997, L1042). NOT a real Express middleware function — pattern is "early-return res.status(401)" inline per-route. | 🟢 Reuse exact inline pattern for `/admin/chat-analytics` (add INSIDE the `if (adminKeyRaw)` block alongside `/dashboard` + `/analytics`). |
| P3 | `grep -rnE 'TelegramBot\|TELEGRAM_BOT_TOKEN\|telegram\.org' src/` | bot lib + weekly-digest cron mirror | `src/lib/telegram.ts` exports `sendDigest()` — silent no-op if `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` unset (graceful per `feedback_npm_bump_companion_manifests_auto`); `src/scripts/shadow-digest-weekly.ts` is the canonical weekly-cron mirror. Invoked via Hetzner crontab: `0 0 * * 0 docker exec ... node dist/scripts/shadow-digest-weekly.js >> /var/log/shadow-digest.log 2>&1`. | 🟢 Mirror this exact pattern for `chat-analytics-digest.ts` (Sunday 09:00 UTC per spec L174). |
| P4 | `docker exec ... psql -U algovault -d signal_performance -c '\d chat_usage_monthly'` (correcting spec L244 typo from `-d algovault`) | confirm shape from AV-CHAT-MCP-W1 | `(api_key TEXT, month_iso TEXT, request_count INT, prompt_tokens BIGINT, completion_tokens BIGINT, PK(api_key, month_iso))` — **monthly aggregate** shape. Different consumer than the new `chat_analytics_events` (per-event detail). Both needed. | 🟢 Confirms spec L38 — keep two separate tables. |
| P5 | `ls src/scripts/*.ts` | existing cron entry-point layout | 9 scripts: agent-forum-post, backfill-outcomes, deploy-merkle-contract, evaluate-venues, monitor, publish-merkle-batch, register-erc8004-agent, seed-signals, **shadow-digest-weekly**. | 🟢 Add `src/scripts/chat-analytics-digest.ts` as #10. |
| P6 | `docker exec ... psql -c '\d chat_analytics_events'` | greenfield | `Did not find any relation named "chat_analytics_events"` | 🟢 Safe to CREATE TABLE IF NOT EXISTS at module-init. |
| P7 (extra) | `docker exec ... psql -c 'SELECT version();'` | confirm PG 13+ for `ADD COLUMN IF NOT EXISTS` + `percentile_cont` + `date_trunc AT TIME ZONE` | `PostgreSQL 16.13` | 🟢 All native features in spec (date_trunc, percentile_cont WITHIN GROUP, ADD COLUMN IF NOT EXISTS) supported. |
| P8 (extra) | `docker exec ... env \| grep -c '^ADMIN_API_KEY='` | needs to be set for `/admin/chat-analytics` to register | `1` | 🟢 Admin key already provisioned in container env. Live probe will use the key Mr.1 controls. |
| P9 (extra) | Hetzner crontab survey | confirm crontab is the canonical schedule mechanism (NOT systemd-timer for in-container scripts) | Crontab has 50+ entries including `0 0 * * 0 docker exec ... shadow-digest-weekly.js`; 3 systemd timers exist but for HOST-side jobs (algovault-bot, funnel-snapshot) not in-container scripts. | 🟢 Cron pattern is canonical for in-container scripts. Code self-provisions the new cron line via SSH per CLAUDE.md "Self-provision manual prerequisites whenever operator identity has root access to both endpoints" rule. |

---

## 3. Architect-ratification rows

### Q-1 — `recordChatEvent` signature: spec's `(pool: pg.Pool, ev)` vs repo helper pattern

**Severity:** Low (architecture-level — affects 2 files in this wave; spec's intent is clear, only the function shape changes).

**Spec L136:** `export async function recordChatEvent(pool: pg.Pool, ev: ChatAnalyticsEvent): Promise<void>` — receives the pg.Pool by parameter.

**Repo reality:** NO exported `pg.Pool` primitive. The PgBackend instance is encapsulated; consumers use `dbExec` / `dbRun` / `dbQuery` (all from `src/lib/performance-db.ts`). AV-CHAT-MCP-W1's `ChatRateLimit.record()` uses `dbRun` directly — same shape.

**Resolution paths:**
- **Path A (recommended):** Adapt signature to `export function recordChatEvent(ev: ChatAnalyticsEvent): void` (fire-and-forget, returns void); body uses `dbRun(sql, ...params)` to match repo convention + ChatRateLimit precedent. No DI plumbing through src/index.ts; the chat tool handler + Express route just import and call `recordChatEvent(ev)`.
- **Path B:** Export `getPool()` from `src/lib/performance-db.ts` (new public API) so spec's pool-parameter signature works literally. More plumbing, no benefit — Path B's pool injection is a testing-affordance the spec doesn't actually leverage (R3 doesn't accept a mock pool elsewhere; R8 tests pool-less behavior via `pool.query.rejects`).

**Default decision (pending ACK):** Path A — adapt signature, document deviation in code comment, keep semantic intent intact (single recording function, fire-and-forget, never throws to caller).

### Q-2 — Hetzner crontab entry for weekly digest

**Severity:** Low — needs SSH self-provisioning post-deploy.

**Finding:** Spec L174 says "Sunday 09:00 UTC". Repo's existing crontab has 50+ entries for in-container scripts using the canonical pattern `<schedule> docker exec crypto-quant-signal-mcp-mcp-server-1 node dist/scripts/<script>.js >> /var/log/<script>.log 2>&1`. New entry needed: `0 9 * * 0 docker exec crypto-quant-signal-mcp-mcp-server-1 node dist/scripts/chat-analytics-digest.js >> /var/log/chat-analytics-digest.log 2>&1`.

**Resolution:** Code self-provisions the crontab entry via SSH after the GHA deploy lands the compiled script (per CLAUDE.md "Self-provision manual prerequisites whenever operator identity has root access to both endpoints" rule). Steps:
1. After deploy success, SSH to Hetzner
2. `crontab -l > /tmp/crontab.bak-pre-chat-analytics-2026-05-18` (backup)
3. `(crontab -l; echo '0 9 * * 0 docker exec crypto-quant-signal-mcp-mcp-server-1 node dist/scripts/chat-analytics-digest.js >> /var/log/chat-analytics-digest.log 2>&1') | crontab -` (idempotent — `(crontab -l | grep -v chat-analytics; ...)` if re-runs needed)
4. Verify: `crontab -l | grep chat-analytics-digest`
5. Manual trigger test: `docker exec crypto-quant-signal-mcp-mcp-server-1 node dist/scripts/chat-analytics-digest.js --dry-run`

**Default decision (pending ACK):** Code self-provisions via SSH at post-deploy step.

### Q-3 — Spec L230 / L244 `-d algovault` typo

**Severity:** Documentation-only (won't fail wave; same trap as AV-CHAT-MCP-W1).

**Finding:** Spec live-probe at L230 + Plan-Mode probe at L244 both use `psql -U algovault -d algovault`. Actual DB name is `signal_performance` (verified during AV-CHAT-MCP-W1). The probes in this Plan-Mode used `-d signal_performance`.

**Resolution:** Document the typo + use the correct DB name in all live probes. Future operators reading the spec L230 should treat `-d algovault` as a known typo and substitute `-d signal_performance`.

**Default decision:** Noted; no architect ACK required.

### Q-4 — Stub LLM responses & `no_answer_flag` interaction

**Severity:** Low — semantic clarification.

**Finding:** Spec L141: `no_answer_flag = ev.answer.includes("I don't have that in my knowledge base")` — locked verbatim from AV-CHAT-MCP-W1 chat-engine system prompt Rule #2 fallback. **But Stub responses start with `[STUB]`** and don't contain the verbatim phrase, so they register as `no_answer_flag=false`. Stub provider also returns `usage.promptTokens=0` / `completionTokens=0`, so `cost_usd_e6=0`.

**Operational meaning:** Stub responses count as queries with cost=0 and no_answer_flag=false. They're observably distinct via `WHERE cost_usd_e6 = 0 AND answer NOT contains 'STUB'` — but we don't store `answer`, only `answer_length`. A grep on the prefix is impossible after-the-fact.

**Resolution paths:**
- **Path A (recommended — keep spec):** No schema change. Stub responses are tracked as zero-cost queries; LLM-PROVIDER-A/B-W1 trigger probe still counts them toward the ≥100/day threshold (volume is volume). Operational note: if ANTHROPIC_API_KEY is unset for an extended window, the digest will show "$0 cost" and "0% cached" — that's the implicit Stub indicator. **NOTE**: ANTHROPIC_API_KEY is currently provisioned (per AV-CHAT-MCP-W1 follow-up completed 2026-05-18 19:56 UTC), so this is theoretical for now.
- **Path B:** Add a `provider TEXT` column to schema tracking `llm.name` ('anthropic' / 'stub' / future). Cleaner but adds schema width for an edge case.

**Default decision (pending ACK):** Path A — keep spec. Document the stub-handling note in `recordChatEvent` source comment so future operators see the contract.

---

## 4. Probe-corrected wave deliverables (post-Plan-Mode adjustments)

| Step | Spec says | Actual deliverable |
|---|---|---|
| R1 | Inline DDL at module-init via `dbExec` | ✓ Same — single block at startHttp boot, idempotent (CREATE TABLE / INDEX / VIEW all IF NOT EXISTS / OR REPLACE) |
| R2 | `src/lib/llm-pricing.ts` per spec body | ✓ Same — verbatim per spec; 2 entries (claude-haiku, claude-sonnet); future-extensible |
| R3 | `recordChatEvent(pool, ev)` | **Q-1 adapt:** `recordChatEvent(ev): void` using `dbRun` — see §3 Q-1 |
| R4 | Wire into MCP + HTTP chat handlers | ✓ Same — additive only; `Date.now()` start/end markers + `recordChatEvent` call inside try/catch (per CLAUDE.md `proof-of-sideeffect-log-in-try-except` companion log on insert success path is implicit via the dbRun's existing PG-error console.error in performance-db.ts) |
| R5 | `/admin/chat-analytics` dashboard | ✓ Same — reuse inline `safeCompare` admin gate INSIDE existing `if (adminKeyRaw)` block. Renderer file `src/lib/chat-analytics-dashboard.ts`. |
| R6 | Sunday 09:00 UTC Telegram cron | ✓ Same — `src/scripts/chat-analytics-digest.ts` mirroring `shadow-digest-weekly.ts` pattern; Hetzner crontab entry self-provisioned via SSH post-deploy (Q-2) |
| R7 | system-map + status + WIS | ✓ Same |
| R8 | vitest canary | ✓ Same — 6 cases per spec L193-198 |

---

## 5. Wave-end gate (must print `W1_GREEN`)

Per spec L204-219, verbatim. The PII canary `! grep ... INSERT.*question[^_]` is the critical line — must never INSERT raw `question` column.

Plus the post-deploy live probe per spec L223-234 (with corrected `-d signal_performance`).

---

## 6. system-map.md edges this wave will mutate

Pre-scoped per the per-chapter-system-map-touch rule (PILOT-ADAPTERS-W1 WIS):

| Wave edge | Producer | → Consumer | Type |
|---|---|---|---|
| E-A | `chat_knowledge` MCP tool + `/api/chat` HTTP (in `src/index.ts`) | `chat_analytics_events` Postgres table via `recordChatEvent()` middleware in `src/lib/chat-analytics.ts` | NEW internal consumer edge |
| E-B | `chat_analytics_events` Postgres table + `chat_analytics_daily` view | `/admin/chat-analytics` admin-gated HTML page via `src/lib/chat-analytics-dashboard.ts` | NEW internal consumer edge |
| E-C | `chat_analytics_events` Postgres table + `chat_analytics_daily` view | Sunday 09:00 UTC Telegram weekly digest via `src/scripts/chat-analytics-digest.ts` + Hetzner crontab `0 9 * * 0 docker exec ...` | NEW external publish surface |

---

## 7. Awaiting Mr.1 approval — 2 decisions

1. **Q-1 ACK**: Adapt `recordChatEvent(ev): void` to use `dbRun` per repo convention (Path A, recommended) or keep spec's `recordChatEvent(pool, ev)` shape with new `getPool()` export from performance-db.ts (Path B)?
2. **Q-2 ACK**: Code self-provisions Hetzner crontab entry via SSH post-deploy (Path A, recommended per CLAUDE.md self-provision rule) or defer cron wiring to a Mr.1-only step after deploy?

Q-3 (spec DB-name typo) + Q-4 (stub response semantics) are documentation-only; no ACK required.

Once approved, R1 → R2 → R3 → R4 → R5 → R6 → R8 → R7 sequential execution.

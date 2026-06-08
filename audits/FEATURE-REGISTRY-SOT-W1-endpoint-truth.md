# FEATURE-REGISTRY-SOT-W1 — Plan-Mode Step-0 endpoint-truth

**Produced:** 2026-06-08 · **Verdict:** 🟡 **HALT — architect-confirm: (Q1) deploy premise is STALE (account UN-FLAGGED), (Q2) chat/search quota model needs an enum value, (Q3) ratify the load-bearing registration + live-x402 refactor approach. Then C1.**
**Tier-2 Bulk-Spec (4 chapters) · probed real checkout `/Users/tank/code/crypto-quant-signal-mcp` @ origin/main `4a4b122`** (clean; HEAD==origin/main).

---

## 🔴 Q1 — DEPLOY PREMISE STALE (prompt line 113)

| Prompt claim | Reality (probed now) | Resolution |
|---|---|---|
| "GitHub account FLAGGED → direct rsync deploy, NO commit; Do NOT run `deploy-direct.sh`" | **Account is UN-FLAGGED.** `git push --dry-run origin main` → `Everything up-to-date` (no auth error); I pushed `4c79798` + `4a4b122` ~20 min ago (WEBSITE-X402-SURFACING-W1). `ls-remote` works. | **Deploy = commit+push → `deploy-direct.sh`** per the prior wave's ratified **Q3 standing directive** ("try commit+push; if unsuccessful direct-deploy; report"). NOT rsync-no-commit. |
| (implicit) GHA auto-deploys on push | **GHA STILL DOWN** — latest `Deploy to Hetzner` run = `13cbddb` 2026-06-06; today's pushes triggered NO run. | After commit+push, deploy via **`deploy-direct.sh`** (git-resets host→origin/main → snapshot-inject → Caddy → rebuild). The prompt's "git-reset reverts uncommitted work" concern is MOOT once committed. |

**This is the same finding I recorded in status.md last wave** (2026-06-08 08:40 UTC WEBSITE-X402-SURFACING-W1, "🔑 DEPLOY-MECHANISM FINDING"). The prompt was authored against the older flagged state.

---

## Step-0 probes (`claim | reality | resolution`)

### #1 — Tool inventory — CONFIRMED (9; alias real)
Live `tools/list` (3-step handshake, loopback `:3000/mcp`): **9 names** = `get_trade_call`, `get_trade_signal`, `get_market_regime`, `scan_funding_arb`, `scan_trade_calls`, `get_equity_call`, `get_equity_regime`, `chat_knowledge`, `search_knowledge`. = 8 canonical + the `get_trade_signal` alias. `index.ts` `server.tool(` ×9 at lines **329/336/345/388/443/468/497/541/578** (NOT the cited `:90/102/145`). `makeTradeCallHandler` at **:293** (both `get_trade_call` `:330` + `get_trade_signal` `:337` register via it). → Registry = **8 FeatureSpecs**; `get_trade_call.aliases=['get_trade_signal']`; `name ∪ aliases` (9) == tools/list.

### #2 — x402 keys — CONFIRMED (canonical gap real)
`x402.ts:58 TOOL_PRICING = { get_trade_signal: 0.02, scan_funding_arb: 0.01, get_market_regime: 0.02 }` (keyed by the **alias** `get_trade_signal`). `SIGNAL_TIMEFRAME_PRICING` (:65) premiums exist but only `effectivePrice(get_trade_signal, tf)` applies them (:437). **Canonical `get_trade_call` has NO key** → `effectivePrice('get_trade_call')` = `TOOL_PRICING['get_trade_call']` = undefined (the gap CH3 closes via alias-resolution, keyed canonically). Scanner/equity/chat/search NOT in TOOL_PRICING.

### #3 — Quota rules per tool (registry quota column) — line refs CORRECTED + chat/search finding
| Tool | quota.unit | holdFree | trackCall site (CORRECTED) | x402 today |
|---|---|---|---|---|
| `get_trade_call` (+alias) | per-non-hold | true | `get-trade-call.ts:447` (gate `:104`) — prompt said `:351` | $0.02 |
| `get_market_regime` | per-call | false (no HOLD) | `get-market-regime.ts:40` — prompt said `:32` | $0.02 |
| `scan_funding_arb` | per-call | false | `scan-funding-arb.ts:147` — prompt said `:145` | $0.01 |
| `scan_trade_calls` | per-non-hold-min1 | (holds free) | `scan-trade-calls.ts:110` `units=Math.max(1,eligible_non_hold)` | **null** |
| `get_equity_call` | per-non-hold | true | `equity-tool-formatters.ts:92` (HOLD-free per QUOTA-CONSISTENCY-W1) | null |
| `get_equity_regime` | per-call | false | `equity-tool-formatters.ts` quotaGate (per-call) | null |
| `chat_knowledge` | **🔴 not call-metered** | n/a | **NO `trackCall`** — rate-limited via `chat-rate-limit.ts` (`rateLimit.check/record`, token/usage-based) | null |
| `search_knowledge` | **🔴 not call-metered** | n/a | **NO `trackCall`** — same rate-limit path | null |

**🔴 Q2:** chat/search do NOT consume the 100/mo call quota — they have a SEPARATE token/usage rate-limit. The prompt's `quota.unit: 'per-call'|'per-non-hold'|'per-non-hold-min1'` has **no value** for them. **Propose adding `'rate-limited'`** (or `'untracked'`) to the enum → chat/search = `quota:{unit:'rate-limited', holdFree:false}`. Architect confirm.

### #4 — `/capabilities` route — NO collision ✅
`grep "/capabilities"` in `index.ts` → only the IMPORT of `./lib/capabilities.js` (the distinct **COUNTS** module: `EXCHANGES`/`TIMEFRAME_COUNT`/`getAssetCount`). **No `app.get('/capabilities')` route exists** → CH2's new route is safe. ⚠️ Naming overlap note: the route `/capabilities` projects the NEW `feature-registry.ts`; the existing `capabilities.ts` is unrelated counts — keep them distinct (consider the route name, or a clarifying comment).

### #5 — system-map edges
**Map Anchor:** NEW component `src/lib/feature-registry.ts` (pure data; no edge until consumed) + NEW `GET /capabilities` producer surface (future bot/webhook consumers in W2) + internal-derive annotations (`server.tool` registration loop, `x402.ts TOOL_PRICING`/`/x402/*` derive from registry) + NEW host-cron canary consumer (CH4 → `send_telegram.sh`). **bot/webhook/landing UNTOUCHED** (W2). `tools/list`=9 unchanged. `system-map.md updated: Y` (CH4).

---

## Q3 — refactor-risk approach (ratify the byte-equivalence spine)
CH2 (registry-driven `server.tool` registration) + CH3 (`TOOL_PRICING` derive) touch **load-bearing registration + a LIVE payment surface**. Build Rule 3 byte-equivalence spine: snapshot live `tools/list` (9 names) + the 3 x402 prices + `audits/x402-shape-snapshot` BEFORE each refactor; assert byte-identical AFTER; the ONLY deltas are additive (`/capabilities`, canonical `get_trade_call` x402 key). Recommend: keep each tool's existing handler + Zod schema **verbatim**; only the registration *index/loop* + the price *source* become registry-driven. Abort-on-diff. Confirm.

---

## HALT — architect Q-block (copy-paste to Cowork; see chat)
- **Q1** Deploy: account is UN-FLAGGED → commit+push each chapter then `deploy-direct.sh` (per prior Q3), NOT the prompt's rsync-no-commit? 
- **Q2** chat/search quota model: add `'rate-limited'` to `quota.unit` (they're token-rate-limited, not call-metered)?
- **Q3** Ratify the byte-equivalence-spine refactor approach (handlers/schemas verbatim; only registration-index + x402 price-source become registry-driven; abort-on-diff)?

## Post-approval execution (CH1→CH4, sequential, byte-equivalence-gated)
CH1 registry SoT (8 FeatureSpecs per the corrected table) + `feature-registry.test.ts`. CH2 registry-driven registration + `GET /capabilities`. CH3 x402 derive (canonical key, NO value change). CH4 drift canary + runbook + system-map + WIS. Each prints `FEATURE_REGISTRY_SOT_W1_CH<N>_GREEN`.

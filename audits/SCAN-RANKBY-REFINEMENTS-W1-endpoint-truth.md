# SCAN-RANKBY-REFINEMENTS-W1 — Plan-Mode Step-0 endpoint-truth

**Date:** 2026-06-28 · **Base:** worktree off origin/main `3caee3c` (v1.21.0 + SCAN-RANKBY-W1/W2/W3 + SCAN-DIGEST-MCP-PARITY-W1)
**Verdict: 0 fictional primitives.** All anchors verified live on origin/main. Plan-Mode HALT cleared by architect (Q1–Q5 ratified 2026-06-28); folded into V2-RESUME (thin confirmation gate; HALT only on NEW drift or a non-empty CH4 golden-set).

## §0 Reconciliation (verify-ship-boundary-on-resume)
Local `~/code/crypto-quant-signal-mcp` was 78 commits behind origin/main (backward-dep files looked absent; oiScore looked at L301). Authoritative = origin/main `3caee3c`. All W1–W3 + digest LIVE on main (git-log verified). NEW-drift gate at execution start: `git log 3caee3c..origin/main -- <anchors>` = EMPTY (no drift).

## §1 Anchor truth table (claim | reality @ origin/main | resolution)
| Spec claim | Reality | Resolution |
|---|---|---|
| `computeOiDelta(…, window)` parameterized | `oi-snapshots.ts:140`/`:158` take window as **ms** (`DEFAULT_OI_WINDOW_MS`); `oiDeltaFromSnapshots:111` pure, takes `windowLabel` | CH1 adds `OI_WINDOWS` (1h/4h/24h→ms) + `oiWindowLabelForMs`; passes the label so the echo is correct. NOT fictional. |
| `oiScore` "307-310" priceChange | actual **L306-312**: `if(assetCtx.openInterest>0){ if(priceChange>0.02)… }`; priceChange=L246; used L332 `oiScore*WEIGHTS.oi` | Line-fix 307-310→306-312. Confirms `internal-oiScore-still-priceChange-derived`. |
| `oi-snapshot-sampler.ts` 5 venues, USD | `src/scripts/oi-snapshot-sampler.ts` (POOL=60, writes `{symbol,oi,ts}`, oi=USD) | CH3 extends to capture base-coin OI; CH2 mirrors the cron pattern. |
| OKX per-instId funding cache + shortlist | `rank-metrics.ts:83-126` okxFundingCache+warmer; `FUNDING_POOL_SIZE=150`; shortlist L320 | CH2 lifts OKX to full universe; fail-soft → this shortlist. |
| RANK_BY_VALUES / resolveRankBy | `rank-constants.ts:18`/`:63` (9 lenses, oid→oi_change) | CH3 = a PARAM, not a value → RANK_BY_VALUES unchanged, tools/list=9. |
| getRankedUniverse / attachRank | getRankedUniverse `rank-metrics.ts:260`; attachRank `trade-call-scanner.ts:163` (echoes oi_change_window L177); callsite L349 | CH1/CH3 thread `{window,basis}` as trailing optional opts (enum-widening LAW); cache key gains them; attachRank echoes oi_change_basis. |
| migrations/011 | `(exchange,symbol,ts,oi)`; highest = 019 | CH3 → `020_oi_snapshots_contracts.sql`; CH4 → `021_oiscore_shadow.sql`. |

## §2 External-API live probes (Precedence #4)
- OKX SWAP universe = **401**; funding per-instId only (`?instType=SWAP`→50014); rate limit **20 req/2s per-IP** (prompt "10/2s" conservative → impl reuses shared `VENUE_FETCH_CONFIGS.OKX`). OKX has a BULK open-interest endpoint (401 in one call; `oi`/`oiCcy`/`oiUsd`).
- **All 5 venues expose base-coin OI directly:** Binance `sumOpenInterest` (103318 BTC), Bybit `openInterest` (56881), Bitget `size` (33889), HL `openInterest` (33518), OKX `oiCcy` (7782). `contracts_oi` stores base-coin-unit OI (price-independent; cross-venue comparable without contractSize normalization).

## §3 Architect ratifications (2026-06-28 — Q1–Q5)
- **Q1=A:** OKX full-universe funding = IN-PROCESS coalesced cache + warmer in NEW `src/lib/okx-funding-poller.ts` (mirrors okxFundingCache; shared 20/2s OKX budget; warms in the long-lived MCP server ONLY; short-lived crons/CLI fall back to the top-150 shortlist). NO new table/cron. (B) rejected — scan lenses run inside the MCP server, so the full universe is covered where it matters. Keeps the wave to 2 migrations.
- **Q2:** CH4 = PURE-EXTRACTION of the score→verdict tail (rawScore→Z-gate→signal/confidence) called twice (live=oiScore_price default, shadow=oiScore_oi). No logic change. Gate = COMPREHENSIVE golden-set byte-identity diff (BUY/SELL/HOLD × regimes + openInterest>0 guard + edge cases). Non-empty → HALT, do NOT touch the verdict.
- **Q3:** shadow store = PG table `oiscore_shadow` (pre-applied); write fire-and-forget + try/catch-isolated (never blocks/fails the live verdict); recorded at signal-evaluation. WR methodology finalized in SCAN-OISCORE-FLIP-W1. `OISCORE_SOURCE` default `price`.
- **Q4:** worktree off 3caee3c; SSH pre-apply on prod `signal_performance` BEFORE each chapter's push (push auto-deploys via GHA): migration 020 (contracts_oi) pre-CH3; migration 021 (oiscore_shadow) pre-CH4. Both ALSO fail-soft in code.
- **Q5:** CH1 enum→ms default 24h; CH3 PARAM oiBasis (not a RANK_BY_VALUES variant), contracts_oi = base-coin OI; additive `.default()` params → shape-snapshot baseline updated (`audits/scan_trade_calls-rankby-refinements-shape-snapshot-2026-06-28.json`).

## §4 Deploy / test / canary
- Push auto-deploys via GHA `deploy.yml` (push:[main]) → schema pre-apply BEFORE push. CI gate canaries: build_landing / feature-registry / **rank-metrics-parity** / scan-digest-parity + geo node:tests + clean `tsc`.
- Tests: `npx vitest run` (full); CH1 added 7 (oi-snapshots + rank-metrics); suite GREEN 2707 pass / 0 fail.
- system-map edges: CH2 NEW `okx-funding-poller → funding cache`; CH3 `oi_snapshots += contracts_oi`, sampler captures contracts, oi_change contracts basis; CH4 additive shadow log + `OISCORE_SOURCE` flag (NONE to the live verdict).

## §5 Risk markers (∴ Plan-Mode) — CLEARED by architect
verdict-touching (oiScore, shadow-only) · 2 schema migrations · new background producer (OKX poller) · external first-use · identifiers cited >1 place · ≥4 chapters · Data-Integrity (track record immutable; no live verdict change this wave).

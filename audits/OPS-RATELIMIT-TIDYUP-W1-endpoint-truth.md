# OPS-RATELIMIT-TIDYUP-W1 — endpoint-truth (Plan-Mode, light)

**Date:** 2026-06-06
**Verdict:** ✅ **READY — 0 fictional primitives.** Two disjoint tidy-ups, both verified against live data. No blocking architect-confirm; two findings surfaced for ratification (a spec-mandated FLAG + a minor identifier-diff). Spec says "wait for architect" → presenting, then C1.

Risk markers: firewalled-file touch (`seed-signals.ts`); `OPS-HL-WEBSOCKET` cited >1 place; non-GHA deploy. Light Plan-Mode.

---

## Step 0 — system-map edge-touch

**NONE structural** → `system-map.md updated: n-a`. R1 fills a `caller` VALUE on the existing `seed → HL (REST)` producer edge (the caller dimension itself shipped in OPS-RATELIMIT-CALLER-ATTRIBUTION-W1); R2 changes a digest ACTION string + planning docs. No new edge/component, no MCP tool, `tools/list`=9, no response-shape change.

---

## R1 — `seed:<tf>` caller tag

| # | Primitive | Reality | Resolution |
|---|---|---|---|
| 1 | **Firewall** `git status -s seed-signals.ts` | ✅ **EMPTY** — no concurrent session editing it; HEAD `873ddec`, no concurrent code commits | R1 may proceed |
| 2 | seam: `runAsBatch` at `seed-signals.ts:990`; `timeframe` parsed at `:992` inside | ✅ `main()` = `return runAsBatch(async () => {... const {timeframe}=parseArgs(); ...})` | hoist `const seedTf = parseArgs().timeframe;` before the `runAsBatch`, pass `'seed:' + seedTf` as its caller (the optional-caller seam from `upstream-weight-budget.ts`). **1 line + the close** `}` → `}, 'seed:' + seedTf)`. No seed logic touched. |
| 3 | `parseArgs` purity (double-call safe?) | ✅ pure for VALID args (returns the parsed object); only `console.error+process.exit(1)` on INVALID args → the running seed always has valid args, and an invalid-arg exit happens identically on the first call. Safe to call twice. | parseArgs-twice (cleaner than a far-close `runAsCaller` wrap of the whole body) |
| 4 | R1.2 test: import `parseArgs` without auto-running the seed | ✅ `seed-signals.ts:1076` `if (require.main === module) main()...` — `main()` does NOT run on import; `tests/seed-signals-parse-args.test.ts` already imports `parseArgs` (precedent) | seam test: `parseArgs(['--timeframe','8h']).timeframe` → `'seed:8h'` → `runAsBatch(() => ({caller: currentCaller(), cls: currentWeightClass()}), 'seed:8h')` == `{caller:'seed:8h', cls:'batch'}`. Proves tf-derivation + caller+class. (AC1 live gate proves end-to-end.) |

---

## R2 — formally cancel `OPS-HL-WEBSOCKET`

**R2.1 — complete enumeration (whole repo + vault):**
| Site | Type | Action |
|---|---|---|
| `src/scripts/shadow-digest-weekly.ts:163` | the live dispatch line (CODE) | **R2.2 redirect** the action |
| `tests/unit/rate-limit-events.test.ts:94` | `toContain('OPS-HL-WEBSOCKET-W{NEXT}')` | **FORCED-TOUCH** → assert the new driver-agnostic action (line 90/97 names cosmetic) |
| `tests/unit/shadow-digest-rate-limit.test.ts:43` | `toContain('OPS-HL-WEBSOCKET-W{NEXT}')` | **FORCED-TOUCH** → assert the new action |
| `migrations/008_rate_limit_events.sql:5` | historical comment in an APPLIED migration | leave (immutable history; no functional effect) |
| vault `status.md` (10×) | historical wave entries | leave (immutable); add a NEW cancellation entry (R2.3) |
| vault `Claude files/WIS-PENDING.md` (4×) | incl. my OPS-HL-BACKFILL-BATCH-W1 "CANCELLED" bullet | already records the cancellation; reinforce (R2.3) |
| `AlgoVault-MCP-roadmap.md` | **0 refs** (never tracked — also 0 "websocket"/"stream") | identifier-diff vs spec R2.3 — see below |

The W{NEXT}-template test (`rate-limit-events.test.ts` "trigger lines use the W{NEXT} template") still passes after the redirect: the joined lines retain the SHADOW trigger's `OPS-SHADOW-BUDGET-W{NEXT}`; the HL line's redirected action carries no `W{NEXT}` and no literal `-W\d`. Verify at C-time.

**R2.2 redirect (keep threshold/mechanism unchanged — lines 133/134/158):**
`— Action: dispatch OPS-HL-WEBSOCKET-W{NEXT} via Cowork → Claude Code` → `— Action: investigate the HL interactive driver via the per-caller breakdown above (attribute first; do NOT prescribe a structural wave blind)`.

**🔶 R2 SCOPE FINDING (spec-mandated FLAG — confirmed live):** the HL trigger's `batch-wait p95 > 20s` condition (line 158, `HL_WAIT_P95_TRIGGER_MS=20_000`) now FALSE-POSITIVES on by-design batch waits. Live HL batch-wait p95 = **179.1s (7d, n=22077)** / **58.9s (post-OPS-HL-BACKFILL-BATCH-W1, n=464)** — both ≫ 20s, because the batch lane is DESIGNED to wait up to ~5min under budget pressure (that's how it yields to interactive). So the trigger will fire weekly on healthy waits. **Per R2.2 scope discipline I do NOT retune** — I FLAG **`OPS-RATELIMIT-DIGEST-THRESHOLD-RECAL-W{NEXT}`** (re-baseline the HL batch-wait p95 threshold to the post-fix by-design distribution, or gate it on a wait/skip RATIO rather than absolute p95). The redirect makes the (still-firing) trigger point at attribution, not the cancelled wave — so it's coherent in the interim.

**R2.3 planning:** status.md cancellation entry + WIS (reinforce the existing CANCELLED bullet). **Roadmap identifier-diff:** the spec says "roadmap mark OPS-HL-WEBSOCKET CANCELLED" but the roadmap has **0** `OPS-HL-WEBSOCKET`/websocket refs — it never tracked the item (it lived only as a digest self-watch trigger + WIS/status). Resolution: record the cancellation in the live trackers (WIS + status) + the digest redirect (the actual mechanism); I will NOT fabricate a roadmap entry to cancel something never on it. (If you want a forward-planning "considered & rejected" note on the roadmap for institutional memory, say so — a 1-line note, else skipped.)

---

## Plan (contingent on "proceed")

- **C1 / R1** (firewall clear): hoist `seedTf` + pass `'seed:'+seedTf` to `runAsBatch` (`seed-signals.ts`); seam test.
- **C2 / R2.2**: redirect `shadow-digest-weekly.ts:163`; update the 2 forced-touch test assertions; verify the W{NEXT}-template test; FLAG `OPS-RATELIMIT-DIGEST-THRESHOLD-RECAL-W{NEXT}` (WIS + status, NOT retuned).
- **C3 / R2.3**: status.md cancellation entry; reinforce WIS CANCELLED bullet; roadmap per the diff above.
- **Gates**: clean build; full suite +0 new failures (15 artifact baseline); deploy-direct `--verify-only` GREEN, `tools/list`=9; AC1 live seed-fire → `caller='seed:<tf>'`; AC2 `grep -rn "dispatch OPS-HL-WEBSOCKET" src/` = 0 + digest `--dry-run` shows the redirected action. status.md + `system-map.md: n-a` + WIS. **AC4 firewall:** `git diff --stat` only `seed-signals.ts` + `shadow-digest-weekly.ts` + the 2 test files + vault planning.

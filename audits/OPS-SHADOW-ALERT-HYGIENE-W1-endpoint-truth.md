# OPS-SHADOW-ALERT-HYGIENE-W1 — Plan-Mode Step 0 (endpoint-truth + identifier-diff + HALT triage)

**Wave:** OPS-SHADOW-ALERT-HYGIENE-W1 (Tier-1, single-session sequential) — Deliverable A of the Shadow-Venue Pipeline brief.
**Date:** 2026-06-01 (probed 07:15 UTC).
**Prompt:** `Prompt/shadow-pipeline-hotfix-A.md`.
**Effort:** Plan-Mode read-only — 0 file edits, 0 state mutation. All probes below are reads.
**Verdict preview:** ✅ **NO HALT** — 0 surprise fictional primitives. The 4 identifier deltas were pre-anticipated parameterizations the prompt explicitly told me to resolve at probe-time ("adapt column names to Step-0 probe 5"; "confirm field-casing convention"). Structural facts (decision tree, venue-store surface, telegram path, schema) all match the brief. Awaiting architect ratification of Q-A…Q-D before any mutation.

---

## Wave Objective (restated)

Silence the false day-15/30 venue auto-EXTEND / manual_required Telegram alerts for venues that have **no seeding pipeline yet** (`buy_sell_count == 0`), pause their promotion clock until seeding actually starts (new nullable `seeding_started_at` column + `COALESCE` clock), and heal ASTER/EDGEX which already burned `extension_count=1` on empty data. Ship **before** the alert cascade starts (first new false alerts fire 2026-06-03). **Does NOT** build the seed loop (Deliverable B / `OPS-SHADOW-PIPELINE-W1`) — this wave ships the column + gate that B depends on.

---

## R0.0 — `$REPO` resolution (CRITICAL)

| Claim | Reality | Resolution |
|---|---|---|
| brief header path `/Users/tank/crypto-quant-signal-mcp/` | `git rev-parse HEAD` = `74507f3` — an **ANCESTOR** of origin (stale; origin advanced past it) | ❌ DO NOT USE |
| prompt canonical `/Users/tank/code/crypto-quant-signal-mcp` | `git rev-parse HEAD` = `d6b4559`, branch `main` | ✅ **= origin HEAD `d6b4559b…`** — USE THIS |
| origin HEAD (authoritative) | `git ls-remote origin HEAD` → `d6b4559b64f1818a270fdf8c7c98468939a008ee` | — |

**`$REPO = /Users/tank/code/crypto-quant-signal-mcp` @ `d6b4559` (in sync with origin/main).** All edits land here. (My 2026-06-01 forensic reads used the stale `74507f3` clone; this Step-0 re-anchored every code fact on `d6b4559` — `evaluate-venues.ts` is byte-identical at the relevant lines, so the forensic decision-tree summary holds.)

---

## Probe results (`claim | reality | resolution`)

### Probe 2 — Clean baseline
- `git -C $REPO status -s` (scope files `evaluate-venues.ts` / `venue-store.ts` / `types.ts`): **CLEAN** — no modified/staged in-scope files. Only untracked artifacts outside scope (`.x402-*.cjs`, `audits/*.md`). **No concurrent-session HALT.**

### Probe 3 — `evaluate-venues.ts` decision tree (live, `d6b4559`)
| Claim (brief §decision tree) | Reality (live source) | Resolution |
|---|---|---|
| sample symbol `buy_sell_count` | `EvalStats.buy_sell_count` (field) + local `buySellCount` (line 91) from SQL alias `buy_sell_count` | ✅ confirmed → **Q-C** |
| `days_since` derived from `integrated_at` | `computeVenueStats()` lines 78–80: `integratedAt = new Date(venue.integrated_at)` → `integratedUnix` → `daysSince`; `integratedUnix` also binds into BOTH sample/WR SQL `created_at > ?` (lines 89, 107) | ✅ confirmed → **Q-B** |
| Branch 2 extend = `incrementExtension()` + `sendVenueStatusChange(action:'extended')` | lines 187–197 | ✅ confirmed |
| Branch 3 manual = `sendVenueStatusChange(action:'manual_required')`, no auto state change | lines 198–209 | ✅ confirmed |
| no_op produces zero side-effects | loop (lines 176–210) acts ONLY on `promoted`/`extended`/`manual_required`; `no_op` falls through silently; `recordEval()` (line 171) runs for ALL venues before `decide()` | ✅ confirmed — suppression-by-classification works |

### Probe 4 + 5 — `venue-store.ts` / `types.ts` surface + live schema
| Claim (brief abbreviations) | Reality (live `information_schema.columns` + source) | Resolution |
|---|---|---|
| column `exchange` | actual `exchange_id` (text) | 🔧 corrected → **Q-A** |
| column `last_eval_n` | actual `last_eval_buy_sell_count` (integer) | 🔧 corrected → **Q-A** |
| column `last_eval_wr` | actual `last_eval_pfe_wr` (real) | 🔧 corrected → **Q-A** |
| column `integrated`/`ext` | actual `integrated_at` (timestamptz) / `extension_count` (integer) | 🔧 corrected → **Q-A** |
| new column `seeding_started_at` | **ABSENT** from `venues` (12 cols: asset_count, exchange_id, extension_count, integrated_at, last_eval_at, last_eval_buy_sell_count, last_eval_pfe_wr, min_buy_sell_sample, notes, promoted_at, retired_at, status) | ✅ safe to ADD (idempotency confirmed) |
| `VenueRecord` field casing `seedingStartedAt?` | interface is **snake_case** (`integrated_at`, `last_eval_pfe_wr`, …) | 🔧 field = `seeding_started_at: string \| null` → **Q-A** |
| `listVenues`/`getVenue` SELECT | both use `SELECT *` (lines 155, 172, 176) | ✅ new column flows through automatically — only `rowToRecord` (line 115) + `VenueRecord` interface need editing |
| `incrementExtension` | `UPDATE venues SET extension_count = extension_count + 1 WHERE exchange_id = ?` (line 251) | ✅ confirmed (suppressed by A1 classification, untouched) |

### Probe 6 — Live venue/signal state (thin re-confirm vs ground truth)
- `signals` by exchange: **only 5 promoted venues** (BYBIT 36559 / OKX 35300 / BITGET 34517 / BINANCE 26655 / HL 7672 — slight growth vs 06-01 forensic = promoted venues accumulating, expected). **All 12 shadow venues: 0 rows** (absent from GROUP BY). ✅ ground truth holds.
- `venues`: ASTER + EDGEX still `extension_count=1`, `last_eval_buy_sell_count=0`. All other shadow venues `extension_count=0`. ✅ heal scope unchanged (still exactly ASTER+EDGEX). (Note: XT shows `last_eval_buy_sell_count=NULL` not 0 — never evaluated; irrelevant to A1, which gates on the live `buy_sell_count` computed each run, not the stored snapshot.)

### Probe 7 — Telegram wrapper contract
| Claim | Reality | Resolution |
|---|---|---|
| alert via `send_telegram.sh` wrapper OR `telegram.ts` | venue alerts use `sendVenueStatusChange()` (`src/lib/telegram.ts:84`) → direct Telegram Bot API (`api.telegram.org/bot${BOT_TOKEN}`). This is the **MCP app's own** alert path — distinct from the host-side `/opt/algovault-monitoring/send_telegram.sh` (monitoring-autopilot subsystem). | ✅ A1 suppresses by making `decide()` return `no_op` → loop never reaches `sendVenueStatusChange`. **Zero edits to `telegram.ts`; no inline gating re-implementation** — honors the monitoring-runbook "don't re-implement gates" contract. |

### Probe 8 — Cron safe-window
- Host `date -u` = 2026-06-01 07:15 UTC. `evaluate-venues.timer`: LAST fired Mon 2026-06-01 06:00:04 (the run that produced the ASTER/EDGEX alerts), NEXT Tue 2026-06-02 06:00 UTC (**~22h away**). ✅ **No ≤30-min pre-fire collision**. Huge window to deploy code + apply heal before next run. Even if deploy slipped, the A3 heal alone makes the next run safe (ext=0 + A1 gate).

---

## HALT triage

| # | Primitive | Class | Outcome |
|---|---|---|---|
| 1 | `exchange` → `exchange_id` | pre-flagged parameterization ("adapt to probe 5") | inline-resolved |
| 2 | `last_eval_n` → `last_eval_buy_sell_count` | pre-flagged | inline-resolved |
| 3 | `last_eval_wr` → `last_eval_pfe_wr` | pre-flagged | inline-resolved |
| 4 | `seedingStartedAt` → `seeding_started_at` (casing) | pre-flagged ("confirm field-casing") | inline-resolved |

**0 surprise fictionals. 0 structural mismatches. → NO HALT.** All deltas are column/field identifier resolutions the prompt explicitly deferred to probe-time. Proceed after Q-A…Q-D ratification.

---

## Architect ratification (Q-A … Q-D) — RESOLVED, awaiting confirm

- **Q-A — exact `venues` column identifiers:** table column `seeding_started_at TIMESTAMPTZ` (snake_case); `VenueRecord` field `seeding_started_at: string | null` (snake_case, matches convention); heal targets `exchange_id`, `extension_count`, `last_eval_buy_sell_count`, `last_eval_pfe_wr`.
- **Q-B — where `days_since` is computed (COALESCE placement):** `computeVenueStats()` in `evaluate-venues.ts` (~line 78), JS-level: `const effectiveStart = venue.seeding_started_at ?? venue.integrated_at;` then derive `integratedAt`/`integratedUnix` from `effectiveStart`. This single change propagates the COALESCE to BOTH the `daysSince` calc AND the sample/WR SQL window (`created_at > integratedUnix`). Since `seeding_started_at` is NULL for every venue today, behavior is **byte-identical → zero regression**. (COALESCE done in JS `??`, not SQL — matches the existing JS-computed-clock architecture.)
- **Q-C — live sample-count symbol for the A1 gate:** `buy_sell_count`. A1 = new **first branch** in pure-function `decide()`: `if (buy_sell_count === 0) return { action: 'no_op', reason: 'no_pipeline_yet', pfe_wr, buy_sell_count, days_since };` — placed before Branch 1. The loop already produces no side-effects for `no_op` → no `sendVenueStatusChange`, no `incrementExtension`. `recordEval` still runs (keeps `last_eval_*` fresh — desirable for the Deliverable-C report). Unit-testable in isolation.
- **Q-D — system-map row(s):** **NO existing `evaluate-venues`/`venue-store` edge row** in system-map.md (the venue-lifecycle subsystem currently lives only in prose "Last touched" logs from EXCHANGE-SHADOW-PROMOTE-W1). Per prompt "if no such edge row exists yet, add it" → **ADD** a venue-lifecycle edge note to the `crypto-quant-signal-mcp` component card (schema: `venues.seeding_started_at` added; edge: `evaluate-venues → Telegram` narrowed with `no_pipeline_yet` suppression; edge: `evaluate-venues → venues` clock now `COALESCE(seeding_started_at, integrated_at)`), same commit. **system-map.md updated: Y.**

---

## Destructive-bash proposals (drafted, NOT executed — await approval)

**Migration (pre-applied via SSH BEFORE code push; `IF NOT EXISTS` idempotent):**
```bash
ssh -i ~/.ssh/algovault_deploy root@204.168.185.24 \
 'docker exec crypto-quant-signal-mcp-postgres-1 psql -U algovault -d signal_performance -c \
 "ALTER TABLE venues ADD COLUMN IF NOT EXISTS seeding_started_at TIMESTAMPTZ;"'
```
Also add `seeding_started_at TIMESTAMPTZ` to the `CREATE TABLE venues` DDL inside `initVenuesTable()` (venue-store.ts ~line 30-40) so fresh bootstraps (tests / new deploys) include it (schema-as-code parity). Committed as `migrations/2026-06-01-seeding-started-at.sql`.

**A3 heal (pre-applied via SSH AFTER code deploy; idempotent via `AND extension_count = 1`):**
```sql
UPDATE venues
SET extension_count = 0,
    last_eval_buy_sell_count = 0,
    last_eval_pfe_wr = NULL
WHERE exchange_id IN ('ASTER','EDGEX') AND extension_count = 1;
```

**Rollback (verbatim in status.md):**
```sql
-- rollback A3 (restore the pre-heal burned extension)
UPDATE venues SET extension_count = 1 WHERE exchange_id IN ('ASTER','EDGEX');
-- rollback A2 (column is nullable + harmless; drop only if required)
ALTER TABLE venues DROP COLUMN IF EXISTS seeding_started_at;
```

---

## Identifier diff (R-section vs AC-section vs SQL vs code vs status.md)

| Identifier | Spelling (canonical) | Sites |
|---|---|---|
| new column | `seeding_started_at` | migration SQL, `initVenuesTable` DDL, `VenueRecord`, `rowToRecord`, `computeVenueStats` (`??`), tests, status.md, commit msg |
| no_op reason | `no_pipeline_yet` | `decide()` return, unit test, status.md |
| sample symbol | `buy_sell_count` / `buySellCount` | `decide()` gate, `EvalStats` |
| heal id column | `exchange_id` | heal UPDATE, rollback |
| heal eval cols | `last_eval_buy_sell_count`, `last_eval_pfe_wr` | heal UPDATE |

All consistent. No drift.

---

## Edit plan (after ratification — single sequential session)

1. **Migration via SSH** — `ADD COLUMN IF NOT EXISTS seeding_started_at` (pre-applied to prod) + add to `initVenuesTable` CREATE DDL + commit `migrations/2026-06-01-seeding-started-at.sql`.
2. **types.ts** — add `seeding_started_at: string | null;` to `VenueRecord`.
3. **venue-store.ts** — add `seeding_started_at` mapping to `rowToRecord` (nullable-timestamp pattern, mirrors `promoted_at`); add column to `initVenuesTable` CREATE DDL.
4. **evaluate-venues.ts** — (A1) first branch in `decide()`: `buy_sell_count === 0 → no_op:no_pipeline_yet`; (A2) `computeVenueStats`: `effectiveStart = venue.seeding_started_at ?? venue.integrated_at`.
5. **tests/unit/evaluate-venues.test.ts** (extend) — (a) `no_pipeline_yet` branch: `buy_sell_count===0 ⇒ no_op`, no alert, no increment; (b) clock: `seeding_started_at` set ⇒ days_since from it; NULL ⇒ falls back to `integrated_at`.
6. **Build + test** — `rm -rf dist && npm run build`; `npx vitest run tests/unit/evaluate-venues`.
7. **Per-file `git add` + `git diff --cached` audit → conventional commit → `git push main`** (auto-deploy).
8. **A3 heal via SSH** (post-deploy).
9. **Verify AC 2/3/4 live** (column present; ext=0 for ASTER/EDGEX; dry-run → 0 starved-venue alerts).
10. **status.md prepend** (verdict, SHA, GHA run, files table, `system-map.md updated: Y`, rollback block) + `scp` to monitoring host (fail-open) + **system-map.md edge add same commit**.

**Verification gate token:** `OPS_SHADOW_ALERT_HYGIENE_W1_GREEN`.

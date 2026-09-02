# OPS-BITMART-ENUM-RECONCILE-W1 — CH1 delta verification (READ-ONLY)

Probed **2026-09-02/03**. Worktree `bitmart-enum-reconcile-w1` @ **`e85eec46`** == `origin/main` — **the identical SHA the backward-dep audit probed**, so F1–F9 are re-confirmations, not re-derivations. Backward dep: `audits/OPS-VENUE-SET-RECONCILE-W1-endpoint-truth.md`. No `raw.githubusercontent` read. Method: 7 delta probes fanned out, each adversarially re-verified (1 of 7 refuted-with-corrections, folded in below); tsc cascade run directly.

**VERDICT: 🟡 CH1_GREEN as a probe — 0 of 9 anchor mismatches (HALT not met). But the wave's two stated guard-handling steps are BOTH unnecessary, and its chip scope is 1 site short of 4.**

---

## D1 — F1–F9 anchors · **0 of 9 mismatches** (HALT threshold is 3; not met)

Every anchor re-grepped by unique substring. Three corrections, none a mismatch:

| F | Spec cites | Resolved |
|---|---|---|
| F3 | `venue-store.ts:278-281` | **`:277-280`** (declaration at `:277`) |
| F5 | `venue-store.ts:286-296` | **`:287-295`** (`throw`+message `:290-293`, attribution `:285`) |
| F8 | `index.ts:5362` (one unguarded site) | **INCOMPLETE — see D5: there are FOUR render sites** |

**Non-decrease baseline is already stale** — the audit's `totalCalls=552970 / asset_count=1872` (2026-09-02) now reads **553524 / 1878** (2026-09-03). CH3 must re-read it live at execution time, not cite the audit.

## D2 — the BITMART removal surface · **13 class-(a) hits across 8 files; only 4 are tsc-forced**

**tsc cascade (run directly, mutate→capture→revert, tree verified clean) — exactly 3 files:**
`exchange-universe.ts:656` (FETCHERS) · `venue-brand-colors.ts:47` (colours) · `venue-budget-registry.ts:407` (budgets). Plus the generator row itself, `capabilities.ts:66`.

**⚠️ The other 9 class-(a) hits are tsc-BLIND and caught ONLY by tests** — a wave leaning on `tsc --noEmit` as its gate ships broken: `index.ts:5147/:5148/:5149` (`LB_EX_LABEL`/`COLOR`/`ORDER`, untyped client-script literals) and the docs.html generated rows.

**Spec expectations CORRECTED:**
- **OI-snapshot sampler: ZERO BitMart literals** (grep exit 1); it derives its venue set at runtime via `getActivePromotedVenueIds()`. The "the retire wave missed it" premise is **VOID for this wave** — settled with evidence.
- **`tf-support`'s `servedIntervalMs` Record is `Record<ExchangeId, …>` (the WIDE 17-union)** — its BITMART entry is class-(b) HISTORICAL and **must be KEPT**; removing it is a **tsc error**, not a requirement. (The spec's CH2#3 lists it as expected cascade — wrong.)
- **`SCAN_EXCHANGES` / the Zod enum / the x402 bazaar enum need NO edit** — they *project* from `PROMOTED_VENUE_IDS` and auto-narrow.
- `venue-brand-colors.ts:47` **is** in the cascade and the spec's CH2#3 list omits it.
- The backward audit's "322 hits / 47 files" covered a **wider corpus** (`audits/` alone holds 132). This corpus yields **206 hits / 57 files**.
- **Four class-(a) sites carry NO BitMart literal** and are invisible to grep — they fail on 15→14 anyway: `tests/public-venue-scope.test.ts:40` (`toHaveLength(15)`) and siblings.

**2 AMBIGUOUS (architect input needed):**
1. `venue-budget-registry.ts:407` — deleting the required `BITMART:` row **orphans its 180/min cross-process weight ledger** (`getVenueBudget:426-429` then falls through to `SHADOW_VENUE_BUDGETS`).
2. `asset-tiers.ts:229` `SHADOW_VENUES` — `ReadonlyArray<ExchangeId>` (wide, tsc-blind), gates `isMemeCoinLiquid` permissive-`true` at `:261`. It is the **stale complement** of the promoted set, not a projection of it.

## D3 — bake surfaces · **FOUR generators, not three; FOUR hand-edits**

- **`scripts/generate_jsonld.mjs` owns 11 "Exchange count" JSON-LD PropertyValue sites** the spec never named (index:94, verify:70, how-it-works:109, skills:111, docs:93, faq:185, glossary:162, integrations:171, privacy:47, terms:47, tools:70; template `landing/_jsonld/product.json.template:19`). **7 of the 11 have NO second owner** — `snapshot-landing-manifest.json`'s `jsonld-exchange-count` claim (`:408-421`) targets only index/verify/how-it-works/skills.
- **The 50 `data-tr-field` spans across 33 files need NO re-bake** — live-bound (`landing/js/track-record-proxy.js:107-114,:147`; all 33 files load it; claim coverage symmetric-difference EMPTY both ways).
- **`snapshot_capabilities.mjs` sweeps only 4 HTML-like targets** (`:224-229`: README.md, landing/index.html, llms.txt, llms-full.txt) — any plan assuming it sweeps the landing tree is wrong by 40+ files. Its `rewriteCountersInString` (`:99-119`) has **no "venues" regex** at all.
- **⚠️ `prepublishOnly` (package.json:79) runs `snapshot_capabilities.mjs --live` — WRITE mode** (`fs.writeFileSync` `:287`/`:302`). Post-15→14 it will **silently rewrite** README/index/llms at publish, and `publish-npm.yml` checks out the **TAG TREE** ⇒ an npm artifact baked to 14 against a repo tree at 15 — the exact silent divergence CLAUDE.md's release-tag LAW names. **The gate that actually goes RED is `tests/unit/snapshot-capabilities.test.mjs:183`.** ⇒ run `npm run snapshot:capabilities` in the **same commit** as the enum change.
- **Genuinely unowned — FOUR hand-edits:** `landing/glossary.html:445` · `landing/faq.html:469` · `landing/llms-full.txt:378` (a **DARK** `# SNAPSHOT-LINE` marker whose regex cannot match "venues") · **`docs/integrations/exchange-kits/binance-agent-os.md:66`** ("across 15 exchanges" — public repo, live public copy). **`CHANGELOG.md:86` LEFT ALONE** (immutable release history).
- `docs-src/partials/faq.html:49` is **not** an unowned 15 — it reads `>5<` and is live-bound; its stale "5" already stamped into `landing/docs.html:2545` is a **pre-existing orthogonal** defect ⇒ separate follow-up.

## D4 — the two guards · **BOTH stated handling steps are UNNECESSARY**

**(a) The DECREASE abort is ORPHANED — it is not a gate.** `scripts/refresh-integrations-numbers.mjs` has **ZERO automated callers** (absent from `package.json` scripts, `.github/**`, `ops/**`, host crontab). It cannot gate commit, push, CI or deploy.
- `--dry-run` **and** `--check` **both abort, exit 1** (`assertMonotonic()` at `:184` runs *inside* the file loop, **before** the write guard at `:204`) — so "just dry-run past it" is measured FALSE.
- **No override needs to be built.** MEASURED: flipping the enum to 14 **and** pre-editing the 14 committed `landing/integrations/*.html` `exchange_count` span literals in the same tree makes `--dry-run` **exit 0**.
- It cannot even load in a fresh worktree (`require`s `dist/lib/capabilities.js` at `:46`) ⇒ any run must build first.
- It returns **exit 1 for BOTH** routine `--check` drift and the DATA-INTEGRITY ABORT — one code, two meanings (a verdict-token defect).

**(b) `HOMEPAGE_VENUE_COUNT_EXACT` needs NO manifest edit.** The row is **fully relational and self-tracking** — it stores no expected value; FLOOR compares scraped `page_value` against live `sot_value` (`website-drift-canary.py:478`). **(c)** `TRACKRECORD_…`'s container-served immunity **re-confirmed** (renders the same `EXCHANGE_COUNT` its SoT reads ⇒ page==SoT always).

**⚠️ Real skew window the spec does not name:** `deploy-direct.sh` bakes landing at `:72`/`:77` **before** flipping the container at `:112`, so the homepage claims 15 against a 14 SoT from deploy time until the **00:39 UTC** re-bake.

## D5 — the chip · **FOUR render sites, and the live chip is not the one the spec names**

| Site | Source | Guarded? | tsc-visible? |
|---|---|---|---|
| `index.ts:4835` | `EXCHANGES` (SSR) | ❌ **NO** | ✅ yes |
| `index.ts:5163` | `LB_EX_ORDER` (leaderboard) | ✅ `if(!e)return` | ❌ |
| `index.ts:5347` | `LB_EX_ORDER` (**exchange FILTER TABS**) | ❌ **NO** | ❌ |
| `index.ts:5362` | `LB_EX_ORDER` (client chip re-render) | ❌ **NO** | ❌ |

**The live BitMart chip on first paint comes from `:4835` (SSR), NOT `:5362`** — measured on the served page (line 368, `color:#00F8F8">BitMart`). **A guard at `:5362` alone would not remove it.** The page also ships a selectable **BitMart filter TAB** (`:5347`) resolving to an empty bucket.

**CORRECTION to the backward audit:** `LB_EX_ORDER` is **not** silently drifting — it is **exactly pinned** to `PROMOTED_VENUE_IDS` by `tests/unit/capabilities.test.ts:94-95`, and `LB_EX_COLOR` is exact-gated too. **`LB_EX_LABEL` (`:5147`) is the ONE un-gated literal** (`toContain`, no extras check) — a leftover `BITMART: 'BitMart'` would ship **GREEN as dead data**.

**RECOMMENDATION (Option B):** the one-commit enum removal at `capabilities.ts:66` **IS** the generator-level fix — it reaches all four sites via `EXCHANGES → PROMOTED_VENUE_IDS → LB_EX_ORDER`, gated by tsc + `capabilities.test`. The test must assert **projection parity** (rendered chips === `LB_EX_ORDER` === `PROMOTED_VENUE_IDS`), **not** "chips ⊆ byExchange" (which would still be RED after an Option-B fix).

## D6 — digest anchors · confirmed, with 2 corrections + 1 new blocker-class finding

`:132` sendDigest · `:55` WR<80% · `:50` no-pipeline · `:117` equity leg — **all safe to cite**.
- **"six sections" restated:** buildReport assembles **FIVE** (`:70` header, `:79/:81` READY-TO-LAUNCH, `:84` Promoted, `:85` Shadow, `:86` Retired-conditional); the **sixth (equity) is appended in `main()` at `:117`**.
- **R1 does NOT categorically require the result bound.** It hard-fails only a bare statement-level `await sendDigest(...)` followed within 5 lines by a success-claiming `console.log`. The self-test fixture at `check-delivery-assertion.mjs:224` is a **self-contained string** — restructuring `:132` would **not** break it. **Drop `:126`** from the must-not-touch set (it is `console.log(text);`, not R1/R3-relevant).
- Real constraint: keep `label:` inside the bracket-matched `sendDigest` args, keep the call closeable within 14 lines, don't convert `:132` to a bare statement while `:133`'s success log stands.
- Cron is **crontab LINE 168**.
- **⚠️ The 06:05 cron has ZERO liveness coverage** — 0 rows in `monitoring-inventory.json`, 0 in `alert-registry.json`, no host watcher. Its only liveness signal today **is the daily TG itself**, so suppression would make a dead cron indistinguishable from a silent one. (The spec's CH5#4 anticipates exactly this: "if CH1#7 finds the cron has no liveness coverage, add it to the monitoring inventory — not to Telegram.")
- Equity leg is **provably dark in prod**: `EQUITY_TOOLS_ENABLED` unset in the container AND absent from the host `.env`; default false at `equity-tools-flag.ts:33-35`.

## D7 — PG-lane gate · every primitive exists; **do not invent a convention**

- **Archetype to mirror: `ops/monitoring/scorer-input-identity-canary.py`** — one terminal `<NAME>_VERDICT=PASS|FAIL|INDETERMINATE`, **exit 3 == INDETERMINATE**, hermetic `--self-test`, `docker exec <pg-ctr> psql -U aoe_readonly -d signal_performance -qtA` via **argv list**, fires `send_telegram.sh` itself with `CRITICAL_PERSISTENT`.
- **Compare the RAW static `PROMOTED_VENUE_IDS` (`capabilities.ts:93`) to `SELECT exchange_id FROM venues WHERE status='promoted'`.** **Do NOT use `getActivePromotedVenueIds()`** — it is static-minus-retired and would mask exactly the drift the gate exists to catch.
- Container read: borrow `quota-exhaustion-canary.py:323-380` (`docker exec … node -e require("/app/dist/lib/capabilities.js")`, `None → INDETERMINATE`). Use `psql -qtA` — **`-q` matters** (without it the command tag pollutes the parse).
- Role: **`aoe_readonly`** (live-verified to SELECT `venues`). Do NOT copy `algovault_autopilot`.
- **`alert-registry.json` row is NOT optional/deferrable** — `tests/unit/alert-registry.test.mjs:39` runs the checker over the real tree and asserts PASS, so a new `ALERT_ID` without a row goes RED.
- **`monitoring-inventory.json` sha256 must be stamped BEFORE host install** — `ops/scripts/install-monitoring-artifact.sh` REFUSES on mismatch by design.
- **Sibling inconsistency to resolve:** exit 3 == INDETERMINATE is invariant across all four sibling gates, but **FAIL is 1** in `scorer-input-identity-canary.py:378` and **0** in `decision-gate-orphan-canary.py:536` / `outcome-backfill-freshness.py:479`.

## Governance — already ruled, recorded here so it is not re-litigated

Multiple probes independently flagged that `capabilities.ts:88` names **`OPS-BITMART-ENUM-REMOVE-W1`** while this wave is **`OPS-BITMART-ENUM-RECONCILE-W1`**. **This is resolved by the spec header + the architect's 2026-09-02 Q1 ruling: this wave SUBSUMES that wave**, and CH2#2 rewrites the `:80-88` comment to record it. No further ruling needed.

## CH1 Verification Gate

`audits/OPS-BITMART-ENUM-RECONCILE-W1-endpoint-truth.md` present · zero tracked files mutated (tsc cascade reverted; `git diff --quiet` clean) · **CH1_GREEN**; proceeding to CH2 requires architect ratification of the Q-set.

---

## ADDENDUM — completeness critic: 11 missed items, 4 hard blockers

### 🛑 M2 — the PRE-PUSH DEADLOCK (this is the one that changes the plan)

`tests/unit/api-performance-public.test.ts:58` asserts **`live <= EXCHANGE_COUNT`**, on a comment (`:53-56`) stating *"promotion only ever GROWS the count."* **That law is now false in the decreasing direction.**

- The moment the enum flips to 14 while prod still serves 15, this test is **RED in the pre-push gate**.
- **Only a push can make prod serve 14.** So *"flip now, bake/deploy later"* is **IMPOSSIBLE, not merely untidy** — it is a chicken-and-egg deadlock.
- **Blast radius:** while `main`=14 and prod=15, this test fails for **every parallel session's pre-push gate, estate-wide**. A failed deploy after the code lands blocks everyone. **Budget a rollback path for a failed deploy, not just for the deploy.**

⇒ **The rewrite of `:58` must land in the SAME commit as the flip.** Architect must pick the shape (see Q13).

### Same-commit edit set is LARGER than D2's 13 class-(a) hits — ordered

1. **`tsc` FIRST** — `build_docs`, `build_landing`, `snapshot_capabilities` and `refresh-integrations` all `require` `dist/`.
2. `capabilities.ts:66` + the 3 tsc-cascade files + the 3 `LB_EX_*` literals (`index.ts:5147/:5148/:5149`).
3. **Fix EVERY test pinning the old world — D2's three PLUS three it missed:** `venue-brand-colors.test.ts:43` (APPROVED palette) · **`p1_track_record_leaderboard.test.mjs:44`** (`>=15`, **node:test-only, vitest-EXCLUDED**) · **`api-performance-public.test.ts:58`** (the M2 deadlock).
4. **Hand-edit `scripts/render-jsx-static.mjs:794/:830/:851/:1984`** — no generator owns them, and unlike the other unowned literals these are **enforced RED** by `tests/unit/numerical-claim-live-bind.test.ts:99-105`. ⇒ **the unowned hand-edit set is FIVE sites, not four.**
5. **Regenerate, never hand-edit:** `node scripts/build_docs.mjs` (**`.github/workflows/deploy.yml:248` runs `build_docs --check` and compares BYTES**; `docs-src/` contains zero bitmart) **and** `npm run snapshot:capabilities`.
6. Then D3's four unowned literals + the 14 `landing/integrations/*.html` spans.

### ⚠️ Verification correction

**`npm test` (vitest) is NOT sufficient for this wave** — `p1_track_record_leaderboard.test.mjs` is **node:test-owned and vitest-excluded**. Verification must run **`scripts/check_test_baseline.sh`** (vitest **+** `node --test`).

### DO NOT TOUCH (historical; two are asserted BY their own self-tests)

`tf-support.ts:47` · `ops/monitoring/trend-mode-readout-gate.py:80` · `ops/monitoring/test-directional-label-freshness.py:238-239` · `adapter-numeric-guard-baseline.json:11` · `CHANGELOG.md:86`.

### Closed negative (recorded so a later chapter does not re-open it)

**External catalog listings need NO re-bake** — `ops/published-surface-registry.json` forbids a venue count on all three off-repo surfaces by standing Mr.1 policy (2026-07-17). *Caveat: no scheduled runner found for `scripts/check-external-surface-parity.mjs` outside the host crontab, which was not read.*

### Post-deploy proof set — surfaces nobody listed

`src/lib/chat-track-record.ts` (the *"Signal venues: &lt;labels&gt;"* block — BitMart must vanish from the NAME list) · `src/index.ts:4839` · `src/lib/signup-flow.ts:198/:209` via `/signup` and the referral pages.

### Stale law to correct in the same commit

`src/lib/chat-track-record.ts:42-49` describes `STATIC_FALLBACK` as a *"Monotonic-grow FLOOR"* and carries an **expired `TODO: revisit by 2026-08-02`**. `exchangeCount` is live-derived, so that framing is **false in the decreasing direction** — fix the comment or the next reader re-derives a wrong law.

### M10 — `BITMART_REQ_CEILING` (`venue-budget-registry.ts:358`)

Referenced **only** by the budget row being deleted. Delete with the row, or keep the 180/min block as a commented historical record? (Points the opposite way from D2's AMBIGUOUS-1 about orphaning the ledger.)

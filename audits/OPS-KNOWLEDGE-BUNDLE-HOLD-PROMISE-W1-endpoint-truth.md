# OPS-KNOWLEDGE-BUNDLE-HOLD-PROMISE-W1 — endpoint truth

**Probed 2026-08-21 against `origin/main` (`211349d`) and live `api.algovault.com`.**
Primary checkout was 29 commits behind `origin/main`; every source probe below uses
`git show origin/main:<path>`, never the working tree (`OPS-SCAN-SHOWCASE-ENRICH-W1` rule).

## Truth table — claim / reality / resolution

| # | Claim (spec) | Reality (measured) | Resolution |
|---|---|---|---|
| P1 | live `tools/list` = 7, `get_equity_call` absent | **CONFIRMED.** `chat_knowledge · get_market_regime · get_trade_call · get_trade_signal · scan_funding_arb · scan_trade_calls · search_knowledge` | proceed |
| P2 | "3 LIVE tool descriptions … all say *for US stocks use `get_equity_call`*" | **PARTIALLY FALSE.** 3 live descriptions do dangle, but from **2** source constants and **2 different** dangling names: `TRADE_CALL_DESCRIPTION` (`src/tool-descriptions.ts:34`, reaching both `get_trade_call` and `get_trade_signal` via `TRADE_CALL_ALIAS_SUFFIX`) → `get_equity_call`; `GET_MARKET_REGIME_DESCRIPTION` (`:45`) → **`get_equity_regime`** | fix **2** constants, not 3; both names |
| P3 | R0b — retired or never shipped? | **RETIRED.** `EQUITY-TOOLS-DARK-RETIRE-W1`, 2026-07-16, `f00b1f5`. Dark behind `EQUITY_TOOLS_ENABLED` (default OFF). Engine, DB tables, npm artifact all intact; re-enable is a flag flip (`docs/RUNBOOK-EQUITY-TOOLS-REENABLE.md`). `GET_EQUITY_CALL_DESCRIPTION` / `GET_EQUITY_REGIME_DESCRIPTION` still exported at `:67`/`:69` | wording must not say "never existed"; that wave put equity public-copy on HOLD, so **silent removal of the referral clause** is the only wording consistent with it |
| P4 | R0c — enumerate every cross-reference | 7/7 tools enumerated from the live payload. All resolve **except** the two equity names. `scan_funding_arb→{get_market_regime,get_trade_call}` OK · `scan_trade_calls→get_trade_call` OK · `chat_knowledge↔search_knowledge` OK | class is closed at 2 |
| P5 | R2 — `lobehub-manifest.json` LOCKSTEP sync | **NO-OP for this defect.** 7 `api[]` entries, **zero** dangling refs; lobehub was already clean. `version` lineage `"26"` | R2 becomes audit-and-record, not an edit |
| P6 | D2 — bundle promises free HOLDs ×4 | **CONFIRMED.** Source files: `audits/x402-http-{get_market_regime,get_trade_call,get_trade_signal,scan_funding_arb}-shape-snapshot-*.json` | real defect |
| P7 | R0c(CH2) — HOLD chargeable on both rails today | **PROVEN in code.** `src/lib/call-class.ts:97` — *"Post cutover no HOLD is unbilled on any rail"*; `FLAT_BILLING_CUTOVER_ISO = 2026-08-08`. `src/lib/x402-http-routes.ts:22` — *"EVERY verdict settles, HOLD included"*, and `:25-26` records that this module's own header carried the false line **until 2026-08-09** | D2 is a **missed lane of an already-shipped fix**, not a new discovery |
| P8 | D3 — shapes for nonexistent tools | **CONFIRMED.** `audits/get_equity_call-shape-snapshot-2026-06-04.json`, `audits/get_equity_regime-shape-snapshot-2026-06-04.json`, and `audits/trade-call-routing-shape-snapshot-2026-06-09.json` whose `allowed_keys` are tool names `["get_equity_call","get_trade_call"]` | real |
| P9 | D4 — `/api/performance-shadow` "returns 404 … a fictional endpoint published as real" | **FALSE.** `api.algovault.com/api/performance-shadow` → **401**. Real route at `src/index.ts:2822`, API-key gated (SV-01, `OPS-AUDIT-REMEDIATION-MED-W1`, Mr.1-confirmed). Only `algovault.com` (landing host, no `/api` routes) → 404. Its snapshot is **accurate**: documents the 401 contract verbatim and states *"NO public/landing consumer (Step-0 census: 0)"* | **SECOND FALSE ALARM.** Deleting it removes a truthful public contract = Data-Integrity reduction |
| P10 | builder ingests `audits/*-shape-snapshot-*.json` | **CONFIRMED.** `scripts/build-knowledge-json.mjs:184-193` (selector `/-shape-snapshot-.*\.json$/`) + `:285-315` (projection, superseded filtered). Arithmetic checks: **53 files on disk − 14 superseded = 39 = live `response_shapes`** | R0a premise sound |
| P11 | 9th probe — does something already do this? | **YES, THREE.** (a) `scripts/check-shape-snapshot-integrity.mjs` — deterministic gate over *exactly this corpus*, wired **fail-close** at `deploy.yml:548-549` with `--self-test` first; validates key names / types / filenames / PII field names but **not reachability**. (b) `tests/unit/no-free-hold-promise.test.ts` — allowlist gate that **already guards 3 `audits/` shape snapshots** with the reason *"BUILD INPUTS, not artefacts … projected into the PUBLIC knowledge bundle"*; the 4 x402 files are simply not on its list. (c) `scripts/check-hold-billing-claims.mjs` — deny-by-default but scoped to `src/**`+`scripts/**`, so `audits/` is out of scope by construction. Also `scripts/check-canaries-wired.mjs` **requires** any new `scripts/check-*` to be wired or allowlisted | **extend the incumbents; do not ship a second copy** |
| P12 | `scripts/check-kb-reachability.mjs` name collision | none — absent from `origin/main` | free to use if a new file is still wanted |
| P13 | R0a — *"any option that edits an audit snapshot in place is rejected by construction"* | **CONTRADICTED BY SHIPPED PRECEDENT.** `b7ff069` (`PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1` CH7) edited **3 `audits/` shape snapshots in place for this exact defect class**; `cbdb748` edited one again. **And a 4th option exists and is ratified: SUPERSESSION** — adding `superseded_by` + `superseded_reason` drops a snapshot from the bundle while *"nothing inside the file was altered"*; **14 live precedents**, honoured by the builder, `check-shape-snapshot-integrity.mjs:73-76` and `knowledge-bundle.test.ts:118` | architect ruling required |
| P14 | CH2 AC — *"`audits/**` byte-identical to `origin/main` (`git diff --stat audits/` empty)"* | **UNSATISFIABLE alongside R1.** Supersession adds 2 keys → non-empty. In-place correction → non-empty. New dated superseding snapshots → non-empty. Only R0a option (a) *stop ingesting* leaves it empty — and that deletes all 39 published contracts | architect ruling required |
| P15 | CH3 R3 placement precedent | **CONFIRMED.** `OPS-JSONLD-DEPLOY-GATE-W1`: a live-fetching `--check` structurally cannot be a fail-close deploy gate. `ops/cron/xrepo-ci-conclusion-canary.sh` **exists** as the INDETERMINATE-vs-unreachable precedent the spec cites | offline half fail-close, live half scheduled canary |
| P16 | the spec's own gate bash | `grep -c 'HOLDs free' "$KB"` reports **1**, not 4 — the bundle is **one line**. Same shape for `performance-shadow` (reports 1, 3 occurrences). `want 0` still functions, but the printed number is lines, not occurrences | count with `python3`, per Build Rule 5 |
| P17 | Map Anchor | `system-map.md:200` — `↓ 4 MCP tools (get_trade_call / scan_funding_arb / get_market_regime / scan_trade_calls)` — **STALE; live surface is 7**. `:201` carries `/knowledge/*.json`. **No** row names `src/tool-descriptions.ts`, `lobehub-manifest.json`, `release-knowledge.yml` or `build-knowledge-json.mjs` | **Y** — edit `:200` (+`:201` if the bundle edge changes), overwrite `Last touched:` at `:3` in place |

## Fictional-primitive count

**Zero fabricated primitives** (`check-kb-reachability.mjs` is declared as proposed, and does not collide).
**Four falsified / unsatisfiable spec premises**: D4's 404 (P9), the 3-descriptions/one-name framing (P2),
the audits-edit prohibition (P13), the audits-byte-identical AC (P14). Under
*"a falsified absence is as HALT-worthy as a fictional primitive"*, these HALT.

---

## Architect rulings — 2026-08-21 (these override the dispatch spec)

| Q | Ruling | Consequence |
|---|---|---|
| **Q1 — R0a ingestion policy** | **(d) SUPERSESSION** — supersede stale snapshots + write NEW dated ones. Not a new proposal: `build-knowledge-json.mjs:285-315` already filters on `superseded_by`, `check-shape-snapshot-integrity.mjs:73-76` already enforces it, `knowledge-bundle.test.ts:118` is already written in its terms. (a)/(b)/(c) would each build a SECOND mechanism beside a working one — the second copy nobody watches. | **+ MANDATORY ADDITION (a live hazard in the current builder):** the filter tests only `typeof superseded_by === 'string' && length > 0` and **never checks the target exists**. A typo'd or dangling `superseded_by` therefore DROPS the shape from the bundle with nothing replacing it, and `:118` still passes because a superseded file is not required to be covered. **That is silent shape loss.** Assert every `superseded_by` resolves to a file on disk, in `check-shape-snapshot-integrity.mjs` (not a new script), proven to fail on a dangling pointer. |
| **Q2 — D4** | **(i) KEEP.** The route is real and API-key-gated; **401 is its documented contract, not an absence**, and the snapshot states truthfully that it has no public/landing consumer. Removing a true contract to satisfy a check derived from the wrong hostname would be the wave making itself less accurate. Not escalating to (ii): naming an auth-gated route and its field in API documentation is ordinary practice, and `current_pfe_wr` is PFE WR — the **aggregated-public** class, not the outcome-WR internal-forever class. | **D4 WITHDRAWN — the wave has THREE defects (D1, D2, D3), not four.** Recorded as the wave's **second false alarm**. A "no auth-gated routes in the public bundle" policy, if ever wanted, is `OPS-BUNDLE-AUTHGATED-ROUTE-POLICY-W{NEXT}` — not an inline ruling here. |
| **Q3 — R0b `okx.ai` / `a2mcp`** | **PENDING-MR1. Code does not decide.** | Blocks **only** CH2 R1's `consumers` edit. CH1, CH3 and the rest of CH2 proceed. Any new dated snapshot carries the existing `consumers` string **forward verbatim** — preservation, not a decision. |
| **Q4 — CH2 audits AC** | **YES, ratified verbatim.** The dispatch's `git diff --stat audits/` empty was unsatisfiable alongside R1 under every option except (a) — a defect in the spec, not a constraint to work around. | Predicate: *no PRE-EXISTING key in any `audits/*.json` is modified or removed; the only permitted mutations are (i) adding `superseded_by` + `superseded_reason` to an existing file and (ii) adding NEW dated snapshot files; AND every `superseded_by` resolves to a file on disk.* |

### Spec corrections carried forward

- **D4** *"`/api/performance-shadow` … returns 404 … a fictional endpoint published as real"* → **WRONG HOST.** `api.algovault.com` → **401**; `algovault.com` → 404. **WITHDRAWN.** Its CH2 R1 remediation bullet, its AC line and its gate line `shadow=$(grep -c 'performance-shadow' "$KB")` "want 0" are **DELETED** — as written that gate would now fail on correctly-retained truthful content.
- *"`audits/**` are HISTORICAL … any option that edits an audit snapshot in place is rejected by construction"* → **WRONG, sentence STRUCK.** `tests/unit/no-free-hold-promise.test.ts:60-66` classifies them as **BUILD INPUTS**, and `b7ff069` edited three in place for this same defect class.
- **CH2 R0a option list** → **INCOMPLETE**; (d) supersession is the in-repo ratified mechanism and is the ruling.

### Declared scope relaxation (fact-honest, per Plan-Mode rules)

CH1's firewall reads `Must NOT write: audits/**`, while the wave's Plan-Mode section mandates this
file at `audits/OPS-KNOWLEDGE-BUNDLE-HOLD-PROMISE-W1-endpoint-truth.md`. The firewall is read as
scoped to the **shape-snapshot corpus and existing audit content** — the thing CH1 must not
disturb. This `.md` is the one declared exception: it matches no builder selector
(`/-shape-snapshot-.*\.json$/`), so it cannot enter the bundle, and it adds no pre-existing-key
mutation. Logged here, in the commit body, and in `status.md` rather than taken silently.

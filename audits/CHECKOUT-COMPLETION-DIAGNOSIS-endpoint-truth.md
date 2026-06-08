# CHECKOUT-COMPLETION-DIAGNOSIS — Plan-Mode endpoint-truth (Step 0)

**Wave:** CHECKOUT-COMPLETION-DIAGNOSIS — read-only, zero production mutation.
**Run:** 2026-06-08 (box clock 04:26 UTC).
**Canonical clone:** `/Users/tank/code/crypto-quant-signal-mcp` @ `origin/main a6fc7a5` (== deployed; SOAK-MEASURE landed).
**Risk markers:** live Stripe read + cross-host psql read → Plan-Mode required.
**Outcome:** **0 fictional primitives; 2 inline-resolved drifts + 1 methodology finding (P3); no HALT → PROCEED.**

## Step-0 probes — `claim | reality | resolution`

| # | Claim (spec) | Reality (probe) | Resolution |
|---|---|---|---|
| **Path** | Context cites `/Users/tank/crypto-quant-signal-mcp/`. | Same stale clone as last wave (`65d14a0`). Canonical = `/Users/tank/code/crypto-quant-signal-mcp` (`a6fc7a5`). | Used canonical. **Flagged** (recurring spec drift). |
| **P1** | SOAK engine `scripts/measure-activation-soak.mjs` exists (extend, don't rebuild); absent = HALT. | **PRESENT** on `origin/main a6fc7a5` (shipped by SOAK-MEASURE). Arg surface: `--gte/--lte/--filter/--json`, paginated pull, schema-adaptive exclusion. | Extended in place with `--profile`/`--all-statuses`/`--subwindow-lte` (flag, not fork). No HALT. |
| **P2** | `OPERATOR_TEST_STRIPE_FILTER.json` exists + keys. | Confirmed; same 9 keys incl. `operator_metadata_markers` (utm_source[4]+utm_campaign[3]). | Reused schema-adaptive exclusion. |
| **P3** | `customer_details.email` populated on real **expired** in-window sessions → email-capture = mid-funnel proxy; if not exposed, fall back + note. | **NOT exposed.** 37/37 expired sessions have `customer_details=null` (confirmed via BOTH list AND `GET`-by-id retrieve on 3 samples); 1/1 paid has email. → On this hosted single-page Checkout, email populates **only on payment submission**. | **Methodology finding.** S1_ENGAGED_no_pay is structurally ~0 — an **artifact**, NOT proof visitors skipped the email field. Per P3, fall back: read mid-funnel intent from **quota-pressure + `upgrade_cta_clicked` + attribution**, never from email-capture. Noted in code + audit. |
| **P4** | `quota_usage`/`request_log` derive per-caller monthly counts. | `quota_usage(tracker_key TEXT pk, call_count INT, period_start TEXT)`; `tracker_key='free:<apikey>'`; `period_start` = rolling-window start (ISO ts), NOT calendar month. `request_log.timestamp` TEXT ISO-8601. `funnel_events(event_type, ts TIMESTAMPTZ, session_id, …)`. | Derivable. R5 = distinct `free:` keys with `call_count ≥ 75/90/100` for in-window `period_start`. R4 engaged-proxy = `funnel_events` `upgrade_cta_clicked`. |
| **P5** | Stripe auth 200; psql `select 1`. | Stripe HTTP **200**; psql **1**. | Proceed. |

## Drift B — `client_reference_id` is synthetic (no identity bridge)
`/signup` mints `client_reference_id = ${utmSource ?? 'direct'}:${Date.now()}:${random}` (index.ts:1149) — a fresh per-click id, NOT a product-user identity. The anonymous web checkout flow carries **no API-key / product identity** into the Stripe session. → R4's "join a start to a known engaged user" is **not possible by identity**; engaged-vs-cold is read from `upgrade_cta_clicked` (set only when `?upgrade_from=quota`, index.ts:1155) + `utm_source`. This is itself an instrumentation gap (note for a future FUNNEL-INSTRUMENTATION wave).

## Quota-pressure baseline (R5, read-only)
- `quota_usage`: 256 rows. **Lifetime** keys crossing 75/90/100 = **1/1/1** (one `free:1…` with `call_count=129` on **2026-05-11 — pre-window**).
- **In-window** (`period_start ≥ 2026-05-20`): max caller `call_count` = **56** → **0/0/0** crossing 75/90/100.
- `funnel_events`: only event_type ever = `first_tool_call_with_track_token` (3 rows). `upgrade_cta_clicked` = **0** all-time.

## system-map impact
**n-a** — read-only; the `--profile` flag lives in `scripts/` (runs host-side, NOT in the container build), audit docs, + vault logs. No edge/column/tool/route/response-shape mutated; no `src/` change → no rebuild/restart.

## Persistence
`AlgoVaultFi` flag: HTTPS push empirically WORKS (prior wave pushed); only GHA Actions are blocked (read-only wave → no deploy regardless; `scripts/` change does not rebuild because no push-triggered GHA runs). Per-file `git add` → local commit → push.

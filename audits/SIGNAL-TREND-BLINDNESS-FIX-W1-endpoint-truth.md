# SIGNAL-TREND-BLINDNESS-FIX-W1 — endpoint truth (CH4)

Read-only forensic chapter. **Structural / schema / code facts only — NO win-rate, edge, PFE, calibration or sample-count figures.** Those are INTERNAL and live in the private vault artifact `SIGNAL-TREND-BLINDNESS-FIX-W1-<date>.md`, following the precedent set by `CRYPTO-PFE-BENCHMARK-AUDIT-W1-endpoint-truth.md`.

**Hard boundary, and it is the operative rule:** the moment a file under this tracked `audits/` directory would mix engine-behaviour statistics with ANY performance, settlement or monetary figure, that file goes to the private vault instead. No mixed files. `audits/regime-separation-band-sweep-<date>.json` sits on the permitted side — it carries label-distribution statistics only.

---

## Primitives probed

| Probe | Result |
|---|---|
| Harness exists in the deployed image | ✅ `/app/dist/scripts/calibration-audit.js` + `/app/dist/scripts/edge-stats.js` |
| Harness is read-only | ✅ `grep -c writeFileSync` → **0**. It prints to stdout; it opens no file |
| CLI surface | `--asset`, `--edge`, `--timeframe` — exactly three flags |
| Second harness built? | ❌ **NO.** CH4 re-runs the existing one. `edge-stats.js` remains the stats SoT |
| DB reachability | `crypto-quant-signal-mcp-postgres-1`, database `signal_performance`, role `algovault` |
| Read-only roles present | `aoe_readonly`, `geo_gap_reader` (login, non-superuser) alongside the app roles |
| `signals.regime_rule_version` | ✅ present in production, `SMALLINT NOT NULL DEFAULT 1` |
| Rule-version partition | v1 populated · **v2 = 0 rows** ✅ · v3 = 0 (committed, not deployed) |
| `hold_counts` dimensionality | keyed `(date, timeframe, coin)` — **no** regime, exchange or confidence column |

## Assertions

- **v2 has zero production rows.** Falsifiable check that the prior-art branch's `REGIME_RULE_V2_CUTOVER_UTC` never leaked into production. It never did.
- **No writes.** No `UPDATE signals`, no DDL, no anchored row touched. The harness cannot write; the queries are `SELECT` only; the host temp files used to marshal output were removed.
- **CH3's behaviour change is NOT measured here.** `TREND_MODE` is default-OFF and undeployed, so this run is the BEFORE. Measuring the AFTER requires a deploy, a soak, and a partition on `regime_rule_version` — which is what that column exists for.

## Known limitations, declared rather than skipped

- **`signals.regime` is a selection-biased series.** Rows exist only when `!internal && signal !== 'HOLD' && confidence >= MIN_TRACKABLE_CONFIDENCE`. CH2 replaced the derivation but left that filter untouched, so the bias survives. Per-regime cells inherit it and must not be read as a regime time-series.
- **HOLD rate by regime is not satisfiable from stored data** — the regime computed for each HOLD is discarded in memory. Registered as `SIGNAL-HOLD-COUNTS-REGIME-DIM-W{NEXT}`. A producer-side fix is out of scope for a read-only chapter.
- **PFE is not a P&L.** A peak-favorable-excursion win rate records whether price touched favourably at any point in the window. The directional-accuracy figure is a different quantity and is reported separately in the private artifact. The two must never be conflated by a later reader.

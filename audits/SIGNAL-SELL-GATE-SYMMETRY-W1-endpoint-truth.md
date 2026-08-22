# SIGNAL-SELL-GATE-SYMMETRY-W1 — endpoint truth (CH1)

Read-only measurement chapter. **Structural facts, probe results and emission-count distributions only.** Every performance or outcome figure is INTERNAL and lives in the private vault artifact `SIGNAL-SELL-GATE-SYMMETRY-W1-<date>.md`; the excluded categories are enumerated there rather than here, so a scanner cannot mistake this disclaimer for the thing it disclaims. **No mixed files.**

**Verdict: `CH1_GREEN` · `SELL_GATE_VALIDATION_VERDICT=NO-VALIDATED-CELL` · `WAVE1_CH1_NO_VALIDATED_CELL`.** CH2 and CH3 are skipped per the spec. Nothing outside the harness was written.

---

## Step-0 probes — claim / reality / resolution

Probed against `origin/main = 86192f6` (= live prod, verified on host). The spec declares its anchor table **advisory**; every anchor below was re-derived.

| # | Claim | Reality | Resolution |
|---|---|---|---|
| P1 | `SELL_THRESHOLD_GATED` at `:162` | `:174` | drift, symbol exists |
| P2 | `absScore > g.sellThreshold` at `:265` | `:277` | drift |
| P3 | `getThresholdForTF` at `:743` | `:1018` (sell), `:1017` (buy) | drift +275 |
| P4 | **`verdictGates.sellThreshold` "LITERAL ABSENT" — chain may be wrong** | **Chain INTACT.** `getThresholdForTF(tf,'sell',SELL_THRESHOLD_GATED)` `:1018` → gates object `:1024` → `gatesFor()` `:1030` → `deriveVerdict(scores, g)` → **`g.sellThreshold` `:277`, strict `>`**. The literal never appears because the field is read through the parameter name `g`. | **CH3's premise HOLDS** |
| P5 | `recordSignal` at `:1051` | `:1326` | drift |
| P6 | `BUY_BASE_THRESHOLD` — do not assume | **`40`**, `src/tools/get-trade-call.ts:173` | confirmed, read not assumed |
| P7 | `edgeMetricReport()` supplies Wilson CI + BH-FDR + walk-forward | True and complete, `calibration-audit.ts:387`; **not orphaned** | reused unmodified |
| P8 | `scripts/backtest.ts` invalid as a base | 5 RSI rungs vs production's 7 | rejection upheld |
| P9 | 9th probe (3rd ask): does a pre-registered / blast-radius / threshold-sweep validator exist? | **No** — no pre-registration harness, no blast-radius reporter, no threshold-sweep module | CH1 is genuinely new work |

**0 fictional primitives.** Every symbol resolves; the ≥3-mismatch HALT does not fire, exactly as the spec's Build Rule 7 anticipated.

### Step 0.1 — the spec's blocking precondition is FALSIFIED (H5)

The spec HALTs CH1 if `DIRECTIONAL_LABEL_CAPACITY_SHORTFALL`'s `unreached_in_danger=BINANCE,BITGET,BYBIT` means those venues' labels are incomplete across the holdout. Measured coverage of `signals` by `directional_labels` at age 3–30 days:

| Venue | Coverage | | Venue | Coverage |
|---|---|---|---|---|
| **BINANCE** | **100.0%** | | XT | 99.0% |
| **BITGET** | **100.0%** | | GATE | 98.9% |
| **BYBIT** | **100.0%** | | MEXC | 98.3% |
| OKX | 100.0% | | PHEMEX | 97.4% |
| ASTER | 99.9% | | **HL** | **90.8%** |
| KUCOIN | 99.5% | | | |

The three named venues are the **best**-covered in the estate; the weakest is **HL**, which the alert does not name. The by-age gradient — 36.1% at age 0 → 74.8% at 1 → 92.2% at 2 → 96.8% at 3 → 98–99% after — is the signature of **legitimate forward-window lag**, not a labeler shortfall. `unreached_in_danger` describes **run ORDER inside a time budget**, not missing labels. Found healed at probe time ⇒ **H5**, the mandated default. **Not a HALT.**

⚠️ **Second, independent reason it does not gate this chapter:** the mandated instrument is the replay harness, which derives outcomes **from klines**, not from `directional_labels`. Label coverage is not an input to any number this chapter produced.

---

## The instrument

| | |
|---|---|
| Harness | `src/scripts/sell-gate-fetch.ts` (corpus) + `src/scripts/sell-gate-validation.ts` (sweep) |
| Scorer | imports the REAL `computeIndicatorScores` / `deriveVerdict`; statistics from the shipped `edgeMetricReport()`. **Nothing re-derived.** |
| Corpus source | the REAL `BinanceAdapter`, paged — **not** a raw API call |
| R1 fidelity vs `86192f6` | **92.08%** (8,172/8,875), tolerance ≥90% declared in advance; must-fail proof 1-bar shift → **37.27%** |
| Scorer equivalence `7b989a4..86192f6` | diff over `get-trade-call.ts`, `pertf-thresholds.ts`, `r4-relax-flag.ts`, `verdict-factors.ts`, `calibration-audit.ts` is **empty** — the 5 intervening commits are CI/reporter only |
| Pre-registration | frozen `2026-08-22T08:04:08Z`, amended `08:12:23Z`, **both before the first measurement** |

**Corpus after amendment:** 10 Binance perps × 10 timeframes, truncated to the funding-available window `2026-04-08 → 2026-08-22`. Two operational amendments were recorded before any result existed: the fetch tripped Binance **HTTP 429** (20 coins → the 10 most liquid that completed), and `funding_history` holds only **136 days** while the raw corpus reached back to 2,540 days — so series were truncated to keep **one instrument** across every cell rather than mixing funded and unfunded bars.

---

## What the sweep measured — emission counts only

The pre-registered grid: 10 timeframes × `{55, 54, 50, 45, 40, 35}` + `R4_RELAX_DIRECTION=sell-revert`, **70 declared cells, 62 powered** at `minN = 30`.

### The `(41, 55]` band is EMPTY on this instrument

| tf | SELLs @ 55 | @ 54 | @ 50 | @ 45 | @ 40 | @ 35 |
|---|---|---|---|---|---|---|
| 5m | 0 | 0 | 0 | 0 | 41 | 642 |
| 3m | 0 | 0 | 0 | 0 | 12 | 248 |
| 15m | 0 | 0 | 0 | 0 | 175 | 956 |
| 30m | 0 | 0 | 0 | 0 | 232 | 1,063 |
| 1h | 0 | 0 | 0 | 0 | 99 | 953 |
| 2h | 0 | 0 | 0 | 0 | 19 | 317 |
| 4h | 0 | 0 | 0 | 0 | 9 | 130 |
| 8h | 0 | 0 | 0 | 0 | 5 | 80 |
| 12h | 0 | 0 | 0 | 0 | 1 | 30 |
| 1d | 0 | 0 | 0 | 0 | 0 | 7 |

**The `55 → 54` step admits ZERO additional SELLs at every horizon.** `OPS-CLOSEDBAR-SELL-ASYMMETRY-W1` measured that step admitting **19×** (241 → 4,592). ⚠️ **Recorded as an instrument difference, not a contradiction** — that wave measured the live multi-venue emission stream over its own window; this replays 10 Binance perps over 136 days, and both can be true of their own populations. The consequence for CH3 is the same either way: **no row in this corpus occupies the `(41, 55]` band, so no threshold in that range can be evidenced here.**

### Admitted-cohort composition, against the 10.8% shipping baseline

Definitions verified in source, not assumed: **volume-floor** = `volumeScore === -70` (`volRatio ≤ 0.5`, `get-trade-call.ts:718`); **RSI-neutral** = `rsiScore === 0` (`40 ≤ rsi ≤ 60`, `:640`).

| tf | @40 vol-floor | @40 RSI-neutral | @35 vol-floor | @35 RSI-neutral |
|---|---|---|---|---|
| 5m | **100.00%** | 97.56% | 89.10% | 99.07% |
| 3m | **100.00%** | 100.00% | 95.97% | 99.60% |
| 15m | **100.00%** | 100.00% | 86.82% | 99.27% |
| 30m | **100.00%** | 100.00% | 79.12% | 99.91% |
| 1h | **100.00%** | 100.00% | 82.16% | 100.00% |
| 2h | **100.00%** | 100.00% | 89.91% | 100.00% |
| 4h | **100.00%** | 100.00% | 69.23% | 100.00% |

At threshold 40 **every** admitted SELL is a volume-floor bar and essentially all are RSI-neutral — roughly **9× the shipping baseline concentration**. This confirms, and exceeds, the prior wave's *"lowering the gate admits a different product"* finding.

### `R4_RELAX_DIRECTION=sell-revert` (AC1.9)

**Admits zero additional SELLs at every timeframe.** Its only measured effect is to remove BUY emissions (5m −3.0% · 15m −3.8% · 30m −3.9% · 2h −3.4% · 1h −2.3% · 3m −1.5%). Mechanically consistent: it moves `sellSofteningZ −2.0 → −2.5`, so the `rawScore += 20` softening fires less often, suppressing marginal BUYs without ever manufacturing a SELL. **The remediation armed and dark for ~12 weeks would not raise SELL counts at all.**

---

## Structural note the harness had to be designed around

A **SELL-only cell cannot express excess edge**. `naiveRate = max(up, n−up)/n` is the best fixed direction on the same rows, so on an all-SELL population the engine *is* always-SELL. A harness that fed SELL-only cells to `edgeMetricReport()` would print a guaranteed null and look rigorous doing it. The decision metric was therefore pre-registered over **mixed** populations (all directional emissions at a given threshold), with the SELL-only view kept strictly descriptive. Because thresholds 55–45 admit nothing, four of six thresholds yield all-BUY populations where the result is 0 **by identity, not measurement** — a fact stated rather than reported as a finding.

The null remains informative on two grounds: mixed cells **do** exist at thresholds 40 and 35 and were measured, and `tests/unit/sell-gate-validation.test.ts` proves the gate **can** fire by constructing a genuinely strong cell that returns `EDGE-FOUND`.

---

## Scope

- Zero writes to `src/tools/**`, `src/lib/**`, `migrations/**`, any threshold, any weight, `ENABLE_R4_RELAX`, `tool-descriptions.ts`, `landing/**`, `README.md`, or any anchored row.
- No flag flipped. `ENABLE_PERTF_THRESHOLDS` and every `ENABLE_PERTF_<TF>` remain `0` in prod, untouched.
- All bars are Binance. Venue-specific behaviour is not measured.
- Wall-clock span differs by horizon — the short timeframes cover one market micro-window; the long ones span the full 136-day funding window.

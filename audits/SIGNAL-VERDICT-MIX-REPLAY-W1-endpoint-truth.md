# SIGNAL-VERDICT-MIX-REPLAY-W1 — endpoint truth

Read-only measurement wave. **Structural facts and label-distribution figures only.** Every performance, outcome or monetary figure is INTERNAL and lives in the private vault artifact `SIGNAL-VERDICT-MIX-REPLAY-W1-<date>.md`; the excluded categories are enumerated in the vault file rather than here, so a scanner cannot mistake this disclaimer for the thing it disclaims. **No mixed files:** the moment a file would carry such a figure alongside these, it goes to the vault whole.

---

## Step-0 probes — claim / reality / resolution

| # | Claim | Reality | Resolution |
|---|---|---|---|
| 1 | `scripts/backtest.ts` may already drive the scorer — extend it rather than build | It walks bars, but its header says the scoring is *"replicated verbatim"*. It imports neither `computeIndicatorScores` nor `deriveVerdict`; its RSI ladder has **5 rungs against production's 7**, missing `< 25 → +100` and `> 75 → −100` — exactly the rungs trend mode flips. No `WEIGHTS`, no thresholds, no regime. Cites `src/tools/get-trade-signal.ts`, a path renamed away | **DRIFTED — not extended.** It is itself the second derivation; extending it would replay a rule production has never run, blind to the region under test |
| 2 | The flag may not be settable per-invocation; "that is R1's real content" | **Already settable.** `IndicatorInputs.trendMode?: boolean` is an injected optional field; production reads the env once at its own call site and passes the boolean in | **FALSIFIED ABSENCE** — no env manipulation, and the two arms differ in exactly one input |
| 3 | `BUY_BASE_THRESHOLD` must not be assumed equal to `SELL_THRESHOLD_GATED` | **`const BUY_BASE_THRESHOLD = 40;`** — `src/tools/get-trade-call.ts:173`. `SELL_THRESHOLD_GATED = 55` at `:174` | CONFIRMED — they differ by 15 points |
| 4 | `calibration-audit.ts` may already emit verdict counts by regime | It types `call: 'BUY' \| 'SELL'` throughout — **HOLD is structurally absent** from its model | Genuine gap, not duplication |
| 5 | Confirm what the prior wave landed | `TREND_MODE`, default-deny exact-`'on'`, CH3 = 8 added lines, **not deployed** | CONFIRMED |

**0 fictional primitives.** One spec drift: R3 attributes the 40/55 gate to "v1.5", but the in-file provenance correction records the v1.5 symmetric design as superseded, with the live asymmetry arriving in `29d9576` (R4, 2026-04-14).

---

## The instrument

| | |
|---|---|
| Harness | `src/scripts/verdict-mix-replay.ts` + `verdict-mix-r1-point.ts` + `verdict-mix-report.ts` |
| Scorer | imports the REAL `computeIndicatorScores` / `deriveVerdict`; `isPfeWin` and `seededCall` imported from `calibration-audit.ts` so the win predicate and random baseline are not re-derived |
| Fidelity target | `oiscore_shadow` — verified against `signals` at **1,996/1,996 verdict agreement and 1,980/1,980 confidence agreement**, and HOLD-inclusive, which `signals` is not |
| R1 corpus | 8,875 shadow rows · BTC+ETH · 1h · BINANCE · 14 days |
| R2–R4 corpus | 24,560 replayed bars · 20 coins × {1h, 4h, 1d} · Binance klines |
| Window reconstruction | `startTime = t − 100·interval`, then the in-progress bar dropped ⇒ **99 closed bars** |

---

## R1 — fidelity gate ✅ PASS

**Tolerance stated before running: ≥ 90% point match.** The replayed `rawScore` must land inside the stored confidence band, which is ±0.445 raw points wide (confidence is a rounded integer percentage of 89).

| run | point match |
|---|---|
| **real** | **92.08%** |
| window shifted 1 bar | 37.27% |
| window shifted 3 bars | 22.29% |
| window shifted 24 bars | 15.88% |

A one-bar error collapses the gate, which is what makes a pass meaningful.

### Two gates were discarded for being unable to fail — both recorded, because the failure is the lesson

1. **Verdict agreement.** The stored stream is 99.7% HOLD, so a verdict-match metric scores ~100% by base rate while proving nothing. Reported alongside, never gated on.
2. **Interval containment.** The first gate asked whether the stored value fell inside the range the replay could reach across every unreconstructable funding/OI value. It passed at 100.00% — and then passed at 100.00% again with the window shifted 1, 6 and 24 bars. Mean interval width was 48 of a possible 89 raw points. It was replaced, not loosened.

### The defect R1 caught

A naive `slice(-100)` gave the replay **100** closed bars where production has **99**. `hurstExponent` returns null below 100 closes, so at 99 bars production applies **no Hurst adjustment**, while the replay turned its ±10/±25 term on. Measured on BTC/1h `ts=1786165266077`: achievable `|raw|` was `[0.0, 47.0]` at 99 bars and `[10.0, 57.0]` at 100 — the stored value fell inside the first and outside the second. Off by one bar; a different rule.

---

## R2 — verdict mix, flag-OFF → flag-ON

⚠️ **The flag-ON column is REPLAY-DERIVED throughout.** Flag-ON has never executed in production, so no stored row describes it.

The two arms differ in exactly one input, and trend mode changes exactly one term, so funding/OI/priceChange/Hurst/squeeze are identical between arms and **any reconstruction error cancels in the delta**. Absolute shares inherit that error; deltas do not.

### by regime (n = 24,560 bars)

| regime | n | BUY off→on | SELL off→on | HOLD off→on | ΔBUY |
|---|---|---|---|---|---|
| RANGING | 7,636 | 3.14 → 3.14% | 0.00 → 0.00% | 96.86 → 96.86% | **0** |
| TRENDING_DOWN | 10,765 | 2.19 → 0.98% | 0.00 → 1.04% | 97.81 → 97.97% | **−130** |
| TRENDING_UP | 6,159 | 1.95 → **9.92%** | 0.00 → 0.00% | 98.05 → 90.08% | **+491** |

### by timeframe

| tf | n | BUY off→on | SELL off→on | HOLD off→on | ΔBUY |
|---|---|---|---|---|---|
| 1h | 9,520 | 2.35 → 5.64% | 0.00 → 0.21% | 97.65 → 94.15% | +313 |
| 4h | 9,520 | 2.92 → 3.11% | 0.00 → 0.46% | 97.08 → 96.43% | +18 |
| 1d | 5,520 | 1.70 → 2.25% | 0.00 → 0.87% | 98.30 → 96.88% | +30 |

**Which cells move, and whether any inverts:**

- `RANGING` is **exactly unchanged** — 0 cells move. This is the designed blast-radius confinement, measured rather than asserted.
- `TRENDING_UP` BUY share **5.1×**, 1.95% → 9.92%. This is the intended effect and the largest single movement.
- `TRENDING_DOWN` **inverts**: BUY share halves (2.19 → 0.98%) while SELL appears from nothing (0.00 → 1.04%). This is the only cell where the sign of the directional bias flips.
- **SELL is 0.00% everywhere under flag-OFF** across all 24,560 bars. The gate at 55 admits nothing in this corpus; every SELL in the flag-ON column is created by trend mode flipping oversold bars in `TRENDING_DOWN`.

---

## Notes on scope

- `emit_suppressions` exists but holds **0 rows**, so gate-suppressed calls are genuinely not recorded anywhere. R3's replay-only requirement stands.
- All 24,560 bars are Binance. Venue-specific behaviour is not measured.
- The corpus spans one market period containing a large advance and a reversal. Shares are period-specific.

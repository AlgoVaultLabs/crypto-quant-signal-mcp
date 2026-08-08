# OPS-CLOSEDBAR-DIRECTIONAL-BALANCE-W1 — is 893:1 a defect, or is it correct?

**Answer: neither. The premise number was wrong, and the real defect is not a threshold.**

R0 was READ-ONLY. **Mutation count: ZERO.** No constant was changed by this wave.

---

## 1. Two corrections to the premise, before any interpretation

| Premise the wave was written on | Measured truth |
|---|---|
| `sell_pfe_wr = 0.0%` | **26.2%** |
| `BUY:SELL = 893:1` (n=1 SELL) | **96.8:1** (n=25) — pre-flip 58.7:1, so the real shift is **1.65×**, not 15× |

**The 0.0% was my bug.** The canonical win predicate in production is
`signal === 'BUY' ? pfe_return_pct > 0 : pfe_return_pct < 0`
(`src/lib/performance-db.ts:1453`, named explicitly in `src/lib/book-liveness.ts:11`).
`OPS-CLOSEDBAR-RECALIBRATE-READINESS-W1`'s harness used `pfe_return_pct > 0` for **both** sides.

`pfe_return_pct` is a **signed move from entry price**, so for a SELL it is `<= 0` by construction
(`computePFEMAE` walks `pfePrice` downward on the SELL branch, then returns
`(pfePrice - entryPrice)/entryPrice`). A SELL could therefore never register a win under the wrong
predicate. Production was always correct; the instrument was not. Note that `return1candle` in the
same file **is** direction-adjusted (`isBuy ? raw1c : -raw1c`), so the codebase carries both
conventions and the harness picked the wrong one.

Fixed in this wave, with a test that fails on the wrong predicate.

---

## 2. `drift_baseline` — the benchmark that makes any WR figure interpretable

`return_pct_1h` / `_4h` / `_24h` are **entirely NULL** in `signals`, so an always-buy / always-sell
benchmark could not be built from realised returns. It was built from **excursion sign** instead,
which is available for every matured row:

| cohort | n | P(any UP excursion) | P(any DOWN excursion) | mean \|PFE\| | mean \|MAE\| |
|---|---|---|---|---|---|
| BUY rows | 20,695 | **92.1%** | **91.1%** | 2.705 | 2.177 |
| SELL rows | 343 | **26.5%** | **26.2%** | 1.086 | 1.877 |

**Within each cohort, up- and down-excursion probabilities are near-identical** (1.0pp and 0.3pp
apart). An always-buy and an always-sell benchmark therefore score *the same* inside a given
cohort. So the BUY-vs-SELL WR gap is **not directional market drift** — the market did not simply
go up. The gap is a difference in whether price moved **at all**.

That is the finding the spec's "92%/0% is reading the market" hypothesis was reaching for, and it
is measurably **not** what happened.

---

## 3. The decisive finding — the SELL cohort is DEAD BOOKS, not bad calls

A **dead book** here is `pfe_return_pct = 0 AND mae_return_pct = 0`: price never moved in either
direction across the whole evaluation window.

| cohort | n | dead book | WR (canonical) |
|---|---|---|---|
| BUY | 20,695 | **0.4%** | 92.1% |
| SELL | 343 | **67.9%** | 26.2% |
| **SELL, live books only** | **110** | — | **81.8%** |
| BUY, live books only | 20,619 | — | 92.4% |

Two-thirds of SELLs are emitted into books that never traded, and PFE records a non-moving book as
a SELL loss (`pfe = 0` is not `< 0`). **Strip them and SELL WR is 81.8% against BUY's 92.4%.**

SELL signals are not worthless. They are being aimed at dead books.

**`EMIT_BOOK_LIVENESS_MODE` is UNSET on production** — the gate written for exactly this
(`src/lib/book-liveness.ts`, whose own header describes `pfe = mae = 0` and the canonical SELL
predicate) is **not enforcing**.

### `per_venue` — the problem is concentrated, not diffuse

| venue | SELL n | dead % | SELL WR (all) | SELL WR (live books) | BUY n | BUY WR |
|---|---|---|---|---|---|---|
| HTX | 153 | **89.5** | 0.7 | **6.3** | 820 | 92.2 |
| XT | 119 | **72.3** | 25.2 | **90.9** | 972 | 88.5 |
| ASTER | 17 | 58.8 | 35.3 | 85.7 | 1,434 | 86.7 |
| BYBIT | 12 | 0.0 | 100.0 | 100.0 | 2,035 | 93.1 |
| GATE | 9 | 0.0 | 100.0 | 100.0 | 2,188 | 90.5 |
| BINGX | 7 | 0.0 | 100.0 | 100.0 | 1,136 | 94.1 |
| HL | 7 | 0.0 | 85.7 | 85.7 | 604 | 90.4 |
| BINANCE | 7 | 0.0 | 100.0 | 100.0 | 2,452 | 94.4 |
| MEXC | 5 | 0.0 | 100.0 | 100.0 | 1,873 | 93.6 |
| BITMART | 5 | 0.0 | 100.0 | 100.0 | 115 | 94.8 |
| KUCOIN | 1 | 0.0 | 100.0 | 100.0 | 2,076 | 92.8 |
| WHITEBIT | 1 | 0.0 | 100.0 | 100.0 | 761 | 89.4 |

**HTX + XT + ASTER carry 289 of 343 SELLs (84%)** and essentially all of the dead-book population.
Every other venue has a **0.0% dead-book rate** and SELL WR of 85.7–100%.

**HTX is a separate problem**: 89.5% dead *and* only 6.3% WR on the live remainder (n=16). That is a
venue-quality finding, not a threshold one.

### per-timeframe

| tf | SELL n | dead % | SELL WR (live) | BUY n | BUY WR |
|---|---|---|---|---|---|
| 4h | 104 | 83.7 | 35.3 | 1,539 | 90.6 |
| 1h | 73 | 60.3 | 89.7 | 1,627 | 89.9 |
| 2h | 63 | 77.8 | 85.7 | 1,436 | 87.4 |
| 8h | 33 | 90.9 | 33.3 | 531 | 85.3 |
| 5m | 23 | 4.3 | 95.5 | 5,200 | 93.1 |
| 12h | 18 | 77.8 | 75.0 | 337 | 89.9 |
| 15m | 11 | 63.6 | 100.0 | 3,009 | 94.3 |
| 3m | 9 | 0.0 | 100.0 | 3,919 | 93.1 |
| 30m | 9 | 11.1 | 100.0 | 3,082 | 92.6 |

Dead books concentrate on the **coarse** timeframes (4h 83.7%, 8h 90.9%, 2h 77.8%). The fast
timeframes are clean and their SELL WR is 95–100%.

---

## 4. `atom_decode` — the −55 mass point is DEGENERATE

4,311 rows sit at exactly `raw_closed = −55`.

| configuration | n | share |
|---|---|---|
| `vol_score = −70, rsi_score = 0` | 4,265 | **98.9%** |
| `vol_score = −70, rsi_score = −100` | 35 | 0.8% |
| `vol_score = −70, rsi_score = −40` | 10 | 0.2% |
| `vol_score = −30, rsi_score = 0` | 1 | 0.0% |

| property | the −55 atom | all negative-raw rows |
|---|---|---|
| at the volume FLOOR (−70) | **100.0%** | 51.3% |
| at RSI extreme (−100) | **0.8%** | 7.3% |
| distinct (vol, rsi) combos | **4** | 43 |

**`rsi_score = 0` means RSI is NEUTRAL — no bearish signal at all.** The atom is: volume pinned at
its floor, momentum saying nothing. That is the partial-bar volume artifact
`SIGNAL-CLOSEDBAR-SHADOW-W1` / `-FLIP-W1` existed to remove, not a strong-bearish configuration.

**Verdict: noise correctly excluded, not signal wrongly excluded.**

### No flat neighbourhood exists on the SELL side

| threshold | SELLs admitted | × current (240 @ >55) |
|---|---|---|
| 50 | 4,763 | 17.0 |
| 53 | 4,667 | 16.6 |
| **54** | **4,551** | **16.2** |
| **55 (current)** | **240** | **0.9** |
| 56 | 110 | 0.4 |
| 60 | 15 | 0.1 |

Every candidate from 50–54 admits ~4,500–4,700, i.e. the whole degenerate atom. **Every SELL-side
candidate is a cliff edge.** The flat-neighbourhood requirement is binding and unmet.

---

## 5. `asymmetry_provenance` — the 15-point gap was NEVER DESIGNED

`git log -S` on both constants converges on one commit:

**`73e34e5` · 2026-04-28 · `feat(call): C1+C2 OUTPUT-SANITIZE-W1`**

It introduced all four constants at once, with this stated justification:

```
// v1.5: Symmetric signal thresholds — both directions require equal conviction
const BUY_BASE_THRESHOLD = 40;
const SELL_BASE_THRESHOLD = 40;
// Regime-aware gates: require higher conviction when trading against the regime
const BUY_THRESHOLD_GATED = 55;   // BUY in TRENDING_DOWN
const SELL_THRESHOLD_GATED = 55;  // SELL in TRENDING_UP or RANGING
```

**The design was SYMMETRIC**: BUY base 40, SELL base 40, both gated at 55 *conditionally on regime*.

The live 15-point asymmetry exists because the sell call site resolved
`getThresholdForTF(timeframe, 'sell', SELL_THRESHOLD_GATED)` — the **gated** constant as its
fallback — while the BUY side used the **base**, and the regime gating was never wired at all.
`SELL_BASE_THRESHOLD` and `BUY_THRESHOLD_GATED` were dead constants (deleted in
`SIGNAL-CLOSEDBAR-FLIP-W1` CH1, `dc42b38`).

**Was the engine biased at that time?** The `−70` volume floor was introduced in the **same commit**
(`73e34e5`). So the thresholds were never tuned *against* a pre-existing bearish pull — both shipped
together.

**The spec's central question has a third answer: the asymmetry is a WIRING DEFECT, not a tuned
choice and not a bias compensation.** A threshold whose justification dissolved and a threshold that
was never wired as designed are different objects, and this is the latter.

---

## 6. Gate verdict

**The imbalance is not a threshold defect. NO constant moved.**

- The −55 atom is degenerate (98.9% one config, RSI neutral, 100% at the volume floor).
- No SELL-side candidate has a flat neighbourhood; 54 admits 19× what 55 does.
- The asymmetry is unintended — but "correcting" it to the designed 40 would sweep in the entire
  degenerate atom, which is the opposite of the intent.

This is **not** the spec's "SELLs add no value" branch either. SELLs score **81.8%** on live books.

**`SELL_THRESHOLD_GATED = 55` stands, now ratified a third time** — previously in
`SIGNAL-CLOSEDBAR-FLIP-W1` Q4 and in `OPS-CLOSEDBAR-RECALIBRATE-READINESS-W1`'s out-of-scope table.

**No third methodology boundary was created**, because nothing moved. The unsegmented public series
still carries exactly one recorded interval, `[2026-08-07T10:16:12Z → 12:28:57Z]`.

---

## 7. For the architect — the one lever that would actually move the balance

Not a threshold: **`EMIT_BOOK_LIVENESS_MODE=enforce`**.

The gate already exists and was built for precisely this population. It is currently unset, so
dead-book calls are emitted rather than suppressed to HOLD. Enabling it is a **live, user-visible
emission change** on the paid surface, so it is explicitly not this wave's call.

Falsifiable prediction if it is enabled, to be checked after: SELL emission falls by roughly the
dead-book share (**~68%**, concentrated in HTX/XT/ASTER at 4h/8h), BUY emission falls ~0.4%, and
measured SELL WR rises from 26.2% toward the live-book **81.8%** — because the suppressed rows are
exactly the ones PFE cannot score.

Two further items that are separate decisions:

1. **HTX SELL quality** — 89.5% dead books *and* 6.3% WR on the live remainder. A venue-coverage
   question, not a threshold one.
2. **The unwired symmetric design** — `SELL_BASE_THRESHOLD = 40` and regime gating were specified in
   `73e34e5` and never wired. Whether to implement the original design (rather than tune around its
   absence) deserves its own decision, and cannot be taken while the −55 atom exists.

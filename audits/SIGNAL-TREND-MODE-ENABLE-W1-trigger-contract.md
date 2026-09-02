# SIGNAL-TREND-MODE-ENABLE-W1 CH2 — rollback trigger contract

**Declared `2026-08-31T09:06:21Z`, BEFORE the `TREND_MODE` flip.** Post-hoc threshold selection is
the failure this project has spent five waves retiring, so the thresholds below are fixed in this
file first and the flag is flipped second.

**This file carries NO measured values, deliberately.** Every threshold is expressed as a MULTIPLE
or a DELTA against a quantity the canary recomputes live. The measured v1 baselines are derived from
`signals.outcome_return_pct`, which CLAUDE.md marks INTERNAL-ONLY, and this repo is public with
`audits/**` tracked — so those figures live in the private vault
(`<vault>/audits/SIGNAL-TREND-MODE-ENABLE-W1-BEFORE-2026-08-31.md`). No mixed files.

---

## The population, and why both arms must share it

```
BEFORE arm:  regime_rule_version = 3  AND  verdict_rule_version = 1  AND  exchange <> 'BITMART'
AFTER  arm:  regime_rule_version = 3  AND  verdict_rule_version = 2  AND  exchange <> 'BITMART'
```

- **`regime_rule_version = 3` is held FIXED on both sides.** The regime LABEL rule changed at
  `2026-08-22T05:41:09Z`; `TRENDING_UP` either side of that instant is not the same label. Pooling
  across it would make every per-regime delta a measurement artifact rather than an effect.
- **`BITMART` is excluded from BOTH arms.** It was retired emission-side on 2026-08-27, mid-BEFORE-
  window, so leaving it in would put a venue in one arm and not the other. Its weight in the BEFORE
  arm is ~0.1%, so this changes nothing numerically — it is done because a population that differs
  between arms is not one instrument, whatever the magnitude.
- **The win predicate is SIDE-AWARE**: `(BUY AND outcome_return_pct > 0) OR (SELL AND
  outcome_return_pct < 0)`. A signed-excursion metric scored without regard to side measures the
  market, not the call.

## The rule that makes the comparison honest

**Both arms are computed in ONE query, and no baseline is ever baked into the canary.** A threshold
stored as a number goes stale the moment the market moves; a threshold stored as a ratio against a
live-recomputed sibling cannot. This is the same law as "a delta across two instruments is not a
delta", applied to time instead of to tooling.

---

## Triggers

**⚠️ AMENDED 2026-09-02 by `EDGE-POPULATION-COMPARISON-W1`, AFTER trigger A fired.** The amendment
is recorded here WITH the firing that prompted it, in that order, because changing a pre-declared
threshold after watching it fire is post-hoc threshold selection and "my correction is
methodologically right" is exactly how that feels from the inside. Ratified by the architect
2026-09-02 as a named wave rather than applied silently.

**What fired and why it was wrong.** Trigger A was declared as
`engine − max(always_long, always_short)`, compared across arms. It reported v2 −9.23pp vs v1
−4.15pp and FAILed a −3.0pp floor. Measured decomposition: `always_short` moved **+2.97pp** between
the windows, which alone explains most of the delta with **zero engine change**. The comparator was
market-coupled, and `max()` is additionally selection-coupled — it silently changes *which* quantity
it names as the up-rate crosses 0.5.

**And the deeper finding, which no comparator repair fixes.** The excess an arm can attain over its
own null is bounded by its marginals. At v1's 99.47% BUY share the engine **cannot** deviate from
its mix-matched null by more than ±0.5pp whatever it does. Attainable widths: **1.06pp (v1)** vs
**38.93pp (v2)** — 36.7×, against a declared floor of 3.0pp. **A floor wider than an arm's entire
attainable range means that arm cannot influence the verdict**, so the "cross-arm delta" was
arithmetically a single-arm level test wearing a delta's clothes. Trigger A therefore **REFUSES**
this comparison as `NOT_IDENTIFIABLE` rather than reporting a number.

| # | Trigger | Metric | Fires when | Window | Min n |
|---|---|---|---|---|---|
| **A** | Edge floor — **derived through `ops/monitoring/population_comparison.py`, basis `MIX_MATCHED_NULL`** | `engine − (q·p_long + (1−q)·p_short)` on the SAME rows, where `q` is the emitted BUY share — the only basis that controls for **both** the world and the arm's own side mix | v2 excess falls **> 3.0 pp** below v1's — **but only if the comparison is IDENTIFIABLE.** Refuses to `INDETERMINATE` when the declared floor exceeds either arm's attainable range, or below **20 clusters** | rolling from flip | **5,000** scored v2 rows **and 20 clusters** |
| ~~A2~~ | ~~Edge-vs-long floor~~ | **RETIRED, not migrated.** Its basis is mix-coupled: it reported **+0.44pp improvement** on the same rows and the same day A reported a 5.08pp regression, purely because BUY share fell 99.5% → 80.9%. Migrating it to the mix-matched null yields a second copy of A, which is a second derivation of one value. Survives as a diagnostic | — | — | — |
| **B** | Volume ceiling — `purpose: OPERATIONAL_BOUND` | `TRENDING_*` recorded rows/day | **> 8×** the v1 daily rate, sustained **3 consecutive days** | 3-day sustained | n/a |
| **C** | Cell concentration — `OPERATIONAL_BOUND` | share of emissions in `4h` + `1d` | **> 3×** the v1 share | rolling | **2,000** v2 rows |
| **D** | Emission gap — `OPERATIONAL_BOUND` | max inter-arrival gap | **> 2×** the v1 maximum | 24 h | n/a |

**B, C and D deliberately compare against a prior window and are declared `OPERATIONAL_BOUND` for
it.** They are anomaly and liveness bounds, not effect claims — and an `OPERATIONAL_BOUND` is
**forbidden from naming the change under test in its alert body**, because a bound that names the
change reads as an effect claim to the operator receiving the page.

**Aggregation is PER_CLUSTER, never pooled.** Measured 2026-09-02: pooled excess **−1.25pp** vs
unweighted daily mean **+0.21pp** — pooling **flipped the sign**, because it weights the busiest day
and the day is the independence unit. v1 ran daily mean 0.00 / stddev 0.08 over 10 days; v2 ran
stddev 2.08 over 3 — a 26× variance difference a pooled point estimate hides entirely.

**Q2 ratified 2026-09-02 — the 3.2× emission rise is ACCEPTED for the 30 days, explicitly.**
Emission went 3,136/day (v1) → ~10,141/day (v2). Trigger B's ceiling is 8× so it correctly passes.
The operator was asked whether a quality-adjusted volume trigger should be added and answered
**keep** — recorded here so the acceptance is a decision on the record rather than a gap nobody
noticed.

### Pre-declared limits, stated now rather than discovered at readout

- **`1d` is a DIRECTIONAL WATCH, not a powered test.** Its measured emission rate puts it far below
  any usable floor even at +30 days. The gate emits **`INDETERMINATE`** for that cell — never a
  green pass over an underpowered one. Declared 2026-08-22, re-confirmed against 9 days of live
  data on 2026-08-31.
- **A trigger without enough rows emits `INDETERMINATE`, never PASS.** "Measured and clean" may not
  share an output with "measured nothing".
- **The accuracy floor is on EDGE, not on raw accuracy — this is a PRE-FLIP correction to a
  pre-declared trigger, made before any v2 row existed.** The original wording ("v2 accuracy falls
  below v1's by more than a stated margin") is unusable, because the engine's emission is
  overwhelmingly one-sided and its realized accuracy is therefore arithmetically pinned to the
  base rate of that side. A margin against it would report which way the market moved over the
  AFTER window, not what trend mode did. Recorded as a correction rather than applied silently.

### Trigger dropped

**Webhook `regime_shift` delivery volume — DROPPED by architect ruling, 2026-08-31.** It was
declared on 2026-08-22 as the highest-ranked trigger on the premise that a higher non-HOLD rate in
`TRENDING_*` would bill live paying subscribers per delivery. Measured before the flip, that premise
is false: **zero** active webhook subscriptions and **zero** `regime_shift` deliveries across the
whole BEFORE window. A trigger with a zero denominator is dark by construction. Recorded here as a
**declared gap with a named owner** — `SIGNAL-TREND-MODE-READOUT-W{NEXT}` re-opens it if a
subscription becomes active — rather than deleted, so its absence is visible rather than silent.

## Rollback

`TREND_MODE` unset from `/opt/crypto-quant-signal-mcp/.env` + `docker compose up -d
--force-recreate mcp-server`. No deploy, no code change. **Exercised end-to-end before being
relied on.** `docker compose restart` does NOT reload `env_file:` and must not be used.

**The gate DETECTS, ALERTS and ESCALATES. It never unsets the flag** — an unattended job must not
mutate a live scorer.

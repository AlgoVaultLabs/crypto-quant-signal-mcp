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

| # | Trigger | Metric | Fires when | Window | Min n |
|---|---|---|---|---|---|
| **A** | Edge floor | v2 accuracy **minus the better of its own two naive baselines** (always-long, always-short), vs the same quantity on v1 | v2 edge falls **> 3.0 pp** below v1 edge | rolling from flip | **5,000** scored v2 rows |
| **A2** | Edge-vs-long floor | v2 accuracy minus v2 always-long, vs the same on v1 — the "does trend mode beat simply buying" test | falls **> 2.0 pp** below v1 | rolling | **5,000** scored |
| **B** | Volume ceiling | `TRENDING_*` recorded rows/day | **> 8×** the v1 daily rate, sustained **3 consecutive days**. The replay predicted a ~5.1× rise in BUY share; 8× is the pre-declared meaning of "much worse than predicted" | 3-day sustained | n/a |
| **C** | Cell concentration | share of emissions landing in `4h` + `1d` | **> 3×** the v1 share | rolling | **2,000** v2 rows |
| **D** | Operator-visible anomaly | (i) any `recordSignal` failure in 24 h, **or** (ii) an emission gap **> 2× the v1 maximum** | either | 24 h | n/a |

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

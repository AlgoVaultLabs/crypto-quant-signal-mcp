# OPS-CLOSEDBAR-SELL-ASYMMETRY-W1 — was the 15-point BUY/SELL gap justified, or was it compensation?

**VERDICT: ARTIFACT, NOT WORTH RECOVERING**

It was compensation. It was designed as compensation, deliberately, on 2026-04-14, and said so in
its own commit message. Its justification had already failed its own re-audit three months before
the flip. But every SELL-side candidate crosses a degenerate 4,352-row atom, and the cohort a
relaxation would admit is 95–99% the configuration where volume sits at its floor and RSI says
nothing. **The asymmetry is now unjustified and is not correctable at the threshold.**

R0 was READ-ONLY. **Mutation count: ZERO.** No constant changed, no flag flipped, no env touched.
`git diff origin/main -- src/tools/get-trade-call.ts` → **empty** (0 lines), evaluated in a worktree
at `HEAD == origin/main`; see §6 defect 1 for why the same command lies in the primary checkout.

---

## 1. `provenance` — recovered in full, and it contradicts the current record

`git log -S` scoped to `src/` rather than to the post-rename filename recovers the whole chain:

| commit | date | what it did |
|---|---|---|
| `a530f4e` | 2026-04-07 | **`-70` volume floor ships** (`else volumeScore = -70`) |
| `3cc3464` | 2026-04-07 | first asymmetry — BUY_BASE **45** / SELL_BASE **35**, "BUY must be more convincing than SELL" |
| `b671c52` | 2026-04-10 | **v1.5.0 — equalises to 40/40**, both gated at 55 *conditionally on regime* |
| **`29d9576`** | **2026-04-14** | **R4 — creates the live 15-point gap, deliberately** |
| `73e34e5` | 2026-04-28 | `src/tools/get-trade-signal.ts` → `get-trade-call.ts` — **a RENAME** |
| `9a0bd02` | 2026-05-28 | R4 inversion recaudit → verdict **RELAX** |
| `de1a260` | 2026-05-28 | per-TF thresholds + R4-relax behind a 2-flag firewall (both default OFF) |
| `dc42b38` | 2026-08-07 | `SIGNAL-CLOSEDBAR-FLIP-W1` CH1 deletes the two now-dead constants |

### The answer, quoted verbatim from `29d9576`

> ```
> fix(signal): invert direction thresholds to capture BUY edge per audit H4/interpretation B (R4)
>
> Audit found a persistent +10-14pp BUY win-rate edge across all 5 exchanges
> (HL +14.3, Binance +14.2, Bybit +10.2, Bitget +13.2, OKX +6.2) despite
> v1.5 symmetric thresholds. Interpretation B: the edge is real market structure
> (short squeezes on crypto perps), not a scoring bug. So we lean into it by
> flipping the 5 compounding SELL biases toward BUY favor.
> [...]
> 4. Regime gate BUY path: BUY now always uses BUY_BASE_THRESHOLD = 40 (no TRENDING_DOWN gate)
> 5. Regime gate SELL path: SELL now always uses SELL_THRESHOLD_GATED = 55 (all regimes gated)
>
> Combined effect: BUY has a consistent 15-point structural advantage (40 vs 55)
> regardless of regime, plus favorable Z-Score and raw-funding asymmetries.
> Target: BUY share >= 60% across HL/Binance/Bybit/Bitget (OKX reference only).
> ```

Flips #4 and #5 **are** the gap. It was a tuned choice, it was explicitly a correction applied
against a scoring skew, and the correction was aimed at a share target.

### Was the engine biased at that time? Yes — measured, and documented in the repo

`b671c52` (2026-04-10), four days earlier, states the condition being corrected:

> ```
> Root cause: PFE/MAE analysis showed 97% SELL signals with 0% directional
> accuracy. Five compounding biases identified and corrected.
> ```

A 97% SELL share is the systematic bearish skew. It predates the gap by four days, and the `-70`
volume floor that mechanically produces much of it predates the gap by **seven** (`a530f4e`,
2026-04-07). **The asymmetry was tuned against a pre-existing bearish pull.**

### Correcting four claims in `OPS-CLOSEDBAR-DIRECTIONAL-BALANCE-W1` §5

That wave (`b561ad8`, 2026-08-08) concluded *"the 15-point asymmetry was NEVER DESIGNED … a wiring
defect, not a tuned choice and not a bias compensation."* Each supporting claim is false:

| claim in §5 | measured reality |
|---|---|
| "`git log -S` on both constants converges on one commit: `73e34e5`" | It converges there **only** under a probe path-scoped to the post-rename filename. `73e34e5` **is the rename** — every constant shows as a `/dev/null →` addition by construction |
| "It introduced all four constants at once" | `b671c52` did, on 2026-04-10, **18 days earlier** |
| "the regime gating was **never wired at all**" | It **was** wired, in `b671c52`, and ran for four days. `29d9576` **deliberately removed it** — the removal is in the diff, as flips #4 and #5 |
| "the `-70` volume floor was introduced in the same commit (`73e34e5`) … so the thresholds were never tuned against a pre-existing bearish pull" | The floor shipped in `a530f4e` on **2026-04-07** — 7 days before the gap, 21 before `73e34e5`. The bearish pull existed first and was measured at 97% SELL |

**Reproduction of the misattribution** (all three against the same tree):

```
git log -S 'SELL_THRESHOLD_GATED' -- src/tools/get-trade-call.ts   # stops at 73e34e5
git log --follow -S 'SELL_THRESHOLD_GATED' -- src/tools/…          # + 29d9576, b671c52
git log -S 'SELL_THRESHOLD_GATED' -- src/                          # + 3cc3464 (pre-tool-file)
```

A pickaxe scoped to a path cannot cross a rename. The generator-level lesson: **`-S` for provenance
must be scoped to a directory or carry `--follow`, never to a single post-rename path.**

### The justification had already expired, on its own pre-declared terms

`9a0bd02` (2026-05-28, `OPS-TRADE-CALL-CALIBRATION-AUDIT-W1`) re-measured the differential that
justified the gap and recorded:

> ```
> R4 inversion recaudit verdict (RELAX — BUY edge +3.17pp PFE-WR, below +5pp
> KEEP threshold but above 0pp REVERT)
> ```

+3.17pp against a pre-declared **+5pp KEEP bar** → verdict **RELAX**. The architect ratified
direction (ii) `sell-revert` at Plan-Mode and the remediation shipped in `de1a260` behind a two-flag
firewall — **and it is still dark**. Production, probed live:

```
ENABLE_R4_RELAX=0            R4_RELAX_DIRECTION=sell-revert
ENABLE_PERTF_THRESHOLDS=0    (all 12 inner ENABLE_PERTF_<TF>=0)
CANDLE_BASIS=closed
/app/dist/tools/get-trade-call.js:  BUY_BASE_THRESHOLD = 40   SELL_THRESHOLD_GATED = 55
```

Armed with the ratified direction, never enabled, **~10 weeks**. (It moves the Z-score gates — R4
flips #1–#3 — and does **not** touch the 40/55 gap.) The per-TF overrides are also off, so the live
rule is uniformly BUY > 40 / |raw| > 55, exactly as the spec assumed.

**So the gap rests on a differential that fell below its own keep-bar in May 2026, measured with the
instrument the architect ruled on 2026-08-08 is a base rate rather than a direction measure.**

---

## 2. `histogram` — `|raw|` mass points, both sides

Source `candle_basis_shadow.raw_closed` — the closed basis, which is the live basis
(`CANDLE_BASIS=closed`). n = 3,109,879 non-null, window 2026-08-01 → 2026-08-08.

**SELL side, every mass point at `raw_closed ≤ −40`:**

| raw | n | | raw | n |
|---|---|---|---|---|
| −40 | 16,682 | | −47 | 2,550 |
| −45 | 15,757 | | −50 | 166 |
| −43 | 13,053 | | −44 | 144 |
| −49 | 8,949 | | −56 | 131 |
| −41 | 7,244 | | −54 | 117 |
| **−55** | **4,352** | | (tail < −56) | 110 |
| −46 | 2,724 | | | |

**BUY side, `raw_closed ≥ 40`:** 41 (12,454) · 43 (8,347) · 45 (7,839) · 47 (5,605) · 49 (4,545) ·
51 (4,061) · 55 (2,003) · 53 (1,886) · 40 (1,490) · 57 (1,401) · 42 (1,131) · 61 (964).

**The atom sits at exactly −55**, and the live rule is strict (`|raw| > 55`), so it is excluded by a
single point. Any downward move admits it whole. There is no flat neighbourhood on the SELL side —
not merely no *good* candidate, but no candidate at all that does not cross it.

---

## 3. `counterfactual` — emission and `buy_sell_ratio` per candidate

BUY emission is held at its live rule (`raw_closed > 40`, n = 54,375) throughout.

| candidate T (SELL fires at \|raw\| > T) | SELLs admitted | × current | **buy_sell_ratio** |
|---|---|---|---|
| **40 — symmetric** | 55,439 | 230× | **1.0 : 1** |
| 45 | 19,220 | 80× | 2.8 : 1 |
| 49 | 4,971 | 21× | 10.9 : 1 |
| 50 | 4,805 | 20× | 11.3 : 1 |
| 52 | 4,776 | 20× | 11.4 : 1 |
| 53 | 4,709 | 20× | 11.5 : 1 |
| **54** | **4,592** | **19×** | 11.8 : 1 |
| **55 — CURRENT** | **241** | **1×** | **225.6 : 1** |
| 56 | 110 | 0.5× | 494.3 : 1 |
| 60 | 15 | 0.06× | 3,625 : 1 |

The 54 → 55 step is a **19.0× emission change**. Candidates 49–54 are flat *relative to each other*
(4,971 → 4,592, −7.6% across five points) but all sit on the far side of the atom from 55, so
reaching that flat region from 55 costs the full 19×.

*(On the spec's ~187:1 premise: the shadow-window figure is 225.6:1; `OPS-CLOSEDBAR-DIRECTIONAL-BALANCE-W1`
reports 96.8:1 on the emitted `signals` population. Different denominators, both real, neither
contradicts the other.)*

### per timeframe

| tf | SELL @55 (live) | SELL @40 | × | BUY @40 |
|---|---|---|---|---|
| 5m | 10 | 11,632 | 1,163× | 14,583 |
| 2h | 51 | 9,424 | 185× | 5,246 |
| **15m** | **0** | 7,586 | — | 7,539 |
| 1h | 37 | 7,281 | 197× | 5,738 |
| 30m | 2 | 6,800 | 3,400× | 7,318 |
| 3m | 6 | 4,703 | 784× | 8,030 |
| 4h | 81 | 2,770 | 34× | 2,762 |
| 8h | 34 | 2,769 | 81× | 1,659 |
| 12h | 20 | 2,370 | 119× | 1,311 |
| **1d** | **0** | 107 | — | 109 |
| **1m** | **0** | 0 | — | 83 |

**The engine cannot currently emit a SELL at all on 15m, 1d or 1m**, and emits ≤ 10 on 5m/3m/30m.

### per venue

| venue | SELL @55 | SELL @40 | × | BUY @40 |
|---|---|---|---|---|
| **HTX** | **115** | 2,140 | 19× | 1,766 |
| **XT** | **97** | 1,666 | 17× | 1,502 |
| GATE | 10 | 15,345 | 1,535× | 12,333 |
| KUCOIN | 5 | 2,290 | 458× | 3,993 |
| MEXC | 4 | 5,436 | 1,359× | 5,346 |
| ASTER | 4 | 2,051 | 513× | 2,107 |
| BITGET | 1 | 8,807 | 8,807× | 5,812 |
| HL | 1 | 5,630 | 5,630× | 4,373 |
| BINANCE | 1 | 3,120 | 3,120× | 3,245 |
| PHEMEX | 1 | 2,798 | 2,798× | 2,736 |
| WHITEBIT | 1 | 2,152 | 2,152× | 2,099 |
| BYBIT | 1 | 1,237 | 1,237× | 3,343 |
| OKX | 0 | 1,842 | — | 2,460 |
| WEEX | 0 | 728 | — | 721 |

**HTX + XT carry 212 of 241 SELLs — 88% of the entire live SELL book.** Those are precisely the two
venues `OPS-CLOSEDBAR-DIRECTIONAL-BALANCE-W1` measured at **89.5%** and **72.3%** dead books. The
threshold does not merely suppress SELLs; **it concentrates the surviving SELL book onto the two
worst-liveness venues.** That is a new finding and it is the strongest practical argument in this
artifact — not for moving the threshold, but for §7 item 1.

---

## 4. What a relaxation would actually admit

| band | n | % volume at floor (−70) | % RSI neutral (0) | **% both — degenerate** |
|---|---|---|---|---|
| ≤ −56 — **emitted today** | 241 | 66.4 | 11.2 | **10.8** |
| exactly −55 — the atom | 4,352 | 100.0 | 99.0 | **98.9** |
| −54 … −49 | 9,330 | 98.1 | 94.8 | **94.8** |
| −48 … −40 | 58,201 | 58.3 | 62.9 | **50.1** |

`rsi_score = 0` is RSI **neutral** — the highest-weighted input (30%) carrying no bearish
information — while volume is pinned at its floor. What the engine emits today is 10.8% that
configuration. Everything a relaxation would admit is 50–99%.

**Correcting the mechanism, so it is not recorded wrongly a second time.** `OPS-CLOSEDBAR-DIRECTIONAL-BALANCE-W1`
§4 calls the atom *"the partial-bar volume artifact the flip removed."* It cannot be: the atom is
measured in the **closed** basis, so by construction it is what **survived** the flip. Measured over
n = 3,110,328 rows carrying both bases:

| basis | share at volume floor (−70) |
|---|---|
| live (partial bar) | **60.06%** |
| closed (post-flip, live today) | **35.26%** |

The flip removed ~41% of the floor incidence. The remaining 35.26% is genuine low-volume books — the
same root cause as the dead-book finding, arrived at from a different direction. The atom is spread
across venues and timeframes (GATE 1h/5m/15m/2h/30m, BITGET 5m, HL 5m/15m), not one venue.

---

## 5. Excluded-cohort edge — the mandated instrument cannot reach the population

The spec requires this be assessed via `directional_labels` / `src/scripts/edge-stats.ts`, reporting
`wilson` CI-lb, Pesaran-Timmermann and n per stratum, and forbids PFE. **It cannot be produced
read-only, by either permitted instrument, and the reason is structural rather than a sample-size
problem.**

| probe | result |
|---|---|
| `signals` direction distribution | BUY 417,261 · SELL 36,421 · **HOLD 0 — HOLDs are never persisted** |
| `directional_labels` volume | 1,126,559 labels, 2026-07-02 → 2026-08-08 |
| `directional_labels ⋈ signals` by direction | BUY 1,031,463 (345,775 signals) · SELL 95,096 (31,756) · **HOLD 0** |
| orphan labels (`signal_id` not in `signals`) | **0** |
| the excluded cohort, `raw_closed ∈ (−55, −40]` | **67,523 rows — every one `call_closed = HOLD`** |
| outcome columns on `candle_basis_shadow` | **none** — no forward return, no barrier, no label |

`directional_labels` keys on `signal_id`. The excluded cohort was never emitted, so it has no
`signals` row, so it can have no label — **by construction, not by omission.** The only table that
contains the cohort carries no outcome data at all.

**Reported, not filled in with reasoning.** Producing Wilson CI-lb / PT / n-per-stratum for this
cohort requires labelling 67,523 shadow rows from OHLCV at their recorded timestamps — a backfill
(`src/scripts/backfill-directional-labels.ts` is the nearest primitive), i.e. a mutation, out of
scope for a read-only wave.

**The verdict does not rest on this leg.** The spec's NOT-WORTH-RECOVERING branch is satisfied by
its *"and/or"* clause on mass points, which is measured and unambiguous (§2, §3). This leg is
declared **INDETERMINATE** rather than claimed null — the cohort's edge is unmeasured, not
measured-zero, and §4's composition is evidence about *what the cohort is*, not about its outcomes.

---

## 6. Two defects in the wave's own gate

1. **AC1 / the Verification Gate misfires in the primary checkout.** It runs
   `git diff origin/main -- src/tools/get-trade-call.ts` in `/Users/tank/code/crypto-quant-signal-mcp`,
   whose `main` was **27 commits behind `origin/main`** (clean tree; `git rev-list --left-right
   --count HEAD...origin/main` → `0  27`). The diff is non-empty **from the lag alone**, so the gate
   returns `ASYM_RED_ENGINE_TOUCHED` for a wave that touched nothing. This wave evaluated it in a
   worktree at `HEAD == origin/main`, where it is correctly empty. A gate asserting "this wave
   changed nothing" must diff against `HEAD` (what the tree actually is) and separately assert
   ancestry — never against a remote the working tree is not on.
2. **AC5's ban-grep fires, and the only thing it matches is this artifact describing the ban-grep.**
   Measured, not predicted. Final state: the gate's pattern matches **exactly two lines, both in
   this section**, and both are provably non-violating —

   | line | text | why it is not a violation |
   |---|---|---|
   | 304 | *"**No argument in this artifact uses PFE as a measure of directional edge**"* | the **denial** of the banned construct. The ban-grep matches its own negation |
   | 313 | the `grep -inE 'pfe.{0,40}(…)'` literal in the remediation snippet | the pattern quoting itself |

   **Zero matches in the provenance quotes, and zero in any argument.** Verified positively rather
   than by absence: `"PFE/MAE analysis showed"` and `"3.17pp PFE-WR"` are present (1 and 2
   occurrences), and **0** of the ban-grep's matches are either of them.

   The verbatim historical quotes AC2 requires pass cleanly, for two reasons worth recording so the
   next wave does not re-derive them: the pattern's alternation ends in `shows`, which does not
   match `"…analysis showed 97% SELL signals"`; and `"+3.17pp PFE-WR, below +5pp KEEP threshold"`
   carries no trigger word within its 40-character window. So the predicted collision with
   provenance did not occur — the collision is **purely self-referential**.

   This is the repo's already-codified law in a new substrate: *"strip comments before grepping
   source for a banned construct … the explanatory prose is the most valuable line in the file and a
   naive grep demands its deletion"* (CLAUDE.md, from `OPS-TEST-GATE-RECONCILE-W1`). There it was a
   script docblock quoting a banned form; here it is audit prose quoting a banned pattern. The fix
   is the same one `scripts/check-canaries-wired.mjs` and `scripts/check-claudemd-claims.mjs`
   already apply: strip fenced blocks, block quotes and `_( … )_` correction blocks before
   ban-grepping. **No argument in this artifact uses PFE as a measure of directional edge** — every
   appearance is a quotation of, or a statement about, what a prior wave asserted.

   **Documented relaxation** (per CLAUDE.md "fact-honest gate relaxations beat false GREEN"): the
   gate is recorded RED on its verbatim form with the three matched line numbers, and GREEN under
   the strip-then-scan form below. Both results are reported; neither is suppressed.

   ```bash
   # strip fenced blocks + block quotes + _( … )_ corrections, then apply the same ban pattern
   sed -e '/^```/,/^```/d' -e '/^>/d' "$A" | grep -inE 'pfe.{0,40}(edge|skill|accuracy|proves|shows)'
   ```

---

## 7. Verdict and recommendation

**VERDICT: ARTIFACT, NOT WORTH RECOVERING**

- It **was** compensation — designed, stated, and aimed at a BUY-share target (§1).
- Its justifying differential fell below its own pre-declared keep-bar in May 2026, and the
  remediation for that has been armed and dark ever since (§1).
- **But** every SELL-side candidate crosses the −55 atom: 19× at the nearest point, 230× at
  symmetric-40 (§2, §3).
- And the cohort a relaxation admits is 95–99% volume-floor / RSI-neutral rows, against 10.8% in
  what is emitted today (§4).

**Recommend no change to `SELL_THRESHOLD_GATED`.** It stands — *not* because the asymmetry is
justified, which it has not been since 2026-05-28, but because no reachable candidate exists.
Previously ratified in **`SIGNAL-CLOSEDBAR-FLIP-W1` Q4** and in
**`OPS-CLOSEDBAR-RECALIBRATE-READINESS-W1`**'s out-of-scope table; `OPS-CLOSEDBAR-DIRECTIONAL-BALANCE-W1`
made it a third. This is a fourth, on narrower grounds and with the provenance corrected.

**Not recommended: symmetric-40.** It buys a 1.0:1 ratio by emitting 55,439 SELLs drawn
overwhelmingly from the degenerate population.

### For the architect, ranked

| # | Lever | Why |
|---|---|---|
| 1 | **`EMIT_BOOK_LIVENESS_MODE=enforce`** | The lever that actually moves the balance, now with a second independent reason: **88% of the live SELL book is HTX + XT**, the two dead-book venues. Live user-visible emission change on the paid surface — architect's call, not a wave's |
| 2 | **Close `ENABLE_R4_RELAX`** | Ratified 2026-05-28, implemented, armed with `sell-revert`, dark ~10 weeks. Enable it or retire it. A ratified decision sitting unexecuted is standing debt, and it is the *live* remnant of the same R4 change this artifact is about |
| 3 | **HTX / XT venue quality** | 88% of SELL emission from the two worst-liveness venues is a coverage question, not a threshold one |
| 4 | **The unwired symmetric design** | `b671c52`'s regime-conditional gating was deliberately removed by R4, not lost. Reinstating it is a real option and a different question from moving a constant — and cannot be taken while the −55 atom exists |

**🛑 HALT. No constant moved. No flag flipped.**

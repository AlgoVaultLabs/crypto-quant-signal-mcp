# RUNBOOK — emit-time book-liveness gate flip

_`OPS-PFE-METRIC-INTEGRITY-W1` shipped the gate DARK. This runbook is the mechanical two-stage
flip a separate Mr.1 dispatch executes. **No calendar-anchored activation** (ruling F3) — the flip
is a pre-registered checklist plus a Mr.1 one-liner, never a date._

## What flips

`get_trade_call` stops emitting a directional call into a **book that is not trading**. A book is
live ⇔ **≥ 12 of its last 24 bars carry `volume > 0`**. A frozen book yields **HOLD**.

Unchanged: response shape, fields, quotas, pricing, tool descriptions, thresholds, the funding
adjustments, and every scoring path. `rawScore` and `confidence` are still the true computed
values — only the ACTION is withheld, and the suppression is explained in `scoreAdjustments`.

**A suppressed emission becomes a HOLD, not a void.** That is load-bearing: `totalGenerated =
totalCalls + totalHolds` (`index.ts:4274`), so a vanished emission would silently shrink the
published hold-rate denominator. HOLD keeps `totalGenerated` invariant and moves the mass
correctly.

## Why (the defect being fixed)

Several venues emit a **zero-volume synthetic flat candle** (OHLC all equal, `volume = 0`) for a
non-trading book rather than omitting the bar. When an evaluation window lands inside such a
stretch, the PFE evaluator scores `pfe = mae = 0` and the canonical predicate records it as a
**LOSS**. A market that was *shut* is booked as a call that was *wrong*.

Measured (contemporaneous era, 2026-07-19): **1,041** such rows — **BUY 0.108% vs SELL 14.654%**,
a **135× directional asymmetry** that is an artifact of *where* we emit, not of edge.

This is the **generator-level** fix. The lane-level fix (excluding those rows at scoring time) is a
separate deliverable of the same wave; the universe-construction fix — `seed-signals.ts` admits
books by quote-currency suffix alone — is deferred to `OPS-SEED-UNIVERSE-LIVENESS-W{NEXT}`.

## The predicate is venue- and asset-class-AGNOSTIC (do not "improve" this)

It reads bars and volume. Nothing else. **No** asset-class classifier, symbol list, market-hours
logic, or venue name — a committed canary greps the executable code and fails the build otherwise,
and is proven non-vacuous against a planted violation.

- Tokenized equity / commodity / FX perps **STAY** (ruling C1). TradFi is a first-class ICP tier.
- Thin **crypto** alts fail the same predicate identically: on ASTER, `KNC · STX · API3 · AEVO ·
  1000SATS · SLP · OKB · BB` measured **0–2** genuine bars of 24 at 1h.
- The **same tickers** on BINANCE/BYBIT measured **24/24**.

The dead thing is always the `(venue, symbol)` **book**. "Equity ⇒ suppress" is a category error
and a Data Integrity violation — it would cut a live tier's corpus on a false premise.

## The pin: k = 12 of N = 24

Measured, not chosen. Live replay (2026-07-19, from Hetzner):

| k | KUCOIN | MEXC | BINANCE | GATE | ASTER |
|---|---|---|---|---|---|
| 2 | 0.0% | 0.0% | 0.0% | 0.0% | 13.5% |
| 6 | 0.0% | 0.0% | 0.0% | 0.0% | 18.9% |
| **12 (pin)** | **0.0%** | **0.0%** | **0.0%** | **0.0%** | **27.0%** |
| 14 | 0.0% | 0.0% | 0.0% | 0.0% | 35.1% |
| 18 | 0.0% | **2.3%** | 0.0% | 0.0% | 37.8% |
| 20 | 0.0% | **2.3%** | 0.0% | 0.0% | 45.9% |

Two constraints keep k well below N, and a tuner must preserve both:

1. **The last bar is the current still-forming candle** and legitimately reads `volume = 0` for
   moments after it opens. A pin near N turns that benign zero into a false suppression at every
   bar boundary, on every book.
2. **Margin below the worst healthy observation** — measured healthy floors: KUCOIN 24/24,
   BINANCE 23/24, GATE 23/24, **MEXC 16/24**. k=12 leaves ~4 bars. **At k ≥ 18 MEXC starts falsely
   suppressing that 16/24 book** — so the once-proposed `k ∈ [14,20]` is NOT safe.

**Do not raise k without re-measuring.** Revisit is tied to the R4 partial-freeze measurement, not
to a date.

## Expected blast radius

Fleet-aggregate ≈ **3.6%** of emissions at k=12. Venue-concentrated:

- **ASTER ≈ 27%** — **INTENDED and acknowledged in writing** (ruling Q3, 2026-07-19): *"those are
  calls into books with 0–2 real bars/day — unactionable even under 'perps trade 24/7'. Emission
  curve bends honestly; hold_rate rises; C1 (keep equities) intact."* ASTER is a top-2 emitter
  (~11.4% of last-7d), so this IS visible on the forward emission curve. That is the point.
- Every healthy venue measured **0.0%**.

`hold_rate` (live 99.1) moves **UP**, because suppressed emissions become HOLDs.
`totalCalls` growth **slows** — it never decreases, so the `FLOOR` drift canaries stay green.

## Shadow-window alert exception — PRE-DECLARED, DATED, and NOT ACTIONABLE

_Declared before the flip by `EDGE-SELL-RESOLUTION-ASYMMETRY-W1` (architect ruling Q2, 2026-08-25)._

**Window: shadow flip `2026-08-25` → `2026-09-08` (14 days).** Inside it, the breach below is
**EXPECTED AND LOGGED**. Do **not** act on it, do **not** silence it, and do **not** tune any
threshold while it is open — a threshold moved during the test destroys the test. On `2026-09-08`
this exception **EXPIRES**: a row still breaching then is a real debt and needs a real decision.

| what breaches | where | why it is expected |
|---|---|---|
| `PENDING_STALE` on `book-liveness-canary` | `monitoring-inventory-reconcile.py`, daily `57 6 * * *` UTC — so first fire **2026-08-26 06:57 UTC** | Its `blocked_on` is `container_env EMIT_BOOK_LIVENESS_ENABLED / met_when: truthy`, and the reconciler breaches **immediately at any age** the moment a blocked condition is MET. Setting `ENABLED=1` for SHADOW meets it. |

**The condition is keyed on the wrong variable, and that is a finding, not something to patch
mid-soak.** This canary's own row says its checks "BOTH presuppose the gate is ENFORCING", but
`ENABLED=1` is equally true in shadow — `MODE` is what separates the two stages. A two-stage
rollout observed through a one-bit flag is the same defect class this wave already fixed in the
AOE digest footnote. Re-keying it to `EMIT_BOOK_LIVENESS_MODE` needs a `met_when` that can compare
a VALUE (`met_when: truthy` accepts only `{1,true,yes,on}`, so neither `shadow` nor `enforce`
would ever satisfy it, and the row would be blocked forever). That work belongs to
**`EDGE-SELL-RESOLUTION-ENFORCE-W{NEXT}`**, which installs the canary and ratchets its ceilings
anyway — not to a mid-test edit.

> **RESOLVED — `EDGE-SELL-RESOLUTION-ENFORCE-W1` CH1, 2026-08-28. The re-key was NOT done, and
> deliberately so; `blocked_on` was DELETED instead** (architect ruling Q3).
>
> The instruction above is correct about the defect and wrong about the remedy, and the reason is
> worth keeping rather than overwriting: **installing the canary dissolves the question.**
> `monitoring-inventory-reconcile.py`'s `PENDING_STALE` check reads only rows whose
> `install_state` is `pending` or `unclassified` (`check_pending_stale`, the `continue` at the top
> of its loop). Once CH1 sets `install_state: installed` there is no pending clock left for a
> `blocked_on` to suppress, so a re-key would have added a value-comparing `met_when` kind to the
> reconciler that **nothing would ever consume** — a new mechanism built for a code path that no
> longer runs. A stale `blocked_on` on an `installed` row is dead config, and dead config is what
> the next wave "fixes" back into existence.
>
> The MODE-vs-ENABLED distinction the finding identified is real and is now handled where it
> belongs — inside the canary, which resolves the live stage through a mirror of the shipped
> `getBookLivenessMode()` and scopes both its ceiling table and its `emit_suppressions.reason`
> filter by it. The one-bit view is gone; it was just never the inventory row's job to fix.

Ratchets deliberately NOT done in the shadow wave, for the same reason (ruling Q2): the runbook's
Stage-2 8-box bar, and `ops/monitoring/book-liveness-canary.py`'s `SUPPRESSION_CEILING_PCT` /
`FROZEN_CEILING_PCT`. Rewriting an acceptance bar *before* the soak that is meant to supply its
evidence is circular. The shadow window produces the evidence; the enforce wave sets the bar.

> **DISCHARGED — `EDGE-SELL-RESOLUTION-ENFORCE-W1` CH2, 2026-08-28.** Both ratchets are done and
> the `PENDING_STALE` breach is cleared **at the cause** (the row is installed, not muted), so
> this exception closes ahead of its 2026-09-08 expiry rather than lapsing. `FROZEN_CEILING_PCT`
> is now MODE-KEYED — a shadow table that tolerates the defect the gate is not yet removing, and
> an enforce table that ratchets to 1% fleet-wide — so the "ratchet at enforce" step is
> structural and no longer a checklist item anyone can forget. `SUPPRESSION_CEILING_PCT` was not
> ratcheted but RETIRED: it divided an `emit_suppressions` numerator by a deduped `signals`
> denominator, two different populations (measured: 29 `(venue, coin, timeframe)` cells carried
> suppressions with zero in-window signal rows). Its replacements are the dead-book persistence
> discriminator and a report-only volume floor.

## Stage 1 — SHADOW (mandatory; produces the evidence for stage 2)

```bash
ssh -i ~/.ssh/algovault_deploy root@204.168.185.24
cd /opt/crypto-quant-signal-mcp
# append (never inline a secret; never `docker compose restart` — it does NOT reload env_file)
printf '\nEMIT_BOOK_LIVENESS_ENABLED=1\nEMIT_BOOK_LIVENESS_MODE=shadow\n' >> .env
docker compose up -d mcp-server
docker exec crypto-quant-signal-mcp-mcp-server-1 env | grep EMIT_BOOK_LIVENESS   # verify BOTH keys
```

In `shadow` the verdict is **untouched** — `bookLive` is left undefined, so emissions are
byte-identical to legacy — but every would-be suppression is counted. That is what makes the
shadow report trustworthy: the same code path produces both the shadow rate and the live rate.

**Soak ≥ 72h**, then read the counter:

```bash
ssh -i ~/.ssh/algovault_deploy root@204.168.185.24 \
  'docker exec crypto-quant-signal-mcp-postgres-1 psql -U algovault -d signal_performance -c "
     SELECT date, exchange, SUM(suppress_count) AS suppressed
     FROM emit_suppressions GROUP BY 1,2 ORDER BY 1 DESC, 3 DESC;"'
```

## Stage 2 — pre-flip bar (mechanical; every box must be ticked)

- [ ] **Shadow soak ≥ 72h** with both keys confirmed live in the container env.
- [ ] **Per-venue suppression COUNTS published** — daily timeseries, per venue AND per timeframe.
      Aggregates mask displacement; a single fleet number is not sufficient.
      **Every figure carries its INSTRUMENT and denominator** (architect ruling Q1, 2026-08-28).
      Two instruments exist and they are not interchangeable — quoting either bare is what put a
      wrong prohibition into a dispatched spec:
      | figure | instrument | window | denominator |
      |---|---|---|---|
      | fleet **0.799%** | live `emit_suppressions` counter | 3d | 80 / 10,007 |
      | fleet **1.375%** | counterfactual replay (`frozen-window-attribution.ts`) | 30d | 1,384 / 100,688 |
      Calibrate the canary's own ceilings on the **live counter** — the instrument the canary
      runs. A ceiling set from the replay would be a cross-instrument comparison.
- [ ] **No `(venue, coin)` classified as a DEAD BOOK outside the known five.**
      _(Re-baselined by `EDGE-SELL-RESOLUTION-ENFORCE-W1` CH2, replacing **"every healthy venue
      ≤ 1%"**. That box was written against a suppression RATE now retired as ill-defined — see
      `WHY_THE_RATE_WAS_RETIRED` in the canary. Measured 2026-08-28T16:16Z on the LIVE
      `emit_suppressions` counter, 3d window: XT **6.14%** · HTX **5.32%** · ASTER **5.08%** ·
      GATE **0.29%** · 12 other venues exactly **0.00%** — the old box FAILS on four venues today
      and would have failed on the night of the flip.)_
      The bar is now structural, not a percentage: a `(venue, coin)` suppressed on ≥ 24 of the
      last 28 days is a **dead book**; anything recovering inside the window is a **closed
      market**, which is correct behaviour. Known dead books at re-baseline: `XT|D`, `XT|EPT`,
      `HTX|LRDS`, `HTX|SEI`, `HTX|VIRTUAL`. **A NEW one appearing ⇒ STOP and investigate the
      adapter** — that is the parse-defect signal the old box was reaching for.
- [ ] **The closed-market population still recovers.** _(Replaces **"ASTER within ~5pp of the
      measured 27%"**. ASTER measures **5.08%**, 21.9 pp below the old box, because the frozen
      population MIGRATED onto XT and HTX — so the old box FAILS on correct behaviour.)_ Confirm
      the ASTER + GATE suppressions are single-day and spread across many symbols (measured: 29
      `(venue, coin)` pairs at exactly 1 day each), not persistent on a few.
      **Note the composition — it is the most user-visible enforce consequence.** ASTER is MIXED:
      ~10 tokenized equities (`SPY RTX QCOM MRNA EBAY SOXL BMNR BARD AIOT SKHYNIX`) and ~11 thin
      crypto alts (`SAND POL THETA TLM VANA DOGS MANTA YB FF DRAM EDGE`). GATE is entirely
      equities, largely Chinese A-shares (`BIWIN NAURA HUAGONGTECH PUYA XIECHUANG YONGDING REGN
      NET`). Ruling C1 intact — but state this consequence explicitly BEFORE flipping.
- [ ] **No suppression on a book a human would call liquid.** Spot-check the top-10 suppressed
      `(venue, symbol)` pairs by hand against live venue data.
- [ ] **`totalCalls` still monotonic** (`/api/performance-public`) — the FLOOR canaries green.
- [ ] **On-chain ↔ dashboard equality canary green**:
      `totalCalls >= Σ /api/merkle-batches.signal_count`. _(Note: that endpoint returned exactly
      100 batches at C1 — confirm whether it paginates before treating the sum as tight.)_
- [ ] **Explicit Mr.1 ack recorded in status.md.** This changes public emission behaviour, so it
      needs explicit permission per LAW — a green checklist is necessary, not sufficient.

## Stage 3 — ENFORCE

```bash
ssh -i ~/.ssh/algovault_deploy root@204.168.185.24
cd /opt/crypto-quant-signal-mcp
sed -i 's/^EMIT_BOOK_LIVENESS_MODE=shadow$/EMIT_BOOK_LIVENESS_MODE=enforce/' .env
docker compose up -d mcp-server
docker exec crypto-quant-signal-mcp-mcp-server-1 env | grep EMIT_BOOK_LIVENESS
```

## Rollback (instant, one key, no rebuild)

```bash
ssh -i ~/.ssh/algovault_deploy root@204.168.185.24
cd /opt/crypto-quant-signal-mcp
sed -i 's/^EMIT_BOOK_LIVENESS_ENABLED=1$/EMIT_BOOK_LIVENESS_ENABLED=0/' .env
docker compose up -d mcp-server
```

The kill switch dominates the mode: with `ENABLED` unset or `0`, `EMIT_BOOK_LIVENESS_MODE=enforce`
still resolves to `off` and behaviour is byte-identical legacy. Rolling back does **not** require
touching `MODE`, and a partial rollback is impossible.

**Fail-safe defaults you can rely on:** enabled-with-garbage-mode resolves to **shadow**, never
enforce — turning the switch on cannot start suppressing on a typo. The predicate itself fails
**OPEN** (treats a book as live) on empty input or a window shorter than k, so a probe failure can
never silence a healthy venue.

## Post-flip watch (first 24h)

| signal | where | meaning |
|---|---|---|
| `emit_suppressions` daily rows | prod postgres | the rate is real, per venue |
| `hold_rate` | `/api/performance-public` | should rise; NO LONGER ALERTED — `DOCS_HOLD_RATE_DTRF_BAND` was retired 2026-08-10 by HOLD-DEEMPHASIS-SWEEP-W1 with the rendered stat. The API field is unchanged; watch it manually |
| `totalCalls` | `/api/performance-public` | must keep rising — a DECREASE is a Data Integrity event |
| `HOMEPAGE_HOLD_RATE_DTRF_BAND` | `website-drift-manifest.yaml:159` | may fire on a >3pp hold-rate move — expected, not a defect |
| new S2 rows | `signals` | should trend toward zero for freshly emitted signals |

## What this does NOT do

- It does **not** change any historical row. Existing S2 rows stay exactly as they are; the
  historical recompute is deferred to `OPS-PFE-HISTORICAL-RECOMPUTE-W{NEXT}`, gated on R4.
- It does **not** change the published PFE WR definition or lower the headline.
- It does **not** touch public copy. "PFE win rate" is really a favourable-excursion rate; that
  honesty fix is `OPS-PFE-COPY-HONESTY-W{NEXT}`.
- It does **not** remove any asset class, venue, or symbol from the universe.

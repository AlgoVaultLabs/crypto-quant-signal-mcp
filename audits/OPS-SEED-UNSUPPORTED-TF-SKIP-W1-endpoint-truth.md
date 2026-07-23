# OPS-SEED-UNSUPPORTED-TF-SKIP-W1 — R0 endpoint-truth (Plan-Mode, read-only)

Make the cron seeder skip a `(venue, tf)` pair when the adapter can only serve it by **coarser** substitution. `claim | reality | resolution`.

- **Probed** 2026-07-23 ~06:00 UTC. **`$REPO`** `/Users/tank/code/crypto-quant-signal-mcp` @ **`4e7cb66`** == origin/main, clean (untracked leftovers only). Adapter maps re-grepped fresh; every coarsening cell live-probed (bar-spacing), not taken from the 2026-06-05 research file.

---

## A. Per-promoted-venue × per-cron-TF faithfulness matrix

Cron-seeded TFs: `3m 5m 15m 30m 1h 2h 4h 8h 12h 1d` (1m never cron-seeded). **Faithful** = native OR served from a *finer* interval (resolution not inflated). **Unfaithful** = served from a *coarser* interval (a `<tf>` WR computed on `>tf` candles). All cells not listed below are **native or finer → faithful** (verified from the maps).

### The only COARSER substitutions on promoted venues (the skip candidates):

| venue | tf | adapter maps to | served (probed) | ratio | class | evidence |
|---|---|---|---|--:|---|---|
| XT | 3m | `5m` | 5min ✓ | 1.67× | coarser-1step | `xt.ts:45` + live |
| GATE | 3m | `5m` | (map) | 1.67× | coarser-1step | `gateio.ts:40` |
| MEXC | 3m | `Min5` | 5min ✓ | 1.67× | coarser-1step | `mexc.ts:55` + live |
| HTX | 3m | `5min` | 5min ✓ | 1.67× | coarser-1step | `htx.ts:62` + live |
| PHEMEX | 3m | `300`s=5m | (map) | 1.67× | coarser-1step | `phemex.ts:59` |
| **PHEMEX** | **12h** | `86400`s=**1d** | **1440min ✓** | **2×** | **coarser — NEW, unflagged** | `phemex.ts:67` + live |
| WHITEBIT | 5m | `15m` | 15min ✓ | 3× | coarser | `whitebit.ts:51` + live |
| WHITEBIT | 3m | `15m` | 15min ✓ | 5× | coarser | `whitebit.ts:50` + live |

**Fully native (all TFs):** ASTER, BINANCE, BINGX, BYBIT, OKX, KUCOIN, EDGEX(shadow), HL. **Native 3m:** + BITGET, BITMART. → the **native-3m promoted set = BINANCE, BYBIT, OKX, BITGET, ASTER, BINGX, KUCOIN, BITMART (8)**; HL has no 3m.

**Faithful FINER substitutions (no action):** most venues serve `2h→1h`, `8h→4h`/`6h`, `12h→4h`/`8h` (all *finer* than requested → not resolution-inflating). E.g. PHEMEX 8h→4h (probed 240min ✓), BITGET 8h→6h, GATE/MEXC 12h→8h, WhiteBIT/XT 2h→1h/8h→4h/12h→4h. **These stay.**

### Current seeding of the coarsening cells (what a skip removes from the public byTimeframe):
- **3m→5m class (XT/GATE/MEXC/HTX/PHEMEX)** — all currently seed 3m (3m line `--top 15 --status promoted --exclude HL,WHITEBIT` = 13 venues). Skipping → 3m coverage **13 → 8** venues (only native-3m).
- **PHEMEX 12h** — currently seeds 12h (12h line `--status promoted --exclude HL`). Skipping → PHEMEX loses public 12h.
- **WhiteBIT 3m/5m** — already excluded via the OPS-VENUE-GO-LIVE-15-W1 hack (`--exclude HL,WHITEBIT` on 3m+5m); the predicate replaces the hack.

---

## B. R1 — the single-derivation seam

| Claim | Reality | Resolution |
|---|---|---|
| A faithful-interval set exists to read | **NO adapter exports its interval map** (grep for `export … INTERVAL/STEP/MAP` = 0 hits). Maps are private `const` + **heterogeneous units**: string-tf (`'15m'`,`'1H'`), venue enums (`'Min5'`,`'15min'`,`'MINUTE_15'`), minutes-number (bitmart/kucoin `5`), seconds-number (phemex `300`), ms-number (hl/okx/edgex/bitget `300_000`). A raw number `300` is ambiguous (min vs sec vs ms) → a shared parser over raw maps CANNOT work. | Each adapter must **export a served-interval-in-ms** derived from its own map (it owns the unit). `tf-support.ts` compares `servedMs(venue,tf)` vs the requested `TF_MS[tf]` and applies the ONE rule. |
| Requested-tf duration | `src/lib/pfe-mae.ts:52 export const TF_MS` + `candle-guard.ts:36 intervalMsFor(tf)` already give it. | Reuse `TF_MS` for the requested side. |
| Seam options | (i) each adapter `export servedIntervalMs(tf)` derived from its `INTERVAL_MAP` + unit — cleanest single-derivation, ~15 small edits; (ii) each adapter exports a `faithfulTimeframes` Set — **REJECTED, that IS a hand-maintained matrix** (SOP lesson #10); (iii) tf-support centralizes per-adapter unit tables — drift risk. | **Recommend (i).** The predicate stays dumb (compare durations + apply the rule); the faithful SET is *computed*, never hand-listed. |

---

## C. R3 — the seeder guard seam

`seedOneVenue(venueId, opts)` (`seed-signals.ts` ~894): destructure `timeframe` (895) → `recordSeedHeartbeat(venueId, timeframe)` (**901**) → universe fetch (908) → `seedExchange` (925). The existing error-path skip (`seedExchange` catch, `InsufficientCandlesError`/`insufficient liquidity`/`not found` → `skipped++`, 793-795) stays (defence in depth — venues that THROW on an unsupported interval are already clean).

**Guard placement — BEFORE `recordSeedHeartbeat` (line 901), NOT after:** a skipped unfaithful TF must NOT stamp a heartbeat. WhiteBIT's 5m line fires every 5 min; if it stamped a heartbeat then skipped, its freshness would look ≤5 min old and **MASK the 45-min SLA** if WhiteBIT's real 15m line broke. Guard before the stamp → WhiteBIT's freshness comes only from its faithful (15m) lines. So:
```
// at seedOneVenue top, after `startedAt`, BEFORE recordSeedHeartbeat:
if (!isTimeframeFaithful(venueId, timeframe)) {
  console.log(`[${ts()}] [${venueId}] tf=${timeframe} SKIP — unfaithful (adapter would coarsen ${timeframe}→${servedLabel(venueId,timeframe)})`);
  return { venueId, seeded: 0, skipped: 0, errors: 0, durationMs: Date.now() - startedAt, failed: false };
}
```

---

## D. R6 — public-surface impact

`system-map.md updated:` **Y** iff a promoted venue's skip changes a public `byTimeframe` edge → **PHEMEX 12h skip is exactly that** (a coverage reduction). Dashboard-change LAW → operator sign-off in the Q-set below before shipping.

---

## E. Architect Q-set — HALT for ratification (see chat fenced block).

Status: awaiting architect ratification of the faithful RULE + the PHEMEX-12h coverage change + the R1 seam before R2.

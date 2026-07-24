# OPS-BASIS-RETRO-BACKFILL-W1 — endpoint-truth + R1 census

**Probed:** 2026-07-24 ~13:40–15:15 UTC · **Host:** 204.168.185.24 (all venue curls host-side — the
authoring Mac is TCP-blocked by Binance/Bybit/KuCoin) · **Repo:** `crypto-quant-signal-mcp`, worktree
`ops/basis-retro-backfill-w1` off `origin/main@634abf6`.

**Plan-Mode outcome: 🛑 HALT (1 fictional primitive + 2 identifier/count drifts + 1 blocking
pre-registration ambiguity). Cleared 2026-07-24 — architect ratified all 4 questions (below). Premise
CONFIRMED: 7 venues serve deep (≥365d) 1h mark+index klines; basis is reconstructable.**

---

## 0 · Ratified architect decisions (2026-07-24 — logged verbatim)

- **Q1 (b) — RATIFIED SUB-AMENDMENT.** The B-DIR v3 **DIAGNOSTIC** runs on `{funding, OI, basis}` once
  EACH has ≥90d of data (floor = OI, **~2026-09-19**); **SPREAD is explicitly reserved for the FULL
  test** (2027-01-17, unchanged, all classes ≥180d). On the record: the diagnostic is a report-only
  ablation whose purpose is speed-of-learning; spread is forward-only by physics, and holding a
  non-promotable report hostage to the one class that cannot accrue faster serves no integrity
  purpose. **The diagnostic report header MUST state the spread exclusion.** The one-shot full test is
  untouched and still includes spread at full age.
- **Q2 — APPROVED.** `migrations/023` `ADD COLUMN source TEXT` (nullable); existing ~397k rows stay
  NULL (= live/pre-source, documented); NEW `recordRetroBasisSnapshots` writer; live
  `recordOiSnapshots` byte-unchanged; VIEW gains `source`.
- **Q3 — CONFIRMED 15 venues.** "current universe" = today's top-`RANK_OI_SAMPLE_POOL` (60) per venue
  snapshot across all probed venues; historically-unlisted symbols yield shorter honest history,
  counted, never padded.
- **Q4 — CONFIRMED 400d cap** (covers the 180d full test with wide margin). Deeper = a one-env re-run
  later — the DB-as-checkpoint design makes extension cheap (recorded here per the ratification).
  Detached `flock`'d host-side job with DB-checkpoint resume: YES (the deploy-kill lesson applied).

---

## 1 · Spec-primitive probes — `claim | reality | resolution`

| # | Claim | Reality (live-probed) | Resolution |
|---|---|---|---|
| 1 | write `source='retro-basis'` | `oi_snapshots` had **9 cols, no `source`** (`information_schema`) | **migration 023** ADD COLUMN source TEXT (pre-applied on prod 2026-07-24, verified; 399,067 rows → source NULL) |
| 2 | "current universe" | **15 venues live**, not 12 — BITMART/WHITEBIT/XT added ~2026-07-23 | Q3 ratified: snapshot today's top-60 per venue across all probed venues |
| 3 | column `venue` | physical column is `exchange`; view aliases `exchange AS venue` | write `exchange`; report says "venue" |
| 4 | venues serve historical mark+index 1h klines | **7 confirmed DEEP ≥365d** (OLDEST bar landed at the requested date, not recent-only) | reconstruction set = the 7 |
| 5 | basis `(mark−index)/index×1e4` | reuse `oi-snapshots.ts::basisBps` (single derivation); native premium/basis = cross-check only | `recordRetroBasisSnapshots` computes via `basisBps` only |
| 6 | paced/checkpoint/`--check`/never-retry-418 | shared `upstreamFetch` (batch lane + 418/429 never retried) exists; **no mark/index kline fetcher existed** | NEW `retro-basis-sources.ts` + `retro-basis-backfill.ts` |
| 7 | "~1 AI session" | 400d = **~25–28k paced calls** (OKX/Bybit/Bitget small page limits dominate: OKX 100/pg, Bybit/Bitget 200/pg) | detached host `flock`-cron lanes; multi-hour wall-clock |
| 8 | pull the diagnostic forward | spread forward-only anchors Oct 19 UNLESS excluded | Q1(b): exclude spread from the diagnostic → floor = OI ~**2026-09-19** |

## 2 · R1 venue census — historical mark/index kline (1h) reconstructability (all 15 probed, zero assumed)

| Venue | mark-kline | index-kline | Depth | Verdict |
|---|---|---|:--:|---|
| BINANCE | `fapi/v1/markPriceKlines?symbol=` | `fapi/v1/indexPriceKlines?pair=` | ≥365d | ✅ reconstruct |
| BYBIT | `v5/market/mark-price-kline` | `v5/market/index-price-kline` | ≥365d | ✅ reconstruct |
| OKX | `v5/market/history-mark-price-candles` | `v5/market/history-index-candles` | ≥365d | ✅ reconstruct |
| BITGET | `v2/mix/market/history-mark-candles` | `v2/mix/market/history-index-candles` | ≥365d | ✅ reconstruct |
| GATE | `candlesticks?contract=mark_*` | `contract=index_*` | ≥365d | ✅ reconstruct |
| ASTER | `fapi/v1/markPriceKlines` (asterdex) | `fapi/v1/indexPriceKlines` (asterdex) | ≥365d | ✅ reconstruct (proxy-OI; basis real) |
| MEXC | `contract/kline/fair_price/{sym}` | `contract/kline/index_price/{sym}` | ≥365d | ✅ reconstruct |
| HL | candleSnapshot = TRADED (`[]`@365d, caps ~208d) | — none | — | ❌ no index/oracle kline (physics) |
| HTX | `mark_price_kline` rejects symbol; `index_kline` 404; only `swap_premium_index_kline` (native premium) | — | — | ❌ no canonical pair (premium≠derivation LAW) |
| PHEMEX | kline `code 30001` throttled from prod egress | throttled | — | ❌ no reachable historical kline |
| KUCOIN | `kline/mark/query` 404 (traded-only) | — | — | ❌ no historical mark/index kline |
| BINGX | `markPriceKlines` ✅ ≥365d | `indexPriceKlines` 404 (v3=traded) | — | ❌ mark only — no index-price kline |
| BITMART | `markprice-kline` exists; OI-only live (basis=0) | unconfirmed | — | ❌ new venue; no index kline |
| WHITEBIT | traded kline only; OI-only live (basis=0) | — | — | ❌ new venue; no mark/index kline |
| XT | `mark-kline` 404 | `index-kline` 404 | — | ❌ traded-only |

**7/15 reconstructable. HL excluded by physics; the other 7 lack a canonical mark+index kline pair.**

## 3 · Recomputed clock under the ratified sub-amendment (per feature class)

| Class | 90d-of-DATA reached | Reconstructable? |
|---|---|---|
| funding | already | n/a |
| OI | **~2026-09-19** (oldest 2026-06-21; forward-only, ~30d history cap) | no |
| basis | **already, after R2** (≥365d on 7 venues) | ✅ |
| spread | 2026-10-19 (forward-only) — **reserved for the FULL test only** | ❌ order books |

**⇒ B-DIR v3 DIAGNOSTIC earliest honest date = OI-bound ~2026-09-19** (≈30d earlier than the prior
Oct-19, spread-anchored date), because Q1(b) excludes spread from the diagnostic. FULL test unchanged
2027-01-17. The diagnostic report header MUST state the spread exclusion.

## 4 · Data-Integrity & serving safety (probed CLEAN)

- `basis_bps`/`mark_price`/`index_price` have **NO live consumer** (B-DIR v3 is the pre-registered
  future consumer) ⇒ writing retro rows cannot corrupt any serving path.
- OI consumers (`computeOiDelta`, `computeOiDeltaForPool`, oiscore-shadow) guard `AND oi IS NOT NULL`
  + a ≤~26h read window ⇒ retro rows (oi NULL, old ts) are invisible to them.
- `recordRetroBasisSnapshots` ON CONFLICT (exchange, symbol, ts) DO NOTHING ⇒ a live row ALWAYS wins;
  re-runs idempotent. Retention is PERMANENT (`pruneOiSnapshots` throws on finite) ⇒ never pruned.

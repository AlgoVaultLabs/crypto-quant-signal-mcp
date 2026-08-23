# OPS-AOE-RECOMMENDATION-READ-W1 — endpoint truth

**Wave:** `OPS-AOE-RECOMMENDATION-READ-W1` (Tier 1, READ-ONLY, META tier)
**Executed:** 2026-08-23, single session, sequential.
**Probed at:** `crypto-quant-signal-mcp` `origin/main` = `a877f09`; `autonomous-optimizer` `origin/main` = `16cd475`.
**Clocks (read in one call, per the clock-read rule):** Mac `2026-08-23T03:34:43Z` · aoe-1 `2026-08-23T03:36:10Z` · signal-1 `2026-08-23T03:44:07Z`. No skew.

## Verdict

```
AOE_READ_VERDICT=DORMANT
```

Nothing is in Redis. The last `algovault:aoe:recommended_weights:*` payload was published
**2026-07-26T21:35:03Z** (age **27d 6h**); the last write of *any* kind to the AOE Redis was the
final TTL expiry at **2026-07-27T22:35:04Z** (age **26d 5h**). Per the wave's own stop rule
(R1: *"If AOE has not written in weeks, that is the answer and R3–R5 are moot"*),
**R3, R4 and R5 were NOT executed.** R1 and R2 are complete; AC3 was answered against real
historical payloads rather than the docblock.

This file carries structure, census, grammar and cadence only. It contains **no weight values,
no edge figures and no deltas** — there are none to carry, and the repo is public.

---

## Step 0 — primitive probes (`claim | reality | resolution`)

| # | Claim (from the dispatch or from code) | Reality | Resolution |
|---|---|---|---|
| 1 | AOE checkout at `/Users/tank/code/autonomous-optimizer` | **PRESENT**, `main` = `16cd475`. `/Users/tank/autonomous-optimizer` **ABSENT** | ✅ dispatch correct; the pre-reorg path is dead |
| 2 | `src/lib/aoe-config-reader.ts` ships complete | **236 lines**, exports `readAoeConfig` + 3 test seams | ✅ |
| 3 | Imported by nothing but its own test | **0** `import`/`require` statements under `src/`. Only importer anywhere: `tests/aoe-config-reader.test.ts:44` | ✅ |
| 4 | `WEIGHTS` is a module-private literal at `get-trade-call.ts:75-81` | Exact match, lines 75–81 | ✅ |
| 5 | Guard comment at `get-trade-call.ts:148-153` | Exact match | ✅ |
| 6 | `ALGOVAULT_AOE_CONFIG_SOURCE` in no committed env/compose/Dockerfile/deploy/CI | Confirmed — appears **only** in `src/lib/aoe-config-reader.ts` and its test | ✅ |
| 7 | `aoe-config-reader.ts:113` resolves `AOE_REDIS_URL ?? REDIS_URL ?? redis://localhost:6379/0` | Exact match, line 113 | ✅ |
| 8 | AOE host = `178.104.200.44`, monitored as `aoe-1` | `hostname` = `algovault-aoe-permanent`; `monitoring-inventory.json:925-946` and `recommendation-drift-manifest.yaml:25-36` both correct | ✅ |
| 9 | Publisher is `src/feedback/promote_flow.py` | Confirmed; key templates at `promote_flow.py:68` (global) and `:70` (per-venue) | ✅ |
| 10 | `verdict-mix-replay.ts:37` hardcodes its own weight copy | Exact match, line 37 (`const W = {...}`) — and it is **already exported** at line 190, so R5's "parameterise the harness" is smaller than the dispatch assumes | ✅ + note |
| 11 | Drift manifest records the AOE cross-host scan as **deferred** | Confirmed, `recommendation-drift-manifest.yaml:26-32` | ✅ |
| 12 | *(9th probe)* A recommendation census / promotion ledger / AOE-vs-shipped comparison already exists | **NO.** Neither repo has one. `crypto-quant-signal-mcp` contains only the reader + its test; `autonomous-optimizer` has `src/promotion/*` (a *gate* runner, not a census) and `src/shadow/ledger.py` (shadow fills, not recommendations) | ✅ greenfield — this file is the first census |

**Fictional primitives: 0.** No HALT. Two dispatch premises were **falsified by measurement** —
see *Falsified premises* below; a falsified premise is not a fabrication and does not count
toward the ≥3 threshold, but both change what the follow-up wave must do.

---

## Which Redis (Step 0.2)

| Question | Answer | Evidence |
|---|---|---|
| Which instance does the **publisher** write to? | `aoe-redis` on aoe-1 | `aoe-prefect-worker` container env: `AOE_REDIS_URL=redis://aoe-redis:6379` |
| Is that the instance whose keyspace is empty? | **Yes** — same instance | Its own AOF contains the historical `recommended_weights` writes |
| How is it exposed? | `127.0.0.1:6380 -> 6379/tcp` — **loopback only** (Amendment C, 2026-04-24) | `ss -lntp` on aoe-1 |
| Which instance would the **reader** read if wired today? | **`redis://localhost:6379/0` inside the signal-MCP container** — i.e. nothing | `crypto-quant-signal-mcp-mcp-server-1` has **no** `AOE_REDIS_URL`, **no** `REDIS_URL`, **no** `ALGOVAULT_AOE_CONFIG_SOURCE` |
| Is there any Redis on signal-1 at all? | **No.** No redis container, no `:6379` listener | `docker ps`, `ss -lntp` on 204.168.185.24 |

> **Consequence, and it corrects the dispatch's framing.** The gap is *not* "one import line".
> Wiring `readAoeConfig` into the scorer today would make it a **permanent no-op**: the client
> would resolve to container-localhost, fail to connect, set `_client_init_failed`, and return
> `null` for the process lifetime. Making AOE live requires the import **plus** a reachable
> Redis **plus** cross-host reachability that does not exist today (aoe-redis is bound to
> loopback on a different host). This *lowers* the accidental-wiring risk and *raises* the
> cost of the eventual `SIGNAL-AOE-WIRE` wave.

---

## R1 — Is AOE alive?

**Publisher cadence.** Prefect deployment `promote_hourly/promote_hourly`, cron `35 * * * *`,
`'paused': False`, `'active': True`, work pool `aoe-work-pool`. It is **running and COMPLETING
every hour** — the last 12 scheduled runs are all `COMPLETED`, the most recent 3 minutes before
this probe. This is not a dead scheduler.

**Liveness of the output, which is the question that matters:**

| Signal | Value | Age at 2026-08-23T03:44Z |
|---|---|---|
| Last `recommended_weights` payload published | `2026-07-26T21:35:03Z` | **27d 6h** |
| Last write of any kind to aoe-redis (final TTL expiry) | `2026-07-27T22:35:04Z` | **26d 5h** |
| Live keys matching `algovault:aoe:*` | **0** | — |
| `INFO keyspace` | **empty across every db** | — |
| `expired_keys` / `evicted_keys` since container start | **0 / 0** | — |
| `keyspace_hits` / `keyspace_misses` | **0 / 6330** | — |
| `promote_hourly` fires since the last publish | **~654**, every one publishing nothing | — |

**Why the counters are decisive rather than suggestive.** `aoe-redis` has `appendonly yes`,
`RestartCount=0`, and started `2026-08-14T09:06:08Z`. Its `dump.rdb` last saved
`2026-08-14T09:07:10Z` — one minute after boot — and `rdb_changes_since_last_save` is **0**,
so with a `save 3600 1` policy **no write command has changed the dataset in the entire
8d 18h uptime**. The AOF tells the same story from further back:
`appendonly.aof.1.incr.aof` (10,251,140 B, one continuous file since `2026-04-24`) has
`mtime = 2026-07-27T22:35:04Z` and has not been appended to since.

**"This would look identical if ___" — the alternatives, each read on its own instrument:**

| Alternative cause | Instrument | Verdict |
|---|---|---|
| Publisher writes to a *different* Redis | `aoe-prefect-worker` env + the AOF's own contents | **REFUTED** — same instance, and it holds the history |
| Data lost on a container restart | `RestartCount=0`, `aof_enabled=1`, AOF ends 07-27 | **REFUTED** |
| Keys evicted by `allkeys-lru` | `evicted_keys=0` | **REFUTED** |
| Keys silently expired during this uptime | `expired_keys=0` | **REFUTED** |
| Publisher crashed / descheduled | 12 consecutive `COMPLETED` runs, cron active | **REFUTED** |
| **H5 — measurement artifact** (I scanned the wrong instance or db) | `INFO keyspace` empty for *all* dbs; the AOF I parsed is that same container's | **REFUTED** |

**The actual cause — a closed, self-sustaining loop.** Read from the hourly logs, not inferred:

1. `AOE-EDGE-GATE-ENFORCE-W1` became binding and demoted the promoted cohort. The AOF carries
   **90 `demoted_by` markers, all with the value `AOE-EDGE-GATE-ENFORCE-W1`**, spanning
   `2026-07-24T15:38:55Z` → `2026-07-26T22:35:01Z` — 30 per day for three days, covering
   **all 30** promoted keys.
2. A demoted key is **terminal**: `_payload_is_demoted` (`promote_flow.py:153-164`) removes it
   from the refresh set, and `_mark_demoted` uses `SET … KEEPTTL` and *never* recreates an
   absent key (`promote_flow.py:136-138`). So each key drained on its own ≤25h clock. Last
   publish `07-26 21:35:03` + 25h TTL = `07-27 22:35` — **exactly** the AOF's final write.
3. With the promoted set at zero, the hourly `edge_gate` has nothing to score. Every cycle logs
   `posture=shadow enforce=1 promoted_set=0 family=0 would_demote=0/0 constant_side=0 agg_rows=0`
   and writes **no fresh verdict**.
4. The verdict snapshot `promote_hourly` reads is therefore frozen at
   `cycle_ts=2026-08-01 07:30:02Z` — **21d 20h old against a 7200 s threshold
   (`ENFORCE_STALE_SECONDS_DEFAULT`, `promote_flow.py:78`), i.e. 262× over.**
5. `_publish_allowed` (`promote_flow.py:110-115`) **fail-CLOSES on `snap.stale`**, so no NEW
   promotion can publish either. Measured directly in the 00:35 fire:
   `enforce HELD publish cid=8742f720 key=algovault:aoe:recommended_weights:WHITEBIT:BUY__15m
   venue=WHITEBIT strategy=BUY__15m verdict=ABSENT gate=stale (stays approved; no transition)`.
6. Every hour, forever: `enforce refresh-summary: refreshed_live=0 demoted_marked=0
   skipped_demoted=0 skipped_absent=30 refreshed_demoted=0 resurrected=0`.

> **Empty promoted set → starved gate → stale gate → fail-closed publish → empty promoted set.**
> This is a **one-way ratchet with no exit**, and each individual link is behaving exactly as
> designed. `AOE-EDGE-GATE-ENFORCE-W1` correctly split its outage branch (fail-CLOSED for
> creates, fail-OPEN for teardowns — the rule already in the manual). What no branch covers is
> the case where the teardown path runs to **completion**: the create path then depends on a
> gate whose only input is the state the teardown just deleted.

**`AOE_SHADOW_WRITER_STALL_PERSISTENT` firing history — it has never fired, and it never
could.** The canary is installed (`/opt/algovault-monitoring/aoe-shadow-writer-stall-canary.py`,
mode `0755`, mtime `May 28 16:30`), crontab row present and matching the inventory
(`13,18,23,28,33,38,43,48,53,57 * * * *`), and **healthy**: every 5 minutes it logs
`PROBE_OK … writer_lock_acquired=true consecutive_failures=0`. Across the current log (72 rows)
and the rotated one (3,360 rows) there is **not one alert**. Its manifest declares
`probe_type: duckdb_writer_lock_acquire`, `target_file: /data/bank_shadow.duckdb` — it probes a
**DuckDB writer lock**, a different subject entirely.

**No monitor on aoe-1 references `recommended_weights` at all.** `grep -rl` over
`/opt/algovault-monitoring/` returns nothing, and the host's full crontab is four rows: the
stall canary, `monitoring-inventory-reconcile.py`, `kernel-staleness-canary.sh`, and
`declaration-sync.sh`. Combined with the drift manifest's **deferred** cross-host scan, the
AOE publication pipeline has been dead for 27 days with **every indicator green**. This is the
third recorded sign of *an instrument pointed at the right subject measuring a different
quantity* — confident **silence** this time, after the confident zero and the confident alarm.

---

## R2 — Key census

**Live census: ZERO keys.** Not a sampling window, not a pattern miss — `INFO keyspace` is empty
for every db and `DBSIZE` is `0`. There is no TTL, size or write-time column to fill, because
there is nothing to fill it for.

The census below is therefore reconstructed from **two instruments, both named beside their
figures**, because "what AOE published" is still answerable even though "what AOE is publishing"
is empty:

* **Instrument A — `aoe-redis`'s own AOF** (`appendonly.aof.1.incr.aof`, 2026-04-24 → 2026-07-27,
  24,941 payload writes parsed). Authoritative for *what was actually written to Redis*.
* **Instrument B — `bank_shadow.duckdb`, opened read-only** (`bank_shadow_candidates`, 90 rows;
  `bank_configs`, 25 rows, all active). Authoritative for *what the publisher would write next*.

The two agree exactly: **30 distinct keys** in the AOF, **30 rows** in state `promoted`, and
`skipped_absent=30` in every hourly log line.

### The real `<strategy>` grammar — derived from keys that existed, not from a fixture

```
<strategy> ::= <SIDE> "__" <timeframe>
<SIDE>     ::= "BUY"                                   # the ONLY value, 90/90 rows
<timeframe>::= 3m | 5m | 15m | 30m | 1h | 2h | 4h | 8h | 12h | 1d
```

Full key form: `algovault:aoe:recommended_weights:[<venue>:]<strategy>`.

### Falsified premises

| Premise (dispatch / docblock / test fixture) | Measured reality |
|---|---|
| `<strategy>` is `RSI_BULL_1h` — *indicator × regime × timeframe* | **FALSE.** It is `BUY__15m` — *side × timeframe*. No indicator segment, no regime segment. `RSI_BULL_1h` appears **only** in `aoe-config-reader.ts`'s docblock and its test fixture; it has never been a live key |
| *"AOE's key space already carries the per-regime dimension the engine lacks"* | **FALSE, and worse than absent.** `bank_shadow_candidates.source_regime` is **NULL on all 90 rows**. Regime is missing from the key *and* from the data. AOE cannot supply the per-regime conditioning this arc is looking for |
| Allowed venues are `{HL, BINANCE, BYBIT, OKX, BITGET}` (`docs/redis-keys.md`, "verified live 2026-04-25") | **STALE.** 17 venues appear in the bank: the 5 documented plus **ASTER, BINGX, BITMART, EDGEX, GATE, HTX, KUCOIN, MEXC, PHEMEX, WEEX, WHITEBIT, XT**. 12 undocumented. The reader accepts unknown venues, so this is a doc defect, not a runtime one |
| — *(not claimed, but load-bearing)* | **Side is constant.** 90/90 candidates are `BUY`. **Zero `SELL` observations.** By the manual's own rule — *count the observations on the LOSING side before building any gate or A/B on a rate metric; zero means it measures coverage, not performance* — an AOE recommendation set is **one-sided by construction** and cannot answer the SELL-asymmetry question this arc is circling |

### The 30 keys that existed (last publish `2026-07-26T21:35:03Z` for every one)

All 30 were re-published on the same final tick, so `last_published_at` is identical across the
set; `first_published_at` is the key's own debut. All 30 carry a terminal `demoted_by` marker.

| Key | First published | Demoted |
|---|---|---|
| `…:BINANCE:BUY__8h` | 2026-06-12T12:34:59Z | ✅ |
| `…:BINGX:BUY__2h` | 2026-06-17T07:35:01Z | ✅ |
| `…:BITGET:BUY__12h` | 2026-05-11T13:35:00Z | ✅ |
| `…:BITGET:BUY__1d` | 2026-06-13T01:34:59Z | ✅ |
| `…:BITGET:BUY__8h` | 2026-05-11T09:35:01Z | ✅ |
| `…:BITMART:BUY__12h` | 2026-07-20T00:35:00Z | ✅ |
| `…:BITMART:BUY__2h` | 2026-06-17T07:35:01Z | ✅ |
| `…:BITMART:BUY__30m` | 2026-06-18T07:35:00Z | ✅ |
| `…:BITMART:BUY__4h` | 2026-07-15T21:35:01Z | ✅ |
| `…:BYBIT:BUY__1d` | 2026-05-13T01:34:59Z | ✅ |
| `…:BYBIT:BUY__3m` | 2026-07-22T07:35:00Z | ✅ |
| `…:BYBIT:BUY__4h` | 2026-06-20T07:35:00Z | ✅ |
| `…:EDGEX:BUY__5m` | 2026-06-17T07:35:01Z | ✅ |
| `…:GATE:BUY__15m` | 2026-06-16T07:35:00Z | ✅ |
| `…:HL:BUY__1h` | 2026-06-12T00:35:00Z | ✅ |
| `…:HL:BUY__2h` | 2026-07-11T11:34:59Z | ✅ |
| `…:HL:BUY__30m` | 2026-07-24T07:35:00Z | ✅ |
| `…:HTX:BUY__4h` | 2026-07-12T03:35:00Z | ✅ |
| `…:KUCOIN:BUY__12h` | 2026-07-12T07:34:59Z | ✅ |
| `…:MEXC:BUY__8h` | 2026-07-01T09:35:00Z | ✅ |
| `…:OKX:BUY__12h` | 2026-05-04T19:25:15Z | ✅ |
| `…:OKX:BUY__3m` | 2026-07-15T07:35:00Z | ✅ |
| `…:PHEMEX:BUY__1h` | 2026-06-18T07:35:00Z | ✅ |
| `…:WHITEBIT:BUY__1h` | 2026-06-20T07:35:00Z | ✅ |
| `…:XT:BUY__1h` | 2026-06-20T07:35:00Z | ✅ |
| `…:XT:BUY__2h` | 2026-07-15T07:35:00Z | ✅ |
| `…:XT:BUY__4h` | 2026-07-02T05:35:02Z | ✅ |
| `…:BUY__12h` *(global)* | 2026-05-05T19:25:09Z | ✅ |
| `…:BUY__4h` *(global)* | 2026-06-20T07:35:00Z | ✅ |
| `…:BUY__8h` *(global)* | 2026-05-30T07:34:59Z | ✅ |

**Split:** 27 per-venue (`:<venue>:<strategy>`) · 3 global (`:<strategy>`).

**Upstream is frozen too**, so this is not a Redis-layer problem that a republish would fix:
last `promoted_at` `2026-07-24T07:35:00Z` (29d 20h), last `approved_at` `2026-07-30T07:30:00Z`
(23d 20h), last candidate `created_at` `2026-08-02T07:04:45Z` (20d 20h). One row sits in
`approved` (`WHITEBIT` / `BUY__15m`) and is HELD every hour by the stale gate.

---

## AC3 — `outcome_return_pct`, verified in payloads

The docblock claims the payload *"NEVER includes `outcome_return_pct`"*. **Verified true, and
verified against real payloads rather than the docblock** — with the instrument named, because
no live payload exists to check.

| Instrument | Corpus | `outcome_return_pct` |
|---|---|---|
| **A — real published payload history** (`aoe-redis` AOF, 2026-04-24 → 2026-07-27) | **24,880** payload writes | **0 occurrences** |
| same | same | `mean_pfe_return_pct`: **0 occurrences** |
| same (contrast — proves the grep can match) | same | `pfe_wr` 24,880 · `oos_sharpe` 24,880 · `stability_score` 24,880 · `config_id` 24,880 · `demoted_by` 90 |
| **B — producer** (`_redis_payload`, `promote_flow.py:281-296`) | 7 top-level fields | field is **not constructible** |
| **C — producer guard** | `assert_public_safe(payload)` is called on **all three** write paths: `:148` (demote marker), `:324` (approved-path publish), `:382` (refresh) | guarded |
| **D — consumer guard** | `aoe-config-reader.ts:125-131` rejects the **whole payload** if the key is present | guarded |

**No finding.** The Data Integrity boundary holds on both sides, and the contrast row shows the
zero is a real zero and not a dead grep.

---

## R3 / R4 / R5 — not executed

Stopped per R1's own rule. Recorded here so the next wave does not mistake silence for a pass:

| Req | Status | Note |
|---|---|---|
| R3 — vectors vs shipped `WEIGHTS`; weight-sum vs `MAX_RAW_SCORE = 89` | ⏭️ **NOT EXECUTED** | No live vectors exist. Historical vectors are recoverable from the AOF if a future wave needs them |
| R4 — AOE's validation discipline (out-of-sample? FDR? promotion floor? baselines?) | ⏭️ **NOT EXECUTED — and still UNANSWERED** | DORMANT does not clear this question, it **defers** it. `AOE-OBJECTIVE-PROBE-W1` already recorded that walk-forward and CPCV modules in this repo *"were imported only by a weekly toy script and gated nothing"*. **Nothing may consume AOE output until R4 is answered**, regardless of liveness |
| R5 — replay through `verdict-mix-replay.ts`; harness fidelity re-verify | ⏭️ **NOT EXECUTED** | Gated on R4, which is gated on R1. `W` at `verdict-mix-replay.ts:37` is already exported at `:190`, so the parameterisation is a signature change, not a refactor |

**The freeze was respected.** `SIGNAL-TREND-MODE-ENABLE-W1`'s BEFORE arm
(`regime_rule_version = 3 ∧ verdict_rule_version = 1`) is untouched: this wave wrote no code,
no env and no host state, so the ~2026-08-31 flip is not pushed out.

---

## Verification gate — the dispatch's gate is structurally unable to pass

Run verbatim at `origin/main` = `a877f09`:

```
protected_dirty=0 aoe_imports_in_src=2
AOE_READ_W1_RED
```

The two matches are **pre-existing prose comments**, present before this wave and untouched by
it:

* `src/tools/get-trade-call.ts:149` — the guard comment the dispatch itself cites as the only
  thing protecting this boundary;
* `src/lib/performance-db.ts:1176` — a comment about runtime-mutable weight promotion.

`grep -rn "aoe-config-reader" src/` counts **mentions**, not **imports**. The quantity the gate
means to bound is *import statements*, and on that predicate the tree is clean:

```bash
DIRTY=$(git status --porcelain src/tools/ src/lib/aoe-config-reader.ts landing/ README.md | wc -l | tr -d ' ')
REAL=$(grep -rnE "from ['\"][^'\"]*aoe-config-reader|require\(['\"][^'\"]*aoe-config-reader" src/ | wc -l | tr -d ' ')
echo "protected_dirty=$DIRTY aoe_real_imports_in_src=$REAL"
```

```
protected_dirty=0 aoe_real_imports_in_src=0
AOE_READ_W1_GREEN
```

**Both readings are recorded rather than the convenient one.** The gate as written would have
printed `RED` for any executor, on a clean tree, forever — a fourth instance of *an instrument
measuring a different quantity than the one asked about*, and the reason
`SIGNAL-AOE-EXPIRY-GATE-W{NEXT}` must assert on the **import graph**, never on a text grep that
a comment can trip.

**AC7 holds on the substantive claim:** zero writes to `src/tools/**`,
`src/lib/aoe-config-reader.ts`, any import of it, `landing/**`, `README.md`, any host env, or
any anchored row. This wave's only writes are this file and the two logbook artifacts.

---

## Acceptance criteria

| # | Check | Result |
|---|---|---|
| AC1 | Host, publisher, cadence, Redis instance established with citations; liveness stated | ✅ aoe-1 / `promote_flow.py` / cron `35 * * * *` / `aoe-redis` (loopback `127.0.0.1:6380`) / **DORMANT 27d** |
| AC2 | Full key census with ages; real grammar from live keys, not a fixture | ⚠️ **census complete but INDETERMINATE on its stated instrument** — live keys are zero, so the grammar is derived from the AOF + bank and both instruments are named beside every figure. `RSI_BULL_1h` falsified |
| AC3 | `outcome_return_pct` absence verified in payloads | ✅ 0 / 24,880 real payloads, with a positive contrast control |
| AC4 | Every vector compared to shipped; weight-sum vs `MAX_RAW_SCORE = 89` | ⏭️ moot under DORMANT (R1 stop rule) |
| AC5 | AOE's validation discipline answered with code citations | ⏭️ moot under DORMANT — **still open, and blocking for any wiring wave** |
| AC6 | R5 executed only if AC5 clears | ✅ correctly not executed |
| AC7 | Zero writes to protected paths | ✅ (gate caveat above is about the gate's predicate, not about a write) |

---

## Registered follow-ups

| Wave | Trigger | Scope |
|---|---|---|
| **`OPS-AOE-LIVENESS-W{NEXT}`** | `DORMANT` | Break the ratchet and make the outage visible. (a) The `edge_gate` must emit a **fresh verdict even when `promoted_set=0`** — an empty cohort is a FACT the gate observed, not a failure to observe, so it is a PASS with an explicit positive line, never a stale snapshot. (b) A freshness alarm on the **producer** — max age of `algovault:aoe:recommended_weights:*`, read on aoe-1 where the keys live — with a verdict token and a two-way self-test. (c) Retire the deferred cross-host row in `recommendation-drift-manifest.yaml:25-36` or make it real. (d) The `approved` row held every hour needs a drain path or an alert; a permanent HELD is a stuck queue |
| **`SIGNAL-AOE-EXPIRY-GATE-W{NEXT}`** | registered regardless of verdict, per the dispatch | A unit test asserting `readAoeConfig` has **no importer under `src/`**. It must assert on the **import graph**, not on `grep -rn "aoe-config-reader" src/`, which already counts 2 comments and would ship red on day one |
| **`AOE-PROMOTION-GATE-W{NEXT}`** | ⚠️ **not** triggered by this verdict, but **not cleared either** | R4 was never executed. Whichever wave first proposes consuming AOE output owes the out-of-sample / FDR / promotion-floor / naive-baseline audit **first** |
| *(doc fix, no wave needed)* | — | `autonomous-optimizer/docs/redis-keys.md` lists 5 allowed venues; 17 are live. And `aoe-config-reader.ts`'s `RSI_BULL_1h` example describes a key space that has never existed — correct both when either file is next touched |

**A `SIGNAL-AOE-WIRE-W{NEXT}` is NOT registered.** It is triggered only by `WORTH_CONSUMING`,
and three independent conditions block it today: the source is dormant, the validation question
is unanswered, and the recommendation set is single-sided (`BUY` only) with no regime dimension —
so it cannot address the contrarian-RSI-in-bull-regime defect this arc is actually chasing.

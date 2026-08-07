# RUNBOOK — flipping the signal engine to a confirmed-bar (closed-candle) basis

**Owner:** `SIGNAL-CLOSEDBAR-FLIP-W{NEXT}` · **Prerequisite:** `SIGNAL-CLOSEDBAR-SHADOW-W1` (shipped 2026-08-01)

`SIGNAL-CLOSEDBAR-SHADOW-W1` installed the confirmed-bar basis behind a **default-OFF** flag
and started measuring. It flipped nothing. This runbook is how the flip actually happens.
It is self-contained: you should not need the wave spec to execute it.

---

## 0. The defect being fixed

Indicators read `candles[length-1]` — the **in-progress** bar. A bar that is 10% elapsed has
~10% of its eventual volume, so the volume leg of the model scores the ladder **FLOOR (−70)**
purely because the bar is young. 20% of model weight carries near-zero information.

`get_market_regime` has a **different** failure mode, measured rather than assumed:
`detectPriceStructure` scans `for (i = 1; i < len - 1; i++)`, so the newest bar is never a
pivot *candidate* — it is the right-hand **confirming shoulder**. Under the live basis that
shoulder is the unfinished bar, so bar `n-2` is published as a confirmed, volume-weighted
pivot on the strength of a high that can still be exceeded. First real production row
(BTC 4h, 27% elapsed) inverted the structure read outright: `LOWER_LOWS → HIGHER_HIGHS`.

**Price is a LEVEL, volume is an INTEGRAL.** A price is valid at every instant; a volume or a
pivot is only complete at bar close. This is why `currentPrice`, the reported `price`, the
track-record entry price and `recordSignal` all stay on the LIVE bar under both bases — only
*indicator inputs* move. Do not "fix" that.

---

## 1. Read the readiness verdict — do not eyeball the data

```bash
ssh -i ~/.ssh/algovault_deploy root@204.168.185.24 \
  'tail -1 /var/lib/algovault-candle-basis/report-$(date -u +%F).md'
```

The daily wrapper (`43 5 * * *`) writes `report-<date>.{md,json}` and a `state.json`.
The verdict is the **last line** of both formats:

```
READY iff ( n_noninternal >= 500 )
       AND ( distinct_utc_days >= 7 )
       AND ( for every tf in seeded_tfs : n[tf] >= 20 )
```

`seeded_tfs` is derived **live from `crontab -l`** by the wrapper, never transcribed. As of
2026-08-01 that is **10** timeframes (`3m,5m,15m,30m,1h,2h,4h,8h,12h,1d`) — note the wave
spec's own Step 0 recorded 9 and said "no 1m/3m", which was already stale for `3m`.
**Re-read it live; do not trust any table, including this one.**

A `CANDLE_BASIS_FLIP_READY` Telegram fires **once ever** (marker
`/var/lib/algovault-candle-basis/.flip-ready.fired`). `CANDLE_BASIS_SHADOW_STALLED` fires if
`n` has not grown in 48h — that means the shadow write went dark and the flip must **not**
proceed on a frozen window.

---

## 2. Recalibrate thresholds FROM the report

The report exists so the retune is measured, not guessed. Read, in `report-<date>.md`:

| Section | What it tells the retune |
|---|---|
| Verdict flips + the six transitions | how many HOLDs become BUY/SELL — the flood risk |
| **Projected verdict volume at CURRENT thresholds** | the headline number: BUY/SELL count per basis |
| Volume-score distribution, `floor(-70)` rate per basis | how much of the defect the flip actually removes |
| `max|raw|` vs the `MAX_RAW_SCORE=89` ceiling | whether the ceiling is even reachable post-flip |
| Confidence delta p50/p95 | how far `MIN_TRACKABLE_CONFIDENCE` has to move |
| By elapsed-fraction decile | whether divergence concentrates in young bars (it should) |
| Daily timeseries | never retune off an aggregate — check for a trend |

Thresholds that actually exist (all in `src/tools/get-trade-call.ts`), as MEASURED at the flip:
`BUY_BASE_THRESHOLD` (40) · `SELL_THRESHOLD_GATED` (55) · `MAX_RAW_SCORE` (89) ·
`MIN_TRACKABLE_CONFIDENCE` (52). The live rule is **BUY `raw > 40`, SELL `|raw| > 55`, no
regime gating** — asymmetric, and left so deliberately.

> `SELL_BASE_THRESHOLD` and `BUY_THRESHOLD_GATED` were listed here until 2026-08-07 and were
> **never read by anything** — deleted in SIGNAL-CLOSEDBAR-FLIP-W1 CH1. `MAX_RAW_SCORE` is the
> confidence **divisor** (`confidence = round(|raw|/89×100)`), not a ceiling, so changing it
> moves every published confidence number with no underlying change — a public-copy change
> requiring architect sign-off, never a wave's own call.

> **Retuning on guesses floods BUY signals.** That is the whole reason this wave measured
> first. If the report says NOT_READY, the answer is to wait, not to lower the bar.

---

## 3. Flip the engine

```bash
ssh -i ~/.ssh/algovault_deploy root@204.168.185.24
cd /opt/crypto-quant-signal-mcp
cp .env .env.bak.CLOSEDBAR-FLIP-$(date -u +%Y%m%dT%H%M%SZ)
echo 'CANDLE_BASIS=closed' >> .env
docker compose up -d mcp-server      # NOT `restart` — that does NOT reload env_file:
docker exec crypto-quant-signal-mcp-mcp-server-1 printenv CANDLE_BASIS   # must print: closed
```

`docker compose restart` does **not** reload `env_file:`. Using it is the single most common
way this flip silently no-ops.

---

## 4. Move bot delivery to bar close

The bot already dispatches on a **bucket**, not on relative age (CH6). One variable moves
delivery from late-bar to bar-close:

```bash
sed -i 's/^ALGOVAULT_BOT_DISPATCH_OFFSET_PCT=.*/ALGOVAULT_BOT_DISPATCH_OFFSET_PCT=0/' /etc/algovault-bot/env
systemctl daemon-reload
systemctl restart algovault-bot.service          # the env file is SHARED by two units…
systemctl restart algovault-bot-cron.timer       # …restart both
```

At `offset=0`, `ALGOVAULT_BOT_CLOSE_GRACE_MIN=1` lands dispatch on the `:01:00` tick — the
first tick *after* close. A `:00:30` target is unreachable at a 60-second tick.

**Expect a one-cycle realignment.** The first fire after the change can land anywhere in the
bar (measured: 464s into a 900s bar); steady state resumes on the next cycle (measured: 824s,
gaps exactly 900s). The `+90min` liveness probe skips this window by design.

---

## 5. Re-time the seeder crons to bar-close + grace

**Re-read `crontab -l` live — the table below is a snapshot and will be stale.**

| tf | minutes (as of 2026-08-01) |
|----|------|
| 3m | `2-59/3` |
| 5m | `1,6,11,…,56` |
| 15m | `2,17,32,47` |
| 30m | `5,35` |
| 1h | `15` |
| 2h | `30` |
| 4h | `10` |
| 8h | `40` |
| 12h | `50` |
| 1d | `20` |

Back up first: `crontab -l > /root/crontab.bak.CLOSEDBAR-FLIP-$(date -u +%Y%m%dT%H%M%SZ)`.
Keep every slot **off the `:00` boundary** — `:00` crons collide and over-count CPU 50-90×.

---

## 6. Verify

```bash
# 1. flag actually live
docker exec crypto-quant-signal-mcp-mcp-server-1 printenv CANDLE_BASIS

# 2. the emitted envelope moved (it SHOULD now — that is the point)
curl -s https://api.algovault.com/health | python3 -m json.tool | head -5

# 3. shadow still accumulating, and call_live now == the closed basis
docker exec crypto-quant-signal-mcp-postgres-1 psql -U algovault -d signal_performance -tAc \
  "SELECT tool, count(*), count(*) FILTER (WHERE call_live<>call_closed) AS flips
     FROM candle_basis_shadow WHERE recorded_at > now() - interval '1 hour' GROUP BY tool;"

# 4. Data Integrity — counts may only GROW
docker exec crypto-quant-signal-mcp-postgres-1 psql -U algovault -d signal_performance -tAc \
  "SELECT (SELECT count(*) FROM signals), (SELECT count(*) FROM funding_history),
          (SELECT count(*) FROM oi_snapshots);"
```

---

## 7. Rollback — one line, no rebuild

```bash
ssh -i ~/.ssh/algovault_deploy root@204.168.185.24 \
  "cd /opt/crypto-quant-signal-mcp && sed -i '/^CANDLE_BASIS=/d' .env && docker compose up -d mcp-server"
```

Unsetting the variable restores the live basis immediately: the code is byte-identical by
default, pinned by two golden envelope fixtures
(`tests/unit/candle-basis-golden.test.ts`, `tests/unit/candle-basis-regime-golden.test.ts`).
For the bot, set `ALGOVAULT_BOT_DISPATCH_OFFSET_PCT=75` and restart both units.

**Never `git revert` the shadow wave to roll back a flip** — the flag *is* the rollback, and
reverting would also delete the measurement table the next attempt depends on.

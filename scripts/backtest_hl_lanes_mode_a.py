#!/usr/bin/env python3
"""
Mode A backtest: per-signal replay of HL 5m + 15m lanes against 1m HL candles.

READ-ONLY on production. Ships no DB writes, no deploy artifacts, no cron.
Run on the Hetzner VPS where the Postgres container is local.

Usage:
    python3 backtest_hl_lanes_mode_a.py \
        [--out-dir /tmp/mode_a] \
        [--cache-dir /tmp/hl_candles] \
        [--post-r6-epoch 1744675200] \
        [--skip-fetch]

Outputs (under --out-dir):
    signals.csv          raw SELECTed signals (one row per signal)
    rows.csv             one row per replayed signal with outcome + realized pnl
    summary.json         per-lane aggregation (outcome mix, EV gross/net/stress,
                         conf-band breakdown, per-direction, top symbols, tie delta)
    coverage.json        coin/day coverage warnings

Stdlib only (no pip installs required on the VPS).
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone, timedelta
from typing import Dict, Iterable, List, Optional, Tuple

# ------------------------------------------------------------------
# Lane recipes (source: experiments/quant-trading-server/mae-pfe-percentile-report.md, 2026-04-17)
# ------------------------------------------------------------------
LANE_RECIPES: Dict[str, Dict[str, float]] = {
    "5m": {
        "stopLossPct": 0.0073,
        "tp1Pct": 0.0039,
        "tp2Pct": 0.0081,
        "maxHoldCandles": 12,    # 12 × 5m = 60 min
        "tp1Fraction": 0.5,
        "moveSlToBeAfterTp1": True,
        "minConfidence": 52,
        "tf_seconds": 300,
    },
    "15m": {
        "stopLossPct": 0.0114,
        "tp1Pct": 0.0067,
        "tp2Pct": 0.0124,
        "maxHoldCandles": 12,    # 12 × 15m = 180 min = 3 h
        "tp1Fraction": 0.5,
        "moveSlToBeAfterTp1": True,
        "minConfidence": 52,
        "tf_seconds": 900,
    },
}

# HL fees (verified on report date — HL public docs, taker ≈ 0.045% per side)
FEE_TAKER_ROUND_TRIP = 0.0009   # 0.045% × 2
FEE_STRESS = 0.0015             # 0.09% fees + 0.03% slippage + 0.03% est. funding
HL_URL = "https://api.hyperliquid.xyz/info"
HL_RATE_LIMIT_DELAY = 0.06      # ~16 req/s — under the 20 req/s cap
MIN_BAR_COMPLETENESS = 0.90

# ------------------------------------------------------------------
# Data types
# ------------------------------------------------------------------
@dataclass
class Signal:
    signal_id: int
    coin: str
    direction: str          # 'BUY' or 'SELL'
    entry_price: float
    confidence: int
    created_at: int         # unix seconds
    timeframe: str          # '5m' or '15m'
    pfe_return_pct: Optional[float]
    mae_pct: Optional[float]
    regime: Optional[str]


@dataclass
class Candle:
    t_ms: int               # open time in ms
    o: float
    h: float
    l: float
    c: float


@dataclass
class SignalOutcome:
    signal_id: int
    symbol: str
    timeframe: str
    direction: str
    confidence: int
    created_at: int
    entry_price: float
    outcome_type: str       # SL / TP1_BE / TP1_TP2 / TP1_TIME / TIME_POSITIVE / TIME_NEGATIVE / NO_DATA
    realized_pnl_pct: float
    tp1_hit_ts: Optional[int]
    tp2_hit_ts: Optional[int]
    sl_hit_ts: Optional[int]
    exit_ts: Optional[int]
    candles_to_exit: int
    same_bar_tp1_sl_tie: bool
    coverage_warning: bool


# ------------------------------------------------------------------
# Signal extraction — READ-ONLY psql via docker exec
# ------------------------------------------------------------------
EXTRACT_SQL = """
SET TRANSACTION READ ONLY;
\\COPY (
  SELECT
    id,
    coin,
    signal AS direction,
    price_at_signal AS entry_price,
    confidence,
    created_at,
    timeframe,
    pfe_return_pct,
    mae_return_pct AS mae_pct,
    regime
  FROM signals
  WHERE exchange='HL'
    AND timeframe IN ('5m','15m')
    AND signal IN ('BUY','SELL')
    AND pfe_return_pct IS NOT NULL
    AND confidence >= 52
    AND created_at >= {epoch}
  ORDER BY id
) TO STDOUT WITH CSV HEADER;
"""


def extract_signals(out_csv: str, post_r6_epoch: int) -> List[Signal]:
    sql = EXTRACT_SQL.format(epoch=post_r6_epoch)
    cmd = [
        "docker", "exec", "-i",
        "crypto-quant-signal-mcp-postgres-1",
        "psql", "-U", "algovault", "-d", "signal_performance",
        "-P", "pager=off", "-v", "ON_ERROR_STOP=1",
    ]
    with open(out_csv, "w") as fh:
        proc = subprocess.run(cmd, input=sql, capture_output=True, text=True, check=False)
        if proc.returncode != 0:
            raise RuntimeError(f"psql extraction failed: {proc.stderr}")
        fh.write(proc.stdout)
    return load_signals(out_csv)


def load_signals(path: str) -> List[Signal]:
    out: List[Signal] = []
    with open(path) as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            out.append(Signal(
                signal_id=int(row["id"]),
                coin=row["coin"],
                direction=row["direction"],
                entry_price=float(row["entry_price"]),
                confidence=int(row["confidence"]),
                created_at=int(row["created_at"]),
                timeframe=row["timeframe"],
                pfe_return_pct=_float_or_none(row.get("pfe_return_pct")),
                mae_pct=_float_or_none(row.get("mae_pct")),
                regime=row.get("regime") or None,
            ))
    return out


def _float_or_none(x: Optional[str]) -> Optional[float]:
    if x is None or x == "":
        return None
    try:
        return float(x)
    except ValueError:
        return None


# ------------------------------------------------------------------
# Candle fetch (HL public API, cached per coin×day)
# ------------------------------------------------------------------
def _utc_day_bounds_ms(day_utc: datetime) -> Tuple[int, int]:
    start = day_utc.replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=timezone.utc)
    end = start + timedelta(days=1)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000) - 1


def cache_path(cache_dir: str, coin: str, day_utc: datetime) -> str:
    return os.path.join(cache_dir, f"hl_candles_{coin}_{day_utc.strftime('%Y%m%d')}.json")


def _post_hl(body: dict, attempt: int = 0) -> list:
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        HL_URL,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        if e.code in (429, 500, 502, 503, 504) and attempt < 4:
            time.sleep(2 ** attempt)
            return _post_hl(body, attempt + 1)
        raise
    except urllib.error.URLError:
        if attempt < 4:
            time.sleep(2 ** attempt)
            return _post_hl(body, attempt + 1)
        raise


def fetch_candles_for_day(cache_dir: str, coin: str, day_utc: datetime) -> List[Candle]:
    path = cache_path(cache_dir, coin, day_utc)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        with open(path) as fh:
            raw = json.load(fh)
    else:
        start_ms, end_ms = _utc_day_bounds_ms(day_utc)
        raw = _post_hl({
            "type": "candleSnapshot",
            "req": {
                "coin": coin,
                "interval": "1m",
                "startTime": start_ms,
                "endTime": end_ms,
            },
        })
        os.makedirs(cache_dir, exist_ok=True)
        with open(path, "w") as fh:
            json.dump(raw, fh)
        time.sleep(HL_RATE_LIMIT_DELAY)
    return [_candle_from_raw(r) for r in raw if isinstance(r, dict)]


def _candle_from_raw(raw: dict) -> Candle:
    return Candle(
        t_ms=int(raw["t"]),
        o=float(raw["o"]),
        h=float(raw["h"]),
        l=float(raw["l"]),
        c=float(raw["c"]),
    )


def candles_for_signal_window(
    cache_dir: str,
    coin: str,
    start_ts: int,
    max_hold_seconds: int,
) -> Tuple[List[Candle], bool]:
    """Return 1m bars covering [start_ts, start_ts + max_hold_seconds], inclusive.
    Second element is coverage_warning (True if < 90% of expected bars were fetched).
    """
    start_dt = datetime.fromtimestamp(start_ts, tz=timezone.utc)
    end_ts = start_ts + max_hold_seconds
    end_dt = datetime.fromtimestamp(end_ts, tz=timezone.utc)

    days: List[datetime] = []
    cur = start_dt.replace(hour=0, minute=0, second=0, microsecond=0)
    end_day = end_dt.replace(hour=0, minute=0, second=0, microsecond=0)
    while cur <= end_day:
        days.append(cur)
        cur += timedelta(days=1)

    all_bars: List[Candle] = []
    for d in days:
        try:
            all_bars.extend(fetch_candles_for_day(cache_dir, coin, d))
        except Exception as e:
            sys.stderr.write(f"[fetch] {coin} {d:%Y-%m-%d}: {e}\n")

    start_ms = start_ts * 1000
    end_ms = end_ts * 1000
    windowed = [b for b in all_bars if start_ms <= b.t_ms <= end_ms]
    windowed.sort(key=lambda b: b.t_ms)
    expected = max_hold_seconds // 60 + 1
    coverage_warning = expected > 0 and (len(windowed) / expected) < MIN_BAR_COMPLETENESS
    return windowed, coverage_warning


# ------------------------------------------------------------------
# Replay engine
# ------------------------------------------------------------------
def replay_signal(
    signal: Signal,
    candles_1m: List[Candle],
    recipe: Dict[str, float],
    *,
    tie_sl_first: bool = True,
    coverage_warning: bool = False,
) -> SignalOutcome:
    """Walk 1m bars for [created_at, created_at + maxHold × tf_seconds], apply
    scale-out logic with SL→BE after TP1. Returns SignalOutcome with realized
    P&L in absolute (decimal) terms for a unit-notional trade.
    """
    entry = signal.entry_price
    sl_pct = recipe["stopLossPct"]
    tp1_pct = recipe["tp1Pct"]
    tp2_pct = recipe["tp2Pct"]
    tp1_frac = recipe["tp1Fraction"]
    tf_seconds = int(recipe["tf_seconds"])
    max_hold_seconds = int(recipe["maxHoldCandles"]) * tf_seconds

    if not candles_1m:
        return SignalOutcome(
            signal_id=signal.signal_id,
            symbol=signal.coin,
            timeframe=signal.timeframe,
            direction=signal.direction,
            confidence=signal.confidence,
            created_at=signal.created_at,
            entry_price=entry,
            outcome_type="NO_DATA",
            realized_pnl_pct=0.0,
            tp1_hit_ts=None, tp2_hit_ts=None, sl_hit_ts=None, exit_ts=None,
            candles_to_exit=0,
            same_bar_tp1_sl_tie=False,
            coverage_warning=True,
        )

    is_buy = signal.direction == "BUY"
    if is_buy:
        tp1_price = entry * (1 + tp1_pct)
        tp2_price = entry * (1 + tp2_pct)
        sl_price = entry * (1 - sl_pct)
    else:
        tp1_price = entry * (1 - tp1_pct)
        tp2_price = entry * (1 - tp2_pct)
        sl_price = entry * (1 + sl_pct)

    tp1_hit_ts: Optional[int] = None
    tp2_hit_ts: Optional[int] = None
    sl_hit_ts: Optional[int] = None
    realized_pct = 0.0
    same_bar_tie = False
    remaining = 1.0
    # After TP1, SL moves to breakeven (entry)
    effective_sl = sl_price

    cutoff_ms = (signal.created_at + max_hold_seconds) * 1000
    last_bar = candles_1m[-1]
    exit_ts: Optional[int] = None
    candles_seen = 0

    for bar in candles_1m:
        if bar.t_ms > cutoff_ms:
            break
        candles_seen += 1
        # BUY: favorable = high ≥ tp; adverse = low ≤ sl.
        # SELL: favorable = low ≤ tp; adverse = high ≥ sl.
        if is_buy:
            tp1_crossed = (tp1_hit_ts is None) and (bar.h >= tp1_price)
            tp2_crossed = (tp1_hit_ts is not None) and (bar.h >= tp2_price)
            sl_crossed = bar.l <= effective_sl
        else:
            tp1_crossed = (tp1_hit_ts is None) and (bar.l <= tp1_price)
            tp2_crossed = (tp1_hit_ts is not None) and (bar.l <= tp2_price)
            sl_crossed = bar.h >= effective_sl

        if tp1_hit_ts is None:
            # First phase: check for TP1 or SL (ambiguity on same bar)
            if tp1_crossed and sl_crossed:
                same_bar_tie = True
                if tie_sl_first:
                    realized_pct += -sl_pct * remaining
                    remaining = 0.0
                    sl_hit_ts = bar.t_ms
                    exit_ts = bar.t_ms
                    return SignalOutcome(
                        signal_id=signal.signal_id, symbol=signal.coin,
                        timeframe=signal.timeframe, direction=signal.direction,
                        confidence=signal.confidence, created_at=signal.created_at,
                        entry_price=entry, outcome_type="SL",
                        realized_pnl_pct=realized_pct,
                        tp1_hit_ts=None, tp2_hit_ts=None, sl_hit_ts=sl_hit_ts,
                        exit_ts=exit_ts, candles_to_exit=candles_seen,
                        same_bar_tp1_sl_tie=True,
                        coverage_warning=coverage_warning,
                    )
                else:
                    # TP1 first: book tp1_frac at TP1, move SL → BE
                    realized_pct += tp1_pct * tp1_frac
                    remaining -= tp1_frac
                    tp1_hit_ts = bar.t_ms
                    effective_sl = entry
                    # still in same bar; BE is now entry. Would BE be crossed?
                    # Post-TP1, BE means exit at entry for remaining; a same-bar
                    # dip back through entry would scratch the runner. Pessimistically
                    # assume after TP1 fill the BE stop doesn't retrigger within the
                    # same bar (favorable TP1 exit usually means bar closed above entry).
                    continue
            elif sl_crossed:
                realized_pct += -sl_pct * remaining
                remaining = 0.0
                sl_hit_ts = bar.t_ms
                exit_ts = bar.t_ms
                return SignalOutcome(
                    signal_id=signal.signal_id, symbol=signal.coin,
                    timeframe=signal.timeframe, direction=signal.direction,
                    confidence=signal.confidence, created_at=signal.created_at,
                    entry_price=entry, outcome_type="SL",
                    realized_pnl_pct=realized_pct,
                    tp1_hit_ts=None, tp2_hit_ts=None, sl_hit_ts=sl_hit_ts,
                    exit_ts=exit_ts, candles_to_exit=candles_seen,
                    same_bar_tp1_sl_tie=False,
                    coverage_warning=coverage_warning,
                )
            elif tp1_crossed:
                realized_pct += tp1_pct * tp1_frac
                remaining -= tp1_frac
                tp1_hit_ts = bar.t_ms
                effective_sl = entry  # move SL → BE
                continue
        else:
            # Second phase (post-TP1): check for TP2, BE stop, or continue
            if tp2_crossed and sl_crossed:
                # Tie on the runner leg — pessimistic: BE first
                realized_pct += 0.0 * remaining  # BE scratches runner
                exit_ts = bar.t_ms
                return SignalOutcome(
                    signal_id=signal.signal_id, symbol=signal.coin,
                    timeframe=signal.timeframe, direction=signal.direction,
                    confidence=signal.confidence, created_at=signal.created_at,
                    entry_price=entry, outcome_type="TP1_BE",
                    realized_pnl_pct=realized_pct,
                    tp1_hit_ts=tp1_hit_ts, tp2_hit_ts=None, sl_hit_ts=bar.t_ms,
                    exit_ts=exit_ts, candles_to_exit=candles_seen,
                    same_bar_tp1_sl_tie=same_bar_tie,
                    coverage_warning=coverage_warning,
                )
            if sl_crossed:
                # BE stop triggered on runner
                exit_ts = bar.t_ms
                return SignalOutcome(
                    signal_id=signal.signal_id, symbol=signal.coin,
                    timeframe=signal.timeframe, direction=signal.direction,
                    confidence=signal.confidence, created_at=signal.created_at,
                    entry_price=entry, outcome_type="TP1_BE",
                    realized_pnl_pct=realized_pct,
                    tp1_hit_ts=tp1_hit_ts, tp2_hit_ts=None, sl_hit_ts=bar.t_ms,
                    exit_ts=exit_ts, candles_to_exit=candles_seen,
                    same_bar_tp1_sl_tie=same_bar_tie,
                    coverage_warning=coverage_warning,
                )
            if tp2_crossed:
                realized_pct += tp2_pct * remaining
                exit_ts = bar.t_ms
                return SignalOutcome(
                    signal_id=signal.signal_id, symbol=signal.coin,
                    timeframe=signal.timeframe, direction=signal.direction,
                    confidence=signal.confidence, created_at=signal.created_at,
                    entry_price=entry, outcome_type="TP1_TP2",
                    realized_pnl_pct=realized_pct,
                    tp1_hit_ts=tp1_hit_ts, tp2_hit_ts=bar.t_ms, sl_hit_ts=None,
                    exit_ts=exit_ts, candles_to_exit=candles_seen,
                    same_bar_tp1_sl_tie=same_bar_tie,
                    coverage_warning=coverage_warning,
                )

    # Time-expired with some (or no) TP fills
    last_close = last_bar.c
    last_ts = last_bar.t_ms
    if tp1_hit_ts is not None:
        # runner exits at last close (close-to-entry move on remaining fraction)
        if is_buy:
            runner_pnl = (last_close - entry) / entry
        else:
            runner_pnl = (entry - last_close) / entry
        realized_pct += runner_pnl * remaining
        return SignalOutcome(
            signal_id=signal.signal_id, symbol=signal.coin,
            timeframe=signal.timeframe, direction=signal.direction,
            confidence=signal.confidence, created_at=signal.created_at,
            entry_price=entry, outcome_type="TP1_TIME",
            realized_pnl_pct=realized_pct,
            tp1_hit_ts=tp1_hit_ts, tp2_hit_ts=None, sl_hit_ts=None,
            exit_ts=last_ts, candles_to_exit=candles_seen,
            same_bar_tp1_sl_tie=same_bar_tie,
            coverage_warning=coverage_warning,
        )

    # No TPs filled, no SL hit
    if is_buy:
        pnl = (last_close - entry) / entry
    else:
        pnl = (entry - last_close) / entry
    realized_pct = pnl
    return SignalOutcome(
        signal_id=signal.signal_id, symbol=signal.coin,
        timeframe=signal.timeframe, direction=signal.direction,
        confidence=signal.confidence, created_at=signal.created_at,
        entry_price=entry,
        outcome_type="TIME_POSITIVE" if pnl > 0 else "TIME_NEGATIVE",
        realized_pnl_pct=realized_pct,
        tp1_hit_ts=None, tp2_hit_ts=None, sl_hit_ts=None,
        exit_ts=last_ts, candles_to_exit=candles_seen,
        same_bar_tp1_sl_tie=same_bar_tie,
        coverage_warning=coverage_warning,
    )


# ------------------------------------------------------------------
# Aggregation
# ------------------------------------------------------------------
OUTCOME_WIN_TYPES = {"TP1_BE", "TP1_TP2", "TP1_TIME", "TIME_POSITIVE"}
OUTCOME_LOSS_TYPES = {"SL", "TIME_NEGATIVE"}


def aggregate(outcomes: List[SignalOutcome]) -> Dict:
    if not outcomes:
        return {"n": 0}
    outcome_types = ["SL", "TP1_BE", "TP1_TP2", "TP1_TIME", "TIME_POSITIVE", "TIME_NEGATIVE", "NO_DATA"]
    mix = {t: 0 for t in outcome_types}
    for o in outcomes:
        mix[o.outcome_type] = mix.get(o.outcome_type, 0) + 1

    valid = [o for o in outcomes if o.outcome_type != "NO_DATA"]
    n_valid = len(valid)
    n_wins = sum(1 for o in valid if o.outcome_type in OUTCOME_WIN_TYPES)
    pnl = [o.realized_pnl_pct for o in valid]
    mean_pnl = sum(pnl) / n_valid if n_valid else 0.0
    sq = sum((p - mean_pnl) ** 2 for p in pnl)
    stdev = (sq / (n_valid - 1)) ** 0.5 if n_valid > 1 else 0.0

    histogram: Dict[str, int] = {}
    for p in pnl:
        bucket = round(p * 100 / 0.1) * 0.1  # % with 0.1% bins
        key = f"{bucket:.1f}"
        histogram[key] = histogram.get(key, 0) + 1

    cumulative = 0.0
    cum_curve: List[float] = []
    for o in sorted(valid, key=lambda x: x.created_at):
        cumulative += o.realized_pnl_pct
        cum_curve.append(cumulative)

    n_tie = sum(1 for o in outcomes if o.same_bar_tp1_sl_tie)
    n_cov = sum(1 for o in outcomes if o.coverage_warning)

    return {
        "n_total": len(outcomes),
        "n_valid": n_valid,
        "outcome_mix": mix,
        "outcome_wr_pct": 100.0 * n_wins / n_valid if n_valid else 0.0,
        "gross_avg_pnl_pct": mean_pnl * 100,
        "net_avg_pnl_pct": (mean_pnl - FEE_TAKER_ROUND_TRIP) * 100,
        "stress_avg_pnl_pct": (mean_pnl - FEE_STRESS) * 100,
        "pnl_stdev_pct": stdev * 100,
        "max_loss_pct": min(pnl) * 100 if pnl else 0.0,
        "max_gain_pct": max(pnl) * 100 if pnl else 0.0,
        "n_same_bar_tie": n_tie,
        "n_coverage_warning": n_cov,
        "histogram_0p1_bins_pct": histogram,
        "cumulative_pnl_curve_pct": [round(c * 100, 4) for c in cum_curve],
    }


def by_key(outcomes: Iterable[SignalOutcome], fn) -> Dict[str, List[SignalOutcome]]:
    buckets: Dict[str, List[SignalOutcome]] = {}
    for o in outcomes:
        k = fn(o)
        buckets.setdefault(k, []).append(o)
    return buckets


def confidence_band(c: int) -> str:
    if 52 <= c <= 59: return "[52-59]"
    if 60 <= c <= 69: return "[60-69]"
    if 70 <= c <= 79: return "[70-79]"
    if 80 <= c <= 89: return "[80-89]"
    if c >= 90: return "[90-100]"
    return "[<52]"


# ------------------------------------------------------------------
# Integrity
# ------------------------------------------------------------------
INTEGRITY_URLS = [
    ("signal_performance_api", "https://api.algovault.com/api/performance-public"),
    ("performance_dashboard", "https://api.algovault.com/performance-dashboard"),
    ("landing_page", "https://algovault.com/"),
]


def _curl_sha(url: str) -> Tuple[str, int]:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "backtest-hl-mode-a/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read()
            return hashlib.sha256(body).hexdigest(), resp.status
    except urllib.error.HTTPError as e:
        return hashlib.sha256(e.read()).hexdigest(), e.code
    except Exception as e:
        return f"ERROR:{e}", -1


def db_row_counts() -> Dict[str, int]:
    sql = (
        "SELECT (SELECT COUNT(*) FROM signals) AS total, "
        "(SELECT COUNT(*) FROM signals WHERE exchange='HL') AS hl_total, "
        "(SELECT COUNT(*) FROM signals WHERE exchange='HL' AND pfe_return_pct IS NOT NULL) AS hl_evaluated;"
    )
    proc = subprocess.run([
        "docker", "exec", "-i", "crypto-quant-signal-mcp-postgres-1",
        "psql", "-U", "algovault", "-d", "signal_performance",
        "-P", "pager=off", "-A", "-t", "-F", ",", "-c", sql,
    ], capture_output=True, text=True, check=True)
    line = proc.stdout.strip().split("\n")[0]
    total, hl_total, hl_evaluated = [int(x) for x in line.split(",")]
    return {"total": total, "hl_total": hl_total, "hl_evaluated": hl_evaluated}


def capture_integrity(out_path: str) -> Dict:
    snap = {"ts": int(time.time()), "db": db_row_counts(), "urls": {}}
    for name, url in INTEGRITY_URLS:
        h, status = _curl_sha(url)
        snap["urls"][name] = {"url": url, "sha256": h, "status": status}
    with open(out_path, "w") as fh:
        json.dump(snap, fh, indent=2)
    return snap


# ------------------------------------------------------------------
# Orchestration
# ------------------------------------------------------------------
def run(args) -> int:
    out_dir = args.out_dir
    cache_dir = args.cache_dir
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(cache_dir, exist_ok=True)

    integ_pre_path = os.path.join(out_dir, "integrity_pre.json")
    integ_post_path = os.path.join(out_dir, "integrity_post.json")

    print(f"[1/5] integrity pre-run → {integ_pre_path}")
    pre = capture_integrity(integ_pre_path)
    print(f"       db: {pre['db']}, urls: {[(k, v['status']) for k, v in pre['urls'].items()]}")

    print("[2/5] extracting signals")
    sig_csv = os.path.join(out_dir, "signals.csv")
    signals = extract_signals(sig_csv, args.post_r6_epoch)
    print(f"       extracted {len(signals)} signals "
          f"({sum(1 for s in signals if s.timeframe=='5m')} 5m / "
          f"{sum(1 for s in signals if s.timeframe=='15m')} 15m)")

    print("[3/5] replaying signals")
    outcomes_sl_first: List[SignalOutcome] = []
    outcomes_tp_first: List[SignalOutcome] = []
    coverage_warnings: Dict[str, int] = {}

    coin_day_seen: Dict[Tuple[str, str], int] = {}
    for i, s in enumerate(signals):
        if i % 200 == 0 and i > 0:
            print(f"       {i}/{len(signals)}")
        recipe = LANE_RECIPES[s.timeframe]
        max_hold_seconds = int(recipe["maxHoldCandles"]) * int(recipe["tf_seconds"])
        bars, cov_warn = candles_for_signal_window(
            cache_dir, s.coin, s.created_at, max_hold_seconds
        )
        day_key = (s.coin, datetime.fromtimestamp(s.created_at, tz=timezone.utc).strftime("%Y%m%d"))
        coin_day_seen[day_key] = len(bars)

        if cov_warn:
            coverage_warnings[f"{s.coin}_{day_key[1]}"] = len(bars)

        o_sl = replay_signal(s, bars, recipe, tie_sl_first=True, coverage_warning=cov_warn)
        o_tp = replay_signal(s, bars, recipe, tie_sl_first=False, coverage_warning=cov_warn)
        outcomes_sl_first.append(o_sl)
        outcomes_tp_first.append(o_tp)

    # Write rows CSV (SL-first tie resolution = primary)
    rows_csv = os.path.join(out_dir, "rows.csv")
    with open(rows_csv, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow([
            "signal_id", "symbol", "timeframe", "direction", "confidence",
            "created_at", "entry_price", "outcome_type", "realized_pnl_pct",
            "tp1_hit_ts", "tp2_hit_ts", "sl_hit_ts", "exit_ts",
            "candles_to_exit", "same_bar_tp1_sl_tie", "coverage_warning",
        ])
        for o in outcomes_sl_first:
            w.writerow([
                o.signal_id, o.symbol, o.timeframe, o.direction, o.confidence,
                o.created_at, f"{o.entry_price:.8f}", o.outcome_type,
                f"{o.realized_pnl_pct:.8f}",
                o.tp1_hit_ts or "", o.tp2_hit_ts or "",
                o.sl_hit_ts or "", o.exit_ts or "",
                o.candles_to_exit, o.same_bar_tp1_sl_tie, o.coverage_warning,
            ])
    print(f"       wrote rows → {rows_csv}")

    print("[4/5] aggregating")
    summary: Dict[str, Dict] = {}
    for tf in ("5m", "15m"):
        tf_out_sl = [o for o in outcomes_sl_first if o.timeframe == tf]
        tf_out_tp = [o for o in outcomes_tp_first if o.timeframe == tf]
        lane = {
            "recipe": {k: v for k, v in LANE_RECIPES[tf].items() if isinstance(v, (int, float, str, bool))},
            "primary_sl_first": aggregate(tf_out_sl),
            "sensitivity_tp_first": aggregate(tf_out_tp),
        }
        # Per-confidence-band
        by_conf = by_key(tf_out_sl, lambda o: confidence_band(o.confidence))
        lane["by_confidence_band"] = {k: aggregate(v) for k, v in sorted(by_conf.items())}
        # Per-direction
        by_dir = by_key(tf_out_sl, lambda o: o.direction)
        lane["by_direction"] = {k: aggregate(v) for k, v in sorted(by_dir.items())}
        # Top 10 symbols by signal count
        by_sym = by_key(tf_out_sl, lambda o: o.symbol)
        top_syms = sorted(by_sym.keys(), key=lambda k: -len(by_sym[k]))[:10]
        lane["top10_symbols"] = {k: aggregate(by_sym[k]) for k in top_syms}
        # Tie-sensitivity delta
        p = lane["primary_sl_first"]
        t = lane["sensitivity_tp_first"]
        if p.get("n_valid") and t.get("n_valid"):
            lane["tie_sensitivity_delta"] = {
                "abs_outcome_wr_pp": t["outcome_wr_pct"] - p["outcome_wr_pct"],
                "abs_gross_pnl_pp": t["gross_avg_pnl_pct"] - p["gross_avg_pnl_pct"],
                "rel_gross_pnl_pct": (
                    100.0 * (t["gross_avg_pnl_pct"] - p["gross_avg_pnl_pct"])
                    / p["gross_avg_pnl_pct"]
                    if p["gross_avg_pnl_pct"] != 0 else None
                ),
            }
        summary[tf] = lane

    summary_path = os.path.join(out_dir, "summary.json")
    with open(summary_path, "w") as fh:
        json.dump(summary, fh, indent=2, default=str)
    print(f"       wrote summary → {summary_path}")

    coverage_path = os.path.join(out_dir, "coverage.json")
    with open(coverage_path, "w") as fh:
        json.dump({
            "n_coin_days_with_warning": len(coverage_warnings),
            "warnings": coverage_warnings,
        }, fh, indent=2)

    print(f"[5/5] integrity post-run → {integ_post_path}")
    post = capture_integrity(integ_post_path)
    ok_db = post["db"] == pre["db"]
    url_diffs = [
        (name, pre["urls"][name]["sha256"], post["urls"][name]["sha256"])
        for name, _ in INTEGRITY_URLS
    ]
    ok_urls = all(p == q for _, p, q in url_diffs)
    integrity_ok = ok_db and ok_urls
    print(f"       db identical: {ok_db}; urls identical: {ok_urls}; overall: {integrity_ok}")
    with open(os.path.join(out_dir, "integrity_diff.json"), "w") as fh:
        json.dump({
            "ok_db": ok_db,
            "pre_db": pre["db"],
            "post_db": post["db"],
            "url_deltas": [{"name": n, "pre": p, "post": q, "equal": p == q} for n, p, q in url_diffs],
            "integrity_ok": integrity_ok,
        }, fh, indent=2)
    return 0 if integrity_ok else 2


def main():
    ap = argparse.ArgumentParser(description="Mode A backtest for HL 5m/15m lanes")
    ap.add_argument("--out-dir", default="/tmp/mode_a")
    ap.add_argument("--cache-dir", default="/tmp/hl_candles")
    ap.add_argument("--post-r6-epoch", type=int, default=1744675200)
    ap.add_argument("--skip-fetch", action="store_true", help="Do not call the HL API; rely on cache only.")
    args = ap.parse_args()
    sys.exit(run(args))


if __name__ == "__main__":
    main()

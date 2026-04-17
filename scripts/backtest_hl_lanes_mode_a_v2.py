#!/usr/bin/env python3
"""
Mode A v2 — recipe-variant backtest of HL 5m + 15m lanes.

Extends Mode A v1 (`backtest_hl_lanes_mode_a.py`) with four recipe variants
per timeframe, each also aggregated at two confidence gates (conf>=52 and
conf>=70). Re-uses v1 signal CSV and candle cache — no re-extraction, no
re-fetch unless cache miss.

Variants:
    V0 Baseline        — SL=p80_all, TP1=p60_winners, TP2=p80_winners, BE after TP1
    V1 WidenTP2        — Same as V0 but TP2 = PFE p90 winners
    V2 Trail           — Same SL/TP1/TP2 as V0 but BE→peak-retrace trailing (0.5%)
    V3 WidenTP2+Trail  — V1 + V2 combined

Usage (fully cached — runs in a few seconds):
    python3 backtest_hl_lanes_mode_a_v2.py \\
        [--signals-csv /tmp/mode_a_laptop/signals.csv] \\
        [--cache-dir /tmp/hl_candles_laptop] \\
        [--v1-rows-csv /tmp/mode_a_laptop/rows.csv] \\
        [--out-dir /tmp/mode_a_laptop_v2] \\
        [--ssh-host root@204.168.185.24 --ssh-key ~/.ssh/algovault_deploy]

Outputs under --out-dir:
    rows.csv          one row per (signal, variant), all variants streamed
    summary.json      16-cell comparison matrix + ranking
    v0_regression.json  diff between v2 V0 rows and v1 rows.csv
    integrity_pre.json / integrity_post.json / integrity_diff.json

Stdlib only — runs anywhere Python 3.9+ is available.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# Import from v1 (same scripts/ directory) — re-use extractor, cache loader,
# and integrity helpers. v1 module name has no underscores-to-hyphens mismatch.
from backtest_hl_lanes_mode_a import (  # noqa: E402
    LANE_RECIPES as V1_RECIPES,
    FEE_TAKER_ROUND_TRIP, FEE_STRESS,
    Candle, Signal, SignalOutcome,
    OUTCOME_WIN_TYPES,
    load_signals,
    candles_for_signal_window,
    replay_signal as v1_replay,
    capture_integrity,
    confidence_band,
    by_key,
)


# ----------------------------------------------------------------------
# Recipe variants
# ----------------------------------------------------------------------
# TP2 p90-winners values come from the Query 7 derivation table in
# `experiments/quant-trading-server/mae-pfe-percentile-report.md` (2026-04-17):
#   HL 5m  PFE p90 winners = 1.3676%
#   HL 15m PFE p90 winners = 1.9615%
TRAIL_PCT = 0.005

VARIANTS: Dict[str, Dict[str, Dict[str, float]]] = {
    "5m": {
        "V0": {"tp2Pct": 0.0081,  "exit_mode": "scale_out_be",    "trail_pct": 0.0},
        "V1": {"tp2Pct": 0.013676, "exit_mode": "scale_out_be",    "trail_pct": 0.0},
        "V2": {"tp2Pct": 0.0081,  "exit_mode": "scale_out_trail", "trail_pct": TRAIL_PCT},
        "V3": {"tp2Pct": 0.013676, "exit_mode": "scale_out_trail", "trail_pct": TRAIL_PCT},
    },
    "15m": {
        "V0": {"tp2Pct": 0.0124,  "exit_mode": "scale_out_be",    "trail_pct": 0.0},
        "V1": {"tp2Pct": 0.019615, "exit_mode": "scale_out_be",    "trail_pct": 0.0},
        "V2": {"tp2Pct": 0.0124,  "exit_mode": "scale_out_trail", "trail_pct": TRAIL_PCT},
        "V3": {"tp2Pct": 0.019615, "exit_mode": "scale_out_trail", "trail_pct": TRAIL_PCT},
    },
}

VARIANT_LABEL = {
    "V0": "Baseline",
    "V1": "WidenTP2 (p90)",
    "V2": "Trail 0.5%",
    "V3": "WidenTP2+Trail",
}


# ----------------------------------------------------------------------
# Replay engine — parameterized by exit_mode
# ----------------------------------------------------------------------
def replay_variant(
    signal: Signal,
    candles_1m: List[Candle],
    tf_recipe: Dict[str, float],
    variant_spec: Dict[str, float],
    *,
    tie_sl_first: bool = True,
    coverage_warning: bool = False,
) -> SignalOutcome:
    """Replay a signal under one variant recipe.

    V0/V1 (exit_mode='scale_out_be'): delegates to v1.replay_signal with the
    variant's TP2 override — guaranteed byte-identical to v1 for V0.

    V2/V3 (exit_mode='scale_out_trail'): local walk with peak-retrace trailing
    stop on the runner leg after TP1 fills. Trail level = max(entry, peak ×
    (1 − trail_pct)) for BUY (mirrored for SELL).
    """
    # Merge recipe + variant
    recipe = dict(tf_recipe)
    recipe["tp2Pct"] = variant_spec["tp2Pct"]
    exit_mode = variant_spec["exit_mode"]

    if exit_mode == "scale_out_be":
        return v1_replay(signal, candles_1m, recipe,
                         tie_sl_first=tie_sl_first,
                         coverage_warning=coverage_warning)

    # Trail mode: walk bars ourselves.
    entry = signal.entry_price
    sl_pct = recipe["stopLossPct"]
    tp1_pct = recipe["tp1Pct"]
    tp2_pct = recipe["tp2Pct"]
    tp1_frac = recipe["tp1Fraction"]
    tf_seconds = int(recipe["tf_seconds"])
    max_hold_seconds = int(recipe["maxHoldCandles"]) * tf_seconds
    trail_pct = variant_spec["trail_pct"]

    if not candles_1m:
        return SignalOutcome(
            signal_id=signal.signal_id, symbol=signal.coin,
            timeframe=signal.timeframe, direction=signal.direction,
            confidence=signal.confidence, created_at=signal.created_at,
            entry_price=entry,
            outcome_type="NO_DATA", realized_pnl_pct=0.0,
            tp1_hit_ts=None, tp2_hit_ts=None, sl_hit_ts=None, exit_ts=None,
            candles_to_exit=0, same_bar_tp1_sl_tie=False,
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
    sl_hit_ts: Optional[int] = None
    tp2_hit_ts: Optional[int] = None
    trail_exit_ts: Optional[int] = None
    exit_ts: Optional[int] = None
    realized_pct = 0.0
    same_bar_tie = False
    remaining = 1.0

    # Peak tracking (initialised when TP1 fills)
    peak: Optional[float] = None

    cutoff_ms = (signal.created_at + max_hold_seconds) * 1000
    last_bar = candles_1m[-1]
    candles_seen = 0

    for bar in candles_1m:
        if bar.t_ms > cutoff_ms:
            break
        candles_seen += 1

        if tp1_hit_ts is None:
            # Phase 1 — identical to v1's pre-TP1 logic
            if is_buy:
                tp1_crossed = bar.h >= tp1_price
                sl_crossed = bar.l <= sl_price
            else:
                tp1_crossed = bar.l <= tp1_price
                sl_crossed = bar.h >= sl_price

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
                        entry_price=entry,
                        outcome_type="SL", realized_pnl_pct=realized_pct,
                        tp1_hit_ts=None, tp2_hit_ts=None, sl_hit_ts=sl_hit_ts,
                        exit_ts=exit_ts, candles_to_exit=candles_seen,
                        same_bar_tp1_sl_tie=True, coverage_warning=coverage_warning,
                    )
                # tie_sl_first=False branch: TP1 first → runner engages trail
                realized_pct += tp1_pct * tp1_frac
                remaining -= tp1_frac
                tp1_hit_ts = bar.t_ms
                peak = tp1_price
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
                    entry_price=entry,
                    outcome_type="SL", realized_pnl_pct=realized_pct,
                    tp1_hit_ts=None, tp2_hit_ts=None, sl_hit_ts=sl_hit_ts,
                    exit_ts=exit_ts, candles_to_exit=candles_seen,
                    same_bar_tp1_sl_tie=False, coverage_warning=coverage_warning,
                )
            elif tp1_crossed:
                realized_pct += tp1_pct * tp1_frac
                remaining -= tp1_frac
                tp1_hit_ts = bar.t_ms
                peak = tp1_price
                continue
        else:
            # Phase 2 (post-TP1) with trailing stop
            assert peak is not None
            # Update peak from this bar's extremes
            if is_buy:
                peak = max(peak, bar.h)
                trail_level = max(entry, peak * (1 - trail_pct))
                tp2_crossed = bar.h >= tp2_price
                trail_crossed = bar.l <= trail_level
            else:
                peak = min(peak, bar.l)
                trail_level = min(entry, peak * (1 + trail_pct))
                tp2_crossed = bar.l <= tp2_price
                trail_crossed = bar.h >= trail_level

            # Same-bar tie resolution: TP2 is an absolute favorable limit at a
            # level reached during the bar's ascent; trail only fires AFTER a
            # retrace from peak. If bar.high ≥ tp2_price, the limit-sell fills
            # on the way up — before the retrace that would trigger trail.
            # Therefore TP2 takes priority over trail on ties.
            if tp2_crossed:
                realized_pct += tp2_pct * remaining
                tp2_hit_ts = bar.t_ms
                return SignalOutcome(
                    signal_id=signal.signal_id, symbol=signal.coin,
                    timeframe=signal.timeframe, direction=signal.direction,
                    confidence=signal.confidence, created_at=signal.created_at,
                    entry_price=entry,
                    outcome_type="TP1_TP2", realized_pnl_pct=realized_pct,
                    tp1_hit_ts=tp1_hit_ts, tp2_hit_ts=tp2_hit_ts, sl_hit_ts=None,
                    exit_ts=tp2_hit_ts, candles_to_exit=candles_seen,
                    same_bar_tp1_sl_tie=same_bar_tie, coverage_warning=coverage_warning,
                )
            if trail_crossed:
                if is_buy:
                    runner_pnl = (trail_level - entry) / entry
                else:
                    runner_pnl = (entry - trail_level) / entry
                realized_pct += runner_pnl * remaining
                trail_exit_ts = bar.t_ms
                return SignalOutcome(
                    signal_id=signal.signal_id, symbol=signal.coin,
                    timeframe=signal.timeframe, direction=signal.direction,
                    confidence=signal.confidence, created_at=signal.created_at,
                    entry_price=entry,
                    outcome_type="TP1_TRAIL", realized_pnl_pct=realized_pct,
                    tp1_hit_ts=tp1_hit_ts, tp2_hit_ts=None, sl_hit_ts=trail_exit_ts,
                    exit_ts=trail_exit_ts, candles_to_exit=candles_seen,
                    same_bar_tp1_sl_tie=same_bar_tie, coverage_warning=coverage_warning,
                )

    # Time-expired
    last_close = last_bar.c
    if tp1_hit_ts is not None:
        if is_buy:
            runner_pnl = (last_close - entry) / entry
        else:
            runner_pnl = (entry - last_close) / entry
        realized_pct += runner_pnl * remaining
        return SignalOutcome(
            signal_id=signal.signal_id, symbol=signal.coin,
            timeframe=signal.timeframe, direction=signal.direction,
            confidence=signal.confidence, created_at=signal.created_at,
            entry_price=entry,
            outcome_type="TP1_TIME", realized_pnl_pct=realized_pct,
            tp1_hit_ts=tp1_hit_ts, tp2_hit_ts=None, sl_hit_ts=None,
            exit_ts=last_bar.t_ms, candles_to_exit=candles_seen,
            same_bar_tp1_sl_tie=same_bar_tie, coverage_warning=coverage_warning,
        )
    # No TP1 fill, no SL — flat time exit
    if is_buy:
        pnl = (last_close - entry) / entry
    else:
        pnl = (entry - last_close) / entry
    return SignalOutcome(
        signal_id=signal.signal_id, symbol=signal.coin,
        timeframe=signal.timeframe, direction=signal.direction,
        confidence=signal.confidence, created_at=signal.created_at,
        entry_price=entry,
        outcome_type="TIME_POSITIVE" if pnl > 0 else "TIME_NEGATIVE",
        realized_pnl_pct=pnl,
        tp1_hit_ts=None, tp2_hit_ts=None, sl_hit_ts=None,
        exit_ts=last_bar.t_ms, candles_to_exit=candles_seen,
        same_bar_tp1_sl_tie=same_bar_tie, coverage_warning=coverage_warning,
    )


# ----------------------------------------------------------------------
# Aggregation (16 cells: 2 timeframes × 4 variants × 2 conf gates)
# ----------------------------------------------------------------------
OUTCOME_ORDER = [
    "SL", "TP1_BE", "TP1_TRAIL", "TP1_TP2", "TP1_TIME",
    "TIME_POSITIVE", "TIME_NEGATIVE", "NO_DATA",
]
WIN_TYPES = {"TP1_BE", "TP1_TRAIL", "TP1_TP2", "TP1_TIME", "TIME_POSITIVE"}


def aggregate_cell(outcomes: List[SignalOutcome]) -> Dict:
    if not outcomes:
        return {"n_total": 0, "n_valid": 0}
    mix = {t: 0 for t in OUTCOME_ORDER}
    for o in outcomes:
        mix[o.outcome_type] = mix.get(o.outcome_type, 0) + 1
    valid = [o for o in outcomes if o.outcome_type != "NO_DATA"]
    n_valid = len(valid)
    if n_valid == 0:
        return {"n_total": len(outcomes), "n_valid": 0, "outcome_mix": mix}
    wins = sum(1 for o in valid if o.outcome_type in WIN_TYPES)
    pnl = [o.realized_pnl_pct for o in valid]
    mean = sum(pnl) / n_valid
    sq = sum((p - mean) ** 2 for p in pnl)
    stdev = (sq / (n_valid - 1)) ** 0.5 if n_valid > 1 else 0.0
    return {
        "n_total": len(outcomes),
        "n_valid": n_valid,
        "outcome_mix": mix,
        "outcome_wr_pct": 100.0 * wins / n_valid,
        "gross_avg_pnl_pct": mean * 100,
        "net_avg_pnl_pct": (mean - FEE_TAKER_ROUND_TRIP) * 100,
        "stress_avg_pnl_pct": (mean - FEE_STRESS) * 100,
        "pnl_stdev_pct": stdev * 100,
        "max_loss_pct": min(pnl) * 100,
        "max_gain_pct": max(pnl) * 100,
    }


def rank_cells(cells: Dict[Tuple[str, str, str], Dict]) -> List[Tuple[Tuple[str, str, str], float, Dict]]:
    ranked = []
    for key, stats in cells.items():
        if stats.get("n_valid", 0) < 20:
            score = -999.0
        else:
            score = stats["net_avg_pnl_pct"] * math.sqrt(stats["n_valid"])
        ranked.append((key, score, stats))
    ranked.sort(key=lambda t: -t[1])
    return ranked


# ----------------------------------------------------------------------
# V0 regression: compare v2 V0 rows with v1 rows.csv
# ----------------------------------------------------------------------
def load_v1_rows(path: str) -> Dict[int, Dict[str, str]]:
    rows: Dict[int, Dict[str, str]] = {}
    with open(path) as fh:
        r = csv.DictReader(fh)
        for row in r:
            rows[int(row["signal_id"])] = row
    return rows


def v0_regression(
    v0_outcomes: List[SignalOutcome],
    v1_rows: Dict[int, Dict[str, str]],
    tolerance: float = 1e-6,
) -> Dict:
    checked = 0
    diffs: List[Dict] = []
    for o in v0_outcomes:
        r = v1_rows.get(o.signal_id)
        if not r:
            continue
        checked += 1
        if o.outcome_type != r["outcome_type"]:
            diffs.append({
                "signal_id": o.signal_id,
                "field": "outcome_type",
                "v2": o.outcome_type, "v1": r["outcome_type"],
            })
            continue
        v1_pnl = float(r["realized_pnl_pct"])
        if abs(o.realized_pnl_pct - v1_pnl) > tolerance:
            diffs.append({
                "signal_id": o.signal_id,
                "field": "realized_pnl_pct",
                "v2": o.realized_pnl_pct, "v1": v1_pnl,
            })
    return {"checked": checked, "n_diffs": len(diffs), "sample_diffs": diffs[:10]}


# ----------------------------------------------------------------------
# Orchestration
# ----------------------------------------------------------------------
def run(args) -> int:
    os.makedirs(args.out_dir, exist_ok=True)

    integ_pre_path = os.path.join(args.out_dir, "integrity_pre.json")
    integ_post_path = os.path.join(args.out_dir, "integrity_post.json")

    print(f"[1/6] integrity pre-run → {integ_pre_path}")
    pre = capture_integrity(integ_pre_path, args.ssh_host, args.ssh_key)
    print(f"       db: {pre['db']}, urls: {[(k, v['status']) for k, v in pre['urls'].items()]}")

    print("[2/6] loading signals")
    signals = load_signals(args.signals_csv)
    print(f"       loaded {len(signals)} signals "
          f"({sum(1 for s in signals if s.timeframe=='5m')} 5m / "
          f"{sum(1 for s in signals if s.timeframe=='15m')} 15m)")

    print("[3/6] running 4 variants per signal")
    rows_path = os.path.join(args.out_dir, "rows.csv")
    all_outcomes: Dict[str, List[SignalOutcome]] = {v: [] for v in VARIANTS["5m"]}
    with open(rows_path, "w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow([
            "signal_id", "variant_id", "timeframe", "direction", "confidence",
            "symbol", "created_at", "outcome_type", "realized_pnl_pct",
            "tp1_hit_ts", "tp2_hit_ts", "sl_hit_ts", "trail_exit_ts", "exit_ts",
            "candles_to_exit", "same_bar_tp1_sl_tie", "coverage_warning",
        ])

        for i, s in enumerate(signals):
            if i % 500 == 0 and i > 0:
                print(f"       {i}/{len(signals)}")
            recipe = V1_RECIPES[s.timeframe]
            max_hold_seconds = int(recipe["maxHoldCandles"]) * int(recipe["tf_seconds"])
            bars, cov_warn = candles_for_signal_window(
                args.cache_dir, s.coin, s.created_at, max_hold_seconds
            )
            for vid, vspec in VARIANTS[s.timeframe].items():
                o = replay_variant(s, bars, recipe, vspec,
                                   tie_sl_first=True, coverage_warning=cov_warn)
                all_outcomes[vid].append(o)
                trail_ts = ""
                # TP1_TRAIL uses sl_hit_ts internally for storage; re-name for CSV clarity
                if o.outcome_type == "TP1_TRAIL":
                    trail_ts = o.sl_hit_ts or ""
                    sl_ts_for_csv = ""
                else:
                    sl_ts_for_csv = o.sl_hit_ts or ""
                writer.writerow([
                    o.signal_id, vid, o.timeframe, o.direction, o.confidence,
                    o.symbol, o.created_at, o.outcome_type,
                    f"{o.realized_pnl_pct:.8f}",
                    o.tp1_hit_ts or "", o.tp2_hit_ts or "",
                    sl_ts_for_csv, trail_ts, o.exit_ts or "",
                    o.candles_to_exit, o.same_bar_tp1_sl_tie, o.coverage_warning,
                ])
    total_rows = sum(len(v) for v in all_outcomes.values())
    print(f"       wrote {total_rows} (signal × variant) rows → {rows_path}")

    print("[4/6] V0 regression vs v1 rows")
    v1_rows = load_v1_rows(args.v1_rows_csv)
    v0_check = v0_regression(all_outcomes["V0"], v1_rows)
    v0_reg_path = os.path.join(args.out_dir, "v0_regression.json")
    with open(v0_reg_path, "w") as fh:
        json.dump(v0_check, fh, indent=2)
    print(f"       checked={v0_check['checked']} diffs={v0_check['n_diffs']}")
    if v0_check["n_diffs"] > 0:
        print(f"       WARNING: V0 regression drift detected. Sample: {v0_check['sample_diffs'][:3]}")

    print("[5/6] aggregating 16 cells")
    cells: Dict[Tuple[str, str, str], Dict] = {}
    for tf in ("5m", "15m"):
        for vid in ("V0", "V1", "V2", "V3"):
            outs = [o for o in all_outcomes[vid] if o.timeframe == tf]
            for gate in ("all", "conf70"):
                if gate == "conf70":
                    outs_g = [o for o in outs if o.confidence >= 70]
                else:
                    outs_g = outs
                cells[(tf, vid, gate)] = aggregate_cell(outs_g)

    ranked = rank_cells(cells)

    summary = {
        "variants": {vid: {"label": VARIANT_LABEL[vid], **vspec}
                     for vid, vspec in VARIANTS["5m"].items()},
        "cells": {f"{k[0]}|{k[1]}|{k[2]}": v for k, v in cells.items()},
        "ranking": [
            {"tf": k[0], "variant": k[1], "gate": k[2],
             "score_net_x_sqrt_n": round(score, 6),
             "n_valid": stats.get("n_valid"),
             "net_avg_pnl_pct": stats.get("net_avg_pnl_pct"),
             "outcome_wr_pct": stats.get("outcome_wr_pct")}
            for (k, score, stats) in ranked
        ],
        "v0_regression": v0_check,
        "winner": None,
        "winner_margin": None,
    }
    # Winner: top ranked with score > 0 and margin check
    top_positive = [r for r in ranked if r[1] > 0]
    if top_positive:
        winner = top_positive[0]
        summary["winner"] = {
            "tf": winner[0][0], "variant": winner[0][1], "gate": winner[0][2],
            "net_avg_pnl_pct": winner[2]["net_avg_pnl_pct"],
            "n_valid": winner[2]["n_valid"],
            "score_net_x_sqrt_n": winner[1],
        }
        if len(top_positive) > 1:
            second = top_positive[1]
            ratio = winner[1] / second[1] if second[1] > 0 else float("inf")
            summary["winner_margin"] = {
                "runner_up": {"tf": second[0][0], "variant": second[0][1],
                              "gate": second[0][2], "score": second[1]},
                "ratio_winner_over_runner_up": round(ratio, 3),
                "clear": ratio >= 2.0,
            }

    summary_path = os.path.join(args.out_dir, "summary.json")
    with open(summary_path, "w") as fh:
        json.dump(summary, fh, indent=2, default=str)
    print(f"       wrote summary → {summary_path}")

    print(f"[6/6] integrity post-run → {integ_post_path}")
    post = capture_integrity(integ_post_path, args.ssh_host, args.ssh_key)
    ok_hl = (pre["db"]["hl_total"] == post["db"]["hl_total"]
             and pre["db"]["hl_evaluated"] == post["db"]["hl_evaluated"])
    url_deltas = {
        name: pre["urls"][name]["sha256"] == post["urls"][name]["sha256"]
        for name in pre["urls"]
    }
    with open(os.path.join(args.out_dir, "integrity_diff.json"), "w") as fh:
        json.dump({
            "pre_db": pre["db"], "post_db": post["db"],
            "ok_hl_subset": ok_hl,
            "url_equal": url_deltas,
            "overall_strict_ok": ok_hl and all(url_deltas.values()),
        }, fh, indent=2)
    print(f"       HL subset byte-identical: {ok_hl}; url equal: {url_deltas}")

    print("\n--- TOP 5 CELLS BY net × √n_valid ---")
    for key, score, stats in ranked[:5]:
        tf, vid, gate = key
        n = stats.get("n_valid", 0)
        net = stats.get("net_avg_pnl_pct", float("nan"))
        wr = stats.get("outcome_wr_pct", float("nan"))
        print(f"  {tf:>3} {vid} {gate:>6} n={n:>4} WR={wr:>5.2f}% net={net:+.4f}% score={score:+.4f}")
    return 0 if ok_hl else 2


def main():
    ap = argparse.ArgumentParser(description="Mode A v2 recipe-variant backtest")
    ap.add_argument("--signals-csv", default="/tmp/mode_a_laptop/signals.csv",
                    help="Path to v1's extracted signals CSV (re-used unchanged).")
    ap.add_argument("--cache-dir", default="/tmp/hl_candles_laptop",
                    help="Path to v1's candle cache directory.")
    ap.add_argument("--v1-rows-csv", default="/tmp/mode_a_laptop/rows.csv",
                    help="Path to v1's rows.csv for V0 regression check.")
    ap.add_argument("--out-dir", default="/tmp/mode_a_laptop_v2")
    ap.add_argument("--ssh-host", default=None,
                    help="Run docker-exec calls via ssh when driving from a laptop.")
    ap.add_argument("--ssh-key", default=None)
    args = ap.parse_args()
    sys.exit(run(args))


if __name__ == "__main__":
    main()

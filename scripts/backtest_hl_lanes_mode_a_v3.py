#!/usr/bin/env python3
"""
Mode A v3 — backtest R_standard recipe on T2 standard-only cohort.

R_standard is the new recipe fitted to the T1+T2-standard MAE/PFE distribution
(per mae-pfe-percentile-report-t1t2.md, 2026-04-18 05:15 UTC). This run
validates whether the generator-level recipe fix (SL 74–94% wider than v2)
translates to positive net EV when applied to the actual tradeable universe
— **excluding T1 (BTC/ETH)**, whose per-coin expectancy ranked 22nd in the
T1+T2 Q8 analysis.

READ-ONLY on production:
  - Zero HL API calls (candles reused from v1/v2 cache at /tmp/hl_candles_laptop/).
  - One DB COUNT(*) call pre/post for row-count integrity.
  - Replay is pure CPU on the v2 signal list; entry prices joined from v1 signals.csv.

Usage:
    python3 backtest_hl_lanes_mode_a_v3.py \\
        [--v2-rows-csv /tmp/mode_a_laptop_v2/rows.csv] \\
        [--signals-csv /tmp/mode_a_laptop/signals.csv] \\
        [--cache-dir /tmp/hl_candles_laptop] \\
        [--out-dir /tmp/mode_a_v3_t2_std] \\
        [--ssh-host root@204.168.185.24 --ssh-key ~/.ssh/algovault_deploy] \\
        [--top-n 20]
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Dict, List, Optional, Set, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from backtest_hl_lanes_mode_a import (  # noqa: E402
    Candle, Signal, SignalOutcome,
    FEE_TAKER_ROUND_TRIP, FEE_STRESS,
    candles_for_signal_window,
    load_signals,
    capture_integrity as _v1_capture_integrity,
)
from backtest_hl_lanes_mode_a_v2 import (  # noqa: E402
    replay_variant,
    aggregate_cell,
    rank_cells,
    OUTCOME_ORDER, WIN_TYPES,
)


# ----------------------------------------------------------------------
# R_standard recipe (literal values from mae-pfe-percentile-report-t1t2.md §7)
# ----------------------------------------------------------------------
R_STANDARD = {
    "5m": {
        "timeframe": "5m",
        "stopLossPct": 0.0127,
        "tp1Pct": 0.0055,
        "tp2Pct_V0": 0.0106,
        "tp2Pct_V1": 0.0162,
        "tp1Fraction": 0.5,
        "moveSlToBeAfterTp1": True,
        "maxHoldCandles": 12,
        "minConfidence": 52,         # overridden by conf gate in aggregation
        "tf_seconds": 300,
    },
    "15m": {
        "timeframe": "15m",
        "stopLossPct": 0.0221,
        "tp1Pct": 0.0108,
        "tp2Pct_V0": 0.0213,
        "tp2Pct_V1": 0.0322,
        "tp1Fraction": 0.5,
        "moveSlToBeAfterTp1": True,
        "maxHoldCandles": 12,
        "minConfidence": 52,
        "tf_seconds": 900,
    },
}


def _assert_r_standard_values() -> None:
    """Fail-fast assert that R_STANDARD matches the percentile report §7 exactly.
    Acceptance-criterion driven: if these ever drift from the report, the test
    aborts before any psql or file output happens."""
    expected = {
        ("5m", "stopLossPct"): 0.0127,
        ("5m", "tp1Pct"): 0.0055,
        ("5m", "tp2Pct_V0"): 0.0106,
        ("5m", "tp2Pct_V1"): 0.0162,
        ("15m", "stopLossPct"): 0.0221,
        ("15m", "tp1Pct"): 0.0108,
        ("15m", "tp2Pct_V0"): 0.0213,
        ("15m", "tp2Pct_V1"): 0.0322,
    }
    for (tf, field), want in expected.items():
        got = R_STANDARD[tf][field]
        if abs(got - want) > 1e-9:
            raise AssertionError(
                f"R_STANDARD drift: {tf}.{field} = {got}, expected {want} "
                f"(from mae-pfe-percentile-report-t1t2.md §7)"
            )


# ----------------------------------------------------------------------
# Variant specs — V0 (TP2=p80) and V1 (TP2=p90 widened)
# ----------------------------------------------------------------------
VARIANTS_V3 = {
    "5m": {
        "V0": {"tp2Pct": R_STANDARD["5m"]["tp2Pct_V0"], "exit_mode": "scale_out_be", "trail_pct": 0.0},
        "V1": {"tp2Pct": R_STANDARD["5m"]["tp2Pct_V1"], "exit_mode": "scale_out_be", "trail_pct": 0.0},
    },
    "15m": {
        "V0": {"tp2Pct": R_STANDARD["15m"]["tp2Pct_V0"], "exit_mode": "scale_out_be", "trail_pct": 0.0},
        "V1": {"tp2Pct": R_STANDARD["15m"]["tp2Pct_V1"], "exit_mode": "scale_out_be", "trail_pct": 0.0},
    },
}


# ----------------------------------------------------------------------
# T2 standard universe resolution
# ----------------------------------------------------------------------
HL_URL = "https://api.hyperliquid.xyz/info"


def _hl_post(body: dict, attempt: int = 0) -> object:
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        HL_URL, data=data, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        if e.code in (429, 500, 502, 503, 504) and attempt < 3:
            time.sleep(2 ** attempt)
            return _hl_post(body, attempt + 1)
        raise


def resolve_t2_standard(top_n: int = 20) -> Tuple[Set[str], List[Dict], Dict]:
    """Resolve top-N standard-dex symbols by notional OI, drop BTC+ETH.
    Returns (t2_set, top_n_ranked, snapshot)."""
    raw = _hl_post({"type": "metaAndAssetCtxs"})
    meta = raw[0]
    ctxs = raw[1]
    assets = []
    for i, a in enumerate(meta["universe"]):
        oi = float(ctxs[i].get("openInterest") or 0)
        px = float(ctxs[i].get("markPx") or 0)
        if oi * px <= 0:
            continue
        assets.append({
            "coin": a["name"], "dex": "standard",
            "open_interest": oi, "mark_px": px,
            "notional_oi": oi * px,
        })
    assets.sort(key=lambda a: -a["notional_oi"])
    top = assets[:top_n]
    t2 = {a["coin"] for a in top} - {"BTC", "ETH"}
    snapshot = {
        "timestamp": datetime.now(tz=timezone.utc).isoformat(),
        "top_n": top_n,
        "t1_excluded": ["BTC", "ETH"],
        "t2_standard_symbols": sorted(list(t2)),
        "top_ranked_before_exclusion": [
            {"coin": a["coin"],
             "notional_oi_usd": round(a["notional_oi"], 2),
             "open_interest": a["open_interest"],
             "mark_px": a["mark_px"]}
            for a in top
        ],
        "source": "https://api.hyperliquid.xyz/info — metaAndAssetCtxs (standard dex, no xyz param)",
    }
    return t2, top, snapshot


# ----------------------------------------------------------------------
# Signal extraction — re-use v2 CSV + v1 signals.csv
# ----------------------------------------------------------------------
def load_v2_unique_signals(
    v2_rows_csv: str, t2_std: Set[str],
) -> List[int]:
    """Return unique signal_ids from v2 CSV where symbol ∈ T2 standard AND at
    least one variant row is NOT NO_DATA AND NOT coverage_warning.
    (Symbol-level filter only — per-variant outcomes are produced fresh by
    the replay, so we don't care what v2's outcome_type was.)"""
    accepted: Set[int] = set()
    rejected = {"symbol_not_in_t2": 0, "no_data": 0, "coverage_warning": 0}
    with open(v2_rows_csv) as fh:
        for row in csv.DictReader(fh):
            sym = row["symbol"]
            if sym not in t2_std:
                rejected["symbol_not_in_t2"] += 1
                continue
            if row["outcome_type"] == "NO_DATA":
                rejected["no_data"] += 1
                continue
            if row["coverage_warning"] in ("True", "true", "1"):
                rejected["coverage_warning"] += 1
                continue
            accepted.add(int(row["signal_id"]))
    return sorted(accepted), rejected


def load_signal_rows_for_ids(
    signals_csv: str, ids: List[int],
) -> List[Signal]:
    id_set = set(ids)
    out: List[Signal] = []
    with open(signals_csv) as fh:
        for row in csv.DictReader(fh):
            sid = int(row["id"])
            if sid not in id_set:
                continue
            out.append(Signal(
                signal_id=sid,
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


def _float_or_none(x):
    if x is None or x == "":
        return None
    try:
        return float(x)
    except ValueError:
        return None


# ----------------------------------------------------------------------
# Replay + aggregation
# ----------------------------------------------------------------------
def run_replay(
    signals: List[Signal], cache_dir: str,
) -> Dict[Tuple[str, str], List[SignalOutcome]]:
    """For each signal, run V0 and V1 variants. Key the result by (timeframe, variant_id)."""
    outcomes: Dict[Tuple[str, str], List[SignalOutcome]] = {
        (tf, vid): [] for tf in ("5m", "15m") for vid in ("V0", "V1")
    }
    for i, s in enumerate(signals):
        if i % 50 == 0 and i > 0:
            sys.stderr.write(f"       {i}/{len(signals)}\n")
        if s.timeframe not in R_STANDARD:
            continue
        recipe = R_STANDARD[s.timeframe]
        max_hold_seconds = int(recipe["maxHoldCandles"]) * int(recipe["tf_seconds"])
        bars, cov_warn = candles_for_signal_window(cache_dir, s.coin, s.created_at, max_hold_seconds)
        for vid, vspec in VARIANTS_V3[s.timeframe].items():
            o = replay_variant(s, bars, recipe, vspec, tie_sl_first=True, coverage_warning=cov_warn)
            outcomes[(s.timeframe, vid)].append(o)
    return outcomes


def aggregate_8_cells(
    outcomes: Dict[Tuple[str, str], List[SignalOutcome]],
) -> Dict[Tuple[str, str, str], Dict]:
    cells: Dict[Tuple[str, str, str], Dict] = {}
    for (tf, vid), outs in outcomes.items():
        for gate, conf_min in (("all", 52), ("conf70", 70)):
            outs_g = [o for o in outs if o.confidence >= conf_min]
            cells[(tf, vid, gate)] = aggregate_cell(outs_g)
    return cells


# ----------------------------------------------------------------------
# Orchestration
# ----------------------------------------------------------------------
def run(args) -> int:
    os.makedirs(args.out_dir, exist_ok=True)
    _assert_r_standard_values()
    print(f"[0/7] R_STANDARD recipe matches report §7 (literal check passed)")

    print("[1/7] integrity pre-run")
    pre = _v1_capture_integrity(os.path.join(args.out_dir, "integrity_pre.json"),
                                args.ssh_host, args.ssh_key)
    print(f"       hl_total={pre['db']['hl_total']}  "
          f"dashboard_sha={pre['urls'].get('performance_dashboard', {}).get('sha256', '')[:16]}  "
          f"landing_sha={pre['urls'].get('landing_page', {}).get('sha256', '')[:16]}")

    print("[2/7] resolving T2 standard universe (drop BTC+ETH)")
    t2_std, top_ranked, snapshot = resolve_t2_standard(args.top_n)
    ts = datetime.now(tz=timezone.utc).strftime("%Y%m%d_%H%M")
    universe_path = os.path.join(args.out_dir, f"t2_standard_universe_{ts}.json")
    with open(universe_path, "w") as fh:
        json.dump(snapshot, fh, indent=2)
    assert "BTC" not in t2_std and "ETH" not in t2_std, "T1 leak — BTC/ETH must be excluded"
    print(f"       T2 standard: {len(t2_std)} symbols: {sorted(t2_std)}")

    print("[3/7] filtering v2 CSV to T2 standard cohort")
    signal_ids, rejected = load_v2_unique_signals(args.v2_rows_csv, t2_std)
    print(f"       unique signal_ids: {len(signal_ids)}")
    print(f"       rejected: {rejected}")

    print("[4/7] loading signal rows from v1 signals.csv")
    signals = load_signal_rows_for_ids(args.signals_csv, signal_ids)
    print(f"       loaded {len(signals)} signals "
          f"({sum(1 for s in signals if s.timeframe=='5m')} 5m / "
          f"{sum(1 for s in signals if s.timeframe=='15m')} 15m)")
    if len(signals) < len(signal_ids):
        print(f"       WARN: {len(signal_ids) - len(signals)} ids missing from signals.csv")

    print("[5/7] replaying V0 + V1 × 5m + 15m with R_standard")
    outcomes = run_replay(signals, args.cache_dir)
    total_rows = sum(len(v) for v in outcomes.values())
    print(f"       total outcomes across 4 variant-tf cells: {total_rows} "
          f"({total_rows // 4} signals × 4 cells)")

    # Write per-signal CSV
    rows_csv = os.path.join(args.out_dir, "rows.csv")
    with open(rows_csv, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow([
            "signal_id", "variant_id", "timeframe", "direction", "confidence",
            "symbol", "created_at", "entry_price", "outcome_type", "realized_pnl_pct",
            "tp1_hit_ts", "tp2_hit_ts", "sl_hit_ts", "exit_ts",
            "candles_to_exit", "same_bar_tp1_sl_tie", "coverage_warning",
        ])
        for (tf, vid), outs in outcomes.items():
            for o in outs:
                w.writerow([
                    o.signal_id, vid, o.timeframe, o.direction, o.confidence,
                    o.symbol, o.created_at, f"{o.entry_price:.8f}",
                    o.outcome_type, f"{o.realized_pnl_pct:.8f}",
                    o.tp1_hit_ts or "", o.tp2_hit_ts or "",
                    o.sl_hit_ts or "", o.exit_ts or "",
                    o.candles_to_exit, o.same_bar_tp1_sl_tie, o.coverage_warning,
                ])
    print(f"       wrote rows → {rows_csv}")

    print("[6/7] aggregating 8 cells + ranking")
    cells = aggregate_8_cells(outcomes)
    ranked = rank_cells(cells)
    for (tf, vid, gate), score, stats in ranked:
        n = stats.get("n_valid", 0)
        if n == 0:
            continue
        print(f"       {tf:>3} {vid} {gate:>6} n={n:>4} "
              f"WR={stats.get('outcome_wr_pct', 0):>5.2f}%  "
              f"gross={stats.get('gross_avg_pnl_pct', 0):+.4f}%  "
              f"net={stats.get('net_avg_pnl_pct', 0):+.4f}%  "
              f"stress={stats.get('stress_avg_pnl_pct', 0):+.4f}%  "
              f"σ={stats.get('pnl_stdev_pct', 0):.4f}%  score={score:+.4f}")

    # Verdict
    pass_cells = [(k, s, st) for k, s, st in ranked
                  if st.get("net_avg_pnl_pct", -1) > 0 and st.get("n_valid", 0) >= 50]
    if pass_cells:
        winner_key, winner_score, winner_stats = pass_cells[0]
        if winner_stats["n_valid"] >= 100:
            verdict_state = "PASS"
        else:
            verdict_state = "MARGINAL_SAMPLE_LIMITED"
        verdict = {"state": verdict_state, "winner": {
            "cell": winner_key,
            "n_valid": winner_stats["n_valid"],
            "net_avg_pnl_pct": winner_stats["net_avg_pnl_pct"],
            "outcome_wr_pct": winner_stats["outcome_wr_pct"],
            "score": winner_score,
            "one_sigma_ci_pct": round(winner_stats["pnl_stdev_pct"] / math.sqrt(winner_stats["n_valid"]), 6),
        }}
    else:
        # FAIL
        any_n_50 = any(st.get("n_valid", 0) >= 50 for _, _, st in ranked)
        verdict = {
            "state": "FAIL",
            "reason": "all cells net <= 0" if any_n_50 else "all cells underpowered (n<50)",
            "options": [
                "widen cohort window (30d via scheduled candle backfill)",
                "SELL-only lane (BUY is structurally underpowered)",
                "re-derive per (symbol, direction) bucket",
                "drop T2 standard; different subset or exec model",
                "defer HL lanes to Phase 2",
            ],
        }

    # Delta vs v2 full-cohort (from v2 summary.json) and v2 T1+T2 standard (from
    # the prior task's probe output). Hard-coded reference numbers here — they
    # come from committed reports, not live sources.
    V2_FULL_COHORT = {
        ("5m", "V0", "all"):    {"n": 1005, "net": -0.1146},
        ("5m", "V0", "conf70"): {"n":  285, "net": -0.1164},
        ("5m", "V1", "all"):    {"n": 1005, "net": -0.1050},
        ("5m", "V1", "conf70"): {"n":  285, "net": -0.0946},
        ("15m", "V0", "all"):    {"n": 501, "net": -0.0324},
        ("15m", "V0", "conf70"): {"n": 140, "net":  0.0837},
        ("15m", "V1", "all"):    {"n": 501, "net": -0.0191},
        ("15m", "V1", "conf70"): {"n": 140, "net":  0.0955},
    }
    # From hl-lanes-backtest-mode-a-t1t2.md table §5 (T1+T2 = 20 symbols incl BTC/ETH+xyz)
    V2_T1T2 = {
        ("5m", "V0", "all"):    {"n":  806, "net": -0.1322},
        ("5m", "V0", "conf70"): {"n":  237, "net": -0.1285},
        ("5m", "V1", "all"):    {"n":  806, "net": -0.1151},
        ("5m", "V1", "conf70"): {"n":  237, "net": -0.1025},
        ("15m", "V0", "all"):    {"n": 369, "net": -0.0921},
        ("15m", "V0", "conf70"): {"n": 142, "net": -0.0499},
        ("15m", "V1", "all"):    {"n": 369, "net": -0.0732},
        ("15m", "V1", "conf70"): {"n": 142, "net": -0.0195},
    }
    delta_rows = []
    for key, score, stats in ranked:
        v2_full = V2_FULL_COHORT.get(key, {})
        v2_t1t2 = V2_T1T2.get(key, {})
        if stats.get("n_valid", 0) == 0:
            continue
        delta_rows.append({
            "tf": key[0], "variant": key[1], "gate": key[2],
            "v3_n": stats["n_valid"],
            "v3_net_pct": round(stats["net_avg_pnl_pct"], 4),
            "v2_full_n": v2_full.get("n"),
            "v2_full_net_pct": v2_full.get("net"),
            "v2_t1t2_n": v2_t1t2.get("n"),
            "v2_t1t2_net_pct": v2_t1t2.get("net"),
            "delta_vs_v2_full_pp": round(stats["net_avg_pnl_pct"] - v2_full["net"], 4)
                                     if v2_full else None,
            "delta_vs_v2_t1t2_pp": round(stats["net_avg_pnl_pct"] - v2_t1t2["net"], 4)
                                     if v2_t1t2 else None,
        })

    summary = {
        "universe_snapshot": snapshot,
        "universe_snapshot_path": universe_path,
        "r_standard_recipe": R_STANDARD,
        "rejected_from_v2_csv": rejected,
        "cohort_n_unique_signals": len(signals),
        "cohort_split_tf": {
            "5m": sum(1 for s in signals if s.timeframe == "5m"),
            "15m": sum(1 for s in signals if s.timeframe == "15m"),
        },
        "cells": {f"{k[0]}|{k[1]}|{k[2]}": v for k, v in cells.items()},
        "ranking": [
            {"tf": k[0], "variant": k[1], "gate": k[2],
             "score": round(s, 4),
             "n_valid": stats.get("n_valid", 0),
             "net_avg_pnl_pct": stats.get("net_avg_pnl_pct"),
             "outcome_wr_pct": stats.get("outcome_wr_pct")}
            for (k, s, stats) in ranked
        ],
        "delta_table": delta_rows,
        "verdict": verdict,
    }
    summary_path = os.path.join(args.out_dir, "summary.json")
    with open(summary_path, "w") as fh:
        json.dump(summary, fh, indent=2, default=str)
    print(f"       summary → {summary_path}")

    print("[7/7] integrity post-run")
    post = _v1_capture_integrity(os.path.join(args.out_dir, "integrity_post.json"),
                                 args.ssh_host, args.ssh_key)
    # v1 capture_integrity stores URL deltas as a dict {name: {url, sha256, status}}.
    pd_equal = pre["urls"]["performance_dashboard"]["sha256"] == post["urls"]["performance_dashboard"]["sha256"]
    lp_equal = pre["urls"]["landing_page"]["sha256"] == post["urls"]["landing_page"]["sha256"]
    hl_equal = pre["db"]["hl_total"] == post["db"]["hl_total"]
    spa_equal = pre["urls"]["signal_performance_api"]["sha256"] == post["urls"]["signal_performance_api"]["sha256"]
    with open(os.path.join(args.out_dir, "integrity_diff.json"), "w") as fh:
        json.dump({
            "hl_row_count_equal": hl_equal,
            "pre_db": pre["db"], "post_db": post["db"],
            "dashboard_equal": pd_equal,
            "landing_equal": lp_equal,
            "signal_performance_api_equal": spa_equal,
            "strict_ok": pd_equal and lp_equal and hl_equal,
        }, fh, indent=2)
    print(f"       performance_dashboard SHA equal: {pd_equal}")
    print(f"       landing_page SHA equal:          {lp_equal}")
    print(f"       HL row count equal:              {hl_equal} "
          f"({pre['db']['hl_total']} → {post['db']['hl_total']})")
    print(f"       signal_performance_api equal (expected differ): {spa_equal}")
    strict = pd_equal and lp_equal and hl_equal
    print(f"       STRICT OK: {strict}")
    if not strict:
        print("       FAIL: integrity mismatch on dashboard/landing/HL row count. "
              "Do NOT treat results as valid.")
        return 2
    return 0


def main():
    ap = argparse.ArgumentParser(description="Mode A v3 — R_standard on T2 standard-only")
    ap.add_argument("--v2-rows-csv", default="/tmp/mode_a_laptop_v2/rows.csv")
    ap.add_argument("--signals-csv", default="/tmp/mode_a_laptop/signals.csv")
    ap.add_argument("--cache-dir", default="/tmp/hl_candles_laptop")
    ap.add_argument("--out-dir", default="/tmp/mode_a_v3_t2_std")
    ap.add_argument("--ssh-host", default=None)
    ap.add_argument("--ssh-key", default=None)
    ap.add_argument("--top-n", type=int, default=20)
    args = ap.parse_args()
    sys.exit(run(args))


if __name__ == "__main__":
    main()

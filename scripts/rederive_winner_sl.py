#!/usr/bin/env python3
"""
Phase 1 — Re-derive SL from WINNER-MAE distribution only.

Root cause traced in hl-lanes-backtest-mode-a-v3-t2-standard.md §6:
  R_standard's stopLossPct = MAE p80 of ALL signals is the WRONG derivation —
  it widens SL to accommodate loser adverse excursions, which doesn't save
  winners and lets losers bleed further. Correct target: winner MAE only.

This script:
  1. Resolves T1+T2 universe (HL metaAndAssetCtxs, standard + xyz dexes).
  2. Runs ONE new SQL query: MAE percentiles on T1+T2 winners only
     (outcome_return_pct > 0), pooled across direction, grouped by
     (timeframe, dex) via three separate dex-filtered calls (combined,
     standard-only, xyz-only).
  3. Synthesizes R_standard_winners recipe (= R_standard with SL swapped).
  4. Directional sanity assert: new SL MUST be < R_standard SL per
     timeframe (losers have deeper MAE than winners — derivation error
     if this ever inverts).
  5. Writes summary JSON for Phase 2 consumption + CSV export.

READ-ONLY on production. Stdlib only. Runs from laptop via SSH + docker exec.

Usage:
    python3 rederive_winner_sl.py \\
        [--out-dir /tmp/mode_a_v4] \\
        [--ssh-host root@204.168.185.24 --ssh-key ~/.ssh/algovault_deploy] \\
        [--top-n 20]
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Dict, List, Optional, Set, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# Re-use universe resolution + SQL guard from the T1+T2 MAE/PFE script.
from query_mae_pfe_t1t2 import (  # noqa: E402
    sql_guard, sql_in_list,
    psql_csv, psql_scalar,
    resolve_t1_t2, classify_dex,
    capture_integrity, diff_integrity,
    INTEGRITY_URLS,
    POST_R6_EPOCH,
)


# ----------------------------------------------------------------------
# R_standard baseline (source: mae-pfe-percentile-report-t1t2.md §7)
# ----------------------------------------------------------------------
R_STANDARD = {
    "5m": {
        "stopLossPct": 0.0127,
        "tp1Pct": 0.0055,
        "tp2Pct_V0": 0.0106,
        "tp2Pct_V1": 0.0162,
    },
    "15m": {
        "stopLossPct": 0.0221,
        "tp1Pct": 0.0108,
        "tp2Pct_V0": 0.0213,
        "tp2Pct_V1": 0.0322,
    },
}


# ----------------------------------------------------------------------
# Winners-only pooled-direction MAE query
# ----------------------------------------------------------------------
def q_winners_pooled(symbols_sql: str) -> str:
    return f"""
WITH winners AS (
  SELECT
    timeframe,
    ABS(mae_return_pct) AS abs_mae
  FROM signals
  WHERE outcome_return_pct > 0
    AND signal IN ('BUY','SELL')
    AND exchange='HL'
    AND coin IN {symbols_sql}
    AND timeframe IN ('5m','15m')
    AND pfe_return_pct IS NOT NULL
    AND mae_return_pct IS NOT NULL
    AND created_at >= {POST_R6_EPOCH}
)
SELECT
  timeframe,
  COUNT(*) AS n,
  ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY abs_mae)::numeric, 4) AS mae_p50,
  ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY abs_mae)::numeric, 4) AS mae_p75,
  ROUND(PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY abs_mae)::numeric, 4) AS mae_p80,
  ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY abs_mae)::numeric, 4) AS mae_p90
FROM winners
GROUP BY timeframe
ORDER BY timeframe;
"""


# ----------------------------------------------------------------------
# Recipe synthesis + sanity assertion
# ----------------------------------------------------------------------
def synthesize_r_standard_winners(
    standard_rows: List[Dict[str, str]],
) -> Dict[str, Dict[str, float]]:
    """Build R_standard_winners: R_standard with stopLossPct swapped to
    mae_p80 from the WINNER distribution (standard-only).

    standard_rows is the output of q_winners_pooled filtered to the standard
    dex — one row per timeframe.
    """
    by_tf = {r["timeframe"]: r for r in standard_rows}
    out: Dict[str, Dict[str, float]] = {}
    for tf in ("5m", "15m"):
        if tf not in by_tf:
            raise RuntimeError(
                f"no winners row for timeframe {tf} in standard subset"
            )
        new_sl = float(by_tf[tf]["mae_p80"]) / 100  # percent → decimal
        base = R_STANDARD[tf]
        out[tf] = {
            "stopLossPct": round(new_sl, 6),
            "tp1Pct": base["tp1Pct"],
            "tp2Pct_V0": base["tp2Pct_V0"],
            "tp2Pct_V1": base["tp2Pct_V1"],
            "_n_winners": int(by_tf[tf]["n"]),
            "_mae_p80_winners_pct": float(by_tf[tf]["mae_p80"]),
            "_r_standard_sl": base["stopLossPct"],
            "_delta_pct": round(new_sl - base["stopLossPct"], 6),
        }
    return out


def directional_sanity_assert(r_std_winners: Dict[str, Dict[str, float]]) -> None:
    """Assert the new SL is tighter than R_standard per timeframe.

    Construction-level invariant: losers have deeper MAE than winners. If the
    new winner-based SL is ≥ R_standard's all-signals SL, the derivation is
    wrong — abort Phase 2.
    """
    violations = []
    for tf in ("5m", "15m"):
        new_sl = r_std_winners[tf]["stopLossPct"]
        r_std_sl = R_STANDARD[tf]["stopLossPct"]
        if new_sl >= r_std_sl:
            violations.append(
                f"{tf}: new SL ({new_sl}) >= R_standard SL ({r_std_sl})"
            )
    if violations:
        raise AssertionError(
            "Directional sanity assert FAILED. Winner-only SL should be "
            "strictly tighter than R_standard's all-signals SL (losers have "
            "deeper MAE than winners by construction). Violations:\n  "
            + "\n  ".join(violations)
        )


# ----------------------------------------------------------------------
# Orchestration
# ----------------------------------------------------------------------
def run(args) -> int:
    os.makedirs(args.out_dir, exist_ok=True)

    print("[1/5] integrity pre-run")
    pre = capture_integrity(args.ssh_host, args.ssh_key)
    pre_path = os.path.join(args.out_dir, "phase1_integrity_pre.json")
    with open(pre_path, "w") as fh:
        json.dump(pre, fh, indent=2)
    print(f"       hl_row_count={pre['hl_row_count']}  "
          f"dashboard_sha={pre['urls']['dashboard']['sha256'][:16]}  "
          f"landing_sha={pre['urls']['landing']['sha256'][:16]}")

    print("[2/5] resolving T1+T2 universe")
    t1_t2, dex_of, top_assets, snapshot = resolve_t1_t2(args.top_n)
    ts = datetime.now(tz=timezone.utc).strftime("%Y%m%d_%H%M")
    universe_path = os.path.join(args.out_dir, f"t1t2_universe_{ts}.json")
    with open(universe_path, "w") as fh:
        json.dump(snapshot, fh, indent=2)
    std_syms = {c for c, d in dex_of.items() if d == "standard"}
    xyz_syms = {c for c, d in dex_of.items() if d == "xyz"}
    print(f"       T1+T2: {len(t1_t2)} symbols "
          f"({len(std_syms)} standard + {len(xyz_syms)} xyz)")

    print("[3/5] querying winners-pooled MAE percentiles")
    combined_sql = sql_in_list(t1_t2)
    std_sql = sql_in_list(std_syms)
    xyz_sql = sql_in_list(xyz_syms)

    winners_by_variant: Dict[str, List[Dict[str, str]]] = {}
    for variant, sql_in in (("combined", combined_sql),
                             ("standard", std_sql),
                             ("xyz", xyz_sql)):
        rows = psql_csv(q_winners_pooled(sql_in), args.ssh_host, args.ssh_key)
        winners_by_variant[variant] = rows
        print(f"       {variant}:")
        for r in rows:
            print(f"         {r['timeframe']:>3}  n={r['n']:>4}  "
                  f"p50={r['mae_p50']:>7}%  p75={r['mae_p75']:>7}%  "
                  f"p80={r['mae_p80']:>7}%  p90={r['mae_p90']:>7}%")

    print("[4/5] synthesize R_standard_winners + directional sanity assert")
    r_std_winners = synthesize_r_standard_winners(winners_by_variant["standard"])
    sanity_passed = True
    sanity_error = None
    try:
        directional_sanity_assert(r_std_winners)
    except AssertionError as e:
        sanity_passed = False
        sanity_error = str(e)
        print(f"       🛑 {e}")
        # Per spec: abort Phase 2. Continue to post-integrity check to
        # confirm no DB mutation, then exit with summary written.

    for tf in ("5m", "15m"):
        rw = r_std_winners[tf]
        direction = "TIGHTER ✓" if rw["_delta_pct"] < 0 else "WIDER 🛑"
        print(f"       {tf} SL: R_standard={rw['_r_standard_sl']:.4f} "
              f"→ R_standard_winners={rw['stopLossPct']:.4f} "
              f"(Δ={rw['_delta_pct']:+.4f}, {direction}, n_winners={rw['_n_winners']})")

    # Write CSV export (winners-pooled percentiles across all 3 variants)
    csv_path = os.path.join(args.out_dir, "mae-pfe-winners-pooled.csv")
    with open(csv_path, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["variant", "timeframe", "n",
                                            "mae_p50", "mae_p75", "mae_p80", "mae_p90"])
        w.writeheader()
        for variant, rows in winners_by_variant.items():
            for r in rows:
                w.writerow({"variant": variant, **r})
    print(f"       CSV export → {csv_path}")

    print("[5/5] integrity post-run")
    post = capture_integrity(args.ssh_host, args.ssh_key)
    post_path = os.path.join(args.out_dir, "phase1_integrity_post.json")
    with open(post_path, "w") as fh:
        json.dump(post, fh, indent=2)
    diff = diff_integrity(pre, post)
    diff_path = os.path.join(args.out_dir, "phase1_integrity_diff.json")
    with open(diff_path, "w") as fh:
        json.dump(diff, fh, indent=2)
    print(f"       hl_row_count: pre={pre['hl_row_count']} "
          f"post={post['hl_row_count']} equal={diff['hl_row_count_equal']}")
    print(f"       dashboard SHA equal: {diff['dashboard_equal']}")
    print(f"       landing   SHA equal: {diff['landing_equal']}")
    print(f"       strict_ok: {diff['strict_ok']}")

    # Final summary JSON consumed by Phase 2 script (only if sanity passed).
    summary = {
        "phase": "1_winner_sl_rederivation",
        "universe_snapshot_path": universe_path,
        "universe": snapshot,
        "winners_by_variant": winners_by_variant,
        "r_standard_baseline": R_STANDARD,
        "r_standard_winners": r_std_winners,
        "directional_sanity_passed": sanity_passed,
        "sanity_error": sanity_error,
        "integrity": diff,
    }
    with open(os.path.join(args.out_dir, "phase1_summary.json"), "w") as fh:
        json.dump(summary, fh, indent=2, default=str)
    print(f"       summary → {args.out_dir}/phase1_summary.json")

    if not sanity_passed:
        print("\n🛑 Phase 1 sanity assert FAILED — Phase 2 MUST NOT run.")
        print("   See phase1_summary.json for the raw winner-MAE percentile output.")
        return 3  # distinct exit code: 3 = sanity fail; 2 = integrity fail

    return 0 if diff["strict_ok"] else 2


def main():
    ap = argparse.ArgumentParser(description="Phase 1: winner-only MAE SL re-derivation")
    ap.add_argument("--out-dir", default="/tmp/mode_a_v4")
    ap.add_argument("--ssh-host", default=None)
    ap.add_argument("--ssh-key", default=None)
    ap.add_argument("--top-n", type=int, default=20)
    args = ap.parse_args()
    sys.exit(run(args))


if __name__ == "__main__":
    main()

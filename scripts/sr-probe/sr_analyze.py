#!/usr/bin/env python3
"""sr_analyze.py — EDGE-SR-LEVEL-PROBE-W1: the probe's statistics, and nothing the registration does not name.

    python3 -I scripts/sr-probe/sr_analyze.py --self-test
    python3 -I scripts/sr-probe/sr_analyze.py --cardinalities --features <csv> [<csv>] --out <json> [--sims N]
    python3 -I scripts/sr-probe/sr_analyze.py --analyze --features <csv> <csv> --labels <csv> --coverage <csv>
            --meta-labelfree <json> --meta-labels <json> --out-json <json> --out-md <md>

Internal META research. `--cardinalities` reads the LABEL-FREE feature files only (counts, side shares, the
cell-day skeleton, a simulation of the design). `--analyze` is the one mode that reads a label, and
scripts/sr-probe/sr-pull.sh refuses to produce its input before the registration is on origin/main.

ONE DERIVATION. The excess over the mix-matched null is `population_comparison.Arm.excess_pp`, from counts; the
interval is `cluster_bootstrap_ols`; the FDR step is `bh`; the identifiability bound is
`declaration_identifiability`. All four are IMPORTED from the files that own them — this file holds no second
formula, and the self-test pins `Arm.excess_pp / 100` to `verdict-rule-gate.per_day` on a fixture.

The statistic, as registered: per UTC day and cell (timeframe), each arm's excess from its own counts; a cell-day
is ABSENT (never zero) when either arm has fewer than 30 scored rows; the day's value is the scored-weighted mean
over the cells present; the estimate is the intercept of `cluster_bootstrap_ols` on UTC-day clusters, B = 2000,
seed = arm_seed(wave, hypothesis).

Figures go to the PRIVATE vault paths given on the command line. Stdout carries the verdict token only.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.util
import json
import math
import os
import random
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def _load(name: str, rel: str):
    spec = importlib.util.spec_from_file_location(name, REPO / rel)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


cps = _load("cluster_perm_stats", "src/scripts/cluster-perm-stats.py")
pc = _load("population_comparison", "ops/monitoring/population_comparison.py")

WAVE = "EDGE-SR-LEVEL-PROBE-W1"
T_FLIP = 1788169595      # 2026-08-31T09:46:35Z
T_DIAG_END = 1790402400  # 2026-09-26T06:00:00Z
PRIMARY = ("1h", "2h", "4h", "8h", "12h")
DESCRIPTIVE = ("3m", "5m", "15m", "30m", "1d")
ALL_TF = ("3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d")
FLOOR = {"H1": 3.0, "H2": 1.0, "H3": 1.0, "H4": 3.0}
# What the point must reach to be read `attributable`. H2 is registered as "slope > 0": its +1.0pp per step
# (H1's +3.0pp over the three steps F1 -> CLEAR) is only the floor a null must exclude.
PASS_FLOOR = {"H2": 0.0, "H3": 1.0, "H4": 3.0}
MIN_ARM = 30
MIN_CLUSTERS = 20
BOOT_B = 2000
BH_Q = 0.10
HOLDOUT_DAYS = 13
NULL_WORDING = "no >= 3.0pp excess lever in the 1h-12h cells at this side mix"
FEATURES_HEADER = ["id", "exchange", "coin", "timeframe", "day", "side", "low_vol", "status", "l1_bars", "l2_bars",
                   "l3_bars", "l1_holes", "opposing", "f", "f_bin", "behind", "naive", "opposing_strong",
                   "n_opposing", "n_qualifying", "xv_checked", "xv_matched"]
LABELS_HEADER = ["signal_id", "label", "ambiguous_candle", "barrier_spec"]
BINS = (("F1", 1.0), ("F2", 2.0), ("F3", 3.0), ("CLEAR", 4.0))

# Self-test mutations: each breaks ONE piece of logic so the self-test can be shown to fail.
MUTATE = os.environ.get("SR_ANALYZE_MUTATE", "")


# ─────────────────────────────── inputs ───────────────────────────────

def sha256_file(path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read_features(paths) -> list[dict]:
    rows = []
    for p in paths:
        with open(p, newline="") as fh:
            rd = csv.reader(fh)
            header = next(rd)
            if header != FEATURES_HEADER:
                raise SystemExit(f"sr_analyze: {p} does not carry the features header")
            for c in rd:
                r = dict(zip(FEATURES_HEADER, c))
                rows.append({
                    "id": int(r["id"]), "exchange": r["exchange"], "coin": r["coin"], "tf": r["timeframe"],
                    "day": r["day"], "side": r["side"], "low_vol": r["low_vol"] == "1", "status": r["status"],
                    "l1_bars": int(r["l1_bars"]) if r["l1_bars"] else None,
                    "l1_holes": int(r["l1_holes"]) if r["l1_holes"] else None,
                    "opposing": r["opposing"] == "1", "f_bin": r["f_bin"], "behind": r["behind"] == "1",
                    "naive": r["naive"] == "1", "strong": r["opposing_strong"] == "1",
                    "xv_checked": int(r["xv_checked"] or 0), "xv_matched": int(r["xv_matched"] or 0),
                    "y": None,
                })
    ids = [r["id"] for r in rows]
    if len(ids) != len(set(ids)):
        raise SystemExit("sr_analyze: a call id appears twice across the feature files")
    return rows


def read_labels(path) -> dict[int, tuple[int, bool]]:
    out = {}
    with open(path, newline="") as fh:
        rd = csv.reader(fh)
        if next(rd) != LABELS_HEADER:
            raise SystemExit(f"sr_analyze: {path} does not carry the labels header")
        for sid, label, amb, _spec in rd:
            y = int(label)
            if y not in (1, -1, 0) or amb not in ("t", "f"):
                raise SystemExit(f"sr_analyze: unreadable label row for signal {sid}")
            out[int(sid)] = (y, amb == "t")
    return out


# ─────────────────────────────── the statistic ───────────────────────────────

def make_arm(label: str, rows: list[dict]):
    """Counts in -> population_comparison.Arm. engine win = label +1; long win = up-first; short win = down-first."""
    eng = sum(1 for r in rows if r["y"] == 1)
    long_w = sum(1 for r in rows if (r["side"] == "BUY" and r["y"] == 1) or (r["side"] == "SELL" and r["y"] == -1))
    short_w = sum(1 for r in rows if (r["side"] == "BUY" and r["y"] == -1) or (r["side"] == "SELL" and r["y"] == 1))
    buy = sum(1 for r in rows if r["side"] == "BUY")
    if MUTATE == "swap_wins":
        long_w, short_w = short_w, long_w
    return pc.Arm(label, len(rows), eng, long_w, short_w, buy)


def contrast(pred_a, pred_b):
    """A cell-day statistic: excess(arm a) - excess(arm b), weight = the two arms' scored rows. None when absent."""
    def stat(rows):
        a = make_arm("a", [r for r in rows if pred_a(r)])
        b = make_arm("b", [r for r in rows if pred_b(r)])
        floor = 0 if MUTATE == "no_min_arm" else MIN_ARM
        if a.scored < max(floor, 1) or b.scored < max(floor, 1):
            return None
        return a.excess_pp - b.excess_pp, a.scored + b.scored
    return stat


def is_clear(r): return not r["opposing"]
def is_opposing(r): return r["opposing"]
def is_naive(r): return r["naive"]
def not_naive(r): return not r["naive"]
def is_behind(r): return r["behind"]
def not_behind(r): return not r["behind"]


stat_h1 = contrast(is_clear, is_opposing)
stat_naive = contrast(not_naive, is_naive)
stat_h4 = contrast(is_behind, not_behind)
stat_strength = contrast(lambda r: r["opposing"] and not r["strong"], lambda r: r["opposing"] and r["strong"])


def stat_h3(rows):
    """H1's delta minus the naive comparator's, on cell-days where both are present."""
    a, b = stat_h1(rows), stat_naive(rows)
    if a is None or b is None:
        return None
    return a[0] - b[0], a[1]


def stat_h2(rows):
    """Slope of bin excess on the bin index (F1=1, F2=2, F3=3, CLEAR=4), over the bins with >= 30 scored rows;
    at least two bins. Fitted by the imported `ols`."""
    xs, ys, w = [], [], 0
    for name, idx in BINS:
        arm = make_arm(name, [r for r in rows if r["f_bin"] == name])
        if arm.scored >= MIN_ARM:
            xs.append([1.0, idx])
            ys.append(arm.excess_pp)
            w += arm.scored
    if len(xs) < 2:
        return None
    beta, _ = cps.ols(xs, ys)
    return beta[1], w


def daily(rows: list[dict], cells, stat) -> tuple[dict[str, float], dict]:
    """{UTC day: scored-weighted mean of the cell-day statistic over the cells present}."""
    by = defaultdict(list)
    for r in rows:
        if r["tf"] in cells:
            by[(r["day"], r["tf"])].append(r)
    per_day = defaultdict(list)
    absent = 0
    for (day, _tf), rs in by.items():
        s = stat(rs)
        if s is None:
            absent += 1
        else:
            per_day[day].append(s)
    out = {}
    for day, ss in per_day.items():
        wsum = sum(w for _, w in ss)
        out[day] = sum(v * w for v, w in ss) / wsum
    return out, {"cell_days_present": sum(len(v) for v in per_day.values()), "cell_days_absent": absent}


def boot(vals: dict[str, float], name: str, b_draws: int = BOOT_B):
    """Intercept of cluster_bootstrap_ols on UTC-day clusters. None when there is no day at all."""
    days = sorted(vals)
    if not days:
        return None
    y = [vals[d] for d in days]
    x = [[1.0] for _ in days]
    b = cps.cluster_bootstrap_ols(x, y, days, b_draws, random.Random(cps.arm_seed(WAVE, name)))
    lo, hi = b["coef"][0]["ci95"]
    same = b["coef"][0]["same_sign_frac"]
    p = float("nan")
    if not (isinstance(same, float) and math.isnan(same)):
        p = (1.0 - same) if b["beta"][0] > 0 else same  # share of draws <= 0
        p = max(p, 1.0 / (b["draws_used"] + 1))
    return {"point": b["beta"][0], "lo": lo, "hi": hi, "clusters": b["clusters"], "p_one_sided": p,
            "draws_used": b["draws_used"], "singular_draws": b["singular_draws"]}


def holdout_point(vals: dict[str, float], holdout_days) -> float | None:
    ys = [vals[d] for d in holdout_days if d in vals]
    return sum(ys) / len(ys) if ys else None


def primary_verdict(b, hold, ident_ok: bool, floor: float = FLOOR["H1"]) -> tuple[str, str]:
    if b is None:
        return "INDETERMINATE", "no cell-day carries both arms at >= 30 scored rows"
    if b["clusters"] < MIN_CLUSTERS:
        return "INDETERMINATE", f"{b['clusters']} day clusters, under the floor of {MIN_CLUSTERS}"
    if not ident_ok:
        return "INDETERMINATE", "NOT_IDENTIFIABLE arm"
    if any(math.isnan(v) for v in (b["point"], b["lo"], b["hi"])):
        return "INDETERMINATE", "the bootstrap produced no usable draw"
    if b["lo"] > 0 and b["point"] >= floor:
        if hold is not None and hold > 0:
            return "PASS", "95% lower bound > 0, point >= +3.0pp, same sign on the hold-out days"
        return "INDETERMINATE", "hold-out sign flip"
    if b["hi"] < 0:
        return "NULL", NULL_WORDING + "; a reversal: the upper bound is under 0"
    if b["hi"] < floor:
        return "NULL", NULL_WORDING
    if b["lo"] <= 0:
        return "INDETERMINATE", "the interval holds +3.0pp with its lower bound <= 0"
    return "INDETERMINATE", "lower bound > 0 but the point is under +3.0pp and the interval holds +3.0pp"


def hyp_state(b, floor: float, rejected: bool, pass_floor=None) -> str:
    if b is None or b["clusters"] < MIN_CLUSTERS or any(math.isnan(v) for v in (b["point"], b["lo"], b["hi"])):
        return "indeterminate"
    if rejected and b["lo"] > 0 and b["point"] >= (floor if pass_floor is None else pass_floor):
        return "attributable"
    if b["hi"] < floor:
        return "not-attributable"
    return "indeterminate"


# ─────────────────────────────── label-free structure ───────────────────────────────

def eligible_labelfree(rows):
    return [r for r in rows if r["status"] == "ok" and not r["low_vol"]]


def minority(rows) -> float | None:
    if not rows:
        return None
    q = sum(1 for r in rows if r["side"] == "BUY") / len(rows)
    return min(q, 1.0 - q)


def primary_cells(rows_labelfree) -> tuple[list[str], list[dict]]:
    """The primary cells that stay: a cell where an H1 arm's 2m is under the floor is dropped, by name."""
    kept, dropped = [], []
    for tf in PRIMARY:
        rs = [r for r in rows_labelfree if r["tf"] == tf]
        bad = None
        for name, pred in (("CLEAR", is_clear), ("OPPOSING", is_opposing)):
            m = minority([r for r in rs if pred(r)])
            if m is None or 200.0 * m < FLOOR["H1"]:
                bad = {"cell": tf, "arm": name, "m": m}
                break
        if bad:
            dropped.append(bad)
        else:
            kept.append(tf)
    return kept, dropped


def corpus_days(rows) -> list[str]:
    """The UTC days of [T_FLIP, T_DIAG_END] — fixed by the registered clocks, never by which rows a file holds.
    A row outside them is not this corpus: refuse rather than widen."""
    d0 = datetime.fromtimestamp(T_FLIP, timezone.utc).date()
    d1 = datetime.fromtimestamp(T_DIAG_END, timezone.utc).date()
    days = [(d0 + timedelta(days=i)).isoformat() for i in range((d1 - d0).days + 1)]
    known = set(days)
    stray = sorted({r["day"] for r in rows} - known)
    if stray:
        raise SystemExit(f"sr_analyze: rows on UTC days outside the registered corpus: {stray[:5]}")
    return days


def holdout_days(days: list[str]) -> list[str]:
    """The UTC days after the median day (the 27 corpus days -> the last 13)."""
    return days[len(days) // 2 + 1:]


ARMS = {
    "H1": (("CLEAR", is_clear), ("OPPOSING", is_opposing)),
    "H2": (("F1", lambda r: r["f_bin"] == "F1"), ("F2", lambda r: r["f_bin"] == "F2"),
           ("F3", lambda r: r["f_bin"] == "F3"), ("CLEAR", is_clear)),
    "H3": (("NAIVE-CLEAR", not_naive), ("NAIVE-OPPOSING", is_naive)),
    "H4": (("BEHIND", is_behind), ("not-BEHIND", not_behind)),
}
# The floor each arm's side mix must be able to carry: H2's +1.0pp per step is +3.0pp over F1 -> CLEAR.
DECL_FLOOR = {"H1": 3.0, "H2": 3.0, "H3": 1.0, "H4": 3.0}


def identifiability(rows_labelfree, cells) -> list[dict]:
    rs = [r for r in rows_labelfree if r["tf"] in cells]
    out = []
    for h, arms in ARMS.items():
        for name, pred in arms:
            sub = [r for r in rs if pred(r)]
            m = minority(sub)
            res = pc.declaration_identifiability(DECL_FLOOR[h], [m]) if m is not None else {"verdict": "INDETERMINATE", "bound_pp": None}
            out.append({"hypothesis": h, "arm": name, "n": len(sub), "m": m, "floor_pp": DECL_FLOOR[h],
                        "bound_pp": res["bound_pp"], "verdict": res["verdict"]})
    return out


def se_instrument(rows_labelfree, cells, days) -> dict:
    """Worst-case binomial standard error of the H1 estimate from the label-free skeleton: per arm
    Var(excess) <= q(1-q)/n (excess = 2q(1-q)(a-b), a and b at 0.5), combined exactly as the statistic combines
    them. A FLOOR on the standard error: it holds no between-day variance of the true delta."""
    by = defaultdict(list)
    for r in rows_labelfree:
        if r["tf"] in cells:
            by[(r["day"], r["tf"])].append(r)
    per_day = defaultdict(list)
    for (day, _tf), rs in by.items():
        a = [r for r in rs if is_clear(r)]
        b = [r for r in rs if is_opposing(r)]
        if len(a) < MIN_ARM or len(b) < MIN_ARM:
            continue
        def v(arm):
            q = sum(1 for r in arm if r["side"] == "BUY") / len(arm)
            return q * (1 - q) / len(arm)
        per_day[day].append((v(a) + v(b), len(a) + len(b)))
    d = len(per_day)
    if d == 0:
        return {"days": 0, "se_pp": None}
    tot = 0.0
    for ss in per_day.values():
        wsum = sum(w for _, w in ss)
        tot += sum(var * w * w for var, w in ss) / (wsum * wsum)
    se = 100.0 * math.sqrt(tot) / d
    return {"days": d, "se_pp": se, "ci_halfwidth_pp": 1.96 * se,
            "true_delta_for_80pct_pass_pp": max(2.8 * se, FLOOR["H1"] + 0.84 * se)}


def simulate(rows_labelfree, cells, days, sims: int, true_delta_pp: float, seed: int, b_draws: int = 400) -> dict:
    """The H1 pipeline on the REAL label-free skeleton with simulated outcomes. No skill outside the injected
    effect: the tape's up-share is drawn per day in [0.30, 0.60], 10% of rows time out, and a CLEAR row is forced
    to an engine win with the probability that makes excess(CLEAR) = true_delta_pp at the cell's POOLED CLEAR
    side mix. A day's own mix differs from the pooled one and 2q(1-q) is concave, so the day-level estimand sits
    under the injected figure; `mean_estimate_pp` is what the design returns for it."""
    rng = random.Random(seed)
    rs = [dict(r) for r in rows_labelfree if r["tf"] in cells]
    inject = {}
    for tf in cells:
        clear = [r for r in rs if r["tf"] == tf and is_clear(r)]
        q = sum(1 for r in clear if r["side"] == "BUY") / len(clear) if clear else 0.5
        inject[tf] = min(1.0, (true_delta_pp / 100.0) / (2 * q * (1 - q))) if 0 < q < 1 else 0.0
    hold = holdout_days(days)
    points, verdicts = [], defaultdict(int)
    for _ in range(sims):
        up = {d: rng.uniform(0.30, 0.60) for d in days}
        for r in rs:
            if not r["opposing"] and rng.random() < inject[r["tf"]]:
                r["y"] = 1
                continue
            x = rng.random()
            if x < 0.10:
                r["y"] = 0
                continue
            went_up = rng.random() < up[r["day"]]
            r["y"] = 1 if went_up == (r["side"] == "BUY") else -1
        vals, _ = daily(rs, cells, stat_h1)
        b = boot(vals, "H1-sim", b_draws)
        v, _cause = primary_verdict(b, holdout_point(vals, hold), True)
        verdicts[v] += 1
        if b is not None:
            points.append(b["point"])
    n = len(points)
    mean = sum(points) / n if n else float("nan")
    sd = math.sqrt(sum((p - mean) ** 2 for p in points) / (n - 1)) if n > 1 else float("nan")
    return {"injected_delta_pp_at_pooled_mix": true_delta_pp, "sims": sims, "bootstrap_draws": b_draws, "mean_estimate_pp": mean,
            "mean_minus_injected_pp": mean - true_delta_pp, "sd_pp": sd,
            "share": {k: verdicts.get(k, 0) / sims for k in ("PASS", "NULL", "INDETERMINATE")}}


def cell_table(rows_labelfree) -> list[dict]:
    out = []
    for tf in ALL_TF:
        rs = [r for r in rows_labelfree if r["tf"] == tf]
        if not rs:
            continue
        q = sum(1 for r in rs if r["side"] == "BUY") / len(rs)
        row = {"cell": tf, "eligible": len(rs), "buy_share": q, "two_q_one_minus_q": 2 * q * (1 - q),
               "raw_side_conditional_equivalent_pp": FLOOR["H1"] / (2 * q * (1 - q)) if 0 < q < 1 else None, "arms": {}}
        for name, pred in (("CLEAR", is_clear), ("OPPOSING", is_opposing), ("F1", lambda r: r["f_bin"] == "F1"),
                           ("F2", lambda r: r["f_bin"] == "F2"), ("F3", lambda r: r["f_bin"] == "F3"),
                           ("BEHIND", is_behind), ("NAIVE-OPPOSING", is_naive),
                           ("OPPOSING-STRONG", lambda r: r["opposing"] and r["strong"])):
            sub = [r for r in rs if pred(r)]
            row["arms"][name] = {"n": len(sub), "buy_share": (sum(1 for r in sub if r["side"] == "BUY") / len(sub)) if sub else None}
        out.append(row)
    return out


def skeleton(rows_labelfree, cells) -> dict:
    """How many cell-days and UTC days each hypothesis can use, by CALL count (an upper bound on scored rows)."""
    out = {}
    fake = [dict(r, y=0) for r in rows_labelfree]
    for h, stat in (("H1", stat_h1), ("H2", stat_h2), ("H3", stat_h3), ("H4", stat_h4)):
        vals, info = daily(fake, cells, stat)
        per_cell = {}
        for tf in cells:
            _v, i = daily(fake, [tf], stat)
            per_cell[tf] = i
        out[h] = {"days": len(vals), **info, "per_cell": per_cell}
    return out


def status_tally(rows) -> dict:
    t = defaultdict(lambda: defaultdict(int))
    for r in rows:
        t[r["tf"]][r["status"]] += 1
        if r["status"] == "ok" and r["low_vol"]:
            t[r["tf"]]["ok_low_vol"] += 1
    return {tf: dict(v) for tf, v in t.items()}


def cardinalities(args) -> int:
    rows = read_features(args.features)
    lf = eligible_labelfree(rows)
    days = corpus_days(rows)
    cells, dropped = primary_cells(lf)
    out = {
        "wave": WAVE, "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "features_sha256": {os.path.basename(p): sha256_file(p) for p in args.features},
        "rows": len(rows), "eligible_labelfree": len(lf), "status": status_tally(rows),
        "corpus_days": days, "holdout_days": holdout_days(days),
        "primary_cells": cells, "primary_cells_dropped": dropped,
        "cells": cell_table(lf),
        "identifiability": identifiability(lf, cells),
        "skeleton": skeleton(lf, cells),
        "l1_under_300_bars": sum(1 for r in lf if r["l1_bars"] is not None and r["l1_bars"] < 300),
        "l1_with_holes": sum(1 for r in lf if r["l1_holes"]),
        "xv": {"checked": sum(r["xv_checked"] for r in lf if r["tf"] in cells),
               "calls_with_check": sum(1 for r in lf if r["tf"] in cells and r["xv_checked"] > 0)},
        "se_instrument_h1": se_instrument(lf, cells, days),
        "seeds": {h: cps.arm_seed(WAVE, h) for h in ("H1", "H2", "H3", "H4")},
    }
    if args.sims:
        out["simulation_h1"] = [simulate(lf, cells, days, args.sims, d, cps.arm_seed(WAVE, f"sim{d}")) for d in (0.0, 3.0, 6.0)]
    Path(args.out).write_text(json.dumps(out, indent=2) + "\n")
    ok = len(lf) > 0 and len(cells) > 0
    print(f"SR_CARDINALITIES_VERDICT={'PASS' if ok else 'INDETERMINATE'}")
    return 0 if ok else 3


# ─────────────────────────────── CH2: the analysis ───────────────────────────────

def fmt(x, nd=2) -> str:
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return "n/a"
    return f"{x:+.{nd}f}" if isinstance(x, float) else str(x)


def arm_summary(rows) -> dict:
    a = make_arm("x", rows)
    buys = [r for r in rows if r["side"] == "BUY"]
    sells = [r for r in rows if r["side"] == "SELL"]
    up = lambda rs: (sum(1 for r in rs if (r["side"] == "BUY") == (r["y"] == 1) and r["y"] != 0) / len(rs)) if rs else None
    return {"scored": a.scored, "buy_share": a.q, "excess_pp": a.excess_pp, "engine_win_rate": a.p_hat,
            "p_decided": (sum(1 for r in rows if r["y"] != 0) / len(rows)) if rows else None,
            "up_rate_buy": up(buys), "up_rate_sell": up(sells)}


def run_hypothesis(rows, cells, stat, name, hold_days) -> dict:
    vals, info = daily(rows, cells, stat)
    b = boot(vals, name)
    return {"boot": b, "holdout_point": holdout_point(vals, hold_days),
            "holdout_days_present": sum(1 for d in hold_days if d in vals), **info}


def analyze(args) -> int:
    rows = read_features(args.features)
    labels = read_labels(args.labels)
    meta_lf = json.loads(Path(args.meta_labelfree).read_text())
    meta_lb = json.loads(Path(args.meta_labels).read_text())
    days = corpus_days(rows)
    hold = holdout_days(days)
    lf = eligible_labelfree(rows)
    cells, dropped_cells = primary_cells(lf)

    chain = {"feature_rows": len(rows), "resolved": sum(1 for r in rows if r["status"] == "ok"),
             "eligible_labelfree": len(lf), "labels_rows": len(labels)}
    ids = {r["id"] for r in rows}
    chain["labels_not_in_extract"] = sum(1 for i in labels if i not in ids)
    scored = []
    no_label = ambiguous = 0
    for r in lf:
        hit = labels.get(r["id"])
        if hit is None:
            no_label += 1
            continue
        if hit[1]:
            ambiguous += 1
            continue
        r["y"] = hit[0]
        scored.append(r)
    chain.update(extract_without_label=no_label, ambiguous_dropped=ambiguous, scored=len(scored),
                 scored_primary=sum(1 for r in scored if r["tf"] in cells))

    # Realized identifiability on the scored rows (the registered table was computed before the ambiguous drop).
    ident = identifiability(scored, cells)
    ident_ok = all(i["verdict"] == "IDENTIFIABLE" for i in ident if i["hypothesis"] == "H1")

    h1 = run_hypothesis(scored, cells, stat_h1, "H1", hold)
    verdict, cause = primary_verdict(h1["boot"], h1["holdout_point"], ident_ok)
    h1.update(state=verdict, cause=cause, floor_pp=FLOOR["H1"])
    decided = [r for r in scored if r["y"] != 0]
    h1["decided_only"] = run_hypothesis(decided, cells, stat_h1, "H1-decided", hold)

    secondary = {"H2": run_hypothesis(scored, cells, stat_h2, "H2", hold),
                 "H3": run_hypothesis(scored, cells, stat_h3, "H3", hold),
                 "H4": run_hypothesis(scored, cells, stat_h4, "H4", hold)}
    names = ["H2", "H3", "H4"]
    pvals = []
    for n in names:
        b = secondary[n]["boot"]
        p = 1.0 if b is None or math.isnan(b["p_one_sided"]) else b["p_one_sided"]
        pvals.append(p)
    rej = cps.bh(pvals, BH_Q)
    for n, p, rj in zip(names, pvals, rej):
        secondary[n].update(p_one_sided=p, bh_rejected=rj, floor_pp=FLOOR[n],
                            state=hyp_state(secondary[n]["boot"], FLOOR[n], rj, PASS_FLOOR[n]))

    per_cell = []
    for tf in ALL_TF:
        rs = [r for r in scored if r["tf"] == tf]
        if not rs:
            continue
        res = run_hypothesis(rs, [tf], stat_h1, f"cell-{tf}", hold)
        per_cell.append({"cell": tf, "role": "primary" if tf in cells else "descriptive", "scored": len(rs),
                         "clear": arm_summary([r for r in rs if is_clear(r)]),
                         "opposing": arm_summary([r for r in rs if is_opposing(r)]), "h1": res})
    prim = [r for r in scored if r["tf"] in cells]
    descriptive = {
        "arms_primary": {name: arm_summary([r for r in prim if pred(r)]) for name, pred in (
            ("CLEAR", is_clear), ("OPPOSING", is_opposing), ("F1", lambda r: r["f_bin"] == "F1"),
            ("F2", lambda r: r["f_bin"] == "F2"), ("F3", lambda r: r["f_bin"] == "F3"), ("BEHIND", is_behind),
            ("not-BEHIND", not_behind), ("NAIVE-OPPOSING", is_naive), ("NAIVE-CLEAR", not_naive),
            ("OPPOSING-STRONG", lambda r: r["opposing"] and r["strong"]),
            ("OPPOSING-WEAK", lambda r: r["opposing"] and not r["strong"]))},
        "weak_minus_strong_opposing": run_hypothesis(scored, cells, stat_strength, "strength", hold),
        "naive_delta": run_hypothesis(scored, cells, stat_naive, "naive", hold),
        "cross_venue": {"levels_checked": sum(r["xv_checked"] for r in prim),
                        "levels_matched": sum(r["xv_matched"] for r in prim)},
    }
    cv = descriptive["cross_venue"]
    cv["share"] = cv["levels_matched"] / cv["levels_checked"] if cv["levels_checked"] else None

    coverage = []
    with open(args.coverage, newline="") as fh:
        for r in csv.DictReader(fh):
            coverage.append({k: (int(v) if v.isdigit() else v) for k, v in r.items()})

    iso = lambda epoch: datetime.fromtimestamp(int(epoch), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out = {
        "wave": WAVE, "verdict": verdict, "cause": cause,
        "registration_commit": meta_lb["registration_commit"],
        "registration_landed_at": iso(meta_lb["registration_commit_epoch"]),
        "labelfree_pull_at": meta_lf["pull_at"], "label_pull_at": meta_lb["pull_at"],
        "sha256": {"extract": meta_lf["files"]["extract.csv"]["sha256"], "coverage": meta_lf["files"]["coverage.csv"]["sha256"],
                   "labels": meta_lb["files"]["labels.csv"]["sha256"],
                   "session_labelfree": meta_lf["session_sql_sha256"], "session_labels": meta_lb["session_sql_sha256"],
                   **{f"features:{os.path.basename(p)}": sha256_file(p) for p in args.features}},
        "corpus_days": len(days), "holdout_days": hold, "primary_cells": cells, "primary_cells_dropped": dropped_cells,
        "chain": chain, "status": status_tally(rows), "identifiability_realized": ident,
        "hypotheses": {"H1": h1, **secondary}, "per_cell": per_cell, "descriptive": descriptive,
        "coverage_chain": coverage, "bootstrap": {"draws": BOOT_B, "seeds": {h: cps.arm_seed(WAVE, h) for h in ("H1", "H2", "H3", "H4")}},
    }
    Path(args.out_json).write_text(json.dumps(out, indent=2) + "\n")
    Path(args.out_md).write_text(render_md(out))
    print(f"SR_PROBE_VERDICT={verdict} — {cause}")
    return 3 if verdict == "INDETERMINATE" else 0


def _boot_cells(res) -> str:
    b = res["boot"]
    if b is None:
        return "n/a | n/a | 0"
    return f"{fmt(b['point'])} | [{fmt(b['lo'])}, {fmt(b['hi'])}] | {b['clusters']}"


def render_md(o: dict) -> str:
    L = []
    h = o["hypotheses"]
    L += [f"# {o['wave']} — findings (PRIVATE vault; internal META research, no edge claim)", "",
          f"`SR_PROBE_VERDICT={o['verdict']} — {o['cause']}`", "",
          f"- registration commit `{o['registration_commit']}` landed {o['registration_landed_at']}",
          f"- label-free pull {o['labelfree_pull_at']} · label pull {o['label_pull_at']}",
          f"- corpus days {o['corpus_days']} · hold-out {o['holdout_days'][0]} … {o['holdout_days'][-1]} ({len(o['holdout_days'])} days)",
          f"- primary cells: {', '.join(o['primary_cells'])} · dropped before registering: {o['primary_cells_dropped'] or 'none'}",
          "", "## Hypotheses (excess over the mix-matched null, pp; ALL_SCORED; UTC-day clusters beside every interval)", "",
          "| hypothesis | floor | point | 95% interval | day clusters | hold-out point | cell-days present / absent | one-sided p | BH q=0.10 | state |",
          "|---|---|---|---|---|---|---|---|---|---|"]
    r = h["H1"]
    L.append(f"| H1 excess(CLEAR) − excess(OPPOSING) | +3.0 | {_boot_cells(r)} | {fmt(r['holdout_point'])} ({r['holdout_days_present']} d) | {r['cell_days_present']} / {r['cell_days_absent']} | — | primary | **{r['state']}** |")
    d = r["decided_only"]
    L.append(f"| H1, decided rows only (beside it) | +3.0 | {_boot_cells(d)} | {fmt(d['holdout_point'])} ({d['holdout_days_present']} d) | {d['cell_days_present']} / {d['cell_days_absent']} | — | — | descriptive |")
    for n, label in (("H2", "H2 slope over F1, F2, F3, CLEAR (per step)"), ("H3", "H3 H1 Δ − NAIVE Δ"), ("H4", "H4 excess(BEHIND) − excess(not BEHIND)")):
        r = h[n]
        L.append(f"| {label} | +{r['floor_pp']:.1f} | {_boot_cells(r)} | {fmt(r['holdout_point'])} ({r['holdout_days_present']} d) | {r['cell_days_present']} / {r['cell_days_absent']} | {r['p_one_sided']:.4f} | {'reject' if r['bh_rejected'] else 'keep'} | **{r['state']}** |")
    c = o["chain"]
    L += ["", "## Rows", "",
          "| step | rows |", "|---|---|",
          f"| feature rows (corpus calls) | {c['feature_rows']} |", f"| resolved (every layer fetched and current) | {c['resolved']} |",
          f"| after low_vol_history drop | {c['eligible_labelfree']} |", f"| without a label row at the label pull | {c['extract_without_label']} |",
          f"| ambiguous_candle dropped | {c['ambiguous_dropped']} |", f"| scored (ALL_SCORED) | {c['scored']} |",
          f"| scored, primary cells | {c['scored_primary']} |", f"| label rows not in the extract (ignored) | {c['labels_not_in_extract']} |",
          "", "## Per cell (H1 pipeline on the cell alone; descriptive cells never enter the verdict)", "",
          "| cell | role | scored | CLEAR n | OPPOSING n | CLEAR excess | OPPOSING excess | Δ point | 95% interval | day clusters | P(decided) CLEAR / OPP | up-rate BUY CLEAR / OPP | up-rate SELL CLEAR / OPP |",
          "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    pct = lambda x: "n/a" if x is None else f"{100 * x:.1f}%"
    for pcell in o["per_cell"]:
        a, b = pcell["clear"], pcell["opposing"]
        L.append(f"| {pcell['cell']} | {pcell['role']} | {pcell['scored']} | {a['scored']} | {b['scored']} | {fmt(a['excess_pp'])} | {fmt(b['excess_pp'])} | {_boot_cells(pcell['h1'])} | {pct(a['p_decided'])} / {pct(b['p_decided'])} | {pct(a['up_rate_buy'])} / {pct(b['up_rate_buy'])} | {pct(a['up_rate_sell'])} / {pct(b['up_rate_sell'])} |")
    L += ["", "## Arms, primary cells pooled (descriptive)", "",
          "| arm | scored | BUY share | excess (pp) | engine win rate | P(decided) | up-rate BUY | up-rate SELL |", "|---|---|---|---|---|---|---|---|"]
    for name, a in o["descriptive"]["arms_primary"].items():
        L.append(f"| {name} | {a['scored']} | {pct(a['buy_share'])} | {fmt(a['excess_pp'])} | {pct(a['engine_win_rate'])} | {pct(a['p_decided'])} | {pct(a['up_rate_buy'])} | {pct(a['up_rate_sell'])} |")
    ws, nv, cv = o["descriptive"]["weak_minus_strong_opposing"], o["descriptive"]["naive_delta"], o["descriptive"]["cross_venue"]
    L += ["", "## Other descriptive reads", "",
          "| read | point | 95% interval | day clusters |", "|---|---|---|---|",
          f"| excess(weak opposing) − excess(strong opposing) | {_boot_cells(ws)} |",
          f"| NAIVE: excess(NAIVE-CLEAR) − excess(NAIVE-OPPOSING) | {_boot_cells(nv)} |", "",
          f"- cross-venue: {cv['levels_matched']} of {cv['levels_checked']} opposing levels have a qualifying level within 0.25·ATR on another venue's candles ({pct(cv['share'])})",
          "", "## Identifiability, realized on the scored rows", "",
          "| hypothesis | arm | n | m | floor (pp) | 2m (pp) | verdict |", "|---|---|---|---|---|---|---|"]
    for i in o["identifiability_realized"]:
        m_txt = "n/a" if i["m"] is None else "%.4f" % i["m"]
        bound_txt = "n/a" if i["bound_pp"] is None else "%.2f" % i["bound_pp"]
        L.append(f"| {i['hypothesis']} | {i['arm']} | {i['n']} | {m_txt} | {i['floor_pp']} | {bound_txt} | {i['verdict']} |")
    L += ["", "## Coverage chain (ADS-1's, on this corpus)", "",
          "| venue | timeframe | registered | v1 present | v2 present | v2 written at or after T_ADAPTER |", "|---|---|---|---|---|---|"]
    for r in o["coverage_chain"]:
        L.append(f"| {r['exchange']} | {r['timeframe']} | {r['registered']} | {r['v1_present']} | {r['v2_present']} | {r['v2_post_adapter']} |")
    L += ["", "## Provenance", ""]
    for k, v in o["sha256"].items():
        L.append(f"- sha256 {k}: `{v}`")
    L += [f"- bootstrap: B = {o['bootstrap']['draws']}, seeds {o['bootstrap']['seeds']}", ""]
    return "\n".join(L)


# ─────────────────────────────── self-test ───────────────────────────────

def self_test() -> int:
    fails = []
    n = [0]

    def check(label: str, cond: bool) -> None:
        n[0] += 1
        if not cond:
            fails.append(label)

    # 1. known answer: BUY+1, BUY-1, SELL+1, SELL+1 -> p_hat .75, null .5*.25 + .5*.75 = .5 -> +25pp
    rows = [{"side": "BUY", "y": 1}, {"side": "BUY", "y": -1}, {"side": "SELL", "y": 1}, {"side": "SELL", "y": 1}]
    check("known-answer excess is +25pp", abs(make_arm("k", rows).excess_pp - 25.0) < 1e-9)
    # a timeout is scored and in no win bucket
    arm = make_arm("t", rows + [{"side": "BUY", "y": 0}])
    check("a timeout is in the denominator and in no win bucket", arm.scored == 5 and arm.engine_wins == 3 and arm.long_wins + arm.short_wins == 4)

    # 2. parity with verdict-rule-gate.per_day on a fixture (the registered single derivation). The rows are built
    #    by the gate's own parser and read back through its own accessors, so its row shape is never restated here.
    vrg = _load("verdict_rule_gate", "ops/monitoring/verdict-rule-gate.py")
    rng = random.Random(7)
    raw = []
    for i in range(240):
        side = "BUY" if rng.random() < 0.7 else "SELL"
        ret = rng.choice([0.012, -0.009, 0.0, 0.004, -0.02])
        raw.append([str(i), "RANGING", "f", side, side, side, str((i % 3) * 86400 + 5), repr(ret)])
    fixture, mine = vrg.parse_rows(raw), defaultdict(list)
    for row in fixture:
        side, ret = vrg.side_under(row, "MM"), row["r"]
        y = 0 if ret == 0 else (1 if (ret > 0) == (side == "BUY") else -1)
        mine[vrg.day_index(row, 0)].append({"side": side, "y": y})
    theirs = vrg.per_day(fixture, 0, "MM")
    check("per_day parity covers three days", sorted(theirs) == [0, 1, 2])
    for d in (0, 1, 2):
        check(f"Arm.excess_pp / 100 equals per_day on day {d}", abs(make_arm("p", mine[d]).excess_pp / 100.0 - theirs[d][0]) < 1e-12)
    check("the parity fixture is not degenerate", any(abs(theirs[d][0]) > 1e-6 for d in theirs))

    # 3. a cell-day is absent under 30 scored rows in either arm, present at 30
    def cd(n_clear, n_opp, day="2026-09-01", tf="1h"):
        out = []
        for i in range(n_clear):
            out.append({"tf": tf, "day": day, "side": "BUY" if i % 2 else "SELL", "y": 1, "opposing": False, "naive": False, "behind": False, "strong": False, "f_bin": "CLEAR"})
        for i in range(n_opp):
            out.append({"tf": tf, "day": day, "side": "BUY" if i % 2 else "SELL", "y": 1 if i % 2 else -1, "opposing": True, "naive": True, "behind": True, "strong": False, "f_bin": "F1"})
        return out
    check("29 rows in an arm -> the cell-day is absent", stat_h1(cd(40, 29)) is None)
    s = stat_h1(cd(40, 30))
    # CLEAR: every row an engine win, q=.5, long=.5, short=.5 -> excess +50pp. OPPOSING: BUY all +1, SELL all -1 ->
    # p_hat .5, long 1.0, short 0 -> null .5 -> 0pp.
    check("30 rows in each arm -> present, +50pp, weight 70", s is not None and abs(s[0] - 50.0) < 1e-9 and s[1] == 70)
    vals, info = daily(cd(40, 29) + cd(40, 30, tf="2h") + cd(60, 60, day="2026-09-02"), ["1h", "2h"], stat_h1)
    check("absent cell-days are counted, never zero-filled", info == {"cell_days_present": 2, "cell_days_absent": 1} and sorted(vals) == ["2026-09-01", "2026-09-02"])

    # 4. the day's value is the scored-weighted mean over the cells present
    mixed = cd(40, 30, tf="1h") + [dict(r, y=(1 if r["opposing"] else (1 if i % 2 else -1))) for i, r in enumerate(cd(100, 100, tf="2h"))]
    a, b = stat_h1([r for r in mixed if r["tf"] == "1h"]), stat_h1([r for r in mixed if r["tf"] == "2h"])
    v, _ = daily(mixed, ["1h", "2h"], stat_h1)
    check("scored-weighted mean over cells", abs(v["2026-09-01"] - (a[0] * a[1] + b[0] * b[1]) / (a[1] + b[1])) < 1e-9 and a[1] != b[1])

    # 5. the registered three-state reading
    B = lambda point, lo, hi, cl=27: {"point": point, "lo": lo, "hi": hi, "clusters": cl, "p_one_sided": 0.01}
    check("PASS", primary_verdict(B(4.0, 1.0, 7.0), 2.0, True)[0] == "PASS")
    check("hold-out flip -> INDETERMINATE", primary_verdict(B(4.0, 1.0, 7.0), -0.5, True) == ("INDETERMINATE", "hold-out sign flip"))
    check("no hold-out day -> INDETERMINATE", primary_verdict(B(4.0, 1.0, 7.0), None, True)[0] == "INDETERMINATE")
    check("NULL carries the registered wording", primary_verdict(B(0.5, -1.0, 2.9), 0.1, True) == ("NULL", NULL_WORDING))
    check("significant but small is NULL", primary_verdict(B(1.5, 0.2, 2.8), 1.0, True)[0] == "NULL")
    check("interval holds the floor with lower <= 0", primary_verdict(B(2.0, -1.0, 5.0), 1.0, True)[0] == "INDETERMINATE")
    check("19 clusters -> INDETERMINATE", primary_verdict(B(4.0, 1.0, 7.0, 19), 2.0, True)[0] == "INDETERMINATE")
    check("NOT_IDENTIFIABLE -> INDETERMINATE", primary_verdict(B(4.0, 1.0, 7.0), 2.0, False) == ("INDETERMINATE", "NOT_IDENTIFIABLE arm"))
    check("no data -> INDETERMINATE", primary_verdict(None, None, True)[0] == "INDETERMINATE")
    check("attributable", hyp_state(B(2.0, 0.5, 4.0), 1.0, True) == "attributable")
    check("not rejected -> indeterminate", hyp_state(B(2.0, 0.5, 4.0), 1.0, False) == "indeterminate")
    check("not-attributable", hyp_state(B(0.1, -0.5, 0.9), 1.0, False) == "not-attributable")
    check("a slope > 0 under +1.0pp per step is attributable for H2 only", hyp_state(B(0.5, 0.1, 0.9), 1.0, True, 0.0) == "attributable" and hyp_state(B(0.5, 0.1, 0.9), 1.0, True) == "not-attributable")
    check("a reversal is a NULL that names it", primary_verdict(B(-2.0, -4.0, -0.5), -1.0, True) == ("NULL", NULL_WORDING + "; a reversal: the upper bound is under 0"))

    # 6. the bootstrap is the imported one, seeded, and repeatable
    series = {f"2026-09-{d:02d}": (d % 5) - 1.5 for d in range(1, 28)}
    b1, b2 = boot(series, "H1"), boot(series, "H1")
    check("bootstrap is repeatable under the registered seed", b1 == b2 and b1["clusters"] == 27 and b1["draws_used"] == BOOT_B)
    check("bootstrap point is the mean of the daily values", abs(b1["point"] - sum(series.values()) / 27) < 1e-9)
    check("no day -> no estimate", boot({}, "H1") is None)

    # 7. hold-out = the days after the median day
    d27 = [f"2026-09-{d:02d}" for d in range(1, 28)]
    check("27 days -> the last 13 are the hold-out", holdout_days(d27) == d27[14:] and len(holdout_days(d27)) == HOLDOUT_DAYS)
    cd27 = corpus_days([{"day": "2026-09-01"}])
    check("the corpus days are the 27 UTC days of [T_FLIP, T_DIAG_END]", len(cd27) == 27 and cd27[0] == "2026-08-31" and cd27[-1] == "2026-09-26")
    check("the hold-out is 2026-09-14 … 2026-09-26", holdout_days(cd27) == cd27[14:] and holdout_days(cd27)[0] == "2026-09-14" and len(holdout_days(cd27)) == HOLDOUT_DAYS)
    try:
        corpus_days([{"day": "2026-09-27"}])
        check("a row outside the corpus days is refused", False)
    except SystemExit:
        check("a row outside the corpus days is refused", True)

    # 8. H2's slope: bins at 0, 10, 20, 30 pp -> +10 per step
    def bin_rows(name, wins_buy):  # 40 rows, q = .5; BUY rows win at wins_buy/20, SELL rows never win
        out = []
        for i in range(20):
            out.append({"side": "BUY", "y": 1 if i < wins_buy else -1, "f_bin": name})
            out.append({"side": "SELL", "y": -1, "f_bin": name})
        return out
    # excess = 2q(1-q)(a-b) with b = P(up|SELL) = 1: a = wins/20 -> excess = .5 * (a - 1)
    sl = stat_h2(bin_rows("F1", 4) + bin_rows("F2", 8) + bin_rows("F3", 12) + bin_rows("CLEAR", 16))
    check("H2 slope is +10pp per step", sl is not None and abs(sl[0] - 10.0) < 1e-9)
    check("one bin -> absent", stat_h2(bin_rows("F1", 4)) is None)

    verdict = "PASS" if not fails else "FAIL"
    for f in fails:
        print(f"  FAIL {f}")
    print(f"[sr_analyze self-test] {n[0] - len(fails)}/{n[0]} checks")
    print(f"SR_ANALYZE_SELFTEST_VERDICT={verdict}")
    return 0 if verdict == "PASS" else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--cardinalities", action="store_true")
    ap.add_argument("--analyze", action="store_true")
    ap.add_argument("--features", nargs="+")
    ap.add_argument("--labels")
    ap.add_argument("--coverage")
    ap.add_argument("--meta-labelfree")
    ap.add_argument("--meta-labels")
    ap.add_argument("--out")
    ap.add_argument("--out-json")
    ap.add_argument("--out-md")
    ap.add_argument("--sims", type=int, default=0)
    args = ap.parse_args()
    if args.self_test:
        return self_test()
    if args.cardinalities:
        if not args.features or not args.out:
            ap.error("--cardinalities needs --features and --out")
        return cardinalities(args)
    if args.analyze:
        need = (args.features, args.labels, args.coverage, args.meta_labelfree, args.meta_labels, args.out_json, args.out_md)
        if not all(need):
            ap.error("--analyze needs --features --labels --coverage --meta-labelfree --meta-labels --out-json --out-md")
        return analyze(args)
    ap.error("one of --self-test, --cardinalities, --analyze")
    return 2


if __name__ == "__main__":
    sys.exit(main())

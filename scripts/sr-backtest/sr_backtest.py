#!/usr/bin/env python3
"""EDGE-SR-LEVEL-BACKTEST-W1 — the estimator of the level-zone backtest.

The TypeScript harness (src/scripts/sr-backtest/run.ts) turns candles into COUNTS: one row per arm, timeframe,
UTC day and coin with the served and control events that were entered, bounced and broke. This file turns counts
into the registered statistics. It holds no formula of its own for the bootstrap, the FDR step or the
identifiability bound: those are imported from src/scripts/cluster-perm-stats.py and
ops/monitoring/population_comparison.py.

  --self-test                      two-way self-test of the verdict logic      SR_BACKTEST_SELFTEST_VERDICT=PASS|FAIL
  --cardinalities DIR              label-free tables of a skeleton run (markdown on stdout)
  --power DIR                      the design's power on that skeleton, outcomes simulated (JSON on stdout)
  --calibrate CSV --out JSON       the null calibration on seeded driftless walks
                                                                    SR_BACKTEST_CALIBRATION_VERDICT=PASS|FAIL|INDETERMINATE
  --analyze DIR --landed-at ISO --out-md F --out-json F
                                   THE read. Refuses unless DIR is a guarded outcome run and the registration
                                   landed before it.     SR_BACKTEST_VERDICT=PASS|NULL|INDETERMINATE — <cause>
                                                         SR_BACKTEST_ANALYZE_VERDICT=REFUSED — <reason>   (exit 3)

Callers gate on the token, never the exit code. Exit 0 = the step ran and said PASS or NULL; 1 = FAIL;
3 = INDETERMINATE or REFUSED.
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
import traceback
from collections import defaultdict
from datetime import datetime, timezone
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

WAVE = "EDGE-SR-LEVEL-BACKTEST-W1"
TFS = ("15m", "1h", "4h", "1d")
COLS = ("served", "matched", "sN", "sHit", "sBreak", "cN", "cHit", "cBreak", "forced")
SERVED, MATCHED, SN, SHIT, SBREAK, CN, CHIT, CBREAK, FORCED = range(9)
MIN_ARM = 30
MIN_CLUSTERS = 20
BOOT_B = 2000
BH_Q = 0.10
HOLDOUT_DAYS = 92
WINDOW_DAYS = 365
DAY_MS = 86_400_000
FLOOR = {"V1": 3.0, "V2a": 2.0, "V2b": 0.0, "V3": 1.0, "V4a": 3.0, "V4b": 3.0}
CAL_MIN_REPS = 100
CAL_MIN_WALKS = 50
CAL_TOLERANCE_PP = 0.5
CAL_MAX_PASS_SHARE = 0.05
ALT_SOURCES = ("floor", "pdhl", "rnd")
NULL_WORDING = "our zones bounce no more than matched random zones by +3.0pp"
# Test-only: break one rule on purpose, so the self-test can be shown to fail (tests/unit/sr-backtest-harness.test.ts).
MUTATE = os.environ.get("SR_BACKTEST_MUTATE", "")


def sha256_file(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ─────────────────────────────── counts ───────────────────────────────

def read_counts(path) -> list[dict]:
    """counts.csv / skeleton.csv: key, tf, day, coin, then COLS. A calibration file carries a leading `rep`."""
    rows = []
    with open(path, newline="") as f:
        rd = csv.reader(f)
        head = next(rd)
        off = 1 if head[0] == "rep" else 0
        if tuple(head[off:]) != ("key", "tf", "day", "coin") + COLS:
            raise ValueError(f"{path}: unexpected header {head}")
        for r in rd:
            rows.append({"rep": int(r[0]) if off else 0, "key": r[off], "tf": r[off + 1], "day": int(r[off + 2]), "coin": r[off + 3],
                         "c": [int(x) for x in r[off + 4:]]})
    return rows


def margin(rows, unit: str) -> dict:
    """Sums of the count columns per (arm, timeframe, cluster) — the cluster is a UTC day or a coin."""
    m = defaultdict(lambda: [0] * len(COLS))
    for r in rows:
        acc = m[(r["key"], r["tf"], r[unit])]
        for i, v in enumerate(r["c"]):
            acc[i] += v
    return m


def units_of(rows, unit: str) -> list:
    return sorted({r[unit] for r in rows})


def delta(key: str):
    """Bounce share of the served arm minus the control arm, in pp. Present only when each arm holds MIN_ARM
    entered events in the cell."""
    def stat(m, tf, u):
        c = m.get((key, tf, u))
        if c is None or c[SN] < MIN_ARM or c[CN] < MIN_ARM:
            return None
        d = 100.0 * (c[SHIT] / c[SN] - c[CHIT] / c[CN])
        if MUTATE == "swap-arms":
            d = -d
        return d, c[SN] + c[CN]
    return stat


def minus(a, b):
    """Difference of two cell statistics, present only when both are; the weight is the sum."""
    def stat(m, tf, u):
        x, y = a(m, tf, u), b(m, tf, u)
        if x is None or y is None:
            return None
        return x[0] - y[0], x[1] + y[1]
    return stat


def negated(a):
    def stat(m, tf, u):
        x = a(m, tf, u)
        return None if x is None else (-x[0], x[1])
    return stat


def follow_through(key: str):
    """V5: the share of breaks that reached the next zone beyond (served arm columns only)."""
    def stat(m, tf, u):
        c = m.get((key, tf, u))
        if c is None or c[SN] < MIN_ARM:
            return None
        return 100.0 * c[SHIT] / c[SN], c[SN]
    return stat


def series(m, stat, units, tfs=TFS) -> dict:
    """Per cluster: the scored-weighted mean of the statistic over the timeframe cells present."""
    out = {}
    for u in units:
        parts = [p for p in (stat(m, tf, u) for tf in tfs) if p is not None]
        if not parts:
            continue
        wsum = sum(w for _, w in parts)
        out[u] = sum(v * w for v, w in parts) / wsum
    return out


def boot(vals: dict, name: str, b_draws: int = BOOT_B):
    """Intercept of cluster_bootstrap_ols with one observation per cluster. None when no cluster is present."""
    ids = sorted(vals)
    if not ids:
        return None
    y = [vals[i] for i in ids]
    b = cps.cluster_bootstrap_ols([[1.0] for _ in ids], y, ids, b_draws, random.Random(cps.arm_seed(WAVE, name)))
    lo, hi = b["coef"][0]["ci95"]
    same = b["coef"][0]["same_sign_frac"]
    p = float("nan")
    if not (isinstance(same, float) and math.isnan(same)):
        p = (1.0 - same) if b["beta"][0] > 0 else same  # the share of draws at or under zero
        p = max(p, 1.0 / (b["draws_used"] + 1))
    return {"point": b["beta"][0], "lo": lo, "hi": hi, "clusters": b["clusters"], "p_one_sided": p,
            "draws_used": b["draws_used"], "singular_draws": b["singular_draws"]}


def holdout_point(vals: dict, hold_units):
    ys = [vals[u] for u in hold_units if u in vals]
    return (sum(ys) / len(ys)) if ys else None


def _bad(b) -> bool:
    return b is None or any(math.isnan(v) for v in (b["point"], b["lo"], b["hi"]))


def primary_verdict(b_day, b_coin, hold, ident_ok: bool, floor: float = FLOOR["V1"]):
    """V1. Returns (verdict, cause, what resolves it)."""
    more = "more scored UTC days: a longer window or the forward test (T3)"
    if b_day is None:
        return "INDETERMINATE", "no cell-day carries both arms at >= 30 entered events", more
    if b_day["clusters"] < MIN_CLUSTERS:
        return "INDETERMINATE", f"{b_day['clusters']} UTC-day clusters, under the floor of {MIN_CLUSTERS}", more
    if not ident_ok:
        return "INDETERMINATE", "NOT_IDENTIFIABLE arm", "a served set that carries both sides"
    if _bad(b_day):
        return "INDETERMINATE", "the bootstrap produced no usable draw", more
    passes_floor = True if MUTATE == "no-floor" else b_day["point"] >= floor
    if b_day["lo"] > 0 and passes_floor:
        if _bad(b_coin) or b_coin["clusters"] < MIN_CLUSTERS:
            return "INDETERMINATE", "fewer than 20 coin clusters", "a wider panel"
        if b_coin["lo"] <= 0:
            return "INDETERMINATE", "the coin-cluster lower bound is <= 0", "a wider panel or the forward test (T3)"
        if MUTATE == "no-holdout" or (hold is not None and hold > 0):
            return "PASS", "point >= +3.0pp, 95% lower bound > 0 on UTC-day and coin clusters, positive on the hold-out", ""
        return "INDETERMINATE", "hold-out sign flip", "the forward test (T3)"
    if b_day["hi"] < 0:
        return "NULL", NULL_WORDING + "; a reversal: the UTC-day upper bound is under 0", ""
    if b_day["hi"] < floor:
        return "NULL", NULL_WORDING, ""
    if b_day["lo"] <= 0:
        return "INDETERMINATE", "the interval holds +3.0pp with its lower bound <= 0", more
    return "INDETERMINATE", "lower bound > 0 but the point is under +3.0pp and the interval holds +3.0pp", more


def test_state(b, floor: float, rejected: bool) -> str:
    """V2–V4: PASS = the BH step rejects, lower bound > 0, point at or over the floor; NULL = the interval sits
    under the floor; INDETERMINATE = neither, or fewer than MIN_CLUSTERS clusters."""
    if _bad(b) or b["clusters"] < MIN_CLUSTERS:
        return "INDETERMINATE"
    if rejected and b["lo"] > 0 and b["point"] >= floor:
        return "PASS"
    if b["hi"] < floor:
        return "NULL"
    return "INDETERMINATE"


def minority(sides: dict, key: str):
    s = sides.get(key)
    if not s or sum(s) == 0:
        return None
    return min(s) / sum(s)


def identifiable(sides: dict, arms, floor: float) -> dict:
    shares = [minority(sides, a) for a in arms]
    if any(s is None for s in shares):
        return {"verdict": "INDETERMINATE", "reason": "an arm has no matched row", "shares": shares}
    r = pc.declaration_identifiability(floor, shares)
    return {"verdict": r["verdict"], "reason": r["reason"], "bound_pp": r["bound_pp"], "shares": shares}


def pooled(m, key: str, tfs=TFS, units=None) -> dict:
    tot = [0] * len(COLS)
    for (k, tf, u), c in m.items():
        if k == key and tf in tfs and (units is None or u in units):
            for i, v in enumerate(c):
                tot[i] += v
    pct = lambda a, b: (100.0 * a / b) if b else None  # noqa: E731
    return {"served": tot[SERVED], "forced": tot[FORCED], "forced_pct": pct(tot[FORCED], tot[MATCHED]),
            "served_entered": tot[SN], "control_entered": tot[CN], "served_entered_pct": pct(tot[SN], tot[MATCHED]),
            "control_entered_pct": pct(tot[CN], tot[MATCHED]), "served_bounce_pct": pct(tot[SHIT], tot[SN]),
            "control_bounce_pct": pct(tot[CHIT], tot[CN]), "served_break_pct": pct(tot[SBREAK], tot[SN]),
            "control_break_pct": pct(tot[CBREAK], tot[CN])}


def presence(m, stat, units, tfs=TFS) -> dict:
    present = sum(1 for u in units for tf in tfs if stat(m, tf, u) is not None)
    return {"cells_present": present, "cells_absent": len(units) * len(tfs) - present}


# ─────────────────────────────── the read ───────────────────────────────

def estimate(rows, sides: dict, hold_start_day: int, label: str = "") -> dict:
    """Every registered statistic from one set of counts."""
    md, mc = margin(rows, "day"), margin(rows, "coin")
    days, coins = units_of(rows, "day"), units_of(rows, "coin")
    hold_days = [d for d in days if d >= hold_start_day]
    in_days = [d for d in days if d < hold_start_day]

    def run(name: str, stat, tfs=TFS):
        vals = series(md, stat, days, tfs)
        return {"day": boot(vals, f"{label}{name}-day"), "coin": boot(series(mc, stat, coins, tfs), f"{label}{name}-coin"),
                "holdout": holdout_point(vals, hold_days), "in_sample": holdout_point(vals, in_days),
                "holdout_days": sum(1 for d in hold_days if d in vals), **presence(md, stat, days, tfs)}

    v1 = run("V1", delta("z1"))
    ident = identifiable(sides, ["z1"], FLOOR["V1"]) if sides else {"verdict": pc.IDENTIFIABLE, "reason": "not assessed"}
    verdict, cause, resolves = primary_verdict(v1["day"], v1["coin"], v1["holdout"], ident["verdict"] == pc.IDENTIFIABLE)
    out = {"verdict": verdict, "cause": cause, "resolves": resolves, "V1": {**v1, "identifiability": ident, "floor_pp": FLOOR["V1"]}}
    out["per_cell"] = {tf: {**run(f"V1-{tf}", delta("z1"), (tf,)), "rates": pooled(md, "z1", (tf,))} for tf in TFS}
    out["per_cell_holdout_rates"] = {tf: pooled(md, "z1", (tf,), set(hold_days)) for tf in TFS}
    out["rates"] = {k: pooled(md, k) for k in ("z1", "z1.W", "z1.M", "z1.S", "z1.sup", "z1.res", "z1.r1", "z1.r2", "z1.r3", "z1.rnd1", "z1.rnd0",
                                               "z1.SS", "z1.SSS", "z1.S0", "floor", "pdhl", "rnd", "v4a", "v4a.long", "v4a.short", "v4b", "v4b.long", "v4b.short")}
    out["descriptive"] = {k: run(f"D-{k}", delta(k)) for k in ("z1.W", "z1.M", "z1.S", "z1.sup", "z1.res", "z1.r1", "z1.r2", "z1.r3", "z1.rnd1",
                                                               "z1.rnd0", "z1.SS", "z1.SSS", "z1.S0", "floor", "pdhl", "rnd")}

    # V3's comparator is the free version with the highest point estimate on the full window; picking the largest of
    # three noisy estimates leans against our zones.
    alts = {a: out["descriptive"][a]["day"] for a in ALT_SOURCES}
    ranked = sorted((a for a in ALT_SOURCES if not _bad(alts[a])), key=lambda a: -alts[a]["point"])
    best = ranked[0] if ranked else None
    tests = {
        "V2a": (run("V2a", minus(delta("z1.S"), delta("z1.W"))), ["z1.S", "z1.W"]),
        "V2b": (run("V2b", minus(delta("z1.SS"), delta("z1.S0"))), ["z1.SS", "z1.S0"]),
        "V3": (run("V3", minus(delta("z1"), delta(best))) if best else {"day": None, "coin": None, "holdout": None}, ["z1"] + ([best] if best else [])),
        "V4a": (run("V4a", delta("v4a")), ["v4a"]),
        "V4b": (run("V4b", negated(delta("v4b"))), ["v4b"]),
    }
    names = list(tests)
    pvals = [1.0 if _bad(tests[n][0]["day"]) or math.isnan(tests[n][0]["day"]["p_one_sided"]) else tests[n][0]["day"]["p_one_sided"] for n in names]
    rejected = cps.bh(pvals, BH_Q)
    for n, p, rej in zip(names, pvals, rejected):
        res, arms = tests[n]
        idn = identifiable(sides, arms, FLOOR[n]) if sides else {"verdict": pc.IDENTIFIABLE, "reason": "not assessed"}
        state = test_state(res["day"], FLOOR[n], rej)
        if idn["verdict"] != pc.IDENTIFIABLE:
            state = "INDETERMINATE"
        out[n] = {**res, "floor_pp": FLOOR[n], "p_one_sided": p, "bh_rejected": rej, "state": state, "identifiability": idn}
    out["V3"]["comparator"] = best
    out["V4b"]["note"] = "the statistic is control minus served: a positive value means the served stop was knocked out and recovered less often"

    # V5: follow-through after a 1-close break minus after a 2-close break. "Broken" stays the 2-close rule unless the
    # 1-close break follows through more, lower bound > 0.
    v5 = run("V5", minus(follow_through("v5.b1"), follow_through("v5.b2")))
    b = v5["day"]
    if _bad(b) or b["clusters"] < MIN_CLUSTERS:
        state, pick = "INDETERMINATE", "2-close (the registered default)"
    elif b["lo"] > 0:
        state, pick = "PASS", "1-close"
    else:
        state, pick = "NULL", "2-close (the registered default)"
    out["V5"] = {**v5, "state": state, "broken_rule": pick, "follow_through_1close_pct": pooled(md, "v5.b1")["served_bounce_pct"],
                 "follow_through_2close_pct": pooled(md, "v5.b2")["served_bounce_pct"], "breaks_1close": pooled(md, "v5.b1")["served_entered"],
                 "breaks_2close": pooled(md, "v5.b2")["served_entered"]}
    out["clusters"] = {"utc_days": len(days), "holdout_days": len(hold_days), "coins": len(coins)}
    return out


def decision_map(o: dict) -> list[str]:
    lines = []
    if o["verdict"] == "PASS":
        lines.append("V1 PASS -> the arc continues: T2 builds the tool on zone rule Z1 and T3's forward test starts.")
    else:
        lines.append(f"V1 {o['verdict']} -> the arc closes with nothing published (arc close condition).")
    if o["V2a"]["state"] != "PASS":
        lines.append(f"V2 Strong-vs-Weak {o['V2a']['state']} -> no Weak / Medium / Strong words; goes to Mr.1 (arc Extra gate).")
    if o["V2b"]["state"] != "PASS":
        lines.append(f"V2 Super-Strong-vs-Strong {o['V2b']['state']} -> no Super Strong word; goes to Mr.1 (arc Extra gate).")
    if o["V4a"]["state"] != "PASS" or o["V4b"]["state"] != "PASS":
        lines.append(f"V4 take-profit {o['V4a']['state']}, stop {o['V4b']['state']} -> no take-profit / stop ideas for the failed part; goes to Mr.1 (arc Extra gate).")
    if o["V3"]["state"] != "PASS":
        lines.append(f"V3 {o['V3']['state']} against {o['V3'].get('comparator')} -> the simpler rule is considered; goes to Mr.1 (arc Extra gate).")
    lines.append(f"V5 {o['V5']['state']} -> \"broken\" is the {o['V5']['broken_rule']} rule.")
    lines.append("None of V2-V5 changes V1.")
    return lines


def fmt(x, nd=2) -> str:
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return "n/a"
    return f"{x:+.{nd}f}" if isinstance(x, float) else str(x)


def pct(x) -> str:
    return "n/a" if x is None else f"{x:.2f}%"


def _b(b) -> str:
    if b is None:
        return "n/a (no cluster present)"
    return f"{fmt(b['point'])}pp [{fmt(b['lo'])}, {fmt(b['hi'])}] · {b['clusters']} clusters"


def render_md(o: dict) -> str:
    L = [f"# {WAVE} — findings", "",
         f"`SR_BACKTEST_VERDICT={o['verdict']} — {o['cause']}`", "",
         "PRIVATE. Vault only: no figure here goes to the repository, the product or public copy. Outcomes are hit-first path labels on candles, never PnL, and this file makes no edge or accuracy claim.", "",
         f"- Registration landed (first seen on origin/main): `{o['registration_landed_at']}` · commit `{o['registration_commit']}`",
         f"- Outcome read started: `{o['outcome_read_at']}`",
         f"- Store manifest sha256: `{o['manifest_sha256']}` · counts.csv sha256: `{o['counts_sha256']}`",
         f"- Clusters: {o['clusters']['utc_days']} UTC days ({o['clusters']['holdout_days']} hold-out), {o['clusters']['coins']} coins", ""]
    if o["resolves"]:
        L += [f"What resolves it: {o['resolves']}.", ""]
    L += ["## What follows (decision map)", ""] + [f"- {x}" for x in o["decision_map"]] + [""]
    v1 = o["V1"]
    L += ["## V1 — served zones against matched random zones", "",
          "| read | delta bounce (served − control) [95% interval] · clusters |", "|---|---|",
          f"| UTC-day clusters, all cells | {_b(v1['day'])} |", f"| coin clusters, all cells | {_b(v1['coin'])} |",
          f"| in-sample days (mean of daily deltas) | {fmt(v1['in_sample'])}pp |",
          f"| hold-out days (mean of daily deltas, {v1['holdout_days']} days present) | {fmt(v1['holdout'])}pp |", "",
          f"Cell-days present {v1['cells_present']}, absent {v1['cells_absent']} (a cell-day is present when each arm has at least {MIN_ARM} entered events). Identifiability: {v1['identifiability']['verdict']}.", "",
          "### Per timeframe", "",
          "| cell | delta [95%] · day clusters | coin clusters | hold-out | served bounce | control bounce | served break | control break | served entered | control entered | forced controls |",
          "|---|---|---|---|---|---|---|---|---|---|---|"]
    for tf in TFS:
        c = o["per_cell"][tf]
        r = c["rates"]
        L.append(f"| {tf} | {_b(c['day'])} | {_b(c['coin'])} | {fmt(c['holdout'])}pp ({c['holdout_days']} d) | {pct(r['served_bounce_pct'])} | {pct(r['control_bounce_pct'])} | {pct(r['served_break_pct'])} | {pct(r['control_break_pct'])} | {r['served_entered']} ({pct(r['served_entered_pct'])}) | {r['control_entered']} ({pct(r['control_entered_pct'])}) | {pct(r['forced_pct'])} |")
    L += ["", "## V2–V5", "", "| test | statistic [95%] · day clusters | coin clusters | hold-out | floor | one-sided p | BH q 0.10 | state |", "|---|---|---|---|---|---|---|---|"]
    names = {"V2a": "V2 Strong − Weak (difference of deltas)", "V2b": "V2 Super Strong − Strong alone", "V3": f"V3 ours − best free version ({o['V3'].get('comparator')})",
             "V4a": "V4 (a) take-profit before the opposing zone", "V4b": "V4 (b) stop beyond the zone: control − served"}
    for n in ("V2a", "V2b", "V3", "V4a", "V4b"):
        t = o[n]
        L.append(f"| {names[n]} | {_b(t['day'])} | {_b(t['coin'])} | {fmt(t['holdout'])}pp | {t['floor_pp']:+.1f}pp | {t['p_one_sided']:.4f} | {'rejects' if t['bh_rejected'] else 'does not reject'} | {t['state']} |")
    v5 = o["V5"]
    L += [f"| V5 follow-through, 1-close − 2-close break | {_b(v5['day'])} | {_b(v5['coin'])} | {fmt(v5['holdout'])}pp | lower bound > 0 | — | — | {v5['state']} → {v5['broken_rule']} |", "",
          f"V5 pooled: after a 1-close break the next zone was reached in {pct(v5['follow_through_1close_pct'])} of {v5['breaks_1close']} breaks; after a 2-close break in {pct(v5['follow_through_2close_pct'])} of {v5['breaks_2close']}.", "",
          "## Arms (pooled rates; descriptive)", "",
          "| arm | delta [95%] · day clusters | served | forced controls | served entered | served bounce | control bounce | served break | control break |", "|---|---|---|---|---|---|---|---|---|"]
    for k, r in o["rates"].items():
        d = o["descriptive"].get(k)
        dd = _b(d["day"]) if d else ("see V1" if k == "z1" else "see V4")
        L.append(f"| {k} | {dd} | {r['served']} | {pct(r['forced_pct'])} | {pct(r['served_entered_pct'])} | {pct(r['served_bounce_pct'])} | {pct(r['control_bounce_pct'])} | {pct(r['served_break_pct'])} | {pct(r['control_break_pct'])} |")
    L += ["", "For v4a the 'bounce' columns are take-profit-first shares; for v4b they are knocked-out-then-recovered shares.", "",
          "## Hold-out, per timeframe (pooled rates)", "", "| cell | served entered | served bounce | control bounce |", "|---|---|---|---|"]
    for tf in TFS:
        r = o["per_cell_holdout_rates"][tf]
        L.append(f"| {tf} | {r['served_entered']} | {pct(r['served_bounce_pct'])} | {pct(r['control_bounce_pct'])} |")
    L += ["", "## Pinned files", "", "| file | sha256 |", "|---|---|"] + [f"| `{k}` | `{v}` |" for k, v in sorted(o["harness_sha256"].items())] + [""]
    return "\n".join(L)


def _iso(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def load_run(run_dir: Path, counts_name: str):
    meta = json.loads((run_dir / "run-meta.json").read_text())
    sides = json.loads((run_dir / "sides.json").read_text())
    return meta, sides, run_dir / counts_name


def analyze(args) -> int:
    run_dir = Path(args.analyze)

    def refuse(reason: str) -> int:
        print(f"SR_BACKTEST_ANALYZE_VERDICT=REFUSED — {reason}")
        return 3
    try:
        meta, sides, counts = load_run(run_dir, "counts.csv")
    except (OSError, ValueError) as e:
        return refuse(f"the run directory is unreadable: {e}")
    guard = meta.get("guard") or {}
    if meta.get("mode") != "outcomes" or guard.get("ok") is not True:
        return refuse("the run is not a guarded outcome run")
    if sha256_file(counts) != meta.get("files", {}).get("counts.csv"):
        return refuse("counts.csv is not the file the run wrote")
    if not args.landed_at:
        return refuse("--landed-at is required")
    # Whole seconds: the two instants are persisted to the second, and the persisted pair must show the order too.
    landed, read_at = _iso(args.landed_at).replace(microsecond=0), _iso(meta["startedAt"]).replace(microsecond=0)
    if not landed < read_at:
        return refuse(f"the registration landed at {landed.isoformat()} and the outcome read started at {read_at.isoformat()}: not before it")
    for rel, want in guard.get("harnessSha256", {}).items():
        if sha256_file(REPO / rel) != want:
            return refuse(f"{rel} changed since the outcome run")
    o = estimate(read_counts(counts), sides, meta["holdoutStartMs"] // DAY_MS)
    o.update({"wave": WAVE, "registration_landed_at": landed.strftime("%Y-%m-%dT%H:%M:%SZ"), "outcome_read_at": read_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
              "registration_commit": guard.get("registrationCommit"), "origin_main_at_read": guard.get("originMain"),
              "manifest_sha256": guard.get("manifestSha256"), "harness_sha256": guard.get("harnessSha256"),
              "counts_sha256": meta["files"]["counts.csv"], "events_sha256": meta["files"].get("events-z1.csv"), "run_dir": str(run_dir),
              "coins": meta["coins"], "instants": meta["instants"], "window": {"startMs": meta["startMs"], "endMs": meta["endMs"], "holdoutStartMs": meta["holdoutStartMs"]}})
    o["decision_map"] = decision_map(o)
    as_json, as_md = json.dumps(o, indent=1, sort_keys=True) + "\n", render_md(o)  # both rendered before either is written
    Path(args.out_json).write_text(as_json)
    Path(args.out_md).write_text(as_md)
    print(f"SR_BACKTEST_VERDICT={o['verdict']} — {o['cause']}")
    return 3 if o["verdict"] == "INDETERMINATE" else 0


# ─────────────────────────────── null calibration ───────────────────────────────

def calibrate(args) -> int:
    path = Path(args.calibrate)
    by_rep, raw = defaultdict(list), defaultdict(list)
    with open(path) as f:
        lines = f.read().split("\n")
    for line in lines[1:]:
        if line:
            raw[int(line.split(",", 1)[0])].append(line)
    for r in read_counts(path):
        by_rep[r["rep"]].append(r)
    reps = []
    for rep in sorted(by_rep):
        rows = [r for r in by_rep[rep] if r["key"] == "z1"]
        days = units_of(rows, "day")
        md = margin(rows, "day")
        vals = series(md, delta("z1"), days)
        present = sorted(vals)
        hold = present[-max(1, round(len(present) * HOLDOUT_DAYS / WINDOW_DAYS)):] if present else []
        b_day = boot(vals, f"cal-{rep}-day")
        b_coin = boot(series(margin(rows, "coin"), delta("z1"), units_of(rows, "coin")), f"cal-{rep}-coin")
        verdict, cause, _ = primary_verdict(b_day, b_coin, holdout_point(vals, hold), True)
        extra = {k: (boot(series(margin(by_rep[rep], "day"), delta(k), units_of(by_rep[rep], "day")), f"cal-{rep}-{k}", 200) or {}).get("point") for k in ("v4a", "v4b")}
        reps.append({"rep": rep, "walks": len(units_of(rows, "coin")), "delta_pp": None if b_day is None else b_day["point"],
                     "lo": None if b_day is None else b_day["lo"], "hi": None if b_day is None else b_day["hi"],
                     "day_clusters": None if b_day is None else b_day["clusters"], "coin_delta_pp": None if b_coin is None else b_coin["point"],
                     "verdict": verdict, "cause": cause, "v4a_delta_pp": extra["v4a"], "v4b_delta_pp": extra["v4b"],
                     "rows_sha256": hashlib.sha256("\n".join(raw[rep]).encode()).hexdigest()})
    ds = [r["delta_pp"] for r in reps if r["delta_pp"] is not None]
    n = len(ds)
    mean = sum(ds) / n if n else float("nan")
    sd = math.sqrt(sum((d - mean) ** 2 for d in ds) / (n - 1)) if n > 1 else float("nan")
    pass_share = sum(1 for r in reps if r["verdict"] == "PASS") / len(reps) if reps else float("nan")
    excl = sum(1 for r in reps if r["lo"] is not None and (r["lo"] > 0 or r["hi"] < 0)) / len(reps) if reps else float("nan")
    mean_of = lambda k: (sum(r[k] for r in reps if r[k] is not None) / max(1, sum(1 for r in reps if r[k] is not None)))  # noqa: E731
    min_reps = args.min_reps if args.min_reps is not None else CAL_MIN_REPS
    within = n > 0 and abs(mean) <= CAL_TOLERANCE_PP
    if len(reps) < min_reps or n < len(reps) or any(r["walks"] < CAL_MIN_WALKS for r in reps):
        verdict = "INDETERMINATE"
    else:
        verdict = "PASS" if within and pass_share <= CAL_MAX_PASS_SHARE else "FAIL"
    out = {"wave": WAVE, "verdict": verdict, "replications": len(reps), "walks_per_replication": min((r["walks"] for r in reps), default=0),
           "mean_delta_pp": mean, "sd_delta_pp": sd, "se_mean_pp": sd / math.sqrt(n) if n > 1 else float("nan"),
           "within_tolerance": within, "tolerance_pp": CAL_TOLERANCE_PP, "v1_pass_share": pass_share, "max_pass_share": CAL_MAX_PASS_SHARE,
           "interval_excludes_zero_share": excl, "mean_v4a_delta_pp": mean_of("v4a_delta_pp"), "mean_v4b_delta_pp": mean_of("v4b_delta_pp"),
           "harness_sha256": {rel: sha256_file(REPO / rel) for rel in CALIBRATION_FILES}, "reps": reps}
    if args.out:
        Path(args.out).write_text(json.dumps(out, indent=1, sort_keys=True) + "\n")
    print(json.dumps({k: v for k, v in out.items() if k not in ("reps", "harness_sha256")}, sort_keys=True))
    print(f"SR_BACKTEST_CALIBRATION_VERDICT={verdict}")
    return {"PASS": 0, "FAIL": 1}.get(verdict, 3)


# Every file whose bytes decide the calibration; scripts/sr-backtest/calibration.json records their sha256.
CALIBRATION_FILES = ("src/scripts/sr-probe/level-v0.ts", "src/scripts/sr-backtest/spec.ts", "src/scripts/sr-backtest/zones.ts",
                     "src/scripts/sr-backtest/engine.ts", "src/scripts/sr-backtest/synth.ts", "src/scripts/sr-backtest/run.ts",
                     "scripts/sr-backtest/sr_backtest.py", "src/scripts/cluster-perm-stats.py")


# ─────────────────────────────── label-free: cardinalities and power ───────────────────────────────

def cardinalities(args) -> int:
    run_dir = Path(args.cardinalities)
    meta, sides, counts = load_run(run_dir, "skeleton.csv")
    if meta.get("mode") != "skeleton":
        print("SR_BACKTEST_CARDINALITIES_VERDICT=INDETERMINATE — not a skeleton run")
        return 3
    rows = read_counts(counts)
    md = margin(rows, "day")
    days = units_of(rows, "day")
    hold_start = meta["holdoutStartMs"] // DAY_MS
    print(f"coins {len(meta['coins'])} · grid instants {meta['instants']} · UTC days with a served row {len(days)} · hold-out days {sum(1 for d in days if d >= hold_start)}")
    print(f"skeleton.csv sha256 {sha256_file(counts)}\n")
    print("| arm | cell | served zones | forced controls | forced share | UTC days | days at >= 30 served | days at >= 75 served | hold-out days at >= 75 |")
    print("|---|---|---|---|---|---|---|---|---|")
    keys = sorted({r["key"] for r in rows})
    for k in keys:
        for tf in TFS:
            cells = [(u, c) for (kk, t, u), c in md.items() if kk == k and t == tf]
            served = sum(c[SERVED] for _, c in cells)
            forced = sum(c[FORCED] for _, c in cells)
            if not served:
                continue
            print(f"| {k} | {tf} | {served:,} | {forced:,} | {100.0 * forced / served:.2f}% | {len(cells)} | {sum(1 for _, c in cells if c[SERVED] >= 30)} | "
                  f"{sum(1 for _, c in cells if c[SERVED] >= 75)} | {sum(1 for u, c in cells if c[SERVED] >= 75 and u >= hold_start)} |")
    print("\n| arm | first side | second side | minority share m |")
    print("|---|---|---|---|")
    for k in sorted(sides):
        a, b = sides[k]
        print(f"| {k} | {a:,} | {b:,} | {min(a, b) / (a + b):.4f} |")
    print("\nSR_BACKTEST_CARDINALITIES_VERDICT=PASS")
    return 0


def _binom(rng, n: int, p: float) -> int:
    if n <= 0 or p <= 0:
        return 0
    if p >= 1:
        return n
    if n * p * (1 - p) >= 10:
        return min(n, max(0, int(round(rng.gauss(n * p, math.sqrt(n * p * (1 - p)))))))
    return sum(1 for _ in range(n) if rng.random() < p)


def power(args) -> int:
    """V1's UTC-day leg on the REAL label-free skeleton with simulated outcomes: every served zone and its control is
    entered with probability `--enter`, the control bounces with probability `--base` and the served zone with
    `--base` + the injected delta. Events are drawn independently, so the spread is a FLOOR: it holds no shared
    market move within a day, which the day-cluster bootstrap of the real read does carry."""
    run_dir = Path(args.power)
    meta, _sides, counts = load_run(run_dir, "skeleton.csv")
    rows = [r for r in read_counts(counts) if r["key"] == "z1"]
    hold_start = meta["holdoutStartMs"] // DAY_MS
    cells = defaultdict(int)
    for r in rows:
        cells[(r["tf"], r["day"])] += r["c"][SERVED]
    days = sorted({d for _, d in cells})
    hold = [d for d in days if d >= hold_start]
    rng = random.Random(cps.arm_seed(WAVE, "power"))
    out = {"sims": args.sims, "enter": args.enter, "base": args.base, "bootstrap_draws": 400, "utc_days": len(days), "by_delta": {}}
    for d_pp in (0.0, 3.0, 4.0, 5.0):
        points, verdicts = [], defaultdict(int)
        for _ in range(args.sims):
            m = {}
            for (tf, day), n in cells.items():
                sn, cn = _binom(rng, n, args.enter), _binom(rng, n, args.enter)
                m[("z1", tf, day)] = [n, n, sn, _binom(rng, sn, args.base + d_pp / 100.0), 0, cn, _binom(rng, cn, args.base), 0, 0]
            vals = series(m, delta("z1"), days)
            b = boot(vals, "power", 400)
            fake_coin = {"point": 1.0, "lo": 1.0, "hi": 1.0, "clusters": MIN_CLUSTERS}
            v, _c, _r = primary_verdict(b, fake_coin, holdout_point(vals, hold), True)
            verdicts[v] += 1
            if b is not None:
                points.append(b["point"])
        n = len(points)
        mean = sum(points) / n if n else float("nan")
        sd = math.sqrt(sum((p - mean) ** 2 for p in points) / (n - 1)) if n > 1 else float("nan")
        out["by_delta"][f"{d_pp:+.1f}"] = {"mean_estimate_pp": mean, "sd_pp": sd, "share": {k: verdicts.get(k, 0) / args.sims for k in ("PASS", "NULL", "INDETERMINATE")}}
    print(json.dumps(out, indent=1, sort_keys=True))
    return 0


# ─────────────────────────────── self-test ───────────────────────────────

def _rows(days: int, coins: int, s_rate, c_rate, n: int = 200, tf: str = "1h", key: str = "z1", first_day: int = 20000) -> list[dict]:
    """Deterministic counts: every (day, coin) cell enters n events per arm; the hit counts follow the given rates,
    which may depend on the day index, with a small fixed wobble so the bootstrap has a spread."""
    out = []
    for d in range(days):
        for c in range(coins):
            wob = (((d * 7 + c * 3) % 5) - 2) if n >= 50 else 0
            sr = s_rate(d) if callable(s_rate) else s_rate
            cr = c_rate(d) if callable(c_rate) else c_rate
            out.append({"rep": 0, "key": key, "tf": tf, "day": first_day + d, "coin": f"C{c:02d}",
                        "c": [n, n, n, int(round(n * sr)) + wob, n // 4, n, int(round(n * cr)) - wob, n // 4, 0]})
    return out


def self_test() -> int:
    fails = []

    def check(name: str, cond: bool) -> None:
        if not cond:
            fails.append(name)
    sides = {k: [500, 500] for k in ("z1", "z1.S", "z1.W", "z1.SS", "z1.S0", "floor", "pdhl", "rnd", "v4a", "v4b")}
    hold = 20000 + 30

    def verdict(rows, sd=sides, hs=hold):
        return estimate(rows, sd, hs, "selftest-")

    strong = verdict(_rows(40, 25, 0.60, 0.50))
    check("a +10pp effect on 40 days and 25 coins passes", strong["verdict"] == "PASS")
    check("its point is near +10pp", abs(strong["V1"]["day"]["point"] - 10.0) < 1.0)
    null = verdict(_rows(40, 25, 0.50, 0.50))
    check("no effect on tight data is NULL", null["verdict"] == "NULL")
    rev = verdict(_rows(40, 25, 0.45, 0.50))
    check("a reversal is NULL and named", rev["verdict"] == "NULL" and "reversal" in rev["cause"])
    small = verdict(_rows(40, 25, 0.515, 0.50))
    check("a tight +1.5pp is NULL, never PASS (the +3.0pp floor)", small["verdict"] == "NULL")
    few = verdict(_rows(12, 25, 0.60, 0.50), hs=20000 + 9)
    check("12 day clusters is INDETERMINATE", few["verdict"] == "INDETERMINATE" and "clusters" in few["cause"])
    flip = verdict(_rows(40, 25, lambda d: 0.62 if d < 30 else 0.47, 0.50))
    check("a negative hold-out is INDETERMINATE — hold-out sign flip", flip["verdict"] == "INDETERMINATE" and flip["cause"] == "hold-out sign flip")
    wide = verdict(_rows(40, 25, lambda d: 0.70 if d % 2 else 0.33, 0.50))
    check("an interval holding +3.0pp with its lower bound <= 0 is INDETERMINATE", wide["verdict"] == "INDETERMINATE" and "lower bound" in wide["cause"])
    fewcoins = verdict(_rows(40, 8, 0.60, 0.50))
    check("8 coin clusters is INDETERMINATE", fewcoins["verdict"] == "INDETERMINATE" and "coin" in fewcoins["cause"])
    lop = verdict(_rows(40, 25, 0.60, 0.50), sd={**sides, "z1": [995, 5]})
    check("an arm whose side mix cannot carry the floor is INDETERMINATE — NOT_IDENTIFIABLE", lop["verdict"] == "INDETERMINATE" and "NOT_IDENTIFIABLE" in lop["cause"])
    thin = verdict(_rows(40, 25, 0.60, 0.50, n=1))  # 25 entered events per arm on each day
    check("cells under 30 entered events per arm are absent, never scored", thin["verdict"] == "INDETERMINATE" and thin["V1"]["cells_present"] == 0)

    labels = _rows(40, 25, 0.60, 0.50) + _rows(40, 25, 0.62, 0.50, key="z1.S") + _rows(40, 25, 0.52, 0.50, key="z1.W") \
        + _rows(40, 25, 0.60, 0.50, key="z1.SS") + _rows(40, 25, 0.60, 0.50, key="z1.S0") + _rows(40, 25, 0.52, 0.50, key="floor") \
        + _rows(40, 25, 0.50, 0.50, key="pdhl") + _rows(40, 25, 0.51, 0.50, key="rnd") + _rows(40, 25, 0.56, 0.50, key="v4a") \
        + _rows(40, 25, 0.50, 0.56, key="v4b")
    lab = verdict(labels)
    check("V2 Strong − Weak at +10pp passes", lab["V2a"]["state"] == "PASS")
    check("V2 Super Strong − Strong at 0 is not a pass", lab["V2b"]["state"] != "PASS")
    check("V3 picks the best free version", lab["V3"]["comparator"] == "floor" and lab["V3"]["state"] == "PASS")
    check("V4 (a) at +6pp passes", lab["V4a"]["state"] == "PASS")
    check("V4 (b) at −6pp passes (control − served)", lab["V4b"]["state"] == "PASS" and lab["V4b"]["day"]["point"] > 3.0)
    check("V2-V5 never change V1", lab["verdict"] == "PASS")
    v5 = verdict(_rows(40, 25, 0.60, 0.50) + _rows(40, 25, 0.70, 0.0, key="v5.b1") + _rows(40, 25, 0.80, 0.0, key="v5.b2"))
    check("V5 keeps the 2-close rule when the 1-close break follows through less", v5["V5"]["broken_rule"].startswith("2-close") and v5["V5"]["state"] == "NULL")
    check("the decision map names the arc close on a NULL", any("arc closes" in x for x in decision_map({**null, "verdict": "NULL"})))
    ok = not fails
    for f in fails:
        print(f"self-test FAILED: {f}")
    print(f"SR_BACKTEST_SELFTEST_VERDICT={'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--cardinalities")
    ap.add_argument("--power")
    ap.add_argument("--sims", type=int, default=200)
    ap.add_argument("--enter", type=float, default=0.45)
    ap.add_argument("--base", type=float, default=0.55)
    ap.add_argument("--calibrate")
    ap.add_argument("--min-reps", type=int, default=None)
    ap.add_argument("--out")
    ap.add_argument("--analyze")
    ap.add_argument("--landed-at")
    ap.add_argument("--out-md")
    ap.add_argument("--out-json")
    args = ap.parse_args()
    try:
        if args.self_test:
            return self_test()
        if args.cardinalities:
            return cardinalities(args)
        if args.power:
            return power(args)
        if args.calibrate:
            return calibrate(args)
        if args.analyze:
            if not args.out_md or not args.out_json:
                print("SR_BACKTEST_ANALYZE_VERDICT=REFUSED — --out-md and --out-json are required")
                return 3
            return analyze(args)
    except Exception:  # noqa: BLE001 — a step that raised decided nothing: exit 3 and no PASS / NULL / FAIL token
        traceback.print_exc()
        if args.self_test:
            print("SR_BACKTEST_SELFTEST_VERDICT=FAIL")
            return 1
        print("SR_BACKTEST_CALIBRATION_VERDICT=INDETERMINATE" if args.calibrate
              else "SR_BACKTEST_ANALYZE_VERDICT=REFUSED — the estimator raised; nothing was read into a verdict" if args.analyze
              else "SR_BACKTEST_CARDINALITIES_VERDICT=INDETERMINATE — the step raised" if args.cardinalities
              else "SR_BACKTEST_POWER_VERDICT=INDETERMINATE — the step raised")
        return 3
    ap.print_usage()
    return 3


if __name__ == "__main__":
    sys.exit(main())

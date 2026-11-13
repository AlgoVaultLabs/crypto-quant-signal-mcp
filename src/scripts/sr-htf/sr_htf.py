#!/usr/bin/env python3
"""EDGE-SR-HTF-LEVELS-W1 — the estimator of the higher-timeframe and volume-POC level study.

src/scripts/sr-htf/htf-run.ts turns candles into COUNTS: one row per source, cell, UTC day and coin with the served
and control events that were entered, bounced and broke. This file turns counts into the registered statistics.
The counts reader, the cell statistic (bounce share served − control, present only when each arm holds 30 entered
events), the per-cluster series, the hold-out mean, the pooled rates, the presence count and the identifiability
bound are EDGE-SR-LEVEL-BACKTEST-W1's own (scripts/sr-backtest/sr_backtest.py, imported, never restated).

The interval is cluster-perm-stats.py's `cluster_bootstrap_ols` with one observation per cluster, read at the
registered 97.5% level (two primaries). That function returns only its 95% interval, so `boot975` replays its draws
— the same seed, the same resampling order, the same sum — and refuses unless the replay's point and 95% interval
are the function's own, bit for bit, on every call.

  --self-test                     two-way self-test of the verdict logic        SR_HTF_SELFTEST_VERDICT=PASS|FAIL
  --cardinalities DIR             label-free tables of a skeleton run (markdown on stdout)
  --power DIR                     the design's power on that skeleton, outcomes simulated (JSON on stdout)
  --calibrate CSV --out JSON      the null calibration on seeded driftless walks with volume
                                                                   SR_HTF_CALIBRATION_VERDICT=PASS|FAIL|INDETERMINATE
  --analyze DIR --landed-at ISO --out-md F --out-json F
                                  THE read. Refuses unless DIR is a guarded outcome run and the registration landed
                                  before it.         SR_HTF_VERDICT=PASS|NULL|INDETERMINATE — <cause>
                                                     SR_HTF_ANALYZE_VERDICT=REFUSED — <reason>   (exit 3)

Callers gate on the token, never the exit code. Exit 0 = the step ran and said PASS or NULL; 1 = FAIL;
3 = INDETERMINATE or REFUSED.
"""
from __future__ import annotations

import argparse
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

REPO = Path(__file__).resolve().parents[3]


def _load(name: str, rel: str):
    spec = importlib.util.spec_from_file_location(name, REPO / rel)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


sb = _load("sr_backtest", "scripts/sr-backtest/sr_backtest.py")
cps = sb.cps
pc = sb.pc

WAVE = "EDGE-SR-HTF-LEVELS-W1"
SOURCES = ("htf", "vpoc")
NAMES = {"htf": "H_A", "vpoc": "H_B"}
CELLS = ("1h", "4h")
DESCRIPTIVE_CELL = "1d"
COLS = sb.COLS
SERVED, MATCHED, SN, SHIT, SBREAK, CN, CHIT, CBREAK, FORCED = range(9)
MIN_ARM = 30
MIN_CLUSTERS = 20
BOOT_B = 2000
FLOOR_PP = 3.0
CI_LEVEL = 0.975
# The 97.5% interval's order statistics, as cluster_bootstrap_ols takes its 95% ones: d[int(q * m)].
LO_Q = 0.0125
HI_Q = 0.9875
DAY_MS = 86_400_000
START_MS = 1_609_459_200_000
HOLDOUT_START_MS = 1_735_689_600_000
END_MS = 1_762_905_600_000
CAL_MIN_REPS = 100
CAL_MIN_WALKS = 50
CAL_TOLERANCE_PP = 0.5
CAL_MAX_PASS_SHARE = 0.05
# The calibration's hold-out: the same share of its present days as the registered hold-out is of the window.
HOLDOUT_SHARE = (END_MS - HOLDOUT_START_MS) / (END_MS - START_MS)
STOP_NULL = "S/R level construction closed (stop rule)"
# Test-only: break one rule on purpose, so the self-test can be shown to fail (tests/unit/sr-htf-harness.test.ts).
MUTATE = os.environ.get("SR_HTF_MUTATE", "")

# Every file whose bytes decide the calibration; src/scripts/sr-htf/calibration.json records their sha256.
CALIBRATION_FILES = ("src/scripts/sr-probe/level-v0.ts", "src/scripts/sr-backtest/spec.ts", "src/scripts/sr-backtest/zones.ts",
                     "src/scripts/sr-backtest/engine.ts", "src/scripts/sr-backtest/synth.ts", "src/scripts/sr-htf/config.ts",
                     "src/scripts/sr-htf/registry.ts", "src/scripts/sr-htf/sources.ts", "src/scripts/sr-htf/synthv.ts",
                     "src/scripts/sr-htf/htf-run.ts", "src/scripts/sr-htf/sr_htf.py", "scripts/sr-backtest/sr_backtest.py",
                     "src/scripts/cluster-perm-stats.py")


def delta(key: str):
    """The closed study's cell statistic for one source (sr_backtest.delta), in pp; None when a cell is absent."""
    base = sb.delta(key)

    def stat(m, tf, u):
        x = base(m, tf, u)
        if x is None:
            return None
        return (-x[0], x[1]) if MUTATE == "swap-arms" else x
    return stat


# ─────────────────────────────── the 97.5% interval ───────────────────────────────

def boot975(vals: dict, name: str, b_draws: int = BOOT_B, check: bool = True):
    """Intercept of cluster_bootstrap_ols with one observation per cluster, at the 97.5% level. None when no cluster
    is present. `check` (every read and the calibration) also runs the function itself and raises unless the
    replay's point and 95% interval are its own: the replay can never drift from the registered estimator."""
    ids = sorted(vals)
    if not ids:
        return None
    y = [vals[i] for i in ids]
    seed = cps.arm_seed(WAVE, name)
    g = len(ids)
    # Per-cluster X'y of an intercept-only design, accumulated as cluster_bootstrap_ols accumulates it.
    py = [0.0 + 1.0 * v for v in y]
    rng = random.Random(seed + 1 if MUTATE == "replay-seed" else seed)
    draws = []
    for _ in range(b_draws):
        s = 0.0
        for _g in range(g):
            s += py[rng.randrange(g)]
        draws.append(s / float(g))
    d = sorted(draws)
    m = len(d)
    point = 0.0
    for v in y:
        point += 1.0 * v
    point = point / float(g)
    lo95, hi95 = d[int(0.025 * m)], d[min(int(0.975 * m), m - 1)]
    lo_q, hi_q = (0.025, 0.975) if MUTATE == "ci95" else (LO_Q, HI_Q)
    out = {"point": point, "lo": d[int(lo_q * m)], "hi": d[min(int(hi_q * m), m - 1)], "lo95": lo95, "hi95": hi95,
           "clusters": g, "draws_used": m, "level": CI_LEVEL}
    if check:
        b = cps.cluster_bootstrap_ols([[1.0] for _ in ids], y, ids, b_draws, random.Random(seed))
        if b["draws_used"] != m or b["clusters"] != g or b["beta"][0] != point or list(b["coef"][0]["ci95"]) != [lo95, hi95]:
            raise ValueError(f"the 97.5% replay of {name} is not cluster_bootstrap_ols's draws "
                             f"(point {point} vs {b['beta'][0]}, 95% [{lo95}, {hi95}] vs {b['coef'][0]['ci95']})")
    return out


def _bad(b) -> bool:
    return b is None or any(math.isnan(v) for v in (b["point"], b["lo"], b["hi"]))


# ─────────────────────────────── the verdict ───────────────────────────────

def hyp_state(b_day, b_coin, hold, ident_ok: bool, floor: float = FLOOR_PP):
    """H_A or H_B. Returns (state, cause, what resolves it)."""
    more = "more scored UTC days: a forward window"
    if b_day is None:
        return "INDETERMINATE", f"no cell-day carries both arms at >= {MIN_ARM} entered events", more
    if b_day["clusters"] < MIN_CLUSTERS:
        return "INDETERMINATE", f"{b_day['clusters']} UTC-day clusters, under the floor of {MIN_CLUSTERS}", more
    if not ident_ok:
        return "INDETERMINATE", "NOT_IDENTIFIABLE arm", "a served set that carries both sides"
    if _bad(b_day):
        return "INDETERMINATE", "the bootstrap produced no usable draw", more
    passes_floor = True if MUTATE == "no-floor" else b_day["point"] >= floor
    if passes_floor and b_day["lo"] > 0:
        if _bad(b_coin) or b_coin["clusters"] < MIN_CLUSTERS:
            return "INDETERMINATE", f"fewer than {MIN_CLUSTERS} coin clusters", "a wider panel"
        if not (MUTATE == "no-coin" or b_coin["point"] > 0):
            return "INDETERMINATE", "the coin-cluster point is <= 0", "a wider panel or a forward window"
        if not (MUTATE == "no-holdout" or (hold is not None and hold > 0)):
            return "INDETERMINATE", "hold-out sign flip" if hold is not None else "no hold-out day carries both arms", "a forward window"
        return "PASS", "point >= +3.0pp, 97.5% lower bound > 0 on UTC-day clusters, coin-cluster point > 0, hold-out point > 0", ""
    if b_day["hi"] < 0:
        return "NULL", "a reversal: the UTC-day 97.5% upper bound is under 0", ""
    if b_day["hi"] < floor:
        return "NULL", "the UTC-day 97.5% upper bound is under +3.0pp", ""
    if b_day["lo"] <= 0:
        return "INDETERMINATE", "the 97.5% interval holds +3.0pp with its lower bound <= 0", more
    return "INDETERMINATE", "lower bound > 0 but the point is under +3.0pp and the interval holds +3.0pp", more


def study_verdict(h: dict):
    """SR_HTF_VERDICT from the two hypotheses' states. Returns (verdict, cause, what resolves it)."""
    passed = [k for k in SOURCES if h[k]["state"] == "PASS"]
    if passed:
        return "PASS", " and ".join(f"{NAMES[k]} ({k}) meets its bar" for k in passed), ""
    if all(h[k]["state"] == "NULL" for k in SOURCES):
        cause = ("neither daily/weekly levels (htf) nor daily volume POCs (vpoc) bounce more than matched random zones "
                 "by +3.0pp: both UTC-day 97.5% upper bounds are under +3.0pp")
        rev = [k for k in SOURCES if "reversal" in h[k]["cause"]]
        if rev:
            cause += "; a reversal for " + " and ".join(f"{NAMES[k]} ({k})" for k in rev) + ": its upper bound is under 0"
        return "NULL", cause, ""
    open_ = [k for k in SOURCES if h[k]["state"] != "NULL"]
    cause = "; ".join(f"{NAMES[k]} ({k}): {h[k]['cause']}" for k in open_)
    resolves = "; ".join(f"{NAMES[k]} ({k}): {h[k]['resolves']}" for k in open_ if h[k]["resolves"])
    return "INDETERMINATE", cause, resolves


def stop_rule(verdict: str, h: dict, resolves: str) -> str:
    if verdict == "PASS":
        names = " and ".join(k for k in SOURCES if h[k]["state"] == "PASS")
        return (f"PASS -> goes to Mr.1 (stop rule): reopen the level tool on {names}? Labels, advice and a forward test "
                "are earned again; nothing is built or published before that ruling.")
    if verdict == "NULL":
        return (f"NULL -> {STOP_NULL}: no further level-rule wave; only a new information source (liquidations, "
                "order book) chosen by Mr.1 reopens it.")
    return (f"INDETERMINATE -> no PASS, so S/R level construction is closed by the stop rule; owed: what resolves it "
            f"({resolves or 'the cause named above'}).")


# ─────────────────────────────── the read ───────────────────────────────

def estimate(rows, sides, hold_start_day: int, label: str = "") -> dict:
    """Every registered statistic from one set of counts."""
    md, mc = sb.margin(rows, "day"), sb.margin(rows, "coin")
    days, coins = sb.units_of(rows, "day"), sb.units_of(rows, "coin")
    hold_days = [d for d in days if d >= hold_start_day]
    in_days = [d for d in days if d < hold_start_day]
    hold_set = set(hold_days)

    def run(name: str, stat, tfs):
        vals = sb.series(md, stat, days, tfs)
        return {"day": boot975(vals, f"{label}{name}-day"), "coin": boot975(sb.series(mc, stat, coins, tfs), f"{label}{name}-coin"),
                "holdout": sb.holdout_point(vals, hold_days), "in_sample": sb.holdout_point(vals, in_days),
                "holdout_days": sum(1 for d in hold_days if d in vals), **sb.presence(md, stat, days, tfs)}

    out = {}
    for k in SOURCES:
        r = run(k, delta(k), CELLS)
        ident = sb.identifiable(sides, [k], FLOOR_PP) if sides is not None else {"verdict": pc.IDENTIFIABLE, "reason": "not assessed"}
        state, cause, resolves = hyp_state(r["day"], r["coin"], r["holdout"], ident["verdict"] == pc.IDENTIFIABLE)
        out[NAMES[k]] = {"source": k, **r, "identifiability": ident, "floor_pp": FLOOR_PP, "ci_level": CI_LEVEL,
                         "state": state, "cause": cause, "resolves": resolves}
    by_source = {k: out[NAMES[k]] for k in SOURCES}
    verdict, cause, resolves = study_verdict(by_source)
    out.update(verdict=verdict, cause=cause, resolves=resolves, stop_rule=stop_rule(verdict, by_source, resolves))
    out["per_cell"] = {k: {tf: {**run(f"{k}-{tf}", delta(k), (tf,)), "rates": sb.pooled(md, k, (tf,)),
                                "holdout_rates": sb.pooled(md, k, (tf,), hold_set)} for tf in CELLS} for k in SOURCES}
    out["rates"] = {k: sb.pooled(md, k, CELLS) for k in SOURCES}
    out["holdout_rates"] = {k: sb.pooled(md, k, CELLS, hold_set) for k in SOURCES}
    z1 = run("D-z1-1d", delta("z1"), (DESCRIPTIVE_CELL,))
    out["descriptive_1d"] = {**z1, "arm": "z1", "cell": DESCRIPTIVE_CELL, "rates": sb.pooled(md, "z1", (DESCRIPTIVE_CELL,)),
                             "holdout_rates": sb.pooled(md, "z1", (DESCRIPTIVE_CELL,), hold_set),
                             "note": "descriptive only, not a test: the closed study's z1 in its 1d cell; coin clusters are the read"}
    out["clusters"] = {"utc_days": len(days), "holdout_days": len(hold_days), "coins": len(coins)}
    return out


def coverage(rows, meta: dict) -> dict:
    """Who was evaluated where: per source, the coins and UTC days that carry a served row, and the share of
    controls that found no disjoint candidate."""
    panel = [c["coin"] for c in meta["coins"]]
    per = {}
    for k, tfs in [(s, CELLS) for s in SOURCES] + [("z1", (DESCRIPTIVE_CELL,))]:
        sel = [r for r in rows if r["key"] == k and r["tf"] in tfs]
        have = {r["coin"] for r in sel}
        served, matched, forced = (sum(r["c"][i] for r in sel) for i in (SERVED, MATCHED, FORCED))
        per[k] = {"cells": list(tfs), "coins_with_a_served_zone": len(have), "coins_without": [c for c in panel if c not in have],
                  "utc_days": len({r["day"] for r in sel}), "served": served, "matched": matched, "forced": forced,
                  "forced_pct": (100.0 * forced / matched) if matched else None}
    first = {c["coin"]: datetime.fromtimestamp(c["firstMs"] / 1000, tz=timezone.utc).strftime("%Y-%m-%d") for c in meta["coins"]}
    return {"sources": per, "panel_coins": len(panel), "grid_instants": meta.get("instants"), "first_evaluated_day": first}


def fmt(x, nd=2) -> str:
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return "n/a"
    return f"{x:+.{nd}f}" if isinstance(x, float) else str(x)


def pct(x) -> str:
    return "n/a" if x is None else f"{x:.2f}%"


def _b(b) -> str:
    if b is None:
        return "n/a (no cluster present)"
    return f"{fmt(b['point'])}pp [{fmt(b['lo'])}, {fmt(b['hi'])}] (97.5%) · {b['clusters']} clusters"


def render_md(o: dict) -> str:
    L = [f"# {WAVE} — findings", "",
         f"`SR_HTF_VERDICT={o['verdict']} — {o['cause']}`", "",
         f"**Stop rule:** {o['stop_rule']}", "",
         "PRIVATE. Vault only: no figure here goes to the repository, the product or public copy. Outcomes are hit-first "
         "path labels on candles, never PnL, and this file makes no edge or accuracy claim.", "",
         f"- Registration landed (first seen on origin/main): `{o['registration_landed_at']}` · commit `{o['registration_commit']}`",
         f"- Outcome read started: `{o['outcome_read_at']}`",
         f"- Store: {len(o['manifests'])} per-coin manifests, panel digest `{o['panel_manifest_sha256']}` · counts.csv sha256 `{o['counts_sha256']}`",
         f"- Clusters: {o['clusters']['utc_days']} UTC days ({o['clusters']['holdout_days']} hold-out, from 2025-01-01), {o['clusters']['coins']} coins", ""]
    if o["resolves"]:
        L += [f"What resolves it: {o['resolves']}.", ""]
    L += ["## H_A (htf) and H_B (vpoc) — served zones against matched random zones, cells 1h + 4h", "",
          "| read | H_A htf | H_B vpoc |", "|---|---|---|"]
    a, b = o["H_A"], o["H_B"]
    L += [f"| state | **{a['state']}** — {a['cause']} | **{b['state']}** — {b['cause']} |",
          f"| UTC-day clusters | {_b(a['day'])} | {_b(b['day'])} |",
          f"| coin clusters | {_b(a['coin'])} | {_b(b['coin'])} |",
          f"| in-sample days (mean of daily Δ) | {fmt(a['in_sample'])}pp | {fmt(b['in_sample'])}pp |",
          f"| hold-out days (mean of daily Δ) | {fmt(a['holdout'])}pp ({a['holdout_days']} days present) | {fmt(b['holdout'])}pp ({b['holdout_days']} days present) |",
          f"| cell-days present / absent | {a['cells_present']} / {a['cells_absent']} | {b['cells_present']} / {b['cells_absent']} |",
          f"| identifiability | {a['identifiability']['verdict']} | {b['identifiability']['verdict']} |", "",
          f"A cell-day is present when each arm has at least {MIN_ARM} entered events. Bar for a PASS: point >= +{FLOOR_PP:.1f}pp, "
          "97.5% lower bound > 0 on UTC-day clusters, coin-cluster point > 0, hold-out point > 0.", "",
          "## Per cell", "",
          "| source | cell | Δ · UTC-day clusters | Δ · coin clusters | hold-out | served bounce | control bounce | served break | control break | served entered | control entered | forced controls |",
          "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for k in SOURCES:
        for tf in CELLS:
            c = o["per_cell"][k][tf]
            r = c["rates"]
            L.append(f"| {k} | {tf} | {_b(c['day'])} | {_b(c['coin'])} | {fmt(c['holdout'])}pp ({c['holdout_days']} d) | {pct(r['served_bounce_pct'])} | "
                     f"{pct(r['control_bounce_pct'])} | {pct(r['served_break_pct'])} | {pct(r['control_break_pct'])} | {r['served_entered']} ({pct(r['served_entered_pct'])}) | "
                     f"{r['control_entered']} ({pct(r['control_entered_pct'])}) | {pct(r['forced_pct'])} |")
    L += ["", "## Hold-out (2025-01-01 → 2025-11-12), pooled rates", "",
          "| source | cell | served entered | served bounce | control bounce | served break | control break |", "|---|---|---|---|---|---|---|"]
    for k in SOURCES:
        for tf in CELLS:
            r = o["per_cell"][k][tf]["holdout_rates"]
            L.append(f"| {k} | {tf} | {r['served_entered']} | {pct(r['served_bounce_pct'])} | {pct(r['control_bounce_pct'])} | {pct(r['served_break_pct'])} | {pct(r['control_break_pct'])} |")
        r = o["holdout_rates"][k]
        L.append(f"| {k} | 1h + 4h | {r['served_entered']} | {pct(r['served_bounce_pct'])} | {pct(r['control_bounce_pct'])} | {pct(r['served_break_pct'])} | {pct(r['control_break_pct'])} |")
    d = o["descriptive_1d"]
    r = d["rates"]
    L += ["", "## Descriptive only — the closed study's z1 in its 1d cell (not a test)", "",
          "| read | Δ (served − control) |", "|---|---|",
          f"| coin clusters (the read) | {_b(d['coin'])} |", f"| UTC-day clusters | {_b(d['day'])} |",
          f"| hold-out days | {fmt(d['holdout'])}pp ({d['holdout_days']} days present) |", "",
          f"Pooled: served bounce {pct(r['served_bounce_pct'])} against control {pct(r['control_bounce_pct'])}; {r['served_entered']} served and "
          f"{r['control_entered']} control zones entered; forced controls {pct(r['forced_pct'])}.", "",
          "## Coverage", "", "| source | cells | coins with a served zone | UTC days | served zones | forced controls |", "|---|---|---|---|---|---|"]
    for k, c in o["coverage"]["sources"].items():
        L.append(f"| {k} | {' + '.join(c['cells'])} | {c['coins_with_a_served_zone']} of {o['coverage']['panel_coins']} | {c['utc_days']} | {c['served']} | {pct(c['forced_pct'])} |")
    L += ["", "First evaluated UTC day per coin: " + ", ".join(f"{k} {v}" for k, v in o["coverage"]["first_evaluated_day"].items()) + ".", "",
          "## Store manifests (sha256)", "", "| plan | sha256 |", "|---|---|"] + [f"| `{m['label']}` | `{m['manifestSha256']}` |" for m in o["manifests"]]
    L += ["", "## Pinned files", "", "| file | sha256 |", "|---|---|"] + [f"| `{k}` | `{v}` |" for k, v in sorted(o["harness_sha256"].items())] + [""]
    return "\n".join(L)


def _iso(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def load_run(run_dir: Path, counts_name: str):
    meta = json.loads((run_dir / "run-meta.json").read_text())
    sides = json.loads((run_dir / "sides.json").read_text())
    return meta, sides, run_dir / counts_name


def panel_digest(manifests) -> str:
    """One sha256 over the per-coin manifests: `<label> <sha256>` lines, sorted by label."""
    lines = sorted(f"{m['label']} {m['manifestSha256']}" for m in manifests)
    return hashlib.sha256(("\n".join(lines) + "\n").encode()).hexdigest()


def analyze(args) -> int:
    run_dir = Path(args.analyze)

    def refuse(reason: str) -> int:
        print(f"SR_HTF_ANALYZE_VERDICT=REFUSED — {reason}")
        return 3
    try:
        meta, sides, counts = load_run(run_dir, "counts.csv")
    except (OSError, ValueError) as e:
        return refuse(f"the run directory is unreadable: {e}")
    guard = meta.get("guard") or {}
    if meta.get("wave") != WAVE or meta.get("mode") != "outcomes" or guard.get("ok") is not True:
        return refuse("the run is not a guarded outcome run of this study")
    if sb.sha256_file(counts) != meta.get("files", {}).get("counts.csv"):
        return refuse("counts.csv is not the file the run wrote")
    if not args.landed_at:
        return refuse("--landed-at is required")
    # Whole seconds: the two instants are persisted to the second, and the persisted pair must show the order too.
    landed, read_at = _iso(args.landed_at).replace(microsecond=0), _iso(meta["startedAt"]).replace(microsecond=0)
    if not landed < read_at:
        return refuse(f"the registration landed at {landed.isoformat()} and the outcome read started at {read_at.isoformat()}: not before it")
    if not guard.get("harnessSha256"):
        return refuse("the run's guard pinned no harness file")
    for rel, want in guard["harnessSha256"].items():
        if sb.sha256_file(REPO / rel) != want:
            return refuse(f"{rel} changed since the outcome run")
    rows = sb.read_counts(counts)
    o = estimate(rows, sides, meta["holdoutStartMs"] // DAY_MS)
    manifests = guard.get("manifests") or []
    o.update({"wave": WAVE, "registration_landed_at": landed.strftime("%Y-%m-%dT%H:%M:%SZ"), "outcome_read_at": read_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
              "registration_commit": guard.get("registrationCommit"), "origin_main_at_read": guard.get("originMain"),
              "manifests": manifests, "panel_manifest_sha256": panel_digest(manifests), "harness_sha256": guard.get("harnessSha256"),
              "counts_sha256": meta["files"]["counts.csv"], "events_sha256": meta["files"].get("events.csv"), "run_dir": str(run_dir),
              "coverage": coverage(rows, meta), "instants": meta["instants"],
              "window": {"startMs": meta["startMs"], "endMs": meta["endMs"], "holdoutStartMs": meta["holdoutStartMs"]}})
    as_json, as_md = json.dumps(o, indent=1, sort_keys=True) + "\n", render_md(o)  # both rendered before either is written
    Path(args.out_json).write_text(as_json)
    Path(args.out_md).write_text(as_md)
    print(f"SR_HTF_VERDICT={o['verdict']} — {o['cause']}")
    print(f"stop rule: {o['stop_rule']}")
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
    for r in sb.read_counts(path):
        by_rep[r["rep"]].append(r)
    reps = []
    for rep in sorted(by_rep):
        one = {"rep": rep, "rows_sha256": hashlib.sha256("\n".join(raw[rep]).encode()).hexdigest()}
        for k in SOURCES:
            rows = [r for r in by_rep[rep] if r["key"] == k]
            days = sb.units_of(rows, "day")
            vals = sb.series(sb.margin(rows, "day"), delta(k), days, CELLS)
            present = sorted(vals)
            hold = present[-max(1, round(len(present) * HOLDOUT_SHARE)):] if present else []
            b_day = boot975(vals, f"cal-{rep}-{k}-day")
            b_coin = boot975(sb.series(sb.margin(rows, "coin"), delta(k), sb.units_of(rows, "coin"), CELLS), f"cal-{rep}-{k}-coin")
            state, cause, resolves = hyp_state(b_day, b_coin, sb.holdout_point(vals, hold), True)
            one[k] = {"walks": len(sb.units_of(rows, "coin")), "delta_pp": None if b_day is None else b_day["point"],
                      "lo": None if b_day is None else b_day["lo"], "hi": None if b_day is None else b_day["hi"],
                      "day_clusters": None if b_day is None else b_day["clusters"], "coin_delta_pp": None if b_coin is None else b_coin["point"],
                      "state": state, "cause": cause, "resolves": resolves}
        one["verdict"] = study_verdict(one)[0]
        reps.append(one)
    per = {}
    for k in SOURCES:
        ds = [r[k]["delta_pp"] for r in reps if r[k]["delta_pp"] is not None]
        n = len(ds)
        mean = sum(ds) / n if n else float("nan")
        sd = math.sqrt(sum((d - mean) ** 2 for d in ds) / (n - 1)) if n > 1 else float("nan")
        pass_share = sum(1 for r in reps if r[k]["state"] == "PASS") / len(reps) if reps else float("nan")
        excl = sum(1 for r in reps if r[k]["lo"] is not None and (r[k]["lo"] > 0 or r[k]["hi"] < 0)) / len(reps) if reps else float("nan")
        per[k] = {"mean_delta_pp": mean, "sd_delta_pp": sd, "se_mean_pp": sd / math.sqrt(n) if n > 1 else float("nan"),
                  "within_tolerance": n > 0 and abs(mean) <= CAL_TOLERANCE_PP, "pass_share": pass_share,
                  "interval_excludes_zero_share": excl, "reps_with_a_delta": n}
    study_pass_share = sum(1 for r in reps if r["verdict"] == "PASS") / len(reps) if reps else float("nan")
    min_reps = args.min_reps if args.min_reps is not None else CAL_MIN_REPS
    walks = min((r[k]["walks"] for r in reps for k in SOURCES), default=0)
    if len(reps) < min_reps or any(per[k]["reps_with_a_delta"] < len(reps) for k in SOURCES) or walks < CAL_MIN_WALKS:
        verdict = "INDETERMINATE"
    else:
        ok = all(per[k]["within_tolerance"] and per[k]["pass_share"] <= CAL_MAX_PASS_SHARE for k in SOURCES)
        verdict = "PASS" if ok else "FAIL"
    out = {"wave": WAVE, "verdict": verdict, "replications": len(reps), "walks_per_replication": walks,
           "tolerance_pp": CAL_TOLERANCE_PP, "max_pass_share": CAL_MAX_PASS_SHARE, "ci_level": CI_LEVEL, "holdout_share": HOLDOUT_SHARE,
           "sources": per, "study_pass_share": study_pass_share,
           "harness_sha256": {rel: sb.sha256_file(REPO / rel) for rel in CALIBRATION_FILES}, "reps": reps}
    if args.out:
        Path(args.out).write_text(json.dumps(out, indent=1, sort_keys=True) + "\n")
    print(json.dumps({k: v for k, v in out.items() if k not in ("reps", "harness_sha256")}, sort_keys=True))
    print(f"SR_HTF_CALIBRATION_VERDICT={verdict}")
    return {"PASS": 0, "FAIL": 1}.get(verdict, 3)


# ─────────────────────────────── label-free: cardinalities and power ───────────────────────────────

def cardinalities(args) -> int:
    run_dir = Path(args.cardinalities)
    meta, sides, counts = load_run(run_dir, "skeleton.csv")
    if meta.get("mode") != "skeleton":
        print("SR_HTF_CARDINALITIES_VERDICT=INDETERMINATE — not a skeleton run")
        return 3
    rows = sb.read_counts(counts)
    md = sb.margin(rows, "day")
    days = sb.units_of(rows, "day")
    hold_start = meta["holdoutStartMs"] // DAY_MS
    print(f"coins {len(meta['coins'])} · grid instants {meta['instants']} · UTC days with a served row {len(days)} · hold-out days {sum(1 for d in days if d >= hold_start)}")
    print(f"skeleton.csv sha256 {sb.sha256_file(counts)}\n")
    # Entry is an outcome and is not counted: "days at >= n served" is the presence proxy. 30 entered events per arm
    # need 30 / e served zones at an entry share e (on the null walks e is about 0.10 / 0.20 for htf in 1h / 4h and
    # 0.44 / 0.58 for vpoc), hence the four thresholds.
    print("| arm | cell | served zones | forced controls | forced share | UTC days | days at >= 30 / 75 / 150 / 300 served | hold-out days at >= 75 / 300 | coins |")
    print("|---|---|---|---|---|---|---|---|---|")
    for k, tfs in [(s, CELLS) for s in SOURCES] + [("z1", (DESCRIPTIVE_CELL,))]:
        for tf in tfs:
            cells = [(u, c) for (kk, t, u), c in md.items() if kk == k and t == tf]
            served = sum(c[SERVED] for _, c in cells)
            forced = sum(c[FORCED] for _, c in cells)
            coins = len({r["coin"] for r in rows if r["key"] == k and r["tf"] == tf})
            if not served:
                print(f"| {k} | {tf} | 0 | — | — | 0 | 0 / 0 / 0 / 0 | 0 / 0 | {coins} |")
                continue
            at = lambda n: sum(1 for _, c in cells if c[SERVED] >= n)  # noqa: E731
            hold_at = lambda n: sum(1 for u, c in cells if c[SERVED] >= n and u >= hold_start)  # noqa: E731
            print(f"| {k} | {tf} | {served:,} | {forced:,} | {100.0 * forced / served:.2f}% | {len(cells)} | {at(30)} / {at(75)} / {at(150)} / {at(300)} | "
                  f"{hold_at(75)} / {hold_at(300)} | {coins} |")
    print("\n| arm | supports | resistances | minority share m | 2m (pp) | identifiable at +3.0pp |")
    print("|---|---|---|---|---|---|")
    for k in sorted(sides):
        a, b = sides[k]
        ident = sb.identifiable(sides, [k], FLOOR_PP)
        print(f"| {k} | {a:,} | {b:,} | {min(a, b) / (a + b):.4f} | {ident.get('bound_pp', float('nan')):.2f} | {ident['verdict']} |")
    print("\nSR_HTF_CARDINALITIES_VERDICT=PASS")
    return 0


def power(args) -> int:
    """H_A's and H_B's UTC-day leg on the REAL label-free skeleton with simulated outcomes: every served zone and its
    control is entered with probability `--enter`, the control bounces with probability `--base` and the served zone
    with `--base` + the injected delta. Events are drawn independently, so the spread is a FLOOR: it holds no shared
    market move within a day, which the day-cluster bootstrap of the real read does carry. The interval is boot975's
    replay at `--draws` draws (the cross-check against cluster_bootstrap_ols is skipped here, for time only)."""
    run_dir = Path(args.power)
    meta, _sides, counts = load_run(run_dir, "skeleton.csv")
    all_rows = sb.read_counts(counts)
    hold_start = meta["holdoutStartMs"] // DAY_MS
    rng = random.Random(cps.arm_seed(WAVE, "power"))
    # One entry share for every cell, or one per cell in CELLS order ("0.10,0.20").
    parts = [float(x) for x in str(args.enter).split(",")]
    enter = dict(zip(CELLS, parts if len(parts) == len(CELLS) else [parts[0]] * len(CELLS)))
    out = {"sims": args.sims, "enter": enter, "base": args.base, "bootstrap_draws": args.draws, "by_source": {}}
    for k in SOURCES:
        cells = defaultdict(int)
        for r in all_rows:
            if r["key"] == k and r["tf"] in CELLS:
                cells[(r["tf"], r["day"])] += r["c"][SERVED]
        days = sorted({d for _, d in cells})
        hold = [d for d in days if d >= hold_start]
        res = {"utc_days": len(days), "holdout_days": len(hold), "by_delta": {}}
        for d_pp in (0.0, 3.0, 4.0, 5.0):
            points, verdicts = [], defaultdict(int)
            for _ in range(args.sims):
                m = {}
                for (tf, day), n in cells.items():
                    sn, cn = sb._binom(rng, n, enter[tf]), sb._binom(rng, n, enter[tf])
                    m[(k, tf, day)] = [n, n, sn, sb._binom(rng, sn, args.base + d_pp / 100.0), 0, cn, sb._binom(rng, cn, args.base), 0, 0]
                vals = sb.series(m, delta(k), days, CELLS)
                b = boot975(vals, "power", args.draws, check=False)
                fake_coin = {"point": 1.0, "lo": 1.0, "hi": 1.0, "clusters": MIN_CLUSTERS}
                v, _c, _r = hyp_state(b, fake_coin, sb.holdout_point(vals, hold), True)
                verdicts[v] += 1
                if b is not None:
                    points.append(b["point"])
            n = len(points)
            mean = sum(points) / n if n else float("nan")
            sd = math.sqrt(sum((p - mean) ** 2 for p in points) / (n - 1)) if n > 1 else float("nan")
            res["by_delta"][f"{d_pp:+.1f}"] = {"mean_estimate_pp": mean, "sd_pp": sd,
                                               "share": {s: verdicts.get(s, 0) / args.sims for s in ("PASS", "NULL", "INDETERMINATE")}}
        out["by_source"][k] = res
    print(json.dumps(out, indent=1, sort_keys=True))
    return 0


# ─────────────────────────────── self-test ───────────────────────────────

def _rows(days: int, coins: int, s_rate, c_rate, n=200, key: str = "htf", tfs=CELLS, first_day: int = 20000) -> list:
    """Deterministic counts: every (day, coin, cell) enters n events per arm (n may depend on the coin); the hit
    counts follow the given rates, which may depend on the day and the coin, with a small fixed wobble so the
    bootstrap has a spread."""
    out = []
    for d in range(days):
        for c in range(coins):
            nn = n(c) if callable(n) else n
            for ti, tf in enumerate(tfs):
                wob = (((d * 7 + c * 3 + ti) % 5) - 2) if nn >= 50 else 0
                sr = s_rate(d, c) if callable(s_rate) else s_rate
                cr = c_rate(d, c) if callable(c_rate) else c_rate
                out.append({"rep": 0, "key": key, "tf": tf, "day": first_day + d, "coin": f"C{c:02d}",
                            "c": [nn, nn, nn, int(round(nn * sr)) + wob, nn // 4, nn, int(round(nn * cr)) - wob, nn // 4, 0]})
    return out


def self_test() -> int:
    fails = []

    def check(name: str, cond: bool) -> None:
        if not cond:
            fails.append(name)
    sides = {k: [500, 500] for k in SOURCES + ("z1",)}
    hold = 20000 + 30

    def verdict(rows, sd=sides, hs=hold):
        return estimate(rows, sd, hs, "selftest-")

    def both(a_rows, b_rows):
        return a_rows + b_rows

    null_v = _rows(40, 25, 0.50, 0.50, key="vpoc")
    strong = verdict(both(_rows(40, 25, 0.60, 0.50), _rows(40, 25, 0.60, 0.50, key="vpoc")))
    check("a +10pp effect on both sources, 40 days and 25 coins, passes and names both", strong["verdict"] == "PASS" and "H_A" in strong["cause"] and "H_B" in strong["cause"])
    check("its point is near +10pp", abs(strong["H_A"]["day"]["point"] - 10.0) < 1.0)
    one = verdict(both(_rows(40, 25, 0.60, 0.50), null_v))
    check("one source at +10pp and the other at 0 is PASS and names only the first", one["verdict"] == "PASS" and "H_A" in one["cause"] and "H_B" not in one["cause"] and one["H_B"]["state"] == "NULL")
    null = verdict(both(_rows(40, 25, 0.50, 0.50), null_v))
    check("no effect on tight data is NULL", null["verdict"] == "NULL" and null["H_A"]["state"] == "NULL")
    check("a NULL states the stop rule's consequence", STOP_NULL in null["stop_rule"])
    rev = verdict(both(_rows(40, 25, 0.45, 0.50), null_v))
    check("a reversal is NULL and named", rev["verdict"] == "NULL" and "reversal" in rev["cause"] and "H_A" in rev["cause"])
    small = verdict(both(_rows(40, 25, 0.515, 0.50), null_v))
    check("a tight +1.5pp is NULL, never PASS (the +3.0pp floor)", small["verdict"] == "NULL")
    few = verdict(both(_rows(12, 25, 0.60, 0.50), _rows(12, 25, 0.50, 0.50, key="vpoc")), hs=20000 + 9)
    check("12 day clusters is INDETERMINATE", few["verdict"] == "INDETERMINATE" and "clusters" in few["H_A"]["cause"])
    flip = verdict(both(_rows(40, 25, lambda d, c: 0.62 if d < 30 else 0.47, 0.50), null_v))
    check("a negative hold-out is INDETERMINATE — hold-out sign flip", flip["verdict"] == "INDETERMINATE" and flip["H_A"]["cause"] == "hold-out sign flip")
    wide = verdict(both(_rows(40, 25, lambda d, c: 0.70 if d % 2 else 0.33, 0.50), null_v))
    check("an interval holding +3.0pp with its lower bound <= 0 is INDETERMINATE", wide["verdict"] == "INDETERMINATE" and "lower bound" in wide["H_A"]["cause"])
    fewcoins = verdict(both(_rows(40, 8, 0.60, 0.50), _rows(40, 8, 0.50, 0.50, key="vpoc")))
    check("8 coin clusters is INDETERMINATE", fewcoins["verdict"] == "INDETERMINATE" and "coin" in fewcoins["H_A"]["cause"])
    # Five heavy coins at +20pp carry the pooled day; twenty light coins at −7.5pp pull the coin mean under zero.
    coin_neg = verdict(both(_rows(40, 25, lambda d, c: 0.70 if c < 5 else 0.425, 0.50, n=lambda c: 1000 if c < 5 else 40), null_v))
    check("a day read that passes with a coin-cluster point <= 0 is INDETERMINATE", coin_neg["verdict"] == "INDETERMINATE"
          and coin_neg["H_A"]["cause"] == "the coin-cluster point is <= 0" and coin_neg["H_A"]["day"]["lo"] > 0 and coin_neg["H_A"]["day"]["point"] >= FLOOR_PP)
    lop = verdict(both(_rows(40, 25, 0.60, 0.50), null_v), sd={**sides, "htf": [995, 5]})
    check("an arm whose side mix cannot carry the floor is INDETERMINATE — NOT_IDENTIFIABLE", lop["verdict"] == "INDETERMINATE" and "NOT_IDENTIFIABLE" in lop["H_A"]["cause"])
    thin = verdict(both(_rows(40, 25, 0.60, 0.50, n=1), null_v))  # 25 entered events per arm on each cell-day
    check("cells under 30 entered events per arm are absent, never scored", thin["verdict"] == "INDETERMINATE" and thin["H_A"]["cells_present"] == 0)
    mixed = verdict(both(_rows(40, 25, 0.50, 0.50), _rows(40, 25, 0.60, 0.50, key="vpoc", n=1)))
    check("one NULL and one INDETERMINATE is INDETERMINATE, never NULL", mixed["verdict"] == "INDETERMINATE" and mixed["H_A"]["state"] == "NULL")
    desc = verdict(both(_rows(40, 25, 0.60, 0.50), null_v) + _rows(40, 25, 0.45, 0.50, key="z1", tfs=("1d",)))
    check("the descriptive 1d z1 read never changes the verdict", desc["verdict"] == "PASS" and desc["descriptive_1d"]["coin"]["point"] < 0)

    # The interval: the replay is cluster_bootstrap_ols's own draws, and the 97.5% interval is wider than its 95%.
    for i, vals in enumerate([{u: float((u * 7) % 11) - 5.0 for u in range(37)}, {u: math.sin(u) * 3.0 + 0.1 * u for u in range(120)}]):
        try:
            b = boot975(vals, f"selftest-replay-{i}")
            check(f"the 97.5% interval strictly contains the 95% one ({i})", b["lo"] < b["lo95"] and b["hi"] > b["hi95"])
        except ValueError:
            fails.append(f"the replay is cluster_bootstrap_ols's draws ({i})")
    check("the order statistics are the registered level", abs(LO_Q - (1.0 - CI_LEVEL) / 2.0) < 1e-12 and abs(HI_Q - (1.0 + CI_LEVEL) / 2.0) < 1e-12)
    check("the presence rule, cluster floor and draws are the closed study's", (sb.MIN_ARM, sb.MIN_CLUSTERS, sb.BOOT_B) == (MIN_ARM, MIN_CLUSTERS, BOOT_B))
    ok = not fails
    for f in fails:
        print(f"self-test FAILED: {f}")
    print(f"SR_HTF_SELFTEST_VERDICT={'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--cardinalities")
    ap.add_argument("--power")
    ap.add_argument("--sims", type=int, default=200)
    ap.add_argument("--enter", default="0.45")
    ap.add_argument("--base", type=float, default=0.55)
    ap.add_argument("--draws", type=int, default=400)
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
                print("SR_HTF_ANALYZE_VERDICT=REFUSED — --out-md and --out-json are required")
                return 3
            return analyze(args)
    except Exception:  # noqa: BLE001 — a step that raised decided nothing: exit 3 and no PASS / NULL / FAIL token
        traceback.print_exc()
        if args.self_test:
            print("SR_HTF_SELFTEST_VERDICT=FAIL")
            return 1
        print("SR_HTF_CALIBRATION_VERDICT=INDETERMINATE" if args.calibrate
              else "SR_HTF_ANALYZE_VERDICT=REFUSED — the estimator raised; nothing was read into a verdict" if args.analyze
              else "SR_HTF_CARDINALITIES_VERDICT=INDETERMINATE — the step raised" if args.cardinalities
              else "SR_HTF_POWER_VERDICT=INDETERMINATE — the step raised")
        return 3
    ap.print_usage()
    return 3


if __name__ == "__main__":
    sys.exit(main())

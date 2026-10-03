#!/usr/bin/env python3
"""verdict-rule-gate.py — SIGNAL-VERDICT-RULE-REGISTRY-W1 CH3 R1.

THE FORWARD GATE FOR PER-TIMEFRAME VERDICT-RULE ASSIGNMENTS.

It executes the registered decision rule — `audits/verdict-rule-registry-preregistration-2026-10-02.md`
— verbatim, on forward data only, and RECOMMENDS. It never writes the assignment
(`src/lib/verdict-rule-assignment.ts`): a recommendation goes to Mr.1, and a separate switch
dispatch commits it. `tests/unit/verdict-rule-registry.test.ts` pins this file's query and every
parameter to the registration through `--show-config`, so the two cannot drift apart.

── WHAT IS DECIDED (registration §0, rulings 2026-10-02) ─────────────────────────────────────────
The decision unit is the TIMEFRAME. The candidates are JOINT (TRENDING_UP, TRENDING_DOWN)
assignments in S1 = {(M,M), (F,M), (F,F)}; (M,F) is printed as a ① diagnostic only, and every H is
outside S1 (the registry refuses H). Per closed window each timeframe gets exactly one of
SWITCH_TO(A) · KEEP_INCUMBENT(cause) · INDETERMINATE(cause).

── THE STATISTIC (registration §4) ──────────────────────────────────────────────────────────────
Per UTC day d, over the window's scored rows, for each assignment A evaluated counterfactually
(exact, because the price return does not depend on the side served and both verdicts are captured):
    E_A,d = mean hit_A − (q_A,d·u_d + (1 − q_A,d)·w_d)            (excess over the mix-matched null)
    M_A,d = mean g_A − (2·q_A,d − 1)·mean(100·r)                  (magnitude excess, bps)
    Δ_d(A) = E_A,d − E_I,d ;  ΔM_d(A) = M_A,d − M_I,d              (paired over the incumbent I)
A switch applied to a random subset of rows has expectation ZERO by construction — the null absorbs
the side-mix change. The raw hit-rate difference is NOT the statistic: it is market-coupled.
Inference is `cluster_bootstrap_ols` from `src/scripts/cluster-perm-stats.py` (UTC-day clusters;
2- and 3-day blocks for 8h/12h/1d), B = 10,000; p⁺ is the share of draws ≤ 0. Rule ① is
`attainable_bound_from_share` from `population_comparison.py`. No second implementation of either.

── WINDOWS (registration §3, ruling Q2) ─────────────────────────────────────────────────────────
Consecutive disjoint fixed windows, one look each. W_1 = the first UTC midnight strictly after
T_START; window k = [W_k, W_k + L_tf days); its LOOK is the first SCHEDULED weekly run (cron
`43 12 * * 1`) at or after W_k + L_tf + H_tf + 24 h; W_{k+1} = the first UTC midnight strictly after
that look. The look is taken from the SCHEDULE, never from a realised run, so the window chain is
reproducible from the registration and the cron alone: a late or repeated run evaluates the same
data-defined windows and only delivers late. Weekly runs before a look print INDETERMINATE
(progress only); rows between a window's end and the next window's start belong to no window.

── VERDICT CONTRACT ─────────────────────────────────────────────────────────────────────────────
Exactly one terminal line: `VERDICT_RULE_GATE_VERDICT=PASS|FAIL|INDETERMINATE`, exit 0/0/3 — the
sibling convention (`trend-mode-readout-gate.py`), 3 being the token-law default for a new gate.
  FAIL           ≥ 1 timeframe recommends SWITCH_TO — the page IS the action, so it exits 0;
  PASS           ≥ 1 timeframe was evaluated at a look and none recommends a switch;
  INDETERMINATE  nothing evaluable (every window open, underpowered, WATCH) or unreadable input.
"Measured and clean" never shares an output with "measured nothing".

── PAGING ───────────────────────────────────────────────────────────────────────────────────────
`VERDICT_RULE_SWITCH_RECOMMENDED`, CRITICAL_PERSISTENT, through the wrapper's PAGE-ON-CHANGE
(the alert-registry row opts in): every evaluable run sends ALERT_KEYS = one `<tf>:<UP><DOWN>:w<k>`
per timeframe whose latest decided window recommends a switch, so the operator is paged once per
transition INTO a recommendation; a run with none calls `--clear` (silent). Never pages on KEEP or
INDETERMINATE, and never clears while blind.

── READ PATH ────────────────────────────────────────────────────────────────────────────────────
Host psql, READ-ONLY: `docker exec <pg> psql -U aoe_readonly` with `default_transaction_read_only`
and a `statement_timeout` of ~10x the measured worst window. The emitted arm only
(`signal_scorer_inputs` ⋈ `signals` for the outcome); never a withheld arm's store (the hold and band
captures, or their labels), and never pooled with one. Refuses to read a decided window unless
`signals` has a VALID index on (signal_hash, exchange) — `idx_signals_signal_hash_exchange`,
migrations/047 — and a timed-out statement makes the whole run INDETERMINATE.

Env:
  VRG_PG_CONTAINER  postgres container      (default crypto-quant-signal-mcp-postgres-1)
  VRG_PG_USER/DB    role + database         (default aoe_readonly / signal_performance)
  VRG_WRAPPER       send_telegram.sh path   (default /opt/algovault-monitoring/send_telegram.sh)
  VRG_NOW           ISO-8601 UTC override for the evaluation instant (tests and replays only)

  verdict-rule-gate.py               run
  verdict-rule-gate.py --self-test   hermetic, two-way, mutation-proven
  verdict-rule-gate.py --show-config the registered parameters as JSON (pinned by a repo test)
"""
from __future__ import annotations

import importlib.util
import json
import math
import os
import random
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent

DETECTOR = "verdict-rule-gate"
ALERT_ID = "VERDICT_RULE_SWITCH_RECOMMENDED"
SEVERITY = "CRITICAL_PERSISTENT"
TOKEN = "VERDICT_RULE_GATE_VERDICT"
PASS, FAIL, INDET = "PASS", "FAIL", "INDETERMINATE"
REGISTRATION = "audits/verdict-rule-registry-preregistration-2026-10-02.md"

# ── Registered parameters. Every number below is the registration's; the repo test compares them. ──
# T_START: the StartedAt of the first production container running the registry code (§1), recorded
# by CH2 in status.md: 2026-10-03T06:36:30.499118497Z, floored to the second.
T_START_EPOCH = 1791009390
# The weekly look (§5 cadence, fixed here): Monday 12:43 UTC = cron `43 12 * * 1`.
SCHEDULE_WEEKDAY, SCHEDULE_HOUR, SCHEDULE_MINUTE = 0, 12, 43
CRON = "43 12 * * 1"
FWER_ONE_SIDED = 0.025        # §6 Holm family-wise error, one-sided
VETO_MIN_POSITIVE = 0.05      # §6 magnitude veto: vetoed when fewer than 5% of ΔM draws are > 0
COVERAGE_FLOOR = 0.95         # §5 scored rows / window rows at the look
BOOT_B = 10000                # §4
FLOOR_PP = 3.0                # §4c rule ① floor on 200·min(q, 1−q)
MATURITY_SLACK_S = 86400      # §3 the +24 h backfill slack
DAY_S = 86400
S1 = ("MM", "FM", "FF")       # (TRENDING_UP, TRENDING_DOWN) per §0
DIAGNOSTIC = ("MF",)          # outside S1 (fails ① by census); its bound is printed only
REGIMES = ("TRENDING_UP", "TRENDING_DOWN")

# tf: (window L days, maturity horizon H seconds = EVAL_CANDLES × TF_MS, cluster block days,
#      minimum clusters = ceil(0.8·L/block), WATCH). §5 table, row for row.
TIMEFRAMES = {
    "3m": (21, 36 * 60, 1, 17, False),
    "5m": (21, 3600, 1, 17, False),
    "15m": (14, 3 * 3600, 1, 12, False),
    "30m": (14, 4 * 3600, 1, 12, False),
    "1h": (14, 8 * 3600, 1, 12, False),
    "2h": (14, 12 * 3600, 1, 12, False),
    "4h": (21, 24 * 3600, 1, 17, False),
    "8h": (49, 32 * 3600, 2, 20, False),
    "12h": (56, 48 * 3600, 2, 23, False),
    "1d": (56, 72 * 3600, 3, None, True),
}

# §3 — the per-window read, BYTE-EQUAL to the registration's literal (the repo test compares them).
WINDOW_SQL = """SELECT ssi.scorer_input_id, ssi.regime, ssi.trend_decisive, ssi.verdict_m, ssi.verdict_f,
       ssi.signal AS served_side, ssi.decided_at, o.outcome_return_pct
FROM signal_scorer_inputs ssi
LEFT JOIN LATERAL (
  SELECT s.outcome_return_pct
  FROM signals s
  WHERE s.signal_hash = ssi.signal_hash AND s.exchange = ssi.exchange
    AND s.regime_rule_version = 3
  ORDER BY s.id
  LIMIT 1
) o ON TRUE
WHERE ssi.timeframe = :tf
  AND ssi.decided_at >= :window_start AND ssi.decided_at < :window_end
  AND ssi.exchange <> 'BITMART'
  AND ssi.rule_config_id IS NOT NULL;"""

# §5 capture completeness — rows the read above EXCLUDES because they carry no stamp, plus stamped
# rows whose capture is incomplete. Expected zero; non-zero ⇒ INDETERMINATE — capture.
CAPTURE_SQL = """SELECT count(*) FILTER (WHERE rule_config_id IS NULL),
       count(*) FILTER (WHERE rule_config_id IS NOT NULL
                          AND (trend_decisive IS NULL OR verdict_m IS NULL OR verdict_f IS NULL))
FROM signal_scorer_inputs
WHERE timeframe = :tf
  AND decided_at >= :window_start AND decided_at < :window_end
  AND exchange <> 'BITMART';"""


# The §3 read joins every captured row to `signals` by (signal_hash, exchange). Without an index on
# that pair each lateral lookup scans the exchange's rows — measured 2026-10-03 on prod: 114.9 ms and
# ~46.8k buffer hits per row, 26–71 minutes per decided window of the database the product serves
# from. `idx_signals_signal_hash_exchange` (migrations/047, architect ruling Q1 = A) is the index. An
# instrument must not degrade what it measures, so the gate REFUSES (INDETERMINATE) before reading a
# window unless such an index is VALID and READY: a failed CREATE INDEX CONCURRENTLY leaves an
# INVALID index that pg_indexes still lists and the planner never uses — counting it would wave the
# per-row scan straight through. Partial and expression indexes do not serve the lookup either.
INDEX_PROBE_SQL = """SELECT count(*)
FROM pg_index i
JOIN pg_class t ON t.oid = i.indrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public' AND t.relname = 'signals'
  AND i.indisvalid AND i.indisready AND i.indislive
  AND i.indpred IS NULL AND i.indexprs IS NULL
  AND pg_get_indexdef(i.indexrelid) ~ ' USING btree \\(signal_hash(, exchange)?\\)';"""

# Every statement of the gate's read-only session runs under statement_timeout (ruling Q1 = A,
# condition 3): ~10x the measured worst per-window read, capped at 300 s. A plan regression — the
# index dropped, invalidated or ignored — then ends as a psql error, i.e. INDETERMINATE, instead of a
# long scan of the serving database. Derivation (post-index EXPLAIN, vault endpoint truth §13.4):
# the worst window is 5m — 21 days, 50,248 rows (2026-09-12..10-03) read in 625 ms on prod 2026-10-03:
# a 182 ms scan of signal_scorer_inputs + 50,248 probes of idx_signals_signal_hash_exchange at 0.008 ms
# (every other timeframe projects to 238-482 ms). 10 x 625 ms = 6,250 ms, far inside the cap.
STATEMENT_TIMEOUT_MS = 6_250
STATEMENT_TIMEOUT_CAP_MS = 300_000
PGOPTIONS = f"-c default_transaction_read_only=on -c statement_timeout={STATEMENT_TIMEOUT_MS}"


class Indeterminate(Exception):
    """Anything we were HANDED and could not read. Never an empty world."""


# ─────────────────────────────── libraries (no second implementation) ───────────────────────────

def _find(rel: str) -> Path | None:
    """Search HERE, then every ancestor — never a fixed parent index (the sibling gate's lesson)."""
    if (HERE / Path(rel).name).exists():
        return HERE / Path(rel).name
    for anc in [HERE, *HERE.parents]:
        cand = anc / rel
        if cand.exists():
            return cand
    return None


def load_libs():
    """population_comparison + canary_result_log + detector_envelope (siblings) and
    cluster-perm-stats (a sibling on the host; `src/scripts/` in a checkout). A missing library is
    INDETERMINATE with a reason, never a crash without a token."""
    sys.path.insert(0, str(HERE))
    try:
        import population_comparison as pc  # noqa: E402
        import canary_result_log as crl  # noqa: E402
        import detector_envelope as de  # noqa: E402
    except Exception as exc:  # noqa: BLE001
        raise Indeterminate(f"sibling library unavailable: {exc}") from exc
    path = _find("src/scripts/cluster-perm-stats.py")
    if path is None:
        raise Indeterminate("cluster-perm-stats.py not found beside the gate or under src/scripts")
    spec = importlib.util.spec_from_file_location("cluster_perm_stats", path)
    cps = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(cps)
    except Exception as exc:  # noqa: BLE001
        raise Indeterminate(f"cluster-perm-stats.py failed to load: {exc}") from exc
    return pc, cps, crl, de


# ─────────────────────────────── windows (pure) ────────────────────────────────────────────────

def first_midnight_after(ts: int) -> int:
    """The first UTC midnight STRICTLY after ts (an exact midnight moves to the next one)."""
    return (ts // DAY_S) * DAY_S + DAY_S


def next_scheduled_run(ts: int) -> int:
    """The first scheduled weekly run at or after ts."""
    d = datetime.fromtimestamp(ts, timezone.utc)
    cand = d.replace(hour=SCHEDULE_HOUR, minute=SCHEDULE_MINUTE, second=0, microsecond=0)
    cand += timedelta(days=(SCHEDULE_WEEKDAY - cand.weekday()) % 7)
    if cand < d:
        cand += timedelta(days=7)
    return int(cand.timestamp())


def window_chain(tf: str, t_start: int, now: int) -> list[dict]:
    """Every window of `tf` that has started by `now`, oldest first."""
    L, H, _b, _mc, _watch = TIMEFRAMES[tf]
    out = []
    start = first_midnight_after(t_start)
    k = 1
    while start <= now:
        end = start + L * DAY_S
        look = next_scheduled_run(end + H + MATURITY_SLACK_S)
        out.append({"k": k, "start": start, "end": end, "look": look})
        start = first_midnight_after(look)
        k += 1
    return out


def latest_decided(chain: list[dict], now: int) -> dict | None:
    done = [w for w in chain if w["look"] <= now]
    return done[-1] if done else None


def current_open(chain: list[dict], now: int) -> dict | None:
    live = [w for w in chain if w["look"] > now]
    return live[-1] if live else None


# ─────────────────────────────── the statistic (pure) ──────────────────────────────────────────

def side_under(row: dict, assignment: str) -> str:
    """The side a row would carry under a joint assignment. Variants act ONLY on decisive rows in a
    cell; every other row — non-decisive, RANGING, outside the cells — is M under every variant."""
    if row["decisive"] and row["regime"] in REGIMES:
        v = assignment[REGIMES.index(row["regime"])]
        if v == "F":
            return row["verdict_f"]
    return row["verdict_m"]


def incumbent(rows: list[dict]) -> str:
    """§4: the assignment in force at the window's first row, read per cell from the served side of
    its first decisive row (served = verdict_f ⇒ F, else M). A cell with no decisive row is M — no
    variant can act on it, so its assignment cannot change any row of this window."""
    out = []
    for regime in REGIMES:
        first = next((r for r in sorted(rows, key=lambda x: x["decided_at"])
                      if r["decisive"] and r["regime"] == regime), None)
        out.append("F" if first is not None and first["served"] == first["verdict_f"]
                   and first["verdict_f"] != first["verdict_m"] else "M")
    return "".join(out)


def day_index(row: dict, window_start: int) -> int:
    return (row["decided_at"] - window_start) // DAY_S


def coverage_ok(scored: int, rows: int) -> bool:
    """§5 coverage floor: scored ≥ 95% of the window's rows. An empty window never passes."""
    return rows > 0 and scored / rows >= COVERAGE_FLOOR  # ratio-exempt: numerator and denominator are ONE registered result set (scored rows of the window's rows); registration section 5 floor


def per_day(rows: list[dict], window_start: int, assignment: str) -> dict[int, tuple[float, float]]:
    """{day: (E_A,d, M_A,d)} over the SCORED rows — the registration §4 formulas, literally."""
    by_day: dict[int, list[dict]] = {}
    for r in rows:
        if r["r"] is None:
            continue
        by_day.setdefault(day_index(r, window_start), []).append(r)
    out = {}
    for d, rs in by_day.items():
        n = len(rs)
        sides = [side_under(r, assignment) for r in rs]
        rets = [r["r"] for r in rs]
        u = sum(1 for x in rets if x > 0) / n
        w = sum(1 for x in rets if x < 0) / n
        q = sum(1 for s in sides if s == "BUY") / n
        hit = sum(1 for s, x in zip(sides, rets) if (s == "BUY" and x > 0) or (s == "SELL" and x < 0)) / n
        g = sum((100.0 * x if s == "BUY" else -100.0 * x) for s, x in zip(sides, rets)) / n
        mean_r = sum(100.0 * x for x in rets) / n
        out[d] = (hit - (q * u + (1.0 - q) * w), g - (2.0 * q - 1.0) * mean_r)
    return out


def buy_share(rows: list[dict], assignment: str) -> float | None:
    scored = [r for r in rows if r["r"] is not None]
    if not scored:
        return None
    return sum(1 for r in scored if side_under(r, assignment) == "BUY") / len(scored)


def p_plus(boot: dict) -> float:
    """§4: the share of bootstrap draws ≤ 0, read off `same_sign_frac` and the point estimate's
    sign. NaN when the bootstrap produced no usable draw (never a pass)."""
    same = boot["coef"][0]["same_sign_frac"]
    if same is None or (isinstance(same, float) and math.isnan(same)):
        return float("nan")
    return (1.0 - same) if boot["beta"][0] > 0 else same


def share_positive(boot: dict) -> float:
    """The share of draws > 0 (the magnitude veto reads this)."""
    same = boot["coef"][0]["same_sign_frac"]
    if same is None or (isinstance(same, float) and math.isnan(same)):
        return float("nan")
    return same if boot["beta"][0] > 0 else 1.0 - same


def holm(tests: list[tuple[str, float]], alpha: float) -> set[str]:
    """Holm step-down: ids rejected at FWER alpha (one-sided p-values). A NaN p is never rejected."""
    ranked = sorted(tests, key=lambda t: (math.inf if math.isnan(t[1]) else t[1], t[0]))
    m = len(ranked)
    rejected = set()
    for i, (tid, p) in enumerate(ranked):
        if math.isnan(p) or p > alpha / (m - i):  # ratio-exempt: Holm step level alpha/(m-i), a multiple-testing threshold, not a population rate
            break
        rejected.add(tid)
    return rejected


def admissible(bound: float | None) -> bool:
    """Rule ① (§6 step 2): admissible iff 200·min(q, 1−q) ≥ the registered floor. None is never."""
    return bound is not None and bound >= FLOOR_PP


def cell_m_edge(rows: list[dict], window_start: int, regime: str) -> tuple[float | None, int, int]:
    """§4 per-cell transparency (descriptive; never decided on): the mean over days of
    mean(h_M − base_d) over the cell's decisive scored rows, base_d = u_d on a BUY, w_d on a SELL."""
    by_day: dict[int, list[dict]] = {}
    for r in rows:
        if r["r"] is not None:
            by_day.setdefault(day_index(r, window_start), []).append(r)
    vals, n = [], 0
    for rs in by_day.values():
        k = len(rs)
        u = sum(1 for r in rs if r["r"] > 0) / k
        w = sum(1 for r in rs if r["r"] < 0) / k
        cell = [r for r in rs if r["decisive"] and r["regime"] == regime]
        if not cell:
            continue
        n += len(cell)
        dev = [(1.0 if ((r["verdict_m"] == "BUY" and r["r"] > 0) or (r["verdict_m"] == "SELL" and r["r"] < 0)) else 0.0)
               - (u if r["verdict_m"] == "BUY" else w) for r in cell]
        vals.append(sum(dev) / len(dev))
    return ((sum(vals) / len(vals)) if vals else None), n, len(vals)


def evaluate_window(tf: str, w: dict, rows: list[dict], capture: tuple[int, int], cps, pc) -> dict:
    """One timeframe-window: the §6 gates in order, then every S1 alternative's statistics.
    Holm and the recommendation happen ACROSS the look's family (evaluate_family)."""
    L, _H, block, min_clusters, watch = TIMEFRAMES[tf]
    res = {"tf": tf, "k": w["k"], "start": w["start"], "end": w["end"], "look": w["look"],
           "rows": len(rows), "scored": sum(1 for r in rows if r["r"] is not None),
           "alts": {}, "diag": {}, "cells": {}}
    for regime in REGIMES:
        edge, n, days = cell_m_edge(rows, w["start"], regime)
        res["cells"][regime] = {"m_edge": edge, "n": n, "days": days}
    inc = incumbent(rows) if rows else "MM"
    res["incumbent"] = inc
    clusters = sorted({day_index(r, w["start"]) // block for r in rows if r["r"] is not None})
    res["clusters"] = len(clusters)
    res["min_clusters"] = min_clusters
    for a in DIAGNOSTIC + S1:
        q = buy_share(rows, a)
        bound = None if q is None else pc.attainable_bound_from_share(q)
        (res["diag"] if a in DIAGNOSTIC else res["alts"]).setdefault(a, {})["ident"] = bound
    # §6 step 1 — the gates, in order; the first that fails is the cause.
    null_stamp, incomplete = capture
    if null_stamp or incomplete:
        res["gate"] = ("capture", f"{null_stamp} unstamped, {incomplete} incomplete rows")
    elif not coverage_ok(res["scored"], res["rows"]):
        res["gate"] = ("coverage", f"scored {res['scored']}/{res['rows']} < {COVERAGE_FLOOR:.2f}")
    elif watch:
        res["gate"] = ("WATCH", "report-only timeframe")
    elif res["clusters"] < min_clusters:
        res["gate"] = ("underpowered", f"{res['clusters']}/{min_clusters} clusters")
    else:
        res["gate"] = None
    if res["gate"] is not None and res["gate"][0] != "WATCH":
        return res
    # Statistics for every S1 alternative to the incumbent (WATCH prints them, never decides).
    base = per_day(rows, w["start"], inc)
    days = sorted(base)
    for a in S1:
        if a == inc:
            continue
        alt = per_day(rows, w["start"], a)
        d_e = [alt[d][0] - base[d][0] for d in days]
        d_m = [alt[d][1] - base[d][1] for d in days]
        cl = [d // block for d in days]
        x = [[1.0] for _ in days]
        seed = cps.arm_seed(f"{tf}|window{w['k']}", a)
        be = cps.cluster_bootstrap_ols(x, d_e, cl, BOOT_B, random.Random(seed))
        bm = cps.cluster_bootstrap_ols(x, d_m, cl, BOOT_B, random.Random(seed))
        st = res["alts"][a]
        st.update(delta=be["beta"][0], p=p_plus(be), mag=bm["beta"][0], mag_pos=share_positive(bm),
                  admissible=admissible(st["ident"]),
                  switched=sum(1 for i in range(2) if a[i] != inc[i]))
    return res


def evaluate_family(results: list[dict]) -> None:
    """§6 steps 2–5 across ONE look: ① admissibility, Holm over every admissible (tf × alternative),
    the magnitude veto after Holm, then one recommendation per timeframe. Mutates `results`."""
    tests = []
    for res in results:
        if res.get("gate") is not None:
            continue
        for a, st in res["alts"].items():
            if "p" in st and st["admissible"]:
                tests.append((f"{res['tf']}|{a}", st["p"]))
    rejected = holm(tests, FWER_ONE_SIDED)
    for res in results:
        if res.get("gate") is not None:
            res["rec"], res["cause"] = INDET, res["gate"][0] + (f": {res['gate'][1]}" if res["gate"][1] else "")
            continue
        cands, vetoed, admissible_any = [], [], False
        for a, st in res["alts"].items():
            if "p" not in st:
                continue
            admissible_any = admissible_any or st["admissible"]
            st["holm"] = f"{res['tf']}|{a}" in rejected
            st["veto"] = st["holm"] and not (st["mag_pos"] >= VETO_MIN_POSITIVE)
            if st["holm"] and not st["veto"]:
                cands.append(a)
            elif st["veto"]:
                vetoed.append(a)
        if cands:
            best = sorted(cands, key=lambda a: (-res["alts"][a]["delta"], res["alts"][a]["switched"], a))[0]
            res["rec"], res["cause"] = "SWITCH_TO", best
        elif not admissible_any:
            res["rec"], res["cause"] = "KEEP_INCUMBENT", "rule_1_unattainable"
        elif vetoed:
            res["rec"], res["cause"] = "KEEP_INCUMBENT", "magnitude_veto"
        else:
            res["rec"], res["cause"] = "KEEP_INCUMBENT", "no_admissible_improvement"


def fold(decided: list[dict]) -> str:
    """FAIL on any switch; PASS only when something was genuinely evaluated; else INDETERMINATE."""
    if any(r.get("rec") == "SWITCH_TO" for r in decided):
        return FAIL
    if any(r.get("rec") == "KEEP_INCUMBENT" for r in decided):
        return PASS
    return INDET


def page_keys(decided: list[dict]) -> list[str]:
    return sorted(f"{r['tf']}:{r['cause']}:w{r['k']}" for r in decided if r.get("rec") == "SWITCH_TO")


# ─────────────────────────────── I/O ───────────────────────────────────────────────────────────

def render(sql: str, tf: str, start: int, end: int) -> str:
    """Bind the three registered placeholders. `tf` comes from the fixed TIMEFRAMES table and the
    bounds are integers, so nothing caller-controlled reaches the SQL text."""
    if tf not in TIMEFRAMES or not isinstance(start, int) or not isinstance(end, int):
        raise Indeterminate(f"refusing to bind tf={tf!r} start={start!r} end={end!r}")
    return (sql.replace(":window_start", str(start)).replace(":window_end", str(end))
               .replace(":tf", f"'{tf}'"))


_RUN = subprocess.run  # the process seam; the self-test replaces it to drive the real read path


def psql(sql: str) -> list[list[str]]:
    """One read-only statement. Any non-zero exit — a statement timeout included — is INDETERMINATE,
    never an empty result: a read that did not finish measured nothing."""
    container = os.environ.get("VRG_PG_CONTAINER", "crypto-quant-signal-mcp-postgres-1")
    user = os.environ.get("VRG_PG_USER", "aoe_readonly")
    db = os.environ.get("VRG_PG_DB", "signal_performance")
    cmd = ["docker", "exec", "-e", f"PGOPTIONS={PGOPTIONS}", container,
           "psql", "-U", user, "-d", db, "-tA", "-F", "|", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql]
    try:
        # the process backstop outlives the server-side timeout, so the server cancels first
        p = _RUN(cmd, capture_output=True, text=True, timeout=STATEMENT_TIMEOUT_MS // 1000 + 120)
    except Exception as exc:  # noqa: BLE001
        raise Indeterminate(f"psql invocation failed: {exc}") from exc
    if p.returncode != 0:
        raise Indeterminate(f"psql exit {p.returncode}: {(p.stderr or '').strip()[:200]}")
    return [ln.split("|") for ln in p.stdout.splitlines() if ln.strip()]


def parse_rows(raw: list[list[str]]) -> list[dict]:
    """The §3 read's eight columns. Anything unparseable is INDETERMINATE, never skipped."""
    out = []
    for f in raw:
        if len(f) != 8:
            raise Indeterminate(f"window row has {len(f)} fields, expected 8")
        try:
            out.append({
                "id": int(f[0]), "regime": f[1], "decisive": f[2] == "t", "verdict_m": f[3],
                "verdict_f": f[4], "served": f[5], "decided_at": int(f[6]),
                "r": None if f[7] == "" else float(f[7]),
            })
        except ValueError as exc:
            raise Indeterminate(f"unparseable window row: {exc}") from exc
    return out


def require_hash_index() -> None:
    try:
        n = int(psql(INDEX_PROBE_SQL)[0][0])
    except (IndexError, ValueError) as exc:
        raise Indeterminate(f"index probe unparseable: {exc}") from exc
    if n < 1:
        raise Indeterminate("no VALID index on signals(signal_hash[, exchange]) — refusing a per-row "
                            "sequential scan of the serving database")


def read_window(tf: str, w: dict) -> tuple[list[dict], tuple[int, int]]:
    rows = parse_rows(psql(render(WINDOW_SQL, tf, w["start"], w["end"])))
    cap = psql(render(CAPTURE_SQL, tf, w["start"], w["end"]))
    try:
        capture = (int(cap[0][0]), int(cap[0][1]))
    except (IndexError, ValueError) as exc:
        raise Indeterminate(f"capture-completeness read unparseable: {exc}") from exc
    return rows, capture


def _iso(ts: int) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


def _day(ts: int) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d")


def _num(x, nd=4) -> str:
    return "na" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x:.{nd}f}"


def tf_line(res: dict) -> str:
    alts = " ".join(
        f"alt={a}:ident={_num(st.get('ident'), 2)}/{FLOOR_PP}"
        + (f",delta={_num(st['delta'])},p={_num(st['p'])},holm={'y' if st.get('holm') else 'n'}"
           f",mag={_num(st['mag'], 2)},veto={'y' if st.get('veto') else 'n'}" if "p" in st else "")
        for a, st in sorted(res["alts"].items()))
    diag = " ".join(f"diag={a}:ident={_num(st.get('ident'), 2)}/{FLOOR_PP}" for a, st in res["diag"].items())
    return (f"VERDICT_RULE_GATE tf={res['tf']} window={res['k']} [{_day(res['start'])},{_day(res['end'])})"
            f" look={_iso(res['look'])} state={res['state']} incumbent={res.get('incumbent', 'na')}"
            f" days={res.get('clusters', 0)}/{res.get('min_clusters') or 'WATCH'}"
            f" scored={res.get('scored', 0)}/{res.get('rows', 0)}"
            + (f" elapsed={res['days_elapsed']}d/{TIMEFRAMES[res['tf']][0]}d" if "days_elapsed" in res else "")
            + f" rec={res['rec']} cause={res['cause']}"
            + (f" {alts}" if alts else "") + (f" {diag}" if diag else ""))


def cell_lines(res: dict) -> list[str]:
    out = []
    for regime in REGIMES:
        c = res.get("cells", {}).get(regime, {"m_edge": None, "n": 0, "days": 0})
        tag = "UP" if regime == "TRENDING_UP" else "DOWN"
        out.append(f"VERDICT_RULE_GATE cell={res['tf']}·{tag} window={res['k']} state={res['state']}"
                   f" days={c['days']}/{res.get('min_clusters') or 'WATCH'} m_edge={_num(c['m_edge'])}"
                   f" n={c['n']} rec={res['rec']} cause={res['cause']}")
    return out


def cell_record(res: dict, regime: str) -> dict:
    c = res.get("cells", {}).get(regime, {"m_edge": None, "n": 0, "days": 0})
    alts = {a: {k: (None if isinstance(v, float) and math.isnan(v) else (round(v, 6) if isinstance(v, float) else v))
                for k, v in st.items()} for a, st in res.get("alts", {}).items()}
    return {"cell": f"{res['tf']}|{regime}", "tf": res["tf"], "window": res["k"], "state": res["state"],
            "window_start": _day(res["start"]), "window_end": _day(res["end"]), "look": _iso(res["look"]),
            "incumbent": res.get("incumbent"), "clusters": res.get("clusters", 0),
            "min_clusters": res.get("min_clusters"), "rows": res.get("rows", 0), "scored": res.get("scored", 0),
            "m_edge": None if c["m_edge"] is None else round(c["m_edge"], 6), "n_decisive": c["n"],
            "rec": res["rec"], "cause": res["cause"], "alts": alts}


def build_envelope(verdict: str, ev: dict, now: int, started: int, run_id: str) -> dict:
    return {
        "schema_version": 1, "detector": DETECTOR, "verdict": verdict, "run_id": run_id,
        "run_started_at": datetime.fromtimestamp(started, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "run_outcome": "complete",
        "produced_at": datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "observation_window": {"from": _iso(first_midnight_after(T_START_EPOCH)), "to": _iso(now)},
        "evidence": ev,
    }


def page_body(decided: list[dict]) -> str:
    lines = [f"🔁 {ALERT_ID}", ""]
    for r in decided:
        if r.get("rec") == "SWITCH_TO":
            st = r["alts"][r["cause"]]
            lines.append(f"{r['tf']}: switch {r['incumbent']} -> {r['cause']} (window {r['k']}, "
                         f"{_day(r['start'])}..{_day(r['end'])}; Δ {st['delta']:+.4f}, p {st['p']:.4f}, "
                         f"Holm-rejected, magnitude {st['mag']:+.2f} bps)")
    lines += ["", "A RECOMMENDATION — this job never switches a cell.",
              "Action: Mr.1 approves or declines; a separate switch dispatch edits",
              "src/lib/verdict-rule-assignment.ts and deploys. Decision rule:",
              REGISTRATION]
    return "\n".join(lines)


def _send(wrapper: str, args: list[str], body: str | None, keys: list[str] | None) -> None:
    if not Path(wrapper).exists():
        print(f"[{DETECTOR}] WARNING: wrapper absent at {wrapper}; nothing sent")
        return
    env = dict(os.environ)
    if keys:
        env["ALERT_KEYS"] = " ".join(keys)
    try:
        subprocess.run([wrapper, *args], input=body, text=True, env=env, timeout=60,
                       capture_output=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[{DETECTOR}] WARNING: wrapper call failed: {exc}")


def evaluate_all(now: int, reader, pc, cps, index_guard=None) -> tuple[list[dict], list[dict]]:
    """(decided, progress): every timeframe's latest DECIDED window, evaluated with its whole look
    family, and its current OPEN window as progress. `reader(tf, window)` returns (rows, capture)."""
    chains = {tf: window_chain(tf, T_START_EPOCH, now) for tf in TIMEFRAMES}
    latest = {tf: latest_decided(c, now) for tf, c in chains.items()}
    looks = sorted({w["look"] for w in latest.values() if w is not None})
    decided = []
    if looks and index_guard is not None:
        index_guard()
    for look in looks:
        family = []
        for tf, chain in chains.items():
            for w in chain:
                if w["look"] == look:
                    rows, capture = reader(tf, w)
                    res = evaluate_window(tf, w, rows, capture, cps, pc)
                    res["state"] = "DECIDED"
                    family.append(res)
        evaluate_family(family)
        decided += [r for r in family if latest[r["tf"]] is not None and latest[r["tf"]]["look"] == look
                    and latest[r["tf"]]["k"] == r["k"]]
    progress = []
    for tf, chain in chains.items():
        w = current_open(chain, now)
        if w is None:
            if not chain:
                start = first_midnight_after(T_START_EPOCH)
                progress.append({"tf": tf, "k": 1, "start": start, "end": start + TIMEFRAMES[tf][0] * DAY_S,
                                 "look": next_scheduled_run(start + TIMEFRAMES[tf][0] * DAY_S + TIMEFRAMES[tf][1]
                                                            + MATURITY_SLACK_S),
                                 "state": "BURN_IN", "rec": INDET, "cause": "window_not_started",
                                 "alts": {}, "diag": {}, "cells": {}, "min_clusters": TIMEFRAMES[tf][3]})
            continue
        state = "OPEN" if now < w["end"] else "MATURING"
        progress.append({"tf": tf, "k": w["k"], "start": w["start"], "end": w["end"], "look": w["look"],
                         "state": state, "rec": INDET,
                         "cause": "window_open" if state == "OPEN" else "window_maturing",
                         "alts": {}, "diag": {}, "cells": {}, "min_clusters": TIMEFRAMES[tf][3],
                         "days_elapsed": max(0, min(now, w["end"]) - w["start"]) // DAY_S})
    return decided, progress


def evaluate_run(now: int, reader, pc, cps, index_guard=None) -> tuple[str, list[dict], list[dict], str | None]:
    """(verdict, decided, progress, why). ANY input the run could not read — a refused index, a timed-out
    statement, an unparseable row — makes the WHOLE run INDETERMINATE: one timeframe that could not be
    read must never let the others fold to PASS."""
    try:
        decided, progress = evaluate_all(now, reader, pc, cps, index_guard=index_guard)
    except Indeterminate as exc:
        return INDET, [], [], str(exc)
    return fold(decided), decided, progress, None


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return _self_test()
    if "--show-config" in argv:
        print(json.dumps(show_config(), indent=1, sort_keys=True))
        return 0
    started = int(datetime.now(timezone.utc).timestamp())
    now = started
    if os.environ.get("VRG_NOW"):
        try:
            now = int(datetime.strptime(os.environ["VRG_NOW"].replace("Z", "+0000"),
                                        "%Y-%m-%dT%H:%M:%S%z").timestamp())
        except ValueError:
            print(f"[{DETECTOR}] VRG_NOW unparseable")
            print(f"{TOKEN}={INDET}")
            return 3
    run_id = f"{DETECTOR}-{datetime.fromtimestamp(started, timezone.utc):%Y%m%dT%H%M%SZ}"
    try:
        pc, cps, crl, de = load_libs()
    except Indeterminate as exc:
        print(f"[{DETECTOR}] could not evaluate: {exc}")
        print(f"{TOKEN}={INDET}")
        return 3
    verdict, decided, progress, why = evaluate_run(now, read_window, pc, cps, index_guard=require_hash_index)
    if why is not None:
        print(f"[{DETECTOR}] could not evaluate: {why}")
        print(f"{TOKEN}={INDET}")
        return 3

    # POSITIVE output for every timeframe and every cell, decided or not — a row silently skipped by
    # a load error must never look like a row that passed.
    shown = []
    for tf in TIMEFRAMES:
        for r in [x for x in decided if x["tf"] == tf] + [x for x in progress if x["tf"] == tf]:
            print(tf_line(r))
        primary = next((x for x in decided if x["tf"] == tf), None) or next(x for x in progress if x["tf"] == tf)
        for ln in cell_lines(primary):
            print(ln)
        shown.append(primary)

    keys = page_keys(decided)
    ev = {"timeframes_decided": len(decided), "timeframes_open": len(progress),
          "switch_recommendations": len(keys), "t_start_epoch": T_START_EPOCH}
    env = build_envelope(verdict, ev, now, started, run_id)
    errs = de.validate(env, de.load_schema())
    if errs:
        print(f"[{DETECTOR}] envelope non-conforming: {'; '.join(errs[:3])}")
        print(f"{TOKEN}={INDET}")
        return 3
    print(f"[{DETECTOR}] envelope={json.dumps(env, sort_keys=True)}")

    exit_code = 3 if verdict == INDET else 0
    written = 0
    for res in shown:
        for regime in REGIMES:
            ok, detail = crl.append_result(DETECTOR, verdict, exit_code, cell_record(res, regime))
            written += 1 if ok else 0
            if not ok:
                print(f"CANARY_RESULT_LOG_FAILED={detail}")
    print(f"CANARY_RESULT_LOG={crl.RESULTS_PATH} records={written}/{2 * len(shown)}")

    wrapper = os.environ.get("VRG_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")
    if verdict == FAIL:
        _send(wrapper, [ALERT_ID, SEVERITY, "-"], page_body(decided), keys)
    elif verdict == PASS:
        # Clear only when something was genuinely evaluated and nothing recommends a switch — a run
        # that measured nothing clears nothing.
        _send(wrapper, ["--clear", ALERT_ID, "no timeframe recommends a switch"], None, None)
    print(f"{TOKEN}={verdict}")
    return exit_code


def show_config() -> dict:
    return {
        "registration": REGISTRATION, "t_start_epoch": T_START_EPOCH, "cron": CRON,
        "schedule": {"weekday": SCHEDULE_WEEKDAY, "hour": SCHEDULE_HOUR, "minute": SCHEDULE_MINUTE},
        "fwer_one_sided": FWER_ONE_SIDED, "veto_min_positive": VETO_MIN_POSITIVE,
        "coverage_floor": COVERAGE_FLOOR, "bootstrap_b": BOOT_B, "floor_pp": FLOOR_PP,
        "maturity_slack_s": MATURITY_SLACK_S, "s1": list(S1), "diagnostic": list(DIAGNOSTIC),
        "timeframes": {tf: {"window_days": v[0], "horizon_s": v[1], "block_days": v[2],
                            "min_clusters": v[3], "watch": v[4]} for tf, v in TIMEFRAMES.items()},
        "window_sql": WINDOW_SQL, "alert_id": ALERT_ID, "severity": SEVERITY, "token": TOKEN,
        # not registered parameters — the read path's own bounds (ruling Q1 = A), pinned by the same test
        "read_path": {"statement_timeout_ms": STATEMENT_TIMEOUT_MS, "pgoptions": PGOPTIONS,
                      "index_probe_sql": INDEX_PROBE_SQL},
    }


# ─────────────────────────────── self-test ─────────────────────────────────────────────────────
# Hermetic and two-way. The DB seam (`reader`) is replaced by synthetic windows, so the self-test
# ALSO asserts the artifacts that seam bypasses — the SQL text, the binder, the row parser, the
# record and the envelope — because those are the only code no scenario would otherwise run.

def _synthetic_rows(start: int, days: int, per_day: int, fade_edge: float, seed: int,
                    decisive_share: float = 0.6, buy_bias: float = 0.5) -> list[dict]:
    """Rows where a decisive DOWN call (served SELL) is WRONG with probability 0.5 + fade_edge, so a
    fade of the DOWN cell gains `fade_edge`-ish per decisive row; UP decisive rows are coin flips."""
    rng = random.Random(seed)
    out, i = [], 0
    for d in range(days):
        for _ in range(per_day):
            i += 1
            regime = rng.choice(REGIMES + ("RANGING",))
            decisive = regime in REGIMES and rng.random() < decisive_share
            if regime == "TRENDING_DOWN":
                m = "SELL"
            elif regime == "TRENDING_UP":
                m = "BUY"
            else:
                m = "BUY" if rng.random() < buy_bias else "SELL"
            f = ("SELL" if m == "BUY" else "BUY") if decisive else m
            if decisive and regime == "TRENDING_DOWN":
                wrong = rng.random() < 0.5 + fade_edge
                r = (abs(rng.gauss(0.4, 0.2)) if wrong else -abs(rng.gauss(0.4, 0.2)))
            else:
                r = rng.gauss(0.0, 0.5)
            out.append({"id": i, "regime": regime, "decisive": decisive, "verdict_m": m, "verdict_f": f,
                        "served": m, "decided_at": start + d * DAY_S + 60, "r": r})
    return out


def _self_test() -> int:
    global _RUN  # section 11 drives the real read path through the process seam
    failures: list[str] = []

    def check(label, cond):
        try:
            ok = bool(cond() if callable(cond) else cond)
        except Exception as exc:  # noqa: BLE001 — an assertion that RAISES is not an assertion
            ok, label = False, f"{label} (raised {type(exc).__name__}: {exc})"
        print(f"  {'ok  ' if ok else 'FAIL'} {label}")
        if not ok:
            failures.append(label)

    try:
        pc, cps, crl, de = load_libs()
    except Indeterminate as exc:
        print(f"  FAIL libraries load ({exc})")
        print("SELF-TEST: FAIL (1)")
        print(f"{TOKEN}={INDET}")
        return 3

    # 1. windows — the registered chain, from T_START and the schedule alone
    w1 = first_midnight_after(T_START_EPOCH)
    check("W_1 is 2026-10-04T00:00Z (first midnight strictly after T_START)",
          _iso(w1) == "2026-10-04T00:00Z")
    check("an exact midnight moves to the NEXT midnight", first_midnight_after(w1) == w1 + DAY_S)
    check("next_scheduled_run lands on a Monday 12:43Z",
          datetime.fromtimestamp(next_scheduled_run(w1), timezone.utc).strftime("%a %H:%M") == "Mon 12:43")
    check("a run exactly at the slot is its own look", next_scheduled_run(next_scheduled_run(w1)) == next_scheduled_run(w1))
    expected_first_looks = {"15m": "2026-10-19", "30m": "2026-10-19", "1h": "2026-10-19", "2h": "2026-10-19",
                            "3m": "2026-10-26", "5m": "2026-10-26", "4h": "2026-11-02", "8h": "2026-11-30",
                            "12h": "2026-12-07", "1d": "2026-12-07"}
    far = w1 + 400 * DAY_S
    for tf, day in expected_first_looks.items():
        check(f"first look of {tf} is {day}", lambda tf=tf, day=day: _day(window_chain(tf, T_START_EPOCH, far)[0]["look"]) == day)
    chain = window_chain("15m", T_START_EPOCH, far)
    check("windows are disjoint and the next starts at the first midnight after the look",
          all(b["start"] == first_midnight_after(a["look"]) and b["start"] > a["end"] for a, b in zip(chain, chain[1:])))
    check("before W_1 there is no window (burn-in)", window_chain("15m", T_START_EPOCH, w1 - 1) == [])
    check("no window is decided before its look",
          latest_decided(chain, chain[0]["look"] - 1) is None and latest_decided(chain, chain[0]["look"]) == chain[0])

    # 2. the variants act only on decisive rows in a cell
    row = {"decisive": True, "regime": "TRENDING_DOWN", "verdict_m": "SELL", "verdict_f": "BUY"}
    check("F on the DOWN cell flips a decisive DOWN row", side_under(row, "FF") == "BUY" and side_under(row, "FM") == "SELL")
    check("a non-decisive row is M under every variant",
          all(side_under({**row, "decisive": False}, a) == "SELL" for a in S1 + DIAGNOSTIC))
    check("a RANGING row is M under every variant",
          all(side_under({**row, "regime": "RANGING"}, a) == "SELL" for a in S1 + DIAGNOSTIC))
    check("the incumbent is read from the served side", incumbent([
        {**row, "served": "BUY", "decided_at": 1}, {"decisive": True, "regime": "TRENDING_UP", "verdict_m": "BUY",
                                                    "verdict_f": "SELL", "served": "BUY", "decided_at": 2}]) == "MF")

    # 3. the null: a switch on rows with NO effect has ~zero paired improvement and is not rejected
    w = {"k": 1, "start": w1, "end": w1 + 14 * DAY_S, "look": next_scheduled_run(w1 + 14 * DAY_S + 3 * 3600 + DAY_S)}
    null_rows = _synthetic_rows(w1, 14, 300, 0.0, seed=7)
    res_null = evaluate_window("15m", w, null_rows, (0, 0), cps, pc)
    evaluate_family([res_null])
    check("NULL window ⇒ KEEP_INCUMBENT (no admissible improvement)",
          lambda: res_null["rec"] == "KEEP_INCUMBENT" and res_null["cause"] == "no_admissible_improvement")
    check("NULL window: every alternative's p⁺ is above the Holm threshold",
          lambda: all(st["p"] > FWER_ONE_SIDED / 2 for st in res_null["alts"].values() if "p" in st)
          and sum(1 for st in res_null["alts"].values() if "p" in st) == 2)

    # 4. MUST-FIRE: decisive DOWN SELLs reliably wrong ⇒ fading DOWN improves ⇒ SWITCH_TO a fade
    strong = _synthetic_rows(w1, 14, 300, 0.25, seed=11)
    res_s = evaluate_window("15m", w, strong, (0, 0), cps, pc)
    evaluate_family([res_s])
    check("a strong fade effect ⇒ SWITCH_TO an admissible fade", lambda: res_s["rec"] == "SWITCH_TO" and res_s["cause"] == "FF")
    check("…with Δ̄ > 0 and the magnitude not vetoed",
          lambda: res_s["alts"]["FF"]["delta"] > 0 and not res_s["alts"]["FF"]["veto"])
    # (F,M) need not be null here: flipping coin-flip UP calls in an up-skewed day RAISES their excess
    # over the mix-matched null (a SELL that hits 50% when the day's down-rate is lower) — that is
    # the registered statistic, not a defect. What must hold is that the largest Δ̄ wins.
    check("the recommendation is the rejected alternative with the largest Δ̄",
          lambda: res_s["alts"]["FF"]["delta"] > res_s["alts"]["FM"]["delta"])
    check("(M,F) is diagnostic only — never a candidate", lambda: "MF" not in res_s["alts"] and "MF" in res_s["diag"])

    # 4b. THE NULL ABSORBS THE MIX CHANGE: fading REPRESENTATIVE rows in a down-skewed day must not
    #     look like an improvement. Without the q·u + (1−q)·w term a fade of BUYs into a falling
    #     market "wins" with zero selection quality — the market-coupled comparator the Data
    #     Integrity LAW forbids.
    rng = random.Random(5)
    skew = []
    for d in range(14):
        for j in range(300):
            regime = ("TRENDING_UP", "RANGING")[j % 2]
            r_ = -abs(rng.gauss(0.3, 0.2)) if rng.random() < 0.7 else abs(rng.gauss(0.3, 0.2))
            dec = regime == "TRENDING_UP" and rng.random() < 0.6
            skew.append({"id": d * 1000 + j, "regime": regime, "decisive": dec, "verdict_m": "BUY",
                         "verdict_f": "SELL" if dec else "BUY", "served": "BUY",
                         "decided_at": w1 + d * DAY_S + 60, "r": r_})  # every row shares the day's skew
    for r_ in skew:
        if r_["regime"] == "RANGING":
            r_["verdict_m"] = r_["verdict_f"] = r_["served"] = "SELL" if r_["id"] % 2 else "BUY"
    res_k = evaluate_window("15m", w, skew, (0, 0), cps, pc)
    evaluate_family([res_k])
    check("fading representative rows in a skewed day is NOT a switch (the null absorbs the mix change)",
          lambda: res_k["rec"] == "KEEP_INCUMBENT")

    # 5. rule ①: a timeframe whose assignment leaves it one-sided is INADMISSIBLE whatever Δ says
    # every call BUY and none decisive: q = 1 under every assignment, so 200·min(q, 1−q) = 0 < 3.0
    one_sided = [dict(r, verdict_m="BUY", verdict_f="BUY", decisive=False) for r in strong]
    res_1 = evaluate_window("15m", w, one_sided, (0, 0), cps, pc)
    evaluate_family([res_1])
    check("① unattainable ⇒ KEEP_INCUMBENT with cause rule_1_unattainable",
          lambda: res_1["rec"] == "KEEP_INCUMBENT" and res_1["cause"] == "rule_1_unattainable")

    check("① boundary: exactly 3.0 pp is admissible, just below is not, None never",
          admissible(3.0) and not admissible(2.9999) and not admissible(None))
    check("① uses population_comparison's bound: q = 0.015 gives exactly 3.0 pp",
          lambda: abs(pc.attainable_bound_from_share(0.015) - 3.0) < 1e-9)
    check("coverage boundary: 95/100 passes, 94/100 does not, 0/0 never",
          coverage_ok(95, 100) and not coverage_ok(94, 100) and not coverage_ok(0, 0))

    # 6. the magnitude veto applies AFTER Holm
    res_v = json.loads(json.dumps(res_s))
    res_v["alts"]["FF"]["mag_pos"] = 0.01
    res_v["alts"]["FM"]["p"] = 0.9
    evaluate_family([res_v])
    check("a vetoed winner ⇒ KEEP_INCUMBENT with cause magnitude_veto",
          lambda: res_v["rec"] == "KEEP_INCUMBENT" and res_v["cause"] == "magnitude_veto")

    # 7. Holm — known answers
    check("Holm rejects all three when each clears its step (α/3, α/2, α)",
          holm([("a", 0.001), ("b", 0.012), ("c", 0.02)], 0.025) == {"a", "b", "c"})
    check("Holm stops at the first non-rejection — c is NOT rejected though 0.02 ≤ α",
          holm([("a", 0.001), ("b", 0.013), ("c", 0.02)], 0.025) == {"a"})
    check("Holm ranks by p, not by input order", holm([("a", 0.03), ("b", 0.001)], 0.025) == {"b"})
    check("Holm never rejects a NaN p", holm([("a", float("nan"))], 0.025) == set())

    # 8. the gates, in order — INDETERMINATE, never PASS
    g = evaluate_window("15m", w, null_rows, (5, 0), cps, pc)
    evaluate_family([g])
    check("unstamped rows ⇒ INDETERMINATE — capture", g["rec"] == INDET and g["cause"].startswith("capture"))
    thin = [dict(r, r=None) if i % 5 == 0 else r for i, r in enumerate(null_rows)]
    g = evaluate_window("15m", w, thin, (0, 0), cps, pc)
    evaluate_family([g])
    check("coverage below 95% ⇒ INDETERMINATE — coverage", g["rec"] == INDET and g["cause"].startswith("coverage"))
    few = [r for r in null_rows if day_index(r, w1) < 5]
    g = evaluate_window("15m", w, few, (0, 0), cps, pc)
    evaluate_family([g])
    check("fewer clusters than the floor ⇒ INDETERMINATE — underpowered",
          g["rec"] == INDET and g["cause"].startswith("underpowered"))
    wd = {"k": 1, "start": w1, "end": w1 + 56 * DAY_S, "look": w1 + 70 * DAY_S}
    g = evaluate_window("1d", wd, _synthetic_rows(w1, 56, 5, 0.25, seed=3), (0, 0), cps, pc)
    evaluate_family([g])
    check("1d is WATCH ⇒ INDETERMINATE — WATCH, never a switch", g["rec"] == INDET and g["cause"].startswith("WATCH"))
    g = evaluate_window("15m", w, [], (0, 0), cps, pc)
    evaluate_family([g])
    check("an EMPTY window ⇒ INDETERMINATE (coverage), never PASS", g["rec"] == INDET)

    # 9. the fold and the token→exit mapping
    check("fold: any switch ⇒ FAIL", fold([res_s, res_null]) == FAIL)
    check("fold: evaluated, no switch ⇒ PASS", fold([res_null]) == PASS)
    check("fold: nothing evaluated ⇒ INDETERMINATE", fold([]) == INDET and fold([g]) == INDET)
    check("page keys name the timeframe, the assignment and the window", page_keys([res_s]) == ["15m:FF:w1"])
    check("page keys never include KEEP or INDETERMINATE", page_keys([res_null, g]) == [])

    # 10. THE BYPASSED ARTIFACTS — the SQL, the binder, the parser, the record, the envelope
    check("the window read joins the outcome from signals with regime_rule_version = 3",
          "regime_rule_version = 3" in WINDOW_SQL and "LEFT JOIN LATERAL" in WINDOW_SQL)
    check("the window read excludes BITMART and unstamped rows",
          "exchange <> 'BITMART'" in WINDOW_SQL and "rule_config_id IS NOT NULL" in WINDOW_SQL)
    check("the window read never touches a withheld arm",
          not any(t in WINDOW_SQL + CAPTURE_SQL for t in ("hold_decision", "band_signals")))
    bound = render(WINDOW_SQL, "15m", 100, 200)
    check("the binder fills all three placeholders",
          "ssi.timeframe = '15m'" in bound and ">= 100" in bound and "< 200" in bound and ":tf" not in bound)
    check("the binder refuses an unregistered timeframe", _raises(lambda: render(WINDOW_SQL, "7m", 1, 2)))
    parsed = parse_rows([["1", "TRENDING_UP", "t", "BUY", "SELL", "BUY", "1791100000", "-0.25"],
                         ["2", "RANGING", "f", "SELL", "SELL", "SELL", "1791100060", ""]])
    check("the parser maps the eight columns", lambda: parsed[0]["decisive"] is True and parsed[0]["r"] == -0.25
          and parsed[1]["r"] is None and parsed[1]["decisive"] is False)
    check("a short row is INDETERMINATE, never skipped", _raises(lambda: parse_rows([["1", "x"]])))
    rec = cell_record({**res_s, "state": "DECIDED"}, "TRENDING_DOWN")
    line = crl.build_record(DETECTOR, FAIL, 0, rec)
    check(f"one cell record fits the result log's line cap ({len(line)} B ≤ {crl.MAX_LINE_BYTES})",
          len(line.encode()) <= crl.MAX_LINE_BYTES)
    env = build_envelope(PASS, {"timeframes_decided": 1}, w1, w1, "rid")
    check("the envelope we BUILD validates", not de.validate(env, de.load_schema()))
    check("a broken envelope is REFUSED", bool(de.validate({"schema_version": 1}, de.load_schema())))
    check("--show-config carries the registered SQL verbatim", show_config()["window_sql"] == WINDOW_SQL)
    check("the index probe targets signals(signal_hash[, exchange])",
          "t.relname = 'signals'" in INDEX_PROBE_SQL and "(signal_hash(, exchange)?" in INDEX_PROBE_SQL)
    check("the index probe counts only a VALID, READY, LIVE index (pg_indexes alone lists an INVALID one)",
          all(c in INDEX_PROBE_SQL for c in ("i.indisvalid", "i.indisready", "i.indislive"))
          and "pg_indexes" not in INDEX_PROBE_SQL)
    check("the index probe refuses partial and expression indexes (neither serves the lookup)",
          "i.indpred IS NULL" in INDEX_PROBE_SQL and "i.indexprs IS NULL" in INDEX_PROBE_SQL)
    guarded = {"called": 0}
    def _guard():
        guarded["called"] += 1
        raise Indeterminate("no index")
    check("the index guard runs BEFORE any decided window is read, and its refusal propagates",
          lambda: _raises(lambda: evaluate_all(w1 + 60 * DAY_S, lambda tf, w_: (_ for _ in ()).throw(AssertionError("read before guard")),
                                               pc, cps, index_guard=_guard)) and guarded["called"] == 1)
    check("no guard and no read while every window is still open (nothing heavy before a look)",
          lambda: len(evaluate_all(w1 + DAY_S, lambda tf, w_: (_ for _ in ()).throw(AssertionError("read")), pc, cps,
                                   index_guard=_guard)[1]) == len(TIMEFRAMES) and guarded["called"] == 1)
    check("the page body names the switch and says the job never switches",
          "15m: switch MM -> FF" in page_body([{**res_s, "state": "DECIDED"}]) and "never switches" in page_body([res_s]))

    # 11. THE STATEMENT TIMEOUT (ruling Q1 = A, condition 3), through the REAL read path — psql →
    #     read_window → evaluate_run, the guard included — with only the process seam replaced. A read
    #     that times out is INDETERMINATE for the whole RUN: never an empty window, never a PASS.
    check("the timeout is set, positive and within the 300 s cap",
          0 < STATEMENT_TIMEOUT_MS <= STATEMENT_TIMEOUT_CAP_MS == 300_000)
    look = next_scheduled_run(w1 + 14 * DAY_S + 3 * 3600 + DAY_S)   # 15m/30m/1h/2h share this first look
    ok_rows = "\n".join("|".join([str(r["id"]), r["regime"], "t" if r["decisive"] else "f", r["verdict_m"],
                                  r["verdict_f"], r["served"], str(r["decided_at"]), repr(r["r"])])
                        for r in null_rows) + "\n"
    seen: list[list[str]] = []

    def _fake(times_out):
        def run(cmd, **_kw):
            seen.append(cmd)
            sql = cmd[-1]
            if "pg_index" in sql:
                return subprocess.CompletedProcess(cmd, 0, "1\n", "")
            if not times_out(sql):
                return subprocess.CompletedProcess(cmd, 0, ok_rows if "LATERAL" in sql else "0|0\n", "")
            return subprocess.CompletedProcess(cmd, 1, "", "ERROR:  canceling statement due to statement timeout")
        return run

    real_run = _RUN
    try:
        _RUN = _fake(lambda sql: False)
        ctl = evaluate_run(look, read_window, pc, cps, index_guard=require_hash_index)
        check("CONTROL: every read clean ⇒ the run is evaluated (PASS), so the fake is not what fails",
              lambda: ctl[0] == PASS and len(ctl[1]) == 4 and ctl[3] is None)
        _RUN = _fake(lambda sql: "'15m'" not in sql)
        out = evaluate_run(look, read_window, pc, cps, index_guard=require_hash_index)
        check("a statement timeout on ONE timeframe (15m read clean) ⇒ the whole RUN is INDETERMINATE, never PASS",
              lambda: out[0] == INDET and out[1] == [] and "statement timeout" in (out[3] or ""))
        check("a timed-out statement raises (INDETERMINATE), never an empty result",
              _raises(lambda: psql("SELECT 1")))
        check("every statement ran read-only AND under the statement timeout",
              lambda: len(seen) > 4 and all(c[3] == f"PGOPTIONS={PGOPTIONS}" for c in seen)
              and f"-c statement_timeout={STATEMENT_TIMEOUT_MS}" in PGOPTIONS
              and "-c default_transaction_read_only=on" in PGOPTIONS)
    finally:
        _RUN = real_run

    total = len(failures)
    print(f"SELF-TEST: {'PASS' if total == 0 else f'FAIL ({total})'}")
    print(f"{TOKEN}={PASS if total == 0 else INDET}")
    return 0 if total == 0 else 3


def _raises(fn) -> bool:
    try:
        fn()
    except Indeterminate:
        return True
    return False


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
